#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  closedDocumentFixture,
} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/helpers.mjs';
import {
  createReadinessAttestation,
} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/readiness.mjs';
import {
  ValidationError,
  compareCloseDocuments,
  validateWorkspace,
  workspaceSnapshot,
} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_ROOT = path.join(REPOSITORY_ROOT, 'skills', 'workflows', 'stnl-spec-lifecycle-manager');
const FIXTURES = path.join(SKILL_ROOT, 'examples', 'validator-fixtures');
const OPTIONAL_SYMLINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN']);
const OPTIONAL_HARDLINK_ERRORS = new Set([...OPTIONAL_SYMLINK_ERRORS, 'EXDEV']);

function temporary(t, prefix = 'stnl renderer adversarial ') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fresh(root, name = 'source') {
  const source = path.join(root, name);
  fs.cpSync(path.join(FIXTURES, 'ready'), source, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  return source;
}

function attestation(root, source, name = 'readiness.json') {
  return createReadinessAttestation(source, path.join(root, name), {
    scope: 'GLOBAL',
    verdict: 'READY',
  });
}

function build(root, source, name = 'candidate') {
  return closedDocumentFixture(source, path.join(root, name));
}

function replace(file, before, after) {
  const current = fs.readFileSync(file, 'utf8');
  assert(current.includes(before), `fixture text not found: ${before}`);
  fs.writeFileSync(file, current.replace(before, after), 'utf8');
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

function stageResidues(root, candidateName) {
  return fs.readdirSync(root).filter((name) => name.startsWith(`.${candidateName}.close-stage-`));
}

function treeSnapshot(root) {
  const result = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const relative = path.relative(root, entry).split(path.sep).join('/');
      const metadata = fs.lstatSync(entry);
      if (metadata.isSymbolicLink()) result.push([relative, 'symlink', fs.readlinkSync(entry)]);
      else if (metadata.isDirectory()) {
        result.push([relative, 'directory', '']);
        visit(entry);
      } else if (metadata.isFile()) result.push([relative, 'file', fs.readFileSync(entry).toString('base64')]);
      else result.push([relative, 'special', `${metadata.mode}:${metadata.dev}:${metadata.ino}`]);
    }
  }
  visit(root);
  return result;
}

function createSymlinkOrSkip(t, target, link, type = undefined) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (OPTIONAL_SYMLINK_ERRORS.has(error?.code)) {
      t.skip(`symlinks unavailable on this filesystem (${error.code})`);
      return false;
    }
    throw error;
  }
}

function createHardlinkOrSkip(t, source, destination) {
  try {
    fs.linkSync(source, destination);
    return true;
  } catch (error) {
    if (OPTIONAL_HARDLINK_ERRORS.has(error?.code)) {
      t.skip(`hardlinks unavailable on this filesystem (${error.code})`);
      return false;
    }
    throw error;
  }
}

function mutateObjective(source, text) {
  replace(
    path.join(source, 'feature_spec.md'),
    'Provide deterministic invitation expiration behavior.',
    text,
  );
  validateWorkspace(source);
}

test('optional canonical categories are omitted rather than rendered as empty headings', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const feature = path.join(source, 'feature_spec.md');
  for (const line of [
    '  decisions: shared/decisions.md\n',
    '  constraints: shared/constraints.md\n',
    '  risks: shared/risks.md\n',
    '  questions: shared/questions.md\n',
  ]) replace(feature, line, '');
  for (const name of ['decisions.md', 'constraints.md', 'risks.md', 'questions.md']) {
    fs.unlinkSync(path.join(source, 'shared', name));
  }
  replace(
    path.join(source, 'shared', 'acceptance-criteria.md'),
    '- references: [D-001, C-001, RK-001]\n',
    '',
  );
  validateWorkspace(source);
  const rendered = fs.readFileSync(path.join(build(root, source), 'feature_spec.md'), 'utf8');
  for (const heading of ['Durable Decisions', 'Relevant Constraints', 'Relevant Risks', 'Durable Resolved Questions']) {
    assert.equal(rendered.includes(`## ${heading}\n`), false, heading);
  }
});

test('pure renderer output is identical across V8 hash seeds and locales',t=>{
 const root=temporary(t),source=fresh(root,'unicode source');mutateObjective(source,'Preservar café, ação e 東京.');const before=workspaceSnapshot(source),outputs=[];
 for(const [seed,locale] of [[1,'C'],[2,'pt_BR.UTF-8']]){
  const entry=path.join(SKILL_ROOT,'runtime/lib/closed-spec.mjs');
  const code=`import {renderClosedFeature} from ${JSON.stringify(new URL('file://'+entry).href)};process.stdout.write(renderClosedFeature(process.argv[1]));`;
  const result=spawnSync(process.execPath,[`--hash-seed=${seed}`,'--input-type=module','-e',code,source],{encoding:'utf8',cwd:root,env:{...process.env,LC_ALL:locale,LANG:locale}});assert.equal(result.status,0,result.stderr);outputs.push(result.stdout);
 }
 assert.equal(outputs[0],outputs[1]);assert.deepEqual(workspaceSnapshot(source),before);
});

test('external directories and files are preserved while all OS metadata forms are omitted', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const execution = path.join(source, 'assets');
  fs.mkdirSync(path.join(execution, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(execution, 'payload.bin'), Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(source, '.DS_Store'), 'ignored');
  fs.writeFileSync(path.join(source, '._finder'), 'ignored');
  fs.mkdirSync(path.join(source, '__MACOSX'));
  fs.writeFileSync(path.join(source, '__MACOSX', 'ignored'), 'ignored');
  const sourceBefore = treeSnapshot(source);
  const candidate = build(root, source);
  assert.deepEqual(fs.readFileSync(path.join(candidate, 'assets', 'payload.bin')), Buffer.from([0, 1, 255]));
  assert.equal(fs.statSync(path.join(candidate, 'assets', 'empty')).isDirectory(), true);
  for (const relative of ['.DS_Store', '._finder', '__MACOSX']) assert.equal(exists(path.join(candidate, relative)), false);
  assert.deepEqual(treeSnapshot(source), sourceBefore);
  compareCloseDocuments(source, candidate);
});

test('hardlink peers hidden in ignored metadata are rejected without residue', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const execution = path.join(source, 'assets');
  fs.mkdirSync(execution);
  const linked = path.join(execution, 'linked.bin');
  fs.writeFileSync(linked, 'metadata peer\n');
  const metadata = path.join(source, '.DS_Store');
  if (!createHardlinkOrSkip(t, linked, metadata)) return;
  const before = treeSnapshot(source);
  assert.throws(() => build(root, source, 'candidate'), /crosses the CLOSE preservation boundary/u);
  assert.deepEqual(treeSnapshot(source), before);
  assert.equal(fs.lstatSync(linked).ino, fs.lstatSync(metadata).ino);
  // This unit helper owns a partial fixture directory; publisher cleanup is tested separately.
});

test('hardlinked symlinks are preserved without dereferencing when the filesystem supports them', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  const execution = path.join(source, 'assets');
  fs.mkdirSync(execution);
  fs.writeFileSync(path.join(execution, 'target.bin'), 'target\n');
  const first = path.join(execution, 'alias-a');
  const second = path.join(execution, 'alias-b');
  if (!createSymlinkOrSkip(t, 'target.bin', first, process.platform === 'win32' ? 'file' : undefined)) return;
  if(process.platform==='darwin')execFileSync('/bin/ln',['-P','-h','--',first,second],{shell:false,timeout:2000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});
  else if (!createHardlinkOrSkip(t, first, second)) return;
  const firstMetadata = fs.lstatSync(first);
  const secondMetadata = fs.lstatSync(second);
  assert.equal(firstMetadata.isSymbolicLink(),true,'fixture must create the symlink inode, not link its target');
  assert.equal(secondMetadata.isSymbolicLink(),true);
  assert.equal(firstMetadata.ino,secondMetadata.ino);
  assert.equal(firstMetadata.nlink,2);
  const candidate = build(root, source);
  const copiedFirst = path.join(candidate, 'assets', 'alias-a');
  const copiedSecond = path.join(candidate, 'assets', 'alias-b');
  assert.equal(fs.lstatSync(copiedFirst).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(copiedSecond).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(copiedFirst), 'target.bin');
  assert.equal(fs.readlinkSync(copiedSecond), 'target.bin');
  assert.equal(fs.lstatSync(copiedFirst).ino, fs.lstatSync(copiedSecond).ino);
  assert.equal(fs.lstatSync(copiedFirst).nlink, 2);
  assert.notEqual(fs.lstatSync(copiedFirst).ino, firstMetadata.ino);
  compareCloseDocuments(source, candidate);
});

// Operational allocation, cleanup and CAS cases moved to the normal publisher below.
test('post-render CLOSE transition rejects invented, discarded, and rewritten authority', async (t) => {
  const mutations = [
    ['invented item', (feature) => {
      const extra = `### R-999 — Invented requirement

- status: in_scope
- coverage_justification: This documentary-only requirement has no observable acceptance behavior.

This record was not present in the active source.

`;
      replace(feature, '## Business Rules\n', `${extra}## Business Rules\n`);
    }, /invented canonical items/u],
    ['discarded final question', (feature) => {
      const data = fs.readFileSync(feature);
      const marker = data.indexOf(Buffer.from('## Durable Resolved Questions\n'));
      assert.notEqual(marker, -1);
      fs.writeFileSync(feature, data.subarray(0, marker));
    }, /discarded canonical items/u],
    ['rewritten requirement', (feature) => replace(
      feature,
      'An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.',
      'A rewritten requirement changes durable authority.',
    ), /changed canonical content for R-001/u],
  ];
  for (const [index, [name, mutate, diagnostic]] of mutations.entries()) {
    await t.test(name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `stnl transition ${index} `));
      try {
        const source = fresh(root);
        const candidate = build(root, source);
        mutate(path.join(candidate, 'feature_spec.md'));
        assert.throws(() => compareCloseDocuments(source, candidate), diagnostic);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('valid retired tombstone bytes survive deterministic closure unchanged', (t) => {
  const root = temporary(t);
  const source = fresh(root);
  replace(path.join(source, 'feature_spec.md'), '- R-001\n', '- R-001\n- R-002\n');
  const tombstone = Buffer.from(`### R-002 — Retired duplicate requirement

- status: retired
- retired_reason: The requirement duplicated R-001 and remains reserved for history.

This authority remains as a documentary tombstone.
`, 'utf8');
  fs.appendFileSync(path.join(source, 'shared', 'requirements.md'), Buffer.concat([Buffer.from('\n'), tombstone]));
  validateWorkspace(source);
  const candidate = build(root, source);
  assert.equal(fs.readFileSync(path.join(candidate, 'feature_spec.md')).includes(tombstone), true);
});

for(const fault of ['copy-failure','source-drift','invalid-stage'])test(`normal CLOSE ${fault} preserves source and handles only its provable stage`,async t=>{
 const root=temporary(t),source=fresh(root),assets=path.join(source,'assets');fs.mkdirSync(assets);fs.writeFileSync(path.join(assets,'payload'),'preserve');
 const before=treeSnapshot(source),originalCopy=fs.copyFileSync;
 const {publishCandidate}=await import('../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs');
 const {resolveExecutionFilesystemRoots}=await import('../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs');
 const filesystemContext={productRoot:root,temporaryRoot:path.join(root,'excluded'),excludedRoots:[path.join(root,'excluded')]};
 const options={filesystemContext,beforePublish:async({stage})=>{
  if(fault==='source-drift')mutateObjective(source,'A concurrent documentary change remains authoritative.');
  if(fault==='invalid-stage')fs.appendFileSync(path.join(stage,'feature_spec.md'),'unexpected stage drift');
 }};
 if(fault==='copy-failure')fs.copyFileSync=function(from,...args){if(from===path.join(assets,'payload'))throw Object.assign(new Error('controlled external copy failure'),{code:'EIO'});return originalCopy.call(this,from,...args);};
 try{await assert.rejects(publishCandidate('CLOSE',source,null,options),/controlled external copy|source changed|transaction-owned stage changed bytes/u);}
 finally{fs.copyFileSync=originalCopy;}
 if(fault!=='source-drift')assert.deepEqual(treeSnapshot(source),before);else assert.match(fs.readFileSync(path.join(source,'feature_spec.md'),'utf8'),/concurrent documentary/u);
 const roots=await resolveExecutionFilesystemRoots({specRoot:source,executionRoot:path.join(source,'execution'),filesystemContext});
 const names=fs.existsSync(roots.materialRoot)?fs.readdirSync(roots.materialRoot):[];if(fault==='invalid-stage')assert.ok(names.some(n=>n.includes('lifecycle-stage-')),'changed stage must remain for diagnosis');
 else assert.equal(names.some(n=>n.includes('lifecycle-stage-')||n.includes('lifecycle-backup-')||n.includes('lifecycle-ownership-')||n==='lifecycle-transaction.json'),false);
 assert.equal(fs.readFileSync(path.join(assets,'payload'),'utf8'),'preserve');
});
