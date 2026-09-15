import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHECKER = path.join(ROOT, "scripts/check-contracts.mjs");
const SOURCE = path.join(ROOT, "templates/prompts");
const RUNNER_LAUNCHERS = [
  "slice-execute-codex.md", "slice-execute-claude.md",
  "slice-apply-findings-codex.md", "slice-apply-findings-claude.md",
  "slice-validate-codex.md", "slice-validate-claude.md",
];

async function fixture(t) {
  const holder = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-launchers-v11-"));
  t.after(() => fs.rm(holder, { recursive: true, force: true }));
  const root = path.join(holder, "prompts");
  await fs.cp(SOURCE, root, { recursive: true });
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [CHECKER, "launchers", "--root", root], { encoding: "utf8" });
}

async function replace(root, relative, before, after) {
  const file = path.join(root, relative);
  const source = await fs.readFile(file, "utf8");
  assert.ok(source.includes(before), before);
  await fs.writeFile(file, source.replace(before, after), "utf8");
}

test("accepts canonical launchers and keeps runner payloads logical", async (t) => {
  const root = await fixture(t);
  assert.equal(check(root).status, 0, check(root).stderr);
  for (const name of RUNNER_LAUNCHERS) {
    const source = await fs.readFile(path.join(root, name), "utf8");
    const assignments = source.split(/\r?\n/u).filter((line) => /^[A-Z_]+=/u.test(line));
    assert.deepEqual(assignments.map((line) => line.slice(0, line.indexOf("="))), ["OPERATION", "SPEC_PATH", "SLICE"]);
    assert.doesNotMatch(source, /VALIDATION_HARNESS_PATH|<SKILL_ROOT>|resolve-validation-runtime\.mjs|run-validation-session\.mjs/u);
    assert.match(source, /stnl-validation-plan\/v1/u);
    assert.match(source, /loaded (?:skill location|owner package|bridge)|loaded packaged bridge/iu);
  }
});

for (const [name, relative, before, after, category] of [
  ["physical harness input", "slice-execute-codex.md", "SLICE={{SLICE}}", "SLICE={{SLICE}}\nVALIDATION_HARNESS_PATH=/tmp/harness", "L004_INPUTS"],
  ["planner schema", "slice-execute-claude.md", "stnl-validation-plan/v1", "free-form plan", "L012_CHECK_DELEGATION"],
  ["Codex inherited history", "slice-execute-codex.md", 'fork_turns="none"', 'fork_turns="all"', "L016_TRANSPORT"],
  ["Claude agent identity", "slice-execute-claude.md", "@agent-stnl-validation-runner", "@agent-other", "L007_PLATFORM_IDENTITY"],
  ["direct result accepted", "slice-apply-findings-codex.md", "statuses/exits/counts/provenance", "a direct result", "L013_CHECK_AUTHORITY"],
  ["formal assessment removed", "slice-validate-claude.md", "stnl-validation-assessment/v1", "free-form verdict", "L008_VALIDATION_FLOW"],
  ["formal plan publishes", "slice-validate-codex.md", "Exit 0 or accepted plan alone cannot publish", "Accepted plan can publish", "L013_CHECK_AUTHORITY"],
  ["fallback enabled", "slice-validate-codex.md", "Não faça fallback", "Faça fallback", "L008_VALIDATION_FLOW"],
]) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(t);
    await replace(root, relative, before, after);
    const result = check(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`CONTRACT_ERROR\\[${category}\\]`, "u"));
  });
}
