#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = new Set(["plan.md", "tasks.md"]);
const ROOT_DIRECTORIES = new Set(["plans", "tasks"]);
const SPEC_ROOT_ENTRIES = new Set(["feature_spec.md", "shared", "execution"]);
const SLICE_FILE = /^slice-[0-9]{2,}\.md$/u;

function isIgnoredMetadata(name) {
  return name === ".DS_Store" || name === "__MACOSX" || name.startsWith("._");
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function requireRealFile(filePath, label) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a real file: ${filePath}`);
  }
}

async function resolveRoots(specPath) {
  const requested = path.resolve(String(specPath));
  const metadata = await lstatOrNull(requested);
  if (metadata === null || metadata.isSymbolicLink()) {
    throw new Error(`SPEC_PATH must exist and must not be a symlink: ${requested}`);
  }
  if (metadata.isDirectory()) {
    const feature = path.join(requested, "feature_spec.md");
    await requireRealFile(feature, "workspace feature_spec.md");
    return { specRoot: requested, executionRoot: path.join(requested, "execution") };
  }
  if (!metadata.isFile()) {
    throw new Error(`SPEC_PATH must be a workspace directory or requirements file: ${requested}`);
  }
  if (path.basename(requested) === "feature_spec.md") {
    return {
      specRoot: path.dirname(requested),
      executionRoot: path.join(path.dirname(requested), "execution"),
    };
  }
  const parsed = path.parse(requested);
  return {
    specRoot: null,
    executionRoot: path.join(parsed.dir, `${parsed.name}-execution`),
  };
}

async function inspectSliceDirectory(directory, findings) {
  const metadata = await lstatOrNull(directory);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    findings.push(directory);
    return;
  }
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (isIgnoredMetadata(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !SLICE_FILE.test(entry.name)) {
      findings.push(entryPath);
    }
  }
}

async function canonicalSliceNames(directory) {
  const metadata = await lstatOrNull(directory);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) return [];
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && SLICE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function findNonCanonicalExecutionPaths(specPath) {
  const { specRoot, executionRoot } = await resolveRoots(specPath);
  const findings = [];
  if (specRoot !== null) {
    for (const entry of await fs.readdir(specRoot, { withFileTypes: true })) {
      if (isIgnoredMetadata(entry.name)) continue;
      if (!SPEC_ROOT_ENTRIES.has(entry.name)) findings.push(path.join(specRoot, entry.name));
    }
  }
  const rootMetadata = await lstatOrNull(executionRoot);
  if (rootMetadata === null || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    findings.push(executionRoot);
    return [...new Set(findings)].sort();
  }
  for (const entry of await fs.readdir(executionRoot, { withFileTypes: true })) {
    if (isIgnoredMetadata(entry.name)) continue;
    const entryPath = path.join(executionRoot, entry.name);
    if (ROOT_FILES.has(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) findings.push(entryPath);
      continue;
    }
    if (ROOT_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) findings.push(entryPath);
      continue;
    }
    findings.push(entryPath);
  }
  for (const required of ROOT_FILES) {
    await requireRealFile(path.join(executionRoot, required), required).catch(() => {
      findings.push(path.join(executionRoot, required));
    });
  }
  await inspectSliceDirectory(path.join(executionRoot, "plans"), findings);
  await inspectSliceDirectory(path.join(executionRoot, "tasks"), findings);
  const plans = await canonicalSliceNames(path.join(executionRoot, "plans"));
  const tasks = await canonicalSliceNames(path.join(executionRoot, "tasks"));
  const allSlices = new Set([...plans, ...tasks]);
  for (const name of allSlices) {
    if (!plans.includes(name)) findings.push(path.join(executionRoot, "plans", name));
    if (!tasks.includes(name)) findings.push(path.join(executionRoot, "tasks", name));
  }
  return [...new Set(findings)].sort();
}

export async function validateExecutionLayout(specPath) {
  const findings = await findNonCanonicalExecutionPaths(specPath);
  if (findings.length !== 0) {
    const error = new Error("execution layout contains non-canonical paths");
    error.findings = findings;
    throw error;
  }
}

async function main(arguments_) {
  if (arguments_.length !== 1) {
    process.stderr.write("usage: validate-execution-layout.mjs SPEC_PATH\n");
    return 2;
  }
  try {
    await validateExecutionLayout(arguments_[0]);
    process.stdout.write("APPROVED: canonical execution layout\n");
    return 0;
  } catch (error) {
    if (Array.isArray(error.findings)) {
      for (const finding of error.findings) {
        process.stderr.write(
          `BLOCKED: non-canonical SPEC path '${finding}'; relocate it outside the SPEC or remove it explicitly\n`,
        );
      }
    } else {
      process.stderr.write(`BLOCKED: ${error.message}\n`);
    }
    return 1;
  }
}

const executed = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
