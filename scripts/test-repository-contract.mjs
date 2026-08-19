import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checker = path.join(repository, "scripts/check-contracts.mjs");
const validationScripts = ["validate-targets.sh", "smoke-structure.sh", "test-launcher-contract.sh", "test-validation-runner-contract.sh"];

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
  const target = path.join(root, "scripts/validate-targets.sh");
  await fs.appendFile(target, "\npython3 scripts/legacy-check.py\n", "utf8");
  const result = check(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CONTRACT_ERROR\[C007_PORTABILITY\]/u);
});
