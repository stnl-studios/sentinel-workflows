#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { prepareRunnerValidationPersistenceFromResponse } from "./serialize-runner-evidence.mjs";
import { preflightExecutionOperation, resolveExecutionWorkspace } from "./execution-state.mjs";

function fail(message) {
  throw new Error(`validation candidate preparation blocked: ${message}`);
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalSlice(value) {
  const raw = String(value);
  if (!/^(?:slice-)?[0-9]+$/u.test(raw)) fail("slice must be a positive decimal or canonical slice label");
  const digits = raw.startsWith("slice-") ? raw.slice(6) : raw;
  const number = BigInt(digits);
  if (number < 1n) fail("slice must be positive");
  return `slice-${number.toString(10).padStart(2, "0")}`;
}

async function realDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be absolute`);
  const metadata = await fs.lstat(value).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${label} must be a real directory`);
  return fs.realpath(value);
}

async function realFile(value, label) {
  const metadata = await fs.lstat(value).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    fail(`${label} must be a single-link real file: ${value}`);
  }
  return fs.realpath(value);
}

function sectionRange(text, heading, label) {
  const marker = `## ${heading}\n\n`;
  const start = text.indexOf(marker);
  if (start < 0 || text.indexOf(marker, start + marker.length) >= 0) fail(`${label} has a missing or duplicate ${heading} section`);
  const bodyStart = start + marker.length;
  const next = text.indexOf("\n## ", bodyStart);
  const end = next < 0 ? text.length : next;
  return { bodyStart, end, body: text.slice(bodyStart, end).trim() };
}

function replaceSection(text, heading, body, label) {
  const section = sectionRange(text, heading, label);
  return `${text.slice(0, section.bodyStart)}${body}\n${text.slice(section.end)}`;
}

function selectedRow(text, slice, label) {
  const matches = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("|")) continue;
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    if (columns.length !== 7) fail(`${label} has a malformed canonical tasks.md row`);
    if (columns[1].startsWith(`${slice.slice("slice-".length)} - `)) matches.push({ index, line, columns });
  }
  if (matches.length !== 1) fail(`${label} must contain exactly one row for ${slice}`);
  return { lines, ...matches[0] };
}

async function writeCandidateFiles(entries) {
  const staged = [];
  try {
    for (const entry of entries) {
      const temporary = `${entry.file}.stnl-validation-candidate-${process.pid}-${staged.length}.tmp`;
      await fs.writeFile(temporary, entry.after, { encoding: "utf8", flag: "wx" });
      staged.push({ ...entry, temporary });
    }
    for (const entry of staged) await fs.rename(entry.temporary, entry.file);
  } catch (error) {
    await Promise.all(staged.map((entry) => fs.rm(entry.temporary, { force: true }).catch(() => {})));
    throw error;
  }
}

export async function prepareValidationCandidate({ specPath, slice: sliceValue, workspace, candidateExecutionRoot, semanticResponseFile }) {
  if (typeof specPath !== "string" || !path.isAbsolute(specPath)) fail("SPEC_PATH must be absolute");
  if (typeof semanticResponseFile !== "string" || !path.isAbsolute(semanticResponseFile)) {
    fail("semantic response file must be absolute");
  }
  const slice = canonicalSlice(sliceValue);
  const preflight = await preflightExecutionOperation(specPath, "VALIDATE_SLICE", BigInt(slice.slice(6)).toString(10));
  const officialWorkspace = await resolveExecutionWorkspace(specPath);
  const workspaceRoot = await realDirectory(workspace, "managed workspace");
  const liveExecutionRoot = await fs.realpath(officialWorkspace.executionRoot);
  const candidateRoot = await realDirectory(candidateExecutionRoot, "candidate execution root");
  if (!inside(liveExecutionRoot, workspaceRoot)) fail("official execution root is outside the managed workspace");
  if (inside(candidateRoot, liveExecutionRoot) || inside(liveExecutionRoot, candidateRoot)) {
    fail("candidate execution root must be isolated from live execution artifacts");
  }

  const taskArtifact = path.join(officialWorkspace.executionRoot, "tasks", `${slice}.md`);
  const liveTaskFile = await realFile(taskArtifact, "live task artifact");
  const candidateTaskFile = await realFile(path.join(candidateRoot, "tasks", `${slice}.md`), "candidate task artifact");
  const liveIndexFile = await realFile(path.join(officialWorkspace.executionRoot, "tasks.md"), "live tasks.md");
  const candidateIndexFile = await realFile(path.join(candidateRoot, "tasks.md"), "candidate tasks.md");
  const responseFile = await realFile(semanticResponseFile, "semantic response file");
  if (!inside(liveTaskFile, liveExecutionRoot) || !inside(candidateTaskFile, candidateRoot)
    || !inside(liveIndexFile, liveExecutionRoot) || !inside(candidateIndexFile, candidateRoot)) {
    fail("candidate or live record resolves outside its canonical execution root");
  }
  if (inside(responseFile, officialWorkspace.executionRoot) || (officialWorkspace.specRoot !== null && inside(responseFile, officialWorkspace.specRoot))) {
    fail("semantic response file must remain outside the SPEC and execution root");
  }

  const [liveTaskBefore, candidateTaskBefore, liveIndexBefore, candidateIndexBefore, semanticResponse] = await Promise.all([
    fs.readFile(liveTaskFile, "utf8"),
    fs.readFile(candidateTaskFile, "utf8"),
    fs.readFile(liveIndexFile, "utf8"),
    fs.readFile(candidateIndexFile, "utf8"),
    fs.readFile(responseFile, "utf8"),
  ]);
  const selected = preflight.tasks.get(slice);
  if (selected === undefined) fail(`official preflight did not resolve ${slice}`);
  const mechanicalSections = ["Validation Attempts", "Effective Validation Base", "Final Result"];
  for (const heading of mechanicalSections) {
    if (sectionRange(candidateTaskBefore, heading, "candidate task").body
      !== sectionRange(liveTaskBefore, heading, "live task").body) {
      fail(`candidate ${heading} must remain byte-identical to live authority until deterministic preparation`);
    }
  }
  const liveRow = selectedRow(liveIndexBefore, slice, "live tasks.md");
  const candidateRow = selectedRow(candidateIndexBefore, slice, "candidate tasks.md");
  if (candidateRow.line !== liveRow.line) fail("candidate selected tasks.md row must remain unchanged until deterministic preparation");

  const prepared = await prepareRunnerValidationPersistenceFromResponse({
    operation: "VALIDATE_SLICE",
    response: semanticResponse,
    workspace: workspaceRoot,
    taskArtifact: liveTaskFile,
    specPath,
    slice: slice.slice(6),
  });
  if (prepared.attemptId !== `attempt-${String(selected.attempts.length + 1).padStart(2, "0")}`) {
    fail("canonical producer attempt identity disagrees with official preflight");
  }

  const attempts = sectionRange(candidateTaskBefore, "Validation Attempts", "candidate task");
  const priorAttempts = attempts.body === "- none" ? "" : attempts.body;
  const nextAttempts = priorAttempts.length === 0
    ? prepared.attemptRecord
    : `${priorAttempts}\n\n${prepared.attemptRecord}`;
  let candidateTaskAfter = replaceSection(candidateTaskBefore, "Validation Attempts", nextAttempts, "candidate task");
  let candidateIndexAfter = candidateIndexBefore;
  if (prepared.status === "PASS") {
    if (prepared.effectiveValidationBase === null) fail("canonical PASS producer omitted the Effective Validation Base");
    candidateTaskAfter = replaceSection(candidateTaskAfter, "Effective Validation Base", prepared.effectiveValidationBase, "candidate task");
    candidateTaskAfter = replaceSection(candidateTaskAfter, "Final Result", "- PASS", "candidate task");
    const columns = [...liveRow.columns];
    if (columns[0] !== "[ ]" || columns[5] !== "pending" || columns[6] !== "pending") {
      fail("official open row is not pending for a formal PASS");
    }
    columns[0] = "[x]";
    columns[5] = "PASS";
    columns[6] = "PASS";
    liveRow.lines[liveRow.index] = `| ${columns.join(" | ")} |`;
    candidateIndexAfter = liveRow.lines.join("\n");
  }

  if (await fs.readFile(candidateTaskFile, "utf8") !== candidateTaskBefore
    || await fs.readFile(candidateIndexFile, "utf8") !== candidateIndexBefore) {
    fail("candidate changed concurrently during deterministic preparation");
  }
  const changed = [{ file: candidateTaskFile, after: candidateTaskAfter }];
  if (candidateIndexAfter !== candidateIndexBefore) changed.push({ file: candidateIndexFile, after: candidateIndexAfter });
  await writeCandidateFiles(changed);
  return Object.freeze({
    status: "PREPARED",
    formalStatus: prepared.status,
    attemptId: prepared.attemptId,
    changedPaths: Object.freeze(changed.map(({ file }) => file)),
    bundle: prepared.bundle,
  });
}

export async function main(arguments_) {
  const options = new Map();
  const valid = new Set(["--prepare", "--spec-path", "--slice", "--workspace", "--candidate-execution-root", "--semantic-response-file"]);
  let prepare = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const key = arguments_[index];
    if (!valid.has(key)) fail(`unknown option ${key}`);
    if (key === "--prepare") {
      if (prepare) fail("duplicate --prepare");
      prepare = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${key}`);
    if (options.has(key)) fail(`duplicate ${key}`);
    options.set(key, value);
    index += 1;
  }
  const required = ["--spec-path", "--slice", "--workspace", "--candidate-execution-root", "--semantic-response-file"];
  if (!prepare || required.some((key) => !options.has(key)) || options.size !== required.length) {
    fail("usage: prepare-validation-candidate.mjs --prepare --spec-path SPEC_PATH --slice SLICE --workspace MANAGED_WORKSPACE --candidate-execution-root CANDIDATE_EXECUTION_ROOT --semantic-response-file RESPONSE_FILE");
  }
  const result = await prepareValidationCandidate({
    specPath: options.get("--spec-path"),
    slice: options.get("--slice"),
    workspace: options.get("--workspace"),
    candidateExecutionRoot: options.get("--candidate-execution-root"),
    semanticResponseFile: options.get("--semantic-response-file"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
