import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {publishCandidate, recoverIncompletePublication, TEST_ONLY_ACK} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {checkDistributableSkill, LIFECYCLE_DISTRIBUTION_POLICY, EXECUTION_DISTRIBUTION_POLICY,
  ROADMAP_DISTRIBUTION_POLICY, RUNBOOK_DISTRIBUTION_POLICY} from './lib/check-distributable-skill.mjs';
import {READY_FIXTURE, PUBLISHER_CLI, buildResumeFixture} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';

const skill = path.resolve('skills/workflows/stnl-spec-lifecycle-manager');
const publisher = path.join(skill, 'runtime/lib/publisher.mjs');
const publisherUrl = new URL('../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs', import.meta.url).href;
const sha = value => createHash('sha256').update(value).digest('hex');
const env = () => {
  const result = {...process.env};
  for (const key of Object.keys(result)) if (key.startsWith('STNL_PUBLISHER_TEST_ONLY_')) delete result[key];
  delete result.NODE_TEST_CONTEXT;
  return result;
};
async function fixture(t, {git = true, ignored = true, productName = 'project with spaces'} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-git-')));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const product = path.join(root, productName);
  await fs.mkdir(product);
  if (git) {
    const result = spawnSync('git', ['init', '-q', product], {encoding:'utf8', timeout:10000});
    assert.equal(result.status, 0, result.stderr);
    await fs.writeFile(path.join(product, '.gitignore'), ignored ? '/tmp/sentinel/\n' : 'unrelated/\n');
  }
  const target = path.join(product, 'target with spaces'), candidate = path.join(product, 'candidate with spaces');
  await fs.cp(READY_FIXTURE, candidate, {recursive:true});
  const temporaryRoot = path.join(root, 'explicit excluded root');
  const filesystemContext = {productRoot:product, temporaryRoot, excludedRoots:[temporaryRoot]};
  return {root, product, target, candidate, filesystemContext};
}
async function snapshot(root) {
  const rows = [];
  async function visit(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name), stat = await fs.lstat(file);
      rows.push([path.relative(root, file), stat.dev, stat.ino, stat.mode, stat.nlink,
        stat.isFile() ? sha(await fs.readFile(file)) : stat.isSymbolicLink() ? await fs.readlink(file) : 'directory']);
      if (stat.isDirectory()) await visit(file);
    }
  }
  await visit(root);
  return rows;
}
async function unchanged(f, action) {
  const before = await snapshot(f.root);
  await action();
  assert.deepEqual(await snapshot(f.root), before, 'failure wrote or replaced filesystem state');
}
function cli(f, args = [], options = {}) {
  return spawnSync(process.execPath, [PUBLISHER_CLI, 'INIT', f.target, f.candidate, ...args],
    {cwd:f.root, encoding:'utf8', env:env(), timeout:20000, ...options});
}
async function fakeGit(f, body) {
  const bin = path.join(f.root, 'fake bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'git'), `#!${process.execPath}\n${body}\n`, {mode:0o755});
  return {...env(), PATH:bin};
}

test('normal Git API and CLI publish with absent ignored namespace; recovery preserves target', async t => {
  for (const entry of ['API', 'CLI']) await t.test(entry, async t => {
    const f = await fixture(t);
    if (entry === 'API') assert.equal(await publishCandidate('INIT', f.target, f.candidate), f.target);
    else { const result = cli(f); assert.equal(result.status, 0, result.stderr); }
    assert.equal((await fs.stat(path.join(f.product,'tmp','sentinel'))).isDirectory(),true,
      'publisher allocates its proved operational namespace');
    assert.equal(await fs.stat(path.join(path.dirname(f.target),`.${path.basename(f.target)}.lifecycle.lock`)).catch(()=>null),null,
      'lifecycle controls must not be allocated beside official target');
    const before = await snapshot(f.target);
    assert.equal(await recoverIncompletePublication(f.target), false);
    assert.deepEqual(await snapshot(f.target), before);
  });
});

test('existing target uses the same guard through RESUME API', async t => {
  const f = await fixture(t);
  await fs.rm(f.candidate, {recursive:true});
  const resume = await buildResumeFixture(f.product);
  await publishCandidate('RESUME', resume.target, resume.candidate, {manifestPath:resume.manifest});
  assert.equal(await recoverIncompletePublication(resume.target), false);
});

test('nonignored root blocks API, CLI and recovery without writes', async t => {
  const f = await fixture(t, {ignored:false});
  await unchanged(f, async () => {
    await assert.rejects(publishCandidate('INIT', f.target, f.candidate), /TEMP_ROOT_UNPROVEN/u);
    await assert.rejects(recoverIncompletePublication(f.target), /TEMP_ROOT_UNPROVEN/u);
    const result = cli(f); assert.equal(result.status, 1); assert.match(result.stderr, /TEMP_ROOT_UNPROVEN/u);
  });
});

test('divergent, overlapping and symlink roots block before writes', async t => {
  for (const kind of ['product', 'temporary', 'overlap', 'symlink']) await t.test(kind, async t => {
    const f = await fixture(t);
    let context = {productRoot:f.product, temporaryRoot:path.join(f.product, 'tmp/sentinel'), excludedRoots:[]};
    if (kind === 'product') context.productRoot = f.root;
    if (kind === 'temporary') context.temporaryRoot = path.join(f.product, 'other');
    if (kind === 'overlap') context.temporaryRoot = f.target;
    if (kind === 'symlink') {
      const alias = path.join(f.root, 'alias'); await fs.symlink(f.product, alias);
      context.productRoot = alias;
    }
    await unchanged(f, async () => {
      await assert.rejects(publishCandidate('INIT', f.target, f.candidate, {filesystemContext:context}), /filesystem:/u);
      const result = cli(f, ['--product-root', context.productRoot, '--temporary-root', context.temporaryRoot,
        '--excluded-root', context.temporaryRoot]);
      assert.equal(result.status, 1); assert.match(result.stderr, /filesystem:/u);
    });
  });
});

test('nonGit requires explicit exclusion, including CLI; no fallback or Git dependency', async t => {
  const f = await fixture(t, {git:false});
  await unchanged(f, async () => {
    await assert.rejects(publishCandidate('INIT', f.target, f.candidate), /TEMP_ROOT_UNPROVEN|explicit excluded/u);
    const invalid = {...f.filesystemContext, excludedRoots:[]};
    await assert.rejects(recoverIncompletePublication(f.target, {filesystemContext:invalid}), /explicitly excluded/u);
    for (const args of [['--product-root', f.product], ['--excluded-root=', '--product-root', f.product],
      ['--product-root', f.product, '--product-root', f.product]]) {
      assert.equal(cli(f, args).status, 2);
    }
  });
  const c = f.filesystemContext;
  const result = cli(f, ['--product-root', c.productRoot, '--temporary-root', c.temporaryRoot,
    '--excluded-root', c.temporaryRoot], {env:{...env(), PATH:''}});
  assert.equal(result.status, 0, result.stderr);
  const before = await snapshot(f.target);
  assert.equal(await recoverIncompletePublication(f.target, {filesystemContext:c}), false);
  assert.deepEqual(await snapshot(f.target), before);
});

test('nonGit recovery retains explicit context through automatic reentry', async t => {
  const f = await fixture(t, {git:false});
  const c = f.filesystemContext;
  const args = ['--product-root', c.productRoot, '--temporary-root', c.temporaryRoot, '--excluded-root', c.temporaryRoot];
  const result = cli(f, args, {env:{...env(), PATH:'', STNL_PUBLISHER_TEST_ONLY_CRASH_AT_CHECKPOINT:'JOURNAL_PREPARED',
    STNL_PUBLISHER_TEST_ONLY_ACKNOWLEDGE_PROCESS_KILL:TEST_ONLY_ACK}});
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  await assert.rejects(publishCandidate('INIT', f.target, f.candidate, {filesystemContext:c}), /INIT destination already exists/u);
  assert.equal(await recoverIncompletePublication(f.target, {filesystemContext:c}), false);
});

test('fixed argv query keeps spaces, shell text and option-like names literal', async t => {
  const f = await fixture(t, {productName:'--project ; $(touch SHOULD_NOT_EXIST)'});
  const log = path.join(f.root, 'query.json');
  const childEnv = await fakeGit(f, `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`);
  const result = cli(f, [], {env:childEnv});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.stat(path.join(f.root, 'SHOULD_NOT_EXIST')).catch(() => null), null);
  assert.deepEqual(JSON.parse(await fs.readFile(log, 'utf8')), ['-C', f.product, 'check-ignore', '-q', '--', path.join(f.product, 'tmp/sentinel') + path.sep]);
});

test('inherited Git authority overrides block before query or any publication write', async t => {
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) {
    await t.test(name, async t => {
      const f = await fixture(t);
      const marker = path.join(f.root, 'query-must-not-run');
      const childEnv = await fakeGit(f, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');`);
      await unchanged(f, async () => {
        const result = cli(f, [], {env:{...childEnv, [name]:name === 'GIT_CONFIG_COUNT' ? '0' : 'must-not-be-exposed'}});
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /TEMP_ROOT_UNPROVEN.*overrides/u);
        assert.ok(!result.stderr.includes('must-not-be-exposed'));
      });
    });
  }
});

test('Git nonzero, missing executable, timeout and excessive output block before writes', async t => {
  for (const kind of ['exit', 'missing', 'timeout', 'output']) await t.test(kind, async t => {
    const f = await fixture(t);
    const body = {exit:'process.exit(1);', timeout:'setTimeout(() => {}, 30000);',
      output:"process.stdout.write('x'.repeat(100000));"}[kind];
    const childEnv = kind === 'missing' ? {...env(), PATH:''} : await fakeGit(f, body);
    await unchanged(f, async () => {
      const result = cli(f, [], {env:childEnv});
      assert.equal(result.status, 1, `${kind}: ${result.stderr}`);
      assert.match(result.stderr, /TEMP_ROOT_UNPROVEN/u);
      assert.ok(result.stderr.length < 512, 'unbounded query output exposed');
    });
  });
});

test('restriction binds the actual publisher call and preserves other runtime boundaries', async t => {
  assert.deepEqual(await checkDistributableSkill(skill, LIFECYCLE_DISTRIBUTION_POLICY), []);
  const original = await fs.readFile(publisher, 'utf8');
  const mutations = [
    ['program', s => s.replace("execFile('git',", "execFile('sh',")],
    ['subcommand', s => s.replace("'check-ignore', '-q'", "'status', '-q'")],
    ['shell', s => s.replace('shell: false', 'shell: true')],
    ['timeout', s => s.replace('timeout: 10000', 'timeout: 0')],
    ['output bound', s => s.replace('maxBuffer: 16384', 'maxBuffer: Infinity')],
    ['variable program', s => s.replace("execFile('git',", "execFile(productRoot,")],
    ['extra call', s => s + "\nexecFile('git', []);\n"],
    ['alias', s => s.replace('{ execFile }', '{ execFile as run }').replace('execFile(', 'run(')],
    ['namespace', s => s.replace("import { execFile }", 'import * as child')],
    ['decoy', s => s.replace('shell: false', 'shell: true /* shell: false */')],
    ['literal decoy', s => s.replace("execFile('git',", "execFile('g i t',")],
    ['argv variable', s => s.replace("['-C', productRoot, 'check-ignore', '-q', '--', ignoredPath]", 'arguments')],
    ['property call', s => s.replace("execFile('git',", "child.execFile('git',")],
    ['escaped identifier', s => s.replace("execFile('git',", "exec\\u0046ile('git',")],
    ['options callback', s => s.replace('error => error ? reject(error) : resolve()', 'resolve')],
    ['additional import', s => s + "\nimport {spawn} from 'node:child_process';\n"],
  ];
  for (const [label, mutate] of mutations) await t.test(label, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-policy-'));
    t.after(() => fs.rm(root, {recursive:true, force:true}));
    await fs.cp(skill, root, {recursive:true});
    const changed = mutate(original); assert.notEqual(changed, original);
    await fs.writeFile(path.join(root, 'runtime/lib/publisher.mjs'), changed);
    assert.ok((await checkDistributableSkill(root, LIFECYCLE_DISTRIBUTION_POLICY))
      .some(value => value.includes('fixed bounded call')), label);
  });
  for (const file of ['runtime/lib/execution-publication.mjs', 'runtime/lib/lifecycle.mjs', 'runtime/other.mjs']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-boundary-'));
    t.after(() => fs.rm(root, {recursive:true, force:true}));
    await fs.mkdir(path.dirname(path.join(root, file)), {recursive:true});
    await fs.writeFile(path.join(root, file), "import {execFile} from 'node:child_process';\n");
    assert.ok((await checkDistributableSkill(root, LIFECYCLE_DISTRIBUTION_POLICY)).some(value => value.includes('must not execute')));
  }
  for (const policy of [{}, EXECUTION_DISTRIBUTION_POLICY, ROADMAP_DISTRIBUTION_POLICY, RUNBOOK_DISTRIBUTION_POLICY]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-other-policy-'));
    t.after(() => fs.rm(root, {recursive:true, force:true}));
    await fs.mkdir(path.join(root, 'runtime/lib'), {recursive:true});
    await fs.writeFile(path.join(root, 'runtime/lib/publisher.mjs'), original);
    assert.ok((await checkDistributableSkill(root, policy)).some(value => value.includes('must not execute')));
  }
});

test('Darwin symlink hardlink capability binds its only fixed bounded call and no other runtime', async t => {
  assert.deepEqual(await checkDistributableSkill(skill,LIFECYCLE_DISTRIBUTION_POLICY),[]);
  const relative='runtime/lib/closed-spec.mjs',original=await fs.readFile(path.join(skill,relative),'utf8');
  const mutations=[
    ['program',s=>s.replace("execFileSync('/bin/ln',","execFileSync('/bin/sh',")],
    ['variable program',s=>s.replace("execFileSync('/bin/ln',","execFileSync(first,")],
    ['follow flag',s=>s.replace("['-P', '-h', '--', first, second]","['-L', '-h', '--', first, second]")],
    ['missing destination guard flag',s=>s.replace("['-P', '-h', '--', first, second]","['-P', '--', first, second]")],
    ['force flag',s=>s.replace("['-P', '-h', '--', first, second]","['-P', '-h', '-f', '--', first, second]")],
    ['delimiter',s=>s.replace("['-P', '-h', '--', first, second]","['-P', '-h', first, second]")],
    ['variable argv',s=>s.replace("['-P', '-h', '--', first, second]",'arguments')],
    ['shell',s=>s.replace('shell: false','shell: true')],
    ['timeout',s=>s.replace('timeout: 2000','timeout: 0')],
    ['buffer',s=>s.replace('maxBuffer: 4096','maxBuffer: Infinity')],
    ['stdin',s=>s.replace("stdio: ['ignore', 'pipe', 'pipe']","stdio: ['pipe', 'pipe', 'pipe']")],
    ['comment decoy',s=>s.replace('shell: false','shell: true /* shell: false */')],
    ['literal decoy',s=>s.replace("execFileSync('/bin/ln',","execFileSync('/bin/l n',")],
    ['second call',s=>s+"\nexecFileSync('/bin/ln', []);\n"],
    ['alias',s=>s.replace('{ execFileSync }','{ execFileSync as run }').replace('execFileSync(','run(')],
    ['namespace',s=>s.replace("import { execFileSync } from 'node:child_process';","import * as child from 'node:child_process';").replace('execFileSync(','child.execFileSync(')],
    ['property',s=>s.replace('execFileSync(','child.execFileSync(')],
    ['escaped identifier',s=>s.replace('execFileSync(','exec\\u0046ileSync(')],
    ['escaped reference',s=>s+"\nconst run = execFileSync;\n"],
    ['additional import',s=>s+"\nimport {spawn} from 'node:child_process';\n"],
  ];
  for(const [label,mutate] of mutations)await t.test(label,async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'link-policy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    await fs.cp(skill,root,{recursive:true});const changed=mutate(original);assert.notEqual(changed,original,label);
    await fs.writeFile(path.join(root,relative),changed);
    assert.ok((await checkDistributableSkill(root,LIFECYCLE_DISTRIBUTION_POLICY)).some(value=>value.includes('symlink hardlink capability must retain its fixed bounded call')),label);
  });
  for(const relative of ['runtime/lib/execution-publication.mjs','runtime/lib/lifecycle.mjs','runtime/other.mjs'])await t.test(`other ${relative}`,async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'link-boundary-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),original);
    assert.ok((await checkDistributableSkill(root,LIFECYCLE_DISTRIBUTION_POLICY)).some(value=>value.includes('must not execute')));
  });
  for(const policy of [{},EXECUTION_DISTRIBUTION_POLICY,ROADMAP_DISTRIBUTION_POLICY,RUNBOOK_DISTRIBUTION_POLICY]){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'link-other-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    await fs.mkdir(path.join(root,'runtime/lib'),{recursive:true});await fs.writeFile(path.join(root,relative),original);
    assert.ok((await checkDistributableSkill(root,policy)).some(value=>value.includes('must not execute')));
  }
});
