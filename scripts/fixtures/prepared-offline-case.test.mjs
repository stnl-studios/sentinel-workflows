// Copied into the authorized slice before delegation. No benchmark oracle imports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';

const matrix = JSON.parse(await fs.readFile(new URL('./offline-case.json', import.meta.url)));
const caseId = matrix.caseId;
// Prepared before delegation. This focused coverage assertion checks structured
// matrix data against Case B's explicit domain, not an LLM's general judgment.
if (caseId === 'B' && process.env.STNL_OFFLINE_REQUIRE_PRIORITY_COVERAGE === '1') {
  test('prepared Case B coverage: every required priority has an executed variant', () => {
    assert.deepEqual([...(matrix.priorities ?? ['low', 'medium', 'high'])].sort(), ['high', 'low', 'medium']);
  });
}
test(`prepared Case ${caseId}: requirements, negative variants and byte preservation`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-check-'));
  const file = path.join(root, 'todos.json');
  const invoke = async (args, code = 0) => {
    let stdout = '', stderr = '';
    const before = await fs.readFile(file).catch(() => null);
    const observed = await runCli(['--store', file, ...args], { stdout: { write: (v) => { stdout += v; } }, stderr: { write: (v) => { stderr += v; } } });
    assert.equal(observed, code, stderr);
    if (code) { assert.equal(stdout, ''); assert.match(stderr, code === 2 ? /^usage:/u : /^error:/u); }
    else assert.equal(stderr, '');
    if (code || args[0] === 'list') assert.deepEqual(await fs.readFile(file).catch(() => null), before, 'read/error must not rewrite storage');
    return stdout.trim() ? stdout.trim().split('\n').map(JSON.parse) : [];
  };
  try {
    await invoke(['list']);
    for (const args of [['unknown'], ['add'], ['complete'], ['complete', '1', '2'], ['list', '--unknown']]) await invoke(args, 2);
    for (const args of [['add', '   '], ['complete', '0'], ['complete', '999']]) await invoke(args, 1);
    const mixed = [{ id: 7, title: 'last', completed: false }, { id: 2, title: 'done', completed: true }, { id: 5, title: 'middle', completed: false }];
    await fs.writeFile(file, JSON.stringify({ todos: mixed }));
    assert.deepEqual((await invoke(['list'])).map((todo) => todo.id), [2, 5, 7]);
    if (caseId === 'A') {
      assert.deepEqual((await invoke(['list', '--completed'])).map((t) => t.id), [2]);
      assert.deepEqual((await invoke(['list', '--pending'])).map((t) => t.id), [5, 7]);
      for (const flags of [['--pending', '--completed'], ['--completed', '--pending'], ['--pending', '--unknown']]) await invoke(['list', ...flags], 2);
      for (const todos of [[], [mixed[1]], [mixed[0]]]) {
        await fs.writeFile(file, JSON.stringify({ todos }));
        for (const flag of ['--completed', '--pending']) assert.deepEqual((await invoke(['list', flag])).map((t) => t.id), todos.filter((t) => t.completed === (flag === '--completed')).map((t) => t.id));
      }
    }
    if (caseId === 'B') {
      assert.ok((await invoke(['list'])).every((t) => t.priority === 'medium'));
      assert.equal((await invoke(['complete', '2']))[0].priority, 'medium');
      if (matrix.completeTarget !== undefined) {
        const expected = mixed.find(todo => todo.id === 2);
        const completed = (await invoke(['complete', String(matrix.completeTarget)]))[0];
        assert.equal(completed.id, expected.id, 'prepared complete must select the expected target ID 2');
      }
      for (const priority of matrix.priorities ?? ['low', 'medium', 'high']) assert.equal((await invoke(['add', '--priority', priority, 'café']))[0].priority, priority);
      await invoke(['add', '--priority', 'urgent', 'title'], 1);
      await invoke(['add', '--priority'], 2);
      await invoke(['add', '--priority', 'low'], 2);
    }
    if (caseId === 'C') {
      for (let twice = 0; twice < 2; twice++) {
        const archived = (await invoke(['archive', '2']))[0];
        assert.equal(archived.archived, true); assert.equal(archived.completed, true);
      }
      assert.deepEqual((await invoke(['list', '--archived'])).map((t) => t.id), [2]);
      assert.deepEqual((await invoke(['list'])).map((t) => t.id), [5, 7]);
      await invoke(['complete', '2'], 1);
      for (let twice = 0; twice < 2; twice++) { const todo = (await invoke(['unarchive', '2']))[0]; assert.equal(todo.archived, false); assert.equal(todo.completed, true); }
      assert.deepEqual(await invoke(['list', '--archived']), []);
      for (const command of ['archive', 'unarchive']) { await invoke([command], 2); await invoke([command, '1', '2'], 2); await invoke([command, '999'], 1); }
    }
    const added = (await invoke(['add', 'nova', 'tarefa', 'café']))[0];
    assert.equal(added.title, 'nova tarefa café'); assert.equal(added.completed, false);
    if (caseId === 'B') assert.equal(added.priority, 'medium');
    for (let twice = 0; twice < 2; twice++) assert.equal((await invoke(['complete', String(added.id)]))[0].completed, true);
  } finally { await fs.rm(root, { recursive: true }); }
});
