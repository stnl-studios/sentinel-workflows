import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startOfficialRunnerBroker, submitOfficialRunnerRequest } from '../agents/codex/runtime/runner-broker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
async function fixture(t, operation) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-reliability-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const tmpdir = path.join(root, 'tmp');
  const specPath = path.join(workspace, 'spec');
  await fs.mkdir(specPath, { recursive: true }); await fs.mkdir(tmpdir);
  return { workspace, tmpdir, operation, sequence: 1, slice: 'slice-01',
    officialPreflight: { exitCode: 0, operation, slice: 'slice-01', inputSlice: '1', specPath,
      state: 'MATERIALIZED_PRISTINE', authority: 'sha256:' + 'a'.repeat(64),
      legalOperations: [{ operation, slice: 'slice-01' }], mandatoryRecovery: null },
    prompt: JSON.stringify({ automaticCheckRound: '1/3', changedAreas: [], filelessReason: 'Approved acceptance-only operation.' }) };
}

test('T03: managed bridge without payload-file fails finitely while stdin remains open', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'agents/codex/runtime/managed-runner-bridge.mjs')],
    { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); }, 1000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  assert.equal(timeout, false, 'missing managed file must not wait for EOF');
  assert.equal(code, 1);
  assert.match(stderr, /payload-file/u);
});

test('T03: native adapter retains its finite stdin plus EOF interface', { timeout: 3000 }, async (t) => {
  const input = await fixture(t, 'EXECUTE_SLICE');
  const broker = await startOfficialRunnerBroker({ ...input, invoke: async (request) => ({ operation: request.operation,
    sequence: request.sequence, slice: request.slice, status: 'RUNNER_RESPONSE_CAPTURED', exitCode: 0 }) });
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'agents/codex/runtime/validation-runner.mjs'), '--operation', input.operation, '--slice', input.slice],
      { cwd: input.workspace, env: { PATH: process.env.PATH, TMPDIR: input.tmpdir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(input.prompt);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr); assert.match(stdout, /SENTINEL_RUNNER_RECEIPT/u); assert.equal(broker.requestsHandled, 1);
  } finally { await broker.close(); }
});

for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']) {
  test(`T07: ${operation} uncertain dispatch never allows an automatic repeat`, async (t) => {
    const input = await fixture(t, operation); let calls = 0;
    const broker = await startOfficialRunnerBroker({ ...input, invoke: async () => {
      calls += 1; throw new Error('provider capacity after thread.started');
    } });
    try {
      await assert.rejects(submitOfficialRunnerRequest(input), { code: 'BROKER_DISPATCH_FAILED' });
      await assert.rejects(submitOfficialRunnerRequest(input), { code: 'BROKER_RESULT_ALREADY_CAPTURED' });
      assert.equal(calls, 1);
    } finally { await broker.close(); }
  });
}

for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS']) {
  test(`P2: ${operation} rejects an initial skipped round before sealing or invoking`, async (t) => {
    const input = await fixture(t, operation); let calls = 0;
    const broker = await startOfficialRunnerBroker({ ...input, invoke: async (request) => {
      calls++;
      return { operation, sequence: request.sequence, slice: request.slice, status: 'RUNNER_INITIALIZATION_BLOCKED', exitCode: 1,
        turnStarted: false, threadId: null, dispatchStarted: false };
    } });
    const withRound = (round) => {
      const managedPayload = { automaticCheckRound: round, changedAreas: [], filelessReason: 'Approved acceptance-only operation.' };
      return { ...input, prompt: JSON.stringify(managedPayload), managedPayload };
    };
    try {
      for (const round of ['2/3', '3/3']) {
        await assert.rejects(submitOfficialRunnerRequest(withRound(round)), { code: 'BROKER_ROUND_INVALID' });
        assert.equal(calls, 0); assert.equal(broker.pending, false);
        assert.equal((await fs.readdir(broker.directory)).filter((name) => name.startsWith('sealed-')).length, 0);
      }
      await submitOfficialRunnerRequest(withRound('1/3')); assert.equal(calls, 1);
      await assert.rejects(submitOfficialRunnerRequest(withRound('2/3')), { code: 'BROKER_ROUND_INVALID' });
      assert.equal(calls, 1, 'proof of no start permits only the same round');
      await submitOfficialRunnerRequest(withRound('1/3')); assert.equal(calls, 2);
      await assert.rejects(submitOfficialRunnerRequest(withRound('1/3')), { code: 'BROKER_RESULT_ALREADY_CAPTURED' });
      assert.equal(calls, 2, 'a proven no-start retry remains bounded to one');
    } finally { await broker.close(); }
  });
  test(`P2: ${operation} advances sequentially only after its private TESTS_FAIL`, async (t) => {
    const input = await fixture(t, operation); let calls = 0;
    const broker = await startOfficialRunnerBroker({ ...input, invoke: async (request) => {
      calls++;
      return { operation, sequence: request.sequence, slice: request.slice, status: 'RUNNER_RESPONSE_CAPTURED', exitCode: 0,
        semanticResponseStatus: calls === 1 ? 'TESTS_FAIL' : 'TESTS_PASS', receiptFile: path.join(input.tmpdir, `receipt-${calls}.json`) };
    } });
    const request = (round) => {
      const managedPayload = { automaticCheckRound: round, changedAreas: [], filelessReason: 'Approved acceptance-only operation.' };
      return submitOfficialRunnerRequest({ ...input, prompt: JSON.stringify(managedPayload), managedPayload });
    };
    try {
      const first = await request('1/3');
      await assert.rejects(request('2/3'), { code: 'BROKER_RESULT_ALREADY_CAPTURED' });
      assert.equal(calls, 1);
      // Unit-level proof fixture; the T15 E2E uses the actual finalizer instead.
      await fs.writeFile(path.join(broker.directory, '001.finalization.json'), JSON.stringify({ operation,
        slice: input.slice, receiptFile: first.receiptFile, state: 'PRIVATE_TESTS_FAIL' }));
      await assert.rejects(request('3/3'), { code: 'BROKER_RESULT_ALREADY_CAPTURED' });
      assert.equal(calls, 1);
      const second = await request('2/3'); assert.equal(second.semanticResponseStatus, 'TESTS_PASS');
      await assert.rejects(request('3/3'), { code: 'BROKER_RESULT_ALREADY_CAPTURED' });
      assert.equal(calls, 2, 'PASS never authorizes another automatic round');
    } finally { await broker.close(); }
  });
}

test('T05: closing the broker cancels and settles its owned pending dispatch before removing active identity', { timeout: 3000 }, async (t) => {
  const input = await fixture(t, 'EXECUTE_SLICE');
  let admitted;
  const started = new Promise((resolve) => { admitted = resolve; });
  const broker = await startOfficialRunnerBroker({ ...input, invoke: (request, { signal }) => new Promise((resolve) => {
    admitted();
    signal.addEventListener('abort', () => resolve({ operation: request.operation, sequence: request.sequence,
      slice: request.slice, status: 'RUNNER_RESULT_BLOCKED', exitCode: 1, error: 'cancelled after start' }), { once: true });
  }) });
  const request = submitOfficialRunnerRequest(input);
  await started;
  assert.equal(broker.pending, true);
  const close = broker.close();
  assert.equal((await request).status, 'RUNNER_RESULT_BLOCKED');
  await close;
  assert.equal(broker.cancelledPending, true);
  assert.equal(await fs.access(path.join(broker.directory, 'active.json')).then(() => true, () => false), false);
  const summary = JSON.parse(await fs.readFile(path.join(broker.directory, '001.supervisor.json')));
  assert.equal(summary.pending, false);
  assert.equal(summary.cancelledPending, true);
});

test('T04: a barrier seals dispatched bytes and simultaneous duplicate requests admit one runner', { timeout: 3000 }, async (t) => {
  const input = await fixture(t, 'EXECUTE_SLICE');
  let announce, release, calls = 0, admitted;
  const started = new Promise((resolve) => { announce = resolve; });
  const finish = new Promise((resolve) => { release = resolve; });
  const broker = await startOfficialRunnerBroker({ ...input, invoke: async (request) => {
    calls++; admitted = request.prompt; announce(); await finish;
    return { operation: request.operation, sequence: request.sequence, slice: request.slice, status: 'RUNNER_RESPONSE_CAPTURED', exitCode: 0 };
  } });
  try {
    const first = submitOfficialRunnerRequest(input); await started;
    await fs.writeFile(broker.payloadFile, '{"changedAfterAdmission":true}');
    const duplicate = submitOfficialRunnerRequest(input);
    // Attach the rejection handler before releasing the controlled interleaving.
    const duplicateResult = assert.rejects(duplicate, { code: 'BROKER_RESULT_ALREADY_CAPTURED' });
    release(); await first; await duplicateResult;
    assert.equal(calls, 1); assert.equal(admitted, input.prompt);
    const names = (await fs.readdir(broker.directory)).filter((name) => name.startsWith('sealed-'));
    assert.equal(names.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(broker.directory, names[0]))).prompt, input.prompt);
  } finally { release(); await broker.close(); }
});

for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']) {
  test(`T07: ${operation} allows one proven pre-dispatch retry and rejects contradictory proof`, async (t) => {
    const input = await fixture(t, operation); let calls = 0;
    const broker = await startOfficialRunnerBroker({ ...input, invoke: async (request) => {
      calls++;
      return { operation, sequence: request.sequence, slice: request.slice, status: 'RUNNER_INITIALIZATION_BLOCKED', exitCode: 1,
        turnStarted: false, threadId: null, dispatchStarted: false };
    } });
    try {
      await submitOfficialRunnerRequest(input); await submitOfficialRunnerRequest(input);
      await assert.rejects(submitOfficialRunnerRequest(input), { code: 'BROKER_RESULT_ALREADY_CAPTURED' });
      assert.equal(calls, 2);
    } finally { await broker.close(); }
    const second = await fixture(t, operation);
    const contradictory = await startOfficialRunnerBroker({ ...second, invoke: async (request) => ({ operation, sequence: request.sequence, slice: request.slice,
      status: 'RUNNER_INITIALIZATION_BLOCKED', exitCode: 1, turnStarted: false, threadId: 'already-started', dispatchStarted: false }) });
    try {
      await assert.rejects(submitOfficialRunnerRequest(second), { code: 'BROKER_RESULT_INVALID' });
      await assert.rejects(submitOfficialRunnerRequest(second), { code: 'BROKER_RESULT_ALREADY_CAPTURED' });
    } finally { await contradictory.close(); }
  });
}
