import assert from 'node:assert/strict';
import test from 'node:test';

import { TodoService } from '../src/todo-service.mjs';

function memoryStore(initial = []) {
  let todos = structuredClone(initial);
  return {
    async read() { return structuredClone(todos); },
    async write(next) { todos = structuredClone(next); },
  };
}

test('add assigns incremental ids and list remains stable', async () => {
  const service = new TodoService(memoryStore());
  assert.deepEqual(await service.add('First'), { id: 1, title: 'First', completed: false });
  assert.deepEqual(await service.add('Second'), { id: 2, title: 'Second', completed: false });
  assert.deepEqual((await service.list()).map((todo) => todo.id), [1, 2]);
});

test('complete updates an existing todo', async () => {
  const service = new TodoService(memoryStore([{ id: 1, title: 'First', completed: false }]));
  assert.deepEqual(await service.complete(1), { id: 1, title: 'First', completed: true });
  assert.equal((await service.list())[0].completed, true);
});

test('empty titles and missing ids fail without a write', async () => {
  let writes = 0;
  const store = memoryStore([{ id: 1, title: 'First', completed: false }]);
  const originalWrite = store.write;
  store.write = async (value) => { writes += 1; await originalWrite(value); };
  const service = new TodoService(store);
  await assert.rejects(service.add('  '), /title must be a non-empty string/u);
  await assert.rejects(service.complete(99), /does not exist/u);
  assert.equal(writes, 0);
});
