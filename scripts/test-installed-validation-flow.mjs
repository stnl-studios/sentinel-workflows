import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { computeRequirementsAuthority, inspectExecutionState } from "../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs";
import { installSentinel } from "./lib/sentinel-distribution.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

async function temporary(t, prefix) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function replaceAll(text, pairs) {
  return pairs.reduce((value, [before, after]) => value.replaceAll(before, after), text);
}

function replaceSection(text, heading, content) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(## ${escaped}\\n\\n)([\\s\\S]*?)(?=\\n## |$)`, "u");
  assert.match(text, pattern);
  return text.replace(pattern, `$1${content}`);
}

async function renderExecution(project) {
  const requirements = path.join(project, "requirements.md");
  const execution = path.join(project, "requirements-execution");
  await fs.writeFile(requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  await fs.mkdir(path.join(execution, "plans"), { recursive: true });
  await fs.mkdir(path.join(execution, "tasks"), { recursive: true });
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  await fs.writeFile(path.join(project, "src/example.txt"), "installed bridge fixture\n", "utf8");
  const authority = await computeRequirementsAuthority(requirements);
  const globalSource = "../requirements.md";
  const detailSource = "../../requirements.md";
  let plan = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  plan = replaceAll(plan, [
    ["`<relative path>`", `\`${globalSource}\``], ["sha256:<64hex>", `sha256:${authority}`],
    ["<positive integer>", "1"], ["<compact objective>", "Exercise the installed validation bridge"],
    ["<compact strategy>", "Plan, execute and publish one isolated check"], ["01 - <name>", "01 - Installed bridge"],
    ["<result>", "installed command evidence"], ["<areas>", "src/example.txt"],
  ]).replace(/\nFor revision 1,[\s\S]*?\n## Serial Slice Order/u, "\n## Serial Slice Order")
    .replace("status: draft", "status: ready").replaceAll("Review state: pending", "Review state: approved");
  await fs.writeFile(path.join(execution, "plan.md"), plan, "utf8");
  let slicePlan = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  slicePlan = replaceAll(slicePlan, [
    ["<Name>", "Installed bridge"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", "1"],
    ["<One coherent outcome or milestone, how it is observed and validated, and why it is one boundary. Technical layers belong in Tasks.>", "Execute one real command through the installed owner bridge."],
    ["<included work>", "Installed bridge fixture."], ["<excluded work and boundary with later slices>", "No consumer work."],
    ["<path, contract, subsystem, or test area>", "src/example.txt"], ["<earlier slice or none>", "none"],
    ["<risk and mitigation>", "Temporary isolated project only."], ["<bounded approach>", "One command."],
    ["<test, command, suite, or observable check>", "node -e process.exit(0)"], ["<objective result and preserved boundary>", "Sealed zero exit."],
  ]).replace("status: draft", "status: ready").replaceAll("Review state: pending", "Review state: approved");
  await fs.writeFile(path.join(execution, "plans/slice-01.md"), slicePlan, "utf8");
  let tasks = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/tasks.template.md"), "utf8");
  tasks = replaceAll(tasks, [["01 - <name>", "01 - Installed bridge"], ["<observable delivery>", "installed command evidence"]]);
  await fs.writeFile(path.join(execution, "tasks.md"), tasks, "utf8");
  let task = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  task = replaceAll(task, [
    ["<Name>", "Installed bridge"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", "1"],
    ["<task>", "Exercise installed bridge"], ["<result>", "installed command evidence"],
    ["<areas>", "src/example.txt"], ["<test, command, suite, or observable check>", "node -e process.exit(0)"],
  ]).replaceAll("- [ ]", "- [x]");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Diff Summary", "- Prepared a disposable installed-flow fixture.");
  await fs.writeFile(path.join(execution, "tasks/slice-01.md"), task, "utf8");
  return { requirements, execution, authority: `sha256:${authority}` };
}

async function installedFixture(t, { blocked = false } = {}) {
  const holder = await temporary(t, "stnl installed bridge holder ");
  const initial = path.join(holder, "unconventional initial package");
  await fs.mkdir(initial);
  const fixture = await renderExecution(initial);
  if (blocked) {
    const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
    let source = await fs.readFile(taskFile, "utf8");
    source = replaceSection(source, "Delegation Blocker", `- Operation: EXECUTE_SLICE
- Kind: malformed-output
- State: active
- After record: none
- Pending automatic round: 1/3
- Causes:
  - planner returned TESTS_PASS without the required plan envelope
- Required action: resume the same operation through planning and the installed bridge`);
    await fs.writeFile(taskFile, source, "utf8");
  }
  await installSentinel({ repositoryRoot: ROOT, platform: "codex", scope: "project", projectRoot: initial });
  const project = path.join(holder, "relocated package nowhere near source conventions");
  await fs.rename(initial, project);
  fixture.requirements = path.join(project, "requirements.md");
  fixture.execution = path.join(project, "requirements-execution");
  const resolverPath = path.join(project, ".agents/skills/stnl-slice-executor/runtime/resolve-validation-runtime.mjs");
  const harnessPath = path.join(project, ".agents/skills/stnl-slice-executor/runtime/run-validation-session.mjs");
  const qualityResolverPath = path.join(project, ".agents/skills/stnl-slice-quality-manager/runtime/resolve-validation-runtime.mjs");
  const resolver = await import(`${pathToFileURL(resolverPath).href}?fixture=${Date.now()}-${Math.random()}`);
  const harness = await import(`${pathToFileURL(harnessPath).href}?fixture=${Date.now()}-${Math.random()}`);
  const qualityResolver = await import(`${pathToFileURL(qualityResolverPath).href}?fixture=${Date.now()}-${Math.random()}`);
  return { ...fixture, project, resolver, harness, qualityResolver };
}

function planFor(fixture, overrides = {}) {
  const plan = {
    schema: "stnl-validation-plan/v1",
    protocol: {
      runner: fixture.resolver.VALIDATION_RUNNER_PROTOCOL,
      harness: fixture.resolver.VALIDATION_HARNESS_PROTOCOL,
      capability: fixture.resolver.VALIDATION_CAPABILITY_IDENTITY,
    },
    operation: "EXECUTE_SLICE", slice: "slice-01", round: "1/3",
    requirementsAuthority: fixture.authority, planRevision: 1,
    discovery: { sources: ["requirements.md", "requirements-execution/tasks/slice-01.md"], actions: ["read project-declared verification intent"] },
    cwd: ".", subjects: ["../../src/example.txt"],
    commands: [{
      argv: ["true"], cwd: ".", writePaths: [], writeFiles: [], env: {},
      timeoutMs: 10_000, executionEnvironment: { kind: "host" },
    }],
    baselineFingerprint: null, failureConclusion: "VALIDATION_FINDING", replayOriginEvidenceId: null,
    coverage: {
      verificationTypes: "focused executable check", selectedChecks: "true zero-exit check",
      rationale: "exercise the real installed harness", coverage: "installed plan to sealed evidence",
      filelessReason: null, nonApplicabilityRationale: null,
    },
    findings: null, priorRound: null, assessment: "none",
  };
  return Object.assign(plan, overrides);
}

async function stageAndPublish(t, fixture, result) {
  const candidateHolder = await temporary(t, "stnl installed candidate ");
  const candidate = path.join(candidateHolder, "execution candidate");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  const accepted = await fixture.resolver.stageValidationBridgeResult(fixture.requirements, result, candidate);
  assert.equal(accepted.state, "IMPLEMENTED_AWAITING_VALIDATION");
  await fs.copyFile(path.join(candidate, "tasks/slice-01.md"), path.join(fixture.execution, "tasks/slice-01.md"));
  return inspectExecutionState(fixture.requirements);
}

test("relocated installed owner executes a planner-only plan through the real harness and publishes accepted evidence", async (t) => {
  const fixture = await installedFixture(t);
  const before = await inspectExecutionState(fixture.requirements);
  assert.equal(before.tasks.get("slice-01").implementationChecks.length, 0);
  const result = await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture));
  assert.equal(result.summary.status, "TESTS_PASS", JSON.stringify(result.summary));
  assert.equal(result.summary.commands.length, 1);
  assert.equal(result.summary.commands[0].exit, 0);
  assert.match(result.sealedEvidence, /^stnl-validation-result\/v1:/u);
  const readback = await stageAndPublish(t, fixture, result);
  assert.equal(readback.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(readback.tasks.get("slice-01").implementationChecks.at(-1).status, "TESTS_PASS");
  assert.equal(readback.tasks.get("slice-01").implementationChecks.at(-1).provenance.evidenceId, result.summary.evidenceId);
});

test("installed quality owner requires assessment, stages sealed formal evidence and publishes PASS by read-back", async (t) => {
  const fixture = await installedFixture(t);
  const auxiliary = await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture));
  await stageAndPublish(t, fixture, auxiliary);
  const formalPlan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  const bridge = await fixture.qualityResolver.executeValidationPlan(fixture.requirements, formalPlan);
  assert.equal(bridge.summary.status, "ASSESSMENT_REQUIRED");
  assert.equal(bridge.persistence, null);
  const assessment = {
    schema: "stnl-validation-assessment/v1", planIdentity: bridge.planIdentity,
    evidenceId: bridge.summary.evidenceId, operation: "VALIDATE_SLICE", slice: "slice-01", round: null,
    status: "PASS", evidence: "Independent assessment confirmed the isolated command and complete scope.",
    verifiedScope: "../../src/example.txt", findingReferences: "none", findingDispositions: "none",
    blockers: "none", gates: [], manifest: ["../../src/example.txt"], filelessReason: null,
    overlaps: "none", regressions: "focused installed-flow command", persistenceSummary: "PASS from independent assessment bound to sealed evidence.",
  };
  const assessed = fixture.qualityResolver.materializeValidationAssessment(bridge, assessment);
  const candidateHolder = await temporary(t, "stnl formal candidate ");
  const candidate = path.join(candidateHolder, "execution");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  const taskFile = path.join(candidate, "tasks/slice-01.md");
  let task = await fs.readFile(taskFile, "utf8");
  task = replaceSection(task, "Final Result", "- PASS");
  await fs.writeFile(taskFile, task, "utf8");
  const tasksFile = path.join(candidate, "tasks.md");
  const tasks = (await fs.readFile(tasksFile, "utf8"))
    .replace("| [ ] | 01 - Installed bridge", "| [x] | 01 - Installed bridge")
    .replace("| pending | pending |", "| PASS | PASS |");
  await fs.writeFile(tasksFile, tasks, "utf8");
  const accepted = await fixture.qualityResolver.stageValidationBridgeResult(fixture.requirements, assessed, candidate);
  assert.equal(accepted.state, "COMPLETE");
  await fs.copyFile(taskFile, path.join(fixture.execution, "tasks/slice-01.md"));
  await fs.copyFile(tasksFile, path.join(fixture.execution, "tasks.md"));
  const readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "COMPLETE");
  assert.equal(readback.tasks.get("slice-01").attempts.at(-1).status, "PASS");
  assert.equal(readback.tasks.get("slice-01").attempts.at(-1).provenance.evidenceId, bridge.summary.evidenceId);
});

test("installed owners preserve formal finding authority across VALIDATE_SLICE and APPLY_FINDINGS", async (t) => {
  const fixture = await installedFixture(t);
  await stageAndPublish(t, fixture, await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture)));
  const formalPlan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  formalPlan.commands[0].argv = ["false"];
  const bridge = await fixture.qualityResolver.executeValidationPlan(fixture.requirements, formalPlan);
  const assessment = {
    schema: "stnl-validation-assessment/v1", planIdentity: bridge.planIdentity,
    evidenceId: bridge.summary.evidenceId, operation: "VALIDATE_SLICE", slice: "slice-01", round: null,
    status: "NEEDS_FIX", evidence: "Independent validation observed the deliberate fixture failure.",
    verifiedScope: "../../src/example.txt", findingReferences: "finding-01", findingDispositions: "finding-01=active",
    blockers: "none", gates: [], manifest: ["../../src/example.txt"], filelessReason: null,
    overlaps: "none", regressions: "focused installed-flow command", persistenceSummary: "NEEDS_FIX bound to sealed evidence.",
  };
  const assessed = fixture.qualityResolver.materializeValidationAssessment(bridge, assessment);
  const candidateHolder = await temporary(t, "stnl needs-fix candidate ");
  const candidate = path.join(candidateHolder, "execution");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  const taskFile = path.join(candidate, "tasks/slice-01.md");
  let task = await fs.readFile(taskFile, "utf8");
  task = replaceSection(task, "Validation Findings", `### finding-01

- Severity: blocking
- State: active
- Origin: attempt-01
- Kind: implementation_defect
- Evidence identity: ${bridge.summary.evidenceId}
- Problem: Deliberate validation command failed.
- Evidence: Sealed formal harness evidence has a nonzero exit.
- Impact: AC-001 is not yet formally satisfied.
- Related authority: AC-001 and slice-01
- Expected correction: Restore the focused command to success.`);
  await fs.writeFile(taskFile, task, "utf8");
  const accepted = await fixture.qualityResolver.stageValidationBridgeResult(fixture.requirements, assessed, candidate);
  assert.equal(accepted.state, "VALIDATION_NEEDS_FIX");
  await fs.copyFile(taskFile, path.join(fixture.execution, "tasks/slice-01.md"));

  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  task = replaceSection(await fs.readFile(liveTask, "utf8"), "Corrections Applied", "- `../../src/example.txt`");
  await fs.writeFile(liveTask, task, "utf8");
  const findingsPlan = planFor(fixture, { operation: "APPLY_FINDINGS" });
  findingsPlan.findings = {
    cycle: "attempt-01", ids: ["finding-01"], correctionsCovered: "../../src/example.txt",
    regressions: "focused installed-flow command",
  };
  const findingsResult = await fixture.resolver.executeValidationPlan(fixture.requirements, findingsPlan);
  assert.equal(findingsResult.summary.status, "TESTS_PASS");
  const correctionHolder = await temporary(t, "stnl findings candidate ");
  const correctionCandidate = path.join(correctionHolder, "execution");
  await fs.cp(fixture.execution, correctionCandidate, { recursive: true });
  const correctionAccepted = await fixture.resolver.stageValidationBridgeResult(fixture.requirements, findingsResult, correctionCandidate);
  assert.equal(correctionAccepted.state, "FINDINGS_CORRECTED");
  await fs.copyFile(path.join(correctionCandidate, "tasks/slice-01.md"), liveTask);
  const readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "FINDINGS_CORRECTED");
  assert.equal(readback.tasks.get("slice-01").findingsChecks.at(-1).status, "TESTS_PASS");
});

test("malformed-output recovery keeps round one and historical blocker while new installed evidence resolves it", async (t) => {
  const fixture = await installedFixture(t, { blocked: true });
  const before = await inspectExecutionState(fixture.requirements);
  assert.equal(before.state, "RUNNER_RESULT_BLOCKED");
  assert.equal(before.tasks.get("slice-01").implementationChecks.length, 0);
  const originalTask = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  const result = await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture));
  assert.equal(result.round, "1/3");
  assert.equal(result.resolution.section, "Delegation Blocker");
  const readback = await stageAndPublish(t, fixture, result);
  const published = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  assert.match(published, /- Kind: malformed-output[\s\S]*- State: resolved[\s\S]*- Resolution:/u);
  assert.ok(originalTask.includes("planner returned TESTS_PASS"));
  assert.ok(published.includes("planner returned TESTS_PASS"));
  assert.equal(readback.tasks.get("slice-01").implementationChecks.at(-1).round, 1);
});

test("installed bridge rejects result-shaped, infrastructure-leaking, implicit, stale and divergent plans before harness dispatch", async (t) => {
  const fixture = await installedFixture(t);
  const cases = [
    [{ status: "TESTS_PASS", testCount: 47 }, "RUNNER_RESULT_INSTEAD_OF_PLAN"],
    [(() => { const value = planFor(fixture); value.discovery.sources[0] = "runtime/run-validation-session.mjs"; return value; })(), "VALIDATION_PLAN_INFRASTRUCTURE_PATH_FORBIDDEN"],
    [(() => { const value = planFor(fixture); delete value.commands[0].executionEnvironment; return value; })(), "PLAN_EXECUTION_ENVIRONMENT_REQUIRED"],
    [(() => { const value = planFor(fixture); value.protocol.capability = `sha256:${"0".repeat(64)}`; return value; })(), "VALIDATION_PLAN_IDENTITY_MISMATCH"],
    [planFor(fixture, { operation: "VALIDATE_SLICE", round: null }), "VALIDATION_PLAN_OWNER_MISMATCH"],
    [planFor(fixture, { slice: "slice-02" }), "VALIDATION_PLAN_ROUND_MISMATCH"],
    [planFor(fixture, { round: "2/3" }), "VALIDATION_PLAN_ROUND_MISMATCH"],
    [planFor(fixture, { requirementsAuthority: `sha256:${"1".repeat(64)}` }), "VALIDATION_PLAN_AUTHORITY_MISMATCH"],
    [planFor(fixture, { planRevision: 2 }), "VALIDATION_PLAN_AUTHORITY_MISMATCH"],
  ];
  for (const [candidate, code] of cases) {
    await assert.rejects(fixture.resolver.validateValidationPlan(fixture.requirements, candidate), (error) => (
      error.code === code || (error.name === "ExecutionContractError" && /slice|SLICE|legal/u.test(error.message))
    ), code);
  }
  await assert.rejects(fixture.qualityResolver.validateValidationPlan(fixture.requirements, planFor(fixture)), (error) => error.code === "VALIDATION_PLAN_OWNER_MISMATCH");
  assert.equal((await inspectExecutionState(fixture.requirements)).tasks.get("slice-01").implementationChecks.length, 0);
});

test("installed bridge preserves a real infrastructure BLOCKED envelope and never fabricates missing provenance", async (t) => {
  const fixture = await installedFixture(t);
  const raw = await fixture.harness.runValidationSession(fixture.requirements, {
    protocol: planFor(fixture).protocol, operation: "EXECUTE_SLICE", slice: "slice-01", round: "1/3",
    cwd: ".", subjects: ["../../src/example.txt"], commands: [{
      argv: ["true"], cwd: ".", writePaths: [], writeFiles: [], env: {}, timeoutMs: 10_000,
    }], baselineFingerprint: null, priorEvidenceId: null,
    failureConclusion: "VALIDATION_FINDING", replayOriginEvidenceId: null,
  });
  const transport = fixture.resolver.validationResultTransport(`${JSON.stringify(raw)}\n`, 1, "");
  assert.match(transport, /^stnl-validation-result\/v1:/u);
  const blocked = await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture), {
    invoke: async () => ({ exit: 1, transport, errors: "" }),
  });
  assert.equal(blocked.summary.state, "INVALID");
  assert.equal(blocked.summary.classification, "INFRASTRUCTURE_BLOCKED");
  assert.equal(blocked.persistence.section, "Delegation Blocker");
  const candidateHolder = await temporary(t, "stnl blocked candidate ");
  const candidate = path.join(candidateHolder, "execution");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  const accepted = await fixture.resolver.stageValidationBridgeResult(fixture.requirements, blocked, candidate);
  assert.equal(accepted.state, "RUNNER_RESULT_BLOCKED");
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture), { invoke: async () => ({ exit: 1, transport: null, errors: "raw failure" }) }),
    (error) => error.code === "MALFORMED_HARNESS_OUTPUT",
  );
});

test("tampered envelope is rejected and an accepted plan alone cannot be staged or published", async (t) => {
  const fixture = await installedFixture(t);
  const result = await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture));
  const tampered = { ...result, sealedEvidence: `${result.sealedEvidence}x` };
  const candidateHolder = await temporary(t, "stnl tampered candidate ");
  const candidate = path.join(candidateHolder, "execution");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  await assert.rejects(fixture.resolver.stageValidationBridgeResult(fixture.requirements, tampered, candidate), (error) => error.code === "INVALID_VALIDATION_BRIDGE_RESULT");
  await assert.rejects(fixture.resolver.stageValidationBridgeResult(fixture.requirements, { schema: "stnl-validation-plan/v1" }, candidate), (error) => error.code === "INVALID_VALIDATION_BRIDGE_RESULT");
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "EXECUTION_STARTED");
});
