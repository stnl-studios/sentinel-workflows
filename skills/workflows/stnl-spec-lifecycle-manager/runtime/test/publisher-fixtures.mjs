import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resumeWorkspaceIdentity,
  validateWorkspace,
  workspaceSnapshot,
} from "../lib/lifecycle.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_ROOT = path.dirname(TEST_DIRECTORY);
export const SKILL_ROOT = path.dirname(RUNTIME_ROOT);
export const READY_FIXTURE = path.join(
  SKILL_ROOT,
  "examples",
  "validator-fixtures",
  "ready",
);
export const PUBLISHER_CLI = path.join(RUNTIME_ROOT, "publish-spec-lifecycle.mjs");

export async function temporaryDirectory(prefix = "stnl-node-publisher-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTemporaryDirectory(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}

export async function copyTree(source, destination) {
  await fs.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

export async function writeResumeManifest(filePath, source, { featureSections = [] } = {}) {
  const workspace = validateWorkspace(source);
  const payload = {
    schema_version: 1,
    mode: "RESUME",
    workspace_identity: {
      h1: workspace.h1,
      pre_state_sha256: resumeWorkspaceIdentity(source),
    },
    allowed_feature_sections: featureSections,
    allowed_existing_ids: [],
    allowed_new_ids: [],
    allowed_status_transitions: [],
    allowed_record_status_transitions: [],
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

export async function buildResumeFixture(
  base,
  { withRaceFiles = false, candidateWhitespaceChange = false } = {},
) {
  const target = path.join(base, "workspace with spaces");
  const candidate = path.join(base, "candidate with spaces");
  const manifest = path.join(base, "resume manifest.json");
  await copyTree(READY_FIXTURE, target);
  if (withRaceFiles) {
    const race = path.join(target, "execution", "publisher-race");
    await fs.mkdir(race, { recursive: true });
    await fs.writeFile(path.join(race, "modified.txt"), "original modification slot\n", "utf8");
    await fs.writeFile(path.join(race, "removed.txt"), "original removal slot\n", "utf8");
    await fs.writeFile(path.join(race, "link-slot.txt"), "original symlink slot\n", "utf8");
  }
  await copyTree(target, candidate);
  let featureSections = [];
  if (candidateWhitespaceChange) {
    const feature = path.join(candidate, "feature_spec.md");
    const original = "Provide deterministic invitation expiration behavior.\n";
    const text = await fs.readFile(feature, "utf8");
    if (text.split(original).length !== 2) {
      throw new Error("publisher fixture Objective line is absent or ambiguous");
    }
    await fs.writeFile(feature, text.replace(original, `${original.slice(0, -1)} \n`), "utf8");
    featureSections = ["Objective"];
  }
  await writeResumeManifest(manifest, target, { featureSections });
  validateWorkspace(target);
  validateWorkspace(candidate);
  return { target, candidate, manifest };
}

export function snapshot(root) {
  return JSON.stringify(workspaceSnapshot(root));
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function transactionResidues(target) {
  const targetName = path.basename(target);
  const prefixes = [
    `.${targetName}.lifecycle-stage-`,
    `.${targetName}.lifecycle-backup-`,
    `.${targetName}.lifecycle-journal-tmp-`,
    `.${targetName}.lifecycle-ownership-`,
    `.${targetName}.lifecycle-retired-tree-`,
  ];
  const journal = `.${targetName}.lifecycle-transaction.json`;
  return (await fs.readdir(path.dirname(target)))
    .filter((name) => name === journal || prefixes.some((prefix) => name.startsWith(prefix)))
    .sort();
}
