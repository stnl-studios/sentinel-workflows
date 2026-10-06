// Fixed benchmark observations. Never copied into, or imported from, candidate tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PRODUCT_CONTRACT = 'sentinel-todo-product-v1';

export async function checkProductAcceptance(workspace, caseId) {
  if (!['A', 'B'].includes(caseId)) throw new Error('product acceptance supports only A/B');
  const evidence = { contract: PRODUCT_CONTRACT, caseId, passed: false, checks: [], commands: 0,
    failedCheck: null, diagnostic: null, errorCode: null };
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-product-'));
  let currentCheck = 'setup';
  let serial = 0;
  const withPriority = (todos) => todos.map((todo) => caseId === 'B'
    ? { ...todo, priority: todo.priority ?? 'medium' } : todo);
  const mixed = [
    { id: 7, title: 'último pendente', completed: false },
    { id: 2, title: 'feito', completed: true },
    { id: 5, title: 'outro pendente', completed: false },
  ];
  const sorted = [...mixed].sort((a, b) => a.id - b.id);
  const check = async (name, observation) => {
    currentCheck = name;
    await observation();
    evidence.checks.push(name);
  };
  const store = async (todos) => {
    const directory = path.join(scratch, String(++serial));
    await fs.mkdir(directory);
    const file = path.join(directory, 'todos.json');
    if (todos !== undefined) await fs.writeFile(file, `${JSON.stringify({ todos }, null, 2)}\n`);
    return file;
  };
  // Includes existence, bytes and stray temporary files, rather than parsed JSON alone.
  const snapshot = async (file) => Promise.all((await fs.readdir(path.dirname(file))).sort()
    .map(async (name) => [name, (await fs.readFile(path.join(path.dirname(file), name))).toString('base64')]));
  const invoke = (file, args) => {
    evidence.commands += 1;
    const result = spawnSync(process.execPath, [path.join(workspace, 'src', 'cli.mjs'), '--store', file, ...args],
      { cwd: workspace, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.signal, null, `CLI signal: ${result.signal}; stderr: ${result.stderr}`);
    return result;
  };
  const success = (result) => {
    assert.equal(result.status, 0, `CLI exit ${result.status}; stderr: ${result.stderr}`);
    assert.equal(result.stderr, '', 'successful CLI must not emit stderr');
    if (result.stdout === '') return [];
    assert.ok(result.stdout.endsWith('\n'), 'JSON lines must end with newline');
    return result.stdout.slice(0, -1).split('\n').map((line) => {
      const todo = JSON.parse(line);
      assert.ok(todo !== null && typeof todo === 'object' && !Array.isArray(todo), 'one Todo object per line');
      return todo;
    });
  };
  const readOnlyList = async (file, args, expected) => {
    const before = await snapshot(file);
    assert.deepEqual(success(invoke(file, ['list', ...args])), withPriority(expected));
    assert.deepEqual(await snapshot(file), before, 'list must preserve storage bytes/existence');
  };
  const rejected = async (file, args, exit, stderr) => {
    const before = await snapshot(file);
    const result = invoke(file, args);
    assert.equal(result.status, exit, `CLI exit ${result.status}; stderr: ${result.stderr}`);
    assert.equal(result.stdout, '', 'rejected command must have empty stdout');
    assert.match(result.stderr, stderr);
    assert.deepEqual(await snapshot(file), before, 'rejected command must preserve storage');
  };
  const persisted = async (file) => JSON.parse(await fs.readFile(file, 'utf8')).todos;
  try {
    workspace = await fs.realpath(workspace);
    await check('list: JSON lines, ID order, legacy compatibility and read-only storage', async () => {
      await readOnlyList(await store(mixed), [], sorted);
      await readOnlyList(await store([]), [], []);
      await readOnlyList(await store(), [], []);
    });
    if (caseId === 'A') {
      await check('list: completed/pending subsets and relative order', async () => {
        const file = await store(mixed);
        await readOnlyList(file, ['--completed'], sorted.filter((todo) => todo.completed));
        await readOnlyList(file, ['--pending'], sorted.filter((todo) => !todo.completed));
      });
      await check('list: empty, missing and no-match filters succeed without writes', async () => {
        for (const todos of [[], undefined, [mixed[0]], [mixed[1]]]) {
          const file = await store(todos);
          for (const flag of ['--completed', '--pending']) {
            await readOnlyList(file, [flag], (todos ?? []).filter((todo) => todo.completed === (flag === '--completed')));
          }
        }
      });
      await check('list: conflicting and unknown flags are usage errors without writes', async () => {
        for (const todos of [mixed, undefined]) {
          const file = await store(todos);
          for (const args of [['--completed', '--pending'], ['--pending', '--completed'],
            ['--unknown'], ['--completed', '--unknown'], ['unexpected']]) {
            await rejected(file, ['list', ...args], 2, /^usage:/u);
          }
        }
      });
    }
    await check('add/complete: JSON output, IDs, titles, persistence and list order', async () => {
      const file = await store(mixed);
      const added = withPriority([{ id: 8, title: 'nova tarefa café', completed: false }])[0];
      assert.deepEqual(success(invoke(file, ['add', 'nova', 'tarefa', 'café'])), [added]);
      assert.deepEqual(withPriority(await persisted(file)), [...withPriority(sorted), added]);
      await readOnlyList(file, [], [...sorted, added]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const completed = success(invoke(file, ['complete', '8']));
        assert.equal(completed.length, 1);
        assert.deepEqual(caseId === 'B' ? completed.map(({ priority, ...todo }) => todo) : completed,
          [{ id: 8, title: 'nova tarefa café', completed: true }]);
        if (caseId === 'B' && completed[0].priority !== undefined) assert.equal(completed[0].priority, 'medium');
        assert.deepEqual(withPriority(await persisted(file)), [...withPriority(sorted), { ...added, completed: true }]);
      }
      await readOnlyList(file, [], [...sorted, { ...added, completed: true }]);
      const missing = await store();
      const first = withPriority([{ id: 1, title: 'primeira', completed: false }]);
      assert.deepEqual(success(invoke(missing, ['add', 'primeira'])), first);
      assert.deepEqual(withPriority(await persisted(missing)), first);
    });
    await check('compatibility: usage/domain errors retain codes, stderr and storage', async () => {
      const file = await store(mixed);
      for (const args of [['add'], ['complete'], ['complete', '2', '5'], ['unknown']]) {
        await rejected(file, args, 2, /^usage:/u);
      }
      if (caseId === 'B') await rejected(file, ['list', '--unknown'], 2, /^usage:/u);
      for (const args of [['add', '   '], ['complete', '0'], ['complete', 'no-id'], ['complete', '999']]) {
        await rejected(file, args, 1, /^error:/u);
      }
      const invalid = await store([]);
      await fs.writeFile(invalid, 'invalid JSON\n');
      await rejected(invalid, ['list'], 1, /^error:/u);
    });
    if (caseId === 'B') {
      await check('priority: default and low/medium/high persist and remain observable', async () => {
        const file = await store([]);
        const expected = [];
        for (const priority of [undefined, 'low', 'medium', 'high']) {
          const title = `tarefa ${priority ?? 'default'}`;
          const todo = { id: expected.length + 1, title, completed: false, priority: priority ?? 'medium' };
          assert.deepEqual(success(invoke(file, ['add', ...(priority ? ['--priority', priority] : []), title])), [todo]);
          expected.push(todo);
          assert.deepEqual(await persisted(file), expected, 'new priority must be persisted, including default');
          await readOnlyList(file, [], expected);
        }
      });
      await check('priority: invalid value is domain error; missing value/title is usage error', async () => {
        for (const todos of [mixed, undefined]) {
          const file = await store(todos);
          await rejected(file, ['add', '--priority', 'urgent', 'tarefa'], 1, /^error:.*urgent/isu);
          for (const args of [['add', '--priority'], ['add', '--priority', 'high']]) {
            await rejected(file, args, 2, /^usage:/u);
          }
        }
      });
      await check('priority: legacy reads do not rewrite; complete preserves old and explicit priority', async () => {
        const todos = [mixed[0], { ...mixed[1], priority: 'high' }, { ...mixed[2], priority: 'low' }];
        const expected = [...todos].sort((a, b) => a.id - b.id);
        const file = await store(todos);
        await readOnlyList(file, [], expected);
        for (const id of ['7', '2', '5']) {
          const todo = expected.find((item) => item.id === Number(id));
          todo.completed = true;
          const output = success(invoke(file, ['complete', id]));
          assert.equal(output.length, 1);
          assert.deepEqual(output.map(({ priority, ...item }) => item), [{ id: todo.id, title: todo.title, completed: true }]);
          if (output[0].priority !== undefined) assert.equal(output[0].priority, todo.priority ?? 'medium');
          const saved = await persisted(file);
          assert.deepEqual(withPriority(saved), withPriority(expected));
          for (const explicit of expected.filter((item) => item.priority)) {
            assert.equal(saved.find((item) => item.id === explicit.id).priority, explicit.priority);
          }
          await readOnlyList(file, [], expected);
        }
      });
      await check('priority: existing title arguments stay literal after first title token', async () => {
        const file = await store([]);
        const todo = { id: 1, title: 'literal --priority high', completed: false, priority: 'medium' };
        assert.deepEqual(success(invoke(file, ['add', 'literal', '--priority', 'high'])), [todo]);
        assert.deepEqual(await persisted(file), [todo]);
      });
      await check('dependencies: no declared external dependencies', async () => {
        const pkg = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          assert.equal(Object.keys(pkg[field] ?? {}).length, 0, `${field} must remain empty`);
        }
      });
    }
    evidence.passed = true;
  } catch (error) {
    evidence.failedCheck = currentCheck;
    evidence.diagnostic = String(error.message).slice(0, 8192);
    evidence.errorCode = typeof error.code === 'string' ? error.code : null;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return evidence;
}
