import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch, writeFileSync } from "node:fs";
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
  repairExecutionContract,
  validateExecutionCandidate,
  workflowSkillForOperation,
} from "../skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs";
import { preparePlanCandidate } from "../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs";
import { serializePlanPathClaims } from "../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs";
import { prepareValidationCandidate } from "../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs";
import { prepareValidationCopy } from "../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs";
import { recoverRejectedValidationCandidate } from "../skills/workflows/stnl-slice-quality-manager/runtime/recover-rejected-validation-candidate.mjs";
import { decideOutcome, initializeTurnBudget, budgetSnapshot, nextHandoff, prepareOfficialRecovery, recoverableRunnerHandoff, runCase, runTemplateTurn } from "../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs";
import { createSnapshot } from "../benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs";
import { validateWorkspace as validateLifecycleWorkspace } from "../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs";
import { renderClosedFeature } from "../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/closed-spec.mjs";
import { runCodexTurn } from "../agents/codex/runtime/sdk-transport.mjs";
import { createUsageNormalizer, ZERO_USAGE } from "../agents/codex/runtime/usage-accounting.mjs";
import { assertManagedRunnerReceipt, createManagedSliceContext, managedEnvironment } from "../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs";
import { publishValidationCandidate } from "../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs";
import { resolveExecutionWorkspace as resolveMaterializerExecutionWorkspace } from "../skills/workflows/stnl-task-materializer/runtime/execution-state.mjs";
import { prepareTaskMaterializationCandidate } from "../skills/workflows/stnl-task-materializer/runtime/prepare-task-candidate.mjs";
import { publishTaskMaterializationCandidate } from "../skills/workflows/stnl-task-materializer/runtime/publish-task-candidate.mjs";
import { serializeTaskPathClaims } from "../skills/workflows/stnl-task-materializer/runtime/serialize-task-paths.mjs";
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
import { captureRunnerResponse } from "../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs";
import { startOfficialRunnerBroker } from "../agents/codex/runtime/runner-broker.mjs";
import { runManagedRunnerBridge } from "../agents/codex/runtime/managed-runner-bridge.mjs";
import { invokeIndependentRunner } from "../agents/codex/runtime/validation-runner.mjs";
import { emptyFindingArrays, validationResponse as sanitizedValidationResponse,
  failedCheckHistory } from "./fixtures/validation-response-regressions.mjs";
import { prepareExecutionCopy, publishExecutionCopy } from "../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs";
import { EXECUTION_OPERATION_SKILLS, WORKFLOW_OPERATIONS } from "./lib/skill-registry.mjs";
import { guardOperationProvenance, recoverableOfficialHandoff } from "../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs";
import { budgetViolation } from "../benchmarks/sentinel-todo/runtime/benchmark.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILLS = [
  "stnl-execution-planner", "stnl-plan-reviewer", "stnl-task-materializer", "stnl-task-reviewer",
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

async function capturedCommandEvidence(t, operation, response, command) {
  const root = await temporary(t, "stnl-captured-commands-");
  const name = `001-${operation.toLowerCase()}-slice-01-attempt-1`;
  const semanticResponseFile = path.join(root, `${name}.response.json`);
  const receiptFile = path.join(root, `${name}.receipt.json`);
  const eventsPath = path.join(root, `${name}.events.jsonl`);
  await fs.writeFile(semanticResponseFile, response);
  await fs.writeFile(eventsPath, [
    { operationId: `runner-${name}`, type: "item.started", item: { id: "item_0", type: "command_execution", command, status: "in_progress", exit_code: null } },
    { operationId: `runner-${name}`, type: "item.completed", item: { id: "item_0", type: "command_execution", command, status: "completed", exit_code: 0 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  await fs.writeFile(receiptFile, JSON.stringify({
    status: "RUNNER_RESPONSE_CAPTURED", operation, eventsPath, semanticResponseFile,
    semanticResponseSha256: createHash("sha256").update(response).digest("hex"),
    captureFailure: null, error: null, exitCode: 0,
  }));
  return { receiptFile, semanticResponseFile };
}

async function capturedVerificationSequence(t, operation, response, exits, literalCommands = null) {
  const root = await temporary(t, "stnl-verdict-sequence-");
  const name = `001-${operation.toLowerCase()}-slice-01-attempt-1`;
  const semanticResponseFile = path.join(root, `${name}.response.json`);
  const receiptFile = path.join(root, `${name}.receipt.json`);
  const eventsPath = path.join(root, `${name}.events.jsonl`);
  const commands = literalCommands ?? exits.map((exit, index) => ({ command: `STNL_VERIFICATION_COMMAND=1 node --test check-${index + 1}.mjs`, exit }));
  const events = commands.flatMap(({ command, exit }, index) => [
    { operationId: `runner-${name}`, type: "item.started", item: { id: `item_${index + 1}`, type: "command_execution", command, status: "in_progress", exit_code: null } },
    { operationId: `runner-${name}`, type: "item.completed", item: { id: `item_${index + 1}`, type: "command_execution", command, status: "completed", exit_code: exit } },
  ]);
  await fs.writeFile(semanticResponseFile, response);
  await fs.writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await fs.writeFile(receiptFile, JSON.stringify({ status: "RUNNER_RESPONSE_CAPTURED", operation,
    eventsPath, semanticResponseFile, semanticResponseSha256: createHash("sha256").update(response).digest("hex"),
    captureFailure: null, error: null, exitCode: 0 }));
  return { semanticResponseFile, receiptFile, commands };
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
  for (const status of ["PASS", "BLOCKED"]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await writeValidatedPath(fixture);
    await editTask(fixture, (value) => {
      let task = value.replace("- [ ] 1.1", "- [x] 1.1");
      task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
      task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
      return replaceSection(task, "Diff Summary", "- Verified behavior is implemented.");
    });
    const claimed = sanitizedValidationResponse(status);
    // Like operation 008, the claim lists only the successful checks. The SDK
    // transcript must still own all four literal commands and their exits.
    claimed.commands = failedCheckHistory.filter(({ exit }) => exit === 0);
    claimed.evidence = "Coverage inspected; ad hoc check fixture and usage assertion failed before correction.";
    if (status === "BLOCKED") claimed.blockers = "Invalid check fixture and usage assertion require reliable verification.";
    const captured = await capturedVerificationSequence(t, "VALIDATE_SLICE", JSON.stringify(claimed), [], failedCheckHistory);
    const before = await fs.readFile(path.join(path.dirname(captured.receiptFile), "001-validate_slice-slice-01-attempt-1.events.jsonl"));
    const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01",
      candidateParent: await temporary(t, "stnl-real-check-history-") });
    const result = await prepareValidationCandidate({ specPath: fixture.requirements, slice: "1",
      workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...captured });
    const task = await fs.readFile(path.join(copy.candidateExecutionRoot, "tasks/slice-01.md"), "utf8");
    if (status === "PASS") {
      assert.equal(result.status, "RUNNER_RESULT_BLOCKED");
      assert.match(result.recovery.diagnostic, /contradicts 2 marked verification/u);
      assert.match(task, /## Validation Attempts\n\n- none/u);
    } else {
      assert.equal(result.formalStatus, "BLOCKED");
      for (const { command, exit } of failedCheckHistory) assert.ok(task.includes("`" + command + "` | exit:" + exit));
      assert.match(task, /### attempt-01/u);
    }
    assert.deepEqual(await fs.readFile(path.join(path.dirname(captured.receiptFile), "001-validate_slice-slice-01-attempt-1.events.jsonl")), before);
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

test("captured contradiction publishes blocker, manager consumes bounded recovery, and valid new attempt completes", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await writeValidatedPath(fixture);
  await editTask(fixture, (value) => {
    let task = value.replace("- [ ] 1.1", "- [x] 1.1");
    task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
    task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(task, "Diff Summary", "- Verified behavior is implemented.");
  });
  const candidateParent = await temporary(t, "stnl-recovery-candidates-");
  const response = JSON.stringify({ status: "PASS", head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "semantic claim", exit: 0 }], evidence: "independent checks cover AC-001",
    findingReferences: "none", findingDispositions: "none", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "no changes" });
  async function candidateFor(exits) {
    const captured = await capturedVerificationSequence(t, "VALIDATE_SLICE", response, exits);
    const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent });
    const candidateTask = path.join(copy.candidateExecutionRoot, "tasks", "slice-01.md");
    const prepared = await prepareValidationCandidate({ specPath: fixture.requirements, slice: "1",
      workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...captured });
    return { copy, prepared, captured };
  }
  const first = await candidateFor([1, 0, 0, 0]);
  assert.equal(first.prepared.status, "RUNNER_RESULT_BLOCKED");
  assert.match(first.prepared.recovery.diagnostic, /RUNNER_VERDICT_EVIDENCE_CONFLICT/u);
  assert.equal((await validateExecutionCandidate(fixture.requirements, first.copy.candidateExecutionRoot)).state,
    "RUNNER_RESULT_BLOCKED");
  assert.equal((await publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
    candidateExecutionRoot: first.copy.candidateExecutionRoot })).state, "RUNNER_RESULT_BLOCKED");
  const firstReadback = await inspectExecutionState(fixture.requirements);
  assert.equal(firstReadback.tasks.get("slice-01").attempts.length, 0);
  const readback = { lifecycle: { status: "ready" }, execution: firstReadback, executionRaw: firstReadback };
  const blocked = decideOutcome("VALIDATE_SLICE", readback, true);
  assert.deepEqual(blocked, { result: "BLOCKED", blocker: "OFFICIAL_RUNNER_RESULT_BLOCKED" });
  const recovery = recoverableRunnerHandoff({ operation: "VALIDATE_SLICE", slice: "slice-01", outcome: blocked,
    readback, priorOperations: [], remainingTurns: 2 });
  const budgets = JSON.parse(await fs.readFile(path.join(ROOT, "benchmarks/sentinel-todo/benchmark.json"), "utf8"))
    .cases.find((item) => item.id === "A").budgets;
  const officialRecovery = await prepareOfficialRecovery({ operation: "VALIDATE_SLICE", slice: "slice-01",
    outcome: blocked, readback, priorOperations: [], remainingTurns: 2, budgets, specPath: fixture.requirements,
    product: { validateWorkspace: () => ({ status: "ready" }), inspectExecutionState, preflightExecutionOperation } });
  assert.deepEqual(officialRecovery, { ...recovery, target: firstReadback.recoveryTargets[0] });
  assert.deepEqual(nextHandoff("VALIDATE_SLICE", readback), { operation: "VALIDATE_SLICE", slice: "slice-01" });
  assert.equal(recovery?.authority, firstReadback.currentFingerprint);
  assert.equal((await preflightExecutionOperation(fixture.requirements, recovery.operation, "1")).state,
    "RUNNER_RESULT_BLOCKED");
  assert.equal(recoverableRunnerHandoff({ operation: "VALIDATE_SLICE", slice: "slice-01", outcome: blocked,
    readback, priorOperations: [], remainingTurns: 1 }), null);
  assert.equal(recoverableRunnerHandoff({ operation: "VALIDATE_SLICE", slice: "slice-01", outcome: blocked,
    readback, priorOperations: [{ recovery }], remainingTurns: 20 }), null);

  const secondContradiction = await candidateFor([1, 0]);
  assert.equal(secondContradiction.prepared.status, "RUNNER_RESULT_BLOCKED");
  assert.equal((await validateExecutionCandidate(fixture.requirements, secondContradiction.copy.candidateExecutionRoot)).state,
    "RUNNER_RESULT_BLOCKED");
  assert.equal((await publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
    candidateExecutionRoot: secondContradiction.copy.candidateExecutionRoot })).state, "RUNNER_RESULT_BLOCKED");
  const repeated = await inspectExecutionState(fixture.requirements);
  const repeatedReadback = { lifecycle: { status: "ready" }, execution: repeated, executionRaw: repeated };
  const repeatedOutcome = decideOutcome("VALIDATE_SLICE", repeatedReadback, true);
  assert.equal(recoverableRunnerHandoff({ operation: "VALIDATE_SLICE", slice: "slice-01",
    outcome: repeatedOutcome, readback: repeatedReadback,
    priorOperations: [{ recovery }], remainingTurns: 20 }), null);
  const second = await candidateFor([0, 0]);
  assert.equal(second.prepared.status, "PREPARED");
  assert.equal(second.prepared.formalStatus, "PASS");
  assert.equal((await validateExecutionCandidate(fixture.requirements, second.copy.candidateExecutionRoot)).state,
    "COMPLETE");
  assert.equal((await publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
    candidateExecutionRoot: second.copy.candidateExecutionRoot })).state, "COMPLETE");
  const completed = await inspectExecutionState(fixture.requirements);
  assert.equal(completed.tasks.get("slice-01").attempts.length, 1);
  assert.deepEqual(decideOutcome("VALIDATE_SLICE", { lifecycle: { status: "ready" },
    execution: completed, executionRaw: completed }, true), { result: "PASS", blocker: null });
  assert.deepEqual(nextHandoff("VALIDATE_SLICE", { executionRaw: completed }), { operation: "SPEC_CLOSE", slice: null });
  assert.match(await fs.readFile(path.join(first.copy.candidateExecutionRoot, "tasks", "slice-01.md"), "utf8"),
    /RUNNER_VERDICT_EVIDENCE_CONFLICT/u);
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
  const initial = await capturedVerificationSequence(t, "VALIDATE_SLICE", response, [0]);
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
  const conflicting = await capturedVerificationSequence(t, "VALIDATE_SLICE", response, [1]);
  const recovered = await recoverRejectedValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
    workspace: fixture.root, rejectedCandidateRoot: copy.candidateExecutionRoot, candidateParent, ...conflicting });
  assert.equal(recovered.publishedState, "RUNNER_RESULT_BLOCKED");
  assert.equal(recovered.mandatoryRecovery.operation, "VALIDATE_SLICE");
  assert.equal(await fs.readFile(rejectedTask, "utf8"), rejected);
  assert.notDeepEqual(await fs.readFile(path.join(fixture.execution, "tasks", "slice-01.md")), liveBefore);
  assert.equal((await inspectExecutionState(fixture.requirements)).tasks.get("slice-01").attempts.length, 0);
});

test("missing mechanical evidence is a hard failure, not a malformed runner blocker", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await writeValidatedPath(fixture);
  await editTask(fixture, (value) => {
    let task = value.replace("- [ ] 1.1", "- [x] 1.1");
    task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  const parent = await temporary(t, "stnl-missing-evidence-");
  const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent: parent });
  const response = JSON.stringify({ status: "PASS", head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "semantic claim", exit: 0 }], evidence: "independent checks cover AC-001",
    findingReferences: "none", findingDispositions: "none", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "no changes" });
  const captured = await capturedVerificationSequence(t, "VALIDATE_SLICE", response, [0]);
  await fs.rm(captured.receiptFile);
  const task = path.join(copy.candidateExecutionRoot, "tasks", "slice-01.md");
  const before = await fs.readFile(task);
  await assert.rejects(prepareValidationCandidate({ specPath: fixture.requirements, slice: "1",
    workspace: fixture.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...captured }), /ENOENT/u);
  assert.deepEqual(await fs.readFile(task), before);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("execution producer publishes SDK command and exit despite semantic placeholder and false exit", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await writeValidatedPath(fixture);
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  let candidate = await fs.readFile(copy.candidateTaskArtifact, "utf8");
  candidate = candidate.replace("- [ ] 1.1", "- [x] 1.1");
  candidate = replaceSection(candidate, "Changed Areas", "- `../../src/example.txt`");
  candidate = replaceSection(candidate, "Diff Summary", "- Behavior implemented and checked.");
  await fs.writeFile(copy.candidateTaskArtifact, candidate);
  const response = JSON.stringify({
    status: "TESTS_PASS", automaticCheckRound: "1/3", head: "fixture-head",
    discoverySources: "task", discoveryActions: "inspected tests", verificationTypesConsidered: "unit",
    nonApplicabilityRationale: "none", noVerificationCommandConfirmation: "ran",
    commands: [{ command: "<bounded integration assertions>", exit: 9 }],
    resultOfEachCommandAndExitCode: "passed", selectedChecks: "focused unit",
    selectionRationale: "direct", coverage: "AC-001", failures: "none", priorRoundFailure: "none",
    correctionApplied: "none", inSliceRationale: "none", evidenceOrFailureSummary: "passed",
    affectedFilesOrBehaviors: "example", blockers: "none", unexpectedWorkspaceEffects: "none",
    persistenceSummary: "none",
  });
  const command = "STNL_VERIFICATION_COMMAND=1 node -e `echo quoted`\ncat <<'EOF'\nlong payload\nEOF";
  const captured = await capturedCommandEvidence(t, "EXECUTE_SLICE", response, command);
  const bundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE", response, workspace: fixture.root, taskArtifact: copy.candidateTaskArtifact,
    ...captured,
  });
  assert.ok(bundle.includes(`json:${JSON.stringify(command)} | exit:0`));
  assert.ok(!bundle.includes("<bounded integration assertions>"));
  assert.ok(!bundle.includes("exit:9"));
  await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation: "EXECUTE_SLICE", bundle });
  const strictRoot = path.join(await temporary(t), "execution");
  await copyDirectory(copy.candidateExecutionRoot, strictRoot);
  await fs.rm(path.join(strictRoot, ".stnl-execution-copy.json"));
  assert.equal((await validateExecutionCandidate(fixture.requirements, strictRoot)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("execution producer inserts exact hashed evidence only into its owned candidate", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  const liveTask = path.join(fixture.execution, "tasks", "slice-01.md");
  const liveBefore = await fs.readFile(liveTask, "utf8");
  let candidate = await fs.readFile(copy.candidateTaskArtifact, "utf8");
  candidate = candidate.replace("- [ ] 1.1", "- [x] 1.1");
  candidate = replaceSection(candidate, "Changed Areas", "- `../../src/example.txt`");
  candidate = replaceSection(candidate, "Diff Summary", "- The example behavior is implemented and checked.");
  await fs.writeFile(copy.candidateTaskArtifact, candidate, "utf8");
  const nativeCommand = "STNL_VERIFICATION_COMMAND=1 node -e 'if (1 + 1 !== 2) process.exit(1)'";
  const observed = spawnSync("sh", ["-c", nativeCommand], { encoding: "utf8", cwd: fixture.root });
  assert.equal(observed.status, 0, observed.stderr);
  const response = JSON.stringify({
    status: "TESTS_PASS", automaticCheckRound: "1/3", head: "0123456789abcdef0123456789abcdef01234567",
    discoverySources: "task and package scripts", discoveryActions: "read-only inspection",
    verificationTypesConsidered: "unit tests", nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "verification command executed",
    commands: [{ command: nativeCommand, exit: observed.status }],
    resultOfEachCommandAndExitCode: "unit tests passed", selectedChecks: "focused unit tests",
    selectionRationale: "direct scope", coverage: "example behavior", failures: "none",
    priorRoundFailure: "none", correctionApplied: "none", inSliceRationale: "none",
    evidenceOrFailureSummary: "focused tests passed", affectedFilesOrBehaviors: "example behavior",
    blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes",
  });
  const bundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE", response, workspace: fixture.root, taskArtifact: copy.candidateTaskArtifact,
  });
  assert.match(bundle, /sha256:[0-9a-f]{64}/u);
  assert.match(bundle, /STNL_VERIFICATION_COMMAND=1 node -e/u);
  const failingCommand = "STNL_VERIFICATION_COMMAND=1 node -e 'process.exit(7)'";
  const failed = spawnSync("sh", ["-c", failingCommand], { encoding: "utf8", cwd: fixture.root });
  assert.equal(failed.status, 7);
  await assert.rejects(serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE", workspace: fixture.root, taskArtifact: copy.candidateTaskArtifact,
    response: JSON.stringify({ ...JSON.parse(response), commands: [{ command: failingCommand, exit: failed.status }] }),
  }), /TESTS_PASS contradicts 1 marked verification command/u);
  assert.doesNotMatch(bundle, /Correction paths:|Prior-round failure:|Updated scope:/u);
  assert.equal(await insertExecutionEvidenceInCandidate({
    taskArtifact: copy.candidateTaskArtifact, operation: "EXECUTE_SLICE", bundle,
  }), "### implementation-check-01");
  assert.equal((await fs.readFile(copy.candidateTaskArtifact, "utf8")).includes(bundle), true);
  assert.equal(await fs.readFile(liveTask, "utf8"), liveBefore);
  const strictRoot = path.join(await temporary(t, "stnl-inserted-evidence-strict-"), "execution");
  await copyDirectory(copy.candidateExecutionRoot, strictRoot);
  await fs.rm(path.join(strictRoot, ".stnl-execution-copy.json"));
  assert.equal((await validateExecutionCandidate(fixture.requirements, strictRoot)).state,
    "IMPLEMENTED_AWAITING_VALIDATION");
  await assert.rejects(insertExecutionEvidenceInCandidate({
    taskArtifact: copy.candidateTaskArtifact, operation: "EXECUTE_SLICE", bundle,
  }), /already contains this execution check/u);
  await assert.rejects(insertExecutionEvidenceInCandidate({
    taskArtifact: liveTask, operation: "EXECUTE_SLICE", bundle,
  }), /owned isolated execution candidate/u);
  const cliCopy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  await fs.writeFile(cliCopy.candidateTaskArtifact, candidate, "utf8");
  const responseFile = path.join(await temporary(t, "stnl-insert-response-"), "response.json");
  await fs.writeFile(responseFile, response, "utf8");
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--execution-bundle", "--operation", "EXECUTE_SLICE", "--workspace", fixture.root,
    "--task-artifact", cliCopy.candidateTaskArtifact, "--semantic-response-file", responseFile,
    "--insert-candidate",
  ], { encoding: "utf8", env: Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !["STNL_MANAGED_CONTEXT", "STNL_RUNNER_EVIDENCE_SERIALIZER", "STNL_RUNNER_ADAPTER"].includes(key))) });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /implementation-check-01 inserted into isolated candidate/u);
  assert.match(await fs.readFile(cliCopy.candidateTaskArtifact, "utf8"), /sha256:[0-9a-f]{64}/u);
  assert.equal(await fs.readFile(liveTask, "utf8"), liveBefore);
});

test("command evidence preserves simple, quoted, backtick, multiline, and heredoc commands", async (t) => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT,
    "skills/workflows/stnl-slice-executor/runtime/runner-execute-response.schema.json"), "utf8"));
  assert.equal(schema.properties.commands.items.properties.command.pattern, "^[\\s\\S]+$");
  assert.equal(schema.properties.head.pattern, "^[^\\r\\n`]+$");
  const commands = [
    "npm test",
    `node -e 'console.log("quoted")'`,
    "node -e `echo legitimate`",
    "printf 'first\nsecond'\ncat output.txt",
    "node --input-type=module <<'NODE'\nimport assert from 'node:assert/strict';\nconst value = () => 1 + 1;\nassert.equal(value(), 2);\nNODE",
  ];
  for (const command of commands) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    const target = await writeValidatedPath(fixture);
    const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
    const claim = path.relative(path.dirname(copy.candidateTaskArtifact), target).split(path.sep).join("/");
    let candidate = await fs.readFile(copy.candidateTaskArtifact, "utf8");
    candidate = candidate.replace("- [ ] 1.1", "- [x] 1.1");
    candidate = replaceSection(candidate, "Changed Areas", `- \`${claim}\``);
    candidate = replaceSection(candidate, "Diff Summary", "- Behavior implemented and checked.");
    await fs.writeFile(copy.candidateTaskArtifact, candidate, "utf8");
    const response = JSON.stringify({
      status: "TESTS_PASS", automaticCheckRound: "1/3", head: "fixture-head",
      discoverySources: "task and package", discoveryActions: "inspected tests",
      verificationTypesConsidered: "focused test", nonApplicabilityRationale: "none",
      noVerificationCommandConfirmation: "command executed",
      commands: [{ command, exit: 0 }], resultOfEachCommandAndExitCode: "passed",
      selectedChecks: "focused test", selectionRationale: "direct coverage", coverage: "AC-001",
      failures: "none", priorRoundFailure: "none", correctionApplied: "none", inSliceRationale: "none",
      evidenceOrFailureSummary: "passed", affectedFilesOrBehaviors: "example behavior",
      blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "no changes",
    });
    const bundle = await serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE", response, workspace: fixture.root, taskArtifact: copy.candidateTaskArtifact,
    });
    const carrier = /[`\r\n]/u.test(command) ? `json:${JSON.stringify(command)}` : `\`${command}\``;
    assert.ok(bundle.includes(`  - ${carrier} | exit:0`));
    await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation: "EXECUTE_SLICE", bundle });
    const strictRoot = path.join(await temporary(t, "stnl-command-roundtrip-strict-"), "execution");
    await copyDirectory(copy.candidateExecutionRoot, strictRoot);
    await fs.rm(path.join(strictRoot, ".stnl-execution-copy.json"));
    assert.equal((await validateExecutionCandidate(fixture.requirements, strictRoot)).state,
      "IMPLEMENTED_AWAITING_VALIDATION");
    await fs.copyFile(copy.candidateTaskArtifact, path.join(fixture.execution, "tasks/slice-01.md"));
    const readback = await inspectExecutionState(fixture.requirements);
    assert.equal(readback.tasks.get("slice-01").implementationChecks[0].commands[0].command, command);
  }
});

test("producer rejects empty commands and preserves mechanical status and head rules", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await assert.rejects(serializeRunnerRecord({
    workspace: fixture.root, taskArtifact: path.join(fixture.execution, "tasks/slice-01.md"),
    targets: [await writeValidatedPath(fixture)], commands: [{ command: "", exit: 0 }],
  }), /non-empty command/u);
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  await fs.writeFile(taskArtifact, replaceSection(await fs.readFile(taskArtifact, "utf8"),
    "Changed Areas", "- `../../src/example.txt`"), "utf8");
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
  for (const invalid of [{ status: "FAKE" }, { automaticCheckRound: "4/3" }, { head: "bad`head" }]) {
    await assert.rejects(serializeRunnerExecutionBundleFromResponse({ operation: "EXECUTE_SLICE",
      response: JSON.stringify({ ...base, ...invalid }), workspace: fixture.root, taskArtifact }),
    /Status|Automatic check round|head|single-line scalar/u);
  }
});

test("captured malformed output creates canonical recovery and rejects wrong authority", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await writeValidatedPath(fixture);
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  let preparedTask = await fs.readFile(copy.candidateTaskArtifact, "utf8");
  preparedTask = preparedTask.replace("- [ ] 1.1", "- [x] 1.1");
  preparedTask = replaceSection(preparedTask, "Changed Areas", "- `../../src/example.txt`");
  preparedTask = replaceSection(preparedTask, "Diff Summary", "- Implementation work completed before runner rejection.");
  await fs.writeFile(copy.candidateTaskArtifact, preparedTask, "utf8");
  const root = await temporary(t, "stnl-captured-malformed-");
  const responseFile = path.join(root, "response.json");
  const receiptFile = path.join(root, "receipt.json");
  const response = JSON.stringify({ status: "TESTS_PASS", commands: [{ command: "", exit: 0 }] });
  await fs.writeFile(responseFile, response, "utf8");
  const receipt = {
    status: "RUNNER_RESPONSE_CAPTURED", operation: "EXECUTE_SLICE", semanticResponseFile: responseFile,
    semanticResponseSha256: createHash("sha256").update(response).digest("hex"),
    captureFailure: null, error: null,
  };
  await fs.writeFile(receiptFile, JSON.stringify(receipt), "utf8");
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--execution-bundle", "--operation", "EXECUTE_SLICE", "--workspace", fixture.root,
    "--task-artifact", copy.candidateTaskArtifact, "--semantic-response-file", responseFile,
    "--receipt-file", receiptFile, "--insert-candidate",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).state, "RUNNER_RESULT_BLOCKED");
  const candidate = await fs.readFile(copy.candidateTaskArtifact, "utf8");
  assert.match(candidate, /## Delegation Blocker\n\n- Operation: EXECUTE_SLICE\n- Kind: malformed-output/u);
  const strictRoot = path.join(await temporary(t, "stnl-malformed-strict-"), "execution");
  await copyDirectory(copy.candidateExecutionRoot, strictRoot);
  await fs.rm(path.join(strictRoot, ".stnl-execution-copy.json"));
  const official = await validateExecutionCandidate(fixture.requirements, strictRoot);
  assert.equal(official.state, "RUNNER_RESULT_BLOCKED");
  assert.equal(official.mandatoryRecovery.operation, "EXECUTE_SLICE");
  const blocker = candidate.match(/## Delegation Blocker\n\n([\s\S]*?)\n## Implementation Test Evidence/u)[1].trim();
  const wrong = replaceSection(replaceSection(candidate, "Delegation Blocker", "- none"), "Scope Expansion", blocker);
  await fs.writeFile(path.join(strictRoot, "tasks/slice-01.md"), wrong, "utf8");
  await assert.rejects(validateExecutionCandidate(fixture.requirements, strictRoot),
    /runner recovery in Scope Expansion instead of Delegation Blocker/u);
  await fs.writeFile(copy.candidateTaskArtifact, candidate, "utf8");
  await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, status: "RUNNER_NOT_STARTED" }), "utf8");
  await assert.rejects(persistMalformedRunnerResultInCandidate({
    taskArtifact: copy.candidateTaskArtifact, operation: "EXECUTE_SLICE", receiptFile, semanticResponseFile: responseFile,
    diagnostic: "invalid command",
  }), /matching captured runner response/u);
  assert.equal(await fs.readFile(copy.candidateTaskArtifact, "utf8"), candidate);
});

test("captured producer rejection resumes APPLY and VALIDATE through their own operations", async (t) => {
  for (const operation of ["APPLY_FINDINGS", "VALIDATE_SLICE"]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await writeValidatedPath(fixture);
    await editTask(fixture, (value) => {
      let task = value.replace("- [ ] 1.1", "- [x] 1.1");
      task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
      task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
      if (operation === "APPLY_FINDINGS") {
        task = replaceSection(task, "Validation Attempts", NEEDS_FIX_ATTEMPT);
        task = replaceSection(task, "Validation Findings", ACTIVE_FINDING);
      }
      return task;
    });
    const root = await temporary(t, "stnl-operation-recovery-");
    const responseFile = path.join(root, "response.json");
    const receiptFile = path.join(root, "receipt.json");
    const response = "{malformed json";
    await fs.writeFile(responseFile, response, "utf8");
    await fs.writeFile(receiptFile, JSON.stringify({
      status: "RUNNER_RESPONSE_CAPTURED", operation, semanticResponseFile: responseFile,
      semanticResponseSha256: createHash("sha256").update(response).digest("hex"),
      captureFailure: null, error: null,
    }), "utf8");
    let candidateRoot;
    if (operation === "APPLY_FINDINGS") {
      const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
      candidateRoot = path.join(root, "execution");
      const cli = spawnSync(process.execPath, [
        path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
        "--execution-bundle", "--operation", operation, "--workspace", fixture.root,
        "--task-artifact", copy.candidateTaskArtifact, "--semantic-response-file", responseFile,
        "--receipt-file", receiptFile, "--insert-candidate",
      ], { encoding: "utf8" });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).state, "RUNNER_RESULT_BLOCKED");
      await copyDirectory(copy.candidateExecutionRoot, candidateRoot);
      await fs.rm(path.join(candidateRoot, ".stnl-execution-copy.json"));
    } else {
      candidateRoot = path.join(root, "execution");
      await copyDirectory(fixture.execution, candidateRoot);
      const prepared = await prepareValidationCandidate({
        specPath: fixture.requirements, slice: "1", workspace: fixture.root,
        candidateExecutionRoot: candidateRoot, semanticResponseFile: responseFile, receiptFile,
      });
      assert.equal(prepared.status, "RUNNER_RESULT_BLOCKED");
    }
    const strict = await validateExecutionCandidate(fixture.requirements, candidateRoot);
    assert.equal(strict.state, "RUNNER_RESULT_BLOCKED");
    assert.equal(strict.mandatoryRecovery.operation, operation);
  }
});

test("APPLY and VALIDATE share lossless command and explanatory carriers", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await writeValidatedPath(fixture);
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  await fs.writeFile(taskArtifact, replaceSection(await fs.readFile(taskArtifact, "utf8"),
    "Changed Areas", "- `../../src/example.txt`"), "utf8");
  const command = "node --input-type=module <<'NODE'\nconsole.log(`result`);\nNODE";
  const explanation = "line one\nline `two`";
  const execute = {
    status: "TESTS_PASS", automaticCheckRound: "1/3", head: "fixture-head",
    discoverySources: explanation, discoveryActions: "inspection", verificationTypesConsidered: "unit",
    nonApplicabilityRationale: "none", noVerificationCommandConfirmation: "ran",
    commands: [{ command, exit: 0 }], resultOfEachCommandAndExitCode: "pass",
    selectedChecks: "unit", selectionRationale: "direct", coverage: "AC-001", failures: "none",
    evidenceOrFailureSummary: explanation, affectedFilesOrBehaviors: "example", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "none",
  };
  const apply = {
    ...execute, findingsCycle: "attempt-01", findingsVerified: "none", correctionsCovered: explanation,
    regressionsSelected: explanation, unsupportedActiveFindings: "none",
  };
  const applyBundle = await serializeRunnerExecutionBundleFromResponse({ operation: "APPLY_FINDINGS",
    response: JSON.stringify(apply), workspace: fixture.root, taskArtifact });
  assert.ok(applyBundle.includes(`json:${JSON.stringify(command)} | exit:0`));
  assert.ok(applyBundle.includes(`json:${JSON.stringify(explanation)}`));
  const validation = {
    status: "PASS", head: "fixture-head", commands: [{ command, exit: 0 }], evidence: explanation,
    findingReferences: "none", findingDispositions: "none", blockers: "none",
    unexpectedWorkspaceEffects: explanation, persistenceSummary: "none",
  };
  const validationBundle = await serializeRunnerValidationBundleFromResponse({ operation: "VALIDATE_SLICE",
    response: JSON.stringify(validation), workspace: fixture.root, taskArtifact,
    specPath: fixture.requirements, slice: "1" });
  assert.equal(validationBundle.split(`json:${JSON.stringify(command)} | exit:0`).length - 1, 3);
  assert.ok(validationBundle.includes(`Evidence: json:${JSON.stringify(explanation)}`));
});

test("APPLY round two derives required correction fields from existing authority", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await writeValidatedPath(fixture);
  await editTask(fixture, (value) => {
    let task = value.replace("- [ ] 1.1", "- [x] 1.1");
    task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
    task = replaceSection(task, "Corrections Applied", "- `../../src/example.txt`");
    task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    task = replaceSection(task, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    task = replaceSection(task, "Validation Findings", ACTIVE_FINDING);
    return replaceSection(task, "Findings Test Evidence",
      checkRecord("findings-check", 1, "TESTS_FAIL", 1, { cycle: "attempt-01" }));
  });
  const payload = {
    status: "TESTS_PASS", automaticCheckRound: "2/3", findingsCycle: "attempt-01", head: "fixture-head",
    discoverySources: "task", discoveryActions: "inspection", verificationTypesConsidered: "unit",
    nonApplicabilityRationale: "none", noVerificationCommandConfirmation: "ran",
    commands: [{ command: "npm test", exit: 0 }], resultOfEachCommandAndExitCode: "pass",
    selectedChecks: "unit", selectionRationale: "same finding correction", coverage: "AC-001",
    findingsVerified: "finding-01", correctionsCovered: "corrected observable mismatch",
    regressionsSelected: "unit", unsupportedActiveFindings: "none", failures: "none",
    evidenceOrFailureSummary: "pass", affectedFilesOrBehaviors: "example", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "none",
  };
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: "APPLY_FINDINGS",
    response: JSON.stringify(payload), workspace: fixture.root,
    taskArtifact: path.join(fixture.execution, "tasks/slice-01.md") });
  assert.match(bundle, /- Prior-round failure: observable mismatch/u);
  assert.match(bundle, /- Correction applied: corrected observable mismatch/u);
  assert.match(bundle, /- In-slice rationale: same finding correction/u);
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

test("prepared fixture failure uses existing execution correction and preserves both rounds", async (t) => {
  // The semantic verdict is supplied by a fake runner. This proves persistence,
  // paths and budgets after TESTS_FAIL, not an LLM's ability to classify a defect.
  for (const operation of ["EXECUTE_SLICE", "APPLY_FINDINGS"]) {
    const fixture = await nestedLifecycleWorkspace(t);
    const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
    const sourceClaim = path.relative(path.dirname(liveTask), path.join(fixture.root, "src/example.txt")).split(path.sep).join("/");
    const priorAttempt = NEEDS_FIX_ATTEMPT.replaceAll("../../src/example.txt", sourceClaim);
    if (operation === "APPLY_FINDINGS") {
      await editTask(fixture, (value) => {
        let task = value.replace("- [ ] 1.1", "- [x] 1.1");
        task = replaceSection(task, "Changed Areas", `- \`${sourceClaim}\``);
        task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll("../../src/example.txt", sourceClaim));
        task = replaceSection(task, "Validation Attempts", priorAttempt);
        return replaceSection(task, "Validation Findings", ACTIVE_FINDING);
      });
    }
    const targets = [path.join(fixture.root, "src/example.txt"),
      path.join(fixture.root, "test/prepared-fixture.json"), path.join(fixture.root, "test/prepared-check.mjs")];
    const claims = targets.map((target) => path.relative(path.dirname(liveTask), target).split(path.sep).join("/"));
    await setImplementationAreas(fixture, {
      global: targets.map((target) => path.relative(fixture.execution, target)).join("`, `"),
      detail: claims.join("`, `"), task: claims.join("`, `"),
    });
    await fs.mkdir(path.dirname(targets[1]), { recursive: true });
    await fs.writeFile(targets[1], JSON.stringify({ enabled: "true" }));
    const checkSource = 'import assert from "node:assert/strict";\nimport fs from "node:fs";\n'
      + 'const fixture = JSON.parse(fs.readFileSync(new URL("./prepared-fixture.json", import.meta.url)));\n'
      + 'assert.equal(typeof fixture.enabled, "boolean", "prepared fixture enabled must be boolean");\n';
    await fs.writeFile(targets[2], checkSource);
    const before = await fs.readFile(liveTask);
    const runtime = path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime");
    const calls = [];
    function cli(label, helper, args) {
      calls.push(label);
      return spawnSync(process.execPath, [path.join(runtime, helper), ...args], {
        cwd: fixture.root, encoding: "utf8", timeout: 10_000,
      });
    }
    const prepareArgs = ["--prepare", "--spec-path", fixture.requirements, "--slice", "slice-01"];
    const prepared = cli("prepare", "prepare-execution-copy.mjs", prepareArgs);
    assert.equal(prepared.status, 0, prepared.stderr);
    const copy = JSON.parse(prepared.stdout);
    t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
    await fs.writeFile(copy.candidateTaskArtifact, replaceSection(
      (await fs.readFile(copy.candidateTaskArtifact, "utf8")).replace("- [ ] 1.1", "- [x] 1.1"),
      "Changed Areas", claims.map((claim) => `- \`${claim}\``).join("\n")));
    const bundles = [];
    const receipts = [];
    let rejected;
    let rejectedBytes;
    let rejectedMarker;
    for (const round of [1, 2]) {
      if (round === 2) {
        // Author-owned correction changes only the authorized fixture, keeping
        // the check, assertions, implementation and approved contracts intact.
        await fs.writeFile(targets[1], JSON.stringify({ enabled: true }));
        calls.push("authorized correction");
        await fs.writeFile(copy.candidateTaskArtifact,
          replaceSection(await fs.readFile(copy.candidateTaskArtifact, "utf8"), "Corrections Applied", `- \`${claims[1]}\``));
      }
      const checkedBytes = await Promise.all(targets.map((target) => fs.readFile(target)));
      const check = spawnSync(process.execPath, [targets[2]], { cwd: fixture.root, encoding: "utf8" });
      calls.push(`fake runner ${round}`);
      assert.equal(check.status, round === 1 ? 1 : 0, check.stderr);
      if (round === 1) assert.match(check.stderr, /prepared fixture enabled must be boolean/u);
      assert.deepEqual(await Promise.all(targets.map((target) => fs.readFile(target))), checkedBytes, "runner check is read-only");
      const payload = {
        status: round === 1 ? "TESTS_FAIL" : "TESTS_PASS", automaticCheckRound: `${round}/3`, head: "fixture-head",
        discoverySources: "prepared check and approved task", discoveryActions: "inspected fixture contract",
        verificationTypesConsidered: "focused prepared check", nonApplicabilityRationale: "none",
        noVerificationCommandConfirmation: "check executed",
        commands: [{ command: "STNL_VERIFICATION_COMMAND=1 node test/prepared-check.mjs", exit: check.status }],
        resultOfEachCommandAndExitCode: `check exit ${check.status}`,
        selectedChecks: "node test/prepared-check.mjs", selectionRationale: "authorized fixture and unchanged assertion",
        coverage: "AC-001 prepared fixture contract", failures: round === 1 ? "prepared fixture enabled must be boolean" : "none",
        evidenceOrFailureSummary: round === 1 ? "fixture string violates boolean input contract; behavior is unverified" : "valid fixture passes unchanged assertion",
        affectedFilesOrBehaviors: "test/prepared-fixture.json", blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes",
        ...(operation === "EXECUTE_SLICE" ? {
          priorRoundFailure: round === 1 ? "none" : "prepared fixture enabled must be boolean",
          correctionApplied: round === 1 ? "none" : "author corrected enabled to a boolean",
          inSliceRationale: "only the approved fixture changed; input contract preserved",
        } : { findingsCycle: "attempt-01", findingsVerified: round === 1 ? "none" : "finding-01",
          unsupportedActiveFindings: round === 1 ? "finding-01" : "none", correctionsCovered: "author corrected the approved fixture",
          regressionsSelected: "unchanged prepared assertion" }),
      };
      const captured = await capturedVerificationSequence(t, operation, JSON.stringify(payload), [],
        [{ command: "STNL_VERIFICATION_COMMAND=1 node test/prepared-check.mjs", exit: check.status }]);
      receipts.push(await fs.readFile(captured.receiptFile));
      const serialized = cli(`serialize ${round}`, "serialize-runner-evidence.mjs", [
        "--execution-bundle", "--operation", operation, "--workspace", fixture.root,
        "--task-artifact", copy.candidateTaskArtifact, "--semantic-response-file", captured.semanticResponseFile,
        "--receipt-file", captured.receiptFile, "--insert-candidate",
      ]);
      assert.equal(serialized.status, 0, serialized.stderr);
      const identifier = serialized.stdout.match(/^(### (?:implementation|findings)-check-[0-9]+) inserted into isolated candidate\n$/u)?.[1];
      assert.ok(identifier, serialized.stdout);
      const candidateText = await fs.readFile(copy.candidateTaskArtifact, "utf8");
      const start = candidateText.indexOf(`${identifier}\n`);
      const bundle = candidateText.slice(start, candidateText.indexOf("\n## ", start)).trimEnd();
      bundles.push(bundle);
      if (round === 1) {
        // Reject a separate owned proposal; never validate/reject the working
        // candidate between rounds or mutate this rejected proposal afterward.
        const negative = cli("negative prepare", "prepare-execution-copy.mjs", prepareArgs);
        assert.equal(negative.status, 0, negative.stderr);
        rejected = JSON.parse(negative.stdout);
        t.after(() => fs.rm(rejected.candidateRoot, { recursive: true, force: true }));
        await fs.writeFile(rejected.candidateTaskArtifact, candidateText);
        rejectedBytes = await fs.readFile(rejected.candidateTaskArtifact);
        rejectedMarker = await fs.readFile(path.join(rejected.candidateRoot, ".stnl-execution-copy.json"));
        const invalid = cli("negative validate", "validate-execution-state.mjs", [
          fixture.requirements, "--candidate", rejected.candidateExecutionRoot,
        ]);
        assert.equal(invalid.status, 1, invalid.stderr);
        assert.match(invalid.stderr, /unterminated .* automatic correction cycle/u);
        const premature = cli("negative publish", "prepare-execution-copy.mjs", [
          "--publish", "--spec-path", fixture.requirements, "--slice", "slice-01",
          "--candidate-root", rejected.candidateRoot,
        ]);
        assert.equal(premature.status, 1, premature.stderr);
        assert.match(premature.stderr, /unterminated .* automatic correction cycle/u);
        assert.deepEqual(await fs.readFile(rejected.candidateTaskArtifact), rejectedBytes);
        assert.equal(await fs.readFile(copy.candidateTaskArtifact, "utf8"), candidateText);
      } else {
        const valid = cli("terminal validate", "validate-execution-state.mjs", [
          fixture.requirements, "--candidate", copy.candidateExecutionRoot,
        ]);
        assert.equal(valid.status, 0, valid.stderr);
        assert.match(valid.stdout, new RegExp(`state=${operation === "EXECUTE_SLICE" ? "IMPLEMENTED_AWAITING_VALIDATION" : "FINDINGS_CORRECTED"}`));
      }
      await assert.rejects(serializeRunnerExecutionBundleFromResponse({ operation,
        response: JSON.stringify({ ...payload, automaticCheckRound: "4/3" }), workspace: fixture.root,
        taskArtifact: copy.candidateTaskArtifact }), /Automatic check round is invalid/u);
      assert.deepEqual(await fs.readFile(liveTask), before, "live authority stays unchanged until publication");
      assert.deepEqual(await fs.readFile(captured.receiptFile), receipts.at(-1));
    }
    const finalTask = await fs.readFile(copy.candidateTaskArtifact, "utf8");
    for (const bundle of bundles) assert.ok(finalTask.includes(bundle), "earlier failure remains byte-identical");
    assert.match(bundles[0], /Status: TESTS_FAIL[\s\S]*exit:1/u);
    assert.match(bundles[1], /Status: TESTS_PASS[\s\S]*exit:0/u);
    assert.ok(bundles[1].includes(`- Correction paths: ${claims[1]}`));
    assert.equal((finalTask.match(/^### (?:implementation|findings)-check-\d+$/gmu) ?? []).length,
      operation === "EXECUTE_SLICE" ? 2 : 3);
    assert.equal(await fs.readFile(targets[2], "utf8"), checkSource);
    assert.equal(await fs.readFile(targets[0], "utf8"), VALIDATED_CONTENT);
    const publication = cli("terminal publish", "prepare-execution-copy.mjs", [
      "--publish", "--spec-path", fixture.requirements, "--slice", "slice-01", "--candidate-root", copy.candidateRoot,
    ]);
    assert.equal(publication.status, 0, publication.stderr);
    const published = await fs.readFile(liveTask, "utf8");
    for (const bundle of bundles) assert.ok(published.includes(bundle));
    if (operation === "APPLY_FINDINGS") {
      assert.ok(published.includes(priorAttempt));
      assert.ok(published.includes(ACTIVE_FINDING), "only formal revalidation can resolve a finding");
    }
    assert.match(published, /## Final Result\n\n- pending/u);
    assert.deepEqual(await fs.readFile(rejected.candidateTaskArtifact), rejectedBytes, "rejected proposal stays untouched after terminal publication");
    assert.deepEqual(await fs.readFile(path.join(rejected.candidateRoot, ".stnl-execution-copy.json")), rejectedMarker);
    const readback = cli("handoff", "validate-execution-state.mjs", [fixture.requirements, "--handoff-after", operation]);
    assert.equal(readback.status, 0, readback.stderr);
    assert.equal(JSON.parse(readback.stdout).normal_handoff.operation, "VALIDATE_SLICE");
    assert.deepEqual(calls, ["prepare", "fake runner 1", "serialize 1", "negative prepare", "negative validate",
      "negative publish", "authorized correction", "fake runner 2", "serialize 2", "terminal validate", "terminal publish", "handoff"]);
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
      const captured = await capturedVerificationSequence(t, operation, JSON.stringify(payload), [], commands);
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
    const optional = branch.title === "VALIDATE_SLICE" ? [] : ["filelessReason"];
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
  await fs.writeFile(fixture.requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  await renderArtifacts(fixture);
  const alias = path.join(root, "alias-project");
  await fs.symlink(real, alias, "dir");
  await assert.rejects(inspectExecutionState(alias), /symlink component/u);
  await assert.rejects(inspectExecutionState(path.join(alias, "requirements.md")), /symlink component/u);
});

test("deterministic plan serializer rebases detailed claims from global physical targets before validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const physicalTarget = path.join(fixture.root, "src", "serializer-target.mjs");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, "export const target = true;\n", "utf8");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailedClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: globalClaim, detail: globalClaim });

  const candidateRoot = path.join(await temporary(t, "stnl-plan-serializer-candidate-"), "execution");
  const liveDetailBytes = await fs.readFile(path.join(fixture.execution, "plans", "slice-01.md"));
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /invalid artifact-relative implementation path|possible path-basis error/u,
  );
  await assert.rejects(
    serializePlanPathClaims({
      specPath: fixture.execution,
      candidateExecutionRoot: candidateRoot,
    }),
    /workspace feature_spec\.md must be a single-link real file/u,
    "passing executionRoot as SPEC_PATH makes the official resolver seek execution/feature_spec.md",
  );

  const first = await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.equal(first.status, "PASS");
  assert.equal(first.serializedClaims, 1);
  assert.equal(first.candidateValidation.state, "PLANNED_READY");
  assert.equal(first.candidateValidation.currentFingerprint, await computeRequirementsAuthority(fixture.requirements));
  assert.deepEqual(first.changedPaths, [path.join(candidateRoot, "plans", "slice-01.md")]);
  const serialized = await fs.readFile(path.join(candidateRoot, "plans", "slice-01.md"), "utf8");
  assert.equal(serialized.includes(`\`${detailedClaim}\``), true);
  assert.equal(
    await fs.realpath(path.resolve(path.dirname(path.join(fixture.execution, "plans", "slice-01.md")), detailedClaim)),
    await fs.realpath(physicalTarget),
  );
  await assert.doesNotReject(validateExecutionCandidate(fixture.requirements, candidateRoot));

  const canonicalBytes = await fs.readFile(path.join(candidateRoot, "plans", "slice-01.md"));
  const second = await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.deepEqual(second.changedPaths, []);
  assert.deepEqual(await fs.readFile(path.join(candidateRoot, "plans", "slice-01.md")), canonicalBytes);

  const invalidCandidateRoot = path.join(await temporary(t, "stnl-plan-serializer-invalid-state-"), "execution");
  await fs.cp(candidateRoot, invalidCandidateRoot, { recursive: true });
  const invalidDetailPath = path.join(invalidCandidateRoot, "plans", "slice-01.md");
  const invalidDetailBefore = await fs.readFile(invalidDetailPath, "utf8");
  await fs.writeFile(invalidDetailPath, invalidDetailBefore
    .replace("status: ready", "status: draft")
    .replace("Review state: approved", "Review state: pending"), "utf8");
  const invalidDetailSnapshot = await fs.readFile(invalidDetailPath);
  await assert.rejects(
    serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: invalidCandidateRoot }),
    /ready global plan retains a draft detailed plan/u,
  );
  assert.deepEqual(await fs.readFile(invalidDetailPath), invalidDetailSnapshot);
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "plans", "slice-01.md")), liveDetailBytes);

  const ambiguousRoot = path.join(await temporary(t, "stnl-plan-serializer-ambiguous-"), "execution");
  await fs.cp(candidateRoot, ambiguousRoot, { recursive: true });
  const ambiguousPath = path.join(ambiguousRoot, "plans", "slice-01.md");
  const ambiguousBefore = await fs.readFile(ambiguousPath);
  await fs.writeFile(ambiguousPath, ambiguousBefore.toString("utf8").replace(
    `\`${detailedClaim}\` — example implementation`,
    `\`${detailedClaim}\`; \`another-target.mjs\` — example implementation`,
  ), "utf8");
  const ambiguousSnapshot = await fs.readFile(ambiguousPath);
  assert.notDeepEqual(ambiguousSnapshot, ambiguousBefore);
  assert.match(ambiguousSnapshot.toString("utf8"), /another-target\.mjs/u);
  await assert.rejects(
    serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: ambiguousRoot }),
    /contains more path claims than its global slice row|has 2 path claims but its global slice row has 1/u,
  );
  assert.deepEqual(await fs.readFile(ambiguousPath), ambiguousSnapshot);

  const malformedRoot = path.join(await temporary(t, "stnl-plan-serializer-malformed-"), "execution");
  await fs.cp(candidateRoot, malformedRoot, { recursive: true });
  const malformedPlan = path.join(malformedRoot, "plan.md");
  const malformedBefore = await fs.readFile(malformedPlan);
  await fs.writeFile(malformedPlan, malformedBefore.toString("utf8").replace(
    globalClaim,
    "../../src/serializer-target.mjs",
  ), "utf8");
  const malformedSnapshot = await fs.readFile(malformedPlan);
  await assert.rejects(
    serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: malformedRoot }),
    /possible path-basis error/u,
  );
  assert.deepEqual(await fs.readFile(malformedPlan), malformedSnapshot);
});

test("planning coverage has one reference for full AC delivery and bounded requirement contributions", async () => {
  const planner = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/SKILL.md"), "utf8");
  const reviewer = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-plan-reviewer/SKILL.md"), "utf8");
  const global = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  const detail = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  for (const consumer of [planner, reviewer, global]) assert.match(consumer, /slice-plan\.template\.md[\s\S]{0,100}Requirements/u);
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
  const executionReceipt = await capturedVerificationSequence(t, "EXECUTE_SLICE", JSON.stringify(implementationResponse), [], implementationResponse.commands);
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
  const validationReceipt = await capturedVerificationSequence(t, "VALIDATE_SLICE", JSON.stringify({ status: "PASS", head: "fixture-head",
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
          for (const ref of span[1].matchAll(/(?:<([A-Z_]+)>\/)?(?:runtime\/)?([a-z][a-z-]+\.mjs)/gu)) {
            const owner = roots.get(ref[1] ?? "SKILL_ROOT");
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
    await assert.rejects(fs.stat(path.join(layout, 'stnl-slice-quality-manager/runtime/capture-runner-response.mjs')), { code: 'ENOENT' });
  }
});

test("shared planning and capture recipes dispatch from their declared owners independently of cwd", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "draft" });
  const target = path.join(fixture.root, 'src/example.txt');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'fixture implementation\n');
  await setImplementationAreas(fixture, { global: 'src/example.txt' });
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
    const candidate = path.join(copyRoot, `candidate-${index}`);
    await fs.cp(fixture.execution, candidate, { recursive: true });
    const values = { '<SPEC_PATH>': fixture.requirements, '<CANDIDATE_EXECUTION_ROOT>': candidate };
    for (const filename of ['prepare-plan-candidate.mjs', 'serialize-plan-paths.mjs']) {
      const recipe = helperRecipe(reviewerRoot, text, filename, values);
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

test("planner content creation recipe renders writable candidates from frozen templates through strict PLAN publication", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "draft" });
  const target = path.join(fixture.root, "src/example.txt");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "observable implementation target\n");
  const requirementsBefore = await fs.readFile(path.join(fixture.requirements, "feature_spec.md"));
  await setImplementationAreas(fixture, { global: "src/example.txt" });
  const relativePaths = ["plan.md", "plans/slice-01.md"];
  const authored = await Promise.all(relativePaths.map((relative) => fs.readFile(path.join(fixture.execution, relative), "utf8")));
  // Keep the fixture's authored bodies outside live authority before starting PLAN.
  const staging = await temporary(t, "stnl-plan-content ü-");
  await fs.rename(fixture.execution, path.join(staging, "authored-reference"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "PLAN")).state, "EMPTY");
  const references = path.join(staging, "frozen references");
  const candidateRoot = path.join(staging, "new candidate/execution");
  await fs.mkdir(references);
  await fs.mkdir(path.join(candidateRoot, "plans"), { recursive: true });
  const frozen = [];
  for (const name of ["plan.template.md", "slice-plan.template.md"]) {
    const bytes = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates", name));
    const file = path.join(references, name);
    await fs.writeFile(file, bytes, { flag: "wx", mode: 0o444 });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o444);
    frozen.push({ file, bytes });
  }
  // Reproduce the inherited mode without attempting a denied write, even as root.
  const copied = path.join(staging, "metadata-copy-control.md");
  await fs.copyFile(frozen[0].file, copied);
  assert.equal((await fs.stat(copied)).mode & 0o222, 0, "copying a frozen template propagates its read-only mode");
  const skill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/SKILL.md"), "utf8");
  const recipe = /node --input-type=module -e '([^']+)' "<TEMPLATE_PATH>" "<NEW_CANDIDATE_ARTIFACT>"/u.exec(skill)?.[1];
  assert.ok(recipe, "planner must document creation by content without inheriting template permissions");
  for (const [index, relative] of relativePaths.entries()) {
    const file = path.join(candidateRoot, relative);
    const args = ["--input-type=module", "-e", recipe, frozen[index].file, file];
    const created = spawnSync(process.execPath, args, { cwd: fixture.root, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    assert.deepEqual(await fs.readFile(file), frozen[index].bytes);
    assert.notEqual((await fs.stat(file)).mode & 0o200, 0, "new candidate artifact is owner-writable before editing or preparation");
    const collision = spawnSync(process.execPath, args, { cwd: fixture.root, encoding: "utf8" });
    assert.notEqual(collision.status, 0);
    assert.match(collision.stderr, /EEXIST/u);
    assert.deepEqual(await fs.readFile(file), frozen[index].bytes, "creation never overwrites an existing candidate");
    const body = authored[index].replace(/^# File Purpose Header\n\n```yaml\n[\s\S]*?^```\n\n/mu, "");
    assert.notEqual(body, authored[index]);
    await fs.writeFile(file, body, "utf8");
    assert.equal(await fs.readFile(file, "utf8"), body, "normal authoring works without a permission change");
  }
  const prepared = await preparePlanCandidate({ candidateExecutionRoot: candidateRoot });
  assert.equal(prepared.status, "PASS");
  assert.equal(prepared.changedPaths.length, 2);
  const serialized = await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.equal(serialized.status, "PASS");
  assert.equal(serialized.candidateValidation.state, "PLANNED_DRAFT");
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "EMPTY", "validation never publishes planning authority");
  const candidateBytes = await Promise.all(relativePaths.map((relative) => fs.readFile(path.join(candidateRoot, relative))));
  // Initial PLAN has no standalone publisher helper: publish only validated planning paths, as its contract prescribes.
  await fs.mkdir(path.join(fixture.execution, "plans"), { recursive: true });
  for (const relative of relativePaths) {
    await fs.copyFile(path.join(candidateRoot, relative), path.join(fixture.execution, relative));
  }
  const readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "PLANNED_DRAFT");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");
  assert.deepEqual(nextHandoff("PLAN", { execution: readback, executionRaw: readback, product: { deriveNormalHandoff } }),
    { operation: "REVIEW_PLAN", slice: null });
  for (const [index, relative] of relativePaths.entries()) {
    const file = path.join(fixture.execution, relative);
    assert.deepEqual(await fs.readFile(file), candidateBytes[index]);
    assert.match(candidateBytes[index].toString(), /^status: draft$/mu);
    assert.notEqual((await fs.stat(file)).mode & 0o200, 0);
  }
  await assert.rejects(fs.stat(path.join(fixture.execution, "tasks.md")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(fixture.requirements, "feature_spec.md")), requirementsBefore);
  for (const { file, bytes } of frozen) {
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o444);
  }
});

test("deterministic plan candidate preparation serializes template headers before strict validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "draft" });
  const physicalTarget = path.join(fixture.root, "src", "example.txt");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, "export const target = true;\n", "utf8");
  const candidateRoot = path.join(await temporary(t, "stnl-plan-header-candidate-"), "execution");
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });

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
    /File Purpose Header/u,
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

  const conflictingRoot = await copyDirectory(
    candidateRoot,
    path.join(await temporary(t, "stnl-plan-header-conflict-"), "execution"),
  );
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

  const readyRoot = path.join(await temporary(t, "stnl-plan-header-ready-"), "execution");
  await fs.cp(candidateRoot, readyRoot, { recursive: true });
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

  const malformedRoot = path.join(await temporary(t, "stnl-plan-header-malformed-"), "execution");
  await fs.cp(conflictingRoot, malformedRoot, { recursive: true });
  const malformedPath = path.join(malformedRoot, "plan.md");
  const malformedBefore = await fs.readFile(malformedPath, "utf8");
  await fs.writeFile(malformedPath, malformedBefore.replace("status: draft\n", "status: draft\nstatus: ready\n"), "utf8");
  const malformedSnapshot = await fs.readFile(malformedPath, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, malformedRoot),
    /File Purpose Header/u,
  );
  await assert.rejects(
    preparePlanCandidate({ candidateExecutionRoot: malformedRoot }),
    /malformed or conflicting File Purpose Header/u,
  );
  assert.deepEqual(await fs.readFile(malformedPath, "utf8"), malformedSnapshot);
});

test("deterministic plan serializer canonicalizes repository-relative semantic targets before strict validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const physicalTarget = path.join(fixture.root, "src", "semantic-target.mjs");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, "export const target = true;\n", "utf8");

  const candidateRoot = path.join(await temporary(t, "stnl-plan-semantic-candidate-"), "execution");
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });
  const candidateFixture = { ...fixture, execution: candidateRoot };
  await fs.rm(fixture.execution, { recursive: true });
  await setImplementationAreas(candidateFixture, {
    global: "src/semantic-target.mjs",
    detail: "src/semantic-target.mjs",
  });

  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /artifact-relative implementation path/u,
  );
  const serialized = await serializePlanPathClaims({
    specPath: fixture.requirements,
    candidateExecutionRoot: candidateRoot,
  });
  assert.equal(serialized.status, "PASS");
  assert.equal(serialized.candidateValidation.state, "PLANNED_READY");
  assert.deepEqual(serialized.changedPaths.slice().sort(), [
    path.join(candidateRoot, "plan.md"),
    path.join(candidateRoot, "plans/slice-01.md"),
  ].sort());
  const global = await fs.readFile(path.join(candidateRoot, "plan.md"), "utf8");
  const detail = await fs.readFile(path.join(candidateRoot, "plans/slice-01.md"), "utf8");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  assert.equal(global.includes(`\`${globalClaim}\``), true);
  assert.equal(detail.includes(`\`${detailClaim}\``), true);
  assert.equal(serialized.candidateValidation.currentFingerprint, await computeRequirementsAuthority(fixture.requirements));

  const escapedDelimiterRoot = path.join(await temporary(t, "stnl-plan-semantic-escaped-"), "execution");
  await fs.cp(candidateRoot, escapedDelimiterRoot, { recursive: true });
  const escapedPlanPath = path.join(escapedDelimiterRoot, "plan.md");
  const escapedBefore = await fs.readFile(escapedPlanPath, "utf8");
  const escapedCarrier = ["`", "src/semantic-target.mjs", "\\", "`"].join("");
  await fs.writeFile(
    escapedPlanPath,
    escapedBefore.replace(`\`${globalClaim}\``, escapedCarrier),
    "utf8",
  );
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, escapedDelimiterRoot),
    /artifact-relative implementation path/u,
  );
  const escapedSerialized = await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: escapedDelimiterRoot });
  assert.equal(escapedSerialized.candidateValidation.state, "PLANNED_READY");
  const escapedCanonicalPlan = await fs.readFile(escapedPlanPath, "utf8");
  assert.equal(escapedCanonicalPlan.includes(`\`${globalClaim}\``), true);
  assert.equal(
    (await validateExecutionCandidate(fixture.requirements, escapedDelimiterRoot)).state,
    "PLANNED_READY",
  );

  const malformedRoot = path.join(await temporary(t, "stnl-plan-semantic-malformed-"), "execution");
  await fs.cp(candidateRoot, malformedRoot, { recursive: true });
  const malformedPlan = path.join(malformedRoot, "plan.md");
  const malformedBefore = await fs.readFile(malformedPlan);
  await fs.writeFile(
    malformedPlan,
    malformedBefore.toString("utf8").replace(globalClaim, "src/../semantic-target.mjs"),
    "utf8",
  );
  const malformedSnapshot = await fs.readFile(malformedPlan);
  await assert.rejects(
    serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: malformedRoot }),
    /semantic physical implementation target must be a normalized repository-relative path/u,
  );
  assert.deepEqual(await fs.readFile(malformedPlan), malformedSnapshot);
});

test("deterministic task serializer rebases approved plan targets before validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const physicalTarget = path.join(fixture.root, "src", "example.txt");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  const taskClaim = path.relative(path.join(fixture.execution, "tasks"), physicalTarget).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: globalClaim, detail: detailClaim, task: globalClaim });

  const candidateRoot = path.join(await temporary(t, "stnl-task-serializer-candidate-"), "execution");
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /possible path-basis error|resolves inside the lifecycle SPEC workspace/u,
  );

  const first = await serializeTaskPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.equal(first.status, "PASS");
  assert.equal(first.serializedClaims, 1);
  assert.deepEqual(first.changedPaths, [path.join(candidateRoot, "tasks", "slice-01.md")]);
  const serialized = await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md"), "utf8");
  assert.equal(serialized.includes(`\`${taskClaim}\``), true);
  assert.match(serialized, /example implementation/u);
  assert.equal(
    await fs.realpath(path.resolve(path.dirname(path.join(fixture.execution, "tasks", "slice-01.md")), taskClaim)),
    await fs.realpath(physicalTarget),
  );
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidateRoot)).state, "MATERIALIZED_PRISTINE");

  const canonicalBytes = await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md"));
  const second = await serializeTaskPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.deepEqual(second.changedPaths, []);
  assert.deepEqual(await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md")), canonicalBytes);

  const ambiguousRoot = path.join(await temporary(t, "stnl-task-serializer-ambiguous-"), "execution");
  await fs.cp(candidateRoot, ambiguousRoot, { recursive: true });
  const ambiguousPath = path.join(ambiguousRoot, "tasks", "slice-01.md");
  const ambiguousBefore = await fs.readFile(ambiguousPath);
  await fs.writeFile(ambiguousPath, ambiguousBefore.toString("utf8").replace(
    /(\| expected areas: )`[^`\n]+`/u,
    `$1\`${taskClaim}\`; \`another-target.mjs\``,
  ), "utf8");
  const ambiguousSnapshot = await fs.readFile(ambiguousPath);
  assert.notDeepEqual(ambiguousSnapshot, ambiguousBefore);
  assert.match(ambiguousSnapshot.toString("utf8"), /another-target\.mjs/u);
  await assert.rejects(
    serializeTaskPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: ambiguousRoot }),
    /has 2 path claims but its approved plan has 1/u,
  );
  assert.deepEqual(await fs.readFile(ambiguousPath), ambiguousSnapshot);

  const malformed = await nestedLifecycleWorkspace(t);
  const malformedTarget = path.join(malformed.root, "src", "example.txt");
  const malformedGlobal = path.relative(malformed.execution, malformedTarget).split(path.sep).join("/");
  const malformedDetail = path.relative(path.join(malformed.execution, "plans"), malformedTarget).split(path.sep).join("/");
  await setImplementationAreas(malformed, {
    global: malformedGlobal,
    detail: malformedDetail.replace(/^\.\.\//u, ""),
    task: malformedGlobal,
  });
  const malformedRoot = path.join(await temporary(t, "stnl-task-serializer-malformed-"), "execution");
  await fs.cp(malformed.execution, malformedRoot, { recursive: true });
  const malformedTask = path.join(malformedRoot, "tasks", "slice-01.md");
  const malformedBefore = await fs.readFile(malformedTask);
  await assert.rejects(
    serializeTaskPathClaims({ specPath: malformed.requirements, candidateExecutionRoot: malformedRoot }),
    /possible path-basis error/u,
  );
  assert.deepEqual(await fs.readFile(malformedTask), malformedBefore);
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

test("execution producer blocks omitted Changed Areas without inferring scope from the worktree", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskArtifact, "utf8");
  assert.match(before, /## Changed Areas\n\n- pending\n/u);
  await assert.rejects(
    serializeExecutionScopeClaims({ workspace: fixture.root, taskArtifact }),
    /Changed Areas cannot remain pending after execution work/u,
  );
  assert.equal(await fs.readFile(taskArtifact, "utf8"), before);

  const executorSkill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  assert.match(executorSkill, /`Changed Areas` MUST NOT remain the pristine `- pending` sentinel/u);
});

test("execution evidence is produced on a same-depth candidate and published as one task replacement", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveBefore = await fs.readFile(liveTask, "utf8");
  const prepared = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  t.after(() => fs.rm(prepared.candidateRoot, { recursive: true, force: true }));
  assert.equal(path.dirname(prepared.candidateRoot), path.dirname(fixture.requirements));
  assert.equal(path.relative(prepared.candidateTaskArtifact, path.join(fixture.root, "src/example.txt")),
    path.relative(liveTask, path.join(fixture.root, "src/example.txt")));
  const target = path.join(fixture.root, "src/example.txt");
  const claim = path.relative(path.dirname(liveTask), target).split(path.sep).join("/");
  let candidateText = await fs.readFile(prepared.candidateTaskArtifact, "utf8");
  candidateText = candidateText.replace("- [ ] 1.1", "- [x] 1.1");
  candidateText = replaceSection(candidateText, "Changed Areas", `- \`${claim}\``);
  await fs.writeFile(prepared.candidateTaskArtifact, candidateText, "utf8");
  const response = JSON.stringify({
    status: "TESTS_PASS", automaticCheckRound: "1/3", head: "fixture-head",
    discoverySources: "task and package scripts", discoveryActions: "read-only inspection",
    verificationTypesConsidered: "unit tests", nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "not applicable",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    resultOfEachCommandAndExitCode: "all passed", selectedChecks: "node --test test/example.test.mjs",
    selectionRationale: "direct coverage", coverage: "changed behavior", failures: "none",
    priorRoundFailure: "none", correctionApplied: "none", inSliceRationale: "none",
    evidenceOrFailureSummary: "focused tests passed", affectedFilesOrBehaviors: "example behavior",
    blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "record persisted",
  });
  const record = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE", response, workspace: fixture.root,
    taskArtifact: prepared.candidateTaskArtifact,
  });
  candidateText = await fs.readFile(prepared.candidateTaskArtifact, "utf8");
  await fs.writeFile(prepared.candidateTaskArtifact,
    replaceSection(candidateText, "Implementation Test Evidence", record), "utf8");
  assert.equal(await fs.readFile(liveTask, "utf8"), liveBefore);
  assert.equal((await validateExecutionCandidate(fixture.requirements, prepared.candidateExecutionRoot)).state,
    "IMPLEMENTED_AWAITING_VALIDATION");
  const published = await publishExecutionCopy({ specPath: fixture.requirements,
    slice: "slice-01", candidateRoot: prepared.candidateRoot });
  assert.equal(published.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.match(await fs.readFile(liveTask, "utf8"), /### implementation-check-01/u);
  await assert.rejects(fs.stat(prepared.candidateRoot), { code: "ENOENT" });
});

test("materializer candidate preparation copies the complete execution tree into an isolated root", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const prepared = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  assert.equal(prepared.status, "PASS");
  assert.notEqual(prepared.candidateExecutionRoot, await fs.realpath(fixture.execution));
  assert.equal(
    path.relative(await fs.realpath(fixture.execution), prepared.candidateExecutionRoot).startsWith(`..${path.sep}`),
    true,
  );
  for (const relative of ["plan.md", "plans/slice-01.md", "tasks.md", "tasks/slice-01.md"]) {
    assert.deepEqual(
      await fs.readFile(path.join(prepared.candidateExecutionRoot, relative)),
      await fs.readFile(path.join(fixture.execution, relative)),
    );
  }
  assert.equal(prepared.copiedEntries > 0, true);
  const alias = path.join(path.dirname(fixture.requirements), "requirements-alias");
  await fs.symlink(fixture.requirements, alias, "dir");
  await assert.rejects(
    prepareTaskMaterializationCandidate({ specPath: alias }),
    /symlink component/u,
  );
});

test("candidate helper CLIs execute from a frozen skill path containing spaces", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const root = await temporary(t, "stnl-helper-path-space-");
  const bundle = path.join(root, "frozen skill bundle");
  await fs.mkdir(bundle);
  for (const skill of ["stnl-execution-planner", "stnl-task-materializer"]) {
    await fs.cp(path.join(ROOT, "skills/workflows", skill), path.join(bundle, skill), { recursive: true });
  }
  const materializerRoot = path.join(bundle, "stnl-task-materializer");
  const contract = await fs.readFile(path.join(materializerRoot, "SKILL.md"), "utf8");
  assert.match(contract, /Resolve bundled `references\/` and `templates\/` from `<SKILL_ROOT>`, the directory containing this SKILL.md, independently of SPEC_PATH, the execution root, candidate root or command cwd/u);
  const resources = new Set([...contract.matchAll(/`<SKILL_ROOT>\/((?:references|templates)\/[^`]+)`/gu)].map((match) => match[1]));
  assert.deepEqual([...resources].sort(), ["references/execution-record-schema.md", "templates/slice-tasks.template.md", "templates/tasks.template.md"]);
  assert.doesNotMatch(contract, /`references\/execution-record-schema\.md`|including[^\n]*`references\/`/u);
  for (const resource of resources) {
    const bytes = await fs.readFile(path.join(materializerRoot, resource));
    assert.deepEqual(bytes, await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer", resource)));
    await assert.rejects(fs.stat(path.join(fixture.execution, resource)), { code: "ENOENT" });
  }
  const livePlan = await fs.readFile(path.join(fixture.execution, "plan.md"));
  const liveDetail = await fs.readFile(path.join(fixture.execution, "plans/slice-01.md"));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "PLANNED_READY");
  const environment = { ...process.env, TMPDIR: root };
  const preparer = path.join(bundle, "stnl-task-materializer/runtime/prepare-task-candidate.mjs");
  const prepared = spawnSync(process.execPath, [preparer, "--prepare", "--spec-path", fixture.requirements], {
    encoding: "utf8", env: environment,
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const result = JSON.parse(prepared.stdout);
  assert.equal(result.status, "PASS");
  assert.equal(path.dirname(result.candidateExecutionRoot), root);
  assert.equal((await fs.lstat(path.join(result.candidateExecutionRoot, "plan.md"))).isFile(), true);
  await renderTasks(fixture, {
    templateRoot: path.join(materializerRoot, "templates"), outputExecutionRoot: result.candidateExecutionRoot,
  });
  await assert.rejects(fs.stat(path.join(fixture.execution, "tasks.md")), { code: "ENOENT" });
  const published = spawnSync(process.execPath, [path.join(materializerRoot, "runtime/publish-task-candidate.mjs"),
    "--publish", "--spec-path", fixture.requirements, "--candidate-execution-root", result.candidateExecutionRoot], {
    cwd: fixture.root, encoding: "utf8", env: environment,
  });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(JSON.parse(published.stdout).status, "PASS");
  const materialized = await inspectExecutionState(fixture.requirements);
  assert.equal(materialized.state, "MATERIALIZED_PRISTINE");
  assert.equal(deriveNormalHandoff(materialized, "MATERIALIZE_TASKS").operation, "REVIEW_TASKS");
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "plan.md")), livePlan);
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "plans/slice-01.md")), liveDetail);
  await assert.rejects(fs.stat(path.join(fixture.execution, "references")), { code: "ENOENT" });
  for (const helper of [
    "stnl-execution-planner/runtime/prepare-plan-candidate.mjs",
    "stnl-execution-planner/runtime/serialize-plan-paths.mjs",
    "stnl-task-materializer/runtime/serialize-task-paths.mjs",
  ]) {
    const invoked = spawnSync(process.execPath, [path.join(bundle, helper)], { encoding: "utf8", env: environment });
    assert.notEqual(invoked.status, 0, `${helper} silently skipped its CLI guard`);
    assert.match(invoked.stderr, /usage:/u);
  }
});

test("materializer candidate publication revalidates and never publishes hard-linked execution files", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const prepared = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  const candidateState = await validateExecutionCandidate(fixture.requirements, prepared.candidateExecutionRoot);
  assert.equal(candidateState.state, "MATERIALIZED_PRISTINE");
  const published = await publishTaskMaterializationCandidate({
    specPath: fixture.requirements,
    candidateExecutionRoot: prepared.candidateExecutionRoot,
  });
  assert.equal(published.status, "PASS");
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  const liveTasks = path.join(fixture.execution, "tasks.md");
  const candidateTasks = path.join(prepared.candidateExecutionRoot, "tasks.md");
  const liveMetadata = await fs.lstat(liveTasks);
  const candidateMetadata = await fs.lstat(candidateTasks);
  assert.equal(liveMetadata.isFile(), true);
  assert.equal(candidateMetadata.isFile(), true);
  assert.equal(liveMetadata.nlink, 1);
  assert.equal(candidateMetadata.nlink, 1);
  assert.notEqual(liveMetadata.ino, candidateMetadata.ino);
  assert.deepEqual(await fs.readFile(liveTasks), await fs.readFile(candidateTasks));
});

test("materializer publication serializes task paths before strict candidate validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const prepared = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  const target = path.join(fixture.root, "src/example.txt");
  const taskPath = path.join(prepared.candidateExecutionRoot, "tasks/slice-01.md");
  const liveTaskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const canonicalTaskClaim = path.relative(path.dirname(liveTaskPath), target).split(path.sep).join("/");
  const malformedClaim = canonicalTaskClaim.replace(/^\.\.\//u, "");
  assert.notEqual(canonicalTaskClaim, malformedClaim);
  const before = await fs.readFile(taskPath, "utf8");
  const malformed = before.replace(`\`${canonicalTaskClaim}\``, `\`${malformedClaim}\``);
  assert.notEqual(malformed, before);
  await fs.writeFile(taskPath, malformed, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, prepared.candidateExecutionRoot),
    /possible path-basis error|artifact-relative implementation path/u,
  );

  const published = await publishTaskMaterializationCandidate({
    specPath: fixture.requirements,
    candidateExecutionRoot: prepared.candidateExecutionRoot,
  });
  assert.equal(published.status, "PASS");
  assert.equal(published.serializedTaskPaths, 1);
  const liveTask = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  assert.equal(liveTask.includes(`\`${canonicalTaskClaim}\``), true);
  assert.equal(liveTask.includes(`\`${malformedClaim}\``), false);
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
  const requirements = path.join(root, "requirements.md");
  await fs.writeFile(requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  const execution = path.join(root, "requirements-execution");
  return { root, requirements, execution, count };
}

async function rebasePlanClaimToTask({ specPath, planArtifact, planClaim, slice = "01" }) {
  const { executionRoot } = await resolveMaterializerExecutionWorkspace(specPath);
  const physicalTarget = path.resolve(path.dirname(planArtifact), planClaim);
  const taskPath = path.join(executionRoot, "tasks", `slice-${slice}.md`);
  const taskClaim = path.relative(path.dirname(taskPath), physicalTarget).split(path.sep).join("/");
  return { executionRoot, physicalTarget, taskPath, taskClaim };
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
  templateRoot = path.join(ROOT, "skills/workflows/stnl-task-materializer/templates"),
  outputExecutionRoot = fixture.execution } = {}) {
  const authority = fingerprint ?? await computeRequirementsAuthority(fixture.requirements);
  const requirementsMetadata = await fs.stat(fixture.requirements);
  const authorityPath = requirementsMetadata.isDirectory() ? path.join(fixture.requirements, "feature_spec.md") : fixture.requirements;
  const detailSource = path.relative(path.join(fixture.execution, "plans"), authorityPath).split(path.sep).join("/");
  const implementationRoot = fixture.root ?? (requirementsMetadata.isDirectory() ? fixture.requirements : path.dirname(fixture.requirements));
  const taskImplementationPath = path.relative(
    path.join(fixture.execution, "tasks"),
    path.join(implementationRoot, "src/example.txt"),
  ).split(path.sep).join("/");
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
    ["<task>", "Implement behavior"], ["<result>", "observable result"],
    ["`<artifact-relative path>`; <optional conceptual area>", `\`${taskImplementationPath}\`; example implementation`],
    ["<test, command, suite, or observable check>", "node --test"],
  ]);
  await fs.writeFile(path.join(outputExecutionRoot, "tasks/slice-01.md"), task);
}

async function renderArtifacts(fixture, { materialized = true, planStatus = "ready", revision = 1, fingerprint = null } = {}) {
  const authority = fingerprint ?? await computeRequirementsAuthority(fixture.requirements);
  const requirementsMetadata = await fs.stat(fixture.requirements);
  const authorityPath = requirementsMetadata.isDirectory() ? path.join(fixture.requirements, "feature_spec.md") : fixture.requirements;
  const globalSource = path.relative(fixture.execution, authorityPath).split(path.sep).join("/");
  const detailSource = path.relative(path.join(fixture.execution, "plans"), authorityPath).split(path.sep).join("/");
  const implementationRoot = fixture.root ?? (requirementsMetadata.isDirectory() ? fixture.requirements : path.dirname(fixture.requirements));
  const implementationTarget = path.join(implementationRoot, "src/example.txt");
  const globalImplementationPath = path.relative(fixture.execution, implementationTarget).split(path.sep).join("/");
  const detailImplementationPath = path.relative(path.join(fixture.execution, "plans"), implementationTarget).split(path.sep).join("/");
  await fs.mkdir(path.join(fixture.execution, "plans"), { recursive: true });
  const planTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  let global = omitInitialRecoveryFields(replaceAll(planTemplate, [
    ["`<relative path>`", `\`${globalSource}\``], ["sha256:<64hex>", `sha256:${authority}`],
    ["<positive integer>", String(revision)], ["<compact objective>", "Deliver observable behavior"],
    ["<compact strategy>", "Implement and validate serially"], ["01 - <name>", "01 - Delivery"],
    ["<result>", "observable result"],
    ["Model-selected physical target (repository-relative before serialization): `<repository-relative physical target>`; <optional conceptual area> (plain-text description)", `\`${globalImplementationPath}\`; example implementation (plain-text description)`],
  ]));
  if (planStatus === "ready") global = headerReady(global);
  await fs.writeFile(path.join(fixture.execution, "plan.md"), global);
  const slicePlanTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  let slicePlan = replaceAll(slicePlanTemplate, [
    ["<Name>", "Delivery"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", String(revision)],
    ["<One coherent delivery and how it is observed.>", "Deliver observable behavior."],
    ["<included work>", "Implement the approved behavior."], ["<excluded work and boundary with later slices>", "No unrelated work."],
    ["`<artifact-relative path>` — <optional contract, subsystem, test area, or explanation>", `\`${detailImplementationPath}\` — example implementation`],
    ["<earlier slice or none>", "none"],
    ["<risk and mitigation>", "Low risk; focused validation."], ["<bounded approach>", "One bounded change."],
    ["<test, command, suite, or observable check>", "node --test"], ["<objective result and preserved boundary>", "Behavior is observable and bounded."],
  ]);
  if (planStatus === "ready") slicePlan = headerReady(slicePlan);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-01.md"), slicePlan);
  if (!materialized) return { authority };
  await renderTasks(fixture, { revision, fingerprint: authority });
  await fs.mkdir(path.dirname(implementationTarget), { recursive: true });
  await fs.writeFile(implementationTarget, VALIDATED_CONTENT, "utf8");
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

async function nestedLifecycleWorkspace(t, { materialized = true, planStatus = "ready" } = {}) {
  const root = await temporary(t, "stnl-path-semantics-");
  const repository = path.join(root, "repository with space ü");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const requirements = await copyDirectory(
    path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"),
    path.join(repository, "specs", "área segura", "feature Ω"),
  );
  const fixture = { root: repository, repository, requirements, execution: path.join(requirements, "execution") };
  await fs.mkdir(path.join(repository, "scripts"), { recursive: true });
  await fs.writeFile(path.join(repository, "scripts/validate.sh"), "#!/bin/sh\n", "utf8");
  await fs.mkdir(path.join(repository, "skills/workflows"), { recursive: true });
  await fs.writeFile(path.join(repository, "skills/workflows/example.mjs"), "export {};\n", "utf8");
  await renderArtifacts(fixture, { materialized, planStatus });
  return fixture;
}

async function editTask(fixture, transform) {
  const file = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(file, "utf8");
  await fs.writeFile(file, transform(before), "utf8");
}

async function editTasksIndex(fixture, transform) {
  const file = path.join(fixture.execution, "tasks.md");
  const before = await fs.readFile(file, "utf8");
  await fs.writeFile(file, transform(before), "utf8");
}

async function editPlan(fixture, transform) {
  const file = path.join(fixture.execution, "plan.md");
  await fs.writeFile(file, transform(await fs.readFile(file, "utf8")), "utf8");
}

async function editSlicePlan(fixture, slice, transform) {
  const file = path.join(fixture.execution, "plans", `${slice}.md`);
  await fs.writeFile(file, transform(await fs.readFile(file, "utf8")), "utf8");
}

function reviseAuthority(text, oldHash, newHash, oldRevision, newRevision) {
  return text.replaceAll(`sha256:${oldHash}`, `sha256:${newHash}`).replaceAll(`Plan revision: ${oldRevision}`, `Plan revision: ${newRevision}`);
}

async function stagePristineReplacement(fixture, oldHash, newHash, { ready = false } = {}) {
  await editPlan(fixture, (value) => {
    let result = reviseAuthority(value, oldHash, newHash, 1, 2).replace("- Review state: approved", `- Review state: ${ready ? "approved" : "pending"}`);
    result = result.replace("status: ready", `status: ${ready ? "ready" : "draft"}`);
    return result.replace("- Objective: Deliver observable behavior", `- Revision mode: pristine-replacement\n- Replan reason: task review found a plan-level defect\n- Supersedes open slices: none\n- Objective: Deliver observable behavior`);
  });
  await editSlicePlan(fixture, "slice-01", (value) => reviseAuthority(value, oldHash, newHash, 1, 2).replace("status: ready", `status: ${ready ? "ready" : "draft"}`).replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`));
}

async function replacePlanningOnly(fixture, oldHash, newHash, { ready = false } = {}) {
  await editPlan(fixture, (value) => setPlanReviewState(
    reviseAuthority(value, oldHash, newHash, 1, 1)
      .replace("- Objective: Deliver observable behavior", "- Objective: Deliver replacement planning authority"),
    ready,
  ));
  await editSlicePlan(fixture, "slice-01", (value) => setPlanReviewState(
    reviseAuthority(value, oldHash, newHash, 1, 1)
      .replace("Deliver observable behavior.", "Deliver replacement planning authority."),
    ready,
  ));
}

async function appendRecoveryPlan(fixture, oldHash, newHash, { ready = false, supersedes = "slice-01 -> slice-02" } = {}) {
  await editPlan(fixture, (value) => {
    let result = reviseAuthority(value, oldHash, newHash, 1, 2).replace("status: ready", `status: ${ready ? "ready" : "draft"}`).replace("- Review state: approved", `- Review state: ${ready ? "approved" : "pending"}`);
    result = result.replace("- Objective: Deliver observable behavior", `- Revision mode: append-only-extension\n- Replan reason: requirements or integration authority changed\n- Supersedes open slices: ${supersedes}\n- Objective: Deliver observable behavior`);
    return result.replace(
      "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |",
      "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |\n| 02 - Recovery | reconciled result | 01 | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-02.md |",
    );
  });
  // Historical plan/task authority remains immutable.
  await editSlicePlan(fixture, "slice-01", (value) => reviseAuthority(value, newHash, oldHash, 2, 1));
  const source = await fs.readFile(path.join(fixture.execution, "plans/slice-01.md"), "utf8");
  let appended = source
    .replaceAll("Slice 01", "Slice 02")
    .replaceAll("- Slice: 01", "- Slice: 02")
    .replaceAll("Delivery", "Recovery")
    .replaceAll(`sha256:${oldHash}`, `sha256:${newHash}`)
    .replaceAll("Plan revision: 1", "Plan revision: 2")
    .replace("status: ready", `status: ${ready ? "ready" : "draft"}`)
    .replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-02.md"), appended, "utf8");
}

async function commitAppendRecovery(fixture, oldHash, newHash, { resolveDivergence = false } = {}) {
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Final Result", "- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 2");
    if (resolveDivergence) result = replaceSection(result, "Divergences", `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: resolved")}\n- Resolution: plan revision 2 committed recovery slice-02`);
    return result;
  });
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | SUPERSEDED | SUPERSEDED |\n| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |",
  ));
  const template = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  const appended = replaceAll(template, [
    ["Slice 01", "Slice 02"], ["- Slice: 01", "- Slice: 02"], ["<Name>", "Recovery"],
    ["plans/slice-01.md", "plans/slice-02.md"], ["`<relative path>`", "`../../requirements.md`"],
    ["sha256:<64hex>", `sha256:${newHash}`], ["<positive integer>", "2"],
    ["<task>", "Reconcile behavior"], ["<result>", "reconciled result"],
    ["`<artifact-relative path>`; <optional conceptual area>", "`../../src/example.txt`; example implementation"],
    ["<test, command, suite, or observable check>", "node --test"],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-02.md"), appended, "utf8");
}

async function addSecondPristineSlice(fixture) {
  await editPlan(fixture, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |\n| 02 - Later | later result | 01 | AC-001 | `../src/later.txt`; later implementation (plain-text description) | plans/slice-02.md |",
  ));
  const plan = (await fs.readFile(path.join(fixture.execution, "plans/slice-01.md"), "utf8"))
    .replaceAll("Slice 01", "Slice 02").replaceAll("- Slice: 01", "- Slice: 02").replaceAll("Delivery", "Later");
  await fs.writeFile(path.join(fixture.execution, "plans/slice-02.md"), plan, "utf8");
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |\n| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |",
  ));
  const task = (await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8"))
    .replaceAll("Slice 01", "Slice 02").replaceAll("- Slice: 01", "- Slice: 02")
    .replaceAll("plans/slice-01.md", "plans/slice-02.md").replaceAll("Delivery", "Later").replace("1.1", "2.1");
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-02.md"), task, "utf8");
}

async function stageThirdRecovery(fixture, authority, { ready = false } = {}) {
  await editPlan(fixture, (value) => value
    .replace("status: ready", `status: ${ready ? "ready" : "draft"}`)
    .replace("Plan revision: 2", "Plan revision: 3")
    .replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`)
    .replace("- Supersedes open slices: slice-01 -> slice-02", "- Supersedes open slices: slice-02 -> slice-03")
    .replace(
      "| 02 - Recovery | reconciled result | 01 | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-02.md |",
      "| 02 - Recovery | reconciled result | 01 | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-02.md |\n| 03 - Recovery | reconciled result | 02 | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-03.md |",
    ));
  let plan = await fs.readFile(path.join(fixture.execution, "plans/slice-02.md"), "utf8");
  plan = plan.replaceAll("Slice 02", "Slice 03").replaceAll("- Slice: 02", "- Slice: 03")
    .replace("Plan revision: 2", "Plan revision: 3")
    .replace("status: ready", `status: ${ready ? "ready" : "draft"}`)
    .replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`)
    .replaceAll(`sha256:${authority}`, `sha256:${authority}`);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-03.md"), plan, "utf8");
}

async function commitThirdRecovery(fixture, authority) {
  const secondPath = path.join(fixture.execution, "tasks/slice-02.md");
  await fs.writeFile(secondPath, replaceSection(await fs.readFile(secondPath, "utf8"), "Final Result", "- SUPERSEDED\n- Superseded by: slice-03\n- Plan revision: 3"), "utf8");
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |",
    "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | SUPERSEDED | SUPERSEDED |\n| [ ] | 03 - Recovery | reconciled result | 02 | tasks/slice-03.md | pending | pending |",
  ));
  const template = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  const third = replaceAll(template, [
    ["Slice 01", "Slice 03"], ["- Slice: 01", "- Slice: 03"], ["<Name>", "Recovery"],
    ["plans/slice-01.md", "plans/slice-03.md"], ["`<relative path>`", "`../../requirements.md`"],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", "3"],
    ["<task>", "Reconcile behavior again"], ["<result>", "reconciled result"],
    ["`<artifact-relative path>`; <optional conceptual area>", "`../../src/example.txt`; example implementation"],
    ["<test, command, suite, or observable check>", "node --test"], ["1.1", "3.1"],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-03.md"), third, "utf8");
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

function assertRecoveryTarget(result, expected) {
  const target = result.recoveryTargets.find((candidate) => (
    candidate.operation === expected.operation && candidate.slice === (expected.slice ?? null)
  ));
  assert.ok(target, `missing recovery target ${expected.operation} ${expected.slice ?? "unscoped"}`);
  for (const [field, value] of Object.entries(expected)) assert.equal(target[field], value, `${field} disagrees`);
  return target;
}

async function passFirstSlice(fixture) {
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await writeValidatedPath(fixture);
}

async function prepareFindingsCorrection(fixture, findingIdsLabel = "Finding IDs") {
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    const check = checkRecord("findings-check", 1, "TESTS_NOT_APPLICABLE", 1, { cycle: "attempt-01" })
      .replace("- Finding IDs: finding-01", `- ${findingIdsLabel}: finding-01`);
    return replaceSection(result, "Findings Test Evidence", check);
  });
}

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

test("validation overlap paths may repeat across records but not within one record", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const claims = ["../../src/example.txt", "../../src/second.txt", "../../src/third.txt"];
  await Promise.all(claims.slice(1).map((claim) => writeValidatedPath(fixture, claim)));
  const originalTask = replaceSection(await fs.readFile(taskArtifact, "utf8"),
    "Changed Areas", `- \`${claims[0]}\``);
  const overlap = (slice, paths) => `- Slice ${slice} overlap: ${paths.map((claim) => `\`${claim}\``).join(", ")}; preserve prior behavior.`;
  const response = JSON.stringify({
    status: "PASS", head: "fixture-head", commands: [{ command: "node --test", exit: 0 }],
    evidence: "Focused validation passed.", findingReferences: "none", findingDispositions: "none",
    blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "No runner writes.",
  });
  const options = { operation: "VALIDATE_SLICE", response, workspace: fixture.root,
    taskArtifact, specPath: fixture.requirements, slice: "1" };
  const assertDeduplicated = async (task) => {
    await fs.writeFile(taskArtifact, task, "utf8");
    const executorBundle = await serializeRunnerValidationBundleFromResponse(options);
    const managerBundle = await serializeQualityManagerValidationBundleFromResponse(options);
    assert.equal(managerBundle, executorBundle, "mirrored producers must emit the same evidence");
    const testedRecord = executorBundle.match(/- Tested record:\n- Tested state:\n([\s\S]*?)\n- Commands:/u)?.[1];
    assert.ok(testedRecord, "producer must emit a physical tested record");
    const emitted = [...testedRecord.matchAll(/^  - `([^`]+)` \| sha256:[0-9a-f]{64}$/gmu)].map((match) => match[1]);
    assert.deepEqual(emitted, claims, "each physical target must appear exactly once");
  };
  await assertDeduplicated(replaceSection(originalTask, "Prior Validation Overlap",
    `${overlap("01", claims)}\n${overlap("02", claims)}`));
  await assertDeduplicated(replaceSection(originalTask, "Prior Validation Overlap",
    `### overlap-01\n\n- Prior slice: slice-01\n- Paths: ${claims.join(", ")}\n\n### overlap-02\n\n- Prior slice: slice-02\n- Paths: ${claims.join(", ")}`));
  await fs.writeFile(taskArtifact, replaceSection(originalTask, "Prior Validation Overlap",
    overlap("01", [claims[0], claims[0]])), "utf8");
  await assert.rejects(serializeRunnerValidationBundleFromResponse(options),
    /Prior Validation Overlap contains duplicate path claim/u);
  await assert.rejects(serializeQualityManagerValidationBundleFromResponse(options),
    /Prior Validation Overlap contains duplicate path claim/u);
});

test("an isolated copied skill runs the stable self-contained preflight CLI", async (t) => {
  const root = await temporary(t);
  const copied = path.join(root, "copied-skill");
  await fs.mkdir(path.join(copied, "runtime"), { recursive: true });
  for (const name of ["execution-state.mjs", "validate-execution-state.mjs"]) {
    await fs.copyFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime", name), path.join(copied, "runtime", name));
  }
  const requirements = path.join(root, "requirements.md");
  await fs.writeFile(requirements, "# Isolated requirements\n");
  const result = spawnSync(process.execPath, [path.join(copied, "runtime/validate-execution-state.mjs"), requirements, "PLAN"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS: PLAN preflight state=EMPTY authority=sha256:[0-9a-f]{64}$/mu);

  const materialized = await standaloneWorkspace(t);
  await renderArtifacts(materialized);
  const afterMaterialize = spawnSync(process.execPath, [
    path.join(copied, "runtime/validate-execution-state.mjs"),
    materialized.requirements,
    "--handoff-after",
    "MATERIALIZE_TASKS",
  ], { encoding: "utf8", cwd: root });
  assert.equal(afterMaterialize.status, 0, afterMaterialize.stderr);
  const materializeTransition = JSON.parse(afterMaterialize.stdout);
  assert.equal(materializeTransition.normal_handoff.workflowSkill, "stnl-task-reviewer");
  assert.equal(materializeTransition.normal_handoff.invocation, "OPERATION=REVIEW_TASKS");
  assert.deepEqual(new Set(materializeTransition.legal_operations.map(({ operation }) => operation)), new Set([
    "REVIEW_TASKS", "EXECUTE_SLICE", "REPLAN",
  ]));

  const afterReview = spawnSync(process.execPath, [
    path.join(copied, "runtime/validate-execution-state.mjs"),
    materialized.requirements,
    "--handoff-after",
    "REVIEW_TASKS",
  ], { encoding: "utf8", cwd: root });
  assert.equal(afterReview.status, 0, afterReview.stderr);
  const reviewTransition = JSON.parse(afterReview.stdout);
  assert.equal(reviewTransition.normal_handoff.workflowSkill, "stnl-slice-executor");
  assert.equal(reviewTransition.normal_handoff.invocation, "OPERATION=EXECUTE_SLICE");
  assert.equal(reviewTransition.normal_handoff.slice, "slice-01");
});

test("every touched model-authored execution writer requires candidate validation and strict readback", async () => {
  for (const skill of SKILLS) {
    const source = await fs.readFile(path.join(ROOT, `skills/workflows/${skill}/SKILL.md`), "utf8");
    if (["stnl-execution-planner", "stnl-plan-reviewer"].includes(skill)) {
      assert.match(source, /serialize-plan-paths\.mjs[\s\S]{0,500}official `validateExecutionCandidate` authority/u, skill);
      assert.doesNotMatch(source, /validate-execution-state\.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>/u, skill);
    } else {
      assert.match(source, /validate-execution-state\.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>/u, skill);
      assert.match(source, /contract\/model(?:-| )(?:enforced|enforcement|owned)/u, skill);
    }
    assert.match(source, /strict(?:ly)? read(?:back| back)/u, skill);
    assert.match(source, /Findings IDs[\s\S]{0,180}Check discovery sources[\s\S]{0,80}Check discovery actions[\s\S]{0,240}--repair-known-contract/u, skill);
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
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_TASKS")).state, "MATERIALIZED_PRISTINE");
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
  await renderArtifacts(ready, { materialized: false, planStatus: "ready" });
  const readyState = await inspectExecutionState(ready.requirements);
  assert.deepEqual(readyState.legalOperations.map(({ operation }) => operation), ["REVIEW_PLAN", "MATERIALIZE_TASKS", "REPLAN"]);
  assert.equal(deriveNormalHandoff(readyState, "REVIEW_PLAN").workflowSkill, "stnl-task-materializer");
  assert.equal(deriveNormalHandoff(readyState, "REVIEW_PLAN").invocation, "OPERATION=MATERIALIZE_TASKS");

  const materialized = await standaloneWorkspace(t);
  await renderArtifacts(materialized);
  const materializedState = await inspectExecutionState(materialized.requirements);
  assert.deepEqual(materializedState.legalOperations.map(({ operation }) => operation), ["REVIEW_TASKS", "REPLAN", "EXECUTE_SLICE"]);
  assert.equal(materializedState.normalHandoff, null, "persisted state alone cannot prove whether task review ran");
  const afterMaterialize = deriveNormalHandoff(materializedState, "MATERIALIZE_TASKS");
  assert.equal(afterMaterialize.workflowSkill, "stnl-task-reviewer");
  assert.equal(afterMaterialize.invocation, "OPERATION=REVIEW_TASKS");
  assert.equal(afterMaterialize.slice, null);
  const afterReview = deriveNormalHandoff(materializedState, "REVIEW_TASKS");
  assert.equal(afterReview.workflowSkill, "stnl-slice-executor");
  assert.equal(afterReview.invocation, "OPERATION=EXECUTE_SLICE");
  assert.equal(afterReview.slice, "slice-01");
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

test("requirements changes during pending REPLAN draft or ready recover through REQUIREMENTS_CHANGED", async (t) => {
  for (const ready of [false, true]) {
    const root = await temporary(t, `stnl-pending-authority-${ready ? "ready" : "draft"}-`);
    const fixtureRoot = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready");
    const workspace = await copyDirectory(fixtureRoot, path.join(root, "spec"));
    const fixture = { requirements: workspace, execution: path.join(workspace, "execution") };
    const { authority } = await renderArtifacts(fixture);
    await stagePristineReplacement(fixture, authority, authority, { ready });
    assert.equal((await inspectExecutionState(workspace)).state, ready ? "PENDING_REPLAN_READY" : "PENDING_REPLAN_DRAFT");
    const pendingPlan = await fs.readFile(path.join(fixture.execution, "plan.md"));

    const requirements = path.join(workspace, "shared/requirements.md");
    await fs.appendFile(requirements, "\nDocumentary requirement clarified by lifecycle RESUME.\n", "utf8");
    const changed = await inspectExecutionState(workspace);
    assert.equal(changed.state, "REQUIREMENTS_CHANGED");
    assertRecoveryTarget(changed, { operation: "REPLAN", slice: null, owner: "requirements-authority" });
    await assert.rejects(
      preflightExecutionOperation(workspace, ready ? "MATERIALIZE_TASKS" : "REVIEW_PLAN"),
      /not legal from REQUIREMENTS_CHANGED/u,
    );
    assert.deepEqual(await fs.readFile(path.join(fixture.execution, "plan.md")), pendingPlan);
  }
});

test("MATERIALIZE_TASKS hands preserved validable frontiers to concrete validation", async (t) => {
  const implemented = await standaloneWorkspace(t);
  await renderArtifacts(implemented);
  await editTask(implemented, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  const implementedState = await inspectExecutionState(implemented.requirements);
  assert.deepEqual(deriveNormalHandoff(implementedState, "MATERIALIZE_TASKS"), {
    workflowSkill: "stnl-slice-quality-manager",
    operation: "VALIDATE_SLICE",
    invocation: "OPERATION=VALIDATE_SLICE",
    slice: "slice-01",
  });

  const corrected = await standaloneWorkspace(t);
  await renderArtifacts(corrected);
  await prepareFindingsCorrection(corrected);
  const correctedState = await inspectExecutionState(corrected.requirements);
  assert.deepEqual(deriveNormalHandoff(correctedState, "MATERIALIZE_TASKS"), {
    workflowSkill: "stnl-slice-quality-manager",
    operation: "VALIDATE_SLICE",
    invocation: "OPERATION=VALIDATE_SLICE",
    slice: "slice-01",
  });
  for (const state of [implementedState, correctedState]) {
    const readback = { execution: state, executionRaw: state, product: { deriveNormalHandoff } };
    assert.deepEqual(decideOutcome("MATERIALIZE_TASKS", readback, true), { result: "PASS", blocker: null });
    assert.deepEqual(nextHandoff("MATERIALIZE_TASKS", readback), { operation: "VALIDATE_SLICE", slice: "slice-01" });
    assert.deepEqual(decideOutcome("MATERIALIZE_TASKS", readback, false),
      { result: "BLOCKED", blocker: "SDK_TURN_FAILED" });
  }
});

test("RESUME remains lifecycle recovery authority before execution REPLAN is derived", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const lifecycleDivergence = ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: RESUME");
  await editTask(fixture, (value) => replaceSection(value, "Divergences", lifecycleDivergence));
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
  const first = ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: RESUME");
  const second = first.replaceAll("divergence-01", "divergence-02").replace(
    "Approved scope omits a required dependency.",
    "A second persisted authority divergence requires lifecycle recovery.",
  );
  await editTask(fixture, (value) => replaceSection(value, "Divergences", `${first}\n\n${second}`));
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
  await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
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
  await editTask(legacy, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace("- Discovery sources:", "- Check discovery sources:")
      .replace("- Discovery actions:", "- Check discovery actions:"));
  });
  const taskPath = path.join(legacy.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskPath, "utf8");
  await assert.rejects(inspectExecutionState(legacy.requirements), (error) => {
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
  await editTask(coexistence, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace("- Discovery sources:", "- Discovery sources: canonical\n- Check discovery sources:")
      .replace("- Discovery actions:", "- Discovery actions: canonical\n- Check discovery actions:"));
  });
  await assert.rejects(inspectExecutionState(coexistence.requirements), (error) => {
    assert.equal(error.contractViolation.repairability, "blocked");
    return true;
  });

  const typo = await standaloneWorkspace(t);
  await renderArtifacts(typo);
  await editTask(typo, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace("- Discovery sources:", "- Discovery sourcez:"));
  });
  await assert.rejects(inspectExecutionState(typo.requirements), /Discovery sources|unknown field/u);
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
  await editTask(multipleRecords, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    const legacy = (record) => record
      .replace("- Discovery sources:", "- Check discovery sources:")
      .replace("- Discovery actions:", "- Check discovery actions:");
    return replaceSection(result, "Implementation Test Evidence", [
      legacy(checkRecord("implementation-check", 1, "TESTS_FAIL", 1)),
      legacy(checkRecord("implementation-check", 2, "TESTS_PASS", 2)),
    ].join("\n\n"));
  });
  const multipleRepair = await repairExecutionContract(multipleRecords.requirements);
  assert.equal(multipleRepair.status, "REPAIRED");
  assert.equal(multipleRepair.repairs.length, 2);
  assert.equal((await inspectExecutionState(multipleRecords.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("contract repair never overwrites a writer in the final source-to-publication window", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");

  // Keep the source-to-publication window open without changing the artifact grammar.
  await editTask(fixture, (value) => value.replace(
    "- Problem: Observable behavior is wrong.",
    `- Problem: ${"x".repeat(32 * 1024 * 1024)}`,
  ));

  const concurrentBytes = Buffer.from("CONCURRENT WRITER WON\n", "utf8");
  let mutationResolve;
  let mutationReject;
  const mutation = new Promise((resolve, reject) => {
    mutationResolve = resolve;
    mutationReject = reject;
  });
  let fired = false;
  const watcher = watch(path.dirname(taskPath), (_event, filename) => {
    if (fired || filename === null
      || !String(filename).startsWith("slice-01.md.stnl-contract-repair-")) return;
    fired = true;
    fs.writeFile(taskPath, concurrentBytes).then(mutationResolve, mutationReject);
  });
  t.after(() => watcher.close());

  const outcome = await repairExecutionContract(fixture.requirements).then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
  await mutation;
  assert.equal(fired, true);
  assert.ok(outcome.error instanceof ExecutionContractError,
    `repair unexpectedly published: ${JSON.stringify(outcome.result)}`);
  assert.match(outcome.error.message, /source changed|concurrent source|publication aborted/u);
  assert.deepEqual(await fs.readFile(taskPath), concurrentBytes);
});

test("contract repair rejects a source mutation at critical-section entry", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  await editTask(fixture, (value) => value.replace(
    "- Problem: Observable behavior is wrong.",
    `- Problem: ${"x".repeat(32 * 1024 * 1024)}`,
  ));

  const lockPath = `${fixture.execution}.stnl-contract-repair.lock`;
  const concurrentBytes = Buffer.from("PRE-CRITICAL WRITER WON\n", "utf8");
  let fired = false;
  let mutation = null;
  const watcher = watch(path.dirname(lockPath), (_event, filename) => {
    if (fired || filename === null || String(filename) !== path.basename(lockPath)) return;
    fired = true;
    mutation = fs.writeFile(taskPath, concurrentBytes);
  });
  t.after(() => watcher.close());

  const outcome = await repairExecutionContract(fixture.requirements).then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
  assert.equal(fired, true);
  await mutation;
  assert.ok(outcome.error instanceof ExecutionContractError,
    `repair unexpectedly published: ${JSON.stringify(outcome.result)}`);
  assert.match(outcome.error.message, /source changed|concurrent source|publication aborted/u);
  assert.deepEqual(await fs.readFile(taskPath), concurrentBytes);
});

test("strict readback failure rolls back only the repair-owned publication", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const tasksIndexPath = path.join(fixture.execution, "tasks.md");
  await editTask(fixture, (value) => value.replace(
    "- Problem: Observable behavior is wrong.",
    `- Problem: ${"x".repeat(32 * 1024 * 1024)}`,
  ));
  const sourceBytes = await fs.readFile(taskPath);
  const foreignIndexBytes = Buffer.from("CONCURRENT TASK INDEX WON\n", "utf8");

  let fired = false;
  let mutation = null;
  const watcher = watch(path.dirname(taskPath), (_event, filename) => {
    if (fired || filename === null
      || !String(filename).startsWith("slice-01.md.stnl-contract-repair-stage-")) return;
    fired = true;
    writeFileSync(tasksIndexPath, foreignIndexBytes);
    mutation = Promise.resolve();
  });
  t.after(() => watcher.close());

  const outcome = await spawnResult(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "--repair-known-contract",
  ], { cwd: fixture.root });
  assert.equal(fired, true);
  await mutation;
  assert.equal(outcome.status, 1, `repair unexpectedly passed strict readback: ${outcome.stdout}`);
  assert.match(outcome.stderr, /BLOCKED:/u);
  assert.deepEqual(await fs.readFile(taskPath), sourceBytes, "owned publication was not rolled back");
  assert.deepEqual(await fs.readFile(tasksIndexPath), foreignIndexBytes, "foreign readback mutation was overwritten");
});

test("contract repair preserves a foreign replacement of its lock identity", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  await editTask(fixture, (value) => value.replace(
    "- Problem: Observable behavior is wrong.",
    `- Problem: ${"x".repeat(32 * 1024 * 1024)}`,
  ));
  const sourceBytes = await fs.readFile(taskPath);
  const lockPath = `${fixture.execution}.stnl-contract-repair.lock`;
  const displacedLockPath = `${lockPath}.displaced-by-test`;
  const foreignLockBytes = Buffer.from("FOREIGN LOCK OWNER\n", "utf8");

  let fired = false;
  let mutation = null;
  const watcher = watch(path.dirname(taskPath), (_event, filename) => {
    if (fired || filename === null
      || !String(filename).startsWith("slice-01.md.stnl-contract-repair-stage-")) return;
    fired = true;
    mutation = fs.rename(lockPath, displacedLockPath)
      .then(() => fs.writeFile(lockPath, foreignLockBytes));
  });
  t.after(() => watcher.close());

  const outcome = await repairExecutionContract(fixture.requirements).then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
  assert.equal(fired, true);
  await mutation;
  assert.ok(outcome.error instanceof ExecutionContractError,
    `repair ignored lock replacement: ${JSON.stringify(outcome.result)}`);
  assert.match(outcome.error.message, /lock ownership changed|foreign lock preserved/u);
  assert.deepEqual(await fs.readFile(taskPath), sourceBytes);
  assert.deepEqual(await fs.readFile(lockPath), foreignLockBytes);
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

test("tasks prose is editable while its canonical table remains machine authority", async (t) => {
  for (const mutate of [
    (value) => value.replace("This is the sole global progress authority.", "This is the sole global progress authority!"),
    (value) => value
      .replace(/Use only `\[ \]`[\s\S]*?explicit `SLICE`\./u, "The table below is the global progress record; select every slice explicitly.")
      .replace(/After materialization,[\s\S]*?(?=\n?$)/u, "History remains append-only after execution work starts."),
    (value) => value.replace("\n\n| Done |", "\n\n\n| Done |").replace("| pending | pending |\n\n", "| pending | pending |\n   \n"),
    (value) => value.replace("\n\n| Done |", "\n\nEditorial notation `A | B | C` is explanatory prose.\n\n| Done |"),
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTasksIndex(fixture, mutate);
    assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  }
});

test("non-rendered tasks prose cannot create authority and row-like residue cannot mask it", async (t) => {
  for (const wrapper of [
    (table) => `\`\`\`md\n${table}\`\`\`\n`,
    (table) => `<!--\n${table}-->\n`,
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTasksIndex(fixture, (value) => value.replace(
      /(\| Done \| Slice \| Delivery \| Dependencies \| Detail \| Validation \| Result \|\n\|---\|---\|---\|---\|---\|---\|---\|\n(?:\|[^\n]+\|\n)+)/u,
      (table) => wrapper(table),
    ));
    await assert.rejects(inspectExecutionState(fixture.requirements), /canonical table header/u);
  }

  const editorial = await standaloneWorkspace(t);
  await renderArtifacts(editorial);
  await editTasksIndex(editorial, (value) => value.replace(
    "\n\n| Done |",
    "\n\n```md\n# Editorial example\n| fake | table | row |\n```\n\n<!--\n# Commented example\n| fake | table | row |\n-->\n\n| Done |",
  ));
  assert.equal((await inspectExecutionState(editorial.requirements)).state, "MATERIALIZED_PRISTINE");

  for (const residue of [
    "[ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "<!-- editorial marker --> [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "[ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending | <!-- editorial marker -->",
  ]) {
    const rowLikeResidue = await standaloneWorkspace(t);
    await renderArtifacts(rowLikeResidue);
    await editTasksIndex(rowLikeResidue, (value) => `${value}\n${residue}\n`);
    await assert.rejects(inspectExecutionState(rowLikeResidue.requirements), /unexpected structural row/u);
  }
});

test("legacy classification requires a complete historical producer signature", async (t) => {
  for (const insertion of [
    "```md\n# Delivery Plan Index\n```",
    "Historical example: \n# Delivery Plan Index",
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editPlan(fixture, (value) => value.replace(
      "- <risk, boundary, or explicit final integration slice>",
      `- no material integration risk\n\n${insertion}`,
    ));
    assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  }

  const missingAuthority = await standaloneWorkspace(t);
  await renderArtifacts(missingAuthority);
  await editPlan(missingAuthority, (value) => value
    .replace(/^- Requirements authority: sha256:[0-9a-f]{64}\n/mu, "")
    .replace(/^- Plan revision: [0-9]+\n/mu, ""));
  await assert.rejects(inspectExecutionState(missingAuthority.requirements), (error) => {
    assert.equal(error.contractViolation, null);
    return /Requirements authority/u.test(error.message);
  });

  const hybrid = await standaloneWorkspace(t);
  await renderArtifacts(hybrid);
  await editPlan(hybrid, (value) => value.replace("# Execution Plan", "# Delivery Plan Index"));
  await assert.rejects(inspectExecutionState(hybrid.requirements), (error) => {
    assert.equal(error.contractViolation, null);
    return /non-canonical primary heading/u.test(error.message);
  });
});

test("the fabricated tasks prose pair is not a historical producer signature", async (t) => {
  const currentIntroduction = "Use only `[ ]` and `[x]`. This is the sole global progress authority. `PASS` and `SUPERSEDED` are terminal; only `PASS` is successful validation. A suggested eligible slice never selects it; every slice operation requires explicit `SLICE`.";
  const currentHistory = "After materialization, historical plans and task records are immutable. A wholly pristine canonical set may be atomically replaced only by explicit approved replanning. After any operational evidence, the index cannot be recreated and historical checklists cannot be rematerialized: an approved append-only revision adds only monotonically numbered rows/files. A current valid `PASS` atomically changes its selected row to `[x]`, validation `PASS`, result `PASS`. The same approved-replan materialization that appends a replacement slice may terminalize its named open predecessor as `[x]`, validation `SUPERSEDED`, result `SUPERSEDED`; it never changes a prior `PASS`.";
  const fabricatedIntroduction = "Use only `[ ]` and `[x]`. This is the sole global progress authority. Every slice operation requires explicit `SLICE`.";
  const fabricatedHistory = "Plans are immutable after materialization; only a current valid `PASS` may complete a selected row.";
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTasksIndex(fixture, (value) => value
    .replace(currentIntroduction, fabricatedIntroduction)
    .replace(currentHistory, fabricatedHistory));
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
  await renderArtifacts(fixture);
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
    assert.equal(error.contractViolation, null);
    return /Requirements authority/u.test(error.message);
  });
});

test("preflight is read-only and exact safe contract repair is an explicit deterministic action", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskPath);
  for (const [operation, slice] of [["VALIDATE_SLICE", "1"], ["REPLAN", null], ["DELETE", null]]) {
    await assert.rejects(preflightExecutionOperation(fixture.requirements, operation, slice), (error) => {
      assert.equal(error.contractViolation.repairability, "mechanical");
      return true;
    });
    assert.deepEqual(await fs.readFile(taskPath), before, `${operation} preflight mutated live execution`);
  }
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
    await assert.rejects(preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1"), (error) => {
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
    ["second required field class", (value) => value.replace("- HEAD: fixture", "- HEADs: fixture")],
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await prepareFindingsCorrection(fixture);
    const liveBefore = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"));
    const candidate = path.join(fixture.root, `candidate-${name.replaceAll(" ", "-")}`);
    await copyDirectory(fixture.execution, candidate);
    const candidateTask = path.join(candidate, "tasks/slice-01.md");
    await fs.writeFile(candidateTask, mutate(await fs.readFile(candidateTask, "utf8")), "utf8");
    await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), ExecutionContractError);
    assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")), liveBefore);
  }
});

test("successful model-owned candidate publication has strict success and live readback proof", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveBefore = await fs.readFile(liveTask);
  const candidate = path.join(fixture.root, "successful-candidate");
  await copyDirectory(fixture.execution, candidate);
  const candidateTask = path.join(candidate, "tasks/slice-01.md");
  let candidateText = await fs.readFile(candidateTask, "utf8");
  candidateText = candidateText.replace("- [ ] 1.1", "- [x] 1.1");
  candidateText = replaceSection(candidateText, "Changed Areas", "- `../../src/example.txt`");
  candidateText = replaceSection(candidateText, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  await fs.writeFile(candidateTask, candidateText, "utf8");

  const candidateState = await validateExecutionCandidate(fixture.requirements, candidate);
  assert.equal(candidateState.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(await fs.readFile(liveTask), liveBefore, "candidate validation published implicitly");

  // Publication remains model-owned; this test performs the authorized selected-task copy only after candidate PASS.
  await fs.copyFile(candidateTask, liveTask);
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

test("artifact-relative planning paths reject lifecycle-local candidates before publication", async (t) => {
  const initial = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "draft" });
  const candidate = await copyDirectory(initial.execution, path.join(path.dirname(initial.repository), "initial plan candidate"));
  const candidateFixture = { ...initial, execution: candidate };
  const requirementsBefore = await fs.readFile(path.join(initial.requirements, "feature_spec.md"));
  await setImplementationAreas(initial, { global: "scripts/validate.sh" });
  assert.equal((await preflightExecutionOperation(initial.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");
  await fs.rm(initial.execution, { recursive: true });
  await setImplementationAreas(candidateFixture, { global: "scripts/validate.sh" });
  await assert.rejects(validateExecutionCandidate(initial.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /artifact="specs\/área segura\/feature Ω\/execution\/plan\.md"/u);
    assert.match(error.message, /field="Serial Slice Order 01 Expected areas"/u);
    assert.match(error.message, /raw="scripts\/validate\.sh"/u);
    assert.match(error.message, /resolves inside the execution root/u);
    assert.match(error.message, /trusted-root=/u);
    return true;
  });
  await assert.rejects(fs.stat(initial.execution), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(initial.requirements, "feature_spec.md")), requirementsBefore);

  const reviewed = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const reviewedCandidate = await copyDirectory(reviewed.execution, path.join(path.dirname(reviewed.repository), "reviewed plan candidate"));
  const reviewedFixture = { ...reviewed, execution: reviewedCandidate };
  const liveBefore = await Promise.all([
    fs.readFile(path.join(reviewed.execution, "plan.md")),
    fs.readFile(path.join(reviewed.execution, "plans/slice-01.md")),
  ]);
  await setImplementationAreas(reviewedFixture, { detail: "../../skills/workflows/example.mjs" });
  await assert.rejects(validateExecutionCandidate(reviewed.requirements, reviewedCandidate), (error) => {
    assert.match(error.message, /field="Likely Areas"/u);
    assert.match(error.message, /resolves inside the lifecycle SPEC workspace/u);
    assert.match(error.message, /existing-project-target=/u);
    return true;
  });
  const correctExisting = path.relative(
    path.join(reviewed.requirements, "execution/plans"),
    path.join(reviewed.repository, "scripts/validate.sh"),
  ).split(path.sep).join("/");
  await setImplementationAreas(reviewedFixture, { detail: correctExisting });
  assert.equal((await validateExecutionCandidate(reviewed.requirements, reviewedCandidate)).state, "PLANNED_READY");
  assert.deepEqual(await Promise.all([
    fs.readFile(path.join(reviewed.execution, "plan.md")),
    fs.readFile(path.join(reviewed.execution, "plans/slice-01.md")),
  ]), liveBefore);
});

test("planning path carriers distinguish concrete paths from conceptual descriptions", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const implementationTarget = path.join(fixture.repository, "scripts/validate.sh");
  const globalClaim = path.relative(fixture.execution, implementationTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), implementationTarget).split(path.sep).join("/");

  await setImplementationAreas(fixture, { global: globalClaim, detail: detailClaim });
  await editPlan(fixture, (value) => value.replace("example implementation", "list command behavior"));
  await editSlicePlan(fixture, "slice-01", (value) => value.replace("example implementation", "list command behavior"));
  const candidate = await copyDirectory(fixture.execution, path.join(path.dirname(fixture.repository), "path carrier candidate"));
  const candidateFixture = { ...fixture, execution: candidate };
  await fs.rm(fixture.execution, { recursive: true });

  assert.equal(path.resolve(fixture.execution, globalClaim), implementationTarget, "P04 global claim resolves to the physical target");
  assert.equal(path.resolve(fixture.execution, "plans", detailClaim), implementationTarget, "P01/P05 detailed claim resolves to the physical target");
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "PLANNED_READY", "P01/P02/P04/P05 valid path claims and plain-text concepts pass");

  await editSlicePlan(candidateFixture, "slice-01", (value) => value.replace(
    /`[^`\n]+` — list command behavior/u,
    "`list` — list command behavior",
  ));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /field="Likely Areas"/u);
    assert.match(error.message, /raw="list"/u);
    assert.match(error.message, /resolves inside the execution root/u);
    return true;
  }, "P03 conceptual code span remains a rejected path claim");
});

test("planning claims use the containing artifact basis", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const implementationTarget = path.join(fixture.repository, "src", "cli.mjs");
  await fs.mkdir(path.dirname(implementationTarget), { recursive: true });
  await fs.writeFile(implementationTarget, "#!/usr/bin/env node\n", "utf8");

  const candidate = await copyDirectory(fixture.execution, path.join(path.dirname(fixture.repository), "pilot-11-plan-candidate"));
  const candidateFixture = { ...fixture, execution: candidate };
  await fs.rm(fixture.execution, { recursive: true });

  const plannerSkill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/SKILL.md"), "utf8");
  const globalTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  const detailedTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  assert.match(plannerSkill, /These carriers are implementation-only/u);
  assert.match(plannerSkill, /nearest ancestor of the normalized requirements source that contains a real `\.git` marker/u);
  assert.match(plannerSkill, /`SPEC_PATH` is not necessarily the project root/u);
  assert.match(plannerSkill, /raw global `Expected areas` selections are semantic repository-relative inputs, not yet persisted artifact-relative claims/u);
  assert.match(plannerSkill, /never apply this artifact-relative readback to the raw semantic input before serialization/u);
  assert.match(globalTemplate, /Model-selected physical target \(repository-relative before serialization\)/u);
  assert.match(detailedTemplate, /Implementation filesystem path \(outside generated execution artifacts\)/u);

  const globalClaim = path.relative(fixture.execution, implementationTarget).split(path.sep).join("/");
  const detailDirectory = path.join(fixture.requirements, "execution", "plans");
  const detailClaim = path.relative(detailDirectory, implementationTarget).split(path.sep).join("/");
  const wrongResolved = path.join(fixture.repository, "specs", "src", "cli.mjs");
  const wrongDetailClaim = path.relative(detailDirectory, wrongResolved).split(path.sep).join("/");

  await setImplementationAreas(candidateFixture, { global: "execution/plan.md", detail: wrongDetailClaim });
  const invalidGlobalBefore = await fs.readFile(path.join(candidate, "plan.md"));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /field="Serial Slice Order 01 Expected areas"/u);
    assert.match(error.message, /raw="execution\/plan\.md"/u);
    assert.match(error.message, /resolves inside the execution root/u);
    return true;
  });
  assert.deepEqual(await fs.readFile(path.join(candidate, "plan.md")), invalidGlobalBefore);

  await setImplementationAreas(candidateFixture, { global: globalClaim });
  const invalidDetailBefore = await fs.readFile(path.join(candidate, "plans/slice-01.md"));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /field="Likely Areas"/u);
    assert.ok(error.message.includes(`raw=${JSON.stringify(wrongDetailClaim)}`));
    assert.ok(error.message.includes(`resolved=${JSON.stringify(wrongResolved)}`));
    assert.match(error.message, /possible path-basis error: artifact-relative target is absent while the same project-root target exists/u);
    assert.ok(error.message.includes(`existing-project-target=${JSON.stringify(implementationTarget)}`));
    return true;
  });
  assert.deepEqual(await fs.readFile(path.join(candidate, "plans/slice-01.md")), invalidDetailBefore);

  await setImplementationAreas(candidateFixture, { detail: detailClaim });
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "PLANNED_READY");
});

test("materialization and task-review gates preserve valid future artifact-relative paths", async (t) => {
  const materializerSkill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/SKILL.md"), "utf8");
  assert.match(materializerSkill, /resolveExecutionWorkspace\(SPEC_PATH\)/u);
  assert.match(materializerSkill, /taskPath = path\.join\(executionRoot, "tasks", "slice-NN\.md"\)/u);
  assert.doesNotMatch(materializerSkill, /path\.join\(SPEC_PATH, "execution"/u);
  assert.doesNotMatch(materializerSkill, /benchmark-case-a|todo-service\.mjs/u);
  assert.match(materializerSkill, /runtime\/prepare-task-candidate\.mjs/u);

  const planOnly = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  await setImplementationAreas(planOnly, { global: "scripts/validate.sh" });
  const invalidPlanBefore = await fs.readFile(path.join(planOnly.execution, "plan.md"));
  await assert.rejects(
    preflightExecutionOperation(planOnly.requirements, "MATERIALIZE_TASKS"),
    /resolves inside the execution root/u,
  );
  assert.deepEqual(await fs.readFile(path.join(planOnly.execution, "plan.md")), invalidPlanBefore);

  const fixture = await nestedLifecycleWorkspace(t);
  const candidate = await copyDirectory(fixture.execution, path.join(path.dirname(fixture.repository), "task review candidate"));
  const candidateFixture = { ...fixture, execution: candidate };
  const liveBefore = await Promise.all([
    fs.readFile(path.join(fixture.execution, "plan.md")),
    fs.readFile(path.join(fixture.execution, "plans/slice-01.md")),
    fs.readFile(path.join(fixture.execution, "tasks.md")),
    fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")),
  ]);
  const futureTarget = path.join(fixture.repository, "skills/workflows/stnl-user-story-refiner/runtime/refine.mjs");
  const shortFuture = "../../skills/workflows/stnl-user-story-refiner/runtime/refine.mjs";
  await setImplementationAreas(candidateFixture, { task: shortFuture });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.match(error.message, /field="Checklist 1\.1 expected areas"/u);
    assert.match(error.message, /resolves inside the lifecycle SPEC workspace/u);
    return true;
  });
  const taskFuture = path.relative(path.join(fixture.execution, "tasks"), futureTarget).split(path.sep).join("/");
  await setImplementationAreas(candidateFixture, { task: taskFuture });
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "MATERIALIZED_PRISTINE");
  await assert.rejects(fs.stat(futureTarget), { code: "ENOENT" });
  assert.deepEqual(await Promise.all([
    fs.readFile(path.join(fixture.execution, "plan.md")),
    fs.readFile(path.join(fixture.execution, "plans/slice-01.md")),
    fs.readFile(path.join(fixture.execution, "tasks.md")),
    fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")),
  ]), liveBefore);

  await setImplementationAreas(fixture, { task: shortFuture });
  const invalidTaskBefore = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_TASKS")).state, "MATERIALIZED_PRISTINE");
  await assert.rejects(
    preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"),
    /resolves inside the lifecycle SPEC workspace/u,
  );
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")), invalidTaskBefore);
});

test("materializer rebases PLAN claims from the official execution workspace for every SPEC_PATH form", async (t) => {
  const lifecycle = await nestedLifecycleWorkspace(t);
  const lifecycleFeature = path.join(lifecycle.requirements, "feature_spec.md");
  const physicalTarget = path.join(lifecycle.repository, "src/example.txt");
  const planArtifact = path.join(lifecycle.execution, "plan.md");
  const planClaim = path.relative(path.dirname(planArtifact), physicalTarget).split(path.sep).join("/");

  const directoryRebase = await rebasePlanClaimToTask({
    specPath: lifecycle.requirements,
    planArtifact,
    planClaim,
  });
  assert.equal(directoryRebase.executionRoot, lifecycle.execution, "R1 lifecycle directory executionRoot");
  assert.equal(directoryRebase.taskPath, path.join(lifecycle.execution, "tasks/slice-01.md"), "R1 lifecycle directory taskPath");
  assert.equal(path.resolve(path.dirname(directoryRebase.taskPath), directoryRebase.taskClaim), physicalTarget, "R1 task claim resolves to the PLAN physical target");
  assert.notEqual(directoryRebase.taskClaim, planClaim, "R4 PLAN and TASK claims use different artifact bases");
  assert.equal(path.resolve(path.dirname(planArtifact), planClaim), physicalTarget, "R4 PLAN claim resolves to the physical target");

  const directoryCandidate = await copyDirectory(lifecycle.execution, path.join(path.dirname(lifecycle.repository), "directory-form-candidate"));
  await setImplementationAreas({ ...lifecycle, execution: directoryCandidate }, {
    global: planClaim,
    task: directoryRebase.taskClaim,
  });
  assert.equal((await validateExecutionCandidate(lifecycle.requirements, directoryCandidate)).state, "MATERIALIZED_PRISTINE", "R1 lifecycle directory candidate");

  const directRebase = await rebasePlanClaimToTask({
    specPath: lifecycleFeature,
    planArtifact,
    planClaim,
  });
  assert.equal(directRebase.executionRoot, lifecycle.execution, "R2 direct feature_spec.md executionRoot");
  assert.equal(directRebase.taskPath, directoryRebase.taskPath, "R2 direct feature_spec.md taskPath matches directory form");
  assert.equal(path.resolve(path.dirname(directRebase.taskPath), directRebase.taskClaim), physicalTarget, "R2 direct feature_spec.md claim resolves to the physical target");
  const directCandidate = await copyDirectory(lifecycle.execution, path.join(path.dirname(lifecycle.repository), "direct-form-candidate"));
  await setImplementationAreas({ ...lifecycle, execution: directCandidate }, { task: directRebase.taskClaim });
  assert.equal((await validateExecutionCandidate(lifecycleFeature, directCandidate)).state, "MATERIALIZED_PRISTINE", "R2 direct feature_spec.md candidate");

  const copiedPlanCandidate = await copyDirectory(lifecycle.execution, path.join(path.dirname(lifecycle.repository), "copied-plan-basis-candidate"));
  await setImplementationAreas({ ...lifecycle, execution: copiedPlanCandidate }, { task: planClaim });
  await assert.rejects(validateExecutionCandidate(lifecycleFeature, copiedPlanCandidate), /artifact-relative implementation path/u, "R5 copied PLAN basis remains invalid for TASK validation");

  const legacyDirectTaskPath = path.join(lifecycleFeature, "execution", "tasks", "slice-01.md");
  const legacyDirectClaim = path.relative(path.dirname(legacyDirectTaskPath), physicalTarget).split(path.sep).join("/");
  assert.notEqual(legacyDirectClaim, directRebase.taskClaim, "R2 old SPEC_PATH/execution basis differs for direct feature_spec.md");
  const legacyDirectCandidate = await copyDirectory(lifecycle.execution, path.join(path.dirname(lifecycle.repository), "legacy-direct-candidate"));
  await setImplementationAreas({ ...lifecycle, execution: legacyDirectCandidate }, { task: legacyDirectClaim });
  await assert.rejects(validateExecutionCandidate(lifecycleFeature, legacyDirectCandidate), /artifact-relative implementation path/u, "R2 old direct-file basis is rejected");

  const standaloneRoot = await temporary(t, "stnl-materializer-standalone-");
  const standaloneRepository = path.join(standaloneRoot, "repository");
  await fs.mkdir(path.join(standaloneRepository, ".git"), { recursive: true });
  const standaloneRequirements = path.join(standaloneRepository, "requirements/feature-x.md");
  await fs.mkdir(path.dirname(standaloneRequirements), { recursive: true });
  await fs.writeFile(standaloneRequirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  const standalone = {
    root: standaloneRepository,
    repository: standaloneRepository,
    requirements: standaloneRequirements,
    execution: path.join(path.dirname(standaloneRequirements), "feature-x-execution"),
  };
  await renderArtifacts(standalone);
  const standaloneTarget = path.join(standaloneRepository, "src/example.txt");
  const standalonePlan = path.join(standalone.execution, "plan.md");
  const standalonePlanClaim = path.relative(path.dirname(standalonePlan), standaloneTarget).split(path.sep).join("/");
  const standaloneRebase = await rebasePlanClaimToTask({
    specPath: standaloneRequirements,
    planArtifact: standalonePlan,
    planClaim: standalonePlanClaim,
  });
  assert.equal(standaloneRebase.executionRoot, standalone.execution, "R3 standalone requirements executionRoot");
  assert.equal(standaloneRebase.taskPath, path.join(standalone.execution, "tasks/slice-01.md"), "R3 standalone requirements taskPath");
  assert.equal(path.resolve(path.dirname(standaloneRebase.taskPath), standaloneRebase.taskClaim), standaloneTarget, "R3 standalone claim resolves to the physical target");
  const standaloneCandidate = await copyDirectory(standalone.execution, path.join(standaloneRoot, "standalone-form-candidate"));
  await setImplementationAreas({ ...standalone, execution: standaloneCandidate }, { task: standaloneRebase.taskClaim });
  assert.equal((await validateExecutionCandidate(standaloneRequirements, standaloneCandidate)).state, "MATERIALIZED_PRISTINE", "R3 standalone requirements candidate");

  const legacyStandaloneTaskPath = path.join(standaloneRequirements, "execution", "tasks", "slice-01.md");
  const legacyStandaloneClaim = path.relative(path.dirname(legacyStandaloneTaskPath), standaloneTarget).split(path.sep).join("/");
  assert.notEqual(legacyStandaloneClaim, standaloneRebase.taskClaim, "R3 old SPEC_PATH/execution basis differs for standalone requirements");
  const legacyStandaloneCandidate = await copyDirectory(standalone.execution, path.join(standaloneRoot, "legacy-standalone-candidate"));
  await setImplementationAreas({ ...standalone, execution: legacyStandaloneCandidate }, { task: legacyStandaloneClaim });
  await assert.rejects(validateExecutionCandidate(standaloneRequirements, legacyStandaloneCandidate), /artifact-relative implementation path/u, "R3 old standalone-file basis is rejected");
});

test("standalone path basis, Unicode, future targets, and symlink safety stay deterministic", async (t) => {
  const root = await temporary(t, "stnl-standalone-paths-");
  const repository = path.join(root, "repository with space ü");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const requirements = path.join(repository, "docs/nested/requirements.md");
  await fs.mkdir(path.dirname(requirements), { recursive: true });
  await fs.writeFile(requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  const fixture = {
    root: repository,
    repository,
    requirements,
    execution: path.join(path.dirname(requirements), "requirements-execution"),
  };
  await fs.mkdir(path.join(repository, "scripts"), { recursive: true });
  const existingTarget = path.join(repository, "scripts/validate.sh");
  await fs.writeFile(existingTarget, "#!/bin/sh\n", "utf8");
  await fs.mkdir(path.join(repository, "skills/workflows"), { recursive: true });
  await renderArtifacts(fixture);
  const candidate = await copyDirectory(fixture.execution, path.join(root, "standalone candidate"));
  const candidateFixture = { ...fixture, execution: candidate };
  const areasFor = (target) => ({
    global: path.relative(fixture.execution, target).split(path.sep).join("/"),
    detail: path.relative(path.join(fixture.execution, "plans"), target).split(path.sep).join("/"),
    task: path.relative(path.join(fixture.execution, "tasks"), target).split(path.sep).join("/"),
  });

  await setImplementationAreas(candidateFixture, areasFor(existingTarget));
  assert.equal((await validateExecutionCandidate(requirements, candidate)).state, "MATERIALIZED_PRISTINE");

  const shortDetail = areasFor(existingTarget).detail.replace(/^\.\.\//u, "");
  await setImplementationAreas(candidateFixture, { detail: shortDetail });
  await assert.rejects(validateExecutionCandidate(requirements, candidate), (error) => {
    assert.match(error.message, /possible path-basis error/u);
    assert.match(error.message, /existing-project-target=/u);
    return true;
  });

  const unicodeLocal = path.join(path.dirname(requirements), "área local/arquivo Ω.txt");
  await fs.mkdir(path.dirname(unicodeLocal), { recursive: true });
  await fs.writeFile(unicodeLocal, "local\n", "utf8");
  await setImplementationAreas(candidateFixture, areasFor(unicodeLocal));
  assert.equal((await validateExecutionCandidate(requirements, candidate)).state, "MATERIALIZED_PRISTINE");

  const futureTarget = path.join(repository, "skills/workflows/stnl-user-story-refiner/novo Ω.mjs");
  await setImplementationAreas(candidateFixture, areasFor(futureTarget));
  assert.equal((await validateExecutionCandidate(requirements, candidate)).state, "MATERIALIZED_PRISTINE");
  await assert.rejects(fs.stat(futureTarget), { code: "ENOENT" });

  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(repository, "linked"), "dir");
  const symlinkFuture = path.join(repository, "linked/future.txt");
  await setImplementationAreas(candidateFixture, areasFor(symlinkFuture));
  await assert.rejects(validateExecutionCandidate(requirements, candidate), /traverses a symlink/u);

  await setImplementationAreas(candidateFixture, { global: "/absolute/path.txt" });
  await assert.rejects(validateExecutionCandidate(requirements, candidate), /not a normalized relative path/u);
  await setImplementationAreas(candidateFixture, { global: "../../../../../../escaped.txt" });
  await assert.rejects(validateExecutionCandidate(requirements, candidate), /escapes its trusted workspace/u);
});

test("semantic auxiliary runner output is serialized by the deterministic execution producer before persistence", async (t) => {
  const contracts = await Promise.all([
    fs.readFile(path.join(ROOT, "agents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8"),
    fs.readFile(path.join(ROOT, "agents/codex/.codex/agents/stnl_validation_runner.toml"), "utf8"),
  ]);
  const persisted = checkRecord("implementation-check", 1, "TESTS_PASS", 1);
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
  const filelessPersisted = persisted.replace(
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    "- Tested state: none\n- Fileless reason: no repository file participates in the observable state",
  );
  assert.match(filelessPersisted, /^- Tested state: none\n- Fileless reason: \S.*$/mu);
  const findingsPersisted = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" });
  assert.match(findingsPersisted, /^- Findings verified: finding-01$/mu);
  assert.match(findingsPersisted, /^- Unsupported active findings: none$/mu);
  const correctionPersisted = checkRecord("implementation-check", 2, "TESTS_PASS", 2);
  assert.match(correctionPersisted, /^- Correction paths: \.\.\/\.\.\/src\/example\.txt$/mu);

  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const candidate = path.join(fixture.root, "runner-round-trip-candidate");
  await copyDirectory(fixture.execution, candidate);
  const taskPath = path.join(candidate, "tasks/slice-01.md");
  let task = await fs.readFile(taskPath, "utf8");
  task = task.replace("- [ ] 1.1", "- [x] 1.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Implementation Test Evidence", persisted);
  await fs.writeFile(taskPath, task, "utf8");
  const candidateResult = await validateExecutionCandidate(fixture.requirements, candidate);
  assert.equal(candidateResult.state, "IMPLEMENTED_AWAITING_VALIDATION");
  await fs.copyFile(taskPath, path.join(fixture.execution, "tasks/slice-01.md"));
  const parsed = await inspectExecutionState(fixture.requirements);
  assert.equal(parsed.tasks.get("slice-01").implementationChecks[0].round, 1);
  assert.equal(parsed.tasks.get("slice-01").implementationChecks[0].testedState[0].path, "../../src/example.txt");
  assert.deepEqual(parsed.tasks.get("slice-01").implementationChecks[0].commands, [{ command: "node --test", exit: 0 }]);
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
    await editTask(fixture, (value) => {
      let task = value.replace("- [ ] 1.1", "- [x] 1.1");
      task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
      task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
      return replaceSection(task, "Diff Summary", "- Implemented the approved observable behavior.");
    });
    const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
    const liveIndex = path.join(fixture.execution, "tasks.md");
    const before = await Promise.all([liveTask, liveIndex].map((file) => fs.readFile(file)));
    const response = JSON.stringify(sanitizedValidationResponse("PASS"));
    const captured = await capturedVerificationSequence(t, "VALIDATE_SLICE", response, [0]);
    const receiptBefore = await fs.readFile(captured.receiptFile);
    const responseBefore = await fs.readFile(captured.semanticResponseFile);
    const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01",
      candidateParent: await temporary(t, "stnl-bullet-summary-") });
    const candidateTask = path.join(copy.candidateExecutionRoot, "tasks/slice-01.md");
    await fs.writeFile(candidateTask, replaceSection(await fs.readFile(candidateTask, "utf8"), "Diff Summary", summary));
    const prepared = await prepareValidationCandidate({ specPath: fixture.requirements, slice: "1", workspace: fixture.root,
      candidateExecutionRoot: copy.candidateExecutionRoot, ...captured });
    assert.equal(prepared.status, "PREPARED");
    assert.equal(prepared.formalStatus, "PASS");
    assert.equal(prepared.attemptId, "attempt-01");
    const candidateBytes = await fs.readFile(candidateTask, "utf8");
    assert.ok(candidateBytes.includes(`## Diff Summary\n\n${summary}\n`), "preparer preserves the author-owned summary");
    assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, "COMPLETE");
    assert.deepEqual(await Promise.all([liveTask, liveIndex].map((file) => fs.readFile(file))), before);
    assert.equal((await publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
      candidateExecutionRoot: copy.candidateExecutionRoot })).state, "COMPLETE");
    const final = await inspectExecutionState(fixture.requirements);
    assert.equal(final.state, "COMPLETE");
    assert.equal(final.tasks.get("slice-01").attempts.length, 1);
    const published = await fs.readFile(liveTask, "utf8");
    assert.ok(published.includes(`## Diff Summary\n\n${summary}\n`));
    assert.match(published, /sha256:[0-9a-f]{64}/u);
    assert.match(published, /STNL_VERIFICATION_COMMAND=1 node --test check-1.mjs.*exit:0/u);
    assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBefore);
    assert.deepEqual(await fs.readFile(captured.semanticResponseFile), responseBefore);
  }
});

test("terminal Diff Summary rejects placeholders and malformed bullet lines without publishing", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let task = value.replace("- [ ] 1.1", "- [x] 1.1");
    task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
    task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(task, "Diff Summary", "- Implemented the approved observable behavior.");
  });
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveIndex = path.join(fixture.execution, "tasks.md");
  const before = await Promise.all([liveTask, liveIndex].map((file) => fs.readFile(file)));
  const captured = await capturedVerificationSequence(t, "VALIDATE_SLICE", JSON.stringify(sanitizedValidationResponse("PASS")), [0]);
  const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01",
    candidateParent: await temporary(t, "stnl-bullet-summary-negative-") });
  await prepareValidationCandidate({ specPath: fixture.requirements, slice: "1", workspace: fixture.root,
    candidateExecutionRoot: copy.candidateExecutionRoot, ...captured });
  const task = path.join(copy.candidateExecutionRoot, "tasks/slice-01.md");
  const valid = await fs.readFile(task, "utf8");
  for (const summary of ["", "-", "- ", "none", "- none", "- pending", "- n/a", "- not_available",
    "- NONE", "- <summary>", "- Implemented behavior.\n- pending", "- Implemented behavior.\n- <remaining work>",
    "Implemented behavior.", "- Implemented behavior.\nArbitrary prose", "- Implemented behavior.\n  - Nested bullet",
    "- Implemented behavior.\n\n- Added checks.", "- Implemented behavior.\n1. Added checks."]) {
    await fs.writeFile(task, replaceSection(valid, "Diff Summary", summary));
    const rejected = await fs.readFile(task);
    await assert.rejects(validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot), /Diff Summary/u);
    await assert.rejects(publishValidationCandidate({ specPath: fixture.requirements, slice: "slice-01",
      candidateExecutionRoot: copy.candidateExecutionRoot }), /Diff Summary/u);
    assert.deepEqual(await fs.readFile(task), rejected, "rejection preserves candidate evidence");
    assert.deepEqual(await Promise.all([liveTask, liveIndex].map((file) => fs.readFile(file))), before);
  }
});

test("validation preparation rolls back only owned task bytes when index installation fails", async (t) => {
  for (const foreign of [false, true]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await writeValidatedPath(fixture);
    await editTask(fixture, value => {
      let task = value.replace('- [ ] 1.1', '- [x] 1.1');
      task = replaceSection(task, 'Changed Areas', '- `../../src/example.txt`');
      task = replaceSection(task, 'Implementation Test Evidence', checkRecord('implementation-check', 1, 'TESTS_PASS', 1));
      return replaceSection(task, 'Diff Summary', '- Approved implementation and checks are complete.');
    });
    const captured = await capturedVerificationSequence(t, 'VALIDATE_SLICE', JSON.stringify(sanitizedValidationResponse('PASS')), [0]);
    const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: 'slice-01', candidateParent: await temporary(t, 'stnl-install-fault-') });
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
      await assert.rejects(prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root,
        candidateExecutionRoot: copy.candidateExecutionRoot, ...captured }), foreign ? /changed during rollback and was preserved/u : /index install EIO/u);
    } finally { fsPromises.rename = rename; }
    assert.equal(fired, true);
    assert.deepEqual(await treeBytes(fixture.execution), liveBefore);
    assert.deepEqual(await Promise.all([captured.receiptFile, captured.semanticResponseFile].map(file => fs.readFile(file))), evidenceBefore);
    if (foreign) {
      assert.equal(await fs.readFile(task, 'utf8'), foreignBytes);
      await assert.rejects(prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root,
        candidateExecutionRoot: copy.candidateExecutionRoot, ...captured }), /Validation Attempts must remain byte-identical/u);
    } else {
      assert.deepEqual(await treeBytes(copy.candidateExecutionRoot), before);
      assert.equal((await prepareValidationCandidate({ specPath: fixture.requirements, slice: '1', workspace: fixture.root,
        candidateExecutionRoot: copy.candidateExecutionRoot, ...captured })).attemptId, 'attempt-01');
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

test("execution scope mismatches are narrowly recoverable semantic errors", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  const fileless = replaceSection(await fs.readFile(copy.candidateTaskArtifact, "utf8"), "Changed Areas", "- none");
  await fs.writeFile(copy.candidateTaskArtifact, fileless);
  const options = { operation: "EXECUTE_SLICE", workspace: fixture.root, taskArtifact: copy.candidateTaskArtifact };
  await assert.rejects(serializeRunnerExecutionBundleFromResponse({ ...options,
    response: JSON.stringify(scopeRegressionPayload()) }), (error) => {
    assert.ok(error instanceof RunnerSemanticResultError);
    assert.match(recoverableRunnerResultDiagnostic(error), /fileless semantic execution response must include Fileless reason/u);
    return true;
  });
  await assert.rejects(serializeRunnerExecutionBundleFromResponse({ ...options,
    response: JSON.stringify(scopeRegressionPayload("   ")) }), RunnerSemanticResultError);
  const valid = JSON.stringify(scopeRegressionPayload("Acceptance-only work changes no repository file."));
  const filelessBundle = await serializeRunnerExecutionBundleFromResponse({ ...options, response: valid });
  assert.match(filelessBundle, /- Tested state: none\n- Fileless reason: Acceptance-only work changes no repository file\./u);
  assert.equal((filelessBundle.match(/^- Tested state:/gmu) ?? []).length, 1);
  assert.match(filelessBundle, /- Tested scope: Acceptance-only work changes no repository file\./u);
  assert.equal(await fs.readFile(copy.candidateTaskArtifact, "utf8"), fileless, "native rejection never publishes or invents a receipt");
  const target = path.join(fixture.root, "src/example.txt");
  const claim = path.relative(path.dirname(copy.candidateTaskArtifact), target).split(path.sep).join("/");
  await writeValidatedPath(fixture, claim);
  await fs.writeFile(copy.candidateTaskArtifact, replaceSection(fileless, "Changed Areas", `- \`${claim}\``));
  const fileBackedBundle = await serializeRunnerExecutionBundleFromResponse({ ...options, response: JSON.stringify(scopeRegressionPayload()) });
  assert.doesNotMatch(fileBackedBundle, /Fileless reason/u);
  await assert.rejects(serializeRunnerExecutionBundleFromResponse({ ...options, response: valid }), (error) => {
    assert.ok(error instanceof RunnerSemanticResultError);
    assert.match(recoverableRunnerResultDiagnostic(error), /file-backed semantic execution response cannot include Fileless reason/u);
    return true;
  });
  await fs.rm(target);
  await fs.mkdir(target);
  await assert.rejects(serializeRunnerExecutionBundleFromResponse({ ...options, response: valid }), (error) => {
    assert.equal(recoverableRunnerResultDiagnostic(error), null, "filesystem failures are not semantic recovery");
    return true;
  });
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

test("fileless APPLY scope rejection preserves prior checks and formal findings history", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const target = path.join(fixture.root, "src/example.txt");
  const claim = path.relative(path.join(fixture.execution, "tasks"), target).split(path.sep).join("/");
  await writeValidatedPath(fixture, claim);
  await editTask(fixture, (value) => {
    let task = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", `- \`${claim}\``);
    task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll("../../src/example.txt", claim));
    task = replaceSection(task, "Validation Attempts", NEEDS_FIX_ATTEMPT.replaceAll("../../src/example.txt", claim));
    return replaceSection(task, "Validation Findings", ACTIVE_FINDING);
  });
  await preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1");
  const before = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  await fs.writeFile(copy.candidateTaskArtifact, replaceSection(before, "Changed Areas", "- none"));
  const { priorRoundFailure, correctionApplied, inSliceRationale, ...common } = scopeRegressionPayload();
  const response = JSON.stringify({ ...common, findingsCycle: "attempt-01", findingsVerified: "none",
    correctionsCovered: "fileless correction", regressionsSelected: "approved prepared checks", unsupportedActiveFindings: "finding-01" });
  const captured = await capturedCommandEvidence(t, "APPLY_FINDINGS", response, "STNL_VERIFICATION_COMMAND=1 node --test test/prepared.test.mjs");
  const cli = spawnSync(process.execPath, [path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--execution-bundle", "--operation", "APPLY_FINDINGS", "--workspace", fixture.root,
    "--task-artifact", copy.candidateTaskArtifact, "--semantic-response-file", captured.semanticResponseFile,
    "--receipt-file", captured.receiptFile, "--insert-candidate"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).state, "RUNNER_RESULT_BLOCKED");
  await publishExecutionCopy({ specPath: fixture.requirements, slice: "slice-01", candidateRoot: copy.candidateRoot });
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, "RUNNER_RESULT_BLOCKED");
  assert.equal(state.mandatoryRecovery.operation, "APPLY_FINDINGS");
  const after = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  for (const heading of ["Implementation Test Evidence", "Validation Attempts", "Validation Findings", "Effective Validation Base", "Final Result"])
    assert.equal(sectionBodyForScopeTest(after, heading), sectionBodyForScopeTest(before, heading));
  assert.equal(state.tasks.get("slice-01").findingsChecks.length, 0);
});

test("scope blocker retains an earlier private fileless failure and its check identifier", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  const prior = checkRecord("implementation-check", 1, "TESTS_FAIL", 1).replace(
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    "- Tested state: none\n- Fileless reason: Acceptance-only checks change no repository file.");
  let candidate = replaceSection(await fs.readFile(copy.candidateTaskArtifact, "utf8"), "Changed Areas", "- none");
  candidate = replaceSection(candidate, "Implementation Test Evidence", prior);
  await fs.writeFile(copy.candidateTaskArtifact, candidate);
  const response = JSON.stringify({ ...scopeRegressionPayload(), automaticCheckRound: "2/3",
    priorRoundFailure: "Prior prepared check failed.", correctionApplied: "Corrected the in-slice fileless check input.",
    inSliceRationale: "Same approved acceptance behavior; no file changes." });
  const captured = await capturedCommandEvidence(t, "EXECUTE_SLICE", response, "STNL_VERIFICATION_COMMAND=1 node --test test/prepared.test.mjs");
  const result = spawnSync(process.execPath, [path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--execution-bundle", "--operation", "EXECUTE_SLICE", "--workspace", fixture.root,
    "--task-artifact", copy.candidateTaskArtifact, "--semantic-response-file", captured.semanticResponseFile,
    "--receipt-file", captured.receiptFile, "--insert-candidate"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "RUNNER_RESULT_BLOCKED");
  const after = await fs.readFile(copy.candidateTaskArtifact, "utf8");
  assert.equal(sectionBodyForScopeTest(after, "Implementation Test Evidence"), sectionBodyForScopeTest(candidate, "Implementation Test Evidence"));
  assert.match(after, /- After record: implementation-check-01/u);
  assert.doesNotMatch(after, /^### implementation-check-02/mu);
  assert.equal((await validateExecutionCandidate(fixture.requirements, copy.candidateExecutionRoot)).state, "RUNNER_RESULT_BLOCKED");
  await publishExecutionCopy({ specPath: fixture.requirements, slice: "slice-01", candidateRoot: copy.candidateRoot });
  assert.equal((await inspectExecutionState(fixture.requirements)).tasks.get("slice-01").implementationChecks.length, 1);
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
  await writeValidatedPath(fixture);
  await editTask(fixture, (value) => {
    let task = value.replace("- [ ] 1.1", "- [x] 1.1");
    task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
    task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(task, "Diff Summary", "- Verified behavior is implemented.");
  });
  const preflight = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  const officialPreflight = { exitCode: 0, operation: "VALIDATE_SLICE", slice: "slice-01", inputSlice: "1",
    specPath: fixture.requirements, state: preflight.state, authority: `sha256:${preflight.currentFingerprint}`,
    legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery };
  const context = await createManagedSliceContext({ officialPreflight, workspace: fixture.root, snapshot: ROOT,
    adapterPath: path.join(ROOT, "agents/codex/runtime/validation-runner.mjs"),
    bridgePath: path.join(ROOT, "agents/codex/runtime/managed-runner-bridge.mjs"),
    preflightPath: path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs") });
  const tmpdir = await temporary(t, "stnl-managed-provider-");
  const environment = managedEnvironment({ PATH: process.env.PATH, TMPDIR: tmpdir }, context);
  const semantic = JSON.stringify({ status: "PASS", head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "semantic claim", exit: 0 }], evidence: "simulated independent provider result",
    findingReferences: "none", findingDispositions: "none", blockers: "none",
    unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes" });
  const check = "STNL_VERIFICATION_COMMAND=1 node --test test/cli.test.mjs";
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
          ...(runnerTurns === 1 ? [
            { operationId, type: "item.started", item: { id: "item_0", type: "command_execution", command: check } },
            { operationId, type: "item.completed", item: { id: "item_0", type: "command_execution", command: check, status: "completed", exit_code: 0 } },
          ] : []),
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
    const copy = await prepareValidationCopy({ specPath: fixture.requirements, slice: "slice-01", candidateParent: tmpdir });
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
      candidateExecutionRoot: copy.candidateExecutionRoot })).state, "COMPLETE");
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
  } finally { await broker.close(); }
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
    assert.deepEqual(JSON.parse(await fs.readFile(receipt.receiptFile)), receipt);
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
  const original = path.join(ROOT, "benchmark-temp/run-20260929125208-f85c2e3a/case-c");
  if (!await fs.access(path.join(original, "10-validate_slice.json")).then(() => true, () => false)) {
    t.skip("historical local replay artifact is absent"); return;
  }
  const evidence = JSON.parse(await fs.readFile(path.join(original, "10-validate_slice.json"), "utf8"));
  const copyRoot = await temporary(t, "stnl-case-c-replay-");
  const workspace = path.join(copyRoot, "workspace");
  const specPath = path.join(workspace, "specs/benchmark-case-c");
  const tmpdir = path.join(copyRoot, "tmp");
  const candidate = path.join(tmpdir, "validation-slice-02-copy");
  const response = path.join(tmpdir, "validation-slice-02.response.json");
  await fs.mkdir(path.dirname(specPath), { recursive: true });
  await fs.mkdir(tmpdir);
  await fs.cp(path.join(original, "workspace/specs/benchmark-case-c"), specPath, { recursive: true });
  await fs.cp(path.join(original, "tmp/validation-slice-02-0MT9ZT"), candidate, { recursive: true });
  await fs.copyFile(path.join(original, "tmp/validation-slice-02.response.json"), response);
  const before = await fs.readFile(path.join(candidate, "tasks/slice-02.md"));
  const historical = evidence.officialPreflight;
  const context = await createManagedSliceContext({ workspace, snapshot: ROOT,
    adapterPath: path.join(ROOT, "agents/codex/runtime/validation-runner.mjs"),
    bridgePath: path.join(ROOT, "agents/codex/runtime/managed-runner-bridge.mjs"),
    preflightPath: path.join(ROOT, "agents/codex/runtime/managed-slice-preflight.mjs"),
    officialPreflight: { ...historical, specPath } });
  const environment = managedEnvironment({ PATH: process.env.PATH, TMPDIR: tmpdir }, context);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs"),
    "--prepare", "--spec-path", specPath, "--slice", "slice-02", "--workspace", workspace,
    "--candidate-execution-root", candidate, "--semantic-response-file", response,
  ], { cwd: workspace, env: environment, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed runner receipt is required; use the configured bridge/u);
  assert.deepEqual(await fs.readFile(path.join(candidate, "tasks/slice-02.md")), before);
  assert.equal(evidence.runner.requestsHandled, 0);
});

test("validation publisher accepts its own complete candidate after the materializer rejects it", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const physicalTarget = path.join(fixture.root, "src", "validation target.mjs");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, VALIDATED_CONTENT, "utf8");

  const liveTask = path.join(fixture.execution, "tasks", "slice-01.md");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  const taskClaim = path.relative(path.dirname(liveTask), physicalTarget).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: globalClaim, detail: detailClaim, task: taskClaim });
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- \`" + taskClaim + "\`");
    result = replaceSection(result, "Implementation Test Evidence", replaceAll(
      checkRecord("implementation-check", 1, "TESTS_PASS", 1),
      [["../../src/example.txt", taskClaim]],
    ));
    return replaceSection(result, "Diff Summary", "- Implemented the approved observable behavior.");
  });

  const responseRoot = await temporary(t, "stnl-validation-publish-response-");
  const semanticResponseFile = path.join(responseRoot, "response.json");
  await fs.writeFile(semanticResponseFile, JSON.stringify({
    status: "PASS",
    head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "node --test test/cli.test.mjs", exit: 0 }],
    evidence: "focused validation passed",
    findingReferences: "none",
    findingDispositions: "none",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "formal result returned",
  }), "utf8");

  const candidateParent = await temporary(t, "stnl-validation-publish-candidate-");
  const candidateRoot = path.join(candidateParent, "execution");
  await copyDirectory(fixture.execution, candidateRoot);
  const prepared = await prepareValidationCandidate({
    specPath: fixture.requirements,
    slice: "1",
    workspace: fixture.root,
    candidateExecutionRoot: candidateRoot,
    semanticResponseFile,
  });
  assert.equal(prepared.formalStatus, "PASS");
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidateRoot)).state, "COMPLETE");

  const liveTaskBefore = await fs.readFile(liveTask);
  const liveIndexPath = path.join(fixture.execution, "tasks.md");
  const liveIndexBefore = await fs.readFile(liveIndexPath);
  await assert.rejects(
    publishTaskMaterializationCandidate({
      specPath: fixture.requirements,
      candidateExecutionRoot: candidateRoot,
    }),
    /slice-01 historical task changed during materialization/u,
  );
  assert.deepEqual(await fs.readFile(liveTask), liveTaskBefore);
  assert.deepEqual(await fs.readFile(liveIndexPath), liveIndexBefore);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const preparedCandidateBeforePublish = await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md"));
  const controllerResult = await publishValidationCandidate({
    specPath: fixture.requirements,
    slice: "slice-01",
    candidateExecutionRoot: candidateRoot,
  });
  assert.equal(controllerResult.status, "PASS");
  assert.equal(controllerResult.state, "COMPLETE");
  assert.deepEqual(await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md")), preparedCandidateBeforePublish,
    "strict publisher must publish the already prepared candidate without rewriting it");
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
  assert.deepEqual(
    await fs.readFile(path.join(fixture.execution, "tasks", "slice-01.md")),
    await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md")),
  );
  assert.deepEqual(
    await fs.readFile(path.join(fixture.execution, "tasks.md")),
    await fs.readFile(path.join(candidateRoot, "tasks.md")),
  );
});

test("validation candidate preparation preserves a new semantic NEEDS_FIX finding for strict ownership validation", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const liveTask = path.join(fixture.execution, "tasks", "slice-01.md");
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Diff Summary", "- Implementation is complete but the independent validation found a blocking mismatch.");
  });
  const responseRoot = await temporary(t, "stnl-validation-needs-fix-response-");
  const semanticResponseFile = path.join(responseRoot, "response.json");
  await fs.writeFile(semanticResponseFile, JSON.stringify({
    status: "NEEDS_FIX",
    head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "node --test test/cli.test.mjs", exit: 0 }],
    evidence: "validation reproduced a behavior mismatch",
    findingReferences: "finding-01",
    findingDispositions: "finding-01=active",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "finding requires correction",
  }), "utf8");
  const candidateParent = await temporary(t, "stnl-validation-needs-fix-candidate-");
  const candidateRoot = path.join(candidateParent, "execution");
  await copyDirectory(fixture.execution, candidateRoot);
  const candidateTask = path.join(candidateRoot, "tasks", "slice-01.md");
  await fs.writeFile(candidateTask, replaceSection(await fs.readFile(candidateTask, "utf8"), "Validation Findings", ACTIVE_FINDING), "utf8");

  assert.equal(await fs.readFile(liveTask, "utf8").then((value) => value.includes("### attempt-01")), false);
  const prepared = await prepareValidationCandidate({
    specPath: fixture.requirements,
    slice: "slice-01",
    workspace: fixture.root,
    candidateExecutionRoot: candidateRoot,
    semanticResponseFile,
  });
  assert.equal(prepared.formalStatus, "NEEDS_FIX");
  const published = await publishValidationCandidate({
    specPath: fixture.requirements,
    slice: "slice-01",
    candidateExecutionRoot: candidateRoot,
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
  const captured = await capturedCommandEvidence(t, "VALIDATE_SLICE", JSON.stringify(response), "STNL_VERIFICATION_COMMAND=1 node --test test/cli.test.mjs");
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
  const passCaptured = await capturedCommandEvidence(t, "VALIDATE_SLICE", JSON.stringify(pass), "STNL_VERIFICATION_COMMAND=1 node --test test/cli.test.mjs");
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
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  const candidateParent = await temporary(t, "stnl-validation-blocker-candidate-");
  const candidateRoot = path.join(candidateParent, "execution");
  await copyDirectory(fixture.execution, candidateRoot);
  const candidateTask = path.join(candidateRoot, "tasks", "slice-01.md");
  await fs.writeFile(candidateTask, replaceSection(await fs.readFile(candidateTask, "utf8"),
    "Delegation Blocker", delegationBlocker("VALIDATE_SLICE", "malformed-output")), "utf8");
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidateRoot)).state, "RUNNER_RESULT_BLOCKED");
  const published = await publishValidationCandidate({
    specPath: fixture.requirements, slice: "slice-01", candidateExecutionRoot: candidateRoot,
  });
  assert.equal(published.status, "PASS");
  assert.equal(published.state, "RUNNER_RESULT_BLOCKED");
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "RUNNER_RESULT_BLOCKED");
});

test("formal validation output round-trips through NEEDS_FIX, correction, PASS, base, final, and handoff", async (t) => {
  const runnerContract = await fs.readFile(path.join(ROOT, "agents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  for (const fieldName of ["return one raw JSON object with exactly the lowerCamelCase semantic keys", '"status": "PASS | NEEDS_FIX | BLOCKED"', '"head": "<semantic value>"', '"commands": [{"command": "<full command>", "exit": 0}]', '"findingReferences": "<semantic value>"', '"findingDispositions": "<semantic value>"']) {
    assert.ok(runnerContract.includes(fieldName), fieldName);
  }
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");

  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  const needsFix = await inspectExecutionState(fixture.requirements);
  assert.equal(needsFix.state, "VALIDATION_NEEDS_FIX");
  const needsFixHandoff = deriveNormalHandoff(needsFix, "VALIDATE_SLICE");
  assert.equal(needsFixHandoff.operation, "APPLY_FINDINGS");
  assert.equal(needsFixHandoff.slice, "slice-01");

  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Corrections Applied", "- `../../src/example.txt`");
    return replaceSection(result, "Findings Test Evidence", checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" }));
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "FINDINGS_CORRECTED");

  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "PASS", { references: "finding-01", dispositions: "finding-01=resolved" })}`);
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed the correction.`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await writeValidatedPath(fixture);
  const complete = await inspectExecutionState(fixture.requirements);
  assert.equal(complete.state, "COMPLETE");
  assert.equal(complete.tasks.get("slice-01").base.present, true);
  assert.equal(complete.tasks.get("slice-01").base.paths[0], "../../src/example.txt");
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

test("real planner and materializer templates round-trip through review and materialization handoffs", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture, { materialized: false, planStatus: "draft" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");
  await editPlan(fixture, (value) => headerReady(value));
  await editSlicePlan(fixture, "slice-01", (value) => headerReady(value));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PLANNED_READY");
  await renderTasks(fixture, { revision: 1, fingerprint: authority });
  const materialized = await inspectExecutionState(fixture.requirements);
  assert.equal(materialized.state, "MATERIALIZED_PRISTINE");
  assert.deepEqual(deriveNormalHandoff(materialized, "MATERIALIZE_TASKS"), {
    workflowSkill: "stnl-task-reviewer",
    operation: "REVIEW_TASKS",
    invocation: "OPERATION=REVIEW_TASKS",
    slice: null,
  });
});

test("distributed execution schemas and runtime agree on corrected semantic boundaries", async (t) => {
  const schemaPaths = [
    "stnl-slice-executor", "stnl-slice-quality-manager", "stnl-task-materializer",
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
    /The first `PASS` attempt is terminal/u,
  ]) assert.match(schemas[0], rule);

  const accepted = await standaloneWorkspace(t);
  await renderArtifacts(accepted);
  await editTask(accepted, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await inspectExecutionState(accepted.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await editTask(accepted, (value) => value.replace("- Tested scope: ../../src/example.txt", "- Tested scope:\n  - ../../src/example.txt"));
  await assert.rejects(inspectExecutionState(accepted.requirements), /Tested scope|unexpected nested/u);
});

test("execution producer serializes automatic correction fields and excludes findings-only labels", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const physicalTarget = path.join(fixture.root, "src/example.txt");
  const claim = path.relative(path.dirname(taskArtifact), physicalTarget).split(path.sep).join("/");
  await editTask(fixture, (value) => replaceSection(
    replaceSection(value, "Changed Areas", `- \`${claim}\``),
    "Corrections Applied",
    "- none",
  ));
  await editTask(fixture, (value) => replaceSection(
    value,
    "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "TESTS_FAIL", 1),
  ));
  await fs.writeFile(physicalTarget, "corrected behavior\n", "utf8");

  const roundTwoPayload = {
    status: "TESTS_PASS",
    automaticCheckRound: "2/3",
    head: "fixture-head",
    discoverySources: "task and package scripts",
    discoveryActions: "read-only inspection",
    verificationTypesConsidered: "unit tests",
    nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "not applicable",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    resultOfEachCommandAndExitCode: "all passed after the bounded correction",
    selectedChecks: "node --test test/example.test.mjs",
    selectionRationale: "directly covers the changed behavior",
    coverage: "changed behavior",
    failures: "none",
    priorRoundFailure: "round one implementation evidence was rejected by the strict schema",
    correctionApplied: "updated the implementation evidence serialization fields",
    inSliceRationale: "the correction remains within the approved slice",
    evidenceOrFailureSummary: "focused tests passed after correction",
    affectedFilesOrBehaviors: "example behavior",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "record persisted",
  };
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: JSON.stringify({ ...roundTwoPayload, correctionsCovered: claim }),
      workspace: fixture.root,
      taskArtifact,
    }),
    /unknown semantic execution payload field: correctionsCovered/u,
  );

  const bundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE",
    response: JSON.stringify(roundTwoPayload),
    workspace: fixture.root,
    taskArtifact,
  });
  assert.match(bundle, /Automatic check round: 2\/3/u);
  assert.match(bundle, /Prior-round failure: round one implementation evidence was rejected by the strict schema/u);
  assert.match(bundle, /Correction applied: updated the implementation evidence serialization fields/u);
  const escapedClaim = claim.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(bundle, new RegExp(`Correction paths: ${escapedClaim}`));
  assert.match(bundle, new RegExp(`Updated scope: ${escapedClaim}`));
  assert.match(bundle, /In-slice rationale: the correction remains within the approved slice/u);
  assert.doesNotMatch(bundle, /Corrections covered:/u);

  const missingPriorFailure = await nestedLifecycleWorkspace(t);
  const missingTask = path.join(missingPriorFailure.execution, "tasks/slice-01.md");
  await editTask(missingPriorFailure, (value) => replaceSection(value, "Changed Areas", `- \`${path.relative(path.dirname(missingTask), path.join(missingPriorFailure.root, "src/example.txt")).split(path.sep).join("/")}\``));
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: JSON.stringify(roundTwoPayload),
      workspace: missingPriorFailure.root,
      taskArtifact: missingTask,
    }),
    /requires prior implementation-check-1\/3 evidence/u,
  );

  const wrongCorrection = await nestedLifecycleWorkspace(t);
  const wrongTask = path.join(wrongCorrection.execution, "tasks/slice-01.md");
  const wrongClaim = path.relative(path.dirname(wrongTask), path.join(wrongCorrection.root, "src/example.txt")).split(path.sep).join("/");
  await fs.writeFile(path.join(wrongCorrection.root, "src/other.txt"), "unrelated\n", "utf8");
  await editTask(wrongCorrection, (value) => {
    let result = replaceSection(value, "Changed Areas", `- \`${wrongClaim}\``);
    result = replaceSection(result, "Corrections Applied", `- \`../../src/other.txt\``);
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
  });
  await fs.writeFile(path.join(wrongCorrection.root, "src/example.txt"), "corrected behavior\n", "utf8");
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: JSON.stringify(roundTwoPayload),
      workspace: wrongCorrection.root,
      taskArtifact: wrongTask,
    }),
    /Corrections Applied/u,
  );
});

test("third failed execution round preserves cumulative corrections with an unchanged file-backed delta", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const targets = [path.join(fixture.root, "src/example.txt"), path.join(fixture.root, "src/other.txt"),
    path.join(fixture.root, "src/stable.txt")];
  const claims = targets.map((target) => path.relative(path.join(fixture.execution, "tasks"), target).split(path.sep).join("/"));
  const correctionClaims = claims.slice(0, 2);
  await setImplementationAreas(fixture, {
    global: targets.map((target) => path.relative(fixture.execution, target)).join("`, `"),
    detail: claims.join("`, `"), task: claims.join("`, `"),
  });
  const livePaths = [fixture.requirements, path.join(fixture.execution, "plan.md"),
    path.join(fixture.execution, "plans/slice-01.md"), path.join(fixture.execution, "tasks.md"),
    path.join(fixture.execution, "tasks/slice-01.md")];
  const liveBytes = await Promise.all(livePaths.map((file) => fs.readFile(file)));
  const authority = (await inspectExecutionState(fixture.requirements)).currentFingerprint;
  const copy = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  t.after(() => fs.rm(copy.candidateRoot, { recursive: true, force: true }));
  const taskPath = copy.candidateTaskArtifact;
  await fs.writeFile(taskPath, replaceSection((await fs.readFile(taskPath, "utf8")).replace("- [ ] 1.1", "- [x] 1.1"),
    "Changed Areas", claims.map((claim) => `- \`${claim}\``).join("\n")));
  const responseFile = path.join(await temporary(t, "stnl-zero-delta-response-"), "response.json");
  const bundles = [];
  for (const round of [1, 2, 3]) {
    if (round === 1) await fs.writeFile(targets[2], "unchanged implementation\n");
    if (round < 3) for (const target of targets.slice(0, 2)) await fs.writeFile(target, `implementation round ${round}\n`);
    const response = JSON.stringify({
      status: "TESTS_FAIL", automaticCheckRound: `${round}/3`, head: "0123456789abcdef0123456789abcdef01234567",
      discoverySources: "prepared tests and current task", discoveryActions: "read-only inspection",
      verificationTypesConsidered: "unit and environment checks", nonApplicabilityRationale: "none",
      noVerificationCommandConfirmation: "verification command executed",
      commands: [{ command: "STNL_VERIFICATION_COMMAND=1 node prepared-check.mjs", exit: 1 }],
      resultOfEachCommandAndExitCode: "check failed", selectedChecks: "prepared check", selectionRationale: "same approved scope",
      coverage: "approved behavior", failures: `round ${round} check failed`,
      priorRoundFailure: round === 1 ? "none" : `round ${round - 1} check failed`,
      correctionApplied: round === 1 ? "none" : round === 2 ? "corrected two implementation paths" : "adjusted verification environment only; code unchanged",
      inSliceRationale: round === 1 ? "none" : "same approved behavior and prepared check",
      evidenceOrFailureSummary: "failed command retained", affectedFilesOrBehaviors: "approved behavior",
      blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "no runner writes",
    });
    await fs.writeFile(responseFile, response);
    const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: "EXECUTE_SLICE",
      response: await fs.readFile(responseFile, "utf8"), workspace: fixture.root, taskArtifact: taskPath });
    assert.equal(await fs.readFile(responseFile, "utf8"), response);
    await insertExecutionEvidenceInCandidate({ taskArtifact: taskPath, operation: "EXECUTE_SLICE", bundle });
    if (round === 2) assert.ok(bundle.includes(`- Correction paths: ${correctionClaims.join(", ")}`));
    if (round === 3) {
      assert.match(bundle, /^- Correction paths: none$/mu);
      assert.match(bundle, /^- Tested state:\n  - `/mu);
      assert.doesNotMatch(bundle, /Fileless reason:/u);
    }
    bundles.push(bundle);
  }
  const finalTask = await fs.readFile(taskPath, "utf8");
  for (const bundle of bundles) assert.ok(finalTask.includes(bundle), "every earlier check remains byte-identical");
  assert.ok(finalTask.includes(`## Corrections Applied\n\n${correctionClaims.map((claim) => `- \`${claim}\``).join("\n")}`));
  const strictRoot = path.join(await temporary(t, "stnl-zero-delta-strict-"), "execution");
  await copyDirectory(copy.candidateExecutionRoot, strictRoot);
  await fs.rm(path.join(strictRoot, ".stnl-execution-copy.json"), { force: true });
  const validated = await validateExecutionCandidate(fixture.requirements, strictRoot);
  assert.equal(validated.currentFingerprint, authority);
  assert.equal(validated.state, "IMPLEMENTATION_RETRY_EXHAUSTED");
  assert.deepEqual(bundles.map((bundle) => bundle.match(/^- Status: (.+)$/mu)[1]),
    ["TESTS_FAIL", "TESTS_FAIL", "TESTS_FAIL"]);
  assert.equal(validated.requiredRecoveryHandoff.operation, "VALIDATE_SLICE");
  assert.ok(!validated.legalOperations.some(({ operation }) => operation === "EXECUTE_SLICE"));
  assert.deepEqual(await Promise.all(livePaths.map((file) => fs.readFile(file))), liveBytes);
  for (const [label, text, diagnostic] of [
    ["changed-state", finalTask.replace(bundles[2], bundles[2].replace(/sha256:[0-9a-f]{64}/u, `sha256:${"0".repeat(64)}`)),
      /Correction paths cannot be none.*unchanged/u],
    ["missing-history", replaceSection(finalTask, "Corrections Applied", "- none"),
      /Correction paths are absent from Corrections Applied/u],
    ["false-fileless", finalTask.replace(bundles[2], bundles[2].replace("- Tested state:\n",
      "- Fileless reason: environment-only correction\n- Tested state:\n")), /Fileless reason.*only/u],
  ]) {
    const rejected = path.join(await temporary(t, `stnl-zero-delta-${label}-`), "execution");
    await copyDirectory(strictRoot, rejected);
    const rejectedTask = path.join(rejected, "tasks/slice-01.md");
    await fs.writeFile(rejectedTask, text);
    await assert.rejects(validateExecutionCandidate(fixture.requirements, rejected), diagnostic);
    assert.equal(await fs.readFile(rejectedTask, "utf8"), text, "rejection preserves candidate bytes");
  }
});

test("round-two correction is inserted into an owned candidate and passes strict validation", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const target = path.join(fixture.root, "src/example.txt");
  const claim = path.relative(path.dirname(liveTask), target).split(path.sep).join("/");
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", `- \`${claim}\``);
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
    return replaceSection(result, "Diff Summary", "- Example behavior implemented; first check failed.");
  });
  const prepared = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  t.after(() => fs.rm(prepared.candidateRoot, { recursive: true, force: true }));
  const liveBefore = await fs.readFile(liveTask);
  await fs.writeFile(target, "corrected behavior\n", "utf8");
  const response = {
    status: "TESTS_PASS", automaticCheckRound: "2/3", head: "0123456789abcdef0123456789abcdef01234567",
    discoverySources: "task and package scripts", discoveryActions: "read-only inspection",
    verificationTypesConsidered: "unit tests", nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "verification command executed",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    resultOfEachCommandAndExitCode: "focused check passed", selectedChecks: "focused unit test",
    selectionRationale: "direct scope", coverage: "corrected example behavior", failures: "none",
    priorRoundFailure: "first focused check failed", correctionApplied: "corrected example behavior",
    inSliceRationale: "same approved target", evidenceOrFailureSummary: "focused check passed",
    affectedFilesOrBehaviors: "example behavior", blockers: "none", unexpectedWorkspaceEffects: "none",
    persistenceSummary: "no runner writes",
  };
  const responseFile = path.join(await temporary(t, "stnl-round-two-response-"), "response.json");
  await fs.writeFile(responseFile, JSON.stringify(response), "utf8");
  const inserted = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--execution-bundle", "--operation", "EXECUTE_SLICE", "--workspace", fixture.root,
    "--task-artifact", prepared.candidateTaskArtifact, "--semantic-response-file", responseFile,
    "--insert-candidate",
  ], { encoding: "utf8" });
  assert.equal(inserted.status, 0, inserted.stderr);
  const candidate = await fs.readFile(prepared.candidateTaskArtifact, "utf8");
  assert.ok(candidate.includes(`## Corrections Applied\n\n- \`${claim}\``));
  assert.ok(candidate.includes(`- Correction paths: ${claim}`));
  const strictRoot = path.join(await temporary(t, "stnl-round-two-strict-"), "execution");
  await copyDirectory(prepared.candidateExecutionRoot, strictRoot);
  await fs.rm(path.join(strictRoot, ".stnl-execution-copy.json"));
  assert.equal((await validateExecutionCandidate(fixture.requirements, strictRoot)).state,
    "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(await fs.readFile(liveTask), liveBefore);

  const missingEvidence = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  t.after(() => fs.rm(missingEvidence.candidateRoot, { recursive: true, force: true }));
  const missingResponse = path.join(await temporary(t, "stnl-missing-correction-"), "response.json");
  await fs.writeFile(missingResponse, JSON.stringify({ ...response, correctionApplied: "none" }), "utf8");
  const rejected = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--execution-bundle", "--operation", "EXECUTE_SLICE", "--workspace", fixture.root,
    "--task-artifact", missingEvidence.candidateTaskArtifact, "--semantic-response-file", missingResponse,
    "--insert-candidate",
  ], { encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /correctionApplied is required/u);
  assert.deepEqual(await fs.readFile(liveTask), liveBefore);
});

test("duplicate or unknown task sections cannot hide operational records", async (t) => {
  const duplicate = await standaloneWorkspace(t);
  await renderArtifacts(duplicate);
  await editTask(duplicate, (value) => value.replace("## Validation Findings\n\n- none", `## Validation Findings

### finding-01

- Severity: blocking
- State: active
- Origin: attempt-99
- Problem: hidden record
- Evidence: duplicate section
- Impact: ambiguous state
- Related authority: AC-001
- Expected correction: remove duplicate

## Validation Findings

- none`));
  const duplicateBefore = await treeBytes(duplicate.execution);
  await assert.rejects(inspectExecutionState(duplicate.requirements), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.equal(error.message, "duplicate section: Validation Findings");
    return true;
  });
  assert.deepEqual(await treeBytes(duplicate.execution), duplicateBefore);

  const template = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  const headings = (text) => [...text.matchAll(/^## ([^\n]+)\n/gmu)].map((match) => match[1]);
  const expected = headings(template);
  for (const [mutate, missing, unexpected] of [
    [(text) => text.replace("## Diff Summary\n\n- pending\n\n", ""), ["Diff Summary"], []],
    [(text) => text.replace("## Final Result", "## Unknown Operational State\n\n- none\n\n## Final Result"), [], ["Unknown Operational State"]],
    [(text) => text.replace("## Expected Tests", "## __swap__").replace("## Changed Areas", "## Expected Tests").replace("## __swap__", "## Changed Areas"), [], []],
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
    await editTask(fixture, mutate);
    const task = path.join(fixture.execution, "tasks/slice-01.md");
    const actual = headings(await fs.readFile(task, "utf8"));
    const before = await treeBytes(fixture.execution);
    const message = `${task} has non-canonical sections; missing=${JSON.stringify(missing)}; unexpected=${JSON.stringify(unexpected)}; expected=${JSON.stringify(expected)}; actual=${JSON.stringify(actual)}`;
    await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
      assert.ok(error instanceof ExecutionContractError);
      assert.equal(error.message, message);
      return true;
    });
    const result = spawnSync(process.execPath, [path.join(ROOT, "skills/workflows/stnl-task-materializer/runtime/validate-execution-state.mjs"), fixture.requirements], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `BLOCKED: ${message}\n`);
    assert.deepEqual(await treeBytes(fixture.execution), before, "diagnostic rejection must not modify any execution artifact");
  }
});

test("execution artifacts enforce purpose owners and canonical cross-references", async (t) => {
  const owner = await standaloneWorkspace(t);
  await renderArtifacts(owner);
  await editTask(owner, (value) => value.replace("owner: stnl-task-materializer", "owner: unrelated-owner"));
  await assert.rejects(inspectExecutionState(owner.requirements), /wrong File Purpose Header owner/u);

  for (const [from, to, expected] of [
    ["- Requirements source: `../../requirements.md`", "- Requirements source: `../../user-owned.md`", /non-canonical Requirements source/u],
    ["- Plan: `../plans/slice-01.md`", "- Plan: `../plans/slice-99.md`", /non-canonical Plan/u],
    ["- Global tasks: `../tasks.md`", "- Global tasks: `../other.md`", /non-canonical Global tasks/u],
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => value.replace(from, to));
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }
  const plan = await standaloneWorkspace(t);
  await renderArtifacts(plan);
  await editSlicePlan(plan, "slice-01", (value) => value.replace("- Global plan: `../plan.md`", "- Global plan: `../other.md`"));
  await assert.rejects(inspectExecutionState(plan.requirements), /non-canonical Global plan/u);
});

test("plan-only materialization preflight parses every detailed plan and review state", async (t) => {
  const malformed = await standaloneWorkspace(t);
  await renderArtifacts(malformed, { materialized: false });
  await fs.writeFile(path.join(malformed.execution, "plans/slice-01.md"), "utterly malformed\n", "utf8");
  await assert.rejects(preflightExecutionOperation(malformed.requirements, "MATERIALIZE_TASKS"), /File Purpose Header/u);

  const draft = await standaloneWorkspace(t);
  await renderArtifacts(draft, { materialized: false });
  await editSlicePlan(draft, "slice-01", (value) => value.replace("status: ready", "status: draft").replace("Review state: approved", "Review state: pending"));
  await assert.rejects(preflightExecutionOperation(draft.requirements, "MATERIALIZE_TASKS"), /ready global plan retains a draft detailed plan/u);
});

test("planning-only REPLAN atomically replaces revision 1 and returns through review and initial materialization", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture, { materialized: false, planStatus: "draft" });
  const initial = await inspectExecutionState(fixture.requirements);
  assert.equal(initial.state, "PLANNED_DRAFT");
  assertRecoveryTarget(initial, { operation: "REPLAN", slice: null, owner: "planning-authority" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "PLANNED_DRAFT");

  await replacePlanningOnly(fixture, authority, authority);
  const replacement = await inspectExecutionState(fixture.requirements);
  assert.equal(replacement.state, "PLANNED_DRAFT");
  assert.equal(replacement.globalPlan.revision, 1);
  assert.equal(replacement.globalPlan.revisionMode, null);
  assert.deepEqual(replacement.globalPlan.supersessionMappings, []);
  await assert.rejects(fs.stat(path.join(fixture.execution, "tasks.md")), { code: "ENOENT" });
  const replacementReadback = { execution: replacement, executionRaw: replacement,
    product: { deriveNormalHandoff } };
  assert.deepEqual(decideOutcome("REPLAN", replacementReadback, true), { result: "PASS", blocker: null });
  assert.deepEqual(nextHandoff("REPLAN", replacementReadback), { operation: "REVIEW_PLAN", slice: null });
  assert.deepEqual(decideOutcome("REPLAN", replacementReadback, false),
    { result: "BLOCKED", blocker: "SDK_TURN_FAILED" });

  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");
  await editPlan(fixture, (value) => setPlanReviewState(value, true));
  await editSlicePlan(fixture, "slice-01", (value) => setPlanReviewState(value, true));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PLANNED_READY");
  await renderTasks(fixture, { revision: 1, fingerprint: authority });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("reviewed planning made stale before tasks replans without historical recovery metadata", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture, { materialized: false, planStatus: "ready" });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "PLANNED_READY");
  await fs.appendFile(fixture.requirements, "- AC-002: authority changed before materialization\n");
  const stale = await inspectExecutionState(fixture.requirements);
  assert.equal(stale.state, "REQUIREMENTS_CHANGED");
  assert.deepEqual(stale.recoveryTargets.map(({ operation, slice }) => ({ operation, slice })), [{ operation: "REPLAN", slice: null }]);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "REQUIREMENTS_CHANGED");

  const budgets = JSON.parse(await fs.readFile(path.join(ROOT, "benchmarks/sentinel-todo/benchmark.json"), "utf8"))
    .cases.find((item) => item.id === "A").budgets;
  const readback = { execution: stale, executionRaw: stale };
  const outcome = decideOutcome("MATERIALIZE_TASKS", readback, true);
  const history = [{ operation: "MATERIALIZE_TASKS", slice: null, outcome }];
  const historyBefore = JSON.stringify(history);
  const executionBefore = await treeBytes(fixture.execution);
  const product = { validateWorkspace: () => ({ status: "ready" }), inspectExecutionState, preflightExecutionOperation };
  const recoveryInput = { operation: "MATERIALIZE_TASKS", slice: null, outcome, readback,
    priorOperations: history, remainingTurns: 1, budgets, product, specPath: fixture.requirements };
  const recovery = await prepareOfficialRecovery(recoveryInput);
  assert.deepEqual(recovery, { operation: "REPLAN", slice: null, state: "REQUIREMENTS_CHANGED",
    authority: stale.currentFingerprint, target: stale.recoveryTargets[0] });
  assert.equal(JSON.stringify(history), historyBefore, "the original BLOCKED record remains intact");
  assert.deepEqual(await treeBytes(fixture.execution), executionBefore, "selection and preflight are read-only");
  assert.equal(await prepareOfficialRecovery({ ...recoveryInput, remainingTurns: 0 }), null);
  assert.equal(await prepareOfficialRecovery({ ...recoveryInput, transportFailed: true }), null);
  assert.equal(await prepareOfficialRecovery({ ...recoveryInput,
    priorOperations: [...history, { operation: "REPLAN", outcome: { result: "PASS" } }] }), null);
  const denied = Object.assign(new Error("preflight access denied"), { code: "EACCES" });
  await assert.rejects(prepareOfficialRecovery({ ...recoveryInput, product: { ...product,
    preflightExecutionOperation: async () => { throw denied; } } }), { code: "EACCES" });
  await fs.appendFile(fixture.requirements, "- AC-003: authority changed again before recovery\n");
  assert.equal(await prepareOfficialRecovery(recoveryInput), null, "fresh authority invalidates the selected recovery");
  assert.equal(JSON.stringify(history), historyBefore);
  assert.deepEqual(await treeBytes(fixture.execution), executionBefore);

  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await replacePlanningOnly(fixture, oldHash, newHash);
  const replacement = await inspectExecutionState(fixture.requirements);
  assert.equal(replacement.state, "PLANNED_DRAFT");
  assert.equal(replacement.globalPlan.revision, 1);
  assert.equal(replacement.globalPlan.revisionMode, null);
  await editPlan(fixture, (value) => setPlanReviewState(value, true));
  await editSlicePlan(fixture, "slice-01", (value) => setPlanReviewState(value, true));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PLANNED_READY");
  await renderTasks(fixture, { revision: 1, fingerprint: newHash });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  assert.equal(await prepareOfficialRecovery(recoveryInput), null, "a healed state cannot restart old recovery");
  await t.test("manager dispatches recovery once, retains BLOCKED journal history, and completes with bounded fake transport", async (child) => {
    const runRoot = path.join(ROOT, "benchmark-temp", `run-test-managed-loop-${randomUUID()}`);
    await fs.mkdir(runRoot);
    child.after(async () => {
      spawnSync("chmod", ["-R", "u+w", runRoot]);
      await fs.rm(runRoot, { recursive: true, force: true });
    });
    await fs.writeFile(path.join(runRoot, ".sentinel-benchmark-owned"), "sentinel-todo-run-v2\n");
    const configuration = JSON.parse(await fs.readFile(path.join(ROOT, "benchmarks/sentinel-todo/benchmark.json"), "utf8"));
    const snapshotMetadata = await createSnapshot(runRoot);
    await initializeTurnBudget(runRoot, configuration.turnBudget.maxTurnsPerRun);
    const workspace = path.join(runRoot, "case-a/workspace");
    const specPath = path.join(workspace, "specs/benchmark-case-a");
    const flow = { root: workspace, requirements: specPath, execution: path.join(specPath, "execution") };
    const calls = [];
    let reviews = 0;
    let runnerNumber = 0;
    let activeBroker;
    const product = {
      inspectExecutionState, preflightExecutionOperation, deriveNormalHandoff, workflowSkillForOperation,
      validateWorkspace: validateLifecycleWorkspace, createManagedSliceContext, managedEnvironment,
      createUsageNormalizer, ZERO_USAGE,
      prepareIsolatedHome: async () => {
        const privateHome = path.join(runRoot, "mock-private-home"); await fs.mkdir(privateHome);
        return { privateHome, env: { ...process.env } };
      },
      verifyIsolatedHome: async () => ({ status: "MOCK_TRANSPORT_HOME" }),
      removeIsolatedHome: async (home) => fs.rm(home.privateHome, { recursive: true }),
      managedDiscoveryInstructions: () => "Use the frozen Sentinel workflow resources for this offline fixture.",
      startOfficialRunnerBroker: async ({ invoke }) => {
        activeBroker = { invoke, errors: [], capturedReceipts: 0, requestsHandled: 0, close: async () => {} };
        return activeBroker;
      },
      invokeIndependentRunner: async (input) => {
        await input.onBeforeTurn();
        const eventsPath = path.join(runRoot, `mock-runner-${++runnerNumber}.jsonl`);
        await fs.writeFile(eventsPath, "");
        const turn = { completed: true, turnStarted: true, threadId: `mock-runner-${runnerNumber}`, usage: { input_tokens: 1, output_tokens: 1 } };
        await input.onTurn({ turn, eventsPath });
        return { status: "RUNNER_RESPONSE_CAPTURED", exitCode: 0 };
      },
      runCodexTurn: async (input) => {
        const operation = input.operationId.split("-").slice(2).join("-"); calls.push(operation);
        await fs.appendFile(input.eventsPath, "");
        if (operation === "SPEC_INIT") {
          await fs.cp(path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"), specPath, { recursive: true });
        } else if (operation === "PLAN" || operation === "REPLAN") {
          await renderArtifacts(flow, { materialized: false, planStatus: "draft" });
        } else if (operation === "REVIEW_PLAN") {
          await editPlan(flow, (text) => setPlanReviewState(text, true));
          await editSlicePlan(flow, "slice-01", (text) => setPlanReviewState(text, true));
          if (++reviews === 1) await fs.appendFile(path.join(specPath, "shared/requirements.md"), "\nDocumentary authority changed in this fixture.\n");
        } else if (operation === "MATERIALIZE_TASKS") {
          const staged = await prepareTaskMaterializationCandidate({ specPath });
          try {
            await renderTasks(flow, { outputExecutionRoot: staged.candidateExecutionRoot });
            await publishTaskMaterializationCandidate({ specPath, candidateExecutionRoot: staged.candidateExecutionRoot });
          } finally { await fs.rm(staged.candidateExecutionRoot, { recursive: true, force: true }); }
        } else if (operation === "EXECUTE_SLICE" || operation === "VALIDATE_SLICE") {
          await activeBroker.invoke({ prompt: "bounded fake independent check" });
          activeBroker.requestsHandled += 1; activeBroker.capturedReceipts += 1;
          const claim = path.relative(path.join(flow.execution, "tasks"), path.join(workspace, "src/example.txt")).split(path.sep).join("/");
          if (operation === "EXECUTE_SLICE") {
            // This orchestration fixture supplies a correct product for the independent final gate.
            await fs.copyFile(path.join(ROOT, "scripts/fixtures/filtered-cli.mjs"), path.join(workspace, "src/cli.mjs"));
            await writeValidatedPath(flow, claim);
            await editTask(flow, (text) => {
              let task = text.replace("- [ ] 1.1", "- [x] 1.1");
              task = replaceSection(task, "Changed Areas", `- \`${claim}\``);
              task = replaceSection(task, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll("../../src/example.txt", claim));
              return replaceSection(task, "Diff Summary", "- Bounded fixture implementation persisted.");
            });
          } else {
            await editTask(flow, (text) => publishPassResult(replaceSection(replaceSection(text,
              "Validation Attempts", PASS_ATTEMPT.replaceAll("../../src/example.txt", claim)),
              "Effective Validation Base", PASS_BASE.replaceAll("../../src/example.txt", claim))));
            await editTasksIndex(flow, (text) => text.replace("| pending | pending |", "| PASS | PASS |").replace("| [ ] |", "| [x] |"));
          }
        } else if (operation === "SPEC_CLOSE") {
          const closed = renderClosedFeature(specPath);
          await fs.writeFile(path.join(specPath, "feature_spec.md"), closed);
          await fs.rm(path.join(specPath, "shared"), { recursive: true });
        } else assert.equal(operation, "REVIEW_TASKS");
        return { completed: true, turnStarted: true, threadId: `mock-main-${calls.length}`, response: "fixture operation completed",
          requestedModel: input.model, reportedModel: input.model, requestedEffort: input.effort,
          usage: { input_tokens: 1, output_tokens: 1 }, toolCalls: 0 };
      },
    };
    const nodeTestContext = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT; // The finalizer subprocess must run the real candidate tests.
    try {
      await runCase({ runRoot, caseId: "A", configuration, snapshotMetadata, maxOperations: null,
        mode: "case", product, signal: new AbortController().signal });
    } finally {
      if (nodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = nodeTestContext;
    }
    const result = JSON.parse(await fs.readFile(path.join(runRoot, "case-a/case-state.json"), "utf8"));
    assert.equal(result.status, "PASS", JSON.stringify(result.terminal));
    assert.deepEqual(calls, ["SPEC_INIT", "PLAN", "REVIEW_PLAN", "REPLAN", "REVIEW_PLAN", "MATERIALIZE_TASKS", "REVIEW_TASKS", "EXECUTE_SLICE", "VALIDATE_SLICE", "SPEC_CLOSE"]);
    const journal = JSON.parse(await fs.readFile(result.journal, "utf8"));
    assert.equal(journal.events[2].result, "BLOCKED");
    assert.equal(journal.events[2].resultingState, "REQUIREMENTS_CHANGED");
    assert.equal(journal.events[3].operation, "REPLAN");
    assert.equal(journal.events[3].result, "PASS");
    assert.equal(result.operations[3].recovery.operation, "REPLAN");
    assert.equal(journal.events.filter((entry) => entry.operation === "REPLAN").length, 1);
    assert.equal(result.operations[2].outcome.result, "BLOCKED");
    assert.deepEqual((await budgetSnapshot(runRoot)).turnBudget, { limit: configuration.turnBudget.maxTurnsPerRun,
      consumed: 12, remaining: configuration.turnBudget.maxTurnsPerRun - 12, mainTurns: 10, runnerTurns: 2 });
    assert.equal((await inspectExecutionState(specPath)).state, "COMPLETE");
    assert.equal(validateLifecycleWorkspace(specPath).closed, true);
    assert.equal(JSON.parse(await fs.readFile(result.finalizer.rawPath, "utf8")).status, "PASS");
    child.diagnostic(JSON.stringify({ status: result.status, calls, historicalBlocked: journal.events[2], consumedTurns: 12 }));
  });
});

test("planning-only replacement rejects historical REPLAN fields and obsolete competing plans", async (t) => {
  const historical = await standaloneWorkspace(t);
  await renderArtifacts(historical, { materialized: false, planStatus: "draft" });
  await editPlan(historical, (value) => value.replace(
    "- Objective: Deliver observable behavior",
    "- Revision mode: pristine-replacement\n- Replan reason: invalid history before tasks\n- Supersedes open slices: none\n- Objective: Deliver observable behavior",
  ));
  await assert.rejects(inspectExecutionState(historical.requirements), /planning-only REPLAN must omit historical recovery revision fields/u);

  const obsolete = await standaloneWorkspace(t);
  await renderArtifacts(obsolete, { materialized: false, planStatus: "draft" });
  const stalePlan = (await fs.readFile(path.join(obsolete.execution, "plans/slice-01.md"), "utf8"))
    .replaceAll("Slice 01", "Slice 02").replaceAll("- Slice: 01", "- Slice: 02");
  await fs.writeFile(path.join(obsolete.execution, "plans/slice-02.md"), stalePlan, "utf8");
  await assert.rejects(inspectExecutionState(obsolete.requirements), /plans directory does not exactly match the current Serial Slice Order/u);
  await fs.rm(path.join(obsolete.execution, "plans/slice-02.md"));
  assert.equal((await inspectExecutionState(obsolete.requirements)).state, "PLANNED_DRAFT");
});

test("controlled execution artifacts reject hardlinks without mutating external bytes", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const external = path.join(fixture.root, "user-owned.md");
  const bytes = await fs.readFile(taskPath);
  await fs.writeFile(external, bytes);
  await fs.rm(taskPath);
  await fs.link(external, taskPath);
  await assert.rejects(inspectExecutionState(fixture.requirements), /single-link real file/u);
  assert.deepEqual(await fs.readFile(external), bytes);
});

test("fake operational headings and non-sequential records never classify as pristine", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Validation Attempts", "### attempt-01\n\n- Type: initial\n- Status: <PASS>"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /placeholder/u);
});

test("pristine REVIEW_TASKS replan dead end has draft, review, and atomic materialization preflights", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "MATERIALIZED_PRISTINE");
  await fs.appendFile(fixture.requirements, "- AC-002: clarified planning boundary\n");
  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await stagePristineReplacement(fixture, oldHash, newHash);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-01", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  const reviewed = await inspectExecutionState(fixture.requirements);
  const reviewedReadback = { execution: reviewed, executionRaw: reviewed, product: { deriveNormalHandoff } };
  assert.deepEqual(decideOutcome("REVIEW_PLAN", reviewedReadback, true), { result: "PASS", blocker: null });
  assert.deepEqual(nextHandoff("REVIEW_PLAN", reviewedReadback), { operation: "MATERIALIZE_TASKS", slice: null });
  assert.deepEqual(decideOutcome("REVIEW_PLAN", reviewedReadback, false),
    { result: "BLOCKED", blocker: "SDK_TURN_FAILED" });
  await editTask(fixture, (value) => reviseAuthority(value, oldHash, newHash, 1, 2));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("pending REPLAN requires canonical fields, one revision increment, and valid supersession mappings", async (t) => {
  async function pending({ authorityChange = false } = {}) {
    const fixture = await standaloneWorkspace(t);
    const { authority: oldHash } = await renderArtifacts(fixture);
    if (authorityChange) await fs.appendFile(fixture.requirements, "- AC-002: revised authority\n");
    const newHash = await computeRequirementsAuthority(fixture.requirements);
    await appendRecoveryPlan(fixture, oldHash, newHash);
    return fixture;
  }

  const missingReason = await pending();
  await editPlan(missingReason, (value) => value.replace(/^- Replan reason:.*\n/mu, ""));
  await assert.rejects(inspectExecutionState(missingReason.requirements), /Replan reason/u);

  const placeholderReason = await pending();
  await editPlan(placeholderReason, (value) => value.replace("- Replan reason: requirements or integration authority changed", "- Replan reason: pending"));
  await assert.rejects(inspectExecutionState(placeholderReason.requirements), /Replan reason must be objective/u);

  const nonIncrementing = await pending();
  await editPlan(nonIncrementing, (value) => value.replace("Plan revision: 2", "Plan revision: 1"));
  await editSlicePlan(nonIncrementing, "slice-02", (value) => value.replace("Plan revision: 2", "Plan revision: 1"));
  await assert.rejects(preflightExecutionOperation(nonIncrementing.requirements, "MATERIALIZE_TASKS"), /increment Plan revision by exactly one/u);

  const invalidTarget = await pending();
  await editPlan(invalidTarget, (value) => value.replace("slice-01 -> slice-02", "slice-01 -> slice-03"));
  await assert.rejects(inspectExecutionState(invalidTarget.requirements), /target slice-03 is not a newly appended later slice/u);

  const missingStaleMapping = await pending({ authorityChange: true });
  await editPlan(missingStaleMapping, (value) => value.replace("- Supersedes open slices: slice-01 -> slice-02", "- Supersedes open slices: none"));
  await assert.rejects(inspectExecutionState(missingStaleMapping.requirements), /does not supersede every prior-revision open slice/u);

  const missingSameAuthorityMapping = await pending();
  await editPlan(missingSameAuthorityMapping, (value) => value.replace("- Supersedes open slices: slice-01 -> slice-02", "- Supersedes open slices: none"));
  await assert.rejects(preflightExecutionOperation(missingSameAuthorityMapping.requirements, "MATERIALIZE_TASKS"), /does not supersede every prior-revision open slice/u);

  const fakeCommitted = await standaloneWorkspace(t);
  await renderArtifacts(fakeCommitted);
  await editPlan(fakeCommitted, (value) => value.replace("- Objective: Deliver observable behavior", "- Revision mode: append-only-extension\n- Replan reason: fake metadata\n- Supersedes open slices: none\n- Objective: Deliver observable behavior"));
  await assert.rejects(inspectExecutionState(fakeCommitted.requirements), /lacks historical and current-revision tasks/u);

  const invalidInitial = await standaloneWorkspace(t);
  await renderArtifacts(invalidInitial, { materialized: false });
  await editPlan(invalidInitial, (value) => value.replace("Plan revision: 1", "Plan revision: 4"));
  await assert.rejects(inspectExecutionState(invalidInitial.requirements), /planning-only authority must use Plan revision 1/u);

  const mixedReplacement = await standaloneWorkspace(t);
  const { authority: mixedAuthority } = await renderArtifacts(mixedReplacement);
  await addSecondPristineSlice(mixedReplacement);
  await stagePristineReplacement(mixedReplacement, mixedAuthority, mixedAuthority, { ready: true });
  await editSlicePlan(mixedReplacement, "slice-02", (value) => value.replace("status: ready", "status: ready"));
  await assert.rejects(preflightExecutionOperation(mixedReplacement.requirements, "MATERIALIZE_TASKS"), /candidate plans do not all match/u);
});

test("requirements authority detects unchanged and stale planning at every requested boundary A-E", async (t) => {
  const variants = ["before-materialization", "after-materialization", "partial-execution", "after-pass"];
  for (const variant of variants) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture, { materialized: variant !== "before-materialization" });
    const before = await inspectExecutionState(fixture.requirements);
    assert.equal(before.stale, false, `${variant}: unchanged authority was stale`);
    if (variant === "partial-execution") {
      await editTask(fixture, (value) => replaceSection(value, "Changed Areas", "- `../../src/example.txt`"));
    } else if (variant === "after-pass") {
      await editTask(fixture, (value) => {
        let result = value.replace("- [ ] 1.1", "- [x] 1.1");
        result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
        result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
        result = replaceSection(result, "Effective Validation Base", PASS_BASE);
        return publishPassResult(result);
      });
      await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
      await writeValidatedPath(fixture);
      assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
    }
    await fs.appendFile(fixture.requirements, "- AC-002: changed authority\n");
    const stale = await inspectExecutionState(fixture.requirements);
    assert.equal(stale.state, "REQUIREMENTS_CHANGED", `${variant}: stale authority continued silently`);
    await assert.rejects(preflightExecutionOperation(fixture.requirements, variant === "before-materialization" ? "MATERIALIZE_TASKS" : "EXECUTE_SLICE", variant === "before-materialization" ? null : "1"), /not legal/u);
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

test("finding resolution is historical while only active blocking findings block", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_NEEDS_FIX");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1")).state, "VALIDATION_NEEDS_FIX");
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed the correction.`);
    result = result.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "PASS", { references: "finding-01", dispositions: "finding-01=resolved" })}`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  await writeValidatedPath(fixture);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
});

test("partial finding correction may revalidate NEEDS_FIX before eventual PASS dispositions", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const secondFinding = ACTIVE_FINDING.replaceAll("finding-01", "finding-02").replace("Origin: attempt-01", "Origin: attempt-02").replace("Observable behavior is wrong.", "Regression behavior is wrong.");
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "NEEDS_FIX", { references: "finding-01, finding-02", dispositions: "finding-01=resolved, finding-02=active" })}`);
    return replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed correction.\n\n${secondFinding}`);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_NEEDS_FIX");
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "NEEDS_FIX", { references: "finding-01, finding-02", dispositions: "finding-01=resolved, finding-02=active" })}\n\n${attemptRecord(3, "PASS", { references: "finding-01, finding-02", dispositions: "finding-01=resolved, finding-02=resolved" })}`);
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed correction.\n\n${secondFinding.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-03 confirmed correction.`);
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 3 }));
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  await writeValidatedPath(fixture);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
});

test("active divergence blocks, resolved divergence remains auditable, and wrong lifecycle fields reject", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "DIVERGENCE_BLOCKED");
  await editTask(fixture, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: resolved")}\n- Resolution: plan revision 2 committed recovery slice-02`));
  await assert.rejects(inspectExecutionState(fixture.requirements), /resolution has no committed supersession owner/u);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE}\n- Resolution: invalid for active state`));
  await assert.rejects(inspectExecutionState(fixture.requirements), /active state cannot contain resolution fields/u);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: DELETE_MANUALLY")));
  await assert.rejects(inspectExecutionState(fixture.requirements), /invalid Required authority operation/u);

  const forged = await standaloneWorkspace(t);
  await renderArtifacts(forged);
  const successor = ACTIVE_DIVERGENCE.replaceAll("divergence-01", "divergence-02").replace("- State: active", "- State: resolved")
    + "\n- Resolution: plan revision 2 committed recovery slice-02";
  await editTask(forged, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: superseded")}\n- Superseded by: divergence-02\n\n${successor}`));
  await assert.rejects(inspectExecutionState(forged.requirements), /no committed (?:supersession|recovery) owner/u);

  const committed = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(committed);
  await appendRecoveryPlan(committed, authority, authority, { ready: true });
  await commitAppendRecovery(committed, authority, authority);
  await editTask(committed, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: superseded")}\n- Superseded by: divergence-02\n\n${successor}`));
  assert.equal((await inspectExecutionState(committed.requirements)).state, "EXECUTION_STARTED");
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

test("third TESTS_FAIL has only formal validation continuation for implementation and findings", async (t) => {
  for (const kind of ["Implementation", "Findings"]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    const prefix = kind === "Implementation" ? "implementation-check" : "findings-check";
    if (kind === "Findings") await editTask(fixture, (value) => replaceSection(value, "Validation Findings", ACTIVE_FINDING));
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
      result = replaceSection(result, `${kind} Test Evidence`, [1, 2, 3].map((round) => checkRecord(prefix, round, "TESTS_FAIL", round, { cycle: "attempt-01" })).join("\n\n"));
      if (kind === "Findings") {
        result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
      }
      return result;
    });
    const state = await inspectExecutionState(fixture.requirements);
    assert.equal(state.state, kind === "Implementation" ? "IMPLEMENTATION_RETRY_EXHAUSTED" : "FINDINGS_RETRY_EXHAUSTED");
    assertRecoveryTarget(state, {
      operation: "VALIDATE_SLICE",
      slice: "slice-01",
      owner: "retry-exhaustion",
      record: `${prefix}-03`,
      round: 3,
      retryState: state.state,
    });
    assert.equal(state.normalHandoff, null);
    assert.deepEqual(state.requiredRecoveryHandoff, {
      workflowSkill: "stnl-slice-quality-manager",
      operation: "VALIDATE_SLICE",
      invocation: "OPERATION=VALIDATE_SLICE",
      slice: "slice-01",
    });
    const handoff = spawnSync(process.execPath, [
      path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs"),
      fixture.requirements,
      "--handoff-after",
      kind === "Implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS",
    ], { encoding: "utf8", cwd: fixture.root });
    assert.equal(handoff.status, 0, handoff.stderr);
    const transition = JSON.parse(handoff.stdout);
    assert.equal(transition.normal_handoff, null);
    assert.deepEqual(transition.required_recovery_handoff, {
      workflowSkill: "stnl-slice-quality-manager",
      operation: "VALIDATE_SLICE",
      invocation: "OPERATION=VALIDATE_SLICE",
      slice: "slice-01",
    });
    await assert.rejects(preflightExecutionOperation(fixture.requirements, kind === "Implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS", "1"), /not legal/u);
    if (kind === "Implementation") {
      const invalidSlice = await rejectedWithRecovery(
        preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "01"),
        /SLICE must be one unsigned decimal number without prefix; legal next operation is VALIDATE_SLICE for slice-01/u,
      );
      assertRecoveryTarget(invalidSlice, { operation: "VALIDATE_SLICE", slice: "slice-01" });
    }
    assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, state.state);

    const blocked = await standaloneWorkspace(t);
    await renderArtifacts(blocked);
    await editTask(blocked, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, `${kind} Test Evidence`, [1, 2, 3].map((round) => checkRecord(prefix, round, "TESTS_FAIL", round, { cycle: "attempt-01" })).join("\n\n"));
      if (kind === "Findings") {
        result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
        result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
      }
      return replaceSection(result, "Delegation Blocker", delegationBlocker(kind === "Implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS", "initialization", { after: `${prefix}-03` }));
    });
    await assert.rejects(inspectExecutionState(blocked.requirements), /cannot resume .* after third-failure exhaustion/u);

    const diverged = await standaloneWorkspace(t);
    await renderArtifacts(diverged);
    await editTask(diverged, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, `${kind} Test Evidence`, [1, 2, 3].map((round) => checkRecord(prefix, round, "TESTS_FAIL", round, { cycle: "attempt-01" })).join("\n\n"));
      result = replaceSection(result, "Divergences", ACTIVE_DIVERGENCE);
      if (kind === "Findings") {
        result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
        result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
      }
      return result;
    });
    await assert.rejects(inspectExecutionState(diverged.requirements), /cannot combine third-failure exhaustion/u);
  }
});

test("automatic check rounds reject skipped, duplicate, non-initial, and post-terminal records", async (t) => {
  const invalidSequences = [
    [checkRecord("implementation-check", 1, "TESTS_PASS", 2), /start its automatic check cycle at round 1\/3/u],
    [checkRecord("implementation-check", 1, "TESTS_FAIL", 1), /unterminated implementation automatic correction cycle/u],
    [`${checkRecord("implementation-check", 1, "TESTS_FAIL", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 3)}`, /round 2\/3/u],
    [`${checkRecord("implementation-check", 1, "TESTS_FAIL", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 1)}`, /round 2\/3/u],
    [`${checkRecord("implementation-check", 1, "TESTS_PASS", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 1)}`, /after terminal automatic-check record/u],
    [`${checkRecord("implementation-check", 1, "TESTS_FAIL", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 2).replace("- Correction applied: bounded objective correction\n", "")}`, /Correction applied/u],
  ];
  for (const [sequence, expected] of invalidSequences) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", sequence));
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }
});

test("EXECUTE_SLICE preflight permits the next automatic round only after an in-scope correction is persisted", async (t) => {
  const uncorrected = await standaloneWorkspace(t);
  await renderArtifacts(uncorrected);
  await editTask(uncorrected, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
  });
  await assert.rejects(
    preflightExecutionOperation(uncorrected.requirements, "EXECUTE_SLICE", "1"),
    /unterminated implementation automatic correction cycle/u,
  );

  const corrected = await standaloneWorkspace(t);
  await renderArtifacts(corrected);
  await editTask(corrected, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
  });
  const preflight = await preflightExecutionOperation(corrected.requirements, "EXECUTE_SLICE", "1");
  assert.equal(preflight.state, "EXECUTION_STARTED");
  assert.deepEqual(preflight.legalOperations, [{ operation: "REPLAN", slice: null }, { operation: "EXECUTE_SLICE", slice: "slice-01" }]);
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

test("file-backed Tested state rejects a truncated SHA-256 digest", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    const malformed = checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace(`sha256:${VALIDATED_HASH}`, `sha256:${VALIDATED_HASH.slice(1)}`);
    return replaceSection(result, "Implementation Test Evidence", malformed);
  });
  await assert.rejects(
    inspectExecutionState(fixture.requirements),
    /implementation-check-01 has (?:malformed Tested state|unexpected nested or continuation content under Tested state)/u,
  );
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

test("APPLY_FINDINGS recovery remains bound to persisted slice-02 and exposes auxiliary round ownership", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await passFirstSlice(fixture);
  const second = path.join(fixture.execution, "tasks/slice-02.md");
  let task = await fs.readFile(second, "utf8");
  task = task.replace("- [ ] 2.1", "- [x] 2.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Validation Attempts", NEEDS_FIX_ATTEMPT);
  task = replaceSection(task, "Validation Findings", ACTIVE_FINDING);
  task = replaceSection(task, "Delegation Blocker", delegationBlocker("APPLY_FINDINGS", "initialization"));
  await fs.writeFile(second, task, "utf8");

  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "RUNNER_INITIALIZATION_BLOCKED");
  assertRecoveryTarget(blocked, {
    operation: "APPLY_FINDINGS",
    slice: "slice-02",
    owner: "delegation-blocker",
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "2")).state, "RUNNER_INITIALIZATION_BLOCKED");
  await rejectedWithRecovery(
    preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "2"),
    /legal next operation is APPLY_FINDINGS for slice-02/u,
  );

  task = await fs.readFile(second, "utf8");
  task = replaceSection(task, "Delegation Blocker", "- none");
  task = replaceSection(task, "Corrections Applied", "- `../../src/example.txt`");
  task = replaceSection(task, "Findings Test Evidence", checkRecord("findings-check", 1, "BLOCKED", 1, { cycle: "attempt-01" }));
  await fs.writeFile(second, task, "utf8");
  const auxiliary = await inspectExecutionState(fixture.requirements);
  assert.equal(auxiliary.state, "AUXILIARY_BLOCKED");
  assertRecoveryTarget(auxiliary, {
    operation: "APPLY_FINDINGS",
    slice: "slice-02",
    owner: "auxiliary-check",
    record: "findings-check-01",
    round: 1,
    sameOperationResumeRequired: true,
  });
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

test("auxiliary BLOCKED resumes only its originating operation and later records clear it", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "BLOCKED", 1));
  });
  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "AUXILIARY_BLOCKED");
  assertRecoveryTarget(blocked, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "auxiliary-check",
    record: "implementation-check-01",
    round: 1,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1")).state, "AUXILIARY_BLOCKED");
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1"), /legal next operation is EXECUTE_SLICE for slice-01/u);
  await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", `${checkRecord("implementation-check", 1, "BLOCKED", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 1)}`));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
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
  const candidate = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
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
      await assert.rejects(publishTaskMaterializationCandidate({ specPath: fixture.requirements, candidateExecutionRoot: badRoot }));
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
  await assert.rejects(publishTaskMaterializationCandidate({ specPath: fixture.requirements,
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
  const published = await publishTaskMaterializationCandidate({ specPath: fixture.requirements,
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
    "skills/workflows/stnl-task-materializer/runtime/validate-execution-state.mjs"), fixture.requirements,
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

test("approved supersession preserves advisory divergence while disposing only the active blocking record", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture);
  const advisory = ACTIVE_DIVERGENCE.replace("divergence-01", "divergence-02").replace("Severity: blocking", "Severity: advisory");
  await editTask(fixture, (text) => replaceSection(replaceSection(text, "Changed Areas", "- `../../src/example.txt`"),
    "Divergences", `${ACTIVE_DIVERGENCE}\n\n${advisory}`));
  await appendRecoveryPlan(fixture, authority, authority, { ready: true });
  const candidate = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  t.after(async () => fs.rm(candidate.candidateExecutionRoot, { recursive: true, force: true }));
  const staged = { ...fixture, execution: candidate.candidateExecutionRoot };
  await commitAppendRecovery(staged, authority, authority);
  await editTask(staged, (text) => replaceSection(text, "Divergences",
    `${ACTIVE_DIVERGENCE.replace("State: active", "State: superseded")}\n- Superseded by: divergence-02\n\n${advisory}`));
  const published = await publishTaskMaterializationCandidate({ specPath: fixture.requirements,
    candidateExecutionRoot: candidate.candidateExecutionRoot });
  assert.equal(published.status, "PASS");
  const result = await inspectExecutionState(fixture.requirements);
  assert.equal(result.state, "EXECUTION_STARTED");
  assert.equal(result.tasks.get("slice-01").divergences[0].state, "superseded");
  assert.equal(result.tasks.get("slice-01").divergences[1].state, "active");
  assert.equal(result.tasks.get("slice-01").divergences[1].body, advisory.slice(advisory.indexOf("- Severity:")));
});

test("a later missing integration slice has an executable append-only REPLAN path", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "COMPLETE");
  await appendRecoveryPlan(fixture, authority, authority, { supersedes: "none" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await writeValidatedPath(fixture);
  await editPlan(fixture, (text) => setPlanReviewState(text, true));
  await editSlicePlan(fixture, "slice-02", (text) => setPlanReviewState(text, true));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  const candidate = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  t.after(async () => fs.rm(candidate.candidateExecutionRoot, { recursive: true, force: true }));
  const taskPath = path.join(candidate.candidateExecutionRoot, "tasks/slice-01.md");
  const passedTask = await fs.readFile(taskPath, "utf8");
  await fs.writeFile(taskPath, replaceSection(passedTask, "Final Result", "- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 2"));
  const liveBefore = await treeBytes(fixture.execution);
  const candidateBefore = await treeBytes(candidate.candidateExecutionRoot);
  await assert.rejects(publishTaskMaterializationCandidate({ specPath: fixture.requirements,
    candidateExecutionRoot: candidate.candidateExecutionRoot }), /historical task changed during materialization/u);
  assert.deepEqual(await treeBytes(fixture.execution), liveBefore);
  assert.deepEqual(await treeBytes(candidate.candidateExecutionRoot), candidateBefore);
});

test("superseded historical paths become terminal only through a later current-authority PASS", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Changed Areas", "- `../../src/example.txt`"));
  await fs.appendFile(fixture.requirements, "- AC-002: corrective integration\n");
  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await appendRecoveryPlan(fixture, oldHash, newHash, { ready: true });
  await commitAppendRecovery(fixture, oldHash, newHash);
  const second = path.join(fixture.execution, "tasks/slice-02.md");
  let task = await fs.readFile(second, "utf8");
  task = task.replace("- [ ] 1.1", "- [x] 1.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Validation Attempts", PASS_ATTEMPT);
  task = replaceSection(task, "Effective Validation Base", PASS_BASE);
  task = publishPassResult(task);
  await fs.writeFile(second, task);
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |", "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | PASS | PASS |"));
  await writeValidatedPath(fixture);
  const complete = await inspectExecutionState(fixture.requirements);
  assert.deepEqual(complete.legalOperations, [{ operation: "REPLAN", slice: null }]);
  assert.equal(complete.normalHandoff, null);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "COMPLETE", "terminal recovery must permit a corrective replan from COMPLETE");
});

test("repeated append-only REPLAN preserves older supersession revisions and commits exact current mappings", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Changed Areas", "- `../../src/example.txt`"));
  await appendRecoveryPlan(fixture, authority, authority, { ready: true });
  await commitAppendRecovery(fixture, authority, authority);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "EXECUTION_STARTED");

  await stageThirdRecovery(fixture, authority);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-03", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  const olderHistory = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"));
  const candidate = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  t.after(async () => fs.rm(candidate.candidateExecutionRoot, { recursive: true, force: true }));
  await commitThirdRecovery({ ...fixture, execution: candidate.candidateExecutionRoot }, authority);
  assert.equal((await publishTaskMaterializationCandidate({ specPath: fixture.requirements,
    candidateExecutionRoot: candidate.candidateExecutionRoot })).status, "PASS");
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")), olderHistory);
  const committed = await inspectExecutionState(fixture.requirements);
  assert.equal(committed.state, "EXECUTION_STARTED");
  assert.equal(committed.tasks.get("slice-01").final.planRevision, 2);
  assert.equal(committed.tasks.get("slice-02").final.planRevision, 3);
  assert.equal(deriveNormalHandoff(committed, "MATERIALIZE_TASKS").slice, "slice-03");

  const omittedMapping = await standaloneWorkspace(t);
  const { authority: omittedAuthority } = await renderArtifacts(omittedMapping);
  await appendRecoveryPlan(omittedMapping, omittedAuthority, omittedAuthority, { ready: true });
  await commitAppendRecovery(omittedMapping, omittedAuthority, omittedAuthority);
  await editPlan(omittedMapping, (value) => value.replace("- Supersedes open slices: slice-01 -> slice-02", "- Supersedes open slices: none"));
  await assert.rejects(inspectExecutionState(omittedMapping.requirements), /committed supersessions do not exactly match/u);
});

test("attempt/check numbering, unresolved blockers at PASS, and structural gates reject deterministically", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", checkRecord("implementation-check", 2, "TESTS_PASS", 1)));
  await assert.rejects(inspectExecutionState(fixture.requirements), /contiguous from 01/u);

  const findingFixture = await standaloneWorkspace(t);
  await renderArtifacts(findingFixture);
  await editTask(findingFixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "PASS", { references: "finding-01", dispositions: "finding-01=active" })}`);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await assert.rejects(inspectExecutionState(findingFixture.requirements), /active blocker/u);

  const divergenceFixture = await standaloneWorkspace(t);
  await renderArtifacts(divergenceFixture);
  await editTask(divergenceFixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE));
  assert.equal((await inspectExecutionState(divergenceFixture.requirements)).state, "DIVERGENCE_BLOCKED");

  const incompleteAttempt = await standaloneWorkspace(t);
  await renderArtifacts(incompleteAttempt);
  await editTask(incompleteAttempt, (value) => {
    let result = replaceSection(value, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  await assert.rejects(inspectExecutionState(incompleteAttempt.requirements), /Validation Attempts before the mandatory checklist is complete/u);

  const backward = await standaloneWorkspace(t);
  await renderArtifacts(backward);
  const finding2 = ACTIVE_FINDING.replaceAll("finding-01", "finding-02").replace("- State: active", "- State: superseded") + "\n- Superseded by: finding-01";
  const finding3 = ACTIVE_FINDING.replaceAll("finding-01", "finding-03");
  await editTask(backward, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", `${ACTIVE_FINDING}\n\n${finding2}\n\n${finding3}`);
  });
  await assert.rejects(inspectExecutionState(backward.requirements), /finding-02 has invalid Superseded by/u);

  const pendingPass = await standaloneWorkspace(t);
  await renderArtifacts(pendingPass);
  await editTask(pendingPass, (value) => replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Validation Attempts", PASS_ATTEMPT));
  await assert.rejects(inspectExecutionState(pendingPass.requirements), /latest PASS attempt was not published atomically/u);

  const malformedBases = [
    [PASS_BASE.replace("- Attempt type: initial", "- Attempt type: revalidation"), /Attempt type disagrees/u],
    [PASS_BASE.replace("- HEAD: fixture", "- HEAD: unrelated"), /HEAD disagrees/u],
    [PASS_BASE.replace("  - `..\/..\/src\/example.txt` | sha256:", "  - malformed | sha256:"), /malformed Files manifest/u],
    [PASS_BASE.replace("- Evidence summary: Objective PASS evidence.", "- Evidence summary: pending"), /Evidence summary/u],
  ];
  for (const [invalidBase, expected] of malformedBases) {
    const malformed = await standaloneWorkspace(t);
    await renderArtifacts(malformed);
    await editTask(malformed, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
      result = replaceSection(result, "Effective Validation Base", invalidBase);
      return publishPassResult(result);
    });
    await assert.rejects(inspectExecutionState(malformed.requirements), expected);
  }

  const malformedClaims = [
    ["- `../../src/example.txt`\n  - `../../src/hidden.txt`", /canonical task-relative path claims/u],
    ["- `../../src/example.txt`\n- arbitrary prose", /canonical task-relative path claims/u],
    ["- `../../src/z.txt`\n- `../../src/a.txt`", /not lexicographically ordered/u],
    ["- `../../src/example.txt`\n- `../../src/example.txt`", /duplicate path claims/u],
  ];
  for (const [claims, expected] of malformedClaims) {
    const malformed = await standaloneWorkspace(t);
    await renderArtifacts(malformed);
    await editTask(malformed, (value) => replaceSection(value, "Changed Areas", claims));
    await assert.rejects(inspectExecutionState(malformed.requirements), expected);
  }

  const unlistedCorrection = await standaloneWorkspace(t);
  await renderArtifacts(unlistedCorrection);
  await editTask(unlistedCorrection, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Corrections Applied", "- `../../src/other.txt`");
  });
  await assert.rejects(inspectExecutionState(unlistedCorrection.requirements), /correction path is absent from Changed Areas/u);
});

test("Effective Validation Base commands and evidence are exact provenance of the owning PASS attempt", async (t) => {
  for (const [mutation, expected] of [
    [(base) => base.replace("`node --test`", "`node --test --test-name-pattern provenance`"), /authoritative commands disagree with its origin attempt/u],
    [(base) => base.replace("Objective PASS evidence.", "Different claimed PASS evidence."), /Evidence summary disagrees with its origin attempt/u],
    [(base) => `${base}\n- Authoritative commands:\n  - \`conflicting command\` | exit:0`, /exactly one Authoritative commands|unexpected content after Evidence summary/u],
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
      result = replaceSection(result, "Effective Validation Base", mutation(PASS_BASE));
      result = replaceSection(result, "Diff Summary", "- Implemented and validated the observable behavior.");
      return replaceSection(result, "Final Result", "- PASS");
    });
    await editTasksIndex(fixture, (value) => value.replace(
      "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
      "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
    ));
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }
});

test("fileless PASS uses an explicit none manifest with objective reason and evidence", async (t) => {
  const filelessAttempt = attemptRecord(1, "PASS", { evidence: "validated observable behavior" });
  const filelessCheck = checkRecord("implementation-check", 1, "TESTS_PASS", 1)
    .replace(`- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`, "- Tested state: none\n- Fileless reason: no repository file participates in the observable configuration state");
  const filelessBase = `- Origin attempt: attempt-01
- Attempt type: initial
- HEAD: fixture
- Result: PASS
- Files: none
- Fileless reason: the slice changes no repository file and validates an externally observable configuration state
- Authoritative commands:
  - \`node --test\` | exit:0
- Evidence summary: validated observable behavior`;

  const valid = await standaloneWorkspace(t);
  await renderArtifacts(valid);
  await editTask(valid, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- none");
    return replaceSection(result, "Implementation Test Evidence", filelessCheck);
  });
  assert.equal((await inspectExecutionState(valid.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal((await preflightExecutionOperation(valid.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await editTask(valid, (value) => {
    let result = value;
    result = replaceSection(result, "Validation Attempts", filelessAttempt);
    result = replaceSection(result, "Effective Validation Base", filelessBase);
    return publishPassResult(result);
  });
  await editTasksIndex(valid, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  assert.equal((await inspectExecutionState(valid.requirements)).state, "COMPLETE");

  for (const [name, baseMutation, error, attemptMutation = (attempt) => attempt] of [
    ["missing reason", (base) => base.replace(/^- Fileless reason:.*\n/mu, ""), /Fileless reason/u],
    ["placeholder reason", (base) => base.replace(/^- Fileless reason:.*$/mu, "- Fileless reason: pending"), /Fileless reason/u],
    ["whitespace reason", (base) => base.replace(/^- Fileless reason:.*$/mu, "- Fileless reason:   "), /Fileless reason/u],
    ["placeholder evidence", (base) => base.replace("- Evidence summary: validated observable behavior", "- Evidence summary: pending"), /Evidence summary/u],
    [
      "whitespace attempt and base evidence",
      (base) => base.replace("- Evidence summary: validated observable behavior", "- Evidence summary:   "),
      /Evidence|Evidence summary/u,
      (attempt) => attempt.replace("- Evidence: validated observable behavior", "- Evidence:   "),
    ],
  ]) {
    const invalid = await standaloneWorkspace(t);
    await renderArtifacts(invalid);
    await editTask(invalid, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- none");
      result = replaceSection(result, "Implementation Test Evidence", filelessCheck);
      result = replaceSection(result, "Validation Attempts", attemptMutation(filelessAttempt));
      result = replaceSection(result, "Effective Validation Base", baseMutation(filelessBase));
      return publishPassResult(result);
    });
    await editTasksIndex(invalid, (value) => value.replace(
      "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
      "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
    ));
    await assert.rejects(inspectExecutionState(invalid.requirements), error, name);
  }
});

test("fileless APPLY_FINDINGS needs objective evidence but no fabricated path", async (t) => {
  const fileless = (record) => record.replace(
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    "- Tested state: none\n- Fileless reason: the correction changes observable authority without filesystem ownership",
  ).replace("- Corrections covered: ../../src/example.txt", "- Corrections covered: objective authority-only correction");

  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- none");
    result = replaceSection(result, "Corrections Applied", "- none");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    return replaceSection(result, "Findings Test Evidence", fileless(
      checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" }),
    ));
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "FINDINGS_CORRECTED");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "FINDINGS_CORRECTED");

  const retried = await standaloneWorkspace(t);
  await renderArtifacts(retried);
  await editTask(retried, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- none");
    result = replaceSection(result, "Corrections Applied", "- none");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    const first = fileless(checkRecord("findings-check", 1, "TESTS_FAIL", 1, { cycle: "attempt-01" }));
    const second = fileless(checkRecord("findings-check", 2, "TESTS_PASS", 2, { cycle: "attempt-01" }))
      .replace("- Correction paths: ../../src/example.txt", "- Correction paths: none")
      .replace("- Correction applied: bounded objective correction", "- Correction applied: corrected authority-only behavior with no filesystem ownership");
    return replaceSection(result, "Findings Test Evidence", `${first}\n\n${second}`);
  });
  assert.equal((await inspectExecutionState(retried.requirements)).state, "FINDINGS_CORRECTED");
});

test("only the current state-driving auxiliary check controls fileless Changed Areas", async (t) => {
  const fileless = (record) => record.replace(
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    "- Tested state: none\n- Fileless reason: no repository file participates in current tested state",
  );

  const contradiction = await standaloneWorkspace(t);
  await renderArtifacts(contradiction);
  await editTask(contradiction, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", fileless(
      checkRecord("implementation-check", 1, "TESTS_PASS", 1),
    ));
  });
  await assert.rejects(inspectExecutionState(contradiction.requirements), /current fileless.*Changed Areas: none/u);

  const mixedHistory = await standaloneWorkspace(t);
  await renderArtifacts(mixedHistory);
  await editTask(mixedHistory, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    const historical = fileless(checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
    const current = checkRecord("implementation-check", 2, "TESTS_PASS", 2);
    return replaceSection(result, "Implementation Test Evidence", `${historical}\n\n${current}`);
  });
  assert.equal((await inspectExecutionState(mixedHistory.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("Final Result accepts one exact terminal authority and rejects masked conflicts", async (t) => {
  for (const invalid of [
    "- PASS\n- pending",
    "- PASS\n- PASS",
    "- pending\n- PASS",
    "- PASS\n- SUPERSEDED",
    "- PASS\n- terminal: PASS",
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
      result = replaceSection(result, "Effective Validation Base", PASS_BASE);
      result = replaceSection(result, "Diff Summary", "- Implemented and validated the observable behavior.");
      return replaceSection(result, "Final Result", invalid);
    });
    await editTasksIndex(fixture, (value) => value.replace(
      "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
      "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
    ));
    await assert.rejects(inspectExecutionState(fixture.requirements), /Final Result is malformed/u);
  }
});

test("canonical execution tables and checklists reject every unexpected structural row", async (t) => {
  const malformedPlan = await standaloneWorkspace(t);
  await renderArtifacts(malformedPlan);
  await editPlan(malformedPlan, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |\n| malformed serial row |",
  ));
  await assert.rejects(inspectExecutionState(malformedPlan.requirements), /Serial Slice Order.*malformed row/u);

  const malformedTasks = await standaloneWorkspace(t);
  await renderArtifacts(malformedTasks);
  await editTasksIndex(malformedTasks, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |\n| unexpected task row |",
  ));
  await assert.rejects(inspectExecutionState(malformedTasks.requirements), /tasks\.md has malformed row/u);

  const nonPipePlan = await standaloneWorkspace(t);
  await renderArtifacts(nonPipePlan);
  await editPlan(nonPipePlan, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |\nmalformed serial row without pipes",
  ));
  await assert.rejects(inspectExecutionState(nonPipePlan.requirements), /Serial Slice Order.*unexpected structural row/u);

  const nonPipeTasks = await standaloneWorkspace(t);
  await renderArtifacts(nonPipeTasks);
  await editTasksIndex(nonPipeTasks, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |\nmalformed task row without pipes",
  ));
  assert.equal((await inspectExecutionState(nonPipeTasks.requirements)).state, "MATERIALIZED_PRISTINE");

  const malformedChecklist = await standaloneWorkspace(t);
  await renderArtifacts(malformedChecklist);
  await editTask(malformedChecklist, (value) => value.replace(
    "- [ ] 1.1 Implement behavior | observable result: observable result | expected areas: `../../src/example.txt`; example implementation | requirement: AC-001",
    "- [ ] 1.1 Implement behavior | observable result: observable result | expected areas: `../../src/example.txt`; example implementation | requirement: AC-001\n- [ ] malformed checklist row",
  ));
  await assert.rejects(inspectExecutionState(malformedChecklist.requirements), /malformed Checklist row/u);
});

test("scalar summaries stay inline while Tested state and Commands stay structurally scoped", async (t) => {
  const valid = await standaloneWorkspace(t);
  await renderArtifacts(valid);
  await editTask(valid, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await inspectExecutionState(valid.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const mutations = [
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope:   "), /Tested scope/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n- Tested scope:"), /exactly one 'Tested scope' field/u],
    [(record) => `${record}\n- Fileless reason:`, /Fileless reason/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n  additional scope"), /unexpected nested or continuation/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n    - nested scalar value"), /unexpected nested/u],
    [(record) => record.replace("- Selected checks: node --test", "- Selected checks: node --test\n\t- nested scalar value"), /unexpected nested/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n  * second value"), /unexpected nested/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n  + second value"), /unexpected nested/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n  1. second value"), /unexpected nested/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope:\n  - ../../src/example.txt"), /Tested scope|unexpected nested/u],
    [(record) => record.replace(
      `  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
      `  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    ), /duplicate Tested state paths/u],
    [(record) => record.replace(
      `  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
      `  - \`../../src/z.txt\` | sha256:${VALIDATED_HASH}\n  - \`../../src/a.txt\` | sha256:${VALIDATED_HASH}`,
    ), /Tested state paths are not lexicographically ordered/u],
    [(record) => record.replace("`../../src/example.txt`", "`../../../outside.txt`"), /unsafe Tested state path/u],
    [(record) => record
      .replace("- Commands:\n  - `node --test` | exit:0", "- Commands:")
      .replace("- Selected checks: node --test", "- Selected checks: focused check\n  - `node --test` | exit:0"), /Commands|unexpected nested/u],
  ];
  for (const [mutate, expected] of mutations) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      return replaceSection(result, "Implementation Test Evidence", mutate(checkRecord("implementation-check", 1, "TESTS_PASS", 1)));
    });
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }

  const whitespaceReason = await standaloneWorkspace(t);
  await renderArtifacts(whitespaceReason);
  await editTask(whitespaceReason, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- none");
    const fileless = checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace(`- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`, "- Tested state: none\n- Fileless reason:   ");
    return replaceSection(result, "Implementation Test Evidence", fileless);
  });
  await assert.rejects(inspectExecutionState(whitespaceReason.requirements), /Fileless reason/u);

  const attemptNested = await standaloneWorkspace(t);
  await renderArtifacts(attemptNested);
  await editTask(attemptNested, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT.replace(
      "- Verified scope: ../../src/example.txt",
      "- Verified scope: ../../src/example.txt\n  additional scope\n  - `hidden command` | exit:0",
    ));
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  await assert.rejects(inspectExecutionState(attemptNested.requirements), /unexpected nested/u);
});

test("Finding IDs are canonical ordered sets tied to declared findings and their cycle", async (t) => {
  const prepare = async (value) => {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (task) => {
      let result = task.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
      result = replaceSection(result, "Validation Attempts", attemptRecord(1, "NEEDS_FIX", {
        references: "finding-01, finding-02",
        dispositions: "finding-01=active, finding-02=active",
      }));
      result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING}\n\n${ACTIVE_FINDING_02}`);
      const check = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" })
        .replace("- Finding IDs: finding-01", `- Finding IDs: ${value}`)
        .replace("- Findings verified: finding-01", `- Findings verified: ${value}`);
      return replaceSection(result, "Findings Test Evidence", check);
    });
    return fixture;
  };

  const valid = await prepare("finding-01, finding-02");
  assert.equal((await inspectExecutionState(valid.requirements)).state, "FINDINGS_CORRECTED");
  for (const [value, expected] of [
    ["finding-01, finding-01", /duplicate Finding IDs/u],
    ["finding-02, finding-01", /Finding IDs are not lexicographically ordered/u],
    ["finding-01, finding-99", /undeclared Finding ID finding-99/u],
    ["finding-01,finding-02", /malformed Finding IDs/u],
  ]) {
    const fixture = await prepare(value);
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }
});

test("Findings verified may be a canonical subset while unsupported reconciles active authority", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    const partial = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" })
      .replace("- Findings verified: finding-01", "- Findings verified: none")
      .replace("- Unsupported active findings: none", "- Unsupported active findings: finding-01");
    return replaceSection(result, "Findings Test Evidence", partial);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "FINDINGS_CORRECTED");

  const invalid = await standaloneWorkspace(t);
  await renderArtifacts(invalid);
  await editTask(invalid, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", attemptRecord(1, "NEEDS_FIX", {
      references: "finding-01, finding-02",
      dispositions: "finding-01=active, finding-02=active",
    }));
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING}\n\n${ACTIVE_FINDING_02}`);
    const check = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" })
      .replace("- Findings verified: finding-01", "- Findings verified: finding-02")
      .replace("- Unsupported active findings: none", "- Unsupported active findings: finding-01");
    return replaceSection(result, "Findings Test Evidence", check);
  });
  await assert.rejects(inspectExecutionState(invalid.requirements), /Findings verified.*subset/u);
});

test("TESTS_PASS rejects none only in the four objective summary fields", async (t) => {
  for (const fieldName of ["Tested scope", "Verification types considered", "Selected checks", "Coverage"]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      const check = checkRecord("implementation-check", 1, "TESTS_PASS", 1)
        .replace(new RegExp(`^- ${fieldName}:.*$`, "mu"), `- ${fieldName}: none`);
      return replaceSection(result, "Implementation Test Evidence", check);
    });
    await assert.rejects(inspectExecutionState(fixture.requirements), new RegExp(fieldName, "u"));
  }

  const canonical = await standaloneWorkspace(t);
  await renderArtifacts(canonical);
  await editTask(canonical, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await inspectExecutionState(canonical.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("a finding is active at origin and terminalizes only under later authority", async (t) => {
  const resolvedAtOrigin = await standaloneWorkspace(t);
  await renderArtifacts(resolvedAtOrigin);
  await editTask(resolvedAtOrigin, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${attemptRecord(1, "NEEDS_FIX", {
      references: "finding-01", dispositions: "finding-01=resolved",
    })}\n\n${attemptRecord(2, "PASS", {
      references: "finding-01", dispositions: "finding-01=resolved",
    })}`);
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-01 claimed immediate resolution.`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await editTasksIndex(resolvedAtOrigin, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(resolvedAtOrigin.requirements), /strictly later|later formal attempt/u);

  const supersededAtOrigin = await standaloneWorkspace(t);
  await renderArtifacts(supersededAtOrigin);
  const superseded = `${ACTIVE_FINDING.replace("- State: active", "- State: superseded")}\n- Superseded by: finding-02`;
  await editTask(supersededAtOrigin, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", attemptRecord(1, "NEEDS_FIX", {
      references: "finding-01, finding-02",
      dispositions: "finding-01=superseded, finding-02=active",
    }));
    return replaceSection(result, "Validation Findings", `${superseded}\n\n${ACTIVE_FINDING_02}`);
  });
  await assert.rejects(inspectExecutionState(supersededAtOrigin.requirements), /origin must be strictly later/u);
});

test("the first formal PASS is terminal for its slice", async (t) => {
  const passPass = await standaloneWorkspace(t);
  await renderArtifacts(passPass);
  await editTask(passPass, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${PASS_ATTEMPT}\n\n${attemptRecord(2, "PASS")}`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await editTasksIndex(passPass, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(passPass.requirements), /attempt-01 PASS is terminal/u);

  const passNeedsFix = await standaloneWorkspace(t);
  await renderArtifacts(passNeedsFix);
  const laterFinding = ACTIVE_FINDING.replace("Origin: attempt-01", "Origin: attempt-02");
  await editTask(passNeedsFix, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${PASS_ATTEMPT}\n\n${attemptRecord(2, "NEEDS_FIX", {
      references: "finding-01", dispositions: "finding-01=active",
    })}`);
    return replaceSection(result, "Validation Findings", laterFinding);
  });
  await assert.rejects(inspectExecutionState(passNeedsFix.requirements), /attempt-01 PASS is terminal/u);
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

test("formal BLOCKED and selected-slice gates have only legal recovery transitions", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let checked = value.replace("- [ ] 1.1", "- [x] 1.1");
    checked = replaceSection(checked, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(checked, "Validation Attempts", BLOCKED_ATTEMPT);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_BLOCKED");
  assertRecoveryTarget(await inspectExecutionState(fixture.requirements), {
    operation: "VALIDATE_SLICE", slice: "slice-01", owner: "validation-attempt", record: "attempt-01",
  });
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"), /not legal/u);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "VALIDATION_BLOCKED");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "VALIDATION_BLOCKED");

});

test("non-canonical execution residue blocks preflight while arbitrary external SPEC siblings remain untouched", async (t) => {
  const root = await temporary(t);
  const workspace = await copyDirectory(path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"), path.join(root, "spec"));
  const fixture = { requirements: workspace, execution: path.join(workspace, "execution") };
  await renderArtifacts(fixture);
  const external = path.join(workspace, "user-owned.bin");
  await fs.writeFile(external, Buffer.from([1, 2, 3]));
  assert.equal((await inspectExecutionState(workspace)).state, "MATERIALIZED_PRISTINE");
  const residue = path.join(fixture.execution, "scratch.md");
  await fs.writeFile(residue, "preserve\n");
  await assert.rejects(inspectExecutionState(workspace), (error) => error instanceof ExecutionContractError && error.findings.includes(residue));
  await assert.rejects(preflightExecutionOperation(workspace, "EXECUTE_SLICE", "1"), (error) => error instanceof ExecutionContractError && error.findings.includes(residue));
  await assert.rejects(preflightExecutionOperation(workspace, "VALIDATE_SLICE", "1"), (error) => error instanceof ExecutionContractError && error.findings.includes(residue));
  assert.deepEqual(await fs.readFile(external), Buffer.from([1, 2, 3]));
  assert.equal(await fs.readFile(residue, "utf8"), "preserve\n");

  const escaped = await standaloneWorkspace(t);
  await renderArtifacts(escaped);
  await editTask(escaped, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../../outside.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  await assert.rejects(preflightExecutionOperation(escaped.requirements, "VALIDATE_SLICE", "1"), /unsafe validation-owned path/u);
});

test("Effective Validation Base ownership reproducer covers path basis, hash, drift, and strict readback", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const target = await writeValidatedPath(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveIndex = path.join(fixture.execution, "tasks.md");
  const liveBefore = await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]);

  const terminalCandidate = async (name, { baseRelative = "../../src/example.txt", hash = VALIDATED_HASH } = {}) => {
    const candidate = await copyDirectory(fixture.execution, path.join(fixture.root, name));
    const candidateTask = path.join(candidate, "tasks/slice-01.md");
    let task = await fs.readFile(candidateTask, "utf8");
    task = task.replace("- [ ] 1.1", "- [x] 1.1");
    task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
    task = replaceSection(task, "Validation Attempts", PASS_ATTEMPT);
    task = replaceSection(task, "Effective Validation Base", passBase({ relative: baseRelative, hash }));
    await fs.writeFile(candidateTask, publishPassResult(task), "utf8");
    await fs.writeFile(path.join(candidate, "tasks.md"), (await fs.readFile(path.join(candidate, "tasks.md"), "utf8")).replace(
      "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
      "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
    ), "utf8");
    return candidate;
  };

  const correct = await terminalCandidate("candidate-correct");
  assert.equal((await validateExecutionCandidate(fixture.requirements, correct)).state, "COMPLETE", "R1 correct candidate");
  assert.deepEqual(await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]), liveBefore, "candidate validation published implicitly");

  const wrongBasis = await terminalCandidate("candidate-wrong-basis", { baseRelative: "src/example.txt" });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, wrongBasis), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match|changed\/corrected path with no validation owner/u);
    return true;
  });
  assert.deepEqual(await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]), liveBefore, "wrong-basis candidate published implicitly");

  const wrongHash = await terminalCandidate("candidate-wrong-hash", { hash: "0".repeat(64) });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, wrongHash), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match/u);
    assert.equal(error.findings.some((item) => item.includes("expected sha256:") && item.includes("current sha256:")), true);
    return true;
  });

  await fs.copyFile(path.join(correct, "tasks/slice-01.md"), liveTask);
  await fs.copyFile(path.join(correct, "tasks.md"), liveIndex);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE", "R5 strict readback without drift");

  await fs.writeFile(target, "post-PASS drift\n", "utf8");
  await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match/u);
    assert.equal(error.recoveryTargets.some(({ operation, owner }) => operation === "REPLAN" && owner === "terminal-integrity"), true);
    return true;
  });
});

test("candidate validation permits declared later-slice ownership of a historical overlap", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await passFirstSlice(fixture);

  const currentContent = "later validated behavior\n";
  const currentHash = createHash("sha256").update(currentContent).digest("hex");
  await writeValidatedPath(fixture, "../../src/example.txt", currentContent);

  const candidate = await copyDirectory(fixture.execution, path.join(fixture.root, "historical-overlap-candidate"));
  const candidateTask = path.join(candidate, "tasks/slice-02.md");
  let task = await fs.readFile(candidateTask, "utf8");
  task = task.replace("- [ ] 2.1", "- [x] 2.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(
    task,
    "Prior Validation Overlap",
    "### overlap-01\n\n- Prior slice: slice-01\n- Paths: ../../src/example.txt\n- Affected behavior: Preserve the previously validated CLI behavior.\n- Regressions: Re-run the focused CLI regression against the changed test file.",
  );
  task = replaceSection(
    task,
    "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll(`sha256:${VALIDATED_HASH}`, `sha256:${currentHash}`),
  );
  await fs.writeFile(candidateTask, task, "utf8");

  const liveTask = await fs.readFile(path.join(fixture.execution, "tasks/slice-02.md"));
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-02.md")), liveTask);

  const needsFix = await copyDirectory(candidate, path.join(fixture.root, "historical-overlap-needs-fix"));
  const needsFixTask = path.join(needsFix, "tasks/slice-02.md");
  let needsFixText = await fs.readFile(needsFixTask, "utf8");
  needsFixText = replaceSection(needsFixText, "Validation Attempts", NEEDS_FIX_ATTEMPT);
  needsFixText = replaceSection(needsFixText, "Validation Findings", ACTIVE_FINDING);
  await fs.writeFile(needsFixTask, needsFixText, "utf8");
  assert.equal((await validateExecutionCandidate(fixture.requirements, needsFix)).state, "VALIDATION_NEEDS_FIX");
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-02.md")), liveTask);

  const invalidCurrent = await copyDirectory(candidate, path.join(fixture.root, "historical-overlap-invalid-current"));
  const invalidTaskPath = path.join(invalidCurrent, "tasks/slice-02.md");
  await fs.writeFile(
    invalidTaskPath,
    (await fs.readFile(invalidTaskPath, "utf8")).replaceAll(`sha256:${currentHash}`, `sha256:${"0".repeat(64)}`),
    "utf8",
  );
  await assert.rejects(validateExecutionCandidate(fixture.requirements, invalidCurrent), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /file-backed candidate evidence expected/u);
    assert.equal(error.findings.some((item) => item.includes("slice-02") || item.includes("tasks/slice-02.md")), true);
    return true;
  });
});

test("a new NEEDS_FIX attempt retains the latest findings check as current overlap owner", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await passFirstSlice(fixture);
  const laterPath = "../../src/later.txt";
  const overlapPath = "../../src/example.txt";
  await writeValidatedPath(fixture, laterPath);
  const planPath = path.join(fixture.execution, "plans/slice-02.md");
  await fs.writeFile(planPath, (await fs.readFile(planPath, "utf8")).replaceAll(overlapPath, laterPath));

  const implemented = await copyDirectory(fixture.execution, path.join(fixture.root, "later-implemented"));
  const implementedTask = path.join(implemented, "tasks/slice-02.md");
  let text = (await fs.readFile(implementedTask, "utf8")).replaceAll(overlapPath, laterPath);
  text = text.replace("- [ ] 2.1", "- [x] 2.1");
  text = replaceSection(text, "Changed Areas", `- \`${laterPath}\``);
  text = replaceSection(text, "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll(overlapPath, laterPath));
  await fs.writeFile(implementedTask, text);
  assert.equal((await validateExecutionCandidate(fixture.requirements, implemented)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const firstAttempt = await copyDirectory(implemented, path.join(fixture.root, "later-needs-fix"));
  const firstTask = path.join(firstAttempt, "tasks/slice-02.md");
  text = await fs.readFile(firstTask, "utf8");
  text = replaceSection(text, "Validation Attempts", NEEDS_FIX_ATTEMPT.replaceAll(overlapPath, laterPath));
  text = replaceSection(text, "Validation Findings", ACTIVE_FINDING);
  await fs.writeFile(firstTask, text);
  assert.equal((await validateExecutionCandidate(fixture.requirements, firstAttempt)).state, "VALIDATION_NEEDS_FIX");

  const correctedContent = "later slice owns the prior overlap\n";
  const correctedHash = createHash("sha256").update(correctedContent).digest("hex");
  await writeValidatedPath(fixture, overlapPath, correctedContent);
  const corrected = await copyDirectory(firstAttempt, path.join(fixture.root, "later-corrected"));
  const correctedTask = path.join(corrected, "tasks/slice-02.md");
  text = await fs.readFile(correctedTask, "utf8");
  text = replaceSection(text, "Changed Areas", `- \`${overlapPath}\`\n- \`${laterPath}\``);
  text = replaceSection(text, "Corrections Applied", `- \`${overlapPath}\``);
  text = replaceSection(text, "Prior Validation Overlap",
    `- Slice 01 overlap: \`${overlapPath}\`; preserve previously validated behavior and rerun its focused regression.`);
  const findingsCheck = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" })
    .replace(`- Tested scope: ${overlapPath}`, `- Tested scope: ${overlapPath}, ${laterPath}`)
    .replace(`  - \`${overlapPath}\` | sha256:${VALIDATED_HASH}`,
      `  - \`${overlapPath}\` | sha256:${correctedHash}\n  - \`${laterPath}\` | sha256:${VALIDATED_HASH}`);
  text = replaceSection(text, "Findings Test Evidence", findingsCheck);
  await fs.writeFile(correctedTask, text);
  assert.equal((await validateExecutionCandidate(fixture.requirements, corrected)).state, "FINDINGS_CORRECTED");

  const revalidation = await copyDirectory(corrected, path.join(fixture.root, "later-revalidation"));
  const revalidationTask = path.join(revalidation, "tasks/slice-02.md");
  text = await fs.readFile(revalidationTask, "utf8");
  const secondAttempt = attemptRecord(2, "NEEDS_FIX", {
    references: "finding-01, finding-02", dispositions: "finding-01=resolved, finding-02=active",
  }).replace(`- Verified scope: ${overlapPath}`, `- Verified scope: ${overlapPath}, ${laterPath}`);
  text = replaceSection(text, "Validation Attempts", `${NEEDS_FIX_ATTEMPT.replaceAll(overlapPath, laterPath)}\n\n${secondAttempt}`);
  text = replaceSection(text, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed the correction.\n\n${ACTIVE_FINDING_02.replace("- Origin: attempt-01", "- Origin: attempt-02")}`);
  await fs.writeFile(revalidationTask, text);
  assert.equal((await validateExecutionCandidate(fixture.requirements, revalidation)).state, "VALIDATION_NEEDS_FIX");
  await writeValidatedPath(fixture, overlapPath, "tampered after the findings check\n");
  await assert.rejects(validateExecutionCandidate(fixture.requirements, revalidation),
    /findings-check-01 Tested state.*file-backed candidate evidence expected/u);
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

test("prior validation overlap is required before execution publication and preserves valid multi-slice claims", async (t) => {
  const { fixture, a, b, claim } = await priorOverlapFixture(t);
  const liveTask = path.join(fixture.execution, "tasks/slice-03.md");
  const liveBefore = await fs.readFile(liveTask);
  const relation = (slice, claim) => `- Slice ${slice} overlap: \`${claim}\`; preserve earlier behavior with focused regressions.`;

  const missing = await overlapCandidate(fixture, [a], "- none");
  await assert.rejects(validateExecutionCandidate(fixture.requirements, missing.candidateExecutionRoot),
    (error) => error.message.includes(`slice-01 -> ${a}`));
  await assert.rejects(publishExecutionCopy({ specPath: fixture.requirements, slice: "slice-03", candidateRoot: missing.candidateRoot }),
    /Prior Validation Overlap is missing required prior slice\/path coverage/u);
  assert.deepEqual(await fs.readFile(liveTask), liveBefore, "R7 failed publication must preserve live task bytes");

  const partial = await overlapCandidate(fixture, [a, b], relation("01", a));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, partial.candidateExecutionRoot),
    (error) => error.message.includes(`slice-02 -> ${b}`));

  const complete = await overlapCandidate(fixture, [a, b], `${relation("01", a)}\n${relation("02", b)}`);
  assert.equal((await validateExecutionCandidate(fixture.requirements, complete.candidateExecutionRoot)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const duplicate = await overlapCandidate(fixture, [a], relation("01", a).replace(`\`${a}\``, `\`${a}\`, \`${a}\``));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, duplicate.candidateExecutionRoot), /Prior Validation Overlap contains duplicate path claim/u);

  const disjoint = await overlapCandidate(fixture, [b], "- none");
  await assert.rejects(validateExecutionCandidate(fixture.requirements, disjoint.candidateExecutionRoot),
    (error) => error.message.includes(`slice-02 -> ${b}`));
  await writeValidatedPath(fixture, claim("third.txt"));
  const legitimateNone = await overlapCandidate(fixture, [claim("third.txt")], "- none");
  assert.equal((await validateExecutionCandidate(fixture.requirements, legitimateNone.candidateExecutionRoot)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(await fs.readFile(liveTask), liveBefore);

  const shared = await priorOverlapFixture(t, { samePath: true });
  const sharedCandidate = await overlapCandidate(shared.fixture, [shared.a], `${relation("01", shared.a)}\n${relation("02", shared.a)}`);
  assert.equal((await validateExecutionCandidate(shared.fixture.requirements, sharedCandidate.candidateExecutionRoot)).state,
    "IMPLEMENTED_AWAITING_VALIDATION");
});

test("terminal inspection detects hash drift and REMOVED reappearance without rewriting PASS history", async (t) => {
  const matching = await standaloneWorkspace(t);
  await renderArtifacts(matching);
  await editTask(matching, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return publishPassResult(result);
  });
  await editTasksIndex(matching, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  const target = await writeValidatedPath(matching);
  const complete = await inspectExecutionState(matching.requirements);
  assert.equal(complete.state, "COMPLETE");
  assert.equal(complete.normalHandoff, null);
  assert.deepEqual(complete.legalOperations, [{ operation: "REPLAN", slice: null }]);
  const taskPath = path.join(matching.execution, "tasks/slice-01.md");
  const historyBeforeDrift = await fs.readFile(taskPath);
  await fs.writeFile(target, "drifted behavior\n");
  await assert.rejects(inspectExecutionState(matching.requirements), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match/u);
    assert.equal(error.findings.some((item) => item.includes(target)
      && item.includes("slice-01") && item.includes("expected sha256:") && item.includes("current sha256:")), true);
    assert.deepEqual(error.recoveryTargets.map(({ operation, slice, owner }) => ({ operation, slice, owner })), [
      { operation: "REPLAN", slice: null, owner: "terminal-integrity" },
    ]);
    return true;
  });
  assert.deepEqual(await fs.readFile(taskPath), historyBeforeDrift, "terminal drift inspection rewrote PASS history");
  assert.equal((await preflightExecutionOperation(matching.requirements, "REPLAN")).state, "COMPLETE");

  const removed = await standaloneWorkspace(t);
  await renderArtifacts(removed);
  await editTask(removed, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/removed.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", passBase({ relative: "../../src/removed.txt", removed: true }));
    return publishPassResult(result);
  });
  await editTasksIndex(removed, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  assert.equal((await inspectExecutionState(removed.requirements)).state, "COMPLETE");
  await writeValidatedPath(removed, "../../src/removed.txt");
  await assert.rejects(inspectExecutionState(removed.requirements), (error) => error instanceof ExecutionContractError
    && error.findings.some((item) => item.includes("slice-01") && item.includes("expected REMOVED, current sha256:"))
    && error.recoveryTargets.some((target_) => target_.operation === "REPLAN"));

  const unowned = await standaloneWorkspace(t);
  await renderArtifacts(unowned);
  await editTask(unowned, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`\n- `../../src/unowned.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return publishPassResult(result);
  });
  await assert.rejects(inspectExecutionState(unowned.requirements), /changed\/corrected path with no validation owner/u);
});

test("terminal candidates reject invalid final ownership and preserve live execution bytes", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveIndex = path.join(fixture.execution, "tasks.md");
  const liveBefore = await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]);
  const candidate = await copyDirectory(fixture.execution, path.join(fixture.root, "terminal-candidate"));
  const candidateTask = path.join(candidate, "tasks/slice-01.md");
  let task = await fs.readFile(candidateTask, "utf8");
  task = task.replace("- [ ] 1.1", "- [x] 1.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Validation Attempts", PASS_ATTEMPT);
  task = replaceSection(task, "Effective Validation Base", PASS_BASE);
  await fs.writeFile(candidateTask, publishPassResult(task), "utf8");
  const candidateIndex = path.join(candidate, "tasks.md");
  await fs.writeFile(candidateIndex, (await fs.readFile(candidateIndex, "utf8")).replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ), "utf8");
  await writeValidatedPath(fixture, "../../src/example.txt", "candidate hash mismatch\n");

  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match/u);
    assert.equal(error.findings.some((item) => item.includes("slice-01")
      && item.includes("expected sha256:") && item.includes("current sha256:")), true);
    return true;
  });
  assert.deepEqual(await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]), liveBefore);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("terminal integrity trusts repository-owned paths outside a nested SPEC and rejects repository escape", async (t) => {
  const root = await temporary(t);
  const repository = path.join(root, "repository with space ü");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const workspace = await copyDirectory(
    path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"),
    path.join(repository, "specs", "área segura", "feature Ω"),
  );
  const fixture = { root: repository, requirements: workspace, execution: path.join(workspace, "execution") };
  await renderArtifacts(fixture);
  const taskDirectory = path.join(fixture.execution, "tasks");
  const ownedPath = path.join(repository, "src/example.txt");
  const ownedRelative = path.relative(taskDirectory, ownedPath).split(path.sep).join("/");
  await fs.mkdir(path.dirname(ownedPath), { recursive: true });
  await fs.writeFile(ownedPath, VALIDATED_CONTENT);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", `- \`${ownedRelative}\``);
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", passBase({ relative: ownedRelative }));
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  assert.equal((await inspectExecutionState(workspace)).state, "COMPLETE");
  const candidate = await copyDirectory(fixture.execution, path.join(root, "nested lifecycle candidate"));
  assert.equal((await validateExecutionCandidate(workspace, candidate)).state, "COMPLETE");
  const formerLocalPrefix = `.${path.basename(workspace)}.stnl-execution-candidate-`;
  assert.deepEqual(
    (await fs.readdir(path.dirname(workspace))).filter((name) => name.startsWith(formerLocalPrefix)),
    [],
    "candidate shadow appeared beside the nested lifecycle SPEC",
  );

  const escapedPath = path.join(root, "escaped.txt");
  const escapedRelative = path.relative(taskDirectory, escapedPath).split(path.sep).join("/");
  await fs.writeFile(escapedPath, VALIDATED_CONTENT);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", `- \`${escapedRelative}\``);
    result = replaceSection(result, "Effective Validation Base", passBase({ relative: escapedRelative }));
    return result;
  });
  await assert.rejects(inspectExecutionState(workspace), /unsafe validation-owned path/u);
});

// A pristine live task must stay pristine until evidence is published from its
// isolated candidate. Requiring its Changed Areas here deadlocks first execution.
// This fixture is generated from the versioned templates; no benchmark-temp input.
for (const operation of ["EXECUTE_SLICE", "APPLY_FINDINGS"]) {
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

test("managed prospective scope is canonical without equating it to a prior published attempt", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const target = path.join(fixture.root, "src/example.txt");
  const extra = path.join(fixture.root, "src/next.txt");
  await fs.writeFile(extra, "next attempt\n");
  const claim = path.relative(path.dirname(taskArtifact), target).split(path.sep).join("/");
  const extraClaim = path.relative(path.dirname(taskArtifact), extra).split(path.sep).join("/");
  const options = { workspace: fixture.root, taskArtifact };
  const before = await fs.readFile(taskArtifact, "utf8");
  assert.deepEqual(await validateManagedChangedAreas({ ...options, changedAreas: [extraClaim, claim, claim] }), [claim, extraClaim]);
  await editTask(fixture, (text) => replaceSection(text, "Changed Areas", `- \`${claim}\``));
  const publishedBefore = await fs.readFile(taskArtifact, "utf8");
  assert.deepEqual(await validateManagedChangedAreas({ ...options, changedAreas: [claim, extraClaim] }), [claim, extraClaim]);
  assert.equal(await fs.readFile(taskArtifact, "utf8"), publishedBefore);
  const outside = path.join(await temporary(t, "stnl-outside-scope-"), "outside.txt");
  await fs.writeFile(outside, "must not be selected\n");
  const link = path.join(fixture.root, "src/link.txt");
  await fs.symlink(outside, link);
  const relative = (file) => path.relative(path.dirname(taskArtifact), file).split(path.sep).join("/");
  for (const invalid of [[target], ["src/example.txt"], [relative(outside)], [relative(link)],
    [claim.replace("example.txt", "missing.txt")], [{ path: claim }]]) {
    await assert.rejects(validateManagedChangedAreas({ ...options, changedAreas: invalid }));
  }
  assert.equal(await fs.readFile(taskArtifact, "utf8"), publishedBefore);
  // Deletion of an explicitly planned file is still captured as a canonical removal.
  await fs.rm(target);
  assert.deepEqual(await validateManagedChangedAreas({ ...options, changedAreas: [claim] }), [claim]);
  const captured = await captureRunnerTestedState({ ...options, changedAreas: [claim] });
  assert.deepEqual(captured.entries, [{ path: claim, value: "REMOVED" }]);
  await fs.writeFile(taskArtifact, before);
});

test("managed scope ignores an out-of-workspace alternative to a valid task-relative path", async (t) => {
  const outer = await temporary(t, "stnl-runner-scope-");
  const workspace = path.join(outer, "a/b/c/d");
  const taskArtifact = path.join(workspace, "specs/benchmark-case-c/execution/tasks/slice-03.md");
  const claim = "../../../../README.md";
  await fs.mkdir(path.dirname(taskArtifact), { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "case documentation\n");
  await fs.writeFile(path.join(outer, "README.md"), "unrelated documentation\n");
  await fs.writeFile(taskArtifact, `## Checklist\n\n- [ ] Document CLI | expected areas: \`${claim}\` | requirement: AC-001\n`);

  assert.deepEqual(await validateManagedChangedAreas({ workspace, taskArtifact, changedAreas: [claim] }), [claim]);
  const captured = await captureRunnerTestedState({ workspace, taskArtifact, changedAreas: [claim] });
  const expected = createHash("sha256").update("case documentation\n").digest("hex");
  assert.deepEqual(captured.entries, [{ path: claim, value: `sha256:${expected}` }]);

  await assert.rejects(validateManagedChangedAreas({ workspace, taskArtifact,
    changedAreas: ["../../../../../escape.txt"] }), /outside workspace|escapes workspace|approved target/u);
  await assert.rejects(captureRunnerTestedState({ workspace, taskArtifact,
    changedAreas: ["../../../../../escape.txt"] }), /outside workspace|escapes workspace/u);

  await fs.writeFile(path.join(path.dirname(taskArtifact), "README.md"), "task documentation\n");
  await fs.writeFile(taskArtifact, "## Checklist\n\n- [ ] Document CLI | expected areas: `README.md` | requirement: AC-001\n");
  await assert.rejects(validateManagedChangedAreas({ workspace, taskArtifact,
    changedAreas: ["README.md"] }), /ambiguous/u);
  await assert.rejects(captureRunnerTestedState({ workspace, taskArtifact,
    changedAreas: ["README.md"] }), /ambiguous/u);
});

test("managed scope rejects an intermediate symlink before probing its external target", async (t) => {
  const outer = await temporary(t, "stnl-runner-link-");
  const workspace = path.join(outer, "workspace");
  const external = path.join(outer, "external");
  const taskArtifact = path.join(workspace, "specs/benchmark-case-c/execution/tasks/slice-03.md");
  const claim = "../../../../linked/README.md";
  await fs.mkdir(path.dirname(taskArtifact), { recursive: true });
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "README.md"), "outside\n");
  await fs.symlink(external, path.join(workspace, "linked"));
  await fs.writeFile(taskArtifact, `## Checklist\n\n- [ ] Document CLI | expected areas: \`${claim}\` | requirement: AC-001\n`);

  const forbidden = new Set([path.join(workspace, "linked/README.md"), path.join(external, "README.md")]);
  const originalLstat = fsPromises.lstat.bind(fsPromises);
  const probes = [];
  t.mock.method(fsPromises, "lstat", async (file, ...args) => {
    const resolved = path.resolve(file);
    probes.push(resolved);
    if (forbidden.has(resolved)) throw new Error("external target was probed");
    return originalLstat(file, ...args);
  });
  const rejectsAtLink = (error) => error.message === `validation-owned path traverses a symlink: ${path.join(workspace, "linked")}`;
  await assert.rejects(validateManagedChangedAreas({ workspace, taskArtifact,
    changedAreas: [claim] }), rejectsAtLink);
  await assert.rejects(captureRunnerTestedState({ workspace, taskArtifact,
    changedAreas: [claim] }), rejectsAtLink);
  assert.ok(probes.includes(path.join(workspace, "linked")));
  assert.ok(probes.every((file) => !forbidden.has(file)));
});
