import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateRunbook } from "../generate-runbook.mjs";
import { hasOwnershipMarker, publishRunbook } from "../lib/publish.mjs";
import { copyFixture, externalManifest, SKILL_ROOT } from "./helpers.mjs";

test("generates a real representative index.html and regenerates byte-identically", async (t) => {
  const root = await copyFixture(t);
  const manifest = await externalManifest(root);
  const first = await generateRunbook(root, manifest);
  const bytes = await fs.readFile(first.output);
  assert.equal(first.status, "GENERATED");
  assert.equal(first.scenarios, 3);
  assert.equal(first.coverage_records, 4);
  assert.equal(hasOwnershipMarker(bytes.toString("utf8")), true);
  const second = await generateRunbook(path.join(root, "feature_spec.md"), manifest);
  assert.deepEqual(await fs.readFile(second.output), bytes);
  const entries = await fs.readdir(path.dirname(second.output));
  assert.deepEqual(entries, ["index.html"]);
});

test("unowned existing output blocks without overwriting human content", async (t) => {
  const root = await copyFixture(t);
  const outputRoot = path.join(root, "test-runbook");
  const output = path.join(outputRoot, "index.html");
  await fs.mkdir(outputRoot);
  await fs.writeFile(output, "<!doctype html><title>Human file</title>\n", "utf8");
  const before = await fs.readFile(output);
  await assert.rejects(generateRunbook(root, await externalManifest(root)), /not owned/u);
  assert.deepEqual(await fs.readFile(output), before);
  assert.deepEqual(await fs.readdir(outputRoot), ["index.html"]);
});

test("modified owned output blocks regeneration without losing human annotations", async (t) => {
  const root = await copyFixture(t);
  const manifest = await externalManifest(root);
  const generated = await generateRunbook(root, manifest);
  await fs.appendFile(generated.output, "<p>HUMAN ANNOTATION</p>\n", "utf8");
  const before = await fs.readFile(generated.output);
  await assert.rejects(generateRunbook(root, manifest), /was modified and will not be overwritten/u);
  assert.deepEqual(await fs.readFile(generated.output), before);
  assert.deepEqual(await fs.readdir(path.dirname(generated.output)), ["index.html"]);
});

test("invalid manifest leaves prior generated output byte-identical and no temporary residue", async (t) => {
  const root = await copyFixture(t);
  const manifestPath = await externalManifest(root);
  const generated = await generateRunbook(root, manifestPath);
  const before = await fs.readFile(generated.output);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.scenarios[0].notes.push("password=abcdefghijklmno");
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await assert.rejects(generateRunbook(root, manifestPath), /secret or credential/u);
  assert.deepEqual(await fs.readFile(generated.output), before);
  assert.deepEqual(await fs.readdir(path.dirname(generated.output)), ["index.html"]);
});

test("inconsistent evidence blocks before creating an output", async (t) => {
  const root = await copyFixture(t);
  const manifestPath = await externalManifest(root);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.sources = manifest.sources.filter((source) => !source.path.endsWith("/feature_spec.md"));
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await assert.rejects(generateRunbook(root, manifestPath), /omits mandatory inspected sources/u);
  assert.equal(await fs.stat(path.join(root, "test-runbook")).catch(() => null), null);
});

test("structurally inconsistent SPEC authority blocks before creating an output", async (t) => {
  const invalidStatusRoot = await copyFixture(t, "stnl invalid status fixture ");
  const invalidStatusFeature = path.join(invalidStatusRoot, "feature_spec.md");
  await fs.writeFile(
    invalidStatusFeature,
    (await fs.readFile(invalidStatusFeature, "utf8")).replace("status: ready", "status: inconsistent"),
    "utf8",
  );
  await assert.rejects(generateRunbook(invalidStatusRoot, await externalManifest(invalidStatusRoot)), /invalid documentary status/u);
  assert.equal(await fs.stat(path.join(invalidStatusRoot, "test-runbook")).catch(() => null), null);

  const invalidIndexRoot = await copyFixture(t, "stnl invalid index fixture ");
  const invalidIndexFeature = path.join(invalidIndexRoot, "feature_spec.md");
  await fs.writeFile(
    invalidIndexFeature,
    (await fs.readFile(invalidIndexFeature, "utf8")).replace("  risks: shared/risks.md\n", ""),
    "utf8",
  );
  await assert.rejects(generateRunbook(invalidIndexRoot, await externalManifest(invalidIndexRoot)), /index does not exactly match/u);
  assert.equal(await fs.stat(path.join(invalidIndexRoot, "test-runbook")).catch(() => null), null);

  const invalidCategoryRoot = await copyFixture(t, "stnl invalid category fixture ");
  const invalidCategoryFeature = path.join(invalidCategoryRoot, "feature_spec.md");
  await fs.writeFile(
    invalidCategoryFeature,
    (await fs.readFile(invalidCategoryFeature, "utf8")).replace("  requirements: shared/requirements.md", "  banana: shared/requirements.md"),
    "utf8",
  );
  await assert.rejects(generateRunbook(invalidCategoryRoot, await externalManifest(invalidCategoryRoot)), /unknown or mismatched canonical artifact category/u);
  assert.equal(await fs.stat(path.join(invalidCategoryRoot, "test-runbook")).catch(() => null), null);

  const invalidSharedRoot = await copyFixture(t, "stnl invalid shared fixture ");
  const requirements = path.join(invalidSharedRoot, "shared", "requirements.md");
  await fs.writeFile(requirements, (await fs.readFile(requirements, "utf8")).replace("# Requirements", "# Bananas"), "utf8");
  await assert.rejects(generateRunbook(invalidSharedRoot, await externalManifest(invalidSharedRoot)), /non-canonical category heading/u);
  assert.equal(await fs.stat(path.join(invalidSharedRoot, "test-runbook")).catch(() => null), null);
});

test("closed SPEC rejects extra YAML and malformed canonical records", async (t) => {
  const closedSource = path.join(SKILL_ROOT, "..", "stnl-spec-lifecycle-manager", "examples", "validator-fixtures", "closed");
  for (const [name, mutate, error] of [
    ["extra-yaml", (text) => text.replace("## Objective", "```yaml\nunsafe: duplicate\n```\n\n## Objective"), /YAML beyond/u],
    ["bad-record", (text) => text.replace("### R-001 — Expired invitation is rejected", "### Bananas"), /missing or malformed canonical record headings|non-canonical level-3/u],
    ["broken-reference", (text) => text.replace("verifies: [R-001]", "verifies: [R-999]"), /references missing canonical ID R-999/u],
  ]) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `stnl closed ${name} `));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, "closed-spec");
    await fs.cp(closedSource, root, { recursive: true });
    const feature = path.join(root, "feature_spec.md");
    await fs.writeFile(feature, mutate(await fs.readFile(feature, "utf8")), "utf8");
    const manifest = path.join(temporary, `${name}.json`);
    await fs.copyFile(path.join(SKILL_ROOT, "runtime", "test", "fixtures", "representative-manifest.json"), manifest);
    await assert.rejects(generateRunbook(root, manifest), error);
    assert.equal(await fs.stat(path.join(root, "test-runbook")).catch(() => null), null);
  }
});

test("manifest inside the SPEC is rejected to preserve lifecycle layout", async (t) => {
  const root = await copyFixture(t);
  const inside = path.join(root, "manifest.json");
  await fs.copyFile(await externalManifest(root), inside);
  await assert.rejects(generateRunbook(root, inside), /ephemeral outside the SPEC root|SPEC layout contains non-canonical paths/u);
  assert.equal(await fs.stat(path.join(root, "test-runbook")).catch(() => null), null);
});

test("generates valid explicitly selected SLICE and TASK runbooks", async (t) => {
  const root = await copyFixture(t);
  const base = JSON.parse(await fs.readFile(await externalManifest(root, "base-manifest.json"), "utf8"));
  base.sources = base.sources.filter((source) => !source.path.includes("slice-02"));
  base.scenarios = base.scenarios.filter((scenario) => scenario.id !== "TR-003");
  base.coverage = base.coverage.filter((item) => item.source_id !== "slice-02");

  const sliceManifest = await externalManifest(root, "slice-manifest.json");
  base.scope = { kind: "SLICE", selection: { slice: "1" } };
  await fs.writeFile(sliceManifest, JSON.stringify(base), "utf8");
  const sliceResult = await generateRunbook(root, sliceManifest);
  assert.deepEqual(sliceResult.scope.selection, { slice: "slice-01" });

  const taskManifest = await externalManifest(root, "task-manifest.json");
  base.scope = { kind: "TASK", selection: { slice: "1", task: "1.1" } };
  base.scenarios = base.scenarios.filter((scenario) => scenario.id === "TR-001");
  base.coverage = base.coverage.filter((item) => item.scenario_ids.length === 0 || item.scenario_ids.includes("TR-001"));
  base.sources.find((source) => source.path.endsWith("/execution/tasks/slice-01.md")).ids = ["1.1"];
  await fs.writeFile(taskManifest, JSON.stringify(base), "utf8");
  const taskResult = await generateRunbook(root, taskManifest);
  assert.deepEqual(taskResult.scope.selection, { slice: "slice-01", task: "1.1" });
});

test("CLI runs from an unrelated cwd with spaces and only the Node runtime", async (t) => {
  const root = await copyFixture(t);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stnl unrelated cwd "));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const entry = path.join(SKILL_ROOT, "runtime", "generate-runbook.mjs");
  const result = spawnSync(process.execPath, [entry, root, await externalManifest(root)], {
    cwd,
    encoding: "utf8",
    env: { PATH: "", LANG: "C", LC_ALL: "C" },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "GENERATED");
  assert.equal(output.configuration.locale, "en-US");
  assert.equal(await fs.stat(output.output).then((item) => item.isFile()), true);
});

test("same manifest renders the same bytes under different locale environment", async (t) => {
  const root = await copyFixture(t);
  const entry = path.join(SKILL_ROOT, "runtime", "generate-runbook.mjs");
  const manifest = await externalManifest(root);
  let baseline = null;
  for (const locale of ["C", "pt_BR.UTF-8", "en_US.UTF-8"]) {
    const result = spawnSync(process.execPath, [entry, root, manifest, "{}"], {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale },
    });
    assert.equal(result.status, 0, result.stderr);
    const bytes = await fs.readFile(path.join(root, "test-runbook", "index.html"));
    if (baseline === null) {
      baseline = bytes;
      t.diagnostic(`representative HTML bytes: ${bytes.length}`);
    } else {
      assert.deepEqual(bytes, baseline);
    }
  }
});

test("publisher rejects an output root reached through a symlinked ancestor", async (t) => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stnl publisher boundary ")));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const external = path.join(temporary, "external");
  await fs.mkdir(external);
  const externalIndex = path.join(external, "index.html");
  await fs.writeFile(externalIndex, "EXTERNAL SENTINEL\n", "utf8");
  await fs.symlink(external, path.join(temporary, "linked"));
  await assert.rejects(
    publishRunbook(path.join(temporary, "linked", "test-runbook"), "unreachable"),
    /output parent contains a symlink component/u,
  );
  assert.equal(await fs.readFile(externalIndex, "utf8"), "EXTERNAL SENTINEL\n");
  assert.equal(await fs.stat(path.join(external, "test-runbook")).catch(() => null), null);
});

test("generator rejects a manifest reached through a symlinked ancestor", async (t) => {
  const root = await copyFixture(t);
  const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
  await fs.symlink(root, link);
  t.after(() => fs.unlink(link).catch(() => {}));
  const outside = path.join(path.dirname(root), "manifest-through-link.json");
  await fs.copyFile(await externalManifest(root, "source-manifest.json"), outside);
  await fs.rename(outside, path.join(root, "manifest-through-link.json"));
  await assert.rejects(generateRunbook(root, path.join(link, "manifest-through-link.json")), /manifest contains a symlink component/u);
  assert.equal(await fs.stat(path.join(root, "test-runbook")).catch(() => null), null);
});
