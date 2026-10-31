import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveExecutionFilesystemContext, resolveExecutionFilesystemRoots, executionLockIdentity,
  acquireExecutionPublicationLock, releaseExecutionPublicationLock, lifecycleCommonLeaseBinding} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {resolveCurrentExecutionContext, resolveExecutionWorkspace, executionWorkspaceFromContext} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-workspace.mjs';
import {createReadinessAttestation} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/readiness.mjs';
import {READY_FIXTURE} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
import {inspectLifecycleLocatorTransition} from
  '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflows = ['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor',
  'stnl-slice-quality-manager','stnl-spec-roadmap','stnl-spec-test-runbook','stnl-spec-lifecycle-manager'];
const sha = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error.code === expected;

async function fixture(t, {git = true} = {}) {
  // Outside this checkout: otherwise its enclosing .git would make the
  // purported non-Git fixture a Git workspace before the intended assertion.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'filesystem-locator-')));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const productRoot = path.join(root, 'project');
  const specRoot = path.join(productRoot, 'specs', 'feature with spaces');
  await fs.mkdir(path.dirname(specRoot), {recursive:true});
  // Root discovery only: this marker does NOT prove a Git repository/ignore.
  if (git) await fs.mkdir(path.join(productRoot, '.git'));
  const workspace = {specRoot, executionRoot:path.join(specRoot, 'execution')};
  const temporaryRoot = path.join(root, 'excluded operations');
  const explicit = {productRoot, temporaryRoot, excludedRoots:[temporaryRoot]};
  return {root, productRoot, workspace, explicit};
}

async function snapshot(root) {
  const rows = [];
  async function visit(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), metadata = await fs.lstat(file);
      const relative = path.relative(root, file);
      rows.push([relative, metadata.dev, metadata.ino, metadata.mode, metadata.nlink,
        metadata.isSymbolicLink() ? await fs.readlink(file)
          : metadata.isFile() ? sha(await fs.readFile(file)) : 'directory']);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await visit(file);
    }
  }
  await visit(root);
  return rows;
}

async function unchanged(f, action) {
  const before = await snapshot(f.root);
  await action();
  assert.deepEqual(await snapshot(f.root), before, 'read-only locator changed filesystem state');
}

test('locator keeps one logical key for absent and existing lifecycle target without allocation', async t => {
  const f = await fixture(t);
  let absent;
  await unchanged(f, async () => { absent = await resolveExecutionFilesystemContext(f.workspace); });
  assert.equal(absent.productRoot, f.productRoot);
  assert.equal(absent.specKey, sha(f.workspace.executionRoot));
  assert.equal(absent.lockPath, path.join(f.productRoot, 'tmp/sentinel', `${absent.specKey}.lock`));
  assert.equal(absent.materialRoot, path.join(f.productRoot, 'tmp/sentinel', absent.specKey));
  assert.equal(absent.exclusion.kind, 'git-ignore-unverified');
  assert.equal(absent.activation, 'read-only');
  assert.equal(absent.leaseParentIdentity, null);
  assert.equal(absent.targetParent, path.dirname(f.workspace.specRoot));
  assert.deepEqual(absent.targetParentIdentity, absent.officialParentIdentity);
  assert.equal(absent.materialRootIdentity, null);
  assert.equal(absent.leaseParentAnchor.path, f.productRoot);
  assert.equal(absent.materialRootAnchor.path, f.productRoot);
  for (const [field, name] of [['lifecycleLock','lifecycle.lock'],
    ['lifecycleJournal','lifecycle-transaction.json'], ['readinessAttestation','readiness-attestation.json']])
    assert.equal(absent[field], path.join(absent.materialRoot, name));
  await fs.mkdir(f.workspace.executionRoot, {recursive:true});
  await unchanged(f, async () => {
    const existing = await resolveExecutionFilesystemContext(f.workspace);
    assert.equal(existing.specKey, absent.specKey);
    assert.equal(existing.lockPath, absent.lockPath);
    assert.equal(existing.officialParent, absent.officialParent);
  });
  await fs.rename(f.workspace.specRoot, f.workspace.specRoot + '.test-owned-previous');
  await unchanged(f, async () => {
    const during = await resolveExecutionFilesystemContext(f.workspace);
    assert.equal(during.specKey, absent.specKey);
    assert.equal(during.lockPath, absent.lockPath);
    assert.deepEqual(during.targetParentIdentity, absent.targetParentIdentity);
  });
  assert.equal(await fs.stat(absent.temporaryRoot).catch(() => null), null);
});

test('locator resolves an absent parent chain but does not create official or operational directories', async t => {
  const f = await fixture(t);
  const specRoot = path.join(f.productRoot, 'missing', 'parent', 'target');
  await unchanged(f, async () => {
    const found = await resolveExecutionFilesystemContext({specRoot, executionRoot:path.join(specRoot, 'execution')});
    assert.equal(found.officialParentIdentity, null);
    assert.equal(found.officialAnchor.path, f.productRoot);
    assert.equal(found.executionRoot, path.join(specRoot, 'execution'));
  });
});

test('non-Git requires exact explicit exclusion and keeps operational root separate from product authority', async t => {
  const f = await fixture(t, {git:false});
  await unchanged(f, async () => {
    await assert.rejects(resolveExecutionFilesystemContext(f.workspace), code('TEMP_ROOT_UNPROVEN'));
    const found = await resolveExecutionFilesystemContext(f.workspace, f.explicit);
    assert.equal(found.productRoot, f.productRoot);
    assert.equal(found.temporaryRoot, f.explicit.temporaryRoot);
    assert.equal(found.exclusion.kind, 'launcher-declared');
    assert.equal(found.activation, 'read-only');
    assert.equal(found.preparationRegistry, path.join(found.materialRoot, 'preparations.json'));
    assert.equal(found.operationRegistry, path.join(found.materialRoot, 'registry.json'));
    for (const excludedRoots of [[], [f.root], [path.parse(f.root).root],
      [f.explicit.temporaryRoot, f.explicit.temporaryRoot]]) {
      await assert.rejects(resolveExecutionFilesystemContext(f.workspace, {...f.explicit, excludedRoots}),
        code('TEMP_ROOT_UNPROVEN'));
    }
  });
});

test('Git context cannot replace normal roots or claim ignore was checked', async t => {
  const f = await fixture(t);
  const context = {...f.explicit, temporaryRoot:path.join(f.productRoot, 'tmp/sentinel'), excludedRoots:[]};
  await unchanged(f, async () => {
    assert.equal((await resolveExecutionFilesystemContext(f.workspace, context)).exclusion.kind,
      'git-ignore-unverified');
    await assert.rejects(resolveExecutionFilesystemContext(f.workspace, f.explicit), code('TEMP_ROOT_UNPROVEN'));
    await assert.rejects(resolveExecutionFilesystemContext(f.workspace, {...context, productRoot:f.root}),
      code('TEMP_ROOT_UNPROVEN'));
  });
});

test('malformed roots, policy fields, escapes and overlap are refused before any allocation', async t => {
  const f = await fixture(t, {git:false});
  await unchanged(f, async () => {
    let getterCalled = false;
    const accessorContext = {...f.explicit};
    Object.defineProperty(accessorContext, 'productRoot', {get() { getterCalled = true; return f.productRoot; }, enumerable:true});
    for (const filesystemContext of [{}, {...f.explicit, extra:true}, {...f.explicit, excludedRoots:'tmp'},
      accessorContext, Object.assign(Object.create({foreign:true}), f.explicit),
      {...f.explicit, excludedRoots:Array(33).fill(f.explicit.temporaryRoot)}])
      await assert.rejects(resolveExecutionFilesystemContext(f.workspace, filesystemContext), code('TEMP_ROOT_UNPROVEN'));
    assert.equal(getterCalled, false, 'untrusted context accessor must not run');
    for (const workspace of [{...f.workspace, executionRoot:'relative'},
      {...f.workspace, executionRoot:f.workspace.executionRoot + '/../escape'},
      {...f.workspace, executionRoot:f.workspace.executionRoot + '/'},
      {...f.workspace, executionRoot:path.join(f.root, 'foreign-execution')},
      {...f.workspace, executionRoot:path.join(f.workspace.specRoot, 'wrong')}])
      await assert.rejects(resolveExecutionFilesystemContext(workspace, f.explicit), code('UNSAFE_PATH'));
    for (const temporaryRoot of [f.workspace.specRoot, f.workspace.executionRoot, f.productRoot])
      await assert.rejects(resolveExecutionFilesystemContext(f.workspace,
        {...f.explicit, temporaryRoot, excludedRoots:[temporaryRoot]}), code('UNSAFE_PATH'));
  });
});

test('symlink official, operational and Git marker ancestry is refused without following or deleting it', async t => {
  const f = await fixture(t, {git:false});
  const other = path.join(f.root, 'other'); await fs.mkdir(other);
  await fs.symlink(other, f.workspace.specRoot);
  await unchanged(f, () => assert.rejects(resolveExecutionFilesystemContext(f.workspace, f.explicit), code('UNSAFE_PATH')));
  await fs.unlink(f.workspace.specRoot);
  await fs.symlink(other, f.explicit.temporaryRoot);
  await unchanged(f, () => assert.rejects(resolveExecutionFilesystemContext(f.workspace, f.explicit), code('UNSAFE_PATH')));
  await fs.unlink(f.explicit.temporaryRoot);
  await fs.symlink(other, path.join(f.productRoot, '.git'));
  await unchanged(f, () => assert.rejects(resolveExecutionFilesystemContext(f.workspace, f.explicit), code('UNSAFE_PATH')));
});

test('non-directory official or namespace paths are refused and foreign bytes retained', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.workspace.specRoot, 'foreign target');
  await unchanged(f, () => assert.rejects(resolveExecutionFilesystemContext(f.workspace), code('UNSAFE_PATH')));
  await fs.unlink(f.workspace.specRoot);
  const found = await resolveExecutionFilesystemContext(f.workspace);
  await fs.mkdir(found.temporaryRoot, {recursive:true});
  await fs.writeFile(found.materialRoot, 'foreign namespace');
  await unchanged(f, () => assert.rejects(resolveExecutionFilesystemContext(f.workspace), code('UNSAFE_PATH')));
});

test('different filesystem is rejected using declared syscall metadata fault injection, not a real mount', async t => {
  const f = await fixture(t, {git:false});
  await fs.mkdir(f.explicit.temporaryRoot);
  const material = path.join(f.explicit.temporaryRoot, sha(f.workspace.executionRoot));
  await fs.mkdir(material);
  const original = fs.lstat;
  try {
    for (const mounted of [f.explicit.temporaryRoot, material]) {
      fs.lstat = async (file, ...options) => {
        const found = await original(file, ...options);
        return file === mounted ? new Proxy(found, {
          get(target, field) { return field === 'dev' ? target.dev + 1 : Reflect.get(target, field); },
        }) : found;
      };
      await unchanged(f, () => assert.rejects(resolveExecutionFilesystemContext(f.workspace, f.explicit), code('CROSS_FILESYSTEM')));
    }
  } finally { fs.lstat = original; }
});

test('old controls block the proposed transition, preserving foreign bytes and physical identities', async t => {
  for (const suffix of ['', '.recovery-foreign', '.retired-foreign', 'preparations']) {
    const f = await fixture(t);
    const roots=await resolveExecutionFilesystemRoots(f.workspace);
    const old={lockPath:path.join(roots.targetParent,`.stnl-execution-${roots.specKey}.lock`)};
    const file = suffix === 'preparations' ? old.lockPath.replace(/\.lock$/u, '.preparations.json') : old.lockPath + suffix;
    await fs.writeFile(file, 'foreign controls are not evidence of dispensability');
    await unchanged(f, () => assert.rejects(resolveExecutionFilesystemContext(f.workspace), code('EXECUTION_PUBLICATION_BLOCKED')));
  }
});

test('active writer uses the coordinated common lease domain with unchanged v1 header', async t => {
  const f = await fixture(t);
  const proposed = await resolveExecutionFilesystemContext(f.workspace);
  await fs.mkdir(proposed.leaseParent,{recursive:true});
  const current = await executionLockIdentity(f.workspace);
  assert.equal(proposed.lockPath,current.lockPath);
  const lease = await acquireExecutionPublicationLock(f.workspace);
  try {
    assert.equal(lease.lockPath,current.lockPath);
    await unchanged(f,async()=>assert.equal((await resolveExecutionFilesystemContext(f.workspace)).lockPath,current.lockPath));
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(current.lockPath))).sort(),['executionRoot','format','pid','token']);
    assert.ok(await fs.stat(proposed.lockPath));
  } finally { await releaseExecutionPublicationLock(lease); }
});

test('explicit standalone context is separate from ImageContext and default readers remain unchanged', async t => {
  const f = await fixture(t, {git:false});
  const source = path.join(f.productRoot, 'specs', 'requirements.md');
  await fs.writeFile(source, '# Requirements\n');
  await fs.mkdir(f.explicit.temporaryRoot,{recursive:true});
  await unchanged(f, async () => {
    const original = await resolveCurrentExecutionContext(source);
    assert.equal(Object.hasOwn(original, 'filesystemContext'), false);
    const resolved = await resolveCurrentExecutionContext(source, {filesystemContext:f.explicit});
    assert.deepEqual(Object.keys(resolved.context).sort(),
      ['logicalSpecRoot','logicalAuthorityPath','logicalExecutionRoot','physicalExecutionRoot','productRoot'].sort());
    assert.equal(resolved.filesystemContext.productRoot, f.productRoot);
    assert.equal(resolved.context.logicalExecutionRoot, original.context.logicalExecutionRoot);
    assert.deepEqual(await resolveCurrentExecutionContext(source), original);
  });
});

test('seven standalone module copies expose the same read-only locator and identical source bytes', async t => {
  const f = await fixture(t);
  const expected = await resolveExecutionFilesystemContext(f.workspace);
  const sources = new Map();
  await unchanged(f, async () => {
    for (const workflow of workflows) {
      const base = path.join(repository, 'skills/workflows', workflow,
        workflow === 'stnl-spec-lifecycle-manager' ? 'runtime/lib' : 'runtime');
      for (const name of ['execution-publication.mjs','execution-workspace.mjs']) {
        const file = path.join(base, name), bytes = await fs.readFile(file);
        if (!sources.has(name)) sources.set(name, bytes);
        assert.deepEqual(bytes, sources.get(name), `${workflow}/${name} differs`);
        const module = await import(pathToFileURL(file).href);
        assert.deepEqual(await module.resolveExecutionFilesystemContext(f.workspace), expected);
      }
    }
  });
});

test('normal workspace wrappers forward only the policy input into the coordinated lease domain', async t => {
  const f = await fixture(t, {git:false});
  const source = path.join(f.productRoot, 'specs', 'requirements.md');
  await fs.writeFile(source, '# Requirements\n');
  await fs.mkdir(f.explicit.temporaryRoot,{recursive:true});
  await unchanged(f, async () => {
    const resolved = await resolveCurrentExecutionContext(source, {filesystemContext:f.explicit});
    const workspace = await resolveExecutionWorkspace(source, {filesystemContext:f.explicit});
    assert.deepEqual(workspace, resolved.workspace);
    assert.deepEqual(workspace.filesystemContext, f.explicit);
    assert.deepEqual(Object.keys(workspace.filesystemContext).sort(), ['excludedRoots','productRoot','temporaryRoot']);
    assert.deepEqual(await resolveExecutionFilesystemRoots(workspace), resolved.filesystemContext);
    const bound = executionWorkspaceFromContext(resolved.context, workspace);
    assert.deepEqual(bound.filesystemContext, f.explicit);
    assert.equal((await executionLockIdentity(bound)).lockPath, resolved.filesystemContext.lockPath);
    await assert.rejects(resolveExecutionFilesystemRoots(bound,
      {...f.explicit, temporaryRoot:path.join(f.root, 'other'), excludedRoots:[path.join(f.root, 'other')]}),
    code('TEMP_ROOT_UNPROVEN'));
    const lease = await acquireExecutionPublicationLock(bound);
    try {
      assert.equal(lease.lockPath, (await executionLockIdentity(bound)).lockPath);
      // Reentry observes the same coordinated domain while its OWN lease exists.
      assert.deepEqual((await resolveCurrentExecutionContext(source, {filesystemContext:f.explicit})).workspace, workspace);
      assert.equal((await resolveExecutionFilesystemContext(bound)).lockPath,lease.lockPath);
      assert.ok(await fs.stat(resolved.filesystemContext.lockPath));
      assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(lease.lockPath))).sort(),['executionRoot','format','pid','token']);
    } finally { await releaseExecutionPublicationLock(lease); }
  });
});

test('caller binding rejects official root overrides without allocating or using candidate physical roots', async t => {
  const f = await fixture(t, {git:false});
  const source = path.join(f.productRoot, 'specs', 'requirements.md');
  await fs.writeFile(source, '# Requirements\n');
  const {context, workspace} = await resolveCurrentExecutionContext(source, {filesystemContext:f.explicit});
  await unchanged(f, async () => {
    const candidate = {...context, physicalExecutionRoot:path.join(f.root, 'candidate')};
    assert.equal(executionWorkspaceFromContext(candidate, workspace).executionRoot, context.logicalExecutionRoot);
    for (const field of ['executionRoot','specRoot','authorityPath','productRoot','temporaryRoot','materialRoot','leaseParent','lockPath','specKey'])
      assert.throws(() => executionWorkspaceFromContext(context, {...workspace, [field]:path.join(f.root, 'foreign')}), code('UNSAFE_PATH'));
    assert.throws(() => executionWorkspaceFromContext(context,
      {...workspace, filesystemContext:{...f.explicit, productRoot:f.root}}), code('UNSAFE_PATH'));
    assert.throws(() => executionWorkspaceFromContext(context,
      {...workspace, filesystemContext:{...f.explicit, temporaryRoot:'relative'}}), code('UNSAFE_PATH'));
    let invoked = false;
    const accessor = {...workspace};
    Object.defineProperty(accessor, 'executionRoot', {get() { invoked = true; return workspace.executionRoot; }});
    assert.throws(() => executionWorkspaceFromContext(context, accessor), code('UNSAFE_PATH'));
    assert.equal(invoked, false);
  });
});

test('allowed OS aliases roundtrip through canonical forwarded policy without a false root conflict', async t => {
  if (process.platform !== 'darwin') return t.skip('Darwin system aliases are not permitted on this platform');
  const f = await fixture(t, {git:false});
  const alias = value => value.replace(/^\/private\/(var|tmp|etc)(?=\/|$)/u, '/$1');
  assert.notEqual(alias(f.productRoot), f.productRoot, 'fixture must exercise a real permitted OS alias');
  const source = path.join(f.productRoot, 'specs', 'requirements.md');
  await fs.writeFile(source, '# Requirements\n');
  const input = {productRoot:alias(f.explicit.productRoot), temporaryRoot:alias(f.explicit.temporaryRoot),
    excludedRoots:f.explicit.excludedRoots.map(alias)};
  await unchanged(f, async () => {
    const resolved = await resolveCurrentExecutionContext(source, {filesystemContext:input});
    assert.deepEqual(resolved.workspace.filesystemContext, f.explicit);
    assert.deepEqual(await resolveExecutionFilesystemRoots(resolved.workspace, input), resolved.filesystemContext);
  });
});

test('custom excluded operational namespace cannot become a standalone official input', async t => {
  const f = await fixture(t, {git:false});
  const temporaryRoot = path.join(f.productRoot, 'custom operations');
  await fs.mkdir(temporaryRoot);
  const source = path.join(temporaryRoot, 'fake-requirements.md');
  await fs.writeFile(source, '# Not an official authority\n');
  await unchanged(f, () => assert.rejects(resolveCurrentExecutionContext(source,
    {filesystemContext:{...f.explicit, temporaryRoot, excludedRoots:[temporaryRoot]}}), code('UNSAFE_PATH')));
});

test('policy arrays with accessors and parent metadata changes are refused read-only', async t => {
  const f = await fixture(t, {git:false});
  let invoked = false;
  const excludedRoots = [];
  Object.defineProperty(excludedRoots, '0', {get() { invoked = true; return f.explicit.temporaryRoot; }});
  await unchanged(f, async () => {
    await assert.rejects(resolveExecutionFilesystemRoots(f.workspace, {...f.explicit, excludedRoots}), code('TEMP_ROOT_UNPROVEN'));
    assert.equal(invoked, false);
    const objectRoot = {toJSON() { invoked = true; return f.productRoot; }};
    await assert.rejects(resolveExecutionFilesystemRoots({...f.workspace, filesystemContext:f.explicit},
      {...f.explicit, productRoot:objectRoot}), code('UNSAFE_PATH'));
    assert.equal(invoked, false, 'policy comparison must not serialize caller-defined objects');
    const original = fs.lstat, parent = path.dirname(f.workspace.specRoot);
    let reads = 0;
    try {
      fs.lstat = async (file, ...options) => {
        const metadata = await original(file, ...options);
        return file === parent && ++reads >= 3 ? new Proxy(metadata, {
          get(target, field) { return field === 'ino' ? target.ino + 1 : Reflect.get(target, field); },
        }) : metadata;
      };
      await assert.rejects(resolveExecutionFilesystemRoots(f.workspace, f.explicit), code('UNSAFE_PATH'));
      assert.ok(reads >= 3, 'parent identity recheck assertion must be reached');
    } finally { fs.lstat = original; }
  });
});

async function releasedLegacy(f) {
  // Authored historical fixture: create/capture/remove its own four-field v1
  // common file, then retain only the released lifecycle record. No old API runs.
  const roots=await resolveExecutionFilesystemRoots(f.workspace),parent=roots.targetParent;
  const oldCommon=path.join(parent,`.stnl-execution-${roots.specKey}.lock`),token=randomUUID();
  const bytes=Buffer.from(JSON.stringify({format:'stnl-execution-lock-v1',token,executionRoot:roots.executionRoot,pid:process.pid})+'\n');
  await fs.writeFile(oldCommon,bytes,{flag:'wx'});const meta=await fs.lstat(oldCommon);await fs.unlink(oldCommon);
  const binding={format:'stnl-lifecycle-common-lease-v1',executionRoot:roots.executionRoot,lockPath:oldCommon,
    parentIdentity:roots.targetParentIdentity,identity:{dev:String(meta.dev),ino:String(meta.ino)},sha256:'sha256:'+sha(bytes),token,pid:process.pid,hostname:os.hostname()};
  const file = path.join(path.dirname(f.workspace.specRoot), `.${path.basename(f.workspace.specRoot)}.lifecycle.lock`);
  const payload = {version:2, state:'released', owner_id:'a'.repeat(32), operation_id:'b'.repeat(32),
    transaction_id:null, pid:process.pid, hostname:os.hostname(), started_at:'2026-10-21T11:46:00.000Z', common_lease:binding};
  await fs.writeFile(file, JSON.stringify(payload) + '\n');
  return {file, payload};
}

test('lifecycle transition inspection preserves valid released history without adopting it', async t => {
  const f = await fixture(t);
  await unchanged(f, async () => {
    const empty = await inspectLifecycleLocatorTransition(f.workspace.specRoot);
    assert.equal(empty.classification, 'clear');
    assert.equal(empty.activation, 'read-only');
  });
  const {file, payload} = await releasedLegacy(f);
  const foreign = path.join(path.dirname(file), '.another-spec.lifecycle-stage-foreign');
  await fs.writeFile(foreign, 'foreign bytes');
  await unchanged(f, async () => {
    const found = await inspectLifecycleLocatorTransition(f.workspace.specRoot);
    assert.equal(found.classification, 'historical-inert');
    assert.equal(found.activation, 'read-only');
    assert.equal(found.legacyLock.file, file);
    assert.equal(found.legacyLock.sha256, `sha256:${sha(await fs.readFile(file))}`);
    assert.deepEqual(found.legacyLock.identity,
      {dev:String((await fs.lstat(file)).dev), ino:String((await fs.lstat(file)).ino)});
  });
  const old = {...payload, version:1}; delete old.common_lease;
  await fs.writeFile(file, JSON.stringify(old));
  await unchanged(f, async () => assert.equal((await inspectLifecycleLocatorTransition(f.workspace.specRoot)).classification, 'historical-inert'));
});

test('lifecycle active, uncertain, forged and linked legacy locks remain blocked and untouched', async t => {
  const f = await fixture(t);
  const {file, payload} = await releasedLegacy(f);
  const missingBinding = {...payload}; delete missingBinding.common_lease;
  for (const value of [{...payload, state:'active'}, {...payload, transaction_id:'c'.repeat(32)},
    {...payload, extra:'forged'}, {...payload,filesystem_context:null},
    {...payload,filesystem_context:{format:'foreign',materialParent:{path:'/foreign',identity:{dev:'0',ino:'0'}}}}, missingBinding,
    {...payload, common_lease:{...payload.common_lease, executionRoot:path.join(f.root, 'foreign')}}]) {
    await fs.writeFile(file, JSON.stringify(value));
    await unchanged(f, () => assert.rejects(inspectLifecycleLocatorTransition(f.workspace.specRoot)));
  }
  await fs.writeFile(file, JSON.stringify(payload));
  await fs.link(file, file + '.foreign-link');
  await unchanged(f, () => assert.rejects(inspectLifecycleLocatorTransition(f.workspace.specRoot)));
  await fs.unlink(file + '.foreign-link');
  await fs.rename(file, file + '.test-owned-original');
  await fs.symlink(file + '.test-owned-original', file);
  await unchanged(f, () => assert.rejects(inspectLifecycleLocatorTransition(f.workspace.specRoot)));
});

test('released lifecycle history plus any related pending role blocks inspection without cleanup', async t => {
  const f = await fixture(t);
  const {file} = await releasedLegacy(f);
  const parent = path.dirname(file), targetName = path.basename(f.workspace.specRoot);
  const {specKey}=await resolveExecutionFilesystemRoots(f.workspace);
  const common = `.stnl-execution-${specKey}.lock`;
  for (const name of [`.${targetName}.lifecycle-transaction.json`, `.${targetName}.readiness-attestation.json`,
    ...['journal-tmp','journal-build','lock-tmp','lock-build','lock-retired','stage','backup','ownership',
      'ownership-tmp','ownership-build','retired-tree'].map(role => `.${targetName}.lifecycle-${role}-uncertain`),
    `.${targetName.toUpperCase()}.LIFECYCLE-STAGE-uncertain`,
    `..${targetName}.readiness-attestation.json.lifecycle-attestation-retired-uncertain`,
    common, `${common}.retired-unproven-v1`, `${common}.recovery-foreign`, common.replace(/\.lock$/u, '.preparations.json')]) {
    const residue = path.join(parent, name);
    await fs.writeFile(residue, 'pending or foreign material\n');
    await unchanged(f, () => assert.rejects(inspectLifecycleLocatorTransition(f.workspace.specRoot)));
    await fs.unlink(residue); // Test owns this fixture, never a production cleanup.
  }
});

test('lifecycle inspection refuses an actually replaced official parent while preserving control bytes and inode',async t=>{
  const f=await fixture(t),{file}=await releasedLegacy(f),parent=path.dirname(file),saved=parent+'.original';
  const before=await fs.readFile(file),metadata=await fs.lstat(file),probe=await fs.open(file,'r');
  const prototype=Object.getPrototypeOf(probe),readFile=prototype.readFile;await probe.close();let changed=false;
  prototype.readFile=async function(...args){const bytes=await readFile.apply(this,args);
    const held=await this.stat();
    if(!changed&&held.dev===metadata.dev&&held.ino===metadata.ino) {
      changed=true;await fs.rename(parent,saved);await fs.mkdir(parent);
      for(const name of await fs.readdir(saved))await fs.rename(path.join(saved,name),path.join(parent,name));
    }
    return bytes;
  };
  try{await assert.rejects(inspectLifecycleLocatorTransition(f.workspace.specRoot),/official parent changed/);}
  finally{prototype.readFile=readFile;}
  assert.equal(changed,true,'injection must occur while the legacy control is captured');
  assert.notEqual((await fs.lstat(parent)).ino,(await fs.lstat(saved)).ino);
  assert.deepEqual(await fs.readFile(file),before);assert.equal((await fs.lstat(file)).ino,metadata.ino);
});

test('legacy READY attestation is an inert external input, never adopted or removed by locator inspection',async t=>{
  const f=await fixture(t);await fs.cp(READY_FIXTURE,f.workspace.specRoot,{recursive:true});
  const file=path.join(path.dirname(f.workspace.specRoot),`.${path.basename(f.workspace.specRoot)}.readiness-attestation.json`);
  createReadinessAttestation(f.workspace.specRoot,file,{scope:'GLOBAL',verdict:'READY'});
  await releasedLegacy(f);
  const bytes=await fs.readFile(file),metadata=await fs.lstat(file);
  await unchanged(f,async()=>{
    const result=await inspectLifecycleLocatorTransition(f.workspace.specRoot);
    assert.equal(result.classification,'historical-inert');assert.equal(result.activation,'read-only');assert.ok(result.legacyLock);
    assert.deepEqual(result.legacyReadinessInput,{file,identity:{dev:String(metadata.dev),ino:String(metadata.ino)},sha256:'sha256:'+sha(bytes)});
  });
  const feature=path.join(f.workspace.specRoot,'feature_spec.md'),original=await fs.readFile(feature,'utf8');
  const changed=original.replace('Provide deterministic invitation expiration behavior.','Provide changed invitation expiration behavior.');
  assert.notEqual(changed,original);await fs.writeFile(feature,changed);
  await unchanged(f,()=>assert.rejects(inspectLifecycleLocatorTransition(f.workspace.specRoot),/stale|workspace/i));
  await fs.writeFile(feature,original);
  const linked=file+'.foreign-link';await fs.link(file,linked);
  await unchanged(f,()=>assert.rejects(inspectLifecycleLocatorTransition(f.workspace.specRoot),/single-link/));
  await fs.unlink(linked);
  await fs.writeFile(file,'foreign readiness bytes\n');
  await unchanged(f,()=>assert.rejects(inspectLifecycleLocatorTransition(f.workspace.specRoot),/readiness|JSON/i));
});

// These are kernel-level guards, with no model, recipe or benchmark invocation.
test('all seven families derive the same common lease and preserve unbound claims',async t=>{
 const f=await fixture(t),roots=await resolveExecutionFilesystemRoots(f.workspace);
 await fs.mkdir(roots.leaseParent,{recursive:true});
 for(const workflow of workflows){
  const relative=workflow==='stnl-spec-lifecycle-manager'?'runtime/lib':'runtime';
  const kernel=await import(pathToFileURL(path.join(repository,'skills/workflows',workflow,relative,'execution-publication.mjs')));
  assert.equal((await kernel.executionLockIdentity(f.workspace)).lockPath,roots.lockPath);
 }
 for(const suffix of ['.retired-unbound-v1','.recovery-unbound','.RETIRED-unbound','.RECOVERY-unbound']){
  const file=roots.lockPath+suffix;await fs.writeFile(file,'unbound claim must remain');
  await unchanged(f,()=>assert.rejects(acquireExecutionPublicationLock(f.workspace),/recovery is incomplete/u));
  assert.equal(await fs.stat(roots.lockPath).catch(()=>null),null);await fs.unlink(file);
 }
});

test('released legacy control is inert under common acquisition, not migrated or retired',async t=>{
 const f=await fixture(t),{file}=await releasedLegacy(f),bytes=await fs.readFile(file),before=await fs.lstat(file);
 const roots=await resolveExecutionFilesystemRoots(f.workspace);await fs.mkdir(roots.leaseParent,{recursive:true});
 const lease=await acquireExecutionPublicationLock(f.workspace);assert.equal(lease.lockPath,roots.lockPath);
 await releaseExecutionPublicationLock(lease);
 assert.deepEqual(await fs.readFile(file),bytes);assert.equal((await fs.lstat(file)).ino,before.ino);
});

test('special legacy lock is refused promptly by kernel and lifecycle, preserving its inode',async t=>{
 const f=await fixture(t),file=path.join(path.dirname(f.workspace.specRoot),`.${path.basename(f.workspace.specRoot)}.lifecycle.lock`);
 const run=promisify(execFile);await run('mkfifo',[file]);const before=await fs.lstat(file);
 for(const module of ['skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs','skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs']){
  const url=pathToFileURL(path.join(repository,module)).href;
  const expression=module.includes('publisher')?`await m.inspectLifecycleLocatorTransition(${JSON.stringify(f.workspace.specRoot)})`:`await m.resolveExecutionFilesystemContext(${JSON.stringify(f.workspace)})`;
  const code=`const m=await import(${JSON.stringify(url)});try{${expression};process.exitCode=2;}catch(error){if(!/regular/u.test(error.message))throw error;}`;
  const result=await run(process.execPath,['--input-type=module','-e',code],{timeout:3000});assert.equal(result.stdout,'');
 }
 assert.ok((await fs.lstat(file)).isFIFO());assert.equal((await fs.lstat(file)).ino,before.ino);
});
