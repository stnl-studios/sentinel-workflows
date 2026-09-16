import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TodoStore } from '../src/todo-store.mjs';

test('store persists readable JSON in stable id order', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-todo-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'data with spaces.json');
  const store = new TodoStore(file);
  await store.write([
    { id: 2, title: 'Dois', completed: true },
    { id: 1, title: 'Um', completed: false },
  ]);
  assert.deepEqual((await store.read()).map((todo) => todo.id), [1, 2]);
  assert.match(await fs.readFile(file, 'utf8'), /"todos": \[/u);
});

test('missing store reads as an empty list', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-todo-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await new TodoStore(path.join(root, 'missing.json')).read(), []);
});

test('invalid persisted data is rejected', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-todo-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'todos.json');
  await fs.writeFile(file, '{"todos":[{"id":1,"title":"X"}]}\n', 'utf8');
  await assert.rejects(new TodoStore(file).read(), /invalid shape/u);
});
