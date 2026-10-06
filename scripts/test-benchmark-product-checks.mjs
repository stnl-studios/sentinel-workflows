import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProductAcceptance, PRODUCT_CONTRACT } from '../benchmarks/sentinel-todo/runtime/product-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'benchmarks/sentinel-todo/seed');
const testEnvironment = { ...process.env };
delete testEnvironment.NODE_TEST_CONTEXT;

async function candidate(t, caseId, reference = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-product-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await fs.realpath(root);
  await fs.cp(SEED, workspace, { recursive: true });
  if (reference) await fs.copyFile(path.join(ROOT, 'scripts/fixtures', caseId === 'A' ? 'filtered-cli.mjs' : 'prioritized-cli.mjs'),
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

test('fixed product oracle preserves process failure diagnostics', async (t) => {
  const workspace = await candidate(t, 'A');
  await fs.writeFile(path.join(workspace, 'src/cli.mjs'), "process.stderr.write('EMFILE: fixture process failure\\n'); process.exitCode = 1;\n");
  const evidence = await checkProductAcceptance(workspace, 'A');
  assert.equal(evidence.passed, false);
  assert.match(evidence.diagnostic, /CLI exit 1; stderr: EMFILE: fixture process failure/u);
});
