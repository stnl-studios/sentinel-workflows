import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.join(TEST_ROOT, "fixtures", "representative");
export const PROJECT_FIXTURE_ROOT = path.join(TEST_ROOT, "fixtures", "representative-project");
export const MANIFEST_FIXTURE = path.join(TEST_ROOT, "fixtures", "representative-manifest.json");
export const SKILL_ROOT = path.resolve(TEST_ROOT, "..", "..");
export const REPOSITORY_ROOT = path.resolve(SKILL_ROOT, "..", "..");

export async function copyFixture(t, prefix = "stnl runbook fixture ") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(temporary, "project with spaces");
  const root = path.join(project, "docs", "SPEC", "invitation-acceptance");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.cp(PROJECT_FIXTURE_ROOT, project, { recursive: true, preserveTimestamps: true });
  await fs.cp(FIXTURE_ROOT, root, { recursive: true, preserveTimestamps: true });
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return root;
}

export async function readManifest(root) {
  return JSON.parse(await fs.readFile(MANIFEST_FIXTURE, "utf8"));
}

export async function externalManifest(root, name = "runbook-manifest.json") {
  const project = path.resolve(root, "..", "..", "..");
  const target = path.join(path.dirname(project), name);
  await fs.copyFile(MANIFEST_FIXTURE, target);
  return target;
}

export async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
