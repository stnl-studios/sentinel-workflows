import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixture, approveFixture } from './test-p1b-preparation.mjs';
import { implementOffline, runFirstRemoval } from './test-p1b-publication.mjs';
import { implementedFixture, formal, revise, setSection, native, capture } from './test-p1b-continuity.mjs';
import { beginPreparedExecutionOperation, readExecutionActivation, validateExecutionCandidate } from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { prepareExecutionCopy } from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import { preparePreparationCandidate } from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import { publishPreparationCandidate } from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import { startNativeRunnerCapture, bindNativeRunnerIdentity } from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { captureRunnerTestedState, serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate } from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';

const CLI = '../../src/unpredicted.mjs';
const TEST = '../../src/greeting.test.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const corrected = 'export const greeting = "hello";\n';

// These are controlled semantic decisions. The joint producer, activation,
// native origin, actual reviewed Node check, receipt and serializer are real.
async function failedFixture(t) {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const approved = await approveFixture(f);
  const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
  const implementation = await implementOffline(f, admitted, { forceFail: true });
  assert.equal(implementation.response.status, 'TESTS_FAIL');
  assert.equal(implementation.response.commands[0].exit, 1);
  return { ...f, admitted, implementation, taskArtifact: implementation.copy.candidateTaskArtifact,
    cli: path.join(f.root, 'src/unpredicted.mjs'), cliTest: path.join(f.root, 'src/greeting.test.mjs') };
}

async function produce(f, operation, evidence) {
  return serializeRunnerExecutionBundleFromResponse({ operation, response: evidence.response,
    workspace: f.root, taskArtifact: f.taskArtifact, ...evidence.captured });
}
async function nextRound(f, operation, prior, mutate = []) {
  const start = await startNativeRunnerCapture({ specPath: f.specPath, owner: f.admitted.owner,
    workspace: f.root, captureParent: f.root, candidateTaskArtifact: f.taskArtifact });
  const agentId = `offline-tested-state-${randomUUID()}`;
  await bindNativeRunnerIdentity({ ...start, agentId });
  if (mutate.includes('cli')) await fs.writeFile(f.cli, corrected);
  if (mutate.includes('test')) await fs.appendFile(f.cliTest, '// bounded test correction\n');
  const passing = mutate.includes('cli');
  const response = { ...prior, automaticCheckRound: '2/3', status: passing ? 'TESTS_PASS' : 'TESTS_FAIL',
    commands: prior.commands.map(item => ({ ...item, exit: passing ? 0 : 1 })),
    failures: passing ? 'none' : 'Greeting still differs from the required hello value.',
    priorRoundFailure: 'Actual prepared greeting assertion exited 1.',
    correctionApplied: mutate.length ? 'Corrected the declared greeting/test files.' : 'No source correction was made; the real failure remains.',
    inSliceRationale: 'All checks and corrections stay in the approved greeting area.',
    correctionsCovered: 'Corrected the declared greeting/test files.', selectionRationale: 'Exercise the prepared greeting assertion.' };
  if (operation === 'EXECUTE_SLICE') delete response.correctionsCovered;
  else for (const key of ['priorRoundFailure', 'correctionApplied', 'inSliceRationale']) delete response[key];
  const captured = await capture({ ...start, agentId }, response, [CLI, TEST]);
  const bundle = await produce(f, operation, { response: JSON.stringify(response), captured });
  return { response, captured, bundle };
}

async function proof(t, details) {
  t.diagnostic(JSON.stringify({ externalCalls: 0, ...details }));
}

test('historical A survives mutation to B and round 2 derives only its changed module', async t => {
  const f = await failedFixture(t);
  const a = hash(await fs.readFile(f.cli)), b = hash(corrected);
  assert.notEqual(a, b);
  const originalReceipt = await fs.readFile(f.implementation.captured.receiptFile);
  assert.equal(f.implementation.capture.entries.find(e => e.path === CLI).value, `sha256:${a}`);
  const two = await nextRound(f, 'EXECUTE_SLICE', f.implementation.response, ['cli']);
  // Re-consuming the concluded first receipt cannot rewrite A from current B.
  const one = await produce(f, 'EXECUTE_SLICE', { response: JSON.stringify(f.implementation.response), captured: f.implementation.captured });
  assert.ok(one.includes('`' + CLI + '` | sha256:' + a));
  assert.ok(!one.includes('`' + CLI + '` | sha256:' + b));
  assert.match(two.bundle, /### implementation-check-02\n- Automatic check round: 2\/3\n- Status: TESTS_PASS/u);
  assert.ok(two.bundle.includes('- Correction paths: ' + CLI));
  assert.equal(two.bundle.includes('- Correction paths: ' + CLI + ', ' + TEST), false);
  assert.match(await fs.readFile(f.taskArtifact, 'utf8'), /## Corrections Applied\n\n- `\.\.\/\.\.\/src\/unpredicted\.mjs`/u);
  assert.equal(Object.hasOwn(two.response, 'correctionPaths'), false);
  assert.deepEqual(await fs.readFile(f.implementation.captured.receiptFile), originalReceipt);
  await proof(t, { a, b, firstExit: 1, secondExit: 0, correctionPaths: [CLI], firstReceiptUnchanged: true });
});

test('no mutation and multiple targets derive the exact corrections set', async t => {
  for (const mutate of [[], ['cli'], ['cli', 'test']]) {
    const f = await failedFixture(t);
    const two = await nextRound(f, 'EXECUTE_SLICE', f.implementation.response, mutate);
    const expected = mutate.length ? mutate.map(name => name === 'cli' ? CLI : TEST).sort().join(', ') : 'none';
    assert.equal(two.bundle.match(/^- Correction paths: (.+)$/mu)?.[1], expected);
    assert.equal(two.response.commands[0].exit, mutate.includes('cli') ? 0 : 1);
    await proof(t, { mutate, correctionPaths: expected, realExit: two.response.commands[0].exit });
  }
});

test('removed target is captured as REMOVED and later bytes cannot rewrite it', async t => {
  await runFirstRemoval({ afterFormal: async ({ f, after }) => {
    const claim = '../../src/obsolete.mjs';
    assert.deepEqual(after.entries.find(e => e.path === claim), { path: claim, value: 'REMOVED' });
    const task = path.join(f.workspace.executionRoot, 'tasks/slice-01.md');
    const before = await fs.readFile(task);
    assert.match(before.toString(), /`\.\.\/\.\.\/src\/obsolete\.mjs` \| REMOVED/u);
    await fs.writeFile(path.join(f.root, 'src/obsolete.mjs'), 'export const obsolete = "reappeared";\n');
    assert.equal(after.entries.find(e => e.path === claim).value, 'REMOVED');
    assert.deepEqual(await fs.readFile(task), before);
    await proof(t, { captured: after.entries, actualRemovalAndFormalCheckPassed: true, officialHistoryUnchangedAfterReappearance: true });
  } });
});

test('receipt, operation, slice, workspace and source mismatch reject captured state', async t => {
  const f = await failedFixture(t);
  const captured = f.implementation.captured;
  const original = await fs.readFile(captured.receiptFile);
  const receipt = JSON.parse(original);
  const evidence = { response: JSON.stringify(f.implementation.response), captured };
  const candidateText = setSection(await fs.readFile(f.taskArtifact, 'utf8'), 'Implementation Test Evidence', '- none');
  await fs.writeFile(f.taskArtifact, candidateText);
  // Every mutant starts from a real accepted receipt in the same consumer.
  const mutants = [
    [{ semanticResponseSha256: '0'.repeat(64) }, /native receipt\/result\/origin binding differs/u],
    [{ operation: 'APPLY_FINDINGS' }, /native receipt\/result\/origin binding differs/u],
    [{ slice: 'slice-03' }, /native receipt\/result\/origin binding differs/u],
    [{ attempt: 2 }, /native receipt\/result\/origin binding differs/u],
    [{ testedState: { ...receipt.testedState, workspace: os.tmpdir() } }, /captured Tested state workspace\/source mismatch/u],
    [{ testedState: { ...receipt.testedState, sourceTaskPath: path.join(f.root, 'other.md') } }, /captured Tested state workspace\/source mismatch/u],
  ];
  for (const [altered, category] of mutants) {
    await fs.writeFile(captured.receiptFile, original);
    const control = await produce(f, 'EXECUTE_SLICE', evidence);
    assert.match(control, /### implementation-check-01/u);
    await validateExecutionCandidate(f.specPath, f.implementation.copy.candidateExecutionRoot,
      [{ slice: 'slice-01', text: setSection(candidateText, 'Implementation Test Evidence', control) }],
      { privateAutomaticCheck: { operation: 'EXECUTE_SLICE', slice: 'slice-01', round: 1 } });
    await fs.writeFile(captured.receiptFile, JSON.stringify({ ...receipt, ...altered }));
    await assert.rejects(produce(f, 'EXECUTE_SLICE', evidence), category);
    await proof(t, { mutant: Object.keys(altered)[0], expectedCategory: category.source, positiveControlReached: true });
  }
  await fs.writeFile(captured.receiptFile, original);
});

test('retained pristine preparations do not invent executed work and real archived checks remain non-pristine', async t => {
  const pristine = await fixture();
  t.after(() => fs.rm(pristine.root, { recursive: true, force: true }));
  await approveFixture(pristine);
  const { inspectExecutionState } = await import('../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs');
  for (let round = 0; round < 2; round++) {
    await revise(pristine);
    const state = await inspectExecutionState(pristine.specPath);
    assert.equal(state.state, 'MATERIALIZED_PRISTINE');
    assert.equal(state.tasks.get('slice-01').pristine, true);
    assert.equal(state.tasks.get('slice-01').continuity.history.length, round + 1);
    assert.equal(state.tasks.get('slice-01').implementationChecks.length, 0);
    assert.equal(state.tasks.get('slice-01').attempts.length, 0);
  }
  const worked = await implementedFixture();
  t.after(() => fs.rm(worked.root, { recursive: true, force: true }));
  await formal(worked);
  const receiptBefore = await fs.readFile(worked.implementation.captured.receiptFile);
  await revise(worked);
  const state = await inspectExecutionState(worked.specPath);
  assert.equal(state.tasks.get('slice-01').pristine, false);
  assert.equal(state.tasks.get('slice-01').implementationChecks.length, 1);
  assert.equal(state.tasks.get('slice-01').attempts[0].status, 'PASS');
  assert.deepEqual(await fs.readFile(worked.implementation.captured.receiptFile), receiptBefore);
  await proof(t, { pristineRetainedRevisions: 2, pristineChecks: 0, workedPristine: false,
    retainedImplementationChecks: 1, retainedFormalPass: true, originalReceiptUnchanged: true });
});

test('an unreviewed joint draft can be replaced without inventing an approved snapshot or activation', async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const { inspectExecutionState, preflightExecutionOperation } = await import('../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs');
  await publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: f.candidate });
  await assert.rejects(preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1'), /not legal/u);
  const replacement = await preparePreparationCandidate({ specPath: f.specPath, operation: 'REPLAN' });
  const global = path.join(replacement.candidateExecutionRoot, 'plan.md');
  await fs.writeFile(global, setSection((await fs.readFile(global, 'utf8')).replace('- Strategy:', '- Replan reason: Clarify the same pristine draft before independent review\n- Strategy:'), 'Delivery Continuity', '- runtime'));
  await publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: replacement.candidateExecutionRoot });
  const state = await inspectExecutionState(f.specPath);
  assert.equal(state.state, 'PENDING_REPLAN_DRAFT');
  assert.equal(state.globalPlan.revision, 2);
  assert.equal(state.tasks.get('slice-01').pristine, true);
  assert.equal(state.tasks.get('slice-01').continuity.history.length, 0);
  for (const file of ['approved-preparation.json', 'activation.json']) await assert.rejects(fs.stat(path.join(f.workspace.executionRoot, file)), { code: 'ENOENT' });
  await assert.rejects(preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1'), /not legal/u);
  await proof(t, { replacedDraftRevision: 2, approvedSnapshot: false, activation: false, executionDenied: true });
});

test('APPLY_FINDINGS uses the same historical snapshot boundary', async t => {
  const f = await implementedFixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const finding = '### finding-01\n\n- Severity: blocking\n- State: active\n- Origin: attempt-01\n- Problem: Strengthen the prepared greeting proof.\n- Evidence: Controlled semantic fixture requires a correction.\n- Impact: Acceptance proof is incomplete.\n- Related authority: AC-001\n- Expected correction: Correct greeting inside the approved area.';
  await formal(f, { responseOverride: { status: 'NEEDS_FIX', findingReferences: 'finding-01', findingDispositions: 'finding-01=active' },
    editCandidate: async copy => { const file = path.join(copy.candidateExecutionRoot, 'tasks/slice-01.md'); await fs.writeFile(file, setSection(await fs.readFile(file, 'utf8'), 'Validation Findings', finding)); } });
  const current = await readExecutionActivation(f.specPath);
  f.admitted = await beginPreparedExecutionOperation(f.specPath, 'APPLY_FINDINGS', '1', current.activation.activationId);
  const start = await native(f, f.admitted.owner);
  const copy = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-01', owner: f.admitted.owner });
  f.taskArtifact = copy.candidateTaskArtifact; f.cli = path.join(f.root, 'src/unpredicted.mjs'); f.cliTest = path.join(f.root, 'src/greeting.test.mjs');
  await fs.writeFile(f.cli, 'export const greeting = "wrong";\n');
  const a = hash(await fs.readFile(f.cli));
  await fs.writeFile(f.taskArtifact, setSection(await fs.readFile(f.taskArtifact, 'utf8'), 'Corrections Applied', '- `' + CLI + '`'));
  const response = { ...f.implementation.response, status: 'TESTS_FAIL', findingsCycle: 'attempt-01',
    commands: f.implementation.response.commands.map(item => ({ ...item, exit: 1 })),
    failures: 'Actual greeting assertion exited 1.', findingsVerified: 'finding-01', correctionsCovered: 'Correct the greeting module.',
    regressionsSelected: 'Prepared greeting value assertion.', unsupportedActiveFindings: 'none' };
  for (const key of ['priorRoundFailure', 'correctionApplied', 'inSliceRationale']) delete response[key];
  const captured = await capture(start, response, [CLI, TEST]);
  const first = await produce(f, 'APPLY_FINDINGS', { response: JSON.stringify(response), captured });
  await insertExecutionEvidenceInCandidate({ taskArtifact: f.taskArtifact, operation: 'APPLY_FINDINGS', bundle: first,
    validateProspectiveTask: task => validateExecutionCandidate(f.specPath, copy.candidateExecutionRoot, [task], { privateAutomaticCheck: { operation: 'APPLY_FINDINGS', slice: 'slice-01', round: 1 } }) });
  const two = await nextRound(f, 'APPLY_FINDINGS', response, ['cli']);
  const historical = await produce(f, 'APPLY_FINDINGS', { response: JSON.stringify(response), captured });
  assert.ok(historical.includes('`' + CLI + '` | sha256:' + a));
  assert.match(two.bundle, /### findings-check-02\n- Automatic check round: 2\/3\n- Status: TESTS_PASS/u);
  assert.equal(two.bundle.match(/^- Correction paths: (.+)$/mu)?.[1], CLI);
  await proof(t, { firstExit: 1, secondExit: 0, a, b: hash(await fs.readFile(f.cli)), correctionPaths: [CLI] });
});
