import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';

function capture() {
  let value = '';
  return { stream: { write(chunk) { value += chunk; } }, read: () => value };
}

test('CLI supports add, list, and complete', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-todo-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = path.join(root, 'todos.json');
  const output = capture();
  const errors = capture();
  assert.equal(await runCli(['--store', store, 'add', 'Olá', 'mundo'], { stdout: output.stream, stderr: errors.stream }), 0);
  assert.equal(await runCli(['--store', store, 'complete', '1'], { stdout: output.stream, stderr: errors.stream }), 0);
  assert.equal(await runCli(['--store', store, 'list'], { stdout: output.stream, stderr: errors.stream }), 0);
  assert.match(output.read(), /"title":"Olá mundo"/u);
  assert.match(output.read(), /"completed":true/u);
  assert.equal(errors.read(), '');
});

test('CLI reports invalid commands deterministically', async () => {
  const output = capture();
  const errors = capture();
  assert.equal(await runCli(['list'], { stdout: output.stream, stderr: errors.stream }), 2);
  assert.match(errors.read(), /^usage:/u);
});
