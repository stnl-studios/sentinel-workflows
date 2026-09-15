#!/usr/bin/env node

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALIDATION_OWNERS = new Set(["stnl-slice-executor", "stnl-slice-quality-manager"]);
const RESOLVER_FILENAME = "resolve-validation-runtime.mjs";
export const VALIDATION_RUNNER_PROTOCOL = "stnl-validation-runner/v10";
export const VALIDATION_HARNESS_PROTOCOL = "stnl-validation-harness/v10";

export class ValidationRuntimeResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ValidationRuntimeResolutionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ValidationRuntimeResolutionError(code, message);
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function skillMetadata(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (match === null) fail("INVALID_SKILL_METADATA", "owning skill has invalid or missing frontmatter");
  const metadata = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/u.exec(line);
    if (field === null || Object.hasOwn(metadata, field[1])) {
      fail("INVALID_SKILL_METADATA", "owning skill has invalid validation runtime metadata");
    }
    metadata[field[1]] = field[2];
  }
  return metadata;
}

function declaredEntrypoint(metadata) {
  const entrypoint = metadata["validation-runtime"];
  if (typeof entrypoint !== "string" || entrypoint.length === 0 || entrypoint.includes("\\")
    || entrypoint.includes("\0") || path.posix.isAbsolute(entrypoint)
    || path.posix.normalize(entrypoint) !== entrypoint
    || entrypoint === ".." || entrypoint.startsWith("../")) {
    fail("INVALID_VALIDATION_RUNTIME_ENTRYPOINT", "owning skill validation runtime entrypoint is not a canonical relative path");
  }
  return entrypoint;
}

async function runtimeProtocolHandshake(runtimePath) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtimePath, "--capabilities"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code: Number.isInteger(code) ? code : signal === null ? 1 : 128,
      stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  let capability;
  try { capability = JSON.parse(result.stdout); } catch { capability = null; }
  if (result.code !== 0 || result.stderr !== "" || result.stdout.length > 512
    || capability === null || typeof capability !== "object" || Array.isArray(capability)
    || Object.keys(capability).sort().join(",") !== "harness,runner"
    || capability.runner !== VALIDATION_RUNNER_PROTOCOL
    || capability.harness !== VALIDATION_HARNESS_PROTOCOL) {
    fail("INCOMPATIBLE_VALIDATION_PROTOCOL", "packaged validation runtime failed the v10 protocol handshake");
  }
}

export async function resolveOwnValidationRuntime(...callerArguments) {
  if (callerArguments.length !== 0) {
    fail("CALLER_RUNTIME_PATH_FORBIDDEN", "validation runtime resolution accepts no caller-supplied path or root");
  }
  const loadedModule = fileURLToPath(import.meta.url);
  const canonicalModule = await fs.realpath(loadedModule).catch(() => (
    fail("RESOLVER_LOCATION_UNAVAILABLE", "loaded validation runtime resolver location is unavailable")
  ));
  const runtimeRoot = path.dirname(canonicalModule);
  if (path.basename(canonicalModule) !== RESOLVER_FILENAME || path.basename(runtimeRoot) !== "runtime") {
    fail("INVALID_RESOLVER_LOCATION", "loaded validation runtime resolver is outside its packaged runtime directory");
  }
  const skillRoot = await fs.realpath(path.dirname(runtimeRoot)).catch(() => (
    fail("SKILL_LOCATION_UNAVAILABLE", "owning skill location is unavailable")
  ));
  if (!within(canonicalModule, skillRoot)) {
    fail("RESOLVER_ESCAPE", "loaded validation runtime resolver escapes its owning skill package");
  }
  const skillFile = path.join(skillRoot, "SKILL.md");
  const skillFileMetadata = await lstatOrNull(skillFile);
  if (skillFileMetadata === null || skillFileMetadata.isSymbolicLink() || !skillFileMetadata.isFile()) {
    fail("INVALID_SKILL_LOCATION", "owning skill package lacks a real SKILL.md");
  }
  const metadata = skillMetadata(await fs.readFile(skillFile, "utf8"));
  const skillName = path.basename(skillRoot);
  if (!VALIDATION_OWNERS.has(skillName) || metadata.name !== skillName) {
    fail("INVALID_SKILL_OWNER", "loaded package is not a canonical validation-owning skill");
  }
  if (metadata["validation-runner-protocol"] !== VALIDATION_RUNNER_PROTOCOL
    || metadata["validation-harness-protocol"] !== VALIDATION_HARNESS_PROTOCOL) {
    fail("INCOMPATIBLE_VALIDATION_PROTOCOL", "owning skill does not declare the canonical validation runner and harness protocols");
  }
  const entrypoint = declaredEntrypoint(metadata);
  const requestedRuntime = path.resolve(skillRoot, ...entrypoint.split("/"));
  if (!within(requestedRuntime, skillRoot)) {
    fail("VALIDATION_RUNTIME_ESCAPE", "declared validation runtime escapes its owning skill package");
  }
  const requestedMetadata = await lstatOrNull(requestedRuntime);
  if (requestedMetadata === null) {
    fail("VALIDATION_RUNTIME_MISSING", "declared validation runtime is missing from its owning skill package");
  }
  const canonicalRuntime = await fs.realpath(requestedRuntime).catch(() => (
    fail("VALIDATION_RUNTIME_UNRESOLVED", "declared validation runtime cannot be resolved")
  ));
  if (!within(canonicalRuntime, skillRoot)) {
    fail("VALIDATION_RUNTIME_ESCAPE", "declared validation runtime resolves outside its owning skill package");
  }
  if (requestedMetadata.isSymbolicLink()) {
    fail("VALIDATION_RUNTIME_SYMLINK", "declared validation runtime must not be a symbolic link");
  }
  const runtimeMetadata = await fs.stat(canonicalRuntime);
  if (!runtimeMetadata.isFile() || runtimeMetadata.nlink !== 1) {
    fail("INVALID_VALIDATION_RUNTIME", "declared validation runtime must be a single-link regular file");
  }
  await runtimeProtocolHandshake(canonicalRuntime);
  return Object.freeze({
    skillName, skillRoot, entrypoint, runtimePath: canonicalRuntime,
    runnerProtocol: VALIDATION_RUNNER_PROTOCOL, harnessProtocol: VALIDATION_HARNESS_PROTOCOL,
  });
}

export async function invokeOwnValidationRuntime(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 2
    || arguments_.some((argument) => typeof argument !== "string")) {
    fail("INVALID_VALIDATION_INVOCATION", "validation runtime invocation requires SPEC_PATH and REQUEST_JSON only");
  }
  const resolved = await resolveOwnValidationRuntime();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolved.runtimePath, ...arguments_], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(Number.isInteger(code) ? code : signal === null ? 1 : 128));
  });
}

async function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  const invoked = await fs.realpath(path.resolve(process.argv[1])).catch(() => path.resolve(process.argv[1]));
  const loaded = await fs.realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
  return invoked === loaded;
}

export async function main(arguments_) {
  try {
    if (arguments_.length === 1 && arguments_[0] === "--resolve") {
      process.stdout.write(`${(await resolveOwnValidationRuntime()).runtimePath}\n`);
      return 0;
    }
    if (arguments_.length === 1 && arguments_[0] === "--capabilities") {
      const resolved = await resolveOwnValidationRuntime();
      process.stdout.write(`${JSON.stringify({ runner: resolved.runnerProtocol, harness: resolved.harnessProtocol })}\n`);
      return 0;
    }
    return await invokeOwnValidationRuntime(arguments_);
  } catch (error) {
    if (error instanceof ValidationRuntimeResolutionError) {
      process.stderr.write(`BLOCKED: ${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (await isDirectInvocation()) process.exitCode = await main(process.argv.slice(2));
