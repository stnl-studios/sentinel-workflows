import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectWorkspace, normalizeSlice, resolveWorkspace } from "../lib/core.mjs";
import { copyFixture } from "./helpers.mjs";

test("resolves modular directory and feature_spec.md to the same canonical roots", async (t) => {
  const root = await copyFixture(t);
  const fromDirectory = await resolveWorkspace(root);
  const fromFile = await resolveWorkspace(path.join(root, "feature_spec.md"));
  const physicalRoot = await fs.realpath(root);
  assert.deepEqual(fromDirectory, fromFile);
  assert.equal(fromDirectory.executionRoot, path.join(physicalRoot, "execution"));
  assert.equal(fromDirectory.outputRoot, path.join(physicalRoot, "test-runbook"));
});

test("derives standalone execution and output siblings without creating them", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "stnl standalone requirements "));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const authority = path.join(temporary, "requirements v2.md");
  await fs.writeFile(authority, "# Requirements\n", "utf8");
  const workspace = await resolveWorkspace(authority);
  const physicalTemporary = await fs.realpath(temporary);
  assert.equal(workspace.executionRoot, path.join(physicalTemporary, "requirements v2-execution"));
  assert.equal(workspace.outputRoot, path.join(physicalTemporary, "requirements v2-test-runbook"));
  assert.equal(await fs.stat(workspace.outputRoot).catch(() => null), null);
});

test("normalizes only unsigned unprefixed slices", () => {
  assert.equal(normalizeSlice("0"), "slice-00");
  assert.equal(normalizeSlice("7"), "slice-07");
  assert.equal(normalizeSlice("123"), "slice-123");
  for (const invalid of ["", "-1", "+1", "1.0", "slice-01", "01", " 1", "1 "]) {
    assert.throws(() => normalizeSlice(invalid), /unsigned decimal/u);
  }
});

test("requires explicit scope selection and returns bounded canonical sources", async (t) => {
  const root = await copyFixture(t);
  await assert.rejects(inspectWorkspace(root, "SLICE", {}), /slice is required/u);
  await assert.rejects(inspectWorkspace(root, "TASK", { slice: "1" }), /slice and task are required/u);
  await assert.rejects(inspectWorkspace(root, "MULTI_SLICE", { slices: [] }), /at least two slices/u);
  await assert.rejects(inspectWorkspace(root, "MULTI_SLICE", { slices: ["1"] }), /at least two slices/u);
  const slice = await inspectWorkspace(root, "SLICE", { slice: "1" });
  const physicalRoot = await fs.realpath(root);
  assert.deepEqual(slice.scope.selection, { slice: "slice-01" });
  assert.ok(slice.mandatory_sources.includes(path.join(physicalRoot, "execution", "plans", "slice-01.md")));
  assert.ok(slice.mandatory_sources.includes(path.join(physicalRoot, "execution", "tasks", "slice-01.md")));
  assert.ok(!slice.mandatory_sources.includes(path.join(physicalRoot, "execution", "plans", "slice-02.md")));
});

test("orders an explicit multi-slice set by the canonical serial plan", async (t) => {
  const root = await copyFixture(t);
  const inspected = await inspectWorkspace(root, "MULTI_SLICE", { slices: ["2", "1"] });
  assert.deepEqual(inspected.scope.selection, { slices: ["slice-01", "slice-02"] });
  await assert.rejects(inspectWorkspace(root, "MULTI_SLICE", { slices: ["1", "1"] }), /duplicates/u);
  await assert.rejects(inspectWorkspace(root, "MULTI_SLICE", { slices: ["1", "3"] }), /absent from plan/u);

  const plan = path.join(root, "execution", "plan.md");
  await fs.writeFile(plan, (await fs.readFile(plan, "utf8")).replace("- Objective:", "- Incidental reference: plans/slice-02.md\n- Objective:"), "utf8");
  const withIncidentalReference = await inspectWorkspace(root, "MULTI_SLICE", { slices: ["2", "1"] });
  assert.deepEqual(withIncidentalReference.scope.selection.slices, ["slice-01", "slice-02"]);
});

test("TASK requires one exact persisted label paired with its slice", async (t) => {
  const root = await copyFixture(t);
  const inspected = await inspectWorkspace(root, "TASK", { slice: "1", task: "1.1" });
  assert.deepEqual(inspected.scope.selection, { slice: "slice-01", task: "1.1" });
  await assert.rejects(inspectWorkspace(root, "TASK", { slice: "1", task: "2.1" }), /occur exactly once/u);
  await assert.rejects(inspectWorkspace(root, "TASK", { slice: "1", task: "task-1" }), /numeric task label/u);

  const tasks = path.join(root, "execution", "tasks", "slice-01.md");
  let taskText = await fs.readFile(tasks, "utf8");
  taskText = taskText
    .replace(/^- \[x\] 1\.1 .*\n/mu, "")
    .replace("## Diff Summary\n", "## Diff Summary\n\n- 1.1 Incidental evidence mention only.\n");
  await fs.writeFile(tasks, taskText, "utf8");
  await assert.rejects(inspectWorkspace(root, "TASK", { slice: "1", task: "1.1" }), /occur exactly once/u);
});

test("execution discovery requires canonical approved plan and task artifacts", async (t) => {
  const root = await copyFixture(t);
  const plan = path.join(root, "execution", "plans", "slice-01.md");
  await fs.writeFile(plan, (await fs.readFile(plan, "utf8")).replace("Review state: approved", "Review state: pending"), "utf8");
  await assert.rejects(inspectWorkspace(root, "SLICE", { slice: "1" }), /status and Review state disagree/u);

  const residueRoot = await copyFixture(t);
  await fs.writeFile(path.join(residueRoot, "execution", "analysis.tmp"), "residue\n", "utf8");
  await assert.rejects(inspectWorkspace(residueRoot, "SLICE", { slice: "1" }), /non-canonical paths.*analysis\.tmp/u);

  const orphanRoot = await copyFixture(t);
  await fs.copyFile(
    path.join(orphanRoot, "execution", "plans", "slice-01.md"),
    path.join(orphanRoot, "execution", "plans", "slice-99.md"),
  );
  await assert.rejects(inspectWorkspace(orphanRoot, "EXECUTION", {}), /non-canonical paths.*tasks.*slice-99\.md/u);

  const pairedOrphanRoot = await copyFixture(t);
  for (const directory of ["plans", "tasks"]) {
    await fs.copyFile(
      path.join(pairedOrphanRoot, "execution", directory, "slice-02.md"),
      path.join(pairedOrphanRoot, "execution", directory, "slice-99.md"),
    );
  }
  await assert.rejects(inspectWorkspace(pairedOrphanRoot, "EXECUTION", {}), /plans directory does not exactly match the current Serial Slice Order/u);

  const missingGlobalRowRoot = await copyFixture(t);
  const globalTasks = path.join(missingGlobalRowRoot, "execution", "tasks.md");
  await fs.writeFile(
    globalTasks,
    (await fs.readFile(globalTasks, "utf8")).replace(/^\| \[ \] \| 02 - .*\n/mu, ""),
    "utf8",
  );
  await assert.rejects(inspectWorkspace(missingGlobalRowRoot, "EXECUTION", {}), /plan\/task slice mappings or serial order disagree/u);

  const externalSiblingRoot = await copyFixture(t);
  const externalSibling = path.join(externalSiblingRoot, "analysis.tmp");
  await fs.writeFile(externalSibling, "lifecycle-preserved user content\n", "utf8");
  await inspectWorkspace(externalSiblingRoot, "EXECUTION", {});
  assert.equal(await fs.readFile(externalSibling, "utf8"), "lifecycle-preserved user content\n");

  const missingBlockerRoot = await copyFixture(t);
  const missingBlockerTask = path.join(missingBlockerRoot, "execution/tasks/slice-01.md");
  await fs.writeFile(missingBlockerTask, (await fs.readFile(missingBlockerTask, "utf8")).replace(/\n## Delegation Blocker\n\n- none\n/u, ""), "utf8");
  await assert.rejects(inspectWorkspace(missingBlockerRoot, "SLICE", { slice: "1" }), /non-canonical sections/u);

  const mismatchedAuthorityRoot = await copyFixture(t);
  const mismatchedTask = path.join(mismatchedAuthorityRoot, "execution/tasks/slice-01.md");
  await fs.writeFile(mismatchedTask, (await fs.readFile(mismatchedTask, "utf8")).replace("Plan revision: 1", "Plan revision: 2"), "utf8");
  await assert.rejects(inspectWorkspace(mismatchedAuthorityRoot, "SLICE", { slice: "1" }), /open slice is stale relative to current global authority/u);
});

test("modular discovery accepts the canonical blocked status for questions authority", async (t) => {
  const root = await copyFixture(t);
  const feature = path.join(root, "feature_spec.md");
  let featureText = await fs.readFile(feature, "utf8");
  featureText = featureText
    .replace("status: ready", "status: blocked")
    .replace("  risks: shared/risks.md\n", "  risks: shared/risks.md\n  questions: shared/questions.md\n")
    .replace("blocking_questions: []", "blocking_questions: [Q-001]");
  await fs.writeFile(feature, featureText, "utf8");
  await fs.writeFile(path.join(root, "shared", "questions.md"), `# File Purpose Header

\`\`\`yaml
purpose: Canonical blocking questions for invitation acceptance.
status: blocked
read_when: A blocker or review finding names an invitation question.
do_not_read_when: No current concern requires a question from this file.
contains: Q canonical question artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain blockers and their explicit resolutions.
\`\`\`

# Questions

### Q-001 — Which copy is approved

- status: open
- classification: blocking
- blocks: [AC-001]

#### Pergunta

Which confirmation copy is approved?

#### Por que importa

The answer determines the observable confirmation required by AC-001.

#### Resolução

Pendente.
`, "utf8");
  const inspected = await inspectWorkspace(root, "CUSTOM", { anchors: ["Q-001"], paths: [] });
  assert.ok(inspected.mandatory_sources.includes(path.join(await fs.realpath(root), "shared", "questions.md")));
});

test("modular discovery rejects documentary status inconsistent with blockers", async (t) => {
  const root = await copyFixture(t);
  const feature = path.join(root, "feature_spec.md");
  await fs.writeFile(feature, (await fs.readFile(feature, "utf8")).replace("status: ready", "status: blocked"), "utf8");
  await assert.rejects(inspectWorkspace(root, "SPEC", {}), /blocked feature_spec\.md requires a documentary blocker/u);
});

test("modular discovery accepts the canonical empty draft requirements sentinel", async (t) => {
  const root = await copyFixture(t);
  const feature = path.join(root, "feature_spec.md");
  let text = await fs.readFile(feature, "utf8");
  text = text
    .replace("status: ready", "status: draft")
    .replace(/## Requirements\n\n[\s\S]*?\n\n## Business Rules/u, "## Requirements\n\n- Not established.\n\n## Business Rules")
    .replace(/```yaml\nartifacts:[\s\S]*?```/u, "```yaml\nartifacts: {}\n```");
  await fs.writeFile(feature, text, "utf8");
  await fs.rm(path.join(root, "shared"), { recursive: true });
  const inspected = await inspectWorkspace(root, "CUSTOM", { anchors: ["missing requirements"], paths: [] });
  assert.deepEqual(inspected.mandatory_sources, [await fs.realpath(feature)]);
});

test("CUSTOM accepts only explicit bounded real source paths", async (t) => {
  const root = await copyFixture(t);
  const inspected = await inspectWorkspace(root, "CUSTOM", {
    anchors: ["AC-001"],
    paths: ["test/fixtures/invitations.json"],
  });
  assert.deepEqual(inspected.scope.selection, {
    anchors: ["AC-001"],
    paths: ["test/fixtures/invitations.json"],
  });
  await assert.rejects(inspectWorkspace(root, "CUSTOM", { anchors: [], paths: [] }), /non-empty bounded/u);
  await assert.rejects(inspectWorkspace(root, "CUSTOM", { anchors: ["AC-001"], paths: ["../outside.md"] }), /forbidden path segment/u);
});

test("CUSTOM rejects a non-array paths value with a stable contract error", async (t) => {
  const root = await copyFixture(t);
  await assert.rejects(
    inspectWorkspace(root, "CUSTOM", { anchors: ["AC-001"], paths: "shared/requirements.md" }),
    /paths must be an array/u,
  );
});

test("controlled authority and custom paths reject symlinks", async (t) => {
  const root = await copyFixture(t);
  const real = path.join(root, "real.md");
  const link = path.join(root, "linked.md");
  await fs.writeFile(real, "# Real\n", "utf8");
  await fs.symlink("real.md", link);
  await assert.rejects(inspectWorkspace(root, "CUSTOM", { anchors: ["AC-001"], paths: ["linked.md"] }), /must be a single-link real file/u);

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stnl external source "));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "outside.md"), "# Outside\n", "utf8");
  await fs.symlink(outside, path.join(root, "linked-directory"));
  await assert.rejects(
    inspectWorkspace(root, "CUSTOM", { anchors: ["AC-001"], paths: ["linked-directory/outside.md"] }),
    /single-link real file|symlink component or escapes/u,
  );
});

test("controlled authority paths reject hard links", async (t) => {
  const root = await copyFixture(t);
  const feature = path.join(root, "feature_spec.md");
  await fs.link(feature, path.join(root, "feature-spec-hardlink.md"));
  await assert.rejects(inspectWorkspace(root, "SPEC", {}), /single-link real file/u);

  const sharedRoot = await copyFixture(t);
  const outside = path.join(path.dirname(path.resolve(sharedRoot, "..", "..", "..")), "requirements-hardlink.md");
  await fs.link(path.join(sharedRoot, "shared", "requirements.md"), outside);
  await assert.rejects(inspectWorkspace(sharedRoot, "SPEC", {}), /shared authority must be a single-link real file/u);
});

test("slice discovery rejects symlinked execution plan and task directories", async (t) => {
  const root = await copyFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stnl external plans "));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.cp(path.join(root, "execution", "plans"), outside, { recursive: true });
  await fs.rm(path.join(root, "execution", "plans"), { recursive: true });
  await fs.symlink(outside, path.join(root, "execution", "plans"));
  await assert.rejects(inspectWorkspace(root, "SLICE", { slice: "1" }), /non-canonical paths|execution plans directory|symlink component/u);
});

test("SPEC and CUSTOM discovery reject secret-bearing paths before reading", async (t) => {
  const root = await copyFixture(t);
  await fs.writeFile(path.join(root, ".env.production"), "TOKEN=do-not-read\n", "utf8");
  await assert.rejects(
    inspectWorkspace(root, "CUSTOM", { anchors: ["AC-001"], paths: [".env.production"] }),
    /secret-bearing path/u,
  );
  await assert.rejects(resolveWorkspace(path.join(root, ".env.production")), /secret-bearing path/u);
});

test("ignored macOS metadata never enters discovery evidence", async (t) => {
  const root = await copyFixture(t);
  await fs.writeFile(path.join(root, "shared", ".DS_Store"), "ignored", "utf8");
  await fs.writeFile(path.join(root, "shared", "._requirements.md"), "ignored", "utf8");
  await fs.mkdir(path.join(root, "shared", "__MACOSX"));
  const inspected = await inspectWorkspace(root, "SPEC", {});
  assert.equal(inspected.mandatory_sources.some((entry) => entry.includes(".DS_Store") || entry.includes("._") || entry.includes("__MACOSX")), false);
});
