import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCodexTurn } from '../agents/codex/runtime/sdk-transport.mjs';

for (const [name, events, exit, started] of [
  ['empty successful process', [], 0, null],
  ['empty failed process', [], 2, null],
  ['truncated stream', ['{truncated'], 0, null],
  ['provider error without start proof', [{ type: 'turn.failed', error: { message: 'capacity' } }], 0, null],
  ['capacity after thread started', [{ type: 'thread.started', thread_id: 'owned-test-thread' }, { type: 'turn.failed', error: { message: 'capacity' } }], 0, true],
]) {
  test(`T07/T08: SDK ${name} cannot prove pre-dispatch absence`, { timeout: 3000 }, async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-start-evidence-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, '.agents/skills'), { recursive: true });
    const executable = path.join(root, 'provider.mjs');
    const stream = events.map((event) => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + '\n';
    await fs.writeFile(executable, '#!' + process.execPath + '\nprocess.stdout.write(' + JSON.stringify(stream) + '); process.exit(' + exit + ');\n', { mode: 0o700 });
    const eventsPath = path.join(root, 'events.jsonl');
    const result = await runCodexTurn({ env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root }, cwd: root,
      prompt: 'Offline fixture only.', model: 'gpt-6-luna', effort: 'low', operationId: name, eventsPath, codexPathOverride: executable });
    assert.equal(result.completed, false); assert.equal(result.turnStarted, started);
    assert.equal(result.threadId, started ? 'owned-test-thread' : null);
    if (started) assert.match(await fs.readFile(eventsPath, 'utf8'), /thread.started/u);
  });
}
