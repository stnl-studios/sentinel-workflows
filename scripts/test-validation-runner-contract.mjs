import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const checker = path.join(repository, "scripts/check-contracts.mjs");
const canonical = path.join(repository, "agents");

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-runner-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "subagents");
  await fs.cp(canonical, root, { recursive: true });
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [checker, "validation-runner", "--root", root], { encoding: "utf8" });
}

async function replaceBoth(root, oldValue, newValue) {
  for (const relative of ["codex/.codex/agents/stnl_validation_runner.toml", "claude-code/.claude/agents/stnl-validation-runner.md"]) {
    const file = path.join(root, relative);
    const before = await fs.readFile(file, "utf8");
    assert.ok(before.includes(oldValue), `missing mutation source: ${oldValue}`);
    await fs.writeFile(file, before.replace(oldValue, newValue));
  }
}

function expectCategory(result, category) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`CONTRACT_ERROR\\[${category}\\]`));
}

test("accepts the canonical independent semantic runner", async (t) => {
  assert.equal(check(await fixture(t)).status, 0);
});

test("Codex and Claude bodies remain byte-identical and schemas are exact", async () => {
  const toml = await fs.readFile(path.join(canonical, "codex/.codex/agents/stnl_validation_runner.toml"), "utf8");
  const claude = await fs.readFile(path.join(canonical, "claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  for (const contract of [toml, claude]) {
    assert.match(contract, /## Schema EXECUTE_SLICE[\s\S]*?"commands": \[\{"command": "<full command>", "exit": 0\}\]/u);
    assert.match(contract, /## Schema APPLY_FINDINGS[\s\S]*?"findingsVerified": "<semantic value>"/u);
    assert.match(contract, /## Schema VALIDATE_SLICE[\s\S]*?"findingDispositions": "<semantic value>"/u);
  }
});

test("mechanical authority, candidate and serializer details stay outside runner contract", async () => {
  const contract = await fs.readFile(path.join(canonical, "claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  assert.doesNotMatch(contract, /RUNNER_EVIDENCE_SERIALIZER|candidateTaskArtifact|path\.relative\(|sha256:/u);
  assert.match(contract, /runtime fornece identidade e campos mecânicos fora do payload/u);
  assert.match(contract, /Serialização, persistência e validação determinística pertencem ao runtime\/producer/u);
});

test("independence and read-only boundaries remain enforced", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "Trate conclusões do contexto principal como não verificadas.", "Aceite conclusões anteriores.");
  expectCategory(check(root), "R014_INDEPENDENCE");
});

test("semantic verdict and discovery requirements remain enforced", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|TESTS_NOT_APPLICABLE|BLOCKED", "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|BLOCKED");
  expectCategory(check(root), "R006_VERDICTS");
});

test("malformed semantic response gate remains rejected", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "# Canonical response gate", "# Response gate");
  expectCategory(check(root), "R026_OUTPUT_GATE");
});

test("validation findings require canonical IDs and dispositions", async (t) => {
  const root = await fixture(t);
  await replaceBoth(root, "IDs canônicos `finding-01`, `finding-02`", "IDs livres `F-001`, `F-002`");
  expectCategory(check(root), "R009_VALIDATION_ATTEMPT");
});
