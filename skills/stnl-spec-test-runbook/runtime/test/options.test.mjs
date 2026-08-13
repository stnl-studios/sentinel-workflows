import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  inspectWorkspace,
  normalizeRunbookOptions,
  parseStrictJson,
  RUNBOOK_OPTION_DEFAULTS,
} from "../lib/core.mjs";
import { validateManifest } from "../lib/manifest.mjs";
import { copyFixture, readManifest, REPOSITORY_ROOT, SKILL_ROOT } from "./helpers.mjs";

const DEFAULT_CONFIGURATION = structuredClone(RUNBOOK_OPTION_DEFAULTS);

test("options omitted normalize through the runtime authority", () => {
  assert.deepEqual(normalizeRunbookOptions(), DEFAULT_CONFIGURATION);
});

test("empty options materialize every deterministic default", () => {
  assert.deepEqual(normalizeRunbookOptions({}), {
    audience: ["mixed"],
    test_types: ["smoke", "functional", "integration", "acceptance", "negative", "regression"],
    environment: null,
    depth: "detailed",
    data_preparation: ["existing_data"],
    evidence: [
      "screenshot", "video", "request_response", "logs", "generated_ids", "database_result",
      "visual_result", "status_http", "events", "message_to_user",
    ],
    presentation: true,
    helpers: false,
    locale: "en-US",
  });
});

test("invalid RUNBOOK_OPTIONS JSON is rejected before inspection", () => {
  assert.throws(() => parseStrictJson('{"locale":"en-US",}', "RUNBOOK_OPTIONS"), /RUNBOOK_OPTIONS must be valid JSON/u);
  for (const [entry, arguments_] of [
    [path.join(SKILL_ROOT, "runtime", "inspect-workspace.mjs"), [".", "SPEC", "{}", "{"]],
    [path.join(SKILL_ROOT, "runtime", "generate-runbook.mjs"), [".", "missing-manifest.json", "{"]],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...arguments_], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BLOCKED: RUNBOOK_OPTIONS must be valid JSON/u);
  }
});

test("unknown option keys are rejected", () => {
  assert.throws(() => normalizeRunbookOptions({ unknown_option: true }), /unknown fields: unknown_option/u);
  assert.throws(() => normalizeRunbookOptions(null), /RUNBOOK_OPTIONS must be a JSON object/u);
  assert.throws(() => normalizeRunbookOptions([]), /RUNBOOK_OPTIONS must be a JSON object/u);
});

test("unsupported depth enum is rejected", () => {
  assert.throws(() => normalizeRunbookOptions({ depth: "banana" }), /depth must be one of concise\|detailed\|guided/u);
});

test("booleans reject strings and numbers", () => {
  assert.throws(() => normalizeRunbookOptions({ helpers: "yes" }), /helpers must be boolean/u);
  assert.throws(() => normalizeRunbookOptions({ presentation: 1 }), /presentation must be boolean/u);
});

test("arrays reject wrong structure and invalid elements", () => {
  assert.throws(() => normalizeRunbookOptions({ audience: [] }), /audience must be a non-empty array/u);
  assert.throws(() => normalizeRunbookOptions({ test_types: "smoke" }), /test_types must be a non-empty array/u);
  assert.throws(() => normalizeRunbookOptions({ data_preparation: ["banana"] }), /data_preparation\[0\] must be one of/u);
  assert.throws(() => normalizeRunbookOptions({ evidence: ["screenshot", 7] }), /evidence\[1\] must be a concise non-empty string/u);
  assert.throws(() => normalizeRunbookOptions({ evidence: ["screenshot", "screenshot"] }), /must not contain duplicates/u);
});

test("omitted locale deterministically defaults to en-US", () => {
  assert.equal(normalizeRunbookOptions({ depth: "guided" }).locale, "en-US");
});

test("en-US locale is accepted exactly", () => {
  assert.equal(normalizeRunbookOptions({ locale: "en-US" }).locale, "en-US");
});

test("pt-BR locale is accepted exactly", () => {
  assert.equal(normalizeRunbookOptions({ locale: "pt-BR" }).locale, "pt-BR");
});

test("locale aliases, case variants, detection tokens, and other locales are rejected", () => {
  for (const locale of ["en", "pt", "pt_BR", "pt-br", "es-ES", "auto", "system"]) {
    assert.throws(() => normalizeRunbookOptions({ locale }), /locale must be one of en-US\|pt-BR/u, locale);
  }
});

test("custom options normalize to one complete effective configuration", () => {
  const configuration = normalizeRunbookOptions({
    audience: ["functional_qa", "product_owner"],
    test_types: ["smoke", "acceptance"],
    environment: "staging",
    depth: "guided",
    data_preparation: ["fixture"],
    evidence: ["screenshot", "request_response"],
    presentation: false,
    helpers: true,
    locale: "pt-BR",
  });
  assert.deepEqual(configuration, {
    audience: ["functional_qa", "product_owner"],
    test_types: ["smoke", "acceptance"],
    environment: "staging",
    depth: "guided",
    data_preparation: ["fixture"],
    evidence: ["screenshot", "request_response"],
    presentation: false,
    helpers: true,
    locale: "pt-BR",
  });
});

test("inspection configuration is the effective manifest configuration", async (t) => {
  const root = await copyFixture(t);
  const raw = await readManifest(root);
  const options = { locale: "pt-BR", presentation: false };
  const inspection = await inspectWorkspace(root, raw.scope.kind, raw.scope.selection, options);
  raw.configuration = structuredClone(inspection.configuration);
  const manifest = validateManifest(raw, inspection);
  assert.deepEqual(manifest.configuration, inspection.configuration);

  const divergent = structuredClone(raw);
  divergent.configuration.locale = "en-US";
  assert.throws(() => validateManifest(divergent, inspection), /does not exactly match normalized RUNBOOK_OPTIONS/u);

  const incompatible = structuredClone(raw);
  incompatible.configuration = structuredClone(DEFAULT_CONFIGURATION);
  incompatible.helper_artifacts = [{ path: "seed.mjs", purpose: "Seed bounded test data" }];
  const defaultInspection = await inspectWorkspace(root, raw.scope.kind, raw.scope.selection);
  assert.throws(() => validateManifest(incompatible, defaultInspection), /helper_artifacts require RUNBOOK_OPTIONS.helpers=true/u);
});

test("runtime defaults, manifest reference, skill, and launcher remain aligned", async () => {
  const [reference, skill, launcher] = await Promise.all([
    fs.readFile(path.join(SKILL_ROOT, "references", "runbook-manifest.md"), "utf8"),
    fs.readFile(path.join(SKILL_ROOT, "SKILL.md"), "utf8"),
    fs.readFile(path.join(REPOSITORY_ROOT, "templates", "prompts", "spec-test-runbook.md"), "utf8"),
  ]);
  const example = reference.match(/```json\n([\s\S]*?)\n```/u);
  assert.notEqual(example, null);
  assert.deepEqual(JSON.parse(example[1]).configuration, DEFAULT_CONFIGURATION);

  for (const key of Object.keys(DEFAULT_CONFIGURATION)) {
    assert.ok(skill.includes(`\`${key}\``), `SKILL.md omits ${key}`);
    assert.ok(launcher.includes(`\`${key}`), `launcher omits ${key}`);
  }
  for (const locale of ["en-US", "pt-BR"]) {
    assert.ok(skill.includes(locale), `SKILL.md omits ${locale}`);
    assert.ok(reference.includes(locale), `manifest reference omits ${locale}`);
    assert.ok(launcher.includes(locale), `launcher omits ${locale}`);
  }
  assert.match(skill, /<RUNBOOK_SELECTION> \[RUNBOOK_OPTIONS\]/u);
  assert.match(skill, /<MANIFEST_PATH> \[RUNBOOK_OPTIONS\]/u);
});

test("CLI arity permits omitted options and rejects excess arguments", async (t) => {
  const root = await copyFixture(t);
  const inspectEntry = path.join(SKILL_ROOT, "runtime", "inspect-workspace.mjs");
  const omitted = spawnSync(process.execPath, [inspectEntry, root, "SPEC", "{}"], { encoding: "utf8" });
  assert.equal(omitted.status, 0, omitted.stderr);
  assert.deepEqual(JSON.parse(omitted.stdout).configuration, DEFAULT_CONFIGURATION);

  for (const [entry, arguments_, usage] of [
    [inspectEntry, ["spec", "SPEC", "{}", "{}", "extra"], /RUNBOOK_OPTIONS_JSON/u],
    [path.join(SKILL_ROOT, "runtime", "generate-runbook.mjs"), ["spec", "manifest", "{}", "extra"], /RUNBOOK_OPTIONS_JSON/u],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...arguments_], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, usage);
  }
});
