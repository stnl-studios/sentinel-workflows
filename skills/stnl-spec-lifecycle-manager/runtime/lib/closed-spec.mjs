import fs from 'node:fs';
import path from 'node:path';

import {
  ACTIVE_SECTIONS,
  ValidationError,
  canonicalPathWithoutSymlinks,
  validateCloseTransition,
  validateWorkspace,
} from './lifecycle.mjs';
import {
  expandUser,
  isOsMetadata,
  lexists,
  lstatOrNull,
  requestedPartsContainTraversal,
  sorted,
} from './core.mjs';
import {
  validateReadinessAttestation,
  workspaceAuthoritySnapshotSha256,
} from './readiness.mjs';

const CLOSED_HEADER = Buffer.from(`# File Purpose Header

\`\`\`yaml
purpose: Template for the final lossless documentary feature SPEC.
status: closed
read_when: Maintaining, validating, extending, or revisiting the closed feature requirements.
do_not_read_when: Looking for session history, implementation evidence, or delivery records.
contains: Durable objective, context, scope, rules, exact canonical items, contracts, and all final questions.
owner: stnl-spec-lifecycle-manager
update_policy: Update only through an explicit future documentary lifecycle action.
\`\`\`
`, 'utf8');

const CLOSED_CATEGORIES = [
  ['requirements', 'Requirements'],
  ['acceptance_criteria', 'Final Acceptance Criteria'],
  ['decisions', 'Durable Decisions'],
  ['constraints', 'Relevant Constraints'],
  ['risks', 'Relevant Risks'],
];

function identity(directory, label) {
  const metadata = lstatOrNull(directory);
  if (metadata === null) throw new ValidationError(`${label} disappeared: ${directory}`);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ValidationError(`${label} must remain a real directory: ${directory}`);
  return `${metadata.dev}:${metadata.ino}`;
}

function requireIdentity(directory, expected, label) {
  if (identity(directory, label) !== expected) throw new ValidationError(`${label} ownership/inode changed: ${directory}`);
}

function removeOwnedDirectory(directory, expected, label) {
  requireIdentity(directory, expected, label);
  fs.rmSync(directory, { recursive: true, force: false });
}

function rollbackPromotedCandidate(candidate, stage, expected) {
  if (lexists(stage)) throw new ValidationError(`CLOSE rollback stage path unexpectedly exists: ${stage}`);
  requireIdentity(candidate, expected, 'promoted CLOSE candidate');
  fs.renameSync(candidate, stage);
  requireIdentity(stage, expected, 'rolled-back CLOSE stage');
}

function preserveMetadata(destination, metadata) {
  try { fs.chmodSync(destination, metadata.mode & 0o7777); } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  try { fs.utimesSync(destination, metadata.atime, metadata.mtime); } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function copyExternal(source, destination, relative, linkGroups) {
  const relativeName = relative.split(path.sep).join('/');
  if (isOsMetadata(relativeName)) return;
  const metadata = fs.lstatSync(source);
  const isLink = metadata.isSymbolicLink();
  const isFile = metadata.isFile();
  if (isLink || isFile) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const linkKey = `${metadata.dev}:${metadata.ino}`;
    const kind = isLink ? 'symlink' : 'file';
    const group = metadata.nlink > 1 ? linkGroups.get(linkKey) : null;
    if (group) {
      if (group.sourceLinkCount !== metadata.nlink || group.kind !== kind) throw new ValidationError(`external hardlink group changed while rendering: ${source}`);
      fs.linkSync(group.firstStagePath, destination);
      group.seen += 1;
      return;
    }
    if (isLink) fs.symlinkSync(fs.readlinkSync(source), destination, process.platform === 'win32' ? 'file' : undefined);
    else {
      fs.copyFileSync(source, destination);
      preserveMetadata(destination, metadata);
    }
    if (metadata.nlink > 1) linkGroups.set(linkKey, { firstStagePath: destination, sourceLinkCount: metadata.nlink, seen: 1, kind });
    return;
  }
  if (metadata.isDirectory()) {
    fs.mkdirSync(destination);
    for (const name of sorted(fs.readdirSync(source))) copyExternal(path.join(source, name), path.join(destination, name), path.join(relative, name), linkGroups);
    preserveMetadata(destination, metadata);
    return;
  }
  throw new ValidationError(`unsupported external filesystem entry: ${source}`);
}

function validateExternalLinkGroups(linkGroups) {
  for (const group of linkGroups.values()) {
    if (group.seen !== group.sourceLinkCount) throw new ValidationError('external hardlink group crosses the CLOSE preservation boundary');
    if (fs.lstatSync(group.firstStagePath).nlink !== group.sourceLinkCount) throw new ValidationError('rendered external hardlink topology changed before validation');
  }
}

function activeParts(data) {
  const text = data.toString('utf8');
  const matches = [...text.matchAll(/^## (?<name>[^\n]+)\n/gmu)];
  const names = matches.map((match) => match.groups.name);
  if (JSON.stringify(names) !== JSON.stringify(ACTIVE_SECTIONS)) throw new ValidationError('active feature sections changed after structural validation');
  const parts = new Map();
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    parts.set(names[index], Buffer.from(text.slice(match.index, end), 'utf8'));
  });
  return [Buffer.from(text.slice(0, matches[0].index), 'utf8'), parts];
}

function closeHeader(prefix) {
  const fenceEnd = prefix.indexOf(Buffer.from('```\n'));
  if (fenceEnd < 0) throw new ValidationError('cannot locate the validated File Purpose Header');
  const headerEnd = fenceEnd + 4;
  const header = prefix.subarray(0, headerEnd);
  const needle = Buffer.from('\nstatus: ready\n');
  let count = 0;
  let offset = -1;
  while ((offset = header.indexOf(needle, offset + 1)) >= 0) count += 1;
  if (count !== 1) throw new ValidationError('CLOSE source header must contain exactly one ready status');
  return Buffer.concat([CLOSED_HEADER, prefix.subarray(headerEnd)]);
}

function renameH2(block, source, destination) {
  const old = Buffer.from(`## ${source}\n`, 'utf8');
  if (!block.subarray(0, old.length).equals(old)) throw new ValidationError(`cannot locate validated section '${source}'`);
  return Buffer.concat([Buffer.from(`## ${destination}\n`, 'utf8'), block.subarray(old.length)]);
}

function recordRegion(file) {
  const data = fs.readFileSync(file);
  const text = data.toString('utf8');
  const match = text.match(/^### (?:AC|RK|R|D|C|Q)-[0-9]{3} — /mu);
  if (match === null) throw new ValidationError(`validated canonical records disappeared from ${file}`);
  return Buffer.from(text.slice(match.index), 'utf8');
}

function appendBlock(chunks, block) {
  if (chunks.length) {
    const current = Buffer.concat(chunks);
    if (!current.subarray(-2).equals(Buffer.from('\n\n'))) chunks.push(current.subarray(-1).equals(Buffer.from('\n')) ? Buffer.from('\n') : Buffer.from('\n\n'));
  }
  chunks.push(block);
}

export function renderClosedFeature(source) {
  const workspace = validateWorkspace(source);
  if (workspace.closed || workspace.status !== 'ready') throw new ValidationError('CLOSE renderer requires an active ready workspace');
  const [prefix, active] = activeParts(fs.readFileSync(path.join(workspace.root, 'feature_spec.md')));
  const chunks = [closeHeader(prefix)];
  appendBlock(chunks, active.get('Objective'));
  appendBlock(chunks, active.get('Context'));
  appendBlock(chunks, renameH2(active.get('Scope'), 'Scope', 'Final Scope'));
  appendBlock(chunks, active.get('Out of Scope'));
  const requirements = workspace.artifacts.get('requirements');
  if (!requirements) throw new ValidationError('active ready workspace has no canonical requirements');
  appendBlock(chunks, Buffer.concat([Buffer.from('## Requirements\n\n'), recordRegion(path.join(workspace.root, ...requirements.split('/')))]));
  appendBlock(chunks, active.get('Business Rules'));
  for (const [key, heading] of CLOSED_CATEGORIES.slice(1)) {
    const artifact = workspace.artifacts.get(key);
    if (artifact) appendBlock(chunks, Buffer.concat([Buffer.from(`## ${heading}\n\n`, 'utf8'), recordRegion(path.join(workspace.root, ...artifact.split('/')))]));
  }
  appendBlock(chunks, renameH2(active.get('Relevant Contracts'), 'Relevant Contracts', 'Important Contracts'));
  const questions = workspace.artifacts.get('questions');
  if (questions) appendBlock(chunks, Buffer.concat([Buffer.from('## Durable Resolved Questions\n\n'), recordRegion(path.join(workspace.root, ...questions.split('/')))]));
  let output = Buffer.concat(chunks);
  if (output.at(-1) !== 0x0a) output = Buffer.concat([output, Buffer.from('\n')]);
  return output;
}

function requireAttestedSnapshot(source, expected) {
  const current = validateWorkspace(source);
  if (workspaceAuthoritySnapshotSha256(current) !== expected) throw new ValidationError('readiness attestation became stale during CLOSE; rerun READINESS GLOBAL');
}

export function buildClosedCandidate(source, candidate, { readinessAttestation } = {}) {
  const requestedSource = expandUser(source);
  const requestedCandidate = expandUser(candidate);
  if (requestedPartsContainTraversal(requestedSource) || requestedPartsContainTraversal(requestedCandidate)) throw new ValidationError('source and candidate must not contain path traversal');
  const sourcePath = canonicalPathWithoutSymlinks(requestedSource, 'CLOSE source');
  const candidatePath = canonicalPathWithoutSymlinks(requestedCandidate, 'CLOSE candidate');
  const sourceMetadata = lstatOrNull(sourcePath);
  if (sourceMetadata === null || !sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) throw new ValidationError(`source must be a real workspace directory: ${sourcePath}`);
  if (lexists(candidatePath)) throw new ValidationError(`candidate must not exist: ${candidatePath}`);
  const parentMetadata = lstatOrNull(path.dirname(candidatePath));
  if (parentMetadata === null || !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new ValidationError(`candidate parent must be a real directory: ${path.dirname(candidatePath)}`);
  const relativeCandidate = path.relative(sourcePath, candidatePath);
  const relativeSource = path.relative(candidatePath, sourcePath);
  const inside = (relative) => relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (inside(relativeCandidate) || inside(relativeSource)) throw new ValidationError('source and candidate must be disjoint directories');
  const [, attestedSnapshot] = validateReadinessAttestation(sourcePath, readinessAttestation, { candidate: candidatePath });
  const rendered = renderClosedFeature(sourcePath);
  requireAttestedSnapshot(sourcePath, attestedSnapshot);
  const stage = fs.mkdtempSync(path.join(path.dirname(candidatePath), `.${path.basename(candidatePath)}.close-stage-`));
  const stageIdentity = identity(stage, 'CLOSE stage');
  try {
    fs.writeFileSync(path.join(stage, 'feature_spec.md'), rendered);
    const linkGroups = new Map();
    for (const name of sorted(fs.readdirSync(sourcePath))) {
      if (name === 'feature_spec.md' || name === 'shared' || isOsMetadata(name)) continue;
      copyExternal(path.join(sourcePath, name), path.join(stage, name), name, linkGroups);
    }
    validateExternalLinkGroups(linkGroups);
    validateWorkspace(stage);
    validateCloseTransition(sourcePath, stage);
    requireAttestedSnapshot(sourcePath, attestedSnapshot);
    if (lexists(candidatePath)) throw new ValidationError(`candidate appeared before publication: ${candidatePath}`);
    fs.renameSync(stage, candidatePath);
    requireIdentity(candidatePath, stageIdentity, 'promoted CLOSE candidate');
    try {
      requireAttestedSnapshot(sourcePath, attestedSnapshot);
    } catch (error) {
      rollbackPromotedCandidate(candidatePath, stage, stageIdentity);
      throw error;
    }
    return candidatePath;
  } finally {
    if (lexists(stage)) removeOwnedDirectory(stage, stageIdentity, 'owned CLOSE stage');
  }
}
