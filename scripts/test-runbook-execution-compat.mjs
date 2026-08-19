import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectWorkspace } from "../skills/workflows/stnl-spec-test-runbook/runtime/lib/core.mjs";
import { computeRequirementsAuthority, inspectExecutionState } from "../skills/workflows/stnl-task-materializer/runtime/execution-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPRESENTATIVE = path.join(ROOT, "skills/workflows/stnl-spec-test-runbook/runtime/test/fixtures/representative");

function replaceAll(text, replacements) {
  let result = text;
  for (const [before, after] of replacements) result = result.replaceAll(before, after);
  return result;
}

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stnl-runbook-execution-compat-")));
  const spec = path.join(temporary, "representative");
  await fs.cp(REPRESENTATIVE, spec, { recursive: true });
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return spec;
}

async function renderRealTemplateExecution(spec) {
  const execution = path.join(spec, "execution");
  await fs.rm(execution, { recursive: true, force: true });
  await fs.mkdir(path.join(execution, "plans"), { recursive: true });
  await fs.mkdir(path.join(execution, "tasks"), { recursive: true });
  const authority = await computeRequirementsAuthority(spec);

  const planTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  const plan = replaceAll(planTemplate, [
    ["`<relative path>`", "`../feature_spec.md`"], ["sha256:<64hex>", `sha256:${authority}`],
    ["<positive integer>", "1"], ["<compact objective>", "Deliver one observable invitation behavior"],
    ["<compact strategy>", "Implement and validate the single slice"], ["01 - <name>", "01 - Invitation API"],
    ["<result>", "eligible invitation is accepted"], ["<areas>", "invitation service"],
  ]).replace("status: draft", "status: ready")
    .replace("Review state: pending", "Review state: approved")
    .replace(/\nFor revision 1,[\s\S]*?\n## Serial Slice Order/u, "\n## Serial Slice Order");
  await fs.writeFile(path.join(execution, "plan.md"), plan, "utf8");

  const sliceTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  const slice = replaceAll(sliceTemplate, [
    ["<Name>", "Invitation API"], ["`<relative path>`", "`../../feature_spec.md`"],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", "1"],
    ["<One coherent delivery and how it is observed.>", "Eligible invitations produce the approved API response."],
    ["<included work>", "Invitation acceptance behavior."], ["<excluded work and boundary with later slices>", "No UI work."],
    ["<path, contract, subsystem, or test area>", "invitation service"], ["<earlier slice or none>", "none"],
    ["<risk and mitigation>", "Low risk; use stable fixtures."], ["<bounded approach>", "One bounded service change."],
    ["<test, command, suite, or observable check>", "invitation integration test"],
    ["<objective result and preserved boundary>", "Eligible acceptance is observable without UI changes."],
  ]).replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved");
  await fs.writeFile(path.join(execution, "plans/slice-01.md"), slice, "utf8");

  const tasksTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/tasks.template.md"), "utf8");
  await fs.writeFile(path.join(execution, "tasks.md"), replaceAll(tasksTemplate, [
    ["01 - <name>", "01 - Invitation API"], ["<observable delivery>", "eligible invitation is accepted"],
  ]), "utf8");
  const taskTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  const task = replaceAll(taskTemplate, [
    ["<Name>", "Invitation API"], ["`<relative path>`", "`../../feature_spec.md`"],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", "1"],
    ["<task>", "Implement eligible invitation acceptance"], ["<result>", "HTTP 201 and one participation"],
    ["<areas>", "invitation service"], ["<test, command, suite, or observable check>", "invitation integration test"],
  ]);
  await fs.writeFile(path.join(execution, "tasks/slice-01.md"), task, "utf8");
}

test("operational runbook fixture is valid shared execution state", async (t) => {
  const spec = await fixture(t);
  assert.equal((await inspectWorkspace(spec, "EXECUTION", {})).scope.kind, "EXECUTION");
  assert.equal((await inspectExecutionState(spec)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("real planner and materializer templates are accepted by both execution consumers", async (t) => {
  const spec = await fixture(t);
  await renderRealTemplateExecution(spec);
  const runbook = await inspectWorkspace(spec, "EXECUTION", {});
  const execution = await inspectExecutionState(spec);
  assert.equal(runbook.scope.kind, "EXECUTION");
  assert.equal(runbook.mandatory_sources.filter((source) => source.endsWith("execution/tasks/slice-01.md")).length, 1);
  assert.equal(execution.state, "MATERIALIZED_PRISTINE");
});

test("runbook rejects execution artifacts after current requirements authority changes", async (t) => {
  const spec = await fixture(t);
  const requirements = path.join(spec, "shared/requirements.md");
  await fs.writeFile(requirements, (await fs.readFile(requirements, "utf8")).replace("creates participation exactly once", "creates participation at most once"), "utf8");
  assert.equal((await inspectExecutionState(spec)).state, "REQUIREMENTS_CHANGED");
  await assert.rejects(inspectWorkspace(spec, "EXECUTION", {}), /Requirements authority is stale relative to current requirements/u);
});

test("runbook rejects malformed persisted execution evidence", async (t) => {
  const spec = await fixture(t);
  const taskPath = path.join(spec, "execution/tasks/slice-02.md");
  const task = await fs.readFile(taskPath, "utf8");
  await fs.writeFile(taskPath, task.replace("## Validation Findings\n\n- none", `## Validation Findings

### finding-01

- Severity: blocking
- State: active
- Origin: attempt-99
- Problem: orphaned formal finding
- Evidence: no matching attempt exists
- Impact: closure would be ambiguous
- Related authority: AC-001
- Expected correction: reconcile formal evidence
- Links: AC-001`), "utf8");
  await assert.rejects(inspectWorkspace(spec, "EXECUTION", {}), /Origin must name an existing NEEDS_FIX attempt/u);
});
