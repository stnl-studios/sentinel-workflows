import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ExecutionContractError,
  computeRequirementsAuthority,
  inspectExecutionState,
  preflightExecutionOperation,
} from "../skills/workflows/stnl-execution-closer/runtime/execution-state.mjs";

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

async function renderTasks(fixture, { revision = 1, fingerprint = null } = {}) {
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
  const task = replaceAll(taskTemplate, [
    ["<Name>", "Delivery"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", String(revision)],
    ["<task>", "Implement behavior"], ["<result>", "observable result"], ["<areas>", "src/example.txt"],
    ["<test, command, suite, or observable check>", "node --test"],
  ]);
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
    ["<One coherent delivery and how it is observed.>", "Deliver observable behavior."],
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
      "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
      "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |\n| 02 - Recovery | reconciled result | 01 | AC-001 | src/example.txt | plans/slice-02.md |",
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
    ["<task>", "Reconcile behavior"], ["<result>", "reconciled result"], ["<areas>", "src/example.txt"],
    ["<test, command, suite, or observable check>", "node --test"],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-02.md"), appended, "utf8");
}

async function addSecondPristineSlice(fixture) {
  await editPlan(fixture, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | src/example.txt | plans/slice-01.md |\n| 02 - Later | later result | 01 | AC-001 | src/later.txt | plans/slice-02.md |",
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
      "| 02 - Recovery | reconciled result | 01 | AC-001 | src/example.txt | plans/slice-02.md |",
      "| 02 - Recovery | reconciled result | 01 | AC-001 | src/example.txt | plans/slice-02.md |\n| 03 - Recovery | reconciled result | 02 | AC-001 | src/example.txt | plans/slice-03.md |",
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

const ACTIVE_DIVERGENCE = `### divergence-01

- Severity: blocking
- State: active
- Origin: EXECUTE_SLICE
- Problem: Approved scope omits a required dependency.
- Evidence: The implementation cannot remain inside the slice.
- Required authority operation: REPLAN`;

function attemptRecord(number, status, { type = number === 1 ? "initial" : "revalidation", references = "none", dispositions = "none" } = {}) {
  const id = String(number).padStart(2, "0");
  const commands = status === "BLOCKED" ? "- Commands: none" : "- Commands:\n  - `node --test` | exit:0";
  return `### attempt-${id}

- Type: ${type}
- Status: ${status}
- HEAD: fixture
- Verified scope: ../../src/example.txt
- ${commands.slice(2)}
- Evidence: Objective ${status} evidence.
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
- Findings verified: active finding behavior
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
const NEEDS_FIX_ATTEMPT = attemptRecord(1, "NEEDS_FIX", { references: "finding-01", dispositions: "finding-01 active" });
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
    return replaceSection(result, "Final Result", "- PASS");
  });
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await writeValidatedPath(fixture);
}

test("all execution skills bundle byte-identical self-contained state runtimes", async () => {
  const names = ["execution-state.mjs", "validate-execution-state.mjs"];
  for (const name of names) {
  const copies = await Promise.all(SKILLS.map((skill) => fs.readFile(path.join(ROOT, "skills", "workflows", skill, "runtime", name))));
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
});

test("actual templates render a machine-unambiguous MATERIALIZED_PRISTINE task", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const task = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  assert.doesNotMatch(task, /^### (?:implementation-check|findings-check|attempt)-/gmu);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_TASKS")).state, "MATERIALIZED_PRISTINE");
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
  const replacement = await inspectExecutionState(fixture.requirements);
  assert.equal(replacement.state, "PLANNED_DRAFT");
  assert.equal(replacement.globalPlan.revision, 1);
  assert.equal(replacement.globalPlan.revisionMode, null);
  await editPlan(fixture, (value) => setPlanReviewState(value, true));
  await editSlicePlan(fixture, "slice-01", (value) => setPlanReviewState(value, true));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PLANNED_READY");
  await renderTasks(fixture, { revision: 1, fingerprint: newHash });
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
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-01", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
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
        return replaceSection(result, "Final Result", "- PASS");
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
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_NEEDS_FIX");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1")).state, "VALIDATION_NEEDS_FIX");
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed the correction.`);
    result = result.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "PASS", { references: "finding-01", dispositions: "finding-01 resolved" })}`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return replaceSection(result, "Final Result", "- PASS");
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
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "NEEDS_FIX", { references: "finding-01 finding-02", dispositions: "finding-01 resolved; finding-02 active" })}`);
    return replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed correction.\n\n${secondFinding}`);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_NEEDS_FIX");
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "NEEDS_FIX", { references: "finding-01 finding-02", dispositions: "finding-01 resolved; finding-02 active" })}\n\n${attemptRecord(3, "PASS", { references: "finding-02", dispositions: "finding-02 resolved" })}`);
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed correction.\n\n${secondFinding.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-03 confirmed correction.`);
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 3 }));
    return replaceSection(result, "Final Result", "- PASS");
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
      result = replaceSection(result, `${kind} Test Evidence`, [1, 2, 3].map((round) => checkRecord(prefix, round, "TESTS_FAIL", round, { cycle: "attempt-01" })).join("\n\n"));
      if (kind === "Findings") result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
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
  passed = replaceSection(passed, "Final Result", "- PASS");
  await fs.writeFile(laterPassPath, passed, "utf8");
  await editTasksIndex(laterPass, (value) => value.replace(
    "| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |",
    "| [x] | 02 - Later | later result | 01 | tasks/slice-02.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(laterPass.requirements), /contains operational state after the serial frontier slice-01/u);
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
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("VALIDATE_SLICE", "malformed-output"));
  });
  const malformedState = await inspectExecutionState(malformed.requirements);
  assert.equal(malformedState.state, "RUNNER_RESULT_BLOCKED");
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
  await commitAppendRecovery(fixture, oldHash, newHash, { resolveDivergence: true });
  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "EXECUTION_STARTED");
  assert.equal(recovered.tasks.get("slice-01").divergences[0].state, "resolved");
  // Terminalizing the replacement without PASS ownership is an impossible corrective request.
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-02.md"), (await fs.readFile(path.join(fixture.execution, "tasks/slice-02.md"), "utf8")).replace("- [ ] 1.1", "- [x] 1.1").replace("## Final Result\n\n- pending", "## Final Result\n\n- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 2"));
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |", "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | SUPERSEDED | SUPERSEDED |"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /committed supersessions do not exactly match|invalid later replacement slice/u);
});

test("a later missing integration slice has an executable append-only REPLAN path", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return replaceSection(result, "Final Result", "- PASS");
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
  task = replaceSection(task, "Final Result", "- PASS");
  await fs.writeFile(second, task);
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |", "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | PASS | PASS |"));
  await writeValidatedPath(fixture);
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
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "PASS", { references: "finding-01", dispositions: "finding-01 incorrectly left active" })}`);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return replaceSection(result, "Final Result", "- PASS");
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
      return replaceSection(result, "Final Result", "- PASS");
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

test("formal BLOCKED and selected-slice gates have only legal recovery transitions", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    const checked = value.replace("- [ ] 1.1", "- [x] 1.1");
    return replaceSection(checked, "Validation Attempts", BLOCKED_ATTEMPT);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_BLOCKED");
  assertRecoveryTarget(await inspectExecutionState(fixture.requirements), {
    operation: "VALIDATE_SLICE", slice: "slice-01", owner: "validation-attempt", record: "attempt-01",
  });
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"), /not legal/u);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "VALIDATION_BLOCKED");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "VALIDATION_BLOCKED");

  const incomplete = await standaloneWorkspace(t);
  await renderArtifacts(incomplete);
  await editTask(incomplete, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  await assert.rejects(preflightExecutionOperation(incomplete.requirements, "VALIDATE_SLICE", "1"), /checklist is incomplete/u);
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
    return replaceSection(result, "Final Result", "- PASS");
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
    return replaceSection(result, "Final Result", "- PASS");
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
    return replaceSection(result, "Final Result", "- PASS");
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
    return replaceSection(result, "Final Result", "- PASS");
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  assert.equal((await preflightExecutionOperation(workspace, "CLOSE")).state, "COMPLETE");

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
