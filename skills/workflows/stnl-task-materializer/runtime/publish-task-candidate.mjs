#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectExecutionState,
  resolveExecutionWorkspace,
  validateExecutionCandidate,
} from "./execution-state.mjs";
import { serializeTaskPathClaims } from "./serialize-task-paths.mjs";

const PUBLISHED_TOP_LEVEL = new Set(["plan.md", "plans", "tasks.md", "tasks"]);

function fail(message) {
  throw new Error(message);
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  const metadata = await fs.lstat(value).catch((error) => fail(`${label} is not available: ${error.message}`));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label} must be a regular non-symlink directory`);
  return fs.realpath(value);
}

async function treeSnapshot(root, relative = "", output = new Map()) {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    if (entry.isSymbolicLink()) fail(`publication tree contains a symbolic link: ${child}`);
    if (entry.isDirectory()) {
      output.set(childRelative, { kind: "directory" });
      await treeSnapshot(root, childRelative, output);
      continue;
    }
    if (!entry.isFile()) fail(`publication tree contains an unsupported entry: ${child}`);
    const metadata = await fs.lstat(child);
    if (metadata.nlink !== 1) fail(`publication tree contains a multiply-linked file: ${child}`);
    output.set(childRelative, { kind: "file", bytes: await fs.readFile(child) });
  }
  return output;
}

function topLevel(relative) {
  return relative.split(path.sep, 1)[0];
}

function sameEntry(left, right) {
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  if (left.kind === "directory") return true;
  return left.bytes.equals(right.bytes);
}

async function copyRegularTree(source, destination, relative = "") {
  const sourceDirectory = path.join(source, relative);
  const destinationDirectory = path.join(destination, relative);
  if (relative !== "") await fs.mkdir(destinationDirectory, { recursive: true });
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const sourcePath = path.join(source, childRelative);
    const destinationPath = path.join(destination, childRelative);
    if (entry.isSymbolicLink()) fail(`candidate contains a symbolic link: ${sourcePath}`);
    if (entry.isDirectory()) {
      await fs.mkdir(destinationPath, { recursive: false });
      await copyRegularTree(source, destination, childRelative);
      continue;
    }
    if (!entry.isFile()) fail(`candidate contains an unsupported entry: ${sourcePath}`);
    const metadata = await fs.lstat(sourcePath);
    if (metadata.nlink !== 1) fail(`candidate contains a multiply-linked file: ${sourcePath}`);
    const bytes = await fs.readFile(sourcePath);
    await fs.writeFile(destinationPath, bytes, { flag: "wx", mode: metadata.mode & 0o777 });
  }
}

async function temporarySibling(parent, prefix) {
  const created = await fs.mkdtemp(path.join(parent, prefix));
  await fs.rm(created, { recursive: true, force: true });
  return created;
}

export async function publishTaskMaterializationCandidate({ specPath, candidateExecutionRoot }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const liveExecutionRoot = await canonicalDirectory(workspace.executionRoot, "live execution root");
  const candidateRoot = await canonicalDirectory(candidateExecutionRoot, "candidate execution root");
  if (inside(candidateRoot, liveExecutionRoot) || inside(liveExecutionRoot, candidateRoot)) {
    fail("candidate execution root must be isolated from live execution root");
  }

  // The approved detailed plans are the semantic target authority.  Make the
  // final task-relative claims from those physical targets before strict
  // candidate validation; publication must not depend on the model invoking
  // the mechanical serializer itself.
  const serializedPaths = await serializeTaskPathClaims({
    specPath,
    candidateExecutionRoot: candidateRoot,
  });
  const candidateState = await validateExecutionCandidate(specPath, candidateRoot);
  const liveSnapshot = await treeSnapshot(liveExecutionRoot);
  const candidateSnapshot = await treeSnapshot(candidateRoot);
  const allRelative = new Set([...liveSnapshot.keys(), ...candidateSnapshot.keys()]);
  for (const relative of allRelative) {
    if (PUBLISHED_TOP_LEVEL.has(topLevel(relative))) continue;
    if (!sameEntry(liveSnapshot.get(relative), candidateSnapshot.get(relative))) {
      fail(`candidate changed a non-materialization path: ${relative}`);
    }
  }

  const parent = path.dirname(liveExecutionRoot);
  const stagedRoot = await fs.mkdtemp(path.join(parent, ".stnl-materialize-publication-"));
  let backupRoot = await temporarySibling(parent, ".stnl-materialize-backup-");
  let liveMoved = false;
  try {
    await copyRegularTree(candidateRoot, stagedRoot);
    await fs.rename(liveExecutionRoot, backupRoot);
    liveMoved = true;
    await fs.rename(stagedRoot, liveExecutionRoot);

    const readback = await inspectExecutionState(specPath);
    if (readback.state !== candidateState.state || readback.currentFingerprint !== candidateState.currentFingerprint) {
      fail(`published execution state differs from validated candidate: ${readback.state}`);
    }
    await fs.rm(backupRoot, { recursive: true, force: true });
    backupRoot = null;
    return Object.freeze({
      status: "PASS",
      state: readback.state,
      currentFingerprint: readback.currentFingerprint,
      publishedExecutionRoot: liveExecutionRoot,
      serializedTaskPaths: serializedPaths.serializedClaims,
    });
  } catch (error) {
    if (liveMoved) {
      await fs.rm(liveExecutionRoot, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backupRoot, liveExecutionRoot).catch((restoreError) => {
        error.message = `${error.message}; publication rollback failed: ${restoreError.message}`;
      });
    }
    throw error;
  } finally {
    if (stagedRoot !== null) await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
    if (backupRoot !== null) await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function main(arguments_) {
  if (arguments_.length !== 5
    || arguments_[0] !== "--publish"
    || arguments_[1] !== "--spec-path"
    || arguments_[3] !== "--candidate-execution-root") {
    process.stderr.write("usage: publish-task-candidate.mjs --publish --spec-path SPEC_PATH --candidate-execution-root CANDIDATE_EXECUTION_ROOT\n");
    return 2;
  }
  try {
    const result = await publishTaskMaterializationCandidate({
      specPath: arguments_[2],
      candidateExecutionRoot: arguments_[4],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = await main(process.argv.slice(2));
}
