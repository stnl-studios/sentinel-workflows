import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { inspectWorkspace } from "../lib/core.mjs";
import { validateManifest, validateManifestEvidence } from "../lib/manifest.mjs";
import { renderRunbook } from "../lib/render.mjs";
import { copyFixture, readManifest } from "./helpers.mjs";

async function validated(t) {
  const root = await copyFixture(t);
  const raw = await readManifest(root);
  const inspection = await inspectWorkspace(root, raw.scope.kind, raw.scope.selection);
  return { root, raw, inspection, manifest: validateManifest(raw, inspection) };
}

test("renders deterministic semantic self-contained HTML", async (t) => {
  const { manifest } = await validated(t);
  const first = renderRunbook(manifest);
  const second = renderRunbook(structuredClone(manifest));
  assert.equal(first.html, second.html);
  assert.equal(first.fingerprint, second.fingerprint);
  const fingerprintDraft = first.html
    .replaceAll(first.fingerprint, "0".repeat(64))
    .replaceAll(first.fingerprint.slice(0, 12), "0".repeat(12));
  assert.equal(createHash("sha256").update(fingerprintDraft, "utf8").digest("hex"), first.fingerprint);
  assert.match(first.html, /^<!doctype html>\n<!-- stnl-spec-test-runbook:v1 fingerprint:[0-9a-f]{64} -->/u);
  for (const marker of ["<header", "<aside", "<main", "<nav", "<article", "<table", "<footer", "@media print", "aria-live=\"polite\"", "Skip to runbook content"]) {
    assert.ok(first.html.includes(marker), `missing HTML marker: ${marker}`);
  }
  assert.ok(!/\b(?:src|href)=["']https?:/iu.test(first.html));
  assert.ok(!/@import|fetch\s*\(|XMLHttpRequest|WebSocket/iu.test(first.html));
  assert.match(first.html, /default-src 'none'/u);
  assert.match(first.html, /<main id="main-content" tabindex="-1">/u);
  assert.match(first.html, /main\{min-width:0\}/u);
  assert.match(first.html, /body\[data-view="presentation"\] \.operational-only\{display:none\}/u);
  assert.match(first.html, /data-initial-status="blocked"/u);
  assert.match(first.html, /status\.value=card\.dataset\.initialStatus/u);
  assert.match(first.html, /button\.dataset\.viewButton==="presentation"/u);
  assert.match(first.html, /\.execution-capture:not\(\.has-content\)\{display:none!important\}/u);
  assert.match(first.html, /--focus:#005fcc/u);
  assert.ok(first.html.includes("Generated IDs"));
});

test("escapes malicious source content without creating executable elements", async (t) => {
  const { manifest } = await validated(t);
  const { html } = renderRunbook(manifest);
  assert.ok(html.includes("&lt;img src=x onerror=globalThis.pwned=1&gt;"));
  assert.ok(html.includes("&lt;/script&gt;&lt;script&gt;globalThis.pwned=1&lt;/script&gt;"));
  assert.equal((html.match(/<script>/gu) ?? []).length, 1);
  assert.equal((html.match(/<img\b/gu) ?? []).length, 0);
  assert.equal(/onerror\s*=/iu.test(html.replaceAll("&lt;img src=x onerror=", "")), false);
});

test("makes traceability, blockers, evidence, setup, cleanup, and local-state boundary visible", async (t) => {
  const { manifest } = await validated(t);
  const { html } = renderRunbook(manifest);
  for (const expected of [
    "Why this test exists", "R-001", "AC-001", "1.1", "Evidence expected",
    "Blocked initially", "Final confirmation copy", "Global cleanup", "Sources used",
    "Local convenience only", "Browser-local state is never repository evidence",
  ]) assert.ok(html.includes(expected), `missing visible content: ${expected}`);
});

test("print contract reveals essential content and hides controls", async (t) => {
  const { manifest } = await validated(t);
  const { html } = renderRunbook(manifest);
  for (const expected of [
    "@page{margin:12mm}", ".sidebar,.view-switch,.scenario-toolbar,.operational-only,.skip-link,footer{display:none!important}",
    ".scenario{display:block!important", ".scenario-body{display:block!important}", "thead{display:table-header-group}",
  ]) assert.ok(html.includes(expected), `missing print contract: ${expected}`);
});

test("coverage rejects false references and false covered claims", async (t) => {
  const { raw, inspection } = await validated(t);
  const unknown = structuredClone(raw);
  unknown.coverage[0].scenario_ids = ["TR-999"];
  assert.throws(() => validateManifest(unknown, inspection), /unknown scenarios/u);
  const emptyCovered = structuredClone(raw);
  emptyCovered.coverage[0].scenario_ids = [];
  assert.throws(() => validateManifest(emptyCovered, inspection), /requires at least one scenario/u);
});

test("secret values and secret-bearing paths are rejected", async (t) => {
  const { raw, inspection } = await validated(t);
  const secret = structuredClone(raw);
  secret.scenarios[0].notes.push("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
  assert.throws(() => validateManifest(secret, inspection), /secret or credential/u);
  const secretPath = structuredClone(raw);
  secretPath.sources.push({ path: ".env", role: "configuration", ids: [] });
  assert.throws(() => validateManifest(secretPath, inspection), /secret-bearing path/u);
  const environmentSecretPath = structuredClone(raw);
  environmentSecretPath.sources.push({ path: "config/.env.production", role: "configuration", ids: [] });
  assert.throws(() => validateManifest(environmentSecretPath, inspection), /secret-bearing path/u);
  const punctuatedSecret = structuredClone(raw);
  punctuatedSecret.scenarios[0].notes.push("password=abc$123456!");
  assert.throws(() => validateManifest(punctuatedSecret, inspection), /secret or credential/u);
  const cookieSecret = structuredClone(raw);
  cookieSecret.scenarios[0].notes.push("Cookie: sessionid=abcdefghijklmnop");
  assert.throws(() => validateManifest(cookieSecret, inspection), /secret or credential/u);
  const namedSecret = structuredClone(raw);
  namedSecret.scenarios[0].inputs.push({ name: "password", value: "SuperSecret123!" });
  assert.throws(() => validateManifest(namedSecret, inspection), /sensitive name/u);
  const sensitiveValue = structuredClone(raw);
  sensitiveValue.scenarios[0].inputs[1].value = "should-not-be-present";
  assert.throws(() => validateManifest(sensitiveValue, inspection), /sensitive and must omit value/u);
});

test("manifest rejects missing operational fields and inconsistent explicit scope", async (t) => {
  const { raw, inspection } = await validated(t);
  const noSteps = structuredClone(raw);
  noSteps.scenarios[0].steps = [];
  assert.throws(() => validateManifest(noSteps, inspection), /steps must be an array with 1-/u);
  const differentScope = structuredClone(raw);
  differentScope.scope = { kind: "SLICE", selection: { slice: "1" } };
  assert.throws(() => validateManifest(differentScope, inspection), /does not match/u);
});

test("optional top-level evidence sections may be omitted without empty-field boilerplate", async (t) => {
  const { raw, inspection } = await validated(t);
  for (const field of ["setup", "data_preparation", "coverage", "risks", "known_issues", "gaps", "cleanup", "helper_artifacts"]) {
    delete raw[field];
  }
  const manifest = validateManifest(raw, inspection);
  assert.deepEqual(manifest.setup, []);
  assert.deepEqual(manifest.data_preparation, []);
  assert.deepEqual(manifest.coverage, []);
  assert.deepEqual(manifest.gaps, []);
  assert.doesNotThrow(() => renderRunbook(manifest));
});

test("presentation option deterministically controls presentation-mode availability", async (t) => {
  const { raw, inspection } = await validated(t);
  raw.configuration.presentation = false;
  const { html } = renderRunbook(validateManifest(raw, inspection));
  assert.equal(html.includes('data-view-button="presentation"'), false);
  assert.ok(html.includes('data-view-button="operational"'));
});

test("scenario and source ordering is stable and independent of input object key order", async (t) => {
  const { raw, inspection } = await validated(t);
  raw.scenarios.reverse();
  raw.sources.reverse();
  raw.coverage.reverse();
  const manifest = validateManifest(raw, inspection);
  assert.deepEqual(manifest.scenarios.map((item) => item.id), ["TR-001", "TR-002", "TR-003"]);
  assert.deepEqual(manifest.sources.map((item) => item.path), [...manifest.sources.map((item) => item.path)].sort());
  const rendered = renderRunbook(manifest);
  assert.ok(rendered.html.indexOf("TR-001") < rendered.html.indexOf("TR-002"));
});

test("source files, declared IDs, origins, and coverage are backed by inspected evidence", async (t) => {
  const { root, raw, inspection, manifest } = await validated(t);
  await assert.doesNotReject(validateManifestEvidence(manifest, inspection));

  const omittedMandatory = structuredClone(raw);
  omittedMandatory.sources = omittedMandatory.sources.filter((source) => !source.path.endsWith("/feature_spec.md"));
  await assert.rejects(validateManifestEvidence(validateManifest(omittedMandatory, inspection), inspection), /omits mandatory inspected sources/u);

  const missingFile = structuredClone(raw);
  missingFile.sources.push({ path: "docs/missing.md", role: "documentation", ids: [] });
  await assert.rejects(validateManifestEvidence(validateManifest(missingFile, inspection), inspection), /does not exist/u);

  await fs.symlink("shared/requirements.md", path.join(root, "linked-source.md"));
  const linkedSource = structuredClone(raw);
  const specRelative = path.relative(inspection.source_root, await fs.realpath(root)).split(path.sep).join("/");
  linkedSource.sources.push({ path: `${specRelative}/linked-source.md`, role: "requirements", ids: [] });
  await assert.rejects(validateManifestEvidence(validateManifest(linkedSource, inspection), inspection), /must be a single-link real file/u);

  const absentId = structuredClone(raw);
  absentId.sources.find((source) => source.path.endsWith("/shared/requirements.md")).ids.push("R-999");
  await assert.rejects(validateManifestEvidence(validateManifest(absentId, inspection), inspection), /R-999 is not present/u);

  const prefixCollisionPath = path.join(root, "prefix-collision.md");
  await fs.writeFile(prefixCollisionPath, "# R-0010 only\n", "utf8");
  const prefixCollision = structuredClone(raw);
  prefixCollision.sources.push({ path: `${specRelative}/prefix-collision.md`, role: "requirements", ids: ["R-001"] });
  await assert.rejects(validateManifestEvidence(validateManifest(prefixCollision, inspection), inspection), /exact canonical token/u);

  const narrativeOnlyId = structuredClone(raw);
  const featureSource = narrativeOnlyId.sources.find((source) => source.path.endsWith("/feature_spec.md"));
  featureSource.ids.push("D-011");
  narrativeOnlyId.scenarios[0].origins.push({ kind: "decision", ref: "D-011" });
  await fs.appendFile(path.join(root, "feature_spec.md"), "\nNarrative origin only: initial-scaffold/D-011.\n- D-011\n", "utf8");
  await assert.rejects(validateManifestEvidence(validateManifest(narrativeOnlyId, inspection), inspection), /D-011 is not present as an exact canonical token/u);

  const incidentalTask = structuredClone(raw);
  const taskSource = incidentalTask.sources.find((source) => source.path.endsWith("/execution/tasks/slice-02.md"));
  taskSource.ids.push("9.9");
  incidentalTask.scenarios[0].origins.push({ kind: "task", ref: "9.9" });
  await fs.appendFile(path.join(root, "execution", "tasks", "slice-02.md"), "\n- [ ] 9.9 Incidental evidence only.\n", "utf8");
  await assert.rejects(validateManifestEvidence(validateManifest(incidentalTask, inspection), inspection), /9.9 is not present as an exact canonical token/u);

  const incidentalSlice = structuredClone(raw);
  const planSource = incidentalSlice.sources.find((source) => source.path.endsWith("/execution/plan.md"));
  planSource.ids.push("slice-99");
  incidentalSlice.scenarios[0].origins.push({ kind: "slice", ref: "slice-99" });
  await fs.appendFile(path.join(root, "execution", "plan.md"), "\n| 99 - Incidental | none | - | AC-001 | none | plans/slice-99.md |\n", "utf8");
  await assert.rejects(validateManifestEvidence(validateManifest(incidentalSlice, inspection), inspection), /slice-99 is not present as an exact canonical token/u);

  const inventedOrigin = structuredClone(raw);
  inventedOrigin.scenarios[0].origins.push({ kind: "acceptance_criterion", ref: "AC-999" });
  await assert.rejects(validateManifestEvidence(validateManifest(inventedOrigin, inspection), inspection), /origin AC-999 is not backed/u);

  const inventedCoverage = structuredClone(raw);
  inventedCoverage.coverage.push({ source_id: "R-999", title: "Invented", status: "no_scenario", scenario_ids: [], rationale: "No source." });
  await assert.rejects(validateManifestEvidence(validateManifest(inventedCoverage, inspection), inspection), /coverage source R-999 is not backed/u);

  const undeclaredPreparation = structuredClone(raw);
  undeclaredPreparation.data_preparation[0].source = "data/undeclared.json";
  await assert.rejects(validateManifestEvidence(validateManifest(undeclaredPreparation, inspection), inspection), /data preparation source is not declared/u);
});

test("slice and task evidence cannot include an unselected slice or task", async (t) => {
  const { root, raw } = await validated(t);
  const sliceInspection = await inspectWorkspace(root, "SLICE", { slice: "1" });
  raw.scope = { kind: "SLICE", selection: { slice: "1" } };
  const sliceManifest = validateManifest(raw, sliceInspection);
  await assert.rejects(validateManifestEvidence(sliceManifest, sliceInspection), /conflicts with explicit SLICE selection/u);

  const taskInspection = await inspectWorkspace(root, "TASK", { slice: "1", task: "1.1" });
  raw.scope = { kind: "TASK", selection: { slice: "1", task: "1.1" } };
  raw.sources = raw.sources.filter((source) => !source.path.includes("slice-02"));
  raw.scenarios = raw.scenarios.filter((scenario) => scenario.id === "TR-001");
  raw.coverage = raw.coverage.filter((item) => item.scenario_ids.length === 0 || item.scenario_ids.includes("TR-001"));
  raw.scenarios[0].origins.push({ kind: "task", ref: "1.2" });
  const taskManifest = validateManifest(raw, taskInspection);
  await assert.rejects(validateManifestEvidence(taskManifest, taskInspection), /conflicts with explicit task selection/u);

  const missingTaskOrigin = structuredClone(raw);
  missingTaskOrigin.scenarios = missingTaskOrigin.scenarios.filter((scenario) => scenario.id === "TR-001");
  missingTaskOrigin.scenarios[0].origins = missingTaskOrigin.scenarios[0].origins.filter((origin) => origin.kind !== "task");
  missingTaskOrigin.coverage = missingTaskOrigin.coverage.filter((item) => item.scenario_ids.length === 0 || item.scenario_ids.includes("TR-001"));
  const missingTaskManifest = validateManifest(missingTaskOrigin, taskInspection);
  await assert.rejects(validateManifestEvidence(missingTaskManifest, taskInspection), /does not trace to explicitly selected task/u);
});
