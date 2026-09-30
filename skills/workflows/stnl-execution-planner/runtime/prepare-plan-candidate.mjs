#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(RUNTIME_ROOT);
const PLAN_TEMPLATE = path.join(SKILL_ROOT, "templates", "plan.template.md");
const SLICE_PLAN_TEMPLATE = path.join(SKILL_ROOT, "templates", "slice-plan.template.md");
const HEADER_PATTERN = /^# File Purpose Header\n\n```yaml\n([\s\S]*?)^```\n\n/mu;

function blocked(message) {
  throw new Error(`plan candidate preparation blocked: ${message}`);
}

async function readRegularFile(file, label) {
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
    blocked(`${label} is not a real regular file: ${file}`);
  }
  return fs.readFile(file, "utf8");
}

function canonicalHeader(template, label) {
  const match = HEADER_PATTERN.exec(template);
  if (match === null) blocked(`${label} template has no canonical File Purpose Header`);
  return match[0];
}

function parseHeaderFields(block, label) {
  const match = HEADER_PATTERN.exec(block);
  if (match === null || match.index !== 0 || match[0] !== block) {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }
  const lines = match[1].split("\n");
  if (lines.at(-1) === "") lines.pop();
  const fields = new Map();
  for (const line of lines) {
    const field = /^([a-z][a-z0-9_]*): (\S.*)$/u.exec(line);
    if (field === null || fields.has(field[1])) {
      blocked(`${label} has a malformed or conflicting File Purpose Header`);
    }
    fields.set(field[1], field[2]);
  }
  return fields;
}

function prepareHeader(text, header, label) {
  const match = HEADER_PATTERN.exec(text);
  if (match === null) {
    if (text.includes("# File Purpose Header")) {
      blocked(`${label} has a malformed or conflicting File Purpose Header`);
    }
    return `${header}${text}`;
  }
  if (match.index !== 0) {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }

  const sourceFields = parseHeaderFields(match[0], label);
  const canonicalFields = parseHeaderFields(header, `${label} template`);
  const sourceKeys = [...sourceFields.keys()].sort();
  const canonicalKeys = [...canonicalFields.keys()].sort();
  if (JSON.stringify(sourceKeys) !== JSON.stringify(canonicalKeys)) {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }
  const status = sourceFields.get("status");
  if (status !== "draft" && status !== "ready") {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }
  const remainder = text.slice(match[0].length);
  if (/^# File Purpose Header(?:\n|$)/mu.test(remainder)) {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }
  const canonicalForStatus = header.replace(/^status: draft$/mu, `status: ${status}`);
  return `${canonicalForStatus}${remainder}`;
}

async function writeAtomically(file, text) {
  const temporary = `${file}.stnl-purpose-header-${process.pid}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function preparePlanCandidate({ candidateExecutionRoot }) {
  const candidate = path.resolve(String(candidateExecutionRoot));
  const candidateMetadata = await fs.lstat(candidate).catch(() => null);
  if (candidateMetadata === null || candidateMetadata.isSymbolicLink() || !candidateMetadata.isDirectory()) {
    blocked(`candidate execution root is not a real directory: ${candidate}`);
  }

  const [planTemplate, slicePlanTemplate] = await Promise.all([
    readRegularFile(PLAN_TEMPLATE, "plan template"),
    readRegularFile(SLICE_PLAN_TEMPLATE, "slice-plan template"),
  ]);
  const headers = {
    plan: canonicalHeader(planTemplate, "plan"),
    slice: canonicalHeader(slicePlanTemplate, "slice-plan"),
  };
  const artifacts = [{
    path: path.join(candidate, "plan.md"),
    header: headers.plan,
    label: "candidate plan.md",
  }];
  const plansDirectory = path.join(candidate, "plans");
  const directoryMetadata = await fs.lstat(plansDirectory).catch(() => null);
  if (directoryMetadata !== null) {
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      blocked(`candidate plans directory is not a real directory: ${plansDirectory}`);
    }
    const entries = await fs.readdir(plansDirectory, { withFileTypes: true });
    for (const entry of entries.filter((item) => /^slice-\d+\.md$/u.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      artifacts.push({
        path: path.join(plansDirectory, entry.name),
        header: headers.slice,
        label: `candidate ${entry.name}`,
      });
    }
  }

  const preparedArtifacts = [];
  for (const artifact of artifacts) {
    const before = await readRegularFile(artifact.path, artifact.label);
    const after = prepareHeader(before, artifact.header, artifact.label);
    preparedArtifacts.push({ path: artifact.path, before, after });
  }

  const changedPaths = [];
  for (const artifact of preparedArtifacts) {
    if (artifact.after === artifact.before) continue;
    await writeAtomically(artifact.path, artifact.after);
    changedPaths.push(artifact.path);
  }
  return Object.freeze({
    status: "PASS",
    changedPaths: Object.freeze(changedPaths),
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 2 || arguments_[0] !== "--candidate-execution-root") {
    throw new Error("usage: prepare-plan-candidate.mjs --candidate-execution-root CANDIDATE_EXECUTION_ROOT");
  }
  const result = await preparePlanCandidate({ candidateExecutionRoot: arguments_[1] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
