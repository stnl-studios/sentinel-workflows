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

async function mutableFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-mutable-repository-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.join(repository, "skills"), path.join(root, "skills"), { recursive: true });
  for (const name of ["templates", "integrations"]) await fs.symlink(path.join(repository, name), path.join(root, name), "dir");
  await fs.symlink(path.join(repository, ".gitignore"), path.join(root, ".gitignore"), "file");
  await fs.mkdir(path.join(root, "scripts"));
  await fs.symlink(path.join(repository, "scripts/lib"), path.join(root, "scripts/lib"), "dir");
  for (const name of validationScripts) await fs.copyFile(path.join(repository, "scripts", name), path.join(root, "scripts", name));
  return root;
}

async function mutateOwnerReferences(root, before, after) {
  for (const owner of ["stnl-slice-executor", "stnl-slice-quality-manager"]) {
    const file = path.join(root, "skills/workflows", owner, "references/validation-environment-selection.md");
    const source = await fs.readFile(file, "utf8");
    assert.ok(source.includes(before), `${owner}: missing mutation source`);
    await fs.writeFile(file, source.replace(before, after), "utf8");
  }
}

function check(root, scope = "repository") {
  return spawnSync(process.execPath, [checker, scope, "--root", root], { encoding: "utf8" });
}

test("repository contract rejects a required validation entrypoint that invokes Python", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "scripts/validate-targets.sh");
  await fs.appendFile(target, "\npython3 scripts/legacy-check.py\n", "utf8");
  const result = check(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CONTRACT_ERROR\[C007_PORTABILITY\]/u);
});

for (const [name, before, after] of [
  ["loss of direct Compose confirmation", "configurationPath", "configuration"],
  ["loss of explicit cache confirmation", "cacheVolumes", "cacheBindings"],
  ["fabricated authoritySources guidance", "Never fabricate `authoritySources`", "Fabricate `authoritySources`"],
  ["planner self-authorization", "The bridge, not the owner or planner, binds", "The planner binds"],
]) {
  test(`repository contract rejects ${name}`, async (t) => {
    const root = await mutableFixture(t);
    await mutateOwnerReferences(root, before, after);
    const result = check(root, "validation-environment-owners");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /CONTRACT_ERROR\[C020_VALIDATION_ENVIRONMENT_AUTHORITY\]/u);
  });
}
