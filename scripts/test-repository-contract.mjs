import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(repository, "scripts/check-contracts.mjs");
const validationScripts = ["validate.sh", "smoke-structure.sh", "test-launcher-contract.sh", "test-validation-runner-contract.sh"];

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-repository-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ["skills", "templates"]) await fs.symlink(path.join(repository, name), path.join(root, name), "dir");
  await fs.symlink(path.join(repository, "integrations"), path.join(root, "integrations"), "dir");
  await fs.symlink(path.join(repository, ".gitignore"), path.join(root, ".gitignore"), "file");
  await fs.mkdir(path.join(root, "scripts"));
  for (const name of validationScripts) await fs.copyFile(path.join(repository, "scripts", name), path.join(root, "scripts", name));
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [checker, "repository", "--root", root], { encoding: "utf8" });
}

test("repository contract rejects a required validation entrypoint that invokes Python", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "scripts/validate.sh");
  await fs.appendFile(target, "\npython3 scripts/legacy-check.py\n", "utf8");
  const result = check(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CONTRACT_ERROR\[C007_PORTABILITY\]/u);
});

test("repository contract rejects recreation of targets", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "targets"));
  const result = check(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CONTRACT_ERROR\[C019_REMOVED_ROOTS\].*targets/u);
});

test("repository contract rejects recreation of agents/base", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "agents/base"), { recursive: true });
  const result = check(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CONTRACT_ERROR\[C019_REMOVED_ROOTS\].*agents\/base/u);
});

// Documentary preparation is a review-only routing exception, not a bypass
// of current byte review or the ordinary editable-draft approval boundary.
test("documentary review routing precedes draft admission and returns to its controller", async () => {
  const reviewer = await fs.readFile(path.join(repository, "skills/workflows/stnl-plan-reviewer/SKILL.md"), "utf8");
  const start = reviewer.indexOf("## Select the review route before candidate admission");
  const end = reviewer.indexOf("## Editable draft and explicit approval");
  assert(start >= 0 && start < end, "documentary routing must precede mandatory draft admission");
  const route = reviewer.slice(start, end);
  for (const token of ["AWAITING_CURRENT_REVIEW", "stnl-documentary-preparation-handle-v1",
    "awaiting-review", "owner.artifactHashes", "owner.source", "owner.decisionBasis",
    "captureExecutionTree", "projectInitialPreparation", "computeRequirementsAuthority",
    "globalReview", "deliveries", "empty evidenceDecisions", "historical approval/proof are unverified",
    "install-documentary-resumption --handle HANDLE --review-file REVIEW", "recover-documentary-resumption"])
    assert(route.includes(token), `missing documentary review boundary: ${token}`);
  assert.match(route, /Do not run prepare-task-candidate, preparation-draft, serialize-plan-paths or publish-task-candidate/u);
  assert.match(route, /all semantic review criteria still apply/u);
  assert.match(route, /Do not edit the candidate\/source/u);
  assert.match(reviewer, /For ordinary PLAN\/REPLAN only, before content reads/u);
  assert.match(reviewer, /For documentary preparation, return the current review decision\/file/u);
  assert.match(reviewer, /Only after the user explicitly approves that digest run/u);
  const guides = await Promise.all(["stnl-slice-executor", "stnl-slice-quality-manager"].map(skill =>
    fs.readFile(path.join(repository, "skills/workflows", skill, "references/documentary-resumption.md"), "utf8")));
  assert.equal(guides[0].replace(/^owner: .+$/mu, "owner: caller"), guides[1].replace(/^owner: .+$/mu, "owner: caller"), "both callers must route the same documentary review");
  assert.match(guides[0], /independent stnl-plan-reviewer using its Documentary preparation handoff route/u);
  assert.match(guides[0], /complete prepare result \(saved handle, candidateExecutionRoot, authority and resumption\)/u);
  assert.match(guides[0], /reviewer returns the actual decision\/file to this invoking controller/u);
});
