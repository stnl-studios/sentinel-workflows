import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { candidateFile, project, representativeRaw, temporary } from "./helpers.mjs";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXPECTED_CASES = new Set([
  "messy-free-text", "structured-story", "multi-source-sprint", "finding-families", "bounded-evidence",
  "insufficient-evidence", "resolution-accepted", "resolution-rejected", "resolution-inconclusive",
  "explicit-bypass", "finding-reopen", "handoff-blocked", "handoff-direct-spec",
  "handoff-multi-domain-roadmap", "cancellation-race", "inadequate-race-resolution",
  "retry-policy-bypass", "stale-reconcile", "publication-collision", "deterministic-render",
  "canonical-requirement-identity", "false-cross-prevention", "requirement-source-evolution", "reconciliation-attempt-history",
  "follow-up-prompt-context", "candidate-history-integrity",
  "controlled-v1-migration", "conflicting-current-context", "repeated-reopen-history",
  "desktop-mobile-visual", "offline-keyboard-filters", "print-completeness",
]);

test("eval catalog is complete, unique, and marks browser checks as manual", async () => {
  const cases = JSON.parse(await fs.readFile(path.join(SKILL_ROOT, "evals/cases.json"), "utf8"));
  assert.deepEqual(new Set(cases.map((item) => item.id)), EXPECTED_CASES);
  assert.equal(cases.length, EXPECTED_CASES.size);
  assert.equal(cases.every((item) => typeof item.automated === "boolean" && item.expectation.length > 20), true);
  assert.deepEqual(
    new Set(cases.filter((item) => item.automated === false).map((item) => item.id)),
    new Set(["desktop-mobile-visual", "offline-keyboard-filters", "print-completeness"]),
  );
});

test("operational runtime is self-contained ESM with no network, dynamic code, packages, or repository scripts", async () => {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".mjs") && !target.includes(`${path.sep}test${path.sep}`)) files.push(target);
    }
  }
  await visit(path.join(SKILL_ROOT, "runtime"));
  const source = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /(?:^|\W)(?:fetch|XMLHttpRequest|WebSocket|eval|Function)\s*\(/u);
  assert.doesNotMatch(source, /node:child_process|node_modules|npm\s+install|(?:\.\.\/){2,}scripts/u);
  assert.doesNotMatch(source, /https?:\/\//u);
});

test("copied skill executes INIT without imports outside its distribution", async (t) => {
  const copiedRoot = path.join(await temporary(t, "stnl-refinement-copy-"), "stnl-requirements-refiner");
  await fs.cp(SKILL_ROOT, copiedRoot, { recursive: true });
  const root = await project(t);
  const candidate = await candidateFile(t, await representativeRaw());
  const result = spawnSync(process.execPath, [path.join(copiedRoot, "runtime/generate-refinement.mjs"), "INIT", root, candidate], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "INITIALIZED");
  assert.match(await fs.readFile(path.join(root, "docs/refinement/index.html"), "utf8"), /stnl-requirements-refiner:v2 fingerprint/u);
});

test("CLI rejects unsupported operations and ambiguous arity before writes", async (t) => {
  const root = await project(t);
  const inspect = spawnSync(process.execPath, [path.join(SKILL_ROOT, "runtime/inspect-refinement.mjs"), "CLOSE", root], { encoding: "utf8" });
  assert.equal(inspect.status, 1);
  assert.match(inspect.stderr, /^BLOCKED: unsupported refinement operation/u);
  const generate = spawnSync(process.execPath, [path.join(SKILL_ROOT, "runtime/generate-refinement.mjs"), "INIT", root], { encoding: "utf8" });
  assert.equal(generate.status, 2);
  assert.match(generate.stderr, /^usage:/u);
  await assert.rejects(() => fs.stat(path.join(root, "docs/refinement")), { code: "ENOENT" });
});
