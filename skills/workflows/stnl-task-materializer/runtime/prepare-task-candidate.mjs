#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveExecutionWorkspace } from "./execution-state.mjs";

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function blocked(message) {
  throw new Error(`task candidate preparation blocked: ${message}`);
}

async function requireRealDirectory(directory, label) {
  const metadata = await fs.lstat(directory).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    blocked(`${label} must be a real directory: ${directory}`);
  }
  return fs.realpath(directory);
}

async function copyCompleteDirectory(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    await fs.cp(sourcePath, destinationPath, {
      recursive: entry.isDirectory(),
      dereference: false,
      errorOnExist: true,
      force: false,
    });
  }
  return entries.length;
}

export async function prepareTaskMaterializationCandidate({ specPath }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const liveExecutionRoot = await requireRealDirectory(workspace.executionRoot, "live execution root");
  const candidateExecutionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-materialize-candidate-"));
  const canonicalCandidate = await fs.realpath(candidateExecutionRoot);
  if (pathIsWithin(canonicalCandidate, liveExecutionRoot) || pathIsWithin(liveExecutionRoot, canonicalCandidate)) {
    await fs.rm(canonicalCandidate, { recursive: true, force: true });
    blocked("candidate execution root is not isolated from live execution artifacts");
  }
  const copiedEntries = await copyCompleteDirectory(liveExecutionRoot, canonicalCandidate);
  return Object.freeze({
    status: "PASS",
    sourceExecutionRoot: liveExecutionRoot,
    candidateExecutionRoot: canonicalCandidate,
    copiedEntries,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 3 || arguments_[0] !== "--prepare" || arguments_[1] !== "--spec-path") {
    throw new Error("usage: prepare-task-candidate.mjs --prepare --spec-path SPEC_PATH");
  }
  const result = await prepareTaskMaterializationCandidate({ specPath: arguments_[2] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
