import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

async function snapshotTaskFile(execution) {
  return fs.readFile(path.join(execution, "tasks/slice-01.md"));
}

function assertSameBytes(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: byte length changed`);
  assert.equal(
    createHash("sha256").update(actual).digest("hex"),
    createHash("sha256").update(expected).digest("hex"),
    `${label}: content changed`,
  );
}

async function isolatedCandidate(t, fixture, prefix = "stnl installed candidate ") {
  const holder = await temporary(t, prefix);
  const candidate = path.join(holder, "execution");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  return candidate;
}

async function stagePublishAndRead(t, fixture, owner, result, { expectedState = null, publishIndex = false } = {}) {
  const candidate = await isolatedCandidate(t, fixture);
  const accepted = await owner.stageValidationBridgeResult(fixture.requirements, result, candidate);
  if (expectedState !== null) assert.equal(accepted.state, expectedState);
  await fs.copyFile(path.join(candidate, "tasks/slice-01.md"), path.join(fixture.execution, "tasks/slice-01.md"));
  if (publishIndex) await fs.copyFile(path.join(candidate, "tasks.md"), path.join(fixture.execution, "tasks.md"));
  return inspectExecutionState(fixture.requirements);
}

function requestForPlan(plan, { omitExecutionEnvironment = false } = {}) {
  return {
    protocol: plan.protocol, operation: plan.operation, slice: plan.slice, round: plan.round,
    cwd: plan.cwd, subjects: plan.subjects,
    commands: plan.commands.map((command) => {
      if (!omitExecutionEnvironment) return command;
      const { executionEnvironment: _executionEnvironment, ...legacy } = command;
      return legacy;
    }),
    baselineFingerprint: plan.baselineFingerprint, priorEvidenceId: plan.priorEvidenceId,
    failureConclusion: plan.failureConclusion, replayOriginEvidenceId: plan.replayOriginEvidenceId,
  };
}

async function executeWithHarnessEvidence(fixture, owner, plan, dependencies = {}, requestOptions = {}) {
  const validatedPlan = await owner.validateValidationPlan(fixture.requirements, plan);
  const raw = await fixture.harness.runValidationSession(
    fixture.requirements, requestForPlan(validatedPlan, requestOptions), dependencies,
  );
  const exit = raw.provenance.state === "INVALID" ? 1 : 0;
  const transport = owner.validationResultTransport(`${JSON.stringify(raw)}\n`, exit, "");
  assert.match(transport, /^stnl-validation-result\/v1:/u);
  const result = await owner.executeValidationPlan(fixture.requirements, plan, {
    invoke: async () => ({ exit, transport, errors: "" }),
  });
  return { raw, result };
}

async function dockerPlanEnvironment(fixture) {
  await fs.mkdir(path.join(fixture.project, "ops"), { recursive: true });
  await fs.writeFile(path.join(fixture.project, "ops/docker-compose.yml"), "services:\n  backend:\n    image: fixture/backend:dev\n", "utf8");
  await fs.writeFile(path.join(fixture.project, "DEVELOPMENT.md"), "Validation uses the project Docker Compose toolchain.\n", "utf8");
  return {
    kind: "docker-compose", composeFile: "ops/docker-compose.yml", service: "backend",
    image: "fixture/backend:dev", authoritySources: ["DEVELOPMENT.md"],
  };
}

function admittedDockerEngine(fixture, { failure = null, run = null } = {}) {
  const imageId = `sha256:${"d".repeat(64)}`;
  return {
    async composeContainers(service) {
      return [{
        ImageID: imageId,
        Labels: {
          "com.docker.compose.service": service,
          "com.docker.compose.project.working_dir": path.join(fixture.project, "ops"),
          "com.docker.compose.project.config_files": path.join(fixture.project, "ops/docker-compose.yml"),
          "com.docker.compose.config-hash": "installed-fixture-config",
        },
      }];
    },
    async image() {
      return { Id: imageId, RepoDigests: [`fixture@sha256:${"e".repeat(64)}`], Config: { WorkingDir: "/app" } };
    },
    async run(options) {
      if (run !== null) return run(options);
      if (failure !== null) {
        throw new fixture.harness.DockerEnvironmentError(
          "DOCKER_START_FAILED", failure, "ops/docker-compose.yml",
        );
      }
      return {
        exit: 0, stdout: Buffer.from("installed docker command passed\n"), stderr: Buffer.alloc(0),
        stderrForEvidence: Buffer.alloc(0), timedOut: false, signaled: false,
        sandboxViolation: false, sandboxEvents: [], sandboxOutcomeUncertain: false,
      };
    },
  };
}

function assessmentFor(bridge, overrides = {}) {
  return {
    schema: "stnl-validation-assessment/v1", planIdentity: bridge.planIdentity,
    evidenceId: bridge.summary.evidenceId, operation: bridge.operation, slice: bridge.slice, round: bridge.round,
    status: bridge.operation === "VALIDATE_SLICE" ? "PASS" : "TESTS_PASS",
    evidence: "Independent assessment confirmed the sealed harness evidence and bounded scope.",
    verifiedScope: "../../src/example.txt", findingReferences: "none", findingDispositions: "none",
    blockers: "none", gates: [], manifest: ["../../src/example.txt"], filelessReason: null,
    overlaps: "none", regressions: "focused installed-flow command",
    persistenceSummary: "Independent assessment bound its conclusion to sealed evidence.",
    ...overrides,
  };
}

function nonBlockingGate(bridge, command) {
  const expected = bridge.summary.subjects[0].expected;
  return {
    id: "gate-01", command, kind: "quality", scope: "out_of_scope", causality: "independent", state: "present",
    problem: "An external fixture gate reports a deliberate independent failure.",
    evidence: "The mandatory slice command passed while the separate external gate retained its deliberate diagnostic.",
    diagnostic: `sha256:${createHash("sha256").update("installed external gate diagnostic").digest("hex")}`,
    correction: "in_scope", correctionEvidence: "The slice obligation is independently covered by the successful mandatory command.",
    revalidates: null, snapshot: [{ path: "../../src/example.txt", expected }], bypass: null,
  };
}

async function publishActiveFinding(t, fixture, { correct = true } = {}) {
  await stageAndPublish(t, fixture, await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture)));
  const plan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  plan.commands[0].argv = ["false"];
  const bridge = await fixture.qualityResolver.executeValidationPlan(fixture.requirements, plan);
  const assessed = fixture.qualityResolver.materializeValidationAssessment(
    bridge,
    assessmentFor(bridge, {
      status: "NEEDS_FIX", findingReferences: "finding-01", findingDispositions: "finding-01=active",
      evidence: "Independent validation observed the deliberate fixture failure.",
      persistenceSummary: "NEEDS_FIX bound to sealed evidence.",
    }),
  );
  const candidate = await isolatedCandidate(t, fixture, "stnl active finding candidate ");
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
  if (!correct) return bridge;
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  task = replaceSection(await fs.readFile(liveTask, "utf8"), "Corrections Applied", "- `../../src/example.txt`");
  await fs.writeFile(liveTask, task, "utf8");
  const findingsPlan = planFor(fixture, { operation: "APPLY_FINDINGS" });
  findingsPlan.findings = {
    cycle: "attempt-01", ids: ["finding-01"], correctionsCovered: "../../src/example.txt",
    regressions: "focused installed-flow command",
  };
  const findingsResult = await fixture.resolver.executeValidationPlan(fixture.requirements, findingsPlan);
  await stagePublishAndRead(t, fixture, fixture.resolver, findingsResult, { expectedState: "FINDINGS_CORRECTED" });
  return bridge;
}

function commandDiagnostic(command) {
  assert.ok(command.diagnostic !== null && typeof command.diagnostic === "object", "command must expose a structured diagnostic");
  return JSON.stringify({ display: command.display, diagnostic: command.diagnostic });
}

async function terminalPassCandidate(t, fixture, prefix) {
  const candidate = await isolatedCandidate(t, fixture, prefix);
  const taskFile = path.join(candidate, "tasks/slice-01.md");
  let task = await fs.readFile(taskFile, "utf8");
  task = replaceSection(task, "Final Result", "- PASS");
  await fs.writeFile(taskFile, task, "utf8");
  const tasksFile = path.join(candidate, "tasks.md");
  const tasks = (await fs.readFile(tasksFile, "utf8"))
    .replace("| [ ] | 01 - Installed bridge", "| [x] | 01 - Installed bridge")
    .replace("| pending | pending |", "| PASS | PASS |");
  await fs.writeFile(tasksFile, tasks, "utf8");
  return { candidate, taskFile, tasksFile };
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

test("installed staging rejects live and redirected destinations before any protected byte changes", async (t) => {
  const fixture = await installedFixture(t);
  const result = await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture));
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const protectedBefore = await snapshotTaskFile(fixture.execution);

  await assert.rejects(
    fixture.resolver.stageValidationBridgeResult(fixture.requirements, result, fixture.execution),
    /isolated|candidate/u,
  );
  assertSameBytes(await snapshotTaskFile(fixture.execution), protectedBefore, "the live execution root changed before rejection");

  const aliasHolder = await temporary(t, "stnl installed candidate alias ");
  const rootAlias = path.join(aliasHolder, "execution-alias");
  await fs.symlink(fixture.execution, rootAlias, "dir");
  await assert.rejects(
    fixture.resolver.stageValidationBridgeResult(fixture.requirements, result, rootAlias),
    /isolated|candidate/u,
  );
  assertSameBytes(await snapshotTaskFile(fixture.execution), protectedBefore, "a root symlink changed protected bytes");

  const tasksAliasCandidate = await isolatedCandidate(t, fixture, "stnl installed tasks alias ");
  await fs.rm(path.join(tasksAliasCandidate, "tasks"), { recursive: true });
  await fs.symlink(path.join(fixture.execution, "tasks"), path.join(tasksAliasCandidate, "tasks"), "dir");
  await assert.rejects(
    fixture.resolver.stageValidationBridgeResult(fixture.requirements, result, tasksAliasCandidate),
    /isolated|candidate|real file/u,
  );
  assertSameBytes(await snapshotTaskFile(fixture.execution), protectedBefore, "a tasks/ symlink changed protected bytes");

  const hardlinkCandidate = await isolatedCandidate(t, fixture, "stnl installed hardlink candidate ");
  const candidateTask = path.join(hardlinkCandidate, "tasks/slice-01.md");
  await fs.unlink(candidateTask);
  await fs.link(liveTask, candidateTask);
  await assert.rejects(
    fixture.resolver.stageValidationBridgeResult(fixture.requirements, result, hardlinkCandidate),
    /isolated|candidate|hardlink|single-link/u,
  );
  assertSameBytes(await snapshotTaskFile(fixture.execution), protectedBefore, "a hardlinked task changed protected bytes");
  await fs.unlink(candidateTask);

  const isolated = await isolatedCandidate(t, fixture, "stnl installed legitimate candidate ");
  const accepted = await fixture.resolver.stageValidationBridgeResult(fixture.requirements, result, isolated);
  assert.equal(accepted.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assertSameBytes(await snapshotTaskFile(fixture.execution), protectedBefore, "legitimate staging changed live bytes before publication");
  assert.notDeepEqual(await fs.readFile(path.join(isolated, "tasks/slice-01.md")), protectedBefore);
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
  const findingsPlan = planFor(fixture, { operation: "APPLY_FINDINGS", assessment: "independent", failureConclusion: "NONE" });
  findingsPlan.findings = {
    cycle: "attempt-01", ids: ["finding-01"], correctionsCovered: "../../src/example.txt",
    regressions: "focused installed-flow command",
  };
  findingsPlan.commands = [findingsPlan.commands[0], { ...findingsPlan.commands[0], argv: ["false"] }];
  const findingsBridge = await fixture.resolver.executeValidationPlan(fixture.requirements, findingsPlan);
  assert.equal(findingsBridge.summary.status, "ASSESSMENT_REQUIRED");
  const gate = nonBlockingGate(findingsBridge, findingsBridge.summary.commands[1].display);
  const findingsResult = fixture.resolver.materializeValidationAssessment(
    findingsBridge,
    assessmentFor(findingsBridge, {
      gates: [gate], persistenceSummary: "Finding correction passed while an independent external gate remained non-blocking.",
    }),
  );
  assert.equal(findingsResult.persistence.section, "Findings Test Evidence");
  assert.match(findingsResult.persistence.markdown, /Gate assessments/u);
  const correctionHolder = await temporary(t, "stnl findings candidate ");
  const correctionCandidate = path.join(correctionHolder, "execution");
  await fs.cp(fixture.execution, correctionCandidate, { recursive: true });
  const correctionAccepted = await fixture.resolver.stageValidationBridgeResult(fixture.requirements, findingsResult, correctionCandidate);
  assert.equal(correctionAccepted.state, "FINDINGS_CORRECTED");
  await fs.copyFile(path.join(correctionCandidate, "tasks/slice-01.md"), liveTask);
  const readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "FINDINGS_CORRECTED");
  assert.equal(readback.tasks.get("slice-01").findingsChecks.at(-1).status, "TESTS_PASS");
  assert.equal(readback.tasks.get("slice-01").findingsChecks.at(-1).gates[0].decision, "non_blocking");
  assert.equal(readback.tasks.get("slice-01").findings[0].state, "active");
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

test("chain A keeps a singleton blocker across repeated preflight and resumes the same auxiliary round", async (t) => {
  const fixture = await installedFixture(t, { blocked: true });
  const blockedPlan = planFor(fixture);
  const { raw, result: repeated } = await executeWithHarnessEvidence(
    fixture, fixture.resolver, blockedPlan, {}, { omitExecutionEnvironment: true },
  );
  assert.equal(raw.provenance.state, "INVALID");
  assert.equal(raw.provenance.workspace.kind, "pre-check");
  assert.equal(repeated.persistence.section, "Delegation Blocker");
  assert.equal(repeated.round, "1/3");

  const blockedReadback = await stagePublishAndRead(t, fixture, fixture.resolver, repeated, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  const blockedMarkdown = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  assert.equal((blockedMarkdown.match(/^- Operation:/gmu) ?? []).length, 1, "Delegation Blocker is a singleton");
  assert.match(blockedMarkdown, /planner returned TESTS_PASS without the required plan envelope/u);
  assert.match(blockedMarkdown, /VALIDATION_EXECUTION_ENVIRONMENT_REQUIRED|executionEnvironment/u);
  assert.equal(blockedReadback.tasks.get("slice-01").implementationChecks.length, 0, "preflight must not consume the pending round");
  assert.equal(blockedReadback.tasks.get("slice-01").delegationBlocker.pendingRound, 1);

  const resumed = await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture));
  assert.equal(resumed.round, "1/3");
  const resumedReadback = await stagePublishAndRead(t, fixture, fixture.resolver, resumed, {
    expectedState: "IMPLEMENTED_AWAITING_VALIDATION",
  });
  assert.equal(resumedReadback.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(resumedReadback.tasks.get("slice-01").implementationChecks.at(-1).round, 1);
  assert.equal(resumedReadback.tasks.get("slice-01").delegationBlocker.state, "resolved");
  assert.match(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8"), /planner returned TESTS_PASS/u);
});

test("one installed SPEC preserves successive auxiliary and formal delegation episodes through final PASS", async (t) => {
  const fixture = await installedFixture(t, { blocked: true });
  const auxiliaryPlan = planFor(fixture);
  const { result: auxiliaryPreflight } = await executeWithHarnessEvidence(
    fixture, fixture.resolver, auxiliaryPlan, {}, { omitExecutionEnvironment: true },
  );
  let readback = await stagePublishAndRead(t, fixture, fixture.resolver, auxiliaryPreflight, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlockers.length, 1);
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.observations.length, 1);
  assert.equal(readback.tasks.get("slice-01").implementationChecks.length, 0);

  const { result: identicalAuxiliaryPreflight } = await executeWithHarnessEvidence(
    fixture, fixture.resolver, auxiliaryPlan, {}, { omitExecutionEnvironment: true },
  );
  readback = await stagePublishAndRead(t, fixture, fixture.resolver, identicalAuxiliaryPreflight, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.observations.length, 2);
  readback = await stagePublishAndRead(t, fixture, fixture.resolver, identicalAuxiliaryPreflight, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.observations.length, 2, "identical evidence is not duplicated");

  const auxiliary = await fixture.resolver.executeValidationPlan(fixture.requirements, auxiliaryPlan);
  assert.equal(auxiliary.summary.commands[0].exit, 0, "the installed harness executes the real minimal success command");
  readback = await stagePublishAndRead(t, fixture, fixture.resolver, auxiliary, {
    expectedState: "IMPLEMENTED_AWAITING_VALIDATION",
  });
  assert.equal(readback.tasks.get("slice-01").implementationChecks[0].id, "implementation-check-01");
  assert.equal(readback.tasks.get("slice-01").implementationChecks[0].round, 1);
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[0].state, "resolved");
  const firstCause = readback.tasks.get("slice-01").delegationBlockers[0].causes?.[0];

  const formalPlan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  const { result: formalBlocked } = await executeWithHarnessEvidence(
    fixture, fixture.qualityResolver, formalPlan, {}, { omitExecutionEnvironment: true },
  );
  readback = await stagePublishAndRead(t, fixture, fixture.qualityResolver, formalBlocked, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlockers.length, 2);
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[0].state, "resolved");
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[0].operation, "EXECUTE_SLICE");
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[1].state, "active");
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[1].operation, "VALIDATE_SLICE");
  assert.equal(readback.effectiveBlockers[0].operation, "VALIDATE_SLICE");
  assert.equal(readback.effectiveBlockers[0].record, null);
  assert.equal(readback.tasks.get("slice-01").attempts.length, 0);

  const { result: repeatedFormalBlocked } = await executeWithHarnessEvidence(
    fixture, fixture.qualityResolver, formalPlan, {}, { omitExecutionEnvironment: true },
  );
  readback = await stagePublishAndRead(t, fixture, fixture.qualityResolver, repeatedFormalBlocked, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlockers.length, 2);
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[1].observations.length, 1);

  const executionEnvironment = await dockerPlanEnvironment(fixture);
  const admittedPlan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  admittedPlan.commands[0] = { ...admittedPlan.commands[0], argv: ["fixture-tool"], executionEnvironment };
  const { raw: failedEvidence, result: failedBridge } = await executeWithHarnessEvidence(
    fixture, fixture.qualityResolver, admittedPlan,
    { dockerEngine: admittedDockerEngine(fixture, { failure: "authenticated same-SPEC runtime failure" }) },
  );
  assert.equal(failedEvidence.provenance.workspace.kind, "isolated-copy");
  const blockedAttempt = fixture.qualityResolver.materializeValidationAssessment(
    failedBridge,
    assessmentFor(failedBridge, {
      status: "BLOCKED", blockers: "DOCKER_START_FAILED: authenticated same-SPEC runtime failure",
      evidence: "Independent assessment confirmed authenticated post-admission infrastructure failure.",
      persistenceSummary: "BLOCKED formal attempt bound to admitted evidence without a fabricated product finding.",
    }),
  );
  readback = await stagePublishAndRead(t, fixture, fixture.qualityResolver, blockedAttempt, {
    expectedState: "VALIDATION_BLOCKED",
  });
  assert.deepEqual(readback.tasks.get("slice-01").attempts.map(({ id, status }) => ({ id, status })), [
    { id: "attempt-01", status: "BLOCKED" },
  ]);
  assert.match(readback.tasks.get("slice-01").attempts[0].body, /- Type: initial/u);
  assert.equal(readback.tasks.get("slice-01").findings.length, 0);
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[1].state, "resolved");

  const { result: secondFormalPreflight } = await executeWithHarnessEvidence(
    fixture, fixture.qualityResolver, formalPlan, {}, { omitExecutionEnvironment: true },
  );
  readback = await stagePublishAndRead(t, fixture, fixture.qualityResolver, secondFormalPreflight, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlockers.length, 3);
  assert.deepEqual(readback.tasks.get("slice-01").delegationBlockers.map(({ state }) => state), ["resolved", "resolved", "active"]);
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[2].afterRecord, "attempt-01");
  assert.equal(readback.effectiveBlockers[0].operation, "VALIDATE_SLICE");
  assert.equal(readback.effectiveBlockers[0].record, "attempt-01");
  assert.equal(readback.tasks.get("slice-01").attempts.length, 1, "preflight must not create attempt-02");

  const passingBridge = await fixture.qualityResolver.executeValidationPlan(
    fixture.requirements,
    planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent", failureConclusion: "NONE" }),
  );
  assert.equal(passingBridge.summary.commands[0].exit, 0);
  const passedAttempt = fixture.qualityResolver.materializeValidationAssessment(
    passingBridge,
    assessmentFor(passingBridge, { persistenceSummary: "Final independent PASS closes the same-SPEC validation chain." }),
  );
  const completeCandidate = await terminalPassCandidate(t, fixture, "stnl same SPEC complete candidate ");
  const accepted = await fixture.qualityResolver.stageValidationBridgeResult(
    fixture.requirements, passedAttempt, completeCandidate.candidate,
  );
  assert.equal(accepted.state, "COMPLETE");
  await fs.copyFile(completeCandidate.taskFile, path.join(fixture.execution, "tasks/slice-01.md"));
  await fs.copyFile(completeCandidate.tasksFile, path.join(fixture.execution, "tasks.md"));
  readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "COMPLETE");
  assert.deepEqual(readback.tasks.get("slice-01").attempts.map(({ id, status }) => ({ id, status })), [
    { id: "attempt-01", status: "BLOCKED" },
    { id: "attempt-02", status: "PASS" },
  ]);
  assert.match(readback.tasks.get("slice-01").attempts[1].body, /- Type: revalidation/u);
  assert.equal(readback.tasks.get("slice-01").attempts[1].provenance.priorEvidenceId, readback.tasks.get("slice-01").attempts[0].provenance.evidenceId);
  assert.deepEqual(readback.tasks.get("slice-01").delegationBlockers.map(({ state }) => state), ["resolved", "resolved", "resolved"]);
  assert.deepEqual(readback.effectiveBlockers, []);
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[0].causes?.[0], firstCause);
});

test("APPLY_FINDINGS can open a new delegation episode after resolving an earlier one in the same finding cycle", async (t) => {
  const fixture = await installedFixture(t);
  await publishActiveFinding(t, fixture, { correct: false });
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  let task = await fs.readFile(liveTask, "utf8");
  task = replaceSection(task, "Corrections Applied", "- `../../src/example.txt`");
  await fs.writeFile(liveTask, task, "utf8");

  const findingsPlan = planFor(fixture, { operation: "APPLY_FINDINGS", assessment: "independent", failureConclusion: "NONE" });
  findingsPlan.findings = {
    cycle: "attempt-01", ids: ["finding-01"], correctionsCovered: "../../src/example.txt",
    regressions: "focused installed-flow command",
  };
  const { result: firstPreflight } = await executeWithHarnessEvidence(
    fixture, fixture.resolver, findingsPlan, {}, { omitExecutionEnvironment: true },
  );
  let readback = await stagePublishAndRead(t, fixture, fixture.resolver, firstPreflight, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.operation, "APPLY_FINDINGS");
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.pendingRound, 1);
  assert.equal(readback.tasks.get("slice-01").attempts[0].id, "attempt-01");
  assert.equal(readback.tasks.get("slice-01").findings[0].state, "active");

  const executionEnvironment = await dockerPlanEnvironment(fixture);
  const admittedPlan = structuredClone(findingsPlan);
  admittedPlan.commands[0] = { ...admittedPlan.commands[0], argv: ["fixture-tool"], executionEnvironment };
  const { result: admittedBridge } = await executeWithHarnessEvidence(
    fixture, fixture.resolver, admittedPlan,
    { dockerEngine: admittedDockerEngine(fixture, { failure: "authenticated findings runtime failure" }) },
  );
  const blockedCheck = fixture.resolver.materializeValidationAssessment(
    admittedBridge,
    assessmentFor(admittedBridge, {
      status: "BLOCKED", blockers: "DOCKER_START_FAILED: authenticated findings runtime failure",
      evidence: "Independent assessment confirmed an admitted APPLY_FINDINGS infrastructure failure.",
      persistenceSummary: "BLOCKED findings check preserves the active finding and reserved round.",
    }),
  );
  readback = await stagePublishAndRead(t, fixture, fixture.resolver, blockedCheck, {
    expectedState: "AUXILIARY_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlockers[0].state, "resolved");
  assert.equal(readback.tasks.get("slice-01").findingsChecks[0].id, "findings-check-01");
  assert.equal(readback.tasks.get("slice-01").findingsChecks[0].findingsCycle, "attempt-01");

  const { result: secondPreflight } = await executeWithHarnessEvidence(
    fixture, fixture.resolver, findingsPlan, {}, { omitExecutionEnvironment: true },
  );
  readback = await stagePublishAndRead(t, fixture, fixture.resolver, secondPreflight, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.deepEqual(readback.tasks.get("slice-01").delegationBlockers.map(({ state }) => state), ["resolved", "active"]);
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.operation, "APPLY_FINDINGS");
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.afterRecord, "findings-check-01");
  assert.equal(readback.tasks.get("slice-01").attempts[0].id, "attempt-01");
  assert.equal(readback.tasks.get("slice-01").findings[0].state, "active");
  assert.equal(readback.tasks.get("slice-01").findingsChecks.length, 1);
  assert.equal(readback.mandatoryRecovery.operation, "APPLY_FINDINGS");
  assert.equal(readback.mandatoryRecovery.record, "findings-check-01");
  assert.equal(readback.mandatoryRecovery.round, 1);
});

test("VALIDATE_SLICE post-admission infrastructure failure persists a formal BLOCKED attempt", async (t) => {
  const fixture = await installedFixture(t);
  await stageAndPublish(t, fixture, await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture)));
  const executionEnvironment = await dockerPlanEnvironment(fixture);
  const plan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  plan.commands[0] = { ...plan.commands[0], argv: ["fixture-tool"], executionEnvironment };
  const { raw, result } = await executeWithHarnessEvidence(
    fixture, fixture.qualityResolver, plan,
    { dockerEngine: admittedDockerEngine(fixture, { failure: "authenticated installed runtime failure" }) },
  );
  assert.equal(raw.provenance.state, "INVALID");
  assert.equal(raw.provenance.workspace.kind, "isolated-copy");
  assert.equal(raw.provenance.blocker.stage, "environment-execution");
  assert.equal(raw.provenance.commands[0].exit, 125);
  assert.equal(result.summary.status, "ASSESSMENT_REQUIRED");
  assert.equal(result.persistence, null);
  const assessed = fixture.qualityResolver.materializeValidationAssessment(
    result,
    assessmentFor(result, {
      status: "BLOCKED", blockers: "DOCKER_START_FAILED: authenticated installed runtime failure",
      evidence: "Independent assessment confirmed an authenticated infrastructure failure after isolated execution admission.",
      persistenceSummary: "BLOCKED formal attempt bound to invalid post-admission infrastructure evidence.",
    }),
  );
  assert.equal(assessed.persistence.section, "Validation Attempts");
  assert.equal(assessed.persistence.recordId, "attempt-01");
  assert.match(assessed.persistence.markdown, /- Type: initial/u);
  assert.match(assessed.persistence.markdown, /- Status: BLOCKED/u);
  assert.doesNotMatch(assessed.persistence.markdown, /Automatic check round: null/u);

  const readback = await stagePublishAndRead(t, fixture, fixture.qualityResolver, assessed, {
    expectedState: "VALIDATION_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").attempts.at(-1).status, "BLOCKED");
  assert.equal(readback.tasks.get("slice-01").findingsChecks.length, 0);
});

test("chain B resumes preflight and post-admission blockers through formal PASS publication and read-back", async (t) => {
  const fixture = await installedFixture(t);
  await stageAndPublish(t, fixture, await fixture.resolver.executeValidationPlan(fixture.requirements, planFor(fixture)));

  const formalPlan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  const { raw: preflightEvidence, result: preflightBlocked } = await executeWithHarnessEvidence(
    fixture, fixture.qualityResolver, formalPlan, {}, { omitExecutionEnvironment: true },
  );
  assert.equal(preflightEvidence.provenance.workspace.kind, "pre-check");
  assert.equal(preflightBlocked.persistence.section, "Delegation Blocker");
  let readback = await stagePublishAndRead(t, fixture, fixture.qualityResolver, preflightBlocked, {
    expectedState: "RUNNER_RESULT_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").attempts.length, 0, "preflight must not fabricate a formal attempt");
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.state, "active");

  const executionEnvironment = await dockerPlanEnvironment(fixture);
  const admittedPlan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  admittedPlan.commands[0] = { ...admittedPlan.commands[0], argv: ["fixture-tool"], executionEnvironment };
  const { raw: admittedEvidence, result: admittedBridge } = await executeWithHarnessEvidence(
    fixture, fixture.qualityResolver, admittedPlan,
    { dockerEngine: admittedDockerEngine(fixture, { failure: "authenticated chain-B runtime failure" }) },
  );
  assert.equal(admittedEvidence.provenance.workspace.kind, "isolated-copy");
  assert.equal(admittedEvidence.provenance.blocker.stage, "environment-execution");
  assert.equal(admittedBridge.summary.status, "ASSESSMENT_REQUIRED");
  const blockedAttempt = fixture.qualityResolver.materializeValidationAssessment(
    admittedBridge,
    assessmentFor(admittedBridge, {
      status: "BLOCKED", blockers: "DOCKER_START_FAILED: authenticated chain-B runtime failure",
      evidence: "Independent assessment authenticated the post-admission infrastructure failure.",
      persistenceSummary: "Formal BLOCKED attempt records the admitted infrastructure failure.",
    }),
  );
  assert.equal(blockedAttempt.persistence.recordId, "attempt-01");
  assert.equal(blockedAttempt.resolution.resolvingRecord, "attempt-01");
  readback = await stagePublishAndRead(t, fixture, fixture.qualityResolver, blockedAttempt, {
    expectedState: "VALIDATION_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").attempts[0].status, "BLOCKED");
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.state, "resolved");

  const passingPlan = planFor(fixture, {
    operation: "VALIDATE_SLICE", round: null, assessment: "independent", failureConclusion: "NONE",
  });
  passingPlan.commands = [passingPlan.commands[0], { ...passingPlan.commands[0], argv: ["false"] }];
  const passingBridge = await fixture.qualityResolver.executeValidationPlan(fixture.requirements, passingPlan);
  assert.equal(passingBridge.summary.status, "ASSESSMENT_REQUIRED");
  assert.equal(passingBridge.summary.commands[0].exit, 0, "the real installed harness must execute mandatory evidence");
  assert.equal(passingBridge.summary.commands[1].exit, 1);

  const ungated = fixture.qualityResolver.materializeValidationAssessment(
    passingBridge,
    assessmentFor(passingBridge, { persistenceSummary: "Insufficient PASS omitted the failed external gate classification." }),
  );
  const invalidCandidate = await terminalPassCandidate(t, fixture, "stnl ungated formal candidate ");
  await assert.rejects(
    fixture.qualityResolver.stageValidationBridgeResult(fixture.requirements, ungated, invalidCandidate.candidate),
    /exit zero unless every failure has a non-blocking gate assessment/u,
  );

  const gate = nonBlockingGate(passingBridge, passingBridge.summary.commands[1].display);
  const passedAttempt = fixture.qualityResolver.materializeValidationAssessment(
    passingBridge,
    assessmentFor(passingBridge, {
      gates: [gate], evidence: "Mandatory formal evidence passed; the separate nonzero command is independently non-blocking.",
      persistenceSummary: "PASS is bound to mandatory evidence plus a canonical independent Gate assessment.",
    }),
  );
  assert.equal(passedAttempt.persistence.recordId, "attempt-02");
  assert.match(passedAttempt.persistence.markdown, /Gate assessments/u);
  const completeCandidate = await terminalPassCandidate(t, fixture, "stnl chain B complete candidate ");
  const accepted = await fixture.qualityResolver.stageValidationBridgeResult(
    fixture.requirements, passedAttempt, completeCandidate.candidate,
  );
  assert.equal(accepted.state, "COMPLETE");
  await fs.copyFile(completeCandidate.taskFile, path.join(fixture.execution, "tasks/slice-01.md"));
  await fs.copyFile(completeCandidate.tasksFile, path.join(fixture.execution, "tasks.md"));
  readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "COMPLETE");
  assert.deepEqual(readback.tasks.get("slice-01").attempts.map((attempt) => attempt.status), ["BLOCKED", "PASS"]);
  assert.match(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8"), /### attempt-02\n\n- Type: revalidation/u);
  assert.equal(readback.tasks.get("slice-01").attempts[1].gates[0].decision, "non_blocking");
  assert.equal(readback.tasks.get("slice-01").attempts[1].provenance.priorEvidenceId, readback.tasks.get("slice-01").attempts[0].provenance.evidenceId);
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.state, "resolved");
});

test("auxiliary assessment preserves non-blocking Gate assessments and the original nonzero exit", async (t) => {
  const fixture = await installedFixture(t);
  const plan = planFor(fixture, { assessment: "independent", failureConclusion: "NONE" });
  plan.commands = [
    plan.commands[0],
    {
      ...plan.commands[0],
      argv: ["false"],
    },
  ];
  const bridge = await fixture.resolver.executeValidationPlan(fixture.requirements, plan);
  assert.equal(bridge.summary.status, "ASSESSMENT_REQUIRED");
  assert.equal(bridge.summary.commands[0].exit, 0);
  assert.equal(bridge.summary.commands[1].exit, 1);
  const gate = nonBlockingGate(bridge, bridge.summary.commands[1].display);
  const ungated = fixture.resolver.materializeValidationAssessment(
    bridge,
    assessmentFor(bridge, { persistenceSummary: "An insufficient assessment omitted the nonzero command classification." }),
  );
  await assert.rejects(
    fixture.resolver.stageValidationBridgeResult(
      fixture.requirements, ungated, await isolatedCandidate(t, fixture, "stnl ungated auxiliary candidate "),
    ),
    /exit zero unless every failure has a non-blocking gate assessment/u,
  );
  const assessed = fixture.resolver.materializeValidationAssessment(
    bridge,
    assessmentFor(bridge, { gates: [gate], persistenceSummary: "Mandatory evidence passed; the independent external gate remains non-blocking." }),
  );
  assert.equal(assessed.persistence.section, "Implementation Test Evidence");
  assert.match(assessed.persistence.markdown, /- Gate assessments: /u);
  assert.match(assessed.persistence.markdown, /`false` \| exit:1/u);
  const readback = await stagePublishAndRead(t, fixture, fixture.resolver, assessed, {
    expectedState: "IMPLEMENTED_AWAITING_VALIDATION",
  });
  const check = readback.tasks.get("slice-01").implementationChecks.at(-1);
  assert.equal(check.status, "TESTS_PASS");
  assert.equal(check.commands[1].exit, 1);
  assert.equal(check.gates[0].decision, "non_blocking");
});

test("formal blocker resolution is derived after assessment and changes only the authorized blocker", async (t) => {
  const fixture = await installedFixture(t);
  await publishActiveFinding(t, fixture);
  const blockedPlan = planFor(fixture, { operation: "VALIDATE_SLICE", round: null, assessment: "independent" });
  const { raw: preflight, result: blocked } = await executeWithHarnessEvidence(
    fixture, fixture.qualityResolver, blockedPlan, {}, { omitExecutionEnvironment: true },
  );
  assert.equal(preflight.provenance.workspace.kind, "pre-check");
  assert.equal(blocked.persistence.section, "Delegation Blocker");
  await stagePublishAndRead(t, fixture, fixture.qualityResolver, blocked, { expectedState: "RUNNER_RESULT_BLOCKED" });
  let readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.tasks.get("slice-01").findings[0].state, "active");
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.state, "active");

  const resumed = await fixture.qualityResolver.executeValidationPlan(fixture.requirements, blockedPlan);
  assert.equal(resumed.summary.status, "ASSESSMENT_REQUIRED");
  assert.equal(resumed.persistence, null);
  assert.equal(resumed.resolution, null, "execution alone must not resolve the blocker before assessment");
  const assessed = fixture.qualityResolver.materializeValidationAssessment(
    resumed,
    assessmentFor(resumed, {
      status: "BLOCKED", findingReferences: "finding-01", findingDispositions: "finding-01=active",
      blockers: "finding-01 remains active and requires a later correction",
      evidence: "The resumed harness evidence is valid, but the earlier implementation finding remains active.",
      persistenceSummary: "Formal BLOCKED revalidation preserves the active finding while resolving transport recovery.",
    }),
  );
  assert.equal(assessed.persistence.recordId, "attempt-02");
  assert.ok(assessed.resolution !== null, "assessment materialization must derive the blocker resolution");
  assert.equal(assessed.resolution.section, "Delegation Blocker");
  assert.equal(assessed.resolution.resolvingRecord, "attempt-02");

  readback = await stagePublishAndRead(t, fixture, fixture.qualityResolver, assessed, {
    expectedState: "VALIDATION_BLOCKED",
  });
  assert.equal(readback.tasks.get("slice-01").delegationBlocker.state, "resolved");
  assert.equal(readback.tasks.get("slice-01").attempts.at(-1).id, "attempt-02");
  assert.equal(readback.tasks.get("slice-01").findings[0].state, "active", "blocker resolution must not resolve another active record");
});

test("assessment summary exposes bounded command diagnostics tied to command and evidence identity", async (t) => {
  const fixture = await installedFixture(t);
  const executionEnvironment = await dockerPlanEnvironment(fixture);
  const secret = "stnl-known-secret-DO-NOT-LEAK";
  const plan = planFor(fixture, { assessment: "independent" });
  plan.commands = [
    { ...plan.commands[0], argv: ["mandatory-tool"], executionEnvironment },
    { ...plan.commands[0], argv: ["message-tool"], executionEnvironment },
    { ...plan.commands[0], argv: ["long-tool"], env: { STNL_TEST_SECRET: secret }, executionEnvironment },
    { ...plan.commands[0], argv: ["silent-tool"], executionEnvironment },
  ];
  const engine = admittedDockerEngine(fixture, {
    run: async ({ argv, environment }) => {
      const tool = path.basename(argv[0]);
      const stderr = tool === "message-tool" ? "OBSERVABLE_DIAGNOSTIC: external service refused the fixture\n"
        : tool === "long-tool" ? `${"x".repeat(12_000)}${environment.STNL_TEST_SECRET}\n`
          : "";
      const exit = tool === "mandatory-tool" ? 0 : tool === "silent-tool" ? 2 : tool === "message-tool" ? 9 : 8;
      return {
        exit, stdout: tool === "mandatory-tool" ? Buffer.from("mandatory check passed\n") : Buffer.alloc(0),
        stderr: Buffer.from(stderr), stderrForEvidence: Buffer.from(stderr), timedOut: false, signaled: false,
        sandboxViolation: false, sandboxEvents: [], sandboxOutcomeUncertain: false,
      };
    },
  });
  const { result: bridge } = await executeWithHarnessEvidence(fixture, fixture.resolver, plan, { dockerEngine: engine });
  assert.equal(bridge.summary.status, "ASSESSMENT_REQUIRED");

  const message = commandDiagnostic(bridge.summary.commands[1]);
  assert.match(message, /message-tool/u);
  assert.match(message, /OBSERVABLE_DIAGNOSTIC: external service refused the fixture/u);
  assert.match(message, new RegExp(bridge.summary.evidenceId, "u"));

  const truncated = commandDiagnostic(bridge.summary.commands[2]);
  assert.match(truncated, /long-tool/u);
  assert.match(truncated, /truncat/iu);
  assert.match(truncated, /redact/iu);
  assert.doesNotMatch(truncated, new RegExp(secret, "u"));
  assert.match(truncated, new RegExp(bridge.summary.evidenceId, "u"));
  assert.ok(Buffer.byteLength(truncated, "utf8") <= 4096, "one command diagnostic must stay compact");

  const silent = commandDiagnostic(bridge.summary.commands[3]);
  assert.match(silent, /silent-tool/u);
  assert.match(silent, /insufficient/iu, "missing output must not imply independent causality");
  assert.match(silent, new RegExp(bridge.summary.evidenceId, "u"));
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
