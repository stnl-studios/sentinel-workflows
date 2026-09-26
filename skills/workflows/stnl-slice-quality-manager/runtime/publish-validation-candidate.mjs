#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectExecutionState,
  preflightExecutionOperation,
  resolveExecutionWorkspace,
  validateExecutionCandidate,
} from "./execution-state.mjs";
import { assertManagedAgreement } from "./managed-slice-context.mjs";

const VALIDATION_OWNED_SECTIONS = new Set([
  "Validation Attempts",
  "Validation Findings",
  "Effective Validation Base",
  "Diff Summary",
  "Final Result",
]);
const METADATA_NAMES = new Set(["__MACOSX", ".DS_Store"]);

function fail(message) {
  throw new Error("validation candidate publication blocked: " + message);
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function ignoredMetadata(name) {
  return METADATA_NAMES.has(name) || name.startsWith("._");
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(label + " must be absolute and canonical");
  }
  const metadata = await fs.lstat(value).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(label + " must be a real directory");
  }
  const canonical = await fs.realpath(value);
  if (canonical !== value) fail(label + " must not traverse a symlink");
  return canonical;
}

async function treeSnapshot(root, relative = "", output = new Map()) {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (ignoredMetadata(entry.name)) continue;
    const childRelative = relative === "" ? entry.name : path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    const metadata = await fs.lstat(child);
    if (metadata.isSymbolicLink()) fail("execution tree contains a symbolic link: " + childRelative);
    if (metadata.isDirectory()) {
      output.set(childRelative, { kind: "directory" });
      await treeSnapshot(root, childRelative, output);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      output.set(childRelative, { kind: "file", bytes: await fs.readFile(child) });
    } else {
      fail("execution tree contains a non-regular or multiply-linked file: " + childRelative);
    }
  }
  return output;
}

function sameEntry(left, right) {
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  return left.kind === "directory" || left.bytes.equals(right.bytes);
}

function snapshotsMatch(left, right) {
  if (left.size !== right.size) return false;
  for (const [relative, entry] of left) {
    if (!sameEntry(entry, right.get(relative))) return false;
  }
  return true;
}

async function copyRegularTree(source, destination, relative = "") {
  const sourceDirectory = path.join(source, relative);
  const destinationDirectory = path.join(destination, relative);
  if (relative !== "") await fs.mkdir(destinationDirectory, { recursive: true });
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (ignoredMetadata(entry.name)) continue;
    const childRelative = relative === "" ? entry.name : path.join(relative, entry.name);
    const sourcePath = path.join(source, childRelative);
    const destinationPath = path.join(destination, childRelative);
    const metadata = await fs.lstat(sourcePath);
    if (metadata.isSymbolicLink()) fail("candidate changed to contain a symbolic link: " + childRelative);
    if (metadata.isDirectory()) {
      await fs.mkdir(destinationPath, { recursive: false });
      await copyRegularTree(source, destination, childRelative);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      await fs.writeFile(destinationPath, await fs.readFile(sourcePath), {
        flag: "wx",
        mode: metadata.mode & 0o777,
      });
    } else {
      fail("candidate contains a non-regular or multiply-linked file: " + childRelative);
    }
  }
}

async function unusedSibling(parent, prefix) {
  const created = await fs.mkdtemp(path.join(parent, prefix));
  await fs.rm(created, { recursive: true, force: false });
  return created;
}

function taskSections(text, label) {
  const headings = [...text.matchAll(/^## ([^\n]+)\n\n/gmu)];
  if (headings.length === 0) fail(label + " has no task sections");
  const sections = new Map();
  const firstStart = headings[0].index;
  const prefix = text.slice(0, firstStart);
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const bodyStart = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const name = heading[1];
    if (sections.has(name)) fail(label + " has duplicate section " + name);
    sections.set(name, text.slice(bodyStart, end));
  }
  return { prefix, names: [...sections.keys()], sections };
}

function assertValidationTaskScope(liveText, candidateText, slice, candidateState) {
  const live = taskSections(liveText, "live task");
  const candidate = taskSections(candidateText, "candidate task");
  if (live.prefix !== candidate.prefix || live.names.join("\n") !== candidate.names.join("\n")) {
    fail("candidate task changed its header or section structure");
  }
  for (const name of live.names) {
    if (VALIDATION_OWNED_SECTIONS.has(name)) continue;
    if (name === "Delegation Blocker"
      && (candidateState === "RUNNER_RESULT_BLOCKED" || candidateState === "RUNNER_INITIALIZATION_BLOCKED"
        || live.sections.get(name).trim() !== "- none")) continue;
    if (live.sections.get(name) !== candidate.sections.get(name)) {
      fail("candidate changed non-validation task section " + name + " for " + slice);
    }
  }
}

function rowColumns(line, slice, label) {
  const columns = line.split("|").slice(1, -1).map((column) => column.trim());
  if (columns.length !== 7 || columns[4] !== "tasks/" + slice + ".md") {
    fail(label + " has a malformed selected tasks.md row");
  }
  return columns;
}

function assertTasksIndexScope(liveText, candidateText, slice) {
  const liveLines = liveText.split("\n");
  const candidateLines = candidateText.split("\n");
  if (liveLines.length !== candidateLines.length) fail("candidate tasks.md changed its line structure");
  const selected = [];
  for (const [index, line] of liveLines.entries()) {
    if (!line.startsWith("|")) continue;
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    if (columns.length === 7 && columns[4] === "tasks/" + slice + ".md") selected.push(index);
  }
  if (selected.length !== 1) fail("live tasks.md must contain exactly one selected row for " + slice);
  const selectedIndex = selected[0];
  for (const [index, line] of liveLines.entries()) {
    if (index !== selectedIndex && line !== candidateLines[index]) {
      fail("candidate tasks.md changed a row or header outside " + slice);
    }
  }
  const before = rowColumns(liveLines[selectedIndex], slice, "live tasks.md");
  const after = rowColumns(candidateLines[selectedIndex], slice, "candidate tasks.md");
  for (let index = 1; index <= 4; index += 1) {
    if (before[index] !== after[index]) fail("candidate changed selected task identity in tasks.md");
  }
  const unchanged = before.every((column, index) => column === after[index]);
  const passed = after[0] === "[x]" && after[5] === "PASS" && after[6] === "PASS";
  if (!unchanged && !passed) fail("candidate selected row must remain unchanged or record formal PASS");
}

function assertPublicationScope(liveSnapshot, candidateSnapshot, slice, liveRoot, candidateRoot, candidateState) {
  const selectedTask = path.join("tasks", slice + ".md");
  const allowed = new Set(["tasks.md", selectedTask]);
  const paths = new Set([...liveSnapshot.keys(), ...candidateSnapshot.keys()]);
  for (const relative of paths) {
    if (allowed.has(relative)) continue;
    if (!sameEntry(liveSnapshot.get(relative), candidateSnapshot.get(relative))) {
      fail("candidate changed an execution artifact outside the selected validation: " + relative);
    }
  }
  const liveTask = liveSnapshot.get(selectedTask);
  const candidateTask = candidateSnapshot.get(selectedTask);
  const liveIndex = liveSnapshot.get("tasks.md");
  const candidateIndex = candidateSnapshot.get("tasks.md");
  if (liveTask?.kind !== "file" || candidateTask?.kind !== "file"
    || liveIndex?.kind !== "file" || candidateIndex?.kind !== "file") {
    fail("live and candidate selected task/index must be regular files");
  }
  assertValidationTaskScope(liveTask.bytes.toString("utf8"), candidateTask.bytes.toString("utf8"), slice, candidateState);
  assertTasksIndexScope(liveIndex.bytes.toString("utf8"), candidateIndex.bytes.toString("utf8"), slice);
  if (liveRoot === candidateRoot) fail("candidate and live execution roots must be distinct");
}

export async function publishValidationCandidate({ specPath, slice: sliceValue, candidateExecutionRoot }) {
  assertManagedAgreement({ specPath, slice: sliceValue });
  if (typeof specPath !== "string" || !path.isAbsolute(specPath) || path.resolve(specPath) !== specPath) {
    fail("SPEC_PATH must be absolute and canonical");
  }
  const rawSlice = String(sliceValue);
  if (!/^(?:slice-)?[0-9]+$/u.test(rawSlice)) fail("slice must be an explicit positive decimal or canonical label");
  const sliceNumber = BigInt(rawSlice.startsWith("slice-") ? rawSlice.slice(6) : rawSlice);
  if (sliceNumber < 1n) fail("slice must be positive");
  const slice = "slice-" + sliceNumber.toString(10).padStart(2, "0");
  const preflight = await preflightExecutionOperation(specPath, "VALIDATE_SLICE", sliceNumber.toString(10));
  const workspace = await resolveExecutionWorkspace(specPath);
  const liveRoot = await canonicalDirectory(workspace.executionRoot, "live execution root");
  const candidateRoot = await canonicalDirectory(candidateExecutionRoot, "candidate execution root");
  if (inside(candidateRoot, liveRoot) || inside(liveRoot, candidateRoot)) {
    fail("candidate execution root must be isolated from live execution root");
  }
  if (!preflight.tasks.has(slice)) fail("official preflight did not resolve " + slice);

  const liveBefore = await treeSnapshot(liveRoot);
  const candidateBefore = await treeSnapshot(candidateRoot);
  const candidateState = await validateExecutionCandidate(specPath, candidateRoot);
  const candidateAfterValidation = await treeSnapshot(candidateRoot);
  if (!snapshotsMatch(candidateBefore, candidateAfterValidation)) {
    fail("candidate changed while strict validation was running");
  }
  assertPublicationScope(liveBefore, candidateBefore, slice, liveRoot, candidateRoot, candidateState.state);

  const parent = path.dirname(liveRoot);
  const stagedRoot = await fs.mkdtemp(path.join(parent, ".stnl-validation-publication-"));
  let stagedSnapshot = null;
  let backupRoot = null;
  let liveMoved = false;
  let candidateInstalled = false;
  try {
    await copyRegularTree(candidateRoot, stagedRoot);
    stagedSnapshot = await treeSnapshot(stagedRoot);
    if (!snapshotsMatch(candidateBefore, stagedSnapshot)) {
      fail("staged validation candidate differs from the strictly validated candidate");
    }
    const liveRecheck = await treeSnapshot(liveRoot);
    if (!snapshotsMatch(liveBefore, liveRecheck)) {
      fail("live execution artifacts changed concurrently before validation publication");
    }

    backupRoot = await unusedSibling(parent, ".stnl-validation-backup-");
    await fs.rename(liveRoot, backupRoot);
    liveMoved = true;
    await fs.rename(stagedRoot, liveRoot);
    candidateInstalled = true;

    const readback = await inspectExecutionState(specPath);
    if (readback.state !== candidateState.state || readback.currentFingerprint !== candidateState.currentFingerprint) {
      fail("published validation state differs from its strictly validated candidate");
    }
    const publishedSnapshot = await treeSnapshot(liveRoot);
    if (!snapshotsMatch(stagedSnapshot, publishedSnapshot)) {
      fail("published validation artifacts changed during official readback");
    }
    await fs.rm(backupRoot, { recursive: true, force: false });
    backupRoot = null;
    liveMoved = false;
    return Object.freeze({
      status: "PASS",
      state: readback.state,
      currentFingerprint: readback.currentFingerprint,
      publishedExecutionRoot: liveRoot,
      selectedSlice: slice,
    });
  } catch (error) {
    if (liveMoved && backupRoot !== null) {
      if (candidateInstalled) {
        const current = await treeSnapshot(liveRoot).catch(() => null);
        if (current === null || !snapshotsMatch(stagedSnapshot, current)) {
          error.message = error.message + "; published tree changed during rollback and was preserved";
          throw error;
        }
        await fs.rm(liveRoot, { recursive: true, force: false });
      }
      await fs.rename(backupRoot, liveRoot);
      backupRoot = null;
      liveMoved = false;
    }
    throw error;
  } finally {
    await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function main(arguments_) {
  if (arguments_.length !== 7 || arguments_[0] !== "--publish"
    || arguments_[1] !== "--spec-path" || arguments_[3] !== "--slice"
    || arguments_[5] !== "--candidate-execution-root") {
    process.stderr.write("usage: publish-validation-candidate.mjs --publish --spec-path SPEC_PATH --slice SLICE --candidate-execution-root CANDIDATE_EXECUTION_ROOT\n");
    return 2;
  }
  try {
    const result = await publishValidationCandidate({
      specPath: arguments_[2],
      slice: arguments_[4],
      candidateExecutionRoot: arguments_[6],
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write("BLOCKED: " + error.message + "\n");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = await main(process.argv.slice(2));
}
