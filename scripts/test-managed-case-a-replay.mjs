import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runManagedRunnerBridge } from '../agents/codex/runtime/managed-runner-bridge.mjs';
import { invokeIndependentRunner, runnerDispatchMode } from '../agents/codex/runtime/validation-runner.mjs';
import { startOfficialRunnerBroker } from '../agents/codex/runtime/runner-broker.mjs';
import { createManagedSliceContext, managedEnvironment } from '../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs';
import { preflightExecutionOperation, inspectExecutionState, validateExecutionCandidate } from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { prepareExecutionCopy, publishExecutionCopy } from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HISTORY = path.join(ROOT, 'benchmark-temp/run-20260929155208-b632f5bd/case-a');
const CLAIM = '../../../../src/cli.mjs';

test('Case A R1-R6: managed payload, conceptual task, recovery and strict publication', async (t) => {
  if (!await fs.access(path.join(HISTORY, 'workspace/specs/benchmark-case-a/execution/tasks/slice-01.md')).then(() => true, () => false)) {
    t.skip('preserved Case A artifacts are unavailable'); return;
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-case-a-offline-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const tmpdir = path.join(root, 'runner-tmp');
  await fs.cp(path.join(HISTORY, 'workspace'), workspace, { recursive: true });
  await fs.mkdir(tmpdir);
  const specPath = path.join(workspace, 'specs/benchmark-case-a');
  const taskPath = path.join(specPath, 'execution/tasks/slice-01.md');
  const task = await fs.readFile(taskPath, 'utf8');
  assert.equal((task.match(/\| expected areas: [^\n]*`\.\.\/\.\.\/\.\.\/\.\.\/src\/cli\.mjs`/gu) ?? []).length, 1);
  assert.equal((task.match(/\| expected areas: CLI parsing and output behavior/gu) ?? []).length, 5);

  const current = await preflightExecutionOperation(specPath, 'EXECUTE_SLICE', '1');
  assert.equal(current.state, 'RUNNER_RESULT_BLOCKED');
  const officialPreflight = { exitCode: 0, operation: 'EXECUTE_SLICE', slice: 'slice-01', inputSlice: '1',
    specPath, state: current.state, authority: `sha256:${current.currentFingerprint}`,
    legalOperations: current.legalOperations, mandatoryRecovery: current.mandatoryRecovery };
  assert.equal(runnerDispatchMode(officialPreflight, 'EXECUTE_SLICE', 'slice-01'), 'SAME_OPERATION_RECOVERY');
  const context = await createManagedSliceContext({ officialPreflight, workspace, snapshot: ROOT,
    adapterPath: path.join(ROOT, 'agents/codex/runtime/validation-runner.mjs'),
    bridgePath: path.join(ROOT, 'agents/codex/runtime/managed-runner-bridge.mjs'),
    preflightPath: path.join(ROOT, 'agents/codex/runtime/managed-slice-preflight.mjs') });
  const environment = managedEnvironment({ ...process.env, TMPDIR: tmpdir }, context);
  const historicalResponse = JSON.parse(await fs.readFile(path.join(HISTORY, 'tmp/006-execute_slice-slice-01-attempt-1.response.json'), 'utf8'));
  let turns = 0;
  const broker = await startOfficialRunnerBroker({ workspace, tmpdir, operation: 'EXECUTE_SLICE',
    sequence: 8, slice: 'slice-01', officialPreflight,
    invoke: (request) => invokeIndependentRunner({ ...request, snapshot: ROOT, env: environment,
      runTurn: async ({ eventsPath, operationId, prompt }) => {
        turns += 1;
        assert.match(prompt, /RUNNER_DISPATCH_MODE=SAME_OPERATION_RECOVERY/u);
        const events = [{ operationId, type: 'thread.started', thread_id: 'offline-provider' },
          { operationId, type: 'turn.started' }];
        historicalResponse.commands.forEach(({ command }, index) => {
          events.push({ operationId, type: 'item.started', item: { id: `item_${index}`, type: 'command_execution', command } });
          events.push({ operationId, type: 'item.completed', item: { id: `item_${index}`, type: 'command_execution', command,
            status: 'completed', exit_code: 0 } });
        });
        events.push({ operationId, type: 'item.completed', item: { id: 'semantic', type: 'agent_message',
          text: JSON.stringify(historicalResponse) } });
        events.push({ operationId, type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
        await fs.writeFile(eventsPath, `${events.map(JSON.stringify).join('\n')}\n`);
        return { completed: true, turnStarted: true, threadId: 'offline-provider', requestedModel: 'gpt-5.6-luna',
          requestedEffort: 'medium', reportedModel: null, error: null, usage: { input_tokens: 1, output_tokens: 1 } };
      } }) });
  try {
    const base = { activeFindings: [], corrections: [], relevantEvidence: 'Case A implementation is present.',
      requestedChecks: 'Check CLI list filters and read-only behavior.' };
    await assert.rejects(runManagedRunnerBridge({ environment, cwd: workspace,
      payload: JSON.stringify({ ...base, automaticRound: '1/3', changedAreas: [CLAIM] }) }), /automaticRound/u);
    assert.equal(turns, 0);
    assert.equal(broker.requestsHandled, 0);
    await assert.rejects(runManagedRunnerBridge({ environment, cwd: workspace,
      payload: JSON.stringify({ ...base, automaticCheckRound: '1/3', changedScope: [CLAIM] }) }), /changedScope/u);
    assert.equal(turns, 0);
    assert.equal(broker.requestsHandled, 0);
    await assert.rejects(runManagedRunnerBridge({ environment, cwd: workspace,
      payload: JSON.stringify({ ...base, automaticCheckRound: '1/3', changedAreas: ['src/cli.mjs'] }) }),
    /canonical task-relative|match the task/u);
    assert.equal(turns, 0);
    const receipt = await runManagedRunnerBridge({ environment, cwd: workspace,
      payload: JSON.stringify({ ...base, automaticCheckRound: '1/3', changedAreas: [CLAIM] }) });
    assert.equal(turns, 1);
    assert.equal(receipt.status, 'RUNNER_RESPONSE_CAPTURED');
    assert.equal(receipt.semanticResponseStatus, 'TESTS_PASS');
    assert.deepEqual(receipt.testedState.entries.map(({ path }) => path), [CLAIM]);
    assert.equal(receipt.captureFailure, null);
    const receiptFile = path.join(tmpdir, '008-execute_slice-slice-01-attempt-1.receipt.json');
    const copy = await prepareExecutionCopy({ specPath, slice: 'slice-01' });
    const producer = path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs');
    const { spawnSync } = await import('node:child_process');
    const produced = spawnSync(process.execPath, [producer, '--execution-bundle', '--operation', 'EXECUTE_SLICE',
      '--workspace', workspace, '--task-artifact', copy.candidateTaskArtifact,
      '--semantic-response-file', receipt.semanticResponseFile, '--receipt-file', receiptFile, '--insert-candidate'],
    { env: environment, encoding: 'utf8' });
    assert.equal(produced.status, 0, produced.stderr);
    const candidate = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
    assert.match(candidate, /### implementation-check-01/u);
    assert.match(candidate, /- State: resolved/u);
    assert.match(candidate, /- Resolution: implementation-check-01 returned a valid runner result/u);
    assert.match(candidate, new RegExp(`sha256:${createHash('sha256').update(await fs.readFile(path.join(workspace, 'src/cli.mjs'))).digest('hex')}`));
    assert.equal((await validateExecutionCandidate(specPath, copy.candidateExecutionRoot)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
    assert.equal((await publishExecutionCopy({ specPath, slice: 'slice-01', candidateRoot: copy.candidateRoot })).state,
      'IMPLEMENTED_AWAITING_VALIDATION');
    const readback = await inspectExecutionState(specPath);
    assert.equal(readback.state, 'IMPLEMENTED_AWAITING_VALIDATION');
    assert.equal(readback.mandatoryRecovery, null);
    assert.throws(() => runnerDispatchMode({ ...officialPreflight, mandatoryRecovery: {
      ...officialPreflight.mandatoryRecovery, slice: 'slice-02' } }, 'EXECUTE_SLICE', 'slice-01'), /mandatoryRecovery/u);
    assert.throws(() => runnerDispatchMode(officialPreflight, 'EXECUTE_SLICE', 'slice-02'), /authorize/u);
    await assert.rejects(runManagedRunnerBridge({ environment, cwd: workspace,
      payload: JSON.stringify({ ...base, automaticCheckRound: '1/3', changedAreas: [CLAIM] }) }), /stale|not legal/u);
    assert.equal(turns, 1);
  } finally { await broker.close(); }
});
