import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertManagedAgreement,
  createManagedSliceContext,
  managedEnvironment,
  readManagedSliceContext,
  assertManagedRuntimeIdentity,
} from '../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs';
import { runManagedRunnerBridge } from '../agents/codex/runtime/managed-runner-bridge.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-managed-context-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runRoot = path.join(root, 'run-ABC123');
  const workspace = path.join(runRoot, 'case-c', 'workspace');
  const specPath = path.join(workspace, 'specs', 'case-c');
  const privateHome = path.join(root, 'run-ABC123-c-QwE456');
  const snapshot = path.join(runRoot, 'snapshot');
  const adapterPath = path.join(snapshot, 'agents/codex/runtime/validation-runner.mjs');
  const bridgePath = path.join(snapshot, 'agents/codex/runtime/managed-runner-bridge.mjs');
  const preflightPath = path.join(snapshot, 'agents/codex/runtime/managed-slice-preflight.mjs');
  await fs.mkdir(specPath, { recursive: true });
  await fs.mkdir(path.dirname(adapterPath), { recursive: true });
  await fs.writeFile(path.join(specPath, 'feature_spec.md'), '# Fixture\n');
  for (const file of [adapterPath, bridgePath, preflightPath]) await fs.writeFile(file, '# helper\n');
  await fs.chmod(adapterPath, 0o755);
  const officialPreflight = {
    exitCode: 0, operation: 'VALIDATE_SLICE', slice: 'slice-01', inputSlice: '1', specPath,
    state: 'IMPLEMENTED_AWAITING_VALIDATION', authority: `sha256:${'a'.repeat(64)}`,
    legalOperations: [{ operation: 'VALIDATE_SLICE', slice: 'slice-01' }], mandatoryRecovery: null,
  };
  return { root, runRoot, workspace, specPath, privateHome, snapshot,
    adapterPath, bridgePath, preflightPath, officialPreflight };
}

for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']) {
  test(`managed context preserves official identity for ${operation}`, async (t) => {
    const f = await fixture(t);
    const preflight = { ...f.officialPreflight, operation,
      legalOperations: [{ operation, slice: 'slice-01' }] };
    const context = await createManagedSliceContext({ officialPreflight: preflight,
      workspace: f.workspace, snapshot: f.snapshot, adapterPath: f.adapterPath,
      bridgePath: f.bridgePath, preflightPath: f.preflightPath });
    const environment = managedEnvironment({ CODEX_HOME: f.privateHome }, context);
    assert.equal(environment.STNL_MANAGED_PREFLIGHT, f.preflightPath);
    assert.equal(environment.STNL_MANAGED_RUNNER_BRIDGE, f.bridgePath);
    const read = readManagedSliceContext(environment);
    assert.equal(read.specPath, f.specPath);
    assert.equal(read.workspace, f.workspace);
    assert.equal(read.operation, operation);
    assert.equal(read.slice, 'slice-01');
    assert.equal(read.identity.snapshot.path, f.snapshot);
    assert.equal(read.identity.adapter.path, f.adapterPath);
    assert.equal(read.identity.bridge.path, f.bridgePath);
    assert.equal(read.identity.preflight.path, f.preflightPath);
    assert.equal(read.specPath.includes(f.privateHome), false);
    assert.equal(assertManagedAgreement({ specPath: f.specPath, workspace: f.workspace,
      slice: '1', operation, environment }).specPath, f.specPath);
  });
}

test('managed identity disagreement blocks every runner operation before dispatch and stale context is rejected', async (t) => {
  const f = await fixture(t);
  let context;
  let environment;
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']) {
    const officialPreflight = { ...f.officialPreflight, operation,
      legalOperations: [{ operation, slice: 'slice-01' }] };
    context = await createManagedSliceContext({ officialPreflight,
      workspace: f.workspace, snapshot: f.snapshot, adapterPath: f.adapterPath,
      bridgePath: f.bridgePath, preflightPath: f.preflightPath });
    environment = managedEnvironment({}, context);
    const otherOperation = operation === 'EXECUTE_SLICE' ? 'VALIDATE_SLICE' : 'EXECUTE_SLICE';
    assert.throws(() => assertManagedAgreement({ operation: otherOperation, environment }), /disagrees/u);
    assert.throws(() => assertManagedAgreement({ slice: '2', environment }), /disagrees/u);
    assert.throws(() => assertManagedAgreement({ workspace: f.privateHome, environment }), /disagrees/u);
    assert.throws(() => assertManagedAgreement({ specPath: path.join(f.privateHome, 'specs/case-c'), environment }), /disagrees/u);
  }
  const stale = { ...context, identity: { ...context.identity,
    adapter: { ...context.identity.adapter, sha256: `sha256:${'b'.repeat(64)}` } } };
  await assert.rejects(assertManagedRuntimeIdentity(stale, { ...environment, STNL_MANAGED_CONTEXT: JSON.stringify(stale) }), /identity|changed|disagree/u);
  assert.equal(readManagedSliceContext({}), null);
  assert.equal(readManagedSliceContext({ STNL_RUNNER_ADAPTER: f.adapterPath }), null,
    'configured manual adapter alone does not enable managed mode');
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']) {
    assert.equal(assertManagedAgreement({ specPath: f.specPath, slice: '1', operation, environment: {} }), null,
      `${operation} keeps the manual fallback when managed context is absent`);
  }
  assert.throws(() => managedEnvironment({ STNL_RUNNER_ADAPTER: path.join(f.root, 'wrong-adapter.mjs') }, context),
    /configured adapter disagrees/u);
});

test('managed context rejects adapter, bridge, preflight, and spec paths outside the frozen snapshot/workspace', async (t) => {
  const f = await fixture(t);
  const sibling = path.join(f.runRoot, 'case-b/workspace/specs/case-b');
  const source = path.join(f.root, 'source/specs/source');
  await fs.mkdir(sibling, { recursive: true });
  await fs.mkdir(source, { recursive: true });
  for (const specPath of [sibling, source, f.privateHome]) {
    await assert.rejects(createManagedSliceContext({ workspace: f.workspace,
      officialPreflight: { ...f.officialPreflight, specPath }, snapshot: f.snapshot,
      adapterPath: f.adapterPath, bridgePath: f.bridgePath, preflightPath: f.preflightPath }), /outside managed workspace|canonical entries/u);
  }
  const forbiddenAdapters = [
    path.join(f.root, 'source/agents/codex/runtime/validation-runner.mjs'),
    path.join(f.root, 'Main/agents/codex/runtime/validation-runner.mjs'),
  ];
  for (const adapterPath of forbiddenAdapters) {
    await fs.mkdir(path.dirname(adapterPath), { recursive: true });
    await fs.writeFile(adapterPath, '# forbidden adapter\n');
    await fs.chmod(adapterPath, 0o755);
    await assert.rejects(createManagedSliceContext({ workspace: f.workspace, officialPreflight: f.officialPreflight,
      snapshot: f.snapshot, adapterPath, bridgePath: f.bridgePath,
      preflightPath: f.preflightPath }), /outside (?:frozen )?snapshot/u);
  }
  const siblingSnapshot = path.join(f.root, 'run-sibling', 'snapshot');
  const siblingAdapter = path.join(siblingSnapshot, 'agents/codex/runtime/validation-runner.mjs');
  await fs.mkdir(path.dirname(siblingAdapter), { recursive: true });
  await fs.writeFile(siblingAdapter, '# sibling adapter\n');
  await fs.chmod(siblingAdapter, 0o755);
  await assert.rejects(createManagedSliceContext({ workspace: f.workspace, officialPreflight: f.officialPreflight,
    snapshot: f.snapshot, adapterPath: siblingAdapter, bridgePath: f.bridgePath,
    preflightPath: f.preflightPath }), /outside frozen snapshot/u);
});

test('pathless bridge preserves semantic payload and uses managed identity for all slice operations', async (t) => {
  const f = await fixture(t);
  const payload = '{"status":"semantic","evidence":"byte-for-byte"}\n';
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']) {
    const officialPreflight = { ...f.officialPreflight, operation,
      legalOperations: [{ operation, slice: 'slice-01' }] };
    const context = await createManagedSliceContext({ officialPreflight, workspace: f.workspace,
      snapshot: f.snapshot, adapterPath: f.adapterPath, bridgePath: f.bridgePath,
      preflightPath: f.preflightPath });
    const environment = managedEnvironment({ TMPDIR: f.root }, context);
    let observed = null;
    let freshnessCalls = 0;
    const result = await runManagedRunnerBridge({ environment, cwd: f.workspace, payload,
      verifyFreshness: async (received) => {
        freshnessCalls += 1;
        assert.equal(received, environment);
      },
      loadAdapter: async (adapter) => {
        assert.equal(adapter, f.adapterPath);
        return { submitRunnerPayload: async (request) => {
          observed = request;
          return { status: 'RUNNER_RESPONSE_CAPTURED', operation, slice: 'slice-01', exitCode: 0 };
        } };
      } });
    assert.equal(freshnessCalls, 1);
    assert.equal(observed.prompt, payload);
    assert.equal(observed.operation, operation);
    assert.equal(observed.slice, 'slice-01');
    assert.equal(observed.cwd, f.workspace);
    assert.equal(result.exitCode, 0);
  }
});

test('bridge rejects context disagreement before adapter dispatch', async (t) => {
  const f = await fixture(t);
  const context = await createManagedSliceContext({ officialPreflight: f.officialPreflight,
    workspace: f.workspace, snapshot: f.snapshot, adapterPath: f.adapterPath,
    bridgePath: f.bridgePath, preflightPath: f.preflightPath });
  const environment = managedEnvironment({}, context);
  let dispatches = 0;
  await assert.rejects(runManagedRunnerBridge({
    environment: { ...environment, STNL_MANAGED_OPERATION: 'EXECUTE_SLICE' },
    cwd: f.workspace,
    payload: '{"status":"semantic"}',
    verifyFreshness: async () => {},
    loadAdapter: async () => {
      dispatches += 1;
      return { submitRunnerPayload: async () => ({ exitCode: 0 }) };
    },
  }), /disagree/u);
  assert.equal(dispatches, 0);
});
