import fs from 'node:fs';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  ValidationError,
  canonicalPathWithoutSymlinks,
  validateWorkspace,
} from './lifecycle.mjs';
import {
  expandUser,
  isWithin,
  lexists,
  lstatOrNull,
  requestedPartsContainTraversal,
  sorted,
} from './core.mjs';
import { exactObject, parseStrictJson } from './strict-json.mjs';

export const READINESS_ATTESTATION_VERSION = 1;
export const READINESS_ATTESTATION_FIELDS = new Set([
  'version', 'mode', 'scope', 'verdict', 'workspace_identity', 'workspace_snapshot_sha256',
]);
export const WORKSPACE_IDENTITY_FIELDS = new Set(['h1', 'path_sha256']);
export const MAX_ATTESTATION_BYTES = 64 * 1024;
const SNAPSHOT_DOMAIN = Buffer.from('stnl-readiness-authority-snapshot-v1\0', 'utf8');
const IDENTITY_DOMAIN = Buffer.from('stnl-readiness-workspace-path-v1\0', 'utf8');
const CREATION_AUTHORITY_DOMAIN = Buffer.from('stnl-readiness-creation-authority-v1\0', 'utf8');
const STRICT_ATTESTATION_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function reject(message) { throw new ValidationError(message); }

function requestedPath(value, label) {
  const requested = expandUser(value);
  if (requestedPartsContainTraversal(requested)) reject(`${label} must not contain path traversal`);
  return requested;
}

function posixPath(value) { return String(value).split(path.sep).join('/'); }

function authorityPaths(workspace) {
  const relatives = ['feature_spec.md', ...[...workspace.artifacts.values()].sort()];
  return relatives.map((relative) => {
    if (path.isAbsolute(relative) || requestedPartsContainTraversal(relative)) reject(`invalid lifecycle authority path: '${relative}'`);
    const authority = path.join(workspace.root, ...relative.split('/'));
    const metadata = lstatOrNull(authority, { bigint: true });
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) reject(`lifecycle authority must be a real file: ${authority}`);
    return [relative, authority, metadata];
  });
}

function openNoFollow(file, flags) {
  try {
    return fs.openSync(file, flags | (fsConstants.O_CLOEXEC ?? 0) | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error?.code === 'ELOOP') reject(`lifecycle authority must not be a symlink: ${file}`);
    throw error;
  }
}

function metadataState(metadata) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.nlink,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].map(String).join(':');
}

function sameIdentity(left, right) {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function readAuthorityBytes(file, expected = null) {
  const descriptor = openNoFollow(file, fsConstants.O_RDONLY);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) reject(`lifecycle authority must be a single-link regular file: ${file}`);
    if (expected !== null && !sameIdentity(before, expected)) reject('readiness source authority changed during attestation creation');
    const data = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (metadataState(before) !== metadataState(after)) reject('readiness source authority changed during attestation creation');
    return data;
  } finally {
    fs.closeSync(descriptor);
  }
}

function lengthBuffer(length) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(length));
  return result;
}

export function workspaceAuthoritySnapshotSha256(workspace) {
  const digest = createHash('sha256');
  digest.update(SNAPSHOT_DOMAIN);
  for (const [relative, authority, metadata] of authorityPaths(workspace)) {
    const encodedPath = Buffer.from(relative, 'utf8');
    const data = readAuthorityBytes(authority, metadata);
    digest.update(lengthBuffer(encodedPath.length));
    digest.update(encodedPath);
    digest.update(lengthBuffer(data.length));
    digest.update(data);
  }
  return digest.digest('hex');
}

function workspaceIdentity(workspace) {
  const canonicalPath = Buffer.from(posixPath(workspace.root), 'utf8');
  return {
    h1: workspace.h1,
    path_sha256: createHash('sha256').update(IDENTITY_DOMAIN).update(canonicalPath).digest('hex'),
  };
}

function requireReadyWorkspace(source) {
  const workspace = validateWorkspace(requestedPath(source, 'source'));
  if (workspace.closed || workspace.status !== 'ready') reject('readiness attestation requires an active ready workspace');
  return workspace;
}

function updateFingerprint(digest, ...values) {
  for (const value of values) {
    const encoded = Buffer.from(String(value), 'utf8');
    digest.update(lengthBuffer(encoded.length));
    digest.update(encoded);
  }
}

function creationAuthorityFingerprint(sourceRoot) {
  const digest = createHash('sha256');
  digest.update(CREATION_AUTHORITY_DOMAIN);

  function visit(entry, relative) {
    const before = lstatOrNull(entry, { bigint: true });
    if (before === null) {
      updateFingerprint(digest, relative, 'missing');
      return;
    }
    if (before.isSymbolicLink()) {
      const target = fs.readlinkSync(entry);
      const after = lstatOrNull(entry, { bigint: true });
      if (!sameIdentity(before, after) || before.ctimeNs !== after.ctimeNs) reject('readiness source authority changed during attestation creation');
      updateFingerprint(digest, relative, 'symlink', metadataState(before), target);
      return;
    }
    if (before.isFile()) {
      const data = readAuthorityBytes(entry, before);
      updateFingerprint(digest, relative, 'file', metadataState(before), data.toString('base64'));
      return;
    }
    if (before.isDirectory()) {
      const names = sorted(fs.readdirSync(entry));
      updateFingerprint(digest, relative, 'directory', before.dev, before.ino, before.mode, names.join('\0'));
      for (const name of names) visit(path.join(entry, name), relative === '.' ? name : `${relative}/${name}`);
      const after = lstatOrNull(entry, { bigint: true });
      if (!sameIdentity(before, after)) reject('readiness source authority changed during attestation creation');
      if (JSON.stringify(names) !== JSON.stringify(sorted(fs.readdirSync(entry)))) reject('readiness source authority changed during attestation creation');
      return;
    }
    updateFingerprint(digest, relative, 'special', metadataState(before));
  }

  const rootMetadata = lstatOrNull(sourceRoot, { bigint: true });
  if (rootMetadata === null || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    updateFingerprint(digest, '.', 'missing-or-invalid-root');
    return digest.digest('hex');
  }
  updateFingerprint(digest, '.', 'directory', rootMetadata.dev, rootMetadata.ino, rootMetadata.mode);
  visit(path.join(sourceRoot, 'feature_spec.md'), 'feature_spec.md');
  visit(path.join(sourceRoot, 'shared'), 'shared');
  const confirmedRoot = lstatOrNull(sourceRoot, { bigint: true });
  if (!sameIdentity(rootMetadata, confirmedRoot)) reject('readiness source authority changed during attestation creation');
  return digest.digest('hex');
}

function sourceRootBeforeValidation(source) {
  const requested = requestedPath(source, 'source');
  const root = canonicalPathWithoutSymlinks(requested, 'source');
  const metadata = lstatOrNull(root);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) return null;
  return root;
}

function requireStableReadyCapture(source) {
  const sourceRoot = sourceRootBeforeValidation(source);
  if (sourceRoot === null) {
    requireReadyWorkspace(source);
    reject('readiness source authority changed during attestation creation');
  }
  const initialFingerprint = creationAuthorityFingerprint(sourceRoot);
  const firstWorkspace = requireReadyWorkspace(sourceRoot);
  const afterValidation = creationAuthorityFingerprint(sourceRoot);
  const firstSnapshot = workspaceAuthoritySnapshotSha256(firstWorkspace);
  const afterSnapshot = creationAuthorityFingerprint(sourceRoot);
  const confirmedWorkspace = requireReadyWorkspace(sourceRoot);
  const afterConfirmation = creationAuthorityFingerprint(sourceRoot);
  const confirmedSnapshot = workspaceAuthoritySnapshotSha256(confirmedWorkspace);
  const finalFingerprint = creationAuthorityFingerprint(sourceRoot);
  const fingerprints = [initialFingerprint, afterValidation, afterSnapshot, afterConfirmation, finalFingerprint];
  if (
    fingerprints.some((value) => value !== initialFingerprint)
    || confirmedSnapshot !== firstSnapshot
    || JSON.stringify(workspaceIdentity(confirmedWorkspace)) !== JSON.stringify(workspaceIdentity(firstWorkspace))
  ) reject('readiness source authority changed during attestation creation');
  return { workspace: confirmedWorkspace, snapshot: confirmedSnapshot, creationFingerprint: finalFingerprint };
}

function verifyStableReadyCapture(capture) {
  const before = creationAuthorityFingerprint(capture.workspace.root);
  const workspace = requireReadyWorkspace(capture.workspace.root);
  const afterValidation = creationAuthorityFingerprint(capture.workspace.root);
  const snapshot = workspaceAuthoritySnapshotSha256(workspace);
  const afterSnapshot = creationAuthorityFingerprint(capture.workspace.root);
  if (
    before !== capture.creationFingerprint
    || afterValidation !== capture.creationFingerprint
    || afterSnapshot !== capture.creationFingerprint
    || snapshot !== capture.snapshot
    || JSON.stringify(workspaceIdentity(workspace)) !== JSON.stringify(workspaceIdentity(capture.workspace))
  ) reject('readiness source authority changed during attestation creation');
}

function payload(workspace, { scope, verdict, snapshot }) {
  if (scope !== 'GLOBAL') reject('readiness attestation requires scope GLOBAL');
  if (verdict !== 'READY') reject('readiness attestation requires verdict READY');
  // Preserve the established canonical sorted-key JSON byte layout exactly.
  return {
    mode: 'READINESS',
    scope,
    verdict,
    version: READINESS_ATTESTATION_VERSION,
    workspace_identity: workspaceIdentity(workspace),
    workspace_snapshot_sha256: snapshot,
  };
}

function outputPath(attestation, workspace) {
  const requested = requestedPath(attestation, 'attestation output');
  const output = canonicalPathWithoutSymlinks(requested, 'attestation output');
  if (lexists(output)) reject(`attestation output must not exist or be a symlink: ${output}`);
  const parent = path.dirname(output);
  const parentMetadata = lstatOrNull(parent);
  if (parentMetadata === null || !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) reject(`attestation output parent must be a real directory: ${parent}`);
  if (isWithin(output, workspace.root)) reject('attestation output must be outside the workspace');
  return output;
}

function ownedOutputIdentity(descriptor) {
  const metadata = fs.fstatSync(descriptor, { bigint: true });
  if (!metadata.isFile() || metadata.nlink !== 1n) reject('attestation output must remain a single-link regular file');
  return { dev: metadata.dev, ino: metadata.ino };
}

function requireOwnedOutputPath(output, owned) {
  const metadata = lstatOrNull(output, { bigint: true });
  if (
    metadata === null
    || metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.nlink !== 1n
    || !sameIdentity(metadata, owned)
  ) reject('attestation output ownership changed during creation');
}

function requireOwnedOutputBytes(descriptor, owned, encoded) {
  const before = fs.fstatSync(descriptor, { bigint: true });
  if (!sameIdentity(before, owned) || !before.isFile() || before.nlink !== 1n || before.size !== BigInt(encoded.length)) {
    reject('attestation output changed during creation');
  }
  const actual = Buffer.alloc(encoded.length);
  let offset = 0;
  while (offset < actual.length) {
    const count = fs.readSync(descriptor, actual, offset, actual.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  const after = fs.fstatSync(descriptor, { bigint: true });
  if (offset !== encoded.length || !actual.equals(encoded) || metadataState(before) !== metadataState(after)) {
    reject('attestation output changed during creation');
  }
}

function removeOwnedOutput(output, owned) {
  const current = lstatOrNull(output, { bigint: true });
  if (current === null || !sameIdentity(current, owned)) return;
  const quarantineDirectory = fs.mkdtempSync(path.join(path.dirname(output), `.${path.basename(output)}.attestation-cleanup-`));
  const quarantineIdentity = lstatOrNull(quarantineDirectory, { bigint: true });
  const quarantined = path.join(quarantineDirectory, 'owned-output');
  let moved = false;
  try {
    fs.renameSync(output, quarantined);
    moved = true;
    const movedMetadata = lstatOrNull(quarantined, { bigint: true });
    if (!sameIdentity(movedMetadata, owned)) {
      if (!lexists(output)) {
        fs.renameSync(quarantined, output);
        moved = false;
      }
      reject('attestation output ownership changed during cleanup');
    }
    fs.unlinkSync(quarantined);
    moved = false;
  } finally {
    if (!moved && lexists(quarantineDirectory)) {
      const currentDirectory = lstatOrNull(quarantineDirectory, { bigint: true });
      if (sameIdentity(currentDirectory, quarantineIdentity) && fs.readdirSync(quarantineDirectory).length === 0) fs.rmdirSync(quarantineDirectory);
    }
  }
}

export function createReadinessAttestation(source, attestation, { scope, verdict } = {}) {
  const capture = requireStableReadyCapture(source);
  const output = outputPath(attestation, capture.workspace);
  const encoded = Buffer.from(`${JSON.stringify(payload(capture.workspace, { scope, verdict, snapshot: capture.snapshot }))}\n`, 'utf8');
  let descriptor = null;
  let owned = null;
  try {
    descriptor = fs.openSync(output, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    owned = ownedOutputIdentity(descriptor);
    fs.writeFileSync(descriptor, encoded);
    fs.fsyncSync(descriptor);
    requireOwnedOutputBytes(descriptor, owned, encoded);
    requireOwnedOutputPath(output, owned);
    verifyStableReadyCapture(capture);
    requireOwnedOutputBytes(descriptor, owned, encoded);
    requireOwnedOutputPath(output, owned);
    fs.closeSync(descriptor);
    descriptor = null;
    requireOwnedOutputPath(output, owned);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (owned !== null) removeOwnedOutput(output, owned);
    throw error;
  }
  return output;
}

function nonemptyString(value, label) {
  if (typeof value !== 'string' || !value) reject(`readiness attestation ${label} must be a non-empty string`);
  return value;
}

function sha256(value, label) {
  const digest = nonemptyString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(digest)) reject(`readiness attestation ${label} must be a lowercase SHA-256 digest`);
  return digest;
}

function readAttestationBytes(file) {
  const expected = lstatOrNull(file, { bigint: true });
  if (expected === null) reject(`readiness attestation must be a real file: ${file}`);
  if (expected.isSymbolicLink()) reject('readiness attestation must not be a symlink');
  if (!expected.isFile() || expected.nlink !== 1n) reject('readiness attestation must be a single-link regular file');
  if (expected.size > BigInt(MAX_ATTESTATION_BYTES)) reject('readiness attestation exceeds the safe size limit');
  let descriptor;
  try {
    descriptor = fs.openSync(file, fsConstants.O_RDONLY | (fsConstants.O_CLOEXEC ?? 0) | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error?.code === 'ELOOP') reject('readiness attestation must not be a symlink');
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') reject(`readiness attestation must be a real file: ${file}`);
    throw error;
  }
  try {
    const metadata = fs.fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n) reject('readiness attestation must be a single-link regular file');
    if (metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
      reject('readiness attestation changed while being opened');
    }
    if (metadata.size > BigInt(MAX_ATTESTATION_BYTES)) reject('readiness attestation exceeds the safe size limit');
    const raw = fs.readFileSync(descriptor);
    if (raw.length > MAX_ATTESTATION_BYTES) reject('readiness attestation exceeds the safe size limit');
    return raw;
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseAttestation(file) {
  let root;
  try {
    root = parseStrictJson(
      STRICT_ATTESTATION_UTF8.decode(readAttestationBytes(file)),
      (key) => `readiness attestation contains duplicate JSON field '${key}'`,
      (value) => `readiness attestation contains invalid JSON constant '${value}'`,
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    reject(`readiness attestation is malformed: ${error.message}`);
  }
  root = exactObject(root, READINESS_ATTESTATION_FIELDS, 'root', 'readiness attestation');
  if (!Number.isInteger(root.version) || root.version !== READINESS_ATTESTATION_VERSION) reject(`readiness attestation has unsupported version ${JSON.stringify(root.version)}`);
  for (const [field, expected] of [['mode', 'READINESS'], ['scope', 'GLOBAL'], ['verdict', 'READY']]) {
    const actual = nonemptyString(root[field], field);
    if (actual !== expected) reject(`readiness attestation requires ${field} ${expected}; got '${actual}'`);
  }
  const identity = exactObject(root.workspace_identity, WORKSPACE_IDENTITY_FIELDS, 'workspace_identity', 'readiness attestation');
  nonemptyString(identity.h1, 'workspace_identity.h1');
  sha256(identity.path_sha256, 'workspace_identity.path_sha256');
  sha256(root.workspace_snapshot_sha256, 'workspace_snapshot_sha256');
  return root;
}

export function validateReadinessAttestation(source, attestation, { candidate = null } = {}) {
  const workspace = requireReadyWorkspace(source);
  const requested = requestedPath(attestation, 'readiness attestation');
  const attestationPath = canonicalPathWithoutSymlinks(requested, 'readiness attestation');
  if (isWithin(attestationPath, workspace.root)) reject('readiness attestation must be outside the workspace');
  if (candidate !== null) {
    const candidatePath = canonicalPathWithoutSymlinks(requestedPath(candidate, 'candidate'), 'candidate');
    if (isWithin(attestationPath, candidatePath)) reject('readiness attestation must be outside the candidate');
  }
  const parsed = parseAttestation(attestationPath);
  const expectedIdentity = workspaceIdentity(workspace);
  if (
    parsed.workspace_identity.h1 !== expectedIdentity.h1
    || parsed.workspace_identity.path_sha256 !== expectedIdentity.path_sha256
  ) reject('readiness attestation workspace identity does not match the CLOSE source');
  const actualSnapshot = workspaceAuthoritySnapshotSha256(workspace);
  if (actualSnapshot !== parsed.workspace_snapshot_sha256) reject('readiness attestation is stale; rerun READINESS GLOBAL');
  return [workspace, actualSnapshot];
}
