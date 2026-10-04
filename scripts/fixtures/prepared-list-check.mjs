// Prepared before independent verification; this check never creates files.
// Minimal AC regression for Case A's observed filter implementation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { runCli } = await import(pathToFileURL(process.argv[2]));
const fixtures = process.argv[3];
async function invoke(store, flags) {
  let stdout = '', stderr = '';
  const exit = await runCli(['--store', store, 'list', ...flags], {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { exit, stdout, stderr };
}

for (const name of ['mixed', 'empty', 'pending', 'missing']) {
  const store = path.join(fixtures, name + '.json');
  const before = await fs.readFile(store).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const todos = before === null ? [] : JSON.parse(before).todos.sort((a, b) => a.id - b.id);
  for (const flags of [[], ['--completed'], ['--pending']]) {
    const expected = flags.length === 0 ? todos
      : todos.filter((todo) => todo.completed === (flags[0] === '--completed'));
    const result = await invoke(store, flags);
    assert.equal(result.exit, 0, name + '/' + flags);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected.map((todo) => JSON.stringify(todo) + '\n').join(''));
  }
  for (const flags of [['--completed', '--pending'], ['--pending', '--completed'],
    ['--unknown'], ['--unknown', '--completed'], ['--completed', '--unknown'],
    ['--unknown', '--pending'], ['--pending', '--unknown']]) {
    const result = await invoke(store, flags);
    assert.equal(result.exit, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith('usage:') && result.stderr.endsWith('\n'));
  }
  const after = await fs.readFile(store).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  assert.deepEqual(after, before, name + ': storage bytes/existence must be preserved');
}
console.log('PASS: 40 list/filter/invalid-flag cases; storage bytes and missing storage preserved');
