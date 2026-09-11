import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveNormalHandoff,
  deriveRecoveryTargets,
  evaluateQualityGate,
  qualityGateIdentity,
  EXECUTION_WORKFLOW_SKILLS,
  ExecutionContractError,
  computeRequirementsAuthority,
  inspectExecutionState,
  preflightExecutionOperation,
  repairExecutionContract,
  validateExecutionCandidate,
  workflowSkillForOperation,
} from "../skills/workflows/stnl-execution-closer/runtime/execution-state.mjs";
import { EXECUTION_OPERATION_SKILLS, WORKFLOW_OPERATIONS } from "./lib/skill-registry.mjs";
import { runValidationSession, validationSandboxBackend } from "../skills/workflows/stnl-slice-executor/runtime/run-validation-session.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILLS = [
  "stnl-execution-planner", "stnl-plan-reviewer", "stnl-task-materializer", "stnl-task-reviewer",
  "stnl-slice-executor", "stnl-slice-quality-manager", "stnl-execution-closer",
];

async function temporary(t, prefix = "stnl-execution-contract-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

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

async function copyDirectory(source, destination) {
  await fs.cp(source, destination, { recursive: true });
  return destination;
}

async function lifecycleExecutionFixture(t, fixtureName = "multi-slice") {
  const root = await temporary(t, "stnl-lifecycle-execution-");
  const source = path.join(ROOT, "skills/workflows/stnl-spec-test-runbook/runtime/test/fixtures", fixtureName);
  const workspace = await copyDirectory(source, path.join(root, fixtureName));
  return {
    root,
    requirements: path.join(workspace, "feature_spec.md"),
    execution: path.join(workspace, "execution"),
  };
}

async function setLifecycleRecordStatus(fixture, relativePath, identifier, status) {
  const file = path.join(path.dirname(fixture.requirements), relativePath);
  const source = await fs.readFile(file, "utf8");
  const recordStart = source.indexOf(`### ${identifier} — `);
  assert.notEqual(recordStart, -1, `fixture record is missing: ${identifier}`);
  const statusStart = source.indexOf("- status: ", recordStart);
  assert.notEqual(statusStart, -1, `fixture status is missing: ${identifier}`);
  const lineEnd = source.indexOf("\n", statusStart);
  assert.notEqual(lineEnd, -1, `fixture status line is unterminated: ${identifier}`);
  await fs.writeFile(file, `${source.slice(0, statusStart)}- status: ${status}${source.slice(lineEnd)}`, "utf8");
}

async function executionMarkdownFiles(execution) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === "__MACOSX" || entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(file);
    }
  }
  await visit(execution);
  return files.sort();
}

async function refreshExecutionAuthority(fixture, oldHash, newHash, { planningOnly = false } = {}) {
  const files = planningOnly
    ? [
      path.join(fixture.execution, "plan.md"),
      ...(await fs.readdir(path.join(fixture.execution, "plans"), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => path.join(fixture.execution, "plans", entry.name)),
    ]
    : await executionMarkdownFiles(fixture.execution);
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    if (source.includes(`sha256:${oldHash}`)) {
      await fs.writeFile(file, source.replaceAll(`sha256:${oldHash}`, `sha256:${newHash}`), "utf8");
    }
  }
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

async function renderTasks(fixture, { revision = 1, fingerprint = null, evidenceContract = false } = {}) {
  const authority = fingerprint ?? await computeRequirementsAuthority(fixture.requirements);
  const requirementsMetadata = await fs.stat(fixture.requirements);
  const authorityPath = requirementsMetadata.isDirectory() ? path.join(fixture.requirements, "feature_spec.md") : fixture.requirements;
  const detailSource = path.relative(path.join(fixture.execution, "plans"), authorityPath).split(path.sep).join("/");
  await fs.mkdir(path.join(fixture.execution, "tasks"), { recursive: true });
  const tasksTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/tasks.template.md"), "utf8");
  const tasks = replaceAll(tasksTemplate, [
    ["01 - <name>", "01 - Delivery"], ["<observable delivery>", "observable result"],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks.md"), tasks);
  const taskTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  let task = replaceAll(taskTemplate, [
    ["<Name>", "Delivery"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", String(revision)],
    ["<task>", "Implement behavior"], ["<result>", "observable result"], ["<areas>", "src/example.txt"],
    ["<test, command, suite, or observable check>", "node --test"],
  ]);
  if (!evidenceContract) task = task.replace("- Validation evidence contract: stnl-validation-evidence/v1\n", "");
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-01.md"), task);
}

async function renderArtifacts(fixture, { materialized = true, planStatus = "ready", revision = 1, fingerprint = null } = {}) {
  const authority = fingerprint ?? await computeRequirementsAuthority(fixture.requirements);
  const requirementsMetadata = await fs.stat(fixture.requirements);
  const authorityPath = requirementsMetadata.isDirectory() ? path.join(fixture.requirements, "feature_spec.md") : fixture.requirements;
  const globalSource = path.relative(fixture.execution, authorityPath).split(path.sep).join("/");
  const detailSource = path.relative(path.join(fixture.execution, "plans"), authorityPath).split(path.sep).join("/");
  await fs.mkdir(path.join(fixture.execution, "plans"), { recursive: true });
  const planTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  let global = omitInitialRecoveryFields(replaceAll(planTemplate, [
    ["`<relative path>`", `\`${globalSource}\``], ["sha256:<64hex>", `sha256:${authority}`],
    ["<positive integer>", String(revision)], ["<compact objective>", "Deliver observable behavior"],
    ["<compact strategy>", "Implement and validate serially"], ["01 - <name>", "01 - Delivery"],
    ["<result>", "observable result"], ["<areas>", "src/example.txt"],
  ]));
  if (planStatus === "ready") global = headerReady(global);
  await fs.writeFile(path.join(fixture.execution, "plan.md"), global);
  const slicePlanTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  let slicePlan = replaceAll(slicePlanTemplate, [
    ["<Name>", "Delivery"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", String(revision)],
    ["<One coherent outcome or milestone, how it is observed and validated, and why it is one boundary. Technical layers belong in Tasks.>", "Deliver observable behavior as one bounded milestone."],
    ["<included work>", "Implement the approved behavior."], ["<excluded work and boundary with later slices>", "No unrelated work."],
    ["<path, contract, subsystem, or test area>", "src/example.txt"], ["<earlier slice or none>", "none"],
    ["<risk and mitigation>", "Low risk; focused validation."], ["<bounded approach>", "One bounded change."],
    ["<test, command, suite, or observable check>", "node --test"], ["<objective result and preserved boundary>", "Behavior is observable and bounded."],
  ]);
  if (planStatus === "ready") slicePlan = headerReady(slicePlan);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-01.md"), slicePlan);
  if (!materialized) return { authority };
  await renderTasks(fixture, { revision, fingerprint: authority });
  return { authority };
}

async function editTask(fixture, transform) {
  const file = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(file, "utf8");
  await fs.writeFile(file, transform(before), "utf8");
}

async function editSliceTask(fixture, slice, transform) {
  const file = path.join(fixture.execution, "tasks", `${slice}.md`);
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

async function appendRecoveryPlan(fixture, oldHash, newHash, {
  ready = false,
  supersedes = "slice-01 -> slice-02",
  requirements = "AC-001",
} = {}) {
  await editPlan(fixture, (value) => {
    let result = reviseAuthority(value, oldHash, newHash, 1, 2).replace("status: ready", `status: ${ready ? "ready" : "draft"}`).replace("- Review state: approved", `- Review state: ${ready ? "approved" : "pending"}`);
    result = result.replace("- Objective: Deliver observable behavior", `- Revision mode: append-only-extension\n- Replan reason: requirements or operational authority changed\n- Supersedes open slices: ${supersedes}\n- Objective: Deliver observable behavior`);
    return result.replace(
      "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
      `| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |\n| 02 - Recovery | reconciled result | 01 | ${requirements} | src/example.txt | plans/slice-02.md |`,
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
    .replace(/^- none\.?$/mu, "- slice-01.")
    .replace(/(## Requirements\n\n)- AC-001(?=\n)/u, `$1- ${requirements.replaceAll(", ", "\n- ")}`)
    .replace("status: ready", `status: ${ready ? "ready" : "draft"}`)
    .replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-02.md"), appended, "utf8");
}

async function commitAppendRecovery(fixture, oldHash, newHash, { resolveDivergence = false, requirements = "AC-001" } = {}) {
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
    ["<task>", "Reconcile behavior"], ["<result>", "reconciled result"], ["<areas>", "src/example.txt"],
    ["<test, command, suite, or observable check>", "node --test"],
    ["requirement: AC-001", `requirement: ${requirements}`],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-02.md"), appended, "utf8");
}

async function addSecondPristineSlice(fixture) {
  await editPlan(fixture, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |\n| 02 - Later | later result | 01 | AC-001 | src/later.txt | plans/slice-02.md |",
  ));
  const plan = (await fs.readFile(path.join(fixture.execution, "plans/slice-01.md"), "utf8"))
    .replaceAll("Slice 01", "Slice 02").replaceAll("- Slice: 01", "- Slice: 02").replaceAll("Delivery", "Later")
    .replace(/^- none\.?$/mu, "- slice-01.");
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
      "| 02 - Recovery | reconciled result | 01 | AC-001 | src/example.txt | plans/slice-02.md |",
      "| 02 - Recovery | reconciled result | 01 | AC-001 | src/example.txt | plans/slice-02.md |\n| 03 - Recovery | reconciled result | 02 | AC-001 | src/example.txt | plans/slice-03.md |",
    ));
  let plan = await fs.readFile(path.join(fixture.execution, "plans/slice-02.md"), "utf8");
  plan = plan.replaceAll("Slice 02", "Slice 03").replaceAll("- Slice: 02", "- Slice: 03")
    .replace(/^- slice-01\.?$/mu, "- slice-02.")
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
    ["<task>", "Reconcile behavior again"], ["<result>", "reconciled result"], ["<areas>", "src/example.txt"],
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
    : `- Commands:\n  - \`node --test\` | exit:${["TESTS_PASS", "TESTS_ACCEPTED"].includes(status) ? 0 : 1}`;
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
  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}
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

function delegationBlocker(operation, kind, { state = "active", after = "none", pendingRound = null, resolution = null } = {}) {
  return `- Operation: ${operation}
- Kind: ${kind}
- State: ${state}
- After record: ${after}${pendingRound === null ? "" : `\n- Pending automatic round: ${pendingRound}/3`}
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
    if (skill !== "stnl-execution-closer") {
      assert.match(source, /validate-execution-state\.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>/u, skill);
      assert.match(source, /contract\/model(?:-| )(?:enforced|enforcement|owned)/u, skill);
      assert.match(source, /strict(?:ly)? read(?:back| back)/u, skill);
    }
    assert.match(source, /Findings IDs[\s\S]{0,180}Check discovery sources[\s\S]{0,80}Check discovery actions[\s\S]{0,240}--repair-known-contract/u, skill);
  }
});

test("actual templates render a machine-unambiguous MATERIALIZED_PRISTINE task", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const task = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  assert.doesNotMatch(task, /^### (?:implementation-check|findings-check|attempt)-/gmu);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_TASKS")).state, "MATERIALIZED_PRISTINE");
});

test("task quantity, files, layers, and context fit never create a semantic REPLAN", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const extraTasks = Array.from({ length: 24 }, (_, index) => {
    const number = index + 2;
    return `- [ ] 1.${number} Implement part ${number}. | observable result: part ${number} remains observable | expected areas: src/example.txt | requirement: AC-001`;
  }).join("\n");
  await editTask(fixture, (value) => value.replace("\n## Expected Tests", `\n${extraTasks}\n\n## Expected Tests`));
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, "MATERIALIZED_PRISTINE");
  assert.equal(state.legalOperations.some(({ operation }) => operation === "REPLAN"), true);
  assert.equal(state.requiredRecoveryHandoff, null);
});

test("outcome-oriented decomposition guidance is explicit, adversarial, and count-neutral", async () => {
  const paths = [
    "skills/workflows/stnl-execution-planner/SKILL.md",
    "skills/workflows/stnl-plan-reviewer/SKILL.md",
    "skills/workflows/stnl-task-materializer/SKILL.md",
    "skills/workflows/stnl-task-reviewer/SKILL.md",
    "skills/workflows/stnl-execution-planner/evals/eval-plan.md",
    "skills/workflows/stnl-plan-reviewer/evals/eval-plan.md",
    "skills/workflows/stnl-task-materializer/evals/eval-plan.md",
    "skills/workflows/stnl-task-reviewer/evals/eval-plan.md",
  ];
  const documents = await Promise.all(paths.map((file) => fs.readFile(path.join(ROOT, file), "utf8")));
  const combined = documents.join("\n");
  for (const phrase of [
    /smallest cohesive, observable, and validatable milestone/u,
    /Business.*UX\/Design.*Architecture.*Engineering/u,
    /agent\/context limits/u,
    /Foundation/u,
    /Integration\/Stabilization/u,
    /SPEC boundary/u,
    /split.*merge.*reorder/u,
    /coverage/u,
    /circular/u,
    /late semantic boundary gate/u,
    /NEEDS_REPLAN/u,
  ]) assert.match(combined, phrase);
  assert.doesNotMatch(combined, /\b(?:maxSlices|minSlices|targetSlices)\b/u);
  assert.doesNotMatch(combined, /(?:ideal|preferred)\s+(?:minimum|maximum|target)?\s*(?:number|count)\s+of\s+Slices/iu);

  const representative = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-spec-test-runbook/runtime/test/fixtures/representative/execution/plan.md"), "utf8");
  assert.equal((representative.match(/^\| [0-9]{2} - /gmu) ?? []).length, 1);
  const multiSlice = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-spec-test-runbook/runtime/test/fixtures/multi-slice/execution/plan.md"), "utf8");
  assert.match(multiSlice, /Verify Delivery Telemetry/iu);
  assert.match(multiSlice, /\| 02 - Verify Delivery Telemetry \|[\s\S]*\| R-003 \|/u);
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
});

test("RESUME remains lifecycle recovery authority before execution REPLAN is derived", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const lifecycleDivergence = ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: RESUME");
  await editTask(fixture, (value) => replaceSection(value, "Divergences", lifecycleDivergence));
  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "DIVERGENCE_BLOCKED");
  assert.deepEqual(blocked.legalOperations, [{ operation: "EXECUTE_SLICE", slice: "slice-01" }]);
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
  assert.deepEqual(blocked.recoveryTargets.filter(({ owner }) => owner === "lifecycle").map(({ record }) => record), ["divergence-01", "divergence-02"]);
  assert.deepEqual(blocked.legalOperations, [{ operation: "EXECUTE_SLICE", slice: "slice-01" }]);
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
    path.join(ROOT, "skills/workflows/stnl-execution-closer/runtime/validate-execution-state.mjs"),
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
      "- <global risk, cross-slice boundary, or explicitly required independent operational milestone>",
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
  for (const [operation, slice] of [["VALIDATE_SLICE", "1"], ["CLOSE", null], ["DELETE", null]]) {
    await assert.rejects(preflightExecutionOperation(fixture.requirements, operation, slice), (error) => {
      assert.equal(error.contractViolation.repairability, "mechanical");
      return true;
    });
    assert.deepEqual(await fs.readFile(taskPath), before, `${operation} preflight mutated live execution`);
  }
  const repair = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-execution-closer/runtime/validate-execution-state.mjs"),
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
  const readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(readback.tasks.get("slice-01").implementationChecks.at(-1).status, "TESTS_PASS");
});

test("auxiliary runner output contract round-trips through model-owned persistence and derived state", async (t) => {
  const contracts = await Promise.all([
    fs.readFile(path.join(ROOT, "templates/subagents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8"),
    fs.readFile(path.join(ROOT, "templates/subagents/codex/.codex/agents/stnl_validation_runner.toml"), "utf8"),
  ]);
  const persisted = checkRecord("implementation-check", 1, "TESTS_PASS", 1);
  for (const [runnerField, recordField] of [
    ["Automatic check round:", "- Automatic check round: 1/3"],
    ["Status:", "- Status: TESTS_PASS"],
    ["Escopo verificado:", "- Tested scope: ../../src/example.txt"],
    ["Estado testado:", "- Tested state:"],
    ["Discovery sources:", "- Discovery sources:"],
    ["Discovery actions:", "- Discovery actions:"],
    ["Verification types considered:", "- Verification types considered:"],
    ["Comandos executados:", "- Commands:"],
    ["Testes selecionados:", "- Selected checks:"],
  ]) {
    for (const contract of contracts) assert.ok(contract.includes(runnerField), runnerField);
    assert.ok(persisted.includes(recordField), recordField);
  }
  assert.match(persisted, /^- Tested scope: \S.*$/mu);
  assert.match(persisted, /^- Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}$/mu);
  assert.match(persisted, /^- Commands:\n  - `[^`]+` \| exit:0$/mu);
  assert.doesNotMatch(persisted, /^- Fileless reason:/mu);
  for (const contract of contracts) {
    assert.match(contract, /Fileless reason: required only when Estado testado is exactly none; omit for file-backed state/u);
    assert.match(contract, /Fileless reason: required only when Manifesto final da slice is exactly none; omit for file-backed manifest/u);
  }
  const filelessPersisted = persisted.replace(
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}`,
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

test("formal validation output round-trips through NEEDS_FIX, correction, PASS, base, final, and handoff", async (t) => {
  const runnerContract = await fs.readFile(path.join(ROOT, "templates/subagents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  for (const fieldName of ["Tipo de validação:", "Status: PASS | ACCEPTED | NEEDS_FIX | BLOCKED", "Manifesto final da slice:", "Evidências:", "Findings:"]) {
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
  assert.equal(deriveNormalHandoff(complete, "VALIDATE_SLICE").operation, "CLOSE");
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
    "stnl-execution-closer", "stnl-slice-executor", "stnl-slice-quality-manager", "stnl-task-materializer",
  ].map((skill) => path.join(ROOT, `skills/workflows/${skill}/references/execution-record-schema.md`));
  const schemas = await Promise.all(schemaPaths.map((schemaPath) => fs.readFile(schemaPath, "utf8")));
  for (const schema of schemas.slice(1)) assert.equal(schema, schemas[0]);
  for (const rule of [
    /Scalar summaries are compact opaque inline values/u,
    /`Finding IDs` is one non-empty lexicographically ordered set/u,
    /exact `Tested state: none`[\s\S]{0,120}`Fileless reason`/u,
    /exact historical pair `Check discovery sources` \/ `Check discovery actions`/u,
    /At most one current base exists and it originates from the current `PASS` or `ACCEPTED` attempt/u,
    /`Finding references` uses exact `none` or `finding-NN, finding-NN`/u,
    /`Finding dispositions` uses exact `none` or `finding-NN=(?:active\|resolved\|superseded), finding-NN=(?:active\|resolved\|superseded)`/u,
    /`Findings verified` is exact `none` or a canonical subset of `Finding IDs`/u,
    /`Unsupported active findings` is deterministically every active finding at the named cycle not present in `Findings verified`/u,
    /file-backed `Correction paths` is an exact comma-space-delimited normalized ordered set, while exact `none` is permitted only for the corresponding fileless correction/u,
    /In `TESTS_PASS` or `TESTS_ACCEPTED`, exact `none` is forbidden specifically for `Tested scope`, `Verification types considered`, `Selected checks`, and `Coverage`/u,
    /Candidate validation rejects terminal implementation evidence with an incomplete checklist/u,
    /exactly one mandatory target, `stnl-slice-executor \/ EXECUTE_SLICE \/ <affected slice>`/u,
    /The first `PASS` or `ACCEPTED` attempt is terminal/u,
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
  await assert.rejects(inspectExecutionState(duplicate.requirements), /duplicate section/u);

  const unknown = await standaloneWorkspace(t);
  await renderArtifacts(unknown);
  await editTask(unknown, (value) => value.replace("## Final Result", "## Unknown Operational State\n\n- none\n\n## Final Result"));
  await assert.rejects(inspectExecutionState(unknown.requirements), /non-canonical sections/u);
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

test("lifecycle planning coverage preserves requirements without ACs and avoids double counting AC coverage", async (t) => {
  const planningOnly = async () => {
    const fixture = await lifecycleExecutionFixture(t);
    await fs.rm(path.join(fixture.execution, "tasks.md"), { force: true });
    await fs.rm(path.join(fixture.execution, "tasks"), { recursive: true, force: true });
    return fixture;
  };

  const complete = await planningOnly();
  assert.equal((await inspectExecutionState(complete.requirements)).state, "PLANNED_READY");

  const missingGlobal = await planningOnly();
  await editPlan(missingGlobal, (value) => value.replace(
    /(\| 02 - Verify Delivery Telemetry \| [^|]+ \| slice-01 \| )R-003( \|)/u,
    "$1AC-002$2",
  ));
  await assert.rejects(inspectExecutionState(missingGlobal.requirements), /detailed plan Requirements disagree/u);

  const missingDetailed = await planningOnly();
  await editSlicePlan(missingDetailed, "slice-02", (value) => value.replace("- R-003", "- AC-002"));
  await assert.rejects(inspectExecutionState(missingDetailed.requirements), /detailed plan Requirements disagree/u);

  const missingEverywhere = await planningOnly();
  await editPlan(missingEverywhere, (value) => value.replace(
    /(\| 02 - Verify Delivery Telemetry \| [^|]+ \| slice-01 \| )R-003( \|)/u,
    "$1AC-002$2",
  ));
  await editSlicePlan(missingEverywhere, "slice-02", (value) => value.replace("- R-003", "- AC-002"));
  await assert.rejects(inspectExecutionState(missingEverywhere.requirements), /current plan coverage omits authority R-003/u);
});

test("task authority references are canonical, Slice-scoped, and coverage-preserving", async (t) => {
  const valid = await lifecycleExecutionFixture(t);
  assert.equal((await inspectExecutionState(valid.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const nonexistentAcceptance = await lifecycleExecutionFixture(t);
  await editSliceTask(nonexistentAcceptance, "slice-02", (value) => value.replace("requirement: R-003", "requirement: AC-999"));
  await assert.rejects(inspectExecutionState(nonexistentAcceptance.requirements), /slice-02 references unknown authority AC-999/u);

  const nonexistentRequirement = await lifecycleExecutionFixture(t);
  await editSliceTask(nonexistentRequirement, "slice-02", (value) => value.replace("requirement: R-003", "requirement: R-999"));
  await assert.rejects(inspectExecutionState(nonexistentRequirement.requirements), /slice-02 references unknown authority R-999/u);

  const crossSlice = await lifecycleExecutionFixture(t);
  await editSliceTask(crossSlice, "slice-02", (value) => value.replace("requirement: R-003", "requirement: AC-001"));
  await assert.rejects(inspectExecutionState(crossSlice.requirements), /slice-02 references authority AC-001 outside approved Slice coverage/u);

  const lostCoverage = await lifecycleExecutionFixture(t);
  await editSliceTask(lostCoverage, "slice-01", (value) => value.replace(/^- \[x\] 1\.2 .*$/mu, ""));
  await assert.rejects(inspectExecutionState(lostCoverage.requirements), /slice-01 task coverage omits authority AC-002/u);

  const oneTaskCoversMultiple = await lifecycleExecutionFixture(t);
  await editSliceTask(oneTaskCoversMultiple, "slice-01", (value) => {
    const withoutSecondTask = value.replace(/^- \[x\] 1\.2 .*$/mu, "");
    return withoutSecondTask.replace("requirement: AC-001", "requirement: AC-001, AC-002");
  });
  assert.equal((await inspectExecutionState(oneTaskCoversMultiple.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const repeatedAuthority = await lifecycleExecutionFixture(t, "representative");
  assert.equal((await inspectExecutionState(repeatedAuthority.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("current lifecycle planning coverage accepts active R and AC references but rejects known inactive authorities", async (t) => {
  const planningOnly = async () => {
    const fixture = await lifecycleExecutionFixture(t);
    await fs.rm(path.join(fixture.execution, "tasks.md"), { force: true });
    await fs.rm(path.join(fixture.execution, "tasks"), { recursive: true, force: true });
    return fixture;
  };

  const active = await planningOnly();
  assert.equal((await inspectExecutionState(active.requirements)).state, "PLANNED_READY");

  const inactiveDetailed = await planningOnly();
  const detailedOldHash = await computeRequirementsAuthority(inactiveDetailed.requirements);
  await setLifecycleRecordStatus(inactiveDetailed, "shared/requirements.md", "R-003", "out_of_scope");
  const detailedNewHash = await computeRequirementsAuthority(inactiveDetailed.requirements);
  await refreshExecutionAuthority(inactiveDetailed, detailedOldHash, detailedNewHash);
  await editPlan(inactiveDetailed, (value) => value.replace(
    /(\| 02 - Verify Delivery Telemetry \| [^|]+ \| slice-01 \| )R-003( \|)/u,
    "$1AC-002$2",
  ));
  await assert.rejects(
    inspectExecutionState(inactiveDetailed.requirements),
    /slice-02 detailed plan Requirements disagree with Serial Slice Order/u,
  );

  const unknown = await planningOnly();
  await editPlan(unknown, (value) => value.replace(
    /(\| 02 - Verify Delivery Telemetry \| [^|]+ \| slice-01 \| )R-003( \|)/u,
    "$1R-999$2",
  ));
  await editSlicePlan(unknown, "slice-02", (value) => value.replace("- R-003", "- R-999"));
  await assert.rejects(inspectExecutionState(unknown.requirements), /current plan references unknown authority R-999/u);

  for (const status of ["out_of_scope", "retired", "superseded"]) {
    const fixture = await planningOnly();
    const oldHash = await computeRequirementsAuthority(fixture.requirements);
    await setLifecycleRecordStatus(fixture, "shared/requirements.md", "R-003", status);
    const newHash = await computeRequirementsAuthority(fixture.requirements);
    await refreshExecutionAuthority(fixture, oldHash, newHash);
    await assert.rejects(
      inspectExecutionState(fixture.requirements),
      new RegExp(`current plan references inactive authority R-003`, "u"),
    );
  }

  for (const status of ["dropped", "retired", "superseded"]) {
    const fixture = await planningOnly();
    const oldHash = await computeRequirementsAuthority(fixture.requirements);
    await setLifecycleRecordStatus(fixture, "shared/acceptance-criteria.md", "AC-002", status);
    const newHash = await computeRequirementsAuthority(fixture.requirements);
    await refreshExecutionAuthority(fixture, oldHash, newHash);
    await assert.rejects(
      inspectExecutionState(fixture.requirements),
      new RegExp(`current plan references inactive authority AC-002`, "u"),
    );
  }
});

test("current lifecycle Task coverage rejects known inactive authority without changing active, unknown, or cross-Slice rules", async (t) => {
  const active = await lifecycleExecutionFixture(t);
  assert.equal((await inspectExecutionState(active.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const inactive = await lifecycleExecutionFixture(t);
  const oldHash = await computeRequirementsAuthority(inactive.requirements);
  await setLifecycleRecordStatus(inactive, "shared/requirements.md", "R-003", "out_of_scope");
  const newHash = await computeRequirementsAuthority(inactive.requirements);
  await refreshExecutionAuthority(inactive, oldHash, newHash);
  await editPlan(inactive, (value) => value.replace(
    "| 02 - Verify Delivery Telemetry | Delivery telemetry is emitted and verified as an independent observability milestone after acceptance. | slice-01 | R-003 | telemetry instrumentation and automated checks | plans/slice-02.md |",
    "| 02 - Verify Delivery Telemetry | Delivery telemetry is emitted and verified as an independent observability milestone after acceptance. | slice-01 | AC-002 | telemetry instrumentation and automated checks | plans/slice-02.md |",
  ));
  await editSlicePlan(inactive, "slice-02", (value) => value.replace("- R-003", "- AC-002"));
  await assert.rejects(inspectExecutionState(inactive.requirements), /slice-02 references inactive authority R-003/u);
});

test("current fingerprint validation rejects inactive coverage while stale historical references remain append-only", async (t) => {
  const historical = await lifecycleExecutionFixture(t);
  const historicalHash = await computeRequirementsAuthority(historical.requirements);
  await setLifecycleRecordStatus(historical, "shared/requirements.md", "R-003", "out_of_scope");
  const historicalState = await inspectExecutionState(historical.requirements);
  assert.equal(historicalState.state, "REQUIREMENTS_CHANGED");
  assert.equal(historicalState.stale, true);
  assert.equal(historicalState.globalPlan.fingerprint, historicalHash);

  const currentReplan = await lifecycleExecutionFixture(t);
  const oldHash = await computeRequirementsAuthority(currentReplan.requirements);
  await setLifecycleRecordStatus(currentReplan, "shared/requirements.md", "R-003", "out_of_scope");
  const newHash = await computeRequirementsAuthority(currentReplan.requirements);
  await refreshExecutionAuthority(currentReplan, oldHash, newHash, { planningOnly: true });
  await editPlan(currentReplan, (value) => value
    .replace("- Plan revision: 1", "- Plan revision: 2")
    .replace(
      "- Objective: Deliver invitation acceptance and complete the explicit delivery-telemetry verification milestone for that flow.",
      "- Revision mode: append-only-extension\n- Replan reason: requirements authority changed\n- Supersedes open slices: none\n- Objective: Deliver invitation acceptance and complete the explicit delivery-telemetry verification milestone for that flow.",
    ));
  await editSlicePlan(currentReplan, "slice-01", (value) => value.replace("Plan revision: 1", "Plan revision: 2"));
  await editSlicePlan(currentReplan, "slice-02", (value) => value.replace("Plan revision: 1", "Plan revision: 2"));
  await assert.rejects(inspectExecutionState(currentReplan.requirements), /current plan references inactive authority R-003/u);
});

test("plan coverage and dependency transformations remain canonical across split, merge, and reorder", async (t) => {
  const split = await standaloneWorkspace(t);
  await fs.appendFile(split.requirements, "\n- AC-002: independent observable behavior\n", "utf8");
  await renderArtifacts(split);
  await addSecondPristineSlice(split);
  await editPlan(split, (value) => value.replace(
    "| 02 - Later | later result | 01 | AC-001 | src/later.txt | plans/slice-02.md |",
    "| 02 - Later | later result | 01 | AC-002 | src/later.txt | plans/slice-02.md |",
  ));
  await editSlicePlan(split, "slice-02", (value) => value.replace("## Requirements\n\n- AC-001", "## Requirements\n\n- AC-002"));
  await editSliceTask(split, "slice-02", (value) => value.replace("requirement: AC-001", "requirement: AC-002"));
  assert.equal((await inspectExecutionState(split.requirements)).state, "MATERIALIZED_PRISTINE");

  const merge = await standaloneWorkspace(t);
  const { authority: oldMergeAuthority } = await renderArtifacts(merge, { materialized: false });
  await fs.appendFile(merge.requirements, "\n- AC-002: merged observable behavior\n", "utf8");
  const newMergeAuthority = await computeRequirementsAuthority(merge.requirements);
  await editPlan(merge, (value) => reviseAuthority(value, oldMergeAuthority, newMergeAuthority, 1, 1)
    .replace("| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |", "| 01 - Delivery | observable result | - | AC-001, AC-002 | src/example.txt | plans/slice-01.md |"));
  await editSlicePlan(merge, "slice-01", (value) => reviseAuthority(value, oldMergeAuthority, newMergeAuthority, 1, 1)
    .replace("## Requirements\n\n- AC-001", "## Requirements\n\n- AC-001\n- AC-002"));
  assert.equal((await inspectExecutionState(merge.requirements)).state, "PLANNED_READY");

  const reorder = await standaloneWorkspace(t);
  await fs.appendFile(reorder.requirements, "\n- AC-002: reordered observable behavior\n", "utf8");
  await renderArtifacts(reorder);
  await addSecondPristineSlice(reorder);
  await editPlan(reorder, (value) => value
    .replace("| 02 - Later | later result | 01 | AC-001 | src/later.txt | plans/slice-02.md |", "| 02 - Later | later result | - | AC-002 | src/later.txt | plans/slice-02.md |")
    .replace("| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |\n| 02 - Later | later result | - | AC-002 | src/later.txt | plans/slice-02.md |", "| 02 - Later | later result | - | AC-002 | src/later.txt | plans/slice-02.md |\n| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |"));
  await editSlicePlan(reorder, "slice-02", (value) => value.replace("## Requirements\n\n- AC-001", "## Requirements\n\n- AC-002").replace("## Dependencies\n\n- slice-01", "## Dependencies\n\n- none"));
  await editSliceTask(reorder, "slice-02", (value) => value.replace("requirement: AC-001", "requirement: AC-002"));
  await editTasksIndex(reorder, (value) => value
    .replace("| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |", "| [ ] | 02 - Later | later result | - | tasks/slice-02.md | pending | pending |")
    .replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |\n| [ ] | 02 - Later | later result | - | tasks/slice-02.md | pending | pending |", "| [ ] | 02 - Later | later result | - | tasks/slice-02.md | pending | pending |\n| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |"));
  assert.equal((await inspectExecutionState(reorder.requirements)).state, "MATERIALIZED_PRISTINE");

  const circular = await standaloneWorkspace(t);
  await renderArtifacts(circular);
  await addSecondPristineSlice(circular);
  await editPlan(circular, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
    "| 01 - Delivery | observable result | 02 | AC-001 | src/example.txt | plans/slice-01.md |",
  ));
  await assert.rejects(inspectExecutionState(circular.requirements), /circular dependency/u);

  const future = await standaloneWorkspace(t);
  await renderArtifacts(future);
  await addSecondPristineSlice(future);
  await editPlan(future, (value) => value
    .replace("| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |", "| 01 - Delivery | observable result | 02 | AC-001 | src/example.txt | plans/slice-01.md |")
    .replace("| 02 - Later | later result | 01 | AC-001 | src/later.txt | plans/slice-02.md |", "| 02 - Later | later result | - | AC-001 | src/later.txt | plans/slice-02.md |"));
  await assert.rejects(inspectExecutionState(future.requirements), /must appear earlier/u);

  const taskDependency = await standaloneWorkspace(t);
  await renderArtifacts(taskDependency);
  await addSecondPristineSlice(taskDependency);
  await editTasksIndex(taskDependency, (value) => value.replace(
    "| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |",
    "| [ ] | 02 - Later | later result | - | tasks/slice-02.md | pending | pending |",
  ));
  await assert.rejects(inspectExecutionState(taskDependency.requirements), /task index Dependencies disagree/u);
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

  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await replacePlanningOnly(fixture, oldHash, newHash);
  await editPlan(fixture, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001, AC-002 | src/example.txt | plans/slice-01.md |",
  ));
  await editSlicePlan(fixture, "slice-01", (value) => value.replace("## Requirements\n\n- AC-001", "## Requirements\n\n- AC-001\n- AC-002"));
  const replacement = await inspectExecutionState(fixture.requirements);
  assert.equal(replacement.state, "PLANNED_DRAFT");
  assert.equal(replacement.globalPlan.revision, 1);
  assert.equal(replacement.globalPlan.revisionMode, null);
  await editPlan(fixture, (value) => setPlanReviewState(value, true));
  await editSlicePlan(fixture, "slice-01", (value) => setPlanReviewState(value, true));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PLANNED_READY");
  await renderTasks(fixture, { revision: 1, fingerprint: newHash });
  await editTask(fixture, (value) => value.replace("requirement: AC-001", "requirement: AC-001, AC-002"));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
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
  await editPlan(fixture, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001, AC-002 | src/example.txt | plans/slice-01.md |",
  ));
  await editSlicePlan(fixture, "slice-01", (value) => value.replace("## Requirements\n\n- AC-001", "## Requirements\n\n- AC-001\n- AC-002"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-01", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  await editTask(fixture, (value) => reviseAuthority(value, oldHash, newHash, 1, 2));
  await editTask(fixture, (value) => value.replace("requirement: AC-001", "requirement: AC-001, AC-002"));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("pending REPLAN requires canonical fields, one revision increment, and valid supersession mappings", async (t) => {
  async function pending({ authorityChange = false } = {}) {
    const fixture = await standaloneWorkspace(t);
    const { authority: oldHash } = await renderArtifacts(fixture);
    if (authorityChange) await fs.appendFile(fixture.requirements, "- AC-002: revised authority\n");
    const newHash = await computeRequirementsAuthority(fixture.requirements);
    await appendRecoveryPlan(fixture, oldHash, newHash, { requirements: authorityChange ? "AC-001, AC-002" : "AC-001" });
    return fixture;
  }

  const missingReason = await pending();
  await editPlan(missingReason, (value) => value.replace(/^- Replan reason:.*\n/mu, ""));
  await assert.rejects(inspectExecutionState(missingReason.requirements), /Replan reason/u);

  const placeholderReason = await pending();
  await editPlan(placeholderReason, (value) => value.replace("- Replan reason: requirements or operational authority changed", "- Replan reason: pending"));
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
  assert.equal((await preflightExecutionOperation(fixture.requirements, "CLOSE")).state, "COMPLETE");
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
  for (const [operation, slice] of [["EXECUTE_SLICE", "2"], ["VALIDATE_SLICE", "1"], ["REPLAN", null], ["CLOSE", null]]) {
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
  await appendRecoveryPlan(fixture, oldHash, newHash, { requirements: "AC-001, AC-002" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-02", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  await commitAppendRecovery(fixture, oldHash, newHash, { resolveDivergence: true, requirements: "AC-001, AC-002" });
  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "EXECUTION_STARTED");
  assert.equal(recovered.tasks.get("slice-01").divergences[0].state, "resolved");
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

test("a later missing corrective milestone has an executable append-only REPLAN path", async (t) => {
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
});

test("superseded historical paths become closable only through a later current-authority PASS", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Changed Areas", "- `../../src/example.txt`"));
  await fs.appendFile(fixture.requirements, "- AC-002: corrective authority\n");
  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await appendRecoveryPlan(fixture, oldHash, newHash, { ready: true, requirements: "AC-001, AC-002" });
  await commitAppendRecovery(fixture, oldHash, newHash, { requirements: "AC-001, AC-002" });
  const second = path.join(fixture.execution, "tasks/slice-02.md");
  let task = await fs.readFile(second, "utf8");
  task = task.replace("- [ ] 1.1", "- [x] 1.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Validation Attempts", PASS_ATTEMPT);
  task = replaceSection(task, "Effective Validation Base", PASS_BASE);
  task = publishPassResult(task);
  // This legacy-history ownership fixture predates harness provenance; new
  // candidate materialization is separately required to retain v1.
  task = task.replace("- Validation evidence contract: stnl-validation-evidence/v1\n", "");
  await fs.writeFile(second, task);
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |", "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | PASS | PASS |"));
  await writeValidatedPath(fixture);
  const complete = await inspectExecutionState(fixture.requirements);
  assert.deepEqual(new Set(complete.legalOperations.map(({ operation }) => operation)), new Set(["CLOSE", "REPLAN"]));
  assert.equal(complete.normalHandoff.invocation, "OPERATION=CLOSE");
  assert.equal(complete.normalHandoff.invocation.startsWith("MODE="), false);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "CLOSE")).state, "COMPLETE");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "COMPLETE", "CLOSE recovery must permit a corrective replan from COMPLETE");
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
  await commitThirdRecovery(fixture, authority);
  const committed = await inspectExecutionState(fixture.requirements);
  assert.equal(committed.state, "EXECUTION_STARTED");
  assert.equal(committed.tasks.get("slice-01").final.planRevision, 2);
  assert.equal(committed.tasks.get("slice-02").final.planRevision, 3);

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
  await assert.rejects(inspectExecutionState(pendingPass.requirements), /latest successful validation attempt was not published atomically/u);

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
    .replace(`- Tested state:\n  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}`, "- Tested state: none\n- Fileless reason: no repository file participates in the observable configuration state");
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
  assert.equal((await preflightExecutionOperation(valid.requirements, "CLOSE")).state, "COMPLETE");

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
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}`,
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
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}`,
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
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |\n| malformed serial row |",
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
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |\nmalformed serial row without pipes",
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
    "- [ ] 1.1 Implement behavior | observable result: observable result | expected areas: src/example.txt | requirement: AC-001",
    "- [ ] 1.1 Implement behavior | observable result: observable result | expected areas: src/example.txt | requirement: AC-001\n- [ ] malformed checklist row",
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
      `  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}`,
      `  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}\n  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}`,
    ), /duplicate Tested state paths/u],
    [(record) => record.replace(
      `  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}`,
      `  - \`../../src/z.txt\` | sha256:${"b".repeat(64)}\n  - \`../../src/a.txt\` | sha256:${"b".repeat(64)}`,
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
      .replace(`- Tested state:\n  - \`../../src/example.txt\` | sha256:${"b".repeat(64)}`, "- Tested state: none\n- Fileless reason:   ");
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
  await assert.rejects(inspectExecutionState(passPass.requirements), /attempt-01 PASS\/ACCEPTED is terminal/u);

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
  await assert.rejects(inspectExecutionState(passNeedsFix.requirements), /attempt-01 PASS\/ACCEPTED is terminal/u);
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
  await assert.rejects(inspectExecutionState(pendingDiff.requirements), /terminal PASS\/ACCEPTED requires a non-placeholder Diff Summary/u);

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
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "REPLAN"), /revalidate the blocker first/u);

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

test("CLOSE verifies real final-owner hashes, removals, and changed-path ownership", async (t) => {
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
  assert.equal((await preflightExecutionOperation(matching.requirements, "CLOSE")).state, "COMPLETE");
  await fs.writeFile(target, "drifted behavior\n");
  await assert.rejects(preflightExecutionOperation(matching.requirements, "CLOSE"), /final validation ownership does not match/u);

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
  assert.equal((await preflightExecutionOperation(removed.requirements, "CLOSE")).state, "COMPLETE");
  await writeValidatedPath(removed, "../../src/removed.txt");
  await assert.rejects(preflightExecutionOperation(removed.requirements, "CLOSE"), (error) => error instanceof ExecutionContractError && error.findings.some((item) => item.includes("expected REMOVED")));

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

test("lifecycle CLOSE trusts repository-owned paths outside a nested SPEC and rejects repository escape", async (t) => {
  const root = await temporary(t);
  const repository = path.join(root, "repository");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const workspace = await copyDirectory(
    path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"),
    path.join(repository, "specs/feature"),
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
  assert.equal((await preflightExecutionOperation(workspace, "CLOSE")).state, "COMPLETE");
  const candidate = await copyDirectory(fixture.execution, path.join(root, "nested-lifecycle-candidate"));
  assert.equal((await validateExecutionCandidate(workspace, candidate)).state, "COMPLETE");

  const escapedPath = path.join(root, "escaped.txt");
  const escapedRelative = path.relative(taskDirectory, escapedPath).split(path.sep).join("/");
  await fs.writeFile(escapedPath, VALIDATED_CONTENT);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", `- \`${escapedRelative}\``);
    result = replaceSection(result, "Effective Validation Base", passBase({ relative: escapedRelative }));
    return result;
  });
  await assert.rejects(preflightExecutionOperation(workspace, "CLOSE"), /unsafe validation-owned path/u);
});

// Shared gate/recovery acceptance scenarios. These fixtures use a real failing
// command and uncommitted file edits; no product language/tool is special-cased.
async function qualityFixture(t) {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture);
  fixture.gateAuthority = { fingerprint: authority, revision: 1, slice: "slice-01" };
  await writeValidatedPath(fixture);
  await writeValidatedPath(fixture, "../../src/external.txt", "broken\n");
  await fs.writeFile(path.join(fixture.root, "check.mjs"), 'import fs from "node:fs"; process.exit(fs.readFileSync("src/external.txt", "utf8").trim() === "fixed" ? 0 : 1);\n');
  await editTask(fixture, (value) => replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- `../../src/example.txt`"));
  return fixture;
}

async function observeGate(fixture, overrides = {}) {
  const exit = spawnSync(process.execPath, ["check.mjs"], { cwd: fixture.root }).status;
  const content = await fs.readFile(path.join(fixture.root, "src/external.txt"));
  const gate = {
    id: "gate-01", command: "node check.mjs", kind: "quality", scope: "out_of_scope",
    causality: "independent", state: exit === 0 ? "absent" : "present",
    problem: "External style debt", evidence: "Baseline and current diagnostic match; the unchanged consumer has no dependency on the slice contract.",
    diagnostic: `sha256:${createHash("sha256").update("external style rule diagnostic").digest("hex")}`,
    correction: "in_scope", correctionEvidence: "Slice obligations are independently validated by the focused check.",
    revalidates: null,
    snapshot: [{ path: "../../src/external.txt", expected: `sha256:${createHash("sha256").update(content).digest("hex")}` }],
    bypass: null, ...overrides,
  };
  return { gate, exit };
}

function gateAttempt(number, status, gates, exit, options = {}) {
  return attemptRecord(number, status, options)
    .replace(/- Commands:(?: none|\n  - `[^`]+` \| exit:0)/u, `- Commands:\n  - \`node --test\` | exit:0\n  - \`node check.mjs\` | exit:${exit}`)
    + `\n- Gate assessments: ${JSON.stringify(gates)}`;
}

async function persistQualityAttempt(fixture, record, { status = "BLOCKED", findingText = null, divergenceText = null } = {}) {
  await editTask(fixture, (value) => {
    const old = value.match(/## Validation Attempts\n\n([\s\S]*?)(?=\n## )/u)[1].trim();
    let result = replaceSection(value, "Validation Attempts", old === "- none" ? record : `${old}\n\n${record}`);
    if (findingText !== null) result = replaceSection(result, "Validation Findings", findingText);
    if (divergenceText !== null) result = replaceSection(result, "Divergences", divergenceText);
    if (["PASS", "ACCEPTED"].includes(status)) {
      const number = Number(record.match(/^### attempt-([0-9]+)/u)[1]);
      const commands = record.match(/- Commands:\n([\s\S]*?)(?=\n- Evidence:)/u)[1];
      const base = passBase({ attempt: number }).replace("- Result: PASS", `- Result: ${status}`)
        .replace("  - `node --test` | exit:0", commands)
        .replace("Objective PASS evidence.", `Objective ${status} evidence.`);
      result = replaceSection(result, "Effective Validation Base", base);
      result = replaceSection(publishPassResult(result), "Final Result", `- ${status}`);
    }
    return result;
  });
  if (["PASS", "ACCEPTED"].includes(status)) await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    `| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | ${status} | ${status} |`,
  ));
}

async function executionCandidate(fixture) {
  return { ...fixture, execution: await copyDirectory(fixture.execution, path.join(fixture.root, "candidate-execution")) };
}

async function snapshotTree(root) {
  const files = (await fs.readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  return Promise.all(files.map(async (file) => [path.relative(root, file), await fs.readFile(file)]));
}

async function assertCandidateRejectedWithoutMutation(fixture, candidate, pattern) {
  const before = await snapshotTree(fixture.execution);
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate.execution), pattern);
  assert.deepEqual(await snapshotTree(fixture.execution), before);
}

test("A/F: an independent external command failure preserves raw exits and permits slice PASS", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture);
  assert.equal(exit, 1);
  assert.equal(evaluateQualityGate(gate, fixture.gateAuthority).decision, "non_blocking");
  await persistQualityAttempt(fixture, gateAttempt(1, "PASS", [gate], exit), { status: "PASS" });
  const result = await preflightExecutionOperation(fixture.requirements, "CLOSE");
  assert.equal(result.state, "COMPLETE");
  assert.equal(result.tasks.get("slice-01").attempts[0].commands[1].exit, 1);
  assert.equal(result.tasks.get("slice-01").attempts[0].gates[0].decision, "non_blocking");
  const unknown = { ...gate, causality: "unknown" };
  assert.equal(evaluateQualityGate(unknown, fixture.gateAuthority).decision, "investigate");
  await editTask(fixture, (value) => value.replace(JSON.stringify([gate]), JSON.stringify([unknown])));
  await assert.rejects(inspectExecutionState(fixture.requirements), /blocking or undetermined gate/u);
});

test("B: external causal regressions require in-scope repair before authority expansion", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { causality: "caused_by_slice", evidence: "Changing the slice interface reproduces the consumer failure; restoring the interface clears it." });
  assert.equal(evaluateQualityGate(gate, fixture.gateAuthority).decision, "blocking");
  await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "REPLAN"), /no in-scope correction/u);
  const expanded = { ...gate, correction: "authority_change", correctionEvidence: "The required interface is fixed by AC-001; an adapter cannot preserve the required behavior. The approved consumer boundary must change.", revalidates: "attempt-01/gate-01" };
  await persistQualityAttempt(fixture, gateAttempt(2, "BLOCKED", [expanded], exit));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "VALIDATION_BLOCKED");
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "REPLAN"), /observation is stale/u);
});

test("C/E: a manually fixed blocker resumes the same operation with unchanged HEAD", async (t) => {
  const fixture = await qualityFixture(t);
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline"]]) {
    assert.equal(spawnSync("git", args, { cwd: fixture.root }).status, 0);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).stdout;
  const first = await observeGate(fixture, { scope: "in_scope", causality: "caused_by_slice" });
  const oldRecord = gateAttempt(1, "BLOCKED", [first.gate], first.exit);
  await persistQualityAttempt(fixture, oldRecord);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).revalidation[0].record, "attempt-01");
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  const current = await observeGate(fixture, { scope: "in_scope", causality: "caused_by_slice", revalidates: "attempt-01/gate-01" });
  assert.equal(current.exit, 0);
  assert.equal(evaluateQualityGate(current.gate, fixture.gateAuthority).decision, "resolved");
  await persistQualityAttempt(fixture, gateAttempt(2, "PASS", [current.gate], current.exit), { status: "PASS" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "CLOSE")).state, "COMPLETE");
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).stdout, head);
  assert.ok((await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8")).includes(oldRecord));
});

test("D: an unchanged blocker is actually rechecked and appends another BLOCKED attempt", async (t) => {
  const fixture = await qualityFixture(t);
  for (let number = 1; number <= 2; number++) {
    const observation = await observeGate(fixture, { scope: "in_scope", causality: "caused_by_slice", revalidates: number === 1 ? null : "attempt-01/gate-01" });
    assert.equal(observation.exit, 1);
    await persistQualityAttempt(fixture, gateAttempt(number, "BLOCKED", [observation.gate], observation.exit));
    assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "VALIDATION_BLOCKED");
  }
  assert.equal((await inspectExecutionState(fixture.requirements)).tasks.get("slice-01").attempts.length, 2);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "CLOSE"), /not legal/u);
});

test("G/H/I: granular persisted bypass survives revalidation but never covers a new blocker", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope", causality: "independent" });
  await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
  const accepted = { ...gate, revalidates: "attempt-01/gate-01", bypass: { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator@example.test", reason: "Accept this optional style gate for this slice.", authorization: "Explicit operator request #42 for gate-01" } };
  const second = { ...gate, id: "gate-02", problem: "New mandatory consumer regression", kind: "requirement", causality: "required_by_slice", diagnostic: `sha256:${"e".repeat(64)}` };
  await persistQualityAttempt(fixture, gateAttempt(2, "BLOCKED", [accepted, second], exit));
  const resumed = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  const gates = resumed.tasks.get("slice-01").attempts.at(-1).gates;
  assert.deepEqual(gates.map((entry) => entry.decision), ["bypassed", "blocking"]);
  assert.throws(() => evaluateQualityGate({ ...second, bypass: accepted.bypass }, fixture.gateAuthority), /does not match/u);
  assert.throws(() => evaluateQualityGate({ ...gate, bypass: accepted.bypass }, { ...fixture.gateAuthority, revision: 2 }), /does not match/u);
  await persistQualityAttempt(fixture, gateAttempt(3, "ACCEPTED", [accepted, { ...second, state: "absent", command: null, revalidates: "attempt-02/gate-02" }], exit), { status: "ACCEPTED" });
  const complete = await preflightExecutionOperation(fixture.requirements, "CLOSE");
  assert.equal(complete.state, "COMPLETE");
  assert.equal(complete.rows[0].result, "ACCEPTED");
  assert.equal(complete.tasks.get("slice-01").attempts.at(-1).gates[0].bypass.authorization, accepted.bypass.authorization);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1"), /not legal/u);
  await editTask(fixture, (value) => value.replace("- Status: ACCEPTED", "- Status: PASS"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /bypass requires ACCEPTED/u);
});

test("auto-recovery takes precedence over a historical bypass", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate } = await observeGate(fixture, { scope: "in_scope" });
  const bypass = { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Known optional gate", authorization: "Explicit request 42" };
  assert.equal(evaluateQualityGate({ ...gate, state: "absent", bypass }, fixture.gateAuthority).decision, "resolved");
  assert.throws(() => evaluateQualityGate({ ...gate, scope: "out_of_scope", bypass }, fixture.gateAuthority), /does not match/u);
});

test("J: gate decisions and bypass cannot mask structural state or mandatory requirements", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture);
  for (const kind of ["structural", "requirement"]) {
    const required = { ...gate, kind, scope: "out_of_scope", causality: "required_by_slice" };
    assert.equal(evaluateQualityGate(required, fixture.gateAuthority).decision, "blocking");
    assert.throws(() => evaluateQualityGate({ ...required, bypass: { target: qualityGateIdentity(required, fixture.gateAuthority), operator: "operator", reason: "Override", authorization: "Explicit" } }, fixture.gateAuthority), /cannot be bypassed/u);
  }
  await persistQualityAttempt(fixture, gateAttempt(1, "PASS", [gate], exit), { status: "PASS" });
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const good = await fs.readFile(taskPath, "utf8");
  await fs.writeFile(taskPath, good.replace("- [x] 1.1", "- [ ] 1.1"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /mandatory checklist/u);
  await fs.writeFile(taskPath, good);
  const dependencies = await standaloneWorkspace(t);
  await renderArtifacts(dependencies);
  await addSecondPristineSlice(dependencies);
  await assert.rejects(preflightExecutionOperation(dependencies.requirements, "EXECUTE_SLICE", "2"), /not legal/u);
  await fs.rm(path.join(fixture.execution, "plans/slice-01.md"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /non-canonical paths|missing|differ|absent|mappings or serial order disagree/u);
});

test("manual finding correction may go directly to independent validation without invented executor edits", async (t) => {
  const fixture = await qualityFixture(t);
  await editTask(fixture, (value) => replaceSection(replaceSection(value, "Validation Attempts", NEEDS_FIX_ATTEMPT), "Validation Findings", ACTIVE_FINDING));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "VALIDATION_NEEDS_FIX");
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  const { gate, exit } = await observeGate(fixture, { revalidates: "finding-01" });
  await persistQualityAttempt(fixture, gateAttempt(2, "PASS", [gate], exit, { references: "finding-01", dispositions: "finding-01=resolved" }), {
    status: "PASS", findingText: `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 independently confirmed the external manual correction.`,
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "CLOSE")).state, "COMPLETE");
});

test("observational divergence can be revalidated as independent without materializing a replan", async (t) => {
  const fixture = await qualityFixture(t);
  const observational = ACTIVE_DIVERGENCE.replace("- Required authority operation: REPLAN", "- Kind: observational\n- Required authority operation: none");
  await editTask(fixture, (value) => replaceSection(value, "Divergences", observational));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "DIVERGENCE_BLOCKED");
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "REPLAN"), /revalidate the blocker first/u);
  const { gate, exit } = await observeGate(fixture, { revalidates: "divergence-01" });
  await persistQualityAttempt(fixture, gateAttempt(1, "PASS", [gate], exit), {
    status: "PASS", divergenceText: `${observational.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-01 revalidated: external failure is independent of the slice.`,
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "CLOSE")).state, "COMPLETE");
});

test("candidate rejects stale working-tree gate evidence and preserves live artifacts", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  const original = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  const candidate = path.join(await temporary(t), "candidate");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  await fs.writeFile(path.join(candidate, "tasks/slice-01.md"), replaceSection(original, "Validation Attempts", gateAttempt(1, "BLOCKED", [gate], exit)));
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "VALIDATION_BLOCKED");
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), /observation is stale/u);
  assert.equal(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8"), original);
});

test("a prior blocker cannot be silently omitted in a later formal result", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  await persistQualityAttempt(fixture, attemptRecord(2, "PASS"), { status: "PASS" });
  await assert.rejects(inspectExecutionState(fixture.requirements), /must revalidate prior blocker/u);
});

test("a bypass needs a prior real blocker, and mixed failures cannot be classified as PASS", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  const bypass = { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Accept optional rule", authorization: "Explicit request 42" };
  await persistQualityAttempt(fixture, gateAttempt(1, "ACCEPTED", [{ ...gate, bypass }], exit), { status: "ACCEPTED" });
  await assert.rejects(inspectExecutionState(fixture.requirements), /previously observed concrete blocker/u);
  const mixed = await qualityFixture(t);
  const independent = await observeGate(mixed);
  const regression = { ...independent.gate, id: "gate-02", causality: "caused_by_slice" };
  await persistQualityAttempt(mixed, gateAttempt(1, "PASS", [independent.gate, regression], exit), { status: "PASS" });
  await assert.rejects(inspectExecutionState(mixed.requirements), /blocking or undetermined gate/u);
});

test("auxiliary manual recovery appends current evidence without commit or reimplementation", async (t) => {
  const fixture = await qualityFixture(t);
  const first = await observeGate(fixture, { scope: "in_scope" });
  const prior = checkRecord("implementation-check", 1, "BLOCKED", 1)
    .replace("- Commands: none", "- Commands:\n  - `node check.mjs` | exit:1") + `\n- Gate assessments: ${JSON.stringify([first.gate])}`;
  await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", prior));
  const resumed = await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1");
  assert.equal(resumed.mandatoryRecovery.owner, "auxiliary-check");
  assert.equal(resumed.revalidation[0].record, "implementation-check-01");
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  const current = await observeGate(fixture, { scope: "in_scope", revalidates: "implementation-check-01/gate-01" });
  const next = checkRecord("implementation-check", 2, "TESTS_PASS", 1).replace("node --test", "node check.mjs") + `\n- Gate assessments: ${JSON.stringify([current.gate])}`;
  await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", `${prior}\n\n${next}`));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("BLOCKED may resolve a manual finding correction while preserving a different real blocker", async (t) => {
  const fixture = await qualityFixture(t);
  await editTask(fixture, (value) => replaceSection(replaceSection(value, "Validation Attempts", NEEDS_FIX_ATTEMPT), "Validation Findings", ACTIVE_FINDING));
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  const resolved = { ...gate, id: "gate-02", command: null, state: "absent", revalidates: "finding-01" };
  await persistQualityAttempt(fixture, gateAttempt(2, "BLOCKED", [gate, resolved], exit, { references: "finding-01", dispositions: "finding-01=resolved" }), {
    findingText: `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirms manual correction while the optional environment gate remains.`,
  });
  const state = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  assert.equal(state.state, "VALIDATION_BLOCKED");
  assert.equal(state.tasks.get("slice-01").findings[0].state, "resolved");
  assert.equal(state.activeFindings.length, 0);
});

test("ACCEPTED retains optional finding identity and exposes acceptance to CLI readers", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  await editTask(fixture, (value) => replaceSection(replaceSection(value, "Validation Attempts", gateAttempt(1, "NEEDS_FIX", [gate], exit, { references: "finding-01", dispositions: "finding-01=active" })), "Validation Findings", ACTIVE_FINDING.replace("AC-001 is not satisfied.", "Optional quality convention is not satisfied.")));
  const accepted = { ...gate, revalidates: "finding-01", bypass: { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Accept optional rule", authorization: "Explicit request 42" } };
  await persistQualityAttempt(fixture, gateAttempt(2, "ACCEPTED", [accepted], exit, { references: "finding-01", dispositions: "finding-01=active" }), { status: "ACCEPTED" });
  const state = await preflightExecutionOperation(fixture.requirements, "CLOSE");
  assert.equal(state.state, "COMPLETE");
  assert.equal(state.tasks.get("slice-01").findings[0].state, "active");
  assert.equal(state.activeFindings.length, 0);
  assert.equal(state.acceptedGates[0].authorization, accepted.bypass.authorization);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "skills/workflows/stnl-execution-closer/runtime/validate-execution-state.mjs"), fixture.requirements, "--handoff-after", "VALIDATE_SLICE"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).accepted_gates[0].gate, "gate-01");
});

test("gate identity excludes prose but binds every material blocker and authority attribute", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate } = await observeGate(fixture, { scope: "in_scope" });
  const authority = fixture.gateAuthority;
  const identity = qualityGateIdentity(gate, authority);
  const bypass = { target: identity, operator: "operator", reason: "Optional gate", authorization: "Request 42" };
  const paraphrased = { ...gate, problem: "Reworded failure", evidence: "Freshly explained evidence", correctionEvidence: "Rephrased correction", snapshot: [] };
  assert.equal(qualityGateIdentity(paraphrased, authority), identity);
  assert.equal(evaluateQualityGate({ ...paraphrased, bypass }, authority).decision, "bypassed");
  for (const change of [
    { diagnostic: `sha256:${"a".repeat(64)}` }, { command: "node other.mjs" }, { kind: "requirement" },
    { causality: "caused_by_slice" }, { correction: "authority_change" }, { scope: "out_of_scope" }, { id: "gate-02" },
  ]) {
    const changed = { ...gate, ...change };
    assert.notEqual(qualityGateIdentity(changed, authority), identity, JSON.stringify(change));
    assert.throws(() => evaluateQualityGate({ ...changed, bypass }, authority), /does not match/u);
  }
  for (const change of [{ revision: 2 }, { slice: "slice-02" }, { fingerprint: `sha256:${"f".repeat(64)}` }]) {
    assert.notEqual(qualityGateIdentity(gate, { ...authority, ...change }), identity);
    for (const state of ["present", "absent"]) assert.throws(() => evaluateQualityGate({ ...gate, state, bypass }, { ...authority, ...change }), /does not match/u);
  }
});

test("persisted bypass survives prose changes, then resolves without ACCEPTED while retaining exact audit history", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
  const bypass = { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Optional gate", authorization: "Request 42" };
  const accepted = { ...gate, problem: "Same failure, new wording", evidence: "Updated explanation", revalidates: "attempt-01/gate-01", bypass };
  const other = { ...gate, id: "gate-02", kind: "requirement", causality: "required_by_slice" };
  await persistQualityAttempt(fixture, gateAttempt(2, "BLOCKED", [accepted, other], exit));
  assert.equal((await inspectExecutionState(fixture.requirements)).tasks.get("slice-01").attempts[1].gates[0].decision, "bypassed");
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  const current = await observeGate(fixture, { ...accepted, state: "absent", revalidates: "attempt-02/gate-01" });
  // Retain semantic identity, but refresh the observed working-tree bytes.
  current.gate.snapshot = (await observeGate(fixture)).gate.snapshot;
  const resolvedOther = { ...other, state: "absent", revalidates: "attempt-02/gate-02", snapshot: current.gate.snapshot };
  await persistQualityAttempt(fixture, gateAttempt(3, "PASS", [current.gate, resolvedOther], current.exit), { status: "PASS" });
  const state = await preflightExecutionOperation(fixture.requirements, "CLOSE");
  assert.equal(state.rows[0].result, "PASS");
  assert.deepEqual(state.acceptedGates, []);
  const attempts = state.tasks.get("slice-01").attempts;
  assert.equal(attempts[2].gates[0].decision, "resolved");
  assert.deepEqual(attempts[2].gates[0].bypass, bypass);
  assert.deepEqual(attempts[1].gates[0].bypass, bypass);
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const valid = await fs.readFile(taskFile, "utf8");
  for (const change of [{ target: `sha256:${"d".repeat(64)}` }, { target: null }, { target: qualityGateIdentity(gate, { ...fixture.gateAuthority, slice: "slice-02" }) }, { target: qualityGateIdentity(gate, { ...fixture.gateAuthority, revision: 2 }) }, { authorization: "Invented historical request" }]) {
    await fs.writeFile(taskFile, valid.replace(JSON.stringify([current.gate, resolvedOther]), JSON.stringify([{ ...current.gate, bypass: { ...bypass, ...change } }, resolvedOther])));
    await assert.rejects(inspectExecutionState(fixture.requirements), /does not match|previously recorded authorization/u);
  }
  await fs.writeFile(taskFile, valid.replace('- Status: PASS', '- Status: ACCEPTED'));
  await assert.rejects(inspectExecutionState(fixture.requirements), /bypass requires ACCEPTED, never PASS/u);
});

test("historical bypass cannot be invented after recovery without a prior blocker", async (t) => {
  const fixture = await qualityFixture(t);
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  const bypass = { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Optional gate", authorization: "Request 42" };
  await persistQualityAttempt(fixture, gateAttempt(1, "PASS", [{ ...gate, bypass }], exit), { status: "PASS" });
  await assert.rejects(inspectExecutionState(fixture.requirements), /previously observed concrete blocker/u);
});

for (const kind of ["observational", "authority", "structural", "required", "legacy"]) {
  test(`${kind} divergence resolves on objective absence and preserves original authority history`, async (t) => {
    const fixture = await qualityFixture(t);
    const original = ACTIVE_DIVERGENCE.replace("- Required authority operation: REPLAN", `${kind === "legacy" ? "" : `- Kind: ${kind}\n`}- Required authority operation: ${kind === "observational" ? "none" : "RESUME"}`);
    await editTask(fixture, (value) => replaceSection(value, "Divergences", original));
    if (kind !== "observational") {
      const state = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
      assert.ok(deriveRecoveryTargets(state).some((target) => target.authorityMode === "RESUME"));
    }
    await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
    const { gate, exit } = await observeGate(fixture, { revalidates: "divergence-01" });
    await persistQualityAttempt(fixture, gateAttempt(1, "PASS", [gate], exit), {
      status: "PASS", divergenceText: `${original.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-01 revalidated: current condition is objectively absent.`,
    });
    const state = await preflightExecutionOperation(fixture.requirements, "CLOSE");
    assert.equal(state.state, "COMPLETE");
    const divergence = state.tasks.get("slice-01").divergences[0];
    assert.equal(divergence.requiredAuthorityOperation, kind === "observational" ? "none" : "RESUME");
    for (const line of original.split("\n").filter((line) => line.startsWith("- ") && !line.startsWith("- State:"))) assert.ok(divergence.body.includes(line));
  });
}

for (const kind of ["authority", "structural", "required", "legacy"]) {
  test(`${kind} divergence cannot be demoted directly or through gate lineage, or bypassed`, async (t) => {
    const fixture = await qualityFixture(t);
    const original = ACTIVE_DIVERGENCE.replace("- Required authority operation: REPLAN", `${kind === "legacy" ? "" : `- Kind: ${kind}\n`}- Required authority operation: RESUME`);
    await editTask(fixture, (value) => replaceSection(value, "Divergences", original));
    const { gate, exit } = await observeGate(fixture, { scope: "in_scope", revalidates: "divergence-01" });
    await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
    const active = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
    assert.equal(active.state, "DIVERGENCE_BLOCKED");
    assert.ok(deriveRecoveryTargets(active).some((target) => target.authorityMode === "RESUME"));
    await assert.rejects(preflightExecutionOperation(fixture.requirements, "REPLAN"), /not legal|revalidate/u);
    const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
    const before = await fs.readFile(taskFile, "utf8");
    for (const revalidates of ["divergence-01", "attempt-01/gate-01"]) {
      await fs.writeFile(taskFile, before);
      await persistQualityAttempt(fixture, gateAttempt(2, "PASS", [{ ...gate, scope: "out_of_scope", revalidates }], exit), {
        status: "PASS", divergenceText: `${original.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 revalidated: claims independent quality debt.`,
      });
      await assert.rejects(inspectExecutionState(fixture.requirements), /divergence cannot become non_blocking/u);
    }
    await fs.writeFile(taskFile, before);
    const bypass = { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Optional gate", authorization: "Request 42" };
    await persistQualityAttempt(fixture, gateAttempt(2, "ACCEPTED", [{ ...gate, bypass, revalidates: "attempt-01/gate-01" }], exit), { status: "ACCEPTED" });
    await assert.rejects(inspectExecutionState(fixture.requirements), /divergences cannot be bypassed/u);
  });
}

test("observational kind cannot erase a required authority operation", async (t) => {
  const fixture = await qualityFixture(t);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE}\n- Kind: observational`));
  await assert.rejects(inspectExecutionState(fixture.requirements), /invalid Required authority operation/u);
});

for (const obligation of [{ kind: "structural" }, { kind: "requirement" }, { causality: "required_by_slice" }]) {
  test(`revalidation preserves original mandatory gate boundary ${JSON.stringify(obligation)}`, async (t) => {
    const fixture = await qualityFixture(t);
    const { gate, exit } = await observeGate(fixture, { scope: "in_scope", ...obligation });
    await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
    const candidate = { ...gate, kind: "quality", scope: "out_of_scope", causality: "independent", revalidates: "attempt-01/gate-01" };
    await persistQualityAttempt(fixture, gateAttempt(2, "PASS", [candidate], exit), { status: "PASS" });
    await assert.rejects(inspectExecutionState(fixture.requirements), /cannot demote or bypass a structural or mandatory gate obligation/u);
  });
}

test("ACCEPTED enforces successful terminal diagnostics and exact result publication", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
  const bypass = { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Optional gate", authorization: "Request 42" };
  const accepted = { ...gate, bypass, revalidates: "attempt-01/gate-01" };
  await persistQualityAttempt(fixture, gateAttempt(2, "ACCEPTED", [accepted], exit), { status: "ACCEPTED" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "CLOSE")).state, "COMPLETE");
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const valid = await fs.readFile(taskFile, "utf8");
  for (const [mutate, message] of [
    [(value) => value.replace('- Result: ACCEPTED', '- Result: PASS'), /Result must match its owning PASS\/ACCEPTED attempt/u],
    [(value) => replaceSection(value, "Diff Summary", "- none"), /terminal PASS\/ACCEPTED requires/u],
    [(value) => replaceSection(value, "Validation Attempts", `${value.match(/## Validation Attempts\n\n([\s\S]*?)(?=\n## )/u)[1].trim()}\n\n${gateAttempt(3, "ACCEPTED", [accepted], exit)}`), /PASS\/ACCEPTED is terminal/u],
    [(value) => replaceSection(value, "Final Result", "- PASS"), /successful terminal result does not originate/u],
  ]) {
    await fs.writeFile(taskFile, mutate(valid));
    await assert.rejects(inspectExecutionState(fixture.requirements), message);
  }
  await fs.writeFile(taskFile, valid);
  await editTasksIndex(fixture, (value) => value.replace('| ACCEPTED | ACCEPTED |', '| PASS | PASS |'));
  await assert.rejects(inspectExecutionState(fixture.requirements), /PASS\/ACCEPTED row and detailed task disagree/u);
});

test("TESTS_ACCEPTED is terminal auxiliary evidence and retains mandatory summary guards", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate } = await observeGate(fixture, { scope: "in_scope" });
  const first = checkRecord("implementation-check", 1, "BLOCKED", 1)
    .replace("- Commands: none", "- Commands:\n  - `node check.mjs` | exit:1") + `\n- Gate assessments: ${JSON.stringify([gate])}`;
  const bypass = { target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Optional gate", authorization: "Request 42" };
  const accepted = { ...gate, bypass, revalidates: "implementation-check-01/gate-01" };
  const second = checkRecord("implementation-check", 2, "TESTS_ACCEPTED", 1)
    .replace('  - `node --test` | exit:0', '  - `node --test` | exit:0\n  - `node check.mjs` | exit:1') + `\n- Gate assessments: ${JSON.stringify([accepted])}`;
  await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", `${first}\n\n${second}`));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const valid = await fs.readFile(taskFile, "utf8");
  for (const name of ["Tested scope", "Verification types considered", "Selected checks", "Coverage"]) {
    const invalid = second.replace(new RegExp(`^- ${name}: .+$`, "mu"), `- ${name}: none`);
    await fs.writeFile(taskFile, valid.replace(second, invalid));
    await assert.rejects(inspectExecutionState(fixture.requirements), /placeholder/u);
  }
  await fs.writeFile(taskFile, valid.replace(second, `${second}\n\n${checkRecord("implementation-check", 3, "TESTS_PASS", 1)}`));
  await assert.rejects(inspectExecutionState(fixture.requirements), /after terminal automatic-check record/u);
});

for (const [kind, operation] of [["authority", "RESUME"], ["authority", "REPLAN"], ["structural", "REPLAN"], ["required", "RESUME"], ["legacy", "RESUME"]]) {
  test(`candidate history rejects ${kind}/${operation} divergence reclassified as observational`, async (t) => {
    const fixture = await qualityFixture(t);
    const original = ACTIVE_DIVERGENCE.replace("- Required authority operation: REPLAN", `${kind === "legacy" ? "" : `- Kind: ${kind}\n`}- Required authority operation: ${operation}`);
    await editTask(fixture, (value) => replaceSection(value, "Divergences", original));
    const candidate = await executionCandidate(fixture);
    const { gate, exit } = await observeGate(fixture, { revalidates: "divergence-01" });
    assert.equal(evaluateQualityGate(gate, fixture.gateAuthority).decision, "non_blocking");
    const rewritten = ACTIVE_DIVERGENCE.replace("- Required authority operation: REPLAN", "- Kind: observational\n- Required authority operation: none");
    await persistQualityAttempt(candidate, gateAttempt(1, "PASS", [gate], exit), {
      status: "PASS", divergenceText: `${rewritten.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-01 revalidated: external failure is independent.`,
    });
    await assertCandidateRejectedWithoutMutation(fixture, candidate, /divergence-01.*immutable/u);
  });
}

for (const [name, from, to] of [
  ["RESUME to REPLAN", "Required authority operation: RESUME", "Required authority operation: REPLAN"],
  ["REPLAN to RESUME", "Required authority operation: REPLAN", "Required authority operation: RESUME"],
  ["problem", "Problem: Approved scope omits a required dependency.", "Problem: An unrelated style warning."],
  ["evidence", "Evidence: The implementation cannot remain inside the slice.", "Evidence: Baseline has the same style warning."],
  ["severity", "Severity: blocking", "Severity: advisory"],
  ["origin", "Origin: EXECUTE_SLICE", "Origin: VALIDATE_SLICE"],
  ["extra historical field", "Evidence: The implementation cannot remain inside the slice.", "Evidence: The implementation cannot remain inside the slice.\n- Historical authority: invented"],
]) {
  test(`candidate history rejects divergence ${name} mutation during resolution`, async (t) => {
    const fixture = await qualityFixture(t);
    const original = `${ACTIVE_DIVERGENCE.replace("operation: REPLAN", `operation: ${name === "REPLAN to RESUME" ? "REPLAN" : "RESUME"}`)}\n- Kind: authority`;
    await editTask(fixture, (value) => replaceSection(value, "Divergences", original));
    const candidate = await executionCandidate(fixture);
    await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
    const { gate, exit } = await observeGate(fixture, { revalidates: "divergence-01" });
    assert.ok(original.includes(from));
    await persistQualityAttempt(candidate, gateAttempt(1, "PASS", [gate], exit), {
      status: "PASS", divergenceText: `${original.replace(from, to).replace("- State: active", "- State: resolved")}\n- Resolution: attempt-01 revalidated: condition is objectively absent.`,
    });
    await assertCandidateRejectedWithoutMutation(fixture, candidate, /divergence-01.*immutable/u);
  });
}

for (const kind of ["authority", "structural", "required", "legacy", "observational"]) {
  test(`candidate history permits ${kind} divergence disposition alone and canonical revalidation`, async (t) => {
    const fixture = await qualityFixture(t);
    const original = ACTIVE_DIVERGENCE.replace("- Required authority operation: REPLAN", `${kind === "legacy" ? "" : `- Kind: ${kind}\n`}- Required authority operation: ${kind === "observational" ? "none" : "RESUME"}`);
    await editTask(fixture, (value) => replaceSection(value, "Divergences", original));
    const candidate = await executionCandidate(fixture);
    if (kind !== "observational") await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
    const { gate, exit } = await observeGate(fixture, { revalidates: "divergence-01" });
    await persistQualityAttempt(candidate, gateAttempt(1, "PASS", [gate], exit), {
      status: "PASS", divergenceText: `${original.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-01 revalidated: current observation clears the original blocker.`,
    });
    const before = await snapshotTree(fixture.execution);
    assert.equal((await validateExecutionCandidate(fixture.requirements, candidate.execution)).state, "COMPLETE");
    assert.deepEqual(await snapshotTree(fixture.execution), before);
    // Exercise the same candidate boundary used by every distributed CLI adapter.
    const cli = spawnSync(process.execPath, [path.join(ROOT, "skills/workflows/stnl-execution-closer/runtime/validate-execution-state.mjs"), fixture.requirements, "--candidate", candidate.execution], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
  });
}

for (const disposition of ["resolved", "superseded"]) {
  test(`candidate history preserves materialized REPLAN divergence ${disposition}`, async (t) => {
    const fixture = await qualityFixture(t);
    const authority = await computeRequirementsAuthority(fixture.requirements);
    await editTask(fixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE));
    await appendRecoveryPlan(fixture, authority, authority, { ready: true });
    assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
    const candidate = await executionCandidate(fixture);
    await commitAppendRecovery(candidate, authority, authority, { resolveDivergence: true });
    if (disposition === "superseded") await editTask(candidate, (value) => replaceSection(value, "Divergences",
      `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: superseded")}\n- Superseded by: divergence-02\n\n${ACTIVE_DIVERGENCE.replace("divergence-01", "divergence-02").replace("- State: active", "- State: resolved")}\n- Resolution: plan revision 2 committed recovery slice-02`));
    assert.equal((await validateExecutionCandidate(fixture.requirements, candidate.execution)).state, "EXECUTION_STARTED");
    await editTask(candidate, (value) => value.replace("Problem: Approved scope omits a required dependency.", "Problem: Altered original authority."));
    await assertCandidateRejectedWithoutMutation(fixture, candidate, /divergence-01.*immutable/u);
  });
}

for (const disposition of ["resolved", "superseded"]) {
  test(`candidate history protects finding identity during ${disposition}`, async (t) => {
    const fixture = await qualityFixture(t);
    await editTask(fixture, (value) => replaceSection(replaceSection(value, "Validation Attempts", NEEDS_FIX_ATTEMPT), "Validation Findings", ACTIVE_FINDING));
    const candidate = await executionCandidate(fixture);
    const findings = disposition === "resolved"
      ? `${ACTIVE_FINDING.replace("State: active", "State: resolved")}\n- Resolution: attempt-02 verified the correction.\n\n${ACTIVE_FINDING_02.replace("Origin: attempt-01", "Origin: attempt-02")}`
      : `${ACTIVE_FINDING.replace("State: active", "State: superseded")}\n- Superseded by: finding-02\n\n${ACTIVE_FINDING_02.replace("Origin: attempt-01", "Origin: attempt-02")}`;
    const attempt = attemptRecord(2, "NEEDS_FIX", {
      references: "finding-01, finding-02",
      dispositions: `finding-01=${disposition}, finding-02=active`,
    });
    await persistQualityAttempt(candidate, attempt, { findingText: findings });
    assert.equal((await validateExecutionCandidate(fixture.requirements, candidate.execution)).state, "VALIDATION_NEEDS_FIX");
    await editTask(candidate, (value) => value.replace("Problem: Observable behavior is wrong.", "Problem: Unrelated cosmetic detail."));
    await assertCandidateRejectedWithoutMutation(fixture, candidate, /finding-01.*immutable/u);
  });
}

for (const section of ["Validation Attempts", "Implementation Test Evidence", "Findings Test Evidence"]) {
  test(`candidate history rejects rewritten ${section}`, async (t) => {
    const fixture = await qualityFixture(t);
    if (section === "Findings Test Evidence") await prepareFindingsCorrection(fixture);
    else await editTask(fixture, (value) => replaceSection(value, section, section === "Validation Attempts"
      ? BLOCKED_ATTEMPT : checkRecord("implementation-check", 1, "TESTS_PASS", 1)));
    const candidate = await executionCandidate(fixture);
    await editTask(candidate, (value) => value.replace("- HEAD: fixture", "- HEAD: invented"));
    await assertCandidateRejectedWithoutMutation(fixture, candidate, /(?:attempt|implementation-check|findings-check)-01.*immutable/u);
  });
}

test("candidate history rejects coordinated historical bypass authorization rewrite", async (t) => {
  const fixture = await qualityFixture(t);
  const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
  await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
  const accepted = { ...gate, revalidates: "attempt-01/gate-01", bypass: {
    target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Optional gate", authorization: "Request 42",
  } };
  const other = { ...gate, id: "gate-02", kind: "requirement", causality: "required_by_slice" };
  await persistQualityAttempt(fixture, gateAttempt(2, "BLOCKED", [accepted, other], exit));
  const candidate = await executionCandidate(fixture);
  await editTask(candidate, (value) => value.replaceAll("Request 42", "Forged request"));
  await assertCandidateRejectedWithoutMutation(fixture, candidate, /attempt-02.*immutable/u);
});

for (const mutation of ["base manifest", "attempt and base evidence", "terminal result"]) {
  test(`candidate history rejects coordinated successful ${mutation} rewrite`, async (t) => {
    const fixture = await qualityFixture(t);
    const { gate, exit } = await observeGate(fixture, { scope: "in_scope" });
    await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate], exit));
    const accepted = { ...gate, revalidates: "attempt-01/gate-01", bypass: {
      target: qualityGateIdentity(gate, fixture.gateAuthority), operator: "operator", reason: "Optional gate", authorization: "Request 42",
    } };
    await persistQualityAttempt(fixture, gateAttempt(2, "ACCEPTED", [accepted], exit), { status: "ACCEPTED" });
    const candidate = await executionCandidate(fixture);
    if (mutation === "base manifest") await editTask(candidate, (value) => value.replace(`sha256:${createHash("sha256").update(VALIDATED_CONTENT).digest("hex")}`, `sha256:${"a".repeat(64)}`));
    if (mutation === "attempt and base evidence") await editTask(candidate, (value) => value.replaceAll("Objective ACCEPTED evidence.", "Invented evidence."));
    if (mutation === "terminal result") {
      await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
      const current = { ...accepted, state: "absent", bypass: null, snapshot: (await observeGate(fixture)).gate.snapshot };
      await editTask(candidate, (value) => {
        let result = value.replace(gateAttempt(2, "ACCEPTED", [accepted], exit), gateAttempt(2, "PASS", [current], 0)).replaceAll("ACCEPTED", "PASS");
        const base = result.match(/## Effective Validation Base\n\n([\s\S]*?)(?=\n## )/u)[1].trim();
        return replaceSection(result, "Effective Validation Base", base.replace("exit:1", "exit:0"));
      });
      await editTasksIndex(candidate, (value) => value.replaceAll("ACCEPTED", "PASS"));
    }
    await assertCandidateRejectedWithoutMutation(fixture, candidate, /(?:terminal.*immutable|attempt-02.*immutable)/u);
  });
}

test("candidate history protects delegation blocker identity while allowing its resolution", async (t) => {
  const fixture = await qualityFixture(t);
  const original = delegationBlocker("VALIDATE_SLICE", "initialization");
  await editTask(fixture, (value) => replaceSection(replaceSection(value, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)), "Delegation Blocker", original));
  const candidate = await executionCandidate(fixture);
  await persistQualityAttempt(candidate, BLOCKED_ATTEMPT);
  await editTask(candidate, (value) => replaceSection(value, "Delegation Blocker", `${original.replace("State: active", "State: resolved")}\n- Resolution: attempt-01 returned valid output.`));
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate.execution)).state, "VALIDATION_BLOCKED");
  await editTask(candidate, (value) => value.replace("Kind: initialization", "Kind: malformed-output"));
  await assertCandidateRejectedWithoutMutation(fixture, candidate, /Delegation Blocker.*immutable/u);
});

test("candidate history rejects removal and renumbering of persisted divergences", async (t) => {
  const fixture = await qualityFixture(t);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE));
  const candidate = await executionCandidate(fixture);
  await editTask(candidate, (value) => replaceSection(value, "Divergences", "- none"));
  await assertCandidateRejectedWithoutMutation(fixture, candidate, /divergence-01.*(?:removed|immutable)/u);
  await editTask(candidate, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE.replace("Problem: Approved scope omits a required dependency.", "Problem: New record usurps original identifier.")}\n\n${ACTIVE_DIVERGENCE.replace("divergence-01", "divergence-02")}`));
  await assertCandidateRejectedWithoutMutation(fixture, candidate, /divergence-01.*immutable/u);
});

test("candidate history rejects retroactive superseded slice ownership during later REPLAN", async (t) => {
  const fixture = await qualityFixture(t);
  const authority = await computeRequirementsAuthority(fixture.requirements);
  await appendRecoveryPlan(fixture, authority, authority, { ready: true });
  await commitAppendRecovery(fixture, authority, authority);
  await stageThirdRecovery(fixture, authority, { ready: true });
  const candidate = await executionCandidate(fixture);
  await commitThirdRecovery(candidate, authority);
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate.execution)).state, "EXECUTION_STARTED");
  await editTask(candidate, (value) => replaceSection(value, "Final Result", "- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 3"));
  await editSlicePlan(candidate, "slice-02", (value) => value.replace("Plan revision: 2", "Plan revision: 3"));
  const secondTask = path.join(candidate.execution, "tasks/slice-02.md");
  await fs.writeFile(secondTask, (await fs.readFile(secondTask, "utf8")).replace("Plan revision: 2", "Plan revision: 3"));
  await editPlan(candidate, (value) => value.replace("Supersedes open slices: slice-02 -> slice-03", "Supersedes open slices: slice-01 -> slice-02, slice-02 -> slice-03"));
  await assertCandidateRejectedWithoutMutation(fixture, candidate, /terminal.*immutable/u);
});

test("candidate history rejects removal of an entire operational execution tree", async (t) => {
  const fixture = await qualityFixture(t);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE));
  const candidate = await executionCandidate(fixture);
  await fs.rm(path.join(candidate.execution, "tasks"), { recursive: true });
  await fs.rm(path.join(candidate.execution, "tasks.md"));
  await assertCandidateRejectedWithoutMutation(fixture, candidate, /historical task cannot be removed/u);
});

test("candidate history requires a newly appended observation for divergence resolution", async (t) => {
  const fixture = await qualityFixture(t);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE));
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  const { gate, exit } = await observeGate(fixture, { revalidates: "divergence-01" });
  await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate, { ...gate, id: "gate-02", command: null, kind: "requirement", state: "present", causality: "required_by_slice", revalidates: null }], exit));
  const candidate = await executionCandidate(fixture);
  await editTask(candidate, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE.replace("State: active", "State: resolved")}\n- Resolution: attempt-01 revalidated: reuse an old observation.`));
  await writeValidatedPath(fixture, "../../src/external.txt", "broken again\n");
  await assertCandidateRejectedWithoutMutation(fixture, candidate, /newly appended revalidation record/u);
});

test("candidate history rejects rewriting a resolved divergence disposition", async (t) => {
  const fixture = await qualityFixture(t);
  const original = ACTIVE_DIVERGENCE.replace("State: active", "State: resolved") + "\n- Resolution: attempt-01 revalidated: the original condition is absent.";
  await writeValidatedPath(fixture, "../../src/external.txt", "fixed\n");
  const { gate, exit } = await observeGate(fixture, { revalidates: "divergence-01" });
  await persistQualityAttempt(fixture, gateAttempt(1, "BLOCKED", [gate, { ...gate, id: "gate-02", command: null, kind: "requirement", state: "present", causality: "required_by_slice", revalidates: null }], exit), { divergenceText: original });
  const candidate = await executionCandidate(fixture);
  await editTask(candidate, (value) => value.replace("the original condition is absent.", "a different reason replaces the historical disposition."));
  await assertCandidateRejectedWithoutMutation(fixture, candidate, /divergence-01.*immutable/u);
});

async function validationSessionFixture(t) {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await renderTasks(fixture, { evidenceContract: true });
  await writeValidatedPath(fixture);
  return fixture;
}

async function editNamedTask(fixture, slice, transform) {
  const file = path.join(fixture.execution, "tasks", `${slice}.md`);
  await fs.writeFile(file, transform(await fs.readFile(file, "utf8")), "utf8");
}

function provenanceBase(provenance, status = "PASS") {
  return `- Origin attempt: attempt-01
- Attempt type: initial
- HEAD: ${provenance.inputs.head}
- Result: ${status}
- Files:
${provenance.subjects.map((subject) => `  - \`${subject.path}\` | ${subject.expected}`).join("\n")}
- Authoritative commands:
${provenance.commands.map((command) => `  - \`${command.display}\` | exit:${command.exit}`).join("\n")}
- Evidence summary: isolated validation evidence`;
}

function overlapRecord(id, priorSlice, paths, behavior = "Preserve the prior validated behavior.", regressions = "Run the focused prior behavior regression.") {
  return `### ${id}\n\n- Prior slice: ${priorSlice}\n- Paths: ${paths.join(", ")}\n- Affected behavior: ${behavior}\n- Regressions: ${regressions}`;
}

async function terminalizeV1Slice(fixture, slice, paths, { overlaps = "- none", command = "/usr/bin/true" } = {}) {
  const subjects = [...paths].sort((a, b) => a.localeCompare(b, "en"));
  for (const subject of subjects) await writeValidatedPath(fixture, subject);
  const implementation = await runValidationSession(fixture.requirements, validationRequest({
    slice, subjects, failureConclusion: "NONE", argv: [command],
  }));
  await editNamedTask(fixture, slice, (value) => {
    let next = value.replace(/- \[ \] ([0-9]+\.[0-9]+)/u, "- [x] $1");
    next = replaceSection(next, "Changed Areas", subjects.map((subject) => `- \`${subject}\``).join("\n"));
    next = replaceSection(next, "Prior Validation Overlap", overlaps);
    return replaceSection(next, "Implementation Test Evidence", evidenceCheckRecord(implementation.provenance));
  });
  const validation = await runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", slice, round: null, subjects, failureConclusion: "NONE", argv: [command],
  }));
  await editNamedTask(fixture, slice, (value) => {
    let next = replaceSection(value, "Validation Attempts", evidenceAttemptRecord(validation.provenance, "PASS"));
    next = replaceSection(next, "Effective Validation Base", provenanceBase(validation.provenance));
    return publishPassResult(next);
  });
  await editTasksIndex(fixture, (value) => value.replace(
    new RegExp(`\\| \\[ \\] \\| [^|]+ \\| [^|]+ \\| [^|]* \\| tasks/${slice}\\.md \\| pending \\| pending \\|`, "u"),
    (match) => match.replace("[ ]", "[x]").replace("pending | pending", "PASS | PASS"),
  ));
  return { implementation, validation };
}

async function addThirdPristineSlice(fixture) {
  await editPlan(fixture, (value) => value.replace(
    "| 02 - Later | later result | 01 | AC-001 | src/later.txt | plans/slice-02.md |",
    "| 02 - Later | later result | 01 | AC-001 | src/later.txt | plans/slice-02.md |\n| 03 - Final | final result | 02 | AC-001 | src/example.txt | plans/slice-03.md |",
  ));
  const plan = (await fs.readFile(path.join(fixture.execution, "plans/slice-02.md"), "utf8"))
    .replaceAll("Slice 02", "Slice 03").replaceAll("- Slice: 02", "- Slice: 03")
    .replace(/^- slice-01\.?$/mu, "- slice-02.")
    .replaceAll("Later", "Final");
  await fs.writeFile(path.join(fixture.execution, "plans/slice-03.md"), plan, "utf8");
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |",
    "| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |\n| [ ] | 03 - Final | final result | 02 | tasks/slice-03.md | pending | pending |",
  ));
  const task = (await fs.readFile(path.join(fixture.execution, "tasks/slice-02.md"), "utf8"))
    .replaceAll("Slice 02", "Slice 03").replaceAll("- Slice: 02", "- Slice: 03")
    .replaceAll("slice-02", "slice-03").replaceAll("Later", "Final").replace("2.1", "3.1");
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-03.md"), task, "utf8");
}

async function twoSliceOverlapFixture(t, priorPaths = ["../../src/example.txt"]) {
  const fixture = await validationSessionFixture(t);
  await addSecondPristineSlice(fixture);
  await terminalizeV1Slice(fixture, "slice-01", priorPaths);
  return fixture;
}

test("Prior Validation Overlap 1 valid overlap passes and CLOSE verifies it", async (t) => {
  const fixture = await twoSliceOverlapFixture(t);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"], {
    overlaps: overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"]),
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "CLOSE")).state, "COMPLETE");
});

test("Prior Validation Overlap 2 missing overlap is rejected deterministically", async (t) => {
  const fixture = await twoSliceOverlapFixture(t);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"]);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "CLOSE"), /does not declare every changed terminal-base intersection/u);
});

test("Prior Validation Overlap 3 incomplete paths are rejected", async (t) => {
  const paths = ["../../src/a.txt", "../../src/b.txt"];
  const fixture = await twoSliceOverlapFixture(t, paths);
  await terminalizeV1Slice(fixture, "slice-02", paths, {
    overlaps: overlapRecord("overlap-01", "slice-01", [paths[0]]),
  });
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "CLOSE"), /incomplete or stale/u);
});

test("Prior Validation Overlap 4 excessive stale path is rejected", async (t) => {
  const fixture = await twoSliceOverlapFixture(t);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"], {
    overlaps: overlapRecord("overlap-01", "slice-01", ["../../src/example.txt", "../../src/stale.txt"]),
  });
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "CLOSE"), /incomplete or stale/u);
});

test("Prior Validation Overlap 5 duplicate prior slice is rejected", async (t) => {
  const fixture = await twoSliceOverlapFixture(t);
  const overlap = overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"]);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"], { overlaps: `${overlap}\n\n${overlap.replace("overlap-01", "overlap-02")}` });
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "CLOSE"), /duplicate Prior Validation Overlap|duplicate or self-referential/u);
});

test("Prior Validation Overlap 6 self overlap is rejected", async (t) => {
  const fixture = await twoSliceOverlapFixture(t);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"], {
    overlaps: overlapRecord("overlap-01", "slice-02", ["../../src/example.txt"]),
  });
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "CLOSE"), /duplicate or self-referential/u);
});

test("Prior Validation Overlap 7 Corrections Applied remains owned and still requires overlap", async (t) => {
  const fixture = await twoSliceOverlapFixture(t);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"]);
  await editNamedTask(fixture, "slice-02", (value) => replaceSection(value, "Corrections Applied", "- `../../src/example.txt`"));
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "CLOSE"), /does not declare every changed terminal-base intersection/u);
});

test("Prior Validation Overlap 8 multiple terminal prior slices require exact per-slice declarations", async (t) => {
  const fixture = await validationSessionFixture(t);
  await addSecondPristineSlice(fixture);
  await addThirdPristineSlice(fixture);
  await terminalizeV1Slice(fixture, "slice-01", ["../../src/example.txt"]);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt", "../../src/second.txt"], {
    overlaps: overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"]),
  });
  await terminalizeV1Slice(fixture, "slice-03", ["../../src/example.txt", "../../src/second.txt"], {
    overlaps: `${overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"])}\n\n${overlapRecord("overlap-02", "slice-02", ["../../src/example.txt", "../../src/second.txt"])}`,
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
  const candidate = await executionCandidate(fixture);
  await editNamedTask(candidate, "slice-03", (value) => replaceSection(value, "Prior Validation Overlap", overlapRecord("overlap-01", "slice-01", ["../../src/second.txt"]) + "\n\n" + overlapRecord("overlap-02", "slice-02", ["../../src/example.txt", "../../src/second.txt"])));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate.execution), /terminal task, validation base and supersession ownership are immutable|incomplete or stale/u);
});

test("Prior Validation Overlap 9 sequential ownership keeps slice-01 and slice-02 history terminal", async (t) => {
  const fixture = await validationSessionFixture(t);
  await addSecondPristineSlice(fixture);
  await addThirdPristineSlice(fixture);
  await terminalizeV1Slice(fixture, "slice-01", ["../../src/example.txt"]);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"], {
    overlaps: overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"]),
  });
  await terminalizeV1Slice(fixture, "slice-03", ["../../src/example.txt"], {
    overlaps: `${overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"])}\n\n${overlapRecord("overlap-02", "slice-02", ["../../src/example.txt"])}`,
  });
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.rows[0].result, "PASS");
  assert.equal(state.rows[1].result, "PASS");
  assert.equal(state.rows[2].result, "PASS");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "CLOSE")).state, "COMPLETE");
});

test("Prior Validation Overlap 10 rejects Base ownership without Changed Areas in a cross-slice candidate", async (t) => {
  const fixture = await twoSliceOverlapFixture(t);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"], {
    overlaps: overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"]),
  });
  const candidate = await executionCandidate(fixture);
  await editNamedTask(candidate, "slice-02", (value) => replaceSection(value, "Changed Areas", "- `../../src/undeclared.txt`"));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate.execution), /changed\/corrected path with no validation owner|Effective Validation Base path is absent/u);
});

test("Prior Validation Overlap contract keeps paths, IDs, and prior references canonical", async (t) => {
  const fixture = await twoSliceOverlapFixture(t);
  await terminalizeV1Slice(fixture, "slice-02", ["../../src/example.txt"], {
    overlaps: overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"]),
  });
  const taskFile = path.join(fixture.execution, "tasks/slice-02.md");
  const original = await fs.readFile(taskFile, "utf8");
  const cases = [
    ["unsorted paths", overlapRecord("overlap-01", "slice-01", ["../../src/z.txt", "../../src/a.txt"]), /paths are not lexicographically ordered/u],
    ["duplicate path", overlapRecord("overlap-01", "slice-01", ["../../src/example.txt", "../../src/example.txt"]), /duplicate paths/u],
    ["duplicate overlap id", `${overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"])}\n\n${overlapRecord("overlap-01", "slice-01", ["../../src/example.txt"])}`, /duplicate Prior Validation Overlap identifiers/u],
    ["nonexistent prior", overlapRecord("overlap-01", "slice-99", ["../../src/example.txt"]), /incomplete or stale/u],
    ["posterior prior", overlapRecord("overlap-01", "slice-03", ["../../src/example.txt"]), /incomplete or stale/u],
  ];
  for (const [, overlap, expected] of cases) {
    await fs.writeFile(taskFile, replaceSection(original, "Prior Validation Overlap", overlap), "utf8");
    await assert.rejects(preflightExecutionOperation(fixture.requirements, "CLOSE"), expected);
  }
  await fs.writeFile(taskFile, original, "utf8");
});

function validationRequest({
  operation = "EXECUTE_SLICE", slice = "slice-01", round = "1/3", subjects = ["../../src/example.txt"],
  argv = [process.execPath, "-e", "process.exit(0)"], writePaths = [], priorEvidenceId = null,
  failureConclusion = "VALIDATION_FINDING", replayOriginEvidenceId = null,
} = {}) {
  return {
    operation, slice, round, cwd: ".", subjects,
    commands: [{ argv, cwd: ".", writePaths, env: {}, timeoutMs: 10_000 }],
    baselineFingerprint: null, priorEvidenceId, failureConclusion, replayOriginEvidenceId,
  };
}

function provenanceCommands(provenance) {
  return provenance.commands.map((command) => `  - \`${command.display}\` | exit:${command.exit}`).join("\n");
}

function evidenceCheckRecord(provenance, { status = "TESTS_PASS", number = 1 } = {}) {
  const identifier = String(number).padStart(2, "0");
  const testedState = provenance.subjects.map((subject) => `  - \`${subject.path}\` | ${subject.expected}`).join("\n");
  return `### implementation-check-${identifier}

- Automatic check round: ${provenance.round}
- Status: ${status}
- HEAD: ${provenance.inputs.head}
- Tested scope: ${provenance.subjects.map((subject) => subject.path).join(", ")}
- Tested state:
${testedState}
- Discovery sources: approved task and repository tests
- Discovery actions: inspected applicable test commands
- Verification types considered: focused automated test
- Commands:
${provenanceCommands(provenance)}
- Evidence provenance: ${JSON.stringify(provenance)}
- Selected checks: isolated validation session
- Selection rationale: bounded authoritative behavior check
- Coverage: AC-001 observable behavior
- Failures: ${status === "TESTS_FAIL" ? "observable mismatch" : "none"}
- Blockers: ${status === "BLOCKED" ? "validation evidence is invalid" : "none"}
- Unexpected workspace effects: ${provenance.workspace.sideEffects.join(", ") || "none"}
- Persistence summary: ${status} persisted.`;
}

function evidenceAttemptRecord(provenance, status, { number = 1 } = {}) {
  const identifier = String(number).padStart(2, "0");
  const findingFields = status === "NEEDS_FIX"
    ? ["finding-01", "finding-01=active"] : ["none", "none"];
  return `### attempt-${identifier}

- Type: ${number === 1 ? "initial" : "revalidation"}
- Status: ${status}
- HEAD: ${provenance.inputs.head}
- Verified scope: ${provenance.subjects.map((subject) => subject.path).join(", ")}
- Commands:
${provenanceCommands(provenance)}
- Evidence provenance: ${JSON.stringify(provenance)}
- Evidence: isolated validation evidence
- Finding references: ${findingFields[0]}
- Finding dispositions: ${findingFields[1]}
- Blockers: ${status === "BLOCKED" ? "invalid reproduction" : "none"}
- Unexpected workspace effects: ${provenance.workspace.sideEffects.join(", ") || "none"}
- Persistence summary: ${status} persisted.`;
}

async function externalExecutionCandidate(t, fixture) {
  const holder = await temporary(t, "stnl-validation-candidate-");
  return { root: holder, requirements: fixture.requirements, execution: await copyDirectory(fixture.execution, path.join(holder, "execution")) };
}

test("real macOS sandbox denial invalidates evidence and cannot become a finding", async (t) => {
  const fixture = await validationSessionFixture(t);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const original = await fs.readFile(liveTask, "utf8");
  const result = await runValidationSession(fixture.requirements, validationRequest({
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'corrupt')", liveTask],
    failureConclusion: "VALIDATION_FINDING",
  }));
  assert.equal(await fs.readFile(liveTask, "utf8"), original);
  assert.notEqual(result.outputs[0].exit, 0);
  assert.equal(result.provenance.state, "INVALID");
  assert.equal(result.provenance.classification, "VALIDATION_SIDE_EFFECT");
  assert.equal(result.provenance.conclusion, "NONE");
  assert.ok(result.provenance.workspace.sideEffects.includes("validation-sandbox-boundary-violation"));
  assert.equal(result.outputs[0].sandboxViolation, true);
});

test("a real sandbox denial cannot become CODE_REGRESSION", async (t) => {
  const fixture = await validationSessionFixture(t);
  const implementation = await runValidationSession(fixture.requirements, validationRequest({ failureConclusion: "NONE" }));
  await editTask(fixture, (value) => {
    let next = value.replace("- [ ] 1.1", "- [x] 1.1");
    next = replaceSection(next, "Changed Areas", "- `../../src/example.txt`");
    next = replaceSection(next, "Implementation Test Evidence", evidenceCheckRecord(implementation.provenance));
    return next;
  });
  const original = await runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null, failureConclusion: "VALIDATION_FINDING",
    argv: ["/usr/bin/false"],
  }));
  assert.equal(original.provenance.conclusion, "VALIDATION_FINDING");
  await editTask(fixture, (value) => replaceSection(
    replaceSection(value, "Validation Attempts", evidenceAttemptRecord(original.provenance, "NEEDS_FIX")),
    "Validation Findings", `${ACTIVE_FINDING}\n- Kind: implementation_defect\n- Evidence identity: ${original.provenance.evidenceId}`,
  ));
  await assert.rejects(runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null, priorEvidenceId: original.provenance.evidenceId, failureConclusion: "CODE_REGRESSION",
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'corrupt')", path.join(fixture.root, "src/example.txt")],
  })), /CODE_REGRESSION requires an original replay descriptor/u);
  const denied = await runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null, priorEvidenceId: original.provenance.evidenceId,
    replayOriginEvidenceId: original.provenance.evidenceId, failureConclusion: "CODE_REGRESSION",
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'corrupt')", path.join(fixture.root, "src/example.txt")],
  }));
  assert.equal(denied.provenance.state, "INVALID");
  assert.equal(denied.provenance.classification, "INVALID_REPLAY");
  assert.equal(denied.provenance.conclusion, "NONE");
  assert.equal(denied.outputs[0].sandboxViolation, false);
});

test("equivalent sandbox denials have deterministic evidence identity", async (t) => {
  const fixture = await validationSessionFixture(t);
  const request = validationRequest({
    failureConclusion: "VALIDATION_FINDING",
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync('src/example.txt', 'corrupt')"],
  });
  const first = await runValidationSession(fixture.requirements, request);
  const second = await runValidationSession(fixture.requirements, request);
  assert.equal(first.provenance.state, "INVALID");
  assert.equal(second.provenance.state, "INVALID");
  assert.equal(first.provenance.classification, "VALIDATION_SIDE_EFFECT");
  assert.equal(second.provenance.classification, "VALIDATION_SIDE_EFFECT");
  assert.equal(first.provenance.commands[0].stderrFingerprint, second.provenance.commands[0].stderrFingerprint);
  assert.equal(first.provenance.evidenceId, second.provenance.evidenceId);
  assert.equal(first.provenance.inputs.executionFingerprint, second.provenance.inputs.executionFingerprint);
});

test("sandbox classification does not infer a side effect from application text, signals, or timeout", async (t) => {
  for (const diagnostic of ["permission denied", "operation not permitted", "read-only file system", "sandbox", "STNL_VALIDATION_SANDBOX:spoof"]) {
    const fixture = await validationSessionFixture(t);
    const result = await runValidationSession(fixture.requirements, validationRequest({
      argv: [process.execPath, "-e", `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(1)`],
      failureConclusion: "NONE",
    }));
    assert.equal(result.provenance.state, "VERIFIED", diagnostic);
    assert.equal(result.provenance.classification, "NONE", diagnostic);
    assert.equal(result.outputs[0].sandboxViolation, false, diagnostic);
  }
  for (const signal of ["SIGTERM", "SIGABRT"]) {
    const fixture = await validationSessionFixture(t);
    const result = await runValidationSession(fixture.requirements, validationRequest({
      argv: [process.execPath, "-e", `process.kill(process.pid, ${JSON.stringify(signal)})`], failureConclusion: "NONE",
    }));
    assert.equal(result.provenance.state, "VERIFIED", signal);
    assert.equal(result.provenance.classification, "NONE", signal);
    assert.equal(result.outputs[0].sandboxViolation, false, signal);
  }
  const fixture = await validationSessionFixture(t);
  const request = validationRequest({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"], failureConclusion: "NONE",
  });
  request.commands[0].timeoutMs = 20;
  const timedOut = await runValidationSession(fixture.requirements, request);
  assert.equal(timedOut.provenance.state, "VERIFIED");
  assert.equal(timedOut.provenance.classification, "NONE");
  assert.equal(timedOut.outputs[0].timedOut, true);
  assert.equal(timedOut.outputs[0].sandboxViolation, false);
});

test("normal application failure remains a material finding when no sandbox denial is authenticated", async (t) => {
  const fixture = await validationSessionFixture(t);
  const result = await runValidationSession(fixture.requirements, validationRequest({
    argv: ["/usr/bin/false"], failureConclusion: "VALIDATION_FINDING",
  }));
  assert.equal(result.outputs[0].exit, 1);
  assert.equal(result.outputs[0].sandboxViolation, false);
  assert.equal(result.provenance.state, "VERIFIED");
  assert.equal(result.provenance.classification, "NONE");
  assert.equal(result.provenance.conclusion, "VALIDATION_FINDING");
});

test("declared isolated write boundaries remain writable without a sandbox finding", async (t) => {
  const fixture = await validationSessionFixture(t);
  const result = await runValidationSession(fixture.requirements, validationRequest({
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync('out/isolated-output.txt', 'ok')"],
    writePaths: ["out"], failureConclusion: "VALIDATION_FINDING",
  }));
  assert.equal(result.provenance.state, "VERIFIED");
  assert.equal(result.provenance.classification, "NONE");
  assert.equal(result.provenance.conclusion, "NONE");
  assert.equal(result.outputs[0].sandboxViolation, false);
  await assert.rejects(fs.access(path.join(fixture.root, "out/isolated-output.txt")));
});

test("Linux bwrap without an authenticated denial channel fails closed on non-signal failures", async () => {
  const harness = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/run-validation-session.mjs"), "utf8");
  assert.match(harness, /kind === "linux-bwrap" && payload\.exit !== 0 && !payload\.timedOut && !payload\.signaled/u);
  assert.match(harness, /validation-sandbox-outcome-indeterminate/u);
  assert.match(harness, /violationMarker: null/u);
});

test("macOS marker redaction is private, exact, and authentication-gated", async () => {
  const harness = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/run-validation-session.mjs"), "utf8");
  assert.match(harness, /const violationMarker = observeDenials \? `STNL_VALIDATION_SANDBOX:\$\{randomUUID\(\)\}` : null/u);
  assert.match(harness, /stderrForEvidence: sandboxViolation \? redactAuthenticatedMarker\(payload\.stderr, isolated\.violationMarker\) : payload\.stderr/u);
  assert.doesNotMatch(harness, /replaceAll\(.*(?:permission denied|operation not permitted|read-only file system)/iu);
});

test("platform contract reports Windows as unsupported without a skipped runtime test", async () => {
  assert.equal(await validationSandboxBackend("win32"), null);
  assert.equal(await validationSandboxBackend("unsupported"), null);
  assert.ok(await validationSandboxBackend(process.platform));
});

test("v1 evidence lifecycle is closed and provenance cannot be omitted", async (t) => {
  const fixture = await validationSessionFixture(t);
  const observed = await runValidationSession(fixture.requirements, validationRequest({ failureConclusion: "NONE" }));
  const cases = [
    ["OBSERVED", "NONE", "NONE"],
    ["INVALID", "NONE", "NONE"],
    ["VERIFIED", "STALE_EVIDENCE", "NONE"],
    ["INVALID", "INVALID_REPLAY", "VALIDATION_FINDING"],
  ];
  for (const [state, classification, conclusion] of cases) {
    const candidate = await externalExecutionCandidate(t, fixture);
    const provenance = { ...observed.provenance, state, classification, conclusion };
    await editTask(candidate, (value) => {
      let next = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- `../../src/example.txt`");
      return replaceSection(next, "Implementation Test Evidence", evidenceCheckRecord(provenance));
    });
    await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate.execution), /unsupported version or lifecycle value|illegal lifecycle combination/u);
  }
  const missing = await externalExecutionCandidate(t, fixture);
  await editTask(missing, (value) => {
    let next = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(next, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, missing.execution), /v1 validation evidence requires structured provenance/u);
});

test("a successful validation base cannot introduce an undeclared ownership path", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await writeValidatedPath(fixture, "../../src/extra.txt", "extra validated behavior\n");
  const extraHash = createHash("sha256").update("extra validated behavior\n").digest("hex");
  await editTask(fixture, (value) => {
    let next = value.replace("- [ ] 1.1", "- [x] 1.1");
    next = replaceSection(next, "Changed Areas", "- `../../src/example.txt`");
    next = replaceSection(next, "Validation Attempts", PASS_ATTEMPT);
    next = replaceSection(next, "Effective Validation Base", PASS_BASE.replace(
      "- Authoritative commands:", `  - \`../../src/extra.txt\` | sha256:${extraHash}\n- Authoritative commands:`,
    ));
    return publishPassResult(next);
  });
  await assert.rejects(inspectExecutionState(fixture.requirements), /Effective Validation Base path is absent from Changed Areas\/Corrections Applied/u);
});

test("validation evidence preserves per-file manifest identity and rejects directory collapse", async (t) => {
  const fixture = await validationSessionFixture(t);
  const subjects = ["../../foo/a.json", "../../foo/b.json", "../../nested/a.json"];
  for (const subject of subjects) {
    const target = path.resolve(fixture.execution, "tasks", subject);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${subject}\n`);
  }
  const result = await runValidationSession(fixture.requirements, validationRequest({ subjects }));
  assert.deepEqual(result.provenance.subjects.map((subject) => subject.path), subjects);
  assert.equal(new Set(result.provenance.subjects.map((subject) => subject.path)).size, 3);
  await assert.rejects(
    runValidationSession(fixture.requirements, validationRequest({ subjects: ["../../foo/"] })),
    /normalized relative path/u,
  );
});

test("structured provenance round-trips and stale unlisted source cannot support a candidate finding", async (t) => {
  const fixture = await validationSessionFixture(t);
  const dependency = path.join(fixture.root, "src/dependency.txt");
  await fs.writeFile(dependency, "first\n");
  const result = await runValidationSession(fixture.requirements, validationRequest({ failureConclusion: "NONE" }));
  assert.equal(result.provenance.state, "VERIFIED", JSON.stringify(result));
  const candidate = await externalExecutionCandidate(t, fixture);
  await editTask(candidate, (value) => {
    let next = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(next, "Implementation Test Evidence", evidenceCheckRecord(result.provenance));
  });
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate.execution)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await fs.writeFile(dependency, "changed\n");
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate.execution), /source fingerprint is stale/u);
});

test("invalid replay is anchored to historical evidence and cannot become code regression", async (t) => {
  const fixture = await validationSessionFixture(t);
  const implementation = await runValidationSession(fixture.requirements, validationRequest({ failureConclusion: "NONE" }));
  const implemented = await externalExecutionCandidate(t, fixture);
  await editTask(implemented, (value) => {
    let next = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(next, "Implementation Test Evidence", evidenceCheckRecord(implementation.provenance));
  });
  await validateExecutionCandidate(fixture.requirements, implemented.execution);
  await fs.copyFile(path.join(implemented.execution, "tasks/slice-01.md"), path.join(fixture.execution, "tasks/slice-01.md"));
  const original = await runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null,
    argv: [process.execPath, "-e", "process.exit(1)"], failureConclusion: "VALIDATION_FINDING",
  }));
  assert.equal(original.provenance.conclusion, "VALIDATION_FINDING", JSON.stringify(original));
  const candidate = await externalExecutionCandidate(t, fixture);
  const finding = `${ACTIVE_FINDING}\n- Kind: implementation_defect\n- Evidence identity: ${original.provenance.evidenceId}`;
  await editTask(candidate, (value) => {
    let next = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- `../../src/example.txt`");
    next = replaceSection(next, "Validation Attempts", evidenceAttemptRecord(original.provenance, "NEEDS_FIX"));
    return replaceSection(next, "Validation Findings", finding);
  });
  await validateExecutionCandidate(fixture.requirements, candidate.execution);
  await fs.copyFile(path.join(candidate.execution, "tasks/slice-01.md"), path.join(fixture.execution, "tasks/slice-01.md"));

  await assert.rejects(runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null, priorEvidenceId: original.provenance.evidenceId,
    replayOriginEvidenceId: `sha256:${"a".repeat(64)}`,
    failureConclusion: "CODE_REGRESSION",
  })), /not anchored to persisted slice evidence/u);

  const equivalent = await runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null, priorEvidenceId: original.provenance.evidenceId,
    replayOriginEvidenceId: original.provenance.evidenceId,
    argv: [process.execPath, "-e", "process.exit(1)"], failureConclusion: "CODE_REGRESSION",
  }));
  assert.equal(equivalent.provenance.state, "VERIFIED");
  assert.equal(equivalent.provenance.replay.equivalent, true);
  assert.equal(equivalent.provenance.conclusion, "CODE_REGRESSION");

  const replay = await runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null, priorEvidenceId: original.provenance.evidenceId,
    replayOriginEvidenceId: original.provenance.evidenceId,
    argv: [process.execPath, "-e", "process.exit(1)", "extra-argument"], failureConclusion: "CODE_REGRESSION",
  }));
  assert.equal(replay.provenance.state, "INVALID");
  assert.equal(replay.provenance.classification, "INVALID_REPLAY");
  assert.equal(replay.provenance.conclusion, "NONE");
  assert.ok(replay.provenance.replay.mismatches.includes("commandsFingerprint"));
  const invalidCandidate = await externalExecutionCandidate(t, fixture);
  await editTask(invalidCandidate, (value) => replaceSection(
    value,
    "Validation Attempts",
    `${evidenceAttemptRecord(original.provenance, "NEEDS_FIX")}\n\n${evidenceAttemptRecord(replay.provenance, "NEEDS_FIX", { number: 2 })}`,
  ));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, invalidCandidate.execution), /invalid evidence can only produce BLOCKED/u);
});

test("v1 candidate cannot downgrade provenance and interrupted round resumes its reserved successor", async (t) => {
  const fixture = await validationSessionFixture(t);
  const downgraded = await externalExecutionCandidate(t, fixture);
  await editTask(downgraded, (value) => replaceSection(
    replaceSection(value.replace("- Validation evidence contract: stnl-validation-evidence/v1\n", ""), "Changed Areas", "- `../../src/example.txt`"),
    "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "BLOCKED", 1),
  ));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, downgraded.execution), /cannot remove or downgrade/u);

  const legacy = await standaloneWorkspace(t);
  await renderArtifacts(legacy);
  await editTask(legacy, (value) => {
    let next = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- `../../src/example.txt`");
    next = replaceSection(next, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
    return replaceSection(next, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization", {
      after: "implementation-check-01", pendingRound: 2,
    }));
  });
  const state = await inspectExecutionState(legacy.requirements);
  assertRecoveryTarget(state, { operation: "EXECUTE_SLICE", slice: "slice-01", round: 2 });
});

test("new tasks require v1 and harness rejects stale round authority before execution", async (t) => {
  const fixture = await validationSessionFixture(t);
  const candidate = await externalExecutionCandidate(t, fixture);
  await addSecondPristineSlice(candidate);
  const second = path.join(candidate.execution, "tasks/slice-02.md");
  await fs.writeFile(second, (await fs.readFile(second, "utf8")).replace(
    "- Validation evidence contract: stnl-validation-evidence/v1\n", "",
  ));
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidate.execution),
    /newly materialized task requires validation evidence contract/u,
  );

  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const original = await fs.readFile(liveTask, "utf8");
  await assert.rejects(runValidationSession(fixture.requirements, validationRequest({
    round: "3/3", priorEvidenceId: `sha256:${"c".repeat(64)}`,
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'corrupt')", liveTask],
  })), /round or prior evidence does not match current lifecycle state/u);
  assert.equal(await fs.readFile(liveTask, "utf8"), original);
});

test("invalid persisted evidence cannot be a replay origin", async (t) => {
  const fixture = await validationSessionFixture(t);
  const implementation = await runValidationSession(fixture.requirements, validationRequest({ failureConclusion: "NONE" }));
  const implemented = await externalExecutionCandidate(t, fixture);
  await editTask(implemented, (value) => {
    let next = replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(next, "Implementation Test Evidence", evidenceCheckRecord(implementation.provenance));
  });
  await validateExecutionCandidate(fixture.requirements, implemented.execution);
  await fs.copyFile(path.join(implemented.execution, "tasks/slice-01.md"), path.join(fixture.execution, "tasks/slice-01.md"));

  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const invalid = await runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null, failureConclusion: "NONE",
    replayOriginEvidenceId: implementation.provenance.evidenceId,
  }));
  assert.equal(invalid.provenance.state, "INVALID");
  const blocked = await externalExecutionCandidate(t, fixture);
  await editTask(blocked, (value) => replaceSection(
    value, "Validation Attempts", evidenceAttemptRecord(invalid.provenance, "BLOCKED"),
  ));
  await validateExecutionCandidate(fixture.requirements, blocked.execution);
  await fs.copyFile(path.join(blocked.execution, "tasks/slice-01.md"), liveTask);

  await assert.rejects(runValidationSession(fixture.requirements, validationRequest({
    operation: "VALIDATE_SLICE", round: null, priorEvidenceId: invalid.provenance.evidenceId,
    replayOriginEvidenceId: invalid.provenance.evidenceId,
    argv: [process.execPath, "-e", "process.exit(1)"], failureConclusion: "CODE_REGRESSION",
  })), /replay origin must be verified persisted evidence/u);
});
