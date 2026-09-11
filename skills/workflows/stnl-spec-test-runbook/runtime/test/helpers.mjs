import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.join(TEST_ROOT, "fixtures", "representative");
export const MULTI_SLICE_FIXTURE_ROOT = path.join(TEST_ROOT, "fixtures", "multi-slice");
export const PROJECT_FIXTURE_ROOT = path.join(TEST_ROOT, "fixtures", "representative-project");
export const MANIFEST_FIXTURE = path.join(TEST_ROOT, "fixtures", "representative-manifest.json");
export const MULTI_SLICE_MANIFEST_FIXTURE = path.join(TEST_ROOT, "fixtures", "multi-slice-manifest.json");
export const SKILL_ROOT = path.resolve(TEST_ROOT, "..", "..");
export const REPOSITORY_ROOT = path.resolve(SKILL_ROOT, "..", "..", "..");

function fixturePaths(fixtureName) {
  if (fixtureName === "multi-slice") {
    return { root: MULTI_SLICE_FIXTURE_ROOT, manifest: MULTI_SLICE_MANIFEST_FIXTURE };
  }
  return { root: FIXTURE_ROOT, manifest: MANIFEST_FIXTURE };
}

export async function copyFixture(t, prefix = "stnl runbook fixture ", fixtureName = "representative") {
  const { root: fixtureRoot } = fixturePaths(fixtureName);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(temporary, "project with spaces");
  const root = path.join(project, "docs", "SPEC", "invitation-acceptance");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.cp(PROJECT_FIXTURE_ROOT, project, { recursive: true, preserveTimestamps: true });
  await fs.cp(fixtureRoot, root, { recursive: true, preserveTimestamps: true });
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return root;
}

export async function readManifest(root, fixtureName = "representative") {
  const { manifest } = fixturePaths(fixtureName);
  return JSON.parse(await fs.readFile(manifest, "utf8"));
}

export async function externalManifest(root, name = "runbook-manifest.json", fixtureName = "representative") {
  const { manifest } = fixturePaths(fixtureName);
  const project = path.resolve(root, "..", "..", "..");
  const target = path.join(path.dirname(project), name);
  await fs.copyFile(manifest, target);
  return target;
}

export async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
