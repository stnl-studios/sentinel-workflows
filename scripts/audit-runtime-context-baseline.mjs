#!/usr/bin/env node
// Optional archaeology only. Normal tests never invoke Git or this script.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fileMetadata, validateBaseline } from "./lib/runtime-context-budget.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maintenance = join(root, "skills/workflows/stnl-spec-lifecycle-manager/maintenance");
const manifest = JSON.parse(await readFile(join(maintenance, "runtime-context-budget.json"), "utf8"));
const snapshot = JSON.parse(await readFile(join(maintenance, "runtime-context-baseline.snapshot.json"), "utf8"));
validateBaseline(manifest, snapshot);
for (const [path, expected] of Object.entries(snapshot.files)) {
  const result = spawnSync("git", ["show", `${snapshot.origin.revision}:${path}`], { cwd: root, encoding: null });
  assert.equal(result.status, 0,
    `Optional archaeology requires the original revision locally; missing ${path}. No fallback or fetch is performed.`);
  assert.deepEqual(fileMetadata(result.stdout), expected, `${path}: original bytes differ from snapshot metadata`);
}
console.log(`Baseline archaeology verified: ${Object.keys(snapshot.files).length} framework files; all metrics, SHA-256 and Git blob hashes match.`);
