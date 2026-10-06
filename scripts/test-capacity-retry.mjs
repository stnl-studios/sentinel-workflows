import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCodexTurn } from '../agents/codex/runtime/sdk-transport.mjs';
import { captureCapacityInputs, capacityTraceIsSafe, modelAtCapacity, operationBudgetHistory,
  runCapacityLimitedTurn } from '../benchmarks/sentinel-todo/runtime/capacity-retry.mjs';
import { admitOperation, initializeTurnBudget, startReservedTurn, settleTurn, budgetSnapshot,
  runCase } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
import { currentFunctionalIdentity } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';
import { budgetViolation } from '../benchmarks/sentinel-todo/runtime/benchmark.mjs';

const message = 'Selected model is at capacity. Please try a different model.';
const command = '/bin/zsh -lc \'node "$STNL_MANAGED_PREFLIGHT"\'';
function trace(attempt, variant, failed) {
  const events = [{ type: 'thread.started', thread_id: `fixture-thread-${attempt}` }, { type: 'turn.started' }];
  if (variant === 'missing-start') events.splice(0, 2);
  if (['preflight', 'pending', 'command'].includes(variant)) {
    const item = { id: 'preflight', type: 'command_execution', command: variant === 'command' ? 'node arbitrary.mjs' : command };
    events.push({ type: 'item.started', item: { ...item, status: 'in_progress' } });
    if (variant !== 'pending') events.push({ type: 'item.completed', item: { ...item, status: 'completed', exit_code: 0 } });
  }
  if (variant === 'file-change') events.push({ type: 'item.completed', item: { id: 'write', type: 'file_change', changes: [] } });
  if (failed) {
    const error = variant === 'generic' ? 'network failure' : message;
    events.push({ type: 'error', message: error }, { type: 'turn.failed', error: { message: error } });
  } else events.push({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
  return events;
}

for (const [variant, expectedTurns, stopReason] of [
  ['success', 2, null], ['preflight', 2, null], ['limit', 2, 'RETRY_LIMIT'],
  ['effect', 1, 'INPUTS_CHANGED_OR_UNPROVEN'], ['file-change', 1, 'EFFECTS_OR_AMBIGUITY'],
  ['command', 1, 'EFFECTS_OR_AMBIGUITY'], ['pending', 1, 'EFFECTS_OR_AMBIGUITY'],
  ['missing-start', 1, 'EFFECTS_OR_AMBIGUITY'], ['generic', 1, null], ['process-error', 1, null],
  ['budget', 1, 'TURN_BUDGET'], ['operation-budget', 1, 'OPERATION_BUDGET'],
  ['change-during-wait', 1, 'INPUTS_CHANGED_OR_UNPROVEN'], ['budget-during-wait', 1, 'TURN_BUDGET'],
  ['cancel', 1, 'CANCELLED'], ['broker', 1, 'EFFECTS_OR_AMBIGUITY'],
]) test(`capacity: ${variant}, actual offline SDK and conserved ledger`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-capacity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), candidates = path.join(root, 'candidates');
  await fs.mkdir(workspace); await fs.mkdir(candidates);
  await fs.mkdir(path.join(root, '.agents/skills'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'source.mjs'), 'original\n');
  const inputs = await captureCapacityInputs(workspace, candidates);
  const executable = path.join(root, 'provider.mjs');
  // This tiny process emits the pinned SDK's normal JSONL boundary. It never
  // loads production auth or invokes a provider/network.
  await fs.writeFile(executable, '#!' + process.execPath + '\n'
    + 'import fs from "node:fs";\n'
    + 'fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(process.argv.slice(2))+"\\n");\n'
    + 'if(process.env.FIXTURE_EFFECT) fs.appendFileSync(process.env.FIXTURE_EFFECT,"changed\\n");\n'
    + 'for(const event of JSON.parse(process.env.FIXTURE_EVENTS)) process.stdout.write(JSON.stringify(event)+"\\n");\n'
    + 'process.exit(Number(process.env.FIXTURE_EXIT));\n', { mode: 0o700 });
  const limit = variant === 'budget' ? 1 : 5;
  await initializeTurnBudget(root, limit);
  const signal = new AbortController();
  let turnNumber, waits = 0, dispatched = 0;
  const persisted = [], eventsPath = path.join(root, 'events.jsonl');
  const reserve = async () => {
    const admission = await admitOperation({ runRoot: root, runId: 'fixture-capacity', caseId: 'A',
      operation: 'EXECUTE_SLICE', runnerRequired: false, limit });
    turnNumber = await startReservedTurn(root, admission.main, limit);
  };
  await reserve();
  const result = await runCapacityLimitedTurn({ signal: signal.signal,
    runTurn: async attempt => {
      dispatched += 1;
      if (attempt === 2) assert.ok(persisted.some(record => record.attempt === 1 && record.turn.error === message));
      const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: root,
        FIXTURE_CALLS: path.join(root, 'calls.jsonl'), FIXTURE_EXIT: variant === 'process-error' ? '2' : '0',
        FIXTURE_EVENTS: JSON.stringify(trace(attempt, variant, attempt === 1 || variant === 'limit')) };
      if (variant === 'effect') env.FIXTURE_EFFECT = path.join(workspace, 'source.mjs');
      return runCodexTurn({ env, cwd: workspace, prompt: 'Offline capacity fixture.', model: 'gpt-6-luna', effort: 'high',
        eventsPath, operationId: `fixture-${attempt}`, codexPathOverride: executable });
    },
    onAttempt: async (turn, attempt) => {
      await settleTurn(root, turnNumber, turn, limit);
      return { attempt, ledgerTurn: turnNumber, turn };
    },
    persistAttempt: async record => {
      await fs.writeFile(path.join(root, `attempt-${record.attempt}.json`), JSON.stringify(record));
      persisted.push(structuredClone(record));
    },
    authorizeRetry: async (turn, attempt) => {
      const events = (await fs.readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      if (!capacityTraceIsSafe(turn, events, `fixture-${attempt}`, true) || variant === 'broker')
        return { allowed: false, reason: 'EFFECTS_OR_AMBIGUITY' };
      const fresh = await captureCapacityInputs(workspace, candidates);
      if (fresh.sha256 !== inputs.sha256) return { allowed: false, reason: 'INPUTS_CHANGED_OR_UNPROVEN' };
      const budgets = { maxReviewPlanEvents: 5, maxReviewTasksEvents: 5, maxReplans: 5,
        maxExecuteSliceAttemptsPerSlice: variant === 'operation-budget' ? 1 : 3, maxApplyFindingsPerSlice: 3, maxWorkflowEvents: 20 };
      if (budgetViolation(Array.from({ length: attempt + 1 }, () => ({ operation: 'EXECUTE_SLICE', slice: 'slice-01' })), budgets))
        return { allowed: false, reason: 'OPERATION_BUDGET' };
      if ((await budgetSnapshot(root)).turnBudget.remaining < 1) return { allowed: false, reason: 'TURN_BUDGET' };
      return { allowed: true, reason: 'NO_EFFECTS_PROVEN' };
    },
    beforeRetry: reserve,
    wait: async () => {
      waits += 1;
      if (variant === 'change-during-wait') await fs.appendFile(path.join(workspace, 'source.mjs'), 'late change\n');
      if (variant === 'budget-during-wait') for (let i = 0; i < 4; i++) {
        await reserve(); await settleTurn(root, turnNumber, { completed: true, turnStarted: true, threadId: `peer-${i}` }, limit);
      }
      if (variant === 'cancel') { signal.abort(); throw new Error('fixture cancellation'); }
    },
  });
  assert.equal(dispatched, expectedTurns); assert.equal(result.stopReason, stopReason);
  assert.equal(waits, expectedTurns === 2 || ['change-during-wait', 'budget-during-wait', 'cancel'].includes(variant) ? 1 : 0);
  const ledger = JSON.parse(await fs.readFile(path.join(root, '.turn-ledger.json')));
  assert.equal(ledger.total, variant === 'budget-during-wait' ? 5 : expectedTurns);
  assert.equal(ledger.reservations.length, 0);
  assert.ok(ledger.turns.every(turn => ['completed', 'failed'].includes(turn.state)));
  const calls = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, expectedTurns);
  assert.ok(calls.every(args => args[args.indexOf('--model') + 1] === 'gpt-6-luna'));
  assert.ok(calls.every(args => args.some(arg => arg.includes('model_reasoning_effort="high"'))));
  if (expectedTurns === 2) assert.equal(ledger.turns[0].state, 'failed', 'capacity dispatch must not be refunded');
  assert.equal(result.turn.completed, ['success', 'preflight'].includes(variant));
});

test('capacity requires exact provider diagnostic; literal agent text is not a capacity signal', () => {
  const turn = { completed: false, error: message, processError: null, errorEvent: { type: 'error', message } };
  assert.equal(modelAtCapacity(turn), true);
  for (const change of [{ completed: true }, { error: 'capacity' }, { errorEvent: null },
    { processError: 'uncertain process' }, { errorEvent: { type: 'item.completed', message } }])
    assert.equal(modelAtCapacity({ ...turn, ...change }), false);
});

test('input proof covers Git, candidates, modes and additions; links are never evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-capacity-inputs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), candidates = path.join(root, 'candidates');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true }); await fs.mkdir(candidates);
  await fs.writeFile(path.join(workspace, '.git/HEAD'), 'original');
  const initial = await captureCapacityInputs(workspace, candidates);
  await fs.writeFile(path.join(workspace, '.git/HEAD'), 'changed');
  assert.notDeepEqual(await captureCapacityInputs(workspace, candidates), initial);
  await fs.writeFile(path.join(workspace, '.git/HEAD'), 'original');
  await fs.writeFile(path.join(candidates, 'new'), 'candidate');
  assert.notDeepEqual(await captureCapacityInputs(workspace, candidates), initial);
  await fs.rm(path.join(candidates, 'new')); await fs.chmod(candidates, 0o700);
  assert.notDeepEqual(await captureCapacityInputs(workspace, candidates), initial);
  await fs.symlink(path.join(workspace, '.git/HEAD'), path.join(candidates, 'link'));
  assert.equal((await captureCapacityInputs(workspace, candidates)).rejected, true);
});

test('capacity dispatch attempts remain in later workflow budgets; atomic admission handles a race', async t => {
  assert.equal(operationBudgetHistory([{ operation: 'EXECUTE_SLICE', dispatchAttempts: 2 }, { operation: 'VALIDATE_SLICE' }]).length, 3);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-capacity-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeTurnBudget(root, 1);
  const turn = { completed: false, error: message, errorEvent: { type: 'error', message } };
  let dispatches = 0, wait = 0;
  const result = await runCapacityLimitedTurn({ signal: new AbortController().signal,
    runTurn: async () => { dispatches += 1; return turn; }, onAttempt: async turn => ({ turn }), persistAttempt: async () => {},
    authorizeRetry: async () => ({ allowed: true }),
    wait: async () => { wait += 1; const peer = await admitOperation({ runRoot: root, runId: 'peer', caseId: 'B', operation: 'PLAN', runnerRequired: false, limit: 1 });
      const number = await startReservedTurn(root, peer.main, 1); await settleTurn(root, number, { completed: true, turnStarted: true }, 1); },
    beforeRetry: () => admitOperation({ runRoot: root, runId: 'retry', caseId: 'A', operation: 'PLAN', runnerRequired: false, limit: 1 }),
  });
  assert.equal(dispatches, 1); assert.equal(wait, 1); assert.equal(result.stopReason, 'TURN_BUDGET');
  assert.equal((await budgetSnapshot(root)).turnBudget.consumed, 1);
});

for (const variant of ['success', 'limit', 'effect', 'budget', 'dispatch-throw', 'persist-throw']) test(`manager integration: ${variant}, evidence and accounting`, async t => {
  const repository = path.resolve(import.meta.dirname, '..');
  const runRoot = path.join(repository, 'benchmark-temp', `run-capacity-manager-${randomUUID()}`);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-capacity-manager-home-'));
  await fs.mkdir(runRoot);
  t.after(async () => { await fs.rm(runRoot, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true }); });
  await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  const relative = 'templates/prompts/spec-init.md';
  await fs.mkdir(path.join(runRoot, 'snapshot/templates/prompts'), { recursive: true });
  const bytes = await fs.readFile(path.join(repository, relative));
  await fs.writeFile(path.join(runRoot, 'snapshot', relative), bytes);
  const digest = createHash('sha256').update('sentinel-functional-snapshot-v1\0')
    .update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes).digest('hex');
  const metadata = { baseSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim(),
    sourceFunctionalSha256: (await currentFunctionalIdentity()).sha256, snapshotSha256: `sha256:${digest}`, snapshotFileCount: 1 };
  await fs.writeFile(path.join(runRoot, 'snapshot.json'), JSON.stringify(metadata));
  const configuration = JSON.parse(await fs.readFile(path.join(repository, 'benchmarks/sentinel-todo/benchmark.json')));
  if (variant === 'budget') configuration.turnBudget.maxTurnsPerRun = 1;
  await initializeTurnBudget(runRoot, configuration.turnBudget.maxTurnsPerRun);
  await fs.mkdir(path.join(home, '.agents/skills'), { recursive: true });
  const executable = path.join(home, 'provider.mjs');
  await fs.writeFile(executable, '#!' + process.execPath + '\n'
    + 'import fs from "node:fs";\n'
    + 'if(process.env.FIXTURE_EFFECT) fs.appendFileSync(process.env.FIXTURE_EFFECT,"effect\\n");\n'
    + 'for(const event of JSON.parse(process.env.FIXTURE_EVENTS)) process.stdout.write(JSON.stringify(event)+"\\n");\n', { mode: 0o700 });
  let calls = 0;
  const product = {
    ZERO_USAGE: {}, createUsageNormalizer: () => ({ observe: observation => ({ ...observation,
      source: 'main', status: variant === 'persist-throw' && observation.usage ? 'attributable' : 'unavailable',
      ...(variant === 'persist-throw' && observation.usage ? { delta: { input: 10, output: 1, cachedInput: 0, cacheWrite: 0, reasoningOutput: 0 } } : {}) }) }),
    prepareIsolatedHome: async () => ({ privateHome: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home } }),
    verifyIsolatedHome: async () => ({ provider: 'OFFLINE_TEST_ONLY' }), managedDiscoveryInstructions: () => 'Offline fixture only.',
    validateWorkspace: () => ({ status: 'ready', closed: false }), inspectExecutionState: async () => ({ state: 'EMPTY' }),
    runCodexTurn: async input => {
      calls += 1;
      if (variant === 'dispatch-throw' && calls === 2) throw new Error('TEST-ONLY second dispatch failure');
      assert.equal(input.model, configuration.productionProfile.cases.A.SPEC.model.toLowerCase());
      assert.equal(input.effort, configuration.productionProfile.cases.A.SPEC.effort);
      const env = { ...input.env, FIXTURE_EVENTS: JSON.stringify(trace(calls, 'success', calls === 1 || variant === 'limit')) };
      if (variant === 'effect') env.FIXTURE_EFFECT = path.join(input.cwd, 'requirements.md');
      if (calls === 2 && variant === 'success') await fs.mkdir(path.join(input.cwd, 'specs/benchmark-case-a'), { recursive: true });
      return runCodexTurn({ ...input, env, codexPathOverride: executable });
    },
    removeIsolatedHome: async () => {}, suspendIsolatedHome: async () => ({ privateHome: home }),
  };
  const rename = fs.rename;
  if (variant === 'persist-throw') fs.rename = async (from, to) => {
    if (to === path.join(runRoot, 'case-a/01-spec_init.capacity-attempt-2.json'))
      throw Object.assign(new Error('TEST-ONLY second attempt persistence failure'), { code: 'EIO' });
    return rename(from, to);
  };
  let result;
  try {
    result = await runCase({ runRoot, caseId: 'A', configuration, snapshotMetadata: metadata,
      maxOperations: variant === 'success' ? 1 : null, mode: variant === 'success' ? 'focal' : 'case',
      product, signal: new AbortController().signal });
  } finally { fs.rename = rename; }
  const state = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/case-state.json')));
  const evidence = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/01-spec_init.json')));
  assert.equal(calls, ['success', 'limit', 'dispatch-throw', 'persist-throw'].includes(variant) ? 2 : 1);
  assert.equal(state.mainTurns, calls); assert.equal(state.runnerTurns, 0);
  assert.equal((await budgetSnapshot(runRoot)).turnBudget.consumed, calls);
  assert.equal(evidence.capacityRetry.attempts.length, calls);
  const first = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/01-spec_init.capacity-attempt-1.json')));
  assert.equal(first.turn.error, message); assert.equal(first.ledgerTurn, 1);
  if (variant === 'success') {
    assert.equal(result.status, 'FOCAL_STOP'); assert.equal(state.operations[0].outcome.result, 'PASS');
    assert.equal(state.operations[0].dispatchAttempts, 2);
    assert.equal(evidence.capacityRetry.stopReason, null);
  } else if (['dispatch-throw', 'persist-throw'].includes(variant)) {
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.terminal.blocker, 'DRIVER_FAILURE');
    assert.equal(state.operations[0].dispatchAttempts, 2);
    assert.equal(operationBudgetHistory(state.operations).length, 2);
    assert.equal(evidence.capacityRetry.stopReason, 'EXCEPTION');
    assert.equal(evidence.capacityRetry.attempts[0].turn.error, message);
    assert.equal(evidence.capacityRetry.attempts[0].ledgerTurn, first.ledgerTurn);
    assert.equal(evidence.capacityRetry.attempts[1].ledgerTurn, 2);
    assert.equal(evidence.normalizedUsage, null, 'the first unavailable usage must not disappear after an exception');
    if (variant === 'persist-throw') {
      assert.equal(evidence.capacityRetry.attempts[1].turn.completed, true);
      assert.equal(evidence.capacityRetry.attempts[1].usageObservation.status, 'attributable');
      assert.equal(evidence.capacityRetry.attempts[1].usageObservation.delta.input, 10);
    } else assert.equal(evidence.capacityRetry.attempts[1].usageObservation.status, 'unavailable');
  } else {
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.terminal.blocker, 'SDK_MODEL_AT_CAPACITY');
    assert.equal(evidence.capacityRetry.stopReason, { limit: 'RETRY_LIMIT', effect: 'INPUTS_CHANGED_OR_UNPROVEN', budget: 'TURN_BUDGET' }[variant]);
  }
});
