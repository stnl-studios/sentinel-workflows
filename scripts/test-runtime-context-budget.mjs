#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { metrics, validateBaseline, validateCurrent } from "./lib/runtime-context-budget.mjs";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(
  ROOT,
  "skills",
  "workflows",
  "stnl-spec-lifecycle-manager",
  "maintenance",
  "runtime-context-budget.json",
);
const SKILL = "skills/workflows/stnl-spec-lifecycle-manager/SKILL.md";
const MODES = "skills/workflows/stnl-spec-lifecycle-manager/references/modes.md";
const WORKSPACE = "skills/workflows/stnl-spec-lifecycle-manager/references/spec-workspace.md";
const SCHEMA = "skills/workflows/stnl-spec-lifecycle-manager/references/spec-schema.md";
const GATES = "skills/workflows/stnl-spec-lifecycle-manager/references/readiness-gates.md";
const IDS = "skills/workflows/stnl-spec-lifecycle-manager/references/canonical-ids.md";
const CLOSE_POLICY = "skills/workflows/stnl-spec-lifecycle-manager/references/close-policy.md";
const EXPECTED_RUNTIME = Object.freeze({
  INIT_DRAFT: [SKILL, MODES, WORKSPACE, SCHEMA],
  INIT_READY: [SKILL, MODES, WORKSPACE, SCHEMA, GATES, IDS],
  RESUME_FOCUSED: [SKILL, MODES, WORKSPACE],
  READINESS_LOCAL: [SKILL, MODES, GATES],
  READINESS_GLOBAL: [SKILL, MODES, GATES],
  CLOSE: [SKILL, MODES, GATES, CLOSE_POLICY],
});

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));

const snapshot = JSON.parse(await readFile(join(dirname(MANIFEST_PATH), "runtime-context-baseline.snapshot.json"), "utf8"));

async function currentMetrics(paths) {
  return metrics(await Promise.all(paths.map((path) => readFile(join(ROOT, path)))));
}

test("manifest has canonical runtime dependencies and excludes maintenance resources", async () => {
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(manifest.embedded_runtime, {
    root_relative_to_skill: "runtime",
    context_policy: "execute_without_loading_source",
    external_dependencies: [],
  });
  assert.deepEqual(Object.keys(manifest.modes).sort(), Object.keys(EXPECTED_RUNTIME).sort());
  const maintenance = new Set(manifest.maintenance_only);
  for (const [mode, expected] of Object.entries(EXPECTED_RUNTIME)) {
    const declared = manifest.modes[mode].runtime_files;
    assert.deepEqual(declared, expected, mode);
    assert.equal(new Set(declared).size, declared.length, mode);
    for (const path of declared) {
      assert(!maintenance.has(path), `${mode}: maintenance resource is a runtime dependency`);
      assert(!path.includes("/maintenance/"), `${mode}: maintenance directory is a runtime dependency`);
      assert(!path.endsWith("token-economy.md"), `${mode}: rationale is a runtime dependency`);
      await readFile(join(ROOT, path));
    }
  }
  for (const mode of ["READINESS_LOCAL", "READINESS_GLOBAL", "CLOSE"]) {
    const declared = manifest.modes[mode].runtime_files;
    assert(!declared.includes(SCHEMA), `${mode}: schema should be validator-owned`);
    assert(!declared.includes(IDS), `${mode}: canonical IDs should be validator-owned`);
  }
});

test("recorded baseline matches the pinned public numeric snapshot without Git", () => {
  validateBaseline(manifest, snapshot);
});

test("baseline integrity rejects tampering, omissions, and relaxed limits", () => {
  for (const mutate of [
    value => { value.files[Object.keys(value.files)[0]].words++; },
    value => { value.files[Object.keys(value.files)[0]].bytes++; },
    value => { value.files[Object.keys(value.files)[0]].sha256 = "0".repeat(64); },
    value => { delete value.files[Object.keys(value.files)[0]]; },
    value => { delete value.modes.CLOSE; },
    value => { value.modes.CLOSE.maximum_ceilings.bytes++; },
  ]) {
    const changed = structuredClone(snapshot);
    mutate(changed);
    assert.throws(() => validateBaseline(manifest, changed), /integrity mismatch/);
  }
  for (const mutate of [
    value => { value.baseline_revision = "0".repeat(40); },
    value => { delete value.modes.CLOSE; },
    value => { value.modes.CLOSE.baseline.files.pop(); },
    value => { value.modes.CLOSE.baseline.words++; },
    value => { value.modes.CLOSE.baseline.bytes++; },
    value => { value.modes.CLOSE.ceilings.words++; },
    value => { value.modes.CLOSE.ceilings.bytes++; },
    value => { value.modes.CLOSE.required_reduction_percent--; },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.throws(() => validateBaseline(changed, snapshot));
  }
});

test("runtime overflow and reduction failures remain hard errors", () => {
  for (const [mode, contract] of Object.entries(manifest.modes)) {
    for (const unit of ["words", "bytes"]) {
      assert.throws(() => validateCurrent(mode, contract,
        { words: 0, bytes: 0, [unit]: contract.ceilings[unit] + 1 }), /ceiling exceeded/);
    }
  }
  const contract = { baseline: { words: 100, bytes: 100 }, ceilings: { words: 100, bytes: 100 }, required_reduction_percent: 20 };
  for (const unit of ["words", "bytes"]) {
    assert.throws(() => validateCurrent("fixture", contract, { words: 0, bytes: 0, [unit]: 81 }), /19% < 20%/);
    validateCurrent("fixture", contract, { words: 0, bytes: 0, [unit]: 80 });
  }
});

test("current runtime remains within explicit instruction ceilings", async () => {
  process.stdout.write("\nMODE FILES WORDS BYTES WORD_DELTA BYTE_DELTA\n");
  for (const [mode, contract] of Object.entries(manifest.modes)) {
    const current = await currentMetrics(contract.runtime_files);
    validateCurrent(mode, contract, current);
    assert(current.words <= contract.ceilings.words, `${mode}: word ceiling exceeded`);
    assert(current.bytes <= contract.ceilings.bytes, `${mode}: byte ceiling exceeded`);
    assert(contract.ceilings.words <= contract.baseline.words, `${mode}: raised word ceiling`);
    assert(contract.ceilings.bytes <= contract.baseline.bytes, `${mode}: raised byte ceiling`);
    process.stdout.write(
      `${mode} ${contract.runtime_files.length} ${current.words} ${current.bytes} ` +
        `${current.words - contract.baseline.words} ${current.bytes - contract.baseline.bytes}\n`,
    );
  }
});

test("required instruction reductions hold for words and bytes", async () => {
  for (const [mode, contract] of Object.entries(manifest.modes)) {
    const current = await currentMetrics(contract.runtime_files);
    for (const unit of ["words", "bytes"]) {
      const reduction = (100 * (contract.baseline[unit] - current[unit])) / contract.baseline[unit];
      assert(
        reduction >= contract.required_reduction_percent,
        `${mode} ${unit}: ${reduction}% < ${contract.required_reduction_percent}%`,
      );
    }
  }
});
