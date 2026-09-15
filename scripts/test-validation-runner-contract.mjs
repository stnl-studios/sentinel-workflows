import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHECKER = path.join(ROOT, "scripts/check-contracts.mjs");
const SOURCE = path.join(ROOT, "integrations");

async function fixture(t) {
  const holder = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-runner-v11-"));
  t.after(() => fs.rm(holder, { recursive: true, force: true }));
  const root = path.join(holder, "integrations");
  await fs.cp(SOURCE, root, { recursive: true });
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [CHECKER, "subagents", "--root", root], { encoding: "utf8" });
}

async function replace(root, relative, before, after) {
  const file = path.join(root, relative);
  const source = await fs.readFile(file, "utf8");
  assert.ok(source.includes(before), before);
  await fs.writeFile(file, source.replace(before, after), "utf8");
}

async function replaceBoth(root, before, after) {
  await replace(root, "codex/agents/stnl_validation_runner.toml", before, after);
  await replace(root, "claude-code/agents/stnl-validation-runner.md", before, after);
}

test("accepts the canonical planner-only runner contract", async (t) => {
  const root = await fixture(t);
  assert.equal(check(root).status, 0, check(root).stderr);
});

for (const [name, category, mutation] of [
  ["runner protocol downgrade", "R013_SYNTAX", (root) => replaceBoth(root, "CONTRATO_CANONICO=stnl-validation-runner/v11", "CONTRATO_CANONICO=stnl-validation-runner/v10")],
  ["plan schema removal", "R007_OUTPUT_SCHEMA", (root) => replaceBoth(root, "PLAN_SCHEMA=stnl-validation-plan/v1", "PLAN_SCHEMA=missing")],
  ["harness discovery permission", "R017_ISOLATION", (root) => replaceBoth(root, "Não tente descobrir, ler, importar ou invocar o harness", "Tente descobrir e invocar o harness")],
  ["direct verification permission", "R017_ISOLATION", (root) => replaceBoth(root, "Não execute build, teste, lint, typecheck", "Execute build, teste, lint, typecheck")],
  ["plan/result distinction removal", "R006_VERDICTS", (root) => replaceBoth(root, "Um plano pronto não significa `TESTS_PASS`", "Um plano pronto significa resultado")],
  ["loaded identity substitution", "R018_PROVENANCE", (root) => replaceBoth(root, "nunca a substitua pela atual do owner", "substitua pela atual do owner")],
  ["Claude regains Bash", "R001_ADAPTER_METADATA", (root) => replace(root, "claude-code/agents/stnl-validation-runner.md", "tools: Read, Glob, Grep", "tools: Read, Glob, Grep, Bash")],
  ["Codex regains workspace write", "R001_ADAPTER_METADATA", (root) => replace(root, "codex/agents/stnl_validation_runner.toml", 'sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"')],
  ["platform contracts diverge", "R003_EQUIVALENCE", (root) => replace(root, "claude-code/agents/stnl-validation-runner.md", "Plano sem commands requer", "Plano vazio requer")],
]) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(t);
    await mutation(root);
    const result = check(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`CONTRACT_ERROR\\[${category}\\]`, "u"));
  });
}
