import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  ACTIVE_SECTIONS,
  ValidationError,
  canonicalPathWithoutSymlinks,
  compareCloseDocuments,
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

function preserveMetadata(destination, metadata) {
  try { fs.chmodSync(destination, metadata.mode & 0o7777); } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  try { fs.utimesSync(destination, metadata.atime, metadata.mtime); } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

// One fixed Darwin producer capability. Paths and physical identity belong to
// the publisher's existing stage; neither a caller nor a model selects a command.
export function linkOwnedStageSymlink(stageRoot, stageIdentity, source, destination, expectedSource) {
  if (process.platform !== 'darwin') throw new ValidationError('Darwin symlink hardlink capability is unavailable on this platform');
  if (!stageIdentity || typeof stageIdentity.dev !== 'string' || typeof stageIdentity.ino !== 'string'
    || !expectedSource || typeof expectedSource.dev !== 'string' || typeof expectedSource.ino !== 'string'
    || typeof expectedSource.nlink !== 'string' || !/^[1-9][0-9]*$/u.test(expectedSource.nlink)
    || typeof expectedSource.payload !== 'string') throw new ValidationError('owned symlink link requires sealed physical identities');
  for (const value of [stageRoot, source, destination]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || requestedPartsContainTraversal(value))
      throw new ValidationError('owned symlink paths must be absolute without traversal');
  }
  const root=canonicalPathWithoutSymlinks(stageRoot,'owned symlink stage');
  requireIdentity(root,`${stageIdentity.dev}:${stageIdentity.ino}`,'owned symlink stage');
  const entry=value=>{
    const parent=canonicalPathWithoutSymlinks(path.dirname(value),'owned symlink parent');
    const file=path.join(parent,path.basename(value)),relative=path.relative(root,file);
    if (!relative || relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new ValidationError('symlink link path escapes its owned stage');
    return file;
  };
  const first=entry(source),second=entry(destination);
  if(first===second)throw new ValidationError('symlink link destination must be distinct');
  const parents=new Map();
  for(const file of [first,second]){
    let parent=path.dirname(file);
    for(;;){
      const meta=fs.lstatSync(parent,{bigint:true});
      if(!meta.isDirectory()||meta.isSymbolicLink())throw new ValidationError('owned symlink ancestor must remain a real directory');
      const relative=path.relative(root,parent);
      if((relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))&&String(meta.dev)!==stageIdentity.dev)
        throw new ValidationError('owned symlink parent differs from the stage filesystem');
      if(!parents.has(parent))parents.set(parent,{dev:meta.dev,ino:meta.ino,mode:meta.mode});
      if(parent===path.parse(parent).root)break;
      parent=path.dirname(parent);
    }
  }
  const checkParents=()=>{
    requireIdentity(root,`${stageIdentity.dev}:${stageIdentity.ino}`,'owned symlink stage');
    for(const [parent,expected] of parents){
      const current=fs.lstatSync(parent,{bigint:true});
      if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==expected.dev||current.ino!==expected.ino||current.mode!==expected.mode)
        throw new ValidationError('owned symlink ancestor changed');
    }
  };
  const checkFirst=()=>{
    const meta=fs.lstatSync(first,{bigint:true});
    if(!meta.isSymbolicLink()||String(meta.dev)!==expectedSource.dev||String(meta.ino)!==expectedSource.ino
      ||String(meta.dev)!==stageIdentity.dev||fs.readlinkSync(first)!==expectedSource.payload)
      throw new ValidationError('owned symlink source identity or payload changed');
    return meta;
  };
  checkParents();
  const before=checkFirst();
  if(String(before.nlink)!==expectedSource.nlink)throw new ValidationError('owned symlink source link count changed');
  if(lstatOrNull(second)!==null)throw new ValidationError('owned symlink destination is occupied');
  checkParents();
  const sealed=checkFirst();
  if(sealed.nlink!==before.nlink||sealed.mode!==before.mode)throw new ValidationError('owned symlink source changed before linking');
  if(lstatOrNull(second)!==null)throw new ValidationError('owned symlink destination is occupied');
  let commandError=null;
  try {
    execFileSync('/bin/ln', ['-P', '-h', '--', first, second], {
      shell: false, timeout: 2000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch(error) { commandError=error; }
  checkParents();
  const after=checkFirst();
  if(after.mode!==before.mode)throw new ValidationError('owned symlink source mode changed');
  if(commandError)throw commandError;
  const linked=fs.lstatSync(second,{bigint:true});
  if(!linked.isSymbolicLink()||linked.dev!==after.dev||linked.ino!==after.ino
    ||after.nlink!==before.nlink+1n||linked.nlink!==after.nlink||linked.mode!==after.mode
    ||fs.readlinkSync(second)!==expectedSource.payload)
    throw new ValidationError('owned symlink link did not preserve exact physical topology');
  checkParents();
}

function copyExternal(source, destination, relative, linkGroups, stage) {
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
      if(kind==='symlink'&&process.platform==='darwin')linkOwnedStageSymlink(stage.root,stage.identity,group.firstStagePath,destination,
        {...group.firstStageIdentity,nlink:String(group.seen),payload:group.payload});
      else fs.linkSync(group.firstStagePath, destination);
      group.seen += 1;
      return;
    }
    if (isLink) fs.symlinkSync(fs.readlinkSync(source), destination, process.platform === 'win32' ? 'file' : undefined);
    else {
      fs.copyFileSync(source, destination);
      preserveMetadata(destination, metadata);
    }
    if (metadata.nlink > 1) {
      const staged=fs.lstatSync(destination,{bigint:true});
      linkGroups.set(linkKey, { firstStagePath: destination, sourceLinkCount: metadata.nlink, seen: 1, kind,
        firstStageIdentity:{dev:String(staged.dev),ino:String(staged.ino)},payload:isLink?fs.readlinkSync(destination):null });
    }
    return;
  }
  if (metadata.isDirectory()) {
    fs.mkdirSync(destination);
    for (const name of sorted(fs.readdirSync(source))) copyExternal(path.join(source, name), path.join(destination, name), path.join(relative, name), linkGroups,stage);
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

function requireStableAuthoritySnapshot(source, expected) {
  const current = validateWorkspace(source);
  if (workspaceAuthoritySnapshotSha256(current) !== expected) throw new ValidationError('CLOSE source changed during rendering; rebuild from the current active source');
}

// Internal publisher renderer: it neither allocates nor promotes a directory.
// The publisher has already bound this stage inode in its existing ownership record.
export function populateOwnedClosedStage(source,stage,expectedIdentity) {
  const sourcePath=canonicalPathWithoutSymlinks(expandUser(source),'CLOSE source');
  const stagePath=canonicalPathWithoutSymlinks(expandUser(stage),'owned CLOSE stage');
  if(requestedPartsContainTraversal(source)||requestedPartsContainTraversal(stage))throw new ValidationError('CLOSE source/stage must not contain path traversal');
  const expected=`${expectedIdentity?.dev}:${expectedIdentity?.ino}`;
  requireIdentity(stagePath,expected,'owned CLOSE stage');
  if(fs.readdirSync(stagePath).length)throw new ValidationError('owned CLOSE stage must be empty before rendering');
  const relative=path.relative(sourcePath,stagePath),reverse=path.relative(stagePath,sourcePath);
  const inside=value=>value===''||(!value.startsWith(`..${path.sep}`)&&value!=='..'&&!path.isAbsolute(value));
  if(inside(relative)||inside(reverse))throw new ValidationError('CLOSE source and owned stage must be disjoint');
  const workspace=validateWorkspace(sourcePath),snapshot=workspaceAuthoritySnapshotSha256(workspace);
  const rendered=renderClosedFeature(sourcePath);requireStableAuthoritySnapshot(sourcePath,snapshot);
  fs.writeFileSync(path.join(stagePath,'feature_spec.md'),rendered,{flag:'wx'});
  const linkGroups=new Map();
  for(const name of sorted(fs.readdirSync(sourcePath))) {
    if(['feature_spec.md','shared','execution'].includes(name)||isOsMetadata(name))continue;
    copyExternal(path.join(sourcePath,name),path.join(stagePath,name),name,linkGroups,{root:stagePath,identity:expectedIdentity});
  }
  validateExternalLinkGroups(linkGroups);compareCloseDocuments(sourcePath,stagePath);
  requireStableAuthoritySnapshot(sourcePath,snapshot);requireIdentity(stagePath,expected,'owned CLOSE stage');
  return stagePath;
}
