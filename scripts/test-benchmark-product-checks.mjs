import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkProductAcceptance, PRODUCT_CONTRACT, productCandidateIdentity, productInstrumentIdentity, validateProductAcceptance } from '../benchmarks/sentinel-todo/runtime/product-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'benchmarks/sentinel-todo/seed');
const testEnvironment = { ...process.env };
delete testEnvironment.NODE_TEST_CONTEXT;

async function candidate(t, caseId, reference = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-product-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await fs.realpath(root);
  await fs.cp(SEED, workspace, { recursive: true });
  if (reference) await fs.copyFile(path.join(ROOT, 'scripts/fixtures', { A: 'filtered-cli.mjs', B: 'prioritized-cli.mjs', C: 'archived-cli.mjs' }[caseId]),
    path.join(workspace, 'src/cli.mjs'));
  return workspace;
}

async function replace(workspace, file, before, after) {
  const target = path.join(workspace, file);
  const text = await fs.readFile(target, 'utf8');
  assert.ok(text.includes(before), `mutant anchor missing: ${before}`);
  await fs.writeFile(target, text.replace(before, after));
}

for (const caseId of ['A', 'B']) {
  test(`fixed product oracle ${caseId}: correct reference and existing internal tests pass`, async (t) => {
    const workspace = await candidate(t, caseId);
    const internal = spawnSync(process.execPath, ['--test'], { cwd: workspace, env: testEnvironment, encoding: 'utf8' });
    assert.equal(internal.status, 0, internal.stdout + internal.stderr);
    assert.match(internal.stdout, /# pass [1-9][0-9]*/u, 'internal tests really execute');
    const evidence = await checkProductAcceptance(workspace, caseId);
    assert.equal(evidence.passed, true, JSON.stringify(evidence));
    assert.equal(evidence.contract, PRODUCT_CONTRACT);
    assert.equal(evidence.caseId, caseId);
    assert.equal(evidence.commands, caseId === 'A' ? 38 : 41);
    assert.equal(evidence.checks.length, caseId === 'A' ? 6 : 8);
    assert.equal(evidence.failedCheck, null);
    assert.equal(evidence.diagnostic, null);
    assert.equal(evidence.errorCode, null);
    // Only the CLI implementation reference was copied; the fixed assertions stay outside.
    assert.deepEqual((await fs.readdir(workspace)).sort(), (await fs.readdir(SEED)).sort());
    assert.deepEqual((await fs.readdir(path.join(workspace, 'test'))).sort(), (await fs.readdir(path.join(SEED, 'test'))).sort());
  });

  test(`fixed product oracle ${caseId}: seed fails even with a fabricated green candidate suite`, async (t) => {
    const workspace = await candidate(t, caseId, false);
    await fs.rm(path.join(workspace, 'test'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'test'));
    await fs.writeFile(path.join(workspace, 'test/green.test.mjs'), "import test from 'node:test'; test('green', () => {});\n");
    assert.equal(spawnSync(process.execPath, ['--test'], { cwd: workspace, env: testEnvironment, encoding: 'utf8' }).status, 0);
    const evidence = await checkProductAcceptance(workspace, caseId);
    assert.equal(evidence.passed, false);
    assert.match(evidence.failedCheck, caseId === 'A' ? /completed\/pending/u : /legacy compatibility/u);
    assert.equal(evidence.errorCode, 'ERR_ASSERTION');
  });
}

const mutants = [
  ['A', 'wrong order', 'src/cli.mjs', 'for (const todo of listed)', 'for (const todo of listed.reverse())', /ID order/u],
  ['A', 'inverted completed filter', 'src/cli.mjs', 'todo.completed === true', 'todo.completed === false', /subsets/u],
  ['A', 'pretty JSON output', 'src/cli.mjs', 'JSON.stringify(todo)', 'JSON.stringify(todo, null, 2)', /JSON lines/u],
  ['A', 'writes while listing', 'src/cli.mjs', 'const todos = await service.list();',
    'const todos = await service.list(); await service.store.write(todos);', /read-only/u],
  ['A', 'accepts mutually exclusive flags', 'src/cli.mjs', 'args.length > 1', 'args.length > 100', /conflicting/u],
  ['A', 'partial write before usage error', 'src/cli.mjs', "if (args.length > 1 ||", "if (args.length > 1 ||", /conflicting/u,
    async (workspace) => replace(workspace, 'src/cli.mjs',
      'stderr.write(`${usage}\\n`);\n        return 2;',
      'await service.store.write([]); stderr.write(`${usage}\\n`);\n        return 2;')],
  ['A', 'add does not persist', 'src/todo-service.mjs', 'await this.store.write([...todos, todo]);', '', /persistence/u],
  ['A', 'unexpected priority only in complete output', 'src/cli.mjs', 'JSON.stringify(await service.complete(args[0]))',
    "JSON.stringify({ ...(await service.complete(args[0])), priority: 'high' })", /add\/complete/u],
  ['B', 'wrong default', 'src/cli.mjs', "let priority = 'medium';", "let priority = 'low';", /add\/complete/u],
  ['B', 'ignores explicit priority', 'src/cli.mjs', 'priority = args[1];', "priority = 'medium';", /low\/medium\/high/u],
  ['B', 'priority output without persistence', 'src/cli.mjs', 'JSON.stringify({ todos }, null, 2)',
    'JSON.stringify({ todos: todos.map(({ priority, ...todo }) => todo) }, null, 2)', /persist/u],
  ['B', 'legacy read rewrites bytes', 'src/cli.mjs', 'return todos;',
    "await fs.writeFile(file, JSON.stringify({ todos })); return todos;", /read-only/u],
  ['B', 'complete drops explicit priority', 'src/cli.mjs', 'const updated = { ...todos[index], completed: true };',
    "const updated = { ...todos[index], completed: true, priority: 'medium' };", /complete preserves/u],
  ['B', 'invalid priority incorrectly uses usage code', 'src/cli.mjs',
    'if (!priorities.includes(priority)) throw new Error(`invalid priority: ${priority}`);',
    'if (!priorities.includes(priority)) { stderr.write(`${usage}\\n`); return 2; }', /invalid value/u],
  ['B', 'missing priority value incorrectly uses domain code', 'src/cli.mjs',
    'if (args.length < 3) { stderr.write(`${usage}\\n`); return 2; }',
    "if (args.length < 3) throw new Error('missing priority value');", /missing value/u],
  ['B', 'flag inside title changes parsing', 'src/cli.mjs', "args[0] === '--priority'", "args.includes('--priority')", /literal/u],
];

for (const [caseId, name, file, before, after, failedCheck, custom] of mutants) {
  test(`fixed product oracle ${caseId} rejects ${name}`, async (t) => {
    const workspace = await candidate(t, caseId);
    if (custom) await custom(workspace);
    else await replace(workspace, file, before, after);
    const evidence = await checkProductAcceptance(workspace, caseId);
    assert.equal(evidence.passed, false, JSON.stringify(evidence));
    assert.match(evidence.failedCheck, failedCheck);
    assert.ok(evidence.diagnostic);
  });
}

test('fixed product oracle B rejects added external dependency', async (t) => {
  const workspace = await candidate(t, 'B');
  const pkg = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
  pkg.dependencies = { 'not-installed': '1.0.0' };
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify(pkg));
  const evidence = await checkProductAcceptance(workspace, 'B');
  assert.equal(evidence.passed, false);
  assert.match(evidence.failedCheck, /dependencies/u);
});

test('fixed product oracle C: correct archive reference and unmodified seed tests pass', async t => {
  const workspace = await candidate(t, 'C');
  const internal = spawnSync(process.execPath, ['--test'], { cwd: workspace, env: testEnvironment, encoding: 'utf8' });
  assert.equal(internal.status, 0, internal.stdout + internal.stderr);
  assert.match(internal.stdout, /# pass [1-9][0-9]*/u);
  const evidence = await checkProductAcceptance(workspace, 'C');
  assert.equal(evidence.passed, true, JSON.stringify(evidence));
  assert.equal(evidence.caseId, 'C');
  assert.ok(evidence.checks.length >= 8);
  assert.ok(evidence.commands > 40);
});

const archiveMutants = [
  ['archived items leak into default list', "(todo.archived ?? false) === (args[0] === '--archived')", 'args.length === 0 || todo.archived === true', /active\/archive lists/u],
  ['archive loses completed state', "{ archived: command === 'archive' }", "{ completed: false, archived: command === 'archive' }", /completed preservation/u],
  ['archive does not persist', 'await write(todos); emit(updated);', "if (command === 'complete') await write(todos); emit(updated);", /persisted state/u],
  ['unarchive remains archived', "archived: command === 'archive'", 'archived: true', /persisted state/u],
  ['idempotent archive is rejected', 'const updated = { ...todos[index]', "if (command === 'archive' && todos[index].archived) throw new Error('already archived'); const updated = { ...todos[index]", /idempotent returns/u],
  ['complete accepts archived todo', "command === 'complete' && todos[index].archived", 'false', /complete archived/u],
  ['archive domain error uses usage exit', 'stderr.write(`error: ${error.message}\\n`); return 1;', "stderr.write(`error: ${error.message}\\n`); return ['archive', 'unarchive'].includes(command) ? 2 : 1;", /domain errors/u],
];
for (const [name, before, after, failedCheck] of archiveMutants) {
  test(`fixed product oracle C rejects ${name} despite green candidate tests`, async t => {
    const workspace = await candidate(t, 'C');
    await replace(workspace, 'src/cli.mjs', before, after);
    // The existing suite does not exercise archive: a green candidate suite is insufficient.
    const internal = spawnSync(process.execPath, ['--test'], { cwd: workspace, env: testEnvironment, encoding: 'utf8' });
    assert.equal(internal.status, 0, internal.stdout + internal.stderr);
    const evidence = await checkProductAcceptance(workspace, 'C');
    assert.equal(evidence.passed, false, JSON.stringify(evidence));
    assert.match(evidence.failedCheck, failedCheck);
  });
}

test('fixed product oracle C rejects transient writes restored before list returns', async t => {
  const workspace = await candidate(t, 'C');
  await replace(workspace, 'src/cli.mjs', 'for (const todo of await read())',
    "try { const original = await fs.readFile(file); await fs.writeFile(file, 'transient'); await fs.writeFile(file, original); } catch (e) { if (e.code !== 'ENOENT') throw e; } for (const todo of await read())");
  const evidence = await checkProductAcceptance(workspace, 'C');
  assert.equal(evidence.passed, false, JSON.stringify(evidence));
  assert.match(evidence.failedCheck, /read-only/u);
});

for (const [name, body] of [
  ['sync write and restore', "const f = await import('node:fs'); const original = f.readFileSync(file); f.writeFileSync(file, 'transient'); f.writeFileSync(file, original);"],
  ['FileHandle write on read-only descriptor caught by candidate', "const handle = await fs.open(file, 'r'); try { await handle.write('x'); } catch {} finally { await handle.close(); }"],
  ['write stream restoring identical bytes', "const f = await import('node:fs'); const original = await fs.readFile(file); await new Promise((resolve, reject) => { const out = f.createWriteStream(file); out.on('error', reject); out.on('finish', resolve); out.end(original); });"],
  ['temporary file removed before return', "await fs.writeFile(file + '.transient', 'x'); await fs.unlink(file + '.transient');"],
  ['failed write caught by candidate', "try { await fs.writeFile(path.dirname(file), 'x'); } catch {}"],
  ['rename round trip', "await fs.rename(file, file + '.moved'); await fs.rename(file + '.moved', file);"],
  ['caught subprocess capability', "try { (await import('node:child_process')).spawnSync(process.execPath, ['-e', '']); } catch {}"],
  ['caught worker capability', "try { new (await import('node:worker_threads')).Worker('', { eval: true }); } catch {}"],
  ['caught native addon capability', "try { process.dlopen({}, 'missing.node'); } catch {}"],
]) {
  test(`bounded storage observer rejects ${name}`, async t => {
    const workspace = await candidate(t, 'C');
    await replace(workspace, 'src/cli.mjs', 'for (const todo of await read())', `${body} for (const todo of await read())`);
    const evidence = await checkProductAcceptance(workspace, 'C');
    assert.equal(evidence.passed, false, JSON.stringify(evidence));
    assert.match(evidence.failedCheck, /read-only/u);
    assert.match(evidence.diagnostic, /write-attempt|unobserved-capability/u);
    assert.equal(evidence.errorCode, name.includes('capability') ? 'PRODUCT_OBSERVATION_UNPROVEN' : 'ERR_ASSERTION');
  });
}

for (const [name, body] of [
  ['missing trace', "await fs.unlink(process.env.STNL_PRODUCT_OBSERVER_FILE);"],
  ['missing completion', "process.removeAllListeners('exit');"],
  ['trace overflow', "for (let i = 0; i < 1100; i++) try { await fs.writeFile(path.dirname(file), 'x'); } catch {}"],
]) {
  test(`bounded observer classifies ${name} as insufficient evidence`, async t => {
    const workspace = await candidate(t, 'C');
    await replace(workspace, 'src/cli.mjs', 'for (const todo of await read())', `${body} for (const todo of await read())`);
    const evidence = await checkProductAcceptance(workspace, 'C');
    assert.equal(evidence.passed, false, JSON.stringify(evidence));
    assert.equal(evidence.errorCode, 'PRODUCT_OBSERVATION_UNPROVEN');
    assert.match(evidence.diagnostic, /storage observation unavailable/u);
  });
}

test('fixed product oracle C accepts equivalent legacy/default-false representation and idempotent writes', async t => {
  const workspace = await candidate(t, 'C');
  await replace(workspace, 'src/cli.mjs', "const emit = (todo) => stdout.write(JSON.stringify(todo) + '\\n');",
    'const emit = todo => { const value = { ...todo }; if (value.archived === false) delete value.archived; stdout.write(`${JSON.stringify(value)}\\n`); };');
  const evidence = await checkProductAcceptance(workspace, 'C');
  assert.equal(evidence.passed, true, JSON.stringify(evidence));
});

// Exercise physical aliases directly in the same bounded subprocess observer.
// These are owned storage fixtures, never historical sessions or host files.
for (const kind of ['symlink-file', 'symlink-parent', 'hardlink', 'buffer', 'url']) {
  test(`bounded observer records write/restore through ${kind}`, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-observer-alias-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const storage = path.join(root, 'storage'); await fs.mkdir(storage);
    const target = path.join(storage, 'todos.json'); await fs.writeFile(target, 'original');
    let alias = path.join(root, 'alias');
    if (kind === 'symlink-file') await fs.symlink(target, alias);
    else if (kind === 'symlink-parent') { await fs.symlink(storage, alias); alias = path.join(alias, 'todos.json'); }
    else if (kind === 'hardlink') await fs.link(target, alias);
    else alias = target;
    const trace = path.join(root, 'trace.jsonl');
    const script = `const fs = require('node:fs'); const {pathToFileURL} = require('node:url');
      const input = ${JSON.stringify(alias)};
      const file = ${kind === 'url' ? 'pathToFileURL(input)' : kind === 'buffer' ? 'Buffer.from(input)' : 'input'};
      const before = fs.readFileSync(file); fs.writeFileSync(file, 'changed'); fs.writeFileSync(file, before);`;
    const result = spawnSync(process.execPath, ['--require', path.join(ROOT, 'benchmarks/sentinel-todo/runtime/product-write-observer.cjs'), '-e', script], {
      env: { ...testEnvironment, STNL_PRODUCT_OBSERVER_ROOT: storage, STNL_PRODUCT_OBSERVER_FILE: trace }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(target, 'utf8'), 'original', 'bytes alone cannot distinguish this attempt');
    const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].type, 'ready');
    assert.equal(events.at(-1).type, 'complete');
    assert.ok(events.some(event => event.type === 'write-attempt'), JSON.stringify(events));
  });
}

test('bounded observer permits writes outside storage and cleans closed descriptor ownership', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-observer-descriptors-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'storage'); await fs.mkdir(storage);
  const target = path.join(storage, 'todos.json'); await fs.writeFile(target, 'original');
  const trace = path.join(root, 'trace.jsonl');
  const script = `const fs = require('node:fs');
    const fd = fs.openSync(${JSON.stringify(target)}, 'r'); fs.closeSync(fd);
    const other = fs.openSync(${JSON.stringify(path.join(root, 'unrelated'))}, 'w');
    fs.writeSync(other, 'permitted'); fs.closeSync(other);`;
  const result = spawnSync(process.execPath, ['--require', path.join(ROOT, 'benchmarks/sentinel-todo/runtime/product-write-observer.cjs'), '-e', script], {
    env: { ...testEnvironment, STNL_PRODUCT_OBSERVER_ROOT: storage, STNL_PRODUCT_OBSERVER_FILE: trace }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.type), ['ready', 'complete']);
});

test('fixed product oracle C accepts equivalent domain-error wording', async t => {
  const workspace = await candidate(t, 'C');
  await replace(workspace, 'src/cli.mjs', 'throw new Error(`todo ${id} is archived`)', "throw new Error('cannot complete an inactive todo')");
  assert.equal((await checkProductAcceptance(workspace, 'C')).passed, true);
});

test('a genuine acceptance cannot be transplanted to another workspace or changed candidate', async t => {
  const original = await candidate(t, 'C');
  const other = await candidate(t, 'C');
  const evidence = await checkProductAcceptance(original, 'C');
  assert.equal(evidence.passed, true, JSON.stringify(evidence));
  validateProductAcceptance(evidence, 'C', true, productInstrumentIdentity(), evidence.product);
  assert.throws(() => validateProductAcceptance(evidence, 'C', true, productInstrumentIdentity(),
    { root: other, sha256: evidence.product.sha256 }), /productAcceptance/u);
  await fs.appendFile(path.join(original, 'src/cli.mjs'), '\n// changed candidate bytes\n');
  const changedIdentity = await productCandidateIdentity(original);
  assert.throws(() => validateProductAcceptance(evidence, 'C', true, productInstrumentIdentity(),
    { root: original, sha256: changedIdentity }), /productAcceptance/u);
});

test('fixed product oracle C rejects added external dependency', async t => {
  const workspace = await candidate(t, 'C');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ dependencies: { unexpected: '1' } }));
  const evidence = await checkProductAcceptance(workspace, 'C');
  assert.equal(evidence.passed, false);
  assert.match(evidence.failedCheck, /dependencies/u);
});

test('fixed product oracle preserves process failure diagnostics', async (t) => {
  const workspace = await candidate(t, 'A');
  await fs.writeFile(path.join(workspace, 'src/cli.mjs'), "process.stderr.write('EMFILE: fixture process failure\\n'); process.exitCode = 1;\n");
  const evidence = await checkProductAcceptance(workspace, 'A');
  assert.equal(evidence.passed, false);
  assert.match(evidence.diagnostic, /CLI exit 1; stderr: EMFILE: fixture process failure/u);
});

test('oracle detects instrument drift in an owned copy even when the candidate suite could pass', async t => {
  const workspace = await candidate(t, 'C');
  const instrument = path.join(workspace, '.test-only-instrument');
  await fs.mkdir(instrument);
  for (const name of ['product-acceptance.mjs', 'product-write-observer.cjs']) {
    await fs.copyFile(path.join(ROOT, 'benchmarks/sentinel-todo/runtime', name), path.join(instrument, name));
  }
  const oracle = path.join(instrument, 'product-acceptance.mjs');
  await replace(workspace, 'src/cli.mjs', 'for (const todo of await read())',
    `await fs.appendFile(${JSON.stringify(oracle)}, '\\n// TEST-ONLY instrument drift'); for (const todo of await read())`);
  const { checkProductAcceptance: ownedOracle } = await import(pathToFileURL(oracle));
  const evidence = await ownedOracle(workspace, 'C');
  assert.equal(evidence.passed, false);
  assert.equal(evidence.failedCheck, 'instrument integrity');
  assert.equal(evidence.errorCode, 'INSTRUMENT_DRIFT');
});

for (const variant of ['sync-relative', 'callback-relative', 'promise-relative', 'buffer', 'url', 'retargeted-alias']) {
  test(`bounded observer freezes open identity for ${variant}`, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-observer-open-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const storage = path.join(root, 'storage'); await fs.mkdir(storage);
    const target = path.join(storage, 'todos.json'); await fs.writeFile(target, 'original');
    const unrelated = path.join(root, 'todos.json'); await fs.writeFile(unrelated, 'unrelated');
    const alias = path.join(root, 'alias');
    if (variant === 'retargeted-alias') await fs.symlink(target, alias);
    const trace = path.join(root, 'trace.jsonl');
    let action;
    if (variant === 'sync-relative') action = `const fd = f.openSync('todos.json', 'r'); process.chdir(${JSON.stringify(root)}); try { f.writeSync(fd, 'x'); } catch {} finally { f.closeSync(fd); }`;
    else if (variant === 'callback-relative') action = `await new Promise((resolve, reject) => {
      f.open('todos.json', 'r', (error, fd) => { if(error) return reject(error); try { f.writeSync(fd, 'x'); } catch {} finally { f.closeSync(fd); resolve(); } });
      process.chdir(${JSON.stringify(root)});
    });`;
    else if (variant === 'retargeted-alias') action = `const handle = await p.open(${JSON.stringify(alias)}, 'r');
      await p.unlink(${JSON.stringify(alias)}); await p.symlink(${JSON.stringify(unrelated)}, ${JSON.stringify(alias)});
      try { await handle.write('x'); } catch {} finally { await handle.close(); }`;
    else {
      const input = variant === 'buffer' ? "Buffer.from('todos.json')" : variant === 'url' ? `pathToFileURL(${JSON.stringify(target)})` : "'todos.json'";
      const mutate = variant === 'buffer' ? "input.fill(120);" : variant === 'url' ? `input.pathname = ${JSON.stringify(unrelated)};` : '';
      action = `const input = ${input}; const pending = p.open(input, 'r'); ${mutate}
        process.chdir(${JSON.stringify(root)}); const handle = await pending;
        try { await handle.write('x'); } catch {} finally { await handle.close(); }`;
    }
    const script = `const f = require('node:fs'); const p = require('node:fs/promises'); const {pathToFileURL} = require('node:url');
      (async () => { ${action} })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const result = spawnSync(process.execPath, ['--require', path.join(ROOT, 'benchmarks/sentinel-todo/runtime/product-write-observer.cjs'), '-e', script], {
      cwd: storage, env: { ...testEnvironment, STNL_PRODUCT_OBSERVER_ROOT: storage, STNL_PRODUCT_OBSERVER_FILE: trace }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(target, 'utf8'), 'original');
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'unrelated');
    const events = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    const expectedMethod = ['sync-relative', 'callback-relative'].includes(variant) ? 'writeSync' : 'FileHandle.write';
    assert.ok(events.some(event => event.type === 'write-attempt' && event.method === expectedMethod), JSON.stringify(events));
    assert.equal(events.at(-1).type, 'complete');
  });
}
