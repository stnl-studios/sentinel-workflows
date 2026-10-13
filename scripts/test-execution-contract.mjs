import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  deriveNormalHandoff,
  EXECUTION_WORKFLOW_SKILLS,
  ExecutionContractError,
  computeRequirementsAuthority,
  inspectExecutionState,
  preflightExecutionOperation,
  preflightRunnerResultRecovery,
  beginRunnerResultRecovery,
  repairExecutionContract,
  validateExecutionCandidate,
  readRunnerVerification,
  readExecutionActivation,
  workflowSkillForOperation,
} from "../skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs";
import { preparePlanCandidate } from "../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs";
import { serializePlanPathClaims } from "../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs";
import { prepareValidationCandidate } from "../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs";
import { prepareValidationCopy } from "../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs";
import { recoverRejectedValidationCandidate } from "../skills/workflows/stnl-slice-quality-manager/runtime/recover-rejected-validation-candidate.mjs";
import { decideOutcome, initializeTurnBudget, budgetSnapshot, nextHandoff, prepareOfficialRecovery, recoverableRunnerHandoff, runCase, runTemplateTurn } from "../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs";
import { validateWorkspace as validateLifecycleWorkspace } from "../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs";
import { renderClosedFeature } from "../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/closed-spec.mjs";
import { runCodexTurn } from "../agents/codex/runtime/sdk-transport.mjs";
import { createUsageNormalizer, ZERO_USAGE } from "../agents/codex/runtime/usage-accounting.mjs";
import { assertManagedRunnerReceipt, createManagedSliceContext, managedEnvironment } from "../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs";
import { publishValidationCandidate } from "../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs";
import { resolveExecutionWorkspace as resolveMaterializerExecutionWorkspace } from "../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs";
import { preparePreparationCandidate } from "../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs";
import { publishPreparationCandidate } from "../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs";
import { serializeTaskPathClaims } from "../skills/workflows/stnl-execution-planner/runtime/serialize-task-paths.mjs";
import {
  validateManagedChangedAreas,
  captureRunnerTestedState,
  serializeRunnerEvidence,
  serializeRunnerManifest,
  serializeRunnerRecord,
  serializeRunnerResponse,
  serializeExecutionScopeClaims,
  insertExecutionEvidenceInCandidate,
  serializeRunnerExecutionBundleFromResponse,
  serializeRunnerValidationBundle,
  serializeRunnerValidationBundleFromResponse,
  persistMalformedRunnerResultInCandidate,
  assertRunnerVerdictConsistency,
  RunnerSemanticResultError,
  recoverableRunnerResultDiagnostic,
} from "../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs";
import { serializeRunnerValidationBundleFromResponse as serializeQualityManagerValidationBundleFromResponse }
  from "../skills/workflows/stnl-slice-quality-manager/runtime/serialize-runner-evidence.mjs";
import { parseSemanticExecutionPayload, serializeCommand } from "../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs";
import { startNativeRunnerCapture, bindNativeRunnerIdentity, captureRunnerResponse } from "../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs";
import { startOfficialRunnerBroker } from "../agents/codex/runtime/runner-broker.mjs";
import { runManagedRunnerBridge } from "../agents/codex/runtime/managed-runner-bridge.mjs";
import { invokeIndependentRunner } from "../agents/codex/runtime/validation-runner.mjs";
import { emptyFindingArrays, validationResponse as sanitizedValidationResponse,
  failedCheckHistory } from "./fixtures/validation-response-regressions.mjs";
import { prepareExecutionCopy, publishExecutionCopy } from "../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs";
import { EXECUTION_OPERATION_SKILLS, WORKFLOW_OPERATIONS } from "./lib/skill-registry.mjs";
import { guardOperationProvenance, recoverableOfficialHandoff } from "../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs";
import { budgetViolation } from "../benchmarks/sentinel-todo/runtime/benchmark.mjs";

import { runRepairDispute } from "./test-p1b-publication.mjs";
import {runOwnedContract} from "./fixtures/p1b-owned-regressions.mjs";
import { readPreparationArtifacts, captureApprovedPreparation, parseVerificationRecipe } from "../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs";
import { reviewDecision, fixture as preparationFixture, approveFixture, publishFixtureCandidate, prepareFixtureCandidate, projectPreparationAuthorityFrom } from "./test-p1b-preparation.mjs";
import { verificationCommand, assertRunnerVerification } from "../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs";
import { createOfflineCheckout } from "./fixtures/offline-checkout.mjs";
import { beginExample, implementExample, validateExample, correctExample, retryExample, retryFindingsExample, exampleHistoryRecipe, captureExample, withExampleOwner } from "./fixtures/execution-contract-producers.mjs";

import { capture as captureNativeExample, native as nativeExample } from "./test-p1b-continuity.mjs";
import { withManagedExample } from "./fixtures/managed-execution-example.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILLS = [
  "stnl-execution-planner", "stnl-plan-reviewer",
  "stnl-slice-executor", "stnl-slice-quality-manager",
];

async function temporary(t, prefix = "stnl-execution-contract-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function treeBytes(directory) {
  return Promise.all((await fs.readdir(directory, { recursive: true })).sort().map(async (relative) => {
    const file = path.join(directory, relative);
    const metadata = await fs.lstat(file);
    return [relative, metadata.mode, metadata.isFile() ? await fs.readFile(file) : null];
  }));
}

async function capturedCommandEvidence(t, fixture, operation, response, command) {
  return capturedVerificationSequence(t, fixture, operation, response, [], [{ command, exit: 0 }]);
}

async function capturedVerificationSequence(t, fixture, operation, response, exits, literalCommands = null) {
  const captured = await captureExample(fixture, operation, JSON.parse(response));
  const receipt = JSON.parse(await fs.readFile(captured.receiptFile));
  const commands = receipt.verification.checks.map(({ command, exit }) => ({ command, exit }));
  if (literalCommands) assert.deepEqual(commands, literalCommands, 'capture stimulus must match the actual reviewed commands and exits');
  else assert.deepEqual(commands.map(({ exit }) => exit), exits, 'capture exits must have been observed from the real reviewed recipe');
  return { ...captured, commands };
}

test("success verdicts reconcile every mechanical exit without suppressing legitimate failures", () => {
  for (const operation of ["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]) {
    const success = operation === "VALIDATE_SLICE" ? "PASS" : "TESTS_PASS";
    assert.doesNotThrow(() => assertRunnerVerdictConsistency(operation, success, [{ exit: 0 }]));
    for (const exits of [[1, 0, 0, 0], [1, 0], [1, 0, 1]]) {
      assert.throws(() => assertRunnerVerdictConsistency(operation, success, exits.map((exit) => ({ command: "check", exit }))),
        (error) => error.code === "RUNNER_VERDICT_EVIDENCE_CONFLICT" && error.failedCommands.length === exits.filter(Boolean).length);
    }
    const failure = operation === "VALIDATE_SLICE" ? "NEEDS_FIX" : "TESTS_FAIL";
    assert.doesNotThrow(() => assertRunnerVerdictConsistency(operation, failure, [{ exit: 1 }]));
    assert.doesNotThrow(() => assertRunnerVerdictConsistency(operation, "BLOCKED", [{ exit: 1 }]));
  }
});

test("real failed-check history rejects omitted failures and persists a legitimate BLOCKED verdict", async (t) => {
  for (const phase of ['omitted-failures', 'contradictory-pass', 'legitimate-blocked']) {
    const status = phase === 'legitimate-blocked' ? 'BLOCKED' : 'PASS';
    const fixture = await standaloneWorkspace(t);
    const history = await exampleHistoryRecipe(fixture, 4);
    await renderArtifacts(fixture);
    await implementExample(fixture);
    const exits = [1, 0, 1, 0];
    await history.set(exits);
    const verification = await readRunnerVerification(fixture.requirements, 'slice-01');
    const commands = verification.checks.map((check, index) => ({ command: verificationCommand(check), exit: exits[index] }));
    const claimed = { ...sanitizedValidationResponse(status), commands: phase === 'omitted-failures' ? commands.filter(({ exit }) => exit === 0) : commands,
      evidence: 'Prepared history assertions one and three failed; both failures are preserved.',
      blockers: status === 'BLOCKED' ? 'The prepared fixture requires reliable correction before acceptance.' : 'none' };
    const captured = await capturedVerificationSequence(t, fixture, 'VALIDATE_SLICE', JSON.stringify(claimed), [], commands);
    const observedFile = path.join(path.dirname(captured.receiptFile), 'round-1.verification.json');
    const observed = await fs.readFile(observedFile);
    await withExampleOwner(captured.admission, async () => {
      const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateParent: await temporary(t), owner: captured.admission.owner });
      const taskFile = path.join(copy.candidateExecutionRoot, 'tasks/slice-01.md');
      const before = await fs.readFile(taskFile);
      if (phase === 'omitted-failures') {
        await assert.rejects(prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root,
          candidateExecutionRoot: copy.candidateExecutionRoot, ...captured }), /native response commands differ from reviewed recipe observation/u);
        assert.deepEqual(await fs.readFile(taskFile), before, 'omitted failures never create a formal attempt');
        return;
      }
      const result = await prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root,
        candidateExecutionRoot: copy.candidateExecutionRoot, ...captured });
      const task = await fs.readFile(taskFile, 'utf8');
      if (status === 'PASS') {
        assert.equal(result.status, 'RUNNER_RESULT_BLOCKED');
        assert.match(result.recovery.diagnostic, /contradicts 2 marked verification/u);
        assert.match(task, /## Validation Attempts\n\n- none/u);
      } else {
        assert.equal(result.formalStatus, 'BLOCKED');
        for (const { command, exit } of commands) assert.ok(task.includes('`' + command + '` | exit:' + exit));
        assert.match(task, /### attempt-01/u);
        await publishValidationCandidate({ specPath: fixture.requirements, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot, owner: captured.admission.owner });
        const readback = await inspectExecutionState(fixture.requirements);
        assert.equal(readback.tasks.get('slice-01').attempts[0].status, 'BLOCKED');
        const recorded = readback.tasks.get('slice-01').attempts[0].commands;
        assert.match(recorded[0].command, /validate-execution-state\.mjs.*VALIDATE_SLICE 1/u);
        assert.equal(recorded[0].exit, 0);
        assert.deepEqual(recorded.slice(1), commands);
      }
      assert.notDeepEqual(await fs.readFile(taskFile), before, 'the genuine result was persisted in the owned candidate');
    });
    assert.deepEqual(await fs.readFile(observedFile), observed, 'producer observation remains unchanged');
  }
});

test("legacy probe escaping and structured assertion distinguish actual priority from stray words", () => {
  const correct = '{"id":2,"title":"B","completed":false,"priority":"medium"}\n';
  const overEscapedItem8Needle = String.raw`\"priority\":\"medium\"`;
  assert.equal(correct.includes(overEscapedItem8Needle), false,
    "the item_8 JS string searches for literal backslashes absent from JSON output");
  function weakItem11Check(output) { return output.includes("priority") && output.includes("medium"); }
  function structuredCheck(output) {
    const records = output.trim().split("\n").map((line) => JSON.parse(line));
    return records.length === 1 && records[0]?.priority === "medium";
  }
  for (const output of [correct,
    '{"id":2,"title":"priority medium","completed":false}\n',
    '{"id":2,"title":"medium","completed":false,"priority":"high"}\n',
    'priority medium\n']) {
    assert.equal(weakItem11Check(output), true);
  }
  assert.equal(structuredCheck(correct), true);
  assert.equal(structuredCheck('{"id":2,"title":"priority medium","completed":false}\n'), false);
  assert.equal(structuredCheck('{"id":2,"title":"medium","completed":false,"priority":"high"}\n'), false);
  assert.throws(() => structuredCheck('priority medium\n'), SyntaxError);
});

async function formalEnvironmentResult(f, { admission = null, passes = false } = {}) {
  admission ??= await beginExample(f, 'VALIDATE_SLICE');
  return withExampleOwner(admission, async () => {
    f.setReady(passes);
    const start = await nativeExample({ specPath: f.requirements, root: f.root }, admission.owner);
    const parent = path.join(f.root, 'observed-formal-candidates'); await fs.mkdir(parent, { recursive: true });
    const copy = await prepareValidationCopy({ specPath: f.requirements, slice: 'slice-01', candidateParent: parent, owner: admission.owner });
    const response = { ...sanitizedValidationResponse('PASS'),
      commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: passes ? 0 : 1 })),
      evidence: 'Offline semantic PASS claim; the real environment assertion determines the mechanical verdict.' };
    const captured = await captureNativeExample(start, response);
    const prepared = await prepareValidationCandidate({ specPath: f.requirements, slice: 'slice-01', workspace: f.root,
      candidateExecutionRoot: copy.candidateExecutionRoot, ...captured });
    return { admission, start, copy, captured, response, prepared };
  });
}

test("captured contradiction publishes blocker, manager consumes bounded recovery, and valid new attempt completes", async t => {
  for (const secondPasses of [true, false]) {
    const f = await filelessRecoveryFixture(t);
    await implementExample(f, { filelessReason: f.filelessReason });
    const first = await formalEnvironmentResult(f);
    assert.equal(first.prepared.status, 'RUNNER_RESULT_BLOCKED');
    assert.match(first.prepared.recovery.diagnostic, /RUNNER_VERDICT_EVIDENCE_CONFLICT/);
    assert.equal((await validateExecutionCandidate(f.requirements, first.copy.candidateExecutionRoot)).state, 'RUNNER_RESULT_BLOCKED');
    await publishValidationCandidate({ specPath: f.requirements, slice: 'slice-01', candidateExecutionRoot: first.copy.candidateExecutionRoot, owner: first.admission.owner });
    const blockedState = await inspectExecutionState(f.requirements);
    assert.equal(blockedState.tasks.get('slice-01').attempts.length, 0);
    const firstCandidate = await treeBytes(first.copy.candidateExecutionRoot);
    const receipts = await Promise.all([first.captured.receiptFile, first.captured.semanticResponseFile].map(async file => [file, await fs.readFile(file)]));
    const readback = { lifecycle: { status: 'ready' }, execution: blockedState, executionRaw: blockedState };
    const outcome = decideOutcome('VALIDATE_SLICE', readback, true);
    assert.deepEqual(outcome, { result: 'BLOCKED', blocker: 'OFFICIAL_RUNNER_RESULT_BLOCKED' });
    const input = { operation: 'VALIDATE_SLICE', slice: 'slice-01', outcome, readback, priorOperations: [], remainingTurns: 2 };
    const recovery = recoverableRunnerHandoff(input);
    assert.equal(recovery.authority, blockedState.currentFingerprint);
    assert.equal(recoverableRunnerHandoff({ ...input, remainingTurns: 1 }), null);
    assert.equal(recoverableRunnerHandoff({ ...input, priorOperations: [{ recovery }], remainingTurns: 20 }), null);
    const budgets = JSON.parse(await fs.readFile(path.join(ROOT, 'benchmarks/sentinel-todo/benchmark.json'))).cases.find(item => item.id === 'A').budgets;
    const official = await prepareOfficialRecovery({ ...input, budgets, specPath: f.requirements,
      product: { validateWorkspace: () => ({ status: 'ready' }), inspectExecutionState, preflightExecutionOperation, preflightRunnerResultRecovery } });
    assert.equal(official.operation, 'VALIDATE_SLICE'); assert.equal(official.slice, 'slice-01');
    assert.deepEqual(official.target, blockedState.recoveryTargets[0]);
    assert.equal(official.admission.rejectedOperationAttemptId, first.admission.owner.operationAttemptId);
    assert.deepEqual(nextHandoff('VALIDATE_SLICE', readback), { operation: 'VALIDATE_SLICE', slice: 'slice-01' });
    const next = await beginRunnerResultRecovery(f.requirements, 'VALIDATE_SLICE', '1', official.admission);
    const ownerFile = path.join(f.root, 'successor-owner.json');
    await fs.writeFile(ownerFile, JSON.stringify({ specPath: f.requirements, owner: next.owner }));
    assert.notEqual(next.owner.operationAttemptId, first.admission.owner.operationAttemptId);
    const second = await formalEnvironmentResult(f, { admission: { ...next, ownerFile }, passes: secondPasses });
    assert.equal(second.prepared.status, secondPasses ? 'PREPARED' : 'RUNNER_RESULT_BLOCKED');
    await publishValidationCandidate({ specPath: f.requirements, slice: 'slice-01', candidateExecutionRoot: second.copy.candidateExecutionRoot, owner: next.owner });
    const final = await inspectExecutionState(f.requirements);
    if (secondPasses) {
      assert.equal(final.state, 'COMPLETE'); assert.equal(final.tasks.get('slice-01').attempts.length, 1);
      assert.deepEqual(decideOutcome('VALIDATE_SLICE', { lifecycle: { status: 'ready' }, execution: final, executionRaw: final }, true), { result: 'PASS', blocker: null });
      assert.deepEqual(nextHandoff('VALIDATE_SLICE', { executionRaw: final }), { operation: 'SPEC_CLOSE', slice: null });
    } else {
      assert.equal(final.state, 'RUNNER_RESULT_BLOCKED'); assert.equal(final.tasks.get('slice-01').attempts.length, 0);
      assert.equal(recoverableRunnerHandoff({ ...input, readback: { executionRaw: final }, priorOperations: [{ recovery }], remainingTurns: 20 }), null);
      await assert.rejects(preflightRunnerResultRecovery(f.requirements, 'VALIDATE_SLICE', '1', {
        expectedActivationId: final.activation.activationId, rejectedOperationAttemptId: next.owner.operationAttemptId,
        rejection: final.activeDelegationBlockers[0].recoveryProof }), /already consumed/);
    }
    assert.deepEqual(await treeBytes(first.copy.candidateExecutionRoot), firstCandidate);
    for (const [file, bytes] of receipts) assert.deepEqual(await fs.readFile(file), bytes);
  }
});

test("late strict PASS command rejection preserves candidate and publishes only bound recovery", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await writeValidatedPath(fixture);
  await editTask(fixture, (value) => {
    let task = value.replace("- [ ] 1.1", "- [x] 1.1");
    task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
    task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(task, "Diff Summary", "- Verified behavior is implemented.");
  });
  const candidateParent = await temporary(t, "stnl-late-rejection-");
  const response = JSON.stringify({ status: "PASS", head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "semantic claim", exit: 0 }], evidence: "independent checks cover AC-001",
    findingReferences: "none", findingDispositions: "none", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "no changes" });
  const initial = await capturedVerificationSequence(t, fixture, "VALIDATE_SLICE", response, [0]);
  const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent });
  assert.equal((await prepareValidationCandidate({ specPath: fixture.requirements, slice: "1",
    workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...initial })).status, "PREPARED");
  const rejectedTask = path.join(copy.candidateExecutionRoot, "tasks", "slice-01.md");
  const prepared = await fs.readFile(rejectedTask, "utf8");
  const rejected = prepared.replaceAll("check-1.mjs` | exit:0", "check-1.mjs` | exit:1");
  assert.notEqual(rejected, prepared);
  await fs.writeFile(rejectedTask, rejected);
  const liveBefore = await fs.readFile(path.join(fixture.execution, "tasks", "slice-01.md"));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot),
    (error) => error.contractViolation?.code === "PASS_COMMAND_EXIT_NONZERO");
  const conflicting = await capturedVerificationSequence(t, fixture, "VALIDATE_SLICE", response, [1]);
  const recovered = await recoverRejectedValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
    workspace: fixture.root, rejectedCandidateRoot: copy.candidateExecutionRoot, candidateParent, ...conflicting });
  assert.equal(recovered.publishedState, "RUNNER_RESULT_BLOCKED");
  assert.equal(recovered.mandatoryRecovery.operation, "VALIDATE_SLICE");
  assert.equal(await fs.readFile(rejectedTask, "utf8"), rejected);
  assert.notDeepEqual(await fs.readFile(path.join(fixture.execution, "tasks", "slice-01.md")), liveBefore);
  assert.equal((await inspectExecutionState(fixture.requirements)).tasks.get("slice-01").attempts.length, 0);
});

test("missing mechanical evidence is a hard failure, not a malformed runner blocker", async (t) => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  await implementExample(fixture);
  const formal = await validateExample(fixture, { prepare: false, publish: false });
  const { copy, captured } = formal;
  const live = await treeBytes(fixture.execution);
  const task = path.join(copy.candidateExecutionRoot, 'tasks/slice-01.md');
  const before = await fs.readFile(task);
  const receipt = await fs.readFile(captured.receiptFile);
  await fs.rm(captured.receiptFile);
  await withExampleOwner(formal.admission, async () => {
    await assert.rejects(prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root,
      candidateExecutionRoot: copy.candidateExecutionRoot, ...captured }), /ENOENT/);
    assert.deepEqual(await fs.readFile(task), before);
    assert.deepEqual(await treeBytes(fixture.execution), live);
    await fs.writeFile(captured.receiptFile, receipt, { flag: 'wx' });
    assert.equal((await prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root,
      candidateExecutionRoot: copy.candidateExecutionRoot, ...captured })).formalStatus, 'PASS');
  });
});

test("execution producer publishes SDK command and exit despite semantic placeholder and false exit", async t => {
  // Historical name remains traceable. Current command authority is the
  // reviewed recipe's observed process result, including in managed transport.
  for (const extraSdkCommand of [false, true]) {
  const f = await standaloneWorkspace(t); await renderArtifacts(f);
  const live = await readPreparationArtifacts(f.execution);
  const semantic = { ...scopeRegressionPayload(), commands: [{ command: '<bounded integration assertions>', exit: 9 }] };
  const sdkCommand = "STNL_VERIFICATION_COMMAND=1 node -e `echo quoted`\ncat <<'EOF'\nlong payload\nEOF";
  await withManagedExample(f, 'EXECUTE_SLICE', semantic, async managed => {
    let task = await fs.readFile(managed.copy.candidateTaskArtifact, 'utf8');
    task = replaceSection(task.replace('- [ ] 1.1', '- [x] 1.1'), 'Changed Areas', '- `../../src/example.txt`');
    task = replaceSection(task, 'Diff Summary', '- Implemented approved example bytes and checked the reviewed recipe.');
    await fs.writeFile(managed.copy.candidateTaskArtifact, task);
    const captured = await managed.dispatch({ automaticCheckRound: '1/3', changedAreas: ['../../src/example.txt'] });
    assert.equal(captured.status, 'RUNNER_RESPONSE_CAPTURED'); assert.equal(managed.calls(), 1);
    const receipt = await fs.readFile(captured.receiptFile), response = await fs.readFile(captured.semanticResponseFile);
    const actual = JSON.parse(receipt).verification.checks.map(({ command, exit }) => ({ command, exit }));
    assert.deepEqual(actual, [{ command: 'node --test src/example.test.mjs', exit: 0 }]);
    if (extraSdkCommand) assert.ok((await fs.readFile(captured.eventsPath, 'utf8')).includes(JSON.stringify(sdkCommand)));
    assert.deepEqual(JSON.parse(response).commands, semantic.commands);
    const consume = () => serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', response: response.toString('utf8'),
      workspace: f.root, taskArtifact: managed.copy.candidateTaskArtifact, receiptFile: captured.receiptFile, semanticResponseFile: captured.semanticResponseFile });
    if (extraSdkCommand) {
      const candidate = await treeBytes(managed.copy.candidateExecutionRoot), official = await treeBytes(f.execution);
      await assert.rejects(consume(), /additional SDK verification commands require an explicitly reviewed recipe; preserve the observed events/);
      assert.deepEqual(await treeBytes(managed.copy.candidateExecutionRoot), candidate); assert.deepEqual(await treeBytes(f.execution), official);
      assert.deepEqual(await fs.readFile(captured.receiptFile), receipt); assert.deepEqual(await fs.readFile(captured.semanticResponseFile), response);
      assert.equal(managed.calls(), 1); return;
    }
    const bundle = await consume();
    assert.ok(bundle.includes('`node --test src/example.test.mjs` | exit:0'));
    assert.ok(!bundle.includes('<bounded integration assertions>')); assert.ok(!bundle.includes('exit:9')); assert.ok(!bundle.includes(sdkCommand));
    assert.deepEqual(await readPreparationArtifacts(f.execution), live);
    await managed.finalize();
    const published = await inspectExecutionState(f.requirements);
    assert.equal(published.state, 'IMPLEMENTED_AWAITING_VALIDATION');
    assert.deepEqual(published.tasks.get('slice-01').implementationChecks[0].commands, actual);
    assert.equal(managed.calls(), 1, 'serialization and publication do not invoke the provider again');
    assert.deepEqual(await fs.readFile(captured.receiptFile), receipt); assert.deepEqual(await fs.readFile(captured.semanticResponseFile), response);
  }, { sdkCommand: extraSdkCommand ? sdkCommand : null });
  }
});

test("execution producer inserts exact hashed evidence only into its owned candidate", async t => {
  const f = await standaloneWorkspace(t); await renderArtifacts(f);
  const admitted = await beginExample(f, 'EXECUTE_SLICE');
  const start = await nativeExample({ specPath: f.requirements, root: f.root }, admitted.owner);
  const copies = [
    await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-01', owner: admitted.owner }),
    await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-01', owner: admitted.owner }),
  ];
  for (const copy of copies) {
    t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
    let task = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
    task = replaceSection(task.replace('- [ ] 1.1', '- [x] 1.1'), 'Changed Areas', '- `../../src/example.txt`');
    task = replaceSection(task, 'Diff Summary', '- Implemented and verified the approved example bytes.');
    await fs.writeFile(copy.candidateTaskArtifact, task);
  }
  const response = { ...scopeRegressionPayload(),
    noVerificationCommandConfirmation: 'The reviewed verification command was executed',
    commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: 0 })),
    resultOfEachCommandAndExitCode: 'The reviewed example assertion exited 0' };
  const captured = await captureNativeExample(start, response, ['../../src/example.txt']);
  const receiptBytes = await fs.readFile(captured.receiptFile);
  const responseBytes = await fs.readFile(captured.semanticResponseFile);
  assert.deepEqual(JSON.parse(receiptBytes).verification.checks.map(({ exit }) => exit), [0]);
  const liveBefore = await treeBytes(f.execution);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE',
    response: JSON.stringify(response), workspace: f.root, taskArtifact: copies[0].candidateTaskArtifact, ...captured });
  assert.equal(await insertExecutionEvidenceInCandidate({ taskArtifact: copies[0].candidateTaskArtifact,
    operation: 'EXECUTE_SLICE', bundle,
    validateProspectiveTask: text => validateExecutionCandidate(f.requirements, copies[0].candidateExecutionRoot, [text]) }),
    '### implementation-check-01');
  const cliEnvironment = { ...process.env, STNL_OPERATION_OWNER_FILE: admitted.ownerFile };
  delete cliEnvironment.NODE_TEST_CONTEXT;
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs'),
    '--execution-bundle', '--operation', 'EXECUTE_SLICE', '--workspace', f.root,
    '--task-artifact', copies[1].candidateTaskArtifact, '--semantic-response-file', captured.semanticResponseFile,
    '--receipt-file', captured.receiptFile, '--insert-candidate'],
  { cwd: f.root, env: cliEnvironment, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(await fs.readFile(copies[1].candidateTaskArtifact), await fs.readFile(copies[0].candidateTaskArtifact));
  assert.equal((await validateExecutionCandidate(f.requirements, copies[0].candidateExecutionRoot)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  assert.equal((await validateExecutionCandidate(f.requirements, copies[1].candidateExecutionRoot)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  assert.deepEqual(await treeBytes(f.execution), liveBefore);
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-01', candidateRoot: copies[0].candidateRoot });
  assert.equal((await inspectExecutionState(f.requirements)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBytes);
  assert.deepEqual(await fs.readFile(captured.semanticResponseFile), responseBytes);

  const bad = await standaloneWorkspace(t);
  const history = await exampleHistoryRecipe(bad, 1);
  await history.set([1]); // The reviewed input is already failing before activation and admission.
  await renderArtifacts(bad);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(bad.root, 'src/history-state.json'))), [false]);
  const badAdmission = await beginExample(bad, 'EXECUTE_SLICE');
  const badStart = await nativeExample({ specPath: bad.requirements, root: bad.root }, badAdmission.owner);
  const badCopy = await prepareExecutionCopy({ specPath: bad.requirements, slice: 'slice-01', owner: badAdmission.owner });
  t.after(() => fs.rm(badCopy.candidateRoot, { recursive: true, force: true }));
  let task = await fs.readFile(badCopy.candidateTaskArtifact, 'utf8');
  task = replaceSection(task.replace('- [ ] 1.1', '- [x] 1.1'), 'Changed Areas', '- `../../src/history-state.json`');
  task = replaceSection(task, 'Diff Summary', '- The prepared history assertion was observed.');
  await fs.writeFile(badCopy.candidateTaskArtifact, task);
  const contradiction = { ...scopeRegressionPayload(),
    noVerificationCommandConfirmation: 'The reviewed verification command was executed',
    commands: badStart.verification.checks.map(check => ({ command: verificationCommand(check), exit: 1 })),
    resultOfEachCommandAndExitCode: 'The reviewed history assertion exited 1' };
  const observed = await captureNativeExample(badStart, contradiction, ['../../src/history-state.json']);
  const failedReceipt = await fs.readFile(observed.receiptFile), failedResponse = await fs.readFile(observed.semanticResponseFile);
  assert.deepEqual(JSON.parse(failedReceipt).verification.checks.map(({ exit }) => exit), [1]);
  const candidateBefore = await treeBytes(badCopy.candidateExecutionRoot), liveBadBefore = await treeBytes(bad.execution);
  await assert.rejects(serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE',
    response: JSON.stringify(contradiction), workspace: bad.root, taskArtifact: badCopy.candidateTaskArtifact, ...observed }),
  /TESTS_PASS contradicts 1 marked verification command/u);
  assert.deepEqual(await treeBytes(badCopy.candidateExecutionRoot), candidateBefore);
  assert.deepEqual(await treeBytes(bad.execution), liveBadBefore);
  assert.deepEqual(await fs.readFile(observed.receiptFile), failedReceipt);
  assert.deepEqual(await fs.readFile(observed.semanticResponseFile), failedResponse);
});

test("producer rejects empty commands and preserves mechanical status and head rules", async (t) => {
  assert.throws(() => serializeCommand('', 'command'), /non-empty command/);
  const base = {
    status: "TESTS_PASS", automaticCheckRound: "1/3", head: "fixture-head",
    discoverySources: "task", discoveryActions: "inspection", verificationTypesConsidered: "unit",
    nonApplicabilityRationale: "none", noVerificationCommandConfirmation: "ran",
    commands: [{ command: "npm test", exit: 0 }], resultOfEachCommandAndExitCode: "pass",
    selectedChecks: "unit", selectionRationale: "direct", coverage: "AC-001", failures: "none",
    priorRoundFailure: "none", correctionApplied: "none", inSliceRationale: "none",
    evidenceOrFailureSummary: "pass", affectedFilesOrBehaviors: "example", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "none",
  };
  assert.deepEqual(parseSemanticExecutionPayload(JSON.stringify(base), 'EXECUTE_SLICE'), base);
  for (const [invalid, diagnostic] of [
    [{ status: 'FAKE' }, /Status is invalid/],
    [{ automaticCheckRound: '4/3' }, /Automatic check round is invalid/],
    [{ head: 'bad`head' }, /head|single-line scalar/],
    [{ commands: [] }, /requires executed commands/],
    [{ commands: [{ command: '', exit: 0 }] }, /non-empty command/],
    [{ correctionsCovered: 'findings-only field' }, /unknown semantic execution payload field: correctionsCovered/],
  ]) assert.throws(() => parseSemanticExecutionPayload(JSON.stringify({ ...base, ...invalid }), 'EXECUTE_SLICE'), diagnostic);
});

async function ownedMalformedRecoveryFixture(t, malformed = true) {
  const fixture = await nestedLifecycleWorkspace(t);
  const admission = await beginExample(fixture, 'EXECUTE_SLICE');
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', owner: admission.owner });
  t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
  const claim = path.relative(path.dirname(copy.candidateTaskArtifact), path.join(fixture.root, 'src/example.txt')).split(path.sep).join('/');
  let task = (await fs.readFile(copy.candidateTaskArtifact, 'utf8')).replace('- [ ] 1.1', '- [x] 1.1');
  task = replaceSection(task, 'Changed Areas', '- `' + claim + '`');
  await fs.writeFile(copy.candidateTaskArtifact, replaceSection(task, 'Diff Summary', '- Implementation completed before checking the captured response.'));
  const response = scopeRegressionPayload();
  response.commands = malformed ? [] : (await readRunnerVerification(fixture.requirements, 'slice-01')).checks.map(check => ({ command: verificationCommand(check), exit: 0 }));
  const captured = await captureExample(fixture, 'EXECUTE_SLICE', response, { admission });
  return { fixture, admission, copy, captured };
}

test("captured malformed output creates canonical recovery and rejects wrong authority", async (t) => {
  const { fixture, admission, copy, captured } = await ownedMalformedRecoveryFixture(t);
  const live = await treeBytes(fixture.execution);
  const receiptBytes = await fs.readFile(captured.receiptFile), responseBytes = await fs.readFile(captured.semanticResponseFile);
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs'),
    '--execution-bundle', '--operation', 'EXECUTE_SLICE', '--workspace', fixture.root,
    '--task-artifact', copy.candidateTaskArtifact, '--semantic-response-file', captured.semanticResponseFile,
    '--receipt-file', captured.receiptFile, '--insert-candidate',
  ], { encoding: 'utf8', env: { ...process.env, STNL_OPERATION_OWNER_FILE: admission.ownerFile } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).state, 'RUNNER_RESULT_BLOCKED');
  const candidate = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  assert.match(candidate, /## Delegation Blocker\n\n- Operation: EXECUTE_SLICE\n- Kind: malformed-output/u);
  assert.doesNotMatch(candidate, /^### implementation-check-/mu);
  const strict = await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot);
  assert.equal(strict.state, 'RUNNER_RESULT_BLOCKED');
  assert.equal(strict.mandatoryRecovery.operation, 'EXECUTE_SLICE');
  const blocker = candidate.split('## Delegation Blocker\n\n')[1].split('\n## ')[0].trim();
  const wrong = replaceSection(replaceSection(candidate, 'Delegation Blocker', '- none'), 'Scope Expansion', blocker);
  await fs.writeFile(copy.candidateTaskArtifact, wrong);
  await assert.rejects(validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot),
    /runner recovery in Scope Expansion instead of Delegation Blocker/u);
  assert.equal(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), wrong);
  await fs.writeFile(copy.candidateTaskArtifact, candidate);
  const receipt = JSON.parse(receiptBytes);
  await fs.writeFile(captured.receiptFile, JSON.stringify({ ...receipt, status: 'RUNNER_NOT_STARTED' }));
  const invalidReceipt = await fs.readFile(captured.receiptFile);
  try {
    await assert.rejects(persistMalformedRunnerResultInCandidate({
      taskArtifact: copy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', workspace: fixture.root, ...captured,
    }), /native receipt\/result\/origin binding differs/u);
    assert.deepEqual(await fs.readFile(captured.receiptFile), invalidReceipt);
    assert.equal(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), candidate);
  } finally { await fs.writeFile(captured.receiptFile, receiptBytes); }
  assert.deepEqual(await fs.readFile(captured.semanticResponseFile), responseBytes);
  assert.deepEqual(await treeBytes(fixture.execution), live);
  assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, 'RUNNER_RESULT_BLOCKED');
});

test("native malformed response preserves pending changed scope without allocating a check", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const first = await implementExample(fixture, { failFirst: true, publish: false });
  const task = first.copy.candidateTaskArtifact;
  const firstReceipt = await fs.readFile(first.captured.receiptFile);
  const sourceClaim = path.relative(path.dirname(task), path.join(fixture.root, 'src/example.txt')).split(path.sep).join('/');
  const lateClaim = path.relative(path.dirname(task), path.join(fixture.root, 'src/late.txt')).split(path.sep).join('/');
  const start = await startNativeRunnerCapture({ specPath: fixture.requirements, owner: first.admission.owner,
    workspace: fixture.root, captureParent: fixture.root, candidateTaskArtifact: task });
  const agentId = 'offline-pending-scope-' + randomUUID(); await bindNativeRunnerIdentity({ ...start, agentId });
  await fs.writeFile(path.join(fixture.root, 'src/example.txt'), 'changed after the last valid check\n');
  await fs.writeFile(path.join(fixture.root, 'src/late.txt'), 'new pending scope\n');
  const claims = [sourceClaim, lateClaim].sort();
  const scope = claims.map(p => '- `' + p + '`').join('\n');
  await fs.writeFile(task, replaceSection(await fs.readFile(task, 'utf8'), 'Changed Areas', scope));
  const captured = await captureNativeExample({ ...start, agentId }, { status: 'TESTS_PASS', commands: 'malformed' }, claims);
  const receipt = await fs.readFile(captured.receiptFile), response = await fs.readFile(captured.semanticResponseFile);
  await withExampleOwner(first.admission, async () => {
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs'),
      '--execution-bundle', '--operation', 'EXECUTE_SLICE', '--workspace', fixture.root, '--task-artifact', task,
      '--semantic-response-file', captured.semanticResponseFile, '--receipt-file', captured.receiptFile, '--insert-candidate'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).state, 'RUNNER_RESULT_BLOCKED');
  });
  const candidate = await fs.readFile(task, 'utf8');
  assert.ok(candidate.includes(first.bundle)); assert.ok(candidate.includes(scope));
  assert.doesNotMatch(candidate, /^### implementation-check-02$/mu);
  assert.equal((await validateExecutionCandidate(fixture.requirements, first.copy.candidateExecutionRoot)).state, 'RUNNER_RESULT_BLOCKED');
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: first.copy.candidateRoot });
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, 'RUNNER_RESULT_BLOCKED'); assert.equal(state.mandatoryRecovery.operation, 'EXECUTE_SLICE');
  assert.equal(state.tasks.get('slice-01').implementationChecks.length, 1);
  assert.ok((await fs.readFile(path.join(fixture.execution, 'tasks/slice-01.md'), 'utf8')).includes(scope));
  for (const [file, bytes] of [[first.captured.receiptFile, firstReceipt], [captured.receiptFile, receipt], [captured.semanticResponseFile, response]]) assert.deepEqual(await fs.readFile(file), bytes);
});

test("native malformed recovery rejects a missing producer error and a mismatched candidate marker", async (t) => {
  // Caller-supplied Error/diagnostic values are descriptive; only the captured
  // bytes can establish the canonical rejection in the current producer.
  const valid = await ownedMalformedRecoveryFixture(t, false);
  const validBefore = await treeBytes(valid.copy.candidateExecutionRoot), validLive = await treeBytes(valid.fixture.execution);
  const forgedError = new RunnerSemanticResultError('EXECUTE_SLICE', new Error('fabricated rejection'));
  for (const supplied of [{ error: null, diagnostic: null }, { error: forgedError, diagnostic: recoverableRunnerResultDiagnostic(forgedError) }]) {
    await assert.rejects(persistMalformedRunnerResultInCandidate({
      taskArtifact: valid.copy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', workspace: valid.fixture.root,
      ...valid.captured, ...supplied,
    }), /captured response has no canonical recoverable rejection/u);
    assert.deepEqual(await treeBytes(valid.copy.candidateExecutionRoot), validBefore);
    await assert.rejects(fs.access(valid.captured.receiptFile + '.rejection.json'), { code: 'ENOENT' });
  }
  assert.deepEqual(await treeBytes(valid.fixture.execution), validLive);

  const { fixture, copy, captured } = await ownedMalformedRecoveryFixture(t);
  const before = await treeBytes(copy.candidateExecutionRoot), live = await treeBytes(fixture.execution);
  const markerFile = copy.candidateRoot + '.copy.json';
  const markerBytes = await fs.readFile(markerFile), receiptBytes = await fs.readFile(captured.receiptFile);
  const marker = JSON.parse(markerBytes);
  await fs.writeFile(markerFile, JSON.stringify({ ...marker, slice: 'slice-99' }));
  const wrongMarker = await fs.readFile(markerFile);
  try {
    await assert.rejects(persistMalformedRunnerResultInCandidate({
      taskArtifact: copy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', workspace: fixture.root, ...captured,
    }), /candidate slice\/owner differs/u);
    assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before);
    assert.deepEqual(await fs.readFile(markerFile), wrongMarker);
    await assert.rejects(fs.access(captured.receiptFile + '.rejection.json'), { code: 'ENOENT' });
  } finally { await fs.writeFile(markerFile, markerBytes); }
  assert.equal((await persistMalformedRunnerResultInCandidate({
    taskArtifact: copy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', workspace: fixture.root, ...captured,
  })).state, 'RUNNER_RESULT_BLOCKED');
  const strict = await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot);
  assert.equal(strict.state, 'RUNNER_RESULT_BLOCKED');
  assert.equal(strict.mandatoryRecovery.operation, 'EXECUTE_SLICE');
  assert.doesNotMatch(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), /^### implementation-check-/mu);
  assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBytes);
  assert.deepEqual(await treeBytes(fixture.execution), live);
});

test("captured producer rejection resumes APPLY and VALIDATE through their own operations", async (t) => {
  for (const operation of ["APPLY_FINDINGS", "VALIDATE_SLICE"]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    fixture.exampleImplementation = await implementExample(fixture);
    if (operation === "APPLY_FINDINGS") await validateExample(fixture, { status: "NEEDS_FIX", findings: ACTIVE_FINDING });
    const admission = await beginExample(fixture, operation);
    const start = await nativeExample({ specPath: fixture.requirements, root: fixture.root }, admission.owner);
    const captured = await captureNativeExample(start, { status: "PASS", commands: "malformed" },
      operation === "APPLY_FINDINGS" ? ["../../src/example.txt"] : null);
    const receipt = await fs.readFile(captured.receiptFile), response = await fs.readFile(captured.semanticResponseFile);
    await withExampleOwner(admission, async () => {
      let candidateRoot;
      let candidateTaskArtifact;
      if (operation === "APPLY_FINDINGS") {
        const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01", owner: admission.owner });
        t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
        candidateRoot = copy.candidateExecutionRoot;
        candidateTaskArtifact = copy.candidateTaskArtifact;
        const liveBefore = await treeBytes(fixture.execution);
        const candidateBefore = await treeBytes(candidateRoot);
        const taskBefore = await fs.readFile(candidateTaskArtifact, "utf8");
        const cli = spawnSync(process.execPath, [path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
          "--execution-bundle", "--operation", operation, "--workspace", fixture.root, "--task-artifact", candidateTaskArtifact,
          "--semantic-response-file", captured.semanticResponseFile, "--receipt-file", captured.receiptFile, "--insert-candidate"], { encoding: "utf8" });
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(JSON.parse(cli.stdout).state, "RUNNER_RESULT_BLOCKED");
        const candidateAfter = await treeBytes(candidateRoot);
        assert.deepEqual(candidateAfter.filter(([file]) => file !== "tasks/slice-01.md"),
          candidateBefore.filter(([file]) => file !== "tasks/slice-01.md"));
        const taskAfter = await fs.readFile(candidateTaskArtifact, "utf8");
        assert.equal(replaceSection(taskAfter, "Delegation Blocker", "- none"), taskBefore);
        assert.match(taskAfter, /^- Kind: malformed-output$/mu);
        assert.deepEqual(await treeBytes(fixture.execution), liveBefore);
      } else {
        const candidateParent = await temporary(t, "stnl-operation-recovery-");
        const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent, owner: admission.owner });
        candidateRoot = copy.candidateExecutionRoot;
        candidateTaskArtifact = path.join(candidateRoot, "tasks/slice-01.md");
        const liveBefore = await treeBytes(fixture.execution);
        const candidateBefore = await treeBytes(candidateRoot);
        const taskBefore = await fs.readFile(candidateTaskArtifact, "utf8");
        const prepared = await prepareValidationCandidate({ specPath: fixture.requirements, slice: "1", workspace: fixture.root,
          candidateExecutionRoot: candidateRoot, ...captured });
        assert.equal(prepared.status, "RUNNER_RESULT_BLOCKED");
        const candidateAfter = await treeBytes(candidateRoot);
        assert.deepEqual(candidateAfter.filter(([file]) => file !== "tasks/slice-01.md"),
          candidateBefore.filter(([file]) => file !== "tasks/slice-01.md"));
        const taskAfter = await fs.readFile(candidateTaskArtifact, "utf8");
        assert.equal(replaceSection(taskAfter, "Delegation Blocker", "- none"), taskBefore);
        assert.match(taskAfter, /^- Kind: malformed-output$/mu);
        assert.deepEqual(await treeBytes(fixture.execution), liveBefore);
      }
      const strict = await validateExecutionCandidate(fixture.requirements, candidateRoot);
      assert.equal(strict.state, "RUNNER_RESULT_BLOCKED");
      assert.equal(strict.mandatoryRecovery.operation, operation);
      const task = await fs.readFile(candidateTaskArtifact, "utf8");
      assert.equal((task.match(/^### findings-check-/gmu) ?? []).length, 0);
      assert.equal((task.match(/^### attempt-/gmu) ?? []).length, operation === "APPLY_FINDINGS" ? 1 : 0);
    });
    assert.deepEqual(await fs.readFile(captured.receiptFile), receipt);
    assert.deepEqual(await fs.readFile(captured.semanticResponseFile), response);
  }
});


test("APPLY round two derives required correction fields from existing authority", async t => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  fixture.exampleImplementation = await implementExample(fixture);
  const needsFix = await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  const first = await correctExample(fixture, { content: 'incorrect attempted correction\n', fail: true, publish: false });
  const second = await retryFindingsExample(fixture, first, { content: VALIDATED_CONTENT, publish: false, insert: false });
  const taskArtifact = first.copy.candidateTaskArtifact;
  const before = await fs.readFile(taskArtifact), receipt = await fs.readFile(second.captured.receiptFile), live = await treeBytes(fixture.execution);
  const consume = options => serializeRunnerExecutionBundleFromResponse({ operation: 'APPLY_FINDINGS', response: JSON.stringify(second.response), workspace: fixture.root, taskArtifact, ...options });
  assert.equal(await consume(second.captured), second.bundle);
  assert.deepEqual(parseSemanticExecutionPayload(JSON.stringify(second.response), 'APPLY_FINDINGS'), second.response);
  const missingRound = { ...second.response }; delete missingRound.automaticCheckRound;
  assert.throws(() => parseSemanticExecutionPayload(JSON.stringify(missingRound), 'APPLY_FINDINGS'), /Automatic check round is invalid/);
  await assert.rejects(consume({ automaticCheckRound: '2/3' }), /native runner requires origin-bound receipt and response/);
  assert.ok(second.bundle.includes('- Prior-round failure: ' + first.response.failures));
  assert.ok(second.bundle.includes('- Correction applied: ' + second.response.correctionsCovered));
  assert.ok(second.bundle.includes('- In-slice rationale: ' + second.response.selectionRationale));
  assert.ok(second.bundle.includes('- Findings cycle: attempt-01'));
  assert.deepEqual(await fs.readFile(taskArtifact), before); assert.deepEqual(await fs.readFile(second.captured.receiptFile), receipt);
  assert.deepEqual(await treeBytes(fixture.execution), live);
  await insertExecutionEvidenceInCandidate({ taskArtifact, operation: 'APPLY_FINDINGS', bundle: second.bundle,
    validateProspectiveTask: text => validateExecutionCandidate(fixture.requirements, first.copy.candidateExecutionRoot, [text]) });
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: first.copy.candidateRoot });
  const task = (await inspectExecutionState(fixture.requirements)).tasks.get('slice-01');
  assert.deepEqual(task.findingsChecks.map(c => [c.round, c.status]), [[1, 'TESTS_FAIL'], [2, 'TESTS_PASS']]);
  assert.ok(task.sections.get('Findings Test Evidence').includes(first.bundle));
  assert.equal(JSON.parse(await fs.readFile(needsFix.captured.receiptFile)).semanticResponseStatus, 'NEEDS_FIX');
});

test("executor contract keeps intermediate failures private before correction and terminal publication", async () => {
  const skill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  assert.match(skill, /Persist every valid result append-only in the isolated candidate via the serializer before deciding what follows/u);
  assert.match(skill, /After `TESTS_FAIL` in round one or two, this private append is the required persistence before correction; do not run the publication validator or publisher yet/u);
  assert.match(skill, /For both `EXECUTE_SLICE` and `APPLY_FINDINGS`, keep intermediate `TESTS_FAIL` records private while applying the authorized correction and obtaining the next runner result within the existing three-call budget/u);
  assert.match(skill, /Only when the bounded cycle ends in `TESTS_PASS`, `TESTS_NOT_APPLICABLE`, round `3\/3 TESTS_FAIL`, or a canonical blocking outcome, execute/u);
  assert.match(skill, /Never mutate or republish a rejected candidate/u);
  assert.match(skill, /Never make a fourth automatic invocation/u);
  const qualityManager = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/SKILL.md"), "utf8");
  for (const contract of [skill, qualityManager]) {
    assert.match(contract, /pass its absolute `receiptFile` literally to `--receipt-file`/u);
    assert.match(contract, /Do not transcribe the receipt JSON, copy it to another path, or reconstruct its filename/u);
  }
});

test("prepared fixture failure uses existing execution correction and preserves both rounds", async t => {
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS']) {
    const f = await standaloneWorkspace(t);
    await fs.mkdir(path.join(f.root, 'src'));
    const fixtureFile = path.join(f.root, 'src/prepared-fixture.json');
    const checkFile = path.join(f.root, 'src/prepared-check.mjs');
    const checkSource = "import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(typeof JSON.parse(fs.readFileSync('src/prepared-fixture.json','utf8')).enabled,'boolean','prepared fixture enabled must be boolean');\n";
    await fs.writeFile(fixtureFile, JSON.stringify({ enabled: true })); await fs.writeFile(checkFile, checkSource);
    f.verificationRecipe = '- Recipe: ' + JSON.stringify({ format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.',
      checks: [{ id: 'verification-01', executable: { literal: 'node' }, args: [{ file: { kind: 'product', path: 'src/prepared-check.mjs' } }],
        inputs: [{ kind: 'product', path: 'src/prepared-fixture.json' }] }], dependencyReview: 'The unchanged assertion reads the explicitly typed JSON fixture in the authorized src directory.' });
    await renderArtifacts(f);
    if (operation === 'APPLY_FINDINGS') {
      await implementExample(f); await validateExample(f, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
    }
    const before = await inspectExecutionState(f.requirements), prior = before.tasks.get('slice-01');
    const admission = await beginExample(f, operation);
    let start = await nativeExample({ specPath: f.requirements, root: f.root }, admission.owner);
    const copy = await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-01', owner: admission.owner });
    t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
    const fixtureClaim = '../../src/prepared-fixture.json';
    const claims = operation === 'APPLY_FINDINGS' ? ['../../src/example.txt', fixtureClaim] : [fixtureClaim];
    let text = (await fs.readFile(copy.candidateTaskArtifact, 'utf8')).replace('- [ ] 1.1', '- [x] 1.1');
    text = replaceSection(text, 'Changed Areas', claims.map(claim => '- `' + claim + '`').join('\n'));
    text = replaceSection(text, 'Diff Summary', '- Corrected a typed prepared fixture without weakening its assertion.');
    if (operation === 'APPLY_FINDINGS') text = replaceSection(text, 'Corrections Applied', '- `' + fixtureClaim + '`');
    await fs.writeFile(copy.candidateTaskArtifact, text);
    const receipts = [], bundles = [], calls = []; let rejectedCopy, rejectedImage;
    const cli = (label, helper, args) => {
      calls.push(label);
      const env = { ...process.env, STNL_OPERATION_OWNER_FILE: admission.ownerFile };
      delete env.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, [path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime', helper), ...args],
        { cwd: f.root, env, encoding: 'utf8' });
    };
    for (const round of [1, 2]) {
      if (round === 2) {
        start = await startNativeRunnerCapture({ specPath: f.requirements, owner: admission.owner, workspace: f.root,
          captureParent: f.root, candidateTaskArtifact: copy.candidateTaskArtifact });
        start.agentId = 'prepared-correction-' + randomUUID(); await bindNativeRunnerIdentity(start);
        await fs.writeFile(copy.candidateTaskArtifact, replaceSection(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), 'Corrections Applied', '- `' + fixtureClaim + '`'));
        calls.push('authorized correction');
      }
      await fs.writeFile(fixtureFile, JSON.stringify({ enabled: round === 1 ? 'true' : true }));
      const inputs = await Promise.all([fixtureFile, checkFile].map(file => fs.readFile(file)));
      const payload = { ...scopeRegressionPayload(), status: round === 1 ? 'TESTS_FAIL' : 'TESTS_PASS', automaticCheckRound: round + '/3',
        commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: round === 1 ? 1 : 0 })),
        failures: round === 1 ? 'prepared fixture enabled must be boolean' : 'none',
        resultOfEachCommandAndExitCode: 'Unchanged typed assertion exit ' + (round === 1 ? 1 : 0),
        evidenceOrFailureSummary: round === 1 ? 'Prepared fixture has a string where boolean is required' : 'Corrected only the fixture type; unchanged assertion passes' };
      if (operation === 'EXECUTE_SLICE') Object.assign(payload, { priorRoundFailure: round === 1 ? 'none' : 'prepared fixture enabled must be boolean',
        correctionApplied: round === 1 ? 'none' : 'Changed the authorized fixture enabled field from string to boolean', inSliceRationale: round === 1 ? 'none' : 'Same approved fixture and unchanged assertion' });
      else {
        for (const key of ['priorRoundFailure', 'correctionApplied', 'inSliceRationale']) delete payload[key];
        Object.assign(payload, { findingsCycle: 'attempt-01', findingsVerified: 'finding-01', correctionsCovered: 'Corrected the authorized prepared fixture type', regressionsSelected: 'Same unchanged prepared assertion', unsupportedActiveFindings: 'none' });
      }
      calls.push('observed round ' + round);
      const captured = await captureNativeExample(start, payload, claims);
      assert.deepEqual(await Promise.all([fixtureFile, checkFile].map(file => fs.readFile(file))), inputs, 'actual runner verification is read-only');
      receipts.push([captured.receiptFile, await fs.readFile(captured.receiptFile)]);
      const bundle = await serializeRunnerExecutionBundleFromResponse({ operation, response: JSON.stringify(payload), workspace: f.root,
        taskArtifact: copy.candidateTaskArtifact, ...captured }); bundles.push(bundle);
      await withExampleOwner(admission, async () => {
        const inserted = cli('serialize ' + round, 'serialize-runner-evidence.mjs', [
          '--execution-bundle', '--operation', operation, '--workspace', f.root, '--task-artifact', copy.candidateTaskArtifact,
          '--semantic-response-file', captured.semanticResponseFile, '--receipt-file', captured.receiptFile, '--insert-candidate']);
        assert.equal(inserted.status, 0, inserted.stderr);
        assert.match(inserted.stdout, new RegExp((operation === 'EXECUTE_SLICE' ? 'implementation' : 'findings') + '-check-0' + round + ' inserted into isolated candidate'));
      });
      const insertedTask = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
      assert.equal(insertedTask.split(bundle).length - 1, 1, 'CLI inserted the API bundle exactly once');
      const section = sectionBodyForScopeTest(insertedTask,
        operation === 'EXECUTE_SLICE' ? 'Implementation Test Evidence' : 'Findings Test Evidence');
      assert.equal((section.match(/^### (?:implementation|findings)-check-[0-9]+$/gmu) ?? []).length, round,
        'CLI inserted no extra or duplicate checks in this cycle');
      await validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot, [{ slice: 'slice-01', text: await fs.readFile(copy.candidateTaskArtifact, 'utf8') }], round === 1
        ? { privateAutomaticCheck: { operation, slice: 'slice-01', round: 1 } } : {});
      if (round === 1) {
        const negativePrepare = cli('negative prepare', 'prepare-execution-copy.mjs',
          ['--prepare', '--spec-path', f.requirements, '--slice', 'slice-01']);
        assert.equal(negativePrepare.status, 0, negativePrepare.stderr);
        rejectedCopy = JSON.parse(negativePrepare.stdout);
        t.after(() => fs.rm(rejectedCopy.candidateRoot, { recursive: true, force: true }));
        await fs.copyFile(copy.candidateTaskArtifact, rejectedCopy.candidateTaskArtifact);
        const live = await treeBytes(f.execution); rejectedImage = await treeBytes(rejectedCopy.candidateExecutionRoot);
        if (operation === 'EXECUTE_SLICE') await assert.rejects(validateExecutionCandidate(f.requirements, rejectedCopy.candidateExecutionRoot), /unterminated.*automatic correction cycle/);
        else assert.equal((await validateExecutionCandidate(f.requirements, rejectedCopy.candidateExecutionRoot)).state, 'VALIDATION_NEEDS_FIX', 'a persisted correction scope is readable, but cannot end its owned failed round');
        const negativeValidate = cli('negative validate', 'validate-execution-state.mjs',
          [f.requirements, '--candidate', rejectedCopy.candidateExecutionRoot]);
        assert.equal(negativeValidate.status, operation === 'EXECUTE_SLICE' ? 1 : 0, negativeValidate.stderr);
        if (operation === 'EXECUTE_SLICE') assert.match(negativeValidate.stderr, /unterminated.*automatic correction cycle/u);
        else assert.match(negativeValidate.stdout, /state=VALIDATION_NEEDS_FIX/u);
        const rejectedCli = cli('negative publish', 'prepare-execution-copy.mjs', [
          '--publish', '--spec-path', f.requirements, '--slice', 'slice-01', '--candidate-root', rejectedCopy.candidateRoot]);
        assert.equal(rejectedCli.status, 1);
        assert.match(rejectedCli.stderr, operation === 'EXECUTE_SLICE'
          ? /unterminated.*automatic correction cycle/u : /terminal publication requires the bounded operation result/u);
        assert.deepEqual(await treeBytes(f.execution), live); assert.deepEqual(await treeBytes(rejectedCopy.candidateExecutionRoot), rejectedImage);
      }
      assert.throws(() => parseSemanticExecutionPayload(JSON.stringify({ ...payload, automaticCheckRound: '4/3' }), operation), /Automatic check round is invalid/);
    }
    const expected = operation === 'EXECUTE_SLICE' ? 'IMPLEMENTED_AWAITING_VALIDATION' : 'FINDINGS_CORRECTED';
    assert.equal((await validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot)).state, expected);
    const terminalCli = cli('terminal validate', 'validate-execution-state.mjs',
      [f.requirements, '--candidate', copy.candidateExecutionRoot]);
    assert.equal(terminalCli.status, 0, terminalCli.stderr);
    assert.match(terminalCli.stdout, new RegExp('state=' + expected, 'u'));
    const publication = cli('terminal publish', 'prepare-execution-copy.mjs', [
      '--publish', '--spec-path', f.requirements, '--slice', 'slice-01', '--candidate-root', copy.candidateRoot]);
    assert.equal(publication.status, 0, publication.stderr);
    const state = await inspectExecutionState(f.requirements), task = state.tasks.get('slice-01');
    const checks = operation === 'EXECUTE_SLICE' ? task.implementationChecks : task.findingsChecks;
    assert.deepEqual(checks.map(check => [check.round, check.status]), [[1, 'TESTS_FAIL'], [2, 'TESTS_PASS']]);
    assert.ok(task.sections.get(operation === 'EXECUTE_SLICE' ? 'Implementation Test Evidence' : 'Findings Test Evidence').includes(bundles[0]));
    assert.match(bundles[1], /- Correction paths: \.\.\/\.\.\/src\/prepared-fixture\.json/);
    if (operation === 'APPLY_FINDINGS') {
      assert.equal(task.attempts[0].body, prior.attempts[0].body); assert.equal(task.findings[0].body, prior.findings[0].body);
    }
    assert.equal(task.final.result, 'pending'); assert.equal(state.normalHandoff.operation, 'VALIDATE_SLICE');
    const handoff = cli('handoff', 'validate-execution-state.mjs', [f.requirements, '--handoff-after', operation]);
    assert.equal(handoff.status, 0, handoff.stderr);
    assert.equal(JSON.parse(handoff.stdout).normal_handoff.operation, 'VALIDATE_SLICE');
    assert.deepEqual(calls, ['observed round 1', 'serialize 1', 'negative prepare', 'negative validate',
      'negative publish', 'authorized correction',
      'observed round 2', 'serialize 2', 'terminal validate', 'terminal publish', 'handoff']);
    assert.equal(await fs.readFile(checkFile, 'utf8'), checkSource);
    assert.deepEqual(await treeBytes(rejectedCopy.candidateExecutionRoot), rejectedImage);
    for (const [file, bytes] of receipts) assert.deepEqual(await fs.readFile(file), bytes);
  }
});

test("objective permission and unavailable-input blockers retain auxiliary recovery without automatic correction", async (t) => {
  // Fake responses/events exercise the existing BLOCKED carrier and recovery;
  // they do not claim deterministic recognition of an environmental cause.
  for (const operation of ["EXECUTE_SLICE", "APPLY_FINDINGS"]) {
    for (const cause of ["sandbox permission denied: operation not permitted", "required external input is genuinely unavailable"]) {
      const fixture = await nestedLifecycleWorkspace(t);
      const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
      const claim = path.relative(path.dirname(taskArtifact), path.join(fixture.root, "src/example.txt")).split(path.sep).join("/");
      await editTask(fixture, (value) => {
        let task = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", `- \`${claim}\``);
        if (operation === "APPLY_FINDINGS") {
          task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll("../../src/example.txt", claim));
          task = replaceSection(task, "Validation Attempts", NEEDS_FIX_ATTEMPT.replaceAll("../../src/example.txt", claim));
          task = replaceSection(task, "Validation Findings", ACTIVE_FINDING);
          task = replaceSection(task, "Corrections Applied", `- \`${claim}\``);
        }
        return task;
      });
      const before = await fs.readFile(taskArtifact);
      const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
      t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
      const permissionDenied = cause.startsWith("sandbox");
      const commands = permissionDenied ? [{ command: "STNL_VERIFICATION_COMMAND=1 node prepared-check.mjs", exit: 1 }] : [];
      const payload = {
        status: "BLOCKED", automaticCheckRound: "1/3", head: "fixture-head",
        discoverySources: "task and check prerequisites", discoveryActions: "inspected available inputs",
        verificationTypesConsidered: "prepared check", nonApplicabilityRationale: "none",
        noVerificationCommandConfirmation: permissionDenied ? "command denied" : "no verification command executed",
        commands, resultOfEachCommandAndExitCode: cause, selectedChecks: "prepared check",
        selectionRationale: "required input and permissions", coverage: "behavior remains unverified",
        failures: cause, evidenceOrFailureSummary: cause, affectedFilesOrBehaviors: "approved behavior",
        blockers: `${cause}; official handoff and prerequisite resolution required`, unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes",
        ...(operation === "EXECUTE_SLICE" ? { priorRoundFailure: "none", correctionApplied: "none", inSliceRationale: "none" }
          : { findingsCycle: "attempt-01", findingsVerified: "none", correctionsCovered: "none", regressionsSelected: "none", unsupportedActiveFindings: "finding-01" }),
      };
      const captured = await capturedVerificationSequence(t, fixture, operation, JSON.stringify(payload), [], commands);
      const receipt = JSON.parse(await fs.readFile(captured.receiptFile, "utf8"));
      if (commands.length === 0) {
        await fs.writeFile(receipt.eventsPath, JSON.stringify({
          operationId: `runner-001-${operation.toLowerCase()}-slice-01-attempt-1`, type: "thread.started", thread_id: "fixture-thread",
        }) + "\n");
      } else {
        const events = (await fs.readFile(receipt.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
        for (const event of events) if (event.type === "item.completed") event.item.aggregated_output = cause;
        await fs.writeFile(receipt.eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      }
      const eventsBefore = await fs.readFile(receipt.eventsPath);
      const bundle = await serializeRunnerExecutionBundleFromResponse({ operation, response: JSON.stringify(payload),
        workspace: fixture.root, taskArtifact: copy.candidateTaskArtifact, ...captured });
      await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation, bundle });
      const blocked = await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot);
      assert.equal(blocked.state, "AUXILIARY_BLOCKED");
      assert.equal(blocked.mandatoryRecovery.operation, operation);
      assert.equal(blocked.mandatoryRecovery.slice, "slice-01");
      assert.equal(blocked.mandatoryRecovery.sameOperationResumeRequired, true);
      assert.equal(recoverableRunnerHandoff({ operation, slice: "slice-01",
        outcome: { result: "BLOCKED", blocker: "OFFICIAL_AUXILIARY_BLOCKED" },
        readback: { executionRaw: blocked }, priorOperations: [], remainingTurns: 10 }), null);
      assert.match(bundle, /Status: BLOCKED/u);
      assert.ok(bundle.includes(cause));
      assert.deepEqual(await fs.readFile(taskArtifact), before);
      assert.deepEqual(await fs.readFile(receipt.eventsPath), eventsBefore);
      assert.doesNotMatch(await fs.readFile(copy.candidateTaskArtifact, "utf8"), /Correction applied:|Correction paths:/u);
    }
  }
});

test("deterministic runner response capture preserves the final object and rejects wrappers", async (t) => {
  const root = await temporary(t, "stnl-runner-response-capture-");
  const structured = path.join(root, "runner.jsonl");
  const output = path.join(root, "semantic-response.json");
  const semantic = {
    status: "TESTS_PASS",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  };
  const structuredOutput = [
    { type: "thread.started" },
    { type: "item.completed", item: { type: "command_execution", exit_code: 0 } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(semantic) } },
    { type: "turn.completed" },
  ].map((event) => JSON.stringify(event)).join("\n");
  await fs.writeFile(structured, `${structuredOutput}\n`, "utf8");

  const captured = await captureRunnerResponse({ structuredOutputFile: structured, outputFile: output });
  assert.equal(captured.status, "PASS");
  assert.equal(await fs.readFile(output, "utf8"), JSON.stringify(semantic));

  const wrappedStructured = path.join(root, "wrapped.jsonl");
  const wrappedOutput = path.join(root, "wrapped-response.json");
  await fs.writeFile(wrappedStructured, `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(JSON.stringify(semantic)) },
  })}\n`, "utf8");
  await assert.rejects(
    captureRunnerResponse({ structuredOutputFile: wrappedStructured, outputFile: wrappedOutput }),
    /must be one JSON object, not a JSON string/u,
  );
  await assert.rejects(fs.lstat(wrappedOutput));

  const proseStructured = path.join(root, "prose.jsonl");
  await fs.writeFile(proseStructured, `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "runner summary" },
  })}\n`, "utf8");
  await assert.rejects(
    captureRunnerResponse({ structuredOutputFile: proseStructured, outputFile: path.join(root, "prose-response.json") }),
    /final runner message is not valid JSON/u,
  );
});

test("runner response schema closes every semantic operation shape", async () => {
  const schemaPath = path.join(
    ROOT,
    "skills/workflows/stnl-slice-executor/runtime/runner-semantic-response.schema.json",
  );
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  assert.equal(schema.oneOf.length, 3);
  for (const branch of schema.oneOf) {
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
    const optional = branch.title === "VALIDATE_SLICE" ? [] : ["filelessReason", "automaticCheckRound", ...(branch.title === "APPLY_FINDINGS" ? ["findingsCycle"] : [])];
    assert.deepEqual(Object.keys(branch.properties).sort(), [...branch.required, ...optional].sort());
    assert.deepEqual(Object.keys(branch.properties.commands), ["$ref"]);
  }
  const commandSchema = schema.$defs.commands.items;
  assert.equal(commandSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(commandSchema.properties).sort(), ["command", "exit"]);
  assert.deepEqual([...commandSchema.required].sort(), ["command", "exit"]);
});

test("provider response schemas use one closed object root per operation", async () => {
  const runtime = path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime");
  const schemas = [
    ["EXECUTE_SLICE", "runner-execute-response.schema.json"],
    ["APPLY_FINDINGS", "runner-apply-findings-response.schema.json"],
    ["VALIDATE_SLICE", "runner-validate-response.schema.json"],
  ];
  const logical = JSON.parse(await fs.readFile(path.join(runtime, "runner-semantic-response.schema.json"), "utf8"));
  for (const [operation, filename] of schemas) {
    const schema = JSON.parse(await fs.readFile(path.join(runtime, filename), "utf8"));
    const branch = logical.oneOf.find((candidate) => candidate.title === operation);
    assert.ok(branch);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(branch.properties).sort());
    assert.deepEqual([...schema.required].sort(), [...branch.required].sort());
    if (operation === "APPLY_FINDINGS") {
      for (const roundTwoOnlyField of ["priorRoundFailure", "correctionApplied", "inSliceRationale"]) {
        assert.equal(Object.hasOwn(schema.properties, roundTwoOnlyField), false);
        assert.equal(Object.hasOwn(branch.properties, roundTwoOnlyField), false);
        assert.equal(branch.required.includes(roundTwoOnlyField), false);
      }
    }
    const commandSchema = schema.properties.commands;
    assert.equal(commandSchema.type, "array");
    assert.equal(commandSchema.items.additionalProperties, false);
    assert.deepEqual(Object.keys(commandSchema.items.properties).sort(), ["command", "exit"]);
    assert.deepEqual([...commandSchema.items.required].sort(), ["command", "exit"]);
  }
});

test("SPEC_PATH rejects directory and file traversal through symlink ancestors", async (t) => {
  const root = await temporary(t);
  const real = path.join(root, "real-project");
  const fixture = { root: real, requirements: path.join(real, "requirements.md"), execution: path.join(real, "requirements-execution") };
  await fs.mkdir(real, { recursive: true });
  await fs.mkdir(path.join(real, ".git"));
  await fs.writeFile(fixture.requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  await renderArtifacts(fixture);
  const alias = path.join(root, "alias-project");
  await fs.symlink(real, alias, "dir");
  await assert.rejects(inspectExecutionState(alias), /symlink component/u);
  await assert.rejects(inspectExecutionState(path.join(alias, "requirements.md")), /symlink component/u);
});


test("planning coverage has one reference for full AC delivery and bounded requirement contributions", async () => {
  const planner = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/SKILL.md"), "utf8");
  const reviewer = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-plan-reviewer/SKILL.md"), "utf8");
  const global = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  const detail = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  assert.match(planner, /Every condition has an integral owner and proof capable of observing it/);
  assert.match(planner, /Never invent a requirement ID or claim full acceptance for partial work/);
  assert.match(reviewer, /exact requirement ID and observable condition, complete\/partial contributions and integral owners/);
  assert.match(reviewer, /structurally valid test that observes a different property is insufficient/);
  assert.match(global, /Requirements \| Authorized areas \| Detailed plan/);
  assert.match(global, /only joint independent REVIEW_PLAN activates execution/);
  assert.match(detail, /Assigning an AC to this slice commits it to the complete criterion/u);
  assert.match(detail, /existing requirement ID[\s\S]{0,160}bounded partial result/u);
  assert.match(detail, /every AC must have a complete delivery/u);
  assert.match(detail, /preparation[\s\S]{0,160}authorized implementation and test paths/u);
  assert.match(detail, /partial contribution still requires checks for its own observable result/u);
  assert.match(detail, /Do not invent requirement IDs/u);
  assert.doesNotMatch(reviewer, /For each slice requiring executable evidence/u, "replace the former separate coverage rule rather than stacking it");
});

test("plan candidate gate enforces current-slice check path declarations, not semantic AC readiness", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "draft" });
  await fs.appendFile(path.join(fixture.requirements, "feature_spec.md"),
    "\n## Planning coverage regression\n\n- REQ-FILTER: Select records by completion state.\n"
    + "- AC-FILTER: CLI list --completed and --pending return matching JSON lines, exit zero, empty stderr and unchanged storage bytes.\n");
  await renderArtifacts(fixture, { materialized: false, planStatus: "draft" });
  const livePaths = ["plan.md", "plans/slice-01.md"];
  const liveBytes = await Promise.all(livePaths.map((relative) => fs.readFile(path.join(fixture.execution, relative))));
  const source = "src/cli.mjs";
  const check = "test/list.test.mjs";
  const checkFixtures = "test/fixtures";
  const detailClaim = (target) => path.relative(path.join(fixture.execution, "plans"), path.join(fixture.root, target)).split(path.sep).join("/");

  async function proposal(name, { declareCurrentCheck = false, globalCurrentCheck = false } = {}) {
    const candidate = path.join(await temporary(t, `stnl-evidence-plan-${name}-`), "execution");
    await fs.cp(fixture.execution, candidate, { recursive: true });
    const later = globalCurrentCheck ? "test/integration.test.mjs" : check;
    const areas = globalCurrentCheck ? `\`${source}\`, \`${check}\`, \`${checkFixtures}\`` : `\`${source}\``;
    const global = replaceSection(liveBytes[0].toString("utf8"), "Serial Slice Order",
      "| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |\n"
      + "|---|---|---|---|---|---|\n"
      + `| 01 - CLI filters | Filtered lists | - | AC-001 | ${areas} | plans/slice-01.md |\n`
      + `| 02 - Integration | Integration checks | 01 | AC-001 | \`${later}\` | plans/slice-02.md |`);
    await fs.writeFile(path.join(candidate, "plan.md"), global);
    let first = replaceSection(liveBytes[1].toString("utf8"), "Likely Areas",
      `- \`${detailClaim(source)}\` — CLI implementation`
      + (declareCurrentCheck ? `\n- \`${detailClaim(check)}\` — prepare runnable filter checks in this slice` : "")
      + (globalCurrentCheck ? `\n- \`${detailClaim(checkFixtures)}\` — prepare filter fixtures in this slice` : ""));
    first = replaceSection(first, "Expected Tests", `- node --test ${check}; prove every CLI filter acceptance criterion`);
    first = replaceSection(first, "Included Scope", "- Implement CLI filters and prepare their runnable checks before independent validation.");
    await fs.writeFile(path.join(candidate, "plans/slice-01.md"), first);
    let second = first.replace("# Slice 01 - Delivery", "# Slice 02 - Integration").replace("- Slice: 01", "- Slice: 02");
    second = replaceSection(second, "Likely Areas", `- \`${detailClaim(later)}\` — later checks`);
    second = replaceSection(second, "Included Scope", "- Broaden integration coverage after slice 01 has its own evidence.");
    second = replaceSection(second, "Expected Tests", `- node --test ${later}`);
    second = replaceSection(second, "Dependencies", "- slice-01");
    await fs.writeFile(path.join(candidate, "plans/slice-02.md"), second);
    return candidate;
  }

  // This reproduces the old allocation shape without modifying that run. The
  // existing deterministic gate cannot judge prose/AC coverage: REVIEW_PLAN's
  // semantic review must reject evidence deferred to slice 02. Do not claim a
  // structural PASS proves readiness or authorize undeclared test preparation.
  const deferred = await proposal("deferred");
  assert.equal((await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: deferred })).candidateValidation.state,
    "PLANNED_DRAFT");
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"), /PLANNED_DRAFT/u);

  const inconsistent = await proposal("inconsistent", { declareCurrentCheck: true });
  const rejectedPaths = ["plan.md", "plans/slice-01.md", "plans/slice-02.md"];
  const rejectedBytes = await Promise.all(rejectedPaths.map((relative) => fs.readFile(path.join(inconsistent, relative))));
  await assert.rejects(serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: inconsistent }),
    /slice-01 plan Likely Areas contains more path claims than its global slice row/u);
  assert.deepEqual(await Promise.all(rejectedPaths.map((relative) => fs.readFile(path.join(inconsistent, relative)))), rejectedBytes);

  const coherent = await proposal("coherent", { declareCurrentCheck: true, globalCurrentCheck: true });
  const accepted = await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: coherent });
  assert.equal(accepted.status, "PASS");
  assert.equal(accepted.candidateValidation.state, "PLANNED_DRAFT");
  assert.equal(accepted.serializedClaims, 4);
  const validated = await validateExecutionCandidate(fixture.requirements, coherent);
  assert.equal(validated.state, "PLANNED_DRAFT");
  const firstPlan = await fs.readFile(path.join(coherent, "plans/slice-01.md"), "utf8");
  assert.ok(firstPlan.includes(`\`${detailClaim(check)}\` — prepare runnable filter checks in this slice`));
  assert.equal(path.resolve(fixture.execution, "plans", detailClaim(check)), path.join(fixture.root, check));

  // Model review owns this distinction. Reproduce the service/CLI split and
  // show that changing its declared coverage does not change structural PASS.
  const partial = await proposal("bounded-contribution", { declareCurrentCheck: true, globalCurrentCheck: true });
  const service = "src/todo-service.mjs", serviceCheck = "test/todo-service.test.mjs";
  await fs.writeFile(path.join(partial, "plan.md"), replaceSection(liveBytes[0].toString("utf8"), "Serial Slice Order",
    "| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |\n"
    + "|---|---|---|---|---|---|\n"
    + `| 01 - Service selection | In-memory selection | - | REQ-FILTER | \`${service}\`, \`${serviceCheck}\` | plans/slice-01.md |\n`
    + `| 02 - CLI delivery | Complete filtered list acceptance | 01 | AC-FILTER | \`${source}\`, \`${check}\`, \`${checkFixtures}\` | plans/slice-02.md |`));
  let servicePlan = replaceSection(firstPlan, "Requirements", "- REQ-FILTER — bounded partial contribution: in-memory selection; complete AC-FILTER belongs to slice-02.");
  servicePlan = replaceSection(servicePlan, "Objective and Observable Result", "Select matching records in memory and preserve their order.");
  servicePlan = replaceSection(servicePlan, "Included Scope", "- Service selection and its prepared unit checks.");
  servicePlan = replaceSection(servicePlan, "Out of Scope and Boundaries", "- CLI flags, JSON output, exit codes, stderr and storage immutability belong to slice-02.");
  servicePlan = replaceSection(servicePlan, "Likely Areas", `- \`${detailClaim(service)}\` — service selection\n- \`${detailClaim(serviceCheck)}\` — prepare service unit checks`);
  servicePlan = replaceSection(servicePlan, "Expected Tests", `- node --test ${serviceCheck}; verify matching records and order in memory.`);
  servicePlan = replaceSection(servicePlan, "Completion Criterion", "- Matching records and order are verified; complete CLI acceptance remains assigned to slice-02.");
  await fs.writeFile(path.join(partial, "plans/slice-01.md"), servicePlan);
  let cliPlan = firstPlan.replace("# Slice 01 - Delivery", "# Slice 02 - CLI delivery").replace("- Slice: 01", "- Slice: 02");
  cliPlan = replaceSection(cliPlan, "Requirements", "- AC-FILTER — complete delivery of both filters, JSON output, exit codes, stderr and unchanged storage bytes.");
  cliPlan = replaceSection(cliPlan, "Dependencies", "- slice-01");
  cliPlan = replaceSection(cliPlan, "Expected Tests", `- node ${check} ${source} test/fixtures; exercise all filter conditions and storage bytes.`);
  await fs.writeFile(path.join(partial, "plans/slice-02.md"), cliPlan);
  assert.equal((await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: partial })).candidateValidation.state, "PLANNED_DRAFT");

  const misassigned = path.join(await temporary(t, "stnl-partial-as-complete-"), "execution");
  await fs.cp(partial, misassigned, { recursive: true });
  const globalPartial = await fs.readFile(path.join(partial, "plan.md"), "utf8");
  await fs.writeFile(path.join(misassigned, "plan.md"), globalPartial.replace("| REQ-FILTER |", "| AC-FILTER |"));
  await fs.writeFile(path.join(misassigned, "plans/slice-01.md"), replaceSection(servicePlan, "Requirements", "- AC-FILTER"));
  assert.equal((await validateExecutionCandidate(fixture.requirements, misassigned)).state, "PLANNED_DRAFT",
    "a semantically inconsistent full AC assignment is structurally valid; only independent model review can reject it");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");

  // Reuse the prepared acceptance check on actual local CLI implementations.
  // No model verdict is injected or interpreted as semantic plan approval.
  await fs.cp(path.join(ROOT, "benchmarks/sentinel-todo/seed/src"), path.join(fixture.root, "src"), { recursive: true });
  await fs.mkdir(path.join(fixture.root, "test/fixtures"), { recursive: true });
  await fs.copyFile(path.join(ROOT, "scripts/fixtures/prepared-list-check.mjs"), path.join(fixture.root, check));
  for (const [name, todos] of [["mixed", [{ id: 2, title: "done", completed: true }, { id: 1, title: "pending", completed: false }]],
    ["empty", []], ["pending", [{ id: 1, title: "pending", completed: false }]]]) {
    await fs.writeFile(path.join(fixture.root, "test/fixtures", `${name}.json`), JSON.stringify({ todos }, null, 3) + "\n");
  }
  const fixturesBefore = await treeBytes(path.join(fixture.root, "test/fixtures"));
  const checkPrepared = () => spawnSync(process.execPath, [path.join(fixture.root, check), path.join(fixture.root, source),
    path.join(fixture.root, "test/fixtures")], { encoding: "utf8" });
  const incompleteDelivery = checkPrepared();
  assert.equal(incompleteDelivery.status, 1);
  assert.match(incompleteDelivery.stderr, /AssertionError/u);
  assert.deepEqual(await treeBytes(path.join(fixture.root, "test/fixtures")), fixturesBefore);
  await fs.copyFile(path.join(ROOT, "scripts/fixtures/filtered-cli.mjs"), path.join(fixture.root, source));
  const completeDelivery = checkPrepared();
  assert.equal(completeDelivery.status, 0, completeDelivery.stderr);
  assert.match(completeDelivery.stdout, /40 list\/filter\/invalid-flag cases/u);
  assert.deepEqual(await treeBytes(path.join(fixture.root, "test/fixtures")), fixturesBefore);
  assert.deepEqual(await Promise.all(livePaths.map((relative) => fs.readFile(path.join(fixture.execution, relative)))), liveBytes);
  await assert.rejects(fs.stat(path.join(coherent, "tasks.md")), { code: "ENOENT" });

  // Continue the requirement-only service slice through the official CLIs.
  // Approved planning and runner verdicts are fixture inputs, not LLM proof.
  const cli = (skill, helper, args) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "skills/workflows", skill, "runtime", helper), ...args],
      { cwd: fixture.root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, `${helper}: ${result.stderr}`);
    return result.stdout;
  };
  await fs.copyFile(path.join(ROOT, "benchmarks/sentinel-todo/seed/src/cli.mjs"), path.join(fixture.root, source));
  const cliBefore = await fs.readFile(path.join(fixture.root, source));
  await fs.cp(partial, fixture.execution, { recursive: true });
  for (const relative of ["plan.md", "plans/slice-01.md", "plans/slice-02.md"]) {
    const file = path.join(fixture.execution, relative);
    await fs.writeFile(file, headerReady(await fs.readFile(file, "utf8")));
  }
  const approvedPlans = await Promise.all(livePaths.concat("plans/slice-02.md").map((p) => fs.readFile(path.join(fixture.execution, p))));
  const planner = "stnl-execution-planner", materializer = "stnl-task-materializer";
  const executor = "stnl-slice-executor", quality = "stnl-slice-quality-manager";
  assert.match(cli(planner, "validate-execution-state.mjs", [fixture.requirements, "MATERIALIZE_TASKS"]), /PLANNED_READY/u);
  const taskCopy = JSON.parse(cli(materializer, "prepare-task-candidate.mjs", ["--prepare", "--spec-path", fixture.requirements]));
  const authority = await computeRequirementsAuthority(fixture.requirements);
  await renderTasks(fixture, { fingerprint: authority, outputExecutionRoot: taskCopy.candidateExecutionRoot });
  const taskDirectory = path.join(fixture.execution, "tasks");
  const serviceClaims = [service, serviceCheck].map((p) => path.relative(taskDirectory, path.join(fixture.root, p)).split(path.sep).join("/"));
  const cliClaims = [source, check, checkFixtures].map((p) => path.relative(taskDirectory, path.join(fixture.root, p)).split(path.sep).join("/"));
  const checkCommand = `STNL_VERIFICATION_COMMAND=1 node --test ${serviceCheck}`;
  const pristine = await fs.readFile(path.join(taskCopy.candidateExecutionRoot, "tasks/slice-01.md"), "utf8");
  let serviceTask = replaceSection(pristine.replace("Tasks - Delivery", "Tasks - Service selection"), "Checklist",
    `- [ ] 1.1 Implement and check in-memory selection | observable result: matching records preserve order | expected areas: ${serviceClaims.map((p) => `\`${p}\``).join(", ")} | requirement: REQ-FILTER`);
  serviceTask = replaceSection(serviceTask, "Expected Tests", `- ${checkCommand}; verify only the bounded REQ-FILTER contribution.`);
  await fs.writeFile(path.join(taskCopy.candidateExecutionRoot, "tasks/slice-01.md"), serviceTask);
  let cliTask = pristine.replaceAll("Slice 01", "Slice 02").replace("- Slice: 01", "- Slice: 02")
    .replace("plans/slice-01.md", "plans/slice-02.md").replace("Tasks - Delivery", "Tasks - CLI delivery");
  cliTask = replaceSection(cliTask, "Checklist",
    `- [ ] 2.1 Deliver complete filtered CLI acceptance | observable result: AC-FILTER complete | expected areas: ${cliClaims.map((p) => `\`${p}\``).join(", ")} | requirement: AC-FILTER`);
  cliTask = replaceSection(cliTask, "Expected Tests", `- node ${check} ${source} test/fixtures`);
  await fs.writeFile(path.join(taskCopy.candidateExecutionRoot, "tasks/slice-02.md"), cliTask);
  const indexFile = path.join(taskCopy.candidateExecutionRoot, "tasks.md");
  await fs.writeFile(indexFile, (await fs.readFile(indexFile, "utf8")).replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [ ] | 01 - Service selection | In-memory selection | - | tasks/slice-01.md | pending | pending |\n"
    + "| [ ] | 02 - CLI delivery | Complete filtered list acceptance | 01 | tasks/slice-02.md | pending | pending |"));
  assert.equal(JSON.parse(cli(materializer, "publish-task-candidate.mjs", ["--publish", "--spec-path", fixture.requirements,
    "--candidate-execution-root", taskCopy.candidateExecutionRoot])).state, "MATERIALIZED_PRISTINE");
  const laterTask = path.join(taskDirectory, "slice-02.md"), laterBefore = await fs.readFile(laterTask);
  assert.match(await fs.readFile(path.join(taskDirectory, "slice-01.md"), "utf8"), /requirement: REQ-FILTER/u);
  assert.doesNotMatch(await fs.readFile(path.join(taskDirectory, "slice-01.md"), "utf8"), /requirement: AC-/u);
  assert.match(cli(executor, "validate-execution-state.mjs", [fixture.requirements, "EXECUTE_SLICE", "1"]), /MATERIALIZED_PRISTINE/u);

  // Implementation and its prepared unit check stay within service slice paths.
  const serviceFile = path.join(fixture.root, service);
  await fs.writeFile(serviceFile, (await fs.readFile(serviceFile, "utf8")).replace("async list() {\n    return this.store.read();\n  }",
    "async list(completed) {\n    const todos = await this.store.read();\n    return completed === undefined ? todos : todos.filter((todo) => todo.completed === completed);\n  }"));
  await fs.writeFile(path.join(fixture.root, serviceCheck), 'import assert from "node:assert/strict";\nimport { TodoService } from "../src/todo-service.mjs";\n'
    + 'const rows = [{ id: 1, title: "pending one", completed: false }, { id: 2, title: "done two", completed: true }, { id: 3, title: "pending three", completed: false }, { id: 4, title: "done four", completed: true }];\n'
    + 'const service = new TodoService({ read: async () => rows, write: async () => { throw new Error("selection must not write"); } });\n'
    + 'for (const [filter, ids] of [[true, [2, 4]], [false, [1, 3]], [undefined, [1, 2, 3, 4]]]) {\n'
    + '  assert.deepEqual(await service.list(filter), rows.filter((todo) => ids.includes(todo.id)));\n}\n');
  const executeCopy = JSON.parse(cli(executor, "prepare-execution-copy.mjs", ["--prepare", "--spec-path", fixture.requirements, "--slice", "slice-01"]));
  await fs.writeFile(executeCopy.candidateTaskArtifact, replaceSection(replaceSection(serviceTask.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas",
    serviceClaims.map((p) => `- \`${p}\``).join("\n")), "Diff Summary", "- Implemented in-memory completion selection and prepared its unit check; CLI acceptance remains in slice-02."));
  const runCheck = () => spawnSync(process.execPath, ["--test", serviceCheck], { cwd: fixture.root, encoding: "utf8" });
  const implemented = runCheck();
  assert.equal(implemented.status, 0, implemented.stderr);
  const implementationResponse = {
    status: "TESTS_PASS", automaticCheckRound: "1/3", head: "fixture-head", discoverySources: "prepared service unit check",
    discoveryActions: "read approved service scope", verificationTypesConsidered: "unit", nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "check executed", commands: [{ command: checkCommand, exit: implemented.status }],
    resultOfEachCommandAndExitCode: "service unit check passed", selectedChecks: serviceCheck, selectionRationale: "bounded requirement contribution",
    coverage: "REQ-FILTER selection and order only; full AC-FILTER belongs to slice-02", failures: "none", priorRoundFailure: "none",
    correctionApplied: "none", inSliceRationale: "none", evidenceOrFailureSummary: "in-memory selection verified",
    affectedFilesOrBehaviors: "service selection and prepared unit check", blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes",
  };
  const executionReceipt = await capturedVerificationSequence(t, fixture, "EXECUTE_SLICE", JSON.stringify(implementationResponse), [], implementationResponse.commands);
  cli(executor, "serialize-runner-evidence.mjs", ["--execution-bundle", "--operation", "EXECUTE_SLICE", "--workspace", fixture.root,
    "--task-artifact", executeCopy.candidateTaskArtifact, "--semantic-response-file", executionReceipt.semanticResponseFile,
    "--receipt-file", executionReceipt.receiptFile, "--insert-candidate"]);
  assert.equal(JSON.parse(cli(executor, "prepare-execution-copy.mjs", ["--publish", "--spec-path", fixture.requirements,
    "--slice", "slice-01", "--candidate-root", executeCopy.candidateRoot])).state, "IMPLEMENTED_AWAITING_VALIDATION");
  const implementationRecord = (await fs.readFile(path.join(taskDirectory, "slice-01.md"), "utf8"))
    .match(/## Implementation Test Evidence\n([\s\S]*?)\n## Findings Test Evidence/u)[1];
  assert.match(cli(quality, "validate-execution-state.mjs", [fixture.requirements, "VALIDATE_SLICE", "1"]), /IMPLEMENTED_AWAITING_VALIDATION/u);
  const validationCopy = JSON.parse(cli(quality, "prepare-validation-copy.mjs", ["--spec-path", fixture.requirements,
    "--slice", "slice-01", "--candidate-parent", await temporary(t, "stnl-partial-validation-")]));
  const verified = runCheck();
  assert.equal(verified.status, 0, verified.stderr);
  const validationReceipt = await capturedVerificationSequence(t, fixture, "VALIDATE_SLICE", JSON.stringify({ status: "PASS", head: "fixture-head",
    commands: [{ command: checkCommand, exit: verified.status }], evidence: "REQ-FILTER bounded selection and order verified; AC-FILTER remains pending in slice-02",
    findingReferences: "none", findingDispositions: "none", blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes" }), [],
    [{ command: checkCommand, exit: verified.status }]);
  cli(quality, "prepare-validation-candidate.mjs", ["--prepare", "--spec-path", fixture.requirements, "--slice", "slice-01", "--workspace", fixture.root,
    "--candidate-execution-root", validationCopy.candidateExecutionRoot, "--semantic-response-file", validationReceipt.semanticResponseFile,
    "--receipt-file", validationReceipt.receiptFile]);
  assert.equal(JSON.parse(cli(quality, "publish-validation-candidate.mjs", ["--publish", "--spec-path", fixture.requirements,
    "--slice", "slice-01", "--candidate-execution-root", validationCopy.candidateExecutionRoot])).state, "EXECUTION_STARTED");
  const handoff = JSON.parse(cli(quality, "validate-execution-state.mjs", [fixture.requirements, "--handoff-after", "VALIDATE_SLICE"]));
  assert.equal(handoff.normal_handoff.operation, "EXECUTE_SLICE");
  assert.equal(handoff.normal_handoff.slice, "slice-02");
  const validatedPartial = await fs.readFile(path.join(taskDirectory, "slice-01.md"), "utf8");
  assert.equal(validatedPartial.match(/## Implementation Test Evidence\n([\s\S]*?)\n## Findings Test Evidence/u)[1], implementationRecord);
  assert.match(validatedPartial, /### implementation-check-01[\s\S]*### attempt-01/u);
  assert.match(validatedPartial, /## Effective Validation Base\n\n- Origin attempt: attempt-01/u);
  assert.match(validatedPartial, /## Final Result\n\n- PASS/u);
  assert.deepEqual(await fs.readFile(laterTask), laterBefore);
  assert.match(await fs.readFile(path.join(fixture.execution, "tasks.md"), "utf8"), /\| \[ \] \| 02 - CLI delivery[^\n]*\| pending \| pending \|/u);
  assert.deepEqual(await Promise.all(livePaths.concat("plans/slice-02.md").map((p) => fs.readFile(path.join(fixture.execution, p)))), approvedPlans);
  assert.deepEqual(await fs.readFile(path.join(fixture.root, source)), cliBefore);
  assert.equal(checkPrepared().status, 1, "full CLI acceptance remains unimplemented despite the partial slice PASS");
});

function helperRoots(skillRoot, text) {
  const roots = new Map([["SKILL_ROOT", skillRoot]]);
  if (text.includes("`<PLANNER_SKILL_ROOT>` is the named sibling stnl-execution-planner")) roots.set("PLANNER_SKILL_ROOT", path.resolve(skillRoot, "../stnl-execution-planner"));
  for (const match of text.matchAll(/<([A-Z_]+)> = path\.resolve\(SKILL_ROOT, "(\.\.\/stnl-[a-z-]+)"\)/gu)) {
    roots.set(match[1], path.resolve(skillRoot, match[2]));
  }
  return roots;
}

function helperRecipe(skillRoot, text, filename, values) {
  const match = [...text.matchAll(/`node "(<[A-Z_]+>\/runtime\/([a-z-]+\.mjs))" ([^`\n]+)`/gu)]
    .find((entry) => entry[2] === filename);
  assert.ok(match, `${path.basename(skillRoot)} lacks an anchored recipe for ${filename}`);
  const alias = match[1].match(/^<([A-Z_]+)>/u)[1];
  const owner = helperRoots(skillRoot, text).get(alias);
  assert.ok(owner, `undefined helper owner ${alias}`);
  const args = match[3].match(/<[^>]+>|[^\s]+/gu).map((token) => {
    if (!token.startsWith('<')) return token;
    assert.ok(Object.hasOwn(values, token), `unbound recipe argument ${token}`);
    return values[token];
  });
  return { entrypoint: path.join(owner, 'runtime', filename), args };
}

test("execution helper references resolve to their declared owner in source, snapshot and installed bundles", async (t) => {
  const temporaryRoot = await temporary(t, "stnl-helper-owners-");
  const source = path.join(ROOT, "skills/workflows");
  const layouts = [source, path.join(temporaryRoot, "snapshot/skills/workflows"),
    path.join(temporaryRoot, "shell-home/.agents/skills")];
  for (const layout of layouts.slice(1)) {
    for (const skill of SKILLS) await fs.cp(path.join(source, skill), path.join(layout, skill), { recursive: true });
  }
  const failures = [];
  for (const layout of layouts) {
    for (const skill of SKILLS) {
      const skillRoot = path.join(layout, skill);
      const text = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
      const roots = helperRoots(skillRoot, text);
      const documents = [text];
      const references = path.join(skillRoot, "references");
      for (const name of await fs.readdir(references).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })) if (name.endsWith('.md')) documents.push(await fs.readFile(path.join(references, name), 'utf8'));
      for (const document of documents) {
        for (const span of document.matchAll(/`([^`\n]+)`/gu)) {
          // Only declared helper paths are runtime references. A source input
          // such as src/greeting.test.mjs is not a runtime/test.mjs helper.
          for (const ref of span[1].matchAll(/(?:<([A-Z_]+)>\/)?runtime\/([a-z][a-z-]+\.mjs)/gu)) {
            const owner = skill === "stnl-plan-reviewer" && ref[2] === "prepare-task-candidate.mjs" && ref[1] === undefined
              ? roots.get("PLANNER_SKILL_ROOT") : roots.get(ref[1] ?? "SKILL_ROOT");
            const target = owner === undefined ? null : path.join(owner, "runtime", ref[2]);
            if (target === null || !await fs.stat(target).then((stat) => stat.isFile(), () => false)) {
              failures.push(`${path.relative(temporaryRoot, layout)} ${skill}: unresolved ${ref[0]}`);
            }
            if (span[1].startsWith('node ') && ref[1] === undefined) {
              failures.push(`${skill}: cwd-relative executable recipe ${span[1]}`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
  for (const layout of layouts) {
    for (const filename of ['prepare-plan-candidate.mjs', 'serialize-plan-paths.mjs']) {
      await assert.rejects(fs.stat(path.join(layout, 'stnl-plan-reviewer/runtime', filename)), { code: 'ENOENT' });
    }
    const nativeCapture = await fs.readFile(path.join(layout, "stnl-slice-quality-manager/runtime/capture-runner-response.mjs"));
    assert.deepEqual(nativeCapture, await fs.readFile(path.join(layout, "stnl-slice-executor/runtime/capture-runner-response.mjs")));
  }
});

test("shared planning and capture recipes dispatch from their declared owners independently of cwd", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "draft" });
  const target = path.join(fixture.root, 'src/example.txt');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'fixture implementation\n');
  const approvedArea = path.relative(fixture.execution, path.dirname(target)).split(path.sep).join('/');
  assert.ok((await fs.readFile(path.join(fixture.execution, 'plan.md'), 'utf8')).includes('directory: `' + approvedArea + '`'), 'the current joint directory carrier authorizes the example target');
  const bundles = [path.join(ROOT, 'skills/workflows')];
  const copyRoot = await temporary(t, 'stnl-helper-dispatch-');
  for (const relative of ['snapshot/skills/workflows', 'shell-home/.agents/skills']) {
    const bundle = path.join(copyRoot, relative);
    for (const skill of ['stnl-plan-reviewer', 'stnl-execution-planner', 'stnl-slice-quality-manager', 'stnl-slice-executor']) {
      await fs.cp(path.join(bundles[0], skill), path.join(bundle, skill), { recursive: true });
    }
    bundles.push(bundle);
  }
  const liveBytes = await fs.readFile(path.join(fixture.execution, 'plan.md'));
  const rawResponse = '{"status":"BLOCKED","evidence":"offline owner fixture"}\n';
  const structuredOutput = path.join(copyRoot, 'runner-events.jsonl');
  await fs.writeFile(structuredOutput, JSON.stringify({ type: 'item.completed',
    item: { type: 'agent_message', text: rawResponse } }) + '\n');
  for (const [index, bundle] of bundles.entries()) {
    const reviewerRoot = path.join(bundle, 'stnl-plan-reviewer');
    const text = await fs.readFile(path.join(reviewerRoot, 'SKILL.md'), 'utf8');
    const candidate = (await preparePreparationCandidate({ specPath: fixture.requirements, operation: "REVIEW_PLAN" })).candidateExecutionRoot;
    const values = { '<SPEC_PATH>': fixture.requirements, '<CANDIDATE_EXECUTION_ROOT>': candidate };
    for (const filename of ['prepare-plan-candidate.mjs', 'serialize-plan-paths.mjs']) {
      assert.match(text, /sibling planner's prepare-plan-candidate\.mjs and serialize-plan-paths\.mjs recipes from its skill/u);
      const plannerRoot = path.join(bundle, 'stnl-execution-planner');
      const recipe = helperRecipe(plannerRoot, await fs.readFile(path.join(plannerRoot, 'SKILL.md'), 'utf8'), filename, values);
      assert.equal(recipe.entrypoint, path.join(bundle, 'stnl-execution-planner/runtime', filename));
      const result = spawnSync(process.execPath, [recipe.entrypoint, ...recipe.args], {
        cwd: fixture.root, encoding: 'utf8', env: { ...process.env, STNL_MANAGED_CONTEXT: '' },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'PASS');
    }
    assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, 'PLANNED_DRAFT');
    const qualityRoot = path.join(bundle, 'stnl-slice-quality-manager');
    const qualityText = await fs.readFile(path.join(qualityRoot, 'SKILL.md'), 'utf8');
    const output = path.join(copyRoot, `response-${index}.json`);
    const capture = helperRecipe(qualityRoot, qualityText, 'capture-runner-response.mjs', {
      '<absolute-runner-output>': structuredOutput, '<absolute-temp-file>': output,
    });
    assert.equal(capture.entrypoint, path.join(bundle, 'stnl-slice-executor/runtime/capture-runner-response.mjs'));
    const result = spawnSync(process.execPath, [capture.entrypoint, ...capture.args], {
      cwd: fixture.root, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'PASS');
    assert.equal(await fs.readFile(output, 'utf8'), rawResponse);
  }
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, 'plan.md')), liveBytes);
});

test("planner content creation recipe renders writable candidates from frozen templates through strict PLAN publication", async t => {
  const f = await preparationFixture({ test: t, form: 'lifecycle-directory' });
  await preparePlanCandidate({ candidateExecutionRoot: f.candidate });
  await serializePlanPathClaims({ specPath: f.specPath, candidateExecutionRoot: f.candidate });
  const authored = await readPreparationArtifacts(f.candidate);
  const requirements = await fs.readFile(path.join(f.specPath, 'feature_spec.md'));
  assert.equal((await preflightExecutionOperation(f.specPath, 'PLAN')).state, 'EMPTY');
  const staging = await temporary(t, 'stnl-content-creation ü-');
  const frozen = [];
  const skill = await fs.readFile(path.join(ROOT, 'skills/workflows/stnl-execution-planner/SKILL.md'), 'utf8');
  assert.ok(skill.includes('Render both Plan and Tasks from UTF-8 template content as new writable files; do not copy frozen template modes.'));
  const recipe = 'import fs from "node:fs/promises";const [source,destination]=process.argv.slice(1);await fs.writeFile(destination,await fs.readFile(source,"utf8"),{encoding:"utf8",flag:"wx"});';
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const mapping = [['plan.template.md', 'plan.md'], ['slice-plan.template.md', 'plans/slice-01.md'], ['tasks.template.md', 'tasks.md'], ['slice-tasks.template.md', 'tasks/slice-01.md']];
  for (const [template, name] of mapping) {
    const bytes = await fs.readFile(path.join(ROOT, 'skills/workflows/stnl-execution-planner/templates', template));
    const source = path.join(staging, template); await fs.writeFile(source, bytes, { flag: 'wx', mode: 0o444 });
    assert.equal((await fs.stat(source)).mode & 0o777, 0o444); frozen.push({ source, bytes });
    const copied = path.join(staging, 'copied-' + template); await fs.copyFile(source, copied);
    assert.equal((await fs.stat(copied)).mode & 0o222, 0, 'metadata-copy control retains frozen mode');
    const target = path.join(f.candidate, name); await fs.unlink(target);
    const args = ['--input-type=module', '-e', recipe, source, target];
    const created = spawnSync(process.execPath, args, { cwd: f.root, env: environment, encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr); assert.deepEqual(await fs.readFile(target), bytes);
    assert.notEqual((await fs.stat(target)).mode & 0o200, 0, 'content rendering creates owner-writable artifact');
    const collision = spawnSync(process.execPath, args, { cwd: f.root, env: environment, encoding: 'utf8' });
    assert.notEqual(collision.status, 0); assert.match(collision.stderr, /EEXIST/);
    assert.deepEqual(await fs.readFile(target), bytes, 'exclusive creation cannot overwrite an authored artifact');
    const body = authored.get(name).replace(/^# File Purpose Header\n\n```yaml\n[\s\S]*?^```\n\n/mu, '');
    assert.notEqual(body, authored.get(name)); await fs.writeFile(target, body);
    assert.equal(await fs.readFile(target, 'utf8'), body);
  }
  const prepared = await preparePlanCandidate({ candidateExecutionRoot: f.candidate });
  assert.equal(prepared.status, 'PASS'); assert.equal(prepared.changedPaths.length, 4);
  const serialized = await serializePlanPathClaims({ specPath: f.specPath, candidateExecutionRoot: f.candidate });
  assert.equal(serialized.status, 'PASS'); assert.equal(serialized.candidateValidation.state, 'PLANNED_DRAFT');
  assert.deepEqual(await readPreparationArtifacts(f.candidate), authored);
  assert.equal((await inspectExecutionState(f.specPath)).state, 'EMPTY', 'preparation validation does not publish');
  const published = await publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: f.candidate });
  assert.equal(published.publication, 'confirmed');
  const state = await inspectExecutionState(f.specPath); assert.equal(state.state, 'PLANNED_DRAFT');
  assert.equal((await preflightExecutionOperation(f.specPath, 'REVIEW_PLAN')).state, 'PLANNED_DRAFT');
  assert.deepEqual(nextHandoff('PLAN', { execution: state, executionRaw: state, product: { deriveNormalHandoff } }), { operation: 'REVIEW_PLAN', slice: null });
  for (const [name, text] of authored) {
    const target = path.join(f.workspace.executionRoot, name);
    assert.equal(await fs.readFile(target, 'utf8'), text); assert.match(text, /^status: draft$/mu);
    assert.notEqual((await fs.stat(target)).mode & 0o200, 0);
  }
  await assert.rejects(preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1'), /not legal/);
  assert.deepEqual(await fs.readFile(path.join(f.specPath, 'feature_spec.md')), requirements);
  for (const { source, bytes } of frozen) {
    assert.deepEqual(await fs.readFile(source), bytes); assert.equal((await fs.stat(source)).mode & 0o777, 0o444);
  }
});

test("deterministic plan candidate preparation serializes template headers before strict validation", async (t) => {
  const f = await preparationFixture({ test: t, form: 'lifecycle-directory' });
  const candidateRoot = f.candidate;
  const fixture = { requirements: f.specPath };
  await preparePlanCandidate({ candidateExecutionRoot: candidateRoot });
  await serializePlanPathClaims({ specPath: f.specPath, candidateExecutionRoot: candidateRoot });

  const planPath = path.join(candidateRoot, "plan.md");
  const detailPath = path.join(candidateRoot, "plans", "slice-01.md");
  const planBefore = await fs.readFile(planPath, "utf8");
  const detailBefore = await fs.readFile(detailPath, "utf8");
  const planHeader = planBefore.match(/^# File Purpose Header\n\n```yaml\n[\s\S]*?^```\n\n/mu)?.[0];
  const detailHeader = detailBefore.match(/^# File Purpose Header\n\n```yaml\n[\s\S]*?^```\n\n/mu)?.[0];
  assert.ok(planHeader);
  assert.ok(detailHeader);
  await fs.writeFile(planPath, planBefore.slice(planHeader.length), "utf8");
  await fs.writeFile(detailPath, detailBefore.slice(detailHeader.length), "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /purpose header|File Purpose Header/iu,
  );

  const prepared = await preparePlanCandidate({ candidateExecutionRoot: candidateRoot });
  assert.equal(prepared.status, "PASS");
  assert.deepEqual([...prepared.changedPaths].sort(), [planPath, detailPath].sort());
  assert.equal((await fs.readFile(planPath, "utf8")).endsWith(planBefore.slice(planHeader.length)), true);
  assert.equal((await fs.readFile(detailPath, "utf8")).endsWith(detailBefore.slice(detailHeader.length)), true);
  const state = await validateExecutionCandidate(fixture.requirements, candidateRoot);
  assert.equal(state.state, "PLANNED_DRAFT");
  const canonicalPlan = await fs.readFile(planPath, "utf8");
  const canonicalDetail = await fs.readFile(detailPath, "utf8");
  assert.deepEqual((await preparePlanCandidate({ candidateExecutionRoot: candidateRoot })).changedPaths, []);
  assert.deepEqual(await fs.readFile(planPath, "utf8"), canonicalPlan);
  assert.deepEqual(await fs.readFile(detailPath, "utf8"), canonicalDetail);

  const conflictingRoot = candidateRoot;
  const conflictingPlanPath = path.join(conflictingRoot, "plan.md");
  const conflictingPlanBefore = await fs.readFile(conflictingPlanPath, "utf8");
  const canonicalUpdatePolicy = planHeader.match(/^update_policy: .+$/mu)?.[0];
  assert.ok(canonicalUpdatePolicy);
  const modelUpdatePolicy = canonicalUpdatePolicy.replace("REVIEW_PLAN corrects ", "REVIEW_PLAN corrects only ");
  assert.notEqual(modelUpdatePolicy, canonicalUpdatePolicy);
  const conflictingPlan = conflictingPlanBefore.replace(canonicalUpdatePolicy, modelUpdatePolicy);
  await fs.writeFile(conflictingPlanPath, conflictingPlan, "utf8");
  const conflictingHeader = conflictingPlan.match(/^# File Purpose Header\n\n```yaml\n[\s\S]*?^```\n\n/mu)?.[0];
  assert.ok(conflictingHeader);
  const conflictingBody = conflictingPlan.slice(conflictingHeader.length);

  const normalized = await preparePlanCandidate({ candidateExecutionRoot: conflictingRoot });
  assert.equal(normalized.status, "PASS");
  assert.deepEqual(normalized.changedPaths, [conflictingPlanPath]);
  const normalizedPlan = await fs.readFile(conflictingPlanPath, "utf8");
  assert.equal(normalizedPlan, canonicalPlan);
  assert.equal(normalizedPlan.slice(planHeader.length), conflictingBody);
  assert.equal((await validateExecutionCandidate(fixture.requirements, conflictingRoot)).state, "PLANNED_DRAFT");
  assert.deepEqual((await preparePlanCandidate({ candidateExecutionRoot: conflictingRoot })).changedPaths, []);

  await publishFixtureCandidate(f, candidateRoot);
  const readyRoot = await prepareFixtureCandidate(f, 'REVIEW_PLAN');
  for (const relativePath of ["plan.md", "plans/slice-01.md"]) {
    const file = path.join(readyRoot, relativePath);
    const content = await fs.readFile(file, "utf8");
    await fs.writeFile(file, content.replace("status: draft\n", "status: ready\n"), "utf8");
  }
  const readyPrepared = await preparePlanCandidate({ candidateExecutionRoot: readyRoot });
  assert.equal(readyPrepared.status, "PASS");
  assert.deepEqual(readyPrepared.changedPaths, []);
  assert.match(await fs.readFile(path.join(readyRoot, "plan.md"), "utf8"), /^status: ready$/mu);
  assert.match(await fs.readFile(path.join(readyRoot, "plans", "slice-01.md"), "utf8"), /^status: ready$/mu);

  for (const relativePath of ['plan.md', 'plans/slice-01.md']) {
    const file = path.join(readyRoot, relativePath);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('status: ready\n', 'status: draft\n'));
  }
  const malformedRoot = readyRoot;
  const malformedPath = path.join(malformedRoot, "plan.md");
  const malformedBefore = await fs.readFile(malformedPath, "utf8");
  await fs.writeFile(malformedPath, malformedBefore.replace("status: draft\n", "status: draft\nstatus: ready\n"), "utf8");
  const malformedSnapshot = await fs.readFile(malformedPath, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, malformedRoot),
    /plan\.md has ambiguous fields/u,
  );
  await assert.rejects(
    preparePlanCandidate({ candidateExecutionRoot: malformedRoot }),
    /malformed or conflicting File Purpose Header/u,
  );
  assert.deepEqual(await fs.readFile(malformedPath, "utf8"), malformedSnapshot);
});



test("deterministic runner evidence serializer emits physical task-relative SHA-256 tuples", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const workspace = fixture.root;
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const physicalTarget = path.join(workspace, "src/example.txt");
  const claim = path.relative(path.dirname(taskArtifact), physicalTarget).split(path.sep).join("/");
  const expected = `  - \`${claim}\` | sha256:${VALIDATED_HASH}`;

  const serialized = await serializeRunnerEvidence({
    workspace,
    taskArtifact,
    targets: [physicalTarget],
  });
  assert.equal(serialized, expected);
  assert.equal(
    await fs.realpath(path.resolve(path.dirname(taskArtifact), claim)),
    await fs.realpath(physicalTarget),
  );
  assert.equal(
    await serializeRunnerEvidence({ workspace, taskArtifact, targets: [physicalTarget] }),
    serialized,
  );
  const record = await serializeRunnerRecord({
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [
      { command: "node --test test/example.test.mjs", exit: 0 },
      { command: "git diff --check", exit: 1 },
    ],
  });
  assert.equal(
    record,
    `- Tested state:\n${expected}\n- Commands:\n  - \`node --test test/example.test.mjs\` | exit:0\n  - \`git diff --check\` | exit:1`,
  );
  assert.equal(record.includes("`- Tested state:`"), false);
  const manifest = await serializeRunnerManifest({
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  assert.equal(
    manifest,
    `- Files:\n${expected}\n- Authoritative commands:\n  - \`node --test test/example.test.mjs\` | exit:0`,
  );
  const manifestCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--manifest",
    "--workspace", workspace,
    "--spec-path", fixture.requirements,
    "--slice", "1",
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs",
    "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(manifestCli.status, 0, manifestCli.stderr);
  assert.equal(manifestCli.stdout.trimEnd(), manifest);
  await assert.rejects(
    serializeRunnerManifest({ workspace, taskArtifact, targets: [physicalTarget], commands: [] }),
    /at least one authoritative command/u,
  );
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs",
    "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trimEnd(), record.slice(0, record.indexOf("\n- Commands:")) + "\n- Commands:\n  - `node --test test/example.test.mjs` | exit:0");
  const help = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--help",
  ], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--response --operation/u);
  assert.match(help.stdout, /--value "semantic value"/u);
  assert.match(help.stdout, /--manifest --workspace/u);
  const tokenizedCommands = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--target", physicalTarget,
    "--command", "node", "--test", "test/example.test.mjs", "--exit", "0",
    "--command", "git", "diff", "--check", "--exit", "1",
  ], { encoding: "utf8" });
  assert.equal(tokenizedCommands.status, 0, tokenizedCommands.stderr);
  assert.equal(tokenizedCommands.stdout.trimEnd(), record);
  const derivedRecord = await serializeRunnerRecord({
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  const derivedCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--spec-path", fixture.requirements,
    "--slice", "1",
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs",
    "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(derivedCli.status, 0, derivedCli.stderr);
  assert.equal(derivedCli.stdout.trimEnd(), derivedRecord);
  const ambiguousInputs = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--spec-path", fixture.requirements,
    "--slice", "1",
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs",
    "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(ambiguousInputs.status, 1);
  assert.match(ambiguousInputs.stderr, /use --task-artifact or --spec-path with --slice, not both/u);
  const responseFields = {
    Operation: "EXECUTE_SLICE",
    Status: "TESTS_PASS",
    "Automatic check round": "1/3",
    HEAD: "none",
    "Tested scope": "malformed semantic scope",
    "Discovery sources": "task and package scripts",
    "Discovery actions": "read-only inspection",
    "Verification types considered": "unit tests",
    "Non-applicability rationale": "none",
    "No verification-command confirmation": "not applicable",
    "Result of each command and exit code": "all passed",
    "Selected checks": "node --test test/example.test.mjs",
    "Selection rationale": "directly covers the changed behavior",
    Coverage: "changed behavior",
    Failures: "none",
    "Evidence or failure summary": "focused tests passed",
    "Affected files or behaviors": "example behavior",
    Blockers: "none",
    "Unexpected workspace effects": "none",
    "Persistence summary": "record persisted",
  };
  const response = await serializeRunnerResponse({
    operation: "EXECUTE_SLICE",
    fields: responseFields,
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  assert.equal(response.startsWith("Operation: EXECUTE_SLICE\nStatus: TESTS_PASS\nAutomatic check round: 1/3"), true);
  assert.equal(response.includes(`Tested scope: ${claim}`), true);
  assert.equal(response.includes("malformed semantic scope"), false);
  assert.match(response, /^Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}$/mu);
  assert.match(response, /^Commands:\n  - `node --test test\/example\.test\.mjs` \| exit:0$/mu);
  assert.equal(response.includes("Operação:"), false);
  const responseFromSemanticValues = await serializeRunnerResponse({
    operation: "EXECUTE_SLICE",
    values: Object.entries(responseFields)
      .filter(([label]) => label !== "Operation")
      .map(([, value]) => value),
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  assert.equal(responseFromSemanticValues, response);
  const validationValues = [
    "initial",
    "PASS",
    "slice-01: src/example.txt",
    "fixture-head",
    "focused validation passed",
    "none",
    "none",
    "none",
    "none",
    "attempt persisted",
  ];
  const validationBundle = await serializeRunnerValidationBundle({
    operation: "VALIDATE_SLICE",
    values: validationValues,
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  assert.match(validationBundle, /- Runner response:\nOperation: VALIDATE_SLICE\nType: initial\nStatus: PASS/u);
  assert.match(validationBundle, /- Tested record:\n- Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}/u);
  assert.match(validationBundle, /- Formal manifest:\n- Files:\n  - `[^`]+` \| sha256:[0-9a-f]{64}/u);
  assert.match(validationBundle, /- Authoritative commands:\n  - `node --test test\/example\.test\.mjs` \| exit:0/u);
  await fs.writeFile(
    taskArtifact,
    (await fs.readFile(taskArtifact, "utf8")).replace("## Changed Areas\n\n- pending", `## Changed Areas\n\n- \`${claim}\``),
    "utf8",
  );
  const semanticValidationResponse = JSON.stringify({
    status: "PASS",
    head: "fixture-head",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    evidence: "focused `npm test` validation passed",
    findingReferences: "none",
    findingDispositions: "none",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "semantic result returned",
  });
  const semanticResponseRoot = await temporary(t, "stnl-validation-semantic-response-");
  const semanticResponseFile = path.join(semanticResponseRoot, "response.txt");
  await fs.writeFile(semanticResponseFile, `${semanticValidationResponse}\n`, "utf8");
  const officialValidationPreflight = `node "${path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs")}" "${fixture.requirements}" VALIDATE_SLICE 1`;
  const derivedValidationBundle = await serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: semanticValidationResponse,
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  });
  assert.match(derivedValidationBundle, /- Runner response:\nOperation: VALIDATE_SLICE\nType: initial\nStatus: PASS/u);
  assert.match(derivedValidationBundle, /\nEvidence: json:"focused `npm test` validation passed"\n/u);
  assert.equal(derivedValidationBundle.includes(`  - \`${claim}\` | sha256:`), true);
  assert.match(derivedValidationBundle, /- Tested record:[\s\S]+sha256:[0-9a-f]{64}/u);
  assert.equal(
    derivedValidationBundle.split(`  - \`${officialValidationPreflight}\` | exit:0`).length - 1,
    3,
    "producer must persist the canonical official preflight in every generated section",
  );
  assert.equal(
    derivedValidationBundle.includes(
      `- Authoritative commands:\n  - \`${officialValidationPreflight}\` | exit:0\n  - \`node --test test/example.test.mjs\` | exit:0`,
    ),
    true,
  );
  await assert.rejects(serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: JSON.stringify({ ...JSON.parse(semanticValidationResponse), head: "`fixture-head`" }),
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  }), /head.*backticks|head.*scalar|canonical HEAD/u);
  const quotedCommand = "node `--test` test/example.test.mjs";
  const quotedBundle = await serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: JSON.stringify({
      ...JSON.parse(semanticValidationResponse),
      commands: [{ command: quotedCommand, exit: 0 }],
    }),
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  });
  assert.ok(quotedBundle.includes(`json:${JSON.stringify(quotedCommand)} | exit:0`));
  const taskBeforeOverlap = await fs.readFile(taskArtifact, "utf8");
  const overlapTask = replaceSection(
    taskBeforeOverlap,
    "Prior Validation Overlap",
    `### overlap-01\n\n- Prior slice: slice-01\n- Paths: \`${claim}\`\n- Affected behavior: Preserve the previously validated behavior.\n- Regressions: Re-run the focused regression.`,
  );
  await fs.writeFile(taskArtifact, overlapTask, "utf8");
  try {
    const overlapBundle = await serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: semanticValidationResponse,
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    });
    assert.equal(overlapBundle.includes(`  - \`${claim}\` | sha256:`), true);
    assert.equal(await fs.readFile(taskArtifact, "utf8"), overlapTask);

    const semanticOverlapTask = overlapTask.replace(
      `- Prior slice: slice-01\n- Paths: \`${claim}\`\n- Affected behavior: Preserve the previously validated behavior.\n- Regressions: Re-run the focused regression.`,
      `- Slice 01 overlap: \`${claim}\`; Preserve the previously validated behavior and re-run the focused regression.`,
    );
    await fs.writeFile(taskArtifact, semanticOverlapTask, "utf8");
    const semanticOverlapBundle = await serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: semanticValidationResponse,
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    });
    assert.equal(semanticOverlapBundle.includes(`  - \`${claim}\` | sha256:`), true);
    assert.equal(await fs.readFile(taskArtifact, "utf8"), semanticOverlapTask);
    await fs.writeFile(taskArtifact, overlapTask, "utf8");

    await fs.writeFile(
      taskArtifact,
      overlapTask.replace(`- Paths: \`${claim}\``, `- Paths: \`${claim}\`, ${claim}`),
      "utf8",
    );
    await assert.rejects(
      serializeRunnerValidationBundleFromResponse({
        operation: "VALIDATE_SLICE",
        response: semanticValidationResponse,
        workspace,
        taskArtifact,
        specPath: fixture.requirements,
        slice: "1",
      }),
      /Prior Validation Overlap Paths must be comma-separated raw paths or balanced Markdown path claims/u,
    );
  } finally {
    await fs.writeFile(taskArtifact, taskBeforeOverlap, "utf8");
  }
  const emptyFindingSynonymResponse = JSON.stringify({
    ...JSON.parse(semanticValidationResponse),
    findingDispositions: "unchanged",
  });
  const emptyFindingBundle = await serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: emptyFindingSynonymResponse,
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  });
  assert.match(emptyFindingBundle, /Finding references: none\nFinding dispositions: none/u);
  assert.equal(emptyFindingBundle.includes("unchanged"), false);
  const markdownScalarResponse = JSON.stringify({
    ...JSON.parse(semanticValidationResponse),
    blockers: "Runner returned `PASS` with `format`.",
  });
  const markdownScalarBundle = await serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: markdownScalarResponse,
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  });
  assert.match(markdownScalarBundle, /\nBlockers: json:"Runner returned `PASS` with `format`\."\n/u);
  const markdownRoundTrip = await serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: JSON.stringify({
      ...JSON.parse(semanticValidationResponse),
      blockers: "Runner returned `PASS.",
    }),
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  });
  assert.match(markdownRoundTrip, /\nBlockers: json:"Runner returned `PASS\."\n/u);
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: JSON.stringify({
        ...JSON.parse(semanticValidationResponse),
        head: "sha256:`not-a-hash`",
      }),
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    }),
    /without backticks/u,
  );
  const derivedValidationCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--validation-bundle", "--operation", "VALIDATE_SLICE",
    "--workspace", workspace,
    "--spec-path", fixture.requirements,
    "--slice", "1",
    "--semantic-response-file", semanticResponseFile,
  ], { encoding: "utf8" });
  assert.equal(derivedValidationCli.status, 0, derivedValidationCli.stderr);
  assert.equal(derivedValidationCli.stdout.trimEnd(), derivedValidationBundle);
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: JSON.stringify({
        ...JSON.parse(semanticValidationResponse),
        commands: [{ command: "validate-execution-state.mjs SPEC_PATH VALIDATE_SLICE 1", exit: 0 }],
      }),
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    }),
    /launcher-owned official preflight/u,
  );
  const semanticExecutionPayload = {
    status: "TESTS_PASS",
    automaticCheckRound: "1/3",
    head: "fixture-head",
    discoverySources: "task and package scripts",
    discoveryActions: "read-only inspection",
    verificationTypesConsidered: "unit tests",
    nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "not applicable",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    resultOfEachCommandAndExitCode: "all passed",
    selectedChecks: "node --test test/example.test.mjs",
    selectionRationale: "directly covers the changed behavior",
    coverage: "changed behavior",
    failures: "none",
    priorRoundFailure: "none",
    correctionApplied: "none",
    inSliceRationale: "none",
    evidenceOrFailureSummary: "focused tests passed",
    affectedFilesOrBehaviors: "example behavior",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "record persisted",
  };
  const semanticExecutionResponse = JSON.stringify(semanticExecutionPayload);
  const executionBundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE",
    response: JSON.stringify({ ...semanticExecutionPayload, nonApplicabilityRationale: "C-like rationale with `literal` syntax" }),
    workspace,
    taskArtifact,
  });
  assert.match(executionBundle, /^### implementation-check-01\n- Automatic check round: 1\/3\n- Status: TESTS_PASS/mu);
  assert.match(executionBundle, new RegExp(`Tested scope: ${claim.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
  assert.match(executionBundle, /Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}/u);
  assert.match(executionBundle, /- Commands:\n  - `node --test test\/example\.test\.mjs` \| exit:0/u);
  assert.match(executionBundle, /- Non-applicability rationale: json:"C-like rationale with `literal` syntax"/u);
  const {
    priorRoundFailure, correctionApplied, inSliceRationale, ...applyFields
  } = semanticExecutionPayload;
  const applyBundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "APPLY_FINDINGS",
    response: JSON.stringify({
      ...applyFields,
      findingsCycle: "attempt-01",
      findingsVerified: "none",
      correctionsCovered: "none",
      regressionsSelected: "C-like regression with `literal` syntax",
      unsupportedActiveFindings: "none",
      nonApplicabilityRationale: "C-like rationale with `literal` syntax",
    }),
    workspace,
    taskArtifact,
  });
  assert.match(applyBundle, /- Non-applicability rationale: json:"C-like rationale with `literal` syntax"/u);
  const canonicalCandidate = path.join(await temporary(t, "stnl-execution-check-candidate-"), "execution");
  await fs.cp(fixture.execution, canonicalCandidate, { recursive: true });
  const canonicalCandidateTask = path.join(canonicalCandidate, "tasks/slice-01.md");
  let canonicalCandidateText = await fs.readFile(canonicalCandidateTask, "utf8");
  canonicalCandidateText = canonicalCandidateText.replace("- [ ] 1.1", "- [x] 1.1");
  canonicalCandidateText = replaceSection(canonicalCandidateText, "Implementation Test Evidence", executionBundle);
  await fs.writeFile(canonicalCandidateTask, canonicalCandidateText, "utf8");
  assert.equal(
    (await validateExecutionCandidate(fixture.requirements, canonicalCandidate)).state,
    "IMPLEMENTED_AWAITING_VALIDATION",
  );
  const malformedCheckCandidate = path.join(await temporary(t, "stnl-execution-check-malformed-"), "execution");
  await fs.cp(canonicalCandidate, malformedCheckCandidate, { recursive: true });
  const malformedCheckTask = path.join(malformedCheckCandidate, "tasks/slice-01.md");
  await fs.writeFile(
    malformedCheckTask,
    (await fs.readFile(malformedCheckTask, "utf8")).replace(
      "- Failures: none",
      "- Evidence or failure summary: unexpected response-only label\n- Failures: none",
    ),
    "utf8",
  );
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, malformedCheckCandidate),
    /unknown field 'Evidence or failure summary'/u,
  );
  const canonicalTaskBytes = await fs.readFile(taskArtifact, "utf8");
  const aliasedTaskBytes = canonicalTaskBytes.replace(
    `## Changed Areas\n\n- \`${claim}\``,
    "## Changed Areas\n\n- `src/example.txt`",
  );
  await fs.writeFile(taskArtifact, aliasedTaskBytes, "utf8");
  const scopeSerialization = await serializeExecutionScopeClaims({ workspace, taskArtifact });
  assert.equal(scopeSerialization.status, "PASS");
  assert.equal(scopeSerialization.serializedClaims, 1);
  assert.ok((await fs.readFile(taskArtifact, "utf8")).includes(`## Changed Areas\n\n- \`${claim}\``));
  await fs.writeFile(taskArtifact, aliasedTaskBytes, "utf8");
  await fs.mkdir(path.join(fixture.execution, "tasks", "src"), { recursive: true });
  await fs.writeFile(path.join(fixture.execution, "tasks", "src/example.txt"), "ambiguous\n", "utf8");
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: semanticExecutionResponse,
      workspace,
      taskArtifact,
    }),
    /ambiguous across task and workspace bases/u,
  );
  await fs.rm(path.join(fixture.execution, "tasks", "src"), { recursive: true, force: true });
  await fs.writeFile(taskArtifact, canonicalTaskBytes, "utf8");
  const semanticBlockedExecutionResponse = JSON.stringify({
    ...semanticExecutionPayload,
    status: "BLOCKED",
    commands: [],
  });
  const blockedExecutionBundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE",
    response: semanticBlockedExecutionResponse,
    workspace,
    taskArtifact,
  });
  assert.match(blockedExecutionBundle, /^### implementation-check-01\n- Automatic check round: 1\/3\n- Status: BLOCKED/mu);
  assert.match(blockedExecutionBundle, /- Commands: none/u);
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: `Operation: EXECUTE_SLICE\n${semanticExecutionResponse}`,
      workspace,
      taskArtifact,
    }),
    /canonical JSON object/u,
  );
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: JSON.stringify({ ...semanticExecutionPayload, translatedStatus: "TESTS_PASS" }),
      workspace,
      taskArtifact,
    }),
    /unknown semantic execution payload field/u,
  );
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: JSON.stringify({ ...semanticExecutionPayload, commands: [{ command: "node --test", exit: "0" }] }),
      workspace,
      taskArtifact,
    }),
    /exit must be an integer/u,
  );
  const multiCommandRecordCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs", "--exit", "0",
    "--command", "node --test test/todo-store.test.mjs", "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(multiCommandRecordCli.status, 0, multiCommandRecordCli.stderr);
  assert.match(multiCommandRecordCli.stdout, /- `node --test test\/example\.test\.mjs` \| exit:0\n  - `node --test test\/todo-store\.test\.mjs` \| exit:0/u);
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: JSON.stringify({
        ...JSON.parse(semanticValidationResponse),
        verifiedScope: "localized scope",
      }),
      workspace,
      taskArtifact,
    }),
    /unknown semantic validation payload field: verifiedScope/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: `Type: initial\n${semanticValidationResponse}`,
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    }),
    /single raw JSON object/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: [
        "Status: PASS",
        "Escopo verificado: localized scope",
        "HEAD: fixture-head",
        "Commands:",
        "  - `node --test test/example.test.mjs` | exit:0",
        "Evidence: focused validation passed",
        "Finding references: none",
        "Finding dispositions: none",
        "Blockers: none",
        "Unexpected workspace effects: none",
        "Persistence summary: semantic result returned",
      ].join("\n"),
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    }),
    /single raw JSON object/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundle({
      operation: "EXECUTE_SLICE",
      values: validationValues,
      workspace,
      taskArtifact,
      targets: [physicalTarget],
      commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    }),
    /validation bundle operation must be VALIDATE_SLICE/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundle({
      operation: "VALIDATE_SLICE",
      values: validationValues.slice(0, -1),
      workspace,
      taskArtifact,
      targets: [physicalTarget],
      commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    }),
    /exactly 10 values/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundle({
      operation: "VALIDATE_SLICE",
      values: validationValues,
      workspace,
      taskArtifact,
      targets: [physicalTarget, physicalTarget],
      commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    }),
    /duplicate (?:task-relative claim|physical target)/u,
  );
  const validationBundleCliArgs = [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--validation-bundle", "--operation", "VALIDATE_SLICE",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
  ];
  for (const value of validationValues) validationBundleCliArgs.push("--value", value);
  validationBundleCliArgs.push("--target", physicalTarget, "--command", "node", "--test", "test/example.test.mjs", "--exit", "0");
  const validationBundleCli = spawnSync(process.execPath, validationBundleCliArgs, { encoding: "utf8" });
  assert.equal(validationBundleCli.status, 0, validationBundleCli.stderr);
  assert.equal(validationBundleCli.stdout.trimEnd(), validationBundle);
  const responseCliArgs = [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--response", "--operation", "EXECUTE_SLICE",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
  ];
  for (const [label, value] of Object.entries(responseFields)) {
    if (label !== "Operation") responseCliArgs.push("--value", value);
  }
  responseCliArgs.push("--target", physicalTarget, "--command", "node", "--test", "test/example.test.mjs", "--exit", "0");
  const responseCli = spawnSync(process.execPath, responseCliArgs, { encoding: "utf8" });
  assert.equal(responseCli.status, 0, responseCli.stderr);
  assert.equal(responseCli.stdout.trimEnd(), response);
  const translatedLabelCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--response", "--operation", "EXECUTE_SLICE",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--field", "Tipo de validação=1/3",
  ], { encoding: "utf8" });
  assert.equal(translatedLabelCli.status, 1);
  assert.match(translatedLabelCli.stderr, /unknown option --field/u);
  await assert.rejects(
    serializeRunnerResponse({ operation: "EXECUTE_SLICE", fields: { ...responseFields, Operation: "Operação" }, workspace, taskArtifact, targets: [physicalTarget], commands: [{ command: "node --test", exit: 0 }] }),
    /response Operation must be EXECUTE_SLICE/u,
  );
  const backtickRecord = await serializeRunnerRecord({
    workspace, taskArtifact, targets: [physicalTarget], commands: [{ command: "node `bad`", exit: 0 }],
  });
  assert.ok(backtickRecord.includes(`json:${JSON.stringify("node `bad`")} | exit:0`));
  await assert.rejects(
    serializeRunnerRecord({ workspace, taskArtifact, targets: [physicalTarget], commands: [] }),
    /at least one executed command/u,
  );
  await assert.rejects(
    serializeRunnerEvidence({ workspace, taskArtifact, targets: [physicalTarget, physicalTarget] }),
    /duplicate (?:task-relative claim|physical target)/u,
  );
  await assert.rejects(
    serializeRunnerEvidence({ workspace, taskArtifact, targets: [path.join(workspace, "src/missing.txt")] }),
    /not available/u,
  );

  const candidateRoot = path.join(await temporary(t, "stnl-runner-evidence-invalid-"), "execution");
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });
  const candidateTask = path.join(candidateRoot, "tasks/slice-01.md");
  let invalidTask = await fs.readFile(candidateTask, "utf8");
  invalidTask = invalidTask.replace("- [ ] 1.1", "- [x] 1.1");
  invalidTask = replaceSection(invalidTask, "Changed Areas", "- `../../src/example.txt`");
  invalidTask = replaceSection(
    invalidTask,
    "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "TESTS_PASS", 1).replace(
      `sha256:${VALIDATED_HASH}`,
      `sha256:${"a".repeat(63)}`,
    ),
  );
  await fs.writeFile(candidateTask, invalidTask, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /malformed Tested state|unexpected nested or continuation content under Tested state/u,
  );
});


test("execution evidence is produced on a same-depth candidate and published as one task replacement", async t => {
  const f = await nestedLifecycleWorkspace(t), liveTask = path.join(f.execution, 'tasks/slice-01.md');
  const before = await readPreparationArtifacts(f.execution);
  const result = await implementExample(f, { publish: false });
  const prepared = result.copy;
  assert.equal(path.dirname(prepared.candidateRoot), path.dirname(f.requirements));
  const target = path.join(f.root, 'src/example.txt');
  const claim = path.relative(path.dirname(liveTask), target).split(path.sep).join('/');
  assert.equal(path.relative(prepared.candidateTaskArtifact, target), path.relative(liveTask, target));
  assert.ok(result.bundle.includes('`' + claim + '` | sha256:' + VALIDATED_HASH));
  assert.equal(await fs.realpath(path.resolve(path.dirname(prepared.candidateTaskArtifact), claim)), await fs.realpath(target));
  assert.deepEqual(await readPreparationArtifacts(f.execution), before);
  const candidate = await fs.readFile(prepared.candidateTaskArtifact);
  assert.equal((await validateExecutionCandidate(f.requirements, prepared.candidateExecutionRoot)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  const published = await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-01', candidateRoot: prepared.candidateRoot });
  assert.equal(published.state, 'IMPLEMENTED_AWAITING_VALIDATION');
  const installed = await fs.readFile(liveTask, 'utf8');
  const expected = candidate.toString('utf8').replace('- Current action: implement approved delivery', '- Current action: continue admitted operation');
  assert.notEqual(expected, candidate.toString('utf8'), 'current Continuity publication action is explicitly accounted for');
  assert.equal(installed, expected);
  const after = await readPreparationArtifacts(f.execution);
  for (const name of ['plan.md', 'plans/slice-01.md', 'tasks.md']) assert.equal(after.get(name), before.get(name));
  assert.match(after.get('tasks/slice-01.md'), /### implementation-check-01/);
  assert.equal((await readExecutionActivation(f.requirements)).activation.activeAttempt, null);
  assert.equal(published.retainedCandidate, prepared.candidateRoot);
  assert.deepEqual(await fs.readFile(prepared.candidateTaskArtifact), candidate, 'confirmed current producer retains disposable candidate for explicit inspection');
  const marker = JSON.parse(await fs.readFile(prepared.candidateRoot + '.copy.json'));
  assert.equal(marker.cleanup.status, 'pending'); assert.ok(marker.confirmation);
});





async function copyDirectory(source, destination) {
  await fs.cp(source, destination, { recursive: true });
  return destination;
}

function gitShowText(revision, file) {
  const result = spawnSync("git", ["show", `${revision}:${file}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function spawnResult(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function replaceAll(text, values) {
  let result = text;
  for (const [from, to] of values) result = result.replaceAll(from, to);
  return result;
}

async function standaloneWorkspace(t, { count = 1 } = {}) {
  const root = await temporary(t);
  // TMPDIR can be the repository's ignored tmp. Give each synthetic project
  // its own boundary so the resolver never adopts the host repository's .git.
  await fs.mkdir(path.join(root, '.git'));
  const requirements = path.join(root, "requirements.md");
  await fs.writeFile(requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  const execution = path.join(root, "requirements-execution");
  return { root, requirements, execution, count, test: t };
}



function headerReady(text) {
  return text.replace("status: draft", "status: ready").replaceAll("Review state: pending", "Review state: approved");
}

function omitInitialRecoveryFields(text) {
  return text.replace(/\nFor revision 1,[\s\S]*?\n## Serial Slice Order/u, "\n## Serial Slice Order");
}

function setPlanReviewState(text, ready) {
  return text
    .replace(/^status: (?:draft|ready)$/mu, `status: ${ready ? "ready" : "draft"}`)
    .replace(/^- Review state: (?:pending|approved)$/gmu, `- Review state: ${ready ? "approved" : "pending"}`);
}

async function renderTasks(fixture, { revision = 1, fingerprint = null,
  templateRoot = path.join(ROOT, "skills/workflows/stnl-execution-planner/templates"),
  outputExecutionRoot = fixture.execution } = {}) {
  const authority = fingerprint ?? await computeRequirementsAuthority(fixture.requirements);
  const requirementsMetadata = await fs.stat(fixture.requirements);
  const authorityPath = requirementsMetadata.isDirectory() ? path.join(fixture.requirements, "feature_spec.md") : fixture.requirements;
  const detailSource = path.relative(path.join(fixture.execution, "plans"), authorityPath).split(path.sep).join("/");
  await fs.mkdir(path.join(outputExecutionRoot, "tasks"), { recursive: true });
  const tasksTemplate = await fs.readFile(path.join(templateRoot, "tasks.template.md"), "utf8");
  const tasks = replaceAll(tasksTemplate, [
    ["01 - <name>", "01 - Delivery"], ["<observable delivery>", "observable result"],
  ]);
  await fs.writeFile(path.join(outputExecutionRoot, "tasks.md"), tasks);
  const taskTemplate = await fs.readFile(path.join(templateRoot, "slice-tasks.template.md"), "utf8");
  const task = replaceAll(taskTemplate, [
    ["<Name>", "Delivery"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", String(revision)],
    ["<Local observable delivery and its practical outcome.>", "Deliver observable example behavior."],
    ["<observable condition>", "Example bytes equal the required content"],
    ["<required evidence>", "node --test src/example.test.mjs asserts the example bytes"],
    ["`<artifact-relative authorized subtree or exact file>`", "`src`"],
    ["`<artifact-relative predicted file>`", "`src/example.txt`"],
    ["<protected semantic responsibility and exclusion>", "Preserve existing authentication, persistence and public contracts."],
    ["<technical action>", "Implement behavior and its prepared assertion"],
    ["<test, command, suite, or observable check>", "node --test src/example.test.mjs"],
    ["<verification file>", "src/example.test.mjs"],
    ["<reviewed indirect dependencies>", "The prepared Node test reads src/example.txt inside the approved product directory; no external inputs."],
  ]);
  await fs.writeFile(path.join(outputExecutionRoot, "tasks/slice-01.md"), task);
}

// Current joint preparation replaces the removed split materialization helper.
// Legacy tests requesting materialized:false still receive the complete draft;
// their old phase expectations must be reconciled individually, never revived.
async function renderArtifacts(fixture, { materialized = true, planStatus = "ready", revision = 1, fingerprint = null } = {}) {
  const authority = fingerprint ?? await computeRequirementsAuthority(fixture.requirements);
  const requirementsMetadata = await fs.stat(fixture.requirements);
  const authorityPath = requirementsMetadata.isDirectory() ? path.join(fixture.requirements, "feature_spec.md") : fixture.requirements;
  const globalSource = path.relative(fixture.execution, authorityPath).split(path.sep).join("/");
  const detailSource = path.relative(path.join(fixture.execution, "plans"), authorityPath).split(path.sep).join("/");
  fixture.root ??= requirementsMetadata.isDirectory() ? fixture.requirements : path.dirname(fixture.requirements);
  const implementationTarget = path.join(fixture.root, "src/example.txt");
  await fs.mkdir(path.dirname(implementationTarget), { recursive: true });
  await fs.writeFile(implementationTarget, VALIDATED_CONTENT, "utf8");
  await fs.writeFile(path.join(fixture.root, "src/example.test.mjs"),
    'import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";test("AC-001 example bytes",()=>assert.equal(fs.readFileSync("src/example.txt","utf8"),'+JSON.stringify(VALIDATED_CONTENT)+'));\n');
  const operation = await fs.stat(fixture.execution).then(() => "REPLAN").catch(error => { if (error.code === "ENOENT") return "PLAN"; throw error; });
  const prepared = await preparePreparationCandidate({ specPath: fixture.requirements, operation });
  const output = prepared.candidateExecutionRoot;
  fixture.test?.after(async () => {
    await fs.rm(output, { recursive: true, force: true });
    await fs.rm(output + '.owner.json', { force: true });
  });
  await fs.mkdir(path.join(output, "plans"), { recursive: true });
  const planTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  const global = replaceAll(planTemplate, [
    ["`<relative path>`", `\`${globalSource}\``], ["sha256:<64hex>", `sha256:${authority}`],
    ["<positive integer>", String(revision)], ["<compact objective>", "Deliver observable behavior"],
    ["<compact strategy>", "Implement and validate serially"], ["01 - <name>", "01 - Delivery"],
    ["<result>", "observable result"],
    ["directory: `<repository-relative physical target>`", "directory: `src`"],
    ["<risk, boundary, or explicit final integration slice>", "Preserve authentication, persistence and public contracts."],
  ]);
  await fs.writeFile(path.join(output, "plan.md"), global);
  const slicePlanTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  const slicePlan = replaceAll(slicePlanTemplate, [
    ["<Name>", "Delivery"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", String(revision)],
    ["<One coherent delivery and how it is observed.>", "Deliver observable behavior."],
    ["<included work>", "Implement the approved behavior and its prepared check."],
    ["<excluded work and boundary with later slices>", "No unrelated work."],
    ["`<artifact-relative authorized subtree or exact file>`", "`src`"],
    ["`<artifact-relative predicted file>`", "`src/example.txt`"],
    ["<auth, persistence and public-contract boundaries requiring semantic review>", "Preserve existing authentication, persistence and public contracts."],
    ["<earlier slice or none>", "none"],
    ["<risk and mitigation>", "Low risk; focused validation."], ["<bounded approach>", "One bounded change."],
    ["<test, command, suite, or observable check>", "node --test src/example.test.mjs"],
    ["<verification file>", "src/example.test.mjs"],
    ["<reviewed indirect dependencies>", "The prepared Node test reads src/example.txt inside the approved product directory; no external inputs."],
    ["<objective result and preserved boundary>", "Behavior is observable and bounded."],
  ]);
  await fs.writeFile(path.join(output, "plans/slice-01.md"), slicePlan);
  await renderTasks(fixture, { revision, fingerprint: authority, outputExecutionRoot: output });
  if (fixture.verificationRecipe) for (const name of ['plans/slice-01.md', 'tasks/slice-01.md']) {
    const file = path.join(output, name);
    await fs.writeFile(file, replaceSection(await fs.readFile(file, 'utf8'), 'Verification Recipe', fixture.verificationRecipe));
  }
  await publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: output });
  if (planStatus === "ready") {
    const review = await preparePreparationCandidate({ specPath: fixture.requirements, operation: "REVIEW_PLAN" });
    fixture.test?.after(async () => {
      await fs.rm(review.candidateExecutionRoot, { recursive: true, force: true });
      await fs.rm(review.candidateExecutionRoot + '.owner.json', { force: true });
    });
    for (const file of ["plan.md", "plans/slice-01.md", "tasks.md", "tasks/slice-01.md"]) {
      const target = path.join(review.candidateExecutionRoot, file);
      await fs.writeFile(target, headerReady(await fs.readFile(target, "utf8")));
    }
    await publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: review.candidateExecutionRoot,
      reviewDecision: { ...reviewDecision, summary: "Controlled offline joint review: AC-001 example bytes, serial ownership, prepared Node assertion and unchanged protected responsibilities. No independent model judgment is claimed." } });
  }
  fixture.preparation = { author: output, materialized, planStatus };
  return { authority };
}

async function setImplementationAreas(fixture, { global, detail, task } = {}) {
  if (global !== undefined) {
    await editPlan(fixture, (value) => value.replace(
      /`[^`\n]+`; example implementation/u,
      `\`${global}\`; example implementation`,
    ));
  }
  if (detail !== undefined) {
    await editSlicePlan(fixture, "slice-01", (value) => value.replace(
      /`[^`\n]+` — example implementation/u,
      `\`${detail}\` — example implementation`,
    ));
  }
  if (task !== undefined) {
    await editTask(fixture, (value) => value.replace(
      /(\| expected areas: )`[^`\n]+`; example implementation( \| requirement:)/u,
      `$1\`${task}\`; example implementation$2`,
    ));
  }
}

async function nestedLifecycleWorkspace(t, { materialized = true, planStatus = "ready", setup = null } = {}) {
  const root = await temporary(t, "stnl-path-semantics-");
  const repository = path.join(root, "repository with space ü");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const requirements = await copyDirectory(
    path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"),
    path.join(repository, "specs", "área segura", "feature Ω"),
  );
  const fixture = { root: repository, repository, requirements, execution: path.join(requirements, "execution"), test: t };
  await fs.mkdir(path.join(repository, "scripts"), { recursive: true });
  await fs.writeFile(path.join(repository, "scripts/validate.sh"), "#!/bin/sh\n", "utf8");
  await fs.mkdir(path.join(repository, "skills/workflows"), { recursive: true });
  await fs.writeFile(path.join(repository, "skills/workflows/example.mjs"), "export {};\n", "utf8");
  if (setup) await setup(fixture);
  await renderArtifacts(fixture, { materialized, planStatus });
  return fixture;
}

async function editTask(fixture, transform) {
  const file = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(file, "utf8");
  const after = transform(before);
  assert.notEqual(after, before, 'task stimulus was not applied to its current carrier');
  await fs.writeFile(file, after, "utf8");
}

async function editTasksIndex(fixture, transform) {
  const file = path.join(fixture.execution, "tasks.md");
  const before = await fs.readFile(file, "utf8");
  const after = transform(before);
  assert.notEqual(after, before, 'index stimulus was not applied to its current carrier');
  await fs.writeFile(file, after, "utf8");
}

async function editPlan(fixture, transform) {
  const file = path.join(fixture.execution, "plan.md");
  const before = await fs.readFile(file, 'utf8'); const after = transform(before);
  assert.notEqual(after, before, 'global Plan stimulus was not applied to its current carrier');
  await fs.writeFile(file, after, "utf8");
}

async function editSlicePlan(fixture, slice, transform) {
  const file = path.join(fixture.execution, "plans", `${slice}.md`);
  const before = await fs.readFile(file, 'utf8'); const after = transform(before);
  assert.notEqual(after, before, 'detailed Plan stimulus was not applied to its current carrier');
  await fs.writeFile(file, after, "utf8");
}

function reviseAuthority(text, oldHash, newHash, oldRevision, newRevision) {
  return text.replaceAll(`sha256:${oldHash}`, `sha256:${newHash}`).replaceAll(`Plan revision: ${oldRevision}`, `Plan revision: ${newRevision}`);
}

async function reviewJointFixture(fixture, { editCandidate = null } = {}) {
  const review = await preparePreparationCandidate({ specPath: fixture.requirements, operation: 'REVIEW_PLAN' });
  fixture.test?.after(() => fs.rm(review.candidateExecutionRoot, { recursive: true, force: true }));
  for (const [name, text] of await readPreparationArtifacts(review.candidateExecutionRoot)) {
    await fs.writeFile(path.join(review.candidateExecutionRoot, name), headerReady(text));
  }
  if (editCandidate) await editCandidate(review.candidateExecutionRoot);
  await publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: review.candidateExecutionRoot,
    reviewDecision: { ...reviewDecision, summary: 'Controlled joint review: example result, obligations, typed proof recipe and protected responsibilities examined together.' } });
  return review;
}

function jointContinuity(before, slices) {
  const header = '| Slice | Prior delivery ID | Relation | Prior preparation revision | Reason | Affected verification |\n|---|---|---|---|---|---|';
  return header + '\n' + slices.map(slice => {
    const prior = before.preparation.deliveries.find(d => d.slice === slice);
    return `| ${slice} | ${prior?.deliveryId ?? 'none'} | ${prior ? 'same' : 'new'} | ${prior ? before.tasks.get(slice).revision : 'none'} | ${prior ? 'Same example result and obligations retained' : 'Explicit later bounded example contribution'} | ${prior ? 'unchanged' : 'all'} |`;
  }).join('\n');
}

async function pristineRevisionCandidate(fixture, oldHash, newHash) {
  const before = await inspectExecutionState(fixture.requirements);
  assert.ok([...before.tasks.values()].every(task => task.pristine), 'pristine fixture cannot discard operational work');
  const prepared = await preparePreparationCandidate({ specPath: fixture.requirements, operation: 'REPLAN', revisionMode: 'pristine-replacement' });
  fixture.test?.after(() => fs.rm(prepared.candidateExecutionRoot, { recursive: true, force: true }));
  const revision = before.globalPlan.revision + 1;
  for (const [name, original] of await readPreparationArtifacts(prepared.candidateExecutionRoot)) {
    let text = setPlanReviewState(reviseAuthority(original, oldHash, newHash, before.globalPlan.revision, revision), false);
    if (name === 'plan.md') {
      text = text.replace(/^- (?:Revision mode|Replan reason|Supersedes open slices):.*\n/gmu, '');
      text = text.replace('- Objective:', '- Revision mode: pristine-replacement\n- Replan reason: Joint preparation needs the revised bounded example proof\n- Supersedes open slices: none\n- Objective:');
      text = replaceSection(text, 'Delivery Continuity', jointContinuity(before, [...before.tasks.keys()]));
    }
    await fs.writeFile(path.join(prepared.candidateExecutionRoot, name), text);
  }
  return { before, prepared, revision };
}

async function stagePristineReplacement(fixture, oldHash, newHash, { ready = false } = {}) {
  const { prepared } = await pristineRevisionCandidate(fixture, oldHash, newHash);
  await publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: prepared.candidateExecutionRoot });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, 'PENDING_REPLAN_DRAFT');
  if (ready) await reviewJointFixture(fixture);
  return prepared;
}

async function replacePlanningOnly(fixture, oldHash, newHash, { ready = false } = {}) {
  const { prepared } = await pristineRevisionCandidate(fixture, oldHash, newHash);
  for (const name of ['plan.md', 'plans/slice-01.md', 'tasks/slice-01.md']) {
    const file = path.join(prepared.candidateExecutionRoot, name); const before = await fs.readFile(file, 'utf8');
    const after = before.replaceAll('Deliver observable behavior', 'Deliver replacement planning authority').replaceAll('Deliver observable example behavior', 'Deliver replacement planning example behavior');
    assert.notEqual(after, before); await fs.writeFile(file, after);
  }
  await publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: prepared.candidateExecutionRoot });
  if (ready) await reviewJointFixture(fixture);
  return prepared;
}

async function appendRecoveryPlan(fixture, oldHash, newHash, { ready = false, supersedes = 'slice-01 -> slice-02', newContribution = 'complete' } = {}) {
  const before = await inspectExecutionState(fixture.requirements);
  const prepared = await preparePreparationCandidate({ specPath: fixture.requirements, operation: 'REPLAN', revisionMode: 'append-only-extension' });
  fixture.test?.after(() => fs.rm(prepared.candidateExecutionRoot, { recursive: true, force: true }));
  const root = prepared.candidateExecutionRoot; const revision = before.globalPlan.revision + 1;
  const previous = [...before.tasks.keys()].at(-1);
  const number = BigInt(previous.slice(6)) + 1n;
  const slice = 'slice-' + number.toString().padStart(2, '0');
  let global = setPlanReviewState(reviseAuthority(await fs.readFile(path.join(root, 'plan.md'), 'utf8'), oldHash, newHash, before.globalPlan.revision, revision), false);
  global = global.replace(/^- (?:Revision mode|Replan reason|Supersedes open slices):.*\n/gmu, '');
  global = global.replace('- Objective:', `- Revision mode: append-only-extension\n- Replan reason: requirements or integration authority changed\n- Supersedes open slices: ${supersedes}\n- Objective:`);
  const row = global.split('\n').find(line => line.endsWith(`| plans/${previous}.md |`)); assert.ok(row);
  const added = row.replace(/^\| [0-9]+ - [^|]+/u, '| ' + slice.slice(6) + ' - Recovery ').replace(/\| [^|]+ \| ([^|]+) \| AC-/u, '| reconciled result | ' + previous.slice(6) + ' | AC-').replace(previous + '.md', slice + '.md');
  global = global.replace(row, row + '\n' + added);
  global = replaceSection(global, 'Delivery Continuity', jointContinuity(before, [...before.tasks.keys(), slice]));
  await fs.writeFile(path.join(root, 'plan.md'), global);
  let index = await fs.readFile(path.join(root, 'tasks.md'), 'utf8');
  const indexRow = index.split('\n').find(line => line.includes(`| tasks/${previous}.md |`)); assert.ok(indexRow);
  const newRow = `| [ ] | ${slice.slice(6)} - Recovery | reconciled result | ${previous.slice(6)} | tasks/${slice}.md | pending | pending |`;
  await fs.writeFile(path.join(root, 'tasks.md'), index.replace(indexRow, indexRow + '\n' + newRow));
  const newPlan = setPlanReviewState(reviseAuthority(await fs.readFile(path.join(root, 'plans', previous + '.md'), 'utf8'), oldHash, newHash, before.tasks.get(previous).revision, revision), false)
    .replace(/^- Delivery ID:.*\n/mu, '').replaceAll(`Slice ${previous.slice(6)}`, `Slice ${slice.slice(6)}`).replaceAll(`- Slice: ${previous.slice(6)}`, `- Slice: ${slice.slice(6)}`);
  await fs.writeFile(path.join(root, 'plans', slice + '.md'), newPlan);
  const task = setPlanReviewState(reviseAuthority(await fs.readFile(path.join(fixture.preparation.author, 'tasks/slice-01.md'), 'utf8'), oldHash, newHash, 1, revision), false)
    .replace(/^- Delivery ID:.*\n/mu, '').replaceAll('Slice 01', 'Slice ' + slice.slice(6)).replaceAll('- Slice: 01', '- Slice: ' + slice.slice(6))
    .replaceAll('slice-01', slice).replaceAll('1.1', number + '.1').replace(/^- History source:.*$/mu, '- History source: runtime');
  const contribution = newContribution === 'partial'
    ? task.replace('contribution: complete | full owner: ' + slice, 'contribution: partial | full owner: slice-01') : task;
  await fs.writeFile(path.join(root, 'tasks', slice + '.md'), contribution);
  await publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: root });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, 'PENDING_REPLAN_DRAFT');
  if (ready) await reviewJointFixture(fixture);
  return prepared;
}

async function commitAppendRecovery(fixture, oldHash, newHash, { resolveDivergence = false } = {}) {
  const before = await inspectExecutionState(fixture.requirements);
  if (before.globalPlan.status === 'draft') await reviewJointFixture(fixture);
  const current = await inspectExecutionState(fixture.requirements);
  assert.equal(current.globalPlan.revisionMode, 'append-only-extension');
  assert.equal(current.tasks.get('slice-01').final.result, 'SUPERSEDED');
  if (resolveDivergence) assert.equal(current.activeDivergences.length, 0);
  return current;
}

async function addSecondPristineSlice(fixture) {
  const authority = await computeRequirementsAuthority(fixture.requirements);
  const { before, prepared, revision } = await pristineRevisionCandidate(fixture, authority, authority);
  const root = prepared.candidateExecutionRoot;
  const slices = [...before.tasks.keys(), 'slice-02'];
  let plan = await fs.readFile(path.join(root, 'plan.md'), 'utf8');
  const row = plan.split('\n').find(line => line.startsWith('| 01 -'));
  assert.ok(row);
  plan = plan.replace(row, row + '\n' + row.replace('01 - Delivery', '02 - Later').replace('| - | AC-001', '| 01 | AC-001').replace('slice-01', 'slice-02'));
  plan = replaceSection(plan, 'Delivery Continuity', jointContinuity(before, slices));
  await fs.writeFile(path.join(root, 'plan.md'), plan);
  let index = await fs.readFile(path.join(root, 'tasks.md'), 'utf8');
  const indexRow = index.split('\n').find(line => line.startsWith('| [ ] | 01'));
  assert.ok(indexRow);
  index = index.replace(indexRow, indexRow + '\n' + indexRow.replace('01 - Delivery', '02 - Later').replace('| - | tasks', '| 01 | tasks').replace('slice-01', 'slice-02'));
  await fs.writeFile(path.join(root, 'tasks.md'), index);
  for (const folder of ['plans', 'tasks']) {
    const original = await fs.readFile(path.join(root, folder, 'slice-01.md'), 'utf8');
    let text = original.replaceAll('Slice 01', 'Slice 02').replaceAll('- Slice: 01', '- Slice: 02').replaceAll('slice-01', 'slice-02').replaceAll('Delivery', 'Later').replaceAll('1.1', '2.1');
    text = text.replace(/^- Later ID:.*\n/mu, '').replace(/^- Delivery ID:.*\n/mu, '');
    if (folder === 'tasks') {
      text = text.replace('contribution: complete | full owner: slice-02', 'contribution: partial | full owner: slice-01');
      text = text.replace(/^- History source:.*$/mu, '- History source: runtime');
    }
    await fs.writeFile(path.join(root, folder, 'slice-02.md'), text);
  }
  await publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: root });
  await reviewJointFixture(fixture);
  const after = await inspectExecutionState(fixture.requirements);
  assert.equal(after.globalPlan.revision, revision); assert.equal(after.tasks.size, 2);
  assert.equal(after.state, 'MATERIALIZED_PRISTINE');
}

async function stageThirdRecovery(fixture, authority, { ready = false } = {}) {
  return appendRecoveryPlan(fixture, authority, authority, { ready, supersedes: 'slice-02 -> slice-03' });
}

async function commitThirdRecovery(fixture, authority) {
  const before = await inspectExecutionState(fixture.requirements);
  if (before.globalPlan.status === 'draft') await reviewJointFixture(fixture);
  const current = await inspectExecutionState(fixture.requirements);
  assert.equal(current.tasks.get('slice-02').final.result, 'SUPERSEDED');
  return current;
}

function replaceSection(text, heading, content) {
  const pattern = new RegExp(`(## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, "u");
  assert.match(text, pattern);
  return text.replace(pattern, `$1${content}\n`);
}

const ACTIVE_FINDING = `### finding-01

- Severity: blocking
- State: active
- Origin: attempt-01
- Problem: Observable behavior is wrong.
- Evidence: Focused validation reproduced the mismatch.
- Impact: AC-001 is not satisfied.
- Related authority: AC-001 and slice-01
- Expected correction: Produce the required behavior.`;

const ACTIVE_FINDING_02 = ACTIVE_FINDING
  .replaceAll("finding-01", "finding-02")
  .replace("Observable behavior is wrong.", "A second observable behavior is wrong.");

const ACTIVE_DIVERGENCE = `### divergence-01

- Severity: blocking
- State: active
- Origin: EXECUTE_SLICE
- Problem: Approved scope omits a required dependency.
- Evidence: The implementation cannot remain inside the slice.
- Required authority operation: REPLAN`;

function attemptRecord(number, status, { type = number === 1 ? "initial" : "revalidation", references = "none", dispositions = "none", command = "node --test", evidence = `Objective ${status} evidence.` } = {}) {
  const id = String(number).padStart(2, "0");
  const commands = status === "BLOCKED" ? "- Commands: none" : `- Commands:\n  - \`${command}\` | exit:0`;
  return `### attempt-${id}

- Type: ${type}
- Status: ${status}
- HEAD: fixture
- Verified scope: ../../src/example.txt
- ${commands.slice(2)}
- Evidence: ${evidence}
- Finding references: ${references}
- Finding dispositions: ${dispositions}
- Blockers: none
- Unexpected workspace effects: none
- Persistence summary: ${status} persisted.`;
}

function checkRecord(prefix, number, status, round, { cycle = null } = {}) {
  const id = String(number).padStart(2, "0");
  const commands = new Set(["TESTS_NOT_APPLICABLE", "BLOCKED"]).has(status)
    ? "- Commands: none"
    : `- Commands:\n  - \`node --test\` | exit:${status === "TESTS_PASS" ? 0 : 1}`;
  const findings = prefix === "findings-check" ? `
- Findings cycle: ${cycle}
- Finding IDs: finding-01
- Findings verified: finding-01
- Corrections covered: ../../src/example.txt
- Regressions: none
- Unsupported active findings: none` : "";
  const nonApplicable = status === "TESTS_NOT_APPLICABLE" ? `
- Non-applicability rationale: no executable verification applies to this documentary-only change
- No verification-command confirmation: no verification command was executed` : "";
  return `### ${prefix}-${id}

- Automatic check round: ${round}/3
- Status: ${status}
- HEAD: fixture
- Tested scope: ../../src/example.txt
- Tested state:
  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}
- Discovery sources: approved task and repository tests
- Discovery actions: inspected applicable test commands
- Verification types considered: focused automated test
${commands}
- Selected checks: node --test
- Selection rationale: focused authoritative behavior check
- Coverage: AC-001 observable behavior
- Failures: ${status === "TESTS_FAIL" ? "observable mismatch" : "none"}
- Blockers: ${status === "BLOCKED" ? "external prerequisite unavailable" : "none"}
- Unexpected workspace effects: none
- Persistence summary: ${status} persisted.${round > 1 ? `
- Prior-round failure: prior verification command failed
- Correction applied: bounded objective correction
- Correction paths: ../../src/example.txt
- Updated scope: ../../src/example.txt
- In-slice rationale: correction remains within AC-001` : ""}${findings}${nonApplicable}`;
}

const PASS_ATTEMPT = attemptRecord(1, "PASS");
const NEEDS_FIX_ATTEMPT = attemptRecord(1, "NEEDS_FIX", { references: "finding-01", dispositions: "finding-01=active" });
const BLOCKED_ATTEMPT = attemptRecord(1, "BLOCKED");

const VALIDATED_CONTENT = "validated behavior\n";
const VALIDATED_HASH = createHash("sha256").update(VALIDATED_CONTENT).digest("hex");

async function writeValidatedPath(fixture, relative = "../../src/example.txt", content = VALIDATED_CONTENT) {
  const target = path.resolve(fixture.execution, "tasks", relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

function passBase({ attempt = 1, relative = "../../src/example.txt", hash = VALIDATED_HASH, removed = false } = {}) {
  const identifier = `attempt-${String(attempt).padStart(2, "0")}`;
  return `- Origin attempt: ${identifier}
- Attempt type: ${attempt === 1 ? "initial" : "revalidation"}
- HEAD: fixture
- Result: PASS
- Files:
  - \`${relative}\` | ${removed ? "REMOVED" : `sha256:${hash}`}
- Authoritative commands:
  - \`node --test\` | exit:0
- Evidence summary: Objective PASS evidence.`;
}

const PASS_BASE = passBase();

function publishPassResult(text) {
  return replaceSection(
    replaceSection(text, "Diff Summary", "- Implemented and validated the observable behavior."),
    "Final Result",
    "- PASS",
  );
}

function delegationBlocker(operation, kind, { state = "active", after = "none", resolution = null } = {}) {
  return `- Operation: ${operation}
- Kind: ${kind}
- State: ${state}
- After record: ${after}
- Causes:
  - configured independent runner could not produce a valid result
- Required action: retry the same operation after restoring the runner${resolution === null ? "" : `\n- Resolution: ${resolution}`}`;
}

async function rejectedWithRecovery(promise, expected) {
  let captured = null;
  await assert.rejects(promise, (error) => {
    captured = error;
    assert.match(error.message, expected);
    return true;
  });
  assert.ok(captured instanceof ExecutionContractError);
  return captured;
}

async function isolatedContractCopy(fixture) {
  const parent = await temporary(fixture.test, 'stnl-contract-mutant-');
  return copyDirectory(fixture.execution, path.join(parent, 'execution'));
}

function assertRecoveryTarget(result, expected) {
  const target = result.recoveryTargets.find((candidate) => (
    candidate.operation === expected.operation && candidate.slice === (expected.slice ?? null)
  ));
  assert.ok(target, `missing recovery target ${expected.operation} ${expected.slice ?? "unscoped"}`);
  for (const [field, value] of Object.entries(expected)) assert.equal(target[field], value, `${field} disagrees`);
  return target;
}

async function passFirstSlice(fixture) {
  fixture.exampleImplementation = await implementExample(fixture);
  fixture.exampleValidation = await validateExample(fixture);
  assert.equal((await inspectExecutionState(fixture.requirements)).tasks.get('slice-01').validation.historicalPass, 'attempt-01');
}

async function prepareFindingsCorrection(fixture, findingIdsLabel = "Finding IDs") {
  fixture.exampleImplementation = await implementExample(fixture);
  fixture.exampleValidation = await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  await writeValidatedPath(fixture, '../../src/example.txt', 'incorrect behavior before the owned correction\n');
  fixture.exampleCorrection = await correctExample(fixture, { content: VALIDATED_CONTENT });
  if (findingIdsLabel !== 'Finding IDs') await editTask(fixture, value => value.replace('- Finding IDs: finding-01', `- ${findingIdsLabel}: finding-01`));
}

test('shared producers establish current PASS, NEEDS_FIX, correction and append-only recovery controls', async t => {
  const completed = await standaloneWorkspace(t); await renderArtifacts(completed); await passFirstSlice(completed);
  const pass = await inspectExecutionState(completed.requirements);
  assert.equal(pass.state, 'COMPLETE'); assert.equal(pass.tasks.get('slice-01').implementationChecks.length, 1);
  assert.equal(pass.tasks.get('slice-01').attempts.length, 1);
  const corrected = await standaloneWorkspace(t); await renderArtifacts(corrected); await prepareFindingsCorrection(corrected);
  const before = await inspectExecutionState(corrected.requirements);
  assert.equal(before.state, 'FINDINGS_CORRECTED'); assert.equal(before.tasks.get('slice-01').findingsChecks.length, 1);
  const receipt = await fs.readFile(corrected.exampleCorrection.captured.receiptFile);
  const task = await fs.readFile(path.join(corrected.execution, 'tasks/slice-01.md'));
  const authority = await computeRequirementsAuthority(corrected.requirements);
  await appendRecoveryPlan(corrected, authority, authority);
  const pending = await inspectExecutionState(corrected.requirements);
  assert.equal(pending.state, 'PENDING_REPLAN_DRAFT');
  const index = JSON.parse(await fs.readFile(path.join(corrected.execution, 'continuity.json')));
  const history = index.deliveries.find(d => d.deliveryId === before.tasks.get('slice-01').deliveryId).history;
  assert.deepEqual(await fs.readFile(path.resolve(corrected.execution, history.at(-1).taskRef.path)), task);
  await commitAppendRecovery(corrected, authority, authority, { resolveDivergence: true });
  const current = await inspectExecutionState(corrected.requirements);
  assert.equal(current.tasks.get('slice-01').final.result, 'SUPERSEDED');
  assert.equal(current.normalHandoff.slice, 'slice-02');
  assert.deepEqual(current.tasks.get('slice-01').findingsChecks, before.tasks.get('slice-01').findingsChecks);
  assert.deepEqual(await fs.readFile(corrected.exampleCorrection.captured.receiptFile), receipt);
  assert.notEqual(current.tasks.get('slice-01').deliveryId, current.tasks.get('slice-02').deliveryId);
  await stageThirdRecovery(corrected, authority);
  await commitThirdRecovery(corrected, authority);
  const third = await inspectExecutionState(corrected.requirements);
  assert.equal(third.globalPlan.revision, 3);
  assert.equal(third.tasks.get('slice-01').final.planRevision, 2);
  assert.equal(third.tasks.get('slice-02').final.planRevision, 3);
  assert.equal(third.normalHandoff.slice, 'slice-03');
  assert.deepEqual(third.tasks.get('slice-01').findingsChecks, before.tasks.get('slice-01').findingsChecks);
  assert.deepEqual(await fs.readFile(corrected.exampleCorrection.captured.receiptFile), receipt);
});

test("all execution skills bundle byte-identical self-contained state runtimes", async () => {
  const stateSkills = [...SKILLS, "stnl-spec-roadmap", "stnl-spec-test-runbook"];
  for (const [name, skillNames] of [["execution-state.mjs", stateSkills], ["validate-execution-state.mjs", SKILLS]]) {
    const copies = await Promise.all(skillNames.map((skill) => fs.readFile(path.join(ROOT, "skills", "workflows", skill, "runtime", name))));
    for (const copy of copies.slice(1)) assert.deepEqual(copy, copies[0], `${name} copies differ`);
    const source = copies[0].toString("utf8");
    assert.doesNotMatch(source, /stnl-spec-lifecycle-manager|\.\.\/\.\.\//u);
  }
});

test("executor and quality-manager bundle one byte-identical managed slice context", async () => {
  const copies = await Promise.all(["stnl-slice-executor", "stnl-slice-quality-manager"].map((skill) =>
    fs.readFile(path.join(ROOT, "skills", "workflows", skill, "runtime", "managed-slice-context.mjs"))));
  assert.deepEqual(copies[0], copies[1]);
});

test("distributed validation evidence serializers remain byte-identical across isolated skills", async () => {
  const executor = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"));
  const qualityManager = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/serialize-runner-evidence.mjs"));
  assert.deepEqual(qualityManager, executor);
});

// Uses current joint preparation, activation, native capture and strict publication.
test("validation overlap paths may repeat across records but not within one record", async () => {
  await runOwnedContract("overlap-sets");
});

test("an isolated copied skill runs the stable self-contained preflight CLI", async (t) => {
  const root = await temporary(t);
  const copied = path.join(root, "copied skill ü");
  await fs.cp(path.join(ROOT, "skills/workflows/stnl-slice-executor"), copied, { recursive: true });
  const requirements = path.join(root, "requirements.md");
  await fs.writeFile(requirements, "# Isolated requirements\n");
  const invoke = args => spawnSync(process.execPath, [path.join(copied, "runtime/validate-execution-state.mjs"), ...args], { encoding: "utf8", cwd: root });
  const result = invoke([requirements, "PLAN"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS: PLAN preflight state=EMPTY authority=sha256:[0-9a-f]{64}$/mu);
  const joint = await standaloneWorkspace(t);
  await renderArtifacts(joint, { planStatus: "draft" });
  const draft = invoke([joint.requirements, "--handoff-after", "PLAN"]);
  assert.equal(draft.status, 0, draft.stderr);
  const draftHandoff = JSON.parse(draft.stdout);
  assert.equal(draftHandoff.normal_handoff.workflowSkill, "stnl-plan-reviewer");
  assert.equal(draftHandoff.normal_handoff.invocation, "OPERATION=REVIEW_PLAN");
  assert.deepEqual(new Set(draftHandoff.legal_operations.map(({ operation }) => operation)), new Set(["REVIEW_PLAN", "REPLAN"]));
  const review = await preparePreparationCandidate({ specPath: joint.requirements, operation: "REVIEW_PLAN" });
  for (const file of ["plan.md", "plans/slice-01.md", "tasks.md", "tasks/slice-01.md"]) {
    const target = path.join(review.candidateExecutionRoot, file);
    await fs.writeFile(target, headerReady(await fs.readFile(target, "utf8")));
  }
  await publishPreparationCandidate({ specPath: joint.requirements, candidateExecutionRoot: review.candidateExecutionRoot, reviewDecision });
  const ready = invoke([joint.requirements, "--handoff-after", "REVIEW_PLAN"]);
  assert.equal(ready.status, 0, ready.stderr);
  const handoff = JSON.parse(ready.stdout);
  assert.equal(handoff.normal_handoff.workflowSkill, "stnl-slice-executor");
  assert.equal(handoff.normal_handoff.invocation, "OPERATION=EXECUTE_SLICE");
  assert.equal(handoff.normal_handoff.slice, "slice-01");
  for (const operation of ["MATERIALIZE_TASKS", "REVIEW_TASKS"]) {
    const removed = invoke([joint.requirements, operation]);
    assert.equal(removed.status, 1);
    assert.match(removed.stderr, /unsupported operation/u);
  }
});

test("every touched model-authored execution writer requires candidate validation and strict readback", async () => {
  for (const skill of SKILLS) {
    const source = await fs.readFile(path.join(ROOT, `skills/workflows/${skill}/SKILL.md`), "utf8");
    if (["stnl-execution-planner", "stnl-plan-reviewer"].includes(skill)) {
      assert.match(source, /prepare-(?:task|plan)-candidate\.mjs/u, skill);
      assert.match(source, /serialize-plan-paths\.mjs/u, skill);
      assert.match(source, /publish-task-candidate\.mjs/u, skill);
      assert.match(source, skill === 'stnl-execution-planner' ? /validate the complete candidate[\s\S]*--handoff-after/u : /validates Plan and Tasks together[\s\S]*verifies readback/u, skill);
      assert.match(source, skill === 'stnl-execution-planner' ? /No MATERIALIZE_TASKS or REVIEW_TASKS operation exists/u : /No task materializer or optional task review follows/u, skill);
    } else {
      assert.match(source, /validate-execution-state\.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>/u, skill);
      assert.match(source, /contract\/model(?:-| )(?:enforced|enforcement|owned)/u, skill);
      assert.match(source, /strict(?:ly)? read(?:back| back)/u, skill);
      assert.match(source, /Findings IDs[\s\S]{0,180}Check discovery sources[\s\S]{0,80}Check discovery actions[\s\S]{0,240}--repair-known-contract/u, skill);
    }
  }
});

test("executor producer instructions require complete computed Tested state digests", async () => {
  const skill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  assert.match(skill, /file-backed[\s\S]{0,260}digest[\s\S]{0,260}64[- ]hex/u);
  assert.match(skill, /Never hand-type, truncate/u);
  assert.match(skill, /For managed launches, use exactly the snapshot-owned serializer in `\$STNL_RUNNER_EVIDENCE_SERIALIZER`; if it is absent, block/u);
  assert.match(skill, /Do not search a private home, source checkout, or benchmark snapshot for another serializer/u);
  assert.doesNotMatch(skill, /\$RUNNER_EVIDENCE_SERIALIZER\b/u);
});

test("the last VALIDATE_SLICE owns bounded global semantic review before terminal PASS", async () => {
  const source = await fs.readFile(
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/SKILL.md"),
    "utf8",
  );
  assert.match(source, /last open effective slice[\s\S]{0,700}global plan and serial order[\s\S]{0,500}Effective Validation Bases/iu);
  assert.match(source, /global requirements coverage[\s\S]{0,180}current authority[\s\S]{0,180}cross-slice consistency[\s\S]{0,220}integration or stabilization/iu);
  assert.match(source, /Missing authority, strategy, or unmaterialized integration work[\s\S]{0,180}`BLOCKED`[\s\S]{0,160}`REPLAN`/iu);
  assert.doesNotMatch(source, /GLOBAL_VALIDATE|FINALIZE_EXECUTION|stnl-execution-closer|OPERATION=CLOSE/u);
});

test("actual templates render a machine-unambiguous MATERIALIZED_PRISTINE task", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const task = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  assert.doesNotMatch(task, /^### (?:implementation-check|findings-check|attempt)-/gmu);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1")).state, "MATERIALIZED_PRISTINE");
});

test("normal workflow sequence is operation-aware and preserves independent legality", async (t) => {
  const registryProjection = Object.fromEntries(Object.entries(WORKFLOW_OPERATIONS)
    .filter(([skill]) => EXECUTION_OPERATION_SKILLS.includes(skill))
    .flatMap(([skill, operations]) => operations
      .map((operation) => [operation, skill])));
  assert.deepEqual(EXECUTION_WORKFLOW_SKILLS, registryProjection);
  for (const [operation, skill] of Object.entries(registryProjection)) assert.equal(workflowSkillForOperation(operation), skill);
  assert.throws(() => workflowSkillForOperation("GENERATE_RUNBOOK"), /no workflow skill owns/u);
  assert.throws(() => workflowSkillForOperation("INIT"), /no workflow skill owns/u);
  assert.throws(() => workflowSkillForOperation("RECONCILE"), /no workflow skill owns/u);

  const empty = await standaloneWorkspace(t);
  const emptyState = await inspectExecutionState(empty.requirements);
  assert.deepEqual(emptyState.legalOperations.map(({ operation }) => operation), ["PLAN"]);
  assert.deepEqual(emptyState.normalHandoff, {
    workflowSkill: "stnl-execution-planner",
    operation: "PLAN",
    invocation: "OPERATION=PLAN",
    slice: null,
  });

  const draft = await standaloneWorkspace(t);
  await renderArtifacts(draft, { materialized: false, planStatus: "draft" });
  const draftState = await inspectExecutionState(draft.requirements);
  assert.deepEqual(draftState.legalOperations.map(({ operation }) => operation), ["REVIEW_PLAN", "REPLAN"]);
  assert.equal(deriveNormalHandoff(draftState, "PLAN").workflowSkill, "stnl-plan-reviewer");
  assert.equal(deriveNormalHandoff(draftState, "PLAN").invocation, "OPERATION=REVIEW_PLAN");

  const ready = await standaloneWorkspace(t);
  await renderArtifacts(ready);
  const readyState = await inspectExecutionState(ready.requirements);
  assert.deepEqual(readyState.legalOperations.map(({ operation }) => operation), ["REPLAN", "EXECUTE_SLICE"]);
  assert.equal(deriveNormalHandoff(readyState, "REVIEW_PLAN").workflowSkill, "stnl-slice-executor");
  assert.equal(deriveNormalHandoff(readyState, "REVIEW_PLAN").invocation, "OPERATION=EXECUTE_SLICE");
  assert.equal(readyState.normalHandoff.slice, "slice-01");
  for (const operation of ["MATERIALIZE_TASKS", "REVIEW_TASKS"]) {
    assert.throws(() => workflowSkillForOperation(operation), /no workflow skill owns/u);
    await assert.rejects(preflightExecutionOperation(ready.requirements, operation), /unsupported operation/u);
  }
});

test("PLAN requires active lifecycle ready while standalone EMPTY remains available", async (t) => {
  const root = await temporary(t, "stnl-lifecycle-plan-gate-");
  const lifecycleFixtures = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures");
  const ready = await copyDirectory(path.join(lifecycleFixtures, "ready"), path.join(root, "ready"));
  assert.equal((await preflightExecutionOperation(ready, "PLAN")).state, "EMPTY");

  const draft = await copyDirectory(path.join(lifecycleFixtures, "ready"), path.join(root, "draft"));
  const draftFeature = path.join(draft, "feature_spec.md");
  await fs.writeFile(draftFeature, (await fs.readFile(draftFeature, "utf8")).replace("status: ready", "status: draft"), "utf8");
  const draftInspection = await inspectExecutionState(draft);
  assert.equal(draftInspection.state, "EMPTY");
  assert.equal(draftInspection.lifecycleStatus, "draft");
  assert.deepEqual(draftInspection.legalOperations, []);
  assert.equal(draftInspection.normalHandoff, null);
  await assert.rejects(preflightExecutionOperation(draft, "PLAN"), /lifecycle status draft.*PLAN requires ready/u);

  const blocked = await copyDirectory(path.join(lifecycleFixtures, "blocked"), path.join(root, "blocked"));
  const blockedInspection = await inspectExecutionState(blocked);
  assert.equal(blockedInspection.state, "EMPTY");
  assert.equal(blockedInspection.lifecycleStatus, "blocked");
  assert.deepEqual(blockedInspection.legalOperations, []);
  assert.equal(blockedInspection.normalHandoff, null);
  await assert.rejects(preflightExecutionOperation(blocked, "PLAN"), /lifecycle status blocked.*PLAN requires ready/u);

  const standalone = await standaloneWorkspace(t);
  assert.equal((await preflightExecutionOperation(standalone.requirements, "PLAN")).state, "EMPTY");
});

test("requirements changes in joint initial draft, REPLAN draft and reviewed preparation require REPLAN", async (t) => {
  for (const phase of ['initial-draft', 'revision-draft', 'reviewed']) {
    const ready = phase === 'reviewed';
    const root = await temporary(t, `stnl-pending-authority-${phase}-`);
    const fixtureRoot = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready");
    const workspace = await copyDirectory(fixtureRoot, path.join(root, "spec"));
    await fs.mkdir(path.join(workspace, ".git"));
    const fixture = { requirements: workspace, execution: path.join(workspace, "execution"), test: t };
    const { authority } = await renderArtifacts(fixture, { planStatus: phase === 'initial-draft' ? 'draft' : 'ready' });
    if (phase !== 'initial-draft') await stagePristineReplacement(fixture, authority, authority, { ready });
    assert.equal((await inspectExecutionState(workspace)).state, ready ? "MATERIALIZED_PRISTINE" : phase === 'initial-draft' ? 'PLANNED_DRAFT' : "PENDING_REPLAN_DRAFT");
    const pendingPlan = await fs.readFile(path.join(fixture.execution, "plan.md"));

    const requirements = path.join(workspace, "shared/requirements.md");
    const beforeAuthority = await computeRequirementsAuthority(workspace);
    const originalRequirements = await fs.readFile(requirements, 'utf8');
    const changedRequirements = originalRequirements.replace('Expired invitation is rejected', 'Expired invitation is rejected with audit');
    assert.notEqual(changedRequirements, originalRequirements, 'requirements stimulus-applied');
    await fs.writeFile(requirements, changedRequirements);
    assert.notEqual(await computeRequirementsAuthority(workspace), beforeAuthority);
    const changed = await inspectExecutionState(workspace);
    assert.equal(changed.state, "REQUIREMENTS_CHANGED");
    assertRecoveryTarget(changed, { operation: "REPLAN", slice: null, owner: "requirements-authority" });
    await assert.rejects(
      preflightExecutionOperation(workspace, ready ? "EXECUTE_SLICE" : "REVIEW_PLAN", ready ? "1" : null),
      /not legal from REQUIREMENTS_CHANGED/u,
    );
    assert.deepEqual(await fs.readFile(path.join(fixture.execution, "plan.md")), pendingPlan);
    assert.equal((await preflightExecutionOperation(workspace, 'REPLAN')).state, 'REQUIREMENTS_CHANGED');
    await stagePristineReplacement(fixture, authority, await computeRequirementsAuthority(workspace), { ready: true });
    assert.equal((await preflightExecutionOperation(workspace, 'EXECUTE_SLICE', '1')).state, 'MATERIALIZED_PRISTINE');
  }
});

test("MATERIALIZE_TASKS hands preserved validable frontiers to concrete validation", async t => {
  // Historical name retained for the ledger. Joint preparation absorbed
  // MATERIALIZE_TASKS; actual EXECUTE/APPLY publishers own these frontiers.
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS']) {
    const f = await standaloneWorkspace(t); await renderArtifacts(f);
    f.exampleImplementation = await implementExample(f);
    if (operation === 'APPLY_FINDINGS') {
      await validateExample(f, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
      await correctExample(f, { content: VALIDATED_CONTENT });
    }
    const state = await inspectExecutionState(f.requirements), before = await treeBytes(f.execution);
    assert.equal(state.state, operation === 'EXECUTE_SLICE' ? 'IMPLEMENTED_AWAITING_VALIDATION' : 'FINDINGS_CORRECTED');
    assert.deepEqual(deriveNormalHandoff(state, operation), { workflowSkill: 'stnl-slice-quality-manager', operation: 'VALIDATE_SLICE', invocation: 'OPERATION=VALIDATE_SLICE', slice: 'slice-01' });
    const readback = { execution: state, executionRaw: state, product: { deriveNormalHandoff } };
    assert.deepEqual(decideOutcome(operation, readback, true), { result: 'PASS', blocker: null });
    assert.deepEqual(nextHandoff(operation, readback), { operation: 'VALIDATE_SLICE', slice: 'slice-01' });
    assert.deepEqual(decideOutcome(operation, readback, false), { result: 'BLOCKED', blocker: 'SDK_TURN_FAILED' });
    await assert.rejects(preflightExecutionOperation(f.requirements, 'MATERIALIZE_TASKS'), /unsupported operation/);
    assert.deepEqual(decideOutcome('MATERIALIZE_TASKS', readback, true), { result: 'BLOCKED', blocker: 'OFFICIAL_TRANSITION_NOT_OBSERVED' });
    assert.deepEqual(await treeBytes(f.execution), before);
  }
});

test("RESUME remains lifecycle recovery authority before execution REPLAN is derived", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const implemented = await implementExample(fixture, { publish: false });
  const lifecycleDivergence = ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: RESUME");
  await editTask({ ...fixture, execution: implemented.copy.candidateExecutionRoot }, (value) => replaceSection(value, "Divergences", lifecycleDivergence));
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: implemented.copy.candidateRoot });
  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "DIVERGENCE_BLOCKED");
  assert.deepEqual(blocked.legalOperations, []);
  assert.deepEqual(blocked.requiredRecoveryHandoff, {
    owner: "lifecycle",
    operation: null,
    invocation: "MODE=RESUME",
    slice: "slice-01",
    record: "divergence-01",
  });
  assert.equal(JSON.stringify(blocked).includes("OPERATION=RESUME"), false);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "REPLAN"), /lifecycle MODE=RESUME/u);
});

test("two lifecycle RESUME records preserve both identities while sharing one handoff", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const implemented = await implementExample(fixture, { publish: false });
  const first = ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: RESUME");
  const second = first.replaceAll("divergence-01", "divergence-02").replace(
    "Approved scope omits a required dependency.",
    "A second persisted authority divergence requires lifecycle recovery.",
  );
  await editTask({ ...fixture, execution: implemented.copy.candidateExecutionRoot }, (value) => replaceSection(value, "Divergences", `${first}\n\n${second}`));
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: implemented.copy.candidateRoot });
  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "DIVERGENCE_BLOCKED");
  assert.deepEqual(blocked.recoveryTargets.map(({ record }) => record), ["divergence-01", "divergence-02"]);
  assert.deepEqual(blocked.legalOperations, []);
  assert.deepEqual(blocked.requiredRecoveryHandoff, {
    owner: "lifecycle",
    operation: null,
    invocation: "MODE=RESUME",
    slice: "slice-01",
    record: null,
  });
});

test("exact legacy Findings IDs corruption is structured, mechanically repaired, and semantically neutral", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskPath, "utf8");

  let strictError;
  await assert.rejects(inspectExecutionState(fixture.requirements), /activation manifest does not cover current artifacts/u);
  await assert.rejects(validateExecutionCandidate(fixture.requirements, await isolatedContractCopy(fixture)), (error) => {
    strictError = error;
    assert.equal(error.contractViolation.kind, "non-canonical-field");
    assert.equal(error.contractViolation.record, "findings-check-01");
    assert.equal(error.contractViolation.expectedField, "Finding IDs");
    assert.equal(error.contractViolation.foundField, "Findings IDs");
    assert.equal(error.contractViolation.repairability, "mechanical");
    return true;
  });
  assert.ok(strictError instanceof ExecutionContractError);

  const repair = await repairExecutionContract(fixture.requirements);
  assert.equal(repair.status, "REPAIRED");
  assert.equal(repair.repairs.length, 1);
  const after = await fs.readFile(taskPath, "utf8");
  assert.equal(after, before.replace("- Findings IDs: finding-01", "- Finding IDs: finding-01"));
  assert.equal(after.replace("- Finding IDs: finding-01", "- Findings IDs: finding-01"), before);

  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "FINDINGS_CORRECTED");
  assert.deepEqual(recovered.activeFindings, ["slice-01:finding-01"]);
  assert.equal(recovered.tasks.get("slice-01").attempts.length, 1);
  assert.equal(recovered.tasks.get("slice-01").findingsChecks.length, 1);
  assert.equal(recovered.tasks.get("slice-01").findings[0].state, "active");
  assert.equal(recovered.tasks.get("slice-01").base.present, false);
  assert.equal(recovered.tasks.get("slice-01").final.result, "pending");
  assert.equal(recovered.normalHandoff.invocation, "OPERATION=VALIDATE_SLICE");
  assert.equal(recovered.normalHandoff.slice, "slice-01");
});

test("exact historical discovery label pair is losslessly repaired while ambiguity stays blocked", async (t) => {
  const legacy = await standaloneWorkspace(t);
  await renderArtifacts(legacy);
  await implementExample(legacy);
  await editTask(legacy, value => value.replace("- Discovery sources:", "- Check discovery sources:").replace("- Discovery actions:", "- Check discovery actions:"));
  const taskPath = path.join(legacy.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskPath, "utf8");
  await assert.rejects(inspectExecutionState(legacy.requirements), /activation manifest does not cover current artifacts/u);
  await assert.rejects(validateExecutionCandidate(legacy.requirements, await isolatedContractCopy(legacy)), (error) => {
    assert.equal(error.contractViolation.kind, "legacy-discovery-labels");
    assert.equal(error.contractViolation.repairability, "mechanical");
    return true;
  });
  const repair = await repairExecutionContract(legacy.requirements);
  assert.equal(repair.status, "REPAIRED");
  const after = await fs.readFile(taskPath, "utf8");
  assert.equal(after, before
    .replace("- Check discovery sources:", "- Discovery sources:")
    .replace("- Check discovery actions:", "- Discovery actions:"));
  assert.equal((await inspectExecutionState(legacy.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const coexistence = await standaloneWorkspace(t);
  await renderArtifacts(coexistence);
  await implementExample(coexistence);
  await editTask(coexistence, value => value.replace("- Discovery sources:", "- Discovery sources: canonical\n- Check discovery sources:").replace("- Discovery actions:", "- Discovery actions: canonical\n- Check discovery actions:"));
  await assert.rejects(inspectExecutionState(coexistence.requirements), /activation manifest does not cover current artifacts/u);
  await assert.rejects(validateExecutionCandidate(coexistence.requirements, await isolatedContractCopy(coexistence)), (error) => {
    assert.equal(error.contractViolation.repairability, "blocked");
    return true;
  });

  const typo = await standaloneWorkspace(t);
  await renderArtifacts(typo);
  await implementExample(typo);
  await editTask(typo, value => value.replace("- Discovery sources:", "- Discovery sourcez:"));
  await assert.rejects(inspectExecutionState(typo.requirements), /activation manifest does not cover current artifacts/u);
  await assert.rejects(validateExecutionCandidate(typo.requirements, await isolatedContractCopy(typo)), /Discovery sources|unknown field/u);
});

test("one explicit repair pass handles every approved alias in one task artifact", async (t) => {
  const sameRecord = await standaloneWorkspace(t);
  await renderArtifacts(sameRecord);
  await prepareFindingsCorrection(sameRecord, "Findings IDs");
  await editTask(sameRecord, (value) => value
    .replace("- Discovery sources:", "- Check discovery sources:")
    .replace("- Discovery actions:", "- Check discovery actions:"));
  const sameRecordPath = path.join(sameRecord.execution, "tasks/slice-01.md");
  const sameRecordBefore = await fs.readFile(sameRecordPath, "utf8");
  const sameRecordRepair = await repairExecutionContract(sameRecord.requirements);
  assert.equal(sameRecordRepair.status, "REPAIRED");
  assert.equal(sameRecordRepair.repairs.length, 2);
  assert.equal(await fs.readFile(sameRecordPath, "utf8"), sameRecordBefore
    .replace("- Check discovery sources:", "- Discovery sources:")
    .replace("- Check discovery actions:", "- Discovery actions:")
    .replace("- Findings IDs:", "- Finding IDs:"));
  assert.equal((await inspectExecutionState(sameRecord.requirements)).state, "FINDINGS_CORRECTED");

  const multipleRecords = await standaloneWorkspace(t);
  await renderArtifacts(multipleRecords);
  const first = await implementExample(multipleRecords, { failFirst: true, publish: false });
  await retryExample(multipleRecords, first, VALIDATED_CONTENT);
  await editTask(multipleRecords, value => value.replaceAll('- Discovery sources:', '- Check discovery sources:').replaceAll('- Discovery actions:', '- Check discovery actions:'));
  const multipleRepair = await repairExecutionContract(multipleRecords.requirements);
  assert.equal(multipleRepair.status, "REPAIRED");
  assert.equal(multipleRepair.repairs.length, 2);
  assert.equal((await inspectExecutionState(multipleRecords.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("contract repair never overwrites a writer in the final source-to-publication window", { timeout: 20_000 }, async () => {
  await runRepairDispute('final-source-window');
});

test("contract repair rejects a source mutation at critical-section entry", { timeout: 20_000 }, async () => {
  await runRepairDispute('critical-section-entry');
});

test("strict readback failure rolls back only the repair-owned publication", { timeout: 20_000 }, async () => {
  // With a foreign installed image, current publication retains that image and
  // the original backup rather than overwriting the foreign bytes to restore.
  await runRepairDispute('strict-readback');
});

test("contract repair preserves a foreign replacement of its lock identity", { timeout: 20_000 }, async () => {
  await runRepairDispute('foreign-lock');
});

test("official 98545e4 lifecycle-root execution is explicit legacy and never EMPTY", async (t) => {
  const root = await temporary(t, "stnl-old-root-execution-");
  const readyFixture = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready");
  const workspace = await copyDirectory(readyFixture, path.join(root, "spec"));
  const historicalRoot = ["skills", "stnl-spec-execution-manager", "templates"].join("/");
  const planIndex = replaceAll(gitShowText("98545e4", `${historicalRoot}/plan-index.template.md`), [
    ["<workspace path>", workspace], ["01 - <name>", "01 - Delivery"],
    ["<one-line observable outcome>", "observable result"],
  ]);
  const tasksIndex = replaceAll(gitShowText("98545e4", `${historicalRoot}/tasks-index.template.md`), [
    ["01 - <name>", "01 - Delivery"], ["<count or compact summary>", "one task"],
  ]);
  const phasePlan = replaceAll(gitShowText("98545e4", `${historicalRoot}/phase-plan.template.md`), [
    ["<Name>", "Delivery"], ["<One observable outcome.>", "Observable result."],
  ]);
  const phaseTasks = replaceAll(gitShowText("98545e4", `${historicalRoot}/phase-tasks.template.md`), [
    ["<Name>", "Delivery"], ["<task>", "Implement behavior"],
  ]);
  await fs.mkdir(path.join(workspace, "plans"));
  await fs.mkdir(path.join(workspace, "tasks"));
  await fs.writeFile(path.join(workspace, "plan.md"), planIndex);
  await fs.writeFile(path.join(workspace, "tasks.md"), tasksIndex);
  await fs.writeFile(path.join(workspace, "plans/plan-01.md"), phasePlan);
  await fs.writeFile(path.join(workspace, "tasks/tasks-01.md"), phaseTasks);

  for (const operation of [
    () => inspectExecutionState(workspace),
    () => preflightExecutionOperation(workspace, "PLAN"),
  ]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error.contractViolation?.kind, "legacy-execution-contract");
      assert.equal(error.contractViolation?.classification, "structurally-incompatible");
      assert.equal(error.contractViolation?.repairability, "blocked");
      assert.equal(error.contractViolation?.reason, "official-lifecycle-root-execution-generation");
      return true;
    });
  }
});



test("legacy classification requires a complete historical producer signature", async t => {
  for (const [insertion, diagnostic] of [
    ['```md\n# Delivery Plan Index\n```', /contains hidden or ambiguous carriers/],
    ['Historical example:\n# Delivery Plan Index', /has a concealed heading/],
  ]) {
    const f = await standaloneWorkspace(t); await renderArtifacts(f, { planStatus: 'draft' });
    assert.equal((await inspectExecutionState(f.requirements)).state, 'PLANNED_DRAFT');
    await editPlan(f, text => replaceSection(text, 'Global Risks and Integration', '- Historical marker # Delivery Plan Index is descriptive text.'));
    assert.equal((await inspectExecutionState(f.requirements)).state, 'PLANNED_DRAFT');
    await editPlan(f, text => replaceSection(text, 'Global Risks and Integration', '- No material integration risk\n\n' + insertion));
    const before = await treeBytes(f.execution);
    // Current joint grammar rejects hidden carriers; mere historical words are
    // still never a complete legacy signature or permission to migrate.
    await assert.rejects(inspectExecutionState(f.requirements), error => {
      assert.notEqual(error.contractViolation?.kind, 'legacy-execution-contract'); assert.match(error.message, diagnostic); return true;
    });
    assert.deepEqual(await treeBytes(f.execution), before);
  }
  for (const [variant, mutate, diagnostic] of [
    ['missing authority', text => text.replace(/^- Requirements authority: sha256:[0-9a-f]{64}\n/mu, '').replace(/^- Plan revision: [0-9]+\n/mu, ''), /invalid authority\/revision/],
    ['hybrid heading', text => text.replace('# Execution Plan', '# Delivery Plan Index'), /non-canonical primary heading/],
  ]) {
    const f = await standaloneWorkspace(t); await renderArtifacts(f, { planStatus: 'draft' });
    assert.equal((await inspectExecutionState(f.requirements)).state, 'PLANNED_DRAFT');
    await editPlan(f, mutate); const before = await treeBytes(f.execution);
    await assert.rejects(inspectExecutionState(f.requirements), error => {
      assert.notEqual(error.contractViolation?.kind, 'legacy-execution-contract', variant); assert.match(error.message, diagnostic); return true;
    });
    assert.deepEqual(await treeBytes(f.execution), before);
  }
});

test("the fabricated tasks prose pair is not a historical producer signature", async (t) => {
  const fabricatedIntroduction = "Use only `[ ]` and `[x]`. This is the sole global progress authority. Every slice operation requires explicit `SLICE`.";
  const fabricatedHistory = "Plans are immutable after materialization; only a current valid `PASS` may complete a selected row.";
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture, { planStatus: 'draft' });
  const before = await fs.readFile(path.join(fixture.execution, 'tasks.md'), 'utf8');
  const table = before.slice(before.indexOf('| Done |'));
  await reviewJointFixture(fixture, { editCandidate: async root => {
    const file = path.join(root, 'tasks.md'); const original = await fs.readFile(file, 'utf8');
    const changed = original.replace(/^purpose: .+$/mu, 'purpose: ' + fabricatedIntroduction).replace(/^contains: .+$/mu, 'contains: ' + fabricatedHistory);
    assert.notEqual(changed, original, 'fabricated descriptive prose stimulus-applied');
    assert.ok(changed.includes(fabricatedIntroduction) && changed.includes(fabricatedHistory));
    assert.equal(changed.slice(changed.indexOf('| Done |')), table, 'descriptive prose does not manufacture a progress row');
    await fs.writeFile(file, changed);
    assert.equal((await validateExecutionCandidate(fixture.requirements, root)).state, 'MATERIALIZED_PRISTINE');
  } });
  const current = await fs.readFile(path.join(fixture.execution, 'tasks.md'), 'utf8');
  assert.equal(current.slice(current.indexOf('| Done |')), table, 'the joint producer preserves the same sole progress authority');
  assert.match(current, /^purpose: Template for the compact global slice progress authority\.$/mu);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("the exact e45e41d split-plan producer remains explicit blocked legacy", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const authoritySource = path.relative(fixture.execution, fixture.requirements).split(path.sep).join("/");
  const detailSource = path.relative(path.join(fixture.execution, "plans"), fixture.requirements).split(path.sep).join("/");
  await fs.mkdir(path.join(fixture.execution, "plans"), { recursive: true });
  const historicalPlannerRoot = ["skills", "stnl-execution-planner", "templates"].join("/");
  let plan = replaceAll(gitShowText("e45e41d", `${historicalPlannerRoot}/plan.template.md`), [
    ["`<relative path>`", `\`${authoritySource}\``], ["01 - <name>", "01 - Delivery"],
    ["<compact objective>", "Deliver observable behavior"], ["<compact strategy>", "Implement serially"],
    ["<result>", "observable result"], ["<areas>", "src/example.txt"],
  ]);
  plan = headerReady(plan);
  let detail = replaceAll(gitShowText("e45e41d", `${historicalPlannerRoot}/slice-plan.template.md`), [
    ["`<relative path>`", `\`${detailSource}\``], ["<Name>", "Delivery"],
  ]);
  detail = headerReady(detail);
  await fs.writeFile(path.join(fixture.execution, "plan.md"), plan);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-01.md"), detail);
  await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
    assert.equal(error.contractViolation?.kind, "legacy-execution-contract");
    assert.equal(error.contractViolation?.reason, "known-split-plan-before-authority-fields");
    return true;
  });
});

test("current and e45e41d hybrid plan structure remains a current violation", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture, { planStatus: 'draft' });
  await editPlan(fixture, (value) => value
    .replace(
      "update_policy: PLAN creates revision 1; REPLAN drafts a replacement or extension; REVIEW_PLAN corrects the mutable draft and changes it to ready.",
      "update_policy: PLAN creates as draft; REVIEW_PLAN corrects and changes status to ready.",
    )
    .replace(/^- Requirements authority: sha256:[0-9a-f]{64}\n/mu, "")
    .replace(/^- Plan revision: [0-9]+\n/mu, "")
    .replace(
      "\n\n## Serial Slice Order",
      "\n\nFor revision 1, including a planning-only replacement before tasks exist, omit the following historical recovery fields.\n\n- Replan reason: <REPLAN_REASON>\n- Revision mode: pristine-replacement | append-only-extension\n- Supersedes open slices: <slice-NN -> slice-NN mappings or none>\n\n## Serial Slice Order",
    ));
  await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
    assert.equal(error.contractViolation ?? null, null);
    return /plan.md Global Context is not populated/u.test(error.message);
  });
});

test("preflight is read-only and exact safe contract repair is an explicit deterministic action", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskPath);
  for (const [operation, slice] of [["VALIDATE_SLICE", "1"], ["REPLAN", null], ["DELETE", null]]) {
    await assert.rejects(preflightExecutionOperation(fixture.requirements, operation, slice), /activation manifest does not cover current artifacts/);
    assert.deepEqual(await fs.readFile(taskPath), before, `${operation} preflight mutated live execution`);
  }
  const shadow = await isolatedContractCopy(fixture), shadowBefore = await treeBytes(shadow);
  await assert.rejects(validateExecutionCandidate(fixture.requirements, shadow), error => {
    assert.equal(error.contractViolation.repairability, 'mechanical');
    assert.equal(error.contractViolation.expectedField, 'Finding IDs');
    return true;
  });
  assert.deepEqual(await treeBytes(shadow), shadowBefore);
  const repair = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "--repair-known-contract",
  ], { encoding: "utf8", cwd: fixture.root });
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stdout, /^PASS: contract repair status=REPAIRED repairs=1 state=FINDINGS_CORRECTED$/mu);
  const result = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  assert.equal(result.state, "FINDINGS_CORRECTED");
  assert.equal(result.slice, "slice-01");
});

for (const malformed of [
  {
    name: "canonical and legacy labels coexist",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Finding IDs: finding-01\n- Findings IDs: finding-01"),
    reason: "canonical-and-alias-conflict",
  },
  {
    name: "canonical label is duplicated",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Finding IDs: finding-01\n- Finding IDs: finding-01"),
    reason: "duplicate-canonical-field",
  },
  {
    name: "legacy label is duplicated",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Findings IDs: finding-01\n- Findings IDs: finding-01"),
    reason: "duplicate-legacy-field",
  },
  {
    name: "unknown typo is not fuzzily repaired",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Finding Identifierz: finding-01"),
    reason: "unknown-or-missing-field",
  },
  {
    name: "legacy label has an empty value",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Findings IDs: "),
    reason: "invalid-repair-value",
  },
  {
    name: "legacy label does not name a declared finding",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Findings IDs: arbitrary-text"),
    reason: "invalid-repair-value",
  },
]) {
  test(`malformed findings contract blocks without mutation: ${malformed.name}`, async (t) => {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await prepareFindingsCorrection(fixture);
    await editTask(fixture, (value) => malformed.mutate(value));
    const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
    const before = await fs.readFile(taskPath);
    await assert.rejects(preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1"), /activation manifest does not cover current artifacts/u);
    await assert.rejects(validateExecutionCandidate(fixture.requirements, await isolatedContractCopy(fixture)), (error) => {
      assert.equal(error.contractViolation.repairability, "blocked");
      assert.equal(error.contractViolation.reason, malformed.reason);
      assert.deepEqual(error.recoveryTargets, []);
      return true;
    });
    assert.deepEqual(await fs.readFile(taskPath), before);
  });
}

test("candidate validation rejects unreadable mutations and preserves live execution bytes", async (t) => {
  for (const [name, mutate] of [
    ["legacy findings field", (value) => value.replace("- Finding IDs: finding-01", "- Findings IDs: finding-01")],
    ["second required field class", (value) => value.replace(/^- HEAD: (.+)$/mu, "- HEADs: $1")],
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await prepareFindingsCorrection(fixture);
    const liveBefore = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"));
    const candidate = path.join(fixture.root, `candidate-${name.replaceAll(" ", "-")}`);
    await copyDirectory(fixture.execution, candidate);
    const candidateTask = path.join(candidate, "tasks/slice-01.md");
    const original = await fs.readFile(candidateTask, "utf8"); const changed = mutate(original);
    assert.notEqual(changed, original, name + ": stimulus-applied");
    await fs.writeFile(candidateTask, changed, "utf8");
    await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), ExecutionContractError);
    assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")), liveBefore);
  }
});

test("successful model-owned candidate publication has strict success and live readback proof", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveBefore = await fs.readFile(liveTask);
  const implemented = await implementExample(fixture, { publish: false });
  const candidate = implemented.copy.candidateExecutionRoot;
  const candidateState = await validateExecutionCandidate(fixture.requirements, candidate);
  assert.equal(candidateState.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(await fs.readFile(liveTask), liveBefore, "candidate validation published implicitly");

  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: implemented.copy.candidateRoot });
  const published = await inspectExecutionState(fixture.requirements);
  assert.equal(published.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(published.tasks.get("slice-01").implementationChecks.at(-1).status, "TESTS_PASS");

  const liveArtifacts = [
    path.join(fixture.execution, "plan.md"),
    path.join(fixture.execution, "plans/slice-01.md"),
    path.join(fixture.execution, "tasks.md"),
    liveTask,
  ];
  const beforeReadback = await Promise.all(liveArtifacts.map((file) => fs.readFile(file)));
  const readbackResult = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "--handoff-after",
    "EXECUTE_SLICE",
  ], { encoding: "utf8" });
  assert.equal(readbackResult.status, 0, readbackResult.stderr);
  const readback = JSON.parse(readbackResult.stdout);
  assert.equal(readback.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(readback.normal_handoff.invocation, "OPERATION=VALIDATE_SLICE");
  assert.equal(readback.normal_handoff.slice, "slice-01");
  assert.equal(readback.legal_operations.some(({ operation }) => operation === "VALIDATE_SLICE"), true);
  assert.equal(readback.legal_operations.some(({ operation }) => operation === "EXECUTE_SLICE"), false);
  assert.equal(readback.mandatory_recovery, null);
  assert.equal(readback.required_recovery_handoff, null);
  assert.deepEqual(await Promise.all(liveArtifacts.map((file) => fs.readFile(file))), beforeReadback, "handoff readback mutated live execution artifacts");

  await assert.rejects(
    preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"),
    /not legal/u,
    "published implementation unexpectedly permitted a second EXECUTE_SLICE",
  );
});

test("candidate shadows use external OS temp, preserve standalone logical paths, and clean owned storage", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await passFirstSlice(fixture);
  const candidate = await copyDirectory(fixture.execution, path.join(fixture.root, "valid-candidate"));
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveSource = path.join(fixture.root, "src/example.txt");
  const liveTaskBefore = await fs.readFile(liveTask);
  const liveSourceBefore = await fs.readFile(liveSource);
  const controlledTemp = await temporary(t, "stnl-candidate-storage-");
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = controlledTemp;
  t.after(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  });

  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "COMPLETE");
  assert.deepEqual(await fs.readdir(controlledTemp), [], "successful candidate left owned temp storage");

  const invalidCandidate = await copyDirectory(fixture.execution, path.join(fixture.root, "invalid-candidate"));
  await fs.writeFile(path.join(invalidCandidate, "scratch.md"), "reject\n", "utf8");
  let rejection;
  await assert.rejects(validateExecutionCandidate(fixture.requirements, invalidCandidate), (error) => {
    rejection = error;
    return error instanceof ExecutionContractError && error.findings.some((finding) => finding.endsWith(`${path.sep}scratch.md`));
  });
  const physicalFinding = rejection.findings.find((finding) => finding.endsWith(`${path.sep}scratch.md`));
  const relativeFinding = path.relative(controlledTemp, physicalFinding);
  assert.ok(relativeFinding !== "" && !relativeFinding.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeFinding));
  const shadowName = relativeFinding.split(path.sep)[0];
  assert.match(shadowName, /^\.stnl-execution-candidate-/u);
  await assert.rejects(fs.stat(path.join(controlledTemp, shadowName)), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(controlledTemp), [], "rejected candidate left owned temp storage");

  const formerLocalPrefix = `.${path.basename(fixture.root)}.stnl-execution-candidate-`;
  assert.deepEqual(
    (await fs.readdir(path.dirname(fixture.root))).filter((name) => name.startsWith(formerLocalPrefix)),
    [],
    "candidate shadow appeared beside the standalone workspace",
  );
  assert.deepEqual(await fs.readFile(liveTask), liveTaskBefore, "candidate validation changed the live task");
  assert.deepEqual(await fs.readFile(liveSource), liveSourceBefore, "candidate validation changed the live source");

  const nestedCandidate = path.join(fixture.execution, "candidate-inside-live-execution");
  await fs.mkdir(nestedCandidate);
  await assert.rejects(validateExecutionCandidate(fixture.requirements, nestedCandidate), /must be isolated from live execution artifacts/u);
  await fs.rm(nestedCandidate, { recursive: true });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, fixture.root), /must be isolated from live execution artifacts/u);
});







test("semantic auxiliary runner output is serialized by the deterministic execution producer before persistence", async (t) => {
  const contracts = await Promise.all([
    fs.readFile(path.join(ROOT, "agents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8"),
    fs.readFile(path.join(ROOT, "agents/codex/.codex/agents/stnl_validation_runner.toml"), "utf8"),
  ]);
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  const live = await readPreparationArtifacts(fixture.execution);
  const implementation = await implementExample(fixture, { publish: false });
  const persisted = implementation.bundle;
  for (const [runnerField, recordField] of [
    ['"automaticCheckRound":', "- Automatic check round: 1/3"],
    ['"status":', "- Status: TESTS_PASS"],
    ['"discoverySources":', "- Discovery sources:"],
    ['"discoveryActions":', "- Discovery actions:"],
    ['"verificationTypesConsidered":', "- Verification types considered:"],
    ['"commands":', "- Commands:"],
    ['"selectedChecks":', "- Selected checks:"],
  ]) {
    for (const contract of contracts) assert.ok(contract.includes(runnerField), runnerField);
    assert.ok(persisted.includes(recordField), recordField);
  }
  assert.match(persisted, /^- Tested scope: \S.*$/mu);
  assert.match(persisted, /^- Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}$/mu);
  assert.match(persisted, /^- Commands:\n  - `[^`]+` \| exit:0$/mu);
  assert.doesNotMatch(persisted, /^- Fileless reason:/mu);
  assert.deepEqual(await readPreparationArtifacts(fixture.execution), live, 'serialization and private insertion leave official Plan and Task bytes intact');
  assert.equal((await readExecutionActivation(fixture.requirements)).activation.activeAttempt.operationAttemptId, implementation.admission.owner.operationAttemptId);
  assert.equal((await validateExecutionCandidate(fixture.requirements, implementation.copy.candidateExecutionRoot)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot });
  const parsed = await inspectExecutionState(fixture.requirements);
  const observed = JSON.parse(await fs.readFile(implementation.captured.receiptFile));
  assert.equal(parsed.tasks.get('slice-01').implementationChecks[0].round, 1);
  assert.equal(parsed.tasks.get('slice-01').implementationChecks[0].testedState[0].path, '../../src/example.txt');
  assert.deepEqual(parsed.tasks.get('slice-01').implementationChecks[0].commands, observed.verification.checks.map(({ command, exit }) => ({ command, exit })));
  const fileless = await standaloneWorkspace(t); await renderArtifacts(fileless);
  const noFiles = await implementExample(fileless, { filelessReason: 'The existing assertion observes repository state without any new repository write.', publish: false });
  assert.match(noFiles.bundle, /^- Tested state: none\n- Fileless reason: \S.*$/mu);
  fixture.exampleImplementation = implementation;
  await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  const findings = await correctExample(fixture, { content: VALIDATED_CONTENT });
  assert.match(findings.bundle, /^- Findings verified: finding-01$/mu);
  assert.match(findings.bundle, /^- Unsupported active findings: none$/mu);
  const corrected = await standaloneWorkspace(t); await renderArtifacts(corrected);
  const first = await implementExample(corrected, { failFirst: true, publish: false });
  const second = await retryExample(corrected, first, VALIDATED_CONTENT);
  assert.match(second.bundle, /^- Correction paths: \.\.\/\.\.\/src\/example\.txt$/mu);
  assert.ok((await fs.readFile(first.copy.candidateTaskArtifact, 'utf8')).includes(first.bundle));
});

test("terminal PASS accepts factual bullet summaries through receipt-bound preparation and publication", async (t) => {
  // Anonymous equivalents of the three rejected summary shapes, plus the
  // established single-line shape. The fake verdict tests the persistence gate,
  // not the truth of model-written prose or a real project's acceptance criteria.
  const summaries = [
    "- Implemented the approved selection behavior while preserving ordered output.\n- Expanded prepared checks for empty results, invalid input and prior behavior.\n- Corrected the prepared no-match fixture without changing the input contract.",
    "- `src/example.txt` records the approved selection behavior and existing ordering contract.\n- Prepared checks cover normal, selected and empty results plus invalid input.\n- The corrected no-match fixture retains the focused check and its assertions.",
    "- `src/example.txt`: the approved behavior retains ordered results and compatibility.\n- Prepared checks include boundary cases and the corrected no-match fixture.\n- Verification: the independent focused check completed with exit 0.",
    "- Implemented and independently checked the approved observable behavior.",
  ];
  for (const summary of summaries) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await implementExample(fixture);
    const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
    const liveIndex = path.join(fixture.execution, "tasks.md");
    const before = await Promise.all([liveTask, liveIndex].map((file) => fs.readFile(file)));
    const formal = await validateExample(fixture, { prepare: false, publish: false });
    const { copy, captured } = formal;
    const prepare = () => withExampleOwner(formal.admission, () => prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...captured }));
    const receiptBefore = await fs.readFile(captured.receiptFile);
    const responseBefore = await fs.readFile(captured.semanticResponseFile);
    const candidateTask = path.join(copy.candidateExecutionRoot, "tasks/slice-01.md");
    await fs.writeFile(candidateTask, replaceSection(await fs.readFile(candidateTask, "utf8"), "Diff Summary", summary));
    const prepared = await prepare();
    assert.equal(prepared.status, "PREPARED");
    assert.equal(prepared.formalStatus, "PASS");
    assert.equal(prepared.attemptId, "attempt-01");
    const candidateBytes = await fs.readFile(candidateTask, "utf8");
    assert.ok(candidateBytes.includes(`## Diff Summary\n\n${summary}\n`), "preparer preserves the author-owned summary");
    assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, "COMPLETE");
    assert.deepEqual(await Promise.all([liveTask, liveIndex].map((file) => fs.readFile(file))), before);
    assert.equal((await publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
      candidateExecutionRoot: copy.candidateExecutionRoot, owner: formal.admission.owner })).state, "COMPLETE");
    const final = await inspectExecutionState(fixture.requirements);
    assert.equal(final.state, "COMPLETE");
    assert.equal(final.tasks.get("slice-01").attempts.length, 1);
    const published = await fs.readFile(liveTask, "utf8");
    assert.ok(published.includes(`## Diff Summary\n\n${summary}\n`));
    assert.match(published, /sha256:[0-9a-f]{64}/u);
    assert.match(published, /node --test src\/example.test.mjs.*exit:0/u);
    assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBefore);
    assert.deepEqual(await fs.readFile(captured.semanticResponseFile), responseBefore);
  }
});

test("terminal Diff Summary rejects placeholders and malformed bullet lines without publishing", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await implementExample(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveIndex = path.join(fixture.execution, "tasks.md");
  const before = await Promise.all([liveTask, liveIndex].map((file) => fs.readFile(file)));
  const formal = await validateExample(fixture, { prepare: false, publish: false });
  const { copy, captured } = formal;
  const prepare = () => withExampleOwner(formal.admission, () => prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...captured }));
  await prepare();
  const task = path.join(copy.candidateExecutionRoot, "tasks/slice-01.md");
  const valid = await fs.readFile(task, "utf8");
  const placeholders = ["- none", "- pending", "- n/a", "- not_available", "- NONE", "- <summary>",
    "- Implemented behavior.\n- pending", "- Implemented behavior.\n- <remaining work>"];
  const malformed = ["", "-", "- ", "none", "Implemented behavior.", "- Implemented behavior.\nArbitrary prose",
    "- Implemented behavior.\n  - Nested bullet", "- Implemented behavior.\n\n- Added checks.",
    "- Implemented behavior.\n1. Added checks."];
  const cases = [
    ...placeholders.map(summary => [summary, /Diff Summary must be objective non-placeholder content/u]),
    ...malformed.map(summary => [summary, summary === '' ? /Diff Summary is empty/ : /Diff Summary must contain only flat '- ' bullet lines/u]),
  ];
  for (const [summary, diagnostic] of cases) {
    await fs.writeFile(task, replaceSection(valid, "Diff Summary", summary));
    const rejected = await fs.readFile(task);
    await assert.rejects(validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot), diagnostic);
    await assert.rejects(publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
      candidateExecutionRoot: copy.candidateExecutionRoot, owner: formal.admission.owner }), diagnostic);
    assert.deepEqual(await fs.readFile(task), rejected, "rejection preserves candidate evidence");
    assert.deepEqual(await Promise.all([liveTask, liveIndex].map((file) => fs.readFile(file))), before);
  }
});

test("validation preparation rolls back only owned task bytes when index installation fails", async (t) => {
  for (const foreign of [false, true]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await writeValidatedPath(fixture);
    await implementExample(fixture);
    const formal = await validateExample(fixture, { prepare: false, publish: false });
    const { copy, captured } = formal;
    const prepare = () => withExampleOwner(formal.admission, () => prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...captured }));
    const task = path.join(copy.candidateExecutionRoot, 'tasks/slice-01.md'), index = path.join(copy.candidateExecutionRoot, 'tasks.md');
    const before = await treeBytes(copy.candidateExecutionRoot), liveBefore = await treeBytes(fixture.execution);
    const evidenceBefore = await Promise.all([captured.receiptFile, captured.semanticResponseFile].map(file => fs.readFile(file)));
    const rename = fsPromises.rename;
    let fired = false, foreignBytes;
    fsPromises.rename = async (from, to) => {
      if (!fired && to === index) {
        fired = true;
        if (foreign) {
          foreignBytes = replaceSection(await fs.readFile(task, 'utf8'), 'Validation Attempts', '- foreign concurrent evidence');
          await fs.writeFile(task, foreignBytes);
        }
        throw Object.assign(new Error('TEST-ONLY index install EIO'), { code: 'EIO' });
      }
      return rename(from, to);
    };
    try {
      await assert.rejects(prepare(), foreign ? /changed during rollback and was preserved/u : /index install EIO/u);
    } finally { fsPromises.rename = rename; }
    assert.equal(fired, true);
    assert.deepEqual(await treeBytes(fixture.execution), liveBefore);
    assert.deepEqual(await Promise.all([captured.receiptFile, captured.semanticResponseFile].map(file => fs.readFile(file))), evidenceBefore);
    if (foreign) {
      assert.equal(await fs.readFile(task, 'utf8'), foreignBytes);
      await assert.rejects(prepare(), /Validation Attempts must remain byte-identical/u);
    } else {
      assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before);
      assert.equal((await prepare()).attemptId, 'attempt-01');
    }
  }
});

test("validation candidate preparation writes canonical attempt and PASS base before strict validation", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const physicalTarget = path.join(fixture.root, "src", "validation target Ω.mjs");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, VALIDATED_CONTENT, "utf8");

  const liveTask = path.join(fixture.execution, "tasks", "slice-01.md");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  const taskClaim = path.relative(path.dirname(liveTask), physicalTarget).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: globalClaim, detail: detailClaim, task: taskClaim });
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", `- \`${taskClaim}\``);
    result = replaceSection(result, "Prior Validation Overlap",
      `- Slice 01 overlap: \`${taskClaim}\`; preserve prior behavior.\n- Slice 02 overlap: \`${taskClaim}\`; preserve prior behavior.`);
    result = replaceSection(result, "Implementation Test Evidence", replaceAll(
      checkRecord("implementation-check", 1, "TESTS_PASS", 1),
      [["../../src/example.txt", taskClaim]],
    ));
    return replaceSection(result, "Diff Summary", "- Implemented the approved observable behavior.");
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const responseRoot = await temporary(t, "stnl-validation-canonical-response-");
  const semanticResponseFile = path.join(responseRoot, "response.json");
  const fullHead = "0123456789abcdef0123456789abcdef01234567";
  const nativeCommand = "STNL_VERIFICATION_COMMAND=1 node -e 'if (2 * 3 !== 6) process.exit(1)'";
  const nativeObserved = spawnSync("sh", ["-c", nativeCommand], { encoding: "utf8", cwd: fixture.root });
  assert.equal(nativeObserved.status, 0, nativeObserved.stderr);
  const semanticResponse = JSON.stringify({
    status: "PASS",
    head: fullHead,
    commands: [{ command: nativeCommand, exit: nativeObserved.status }],
    evidence: "focused `npm test` validation passed",
    findingReferences: "none",
    findingDispositions: "none",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "formal result returned",
  });
  await fs.writeFile(semanticResponseFile, semanticResponse, "utf8");

  const candidateParent = await temporary(t, "stnl-validation-candidate-root-");
  const candidateRoot = path.join(candidateParent, "execution");
  await copyDirectory(fixture.execution, candidateRoot);
  const prepared = await prepareValidationCandidate({
    specPath: fixture.requirements,
    slice: "1",
    workspace: fixture.root,
    candidateExecutionRoot: candidateRoot,
    semanticResponseFile,
  });
  assert.equal(prepared.status, "PREPARED");
  assert.equal(prepared.formalStatus, "PASS");
  assert.equal(prepared.attemptId, "attempt-01");
  assert.match(await fs.readFile(path.join(candidateRoot, "tasks/slice-01.md"), "utf8"),
    /Evidence: json:"focused `npm test` validation passed"/u);
  assert.match(await fs.readFile(path.join(candidateRoot, "tasks/slice-01.md"), "utf8"),
    /STNL_VERIFICATION_COMMAND=1 node -e/u);
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidateRoot)).state, "COMPLETE");

  const preflight = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  const managedSnapshot = path.join(fixture.root, "managed-snapshot");
  const managedAdapter = path.join(managedSnapshot, "agents/codex/runtime/validation-runner.mjs");
  const managedBridge = path.join(managedSnapshot, "agents/codex/runtime/managed-runner-bridge.mjs");
  const managedHelper = path.join(managedSnapshot, "agents/codex/runtime/managed-slice-preflight.mjs");
  const managedSerializer = path.join(managedSnapshot,
    "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs");
  await fs.mkdir(path.dirname(managedAdapter), { recursive: true });
  await fs.mkdir(path.dirname(managedSerializer), { recursive: true });
  await Promise.all([managedAdapter, managedBridge, managedHelper, managedSerializer]
    .map((file) => fs.writeFile(file, "// managed helper\n")));
  await fs.chmod(managedAdapter, 0o755);
  const managed = await createManagedSliceContext({ workspace: fixture.root,
    snapshot: managedSnapshot, adapterPath: managedAdapter, bridgePath: managedBridge,
    preflightPath: managedHelper, officialPreflight: {
    exitCode: 0, operation: "VALIDATE_SLICE", slice: "slice-01", inputSlice: "1",
    specPath: fixture.requirements, state: preflight.state,
    authority: `sha256:${preflight.currentFingerprint}`,
    legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery,
  } });
  const managedEnv = managedEnvironment({ PATH: process.env.PATH }, managed);
  const validator = path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs");
  const manualPreflight = spawnSync(process.execPath, [validator, fixture.requirements, "VALIDATE_SLICE", "1"],
    { encoding: "utf8", cwd: fixture.root, env: { PATH: process.env.PATH } });
  assert.equal(manualPreflight.status, 0, manualPreflight.stderr);
  const managedValidator = path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs");
  const managedPreflight = spawnSync(process.execPath, [managedValidator],
    { encoding: "utf8", cwd: fixture.root, env: managedEnv });
  assert.equal(managedPreflight.status, 0, managedPreflight.stderr);
  assert.match(managedPreflight.stdout, /managed preflight state=IMPLEMENTED_AWAITING_VALIDATION/u);
  const staleContext = managedEnvironment({ PATH: process.env.PATH },
    { ...managed, authority: `sha256:${"b".repeat(64)}` });
  const stalePreflight = spawnSync(process.execPath, [managedValidator],
    { encoding: "utf8", cwd: fixture.root, env: staleContext });
  assert.equal(stalePreflight.status, 1);
  assert.match(stalePreflight.stderr, /identity is stale/u);
  const copyCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs"),
    "--spec-path", fixture.requirements, "--slice", "slice-01", "--candidate-parent", candidateParent,
  ], { encoding: "utf8", cwd: fixture.root, env: managedEnv });
  assert.equal(copyCli.status, 0, copyCli.stderr);
  const managedCopy = JSON.parse(copyCli.stdout);
  assert.equal(managedCopy.executionRoot, fixture.execution);
  const prepareCli = [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs"),
    "--prepare", "--spec-path", fixture.requirements, "--slice", "slice-01",
    "--workspace", fixture.root, "--candidate-execution-root", managedCopy.candidateExecutionRoot,
    "--semantic-response-file", semanticResponseFile,
  ];
  const disagreement = spawnSync(process.execPath, prepareCli.map((value) => value === fixture.requirements
    ? path.join(candidateParent, "wrong-spec") : value), { encoding: "utf8", cwd: fixture.root, env: managedEnv });
  assert.equal(disagreement.status, 1);
  assert.match(disagreement.stderr, /explicit SPEC_PATH disagrees with managed context/u);
  const managedPreparation = spawnSync(process.execPath, prepareCli,
    { encoding: "utf8", cwd: fixture.root, env: managedEnv });
  assert.equal(managedPreparation.status, 1);
  assert.match(managedPreparation.stderr, /managed runner receipt is required; use the configured bridge/u);

  const candidateTask = path.join(candidateRoot, "tasks", "slice-01.md");
  const candidateText = await fs.readFile(candidateTask, "utf8");
  const baseStart = candidateText.indexOf("## Effective Validation Base\n\n");
  const baseEnd = candidateText.indexOf("\n## ", baseStart + 1);
  const base = candidateText.slice(baseStart, baseEnd < 0 ? candidateText.length : baseEnd);
  assert.ok(base.includes(`- HEAD: ${fullHead}`));
  assert.ok(base.includes(`- Origin attempt: ${prepared.attemptId}`));
  assert.ok(candidateText.includes(`- HEAD: ${fullHead}`));
  assert.ok(candidateText.includes(`- \`${taskClaim}\` | sha256:${VALIDATED_HASH}`));
  assert.equal(await fs.realpath(path.resolve(path.dirname(liveTask), taskClaim)), await fs.realpath(physicalTarget));

  const truncatedHead = `${fullHead.slice(0, 30)}deadbeef`;
  const tamperedText = candidateText.replace(
    `## Effective Validation Base\n\n- Origin attempt: ${prepared.attemptId}\n- Attempt type: initial\n- HEAD: ${fullHead}`,
    `## Effective Validation Base\n\n- Origin attempt: ${prepared.attemptId}\n- Attempt type: initial\n- HEAD: ${truncatedHead}`,
  );
  assert.notEqual(tamperedText, candidateText, "the causal mismatch fixture must alter only the base HEAD");
  await fs.writeFile(candidateTask, tamperedText, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /Effective Validation Base HEAD disagrees with its origin attempt/u,
  );
  await assert.rejects(
    prepareValidationCandidate({
      specPath: fixture.requirements,
      slice: "1",
      workspace: fixture.root,
      candidateExecutionRoot: candidateRoot,
      semanticResponseFile,
    }),
    /candidate Validation Attempts must remain byte-identical to live authority/u,
  );
  assert.equal(await fs.readFile(candidateTask, "utf8"), tamperedText, "preparation must not repair a rejected candidate");

  const malformedCandidateRoot = path.join(candidateParent, "malformed-execution");
  await copyDirectory(fixture.execution, malformedCandidateRoot);
  const malformedTask = path.join(malformedCandidateRoot, "tasks", "slice-01.md");
  const malformedBefore = await fs.readFile(malformedTask, "utf8");
  const malformedResponseFile = path.join(responseRoot, "malformed.json");
  await fs.writeFile(malformedResponseFile, JSON.stringify({
    status: "PASS",
    head: "",
    commands: [{ command: "node --test test/cli.test.mjs", exit: 0 }],
    evidence: "focused validation passed",
    findingReferences: "none",
    findingDispositions: "none",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "formal result returned",
  }), "utf8");
  await assert.rejects(
    prepareValidationCandidate({
      specPath: fixture.requirements,
      slice: "1",
      workspace: fixture.root,
      candidateExecutionRoot: malformedCandidateRoot,
      semanticResponseFile: malformedResponseFile,
    }),
    /head must be a complete single-line scalar/u,
  );
  assert.equal(await fs.readFile(malformedTask, "utf8"), malformedBefore, "malformed semantic input must not create a candidate record");
});

function scopeRegressionPayload(filelessReason = undefined) {
  return { status: "TESTS_PASS", automaticCheckRound: "1/3", head: "fixture-head",
    discoverySources: "approved task and prepared checks", discoveryActions: "read-only inspection",
    verificationTypesConsidered: "prepared acceptance checks", nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "not applicable",
    commands: [{ command: "semantic claim", exit: 0 }], resultOfEachCommandAndExitCode: "passed",
    selectedChecks: "prepared acceptance checks", selectionRationale: "approved acceptance behavior",
    coverage: "observable behavior", failures: "none", priorRoundFailure: "none",
    correctionApplied: "none", inSliceRationale: "none", evidenceOrFailureSummary: "checks passed",
    affectedFilesOrBehaviors: "observable behavior", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes",
    ...(filelessReason === undefined ? {} : { filelessReason }) };
}

test("execution scope mismatches are narrowly recoverable semantic errors", async t => {
  const reason = 'Acceptance-only work changes no repository file.';
  for (const scenario of ['fileless-valid', 'file-backed-valid', 'missing-reason', 'blank-reason', 'extra-reason', 'filesystem-failure']) {
    const f = await nestedLifecycleWorkspace(t);
    const admission = await beginExample(f, 'EXECUTE_SLICE');
    const start = await startNativeRunnerCapture({ specPath: f.requirements, owner: admission.owner, workspace: f.root, captureParent: f.root });
    const agentId = 'scope-' + randomUUID(); await bindNativeRunnerIdentity({ ...start, agentId });
    const copy = await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-01', owner: admission.owner });
    t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
    const target = path.join(f.root, 'src/example.txt');
    const claim = path.relative(path.dirname(copy.candidateTaskArtifact), target).split(path.sep).join('/');
    const fileless = ['fileless-valid', 'missing-reason', 'blank-reason'].includes(scenario);
    const response = scopeRegressionPayload(scenario === 'blank-reason' ? '   ' : ['fileless-valid', 'extra-reason', 'filesystem-failure'].includes(scenario) ? reason : undefined);
    response.commands = start.verification.checks.map(check => ({ command: verificationCommand(check), exit: 0 }));
    await fs.writeFile(copy.candidateTaskArtifact, replaceSection(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), 'Changed Areas', fileless ? '- none' : '- `' + claim + '`'));
    const captured = await captureNativeExample({ ...start, agentId }, response, fileless ? [] : [claim]);
    const before = await treeBytes(copy.candidateExecutionRoot), live = await treeBytes(f.execution);
    const receipt = await fs.readFile(captured.receiptFile), raw = await fs.readFile(captured.semanticResponseFile);
    if (scenario === 'filesystem-failure') { await fs.unlink(target); await fs.mkdir(target); }
    const consume = () => serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', workspace: f.root,
      taskArtifact: copy.candidateTaskArtifact, response: raw.toString('utf8'), ...captured });
    if (scenario.endsWith('-valid')) {
      const bundle = await consume();
      if (fileless) {
        assert.ok(bundle.includes('- Tested state: none\n- Fileless reason: ' + reason));
        assert.equal((bundle.match(/^- Tested state:/gmu) ?? []).length, 1);
        assert.ok(bundle.includes('- Tested scope: ' + reason));
      } else { assert.doesNotMatch(bundle, /Fileless reason/); assert.ok(bundle.includes('`' + claim + '` | sha256:' + VALIDATED_HASH)); }
    } else if (scenario === 'filesystem-failure') {
      await assert.rejects(consume(), error => { assert.equal(recoverableRunnerResultDiagnostic(error), null, 'mechanical filesystem rejection cannot authorize semantic recovery'); return true; });
    } else {
      const diagnostic = scenario === 'missing-reason' ? /fileless semantic execution response must include Fileless reason/
        : scenario === 'extra-reason' ? /file-backed semantic execution response cannot include Fileless reason/ : /fileless semantic execution response must include Fileless reason/;
      await assert.rejects(consume(), error => { assert.ok(error instanceof RunnerSemanticResultError); assert.match(recoverableRunnerResultDiagnostic(error), diagnostic); return true; });
    }
    assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before); assert.deepEqual(await treeBytes(f.execution), live);
    assert.deepEqual(await fs.readFile(captured.receiptFile), receipt); assert.deepEqual(await fs.readFile(captured.semanticResponseFile), raw);
  }
});


test("managed fileless omission publishes one blocker then resumes the same operation with valid evidence", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const originalTask = await fs.readFile(taskPath, "utf8");
  const originalIndex = await fs.readFile(path.join(fixture.execution, "tasks.md"));
  const cli = path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs");
  const scopeReason = "Acceptance-only work changes no repository file.";
  const budgets = JSON.parse(await fs.readFile(path.join(ROOT, "benchmarks/sentinel-todo/benchmark.json"), "utf8")).cases.find((item) => item.id === "A").budgets;
  let totalRunnerTurns = 0;
  let firstBlocker = null;
  let firstRecovery = null;
  const immutableCaptures = [];
  for (const [index, reason] of [undefined, undefined, scopeReason].entries()) {
    const preflight = await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1");
    const officialPreflight = { exitCode: 0, operation: "EXECUTE_SLICE", slice: "slice-01", inputSlice: "1",
      specPath: fixture.requirements, state: preflight.state, authority: `sha256:${preflight.currentFingerprint}`,
      legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery };
    const context = await createManagedSliceContext({ officialPreflight, workspace: fixture.root, snapshot: ROOT,
      adapterPath: path.join(ROOT, "agents/codex/runtime/validation-runner.mjs"),
      bridgePath: path.join(ROOT, "agents/codex/runtime/managed-runner-bridge.mjs"),
      preflightPath: path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs") });
    const tmpdir = await temporary(t, "stnl-scope-provider-");
    const environment = managedEnvironment({ PATH: process.env.PATH, TMPDIR: tmpdir }, context);
    const broker = await startOfficialRunnerBroker({ workspace: fixture.root, tmpdir,
      operation: "EXECUTE_SLICE", sequence: index + 1, slice: "slice-01", officialPreflight,
      invoke: (request) => invokeIndependentRunner({ ...request, snapshot: ROOT, env: environment,
        runTurn: async ({ eventsPath, operationId, threadId }) => {
          totalRunnerTurns += 1;
          assert.equal(threadId, undefined, "omitted evidence does not authorize a format repair or inherited history");
          const events = [{ operationId, type: "thread.started", thread_id: `scope-thread-${index}` },
            { operationId, type: "turn.started" },
            { operationId, type: "item.started", item: { id: "item_0", type: "command_execution", command: "STNL_VERIFICATION_COMMAND=1 node --test test/prepared.test.mjs" } },
            { operationId, type: "item.completed", item: { id: "item_0", type: "command_execution", command: "STNL_VERIFICATION_COMMAND=1 node --test test/prepared.test.mjs", status: "completed", exit_code: 0 } },
            { operationId, type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(scopeRegressionPayload(reason)) } },
            { operationId, type: "turn.completed" }];
          await fs.writeFile(eventsPath, events.map(JSON.stringify).join("\n") + "\n");
          return { completed: true, turnStarted: true, threadId: `scope-thread-${index}`,
            requestedModel: "gpt-6-luna", requestedEffort: "medium", error: null, usage: null };
        } }) });
    try {
      const receipt = await runManagedRunnerBridge({ environment, cwd: fixture.root,
        payload: JSON.stringify({ automaticCheckRound: "1/3", changedAreas: [], filelessReason: scopeReason }) });
      assert.equal(receipt.status, "RUNNER_RESPONSE_CAPTURED");
      assert.equal(receipt.formatRepair, null);
      assert.equal(broker.requestsHandled, 1);
      const capturedBefore = await treeBytes(tmpdir);
      immutableCaptures.push({ tmpdir, bytes: capturedBefore.filter(([file]) => !file.startsWith("stnl-runner-broker")) });
      const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
      const candidateBefore = await fs.readFile(copy.candidateTaskArtifact, "utf8");
      let proposed = replaceSection(candidateBefore.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- none");
      proposed = replaceSection(proposed, "Diff Summary", "- Prepared acceptance behavior was checked without file changes.");
      await fs.writeFile(copy.candidateTaskArtifact, proposed);
      const args = [cli, "--execution-bundle", "--operation", "EXECUTE_SLICE", "--workspace", fixture.root,
        "--task-artifact", copy.candidateTaskArtifact, "--semantic-response-file", receipt.semanticResponseFile,
        "--receipt-file", receipt.receiptFile, "--insert-candidate"];
      if (index === 0) {
        const wrong = path.join(tmpdir, "wrong.receipt.json");
        await fs.writeFile(wrong, JSON.stringify({ ...receipt, slice: "slice-02" }));
        const mismatch = spawnSync(process.execPath, args.map((arg) => arg === receipt.receiptFile ? wrong : arg),
          { cwd: fixture.root, env: environment, encoding: "utf8" });
        assert.equal(mismatch.status, 1);
        assert.match(mismatch.stderr, /receipt does not match the active managed runner invocation/u);
        assert.equal(await fs.readFile(copy.candidateTaskArtifact, "utf8"), proposed);
        await fs.rm(wrong);
        const rawResponse = await fs.readFile(receipt.semanticResponseFile);
        await fs.appendFile(receipt.semanticResponseFile, " ");
        const hashMismatch = spawnSync(process.execPath, args, { cwd: fixture.root, env: environment, encoding: "utf8" });
        assert.equal(hashMismatch.status, 1);
        assert.match(hashMismatch.stderr, /receipt response hash disagrees/u);
        assert.equal(await fs.readFile(copy.candidateTaskArtifact, "utf8"), proposed);
        await fs.writeFile(receipt.semanticResponseFile, rawResponse);
        const liveBefore = await fs.readFile(taskPath);
        await fs.appendFile(taskPath, "\nchanged after preparation\n");
        const staleSource = spawnSync(process.execPath, args, { cwd: fixture.root, env: environment, encoding: "utf8" });
        assert.equal(staleSource.status, 1);
        assert.match(staleSource.stderr, /live task changed since candidate preparation/u);
        assert.equal(await fs.readFile(copy.candidateTaskArtifact, "utf8"), proposed);
        await fs.writeFile(taskPath, liveBefore);
      }
      const result = spawnSync(process.execPath, args, { cwd: fixture.root, env: environment, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await treeBytes(tmpdir), capturedBefore, "raw response, events and receipt stay byte-identical");
      const candidate = await fs.readFile(copy.candidateTaskArtifact, "utf8");
      if (reason === undefined) {
        assert.equal(JSON.parse(result.stdout).state, "RUNNER_RESULT_BLOCKED");
        assert.match(candidate, /## Changed Areas\n\n- pending/u);
        assert.match(candidate, /- \[ \] 1\.1/u);
        assert.doesNotMatch(candidate, /^### implementation-check-/mu);
        assert.match(candidate, /## Final Result\n\n- pending/u);
        assert.equal((candidate.match(/^- Kind: malformed-output$/gmu) ?? []).length, 1);
        if (firstBlocker !== null) assert.match(candidate, /- After record: none/u);
        firstBlocker = candidate;
        if (index === 0) {
          for (const invalid of [candidate.replace("- Kind: malformed-output", "- Kind: initialization"),
            candidate.replace("- [ ] 1.1", "- [x] 1.1"), replaceSection(candidate, "Delegation Blocker", "- none")]) {
            await fs.writeFile(copy.candidateTaskArtifact, invalid);
            await assert.rejects(validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot), /Changed Areas cannot remain pending after work/u);
          }
          await fs.writeFile(copy.candidateTaskArtifact, candidate);
        }
      } else {
        assert.match(result.stdout, /implementation-check-01 inserted/u);
        assert.match(candidate, /- State: resolved/u);
        assert.match(candidate, /- Fileless reason: Acceptance-only work changes no repository file\./u);
      }
      assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state,
        reason === undefined ? "RUNNER_RESULT_BLOCKED" : "IMPLEMENTED_AWAITING_VALIDATION");
      await publishExecutionCopy({ specPath: fixture.requirements, slice: "slice-01", candidateRoot: copy.candidateRoot });
      const state = await inspectExecutionState(fixture.requirements);
      assert.equal(state.state, reason === undefined ? "RUNNER_RESULT_BLOCKED" : "IMPLEMENTED_AWAITING_VALIDATION");
      if (reason === undefined) {
        assert.equal(state.mandatoryRecovery.operation, "EXECUTE_SLICE");
        assert.equal(state.mandatoryRecovery.slice, "slice-01");
        assert.equal(state.mandatoryRecovery.sameOperationResumeRequired, true);
        await assert.rejects(preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1"));
        await assert.rejects(preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1"));
        const readback = { execution: state, executionRaw: state, product: { deriveNormalHandoff } };
        const outcome = decideOutcome("EXECUTE_SLICE", readback, true);
        assert.equal(outcome.blocker, "OFFICIAL_RUNNER_RESULT_BLOCKED");
        const recovery = recoverableRunnerHandoff({ operation: "EXECUTE_SLICE", slice: "slice-01", outcome,
          readback, priorOperations: firstRecovery === null ? [] : [{ recovery: firstRecovery }], remainingTurns: 20 });
        if (index === 0) { assert.equal(recovery.operation, "EXECUTE_SLICE"); firstRecovery = recovery; }
        else assert.equal(recovery, null, "a second malformed result stays blocked; no second automatic recovery");
        assert.equal(recoverableRunnerHandoff({ operation: "EXECUTE_SLICE", slice: "slice-01", outcome,
          readback, priorOperations: [], remainingTurns: 1 }), null, "existing turn budget still gates recovery");
      }
      assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks.md")), originalIndex);
      assert.equal(sectionBodyForScopeTest(await fs.readFile(taskPath, "utf8"), "Validation Attempts"), sectionBodyForScopeTest(originalTask, "Validation Attempts"));
    } finally { await broker.close(); }
  }
  assert.equal(totalRunnerTurns, 3, "third operation is an explicit manual resume, not a second automatic recovery");
  for (const capture of immutableCaptures) assert.deepEqual((await treeBytes(capture.tmpdir)).filter(([file]) => !file.startsWith("stnl-runner-broker")), capture.bytes);
  // Existing campaign accounting, rather than a new contextual-repair counter, owns limits.
  assert.equal(budgetViolation(Array.from({ length: budgets.maxExecuteSliceAttemptsPerSlice + 1 }, () => ({ operation: "EXECUTE_SLICE", slice: "slice-01" })), budgets).budget, "maxExecuteSliceAttemptsPerSlice");

  const implementedTask = await fs.readFile(taskPath, "utf8");
  const preflight = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  const officialPreflight = { exitCode: 0, operation: "VALIDATE_SLICE", slice: "slice-01", inputSlice: "1",
    specPath: fixture.requirements, state: preflight.state, authority: `sha256:${preflight.currentFingerprint}`,
    legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery };
  const context = await createManagedSliceContext({ officialPreflight, workspace: fixture.root, snapshot: ROOT,
    adapterPath: path.join(ROOT, "agents/codex/runtime/validation-runner.mjs"),
    bridgePath: path.join(ROOT, "agents/codex/runtime/managed-runner-bridge.mjs"),
    preflightPath: path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs") });
  const tmpdir = await temporary(t, "stnl-scope-formal-provider-");
  const environment = managedEnvironment({ PATH: process.env.PATH, TMPDIR: tmpdir }, context);
  const semantic = { ...sanitizedValidationResponse("PASS"), evidence: "Independent prepared acceptance checks verify the approved fileless behavior." };
  let formalCalls = 0;
  const broker = await startOfficialRunnerBroker({ workspace: fixture.root, tmpdir,
    operation: "VALIDATE_SLICE", sequence: 4, slice: "slice-01", officialPreflight,
    invoke: (request) => invokeIndependentRunner({ ...request, snapshot: ROOT, env: environment,
      runTurn: async ({ eventsPath, operationId }) => {
        formalCalls += 1;
        const command = "STNL_VERIFICATION_COMMAND=1 node --test test/prepared.test.mjs";
        const events = [{ operationId, type: "thread.started", thread_id: "formal-fileless-thread" },
          { operationId, type: "turn.started" },
          { operationId, type: "item.started", item: { id: "item_0", type: "command_execution", command } },
          { operationId, type: "item.completed", item: { id: "item_0", type: "command_execution", command, status: "completed", exit_code: 0 } },
          { operationId, type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(semantic) } },
          { operationId, type: "turn.completed" }];
        await fs.writeFile(eventsPath, events.map(JSON.stringify).join("\n") + "\n");
        return { completed: true, turnStarted: true, threadId: "formal-fileless-thread",
          requestedModel: "gpt-6-luna", requestedEffort: "medium", error: null, usage: null };
      } }) });
  try {
    const receipt = await runManagedRunnerBridge({ environment, cwd: fixture.root, payload: "Validate all approved fileless acceptance behavior." });
    assert.equal(receipt.status, "RUNNER_RESPONSE_CAPTURED");
    assert.equal(formalCalls, 1);
    assert.equal(JSON.parse(await fs.readFile(receipt.semanticResponseFile, "utf8")).filelessReason, undefined,
      "VALIDATE retains its exact schema; reason belongs to existing execution authority");
    const capturedBefore = await treeBytes(tmpdir);
    const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent: tmpdir });
    const args = [path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs"),
      "--prepare", "--spec-path", fixture.requirements, "--slice", "slice-01", "--workspace", fixture.root,
      "--candidate-execution-root", copy.candidateExecutionRoot, "--semantic-response-file", receipt.semanticResponseFile,
      "--receipt-file", receipt.receiptFile];
    const candidateBefore = await treeBytes(copy.candidateExecutionRoot);
    const wrong = path.join(tmpdir, "wrong-formal.receipt.json");
    await fs.writeFile(wrong, JSON.stringify({ ...receipt, operation: "EXECUTE_SLICE" }));
    const mismatch = spawnSync(process.execPath, args.map((arg) => arg === receipt.receiptFile ? wrong : arg),
      { cwd: fixture.root, env: environment, encoding: "utf8" });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /receipt does not match the active managed runner invocation/u);
    assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidateBefore);
    await fs.rm(wrong);
    for (const invalidAuthority of [
      implementedTask.replace(/^- Fileless reason:.*\n/mu, ""),
      implementedTask.replace(/(- Requirements authority: sha256:)[0-9a-f]{64}/u, "$1" + "0".repeat(64)),
    ]) {
      await fs.writeFile(taskPath, invalidAuthority);
      const rejected = spawnSync(process.execPath, args, { cwd: fixture.root, env: environment, encoding: "utf8" });
      assert.equal(rejected.status, 1, "invalid current reason or stale authority cannot produce formal evidence");
      assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidateBefore);
      await fs.writeFile(taskPath, implementedTask);
    }
    const prepared = spawnSync(process.execPath, args, { cwd: fixture.root, env: environment, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).formalStatus, "PASS");
    assert.equal(await fs.readFile(taskPath, "utf8"), implementedTask, "formal preparation keeps live authority unchanged");
    const candidateTask = await fs.readFile(path.join(copy.candidateExecutionRoot, "tasks/slice-01.md"), "utf8");
    assert.match(sectionBodyForScopeTest(candidateTask, "Effective Validation Base"), /- Files: none\n- Fileless reason: Acceptance-only work changes no repository file\./u);
    assert.equal(sectionBodyForScopeTest(candidateTask, "Implementation Test Evidence"), sectionBodyForScopeTest(implementedTask, "Implementation Test Evidence"));
    assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, "COMPLETE");
    const forged = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent: tmpdir });
    const forgedTaskPath = path.join(forged.candidateExecutionRoot, "tasks/slice-01.md");
    await fs.writeFile(forgedTaskPath, implementedTask.replace(`- Fileless reason: ${scopeReason}`, "- Fileless reason: Candidate prose cannot redefine the authoritative fileless reason."));
    const forgedPreparation = spawnSync(process.execPath, args.map((arg) => arg === copy.candidateExecutionRoot ? forged.candidateExecutionRoot : arg),
      { cwd: fixture.root, env: environment, encoding: "utf8" });
    assert.equal(forgedPreparation.status, 0, forgedPreparation.stderr);
    const forgedText = await fs.readFile(forgedTaskPath, "utf8");
    assert.match(sectionBodyForScopeTest(forgedText, "Effective Validation Base"), /- Fileless reason: Acceptance-only work changes no repository file\./u,
      "the producer reads the validated live owner rather than candidate prose");
    await assert.rejects(publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01", candidateExecutionRoot: forged.candidateExecutionRoot }),
      /candidate changed non-validation task section Implementation Test Evidence/u);
    assert.equal(await fs.readFile(taskPath, "utf8"), implementedTask, "forged candidate cannot publish or mutate live authority");
    const published = await publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01", candidateExecutionRoot: copy.candidateExecutionRoot });
    assert.equal(published.state, "COMPLETE");
    const final = await inspectExecutionState(fixture.requirements);
    assert.equal(final.state, "COMPLETE");
    assert.equal(final.tasks.get("slice-01").attempts.length, 1);
    assert.equal(final.tasks.get("slice-01").attempts[0].status, "PASS");
    assert.equal(final.tasks.get("slice-01").base.fileless, true);
    assert.equal(final.tasks.get("slice-01").final.result, "PASS");
    assert.match(await fs.readFile(path.join(fixture.execution, "tasks.md"), "utf8"), /\| \[x\] \| 01 - Delivery.*\| PASS \| PASS \|/u);
    for (const [file, mode, bytes] of capturedBefore)
      if (!file.startsWith("stnl-runner-broker")) assert.deepEqual(await fs.readFile(path.join(tmpdir, file)), bytes);
    assert.equal(formalCalls, 1, "publication never calls the runner again");
  } finally { await broker.close(); }
});

async function filelessRecoveryFixture(t) {
  const fixture = await standaloneWorkspace(t);
  const key = 'STNL_FILELESS_RECOVERY_READY', previous = process.env[key];
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  process.env[key] = '1';
  await fs.mkdir(path.join(fixture.root, 'src'));
  await fs.writeFile(path.join(fixture.root, 'src/observation.mjs'), "import assert from 'node:assert/strict';assert.equal(process.env.STNL_FILELESS_RECOVERY_READY,'1');\n");
  fixture.verificationRecipe = '- Recipe: ' + JSON.stringify({ format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.',
    checks: [{ id: 'verification-01', executable: { literal: 'node' }, args: [{ file: { kind: 'product', path: 'src/observation.mjs' } }], inputs: [] }],
    dependencyReview: 'The existing assertion reads the process configuration and makes no repository changes.' });
  await renderArtifacts(fixture);
  fixture.filelessReason = 'Only the process configuration changes; repository bytes remain unchanged.';
  fixture.setReady = value => { process.env[key] = value ? '1' : '0'; };
  return fixture;
}

async function insertCapturedScopeBlocker(fixture, admission, copy, captured, operation) {
  return withExampleOwner(admission, async () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs'),
      '--execution-bundle', '--operation', operation, '--workspace', fixture.root, '--task-artifact', copy.candidateTaskArtifact,
      '--semantic-response-file', captured.semanticResponseFile, '--receipt-file', captured.receiptFile, '--insert-candidate'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).state, 'RUNNER_RESULT_BLOCKED');
    assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, 'RUNNER_RESULT_BLOCKED');
    await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: copy.candidateRoot });
  });
}

test("fileless APPLY scope rejection preserves prior checks and formal findings history", async (t) => {
  const fixture = await filelessRecoveryFixture(t);
  fixture.exampleImplementation = await implementExample(fixture, { filelessReason: fixture.filelessReason });
  const formal = await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  const before = await fs.readFile(path.join(fixture.execution, 'tasks/slice-01.md'), 'utf8');
  const admission = await beginExample(fixture, 'APPLY_FINDINGS');
  const start = await nativeExample({ specPath: fixture.requirements, root: fixture.root }, admission.owner);
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', owner: admission.owner });
  t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
  await fs.writeFile(copy.candidateTaskArtifact, replaceSection(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), 'Corrections Applied', '- none'));
  const payload = { ...fixture.exampleImplementation.response, findingsCycle: 'attempt-01', findingsVerified: 'finding-01',
    correctionsCovered: 'Rechecked the observed process configuration without repository changes', regressionsSelected: 'Same prepared process assertion', unsupportedActiveFindings: 'none' };
  for (const key of ['priorRoundFailure', 'correctionApplied', 'inSliceRationale', 'filelessReason']) delete payload[key];
  const captured = await captureNativeExample(start, payload, []);
  const immutable = await Promise.all([fixture.exampleImplementation.captured.receiptFile, formal.captured.receiptFile, captured.receiptFile].map(async file => [file, await fs.readFile(file)]));
  await insertCapturedScopeBlocker(fixture, admission, copy, captured, 'APPLY_FINDINGS');
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, 'RUNNER_RESULT_BLOCKED'); assert.equal(state.mandatoryRecovery.operation, 'APPLY_FINDINGS');
  const after = await fs.readFile(path.join(fixture.execution, 'tasks/slice-01.md'), 'utf8');
  for (const heading of ['Implementation Test Evidence', 'Validation Attempts', 'Validation Findings', 'Effective Validation Base', 'Final Result'])
    assert.equal(sectionBodyForScopeTest(after, heading), sectionBodyForScopeTest(before, heading));
  assert.equal(state.tasks.get('slice-01').findingsChecks.length, 0);
  assert.match(after, /Fileless reason|filelessReason/u);
  for (const [file, bytes] of immutable) assert.deepEqual(await fs.readFile(file), bytes);
});

test("scope blocker retains an earlier private fileless failure and its check identifier", async (t) => {
  const fixture = await filelessRecoveryFixture(t); fixture.setReady(false);
  const first = await implementExample(fixture, { filelessReason: fixture.filelessReason, failFirst: true, publish: false });
  const copy = first.copy, task = copy.candidateTaskArtifact;
  const before = await fs.readFile(task, 'utf8'), firstReceipt = await fs.readFile(first.captured.receiptFile);
  const start = await startNativeRunnerCapture({ specPath: fixture.requirements, owner: first.admission.owner, workspace: fixture.root,
    captureParent: fixture.root, candidateTaskArtifact: task });
  const agentId = 'offline-fileless-' + randomUUID(); await bindNativeRunnerIdentity({ ...start, agentId });
  fixture.setReady(true);
  const payload = { ...first.response, status: 'TESTS_PASS', automaticCheckRound: '2/3',
    priorRoundFailure: first.response.failures, correctionApplied: 'Corrected the process configuration', inSliceRationale: 'Same observation without repository changes',
    commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: 0 })), failures: 'none',
    resultOfEachCommandAndExitCode: 'The process assertion now passes', evidenceOrFailureSummary: 'Observed ready process configuration' };
  delete payload.filelessReason;
  const captured = await captureNativeExample({ ...start, agentId }, payload, []), receipt = await fs.readFile(captured.receiptFile);
  await insertCapturedScopeBlocker(fixture, first.admission, copy, captured, 'EXECUTE_SLICE');
  const after = await fs.readFile(task, 'utf8');
  assert.equal(sectionBodyForScopeTest(after, 'Implementation Test Evidence'), sectionBodyForScopeTest(before, 'Implementation Test Evidence'));
  assert.match(after, /- After record: implementation-check-01/u); assert.doesNotMatch(after, /^### implementation-check-02/mu);
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, 'RUNNER_RESULT_BLOCKED'); assert.equal(state.tasks.get('slice-01').implementationChecks.length, 1);
  assert.deepEqual(await fs.readFile(first.captured.receiptFile), firstReceipt); assert.deepEqual(await fs.readFile(captured.receiptFile), receipt);
});

function sectionBodyForScopeTest(text, heading) {
  const start = text.indexOf(`## ${heading}\n\n`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

test("completed rejected receipts publish only a blocker and use the existing bounded same-operation recovery", async (t) => {
  for (const scenario of [
    { operation: "EXECUTE_SLICE", rejection: "json" },
    { operation: "EXECUTE_SLICE", rejection: "json", fileless: true },
    { operation: "APPLY_FINDINGS", rejection: "json" },
    { operation: "VALIDATE_SLICE", rejection: "json" },
    { operation: "VALIDATE_SLICE", rejection: "schema" },
    { operation: "EXECUTE_SLICE", rejection: "producer" },
    { operation: "APPLY_FINDINGS", rejection: "producer" },
  ]) await t.test(`${scenario.operation} ${scenario.rejection}${scenario.fileless ? " fileless" : ""}`, async (t) => {
    const fixture = await nestedLifecycleWorkspace(t);
    const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
    const target = path.join(fixture.root, "src/example.txt");
    const claim = path.relative(path.dirname(taskPath), target).split(path.sep).join("/");
    await writeValidatedPath(fixture, claim);
    if (scenario.operation !== "EXECUTE_SLICE") await editTask(fixture, (value) => {
      let task = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", `- \`${claim}\``);
      task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll("../../src/example.txt", claim));
      if (scenario.operation === "APPLY_FINDINGS") {
        task = replaceSection(task, "Validation Attempts", NEEDS_FIX_ATTEMPT.replaceAll("../../src/example.txt", claim));
        task = replaceSection(task, "Validation Findings", ACTIVE_FINDING);
      }
      return task;
    });
    const original = await fs.readFile(taskPath, "utf8");
    const indexBefore = await fs.readFile(path.join(fixture.execution, "tasks.md"));
    const captures = [];
    let runnerTurns = 0;
    let recovery = null;
    let sequence = 0;
    async function dispatch(operation, rejected, exerciseGuards = false) {
      const preflight = await preflightExecutionOperation(fixture.requirements, operation, "1");
      const officialPreflight = { exitCode: 0, operation, slice: "slice-01", inputSlice: "1",
        specPath: fixture.requirements, state: preflight.state, authority: `sha256:${preflight.currentFingerprint}`,
        legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery };
      const context = await createManagedSliceContext({ officialPreflight, workspace: fixture.root, snapshot: ROOT,
        adapterPath: path.join(ROOT, "agents/codex/runtime/validation-runner.mjs"),
        bridgePath: path.join(ROOT, "agents/codex/runtime/managed-runner-bridge.mjs"),
        preflightPath: path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs") });
      const tmpdir = await temporary(t, "stnl-rejected-receipt-");
      const environment = managedEnvironment({ PATH: process.env.PATH, TMPDIR: tmpdir }, context);
      const filelessReason = "Acceptance-only work changes no repository file.";
      let semantic = scopeRegressionPayload(scenario.fileless ? filelessReason : undefined);
      if (operation === "APPLY_FINDINGS") {
        const { priorRoundFailure, correctionApplied, inSliceRationale, ...common } = semantic;
        semantic = { ...common, findingsCycle: "attempt-01", findingsVerified: "finding-01",
          correctionsCovered: "approved correction", regressionsSelected: "prepared checks", unsupportedActiveFindings: "none" };
      } else if (operation === "VALIDATE_SLICE") semantic = { ...sanitizedValidationResponse("PASS"),
        evidence: "Offline SDK fixture models prepared acceptance checks; no real provider is used.",
        ...(scenario.operation === "APPLY_FINDINGS" ? { findingReferences: "finding-01", findingDispositions: "finding-01=resolved" } : {}) };
      if (rejected && scenario.rejection === "schema") semantic = { ...semantic, status: "NEEDS_FIX", commands: [] };
      if (rejected && scenario.rejection === "producer") semantic = { ...semantic, discoverySources: [] };
      const final = rejected && scenario.rejection === "json" ? "{ invalid final response" : JSON.stringify(semantic);
      const broker = await startOfficialRunnerBroker({ workspace: fixture.root, tmpdir,
        operation, sequence: ++sequence, slice: "slice-01", officialPreflight,
        invoke: (request) => invokeIndependentRunner({ ...request, snapshot: ROOT, env: environment,
          runTurn: async ({ eventsPath, operationId, threadId }) => {
            runnerTurns += 1;
            assert.equal(threadId, undefined, "schema rejection grants no format or transport retry");
            const command = "STNL_VERIFICATION_COMMAND=1 node --test test/prepared.test.mjs";
            const events = [{ operationId, type: "thread.started", thread_id: `rejected-thread-${sequence}` },
              { operationId, type: "turn.started" },
              // The schema regression reproduces a discovery-only final response.
              ...(!(rejected && scenario.rejection === "schema") ? [
                { operationId, type: "item.started", item: { id: "item_0", type: "command_execution", command } },
                { operationId, type: "item.completed", item: { id: "item_0", type: "command_execution", command, status: "completed", exit_code: 0 } },
              ] : []),
              { operationId, type: "item.completed", item: { id: "item_1", type: "agent_message", text: final } },
              { operationId, type: "turn.completed" }];
            await fs.writeFile(eventsPath, events.map(JSON.stringify).join("\n") + "\n");
            return { completed: true, turnStarted: true, threadId: `rejected-thread-${sequence}`,
              requestedModel: "gpt-6-luna", requestedEffort: "medium", error: null, usage: null };
          } }) });
      try {
        const receipt = await runManagedRunnerBridge({ environment, cwd: fixture.root,
          payload: operation === "VALIDATE_SLICE" ? "Review prepared checks against the approved requirements."
            : JSON.stringify({ automaticCheckRound: "1/3", changedAreas: scenario.fileless ? [] : [claim],
              ...(scenario.fileless ? { filelessReason } : {}) }) });
        assert.equal(receipt.status, rejected && scenario.rejection !== "producer" ? "RUNNER_RESULT_BLOCKED" : "RUNNER_RESPONSE_CAPTURED");
        assert.equal(await fs.readFile(receipt.semanticResponseFile, "utf8"), final);
        assert.equal(receipt.semanticResponseSha256, createHash("sha256").update(final).digest("hex"));
        assert.equal(receipt.authority, officialPreflight.authority);
        if (operation === "VALIDATE_SLICE") {
          await assert.rejects(runManagedRunnerBridge({ environment, cwd: fixture.root, payload: "repeat" }),
            (error) => error.code === "BROKER_RESULT_ALREADY_CAPTURED");
        }
        const capturedBefore = await treeBytes(tmpdir);
        captures.push({ tmpdir, bytes: capturedBefore.filter(([file]) => !file.startsWith("stnl-runner-broker")) });
        const copy = operation === "VALIDATE_SLICE"
          ? await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent: tmpdir })
          : await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
        const candidateTask = path.join(copy.candidateExecutionRoot, "tasks/slice-01.md");
        if (operation !== "VALIDATE_SLICE") {
          let task = replaceSection((await fs.readFile(candidateTask, "utf8")).replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", scenario.fileless ? "- none" : `- \`${claim}\``);
          if (operation === "APPLY_FINDINGS") task = replaceSection(task, "Corrections Applied", `- \`${claim}\``);
          await fs.writeFile(candidateTask, task);
        } else if (!rejected && scenario.operation === "APPLY_FINDINGS") {
          await fs.writeFile(candidateTask, replaceSection(await fs.readFile(candidateTask, "utf8"), "Validation Findings",
            `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 verified the correction.`));
        }
        if (!rejected && operation === "VALIDATE_SLICE") await fs.writeFile(candidateTask,
          replaceSection(await fs.readFile(candidateTask, "utf8"), "Diff Summary", "- Offline prepared checks verified the approved acceptance behavior."));
        const args = operation === "VALIDATE_SLICE"
          ? [path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs"),
            "--prepare", "--spec-path", fixture.requirements, "--slice", "slice-01", "--workspace", fixture.root,
            "--candidate-execution-root", copy.candidateExecutionRoot]
          : [path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
            "--execution-bundle", "--operation", operation, "--workspace", fixture.root,
            "--task-artifact", candidateTask, "--insert-candidate"];
        args.push("--receipt-file", receipt.receiptFile, "--semantic-response-file", receipt.semanticResponseFile);
        const before = await treeBytes(copy.candidateExecutionRoot);
        const runProducer = (env = environment, argv = args) => spawnSync(process.execPath, argv,
          { cwd: fixture.root, env, encoding: "utf8" });
        if (exerciseGuards) {
          if (receipt.status === "RUNNER_RESULT_BLOCKED") {
            await assert.rejects(assertManagedRunnerReceipt({ operation, slice: "slice-01", workspace: fixture.root,
              receiptFile: receipt.receiptFile, semanticResponseFile: receipt.semanticResponseFile, environment }),
            /receipt does not match the active managed runner invocation/u, "ordinary evidence consumers cannot accept a rejected receipt");
            assert.equal(runProducer({ PATH: process.env.PATH }).status, 1, "a rejected diagnostic cannot manufacture native recovery");
            assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before);
          }
          const receiptBytes = await fs.readFile(receipt.receiptFile);
          for (const mutation of [
            { operation: operation === "VALIDATE_SLICE" ? "EXECUTE_SLICE" : "VALIDATE_SLICE" },
            { slice: "slice-02" }, { sequence: sequence + 1 }, { attempt: 2 }, { threadId: "other" },
            { authority: "sha256:" + "0".repeat(64) }, { semanticResponseSha256: "0".repeat(64) },
            { semanticResponseFile: path.join(tmpdir, "copied.response.json") },
            { receiptFile: path.join(tmpdir, "copied.receipt.json") },
            ...(receipt.status === "RUNNER_RESULT_BLOCKED" ? [{ status: "RUNNER_RESPONSE_CAPTURED", exitCode: 0,
              captureFailure: null, captureFailureCode: null }] : []),
            { processError: "uncertain timeout" }, { providerError: { message: "provider failure" } },
          ]) {
            await fs.writeFile(receipt.receiptFile, JSON.stringify({ ...receipt, ...mutation }));
            const result = runProducer();
            assert.equal(result.status, 1, JSON.stringify(mutation));
            assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before);
          }
          await fs.writeFile(receipt.receiptFile, receiptBytes);
          const responseBytes = await fs.readFile(receipt.semanticResponseFile);
          await fs.appendFile(receipt.semanticResponseFile, " ");
          assert.equal(runProducer().status, 1);
          assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before);
          await fs.writeFile(receipt.semanticResponseFile, responseBytes);
          const eventsBytes = await fs.readFile(receipt.eventsPath);
          for (const changed of [
            eventsBytes.toString().replace(final.replaceAll("\\", "\\\\").replaceAll('"', '\\"'), "different final bytes"),
            eventsBytes + JSON.stringify({ operationId: `runner-${path.basename(receipt.eventsPath, ".events.jsonl")}`, type: "turn.started" }) + "\n",
          ]) {
            await fs.writeFile(receipt.eventsPath, changed);
            assert.equal(runProducer().status, 1, "event bytes and conclusive final completion are required");
            assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before);
          }
          await fs.writeFile(receipt.eventsPath, eventsBytes);
          const startedPath = receipt.eventsPath.replace(".events.jsonl", ".started.json");
          const startedBytes = await fs.readFile(startedPath);
          await fs.writeFile(startedPath, JSON.stringify({ ...JSON.parse(startedBytes), authority: "sha256:" + "0".repeat(64) }));
          assert.equal(runProducer().status, 1);
          await fs.writeFile(startedPath, startedBytes);
          const copiedReceipt = path.join(tmpdir, "copied.receipt.json");
          await fs.writeFile(copiedReceipt, receiptBytes);
          assert.equal(runProducer(environment, args.map((arg) => arg === receipt.receiptFile ? copiedReceipt : arg)).status, 1);
          await fs.rm(copiedReceipt);
          const requirementsFile = path.join(fixture.requirements, "shared/requirements.md");
          const requirementsBefore = await fs.readFile(requirementsFile);
          await fs.appendFile(requirementsFile, "\nChanged authority after dispatch.\n");
          assert.equal(runProducer().status, 1);
          assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before);
          await fs.writeFile(requirementsFile, requirementsBefore);
        }
        const produced = runProducer();
        assert.equal(produced.status, 0, produced.stderr);
        const candidate = await fs.readFile(candidateTask, "utf8");
        if (rejected) {
          assert.match(produced.stdout, /RUNNER_RESULT_BLOCKED/u);
          for (const heading of ["Implementation Test Evidence", "Findings Test Evidence", "Validation Attempts", "Effective Validation Base", "Final Result"]) {
            assert.equal(sectionBodyForScopeTest(candidate, heading), sectionBodyForScopeTest(original, heading), heading);
          }
          assert.equal((candidate.match(/^- Kind: malformed-output$/gmu) ?? []).length, 1);
          assert.match(candidate, new RegExp(`- Operation: ${operation}`));
        }
        await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot);
        if (operation === "VALIDATE_SLICE") await publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01", candidateExecutionRoot: copy.candidateExecutionRoot });
        else await publishExecutionCopy({ specPath: fixture.requirements, slice: "slice-01", candidateRoot: copy.candidateRoot });
        const state = await inspectExecutionState(fixture.requirements);
        if (rejected) {
          assert.equal(state.state, "RUNNER_RESULT_BLOCKED");
          assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks.md")), indexBefore);
          assert.equal(state.mandatoryRecovery.operation, operation);
          assert.equal(state.mandatoryRecovery.slice, "slice-01");
          const readback = { execution: state, executionRaw: state, product: { deriveNormalHandoff } };
          const outcome = decideOutcome(operation, readback, true);
          const next = recoverableRunnerHandoff({ operation, slice: "slice-01", outcome, readback,
            priorOperations: recovery === null ? [] : [{ recovery }], remainingTurns: 20 });
          if (recovery === null) { assert.equal(next.operation, operation); recovery = next; }
          else assert.equal(next, null, "second rejection does not authorize another automatic recovery");
        }
        return state;
      } finally { await broker.close(); }
    }
    await dispatch(scenario.operation, true, true);
    // Exercise the exhausted automatic-recovery edge separately. The following
    // valid response is an explicit manual resume, not a new automatic retry.
    if (scenario.rejection === "schema") await dispatch(scenario.operation, true);
    await dispatch(scenario.operation, false);
    if (scenario.operation !== "VALIDATE_SLICE") await dispatch("VALIDATE_SLICE", false);
    const final = await inspectExecutionState(fixture.requirements);
    assert.equal(final.state, "COMPLETE");
    assert.equal(final.tasks.get("slice-01").attempts.length, scenario.operation === "APPLY_FINDINGS" ? 2 : 1);
    assert.equal(runnerTurns, (scenario.operation === "VALIDATE_SLICE" ? 2 : 3) + (scenario.rejection === "schema" ? 1 : 0));
    for (const capture of captures) for (const [file, , bytes] of capture.bytes)
      if (bytes !== null) assert.deepEqual(await fs.readFile(path.join(capture.tmpdir, file)), bytes, `immutable ${file}`);
  });
});

test("T01/T02/T10/T12/T14: finite managed CLI and finalizer own rejected recovery through completion", { timeout: 15000 }, async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const finalizer = path.join(ROOT, "agents/codex/runtime/managed-slice-finalize.mjs");
  const bridge = path.join(ROOT, "agents/codex/runtime/managed-runner-bridge.mjs");
  const task = path.join(fixture.execution, "tasks/slice-01.md");
  const reason = "Acceptance-only work changes no repository file.";
  let turns = 0;
  for (const [index, operation] of ["EXECUTE_SLICE", "EXECUTE_SLICE", "VALIDATE_SLICE"].entries()) {
    const current = await preflightExecutionOperation(fixture.requirements, operation, "1");
    const preflight = { exitCode: 0, operation, slice: "slice-01", inputSlice: "1", specPath: fixture.requirements,
      state: current.state, authority: `sha256:${current.currentFingerprint}`, legalOperations: current.legalOperations, mandatoryRecovery: current.mandatoryRecovery };
    const context = await createManagedSliceContext({ officialPreflight: preflight, workspace: fixture.root, snapshot: ROOT,
      adapterPath: path.join(ROOT, "agents/codex/runtime/validation-runner.mjs"), bridgePath: bridge,
      preflightPath: path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs") });
    const tmpdir = await temporary(t, "stnl-finite-transport-");
    const environment = managedEnvironment({ PATH: process.env.PATH, TMPDIR: tmpdir }, context);
    const broker = await startOfficialRunnerBroker({ workspace: fixture.root, tmpdir, operation, slice: "slice-01",
      sequence: index + 1, officialPreflight: preflight,
      invoke: (request, { signal }) => invokeIndependentRunner({ ...request, snapshot: ROOT, env: environment, signal,
        runTurn: async ({ eventsPath, operationId }) => {
          turns += 1;
          const command = "STNL_VERIFICATION_COMMAND=1 node --test test/prepared.test.mjs";
          const response = index === 0 ? "{ invalid completed JSON"
            : JSON.stringify(operation === "EXECUTE_SLICE" ? scopeRegressionPayload(reason)
              : { ...sanitizedValidationResponse("PASS"), evidence: "Offline fixture models independent prepared checks." });
          const events = [{ operationId, type: "thread.started", thread_id: `finite-${index}` }, { operationId, type: "turn.started" },
            { operationId, type: "item.started", item: { id: "item_0", type: "command_execution", command } },
            { operationId, type: "item.completed", item: { id: "item_0", type: "command_execution", command, status: "completed", exit_code: 0 } },
            { operationId, type: "item.completed", item: { id: "item_1", type: "agent_message", text: response } }, { operationId, type: "turn.completed" }];
          await fs.writeFile(eventsPath, events.map(JSON.stringify).join("\n") + "\n");
          return { completed: true, turnStarted: true, threadId: `finite-${index}`, error: null, processError: null };
        } }) });
    environment.STNL_MANAGED_RUNNER_PAYLOAD = broker.payloadFile;
    environment.STNL_MANAGED_FINALIZER = finalizer;
    const call = (args) => spawnSync(process.execPath, [finalizer, ...args], { cwd: fixture.root, env: environment, encoding: "utf8", timeout: 3000 });
    const bridgeCall = (file = broker.payloadFile) => spawnSync(process.execPath, [bridge, "--payload-file", file],
      { cwd: fixture.root, env: environment, encoding: "utf8", timeout: 3000 });
    try {
      const prepared = call(["--prepare"]); assert.equal(prepared.status, 0, prepared.stderr);
      const copy = JSON.parse(prepared.stdout);
      assert.equal(call(["--prepare"]).status, 1, "a second prepare cannot switch candidate identity");
      let candidate = await fs.readFile(copy.candidateTaskArtifact, "utf8");
      if (operation === "EXECUTE_SLICE") candidate = replaceSection(candidate.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- none");
      candidate = replaceSection(candidate, "Diff Summary", "- Offline prepared acceptance behavior is represented in the selected candidate.");
      await fs.writeFile(copy.candidateTaskArtifact, candidate);
      if (index === 0) {
        assert.equal(bridgeCall().status, 1, "missing payload is finite");
        for (const bytes of ["", "{ invalid JSON", "x".repeat(256 * 1024 + 1)]) {
          await fs.writeFile(broker.payloadFile, bytes);
          assert.equal(bridgeCall().status, 1);
          assert.equal(broker.requestsHandled, 0);
        }
        const other = path.join(tmpdir, "other.json"); await fs.writeFile(other, "{}");
        await fs.rm(broker.payloadFile); await fs.symlink(other, broker.payloadFile);
        assert.equal(bridgeCall().status, 1);
        await fs.rm(broker.payloadFile); await fs.link(other, broker.payloadFile);
        assert.equal(bridgeCall().status, 1);
        await fs.rm(broker.payloadFile); await fs.rm(other);
        assert.equal(bridgeCall(task).status, 1, "an arbitrary existing file is not the owned payload");
      }
      await fs.writeFile(broker.payloadFile, JSON.stringify(operation === "EXECUTE_SLICE"
        ? { automaticCheckRound: "1/3", changedAreas: [], filelessReason: reason, relevantEvidence: "Olá \"quotes\" $() `data`\nline" }
        : { relevantEvidence: "Independently verify approved acceptance criteria." }));
      const child = spawn(process.execPath, [bridge, "--payload-file", broker.payloadFile], { cwd: fixture.root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, index === 0 ? 1 : 0, stderr);
      assert.match(stdout, /SENTINEL_RUNNER_RECEIPT/u);
      assert.equal(broker.requestsHandled, 1);
      // The CLI completed despite its stdin remaining open; dispatch used finite bytes.
      const liveBefore = await fs.readFile(task);
      const latestFile = path.join(broker.directory, `${String(index + 1).padStart(3, "0")}.latest.json`);
      const latestBefore = await fs.readFile(latestFile);
      const latest = JSON.parse(latestBefore);
      for (const mismatch of [{ slice: "slice-02" }, { operation: "APPLY_FINDINGS" }, { authority: "sha256:" + "f".repeat(64) },
        { payloadSha256: "f".repeat(64) }, { receipt: { ...latest.receipt, threadId: "another-thread" } }]) {
        await fs.writeFile(latestFile, JSON.stringify({ ...latest, ...mismatch }));
        assert.equal(call(["--finalize"]).status, 1);
        assert.deepEqual(await fs.readFile(task), liveBefore);
      }
      await fs.writeFile(latestFile, latestBefore);
      const finalized = call(["--finalize"]); assert.equal(finalized.status, 0, finalized.stderr);
      const result = JSON.parse(finalized.stdout);
      assert.equal(result.state, ["RUNNER_RESULT_BLOCKED", "IMPLEMENTED_AWAITING_VALIDATION", "COMPLETE"][index]);
      const after = await fs.readFile(task);
      const duplicate = call(["--finalize"]); assert.equal(duplicate.status, 0, duplicate.stderr);
      assert.deepEqual(JSON.parse(duplicate.stdout), result);
      assert.deepEqual(await fs.readFile(task), after, "duplicate finalization never appends a check/attempt");
      await fs.writeFile(task, Buffer.concat([after, Buffer.from("\n<!-- foreign write -->\n")]));
      const conflict = await fs.readFile(task);
      assert.equal(call(["--finalize"]).status, 1, "idempotence cannot cover a conflicting live readback");
      assert.deepEqual(await fs.readFile(task), conflict);
      await fs.writeFile(task, after);
      const recorded = path.join(broker.directory, `${String(index + 1).padStart(3, "0")}.finalization.json`);
      const recordedBytes = await fs.readFile(recorded);
      await fs.writeFile(recorded, JSON.stringify({ ...JSON.parse(recordedBytes), evidenceSha256: { "/outside/fictitious-GLOBAL": "0".repeat(64) } }));
      assert.equal(call(["--finalize"]).status, 1, "recorded evidence never authorizes arbitrary read paths");
      assert.deepEqual(await fs.readFile(task), after);
      await fs.writeFile(recorded, recordedBytes);
      assert.equal(call(["--finalize", "--receipt-file", "/outside"]).status, 1, "receipt paths are not caller-selected");
    } finally { await broker.close(); }
  }
  assert.equal(turns, 3);
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, "COMPLETE");
  assert.equal(state.tasks.get("slice-01").attempts.length, 1, "rejected diagnostics are not formal attempts");
});

test("managed bridge and broker bind one format repair through strict publication", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await implementExample(fixture);
  const preflight = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  const officialPreflight = { exitCode: 0, operation: "VALIDATE_SLICE", slice: "slice-01", inputSlice: "1",
    specPath: fixture.requirements, state: preflight.state, authority: `sha256:${preflight.currentFingerprint}`,
    legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery, activationId: preflight.activation.activationId };
  const context = await createManagedSliceContext({ officialPreflight, workspace: fixture.root, snapshot: ROOT,
    adapterPath: path.join(ROOT, "agents/codex/runtime/validation-runner.mjs"),
    bridgePath: path.join(ROOT, "agents/codex/runtime/managed-runner-bridge.mjs"),
    preflightPath: path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs") });
  Object.assign(officialPreflight, { owner: context.owner, expectedActivationId: context.expectedActivationId });
  const tmpdir = await temporary(t, "stnl-managed-provider-");
  const environment = managedEnvironment({ ...process.env, TMPDIR: tmpdir }, context);
  const semantic = JSON.stringify({ status: "PASS", head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "semantic claim", exit: 0 }], evidence: "simulated independent provider result",
    findingReferences: "none", findingDispositions: "none", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes" });
  const originalEnvironment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  Object.assign(process.env, environment);
  let runnerTurns = 0;
  const broker = await startOfficialRunnerBroker({ workspace: fixture.root, tmpdir,
    operation: "VALIDATE_SLICE", sequence: 1, slice: "slice-01", officialPreflight,
    invoke: (request) => invokeIndependentRunner({ ...request, snapshot: ROOT, env: environment,
      runTurn: async ({ eventsPath, operationId, threadId }) => {
        runnerTurns += 1;
        assert.equal(threadId, runnerTurns === 1 ? undefined : "simulated-provider-thread");
        const events = [
          ...(runnerTurns === 1 ? [{ operationId, type: "thread.started", thread_id: "simulated-provider-thread" }] : []),
          { operationId, type: "turn.started" },
          { operationId, type: "item.completed", item: { id: "item_1", type: "agent_message",
            text: runnerTurns === 1 ? JSON.stringify({ ...JSON.parse(semantic),
              findingReferences: [], findingDispositions: [] }) : semantic } },
          { operationId, type: "turn.completed", usage: { input_tokens: 5, output_tokens: 5 } },
        ];
        await fs.appendFile(eventsPath, `${events.map(JSON.stringify).join("\n")}\n`);
        return { completed: true, turnStarted: true, threadId: "simulated-provider-thread",
          requestedModel: "gpt-5.6-luna", requestedEffort: "medium", reportedModel: null,
          error: null, usage: { input_tokens: 5, output_tokens: 5 } };
      } }) });
  try {
    const receipt = await runManagedRunnerBridge({ environment, cwd: fixture.root, payload: "Review changed scope and checks." });
    assert.equal(receipt.status, "RUNNER_RESPONSE_CAPTURED");
    assert.equal(receipt.formatRepair.accepted, true);
    assert.deepEqual(receipt.verification.checks.map(({ command, exit }) => ({ command, exit })), [{ command: 'node --test src/example.test.mjs', exit: 0 }]);
    assert.equal(runnerTurns, 2);
    assert.equal(broker.requestsHandled, 1);
    assert.equal(broker.capturedReceipts, 1);
    await assert.rejects(runManagedRunnerBridge({ environment, cwd: fixture.root,
      payload: "Try another validation after format repair." }),
    (error) => error.code === "BROKER_RESULT_ALREADY_CAPTURED");
    assert.equal(runnerTurns, 2, "format repair must not release the broker's validation lock");
    assert.equal(receipt.receiptFile, await fs.realpath(path.join(tmpdir, "001-validate_slice-slice-01-attempt-1.receipt.json")));
    const receiptPath = receipt.receiptFile;
    const receiptBytes = await fs.readFile(receiptPath);
    assert.deepEqual(JSON.parse(receiptBytes), receipt, "returned receipt names the file already persisted by the adapter");
    const eventsBytes = await fs.readFile(receipt.eventsPath);
    const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent: tmpdir, owner: context.owner });
    const cli = path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs");
    const args = [cli, "--prepare", "--spec-path", fixture.requirements, "--slice", "slice-01",
      "--workspace", fixture.root, "--candidate-execution-root", copy.candidateExecutionRoot,
      "--semantic-response-file", receipt.semanticResponseFile];
    const candidateBefore = await treeBytes(copy.candidateExecutionRoot);
    const liveBefore = await treeBytes(fixture.execution);
    const duplicate = path.join(tmpdir, "transcribed.receipt.json");
    await fs.writeFile(duplicate, receiptBytes);
    const copiedReceipt = spawnSync(process.execPath, [...args, "--receipt-file", duplicate],
      { cwd: fixture.root, env: environment, encoding: "utf8" });
    assert.equal(copiedReceipt.status, 1);
    assert.match(copiedReceipt.stderr, /receipt does not match the active managed runner invocation/u);
    assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidateBefore);
    assert.deepEqual(await treeBytes(fixture.execution), liveBefore);
    const missing = spawnSync(process.execPath, args, { cwd: fixture.root, env: environment, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /managed runner receipt is required/u);
    const wrong = path.join(tmpdir, "wrong.receipt.json");
    await fs.writeFile(wrong, JSON.stringify({ ...receipt, operation: "EXECUTE_SLICE" }));
    const mismatch = spawnSync(process.execPath, [...args, "--receipt-file", wrong],
      { cwd: fixture.root, env: environment, encoding: "utf8" });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /receipt does not match the active managed runner invocation/u);
    const capturedBytes = await fs.readFile(receipt.semanticResponseFile);
    await fs.writeFile(receipt.semanticResponseFile, `${capturedBytes.toString("utf8")} `);
    const staleResponse = spawnSync(process.execPath, [...args, "--receipt-file", receipt.receiptFile],
    { cwd: fixture.root, env: environment, encoding: "utf8" });
    assert.equal(staleResponse.status, 1);
    assert.match(staleResponse.stderr, /receipt response hash disagrees/u);
    await fs.writeFile(receipt.semanticResponseFile, capturedBytes);
    const prepared = spawnSync(process.execPath, [...args, "--receipt-file", receipt.receiptFile],
    { cwd: fixture.root, env: environment, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).formalStatus, "PASS", prepared.stdout);
    assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, "COMPLETE");
    assert.equal((await publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
      candidateExecutionRoot: copy.candidateExecutionRoot, owner: context.owner })).state, "COMPLETE");
    const readback = await inspectExecutionState(fixture.requirements);
    assert.equal(readback.state, "COMPLETE");
    assert.deepEqual(nextHandoff("VALIDATE_SLICE", { executionRaw: readback }), { operation: "SPEC_CLOSE", slice: null });
    assert.equal(runnerTurns, 2, "preparation and publication consume the captured result without another runner turn");
    assert.equal(broker.requestsHandled, 2);
    assert.equal(broker.capturedReceipts, 1);
    assert.deepEqual(broker.errors, ["BROKER_RESULT_ALREADY_CAPTURED"], "formal PASS retains the rejected duplicate incident");
    assert.deepEqual(await fs.readFile(receiptPath), receiptBytes);
    assert.deepEqual(await fs.readFile(receipt.eventsPath), eventsBytes);
    assert.deepEqual(await fs.readFile(receipt.semanticResponseFile), capturedBytes);
    assert.deepEqual(await fs.readFile(duplicate), receiptBytes, "the rejected receipt copy remains preserved after official PASS");
  } finally {
    try { await broker.close(); }
    finally { for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]; Object.assign(process.env, originalEnvironment); }
  }
});

test("runner adapter fails closed on uncertain SDK returns and captures a valid final response", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const officialPreflight = { exitCode: 0, operation: "VALIDATE_SLICE", slice: "slice-01",
    specPath: fixture.requirements, legalOperations: [{ operation: "VALIDATE_SLICE", slice: "slice-01" }],
    mandatoryRecovery: null };
  const baseTurn = { requestedModel: "gpt-6-luna", requestedEffort: "medium", reportedModel: null,
    usage: null, error: null, processError: null, errorEvent: null };
  const scenarios = [
    { name: "process error after thread start", turn: { completed: false, turnStarted: true,
      threadId: "started-thread", processError: "process exited" }, status: "RUNNER_RESULT_BLOCKED" },
    { name: "timeout without a thread event", turn: { completed: false, turnStarted: false,
      threadId: null, processError: "AbortError: timed out" }, status: "RUNNER_RESULT_BLOCKED" },
    { name: "completed with malformed final JSON", turn: { completed: true, turnStarted: true,
      threadId: "started-thread" }, message: "{", status: "RUNNER_RESULT_BLOCKED" },
    { name: "completed with valid final JSON", turn: { completed: true, turnStarted: true,
      threadId: "started-thread" }, message: JSON.stringify(sanitizedValidationResponse("PASS")),
      status: "RUNNER_RESPONSE_CAPTURED" },
    { name: "accounting failure after dispatch", turn: { completed: true, turnStarted: true,
      threadId: "started-thread" }, message: JSON.stringify({ status: "PASS" }),
      accountingFailure: true, status: "RUNNER_RESULT_BLOCKED" },
    { name: "SDK invocation throws without no-start proof", throws: true, status: "RUNNER_RESULT_BLOCKED" },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const tmpdir = await temporary(t, "stnl-runner-return-");
    const receipt = await invokeIndependentRunner({ snapshot: ROOT, workspace: fixture.root,
      tmpdir, env: {}, operation: "VALIDATE_SLICE", sequence: index + 1, slice: "slice-01",
      officialPreflight, prompt: "Review the current slice.",
      onTurn: scenario.accountingFailure ? () => { throw new Error("accounting failed"); } : () => {},
      runTurn: async ({ eventsPath }) => {
        if (scenario.throws) throw new Error("SDK invocation failed after dispatch");
        if (scenario.message !== undefined) {
          await fs.writeFile(eventsPath, `${JSON.stringify({ type: "item.completed",
            item: { type: "agent_message", text: scenario.message } })}\n`);
        }
        return { ...baseTurn, ...scenario.turn };
      } });
    assert.equal(receipt.status, scenario.status, scenario.name);
    assert.equal(receipt.exitCode, scenario.status === "RUNNER_RESPONSE_CAPTURED" ? 0 : 1, scenario.name);
    assert.equal(receipt.receiptFile, await fs.realpath(path.join(tmpdir,
      `${String(index + 1).padStart(3, "0")}-validate_slice-slice-01-attempt-1.receipt.json`)));
    assert.equal(receipt.owner, undefined, 'this isolated adapter unit has no admitted workflow owner');
    assert.deepEqual(JSON.parse(await fs.readFile(receipt.receiptFile)), JSON.parse(JSON.stringify(receipt)), 'receipt persistence preserves its entire JSON representation');
    if (scenario.name === "completed with malformed final JSON") {
      assert.match(receipt.captureFailure, /not valid JSON/u);
    }
    if (scenario.throws) assert.match(receipt.processError, /SDK invocation failed/u);
    if (scenario.accountingFailure) assert.match(receipt.processError, /accounting failed/u);
  }
});

test("one same-thread format repair preserves the completed validation verdict and evidence", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const valid = JSON.stringify({ status: "BLOCKED", head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "node --test", exit: 0 }], evidence: "original evidence",
    findingReferences: "none", findingDispositions: "none", blockers: "missing prerequisite",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "no writes" });
  const malformed = valid.slice(0, -1);
  const scenarios = [
    { name: "format fixed", first: malformed, second: valid, expected: "RUNNER_RESPONSE_CAPTURED", turns: 2 },
    { name: "real empty finding arrays", first: emptyFindingArrays, second: JSON.stringify(sanitizedValidationResponse()),
      expected: "RUNNER_RESPONSE_CAPTURED", turns: 2 },
    { name: "combined fence and arrays", first: `\`\`\`json\n${emptyFindingArrays}\n\`\`\``,
      second: JSON.stringify(sanitizedValidationResponse()), expected: "RUNNER_RESPONSE_CAPTURED", turns: 2 },
    { name: "schema repair changed verdict", first: emptyFindingArrays,
      second: JSON.stringify(sanitizedValidationResponse("PASS")), expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "schema repair changed evidence", first: emptyFindingArrays,
      second: JSON.stringify(sanitizedValidationResponse()).replace('need direct evidence', 'have sufficient evidence'),
      expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "schema repair second invalid", first: emptyFindingArrays, second: emptyFindingArrays,
      expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "nonempty finding array", first: JSON.stringify({ ...sanitizedValidationResponse(), findingReferences: ["finding-01"] }),
      expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
    { name: "fence fixed", first: `\`\`\`json\n${valid}\n\`\`\``, second: valid,
      expected: "RUNNER_RESPONSE_CAPTURED", turns: 2 },
    { name: "trailing comma fixed", first: valid.slice(0, -1) + ',}', second: valid,
      expected: "RUNNER_RESPONSE_CAPTURED", turns: 2 },
    { name: "second malformed", first: malformed, second: malformed, expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "verdict changed", first: malformed, second: valid.replace('"BLOCKED"', '"PASS"'),
      expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "evidence changed", first: malformed, second: valid.replace('original evidence', 'new evidence'),
      expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "valid BLOCKED", first: valid, expected: "RUNNER_RESPONSE_CAPTURED", turns: 1 },
    { name: "valid NEEDS_FIX", first: valid.replace('"BLOCKED"', '"NEEDS_FIX"'),
      expected: "RUNNER_RESPONSE_CAPTURED", turns: 1 },
    { name: "pending", first: malformed, pending: true, expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
    { name: "uncertain timeout", first: malformed, incomplete: true, expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
    { name: "completed with process error", first: malformed, processError: true,
      expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
    { name: "unprovable original", first: valid.slice(0, -2), expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
    { name: "schema failure", first: malformed.replace('"commands":[', '"checks":['),
      expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
    { name: "completion event absent", first: malformed, noCompletion: true,
      expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
    { name: "next turn pending in events", first: malformed, pendingEvent: true,
      expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
    { name: "repair changed thread", first: malformed, second: valid, changedThread: true,
      expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "repair timed out", first: malformed, second: valid, repairTimeout: true,
      expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "repair threw", first: malformed, second: valid, repairThrows: true,
      expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "repair used a tool", first: malformed, second: valid, toolUse: true,
      expected: "RUNNER_RESULT_BLOCKED", turns: 2 },
    { name: "EXECUTE does not repair", operation: "EXECUTE_SLICE", first: malformed,
      expected: "RUNNER_RESULT_BLOCKED", turns: 1 },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const tmpdir = await temporary(t, "stnl-format-repair-");
    const operation = scenario.operation ?? "VALIDATE_SLICE";
    const preflight = { exitCode: 0, operation, slice: "slice-01", specPath: fixture.requirements,
      legalOperations: [{ operation, slice: "slice-01" }], mandatoryRecovery: null };
    let calls = 0;
    let reservations = 0;
    const receipt = await invokeIndependentRunner({ snapshot: ROOT, workspace: fixture.root,
      tmpdir, env: {}, operation, sequence: index + 20, slice: "slice-01", officialPreflight: preflight,
      prompt: operation === "EXECUTE_SLICE" ? "automaticCheckRound=1/3" : "Review the current slice.",
      onBeforeTurn: async () => { reservations += 1; },
      runTurn: async ({ eventsPath, operationId, threadId, prompt }) => {
        calls += 1;
        if (calls > 2) throw new Error("format repair exceeded one attempt");
        if (calls === 2) {
          assert.equal(threadId, "format-thread", scenario.name);
          assert.match(prompt, /Do not inspect files, run checks,/u);
          assert.ok(prompt.endsWith(scenario.first), scenario.name);
          if (scenario.repairThrows) throw new Error("repair transport exception");
        } else assert.equal(threadId, undefined, scenario.name);
        if (scenario.incomplete) return { completed: false, turnStarted: true,
          threadId: "format-thread", processError: "AbortError: timed out", error: "timed out" };
        if (scenario.pending || (calls === 2 && scenario.repairTimeout)) {
          return { completed: false, turnStarted: true, threadId: "format-thread", error: null };
        }
        const message = calls === 1 ? scenario.first : scenario.second;
        const events = [
          ...(calls === 1 ? [{ operationId, type: "thread.started", thread_id: "format-thread" }] : []),
          { operationId, type: "turn.started" },
          ...(calls === 2 && scenario.toolUse ? [{ operationId, type: "item.completed",
            item: { type: "command_execution", command: "node --test", exit_code: 0 } }] : []),
          { operationId, type: "item.completed", item: { type: "agent_message", text: message } },
          ...(!scenario.noCompletion ? [{ operationId, type: "turn.completed",
            usage: { input_tokens: 1, output_tokens: 1 } }] : []),
          ...(scenario.pendingEvent ? [{ operationId, type: "turn.started" }] : []),
        ];
        await fs.appendFile(eventsPath, `${events.map(JSON.stringify).join("\n")}\n`);
        return { completed: true, turnStarted: true,
          threadId: calls === 2 && scenario.changedThread ? "other-thread" : "format-thread",
          requestedModel: "gpt-6-luna", requestedEffort: "medium", reportedModel: null,
          error: null, processError: scenario.processError ? "process exited" : null,
          usage: { input_tokens: 1, output_tokens: 1 } };
      } });
    assert.equal(receipt.status, scenario.expected, scenario.name);
    assert.equal(calls, scenario.turns, scenario.name);
    assert.equal(reservations, scenario.turns, scenario.name);
    if (scenario.expected === "RUNNER_RESULT_BLOCKED") {
      const diagnosticAllowed = !scenario.pending && !scenario.incomplete && !scenario.processError
        && !scenario.noCompletion && !scenario.pendingEvent && !scenario.changedThread
        && !scenario.repairTimeout && !scenario.repairThrows && !scenario.toolUse;
      if (diagnosticAllowed) {
        const rejected = scenario.turns === 2 ? scenario.second : scenario.first;
        assert.ok(receipt.semanticResponseFile, `${scenario.name}: completed rejection retains a bound diagnostic`);
        assert.equal(await fs.readFile(receipt.semanticResponseFile, "utf8"), rejected);
        assert.equal(receipt.semanticResponseSha256, createHash("sha256").update(rejected).digest("hex"));
        assert.equal(receipt.semanticResponseStatus, null, "diagnostic is never an accepted verdict");
        assert.equal(receipt.exitCode, 1);
      } else assert.equal(receipt.semanticResponseFile, null, `${scenario.name}: uncertain/unsafe completion cannot authorize recovery`);
    }
    if (scenario.name === "format fixed") {
      assert.equal(receipt.semanticResponseStatus, "BLOCKED");
      assert.equal(await fs.readFile(receipt.semanticResponseFile, "utf8"), valid);
      assert.equal(receipt.formatRepair.accepted, true);
      assert.equal(await fs.readFile(receipt.formatRepair.originalResponseFile, "utf8"), malformed);
      assert.equal(await fs.readFile(receipt.formatRepair.repairedResponseFile, "utf8"), valid);
      assert.equal(receipt.formatRepair.originalSha256, createHash("sha256").update(malformed).digest("hex"));
      assert.equal(receipt.formatRepair.threadId, "format-thread");
      assert.ok(receipt.formatRepair.eventOffset > 0);
      assert.equal(receipt.formatRepair.repairTurn.completed, true);
    }
    if (["real empty finding arrays", "combined fence and arrays"].includes(scenario.name)) {
      assert.equal(receipt.semanticResponseStatus, "BLOCKED");
      assert.equal(receipt.captureFailureCode, null);
      assert.deepEqual(receipt.formatRepair.emptyFindingFields, ["findingReferences", "findingDispositions"]);
      assert.equal(receipt.formatRepair.originalSha256, createHash("sha256").update(scenario.first).digest("hex"));
      assert.equal(receipt.semanticResponseSha256, createHash("sha256").update(scenario.second).digest("hex"));
      if (scenario.name === "real empty finding arrays") {
        assert.equal(receipt.formatRepair.originalCaptureFailureCode, "RUNNER_RESPONSE_SCHEMA_INVALID");
      }
      assert.equal(await fs.readFile(receipt.formatRepair.originalResponseFile, "utf8"), scenario.first);
      assert.equal(await fs.readFile(receipt.semanticResponseFile, "utf8"), scenario.second);
      assert.deepEqual(JSON.parse(scenario.second).commands, JSON.parse(emptyFindingArrays).commands);
      assert.equal(JSON.parse(scenario.second).evidence, JSON.parse(emptyFindingArrays).evidence);
    }
    if (scenario.expected === "RUNNER_RESULT_BLOCKED" && scenario.turns === 2) {
      assert.equal(receipt.formatRepair.accepted, false, scenario.name);
      assert.ok(receipt.formatRepair.rejection, scenario.name);
    }
    if (["valid BLOCKED", "valid NEEDS_FIX"].includes(scenario.name) || scenario.incomplete
      || scenario.pending || scenario.processError || operation === "EXECUTE_SLICE") {
      assert.equal(receipt.formatRepair, null, scenario.name);
    }
  }
});

test("SDK starts independent invocations fresh while one format repair resumes only its runner and counts usage deltas", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const tmpdir = await temporary(t, "stnl-sdk-repair-");
  const capture = path.join(tmpdir, "calls.jsonl");
  const cli = path.join(tmpdir, "offline-codex.mjs");
  const valid = JSON.stringify(sanitizedValidationResponse());
  const malformed = valid.slice(0, -1);
  await fs.writeFile(cli, '#!' + process.execPath + '\nimport fs from "node:fs";\n'
    + 'const args=process.argv.slice(2), file=process.env.STNL_FAKE_CAPTURE;\n'
    + 'const index=fs.existsSync(file)?fs.readFileSync(file,"utf8").trim().split("\\n").length:0;\n'
    + 'fs.appendFileSync(file,JSON.stringify({args,prompt:fs.readFileSync(0,"utf8")})+"\\n");\n'
    + 'const thread=args.includes("resume")?args.find(arg=>arg.startsWith("sdk-fresh-")):"sdk-fresh-"+index;\n'
    + 'console.log(JSON.stringify({type:"thread.started",thread_id:thread}));\n'
    + 'console.log(JSON.stringify({type:"turn.started"}));\n'
    + 'const responses=' + JSON.stringify([malformed, valid, valid, 'Offline next template.']) + ';\n'
    + 'console.log(JSON.stringify({type:"item.completed",item:{id:"final",type:"agent_message",text:responses[index]}}));\n'
    + 'const counters=' + JSON.stringify([[100, 10, 20], [140, 16, 24], [30, 4, 4], [25, 3, 0]]) + ';\n'
    + 'const [input_tokens,output_tokens,cached_input_tokens]=counters[index];\n'
    + 'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens,output_tokens,cached_input_tokens}}));\n');
  await fs.chmod(cli, 0o755);
  await fs.mkdir(path.join(tmpdir, ".agents/skills"), { recursive: true });
  const env = { CODEX_HOME: tmpdir, HOME: tmpdir, STNL_FAKE_CAPTURE: capture };
  const preflight = { exitCode: 0, operation: "VALIDATE_SLICE", slice: "slice-01", specPath: fixture.requirements,
    legalOperations: [{ operation: "VALIDATE_SLICE", slice: "slice-01" }], mandatoryRecovery: null };
  const usage = createUsageNormalizer({ baseline: ZERO_USAGE, source: "runner" });
  const observations = [];
  const dispatches = [];
  const admissions = [];
  const invoke = (sequence) => invokeIndependentRunner({ snapshot: ROOT, workspace: fixture.root,
    tmpdir, env, operation: "VALIDATE_SLICE", sequence, slice: "slice-01", officialPreflight: preflight,
    prompt: "Independently review this slice; report missing acceptance evidence as BLOCKED.",
    onBeforeTurn: async (input) => admissions.push(Boolean(input.formatRepair)),
    onTurn: async ({ turn }) => observations.push(usage.observe({ threadId: turn.threadId,
      segment: "offline-run", usage: turn.usage })),
    runTurn: (input) => {
      dispatches.push(input);
      return runCodexTurn({ ...input, codexPathOverride: cli });
    } });
  const first = await invoke(1);
  assert.equal(first.status, "RUNNER_RESPONSE_CAPTURED", JSON.stringify({
    error: first.error, processError: first.processError, captureFailure: first.captureFailure,
    formatRepair: first.formatRepair }));
  assert.equal(first.semanticResponseStatus, "BLOCKED", "format repair does not upgrade a verdict");
  assert.equal(first.formatRepair.accepted, true);
  assert.equal(await fs.readFile(first.formatRepair.originalResponseFile, "utf8"), malformed);
  assert.equal(await fs.readFile(first.semanticResponseFile, "utf8"), valid);
  const second = await invoke(2);
  assert.equal(second.status, "RUNNER_RESPONSE_CAPTURED");
  assert.equal(second.formatRepair, null);
  assert.deepEqual(admissions, [false, true, false]);
  assert.deepEqual(dispatches.map((input) => input.threadId), [undefined, "sdk-fresh-0", undefined]);
  assert.equal(dispatches[0].operationId, dispatches[1].operationId);
  assert.notEqual(dispatches[1].operationId, dispatches[2].operationId);
  assert.ok(!dispatches[2].prompt.includes(malformed), "later invocation must not receive prior repair history");
  assert.deepEqual(observations.map((item) => [item.status, item.delta.input, item.delta.output, item.delta.cachedInput]),
    [["attributable", 100, 10, 20], ["attributable", 40, 6, 4], ["attributable", 30, 4, 4]]);
  assert.equal(observations.reduce((total, item) => total + item.delta.total, 0), 190);
  const prompt = "Use stnl-plan-reviewer.\nOPERATION=REVIEW_PLAN\nSPEC_PATH=" + fixture.requirements + "\n";
  const next = await runTemplateTurn({ runCodexTurn }, { env, cwd: fixture.root, prompt, model: "gpt-6-luna",
    effort: "medium", threadId: first.threadId, operationId: "next-template",
    eventsPath: path.join(tmpdir, "next.events.jsonl"), codexPathOverride: cli });
  assert.equal(next.threadId, "sdk-fresh-3");
  const calls = (await fs.readFile(capture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.args.includes("resume")), [false, true, false, false]);
  assert.equal(calls[3].prompt, prompt);
  assert.ok(!calls[3].prompt.includes(malformed));
  for (const input of dispatches) {
    assert.equal(input.cwd, fixture.root);
    assert.equal(input.isolateSkills, true);
  }
});

test("copied Case C subagent response without receipt cannot replay as official validation", async (t) => {
  // The recovered guarantee is receipt-less semantic replay; it no longer
  // depends on the absent local Case C run or certifies the future C oracle.
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture); await implementExample(fixture);
  const valid = await validateExample(fixture, { publish: false });
  const candidate = valid.copy.candidateExecutionRoot;
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, 'COMPLETE');
  const responseFile = path.join(await temporary(t, 'stnl-receiptless-replay-'), 'copied-response.json');
  const original = await fs.readFile(valid.captured.semanticResponseFile);
  await fs.writeFile(responseFile, original);
  assert.deepEqual(await fs.readFile(responseFile), original, 'the response is a genuine complete current result');
  const live = await treeBytes(fixture.execution); const proposed = await treeBytes(candidate);
  await withExampleOwner(valid.admission, async () => {
    await assert.rejects(prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root,
      candidateExecutionRoot: candidate, semanticResponseFile: responseFile }), /origin-bound receipt|receiptFile|receipt file/u);
  });
  assert.deepEqual(await treeBytes(fixture.execution), live);
  assert.deepEqual(await treeBytes(candidate), proposed);
  assert.deepEqual(await fs.readFile(responseFile), original);
});

test("validation publisher accepts its own complete candidate after the materializer rejects it", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  await implementExample(fixture);
  const { admission, copy, captured, prepared } = await validateExample(fixture, { publish: false });
  assert.equal(prepared.formalStatus, 'PASS');
  assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, 'COMPLETE');
  const liveBefore = await treeBytes(fixture.execution), candidateBefore = await treeBytes(copy.candidateExecutionRoot);
  const receiptBefore = await fs.readFile(captured.receiptFile);
  // Current joint preparation requires its own marker; an operational
  // candidate cannot acquire preparation authority through this publisher.
  await assert.rejects(publishPreparationCandidate({
    specPath: fixture.requirements, candidateExecutionRoot: copy.candidateExecutionRoot,
  }), error => {
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.path, copy.candidateExecutionRoot + '.owner.json');
    return true;
  });
  assert.deepEqual(await treeBytes(fixture.execution), liveBefore);
  assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidateBefore);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  const published = await publishValidationCandidate({
    specPath: fixture.requirements, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot, owner: admission.owner,
  });
  assert.equal(published.status, 'PASS');
  assert.equal(published.state, 'COMPLETE');
  assert.equal((await inspectExecutionState(fixture.requirements)).state, 'COMPLETE');
  assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidateBefore, 'publication preserves the prepared candidate');
  const candidateTask = await fs.readFile(path.join(copy.candidateExecutionRoot, 'tasks/slice-01.md'), 'utf8');
  const expectedContinuity = '- Current validation: current\n- Historical PASS: attempt-01\n- History source: ../continuity.json#'
    + admission.owner.deliveryId + '\n- Current action: delivery validated';
  assert.equal(await fs.readFile(path.join(fixture.execution, 'tasks/slice-01.md'), 'utf8'),
    replaceSection(candidateTask, 'Continuity', expectedContinuity),
    'only the trusted publication continuity projection differs; all prepared evidence remains exact');
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, 'tasks.md')),
    await fs.readFile(path.join(copy.candidateExecutionRoot, 'tasks.md')));
  assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBefore);
});

test("validation candidate preparation preserves a new semantic NEEDS_FIX finding for strict ownership validation", async (t) => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  await implementExample(fixture);
  const liveTask = path.join(fixture.execution, 'tasks/slice-01.md');
  const formal = await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING, prepare: false, publish: false });
  const { copy, captured } = formal;
  const candidateRoot = copy.candidateExecutionRoot;
  const candidateTask = path.join(candidateRoot, 'tasks/slice-01.md');
  assert.equal((await fs.readFile(liveTask, 'utf8')).includes('### attempt-01'), false);
  const prepared = await withExampleOwner(formal.admission, () => prepareValidationCandidate({ specPath: fixture.requirements,
    slice: 'slice-01', workspace: fixture.root, candidateExecutionRoot: candidateRoot, ...captured }));
  assert.equal(prepared.formalStatus, 'NEEDS_FIX');
  const published = await publishValidationCandidate({
    specPath: fixture.requirements,
    slice: "slice-01",
    candidateExecutionRoot: candidateRoot, owner: formal.admission.owner,
  });
  assert.equal(published.status, "PASS");
  assert.equal(published.state, "VALIDATION_NEEDS_FIX");
  const taskText = await fs.readFile(candidateTask, "utf8");
  assert.ok(taskText.includes("- Finding references: finding-01"));
  assert.ok(taskText.includes("- Finding dispositions: finding-01=active"));
  assert.match(taskText, /## Effective Validation Base\n\n- none/u);
  assert.match(taskText, /## Final Result\n\n- pending/u);
  assert.equal((await fs.readFile(path.join(candidateRoot, "tasks.md"), "utf8")).includes("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |"), true);
  const readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "VALIDATION_NEEDS_FIX");
  assert.equal(deriveNormalHandoff(readback, "VALIDATE_SLICE")?.operation, "APPLY_FINDINGS");
  assert.equal((await fs.readFile(path.join(fixture.execution, "tasks.md"), "utf8"))
    .includes("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |"), true);
});

test("authorized prepared-test coverage finding follows correction and revalidation without rewriting history or budgets", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  await fs.appendFile(path.join(fixture.requirements, "feature_spec.md"), "\nAC-001 fixture variant: add --priority without a value returns usage/2, preserves existing storage bytes and does not create absent storage; prepare both variants here.\n");
  await renderArtifacts(fixture);
  const testPath = path.join(fixture.root, "test/cli.test.mjs");
  const claim = path.relative(path.join(fixture.execution, "tasks"), testPath).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: path.relative(fixture.execution, testPath).split(path.sep).join("/"), detail: claim, task: claim });
  const reference = await temporary(t, "stnl-coverage-cli-reference-");
  await fs.copyFile(path.join(ROOT, "scripts/fixtures/prioritized-cli.mjs"), path.join(reference, "cli.mjs"));
  await fs.copyFile(path.join(ROOT, "benchmarks/sentinel-todo/seed/src/validation.mjs"), path.join(reference, "validation.mjs"));
  const oldVariants = [{ existing: true, args: ["add", "--priority", "high"] }, { existing: false, args: ["add", "--priority"] }];
  const missingVariant = { existing: true, args: ["add", "--priority"] };
  assert.equal(oldVariants.some((v) => JSON.stringify(v) === JSON.stringify(missingVariant)), false);
  const preparedTests = (variants) => `import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from ${JSON.stringify(pathToFileURL(path.join(reference, "cli.mjs")).href)};
for (const variant of ${JSON.stringify(variants)}) test(JSON.stringify(variant), async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-prepared-priority-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'todos.json');
  const bytes = '{"todos":[{"id":5,"title":"old","completed":false}]}\\n';
  if (variant.existing) await fs.writeFile(file, bytes);
  let stdout = ''; let stderr = '';
  const exit = await runCli(['--store', file, ...variant.args], { stdout: { write: (s) => stdout += s }, stderr: { write: (s) => stderr += s } });
  assert.equal(exit, 2); assert.equal(stdout, ''); assert.match(stderr, /^usage:/);
  if (variant.existing) assert.equal(await fs.readFile(file, 'utf8'), bytes);
  else await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});\n`;
  const target = await writeValidatedPath(fixture, claim, preparedTests(oldVariants));
  const childEnvironment = { ...process.env }; delete childEnvironment.NODE_TEST_CONTEXT;
  const runChecks = (count) => {
    const check = spawnSync(process.execPath, ["--test", target], { cwd: fixture.root, env: childEnvironment, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr + check.stdout);
    assert.match(check.stdout, new RegExp(`# pass ${count}\\b`, "u"));
  };
  runChecks(2); // A passing prepared suite still objectively omits one required variant.
  const evidenceFor = async (record) => record.replaceAll("../../src/example.txt", claim)
    .replaceAll(VALIDATED_HASH, createHash("sha256").update(await fs.readFile(target)).digest("hex"));
  const initialEvidence = await evidenceFor(checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  await editTask(fixture, (text) => replaceSection(replaceSection(replaceSection(text.replace("- [ ] 1.1", "- [x] 1.1"),
    "Changed Areas", `- \`${claim}\``), "Implementation Test Evidence", initialEvidence), "Diff Summary", "- Prepared invalid-argument checks preserve storage; formal review checks required variant coverage."));
  const response = { ...sanitizedValidationResponse("NEEDS_FIX"), findingReferences: "finding-01", findingDispositions: "finding-01=active",
    evidence: "AC-001: existing-storage add --priority missing-value variant is omitted from the executor-prepared matrix in approved test/cli.test.mjs; absent storage is covered. No functional CLI defect is claimed.", blockers: "none" };
  const captured = await capturedCommandEvidence(t, fixture, "VALIDATE_SLICE", JSON.stringify(response), "STNL_VERIFICATION_COMMAND=1 node --test test/cli.test.mjs");
  const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent: await temporary(t) });
  const finding = ACTIVE_FINDING.replace("Observable behavior is wrong.", "Required existing-storage missing-priority test variant is omitted.")
    .replace("Focused validation reproduced the mismatch.", response.evidence).replace("AC-001 is not satisfied.", "Required byte-preservation evidence is incomplete.")
    .replace("Produce the required behavior.", `Add the missing variant and byte-preservation assertions only in ${claim}.`);
  const candidateTask = path.join(copy.candidateExecutionRoot, "tasks/slice-01.md");
  await fs.writeFile(candidateTask, replaceSection(await fs.readFile(candidateTask, "utf8"), "Validation Findings", finding));
  assert.equal((await prepareValidationCandidate({ specPath: fixture.requirements, slice: "1", workspace: fixture.root,
    candidateExecutionRoot: copy.candidateExecutionRoot, ...captured })).formalStatus, "NEEDS_FIX");
  await publishValidationCandidate({ specPath: fixture.requirements, slice: "1", candidateExecutionRoot: copy.candidateExecutionRoot });
  const readback = (state) => ({ execution: state, executionRaw: state, product: { deriveNormalHandoff } });
  const needsFix = await inspectExecutionState(fixture.requirements);
  const outcome = guardOperationProvenance(decideOutcome("VALIDATE_SLICE", readback(needsFix), true), "VALIDATE_SLICE", [], 1);
  assert.deepEqual(outcome, { result: "NEEDS_FIX", blocker: null });
  assert.deepEqual(nextHandoff("VALIDATE_SLICE", readback(needsFix)), { operation: "APPLY_FINDINGS", slice: "slice-01" });
  assert.equal(recoverableOfficialHandoff({ outcome, readback: readback(needsFix) }), null, "normal findings do not start a blocked-recovery loop");
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1"));
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const priorTask = await fs.readFile(liveTask, "utf8");
  const priorAttempt = priorTask.match(/### attempt-01\n[\s\S]*?(?=\n## |$)/u)[0].trim();
  await fs.writeFile(target, preparedTests([...oldVariants, missingVariant]));
  runChecks(3);
  const correctionEvidence = await evidenceFor(checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" }));
  const unauthorized = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  const unauthorizedTask = await fs.readFile(unauthorized.candidateTaskArtifact, "utf8");
  await fs.writeFile(unauthorized.candidateTaskArtifact, replaceSection(replaceSection(unauthorizedTask,
    "Corrections Applied", `- \`${claim.replace("cli.test.mjs", "unplanned.test.mjs")}\``), "Findings Test Evidence", correctionEvidence));
  await assert.rejects(publishExecutionCopy({ specPath: fixture.requirements, slice: "slice-01", candidateRoot: unauthorized.candidateRoot }));
  assert.equal(await fs.readFile(liveTask, "utf8"), priorTask, "rejected correction cannot mutate live authority or finding history");
  const corrected = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  const correctionTask = await fs.readFile(corrected.candidateTaskArtifact, "utf8");
  await fs.writeFile(corrected.candidateTaskArtifact, replaceSection(replaceSection(correctionTask, "Corrections Applied", `- \`${claim}\``), "Findings Test Evidence", correctionEvidence));
  await publishExecutionCopy({ specPath: fixture.requirements, slice: "slice-01", candidateRoot: corrected.candidateRoot });
  const findingsCorrected = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  assert.deepEqual(nextHandoff("APPLY_FINDINGS", readback(findingsCorrected)), { operation: "VALIDATE_SLICE", slice: "slice-01" });
  assert.deepEqual(findingsCorrected.activeFindings, ["slice-01:finding-01"], "auxiliary PASS cannot resolve the finding");
  const pass = { ...response, status: "PASS", findingDispositions: "finding-01=resolved", evidence: "Prepared checks now execute both required storage variants and confirm exact bytes/no creation." };
  const passCaptured = await capturedCommandEvidence(t, fixture, "VALIDATE_SLICE", JSON.stringify(pass), "STNL_VERIFICATION_COMMAND=1 node --test test/cli.test.mjs");
  const passCopy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent: await temporary(t) });
  const passTask = path.join(passCopy.candidateExecutionRoot, "tasks/slice-01.md");
  await fs.writeFile(passTask, replaceSection(await fs.readFile(passTask, "utf8"), "Validation Findings", `${finding.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 verified the missing variant.`));
  await prepareValidationCandidate({ specPath: fixture.requirements, slice: "1", workspace: fixture.root, candidateExecutionRoot: passCopy.candidateExecutionRoot, ...passCaptured });
  await publishValidationCandidate({ specPath: fixture.requirements, slice: "1", candidateExecutionRoot: passCopy.candidateExecutionRoot });
  const terminal = await inspectExecutionState(fixture.requirements);
  assert.equal(terminal.state, "COMPLETE");
  assert.deepEqual(nextHandoff("VALIDATE_SLICE", readback(terminal)), { operation: "SPEC_CLOSE", slice: null });
  const finalTask = await fs.readFile(liveTask, "utf8");
  assert.ok(finalTask.includes(priorAttempt)); assert.ok(finalTask.includes(initialEvidence));
  assert.match(finalTask, /### attempt-02[\s\S]*Type: revalidation/u);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1"));
  const budgets = JSON.parse(await fs.readFile(path.join(ROOT, "benchmarks/sentinel-todo/benchmark.json"), "utf8")).cases.find((c) => c.id === "B").budgets;
  const events = ["VALIDATE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"].map((operation) => ({ operation, slice: "slice-01" }));
  assert.equal(budgetViolation(events, budgets), null);
  assert.equal(budgetViolation(Array.from({ length: budgets.maxApplyFindingsPerSlice + 1 }, () => events[1]), budgets).budget, "maxApplyFindingsPerSlice");
});

test("validation publisher persists a strictly validated runner delegation blocker", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  await implementExample(fixture);
  const admission = await beginExample(fixture, 'VALIDATE_SLICE');
  await withExampleOwner(admission, async () => {
    const captured = await captureExample(fixture, 'VALIDATE_SLICE', { status: 'PASS', head: '' }, { admission });
    const parent = await temporary(t, 'stnl-owned-validation-blocker-');
    const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateParent: parent, owner: admission.owner });
    const task = path.join(copy.candidateExecutionRoot, 'tasks/slice-01.md');
    const official = await treeBytes(fixture.execution);
    const prepared = await prepareValidationCandidate({
      specPath: fixture.requirements, slice: 'slice-01', workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...captured,
    });
    assert.equal(prepared.status, 'RUNNER_RESULT_BLOCKED');
    const before = await fs.readFile(task, 'utf8'), candidateBefore = await treeBytes(copy.candidateExecutionRoot);
    const receiptBefore = await fs.readFile(captured.receiptFile);
    const strict = await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot);
    assert.equal(strict.state, 'RUNNER_RESULT_BLOCKED');
    assert.equal(strict.mandatoryRecovery.operation, 'VALIDATE_SLICE');
    assert.doesNotMatch(before, /^### attempt-/mu);
    assert.deepEqual(await treeBytes(fixture.execution), official);
    await assert.rejects(publishValidationCandidate({
      specPath: fixture.requirements, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot,
      owner: admission.owner, expectedActivationId: randomUUID(),
    }), /validation CAS token differs/u);
    assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidateBefore);
    assert.deepEqual(await treeBytes(fixture.execution), official);
    const published = await publishValidationCandidate({
      specPath: fixture.requirements, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot, owner: admission.owner,
    });
    assert.equal(published.status, 'PASS');
    assert.equal(published.state, 'RUNNER_RESULT_BLOCKED');
    const readback = await inspectExecutionState(fixture.requirements);
    assert.equal(readback.state, 'RUNNER_RESULT_BLOCKED');
    assert.equal(readback.mandatoryRecovery.operation, 'VALIDATE_SLICE');
    assert.equal(readback.tasks.get('slice-01').attempts.length, 0);
    assert.equal(await fs.readFile(path.join(fixture.execution, 'tasks/slice-01.md'), 'utf8'), before);
    assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidateBefore);
    assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBefore);
  });
});

test("formal validation output round-trips through NEEDS_FIX, correction, PASS, base, final, and handoff", async (t) => {
  const runnerContract = await fs.readFile(path.join(ROOT, "agents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  for (const fieldName of ["return one raw JSON object with exactly the lowerCamelCase semantic keys", '"status": "PASS | NEEDS_FIX | BLOCKED"', '"head": "<semantic value>"', '"commands": [{"command": "<full command>", "exit": 0}]', '"findingReferences": "<semantic value>"', '"findingDispositions": "<semantic value>"']) {
    assert.ok(runnerContract.includes(fieldName), fieldName);
  }
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  fixture.exampleImplementation = await implementExample(fixture);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const initialFormal = await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  const needsFix = await inspectExecutionState(fixture.requirements);
  assert.equal(needsFix.state, "VALIDATION_NEEDS_FIX");
  const needsFixHandoff = deriveNormalHandoff(needsFix, "VALIDATE_SLICE");
  assert.equal(needsFixHandoff.operation, "APPLY_FINDINGS");
  assert.equal(needsFixHandoff.slice, "slice-01");

  await correctExample(fixture, { content: VALIDATED_CONTENT });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "FINDINGS_CORRECTED");

  const resolved = ACTIVE_FINDING.replace('State: active', 'State: resolved') + '\n- Resolution: attempt-02 confirmed the correction.';
  await validateExample(fixture, { findings: resolved, dispositions: 'finding-01=resolved' });

  const complete = await inspectExecutionState(fixture.requirements);
  assert.equal(complete.state, "COMPLETE");
  assert.equal(complete.tasks.get('slice-01').attempts[0].status, 'NEEDS_FIX');
  assert.ok(complete.tasks.get('slice-01').sections.get('Implementation Test Evidence').includes(fixture.exampleImplementation.bundle));
  assert.equal(JSON.parse(await fs.readFile(initialFormal.captured.receiptFile)).semanticResponseStatus, 'NEEDS_FIX');
  assert.equal(complete.tasks.get("slice-01").base.present, true);
  assert.equal(complete.tasks.get("slice-01").base.paths[0], path.relative(path.join(fixture.execution, "tasks"), path.join(fixture.root, "src/example.txt")).split(path.sep).join("/"));
  assert.equal(complete.tasks.get("slice-01").final.result, "PASS");
  assert.equal(deriveNormalHandoff(complete, "VALIDATE_SLICE"), null);
  assert.deepEqual(complete.legalOperations, [{ operation: "REPLAN", slice: null }]);
});

test("an intermediate PASS hands off to the next serial execution frontier", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await passFirstSlice(fixture);
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, "EXECUTION_STARTED");
  assert.deepEqual(deriveNormalHandoff(state, "VALIDATE_SLICE"), {
    workflowSkill: "stnl-slice-executor",
    operation: "EXECUTE_SLICE",
    invocation: "OPERATION=EXECUTE_SLICE",
    slice: "slice-02",
  });
});

test("real joint templates round-trip through independent review and direct execution handoff", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture, { planStatus: "draft" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");
  for (const file of ["tasks.md", "tasks/slice-01.md"]) assert.ok((await fs.stat(path.join(fixture.execution, file))).isFile());
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"), /not legal/u);
  const review = await preparePreparationCandidate({ specPath: fixture.requirements, operation: "REVIEW_PLAN" });
  for (const file of ["plan.md", "plans/slice-01.md", "tasks.md", "tasks/slice-01.md"]) {
    const target = path.join(review.candidateExecutionRoot, file);
    await fs.writeFile(target, headerReady(await fs.readFile(target, "utf8")));
  }
  await publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: review.candidateExecutionRoot, reviewDecision });
  const activated = await inspectExecutionState(fixture.requirements);
  assert.equal(activated.state, "MATERIALIZED_PRISTINE");
  assert.deepEqual(deriveNormalHandoff(activated, "REVIEW_PLAN"), {
    workflowSkill: "stnl-slice-executor", operation: "EXECUTE_SLICE", invocation: "OPERATION=EXECUTE_SLICE", slice: "slice-01",
  });
});

test("distributed execution schemas and runtime agree on corrected semantic boundaries", async (t) => {
  const schemaPaths = [
    "stnl-slice-executor", "stnl-slice-quality-manager", "stnl-execution-planner",
  ].map((skill) => path.join(ROOT, `skills/workflows/${skill}/references/execution-record-schema.md`));
  const schemas = await Promise.all(schemaPaths.map((schemaPath) => fs.readFile(schemaPath, "utf8")));
  for (const schema of schemas.slice(1)) assert.equal(schema, schemas[0]);
  for (const rule of [
    /Scalar summaries are compact opaque inline values/u,
    /`Finding IDs` is one non-empty lexicographically ordered set/u,
    /exact `Tested state: none`[\s\S]{0,120}`Fileless reason`/u,
    /exact historical pair `Check discovery sources` \/ `Check discovery actions`/u,
    /At most one current base exists and it originates from the current `PASS` attempt/u,
    /`Finding references` uses exact `none` or `finding-NN, finding-NN`/u,
    /`Finding dispositions` uses exact `none` or `finding-NN=(?:active\|resolved\|superseded), finding-NN=(?:active\|resolved\|superseded)`/u,
    /`Findings verified` is exact `none` or a canonical subset of `Finding IDs`/u,
    /`Unsupported active findings` is deterministically every active finding at the named cycle not present in `Findings verified`/u,
    /In EXECUTE_SLICE it records the current-round code delta; `Corrections Applied` preserves the cumulative historical paths/u,
    /Exact `none` is permitted for a fileless correction, or for an EXECUTE_SLICE round whose file-backed Tested state paths and digests exactly match the preceding failed round/u,
    /In `TESTS_PASS`, exact `none` is forbidden specifically for `Tested scope`, `Verification types considered`, `Selected checks`, and `Coverage`/u,
    /Candidate validation rejects terminal implementation evidence with an incomplete checklist/u,
    /exactly one mandatory target, `stnl-slice-executor \/ EXECUTE_SLICE \/ <affected slice>`/u,
    /A PASS seals its validation cycle\. Another attempt requires a runtime-owned reopening/u,
  ]) assert.match(schemas[0], rule);

  const accepted = await standaloneWorkspace(t);
  await renderArtifacts(accepted);
  const implementation = await implementExample(accepted, { publish: false });
  assert.equal((await rejectTaskMutations(accepted, implementation.copy, [
    ['nested Tested scope', text => text.replace(/^- Tested scope:.*$/mu, '- Tested scope:\n  - ../../src/example.txt'), /Tested scope|unexpected nested/u],
  ])).state, 'IMPLEMENTED_AWAITING_VALIDATION');
});

test("execution producer serializes automatic correction fields and excludes findings-only labels", async t => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  const first = await implementExample(fixture, { failFirst: true, publish: false });
  const second = await retryExample(fixture, first, VALIDATED_CONTENT, { publish: false, insert: false });
  const taskArtifact = first.copy.candidateTaskArtifact;
  const claim = path.relative(path.join(fixture.execution, 'tasks'), path.join(fixture.root, 'src/example.txt')).split(path.sep).join('/');
  const consume = (captured = second.captured) => serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', response: JSON.stringify(second.response), workspace: fixture.root, taskArtifact, ...captured });
  assert.equal(await consume(), second.bundle);
  assert.deepEqual(parseSemanticExecutionPayload(JSON.stringify(second.response), 'EXECUTE_SLICE'), second.response);
  assert.throws(() => parseSemanticExecutionPayload(JSON.stringify({ ...second.response, correctionsCovered: claim }), 'EXECUTE_SLICE'), /unknown semantic execution payload field: correctionsCovered/);
  const missingRound = { ...second.response }; delete missingRound.automaticCheckRound;
  assert.throws(() => parseSemanticExecutionPayload(JSON.stringify(missingRound), 'EXECUTE_SLICE'), /Automatic check round is invalid/);
  await assert.rejects(consume({ automaticCheckRound: '2/3' }), /native runner requires origin-bound receipt and response/);
  for (const [label, value] of [['Automatic check round', '2/3'], ['Prior-round failure', second.response.priorRoundFailure],
    ['Correction applied', second.response.correctionApplied], ['Correction paths', claim], ['Updated scope', claim], ['In-slice rationale', second.response.inSliceRationale]]) assert.ok(second.bundle.includes('- ' + label + ': ' + value), label);
  assert.doesNotMatch(second.bundle, /Corrections covered:/);
  const original = await fs.readFile(taskArtifact, 'utf8'), live = await treeBytes(fixture.execution), receipt = await fs.readFile(second.captured.receiptFile);
  await fs.writeFile(path.join(fixture.root, 'src/other.txt'), 'unrelated existing bytes\n');
  for (const [name, mutated, expected] of [
    ['missing prior failure', replaceSection(original, 'Implementation Test Evidence', '- none'), /requires prior implementation-check-1\/3 evidence/],
    ['unrelated correction', replaceSection(original, 'Corrections Applied', '- `../../src/other.txt`'), /Corrections Applied does not match mechanically derived correction paths/],
  ]) {
    assert.notEqual(mutated, original, name); await fs.writeFile(taskArtifact, mutated);
    await assert.rejects(consume(), expected);
    assert.equal(await fs.readFile(taskArtifact, 'utf8'), mutated);
    assert.deepEqual(await treeBytes(fixture.execution), live); assert.deepEqual(await fs.readFile(second.captured.receiptFile), receipt);
    await fs.writeFile(taskArtifact, original);
  }
  assert.equal(await consume(), second.bundle);
  await insertExecutionEvidenceInCandidate({ taskArtifact, operation: 'EXECUTE_SLICE', bundle: second.bundle,
    validateProspectiveTask: text => validateExecutionCandidate(fixture.requirements, first.copy.candidateExecutionRoot, [text]) });
  assert.equal((await validateExecutionCandidate(fixture.requirements, first.copy.candidateExecutionRoot)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  assert.ok((await fs.readFile(taskArtifact, 'utf8')).includes(first.bundle));
  assert.deepEqual(await treeBytes(fixture.execution), live);
});


test("round-two correction is inserted into an owned candidate and passes strict validation", async t => {
  for (const missingCorrection of [false, true]) {
    const f = await standaloneWorkspace(t); await renderArtifacts(f);
    const first = await implementExample(f, { failFirst: true, publish: false });
    const live = await treeBytes(f.execution), firstReceipt = await fs.readFile(first.captured.receiptFile);
    const next = await startNativeRunnerCapture({ specPath: f.requirements, owner: first.admission.owner,
      workspace: f.root, captureParent: f.root, candidateTaskArtifact: first.copy.candidateTaskArtifact });
    const agentId = 'round-two-' + randomUUID(); await bindNativeRunnerIdentity({ ...next, agentId });
    await fs.writeFile(path.join(f.root, 'src/example.txt'), VALIDATED_CONTENT);
    const response = { ...first.response, status: 'TESTS_PASS', automaticCheckRound: '2/3',
      commands: next.verification.checks.map(check => ({ command: verificationCommand(check), exit: 0 })),
      failures: 'none', priorRoundFailure: first.response.failures,
      correctionApplied: missingCorrection ? 'none' : 'Corrected the approved example bytes while retaining the prepared assertion',
      inSliceRationale: 'Same AC-001 and authorized example path', evidenceOrFailureSummary: 'The unchanged prepared assertion now passes' };
    const captured = await captureNativeExample({ ...next, agentId }, response, ['../../src/example.txt']);
    const receiptBytes = await fs.readFile(captured.receiptFile), responseBytes = await fs.readFile(captured.semanticResponseFile);
    assert.equal(JSON.parse(receiptBytes).verification.checks[0].exit, 0);
    const candidateBefore = await fs.readFile(first.copy.candidateTaskArtifact, 'utf8');
    assert.ok(candidateBefore.includes(first.bundle)); assert.doesNotMatch(candidateBefore, /^### implementation-check-02$/mu);
    const environment = { ...process.env, STNL_OPERATION_OWNER_FILE: first.admission.ownerFile }; delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs'),
      '--execution-bundle', '--operation', 'EXECUTE_SLICE', '--workspace', f.root,
      '--task-artifact', first.copy.candidateTaskArtifact, '--semantic-response-file', captured.semanticResponseFile,
      '--receipt-file', captured.receiptFile, '--insert-candidate'], { cwd: f.root, env: environment, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const text = await fs.readFile(first.copy.candidateTaskArtifact, 'utf8');
    assert.ok(text.includes(first.bundle), 'the first private failed check remains exact');
    if (missingCorrection) {
      assert.equal(JSON.parse(result.stdout).state, 'RUNNER_RESULT_BLOCKED');
      assert.match(text, /- Kind: malformed-output/); assert.match(text, /correctionApplied is required/);
      assert.doesNotMatch(text, /^### implementation-check-02$/mu);
      assert.equal((await validateExecutionCandidate(f.requirements, first.copy.candidateExecutionRoot)).state, 'RUNNER_RESULT_BLOCKED');
    } else {
      assert.match(result.stdout, /implementation-check-02 inserted into isolated candidate/);
      assert.match(text, /## Corrections Applied\n\n- `\.\.\/\.\.\/src\/example.txt`/);
      assert.match(text, /- Correction paths: \.\.\/\.\.\/src\/example.txt/);
      assert.equal((await validateExecutionCandidate(f.requirements, first.copy.candidateExecutionRoot)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
    }
    assert.deepEqual(await treeBytes(f.execution), live);
    assert.deepEqual(await fs.readFile(first.captured.receiptFile), firstReceipt);
    assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBytes); assert.deepEqual(await fs.readFile(captured.semanticResponseFile), responseBytes);
  }
});



test("draft joint REPLAN replaces paired authority and returns through review directly to execution", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture, { materialized: false, planStatus: "draft" });
  const initial = await inspectExecutionState(fixture.requirements);
  assert.equal(initial.state, "PLANNED_DRAFT");
  assertRecoveryTarget(initial, { operation: "REPLAN", slice: null, owner: "planning-authority" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "PLANNED_DRAFT");

  await replacePlanningOnly(fixture, authority, authority);
  const replacement = await inspectExecutionState(fixture.requirements);
  assert.equal(replacement.state, "PENDING_REPLAN_DRAFT");
  assert.equal(replacement.globalPlan.revision, 2);
  assert.equal(replacement.globalPlan.revisionMode, "pristine-replacement");
  assert.deepEqual(replacement.globalPlan.supersessionMappings, []);
  assert.ok((await fs.stat(path.join(fixture.execution, "tasks.md"))).isFile());
  assert.equal(replacement.tasks.get("slice-01").revision, 2);
  const replacementReadback = { execution: replacement, executionRaw: replacement,
    product: { deriveNormalHandoff } };
  assert.deepEqual(decideOutcome("REPLAN", replacementReadback, true), { result: "PASS", blocker: null });
  assert.deepEqual(nextHandoff("REPLAN", replacementReadback), { operation: "REVIEW_PLAN", slice: null });
  assert.deepEqual(decideOutcome("REPLAN", replacementReadback, false),
    { result: "BLOCKED", blocker: "SDK_TURN_FAILED" });

  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await reviewJointFixture(fixture);
  const current = await inspectExecutionState(fixture.requirements);
  assert.equal(current.state, "MATERIALIZED_PRISTINE");
  assert.equal(current.normalHandoff.operation, 'EXECUTE_SLICE');
  for (const retired of ['MATERIALIZE_TASKS', 'REVIEW_TASKS']) await assert.rejects(preflightExecutionOperation(fixture.requirements, retired), /unsupported operation/u);
});

test("joint reviewed preparation made stale before execution replans through the real offline manager", { timeout: 90_000 }, async (t) => {
  const controls = await nestedLifecycleWorkspace(t);
  await fs.appendFile(path.join(controls.requirements, "shared/requirements.md"), "\nDocumentary context changed after joint review.\n");
  const stale = await inspectExecutionState(controls.requirements);
  assert.equal(stale.state, "REQUIREMENTS_CHANGED");
  const budgets = JSON.parse(await fs.readFile(path.join(ROOT, "benchmarks/sentinel-todo/benchmark.json"))).cases.find(c => c.id === "A").budgets;
  const readback = { lifecycle: { status: "ready" }, execution: stale, executionRaw: stale };
  const outcome = decideOutcome("REVIEW_PLAN", readback, true);
  const history = [{ operation: "REVIEW_PLAN", slice: null, outcome }];
  const historyBefore = JSON.stringify(history), executionBefore = await treeBytes(controls.execution);
  const product = { validateWorkspace: validateLifecycleWorkspace, inspectExecutionState, preflightExecutionOperation };
  const recoveryInput = { operation: "REVIEW_PLAN", slice: null, outcome, readback, priorOperations: history, remainingTurns: 1,
    budgets, product, specPath: controls.requirements };
  const recovery = await prepareOfficialRecovery(recoveryInput);
  assert.equal(recovery.operation, "REPLAN");
  assert.equal(recovery.authority, stale.currentFingerprint);
  assert.equal(JSON.stringify(history), historyBefore);
  assert.deepEqual(await treeBytes(controls.execution), executionBefore);
  assert.equal(await prepareOfficialRecovery({ ...recoveryInput, remainingTurns: 0 }), null);
  assert.equal(await prepareOfficialRecovery({ ...recoveryInput, transportFailed: true }), null);
  assert.equal(await prepareOfficialRecovery({ ...recoveryInput, priorOperations: [...history, { operation: "REPLAN", outcome: { result: "PASS" } }] }), null);
  const denied = Object.assign(new Error("controlled preflight denied"), { code: "EACCES" });
  await assert.rejects(prepareOfficialRecovery({ ...recoveryInput, product: { ...product, preflightExecutionOperation: async () => { throw denied; } } }), { code: "EACCES" });
  await fs.appendFile(path.join(controls.requirements, "shared/requirements.md"), "\nAuthority changed again before recovery.\n");
  assert.equal(await prepareOfficialRecovery(recoveryInput), null);
  assert.equal(JSON.stringify(history), historyBefore);
  assert.deepEqual(await treeBytes(controls.execution), executionBefore);
  const fixture = await createOfflineCheckout(t, ROOT, "stale-joint-review");
  const result = await spawnResult(process.execPath, ["benchmarks/sentinel-todo/runtime/benchmark-manager.mjs", "run", "--case", "A"],
    { cwd: fixture.root, env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  await fs.writeFile(path.join(fixture.root, ".offline-stale-review.log"), result.stdout + "\n" + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const context = JSON.parse(await fs.readFile(path.join(fixture.root, ".offline-context.json")));
  assert.equal(context.mode, "OFFLINE_TEST_ONLY");
  const runIds = (await fs.readdir(path.join(fixture.root, "benchmark-temp"))).filter(name => name.startsWith("run-"));
  assert.equal(runIds.length, 1);
  const runRoot = path.join(fixture.root, "benchmark-temp", runIds[0]);
  assert.equal(JSON.parse(await fs.readFile(path.join(runRoot, "summary.json"))).status, "PASS");
  const snapshot = JSON.parse(await fs.readFile(path.join(runRoot, "snapshot.json")));
  assert.equal(snapshot.externalSdk.mode, "shared-readonly");
  await assert.rejects(fs.lstat(path.join(runRoot, "snapshot/agents/codex/node_modules")), { code: "ENOENT" });
  const state = JSON.parse(await fs.readFile(path.join(runRoot, "case-a/case-state.json")));
  const journal = JSON.parse(await fs.readFile(state.journal));
  assert.deepEqual(journal.events.map(e => e.operation), ["SPEC_INIT", "PLAN", "REVIEW_PLAN", "REPLAN", "REVIEW_PLAN", "EXECUTE_SLICE", "VALIDATE_SLICE", "SPEC_CLOSE"]);
  assert.equal(journal.events[2].result, "BLOCKED");
  assert.equal(journal.events[2].resultingState, "REQUIREMENTS_CHANGED");
  assert.equal(journal.events[3].result, "PASS");
  assert.equal(state.operations[2].outcome.result, "BLOCKED");
  assert.equal(state.operations[3].recovery.operation, "REPLAN");
  assert.equal(journal.events.filter(e => e.operation === "REPLAN").length, 1);
  const calls = (await fs.readFile(path.join(fixture.root, ".offline-calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.length > 0 && calls.every(c => c.externalCalls === 0));
  assert.equal(calls.filter(c => c.independent).length, 2);
  const configuration = JSON.parse(await fs.readFile(path.join(fixture.root, "benchmarks/sentinel-todo/benchmark.json")));
  assert.deepEqual((await budgetSnapshot(runRoot)).turnBudget, { limit: configuration.turnBudget.maxTurnsPerRun,
    consumed: 10, remaining: configuration.turnBudget.maxTurnsPerRun - 10, mainTurns: 8, runnerTurns: 2 });
  const specPath = path.join(runRoot, "case-a/workspace/specs/benchmark-case-a");
  const completed = await inspectExecutionState(specPath);
  assert.equal(completed.state, "COMPLETE");
  assert.equal(validateLifecycleWorkspace(specPath).closed, true);
  assert.equal(await prepareOfficialRecovery({ ...recoveryInput, specPath, readback: { lifecycle: { status: "ready" }, execution: completed, executionRaw: completed } }), null);
  assert.equal(JSON.parse(await fs.readFile(state.finalizer.rawPath)).status, "PASS");
  t.diagnostic(JSON.stringify({ externalCalls: 0, sdkMode: snapshot.externalSdk.mode,
    operations: journal.events.map(e => ({ operation: e.operation, result: e.result })), runnerCalls: 2 }));
});

test("planning-only replacement rejects historical REPLAN fields and obsolete competing plans", async t => {
  // PLAN produces a joint draft. Recovery fields cannot turn revision 1 into
  // a pristine replacement, and an unlisted detailed Plan has no authority.
  const f = await standaloneWorkspace(t); await renderArtifacts(f, { planStatus: 'draft' });
  const consume = () => inspectExecutionState(f.requirements);
  assert.equal((await consume()).state, 'PLANNED_DRAFT');
  const plan = path.join(f.execution, 'plan.md'), original = await fs.readFile(plan, 'utf8');
  const historical = original.replace('- Objective: Deliver observable behavior',
    '- Revision mode: pristine-replacement\n- Replan reason: invalid revision-one replacement\n- Supersedes open slices: none\n- Objective: Deliver observable behavior');
  assert.notEqual(historical, original); await fs.writeFile(plan, historical);
  const invalid = await treeBytes(f.execution);
  await assert.rejects(consume(), /pristine joint replacement has invalid revision or retained execution history/);
  assert.deepEqual(await treeBytes(f.execution), invalid);
  await fs.writeFile(plan, original); assert.equal((await consume()).state, 'PLANNED_DRAFT');
  assert.equal((await projectPreparationAuthorityFrom(f.execution)).preparationRevision, 1);
  const stale = path.join(f.execution, 'plans/slice-02.md');
  await fs.writeFile(stale, (await fs.readFile(path.join(f.execution, 'plans/slice-01.md'), 'utf8'))
    .replaceAll('Slice 01', 'Slice 02').replaceAll('- Slice: 01', '- Slice: 02'));
  const extra = await treeBytes(f.execution);
  await assert.rejects(projectPreparationAuthorityFrom(f.execution), /artifact manifest does not match serial slices/);
  await assert.rejects(consume(), error => {
    assert.match(error.message, /execution layout contains non-canonical paths:/);
    assert.deepEqual(error.findings, [path.join(f.execution, 'tasks/slice-02.md')]);
    return true;
  });
  assert.deepEqual(await treeBytes(f.execution), extra);
  await fs.unlink(stale); assert.equal((await consume()).state, 'PLANNED_DRAFT');
  assert.equal(await fs.readFile(plan, 'utf8'), original);
});


test("pending REPLAN requires canonical fields, one revision increment, and valid supersession mappings", async t => {
  // Current joint append mappings/reasons/continuity are covered by the named
  // publication guards; mixed review states by preparation's joint review guard.
  // These two controls retain the initial-authority edges of the old contract.
  for (const kind of ['invalid-initial-revision', 'extension-without-history']) {
    const f = await standaloneWorkspace(t);
    await renderArtifacts(f, { planStatus: kind === 'invalid-initial-revision' ? 'draft' : 'ready' });
    const consume = () => inspectExecutionState(f.requirements);
    const expected = kind === 'invalid-initial-revision' ? 'PLANNED_DRAFT' : 'MATERIALIZED_PRISTINE';
    assert.equal((await consume()).state, expected);
    const artifacts = ['plan.md', 'plans/slice-01.md', 'tasks/slice-01.md'];
    const originals = new Map(await Promise.all(artifacts.map(async file => [file, await fs.readFile(path.join(f.execution, file), 'utf8')])));
    if (kind === 'invalid-initial-revision') {
      for (const [file, original] of originals) {
        const mutant = original.replace('Plan revision: 1', 'Plan revision: 4');
        assert.notEqual(mutant, original); await fs.writeFile(path.join(f.execution, file), mutant);
      }
    } else {
      const original = originals.get('plan.md');
      const mutant = original.replace('- Objective: Deliver observable behavior',
        '- Revision mode: append-only-extension\n- Replan reason: Cannot manufacture predecessor history\n- Supersedes open slices: none\n- Objective: Deliver observable behavior');
      assert.notEqual(mutant, original); await fs.writeFile(path.join(f.execution, 'plan.md'), mutant);
    }
    const rejected = await treeBytes(f.execution);
    await assert.rejects(consume(), kind === 'invalid-initial-revision'
      ? /initial materialized plan must use Plan revision 1/
      : /execution publication: current normativeSha256 differs from approved preparation/);
    assert.deepEqual(await treeBytes(f.execution), rejected, 'rejection never repairs or rewrites authority');
    for (const [file, original] of originals) await fs.writeFile(path.join(f.execution, file), original);
    assert.equal((await consume()).state, expected, 'same consumer accepts the restored producer output');
  }
});


test("lifecycle shared-only changes stale planning and deterministic lifecycle CLOSE preserves the fingerprint", async (t) => {
  const readySource = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready");
  const closedSource = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/closed");
  const root = await temporary(t);
  const ready = await copyDirectory(readySource, path.join(root, "ready"));
  const closed = await copyDirectory(closedSource, path.join(root, "closed"));
  const activeHash = await computeRequirementsAuthority(ready);
  assert.equal(await computeRequirementsAuthority(closed), activeHash, "lossless lifecycle CLOSE changed semantic authority");
  const requirement = path.join(ready, "shared/requirements.md");
  await fs.writeFile(requirement, (await fs.readFile(requirement, "utf8")).replace("Expired invitation is rejected", "Expired invitation is rejected with audit"));
  assert.notEqual(await computeRequirementsAuthority(ready), activeHash, "shared-only authority mutation was ignored");
});


test("stale delegation blockers cannot reopen terminal auxiliary phases", async (t) => {
  for (const status of ["TESTS_PASS", "TESTS_NOT_APPLICABLE"]) {
    for (const kind of ["Implementation", "Findings"]) {
      const fixture = await standaloneWorkspace(t);
      await renderArtifacts(fixture);
      const implementation = kind === "Implementation";
      const prefix = implementation ? "implementation-check" : "findings-check";
      await editTask(fixture, (value) => {
        let result = value.replace("- [ ] 1.1", "- [x] 1.1");
        if (!implementation) {
          result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
          result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
        }
        result = replaceSection(result, `${kind} Test Evidence`, checkRecord(prefix, 1, status, 1, { cycle: "attempt-01" }));
        return replaceSection(result, "Delegation Blocker", delegationBlocker(implementation ? "EXECUTE_SLICE" : "APPLY_FINDINGS", "initialization", { after: `${prefix}-01` }));
      });
      await assert.rejects(inspectExecutionState(fixture.requirements), /stale .* Delegation Blocker/u);
    }
  }
});




test("only the first open serial slice may own operational phase", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  const laterPath = path.join(fixture.execution, "tasks/slice-02.md");
  let later = await fs.readFile(laterPath, "utf8");
  later = later.replace("- [ ] 2.1", "- [x] 2.1");
  later = replaceSection(later, "Changed Areas", "- `../../src/example.txt`");
  later = replaceSection(later, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  await fs.writeFile(laterPath, later, "utf8");
  await assert.rejects(inspectExecutionState(fixture.requirements), /contains operational state after the serial frontier slice-01/u);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1"), /contains operational state after the serial frontier slice-01/u);

  const laterPass = await standaloneWorkspace(t);
  await renderArtifacts(laterPass);
  await addSecondPristineSlice(laterPass);
  const laterPassPath = path.join(laterPass.execution, "tasks/slice-02.md");
  let passed = await fs.readFile(laterPassPath, "utf8");
  passed = passed.replace("- [ ] 2.1", "- [x] 2.1");
  passed = replaceSection(passed, "Changed Areas", "- `../../src/example.txt`");
  passed = replaceSection(passed, "Validation Attempts", PASS_ATTEMPT);
  passed = replaceSection(passed, "Effective Validation Base", PASS_BASE);
  passed = publishPassResult(passed);
  await fs.writeFile(laterPassPath, passed, "utf8");
  await editTasksIndex(laterPass, (value) => value.replace(
    "| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |",
    "| [x] | 02 - Later | later result | 01 | tasks/slice-02.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(laterPass.requirements), /contains operational state after the serial frontier slice-01/u);
});

test("incomplete execution finalization is rejected for candidates and live history recovers only through its executor slice", async (t) => {
  const planning = await standaloneWorkspace(t);
  await renderArtifacts(planning, { materialized: false, planStatus: "draft" });
  const planningCandidate = await copyDirectory(planning.execution, path.join(planning.root, "planning-candidate"));
  assert.equal((await validateExecutionCandidate(planning.requirements, planningCandidate)).state, "PLANNED_DRAFT");

  for (const status of ["TESTS_PASS", "TESTS_NOT_APPLICABLE"]) {
    const prevention = await standaloneWorkspace(t);
    await renderArtifacts(prevention);
    const interruptedCandidate = await copyDirectory(
      prevention.execution,
      path.join(prevention.root, `interrupted-before-finalization-${status.toLowerCase()}`),
    );
    const interruptedTask = path.join(interruptedCandidate, "tasks/slice-01.md");
    let interrupted = await fs.readFile(interruptedTask, "utf8");
    interrupted = interrupted.replace("- [ ] 1.1", "- [x] 1.1");
    interrupted = replaceSection(interrupted, "Changed Areas", "- `../../src/example.txt`");
    await fs.writeFile(interruptedTask, interrupted, "utf8");
    const interruptionState = await validateExecutionCandidate(prevention.requirements, interruptedCandidate);
    assert.equal(interruptionState.state, "EXECUTION_STARTED");
    assert.deepEqual(interruptionState.legalOperations, [
      { operation: "REPLAN", slice: null },
      { operation: "EXECUTE_SLICE", slice: "slice-01" },
    ]);

    const invalidCandidate = await copyDirectory(
      prevention.execution,
      path.join(prevention.root, `invalid-finalization-${status.toLowerCase()}`),
    );
    const invalidCandidateTask = path.join(invalidCandidate, "tasks/slice-01.md");
    let invalid = await fs.readFile(invalidCandidateTask, "utf8");
    invalid = replaceSection(invalid, "Changed Areas", "- `../../src/example.txt`");
    invalid = replaceSection(invalid, "Implementation Test Evidence", checkRecord("implementation-check", 1, status, 1));
    await fs.writeFile(invalidCandidateTask, invalid, "utf8");
    await assert.rejects(
      validateExecutionCandidate(prevention.requirements, invalidCandidate),
      /candidate cannot finalize execution for slice-01 while its mandatory checklist is incomplete/u,
    );
    await fs.copyFile(invalidCandidateTask, path.join(prevention.execution, "tasks/slice-01.md"));
    const persistedInconsistency = await inspectExecutionState(prevention.requirements);
    assertRecoveryTarget(persistedInconsistency, {
      operation: "EXECUTE_SLICE",
      slice: "slice-01",
      owner: "stnl-slice-executor",
      record: "implementation-check-01",
      round: 1,
      sameOperationResumeRequired: true,
    });
    await editTask(prevention, (value) => value.replace("- [ ] 1.1", "- [x] 1.1"));
    assert.equal(
      (await preflightExecutionOperation(prevention.requirements, "VALIDATE_SLICE", "1")).state,
      "IMPLEMENTED_AWAITING_VALIDATION",
    );
  }

  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });

  const inconsistent = await inspectExecutionState(fixture.requirements);
  assert.equal(inconsistent.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(inconsistent.legalOperations, [{ operation: "EXECUTE_SLICE", slice: "slice-01" }]);
  assert.equal(inconsistent.normalHandoff, null);
  assert.deepEqual(inconsistent.requiredRecoveryHandoff, null);
  assertRecoveryTarget(inconsistent, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "stnl-slice-executor",
    record: "implementation-check-01",
    round: 1,
    sameOperationResumeRequired: true,
  });

  for (let invocation = 0; invocation < 2; invocation += 1) {
    const resumed = await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1");
    assert.equal(resumed.state, "IMPLEMENTED_AWAITING_VALIDATION");
    assert.equal(resumed.mandatoryRecovery.slice, "slice-01");
  }
  const acceptedCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "EXECUTE_SLICE",
    "1",
  ], { encoding: "utf8" });
  assert.equal(acceptedCli.status, 0, acceptedCli.stderr);
  const acceptedMetadata = JSON.parse(acceptedCli.stdout.split("\n")
    .find((line) => line.startsWith("MANDATORY_RECOVERY: ")).slice("MANDATORY_RECOVERY: ".length));
  assert.deepEqual(acceptedMetadata, inconsistent.mandatoryRecovery);
  for (const [operation, slice] of [["EXECUTE_SLICE", "2"], ["VALIDATE_SLICE", "1"], ["REPLAN", null]]) {
    const rejected = await rejectedWithRecovery(
      preflightExecutionOperation(fixture.requirements, operation, slice),
      /legal next operation is EXECUTE_SLICE for slice-01/u,
    );
    assertRecoveryTarget(rejected, {
      operation: "EXECUTE_SLICE",
      slice: "slice-01",
      owner: "stnl-slice-executor",
      record: "implementation-check-01",
      round: 1,
      sameOperationResumeRequired: true,
    });
  }
  const unsupported = await rejectedWithRecovery(
    preflightExecutionOperation(fixture.requirements, "RESUME_SLICE", "1"),
    /unsupported operation RESUME_SLICE; legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  assertRecoveryTarget(unsupported, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "stnl-slice-executor",
  });
  const rejectedCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "VALIDATE_SLICE",
    "1",
  ], { encoding: "utf8" });
  assert.equal(rejectedCli.status, 1);
  const rejectedMetadata = JSON.parse(rejectedCli.stderr.split("\n")
    .find((line) => line.startsWith("RECOVERY_TARGETS: ")).slice("RECOVERY_TARGETS: ".length));
  assert.deepEqual(rejectedMetadata, inconsistent.recoveryTargets);

  const recoveredCandidate = await copyDirectory(fixture.execution, path.join(fixture.root, "recovered-candidate"));
  const recoveredCandidateTask = path.join(recoveredCandidate, "tasks/slice-01.md");
  await fs.writeFile(
    recoveredCandidateTask,
    (await fs.readFile(recoveredCandidateTask, "utf8")).replace("- [ ] 1.1", "- [x] 1.1"),
    "utf8",
  );
  const recoveredCandidateState = await validateExecutionCandidate(fixture.requirements, recoveredCandidate);
  assert.equal(recoveredCandidateState.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(recoveredCandidateState.mandatoryRecovery, null);
  await fs.copyFile(recoveredCandidateTask, path.join(fixture.execution, "tasks/slice-01.md"));

  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(recovered.mandatoryRecovery, null);
  assertRecoveryTarget(recovered, {
    operation: "VALIDATE_SLICE",
    slice: "slice-01",
    owner: "implementation-check",
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await assert.rejects(
    preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"),
    /legal next operations are VALIDATE_SLICE for slice-01 or REPLAN/u,
  );
});

test("incomplete checklist recovery overrides only validation-bound implementation retry and delegation states", async (t) => {
  const exhausted = await standaloneWorkspace(t);
  await renderArtifacts(exhausted);
  await editTask(exhausted, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    return replaceSection(
      result,
      "Implementation Test Evidence",
      [1, 2, 3].map((round) => checkRecord("implementation-check", round, "TESTS_FAIL", round)).join("\n\n"),
    );
  });
  const exhaustedCandidate = await copyDirectory(exhausted.execution, path.join(exhausted.root, "exhausted-invalid-candidate"));
  await assert.rejects(
    validateExecutionCandidate(exhausted.requirements, exhaustedCandidate),
    /candidate cannot finalize execution for slice-01 while its mandatory checklist is incomplete/u,
  );
  const exhaustedState = await inspectExecutionState(exhausted.requirements);
  assert.equal(exhaustedState.state, "IMPLEMENTATION_RETRY_EXHAUSTED");
  assertRecoveryTarget(exhaustedState, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "stnl-slice-executor",
    record: "implementation-check-03",
    round: 3,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(exhausted.requirements, "EXECUTE_SLICE", "1")).state, "IMPLEMENTATION_RETRY_EXHAUSTED");
  await rejectedWithRecovery(
    preflightExecutionOperation(exhausted.requirements, "VALIDATE_SLICE", "1"),
    /legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  await editTask(exhausted, (value) => value.replace("- [ ] 1.1", "- [x] 1.1"));
  const exhaustedRecovered = await inspectExecutionState(exhausted.requirements);
  assert.equal(exhaustedRecovered.state, "IMPLEMENTATION_RETRY_EXHAUSTED");
  assertRecoveryTarget(exhaustedRecovered, {
    operation: "VALIDATE_SLICE",
    slice: "slice-01",
    owner: "retry-exhaustion",
  });
  await assert.rejects(preflightExecutionOperation(exhausted.requirements, "EXECUTE_SLICE", "1"), /not legal/u);
  assert.equal((await preflightExecutionOperation(exhausted.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTATION_RETRY_EXHAUSTED");

  const delegatedValidation = await standaloneWorkspace(t);
  await renderArtifacts(delegatedValidation);
  await editTask(delegatedValidation, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("VALIDATE_SLICE", "initialization"));
  });
  const delegatedInvalidCandidate = await copyDirectory(
    delegatedValidation.execution,
    path.join(delegatedValidation.root, "delegated-validation-invalid-candidate"),
  );
  await assert.rejects(
    validateExecutionCandidate(delegatedValidation.requirements, delegatedInvalidCandidate),
    /candidate cannot finalize execution for slice-01 while its mandatory checklist is incomplete/u,
  );
  const delegatedState = await inspectExecutionState(delegatedValidation.requirements);
  assert.equal(delegatedState.state, "RUNNER_INITIALIZATION_BLOCKED");
  assertRecoveryTarget(delegatedState, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "stnl-slice-executor",
    record: "implementation-check-01",
    round: 1,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(delegatedValidation.requirements, "EXECUTE_SLICE", "1")).state, "RUNNER_INITIALIZATION_BLOCKED");
  await editTask(delegatedValidation, (value) => value.replace("- [ ] 1.1", "- [x] 1.1"));
  const delegatedRecovered = await inspectExecutionState(delegatedValidation.requirements);
  assertRecoveryTarget(delegatedRecovered, {
    operation: "VALIDATE_SLICE",
    slice: "slice-01",
    owner: "delegation-blocker",
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(delegatedValidation.requirements, "VALIDATE_SLICE", "1")).state, "RUNNER_INITIALIZATION_BLOCKED");
});

test("terminal auxiliary outcomes and scoped blocker resumes have exact phases", async (t) => {
  const implemented = await standaloneWorkspace(t);
  await renderArtifacts(implemented);
  await editTask(implemented, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await inspectExecutionState(implemented.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await assert.rejects(preflightExecutionOperation(implemented.requirements, "EXECUTE_SLICE", "1"), /legal next operations are VALIDATE_SLICE for slice-01 or REPLAN/u);
  assert.equal((await preflightExecutionOperation(implemented.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const corrected = await standaloneWorkspace(t);
  await renderArtifacts(corrected);
  await editTask(corrected, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    return replaceSection(result, "Findings Test Evidence", checkRecord("findings-check", 1, "TESTS_NOT_APPLICABLE", 1, { cycle: "attempt-01" }));
  });
  assert.equal((await inspectExecutionState(corrected.requirements)).state, "FINDINGS_CORRECTED");
  await assert.rejects(preflightExecutionOperation(corrected.requirements, "APPLY_FINDINGS", "1"), /not legal from FINDINGS_CORRECTED/u);
  assert.equal((await preflightExecutionOperation(corrected.requirements, "VALIDATE_SLICE", "1")).state, "FINDINGS_CORRECTED");

  const initialized = await standaloneWorkspace(t);
  await renderArtifacts(initialized);
  await editTask(initialized, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization"));
  });
  const initializedState = await inspectExecutionState(initialized.requirements);
  assert.equal(initializedState.state, "RUNNER_INITIALIZATION_BLOCKED");
  assert.deepEqual(initializedState.mandatoryRecovery, initializedState.recoveryTargets[0]);
  assert.deepEqual(initializedState.legalOperations, [{ operation: "EXECUTE_SLICE", slice: "slice-01" }]);
  assert.equal(initializedState.normalHandoff, null);
  assertRecoveryTarget(initializedState, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "delegation-blocker",
    record: null,
    round: null,
    retryState: null,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(initialized.requirements, "EXECUTE_SLICE", "1")).state, "RUNNER_INITIALIZATION_BLOCKED");
  const wrongOperation = await rejectedWithRecovery(
    preflightExecutionOperation(initialized.requirements, "REPLAN"),
    /legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  assertRecoveryTarget(wrongOperation, { operation: "EXECUTE_SLICE", slice: "slice-01" });
  const unsupportedOperation = await rejectedWithRecovery(
    preflightExecutionOperation(initialized.requirements, "DELETE_MANUALLY"),
    /unsupported operation DELETE_MANUALLY; legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  assertRecoveryTarget(unsupportedOperation, { operation: "EXECUTE_SLICE", slice: "slice-01" });
  const wrongSlice = await rejectedWithRecovery(
    preflightExecutionOperation(initialized.requirements, "EXECUTE_SLICE", "2"),
    /legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  assertRecoveryTarget(wrongSlice, { operation: "EXECUTE_SLICE", slice: "slice-01" });
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs"),
    initialized.requirements,
    "REPLAN",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /legal next operation is EXECUTE_SLICE for slice-01/u);
  await editTask(initialized, (value) => {
    let result = replaceSection(value, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization", { state: "resolved", resolution: "implementation-check-01 returned a valid result" }));
  });
  assert.equal((await inspectExecutionState(initialized.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const malformed = await standaloneWorkspace(t);
  await renderArtifacts(malformed);
  await editTask(malformed, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("VALIDATE_SLICE", "malformed-output"));
  });
  const malformedState = await inspectExecutionState(malformed.requirements);
  assert.equal(malformedState.state, "RUNNER_RESULT_BLOCKED");
  assert.deepEqual(malformedState.mandatoryRecovery, malformedState.recoveryTargets[0]);
  assert.equal(malformedState.normalHandoff, null);
  assertRecoveryTarget(malformedState, {
    operation: "VALIDATE_SLICE",
    slice: "slice-01",
    owner: "delegation-blocker",
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(malformed.requirements, "VALIDATE_SLICE", "1")).state, "RUNNER_RESULT_BLOCKED");
});

test("APPLY_FINDINGS recovery remains bound to persisted slice-02 and exposes auxiliary round ownership", async t => {
  const f = await standaloneWorkspace(t); await renderArtifacts(f);
  await addSecondPristineSlice(f); await passFirstSlice(f);
  const secondOwner = await beginExample(f, 'EXECUTE_SLICE', 'slice-02');
  const secondStart = await nativeExample({ specPath: f.requirements, root: f.root }, secondOwner.owner);
  const secondCopy = await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-02', owner: secondOwner.owner });
  t.after(() => fs.rm(secondCopy.candidateRoot, { recursive: true, force: true }));
  let secondTask = (await fs.readFile(secondCopy.candidateTaskArtifact, 'utf8')).replace('- [ ] 2.1', '- [x] 2.1');
  secondTask = replaceSection(secondTask, 'Changed Areas', '- `../../src/example.txt`');
  secondTask = replaceSection(secondTask, 'Prior Validation Overlap',
    '### overlap-01\n\n- Prior slice: slice-01\n- Paths: `../../src/example.txt`\n- Affected behavior: Preserve the earlier example bytes.\n- Regressions: The same prepared byte assertion.');
  await fs.writeFile(secondCopy.candidateTaskArtifact, secondTask);
  const secondResponse = { ...f.exampleImplementation.response,
    commands: secondStart.verification.checks.map(check => ({ command: verificationCommand(check), exit: 0 })) };
  const secondCapture = await captureNativeExample(secondStart, secondResponse, ['../../src/example.txt']);
  const secondBundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', response: JSON.stringify(secondResponse),
    workspace: f.root, taskArtifact: secondCopy.candidateTaskArtifact, ...secondCapture });
  await insertExecutionEvidenceInCandidate({ taskArtifact: secondCopy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', bundle: secondBundle,
    validateProspectiveTask: task => validateExecutionCandidate(f.requirements, secondCopy.candidateExecutionRoot, [task]) });
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-02', candidateRoot: secondCopy.candidateRoot });
  const formal = await validateExample(f, { slice: 'slice-02', status: 'NEEDS_FIX',
    findings: ACTIVE_FINDING.replaceAll('slice-01', 'slice-02') });
  const before = await inspectExecutionState(f.requirements);
  const admission = await beginExample(f, 'APPLY_FINDINGS', 'slice-02');
  const blockedCopy = await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-02', owner: admission.owner });
  t.after(() => fs.rm(blockedCopy.candidateRoot, { recursive: true, force: true }));
  const original = await fs.readFile(blockedCopy.candidateTaskArtifact, 'utf8');
  await fs.writeFile(blockedCopy.candidateTaskArtifact, replaceSection(original, 'Delegation Blocker',
    delegationBlocker('APPLY_FINDINGS', 'initialization')));
  assert.equal((await validateExecutionCandidate(f.requirements, blockedCopy.candidateExecutionRoot)).state, 'RUNNER_INITIALIZATION_BLOCKED');
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-02', candidateRoot: blockedCopy.candidateRoot, owner: admission.owner, terminal: false });
  const blocked = await inspectExecutionState(f.requirements);
  assertRecoveryTarget(blocked, { operation: 'APPLY_FINDINGS', slice: 'slice-02',
    owner: 'delegation-blocker', sameOperationResumeRequired: true });
  assert.equal((await preflightExecutionOperation(f.requirements, 'APPLY_FINDINGS', '2', { owner: admission.owner })).state, 'RUNNER_INITIALIZATION_BLOCKED');
  await rejectedWithRecovery(preflightExecutionOperation(f.requirements, 'EXECUTE_SLICE', '2', { owner: admission.owner }),
    /legal next operation is APPLY_FINDINGS for slice-02/);
  await assert.rejects(preflightExecutionOperation(f.requirements, 'APPLY_FINDINGS', '1', { owner: admission.owner }), /slice-02/);

  const start = await nativeExample({ specPath: f.requirements, root: f.root }, admission.owner);
  const copy = await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-02', owner: admission.owner });
  t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
  await fs.writeFile(copy.candidateTaskArtifact, replaceSection(await fs.readFile(copy.candidateTaskArtifact, 'utf8'),
    'Corrections Applied', '- `../../src/example.txt`'));
  const response = { ...scopeRegressionPayload(), status: 'BLOCKED', findingsCycle: 'attempt-01', findingsVerified: 'none',
    correctionsCovered: 'Rechecked the existing example assertion', regressionsSelected: 'Prepared byte assertion',
    unsupportedActiveFindings: 'finding-01', blockers: 'Controlled semantic prerequisite is unavailable',
    commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: 0 })) };
  for (const key of ['priorRoundFailure', 'correctionApplied', 'inSliceRationale']) delete response[key];
  const captured = await captureNativeExample(start, response, ['../../src/example.txt']);
  const receipt = await fs.readFile(captured.receiptFile), priorReceipt = await fs.readFile(formal.captured.receiptFile);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'APPLY_FINDINGS', response: JSON.stringify(response),
    workspace: f.root, taskArtifact: copy.candidateTaskArtifact, ...captured });
  await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation: 'APPLY_FINDINGS', bundle,
    validateProspectiveTask: task => validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot, [task]) });
  assert.equal((await validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot)).state, 'AUXILIARY_BLOCKED');
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-02', candidateRoot: copy.candidateRoot, owner: admission.owner });
  const auxiliary = await inspectExecutionState(f.requirements);
  assertRecoveryTarget(auxiliary, { operation: 'APPLY_FINDINGS', slice: 'slice-02', owner: 'auxiliary-check',
    record: 'findings-check-01', round: 1, sameOperationResumeRequired: true });
  assert.equal(auxiliary.tasks.get('slice-01').attempts[0].body, before.tasks.get('slice-01').attempts[0].body);
  assert.equal(auxiliary.tasks.get('slice-02').attempts[0].body, before.tasks.get('slice-02').attempts[0].body);
  assert.equal(auxiliary.tasks.get('slice-02').delegationBlocker.state, 'resolved');
  assert.deepEqual(await fs.readFile(captured.receiptFile), receipt);
  assert.deepEqual(await fs.readFile(formal.captured.receiptFile), priorReceipt);
});


test("an executor delegation blocker remains narrowly resumable when later validation history would otherwise deadlock it", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization"));
  });

  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "RUNNER_INITIALIZATION_BLOCKED");
  assertRecoveryTarget(blocked, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "delegation-blocker",
    record: null,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1")).state, "RUNNER_INITIALIZATION_BLOCKED");
  await rejectedWithRecovery(
    preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1"),
    /legal next operation is EXECUTE_SLICE for slice-01/u,
  );

  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization", {
      state: "resolved",
      resolution: "implementation-check-01 returned a valid result",
    }));
  });
  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "VALIDATION_NEEDS_FIX");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1")).state, "VALIDATION_NEEDS_FIX");
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"), /not legal/u);
});

test("auxiliary BLOCKED resumes only its originating operation and later records clear it", async t => {
  const f = await standaloneWorkspace(t); await renderArtifacts(f);
  const admission = await beginExample(f, 'EXECUTE_SLICE');
  const start = await nativeExample({ specPath: f.requirements, root: f.root }, admission.owner);
  const copy = await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-01', owner: admission.owner });
  t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
  const original = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  await fs.writeFile(copy.candidateTaskArtifact, replaceSection(original, 'Changed Areas', '- `../../src/example.txt`'));
  const response = { ...scopeRegressionPayload(), status: 'BLOCKED',
    commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: 0 })),
    resultOfEachCommandAndExitCode: 'The real prepared assertion passes; semantic approval remains unavailable',
    blockers: 'Controlled offline semantic prerequisite is unavailable',
    evidenceOrFailureSummary: 'Retain the concluded BLOCKED outcome pending human resolution' };
  const captured = await captureNativeExample(start, response, ['../../src/example.txt']);
  const receipt = await fs.readFile(captured.receiptFile), semantic = await fs.readFile(captured.semanticResponseFile);
  const live = await treeBytes(f.execution);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', response: JSON.stringify(response),
    workspace: f.root, taskArtifact: copy.candidateTaskArtifact, ...captured });
  await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', bundle,
    validateProspectiveTask: task => validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot, [task]) });
  assert.equal((await validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot)).state, 'AUXILIARY_BLOCKED');
  assert.deepEqual(await treeBytes(f.execution), live);
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-01', candidateRoot: copy.candidateRoot });
  const blocked = await inspectExecutionState(f.requirements);
  assert.equal(blocked.state, 'AUXILIARY_BLOCKED');
  assertRecoveryTarget(blocked, { operation: 'EXECUTE_SLICE', slice: 'slice-01', owner: 'auxiliary-check',
    record: 'implementation-check-01', round: 1, sameOperationResumeRequired: true });
  assert.equal((await preflightExecutionOperation(f.requirements, 'EXECUTE_SLICE', '1')).state, 'AUXILIARY_BLOCKED');
  await assert.rejects(preflightExecutionOperation(f.requirements, 'APPLY_FINDINGS', '1'), /legal next operation is EXECUTE_SLICE for slice-01/);
  assert.equal(recoverableRunnerHandoff({ operation: 'EXECUTE_SLICE', slice: 'slice-01',
    outcome: { result: 'BLOCKED', blocker: 'OFFICIAL_AUXILIARY_BLOCKED' },
    readback: { executionRaw: blocked }, priorOperations: [], remainingTurns: 10 }), null);
  await implementExample(f);
  const resumed = await inspectExecutionState(f.requirements);
  assert.equal(resumed.state, 'IMPLEMENTED_AWAITING_VALIDATION');
  assert.deepEqual(resumed.tasks.get('slice-01').implementationChecks.map(check => [check.id, check.status, check.round]),
    [['implementation-check-01', 'BLOCKED', 1], ['implementation-check-02', 'TESTS_PASS', 1]]);
  assert.equal(resumed.tasks.get('slice-01').implementationChecks[0].body, blocked.tasks.get('slice-01').implementationChecks[0].body);
  assert.equal(resumed.mandatoryRecovery, null);
  assert.deepEqual(await fs.readFile(captured.receiptFile), receipt);
  assert.deepEqual(await fs.readFile(captured.semanticResponseFile), semantic);
});

test("append-only requirements recovery preserves history and requires later PASS ownership", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Divergences", ACTIVE_DIVERGENCE);
  });
  await fs.appendFile(fixture.requirements, "- AC-002: changed after partial execution\n");
  const newHash = await computeRequirementsAuthority(fixture.requirements);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "REQUIREMENTS_CHANGED");
  await appendRecoveryPlan(fixture, oldHash, newHash);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-02", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  const reviewed = await inspectExecutionState(fixture.requirements);
  const reviewedReadback = { execution: reviewed, executionRaw: reviewed, product: { deriveNormalHandoff } };
  assert.deepEqual(decideOutcome("REVIEW_PLAN", reviewedReadback, true), { result: "PASS", blocker: null });
  assert.deepEqual(nextHandoff("REVIEW_PLAN", reviewedReadback), { operation: "MATERIALIZE_TASKS", slice: null });
  const liveBeforeMaterialization = await treeBytes(fixture.execution);
  const candidate = await preparePreparationCandidate({ specPath: fixture.requirements });
  t.after(async () => fs.rm(candidate.candidateExecutionRoot, { recursive: true, force: true }));
  await commitAppendRecovery({ ...fixture, execution: candidate.candidateExecutionRoot }, oldHash, newHash,
    { resolveDivergence: true });
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate.candidateExecutionRoot)).state,
    "EXECUTION_STARTED", "the approved supersession and divergence resolution satisfy the execution contract");
  const candidateBeforeMaterialization = await treeBytes(candidate.candidateExecutionRoot);
  const forbidden = [
    ["wrong replacement", "tasks/slice-01.md", (text) => text.replace("- Superseded by: slice-02", "- Superseded by: slice-03")],
    ["wrong revision", "tasks/slice-01.md", (text) => text.replace("- Plan revision: 2", "- Plan revision: 3")],
    ["wrong resolution owner", "tasks/slice-01.md", (text) => text.replace("plan revision 2 committed recovery slice-02", "plan revision 3 committed recovery slice-02")],
    ["wrong resolution owner with non-canonical new path", "tasks/slice-01.md", (text) => text.replace("plan revision 2 committed recovery slice-02", "plan revision 3 committed recovery slice-02"), true],
    ["changed checklist", "tasks/slice-01.md", (text) => text.replace("- [ ] 1.1", "- [x] 1.1")],
    ["changed path", "tasks/slice-01.md", (text) => text.replace("../../src/example.txt", "../../src/other.txt")],
    ["changed evidence", "tasks/slice-01.md", (text) => replaceSection(text, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1))],
    ["changed divergence problem", "tasks/slice-01.md", (text) => text.replace("Approved scope omits a required dependency.", "Different historical problem.")],
    ["changed divergence evidence", "tasks/slice-01.md", (text) => text.replace("The implementation cannot remain inside the slice.", "Different historical evidence.")],
    ["changed divergence authority", "tasks/slice-01.md", (text) => text.replace("Required authority operation: REPLAN", "Required authority operation: RESUME")],
    ["duplicate disposition", "tasks/slice-01.md", (text) => text.replace("- Resolution:", "- Resolution: plan revision 2 committed recovery slice-02\n- Resolution:")],
    ["invalid divergence successor", "tasks/slice-01.md", (text) => text.replace("- State: resolved", "- State: superseded").replace("- Resolution: plan revision 2 committed recovery slice-02", "- Superseded by: divergence-99")],
    ["changed approved mapping", "plan.md", (text) => text.replace("slice-01 -> slice-02", "none")],
    ["changed approved detailed plan", "plans/slice-01.md", (text) => text.replace("Deliver observable behavior.", "Different approved scope.")],
  ];
  for (const [name, relative, mutate, nonCanonicalNewPath] of forbidden) {
    await t.test(name, async (child) => {
      const badRoot = await temporary(child, "stnl-forbidden-materialization-");
      await copyDirectory(candidate.candidateExecutionRoot, badRoot);
      const target = path.join(badRoot, relative);
      const before = await fs.readFile(target, "utf8");
      const changed = mutate(before);
      assert.notEqual(changed, before, `${name} must actually change the fixture`);
      await fs.writeFile(target, changed);
      if (nonCanonicalNewPath) {
        const newTask = path.join(badRoot, "tasks/slice-02.md");
        await fs.writeFile(newTask, (await fs.readFile(newTask, "utf8")).replace("../../src/example.txt", "../src/example.txt"));
      }
      const badBefore = await treeBytes(badRoot);
      await assert.rejects(publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: badRoot }));
      assert.deepEqual(await treeBytes(fixture.execution), liveBeforeMaterialization);
      assert.deepEqual(await treeBytes(badRoot), badBefore);
    });
  }
  const approvedPlan = await fs.readFile(path.join(fixture.execution, "plan.md"));
  const approvedDetail = await fs.readFile(path.join(fixture.execution, "plans/slice-02.md"));
  await fs.writeFile(path.join(fixture.execution, "plan.md"), setPlanReviewState(approvedPlan.toString(), false));
  await fs.writeFile(path.join(fixture.execution, "plans/slice-02.md"), setPlanReviewState(approvedDetail.toString(), false));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "PENDING_REPLAN_DRAFT");
  const unapprovedBefore = await treeBytes(fixture.execution);
  await assert.rejects(publishPreparationCandidate({ specPath: fixture.requirements,
    candidateExecutionRoot: candidate.candidateExecutionRoot }), /historical task changed during materialization/u);
  assert.deepEqual(await treeBytes(fixture.execution), unapprovedBefore);
  assert.deepEqual(await treeBytes(candidate.candidateExecutionRoot), candidateBeforeMaterialization);
  await fs.writeFile(path.join(fixture.execution, "plan.md"), approvedPlan);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-02.md"), approvedDetail);
  const newTaskPath = path.join(candidate.candidateExecutionRoot, "tasks/slice-02.md");
  const newTask = await fs.readFile(newTaskPath, "utf8");
  await fs.writeFile(newTaskPath, newTask.replace("../../src/example.txt", "../src/example.txt"));
  const serialized = await serializeTaskPathClaims({ specPath: fixture.requirements,
    candidateExecutionRoot: candidate.candidateExecutionRoot });
  assert.equal(serialized.status, "PASS");
  assert.deepEqual(serialized.changedPaths, [newTaskPath], "only the newly approved task's claims are serialized");
  assert.deepEqual(await treeBytes(fixture.execution), liveBeforeMaterialization);
  assert.deepEqual(await treeBytes(candidate.candidateExecutionRoot), candidateBeforeMaterialization);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "PENDING_REPLAN_READY");
  const published = await publishPreparationCandidate({ specPath: fixture.requirements,
    candidateExecutionRoot: candidate.candidateExecutionRoot });
  assert.equal(published.status, "PASS");
  assert.deepEqual(await treeBytes(fixture.execution), candidateBeforeMaterialization);
  assert.deepEqual(await treeBytes(candidate.candidateExecutionRoot), candidateBeforeMaterialization);
  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "EXECUTION_STARTED");
  assert.equal(recovered.tasks.get("slice-01").divergences[0].state, "resolved");
  const materializedReadback = { execution: recovered, executionRaw: recovered, product: { deriveNormalHandoff } };
  assert.deepEqual(decideOutcome("MATERIALIZE_TASKS", materializedReadback, true), { result: "PASS", blocker: null });
  assert.deepEqual(nextHandoff("MATERIALIZE_TASKS", materializedReadback), { operation: "EXECUTE_SLICE", slice: "slice-02" });
  const handoff = spawnSync(process.execPath, [path.join(ROOT,
    "skills/workflows/stnl-execution-planner/runtime/validate-execution-state.mjs"), fixture.requirements,
    "--handoff-after", "MATERIALIZE_TASKS"], { encoding: "utf8", cwd: fixture.root });
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.equal(JSON.parse(handoff.stdout).normal_handoff.operation, "EXECUTE_SLICE");
  assert.equal(JSON.parse(handoff.stdout).normal_handoff.slice, "slice-02");
  t.diagnostic(JSON.stringify({ officialPublication: published.status, state: recovered.state,
    mapping: "slice-01 -> slice-02", divergence: "active -> resolved", handoff: JSON.parse(handoff.stdout).normal_handoff,
    candidateBytesPreserved: true }));
  // Terminalizing the replacement without PASS ownership is an impossible corrective request.
  const replacementPath = path.join(fixture.execution, "tasks/slice-02.md");
  let impossibleReplacement = await fs.readFile(replacementPath, "utf8");
  impossibleReplacement = impossibleReplacement.replace("- [ ] 1.1", "- [x] 1.1");
  impossibleReplacement = replaceSection(impossibleReplacement, "Changed Areas", "- `../../src/example.txt`");
  impossibleReplacement = impossibleReplacement.replace("## Final Result\n\n- pending", "## Final Result\n\n- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 2");
  await fs.writeFile(replacementPath, impossibleReplacement, "utf8");
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |", "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | SUPERSEDED | SUPERSEDED |"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /committed supersessions do not exactly match|invalid later replacement slice/u);
});

test("U3 post-append handoff rejects self-supersession and retains later PASS ownership", async t => {
  const f = await standaloneWorkspace(t); const { authority } = await renderArtifacts(f);
  const initial = await inspectExecutionState(f.requirements);
  assert.equal(initial.state, 'MATERIALIZED_PRISTINE');
  assert.equal(deriveNormalHandoff(initial, 'REVIEW_PLAN')?.slice, 'slice-01');

  const first = await implementExample(f, { publish: false });
  await fs.writeFile(first.copy.candidateTaskArtifact,
    replaceSection(await fs.readFile(first.copy.candidateTaskArtifact, 'utf8'), 'Divergences', ACTIVE_DIVERGENCE));
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-01', candidateRoot: first.copy.candidateRoot });
  const prior = (await inspectExecutionState(f.requirements)).tasks.get('slice-01');
  const receipt = await fs.readFile(first.captured.receiptFile);
  const priorTask = await fs.readFile(path.join(f.execution, 'tasks/slice-01.md'));

  await fs.appendFile(f.requirements, '\nThe recovery must retain the original example assertion and its observed history.\n');
  const changedAuthority = await computeRequirementsAuthority(f.requirements);
  assert.notEqual(changedAuthority, authority);
  assert.equal((await preflightExecutionOperation(f.requirements, 'REPLAN')).state, 'REQUIREMENTS_CHANGED');
  await appendRecoveryPlan(f, authority, changedAuthority);
  assert.equal((await preflightExecutionOperation(f.requirements, 'REVIEW_PLAN')).state, 'PENDING_REPLAN_DRAFT');
  await assert.rejects(preflightExecutionOperation(f.requirements, 'EXECUTE_SLICE', '2'), /not legal/u);

  // A separate officially prepared draft is valid before one prospective
  // mapping edit. Both source and target then name the newly appended slice,
  // so the first pertinent contract guard must reject self-supersession.
  const draft = await preparePreparationCandidate({ specPath: f.requirements, operation: 'REVIEW_PLAN' });
  t.after(() => fs.rm(draft.candidateExecutionRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(draft.candidateExecutionRoot + '.owner.json', { force: true }));
  const draftPlan = path.join(draft.candidateExecutionRoot, 'plan.md');
  const canonicalPlan = await fs.readFile(draftPlan, 'utf8');
  assert.match(canonicalPlan, /^- Supersedes open slices: slice-01 -> slice-02$/mu);
  assert.equal((await validateExecutionCandidate(f.requirements, draft.candidateExecutionRoot)).state, 'PENDING_REPLAN_DRAFT');
  const liveBeforeRejection = await treeBytes(f.execution);
  const invalidPlan = canonicalPlan.replace('- Supersedes open slices: slice-01 -> slice-02',
    '- Supersedes open slices: slice-02 -> slice-02');
  assert.notEqual(invalidPlan, canonicalPlan);
  await fs.writeFile(draftPlan, invalidPlan);
  const rejectedCandidate = await treeBytes(draft.candidateExecutionRoot);
  await assert.rejects(validateExecutionCandidate(f.requirements, draft.candidateExecutionRoot),
    /invalid joint supersession mapping/u);
  assert.deepEqual(await treeBytes(f.execution), liveBeforeRejection);
  assert.deepEqual(await treeBytes(draft.candidateExecutionRoot), rejectedCandidate);
  assert.deepEqual(await fs.readFile(first.captured.receiptFile), receipt);

  await reviewJointFixture(f);
  const reviewed = await inspectExecutionState(f.requirements);
  assert.equal(reviewed.state, 'EXECUTION_STARTED');
  assert.equal(deriveNormalHandoff(reviewed, 'REVIEW_PLAN')?.slice, 'slice-02');
  assert.equal(reviewed.mandatoryRecovery, null);
  assert.deepEqual(reviewed.legalOperations.filter(entry => entry.operation === 'EXECUTE_SLICE')
    .map(entry => entry.slice), ['slice-02']);
  assert.equal(reviewed.tasks.get('slice-01').final.result, 'SUPERSEDED');
  assert.equal(reviewed.tasks.get('slice-01').final.supersededBy, 'slice-02');
  assert.equal(reviewed.tasks.get('slice-01').implementationChecks[0].body, prior.implementationChecks[0].body);
  assert.deepEqual(reviewed.tasks.get('slice-01').divergences, prior.divergences);
  assert.deepEqual(reviewed.activeDivergences, []);
  const continuity = JSON.parse(await fs.readFile(path.join(f.execution, 'continuity.json')));
  const retained = continuity.deliveries.find(d => d.deliveryId === prior.deliveryId).history.at(-1);
  assert.deepEqual(await fs.readFile(path.resolve(f.execution, retained.taskRef.path)), priorTask);
  const readback = { execution: reviewed, executionRaw: reviewed, product: { deriveNormalHandoff } };
  assert.deepEqual(decideOutcome('REVIEW_PLAN', readback, true), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('REVIEW_PLAN', readback), { operation: 'EXECUTE_SLICE', slice: 'slice-02' });
  const handoff = spawnSync(process.execPath, [path.join(ROOT,
    'skills/workflows/stnl-execution-planner/runtime/validate-execution-state.mjs'), f.requirements,
    '--handoff-after', 'REVIEW_PLAN'], { encoding: 'utf8', cwd: f.root });
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.deepEqual(JSON.parse(handoff.stdout).normal_handoff.slice, 'slice-02');

  const implementation = await implementExample(f, { slice: 'slice-02', publish: false });
  const candidate = implementation.copy;
  assert.equal((await validateExecutionCandidate(f.requirements, candidate.candidateExecutionRoot)).state,
    'IMPLEMENTED_AWAITING_VALIDATION');
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-02', candidateRoot: candidate.candidateRoot });
  assert.notEqual((await inspectExecutionState(f.requirements)).state, 'COMPLETE');
  await validateExample(f, { slice: 'slice-02' });
  const complete = await inspectExecutionState(f.requirements);
  assert.equal(complete.state, 'COMPLETE');
  assert.equal(complete.tasks.get('slice-02').base.present, true);
  assert.equal(complete.tasks.get('slice-02').attempts.at(-1).id, 'attempt-01');
  assert.deepEqual(await fs.readFile(first.captured.receiptFile), receipt);
  assert.deepEqual(await fs.readFile(path.resolve(f.execution, retained.taskRef.path)), priorTask);
});

// Every structural mutation is consumed as a prospective task on a real owned
// candidate. The positive uses the same validator; live activation is separate.
async function rejectTaskMutations(fixture, copy, cases) {
  const task = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  const live = await treeBytes(fixture.execution), candidate = await treeBytes(copy.candidateExecutionRoot);
  const positive = await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot);
  const failures = [];
  for (const [name, mutate, diagnostic] of cases) {
    const text = mutate(task); assert.notEqual(text, task, name + ': stimulus applied');
    try {
      await assert.rejects(validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot,
        [{ slice: 'slice-01', text }]), diagnostic, name);
    } catch (error) { failures.push({ name, diagnostic: error.actual?.message ?? error.message }); }
    assert.deepEqual(await treeBytes(fixture.execution), live, name + ': live preserved');
    assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidate, name + ': candidate preserved');
  }
  assert.deepEqual(failures, [], 'all prospective task guards must reach their intended boundary');
  return positive;
}

test('canonical owned auxiliary and formal candidates enforce record structure and exact PASS provenance', async t => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  const impl = await implementExample(fixture, { publish: false });
  const scopeBefore = await fs.readFile(impl.copy.candidateTaskArtifact, 'utf8');
  const liveTaskBefore = await fs.readFile(path.join(fixture.execution, 'tasks/slice-01.md'));
  assert.equal((await serializeExecutionScopeClaims({ workspace: fixture.root,
    taskArtifact: impl.copy.candidateTaskArtifact })).status, 'PASS');
  const omittedScope = replaceSection(scopeBefore, 'Changed Areas', '- pending');
  assert.notEqual(omittedScope, scopeBefore);
  await fs.writeFile(impl.copy.candidateTaskArtifact, omittedScope);
  await assert.rejects(serializeExecutionScopeClaims({ workspace: fixture.root,
    taskArtifact: impl.copy.candidateTaskArtifact }), /Changed Areas cannot remain pending after execution work/);
  assert.equal(await fs.readFile(impl.copy.candidateTaskArtifact, 'utf8'), omittedScope);
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, 'tasks/slice-01.md')), liveTaskBefore);
  await fs.writeFile(impl.copy.candidateTaskArtifact, scopeBefore);
  const field = (text, name, value) => text.replace(new RegExp(`^- ${name}:.*$`, 'mu'), `- ${name}: ${value}`);
  const check = (text, mutate) => replaceSection(text, 'Implementation Test Evidence', mutate(impl.bundle));
  const cases = [
    ['incomplete checklist', text => text.replace('- [x] 1.1', '- [ ] 1.1'), /mandatory checklist is incomplete/],
    ['pending changed scope', text => replaceSection(text, 'Changed Areas', '- pending'), /Changed Areas cannot remain pending after work/],
    ['truncated tested hash', text => check(text, record => record.replace(`sha256:${VALIDATED_HASH}`, 'sha256:1234abcd')), /unexpected nested.*Tested state/],
    ['duplicate section', text => text.replace('## Validation Findings', '## Validation Findings\n\n- none\n\n## Validation Findings'), /duplicates Validation Findings/],
    ['missing section', text => text.replace(/## Diff Summary\n[\s\S]*?(?=## Final Result)/u, ''), /unknown, missing or unordered sections/],
    ['unknown section', text => text.replace('## Final Result', '## Unknown Operational State\n\n- none\n\n## Final Result'), /unknown, missing or unordered sections/],
    ['reordered sections', text => text.replace('## Expected Tests', '## __swap__').replace('## Changed Areas', '## Expected Tests').replace('## __swap__', '## Changed Areas'), /section order|sections/],
    ['duplicate Tested scope', text => check(text, record => record.replace('- Tested scope:', '- Tested scope: shadow\n- Tested scope:')), /exactly one 'Tested scope'/],
    ['empty Tested scope', text => check(text, record => field(record, 'Tested scope', '  ')), /Tested scope/],
    ['file-backed empty reason', text => check(text, record => record + '\n- Fileless reason:'), /Fileless reason/],
    ['duplicate tested path', text => check(text, record => record.replace(`  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`, `  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`)), /duplicate Tested state paths/],
    ['unordered tested paths', text => check(text, record => record.replace(`  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`, `  - \`../../src/z.txt\` | sha256:${VALIDATED_HASH}\n  - \`../../src/a.txt\` | sha256:${VALIDATED_HASH}`)), /Tested state paths are not lexicographically ordered/],
    ['unsafe tested path', text => check(text, record => record.replace('`../../src/example.txt`', '`../../../outside.txt`')), /unsafe Tested state path/],
    ['commands cannot move to selected checks', text => check(text, record => record.replace(/- Commands:\n  - [^\n]+/u, '- Commands:').replace(/- Selected checks: [^\n]+/u, '- Selected checks: focused check\n  - `node --test` | exit:0')), /Commands|unexpected nested/],
    ['purpose owner', text => text.replace('owner: stnl-execution-planner', 'owner: unrelated-owner'), /incompatible owner/],
    ['requirements reference', text => text.replace('- Requirements source: `../../requirements.md`', '- Requirements source: `../../user-owned.md`'), /non-canonical Requirements source/],
    ['plan reference', text => text.replace('- Plan: `../plans/slice-01.md`', '- Plan: `../plans/slice-99.md`'), /non-canonical Plan/],
    ['tasks reference', text => text.replace('- Global tasks: `../tasks.md`', '- Global tasks: `../other.md`'), /non-canonical Global tasks/],
    ['check numbering', text => check(text, record => record.replace('### implementation-check-01', '### implementation-check-02')), /contiguous from 01/],
    ['check after terminal PASS', text => check(text, record => `${record}\n\n${record.replace('### implementation-check-01', '### implementation-check-02')}`), /after terminal automatic-check record/],
  ];
  for (const name of ['Tested scope', 'Verification types considered', 'Selected checks', 'Coverage']) cases.push([name + ' needs objective content', text => check(text, record => field(record, name, 'none')), new RegExp(name)]);
  for (const value of ['  additional scope', '    - nested scalar value', '\t- nested scalar value', '  * second value', '  + second value', '  1. second value']) cases.push(['scalar continuation ' + JSON.stringify(value), text => check(text, record => record.replace(/^- Tested scope:.*$/mu, match => match + '\n' + value)), /unexpected nested|continuation/]);
  for (const body of ['- `../../src/example.txt`\n  - `../../src/hidden.txt`', '- `../../src/example.txt`\n- arbitrary prose', '- `../../src/z.txt`\n- `../../src/a.txt`', '- `../../src/example.txt`\n- `../../src/example.txt`']) cases.push(['canonical scope ' + body, text => replaceSection(text, 'Changed Areas', body), /canonical task-relative path claims|not lexicographically ordered|duplicate path claims/]);
  assert.equal((await rejectTaskMutations(fixture, impl.copy, cases)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: impl.copy.candidateRoot });
  const formal = await validateExample(fixture, { publish: false });
  const copy = { ...formal.copy, candidateTaskArtifact: path.join(formal.copy.candidateExecutionRoot, 'tasks/slice-01.md') };
  const base = (text, transform) => {
    const body = text.split('## Effective Validation Base\n\n')[1].split('\n## ')[0].trim();
    return replaceSection(text, 'Effective Validation Base', transform(body));
  };
  const formalCases = [
    ['base attempt type', text => base(text, body => field(body, 'Attempt type', 'revalidation')), /Attempt type disagrees/],
    ['base HEAD', text => base(text, body => field(body, 'HEAD', 'unrelated')), /HEAD disagrees/],
    ['base manifest tuple', text => base(text, body => body.replace('`../../src/example.txt`', 'malformed')), /malformed Files manifest/],
    ['base placeholder evidence', text => base(text, body => field(body, 'Evidence summary', 'pending')), /Evidence summary/],
    ['base different command', text => base(text, body => body.replace('node --test src/example.test.mjs', 'node --test src/other.test.mjs')), /authoritative commands disagree with its origin attempt/],
    ['base different evidence', text => base(text, body => field(body, 'Evidence summary', 'Different objective evidence.')), /Evidence summary disagrees with its origin attempt/],
    ['base duplicate command authority', text => base(text, body => body + '\n- Authoritative commands:\n  - `conflicting command` | exit:0'), /exactly one Authoritative commands|unexpected content after Evidence summary/],
    ['incomplete atomic PASS', text => replaceSection(text, 'Final Result', '- pending'), /latest PASS attempt was not published atomically/],
    ['attempt numbering', text => text.replace('### attempt-01', '### attempt-02'), /contiguous from 01/],
    ['attempt scalar continuation', text => text.replace(/^- Verified scope:.*$/mu, match => match + '\n  additional scope\n  - `hidden command` | exit:0'), /unexpected nested/],
  ];
  for (const status of ['PASS', 'NEEDS_FIX']) formalCases.push([
    `attempt after PASS without sealed reopening: ${status}`,
    text => {
      const first = text.split('## Validation Attempts\n\n')[1].split('\n## ')[0].trim();
      const second = first.replace('### attempt-01', '### attempt-02')
        .replace('- Type: initial', '- Type: revalidation')
        .replace('- Status: PASS', `- Status: ${status}`);
      return replaceSection(text, 'Validation Attempts', `${first}\n\n${second}`);
    },
    /attempt-01 PASS is terminal without a sealed reopening/,
  ]);
  for (const result of ['- PASS\n- pending', '- PASS\n- PASS', '- pending\n- PASS', '- PASS\n- SUPERSEDED', '- PASS\n- terminal: PASS']) formalCases.push(['terminal conflict ' + result, text => replaceSection(text, 'Final Result', result), /Final Result is malformed/]);
  for (const summary of ['- pending', 'paragraph summary', '- fact\n  - nested fact', '- fact\n\n- another fact', '- ']) formalCases.push(['invalid Diff Summary ' + summary, text => replaceSection(text, 'Diff Summary', summary), /Diff Summary/]);
  assert.equal((await rejectTaskMutations(fixture, copy, formalCases)).state, 'COMPLETE');
  await publishValidationCandidate({ specPath: fixture.requirements, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot, owner: formal.admission.owner });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, 'COMPLETE');
});

test('canonical fileless implementation, findings correction and PASS retain explicit reason without invented paths', async t => {
  const fixture = await standaloneWorkspace(t);
  const previousEnvironment = process.env.STNL_QA_FILELESS_READY;
  t.after(() => { if (previousEnvironment === undefined) delete process.env.STNL_QA_FILELESS_READY; else process.env.STNL_QA_FILELESS_READY = previousEnvironment; });
  process.env.STNL_QA_FILELESS_READY = '1';
  await fs.mkdir(path.join(fixture.root, 'src'));
  await fs.writeFile(path.join(fixture.root, 'src/observation.mjs'), "import assert from 'node:assert/strict';assert.equal(process.env.STNL_QA_FILELESS_READY,'1','the observed process configuration is ready');\n");
  fixture.verificationRecipe = '- Recipe: ' + JSON.stringify({ format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.', checks: [{ id: 'verification-01', executable: { literal: 'node' }, args: [{ file: { kind: 'product', path: 'src/observation.mjs' } }], inputs: [] }], dependencyReview: 'The prepared assertion observes STNL_QA_FILELESS_READY inherited by the process, without changing repository files.' });
  await renderArtifacts(fixture);
  const reason = 'The correction sets the observed process configuration; no repository file is changed.';
  const initial = await standaloneWorkspace(t); initial.verificationRecipe = fixture.verificationRecipe;
  await fs.mkdir(path.join(initial.root, 'src'));
  await fs.copyFile(path.join(fixture.root, 'src/observation.mjs'), path.join(initial.root, 'src/observation.mjs'));
  await renderArtifacts(initial);
  await implementExample(initial, { filelessReason: reason });
  await validateExample(initial);
  const initialPass = await inspectExecutionState(initial.requirements);
  assert.equal(initialPass.state, 'COMPLETE');
  assert.equal(initialPass.tasks.get('slice-01').attempts[0].id, 'attempt-01');
  assert.equal(initialPass.tasks.get('slice-01').base.fileless, true);
  const direct = await standaloneWorkspace(t); direct.verificationRecipe = fixture.verificationRecipe;
  await fs.mkdir(path.join(direct.root, 'src'));
  await fs.copyFile(path.join(fixture.root, 'src/observation.mjs'), path.join(direct.root, 'src/observation.mjs'));
  await renderArtifacts(direct);
  direct.exampleImplementation = await implementExample(direct, { filelessReason: reason });
  await validateExample(direct, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  const directCorrection = await correctExample(direct, { filelessReason: reason });
  assert.match(directCorrection.bundle, /- Automatic check round: 1\/3/);
  assert.equal((await preflightExecutionOperation(direct.requirements, 'VALIDATE_SLICE', '1')).state, 'FINDINGS_CORRECTED');
  fixture.exampleImplementation = await implementExample(fixture, { filelessReason: reason, publish: false });
  const first = fixture.exampleImplementation;
  await rejectTaskMutations(fixture, first.copy, [
    ['fileless needs reason', text => text.replace(/^- Fileless reason:.*\n/mu, ''), /Fileless reason/],
    ['fileless rejects placeholder', text => text.replace(/^- Fileless reason:.*$/mu, '- Fileless reason: pending'), /Fileless reason/],
    ['fileless rejects blank', text => text.replace(/^- Fileless reason:.*$/mu, '- Fileless reason:   '), /Fileless reason/],
    ['current check drives changed scope', text => replaceSection(text, 'Changed Areas', '- `../../src/example.txt`'), /current fileless.*Changed Areas: none/],
  ]);
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: first.copy.candidateRoot });
  await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  const prior = (await inspectExecutionState(fixture.requirements)).tasks.get('slice-01');
  process.env.STNL_QA_FILELESS_READY = '0';
  const failed = await correctExample(fixture, { filelessReason: reason, fail: true, publish: false });
  process.env.STNL_QA_FILELESS_READY = '1';
  const correction = await retryFindingsExample(fixture, failed);
  assert.match(correction.bundle, /- Tested state: none\n- Fileless reason:/);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, 'FINDINGS_CORRECTED');
  const resolved = ACTIVE_FINDING.replace('State: active', 'State: resolved') + '\n- Resolution: attempt-02 confirms the corrected observation.';
  const formal = await validateExample(fixture, { findings: resolved, dispositions: 'finding-01=resolved', publish: false });
  const copy = { ...formal.copy, candidateTaskArtifact: path.join(formal.copy.candidateExecutionRoot, 'tasks/slice-01.md') };
  await rejectTaskMutations(fixture, copy, [
    ['fileless PASS needs reason', text => text.replace(/(## Effective Validation Base[\s\S]*?)- Fileless reason:[^\n]*\n/u, '$1'), /Fileless reason/],
    ['fileless PASS rejects placeholder reason', text => text.replace(/(## Effective Validation Base[\s\S]*?)- Fileless reason:[^\n]*/u, '$1- Fileless reason: pending'), /Fileless reason/],
    ['fileless PASS rejects whitespace reason', text => text.replace(/(## Effective Validation Base[\s\S]*?)- Fileless reason:[^\n]*/u, '$1- Fileless reason:   '), /Fileless reason/],
    ['fileless PASS needs evidence', text => text.replace(/(## Effective Validation Base[\s\S]*?)- Evidence summary:[^\n]*/u, '$1- Evidence summary: pending'), /Evidence summary/],
    ['fileless attempt and base need evidence', text => text.replace(/(## Validation Attempts[\s\S]*?)- Evidence:[^\n]*/u, '$1- Evidence:   ').replace(/(## Effective Validation Base[\s\S]*?)- Evidence summary:[^\n]*/u, '$1- Evidence summary:   '), /Evidence/],
    ['fileless PASS rejects whitespace evidence', text => text.replace(/(## Effective Validation Base[\s\S]*?)- Evidence summary:[^\n]*/u, '$1- Evidence summary:   '), /Evidence summary/],
  ]);
  await publishValidationCandidate({ specPath: fixture.requirements, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot, owner: formal.admission.owner });
  const complete = await inspectExecutionState(fixture.requirements), task = complete.tasks.get('slice-01');
  assert.equal(complete.state, 'COMPLETE'); assert.equal(task.base.fileless, true);
  assert.equal(task.sections.get('Changed Areas'), '- none'); assert.equal(task.sections.get('Corrections Applied'), '- none');
  assert.equal(task.implementationChecks[0].body, prior.implementationChecks[0].body);
  assert.equal(task.attempts[0].body, prior.attempts[0].body);
  assert.deepEqual(task.attempts.map(a => [a.id, a.status]), [['attempt-01', 'NEEDS_FIX'], ['attempt-02', 'PASS']]);
});

test('canonical current file-backed check supersedes a fileless failure without rewriting its receipt', async t => {
  const fixture = await standaloneWorkspace(t);
  const prior = process.env.STNL_QA_MIXED_READY;
  t.after(() => { if (prior === undefined) delete process.env.STNL_QA_MIXED_READY; else process.env.STNL_QA_MIXED_READY = prior; });
  process.env.STNL_QA_MIXED_READY = '0';
  await fs.mkdir(path.join(fixture.root, 'src'));
  await fs.writeFile(path.join(fixture.root, 'src/mixed.mjs'), "import assert from 'node:assert/strict';import fs from 'node:fs';assert.equal(process.env.STNL_QA_MIXED_READY,'1');assert.equal(fs.readFileSync('src/example.txt','utf8'),'current file-backed observation\\n');\n");
  fixture.verificationRecipe = '- Recipe: ' + JSON.stringify({ format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.', checks: [{ id: 'verification-01', executable: { literal: 'node' }, args: [{ file: { kind: 'product', path: 'src/mixed.mjs' } }], inputs: [{ kind: 'product', path: 'src/example.txt' }] }], dependencyReview: 'The prepared command observes the process configuration and then reads the explicitly bound example bytes.' });
  await renderArtifacts(fixture);
  const before = await fs.readFile(path.join(fixture.root, 'src/example.txt'));
  const first = await implementExample(fixture, { publish: false, failFirst: true,
    filelessReason: 'The prepared observation failed without changing any repository file.' });
  assert.deepEqual(await fs.readFile(path.join(fixture.root, 'src/example.txt')), before);
  assert.match(first.bundle, /- Tested state: none\n- Fileless reason:/);
  const receipt = await fs.readFile(first.captured.receiptFile);
  process.env.STNL_QA_MIXED_READY = '1';
  const second = await retryExample(fixture, first, 'current file-backed observation\n');
  assert.doesNotMatch(second.bundle, /Fileless reason:/);
  assert.match(second.bundle, /- Tested state:\n  - `\.\.\/\.\.\/src\/example.txt` \| sha256:/);
  const current = await inspectExecutionState(fixture.requirements), task = current.tasks.get('slice-01');
  assert.equal(current.state, 'IMPLEMENTED_AWAITING_VALIDATION');
  assert.equal(task.sections.get('Changed Areas'), '- `../../src/example.txt`');
  assert.ok(task.sections.get('Implementation Test Evidence').includes(first.bundle));
  assert.ok(task.sections.get('Implementation Test Evidence').includes(second.bundle));
  assert.deepEqual(await fs.readFile(first.captured.receiptFile), receipt);
});

test('canonical formal BLOCKED resumes validation and preserves its first attempt through PASS', async t => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  await implementExample(fixture);
  const blocked = await validateExample(fixture, { status: 'BLOCKED' });
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, 'VALIDATION_BLOCKED');
  assertRecoveryTarget(state, { operation: 'VALIDATE_SLICE', slice: 'slice-01', owner: 'validation-attempt', record: 'attempt-01' });
  const before = await treeBytes(fixture.execution);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, 'EXECUTE_SLICE', '1'), /not legal/);
  assert.equal((await preflightExecutionOperation(fixture.requirements, 'VALIDATE_SLICE', '1')).state, 'VALIDATION_BLOCKED');
  assert.equal((await preflightExecutionOperation(fixture.requirements, 'REPLAN')).state, 'VALIDATION_BLOCKED');
  assert.deepEqual(await treeBytes(fixture.execution), before);
  const receipt = await fs.readFile(blocked.captured.receiptFile);
  await validateExample(fixture);
  const completed = await inspectExecutionState(fixture.requirements);
  assert.equal(completed.state, 'COMPLETE');
  assert.deepEqual(completed.tasks.get('slice-01').attempts.map(a => [a.id, a.status]), [['attempt-01', 'BLOCKED'], ['attempt-02', 'PASS']]);
  assert.equal(completed.tasks.get('slice-01').attempts[0].body, state.tasks.get('slice-01').attempts[0].body);
  assert.deepEqual(await fs.readFile(blocked.captured.receiptFile), receipt);
});

test('canonical requirements freshness gates draft, approved, private execution and terminal PASS', async t => {
  for (const phase of ['draft', 'approved', 'private execution', 'terminal PASS']) await t.test(phase, async child => {
    const fixture = await standaloneWorkspace(child);
    await renderArtifacts(fixture, { planStatus: phase === 'draft' ? 'draft' : 'ready' });
    const privateExecution = phase === 'private execution' ? await implementExample(fixture, { publish: false }) : null;
    if (phase === 'terminal PASS') { await implementExample(fixture); await validateExample(fixture); }
    const initial = await inspectExecutionState(fixture.requirements);
    assert.equal(initial.stale, false);
    const before = await treeBytes(fixture.execution);
    await fs.appendFile(fixture.requirements, '\nDocumentary clarification changes the approved authority.\n');
    assert.notEqual(await computeRequirementsAuthority(fixture.requirements), initial.currentFingerprint);
    const stale = await inspectExecutionState(fixture.requirements);
    assert.equal(stale.state, 'REQUIREMENTS_CHANGED');
    // Pass the authentic owner so freshness, rather than the conflicting-admission
    // guard, decides the same-operation request while work remains private.
    const operations = privateExecution ? ['EXECUTE_SLICE'] : ['EXECUTE_SLICE', 'VALIDATE_SLICE'];
    for (const operation of operations) await assert.rejects(
      preflightExecutionOperation(fixture.requirements, operation, '1', { owner: privateExecution?.admission.owner }), /not legal|authority.*changed|stale/i);
    assert.deepEqual(await treeBytes(fixture.execution), before);
    if (phase === 'terminal PASS') assert.equal(stale.tasks.get('slice-01').attempts[0].body, initial.tasks.get('slice-01').attempts[0].body);
  });
});

test('canonical findings sets and dispositions reconcile declared active authority without rewriting origin', async t => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  fixture.exampleImplementation = await implementExample(fixture);
  await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING + '\n\n' + ACTIVE_FINDING_02 });
  const correction = await correctExample(fixture, { content: VALIDATED_CONTENT, verified: 'finding-01', unsupported: 'finding-02', publish: false });
  const cases = [
    ['duplicate findings IDs', text => text.replace('- Finding IDs: finding-01, finding-02', '- Finding IDs: finding-01, finding-01'), /duplicate Finding IDs/],
    ['unordered findings IDs', text => text.replace('- Finding IDs: finding-01, finding-02', '- Finding IDs: finding-02, finding-01'), /Finding IDs are not lexicographically ordered/],
    ['unknown findings ID', text => text.replace('- Finding IDs: finding-01, finding-02', '- Finding IDs: finding-01, finding-99'), /undeclared Finding ID finding-99/],
    ['malformed findings IDs', text => text.replace('- Finding IDs: finding-01, finding-02', '- Finding IDs: finding-01,finding-02'), /malformed Finding IDs/],
    ['verified must be subset', text => text.replace('- Finding IDs: finding-01, finding-02', '- Finding IDs: finding-01').replace('- Findings verified: finding-01', '- Findings verified: finding-02'), /Findings verified.*subset/],
    ['unsupported must match current active set', text => text.replace('- Unsupported active findings: finding-02', '- Unsupported active findings: none'), /Unsupported active findings/],
    ['correction must have paths', text => replaceSection(text, 'Corrections Applied', '- none'), /Findings Test Evidence requires Corrections Applied/],
    ['same-attempt resolution', text => text.replace('- State: active\n- Origin: attempt-01', '- State: resolved\n- Resolution: attempt-01 claims immediate resolution\n- Origin: attempt-01'), /strictly later|later formal attempt/],
    ['same-origin supersession', text => text.replace('- State: active\n- Origin: attempt-01', '- State: superseded\n- Superseded by: finding-02\n- Origin: attempt-01'), /origin must be strictly later/],
    ['backward supersession', text => text.replace('### finding-02\n\n- Severity: blocking\n- State: active', '### finding-02\n\n- Severity: blocking\n- State: superseded\n- Superseded by: finding-01'), /invalid Superseded by/],
  ];
  assert.equal((await rejectTaskMutations(fixture, correction.copy, cases)).state, 'FINDINGS_CORRECTED');
  const subsetTask = await fs.readFile(correction.copy.candidateTaskArtifact, 'utf8');
  const unchangedLive = await treeBytes(fixture.execution), unchangedCandidate = await treeBytes(correction.copy.candidateExecutionRoot);
  for (const [verified, unsupported] of [['finding-01, finding-02', 'none'], ['none', 'finding-01, finding-02']]) {
    const text = subsetTask.replace('- Findings verified: finding-01', '- Findings verified: ' + verified).replace('- Unsupported active findings: finding-02', '- Unsupported active findings: ' + unsupported);
    assert.notEqual(text, subsetTask);
    assert.equal((await validateExecutionCandidate(fixture.requirements, correction.copy.candidateExecutionRoot, [{ slice: 'slice-01', text }])).state, 'FINDINGS_CORRECTED');
    assert.deepEqual(await treeBytes(fixture.execution), unchangedLive);
    assert.deepEqual(await treeBytes(correction.copy.candidateExecutionRoot), unchangedCandidate);
  }
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: correction.copy.candidateRoot });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, 'FINDINGS_CORRECTED');
});

test('canonical partial correction revalidates NEEDS_FIX then PASS with immutable finding origins and attempts', async t => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  fixture.exampleImplementation = await implementExample(fixture);
  await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  const initial = (await inspectExecutionState(fixture.requirements)).tasks.get('slice-01').attempts[0].body;
  await correctExample(fixture, { content: VALIDATED_CONTENT });
  const firstResolved = ACTIVE_FINDING.replace('State: active', 'State: resolved') + '\n- Resolution: attempt-02 confirms the first correction.';
  const second = ACTIVE_FINDING_02.replace('Origin: attempt-01', 'Origin: attempt-02');
  await validateExample(fixture, { status: 'NEEDS_FIX', findings: firstResolved + '\n\n' + second, dispositions: 'finding-01=resolved, finding-02=active' });
  const partial = (await inspectExecutionState(fixture.requirements)).tasks.get('slice-01');
  assert.deepEqual(partial.findings.map(f => [f.id, f.state]), [['finding-01', 'resolved'], ['finding-02', 'active']]);
  assert.equal((await preflightExecutionOperation(fixture.requirements, 'APPLY_FINDINGS', '1')).state, 'VALIDATION_NEEDS_FIX');
  await correctExample(fixture, { verified: 'finding-02', content: VALIDATED_CONTENT });
  const secondResolved = second.replace('State: active', 'State: resolved') + '\n- Resolution: attempt-03 confirms the second correction.';
  await validateExample(fixture, { findings: firstResolved + '\n\n' + secondResolved, dispositions: 'finding-01=resolved, finding-02=resolved' });
  const complete = await inspectExecutionState(fixture.requirements), task = complete.tasks.get('slice-01');
  assert.equal(complete.state, 'COMPLETE'); assert.equal(task.attempts[0].body, initial);
  assert.equal(task.attempts[1].body, partial.attempts[1].body);
  assert.deepEqual(task.attempts.map(a => [a.id, a.status]), [['attempt-01', 'NEEDS_FIX'], ['attempt-02', 'NEEDS_FIX'], ['attempt-03', 'PASS']]);
  assert.deepEqual(task.findings.map(f => [f.id, f.origin, f.state]), [['finding-01', 'attempt-01', 'resolved'], ['finding-02', 'attempt-02', 'resolved']]);
  assert.deepEqual(task.findingsChecks.map(c => [c.id, c.findingsCycle]), [['findings-check-01', 'attempt-01'], ['findings-check-02', 'attempt-02']]);
});

function assertExhaustedHandoff(fixture, state, operation, prefix) {
  assertRecoveryTarget(state, { operation: 'VALIDATE_SLICE', slice: 'slice-01', owner: 'retry-exhaustion', record: `${prefix}-03`, round: 3, retryState: state.state });
  assert.equal(state.normalHandoff, null);
  assert.deepEqual(state.requiredRecoveryHandoff, { workflowSkill: 'stnl-slice-quality-manager', operation: 'VALIDATE_SLICE', invocation: 'OPERATION=VALIDATE_SLICE', slice: 'slice-01' });
  const result = spawnSync(process.execPath, [path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs'), fixture.requirements, '--handoff-after', operation], { encoding: 'utf8', cwd: fixture.root });
  assert.equal(result.status, 0, result.stderr);
  const handoff = JSON.parse(result.stdout);
  assert.equal(handoff.normal_handoff, null); assert.deepEqual(handoff.required_recovery_handoff, state.requiredRecoveryHandoff);
}

test('canonical third failed automatic round preserves cumulative paths and permits only formal continuation', async t => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  const first = await implementExample(fixture, { failFirst: true, publish: false });
  const second = await retryExample(fixture, first, 'second incorrect example\n', { status: 'TESTS_FAIL', publish: false });
  const unchangedProduct = await fs.readFile(path.join(fixture.root, 'src/example.txt'));
  const third = await retryExample(fixture, second, undefined, { status: 'TESTS_FAIL', publish: false });
  assert.deepEqual(await fs.readFile(path.join(fixture.root, 'src/example.txt')), unchangedProduct);
  const copy = first.copy;
  assert.equal((await rejectTaskMutations(fixture, copy, [
    ['implementation cannot resume exhausted operation', text => replaceSection(text, 'Delegation Blocker', delegationBlocker('EXECUTE_SLICE', 'initialization', { after: 'implementation-check-03' })), /cannot resume.*third-failure exhaustion/],
    ['exhaustion cannot carry active divergence', text => replaceSection(text, 'Divergences', ACTIVE_DIVERGENCE), /third-failure exhaustion.*active blocking divergence/],
    ['round four is rejected', text => text.replace('Automatic check round: 3/3', 'Automatic check round: 4/3'), /Automatic check round/],
    ['skipped check identifier', text => text.replace('### implementation-check-03', '### implementation-check-04'), /identifiers must be contiguous/],
    ['duplicate round', text => text.replace('Automatic check round: 3/3', 'Automatic check round: 2/3'), /round|sequential/],
    ['non-initial first round', text => text.replace(first.bundle, second.bundle.replace('### implementation-check-02', '### implementation-check-01')), /start its automatic check cycle at round 1\/3/],
    ['skipped second round', text => text.replace(second.bundle, second.bundle.replace('Automatic check round: 2/3', 'Automatic check round: 3/3')), /round 2\/3/],
    ['second round needs correction explanation', text => text.replace(second.bundle, second.bundle.replace(/^- Correction applied:.*\n/mu, '')), /Correction applied/],
  ])).state, 'IMPLEMENTATION_RETRY_EXHAUSTED');
  const privateText = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  for (const check of [first, second, third]) assert.ok(privateText.includes(check.bundle));
  assert.match(third.bundle, /- Correction paths: none/);
  assert.match(third.bundle, /- Tested state:\n  - `\.\.\/\.\.\/src\/example\.txt` \| sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(third.bundle, /Fileless reason:/);
  assert.match(privateText, /## Corrections Applied\n\n- `..\/..\/src\/example.txt`/);
  assert.match(second.bundle, /- Correction paths: ..\/..\/src\/example.txt/);
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: copy.candidateRoot });
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, 'IMPLEMENTATION_RETRY_EXHAUSTED');
  assertExhaustedHandoff(fixture, state, 'EXECUTE_SLICE', 'implementation-check');
  const invalidSlice = await rejectedWithRecovery(preflightExecutionOperation(fixture.requirements, 'VALIDATE_SLICE', '01'), /SLICE must be one unsigned decimal/);
  assertRecoveryTarget(invalidSlice, { operation: 'VALIDATE_SLICE', slice: 'slice-01' });
  assert.deepEqual(state.legalOperations.filter(op => op.slice), [{ operation: 'VALIDATE_SLICE', slice: 'slice-01' }]);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, 'EXECUTE_SLICE', '1'), /not legal|not allowed|requires|exhausted/);
  assert.equal((await preflightExecutionOperation(fixture.requirements, 'VALIDATE_SLICE', '1')).state, 'IMPLEMENTATION_RETRY_EXHAUSTED');
});

test('canonical findings exhaustion retains active authority and all three observed failures', async t => {
  const fixture = await standaloneWorkspace(t); await renderArtifacts(fixture);
  fixture.exampleImplementation = await implementExample(fixture);
  await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  const initial = (await inspectExecutionState(fixture.requirements)).tasks.get('slice-01');
  const first = await correctExample(fixture, { content: 'first incorrect correction\n', fail: true, publish: false });
  const second = await retryFindingsExample(fixture, first, { content: 'second incorrect correction\n', fail: true, publish: false });
  const third = await retryFindingsExample(fixture, second, { fail: true, publish: false });
  assert.equal((await rejectTaskMutations(fixture, first.copy, [
    ['findings exhausted divergence conflict', text => replaceSection(text, 'Divergences', ACTIVE_DIVERGENCE.replace('Origin: EXECUTE_SLICE', 'Origin: APPLY_FINDINGS')), /third-failure exhaustion.*active blocking divergence/],
    ['findings cannot resume exhausted operation', text => replaceSection(text, 'Delegation Blocker', delegationBlocker('APPLY_FINDINGS', 'initialization', { after: 'findings-check-03' })), /cannot resume.*third-failure exhaustion/],
  ])).state, 'FINDINGS_RETRY_EXHAUSTED');
  const text = await fs.readFile(first.copy.candidateTaskArtifact, 'utf8');
  for (const check of [first, second, third]) assert.ok(text.includes(check.bundle));
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: first.copy.candidateRoot });
  const state = await inspectExecutionState(fixture.requirements), task = state.tasks.get('slice-01');
  assert.equal(state.state, 'FINDINGS_RETRY_EXHAUSTED');
  assert.equal((await preflightExecutionOperation(fixture.requirements, 'VALIDATE_SLICE', '1')).state, 'FINDINGS_RETRY_EXHAUSTED');
  assertExhaustedHandoff(fixture, state, 'APPLY_FINDINGS', 'findings-check');
  assert.deepEqual(state.legalOperations.filter(op => op.slice), [{ operation: 'VALIDATE_SLICE', slice: 'slice-01' }]);
  assert.equal(task.findings[0].body, initial.findings[0].body);
  assert.equal(task.attempts[0].body, initial.attempts[0].body);
  assert.equal(task.implementationChecks[0].body, initial.implementationChecks[0].body);
  assert.deepEqual(task.findingsChecks.map(check => [check.id, check.round, check.status]), [[ 'findings-check-01', 1, 'TESTS_FAIL' ], [ 'findings-check-02', 2, 'TESTS_FAIL' ], [ 'findings-check-03', 3, 'TESTS_FAIL' ]]);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, 'APPLY_FINDINGS', '1'), /not legal|not allowed|requires|exhausted/);
});

test("canonical interrupted automatic checks preserve origins through blocking publication and approved recovery", async (t) => {
  for (const round of [1, 2]) for (const disposition of ['active', 'resolved', 'superseded']) {
    await t.test(`${disposition} divergence after round ${round}/3`, async child => {
      const fixture = await standaloneWorkspace(child);
      const { authority } = await renderArtifacts(fixture);
      const first = await implementExample(fixture, { failFirst: true, publish: false });
      const last = round === 1 ? first : await retryExample(fixture, first, 'still incorrect example bytes\n', { status: 'TESTS_FAIL', publish: false });
      const copy = first.copy, task = copy.candidateTaskArtifact;
      const unterminated = await fs.readFile(task, 'utf8'), liveBeforeBlock = await treeBytes(fixture.execution);
      // No divergence and advisory alone must not release the active owner.
      for (const body of ['- none', ACTIVE_DIVERGENCE.replace('Severity: blocking', 'Severity: advisory')]) {
        await fs.writeFile(task, replaceSection(unterminated, 'Divergences', body));
        const candidateBefore = await treeBytes(copy.candidateExecutionRoot);
        await assert.rejects(publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: copy.candidateRoot }), round === 1 ? /unterminated implementation automatic correction cycle/ : /terminal publication requires the bounded operation result/);
        assert.deepEqual(await treeBytes(fixture.execution), liveBeforeBlock);
        assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), candidateBefore);
        assert.equal((await readExecutionActivation(fixture.requirements)).activation.activeAttempt.operationAttemptId, first.admission.owner.operationAttemptId);
      }
      await fs.writeFile(task, unterminated);
      const advisory = ACTIVE_DIVERGENCE.replace('divergence-01', 'divergence-02').replace('Severity: blocking', 'Severity: advisory');
      await fs.writeFile(task, replaceSection(await fs.readFile(task, 'utf8'), 'Divergences', ACTIVE_DIVERGENCE + '\n\n' + advisory));
      const receipts = await Promise.all([first, ...(round === 2 ? [last] : [])].map(async check => [check.captured.receiptFile, await fs.readFile(check.captured.receiptFile)]));
      const positive = await rejectTaskMutations(fixture, copy, [
        ['active resolution is illegal', text => text.replace('## Divergences\n', '## Divergences\n').replace('State: active\n- Origin: EXECUTE_SLICE', 'State: active\n- Resolution: invalid\n- Origin: EXECUTE_SLICE'), /active state cannot contain resolution fields/],
        ['uncommitted resolution owner', text => text.replace('State: active\n- Origin: EXECUTE_SLICE', 'State: resolved\n- Resolution: plan revision 2 committed recovery slice-02\n- Origin: EXECUTE_SLICE').replace('Severity: advisory', 'Severity: blocking'), /resolution has no committed supersession owner/],
        ['uncommitted superseded resolution owner', text => replaceSection(text, 'Divergences',
          ACTIVE_DIVERGENCE.replace('State: active', 'State: superseded') + '\n- Superseded by: divergence-02\n\n'
          + ACTIVE_DIVERGENCE.replace('divergence-01', 'divergence-02').replace('State: active', 'State: resolved')
          + '\n- Resolution: plan revision 2 committed recovery slice-02\n\n'
          + ACTIVE_DIVERGENCE.replace('divergence-01', 'divergence-03')), /no committed (?:supersession|recovery) owner/],
        ['unknown authority operation', text => text.replace('Required authority operation: REPLAN', 'Required authority operation: DELETE_MANUALLY'), /invalid Required authority operation/],
        ['duplicate disposition', text => text.replace('State: active\n- Origin: EXECUTE_SLICE', 'State: active\n- State: resolved\n- Origin: EXECUTE_SLICE'), /exactly one.*State/],
        ['invalid divergence successor', text => text.replace('State: active\n- Origin: EXECUTE_SLICE', 'State: superseded\n- Superseded by: divergence-99\n- Origin: EXECUTE_SLICE'), /invalid Superseded by/],
      ]);
      assert.equal(positive.state, 'DIVERGENCE_BLOCKED');
      const published = await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: copy.candidateRoot });
      assert.equal(published.state, 'DIVERGENCE_BLOCKED');
      const before = await inspectExecutionState(fixture.requirements);
      assert.equal((await readExecutionActivation(fixture.requirements)).activation.activeAttempt, null);
      assert.equal((await preflightExecutionOperation(fixture.requirements, 'REPLAN')).state, 'DIVERGENCE_BLOCKED');
      const history = before.tasks.get('slice-01').sections.get('Implementation Test Evidence');
      assert.ok(history.includes(first.bundle)); assert.ok(history.includes(last.bundle));
      await appendRecoveryPlan(fixture, authority, authority);
      await reviewJointFixture(fixture, { editCandidate: async root => {
        if (disposition === 'active') return;
        const file = path.join(root, 'tasks/slice-01.md');
        const text = await fs.readFile(file, 'utf8');
        const record = disposition === 'resolved'
          ? ACTIVE_DIVERGENCE.replace('State: active', 'State: resolved') + '\n- Resolution: plan revision 2 committed recovery slice-02'
          : ACTIVE_DIVERGENCE.replace('State: active', 'State: superseded') + '\n- Superseded by: divergence-02';
        await fs.writeFile(file, replaceSection(text, 'Divergences', record + '\n\n' + advisory));
        if (round === 1 && disposition === 'resolved') {
          await preparePlanCandidate({ candidateExecutionRoot: root });
          await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: root });
          await captureApprovedPreparation({ candidateExecutionRoot: root, reviewDecision });
          await validateExecutionCandidate(fixture.requirements, root);
          await fs.rm(path.join(root, 'approved-preparation.json'), { force: true });
          const validTask = await fs.readFile(file, 'utf8'), live = await treeBytes(fixture.execution);
          for (const [label, mutate, diagnostic] of [
            ['problem', value => value.replace('Approved scope omits', 'Rewritten scope omits'), /historical finding origin\/description rewritten/],
            ['evidence', value => value.replace('The implementation cannot', 'The revised implementation cannot'), /historical finding origin\/description rewritten/],
            ['origin', value => value.replace('Origin: EXECUTE_SLICE', 'Origin: APPLY_FINDINGS'), /historical finding origin\/description rewritten/],
            ['advisory disposition', value => value.replace('Severity: advisory\n- State: active', 'Severity: advisory\n- State: resolved\n- Resolution: plan revision 2 committed recovery slice-02'), /Divergences rewrote historical evidence/],
          ]) {
            const invalidTask = mutate(validTask); assert.notEqual(invalidTask, validTask, label);
            await fs.writeFile(file, invalidTask);
            // Review snapshot reflects exactly this proposal, so rejection must
            // be historical authorization, never a stale review hash.
            const candidate = await readPreparationArtifacts(root);
            await assert.rejects(publishPreparationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: root, reviewDecision }), diagnostic);
            assert.deepEqual(await treeBytes(fixture.execution), live);
            assert.deepEqual(await readPreparationArtifacts(root), candidate);
            await fs.rm(path.join(root, 'approved-preparation.json'), { force: true });
          }
          await fs.writeFile(file, validTask);
        }
      } });
      const recovered = await inspectExecutionState(fixture.requirements), previous = recovered.tasks.get('slice-01');
      assert.equal(previous.final.result, 'SUPERSEDED'); assert.equal(previous.final.supersededBy, 'slice-02');
      assert.equal(previous.final.planRevision, 2);
      assert.equal(previous.divergences[0].state, disposition);
      assert.equal(previous.divergences[1].body, advisory.slice(advisory.indexOf('- Severity:')));
      assert.equal(previous.sections.get('Implementation Test Evidence'), history);
      assert.equal(recovered.normalHandoff.operation, 'EXECUTE_SLICE'); assert.equal(recovered.normalHandoff.slice, 'slice-02');
      for (const [file, bytes] of receipts) assert.deepEqual(await fs.readFile(file), bytes);
    });
  }
});

test("approved supersession preserves interrupted automatic checks with a committed recovery owner", async t => {
  // Both interrupted rounds and active/resolved dispositions use the unchanged
  // canonical interrupted-check producer tests. These are the remaining owner
  // and terminal-index guards on the same genuine reviewed recovery candidate.
  const f = await standaloneWorkspace(t); const { authority } = await renderArtifacts(f);
  const failed = await implementExample(f, { failFirst: true, publish: false });
  await fs.writeFile(failed.copy.candidateTaskArtifact,
    replaceSection(await fs.readFile(failed.copy.candidateTaskArtifact, 'utf8'), 'Divergences', ACTIVE_DIVERGENCE));
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-01', candidateRoot: failed.copy.candidateRoot });
  assert.equal((await inspectExecutionState(f.requirements)).state, 'DIVERGENCE_BLOCKED');
  const receipt = await fs.readFile(failed.captured.receiptFile);
  await appendRecoveryPlan(f, authority, authority);
  await reviewJointFixture(f, { editCandidate: async root => {
    await preparePlanCandidate({ candidateExecutionRoot: root });
    await serializePlanPathClaims({ specPath: f.requirements, candidateExecutionRoot: root });
    await captureApprovedPreparation({ candidateExecutionRoot: root, reviewDecision });
    const consume = () => validateExecutionCandidate(f.requirements, root);
    assert.equal((await consume()).state, 'EXECUTION_STARTED');
    const live = await treeBytes(f.execution);
    for (const [name, relative, mutate, diagnostic] of [
      ['missing terminal index', 'tasks.md', text => text.replace('SUPERSEDED | SUPERSEDED', 'pending | pending'), /global and detailed state disagree/],
      ['missing recovery owner', 'tasks/slice-01.md', text => text.replace('Superseded by: slice-02', 'Superseded by: slice-99'), /not a committed supersession mapping/],
      ['wrong committing revision', 'tasks/slice-01.md', text => text.replace('- Plan revision: 2', '- Plan revision: 3'), /committing Plan revision|committed supersessions do not exactly match/],
    ]) {
      const file = path.join(root, relative), original = await fs.readFile(file, 'utf8');
      const mutant = mutate(original); assert.notEqual(mutant, original, name);
      await fs.writeFile(file, mutant); const rejected = await treeBytes(root);
      await assert.rejects(consume(), diagnostic, name);
      assert.deepEqual(await treeBytes(root), rejected, name + ': candidate retained');
      assert.deepEqual(await treeBytes(f.execution), live, name + ': live retained');
      await fs.writeFile(file, original); assert.equal((await consume()).state, 'EXECUTION_STARTED');
    }
    await fs.rm(path.join(root, 'approved-preparation.json'), { force: true });
  } });
  const resumed = await inspectExecutionState(f.requirements), historical = resumed.tasks.get('slice-01');
  assert.equal(historical.final.result, 'SUPERSEDED'); assert.equal(historical.final.supersededBy, 'slice-02');
  assert.equal(historical.final.planRevision, 2); assert.equal(historical.divergences[0].state, 'active');
  assert.ok(historical.sections.get('Implementation Test Evidence').includes(failed.bundle));
  assert.deepEqual(await fs.readFile(failed.captured.receiptFile), receipt);
  assert.equal(resumed.normalHandoff.operation, 'EXECUTE_SLICE'); assert.equal(resumed.normalHandoff.slice, 'slice-02');
});


test("interrupted checks cannot forge supersession in the original plan revision", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await editTask(fixture, (text) => replaceSection(replaceSection(replaceSection(text,
    "Changed Areas", "- `../../src/example.txt`"),
    "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_FAIL", 1)),
  "Final Result", "- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 1"));
  await editTasksIndex(fixture, (text) => text.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | SUPERSEDED | SUPERSEDED |"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /SUPERSEDED.*committing Plan revision/u);
});

test("a later missing integration slice has an executable append-only REPLAN path", async t => {
  const f = await standaloneWorkspace(t); const { authority } = await renderArtifacts(f);
  await implementExample(f); const formal = await validateExample(f);
  const passed = (await inspectExecutionState(f.requirements)).tasks.get('slice-01');
  const receipt = await fs.readFile(formal.captured.receiptFile);
  assert.equal((await preflightExecutionOperation(f.requirements, 'REPLAN')).state, 'COMPLETE');
  // The new integration contribution does not take the completed AC's integral
  // ownership away from slice-01 or pretend that its earlier proof was missing.
  await appendRecoveryPlan(f, authority, authority, { supersedes: 'none', newContribution: 'partial' });
  assert.equal((await preflightExecutionOperation(f.requirements, 'REVIEW_PLAN')).state, 'PENDING_REPLAN_DRAFT');
  await reviewJointFixture(f, { editCandidate: async root => {
    const file = path.join(root, 'tasks/slice-01.md'), original = await fs.readFile(file, 'utf8');
    const mutant = replaceSection(original, 'Final Result', '- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 2');
    assert.notEqual(mutant, original); await fs.writeFile(file, mutant);
    const live = await treeBytes(f.execution), rejected = await readPreparationArtifacts(root);
    await assert.rejects(publishPreparationCandidate({ specPath: f.requirements, candidateExecutionRoot: root, reviewDecision }),
      /SUPERSEDED must not retain an Effective Validation Base/);
    assert.deepEqual(await treeBytes(f.execution), live);
    assert.deepEqual(await readPreparationArtifacts(root), rejected);
    await fs.writeFile(file, original); await fs.rm(path.join(root, 'approved-preparation.json'), { force: true });
  } });
  const resumed = await inspectExecutionState(f.requirements), historical = resumed.tasks.get('slice-01');
  assert.equal(historical.final.result, 'PASS'); assert.equal(historical.attempts[0].body, passed.attempts[0].body);
  assert.equal(historical.sections.get('Effective Validation Base'), passed.sections.get('Effective Validation Base'));
  assert.equal(historical.base.present, true);
  assert.equal(resumed.normalHandoff.operation, 'EXECUTE_SLICE'); assert.equal(resumed.normalHandoff.slice, 'slice-02');
  assert.equal((await preflightExecutionOperation(f.requirements, 'EXECUTE_SLICE', '2')).state, 'EXECUTION_STARTED');
  assert.deepEqual(await fs.readFile(formal.captured.receiptFile), receipt);
});

test("superseded historical paths become terminal only through a later current-authority PASS", async (t) => {
  const fixture = await standaloneWorkspace(t); const { authority: oldHash } = await renderArtifacts(fixture);
  const first = await implementExample(fixture);
  const firstReceipt = await fs.readFile(first.captured.receiptFile);
  await fs.appendFile(fixture.requirements, '- AC-002: corrective integration\n');
  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await appendRecoveryPlan(fixture, oldHash, newHash, { ready: true });
  const recovery = await inspectExecutionState(fixture.requirements);
  assert.equal(recovery.tasks.get('slice-01').final.result, 'SUPERSEDED');
  assert.equal(recovery.normalHandoff.slice, 'slice-02'); assert.notEqual(recovery.state, 'COMPLETE');
  await implementExample(fixture, { slice: 'slice-02' });
  const beforePass = await inspectExecutionState(fixture.requirements);
  assert.equal(beforePass.state, 'IMPLEMENTED_AWAITING_VALIDATION');
  assert.equal(beforePass.tasks.get('slice-02').attempts.length, 0);
  const formal = await validateExample(fixture, { slice: 'slice-02' });
  const complete = await inspectExecutionState(fixture.requirements);
  assert.equal(complete.state, 'COMPLETE');
  assert.deepEqual(complete.legalOperations, [{ operation: 'REPLAN', slice: null }]);
  assert.equal(complete.normalHandoff, null);
  assert.equal((await preflightExecutionOperation(fixture.requirements, 'REPLAN')).state, 'COMPLETE');
  assert.equal(complete.tasks.get('slice-01').final.supersededBy, 'slice-02');
  assert.ok(complete.tasks.get('slice-01').sections.get('Implementation Test Evidence').includes(first.bundle));
  assert.equal(complete.tasks.get('slice-02').attempts.at(-1).status, 'PASS');
  assert.deepEqual(await fs.readFile(first.captured.receiptFile), firstReceipt);
  assert.equal(JSON.parse(await fs.readFile(formal.captured.receiptFile)).operation, 'VALIDATE_SLICE');
});

test("attempt/check numbering, unresolved blockers at PASS, and structural gates reject deterministically", async t => {
  const f = await standaloneWorkspace(t); await renderArtifacts(f);
  const impl = await implementExample(f, { publish: false });
  await rejectTaskMutations(f, impl.copy, [
    ['check numbering', text => text.replace('### implementation-check-01', '### implementation-check-02'), /contiguous from 01/],
    ['unlisted correction', text => replaceSection(text, 'Corrections Applied', '- `../../src/other.txt`'), /correction path is absent from Changed Areas/],
    ['nested path claim', text => replaceSection(text, 'Changed Areas', '- `../../src/example.txt`\n  - `../../src/hidden.txt`'), /canonical task-relative path claims/],
    ['prose path claim', text => replaceSection(text, 'Changed Areas', '- `../../src/example.txt`\n- arbitrary prose'), /canonical task-relative path claims/],
    ['unordered claims', text => replaceSection(text, 'Changed Areas', '- `../../src/z.txt`\n- `../../src/a.txt`'), /not lexicographically ordered/],
    ['duplicate claims', text => replaceSection(text, 'Changed Areas', '- `../../src/example.txt`\n- `../../src/example.txt`'), /duplicate path claims/],
  ]);
  const task = await fs.readFile(impl.copy.candidateTaskArtifact, 'utf8');
  const live = await treeBytes(f.execution), candidate = await treeBytes(impl.copy.candidateExecutionRoot);
  const divergent = replaceSection(task, 'Divergences', ACTIVE_DIVERGENCE);
  assert.notEqual(divergent, task);
  assert.equal((await validateExecutionCandidate(f.requirements, impl.copy.candidateExecutionRoot, [{ slice: 'slice-01', text: divergent }])).state, 'DIVERGENCE_BLOCKED');
  assert.deepEqual(await treeBytes(f.execution), live); assert.deepEqual(await treeBytes(impl.copy.candidateExecutionRoot), candidate);
  await publishExecutionCopy({ specPath: f.requirements, slice: 'slice-01', candidateRoot: impl.copy.candidateRoot });
  const formal = await validateExample(f, { publish: false });
  const copy = { ...formal.copy, candidateTaskArtifact: path.join(formal.copy.candidateExecutionRoot, 'tasks/slice-01.md') };
  const base = (text, mutate) => replaceSection(text, 'Effective Validation Base', mutate(text.split('## Effective Validation Base\n\n')[1].split('\n## ')[0].trim()));
  const backward = ACTIVE_FINDING + '\n\n' + ACTIVE_FINDING_02.replace('State: active', 'State: superseded') + '\n- Superseded by: finding-01\n\n' + ACTIVE_FINDING.replaceAll('finding-01', 'finding-03');
  await rejectTaskMutations(f, copy, [
    ['formal checklist required', text => text.replace('- [x] 1.1', '- [ ] 1.1'), /Validation Attempts before the mandatory checklist is complete/],
    ['backward supersession', text => replaceSection(text, 'Validation Findings', backward), /finding-02 has invalid Superseded by/],
    ['unpublished PASS', text => replaceSection(text, 'Final Result', '- pending'), /latest PASS attempt was not published atomically/],
    ['base attempt type', text => base(text, value => value.replace('- Attempt type: initial', '- Attempt type: revalidation')), /Attempt type disagrees/],
    ['base HEAD', text => base(text, value => value.replace('- HEAD: offline-example', '- HEAD: unrelated')), /HEAD disagrees/],
    ['base path grammar', text => base(text, value => value.replace('`../../src/example.txt`', 'malformed')), /malformed Files manifest/],
    ['base evidence placeholder', text => base(text, value => value.replace(/^- Evidence summary:.*$/mu, '- Evidence summary: pending')), /Evidence summary/],
  ]);
  await publishValidationCandidate({ specPath: f.requirements, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot, owner: formal.admission.owner });
  assert.equal((await inspectExecutionState(f.requirements)).state, 'COMPLETE');
  // Active finding origins require a real NEEDS_FIX, then an actual correction
  // and revalidation. A first PASS cannot manufacture that historical origin.
  const finding = await standaloneWorkspace(t); await renderArtifacts(finding);
  finding.exampleImplementation = await implementExample(finding);
  const initial = await validateExample(finding, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING });
  await correctExample(finding, { content: VALIDATED_CONTENT });
  const resolved = ACTIVE_FINDING.replace('- State: active', '- State: resolved') + '\n- Resolution: attempt-02 confirmed the correction.';
  const revalidation = await validateExample(finding, { findings: resolved, dispositions: 'finding-01=resolved', publish: false });
  const revalidationCopy = { ...revalidation.copy, candidateTaskArtifact: path.join(revalidation.copy.candidateExecutionRoot, 'tasks/slice-01.md') };
  const receipt = await fs.readFile(initial.captured.receiptFile);
  await rejectTaskMutations(finding, revalidationCopy, [
    ['active blocker at PASS', text => replaceSection(text.replace('- Finding dispositions: finding-01=resolved', '- Finding dispositions: finding-01=active'), 'Validation Findings', ACTIVE_FINDING), /active blocker/],
  ]);
  assert.deepEqual(await fs.readFile(initial.captured.receiptFile), receipt);

});





test("work, corrections, findings authority, terminal diff, and blocker resolution reconcile exactly", async (t) => {
  const pendingChanged = await standaloneWorkspace(t);
  await renderArtifacts(pendingChanged);
  await editTask(pendingChanged, (value) => replaceSection(
    value.replace("- [ ] 1.1", "- [x] 1.1"),
    "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "TESTS_PASS", 1),
  ));
  await assert.rejects(inspectExecutionState(pendingChanged.requirements), /Changed Areas cannot remain pending after work/u);

  const noCorrections = await standaloneWorkspace(t);
  await renderArtifacts(noCorrections);
  await prepareFindingsCorrection(noCorrections);
  await editTask(noCorrections, (value) => replaceSection(value, "Corrections Applied", "- none"));
  await assert.rejects(inspectExecutionState(noCorrections.requirements), /Findings Test Evidence requires Corrections Applied/u);

  const wrongRoundPath = await standaloneWorkspace(t);
  await renderArtifacts(wrongRoundPath);
  await editTask(wrongRoundPath, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    const records = `${checkRecord("implementation-check", 1, "TESTS_FAIL", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 2).replace("- Correction paths: ../../src/example.txt", "- Correction paths: ../../src/other.txt")}`;
    return replaceSection(result, "Implementation Test Evidence", records);
  });
  await assert.rejects(inspectExecutionState(wrongRoundPath.requirements), /Correction paths.*Corrections Applied/u);

  const wrongAttemptIds = await standaloneWorkspace(t);
  await renderArtifacts(wrongAttemptIds);
  await editTask(wrongAttemptIds, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", attemptRecord(1, "NEEDS_FIX", {
      references: "finding-99",
      dispositions: "finding-99=active",
    }));
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  await assert.rejects(inspectExecutionState(wrongAttemptIds.requirements), /undeclared finding-99/u);

  const contradictoryTimeline = await standaloneWorkspace(t);
  await renderArtifacts(contradictoryTimeline);
  await editTask(contradictoryTimeline, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", [
      NEEDS_FIX_ATTEMPT,
      attemptRecord(2, "NEEDS_FIX", { references: "finding-01", dispositions: "finding-01=resolved" }),
      attemptRecord(3, "NEEDS_FIX", { references: "finding-01", dispositions: "finding-01=active" }),
    ].join("\n\n"));
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  await assert.rejects(inspectExecutionState(contradictoryTimeline.requirements), /disposition contradicts.*timeline/u);

  const historicalUnsupported = await standaloneWorkspace(t);
  await renderArtifacts(historicalUnsupported);
  await editTask(historicalUnsupported, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", [
      attemptRecord(1, "NEEDS_FIX", {
        references: "finding-01, finding-02",
        dispositions: "finding-01=active, finding-02=active",
      }),
      attemptRecord(2, "NEEDS_FIX", {
        references: "finding-01, finding-02",
        dispositions: "finding-01=active, finding-02=active",
      }),
    ].join("\n\n"));
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING}\n\n${ACTIVE_FINDING_02}`);
    return replaceSection(result, "Findings Test Evidence", checkRecord(
      "findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" },
    ));
  });
  await assert.rejects(inspectExecutionState(historicalUnsupported.requirements), /Unsupported active findings contradict/u);

  const unsupportedContradiction = await standaloneWorkspace(t);
  await renderArtifacts(unsupportedContradiction);
  await prepareFindingsCorrection(unsupportedContradiction);
  await editTask(unsupportedContradiction, (value) => value.replace(
    "- Unsupported active findings: none",
    "- Unsupported active findings: finding-01",
  ));
  await assert.rejects(inspectExecutionState(unsupportedContradiction.requirements), /Unsupported active findings contradict/u);

  const pendingDiff = await standaloneWorkspace(t);
  await renderArtifacts(pendingDiff);
  await editTask(pendingDiff, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return replaceSection(result, "Final Result", "- PASS");
  });
  await editTasksIndex(pendingDiff, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(pendingDiff.requirements), /Diff Summary must be objective non-placeholder content/u);

  const blockerWithPendingChangedAreas = await standaloneWorkspace(t);
  await renderArtifacts(blockerWithPendingChangedAreas);
  await editTask(blockerWithPendingChangedAreas, (value) => replaceSection(
    value,
    "Delegation Blocker",
    delegationBlocker("EXECUTE_SLICE", "initialization"),
  ));
  await assert.rejects(inspectExecutionState(blockerWithPendingChangedAreas.requirements), /Changed Areas cannot remain pending after work/u);

  const diffWithPendingChangedAreas = await standaloneWorkspace(t);
  await renderArtifacts(diffWithPendingChangedAreas);
  await editTask(diffWithPendingChangedAreas, (value) => replaceSection(
    value,
    "Diff Summary",
    "- Implemented the observable behavior.",
  ));
  await assert.rejects(inspectExecutionState(diffWithPendingChangedAreas.requirements), /Changed Areas cannot remain pending after work/u);

  const wrongResolution = await standaloneWorkspace(t);
  await renderArtifacts(wrongResolution);
  await editTask(wrongResolution, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization", {
      state: "resolved",
      resolution: "attempt-01 returned a valid result",
    }));
  });
  await assert.rejects(inspectExecutionState(wrongResolution.requirements), /Resolution must name implementation-check-01/u);
});


test("non-canonical execution residue blocks preflight while arbitrary external SPEC siblings remain untouched", async (t) => {
  const root = await temporary(t);
  const workspace = await copyDirectory(path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"), path.join(root, "spec"));
  await fs.mkdir(path.join(workspace, ".git"));
  const fixture = { test: t, root: workspace, requirements: workspace, execution: path.join(workspace, "execution") };
  await renderArtifacts(fixture);
  const external = path.join(workspace, "user-owned.bin");
  await fs.writeFile(external, Buffer.from([1, 2, 3]));
  assert.equal((await inspectExecutionState(workspace)).state, "MATERIALIZED_PRISTINE");
  const residue = path.join(fixture.execution, "scratch.md");
  await fs.writeFile(residue, "preserve\n");
  await assert.rejects(inspectExecutionState(workspace), /unknown official artifact: scratch.md/);
  await assert.rejects(preflightExecutionOperation(workspace, "EXECUTE_SLICE", "1"), /unknown official artifact: scratch.md/);
  await assert.rejects(preflightExecutionOperation(workspace, "VALIDATE_SLICE", "1"), /unknown official artifact: scratch.md/);
  assert.deepEqual(await fs.readFile(external), Buffer.from([1, 2, 3]));
  assert.equal(await fs.readFile(residue, "utf8"), "preserve\n");

  const escaped = await standaloneWorkspace(t);
  await renderArtifacts(escaped);
  const implemented = await implementExample(escaped, { publish: false });
  await rejectTaskMutations(escaped, implemented.copy, [
    ['escaped Changed Areas', text => replaceSection(text, 'Changed Areas', '- `../../../outside.txt`'), /unsafe validation-owned path|escapes logical project/],
  ]);
});

// Uses current joint preparation, activation, native capture and strict publication.
test("Effective Validation Base ownership reproducer covers path basis, hash, drift, and strict readback", async () => {
  await runOwnedContract("base-provenance");
});



// Uses current joint preparation, activation, native capture and strict publication.
test("directory scope selects files but current checks alone take ownership from a prior PASS", async () => {
  await runOwnedContract("directory-owner");
});

// Uses current joint preparation, activation, native capture and strict publication.
test("a new NEEDS_FIX attempt retains the latest findings check as current overlap owner", async () => {
  await runOwnedContract("findings-overlap");
});

async function priorOverlapFixture(t, { samePath = false } = {}) {
  const fixture = await nestedLifecycleWorkspace(t);
  const claim = (name) => path.relative(path.join(fixture.execution, "tasks"), path.join(fixture.root, "src", name)).split(path.sep).join("/");
  const a = claim("example.txt");
  const b = samePath ? a : claim("later.txt");
  const firstPlanRow = (await fs.readFile(path.join(fixture.execution, "plan.md"), "utf8"))
    .split("\n").find((line) => line.startsWith("| 01 - Delivery |"));
  const secondPlanRow = firstPlanRow.replace("01 - Delivery", "02 - Later").replace("| - | AC-001 |", "| 01 | AC-001 |")
    .replace("example.txt", "later.txt").replace("plans/slice-01.md", "plans/slice-02.md");
  const thirdPlanRow = secondPlanRow.replace("02 - Later", "03 - Final").replace("| 01 | AC-001 |", "| 02 | AC-001 |")
    .replace("later.txt", "example.txt").replace("plans/slice-02.md", "plans/slice-03.md");
  await editPlan(fixture, (value) => value.replace(firstPlanRow, `${firstPlanRow}\n${secondPlanRow}\n${thirdPlanRow}`));
  const firstTaskRow = (await fs.readFile(path.join(fixture.execution, "tasks.md"), "utf8"))
    .split("\n").find((line) => line.startsWith("| [ ] | 01 - Delivery |"));
  const secondTaskRow = firstTaskRow.replace("01 - Delivery", "02 - Later").replace("| - | tasks/", "| 01 | tasks/")
    .replace("slice-01.md", "slice-02.md");
  const thirdTaskRow = secondTaskRow.replace("02 - Later", "03 - Final").replace("| 01 | tasks/", "| 02 | tasks/")
    .replace("slice-02.md", "slice-03.md");
  await editTasksIndex(fixture, (value) => value.replace(firstTaskRow, `${firstTaskRow}\n${secondTaskRow}\n${thirdTaskRow}`));
  const firstPlan = await fs.readFile(path.join(fixture.execution, "plans/slice-01.md"), "utf8");
  await fs.writeFile(path.join(fixture.execution, "plans/slice-02.md"), firstPlan.replaceAll("Slice 01", "Slice 02")
    .replaceAll("- Slice: 01", "- Slice: 02").replaceAll("Delivery", "Later"), "utf8");
  await fs.writeFile(path.join(fixture.execution, "plans/slice-03.md"), firstPlan.replaceAll("Slice 01", "Slice 03")
    .replaceAll("- Slice: 01", "- Slice: 03").replaceAll("Delivery", "Final"), "utf8");
  const firstTaskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const firstTask = await fs.readFile(firstTaskPath, "utf8");
  const secondPristine = firstTask.replaceAll("Slice 01", "Slice 02").replaceAll("- Slice: 01", "- Slice: 02")
    .replaceAll("plans/slice-01.md", "plans/slice-02.md").replaceAll("Delivery", "Later").replace("1.1", "2.1");
  const thirdPristine = firstTask.replaceAll("Slice 01", "Slice 03").replaceAll("- Slice: 01", "- Slice: 03")
    .replaceAll("plans/slice-01.md", "plans/slice-03.md").replaceAll("Delivery", "Final").replace("1.1", "3.1");
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-02.md"), secondPristine, "utf8");
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-03.md"), thirdPristine, "utf8");
  let first = firstTask.replace("- [ ] 1.1", "- [x] 1.1");
  first = replaceSection(first, "Changed Areas", `- \`${a}\``);
  first = replaceSection(first, "Validation Attempts", PASS_ATTEMPT);
  first = replaceSection(first, "Effective Validation Base", PASS_BASE.replaceAll("../../src/example.txt", a));
  await fs.writeFile(firstTaskPath, publishPassResult(first), "utf8");
  await writeValidatedPath(fixture, a);
  await editTasksIndex(fixture, (value) => value.replace(firstTaskRow, firstTaskRow.replace("[ ]", "[x]").replace("| pending | pending |", "| PASS | PASS |")));
  const secondTaskPath = path.join(fixture.execution, "tasks/slice-02.md");
  let second = secondPristine.replace("- [ ] 2.1", "- [x] 2.1");
  second = replaceSection(second, "Changed Areas", `- \`${b}\``);
  if (samePath) {
    second = replaceSection(second, "Prior Validation Overlap",
      `- Slice 01 overlap: \`${b}\`; preserve the first validated behavior with focused regressions.`);
  }
  second = replaceSection(second, "Validation Attempts", PASS_ATTEMPT);
  second = replaceSection(second, "Effective Validation Base", PASS_BASE.replaceAll("../../src/example.txt", b));
  await fs.writeFile(secondTaskPath, publishPassResult(second), "utf8");
  await writeValidatedPath(fixture, b);
  await editTasksIndex(fixture, (value) => value.replace(secondTaskRow, secondTaskRow.replace("[ ]", "[x]").replace("| pending | pending |", "| PASS | PASS |")));
  return { fixture, a, b, claim };
}

async function overlapCandidate(fixture, changed, overlap) {
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-03" });
  let task = await fs.readFile(copy.candidateTaskArtifact, "utf8");
  task = task.replace("- [ ] 3.1", "- [x] 3.1");
  task = replaceSection(task, "Changed Areas", changed.map((claim) => `- \`${claim}\``).join("\n"));
  task = replaceSection(task, "Prior Validation Overlap", overlap);
  const testedState = changed.map((claim) => `  - \`${claim}\` | sha256:${VALIDATED_HASH}`).join("\n");
  task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)
    .replace(`  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`, testedState));
  await fs.writeFile(copy.candidateTaskArtifact, task, "utf8");
  return copy;
}

// Uses current joint preparation, activation, native capture and strict publication.
test("prior validation overlap is required before execution publication and preserves valid multi-slice claims", async () => {
  await runOwnedContract("required-overlap");
});

test("terminal PASS inherits only tested superseded paths from its recovery lineage", async (t) => {
  async function recoveryFixture(owner, historicalStatus = "TESTS_PASS") {
    const fixture = await standaloneWorkspace(owner);
    const { authority } = await renderArtifacts(fixture);
    const inherited = "../../src/example.txt";
    const current = "../../src/replacement.txt";
    const unrelated = "../../src/unrelated.txt";
    await writeValidatedPath(fixture, inherited);
    await writeValidatedPath(fixture, current);
    await writeValidatedPath(fixture, unrelated);
    await editTask(fixture, (value) => replaceSection(replaceSection(replaceSection(value,
      "Changed Areas", `- \`${inherited}\``), "Implementation Test Evidence",
    checkRecord("implementation-check", 1, historicalStatus, 1)), "Divergences", ACTIVE_DIVERGENCE));
    await appendRecoveryPlan(fixture, authority, authority, { ready: true });
    await commitAppendRecovery(fixture, authority, authority, { resolveDivergence: true });
    await editPlan(fixture, (value) => value.replace(
      "02 - Recovery | reconciled result | 01 | AC-001 | `../src/example.txt`",
      "02 - Recovery | reconciled result | 01 | AC-001 | `../src/replacement.txt`"));
    await editSlicePlan(fixture, "slice-02", (value) => value.replaceAll("../../src/example.txt", current));
    const taskPath = path.join(fixture.execution, "tasks/slice-02.md");
    let task = await fs.readFile(taskPath, "utf8");
    task = task.replace("- [ ] 1.1", "- [x] 1.1").replaceAll(inherited, current);
    task = replaceSection(task, "Changed Areas", `- \`${current}\``);
    task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replaceAll(inherited, current));
    task = replaceSection(task, "Diff Summary", "- Replacement behavior and inherited source were verified.");
    await fs.writeFile(taskPath, task, "utf8");
    return { fixture, inherited, current, unrelated };
  }

  const { fixture, inherited, current, unrelated } = await recoveryFixture(t);
  const liveTask = path.join(fixture.execution, "tasks/slice-02.md");
  const liveBefore = await fs.readFile(liveTask);
  const parent = await temporary(t, "stnl-terminal-inheritance-");
  const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-02", candidateParent: parent });
  const responseFile = path.join(parent, "validation-response.json");
  await fs.writeFile(responseFile, JSON.stringify(sanitizedValidationResponse("PASS")));
  const prepared = await prepareValidationCandidate({ specPath: fixture.requirements, slice: "2",
    workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, semanticResponseFile: responseFile });
  assert.equal(prepared.formalStatus, "PASS");
  const candidateTask = await fs.readFile(path.join(copy.candidateExecutionRoot, "tasks/slice-02.md"), "utf8");
  const base = sectionBodyForScopeTest(candidateTask, "Effective Validation Base");
  assert.ok(base.includes("- `" + inherited + "` | sha256:" + VALIDATED_HASH));
  assert.ok(base.includes("- `" + current + "` | sha256:" + VALIDATED_HASH));
  assert.equal(base.includes(unrelated), false, "a file outside superseded lineage is not inherited");
  assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, "COMPLETE");
  assert.deepEqual(await fs.readFile(liveTask), liveBefore, "preparing and validating a candidate must not publish it");

  const forgedRoot = await copyDirectory(copy.candidateExecutionRoot, path.join(parent, "forged"));
  const forgedTaskPath = path.join(forgedRoot, "tasks/slice-02.md");
  const forgedTask = await fs.readFile(forgedTaskPath, "utf8");
  await fs.writeFile(forgedTaskPath, forgedTask.replace(
    "- `" + inherited + "` | sha256:" + VALIDATED_HASH,
    "- `" + inherited + "` | sha256:" + "0".repeat(64)));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, forgedRoot),
    /final validation ownership does not match|expected sha256/u);

  await writeValidatedPath(fixture, inherited, "drifted source\n");
  await assert.rejects(serializeRunnerValidationBundleFromResponse({ operation: "VALIDATE_SLICE",
    response: JSON.stringify(sanitizedValidationResponse("PASS")), workspace: fixture.root,
    taskArtifact: liveTask, specPath: fixture.requirements, slice: "2" }),
  /superseded path drifted from tested file evidence/u);
  await assert.rejects(validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot),
    /final validation ownership does not match|expected sha256/u);

  for (const [changeAfter, expectedError] of [
    [1, /superseded path capture differs from tested file evidence/u],
    [4, /superseded path drifted after validation capture/u],
  ]) {
    const raced = await recoveryFixture(t);
    const racedTask = path.join(raced.fixture.execution, "tasks/slice-02.md");
    const racedPath = path.resolve(path.dirname(racedTask), raced.inherited);
    const originalReadFile = fsPromises.readFile.bind(fsPromises);
    let inheritedReads = 0;
    const readMock = t.mock.method(fsPromises, "readFile", async (file, ...args) => {
      const contents = await originalReadFile(file, ...args);
      if (path.resolve(file) === racedPath && ++inheritedReads === changeAfter) {
        await fs.writeFile(racedPath, "changed between validation reads\n");
      }
      return contents;
    });
    try {
      await assert.rejects(serializeRunnerValidationBundleFromResponse({ operation: "VALIDATE_SLICE",
        response: JSON.stringify(sanitizedValidationResponse("PASS")), workspace: raced.fixture.root,
        taskArtifact: racedTask, specPath: raced.fixture.requirements, slice: "2" }), expectedError);
    } finally {
      readMock.mock.restore();
    }
    assert.ok(inheritedReads > changeAfter, "the race must span the hash check and a later read");
  }

  const untested = await recoveryFixture(t, "TESTS_NOT_APPLICABLE");
  await assert.rejects(serializeRunnerValidationBundleFromResponse({ operation: "VALIDATE_SLICE",
    response: JSON.stringify(sanitizedValidationResponse("PASS")), workspace: untested.fixture.root,
    taskArtifact: path.join(untested.fixture.execution, "tasks/slice-02.md"),
    specPath: untested.fixture.requirements, slice: "2" }),
  /superseded path lacks tested file evidence/u);

  const wrongLineage = await recoveryFixture(t);
  const historicalTaskPath = path.join(wrongLineage.fixture.execution, "tasks/slice-01.md");
  await fs.writeFile(historicalTaskPath, (await fs.readFile(historicalTaskPath, "utf8"))
    .replace("- Superseded by: slice-02", "- Superseded by: slice-99"));
  await assert.rejects(serializeRunnerValidationBundleFromResponse({ operation: "VALIDATE_SLICE",
    response: JSON.stringify(sanitizedValidationResponse("PASS")), workspace: wrongLineage.fixture.root,
    taskArtifact: path.join(wrongLineage.fixture.execution, "tasks/slice-02.md"),
    specPath: wrongLineage.fixture.requirements, slice: "2" }),
  /not a committed supersession mapping|invalid later replacement slice/u);
});

// Uses current joint preparation, activation, native capture and strict publication.
test("terminal inspection detects hash drift and REMOVED reappearance without rewriting PASS history", async () => {
  await runOwnedContract("terminal-drift");
});

// Uses current joint preparation, activation, native capture and strict publication.
test("terminal candidates reject invalid final ownership and preserve live execution bytes", async () => {
  await runOwnedContract("terminal-candidate");
});

// Uses current joint preparation, activation, native capture and strict publication.
test("terminal integrity trusts repository-owned paths outside a nested SPEC and rejects repository escape", async () => {
  await runOwnedContract("nested-root");
});

// A pristine live task must stay pristine until evidence is published from its
// isolated candidate. Requiring its Changed Areas here deadlocks first execution.
// This fixture is generated from the versioned templates; no benchmark-temp input.
test("managed execution consumes the captured receipt path for EXECUTE_SLICE", async t => {
  const operation = "EXECUTE_SLICE";
  const fixture = await nestedLifecycleWorkspace(t, { setup: async f => {
    await fs.mkdir(path.join(f.root, 'src'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'src/related.txt'), 'related verification input\n');
    await fs.writeFile(path.join(f.root, 'src/receipt-inputs.mjs'),
      `import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync('src/example.txt','utf8'),${JSON.stringify(VALIDATED_CONTENT)});assert.equal(fs.readFileSync('src/related.txt','utf8'),${JSON.stringify('related verification input\n')});\n`);
    f.verificationRecipe = '- Recipe: ' + JSON.stringify({ format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.',
      checks: [{ id: 'verification-01', executable: { literal: 'node' }, args: [{ file: { kind: 'product', path: 'src/receipt-inputs.mjs' } }],
        inputs: [{ kind: 'product', path: 'src/example.txt' }, { kind: 'product', path: 'src/related.txt' }] }],
      dependencyReview: 'The prepared assertion reads both explicitly typed source files inside the approved src directory.' });
  } });
  const workspace = fixture.root, taskArtifact = path.join(fixture.execution, 'tasks/slice-01.md');
  const files = ['src/example.txt', 'src/related.txt'].map(file => path.join(workspace, file));
  const claims = files.map(file => path.relative(path.dirname(taskArtifact), file).split(path.sep).join('/'));
  const liveBefore = await fs.readFile(taskArtifact, 'utf8');
  if (operation === 'EXECUTE_SLICE') assert.match(liveBefore, /## Changed Areas\n\n- pending\n/);
  assert.equal((await preflightExecutionOperation(fixture.requirements, operation, '1')).state,
    operation === 'EXECUTE_SLICE' ? 'MATERIALIZED_PRISTINE' : 'VALIDATION_NEEDS_FIX');
  const semantic = scopeRegressionPayload();
  await withManagedExample(fixture, operation, async args => {
    assert.match(args.prompt, /RUNNER_DISPATCH_MODE=NORMAL/);
    assert.equal(await fs.readFile(taskArtifact, 'utf8'), liveBefore);
    return semantic;
  }, async managed => {
    const { copy, environment, broker } = managed;
    let candidate = liveBefore.replace('- [ ] 1.1', '- [x] 1.1');
    candidate = replaceSection(candidate, 'Changed Areas', claims.map(claim => '- `' + claim + '`').join('\n'));
    candidate = replaceSection(candidate, 'Diff Summary', '- Implemented behavior and its related verification.');
    await fs.writeFile(copy.candidateTaskArtifact, candidate);
    if (operation === 'EXECUTE_SLICE') assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, 'EXECUTION_STARTED');
    const payload = { automaticCheckRound: '1/3', changedAreas: claims, relevantEvidence: 'Prospective candidate scope', requestedChecks: 'Prepared two-file assertions' };
    await assert.rejects(managed.dispatch({ ...payload, changedScope: claims, changedAreas: undefined }), /changedScope/);
    assert.equal(managed.calls(), 0); assert.equal(broker.requestsHandled, 0);
    const receipt = await managed.dispatch(payload);
    assert.equal(managed.calls(), 1); assert.equal(broker.requestsHandled, 1);
    assert.equal(receipt.status, 'RUNNER_RESPONSE_CAPTURED');
    assert.deepEqual(receipt.testedState.entries.map(entry => entry.path), claims);
    for (const [index, file] of files.entries()) assert.equal(receipt.testedState.entries[index].value, 'sha256:' + createHash('sha256').update(await fs.readFile(file)).digest('hex'));
    assert.deepEqual(receipt.verification.checks.map(({ command, exit }) => ({ command, exit })), [{ command: 'node src/receipt-inputs.mjs', exit: 0 }]);
    assert.equal(await fs.readFile(taskArtifact, 'utf8'), liveBefore);
    assert.equal(receipt.receiptFile, await fs.realpath(path.join(managed.tmpdir, `001-${operation.toLowerCase()}-slice-01-attempt-1.receipt.json`)));
    const receiptBytes = await fs.readFile(receipt.receiptFile), responseBytes = await fs.readFile(receipt.semanticResponseFile), eventsBytes = await fs.readFile(receipt.eventsPath);
    assert.deepEqual(JSON.parse(receiptBytes), receipt, 'bridge forwards the persisted receipt and path unchanged');
    const producer = path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs');
    const produce = receiptArgument => spawnSync(process.execPath, [producer, '--execution-bundle', '--operation', operation,
      '--workspace', workspace, '--task-artifact', copy.candidateTaskArtifact, '--semantic-response-file', receipt.semanticResponseFile,
      '--receipt-file', receiptArgument, '--insert-candidate'], { cwd: workspace, env: environment, encoding: 'utf8' });
    const duplicate = path.join(managed.tmpdir, 'transcribed.receipt.json'); await fs.writeFile(duplicate, receiptBytes);
    const candidateBefore = await treeBytes(copy.candidateRoot), liveTreeBefore = await treeBytes(fixture.execution);
    const copied = produce(duplicate);
    assert.equal(copied.status, 1); assert.match(copied.stderr, /receipt does not match the active managed runner invocation/);
    assert.deepEqual(await treeBytes(copy.candidateRoot), candidateBefore); assert.deepEqual(await treeBytes(fixture.execution), liveTreeBefore);
    if (operation === 'EXECUTE_SLICE') {
      await fs.writeFile(copy.candidateTaskArtifact, replaceSection(candidate, 'Changed Areas', '- `' + claims[0] + '`'));
      const incomplete = await treeBytes(copy.candidateRoot);
      const rejected = produce(receipt.receiptFile);
      assert.equal(rejected.status, 1); assert.match(rejected.stderr, /captured Tested state does not match candidate target scope/);
      assert.deepEqual(await treeBytes(copy.candidateRoot), incomplete);
      await assert.rejects(publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: copy.candidateRoot }), /terminal publication requires the bounded operation result; checklist-only update must keep ownership/);
      assert.deepEqual(await treeBytes(fixture.execution), liveTreeBefore);
      await fs.writeFile(copy.candidateTaskArtifact, candidate);
    }
    const state = operation === 'EXECUTE_SLICE' ? 'IMPLEMENTED_AWAITING_VALIDATION' : 'FINDINGS_CORRECTED';
    if (operation === 'EXECUTE_SLICE') {
      const produced = produce(receipt.receiptFile);
      assert.equal(produced.status, 0, produced.stderr);
      assert.match(produced.stdout, /^### implementation-check-01 inserted into isolated candidate/);
      assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, state);
      assert.equal(await fs.readFile(taskArtifact, 'utf8'), liveBefore);
      const published = spawnSync(process.execPath, [path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs'),
        '--publish', '--spec-path', fixture.requirements, '--slice', 'slice-01', '--candidate-root', copy.candidateRoot], { cwd: workspace, env: environment, encoding: 'utf8' });
      assert.equal(published.status, 0, published.stderr); assert.equal(JSON.parse(published.stdout).state, state);
    }
    const readback = await inspectExecutionState(fixture.requirements); assert.equal(readback.state, state); assert.equal(readback.normalHandoff.operation, 'VALIDATE_SLICE');
    assert.equal(managed.calls(), 1); assert.equal(broker.requestsHandled, 1);
    assert.deepEqual(await fs.readFile(duplicate), receiptBytes); assert.deepEqual(await fs.readFile(receipt.receiptFile), receiptBytes);
    assert.deepEqual(await fs.readFile(receipt.semanticResponseFile), responseBytes); assert.deepEqual(await fs.readFile(receipt.eventsPath), eventsBytes);
  });
});

for (const operation of ["APPLY_FINDINGS"]) {
test(`managed execution consumes the captured receipt path for ${operation}`, async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const workspace = fixture.root;
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const target = path.join(workspace, "src/example.txt");
  const related = path.join(workspace, "test/related.txt");
  await fs.mkdir(path.dirname(related), { recursive: true });
  await fs.writeFile(related, "related verification input\n");
  const claims = [target, related].map((file) => path.relative(path.dirname(taskArtifact), file).split(path.sep).join("/"));
  if (operation === "APPLY_FINDINGS") {
    await editTask(fixture, (value) => {
      let task = value.replace("- [ ] 1.1", "- [x] 1.1");
      task = replaceSection(task, "Changed Areas", `- \`${claims[0]}\``);
      task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll("../../src/example.txt", claims[0]));
      task = replaceSection(task, "Validation Attempts", NEEDS_FIX_ATTEMPT.replaceAll("../../src/example.txt", claims[0]));
      task = replaceSection(task, "Validation Findings", ACTIVE_FINDING);
      return replaceSection(task, "Diff Summary", "- Implementation submitted for independent correction.");
    });
  }
  const liveBefore = await fs.readFile(taskArtifact, "utf8");
  if (operation === "EXECUTE_SLICE") assert.match(liveBefore, /## Changed Areas\n\n- pending\n/u);
  const preflight = await preflightExecutionOperation(fixture.requirements, operation, "1");
  assert.equal(preflight.state, operation === "EXECUTE_SLICE" ? "MATERIALIZED_PRISTINE" : "VALIDATION_NEEDS_FIX");
  const officialPreflight = { exitCode: 0, operation, slice: "slice-01", inputSlice: "1",
    specPath: fixture.requirements, state: preflight.state, authority: `sha256:${preflight.currentFingerprint}`,
    legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery };
  const context = await createManagedSliceContext({ officialPreflight, workspace, snapshot: ROOT,
    adapterPath: path.join(ROOT, "agents/codex/runtime/validation-runner.mjs"),
    bridgePath: path.join(ROOT, "agents/codex/runtime/managed-runner-bridge.mjs"),
    preflightPath: path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs") });
  const tmpdir = await temporary(t, "stnl-pristine-runner-");
  const environment = managedEnvironment({ ...process.env, TMPDIR: tmpdir }, context);
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  let candidate = liveBefore.replace("- [ ] 1.1", "- [x] 1.1");
  candidate = replaceSection(candidate, "Changed Areas", claims.map((claim) => `- \`${claim}\``).join("\n"));
  if (operation === "APPLY_FINDINGS") candidate = replaceSection(candidate, "Corrections Applied", claims.map((claim) => `- \`${claim}\``).join("\n"));
  candidate = replaceSection(candidate, "Diff Summary", "- Implemented behavior and its related verification.");
  await fs.writeFile(copy.candidateTaskArtifact, candidate);
  if (operation === "EXECUTE_SLICE") {
    assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, "EXECUTION_STARTED");
  }
  let turns = 0;
  const broker = await startOfficialRunnerBroker({ workspace, tmpdir, operation, sequence: 1,
    slice: "slice-01", officialPreflight, pollIntervalMs: 5,
    invoke: (request) => invokeIndependentRunner({ ...request, snapshot: ROOT, env: environment,
      runTurn: async ({ eventsPath, operationId, prompt }) => {
        turns += 1;
        assert.match(prompt, /RUNNER_DISPATCH_MODE=NORMAL/u);
        assert.equal(await fs.readFile(taskArtifact, "utf8"), liveBefore);
        // The model boundary is stubbed; the local check really runs on these bytes.
        const check = `import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(fs.readFileSync('src/example.txt', 'utf8'), ${JSON.stringify(VALIDATED_CONTENT)}); assert.equal(fs.readFileSync('test/related.txt', 'utf8'), 'related verification input\\n');`;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", check], {
          cwd: workspace, env: { ...process.env, STNL_VERIFICATION_COMMAND: "1" }, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const command = `STNL_VERIFICATION_COMMAND=1 ${process.execPath} --input-type=module -e ${JSON.stringify(check)}`;
        const response = {
          status: "TESTS_PASS", automaticCheckRound: "1/3", head: "1".repeat(40),
          discoverySources: "task and versioned fixture", discoveryActions: "read fixture inputs",
          verificationTypesConsidered: "focused verification", nonApplicabilityRationale: "none",
          noVerificationCommandConfirmation: "applicable check executed", commands: [{ command, exit: result.status }],
          resultOfEachCommandAndExitCode: "local check passed", selectedChecks: "fixture byte assertions",
          selectionRationale: "direct scope coverage", coverage: "AC-001", failures: "none",
          ...(operation === "EXECUTE_SLICE" ? { priorRoundFailure: "none", correctionApplied: "none", inSliceRationale: "none" } : {}),
          evidenceOrFailureSummary: "real local check passed", affectedFilesOrBehaviors: "example and related verification",
          blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner edits",
          ...(operation === "APPLY_FINDINGS" ? { findingsCycle: "attempt-01", findingsVerified: "finding-01",
            correctionsCovered: "approved target and related verification", regressionsSelected: "fixture byte assertions",
            unsupportedActiveFindings: "none" } : {}),
        };
        const events = [
          { operationId, type: "thread.started", thread_id: "offline-pristine-runner" },
          { operationId, type: "turn.started" },
          { operationId, type: "item.started", item: { id: "item_0", type: "command_execution", command } },
          { operationId, type: "item.completed", item: { id: "item_0", type: "command_execution", command,
            status: "completed", exit_code: result.status, aggregated_output: result.stdout } },
          { operationId, type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(response) } },
          { operationId, type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } },
        ];
        await fs.writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
        return { completed: true, turnStarted: true, threadId: "offline-pristine-runner", requestedModel: "gpt-5.6-luna",
          requestedEffort: "medium", reportedModel: null, error: null, usage: { input_tokens: 0, output_tokens: 0 } };
      } }) });
  try {
    const payload = { automaticCheckRound: "1/3", changedAreas: claims,
      relevantEvidence: "candidate holds prospective changed scope", requestedChecks: "check the two fixture inputs" };
    await assert.rejects(runManagedRunnerBridge({ environment, cwd: workspace,
      payload: JSON.stringify({ ...payload, changedScope: claims, changedAreas: undefined }) }), /changedScope/u);
    assert.equal(turns, 0);
    assert.equal(broker.requestsHandled, 0);
    const receipt = await runManagedRunnerBridge({ environment, cwd: workspace, payload: JSON.stringify(payload) });
    assert.equal(turns, 1);
    assert.equal(broker.requestsHandled, 1);
    assert.equal(receipt.status, "RUNNER_RESPONSE_CAPTURED");
    assert.deepEqual(receipt.testedState.entries.map((entry) => entry.path), claims);
    for (const [index, file] of [target, related].entries()) {
      assert.equal(receipt.testedState.entries[index].value, `sha256:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`);
    }
    assert.equal(await fs.readFile(taskArtifact, "utf8"), liveBefore);
    assert.equal(receipt.receiptFile, await fs.realpath(path.join(tmpdir, `001-${operation.toLowerCase()}-slice-01-attempt-1.receipt.json`)));
    const receiptFile = receipt.receiptFile;
    const receiptBytes = await fs.readFile(receiptFile);
    const responseBytes = await fs.readFile(receipt.semanticResponseFile);
    const eventsBytes = await fs.readFile(receipt.eventsPath);
    assert.deepEqual(JSON.parse(receiptBytes), receipt, "bridge forwards the adapter's persisted receipt and path unchanged");
    const producer = path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs");
    const produce = (artifact, receiptArgument = receiptFile) => spawnSync(process.execPath, [producer, "--execution-bundle", "--operation", operation,
      "--workspace", workspace, "--task-artifact", artifact, "--semantic-response-file", receipt.semanticResponseFile,
      "--receipt-file", receiptArgument, "--insert-candidate"], { env: environment, encoding: "utf8" });
    const duplicate = path.join(tmpdir, "transcribed.receipt.json");
    await fs.writeFile(duplicate, receiptBytes);
    const candidateBefore = await treeBytes(copy.candidateRoot);
    const liveTreeBefore = await treeBytes(fixture.execution);
    const copiedReceipt = produce(copy.candidateTaskArtifact, duplicate);
    assert.equal(copiedReceipt.status, 1);
    assert.match(copiedReceipt.stderr, /receipt does not match the active managed runner invocation/u);
    assert.deepEqual(await treeBytes(copy.candidateRoot), candidateBefore);
    assert.deepEqual(await treeBytes(fixture.execution), liveTreeBefore);
    assert.equal(await fs.readFile(taskArtifact, "utf8"), liveBefore);
    if (operation === "EXECUTE_SLICE") {
    // Prospective dispatch does not authorize publishing a different target set.
    const incomplete = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
    await fs.writeFile(incomplete.candidateTaskArtifact, replaceSection(candidate, "Changed Areas", `- \`${claims[0]}\``));
    const rejected = produce(incomplete.candidateTaskArtifact);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /captured Tested state does not match candidate target scope/u);
    const blockedPublish = spawnSync(process.execPath, [
      path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs"),
      "--publish", "--spec-path", fixture.requirements, "--slice", "slice-01", "--candidate-root", incomplete.candidateRoot,
    ], { env: environment, encoding: "utf8" });
    assert.equal(blockedPublish.status, 1);
    assert.match(blockedPublish.stderr, /EXECUTION_STARTED without publishable runner evidence/u);
    assert.equal(await fs.readFile(taskArtifact, "utf8"), liveBefore);
    }
    const produced = produce(copy.candidateTaskArtifact);
    assert.equal(produced.status, 0, produced.stderr);
    assert.match(produced.stdout, new RegExp(`^### ${operation === "EXECUTE_SLICE" ? "implementation" : "findings"}-check-01 inserted into isolated candidate`, "u"));
    assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state,
      operation === "EXECUTE_SLICE" ? "IMPLEMENTED_AWAITING_VALIDATION" : "FINDINGS_CORRECTED");
    assert.equal(await fs.readFile(taskArtifact, "utf8"), liveBefore);
    const published = spawnSync(process.execPath, [
      path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs"),
      "--publish", "--spec-path", fixture.requirements, "--slice", "slice-01", "--candidate-root", copy.candidateRoot,
    ], { env: environment, encoding: "utf8" });
    assert.equal(published.status, 0, published.stderr);
    assert.equal(JSON.parse(published.stdout).state,
      operation === "EXECUTE_SLICE" ? "IMPLEMENTED_AWAITING_VALIDATION" : "FINDINGS_CORRECTED");
    const readback = await inspectExecutionState(fixture.requirements);
    assert.equal(readback.state, operation === "EXECUTE_SLICE" ? "IMPLEMENTED_AWAITING_VALIDATION" : "FINDINGS_CORRECTED");
    assert.equal(readback.normalHandoff.operation, "VALIDATE_SLICE");
    assert.equal(turns, 1, "reusing the captured result for persistence must not rerun the provider or local check");
    assert.equal(broker.requestsHandled, 1);
    assert.deepEqual(await fs.readFile(duplicate), receiptBytes);
    assert.deepEqual(await fs.readFile(receiptFile), receiptBytes);
    assert.deepEqual(await fs.readFile(receipt.semanticResponseFile), responseBytes);
    assert.deepEqual(await fs.readFile(receipt.eventsPath), eventsBytes);
  } finally { await broker.close(); }
});
}

test("managed prospective scope is canonical without equating it to a prior published attempt", async t => {
  const f = await nestedLifecycleWorkspace(t);
  const liveTask = path.join(f.execution, 'tasks/slice-01.md');
  const target = path.join(f.root, 'src/example.txt'), extra = path.join(f.root, 'src/next.txt');
  const relative = file => path.relative(path.dirname(liveTask), file).split(path.sep).join('/');
  const claim = relative(target), extraClaim = relative(extra), missing = relative(path.join(f.root, 'src/missing.txt'));
  const admission = await beginExample(f, 'EXECUTE_SLICE');
  await fs.writeFile(extra, 'next attempt\n');
  const copy = await prepareExecutionCopy({ specPath: f.requirements, slice: 'slice-01', owner: admission.owner });
  t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
  const options = { workspace: f.root, taskArtifact: copy.candidateTaskArtifact };
  const live = await treeBytes(f.execution), pristine = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  assert.match(pristine, /## Changed Areas\n\n- pending/);
  assert.deepEqual(await validateManagedChangedAreas({ ...options, changedAreas: [extraClaim, claim, claim] }), [claim, extraClaim]);
  const priorScope = replaceSection(pristine, 'Changed Areas', '- `' + claim + '`');
  assert.notEqual(priorScope, pristine); await fs.writeFile(copy.candidateTaskArtifact, priorScope);
  assert.deepEqual(await validateManagedChangedAreas({ ...options, changedAreas: [claim, extraClaim] }), [claim, extraClaim]);
  assert.equal(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), priorScope);
  const outside = path.join(await temporary(t, 'stnl-outside-scope-'), 'outside.txt'); await fs.writeFile(outside, 'must not be selected\n');
  const link = path.join(f.root, 'src/link.txt'); await fs.symlink(outside, link);
  for (const [label, changedAreas, diagnostic] of [
    ['absolute', [target], /must be a normalized relative path/],
    ['wrong physical basis', ['src/example.txt'], /outside authorized areas/],
    ['repository escape', [relative(outside)], /escapes its trusted workspace/],
    ['symlink', [relative(link)], /traverses a symlink/],
    ['non-string', [{ path: claim }], /must be a normalized relative path/],
  ]) {
    await assert.rejects(validateManagedChangedAreas({ ...options, changedAreas }), diagnostic, label);
    assert.equal(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), priorScope); assert.deepEqual(await treeBytes(f.execution), live);
  }
  // Directory authorization allows a future selection; only the actual capture
  // may certify an absent file as REMOVED, and it requires earlier bytes.
  assert.deepEqual(await validateManagedChangedAreas({ ...options, changedAreas: [missing] }), [missing]);
  await assert.rejects(captureRunnerTestedState({ ...options, changedAreas: [missing] }), /absent future file is not proved removal/);
  const beforeRemoval = await captureRunnerTestedState({ ...options, changedAreas: [claim] });
  assert.deepEqual(beforeRemoval.entries, [{ path: claim, value: 'sha256:' + VALIDATED_HASH }]);
  await fs.rm(target);
  assert.deepEqual(await validateManagedChangedAreas({ ...options, changedAreas: [claim] }), [claim]);
  assert.deepEqual((await captureRunnerTestedState({ ...options, changedAreas: [claim] })).entries, [{ path: claim, value: 'REMOVED' }]);
  assert.equal(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), priorScope); assert.deepEqual(await treeBytes(f.execution), live);
});

test("managed scope ignores an out-of-workspace alternative to a valid task-relative path", async (t) => {
  const outer = await temporary(t, "stnl-runner-scope-");
  const parent = path.join(outer, "a/b/c/d"); await fs.mkdir(parent, { recursive: true });
  const f = await preparationFixture({ parent });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await approveFixture(f);
  const taskArtifact = path.join(f.workspace.executionRoot, "tasks/slice-01.md");
  const claim = "../../src/README.md";
  const target = path.join(f.root, "src/README.md");
  const alternative = path.resolve(f.root, claim);
  assert.ok(alternative.startsWith(outer + path.sep) && !alternative.startsWith(f.root + path.sep));
  await fs.writeFile(target, "case documentation\n");
  await fs.mkdir(path.dirname(alternative), { recursive: true });
  await fs.writeFile(alternative, "unrelated documentation\n");
  const options = { workspace: f.root, taskArtifact };
  assert.deepEqual(await validateManagedChangedAreas({ ...options, changedAreas: [claim] }), [claim]);
  const captured = await captureRunnerTestedState({ ...options, changedAreas: [claim] });
  assert.deepEqual(captured.entries, [{ path: claim, value: "sha256:" + createHash("sha256").update("case documentation\n").digest("hex") }]);
  const escape = path.relative(path.dirname(taskArtifact), alternative).split(path.sep).join("/");
  await assert.rejects(validateManagedChangedAreas({ ...options, changedAreas: [escape] }), /validation-owned path escapes its trusted workspace/u);
  await assert.rejects(captureRunnerTestedState({ ...options, changedAreas: [escape] }), /validation-owned path escapes its trusted workspace/u);
  // The lexical alias exists both beside the task and under the workspace.
  // It must not silently choose the wrong containing artifact basis.
  await fs.writeFile(path.join(path.dirname(taskArtifact), "README.md"), "task documentation\n");
  await fs.writeFile(path.join(f.root, "README.md"), "root documentation\n");
  await assert.rejects(validateManagedChangedAreas({ ...options, changedAreas: ["README.md"] }), error => error.message === "managed changedAreas is outside authorized areas: README.md");
  await assert.rejects(captureRunnerTestedState({ ...options, changedAreas: ["README.md"] }), error => error.message === "runner changed area is outside authorized areas: README.md");
});

test("managed scope rejects an intermediate symlink before probing its external target", async (t) => {
  const f = await preparationFixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await approveFixture(f);
  const external = await temporary(t, "stnl-runner-link-external-");
  await fs.writeFile(path.join(external, "README.md"), "outside\n");
  const taskArtifact = path.join(f.workspace.executionRoot, "tasks/slice-01.md");
  const target = path.join(f.root, "src/linked");
  const claim = "../../src/linked/README.md";
  // Same consumer succeeds on a regular contained directory before the mutant.
  await fs.mkdir(target); await fs.writeFile(path.join(target, "README.md"), "inside\n");
  const options = { workspace: f.root, taskArtifact, changedAreas: [claim] };
  assert.deepEqual(await validateManagedChangedAreas(options), [claim]);
  assert.equal((await captureRunnerTestedState(options)).entries.length, 1);
  await fs.rm(target, { recursive: true }); await fs.symlink(external, target);
  const forbidden = new Set([path.join(target, "README.md"), path.join(external, "README.md")]);
  const originalLstat = fsPromises.lstat.bind(fsPromises);
  const probes = [];
  t.mock.method(fsPromises, "lstat", async (file, ...args) => {
    const resolved = path.resolve(file); probes.push(resolved);
    if (forbidden.has(resolved)) throw new Error("external target was probed");
    return originalLstat(file, ...args);
  });
  const rejectsAtLink = error => error.message === `validation-owned path traverses a symlink: ${target}`;
  await assert.rejects(validateManagedChangedAreas(options), rejectsAtLink);
  await assert.rejects(captureRunnerTestedState(options), rejectsAtLink);
  assert.ok(probes.includes(target));
  assert.ok(probes.every(file => !forbidden.has(file)));
});
test('canonical observed complex commands round-trip through EXECUTE, APPLY and formal publication with placeholder rejection', async t => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT,
    'skills/workflows/stnl-slice-executor/runtime/runner-execute-response.schema.json'), 'utf8'));
  assert.equal(schema.properties.commands.items.properties.command.pattern, '^[\\s\\S]+$');
  assert.equal(schema.properties.head.pattern, '^[^\\r\\n`]+$');
  const fixture = await standaloneWorkspace(t);
  await fs.mkdir(path.join(fixture.root, 'src'), { recursive: true });
  await fs.writeFile(path.join(fixture.root, 'src/input.txt'), 'observed input\n');
  const scripts = [
    `node -e 'require("node:assert/strict").equal(1 + 1, 2)'`,
    'cat < src/input.txt 2>&1 | cat > /dev/null',
    'cat < src/input.txt > /dev/null',
    'cat < src/input.txt 2> /dev/null',
    'node -e `printf "process.exit(0)"`',
    "printf 'first\nsecond'\ncat src/input.txt",
    "node --input-type=module <<'NODE'\nimport assert from 'node:assert/strict';\nconst value = () => 1 + 1;\nassert.equal(value(), 2);\nNODE",
  ];
  fixture.verificationRecipe = '- Recipe: ' + JSON.stringify({ format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.',
    checks: [{ id: 'verification-01', executable: { literal: 'node' }, args: [{ literal: '--test' }, { file: { kind: 'product', path: 'src/example.test.mjs' } }], inputs: [{ kind: 'product', path: 'src/example.txt' }] },
      ...scripts.map((script, index) => ({ id: `verification-${String(index + 2).padStart(2, '0')}`, executable: { literal: 'sh' }, args: [{ literal: '-c' }, { literal: script }], inputs: [{ kind: 'product', path: 'src/input.txt' }] })),
      { id: 'verification-09', executable: { literal: 'node' }, args: [{ literal: '-e' }, { literal: 'process.stdout.write("CRLF observed")\r\n' }], inputs: [] }],
    dependencyReview: 'Fixed local shell literals only; Node assertion and input file are typed. Redirects use the null device and no command changes observed inputs or calls a network service.' });
  await renderArtifacts(fixture);
  fixture.exampleImplementation = await implementExample(fixture, { publish: false });
  const implementation = fixture.exampleImplementation;
  const commands = implementation.start.verification.checks.map(check => verificationCommand(check));
  const observation = JSON.parse(await fs.readFile(implementation.captured.receiptFile)).verification;
  assert.deepEqual(observation.checks.map(check => [check.command, check.exit]), commands.map(command => [command, 0]));
  assert.ok(observation.checks.some(check => check.stdout.includes('observed input')), 'the actual redirected/multiline stimulus ran');
  assert.equal(observation.checks[6].request.args[1], scripts[5], 'multiline bytes survive the reviewed recipe');
  assert.equal(observation.checks[6].stdout, 'first\nsecondobserved input\n');
  assert.equal(observation.checks[7].request.args[1], scripts[6], 'heredoc bytes survive the reviewed recipe');
  assert.equal(observation.checks[8].request.args[1], 'process.stdout.write("CRLF observed")\r\n');
  assert.ok(observation.checks.some(check => check.stdout === 'CRLF observed'), 'CRLF argument bytes reached direct execution');
  for (const mutate of [
    receipt => { receipt.checks[6].command += ' changed'; },
    receipt => { receipt.checks[6].stdout += ' changed'; },
    receipt => { receipt.checks[6].request.args[1] = 'changed'; },
    receipt => { receipt.status = 'started'; },
  ]) {
    const tampered = structuredClone(observation); mutate(tampered);
    assert.throws(() => assertRunnerVerification(tampered, implementation.start.verification), /runner verification:/);
  }
  const sourceRecipe = JSON.parse(fixture.verificationRecipe.slice('- Recipe: '.length));
  for (const executable of ['sh\nchanged', 'sh\rchanged', 'sh\0changed']) {
    const mutated = structuredClone(sourceRecipe); mutated.checks[1].executable.literal = executable;
    assert.throws(() => parseVerificationRecipe('- Recipe: ' + JSON.stringify(mutated)), /invalid verification literal/);
  }
  const nulArgument = structuredClone(sourceRecipe); nulArgument.checks[1].args[1].literal += '\0';
  assert.throws(() => parseVerificationRecipe('- Recipe: ' + JSON.stringify(nulArgument)), /invalid verification literal/);
  for (const command of commands) {
    const carrier = /[`\r\n]/u.test(command) ? `json:${JSON.stringify(command)}` : `\`${command}\``;
    assert.ok(implementation.bundle.includes(`  - ${carrier} | exit:0`), 'lossless canonical command carrier');
  }
  await rejectTaskMutations(fixture, implementation.copy, [
    ['placeholder command', text => text.replace(`\`${commands[0]}\` | exit:0`, '`node <placeholder>` | exit:0'), /template placeholder content/],
    ['placeholder path', text => text.replace(`\`${commands[0]}\` | exit:0`, '`node <task-relative path> 2>&1` | exit:0'), /template placeholder content/],
    ['placeholder after redirect', text => text.replace(`\`${commands[0]}\` | exit:0`, '`cat < src/input.txt 2>&1 && node <placeholder>` | exit:0'), /template placeholder content/],
    ['placeholder failure after valid redirect', text => text.replace('- Failures: none', '- Failures: <missing evidence>'), /template placeholder content/],
    ['placeholder coverage after valid redirect', text => text.replace('- Coverage: AC-001 example bytes', '- Coverage: <unproven scope>'), /template placeholder content/],
  ]);
  const receiptBytes = await fs.readFile(implementation.captured.receiptFile);
  await publishExecutionCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot });
  const explanation = 'line one\nline `two`';
  const needsFix = await validateExample(fixture, { status: 'NEEDS_FIX', findings: ACTIVE_FINDING, explanation });
  const correction = await correctExample(fixture, { content: undefined, explanation });
  assert.ok(correction.bundle.includes(`json:${JSON.stringify(explanation)}`));
  for (const command of commands) {
    const carrier = /[`\r\n]/u.test(command) ? `json:${JSON.stringify(command)}` : `\`${command}\``;
    assert.ok(correction.bundle.includes(`  - ${carrier} | exit:0`), 'APPLY command carrier is lossless');
  }
  const resolved = ACTIVE_FINDING.replace('State: active', 'State: resolved')
    + '\n- Resolution: attempt-02 confirms the corrected observation.';
  const pass = await validateExample(fixture, { status: 'PASS', findings: resolved, dispositions: 'finding-01=resolved', explanation });
  const state = await inspectExecutionState(fixture.requirements), task = state.tasks.get('slice-01');
  assert.equal(state.state, 'COMPLETE');
  for (const record of [...task.implementationChecks, ...task.findingsChecks]) {
    assert.deepEqual(record.commands.map(({ command, exit }) => [command, exit]), commands.map(command => [command, 0]));
  }
  for (const record of task.attempts) {
    assert.match(record.commands[0].command, /validate-execution-state\.mjs/);
    assert.deepEqual(record.commands.slice(1).map(({ command, exit }) => [command, exit]), commands.map(command => [command, 0]));
    assert.ok(record.body.includes(`json:${JSON.stringify(explanation)}`), 'formal explanatory carrier is lossless');
  }
  for (const result of [needsFix, correction, pass]) assert.equal(JSON.parse(await fs.readFile(result.captured.receiptFile)).verification.status, 'completed');
  assert.deepEqual(await fs.readFile(implementation.captured.receiptFile), receiptBytes);
});

test('U3 managed rejected result recovers with current admitted identity and exact prior evidence', async t => {
  for (const operation of ['EXECUTE_SLICE', 'VALIDATE_SLICE']) for (const kind of ['json', 'schema', 'producer']) {
    await t.test(`${operation} ${kind}`, async child => {
      const f = await standaloneWorkspace(child); await renderArtifacts(f);
      if (operation === 'VALIDATE_SLICE') await implementExample(f);
      const semantic = operation === 'EXECUTE_SLICE' ? scopeRegressionPayload() : sanitizedValidationResponse('PASS');
      const bad = kind === 'json' ? '{ invalid final response' : kind === 'schema'
        ? { ...semantic, commands: 'malformed' } : { ...semantic, head: '' };
      let first, recovery, priorOwner, second;
      const captures = [];
      async function run(response, successor = false) {
        return withManagedExample(f, operation, async args => {
          assert.equal(args.threadId, undefined, 'a new invocation never inherits the prior thread');
          return response;
        }, async managed => {
          const file = managed.copy.candidateTaskArtifact;
          if (operation === 'EXECUTE_SLICE') {
            let text = await fs.readFile(file, 'utf8');
            text = text.replace('- [ ] 1.1', '- [x] 1.1');
            text = replaceSection(text, 'Changed Areas', '- `../../src/example.txt`');
            text = replaceSection(text, 'Diff Summary', '- Actual reviewed example assertion exercises the approved result.');
            await fs.writeFile(file, text);
          }
          const receipt = await managed.dispatch(operation === 'VALIDATE_SLICE' ? 'Validate the exact current reviewed example proof.'
            : { automaticCheckRound: '1/3', changedAreas: ['../../src/example.txt'] });
          assert.equal(await fs.readFile(receipt.semanticResponseFile, 'utf8'), typeof response === 'string' ? response : JSON.stringify(response));
          assert.equal(managed.calls(), 1);
          assert.equal(receipt.formatRepair?.attempted ?? false, false); assert.equal(receipt.formatRepair?.accepted ?? false, false);
          const files = [receipt.receiptFile, receipt.semanticResponseFile, receipt.eventsPath];
          const bytes = await Promise.all(files.map(async file => [file, await fs.readFile(file)])); captures.push(...bytes);
          const candidate = await treeBytes(managed.copy.candidateExecutionRoot);
          if (!successor && kind === 'json') {
            const consume = (environment = managed.environment) => assertManagedRunnerReceipt({ operation, slice: 'slice-01', workspace: f.root,
              receiptFile: receipt.receiptFile, semanticResponseFile: receipt.semanticResponseFile, allowRejected: true, environment });
            await consume();
            const current = await preflightExecutionOperation(f.requirements, operation, '1', { owner: managed.context.owner });
            if (operation === 'EXECUTE_SLICE') assert.notDeepEqual(
              [current.state, current.legalOperations, current.mandatoryRecovery ?? null],
              [managed.context.state, managed.context.legalOperations, managed.context.mandatoryRecovery ?? null],
              'legitimate admitted execution changes the pre-admission projection');
            const live = await treeBytes(f.execution), originalReceipt = await fs.readFile(receipt.receiptFile);
            const copiedReceipt = path.join(managed.tmpdir, 'copied-rejected-receipt.json');
            await fs.writeFile(copiedReceipt, originalReceipt);
            await assert.rejects(assertManagedRunnerReceipt({ operation, slice: 'slice-01', workspace: f.root,
              receiptFile: copiedReceipt, semanticResponseFile: receipt.semanticResponseFile,
              allowRejected: true, environment: managed.environment }), /receipt does not match the active managed runner invocation/u);
            assert.deepEqual(await treeBytes(f.execution), live); assert.deepEqual(await treeBytes(managed.copy.candidateExecutionRoot), candidate);
            assert.deepEqual(await fs.readFile(receipt.receiptFile), originalReceipt);
            const wrongOwner = { ...managed.context, owner: { ...managed.context.owner, operationAttemptId: randomUUID() } };
            const wrongEnvironment = managedEnvironment({ ...managed.environment }, wrongOwner);
            await assert.rejects(consume(wrongEnvironment), /owner|attempt|differs|identity|receipt/u);
            assert.deepEqual(await treeBytes(f.execution), live);
            const authority = await fs.readFile(f.requirements); await fs.appendFile(f.requirements, '\nAC-002: changed after dispatch.\n');
            await assert.rejects(consume(), /authority|changed|stale|activation/u);
            assert.deepEqual(await treeBytes(f.execution), live); assert.deepEqual(await treeBytes(managed.copy.candidateExecutionRoot), candidate);
            await fs.writeFile(f.requirements, authority); await consume();
          }
          const outcome = await managed.finalize();
          assert.equal(outcome.published, true); assert.equal(outcome.state, successor
            ? operation === 'VALIDATE_SLICE' ? 'COMPLETE' : 'IMPLEMENTED_AWAITING_VALIDATION' : 'RUNNER_RESULT_BLOCKED');
          assert.deepEqual(await treeBytes(managed.copy.candidateExecutionRoot), candidate, 'finalizer preserves semantic input candidate');
          assert.equal(managed.calls(), 1);
          if (!successor) {
            const state = await inspectExecutionState(f.requirements);
            assert.equal(state.tasks.get('slice-01').attempts.length, 0);
            assert.equal(state.tasks.get('slice-01').implementationChecks.length, operation === 'EXECUTE_SLICE' ? 0 : 1);
            recovery = { expectedActivationId: state.activation.activationId,
              rejectedOperationAttemptId: state.activation.activeAttempt.operationAttemptId,
              rejection: state.activeDelegationBlockers[0].recoveryProof };
            priorOwner = managed.context.owner;
            await assert.rejects(preflightRunnerResultRecovery(f.requirements, operation, '1', recovery), /conclusion uncertain/);
          } else {
            assert.notEqual(managed.context.owner.operationAttemptId, priorOwner.operationAttemptId);
            assert.equal(managed.context.owner.recovery.predecessor.operationAttemptId, priorOwner.operationAttemptId);
          }
          return receipt;
        }, { recovery: successor ? recovery : null, sequence: successor ? 2 : 1 });
      }
      first = await run(bad);
      assert.equal((await preflightRunnerResultRecovery(f.requirements, operation, '1', recovery)).state, 'RUNNER_RESULT_BLOCKED');
      second = await run(semantic, true);
      assert.notEqual(second.threadId, first.threadId); assert.notEqual(second.receiptFile, first.receiptFile);
      if (operation === 'EXECUTE_SLICE') await validateExample(f);
      const final = await inspectExecutionState(f.requirements);
      assert.equal(final.state, 'COMPLETE'); assert.equal(final.tasks.get('slice-01').attempts.length, 1);
      for (const [file, bytes] of captures) assert.deepEqual(await fs.readFile(file), bytes);
    });
  }
});
