import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppServer, sanitizeEvent } from '../app-server.mjs';

// These are protocol simulations, not live model or Sentinel qualification.
function fake(onRequest = () => {}) {
  const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new EventEmitter();
  p.exitCode = null; p.signalCode = null; const writes = [], kills = [];
  const send = m => p.stdout.write(JSON.stringify(m) + '\n');
  p.stdin.write = text => {
    const m = JSON.parse(text); writes.push(m);
    if (m.method === 'initialize') queueMicrotask(() => send({ id: m.id, result: { userAgent: 'fake' } }));
    else onRequest(m, send, p);
  };
  p.kill = signal => { kills.push(signal); p.signalCode = signal; queueMicrotask(() => p.emit('exit', null, signal)); return true; };
  const events = []; let options,spawnArgs;
  const server = new AppServer({ cli: '/fake/codex', cwd: '/fixture', home: '/isolated', tmpDir: '/scratch', onEvent: e => events.push(e), spawnImpl: (_c, _a, o) => { options = o; spawnArgs = _a; return p; } });
  return { server, p, send, writes, kills, events, get options() { return options; }, get spawnArgs() { return spawnArgs; } };
}
test('SIMULATED: early terminal buffered, old and foreign turns ignored', async () => {
  const f = fake((m, send) => { if (m.method === 'turn/start') {
    send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'old', status: 'failed' } } });
    send({ method: 'turn/completed', params: { threadId: 'other', turn: { id: 'new', status: 'failed' } } });
    send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'new', status: 'completed' } } });
    send({ id: m.id, result: { turn: { id: 'new' } } });
  } });
  await f.server.start(); let accepted;
  const r = await f.server.runTurn({ threadId: 't', input: [], onAccepted: x => { accepted = x; } });
  assert.equal(r.status, 'completed'); assert.equal(accepted.turnId, 'new');
  assert.ok(f.spawnArgs.includes('sandbox_workspace_write.exclude_slash_tmp=true'));assert.equal(f.options.env.TMPDIR,'/scratch');assert.equal(f.options.env.TMPPREFIX,'/scratch/zsh');assert.ok(f.spawnArgs.includes('shell_environment_policy.set.TMPPREFIX="/scratch/zsh"'));assert.equal(f.options.env.CODEX_HOME, '/isolated'); assert.equal(f.options.env.HOME, process.env.HOME);
  await f.server.stop();
});
test('SIMULATED: inbound approval ID collision is denied, not a response', async () => {
  const f = fake((m, send) => { if (m.method === 'custom') {
    send({ id: m.id, method: 'item/commandExecution/requestApproval', params: {} });
    send({ id: m.id, result: { real: true } });
  } });
  await f.server.start(); assert.deepEqual(await f.server.request('custom', {}), { real: true });
  assert.ok(f.writes.some(m => m.error?.code === -32000)); await f.server.stop();
});
test('SIMULATED: abort wins completed event during acceptance and interrupts', async () => {
  const ac = new AbortController();
  const f = fake((m, send) => {
    if (m.method === 'turn/start') { send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'n', status: 'completed' } } }); send({ id: m.id, result: { turn: { id: 'n' } } }); }
    if (m.method === 'turn/interrupt') send({ id: m.id, result: {} });
  });
  await f.server.start(); const r = await f.server.runTurn({ threadId: 't', input: [], signal: ac.signal, onAccepted: () => ac.abort() });
  assert.equal(r.status, 'interrupted'); assert.ok(f.writes.some(m => m.method === 'turn/interrupt')); assert.ok(f.kills.includes('SIGTERM'));
});
test('SIMULATED: deadline without acknowledgement stops uncertain dispatch', async () => {
  const f = fake(); await f.server.start();
  const timing = {};
  const r = await f.server.runTurn({ threadId: 't', input: [], deadline: Date.now() + 15, timing });
  assert.equal(r.status, 'interrupted'); assert.equal(r.turnId, null); assert.ok(f.kills.length);
  assert.equal(timing.adapterAbortSource, 'adapter-deadline');
  assert.equal(timing.interruptRpcOutcome, 'turn-identity-unknown');
  assert.equal(timing.interruptRpcAttemptedAt, undefined);
  assert.equal(timing.providerInterruptedAt, undefined);
});
test('SIMULATED: interruption receipt separates provider notification from RPC acknowledgment and timeout', async () => {
  for (const acknowledge of [true, false]) {
    const ac = new AbortController(), timing = {};
    const f = fake((m, send) => {
      if (m.method === 'turn/start') send({ id: m.id, result: { turn: { id: 'bound' } } });
      if (m.method === 'turn/interrupt') {
        send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'foreign', status: 'interrupted' } } });
        if (acknowledge) {
          send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'bound', status: 'interrupted' } } });
          setTimeout(() => send({ id: m.id, result: {} }), 5);
        }
      }
    });
    await f.server.start();
    const r = await f.server.runTurn({ threadId: 't', input: [], timing, signal: ac.signal, onAccepted: () => ac.abort() });
    assert.equal(r.status, 'interrupted');
    assert.equal(timing.adapterAbortSource, 'signal');
    assert.equal(timing.interruptRpcOutcome, acknowledge ? 'acknowledged' : 'timeout');
    assert.ok(timing.adapterAbortAt <= timing.interruptRpcAttemptedAt);
    assert.ok(timing.interruptRpcAttemptedAt <= timing.interruptRpcSettledAt);
    assert.ok(timing.interruptRpcSettledAt <= timing.adapterStoppedAt);
    if (acknowledge) {
      assert.ok(timing.interruptRpcAttemptedAt <= timing.providerInterruptedAt);
      assert.ok(timing.providerInterruptedAt <= timing.interruptRpcSettledAt);
    } else assert.equal(timing.providerInterruptedAt, undefined);
  }
});

test('SIMULATED: request errors/timeouts and process exit settle pending work', async () => {
  const f = fake((m, send) => { if (m.method === 'reject') send({ id: m.id, error: { code: -1, message: 'rejected' } }); });
  await f.server.start(); await assert.rejects(f.server.request('reject', {}), /rejected/);
  await assert.rejects(f.server.request('silent', {}, { timeoutMs: 5 }), /timeout/);
  const pending = f.server.request('pending', {}); f.p.emit('exit', 7, null);
  await assert.rejects(pending, /exit/); await f.server.stop();
});
test('SIMULATED: active turn exit is transport failure, not semantic PASS', async () => {
  const f = fake((m, send, p) => { if (m.method === 'turn/start') { send({ id: m.id, result: { turn: { id: 'x' } } }); setTimeout(() => p.emit('exit', 1, null), 1); } });
  await f.server.start(); const r = await f.server.runTurn({ threadId: 't', input: [] }); assert.equal(r.status, 'transport_error'); await f.server.stop();
});
test('sanitizer discards reasoning/auth and retains usage/command proof', () => {
  assert.equal(sanitizeEvent({ method: 'item/reasoning/textDelta', params: { delta: 'private' } }), null);
  assert.equal(sanitizeEvent({ method: 'item/completed', params: { item: { type: 'reasoning', text: 'private' } } }), null);
  const raw = sanitizeEvent({ method: 'rawResponse/completed', params: { responseId: 'r', usage: { reasoningOutputTokens: 5 }, output: 'private', encryptedContent: 'private' } });
  assert.deepEqual(raw.params, { responseId: 'r', usage: { reasoningOutputTokens: 5 } });
  const command = sanitizeEvent({ method: 'item/completed', params: { item: { type: 'commandExecution', aggregatedOutput: 'proof', apiKey: 'secret' } } });
  assert.equal(command.params.item.aggregatedOutput, 'proof'); assert.equal(command.params.item.apiKey, undefined);
  const terminal = sanitizeEvent({ method: 'turn/completed', params: { turn: { items: [{ type: 'reasoning', content: 'private' }, { type: 'agentMessage', text: 'public' }] } } });
  assert.equal(terminal.params.turn.items.length, 1);
});
test('SIMULATED: stop escalates unresponsive process and stays bounded', async () => {
  const f = fake(); await f.server.start(); f.p.kill = signal => { f.kills.push(signal); return true; };
  const start = Date.now(); await f.server.stop(); assert.ok(Date.now() - start < 2200); assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL']);
});

test('SIMULATED: a signalled PID without code or signal is not a confirmed direct child exit',async()=>{
 const f=fake();f.p.pid=123456;f.p.kill=signal=>{f.kills.push(signal);return true;};
 await f.server.start();
 await assert.rejects(f.server.stop(),error=>error.code==='APP_SERVER_EXIT_UNCONFIRMED');
 assert.deepEqual(f.kills,['SIGTERM','SIGKILL']);
});
