import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runCodexTurn } from '../agents/codex/runtime/sdk-transport.mjs';
import { isolatedEnvironment } from '../agents/codex/runtime/isolated-home.mjs';
import { captureCapacityInputs, captureCapacitySkillRead, capacityTraceDecision, capacityTraceIsSafe,
  transportDiagnosticEvidence, modelAtCapacity, operationBudgetHistory,
  runCapacityLimitedTurn } from '../benchmarks/sentinel-todo/runtime/capacity-retry.mjs';
import { admitOperation, initializeTurnBudget, startReservedTurn, settleTurn, budgetSnapshot,
  runCase } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
import { currentFunctionalIdentity } from '../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs';
import { budgetViolation } from '../benchmarks/sentinel-todo/runtime/benchmark.mjs';

const message = 'Selected model is at capacity. Please try a different model.';
const command = '/bin/zsh -lc \'node "$STNL_MANAGED_PREFLIGHT"\'';
function trace(attempt, variant, failed, skillRead = null) {
  const events = [{ type: 'thread.started', thread_id: `fixture-thread-${attempt}` }, { type: 'turn.started' }];
  if (variant === 'missing-start') events.splice(0, 2);
  if (['preflight', 'pending', 'command'].includes(variant) || variant.startsWith('skill-')) {
    const item = { id: 'preflight', type: 'command_execution', command: variant === 'command' ? 'node arbitrary.mjs' : command };
    events.push({ type: 'item.started', item: { ...item, status: 'in_progress' } });
    if (variant !== 'pending') events.push({ type: 'item.completed', item: { ...item, status: 'completed', exit_code: 0 } });
  }
  if (variant.startsWith('skill-')) {
    const item = { id: 'skill-read', type: 'command_execution', command: variant === 'skill-unqualified'
      ? `/bin/zsh -lc 'cat "${skillRead.path}"'` : skillRead.command };
    if (variant === 'skill-write') item.command += '; touch unexpected';
    events.push({ type: 'item.started', item: { ...item, status: 'in_progress' } },
      { type: 'item.completed', item: { ...item, status: 'completed', exit_code: 0,
        aggregated_output: variant === 'skill-output' ? 'unexpected output' : skillRead.output } });
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
  ['missing-start', 1, 'EFFECTS_OR_AMBIGUITY'], ['generic', 1, null], ['process-error', 1, 'PROCESS_FAILURE_UNPROVEN'],
  ['capacity-exit', 2, null], ['capacity-exit-limit', 2, 'RETRY_LIMIT'],
  ['skill-read', 2, null], ['skill-unqualified', 1, 'SKILL_READ_COMMAND_UNPROVEN'],
  ['skill-write', 1, 'EFFECTS_OR_AMBIGUITY'], ['skill-output', 1, 'EFFECTS_OR_AMBIGUITY'],
  ['skill-mutated', 1, 'SKILL_READ_AUTHORITY_UNPROVEN'],
  ['budget', 1, 'TURN_BUDGET'], ['operation-budget', 1, 'OPERATION_BUDGET'],
  ['change-during-wait', 1, 'INPUTS_CHANGED_OR_UNPROVEN'], ['budget-during-wait', 1, 'TURN_BUDGET'],
  ['cancel', 1, 'CANCELLED'], ['broker', 1, 'EFFECTS_OR_AMBIGUITY'],
]) test(`capacity: ${variant}, actual offline SDK and conserved ledger`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-capacity-')));
  const skillDirectory = path.join(root, '.agents/skills/stnl-slice-executor');
  t.after(async () => {
    for (const directory of [path.dirname(skillDirectory), skillDirectory]) await fs.chmod(directory, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace'), candidates = path.join(root, 'candidates');
  await fs.mkdir(workspace); await fs.mkdir(candidates);
  await fs.mkdir(path.join(root, '.agents/skills'), { recursive: true });
  let skillRead = null;
  const skillOptions = { snapshot: path.join(root, 'snapshot'), shellHome: root, workflowSkill: 'stnl-slice-executor' };
  if (variant.startsWith('skill-')) {
    await fs.mkdir(skillDirectory);
    const sourceDirectory = path.join(root, 'snapshot/skills/workflows/stnl-slice-executor');
    await fs.mkdir(sourceDirectory, { recursive: true });
    for (const directory of [skillDirectory, sourceDirectory]) await fs.writeFile(path.join(directory, 'SKILL.md'), 'Frozen executor skill.\n');
    await fs.chmod(path.join(skillDirectory, 'SKILL.md'), 0o444);
    await fs.chmod(skillDirectory, 0o555); await fs.chmod(path.dirname(skillDirectory), 0o555);
    skillRead = await captureCapacitySkillRead(skillOptions);
    assert.ok(skillRead);
  }
  await fs.writeFile(path.join(workspace, 'source.mjs'), 'original\n');
  const inputs = await captureCapacityInputs(workspace, candidates);
  const executable = path.join(root, 'provider.mjs');
  // This tiny process emits the pinned SDK's normal JSONL boundary. It never
  // loads production auth or invokes a provider/network.
  await fs.writeFile(executable, '#!' + process.execPath + '\n'
    + 'import fs from "node:fs";\n'
    + 'fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(process.argv.slice(2))+"\\n");\n'
    + 'if(process.env.FIXTURE_EFFECT) fs.appendFileSync(process.env.FIXTURE_EFFECT,"changed\\n");\n'
    + 'if(process.env.FIXTURE_SKILL_EFFECT) {fs.chmodSync(process.env.FIXTURE_SKILL_EFFECT,0o644); fs.appendFileSync(process.env.FIXTURE_SKILL_EFFECT,"changed\\n");}\n'
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
        FIXTURE_CALLS: path.join(root, 'calls.jsonl'), FIXTURE_EXIT: variant === 'process-error' ? '2'
          : variant === 'capacity-exit-limit' || ((variant === 'capacity-exit' || variant.startsWith('skill-')) && attempt === 1) ? '1' : '0',
        FIXTURE_EVENTS: JSON.stringify(trace(attempt, variant, attempt === 1 || ['limit', 'capacity-exit-limit'].includes(variant), skillRead)) };
      if (variant === 'effect') env.FIXTURE_EFFECT = path.join(workspace, 'source.mjs');
      if (variant === 'skill-mutated') env.FIXTURE_SKILL_EFFECT = skillRead.path;
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
      const decision = capacityTraceDecision(turn, events, `fixture-${attempt}`, true, skillRead);
      if (!decision.allowed) return decision;
      if (variant === 'broker') return { allowed: false, reason: 'EFFECTS_OR_AMBIGUITY' };
      if (decision.skillRead && JSON.stringify(await captureCapacitySkillRead(skillOptions)) !== JSON.stringify(skillRead))
        return { allowed: false, reason: 'SKILL_READ_AUTHORITY_UNPROVEN' };
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
  assert.equal(result.turn.completed, ['success', 'preflight', 'capacity-exit', 'skill-read'].includes(variant));
  if (variant.startsWith('capacity-exit')) {
    assert.equal(result.attempts[0].turn.errorEvent.type, 'error');
    assert.match(result.attempts[0].turn.processError, /Codex Exec exited with code 1/u);
    assert.deepEqual(result.attempts[0].turn.processFailure, { kind: 'sdk_exit', exitCode: 1, stderrClass: 'empty' });
  }
});

for (const [variant, callsExpected, reason] of [
  ['safe-read', 2, 'RETRY_LIMIT'], ['observed-cat', 1, 'SKILL_READ_COMMAND_UNPROVEN'],
  ['authority-change', 1, 'AUTHORITY_CHANGED'], ['workspace-change', 1, 'INPUTS_CHANGED_OR_UNPROVEN'],
  ['pending-broker', 1, 'EFFECTS_OR_AMBIGUITY'], ['budget', 1, 'TURN_BUDGET'],
]) test(`managed capacity integration: ${variant}`, async t => {
  const repository = path.resolve(import.meta.dirname, '..');
  const runRoot = path.join(repository, 'benchmark-temp', `run-capacity-managed-${randomUUID()}`);
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-capacity-managed-home-')));
  const installed = path.join(home, '.agents/skills/stnl-slice-executor');
  t.after(async () => {
    for (const directory of [path.dirname(installed), installed]) await fs.chmod(directory, 0o755).catch(() => {});
    await fs.rm(runRoot, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true });
  });
  const caseRoot = path.join(runRoot, 'case-a'), snapshot = path.join(runRoot, 'snapshot');
  await fs.mkdir(runRoot); await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  const workspace = path.join(caseRoot, 'workspace'), candidates = path.join(caseRoot, 'candidates');
  for (const directory of [workspace, candidates, path.join(caseRoot, 'tmp'), path.join(caseRoot, 'prompts'), installed])
    await fs.mkdir(directory, { recursive: true });
  const files = ['agents/codex/runtime/offline-provider-context.mjs', 'agents/codex/runtime/sdk-transport.mjs',
    'skills/workflows/stnl-slice-executor/SKILL.md',
    'templates/prompts/slice-execute-codex.md'];
  for (const relative of files) {
    const bytes = await fs.readFile(path.join(repository, relative));
    await fs.mkdir(path.dirname(path.join(snapshot, relative)), { recursive: true });
    await fs.writeFile(path.join(snapshot, relative), bytes, { mode: 0o444 });
    if (relative.endsWith('SKILL.md')) await fs.writeFile(path.join(installed, 'SKILL.md'), bytes, { mode: 0o444 });
  }
  await fs.cp(path.join(repository, 'agents/codex/node_modules/@openai/codex-sdk'),
    path.join(snapshot, 'agents/codex/node_modules/@openai/codex-sdk'), { recursive: true });
  const sdkRoot = 'agents/codex/node_modules/@openai/codex-sdk';
  for (const entry of await fs.readdir(path.join(snapshot, sdkRoot), { recursive: true })) {
    const relative = path.join(sdkRoot, entry), file = path.join(snapshot, relative);
    if ((await fs.lstat(file)).isFile()) { files.push(relative); await fs.chmod(file, 0o444); }
  }
  const digest = createHash('sha256').update('sentinel-functional-snapshot-v1\0');
  for (const relative of [...files].sort()) {
    const bytes = await fs.readFile(path.join(snapshot, relative));
    digest.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  const { managedDiscoveryInstructions: frozenDiscovery } = await import(pathToFileURL(path.join(snapshot,
    'agents/codex/runtime/sdk-transport.mjs')).href);
  await fs.chmod(installed, 0o555); await fs.chmod(path.dirname(installed), 0o555);
  const configuration = JSON.parse(await fs.readFile(path.join(repository, 'benchmarks/sentinel-todo/benchmark.json')));
  const priorStages = [['SPEC_INIT', 'SPEC', 'SPEC_READY'], ['PLAN', 'PLAN', 'PLANNED_DRAFT'],
    ['REVIEW_PLAN', 'REVIEW_VALIDATE', 'PLANNED_READY'], ['MATERIALIZE_TASKS', 'TASKS', 'MATERIALIZED_PRISTINE'],
    ['REVIEW_TASKS', 'REVIEW_VALIDATE', 'MATERIALIZED_PRISTINE']];
  if (variant === 'budget') configuration.turnBudget.maxTurnsPerRun = priorStages.length + 2;
  const metadata = { baseSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim(),
    sourceFunctionalSha256: (await currentFunctionalIdentity()).sha256, snapshotSha256: `sha256:${digest.digest('hex')}`, snapshotFileCount: files.length };
  await fs.writeFile(path.join(runRoot, 'snapshot.json'), JSON.stringify(metadata));
  await initializeTurnBudget(runRoot, configuration.turnBudget.maxTurnsPerRun);
  const specPath = path.join(workspace, ...configuration.cases.find(item => item.id === 'A').specPath.split('/'));
  await fs.mkdir(specPath, { recursive: true });
  const journal = path.join(caseRoot, 'journal.json');
  const initialized = spawnSync(process.execPath, [path.join(repository, 'benchmarks/sentinel-todo/runtime/benchmark.mjs'), 'journal-init',
    '--output', journal, '--case', 'A', '--sentinel-sha', metadata.baseSha, '--run-mode', 'focal', '--production-profile', configuration.productionProfile.id], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const execution = { state: 'MATERIALIZED_PRISTINE', currentFingerprint: 'a'.repeat(64),
    legalOperations: [{ operation: 'EXECUTE_SLICE', slice: 'slice-01' }], normalHandoff: { operation: 'EXECUTE_SLICE', slice: 'slice-01' } };
  const priorOperations = [], journalData = JSON.parse(await fs.readFile(journal));
  for (const [index, [operation, phase, resultingState]] of priorStages.entries()) {
    const threadId = `prior-offline-${index + 1}`, route = configuration.productionProfile.cases.A[phase];
    const prior = await admitOperation({ runRoot, runId: path.basename(runRoot), caseId: 'A', operation, runnerRequired: false,
      limit: configuration.turnBudget.maxTurnsPerRun });
    await settleTurn(runRoot, await startReservedTurn(runRoot, prior.main, configuration.turnBudget.maxTurnsPerRun),
      { completed: true, turnStarted: true, threadId }, configuration.turnBudget.maxTurnsPerRun);
    const evidencePath = path.join(caseRoot, `${String(index + 1).padStart(2, '0')}-${operation.toLowerCase()}.json`);
    await fs.writeFile(evidencePath, JSON.stringify({ sequence: index + 1, turn: { usage: null },
      officialReadback: { lifecycle: { status: 'ready' }, execution } }));
    priorOperations.push({ operation, outcome: { result: 'PASS' }, evidencePath, threadId });
    journalData.events.push({ index: index + 1, operation, phase, model: route.model, effort: route.effort,
      result: 'PASS', childDispatches: [], durationMs: 0, inputBytes: 1, outputBytes: 1, resultingState });
  }
  await fs.writeFile(journal, JSON.stringify(journalData));
  await fs.writeFile(path.join(caseRoot, 'case-state.json'), JSON.stringify({ status: 'FOCAL_STOP', terminal: { result: 'FOCAL_STOP' },
    privateHomeSuspended: true, suspendedHome: {}, workspace, specPath, journal, threads: { author: null }, mainTurns: priorStages.length,
    runnerTurns: 0, operations: priorOperations }));
  const proof = await captureCapacitySkillRead({ snapshot, shellHome: home, workflowSkill: 'stnl-slice-executor' });
  assert.ok(proof);
  const executable = path.join(home, 'provider.mjs');
  await fs.writeFile(executable, '#!' + process.execPath + '\nimport fs from "node:fs";import {spawnSync} from "node:child_process";\n'
    + 'if(process.env.FIXTURE_EFFECT)fs.writeFileSync(process.env.FIXTURE_EFFECT,"changed");\n'
    + 'const read=spawnSync("/bin/zsh",["-lc",process.env.FIXTURE_READ_COMMAND],{env:process.env,encoding:"utf8"});\n'
    + 'if(read.stderr)process.stderr.write(read.stderr);\n'
    + 'for(const event of JSON.parse(process.env.FIXTURE_EVENTS)){if(event.type==="item.completed"&&event.item?.id==="skill-read")'
    + '{event.item.aggregated_output=read.stdout;event.item.exit_code=read.status;event.item.status=read.status===0?"completed":"failed";}'
    + 'process.stdout.write(JSON.stringify(event)+"\\n");}\nprocess.exit(1);\n', { mode: 0o700 });
  let calls = 0, preflights = 0;
  const product = {
    ZERO_USAGE: {}, createUsageNormalizer: () => ({ observe: observation => ({ ...observation, status: 'unavailable', source: 'main' }) }),
    resumeIsolatedHome: async () => ({ shellHome: home, privateHome: home, env: isolatedEnvironment({ privateHome: home,
      shellHome: home, tmpdir: path.join(caseRoot, 'tmp'), snapshot, workspace, candidates }) }),
    verifyIsolatedHome: async () => ({ provider: 'OFFLINE_TEST_ONLY' }), removeIsolatedHome: async () => {},
    validateWorkspace: () => ({ status: 'ready', closed: false }), inspectExecutionState: async () => execution,
    workflowSkillForOperation: () => 'stnl-slice-executor', managedDiscoveryInstructions: frozenDiscovery,
    preflightExecutionOperation: async () => {
      preflights += 1;
      return { ...execution, currentFingerprint: variant === 'authority-change' && calls > 0 ? 'b'.repeat(64) : execution.currentFingerprint };
    },
    createManagedSliceContext: async input => ({ ...input.officialPreflight }),
    managedEnvironment: env => ({ ...env, STNL_MANAGED_PREFLIGHT: path.join(snapshot, 'agents/codex/runtime/managed-slice-preflight.mjs') }),
    startOfficialRunnerBroker: async () => ({ pending: variant === 'pending-broker', requestsHandled: 0, capturedReceipts: 0,
      errors: [], cancelledPending: false, payloadFile: path.join(home, 'payload.json'), close: async () => {} }),
    runCodexTurn: async input => {
      calls += 1;
      assert.equal(input.model, configuration.productionProfile.cases.A.EXECUTE.model.toLowerCase());
      assert.equal(input.effort, configuration.productionProfile.cases.A.EXECUTE.effort);
      // Copy the recipe from the production launcher, not from the gate's proof.
      // The offline process executes that exact read on the frozen installed file.
      const recipes = [...input.prompt.matchAll(/^```sh\n(\/bin\/cat [^\n]+)\n```$/gmu)];
      assert.equal(recipes.length, 1, 'real discovery must supply exactly one standalone skill-read recipe');
      const recipe = recipes[0][1];
      const recordedCommand = `/bin/zsh -lc '${recipe}'`;
      assert.equal(recordedCommand, proof.command, 'the real launcher recipe must match the strict retry gate');
      assert.ok(input.prompt.indexOf('Run node "$STNL_MANAGED_PREFLIGHT"') < recipes[0].index,
        'managed preflight must precede the skill-read recipe');
      const launcherRead = { ...proof, command: recordedCommand };
      const env = { ...input.env, FIXTURE_READ_COMMAND: variant === 'observed-cat' ? recipe.replace('/bin/cat', 'cat') : recipe,
        FIXTURE_EVENTS: JSON.stringify(trace(calls, variant === 'observed-cat' ? 'skill-unqualified' : 'skill-read', true, launcherRead)) };
      if (variant === 'workspace-change') env.FIXTURE_EFFECT = path.join(workspace, 'changed.txt');
      return runCodexTurn({ ...input, env, codexPathOverride: executable });
    },
  };
  const result = await runCase({ runRoot, caseId: 'A', configuration, snapshotMetadata: metadata,
    maxOperations: null, mode: 'focal', product, signal: new AbortController().signal, resume: true, capacityWait: async () => {} });
  assert.equal(result.terminal.blocker, 'SDK_MODEL_AT_CAPACITY', result.terminal.diagnostic);
  const evidence = JSON.parse(await fs.readFile(path.join(caseRoot, '06-execute_slice.json')));
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.terminal.blocker, 'SDK_MODEL_AT_CAPACITY', evidence.journal.diagnostic);
  assert.equal(calls, callsExpected); assert.equal(evidence.capacityRetry.stopReason, reason);
  assert.equal(evidence.capacityRetry.attempts.length, callsExpected);
  assert.equal(evidence.runner.turns, 0); assert.equal(evidence.runner.requestsHandled, 0);
  assert.equal((await budgetSnapshot(runRoot)).turnBudget.consumed, priorStages.length + callsExpected);
  const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
  assert.equal(ledger.reservations.length, 0);
  assert.ok(preflights >= (variant === 'authority-change' || variant === 'safe-read' ? 2 : 1));
});

test('capacity requires exact provider diagnostic; literal agent text is not a capacity signal', () => {
  const turn = { completed: false, error: message, processError: null, errorEvent: { type: 'error', message } };
  assert.equal(modelAtCapacity(turn), true);
  for (const change of [{ completed: true }, { error: 'capacity' }, { errorEvent: null },
    { errorEvent: { type: 'item.completed', message } }])
    assert.equal(modelAtCapacity({ ...turn, ...change }), false);
  assert.equal(modelAtCapacity({ ...turn, processError: 'uncertain process' }), true, 'classification does not grant retry');
  assert.equal(capacityTraceIsSafe({ ...turn, processError: 'uncertain process' }, [], 'unknown', true), false);
});

test('capacity exit proof cannot conceal an unrelated process failure or incomplete trace', () => {
  const operationId = 'exit-proof';
  const events = trace(1, 'success', true).map(event => ({ operationId, ...event }));
  const turn = { completed: false, turnStarted: true, threadId: 'fixture-thread-1', toolCalls: 0,
    error: message, errorEvent: events.find(event => event.type === 'error'),
    processError: 'Error: Codex Exec exited with code 1: ', processFailure: { kind: 'sdk_exit', exitCode: 1, stderrClass: 'empty' } };
  assert.equal(capacityTraceIsSafe(turn, events, operationId, true), true);
  for (const change of [{ processError: 'AbortError: cancelled' }, { processFailure: null },
    { processFailure: { kind: 'sdk_exit', exitCode: 2, stderrClass: 'empty' } },
    { processFailure: { kind: 'sdk_exit', exitCode: 1, stderrClass: 'unproven' } }, { processError: null }]) {
    assert.equal(capacityTraceDecision({ ...turn, ...change }, events, operationId, true).reason, 'PROCESS_FAILURE_UNPROVEN');
  }
  for (const changed of [events.slice(0, -1), [...events, { operationId, type: 'item.completed', item: { type: 'file_change' } }],
    events.map(event => event.type === 'error' ? { ...event, message: 'network failure' } : event)])
    assert.equal(capacityTraceIsSafe(turn, changed, operationId, true), false);
});

test('capacity diagnostics retain provider identity and process proof without stderr or extra event fields', () => {
  const turn = { error: message, processError: 'Error: Codex Exec exited with code 1: TEST_ONLY_SECRET',
    processFailure: { kind: 'sdk_exit', exitCode: 1, stderrClass: 'unproven' },
    errorEvent: { type: 'turn.failed', operationId: 'diagnostic', error: { message, secret: 'TEST_ONLY_SECRET' } } };
  const evidence = transportDiagnosticEvidence(turn);
  assert.equal(evidence.error, message);
  assert.deepEqual(evidence.errorEvent, { type: 'turn.failed', operationId: 'diagnostic', error: { message } });
  assert.deepEqual(evidence.processFailure, { kind: 'sdk_exit', exitCode: 1, stderrClass: 'unproven' });
  assert.ok(!JSON.stringify(evidence).includes('TEST_ONLY_SECRET'));
  assert.equal(evidence.processErrorSha256, createHash('sha256').update(turn.processError).digest('hex'));
});

test('owned skill proof rejects writable, changed, linked or unsafe files', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-capacity-skill-')));
  const directory = path.join(root, '.agents/skills/stnl-slice-executor');
  const file = path.join(directory, 'SKILL.md');
  const source = path.join(root, 'snapshot/skills/workflows/stnl-slice-executor/SKILL.md');
  t.after(async () => {
    for (const parent of [path.dirname(directory), directory]) await fs.chmod(parent, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(file, 'frozen skill\n'); await fs.writeFile(source, 'frozen skill\n');
  const options = { snapshot: path.join(root, 'snapshot'), shellHome: root, workflowSkill: 'stnl-slice-executor' };
  assert.equal(await captureCapacitySkillRead(options), null, 'writable skill has no retry authority');
  await fs.chmod(file, 0o444); await fs.chmod(directory, 0o555); await fs.chmod(path.dirname(directory), 0o555);
  assert.ok(await captureCapacitySkillRead(options));
  await fs.writeFile(path.join(root, '.zshenv'), 'arbitrary startup program\n');
  assert.equal(await captureCapacitySkillRead(options), null, 'shell startup effects are not authorized reads');
  await fs.unlink(path.join(root, '.zshenv'));
  await fs.writeFile(source, 'changed snapshot\n');
  assert.equal(await captureCapacitySkillRead(options), null);
  await fs.writeFile(source, 'frozen skill\n');
  await fs.link(file, path.join(root, 'hardlink'));
  assert.equal(await captureCapacitySkillRead(options), null);
  await fs.unlink(path.join(root, 'hardlink'));
  await fs.chmod(directory, 0o755); await fs.unlink(file); await fs.symlink(source, file);
  await fs.chmod(directory, 0o555);
  assert.equal(await captureCapacitySkillRead(options), null);
  assert.equal(await captureCapacitySkillRead({ ...options, workflowSkill: '../unauthorized' }), null);
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

for (const variant of ['success', 'limit', 'effect', 'budget', 'dispatch-throw', 'persist-throw',
  'capacity-exit', 'capacity-exit-limit', 'uncertain-exit', 'uncertain-stderr', 'generic-exit', 'truncated-process']) test(`manager integration: ${variant}, evidence and accounting`, async t => {
  const succeeds = ['success', 'capacity-exit'].includes(variant);
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
    + 'for(const event of JSON.parse(process.env.FIXTURE_EVENTS)) process.stdout.write(JSON.stringify(event)+"\\n");\n'
    + 'if(process.env.FIXTURE_TRUNCATED) process.stdout.write("{truncated\\n");\n'
    + 'if(process.env.FIXTURE_EXIT) process.stderr.write(process.env.FIXTURE_STDERR || "TEST_ONLY_SECRET_FOR_REDACTION\\n");\n'
    + 'process.exit(Number(process.env.FIXTURE_EXIT || 0));\n', { mode: 0o700 });
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
      const env = { ...input.env, FIXTURE_EVENTS: JSON.stringify(trace(calls, variant === 'generic-exit' ? 'generic' : 'success',
        calls === 1 || ['limit', 'capacity-exit-limit'].includes(variant))) };
      if (variant === 'uncertain-exit') env.FIXTURE_EXIT = '2';
      if (variant === 'capacity-exit-limit' || ['uncertain-stderr', 'generic-exit', 'truncated-process'].includes(variant)
        || variant === 'capacity-exit' && calls === 1) env.FIXTURE_EXIT = '1';
      if (['capacity-exit', 'capacity-exit-limit'].includes(variant)) env.FIXTURE_STDERR = message + '\n';
      if (variant === 'truncated-process') env.FIXTURE_TRUNCATED = '1';
      if (variant === 'effect') env.FIXTURE_EFFECT = path.join(input.cwd, 'requirements.md');
      if (calls === 2 && succeeds) await fs.mkdir(path.join(input.cwd, 'specs/benchmark-case-a'), { recursive: true });
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
      maxOperations: succeeds ? 1 : null, mode: succeeds ? 'focal' : 'case', capacityWait: async () => {},
      product, signal: new AbortController().signal });
  } finally { fs.rename = rename; }
  const state = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/case-state.json')));
  const evidence = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/01-spec_init.json')));
  assert.equal(calls, ['success', 'limit', 'dispatch-throw', 'persist-throw', 'capacity-exit', 'capacity-exit-limit'].includes(variant) ? 2 : 1);
  assert.equal(state.mainTurns, calls); assert.equal(state.runnerTurns, 0);
  assert.equal((await budgetSnapshot(runRoot)).turnBudget.consumed, calls);
  if (['capacity-exit', 'capacity-exit-limit', 'uncertain-exit', 'uncertain-stderr', 'generic-exit', 'truncated-process'].includes(variant)) {
    const serialized = JSON.stringify(evidence);
    assert.ok(!serialized.includes('TEST_ONLY_SECRET_FOR_REDACTION'), 'manager evidence must not persist SDK stderr');
    if (variant !== 'capacity-exit') assert.ok(evidence.turn.processError);
    assert.ok(evidence.turn.errorEvent || variant === 'capacity-exit', 'provider event remains explicit');
  }
  if (variant === 'generic-exit') {
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.terminal.blocker, 'SDK_TURN_FAILED');
    assert.equal(evidence.capacityRetry, undefined);
    assert.deepEqual(evidence.turn.processFailure, { kind: 'sdk_exit', exitCode: 1, stderrClass: 'unproven' });
    return;
  }
  assert.equal(evidence.capacityRetry.attempts.length, calls);
  const first = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/01-spec_init.capacity-attempt-1.json')));
  assert.equal(first.turn.error, message); assert.equal(first.ledgerTurn, 1);
  if (succeeds) {
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
    assert.equal(evidence.capacityRetry.stopReason, { limit: 'RETRY_LIMIT', 'capacity-exit-limit': 'RETRY_LIMIT',
      effect: 'INPUTS_CHANGED_OR_UNPROVEN', budget: 'TURN_BUDGET', 'uncertain-exit': 'PROCESS_FAILURE_UNPROVEN',
      'uncertain-stderr': 'PROCESS_FAILURE_UNPROVEN',
      'truncated-process': 'PROCESS_FAILURE_UNPROVEN' }[variant]);
    assert.match(evidence.outcome.diagnostic, new RegExp(evidence.capacityRetry.stopReason));
  }
  if (variant === 'capacity-exit' || variant === 'capacity-exit-limit') {
    assert.deepEqual(first.turn.processFailure, { kind: 'sdk_exit', exitCode: 1, stderrClass: 'capacity_only' });
    assert.equal(first.turn.errorEvent.message, message);
    assert.match(first.turn.processError, /stderr omitted/u);
    assert.match(first.turn.processErrorSha256, /^[a-f0-9]{64}$/u);
    assert.ok(!JSON.stringify(first).includes('TEST_ONLY_SECRET_FOR_REDACTION'));
  }
});
