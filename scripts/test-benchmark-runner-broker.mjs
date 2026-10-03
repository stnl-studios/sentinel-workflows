import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  startOfficialRunnerBroker,
  submitOfficialRunnerRequest,
} from '../agents/codex/runtime/runner-broker.mjs';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-runner-broker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'case-c');
  const tmpdir = path.join(root, 'runner-tmp');
  const specPath = path.join(workspace, 'specs', 'benchmark-case-c');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(tmpdir);
  await fs.mkdir(specPath, { recursive: true });
  await fs.writeFile(path.join(specPath, 'feature_spec.md'), '# Test spec\n', 'utf8');
  return {
    workspace: await fs.realpath(workspace),
    specPath: await fs.realpath(specPath),
    tmpdir: await fs.realpath(tmpdir),
  };
}

function officialPreflight({ operation, slice, specPath, mandatoryRecovery = null }) {
  return {
    exitCode: 0,
    operation,
    slice,
    inputSlice: String(Number(slice.slice('slice-'.length))),
    specPath,
    state: mandatoryRecovery === null ? 'MATERIALIZED_PRISTINE' : 'RUNNER_INITIALIZATION_BLOCKED',
    authority: `sha256:${'a'.repeat(64)}`,
    legalOperations: [{ operation, slice }],
    mandatoryRecovery,
  };
}

function runnerReceipt({ operation, sequence, slice, status = 'RUNNER_RESPONSE_CAPTURED' }) {
  return {
    sequence,
    operation,
    slice,
    attempt: 1,
    runnerAgent: 'stnl_validation_runner',
    status,
    exitCode: status === 'RUNNER_RESPONSE_CAPTURED' ? 0 : 1,
  };
}

test('official runner broker serializes the configured runner flat receipt without changing its identity', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  const payload = {
    workspace,
    tmpdir,
    operation: 'EXECUTE_SLICE',
    sequence: 7,
    slice: 'slice-01',
    officialPreflight: officialPreflight({ operation: 'EXECUTE_SLICE', slice: 'slice-01', specPath }),
    prompt: 'Select focused persistence checks and return the required semantic JSON.',
  };
  const invoked = [];
  const broker = await startOfficialRunnerBroker({
    ...payload,
    invoke: async (request) => {
      invoked.push(request);
      return runnerReceipt(request);
    },
  });
  try {
    const result = await submitOfficialRunnerRequest(payload);
    const { exitCode, ...receipt } = runnerReceipt(payload);
    assert.deepEqual(result, { ...receipt, exitCode });
    assert.deepEqual(invoked, [{
      ...payload,
      specPath: payload.officialPreflight.specPath,
      officialPreflight: payload.officialPreflight,
      managedPayload: null,
    }]);
    assert.equal(broker.requestsHandled, 1);
    assert.deepEqual(broker.errors, []);
  } finally {
    await broker.close();
  }
});

test('official runner broker forwards the exact authorized same-operation recovery preflight', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  const authorized = officialPreflight({
    operation: 'EXECUTE_SLICE',
    slice: 'slice-02',
    specPath,
    mandatoryRecovery: {
      operation: 'EXECUTE_SLICE',
      slice: 'slice-02',
      owner: 'delegation-blocker',
      sameOperationResumeRequired: true,
    },
  });
  let dispatched;
  const broker = await startOfficialRunnerBroker({
    workspace,
    tmpdir,
    operation: 'EXECUTE_SLICE',
    sequence: 11,
    slice: 'slice-02',
    officialPreflight: authorized,
    invoke: async (request) => {
      dispatched = request;
      return runnerReceipt(request);
    },
  });
  try {
    const result = await submitOfficialRunnerRequest({
      workspace,
      tmpdir,
      operation: 'EXECUTE_SLICE',
      sequence: 11,
      slice: 'slice-02',
      prompt: 'Resume only at the authorized runner invocation.',
    });
    assert.equal(result.status, 'RUNNER_RESPONSE_CAPTURED');
    assert.equal(dispatched.specPath, specPath);
    assert.deepEqual(dispatched.officialPreflight, authorized);
    assert.equal(dispatched.officialPreflight.inputSlice, '2');
    assert.equal(dispatched.officialPreflight.mandatoryRecovery.sameOperationResumeRequired, true);
    assert.deepEqual(broker.errors, []);
  } finally {
    await broker.close();
  }
});

test('official runner broker rejects a non-authoritative nested receipt shape without fallback', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  let calls = 0;
  const broker = await startOfficialRunnerBroker({
    workspace,
    tmpdir,
    operation: 'EXECUTE_SLICE',
    sequence: 8,
    slice: 'slice-01',
    officialPreflight: officialPreflight({ operation: 'EXECUTE_SLICE', slice: 'slice-01', specPath }),
    invoke: async (request) => {
      calls += 1;
      const { exitCode, ...receipt } = runnerReceipt(request);
      return { receipt, exitCode };
    },
  });
  try {
    await assert.rejects(
      () => submitOfficialRunnerRequest({
        workspace,
        tmpdir,
        operation: 'EXECUTE_SLICE',
        sequence: 8,
        slice: 'slice-01',
        prompt: 'The configured runner response shape must remain exact.',
      }),
      (error) => error.code === 'BROKER_RESULT_INVALID',
    );
    assert.equal(calls, 1);
    assert.deepEqual(broker.errors, ['BROKER_RESULT_INVALID']);
  } finally {
    await broker.close();
  }
});

test('official runner broker fails closed when no active driver broker exists', async (t) => {
  const { workspace, tmpdir } = await fixture(t);
  await assert.rejects(
    () => submitOfficialRunnerRequest({
      workspace,
      tmpdir,
      operation: 'EXECUTE_SLICE',
      sequence: 1,
      slice: 'slice-01',
      prompt: 'Focused checks',
      timeoutMs: 100,
    }),
    (error) => error.code === 'BROKER_FILE_UNSAFE',
  );
});

test('validation-runner CLI executes directly, requires the active broker, and never starts a nested runner', async (t) => {
  const { workspace, tmpdir } = await fixture(t);
  const helper = path.join(REPOSITORY, 'agents/codex/runtime/validation-runner.mjs');
  const result = spawnSync(helper, [
    '--operation', 'EXECUTE_SLICE',
    '--slice', 'slice-01',
  ], {
    cwd: workspace,
    encoding: 'utf8',
    input: 'automaticCheckRound=1/3\nFocused checks\n',
    env: { ...process.env, TMPDIR: tmpdir },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /active\.json/u);
  assert.deepEqual(await fs.readdir(tmpdir), []);
});

test('official runner broker rejects a mismatched recovery target without dispatch', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  let calls = 0;
  const broker = await startOfficialRunnerBroker({
    workspace,
    tmpdir,
    operation: 'EXECUTE_SLICE',
    sequence: 9,
    slice: 'slice-02',
    officialPreflight: officialPreflight({ operation: 'EXECUTE_SLICE', slice: 'slice-02', specPath }),
    invoke: async () => {
      calls += 1;
      return runnerReceipt({ operation: 'EXECUTE_SLICE', sequence: 9, slice: 'slice-02' });
    },
  });
  try {
    await assert.rejects(
      () => submitOfficialRunnerRequest({
        workspace,
        tmpdir,
        operation: 'EXECUTE_SLICE',
        sequence: 9,
        slice: 'slice-01',
        prompt: 'Wrong slice must be rejected.',
        timeoutMs: 100,
      }),
      (error) => error.code === 'BROKER_TARGET_MISMATCH',
    );
    assert.equal(calls, 0);
    assert.equal(broker.requestsHandled, 0);
  } finally {
    await broker.close();
  }
});

test('official runner initialization failure is returned once without retry or fallback', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  let calls = 0;
  const blocked = runnerReceipt({
    operation: 'VALIDATE_SLICE',
    sequence: 3,
    slice: 'slice-10',
    status: 'RUNNER_INITIALIZATION_BLOCKED',
  });
  const broker = await startOfficialRunnerBroker({
    workspace,
    tmpdir,
    operation: 'VALIDATE_SLICE',
    sequence: 3,
    slice: 'slice-10',
    officialPreflight: officialPreflight({ operation: 'VALIDATE_SLICE', slice: 'slice-10', specPath }),
    invoke: async () => {
      calls += 1;
      return blocked;
    },
  });
  try {
    const result = await submitOfficialRunnerRequest({
      workspace,
      tmpdir,
      operation: 'VALIDATE_SLICE',
      sequence: 3,
      slice: 'slice-10',
      prompt: 'Return a validation verdict.',
    });
    assert.deepEqual(result, blocked);
    assert.equal(calls, 1);
    assert.equal(broker.requestsHandled, 1);
  } finally {
    await broker.close();
  }
});

test('pending validation keeps its first BLOCKED receipt and does not dispatch a queued divergent retry', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  const payload = {
    workspace, tmpdir, operation: 'VALIDATE_SLICE', sequence: 7, slice: 'slice-01',
    prompt: 'Validate the current slice.',
  };
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const broker = await startOfficialRunnerBroker({
    ...payload,
    officialPreflight: officialPreflight({ operation: payload.operation, slice: payload.slice, specPath }),
    invoke: async (request) => {
      calls += 1;
      signalStarted();
      await pending;
      return { ...runnerReceipt(request), semanticResponseStatus: calls === 1 ? 'BLOCKED' : 'PASS' };
    },
  });
  try {
    const first = submitOfficialRunnerRequest(payload);
    await started;
    const second = submitOfficialRunnerRequest({ ...payload, prompt: 'Retry while the first runner is pending.' });
    const duplicateRejected = assert.rejects(second,
      (error) => error.code === 'BROKER_RESULT_ALREADY_CAPTURED');
    // Both requests are present while the first invocation is unresolved.
    let queuedRequests = 0;
    for (let i = 0; i < 40; i += 1) {
      queuedRequests = (await fs.readdir(broker.directory)).filter((name) => name.startsWith('request-')).length;
      if (queuedRequests === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(queuedRequests, 2);
    assert.equal(calls, 1);
    release();
    const result = await first;
    assert.equal(result.status, 'RUNNER_RESPONSE_CAPTURED');
    assert.equal(result.semanticResponseStatus, 'BLOCKED');
    assert.equal(result.exitCode, 0);
    await duplicateRejected;
    await assert.rejects(() => submitOfficialRunnerRequest(payload),
      (error) => error.code === 'BROKER_RESULT_ALREADY_CAPTURED');
    assert.equal(calls, 1);
    assert.equal(broker.capturedReceipts, 1);
  } finally {
    release();
    await broker.close();
  }
});

test('a started validation with malformed final output blocks a queued retry', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  const payload = {
    workspace, tmpdir, operation: 'VALIDATE_SLICE', sequence: 9, slice: 'slice-01',
    prompt: 'Validate the current slice.',
  };
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const broker = await startOfficialRunnerBroker({
    ...payload,
    officialPreflight: officialPreflight({ operation: payload.operation, slice: payload.slice, specPath }),
    invoke: async (request) => {
      calls += 1;
      signalStarted();
      await pending;
      if (calls > 1) return { ...runnerReceipt(request), semanticResponseStatus: 'PASS' };
      return { ...runnerReceipt({ ...request, status: 'RUNNER_RESULT_BLOCKED' }),
        threadId: 'started-runner', semanticResponseFile: null, captureFailure: 'invalid final JSON' };
    },
  });
  try {
    const first = submitOfficialRunnerRequest(payload);
    await started;
    const retry = submitOfficialRunnerRequest({ ...payload, prompt: 'Queued retry.' });
    const retryRejected = assert.rejects(retry,
      (error) => error.code === 'BROKER_RESULT_ALREADY_CAPTURED');
    let queuedRequests = 0;
    for (let i = 0; i < 40; i += 1) {
      queuedRequests = (await fs.readdir(broker.directory)).filter((name) => name.startsWith('request-')).length;
      if (queuedRequests === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(queuedRequests, 2);
    assert.equal(calls, 1);
    release();
    const result = await first;
    assert.equal(result.status, 'RUNNER_RESULT_BLOCKED');
    assert.equal(result.exitCode, 1);
    assert.equal(result.captureFailure, 'invalid final JSON');
    await retryRejected;
    await assert.rejects(() => submitOfficialRunnerRequest(payload),
      (error) => error.code === 'BROKER_RESULT_ALREADY_CAPTURED');
    assert.equal(calls, 1);
    assert.equal(broker.capturedReceipts, 0);
  } finally {
    release();
    await broker.close();
  }
});

test('validation initialization without a started runner permits a later request', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  const payload = {
    workspace, tmpdir, operation: 'VALIDATE_SLICE', sequence: 10, slice: 'slice-01',
    prompt: 'Validate the current slice.',
  };
  let calls = 0;
  const broker = await startOfficialRunnerBroker({
    ...payload,
    officialPreflight: officialPreflight({ operation: payload.operation, slice: payload.slice, specPath }),
    invoke: async (request) => {
      calls += 1;
      return runnerReceipt({ ...request,
        status: calls === 1 ? 'RUNNER_INITIALIZATION_BLOCKED' : 'RUNNER_RESPONSE_CAPTURED' });
    },
  });
  try {
    const first = await submitOfficialRunnerRequest(payload);
    assert.equal(first.status, 'RUNNER_INITIALIZATION_BLOCKED');
    const second = await submitOfficialRunnerRequest(payload);
    assert.equal(second.status, 'RUNNER_RESPONSE_CAPTURED');
    assert.equal(calls, 2);
  } finally {
    await broker.close();
  }
});

test('an invocation exception has uncertain provider state and blocks a later validation request', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  const payload = {
    workspace, tmpdir, operation: 'VALIDATE_SLICE', sequence: 8, slice: 'slice-01',
    prompt: 'Validate the current slice.',
  };
  let calls = 0;
  const broker = await startOfficialRunnerBroker({
    ...payload,
    officialPreflight: officialPreflight({ operation: payload.operation, slice: payload.slice, specPath }),
    invoke: async (request) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('transport failed'), { code: 'RUNNER_TRANSPORT_FAILED' });
      return runnerReceipt(request);
    },
  });
  try {
    await assert.rejects(() => submitOfficialRunnerRequest(payload),
      (error) => error.code === 'RUNNER_TRANSPORT_FAILED');
    assert.equal(broker.capturedReceipts, 0);
    await assert.rejects(() => submitOfficialRunnerRequest(payload),
      (error) => error.code === 'BROKER_RESULT_ALREADY_CAPTURED');
    assert.equal(calls, 1);
    assert.equal(broker.capturedReceipts, 0);
  } finally {
    await broker.close();
  }
});

test('execute slice still permits distinct automatic check rounds in one operation', async (t) => {
  const { workspace, specPath, tmpdir } = await fixture(t);
  const payload = {
    workspace, tmpdir, operation: 'EXECUTE_SLICE', sequence: 6, slice: 'slice-01',
  };
  let calls = 0;
  const broker = await startOfficialRunnerBroker({
    ...payload,
    officialPreflight: officialPreflight({ operation: payload.operation, slice: payload.slice, specPath }),
    invoke: async (request) => {
      calls += 1;
      return runnerReceipt(request);
    },
  });
  try {
    for (const round of ['1/3', '2/3']) {
      const result = await submitOfficialRunnerRequest({ ...payload, prompt: `automaticCheckRound=${round}` });
      assert.equal(result.status, 'RUNNER_RESPONSE_CAPTURED');
    }
    assert.equal(calls, 2);
    assert.equal(broker.capturedReceipts, 2);
  } finally {
    await broker.close();
  }
});
