#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalHarnessRequest,
  canonicalSliceInput,
  decideOfficialOutcome,
  dispatchForOperation,
  finalizeAndPreserve,
  runPilotSchedule,
} from '../benchmarks/sentinel-todo/runtime/benchmark-production-pilot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'benchmarks', 'sentinel-todo', 'benchmark.json');

async function temporary(t, prefix) {
  const logical = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = await fs.realpath(logical);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('P01 — finalize non-zero preserves an existing canonical raw before cleanup', async (t) => {
  const root = await temporary(t, 'pilot-finalize-');
  const rawPath = path.join(root, 'session', 'result.json');
  const destination = path.join(root, 'durable', 'case-a-production-v2.json');
  await fs.mkdir(path.dirname(rawPath));
  const raw = { caseId: 'A', productionProfileId: 'production-v2', status: 'BLOCKED' };
  const finalized = await finalizeAndPreserve({
    finalize: async () => {
      await fs.writeFile(rawPath, `${JSON.stringify(raw)}\n`, 'utf8');
      return { exitCode: 1, stdout: '', stderr: 'finalized with status BLOCKED' };
    },
    rawPath,
    destination,
    expectedCaseId: 'A',
    expectedProfileId: 'production-v2',
  });
  assert.equal(finalized.finalizer.exitCode, 1);
  assert.equal(finalized.preserved, true);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), raw);
  await fs.rm(path.dirname(rawPath), { recursive: true });
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), raw);
});

test('P02 — official readback wins over model prose and ad hoc interpretation', () => {
  const success = decideOfficialOutcome({
    operation: 'SPEC_INIT',
    harnessStatus: 'HARNESS_COMPLETED',
    modelText: 'BLOCKED because no exact - status: ready line exists',
    official: { lifecycle: { status: 'ready' }, execution: { state: 'EMPTY' } },
  });
  assert.deepEqual(success, { result: 'PASS', blocker: null });

  const blocked = decideOfficialOutcome({
    operation: 'EXECUTE_SLICE',
    harnessStatus: 'HARNESS_COMPLETED',
    modelText: 'PASS',
    official: { lifecycle: { status: 'ready' }, execution: { state: 'AUXILIARY_BLOCKED' } },
  });
  assert.deepEqual(blocked, { result: 'BLOCKED', blocker: 'OFFICIAL_AUXILIARY_BLOCKED' });
});

test('P03 — harness requests canonicalize cwd and TMPDIR before invocation', async (t) => {
  const root = await temporary(t, 'pilot-canonical-');
  const physical = path.join(root, 'physical');
  const tmpdir = path.join(root, 'runner-tmp');
  const alias = path.join(root, 'alias');
  await fs.mkdir(physical);
  await fs.mkdir(tmpdir);
  await fs.symlink(physical, alias, 'dir');
  const request = await canonicalHarnessRequest({
    workspace: alias,
    tmpdir,
    dispatch: { model: 'GPT-5.6-Luna', effort: 'high' },
    prompt: 'operation',
  });
  assert.equal(request.cwd, await fs.realpath(physical));
  assert.equal(request.tmpdir, await fs.realpath(tmpdir));
});

test('P04 — canonical slice labels render as unsigned decimal launcher input', () => {
  assert.equal(canonicalSliceInput('slice-01'), '1');
  assert.equal(canonicalSliceInput('slice-02'), '2');
  assert.equal(canonicalSliceInput('slice-10'), '10');
  assert.throws(() => canonicalSliceInput('1'), /invalid canonical slice label/u);
});

test('P05 — blocked Case A gates B/C and no case receives an outer retry', async () => {
  const calls = [];
  const result = await runPilotSchedule(async (caseId) => {
    calls.push(caseId);
    return { caseId, status: 'BLOCKED' };
  });
  assert.deepEqual(calls, ['A']);
  assert.equal(result.B.status, 'NOT_RUN');
  assert.equal(result.C.status, 'NOT_RUN');
});

test('P05b — an infrastructure rejection in Case A is terminal and still gates B/C', async () => {
  const calls = [];
  const result = await runPilotSchedule(async (caseId) => {
    calls.push(caseId);
    throw new Error('session creation failed');
  });
  assert.deepEqual(calls, ['A']);
  assert.equal(result.A.status, 'BLOCKED');
  assert.equal(result.A.blocker, 'DRIVER_FAILURE');
  assert.equal(result.B.status, 'NOT_RUN');
  assert.equal(result.C.status, 'NOT_RUN');
});

test('P06 — B/C start concurrently after A passes and one sibling cannot cancel the other', async () => {
  const calls = [];
  let releaseB;
  let releaseC;
  const b = new Promise((resolve) => { releaseB = resolve; });
  const c = new Promise((resolve) => { releaseC = resolve; });
  const scheduled = runPilotSchedule(async (caseId) => {
    calls.push(caseId);
    if (caseId === 'A') return { caseId, status: 'PASS' };
    if (caseId === 'B') return b;
    return c;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['A', 'B', 'C']);
  releaseB({ caseId: 'B', status: 'BLOCKED' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((caseId) => caseId === 'C').length, 1);
  releaseC({ caseId: 'C', status: 'PASS', rawSha256: 'c' });
  const result = await scheduled;
  assert.equal(result.B.status, 'BLOCKED');
  assert.equal(result.C.status, 'PASS');
  assert.deepEqual(calls, ['A', 'B', 'C']);
});

test('P06b — a rejected sibling still waits for and preserves the other sibling result', async () => {
  const calls = [];
  const result = await runPilotSchedule(async (caseId) => {
    calls.push(caseId);
    if (caseId === 'A') return { caseId, status: 'PASS' };
    if (caseId === 'B') throw new Error('B infrastructure failure');
    await new Promise((resolve) => setImmediate(resolve));
    return { caseId, status: 'PASS', rawSha256: 'preserved-c' };
  });
  assert.deepEqual(calls, ['A', 'B', 'C']);
  assert.equal(result.B.status, 'BLOCKED');
  assert.equal(result.C.status, 'PASS');
  assert.equal(result.C.rawSha256, 'preserved-c');
});

test('P07 — durable evidence stays outside and does not contaminate the functional workspace', async (t) => {
  const root = await temporary(t, 'pilot-integrity-');
  const workspace = path.join(root, 'workspace');
  const session = path.join(root, 'session');
  const durable = path.join(root, 'evidence', 'raw.json');
  const rawPath = path.join(session, 'raw.json');
  await fs.mkdir(workspace);
  await fs.mkdir(session);
  await fs.writeFile(path.join(workspace, 'functional.txt'), 'unchanged\n', 'utf8');
  const before = await fs.readFile(path.join(workspace, 'functional.txt'));
  const raw = { caseId: 'C', productionProfileId: 'production-v2', status: 'PASS' };
  const result = await finalizeAndPreserve({
    finalize: async () => {
      await fs.writeFile(rawPath, `${JSON.stringify(raw)}\n`, 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    rawPath,
    destination: durable,
    expectedCaseId: 'C',
    expectedProfileId: 'production-v2',
  });
  assert.equal(result.preserved, true);
  assert.deepEqual(await fs.readFile(path.join(workspace, 'functional.txt')), before);
  assert.deepEqual(await fs.readdir(workspace), ['functional.txt']);
});

test('P08 — production-v2 is the sole dispatch authority and mismatches remain observable', async () => {
  const configuration = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
  assert.equal(configuration.productionPilot.driverVersion, 1);
  assert.equal(configuration.productionPilot.qualification.sandboxProbeStatus, 'SANDBOX_PROBE_PASS');
  assert.deepEqual(dispatchForOperation(configuration, 'A', 'PLAN'), {
    phase: 'PLAN', model: 'GPT-5.6-Terra', effort: 'high',
  });
  const expected = dispatchForOperation(configuration, 'B', 'VALIDATE_SLICE');
  const observed = { model: 'GPT-5.6-Luna', effort: 'high' };
  assert.notDeepEqual({ model: expected.model, effort: expected.effort }, observed);
  assert.throws(
    () => dispatchForOperation({ ...configuration, productionProfile: { ...configuration.productionProfile, id: 'production-v1' } }, 'A', 'PLAN'),
    /production-v2 is required/u,
  );
});
