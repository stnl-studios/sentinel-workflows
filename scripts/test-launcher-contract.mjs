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

for (const [name, relative, before, after, category, action] of [
  ["physical harness input", "slice-execute-codex.md", "SLICE={{SLICE}}", "SLICE={{SLICE}}\nVALIDATION_HARNESS_PATH=/tmp/harness", "L004_INPUTS"],
  ["planner schema", "slice-execute-claude.md", "stnl-validation-plan/v1", "free-form plan", "L012_CHECK_DELEGATION"],
  ["Codex inherited history", "slice-execute-codex.md", 'fork_turns="none"', 'fork_turns="all"', "L016_TRANSPORT"],
  ["Claude agent identity", "slice-execute-claude.md", "@agent-stnl-validation-runner", "@agent-other", "L007_PLATFORM_IDENTITY"],
  ["direct result accepted", "slice-apply-findings-codex.md", "statuses/exits/counts/provenance", "a direct result", "L013_CHECK_AUTHORITY"],
  ["formal assessment removed", "slice-validate-claude.md", "stnl-validation-assessment/v1", "free-form verdict", "L008_VALIDATION_FLOW"],
  ["formal plan publishes", "slice-validate-codex.md", "Exit 0 or accepted plan alone cannot publish", "Accepted plan can publish", "L013_CHECK_AUTHORITY"],
  ["fallback enabled", "slice-validate-codex.md", "Não faça fallback", "Faça fallback", "L008_VALIDATION_FLOW"],
  ["missing shared launcher", "execution-close.md", "Use `stnl-execution-closer`.", "Use `stnl-execution-closer`.", "L001_REGISTRY", "unlink"],
  ["wrong shared skill", "execution-plan.md", "stnl-execution-planner", "stnl-spec-execution-manager", "L002_SKILL"],
  ["wrong shared operation", "execution-plan.md", "OPERATION=PLAN", "OPERATION=FINALIZE_SLICE", "L003_OPERATION"],
  ["missing slice identity", "slice-execute-codex.md", "SLICE={{SLICE}}\n", "", "L004_INPUTS"],
  ["removed execution token", "execution-plan.md", "Contexto adicional (opcional):", "RUN_TESTS\n\nContexto adicional (opcional):", "L005_REMOVED_CONTRACT"],
  ["shared launcher gains vendor syntax", "execution-close.md", "Contexto adicional (opcional):", "Codex stnl_validation_runner\n\nContexto adicional (opcional):", "L006_SHARED_ISOLATION"],
  ["shared CLOSE invokes tests", "execution-close.md", "Contexto adicional (opcional):", "Execute testes e faça retry.\n\nContexto adicional (opcional):", "L006_SHARED_ISOLATION"],
  ["malformed context trailer", "execution-tasks-review.md", "Contexto adicional (opcional):", "Contexto adicional (opcional):\nextra", "L009_CONTEXT_FORMAT"],
  ["recovery target loses preflight authority", "slice-execute-codex.md", "concrete recovery operation and slice returned by deterministic preflight", "operation and slice requested by the user", "L019_RECOVERY_TARGET"],
  ["auxiliary cycle permits a fourth call", "slice-apply-findings-codex.md", "never a fourth call", "make a fourth call", "L014_AUTOMATIC_RECHECK"],
  ["auxiliary check claims formal attempt", "slice-execute-claude.md", "Contexto adicional (opcional):", "Crie Validation Attempt.\n\nContexto adicional (opcional):", "L013_CHECK_AUTHORITY"],
  ["transport consumes auxiliary round", "slice-execute-codex.md", "não consomem rodada `N/3`", "consomem rodada `N/3`", "L016_TRANSPORT"],
  ["transport creates findings check", "slice-apply-findings-codex.md", "does not create `findings-check-NN`", "creates `findings-check-NN`", "L016_TRANSPORT"],
  ["formal transport allocates attempt", "slice-validate-codex.md", "do not create/consume `attempt-NN`", "create/consume `attempt-NN`", "L016_TRANSPORT"],
  ["formal validation repeats tests", "slice-validate-claude.md", "não repete testes", "repete testes", "L013_CHECK_AUTHORITY"],
  ["non-applicability is promoted to PASS", "slice-validate-codex.md", "Não promova não aplicabilidade a `PASS`", "Promova não aplicabilidade a `PASS`", "L013_CHECK_AUTHORITY"],
  ["APPLY_FINDINGS non-applicability resolves findings", "slice-apply-findings-claude.md", "não resolve findings por si só", "resolve findings por si só", "L013_CHECK_AUTHORITY"],
  ["platform recovery-history semantics diverge", "slice-execute-claude.md", "Preserve one historical Delegation Blocker", "Discard the historical Delegation Blocker", "L018_PLATFORM_EQUIVALENCE"],
  ["READINESS accepts lowercase alias", "spec-readiness.md", "Contexto adicional (opcional):", "Use `local`.\n\nContexto adicional (opcional):", "L015_READINESS_SCOPE"],
  ["runbook locale default changes", "spec-test-runbook.md", "`locale=\"en-US\"`", "`locale=\"pt-BR\"`", "L020_RUNBOOK_OPTIONS"],
  ["roadmap authority changes", "spec-roadmap-reconcile.md", "roadmap.json", "other.json", "L021_ROADMAP_BOUNDARY"],
  ["refinement loses manual handoff", "requirements-refinement-init.md", "handoff manual", "handoff automático", "L022_REFINEMENT_BOUNDARY"],
]) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(t);
    if (action === "unlink") await fs.unlink(path.join(root, relative));
    else await replace(root, relative, before, after);
    const result = check(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`CONTRACT_ERROR\\[${category}\\]`, "u"));
  });
}
