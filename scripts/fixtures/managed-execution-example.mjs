import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { preflightExecutionOperation, preflightRunnerResultRecovery } from '../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { createManagedSliceContext, managedEnvironment } from '../../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';
import { startOfficialRunnerBroker } from '../../agents/codex/runtime/runner-broker.mjs';
import { runManagedRunnerBridge } from '../../agents/codex/runtime/managed-runner-bridge.mjs';
import { invokeIndependentRunner } from '../../agents/codex/runtime/validation-runner.mjs';
import { finalizeManagedSlice } from '../../agents/codex/runtime/managed-slice-finalize.mjs';
import { prepareManagedFindingsRequest } from '../../agents/codex/runtime/managed-findings-cycle.mjs';

const snapshot = path.resolve(import.meta.dirname, '../..');
// The provider's semantic response and SDK transcript are explicit offline
// stimuli. Identity, admission, candidate binding, reviewed process execution,
// capture, receipt and publication are produced by the real managed runtime.
export async function withManagedExample(f, operation, response, action, { sdkCommand = null, recovery = null, sequence = 1 } = {}) {
  const original = { ...process.env };
  assert.equal(sequence, recovery === null ? 1 : 2, 'the bounded successor uses sequence 2 only with official recovery');
  const state = recovery === null
    ? await preflightExecutionOperation(f.requirements, operation, '1')
    : await preflightRunnerResultRecovery(f.requirements, operation, '1', recovery);
  const officialPreflight = { exitCode: 0, operation, slice: 'slice-01', inputSlice: '1', specPath: f.requirements,
    state: state.state, authority: 'sha256:' + state.currentFingerprint, legalOperations: state.legalOperations,
    mandatoryRecovery: state.mandatoryRecovery, activationId: state.activation.activationId };
  const context = await createManagedSliceContext({ officialPreflight, workspace: f.root, snapshot, recovery,
    adapterPath: path.join(snapshot, 'agents/codex/runtime/validation-runner.mjs'),
    bridgePath: path.join(snapshot, 'agents/codex/runtime/managed-runner-bridge.mjs'),
    preflightPath: path.join(snapshot, 'agents/codex/runtime/managed-slice-preflight.mjs') });
  Object.assign(officialPreflight, { owner: context.owner, expectedActivationId: context.expectedActivationId });
  const tmpdir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-managed-example-')));
  f.test?.after(() => fs.rm(tmpdir, { recursive: true, force: true }));
  const environment = managedEnvironment({ ...process.env, TMPDIR: tmpdir,
    STNL_MANAGED_FINALIZER: path.join(snapshot, 'agents/codex/runtime/managed-slice-finalize.mjs') }, context);
  delete environment.NODE_TEST_CONTEXT;
  let broker, calls = 0;
  try {
    Object.assign(process.env, environment);
    broker = await startOfficialRunnerBroker({ workspace: f.root, tmpdir, operation, sequence, slice: 'slice-01', officialPreflight, pollIntervalMs: 1,
      prepareSealedMetadata: async request => {
        const findingsOwnership = await prepareManagedFindingsRequest({ request, environment });
        return findingsOwnership === null ? null : { findingsOwnership };
      },
      invoke: request => invokeIndependentRunner({ ...request, snapshot, env: environment, runTurn: async args => {
        calls += 1;
        const threadId = 'offline-example-' + randomUUID();
        const final = typeof response === 'function' ? await response(args) : response;
        const events = [{ type: 'thread.started', thread_id: threadId }, { type: 'turn.started' },
          ...(sdkCommand === null ? [] : [{ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: sdkCommand } }, { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: sdkCommand, status: 'completed', exit_code: 0 } }]),
          { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: typeof final === 'string' ? final : JSON.stringify(final) } }, { type: 'turn.completed' }];
        await fs.writeFile(args.eventsPath, events.map(event => JSON.stringify({ ...event, operationId: args.operationId })).join('\n') + '\n', { flag: 'wx' });
        return { completed: true, turnStarted: true, threadId, error: null, processError: null, errorEvent: null,
          requestedModel: args.model, requestedEffort: args.effort, reportedModel: args.model, usage: null };
      } }) });
    const prepared = await finalizeManagedSlice('--prepare');
    assert.equal(prepared.status, 'PREPARED');
    const binding = JSON.parse(await fs.readFile(path.join(tmpdir, `stnl-runner-broker/${String(sequence).padStart(3, '0')}.candidate.json`)));
    f.test?.after(() => fs.rm(binding.candidateExecutionRoot, { recursive: true, force: true }));
    return await action({ context, environment, tmpdir, broker, copy: binding,
      dispatch: payload => runManagedRunnerBridge({ environment, cwd: f.root, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
      finalize: () => finalizeManagedSlice('--finalize'), calls: () => calls });
  } finally {
    try { if (broker) await broker.close(); }
    finally { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); }
  }
}
