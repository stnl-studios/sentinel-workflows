#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSymlinkComponents, inspectWorkspace, lstatOrNull, parseStrictJson } from "./lib/core.mjs";
import { validateManifest, validateManifestEvidence } from "./lib/manifest.mjs";
import { publishRunbook } from "./lib/publish.mjs";
import { renderRunbook } from "./lib/render.mjs";

async function readManifest(manifestPath) {
  const requested = path.resolve(String(manifestPath));
  await assertNoSymlinkComponents(requested, "manifest");
  const metadata = await lstatOrNull(requested);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`manifest must be a real file: ${requested}`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`manifest must be a single-link real file: ${requested}`);
  }
  if (metadata.size > 2_000_000) throw new Error("manifest exceeds the 2 MB safety limit");
  return parseStrictJson(await fs.readFile(requested, "utf8"), "manifest");
}

export async function generateRunbook(specPath, manifestPath, optionsValue = {}) {
  const requestedManifest = path.resolve(String(manifestPath));
  const raw = await readManifest(manifestPath);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || raw.scope === null || typeof raw.scope !== "object") {
    throw new Error("manifest.scope is required");
  }
  const inspection = await inspectWorkspace(specPath, raw.scope.kind, raw.scope.selection, optionsValue);
  const physicalManifest = await fs.realpath(requestedManifest);
  for (const [label, root] of [["SPEC", inspection.spec_root], ["execution", inspection.execution_root], ["output", inspection.output_root]]) {
    if (root === null) continue;
    const boundary = path.relative(root, physicalManifest);
    if (boundary === "" || (!boundary.startsWith(`..${path.sep}`) && boundary !== ".." && !path.isAbsolute(boundary))) {
      throw new Error(`manifest must be ephemeral outside the ${label} root: ${requestedManifest}`);
    }
  }
  const manifest = validateManifest(raw, inspection);
  await validateManifestEvidence(manifest, inspection);
  const rendered = renderRunbook(manifest);
  const output = await publishRunbook(inspection.output_root, rendered.html);
  return {
    status: "GENERATED",
    output,
    fingerprint: rendered.fingerprint,
    scope: inspection.scope,
    configuration: inspection.configuration,
    scenarios: manifest.scenarios.length,
    coverage_records: manifest.coverage.length,
    helpers: manifest.helper_artifacts.map((item) => path.join(inspection.output_root, ...item.path.split("/"))),
  };
}

export async function main(arguments_) {
  if (arguments_.length < 2 || arguments_.length > 3) {
    process.stderr.write("usage: generate-runbook.mjs SPEC_PATH MANIFEST_PATH [RUNBOOK_OPTIONS_JSON]\n");
    return 2;
  }
  try {
    const result = await generateRunbook(
      arguments_[0],
      arguments_[1],
      arguments_[2] === undefined ? {} : parseStrictJson(arguments_[2], "RUNBOOK_OPTIONS"),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    return 1;
  }
}

const executed = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
