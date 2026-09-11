#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeRequirementsAuthority,
  computeValidationSourceFingerprint,
  ExecutionContractError,
  inspectExecutionState,
  isIgnoredMetadata,
  readValidationHead,
  resolveExecutionWorkspace,
  validationEvidenceIdentity,
} from "./execution-state.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/u;
const OPERATIONS = new Set(["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]);
const REQUEST_KEYS = new Set([
  "operation", "slice", "round", "cwd", "subjects", "commands", "baselineFingerprint",
  "priorEvidenceId", "failureConclusion", "replayOriginEvidenceId",
]);
const COMMAND_KEYS = new Set(["argv", "cwd", "writePaths", "env", "timeoutMs"]);

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key))) {
    throw new ExecutionContractError(`${label} has missing or unknown fields`);
  }
}

function canonical(value) {
  if (ArrayBuffer.isView(value)) return { bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(domain, value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical([domain, value]))).digest("hex")}`;
}

function normalizedRelative(value, label, { allowParent = false } = {}) {
  if (value === ".") return value;
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.endsWith("/") || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || (!allowParent && (value === ".." || value.startsWith("../")))) {
    throw new ExecutionContractError(`${label} must be a normalized relative path`);
  }
  return value;
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function lstatOrNull(filePath) {
  try { return await fs.lstat(filePath); } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function trustedProjectRoot(workspace) {
  let current = path.dirname(workspace.authorityPath);
  for (;;) {
    const marker = await lstatOrNull(path.join(current, ".git"));
    if (marker !== null && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return current;
    const parent = path.dirname(current);
    if (parent === current) return workspace.specRoot ?? path.dirname(workspace.authorityPath);
    current = parent;
  }
}

async function assertCopySourceSafe(directory, projectRoot) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || isIgnoredMetadata(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    const metadata = await fs.lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      const raw = await fs.readlink(entryPath);
      const physical = await fs.realpath(entryPath);
      if (path.isAbsolute(raw) || !within(physical, projectRoot)) {
        throw new ExecutionContractError(`validation source contains an unsafe symlink: ${entryPath}`);
      }
    } else if (metadata.isDirectory()) await assertCopySourceSafe(entryPath, projectRoot);
  }
}

async function fingerprintTree(root) {
  const metadata = await lstatOrNull(root);
  if (metadata === null) return digest("stnl-validation-tree-v1", []);
  const entries = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (isIgnoredMetadata(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath).split(path.sep).join("/");
      const item = await fs.lstat(entryPath);
      if (item.isSymbolicLink()) entries.push([relative, "symlink", await fs.readlink(entryPath)]);
      else if (item.isDirectory()) {
        entries.push([relative, "directory"]);
        await visit(entryPath);
      } else if (item.isFile()) entries.push([relative, "file", createHash("sha256").update(await fs.readFile(entryPath)).digest("hex")]);
      else entries.push([relative, "other"]);
    }
  }
  await visit(root);
  return digest("stnl-validation-tree-v1", entries);
}

async function subjectManifest(taskDirectory, subjects, projectRoot) {
  const output = [];
  const physical = new Set();
  for (const subject of subjects) {
    const target = path.resolve(taskDirectory, subject);
    if (!within(target, projectRoot)) {
      throw new ExecutionContractError(`validation subject escapes the isolated project: ${subject}`);
    }
    const metadata = await lstatOrNull(target);
    if (metadata === null) output.push({ path: subject, expected: "REMOVED" });
    else {
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
        throw new ExecutionContractError(`validation subject is not a single-link file: ${subject}`);
      }
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (physical.has(identity)) throw new ExecutionContractError(`validation subjects alias the same physical file: ${subject}`);
      physical.add(identity);
      output.push({ path: subject, expected: `sha256:${createHash("sha256").update(await fs.readFile(target)).digest("hex")}` });
    }
  }
  return output;
}

function shellDisplay(argv) {
  return argv.map((value) => /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
}

async function resolveExecutable(command, environment, cwd) {
  const executable = command.argv[0];
  const candidates = path.isAbsolute(executable) ? [executable]
    : executable.includes(path.sep) ? [path.resolve(cwd, executable)]
      : String(environment.PATH ?? "").split(path.delimiter).filter(Boolean)
        .map((directory) => path.resolve(cwd, directory, executable));
  for (const candidate of candidates) {
    const metadata = await lstatOrNull(candidate);
    if (metadata?.isFile()) return digest("stnl-validation-executable-v1", await fs.readFile(candidate));
  }
  return digest("stnl-validation-executable-v1", { unresolved: executable, path: environment.PATH ?? "" });
}

function logicalEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, value]) => [key, digest("stnl-validation-env-value-v1", value)]));
}

function mapArgument(value, projectRoot, copiedRoot, { executable = false } = {}) {
  if (!path.isAbsolute(value)) return value;
  if (within(value, projectRoot)) return path.join(copiedRoot, path.relative(projectRoot, value));
  if (executable) return value;
  throw new ExecutionContractError(`validation command contains an absolute path outside the isolated project: ${value}`);
}

function sandboxLiteral(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parentDirectories(paths) {
  const output = new Set();
  for (const entry of paths) {
    let current = path.dirname(entry);
    while (current !== "/" && !output.has(current)) {
      output.add(current);
      current = path.dirname(current);
    }
  }
  return [...output].sort((a, b) => a.localeCompare(b, "en"));
}

async function existingReadPaths(paths) {
  const output = [];
  for (const candidate of paths) {
    const metadata = await lstatOrNull(candidate);
    if (metadata?.isDirectory() || metadata?.isFile()) output.push(candidate);
  }
  return [...new Set(output)];
}

export async function validationSandboxBackend(platform = process.platform) {
  if (platform === "darwin") {
    const metadata = await lstatOrNull("/usr/bin/sandbox-exec");
    return metadata?.isFile() && (metadata.mode & 0o111) !== 0
      ? { kind: "darwin-sandbox-exec", executable: "/usr/bin/sandbox-exec" } : null;
  }
  if (platform === "linux") {
    const metadata = await lstatOrNull("/usr/bin/bwrap");
    return metadata?.isFile() && (metadata.mode & 0o111) !== 0
      ? { kind: "linux-bwrap", executable: "/usr/bin/bwrap" } : null;
  }
  return null;
}

async function assertSandboxBackendAvailable(backend) {
  const argv = backend.kind === "darwin-sandbox-exec"
    ? [backend.executable, "-p", "(version 1) (allow default)", "--", "/usr/bin/true"]
    : [backend.executable, "--die-with-parent", "--unshare-net", "--ro-bind", "/", "/", "--", "/usr/bin/true"];
  await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
    child.once("error", () => reject(new ExecutionContractError("validation OS filesystem sandbox is unavailable")));
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new ExecutionContractError("validation OS filesystem sandbox is unavailable"));
    });
  });
}

async function startDarwinSandboxAudit(marker) {
  const watcher = spawn("/usr/bin/log", ["stream", "--style", "syslog", "--predicate", `eventMessage CONTAINS ${JSON.stringify(marker)}`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let transcript = "";
  let ready = false;
  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExecutionContractError("validation macOS sandbox audit channel is unavailable")), 2_000);
    watcher.once("error", () => {
      clearTimeout(timer);
      reject(new ExecutionContractError("validation macOS sandbox audit channel is unavailable"));
    });
    watcher.stdout.on("data", (chunk) => {
      transcript += chunk.toString("utf8");
      if (!ready) {
        ready = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
  try {
    await readyPromise;
  } catch (error) {
    watcher.kill();
    throw error;
  }
  return {
    async stop(shouldQuery) {
      // Unified Log delivery is asynchronous; retain the authenticated observer
      // briefly after the child has exited before collecting its result.
      if (!shouldQuery) {
        watcher.kill();
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      watcher.kill();
      await new Promise((resolve) => watcher.once("close", resolve));
      const historical = await new Promise((resolve) => {
        const query = spawn("/usr/bin/log", ["show", "--last", "1m", "--style", "syslog", "--predicate", `eventMessage CONTAINS ${JSON.stringify(marker)}`], { stdio: ["ignore", "pipe", "ignore"] });
        let output = "";
        query.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
        query.once("error", () => resolve(""));
        query.once("close", () => resolve(output));
      });
      const authenticated = authenticatedSandboxLog(`${transcript}\n${historical}`, marker);
      return authenticated;
    },
  };
}

function redactAuthenticatedMarker(stderr, marker) {
  if (marker === null) return stderr;
  return Buffer.from(stderr.toString("utf8").replaceAll(marker, "STNL_VALIDATION_SANDBOX:<authenticated>"));
}

function authenticatedSandboxLog(transcript, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\(Sandbox\\)[\\s\\S]{0,65536}?deny\\(\\d+\\)\\s+file-write[\\s\\S]{0,65536}?${escaped}`, "u").test(transcript);
}

async function sandboxInvocation(command, { backend, cwd, environment, sessionRoot, copiedRoot, runtimeRoot, writePaths, observeDenials = true }) {
  if (backend.kind === "darwin-sandbox-exec") {
    const readRoots = await existingReadPaths([
      copiedRoot, runtimeRoot, "/System", "/Library/Apple", "/usr", "/bin", "/sbin", "/private/etc",
      ...String(environment.PATH ?? "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(cwd, entry)),
      path.dirname(command.argv[0]),
      path.join(os.homedir(), ".CFUserTextEncoding"),
    ]);
    const writable = [runtimeRoot, ...writePaths];
    // The nonce is not in the child environment or argv. The observer authenticates
    // only the matching macOS Unified Log file-write event, never application stderr.
    const violationMarker = observeDenials ? `STNL_VALIDATION_SANDBOX:${randomUUID()}` : null;
    const profile = [
      "(version 1)", `(deny default${violationMarker === null ? "" : ` (with message ${sandboxLiteral(violationMarker)})`})`,
      '(import "system.sb")', "(deny network*)", "(allow process*)",
      ...parentDirectories(readRoots).map((entry) => `(allow file-read-metadata file-test-existence (subpath ${sandboxLiteral(entry)}))`),
      `(allow file-read* file-test-existence ${readRoots.map((entry) => `(subpath ${sandboxLiteral(entry)})`).join(" ")})`,
      `(deny file-write* (require-all ${writable.map((entry) => `(require-not (subpath ${sandboxLiteral(entry)}))`).join(" ")})${violationMarker === null ? "" : ` (with message ${sandboxLiteral(violationMarker)})`})`,
      `(allow file-write* ${writable.map((entry) => `(subpath ${sandboxLiteral(entry)})`).join(" ")})`,
    ].join(" ");
    return { argv: [backend.executable, "-p", profile, "--", ...command.argv], cwd, violationMarker };
  }
  if (backend.kind === "linux-bwrap") {
    const arguments_ = [
      backend.executable, "--die-with-parent", "--unshare-net", "--ro-bind", "/", "/",
      "--bind", runtimeRoot, runtimeRoot,
    ];
    for (const writable of writePaths) arguments_.push("--bind", writable, writable);
    arguments_.push("--chdir", cwd, "--", ...command.argv);
    return { argv: arguments_, cwd, violationMarker: null };
  }
  throw new ExecutionContractError("validation requires an available OS filesystem sandbox (macOS sandbox-exec or Linux bwrap)");
}

function remapSandboxPath(value, sourceRoot, targetRoot) {
  return value === sourceRoot || value.startsWith(`${sourceRoot}${path.sep}`)
    ? path.join(targetRoot, path.relative(sourceRoot, value)) : value;
}

async function preparePermissiveProbe({ command, backend, cwd, environment, sessionRoot, copiedRoot, runtimeRoot }) {
  // A fresh isolated permissive copy is used only to disambiguate a failed
  // protected run; its outputs never become evidence or replay material.
  const probeRoot = await fs.mkdtemp(path.join(sessionRoot, "probe-"));
  await fs.cp(copiedRoot, probeRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git" && !isIgnoredMetadata(path.basename(source)),
  });
  const probeRuntimeRoot = await fs.mkdtemp(path.join(sessionRoot, "probe-runtime-"));
  await fs.mkdir(path.join(probeRuntimeRoot, "home"), { recursive: true });
  await fs.mkdir(path.join(probeRuntimeRoot, "tmp"), { recursive: true });
  const probeEnvironment = Object.fromEntries(Object.entries(environment).map(([key, value]) => [
    key, remapSandboxPath(value, runtimeRoot, probeRuntimeRoot),
  ]));
  const probeCommand = {
    ...command,
    argv: command.argv.map((value) => remapSandboxPath(value, copiedRoot, probeRoot)),
    cwd: remapSandboxPath(cwd, copiedRoot, probeRoot),
  };
  return {
    command: probeCommand,
    options: {
      backend, cwd: probeCommand.cwd, environment: probeEnvironment, sessionRoot,
      copiedRoot: probeRoot, runtimeRoot: probeRuntimeRoot, writePaths: [probeRoot],
      observeDenials: false,
    },
  };
}

async function execute(command, { backend, cwd, environment, sessionRoot, copiedRoot, runtimeRoot, writePaths, probeOnFailure = true, observeDenials = true }) {
  const probe = probeOnFailure && backend.kind === "darwin-sandbox-exec"
    ? await preparePermissiveProbe({ command, backend, cwd, sessionRoot, copiedRoot, runtimeRoot, environment }) : null;
  const isolated = await sandboxInvocation(command, { backend, cwd, environment, sessionRoot, copiedRoot, runtimeRoot, writePaths, observeDenials });
  const audit = isolated.violationMarker === null ? null : await startDarwinSandboxAudit(isolated.violationMarker);
  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), command.timeoutMs);
    const child = spawn(isolated.argv[0], isolated.argv.slice(1), {
      cwd: isolated.cwd, env: environment, signal: controller.signal, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    const collect = (chunks, kind) => (chunk) => {
      const size = kind === "stdout" ? stdoutSize : stderrSize;
      if (size < 1_048_576) chunks.push(chunk.subarray(0, 1_048_576 - size));
      if (kind === "stdout") stdoutSize += chunk.length;
      else stderrSize += chunk.length;
    };
    child.stdout.on("data", collect(stdout, "stdout"));
    child.stderr.on("data", collect(stderr, "stderr"));
    let settled = false;
    const finish = async (payload) => {
      if (settled) return;
      settled = true;
      let sandboxViolation = audit === null ? false : await audit.stop(payload.exit !== 0 && !payload.timedOut && !payload.signaled);
      if (!sandboxViolation && probe !== null && payload.exit !== 0 && !payload.timedOut && !payload.signaled) {
        const permissive = await execute(probe.command, { ...probe.options, probeOnFailure: false });
        sandboxViolation = permissive.exit === 0 && !permissive.timedOut && !permissive.signaled;
      }
      const sandboxOutcomeUncertain = backend.kind === "linux-bwrap" && payload.exit !== 0 && !payload.timedOut && !payload.signaled;
      resolve({ ...payload, sandboxViolation, sandboxOutcomeUncertain,
        stderrForEvidence: sandboxViolation ? redactAuthenticatedMarker(payload.stderr, isolated.violationMarker) : payload.stderr });
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.name === "AbortError") finish({ exit: 124, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut: true, signaled: false });
      else reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      const stderrBuffer = Buffer.concat(stderr);
      await finish({
        exit: Number.isInteger(code) ? code : signal === null ? 1 : 128,
        stdout: Buffer.concat(stdout), stderr: stderrBuffer, timedOut: false,
        signaled: signal !== null,
      });
    });
  });
}

function replayComponentMap({ operation, slice, round, cwd, executionRoot, inputs, commands }) {
  return {
    operation, slice, round, cwd, executionRoot,
    requirementsAuthority: inputs.requirementsAuthority,
    planRevision: inputs.planRevision,
    head: inputs.head,
    sourceFingerprint: inputs.sourceFingerprint,
    manifestFingerprint: inputs.manifestFingerprint,
    baselineFingerprint: inputs.baselineFingerprint,
    changedScopeFingerprint: inputs.changedScopeFingerprint,
    commandsFingerprint: digest("stnl-validation-commands-v1", commands.map(({
      display, argv, cwd, writePaths, envFingerprint, executableFingerprint, timeoutMs,
    }) => ({ display, argv, cwd, writePaths, envFingerprint, executableFingerprint, timeoutMs }))),
  };
}

function replayDescriptor(provenance) {
  return {
    evidenceId: provenance.evidenceId,
    ...replayComponentMap({
      operation: provenance.operation,
      slice: provenance.slice,
      round: provenance.round,
      cwd: provenance.workspace.cwd,
      executionRoot: provenance.workspace.executionRoot,
      inputs: provenance.inputs,
      commands: provenance.commands,
    }),
    executionFingerprint: provenance.inputs.executionFingerprint,
  };
}

function expectedValidationInvocation(task, operation) {
  if (operation === "VALIDATE_SLICE") {
    const previous = task.attempts.at(-1) ?? null;
    if (previous !== null && new Set(["PASS", "ACCEPTED"]).has(previous.status)) return null;
    return { round: null, priorEvidenceId: previous?.provenance?.evidenceId ?? null };
  }
  const records = operation === "EXECUTE_SLICE" ? task.implementationChecks : task.findingsChecks;
  let cycleRecords = records;
  if (operation === "APPLY_FINDINGS") {
    const cycle = task.attempts.at(-1)?.id ?? null;
    if (cycle === null) return null;
    cycleRecords = records.filter((record) => record.findingsCycle === cycle);
  }
  const previous = cycleRecords.at(-1) ?? null;
  let round = "1/3";
  if (previous?.status === "TESTS_FAIL" && previous.round < 3) round = `${previous.round + 1}/3`;
  else if (previous?.status === "BLOCKED") round = "1/3";
  else if (previous !== null) return null;
  if (task.delegationBlocker?.state === "active" && task.delegationBlocker.operation === operation
    && task.delegationBlocker.pendingRound !== null) round = `${task.delegationBlocker.pendingRound}/3`;
  return { round, priorEvidenceId: records.at(-1)?.provenance?.evidenceId ?? null };
}

export async function runValidationSession(specPath, request) {
  exactObject(request, REQUEST_KEYS, "validation session request");
  if (!OPERATIONS.has(request.operation) || !/^slice-(?:[0-9]{2}|[1-9][0-9]{2,})$/u.test(request.slice)) {
    throw new ExecutionContractError("validation session operation or slice is invalid");
  }
  const expectedRound = request.operation === "VALIDATE_SLICE" ? null : /^(?:1|2|3)\/3$/u.test(request.round) ? request.round : undefined;
  if (expectedRound === undefined || request.round !== expectedRound) throw new ExecutionContractError("validation session round is invalid");
  normalizedRelative(request.cwd, "validation session cwd");
  if (!Array.isArray(request.subjects)) throw new ExecutionContractError("validation session subjects must be an array");
  const subjects = request.subjects.map((entry) => normalizedRelative(entry, "validation session subject", { allowParent: true })).sort((a, b) => a.localeCompare(b, "en"));
  if (new Set(subjects).size !== subjects.length) throw new ExecutionContractError("validation session subjects must be unique");
  if (!Array.isArray(request.commands)) throw new ExecutionContractError("validation session commands must be an array");
  if (request.baselineFingerprint !== null && !HASH.test(request.baselineFingerprint)) throw new ExecutionContractError("validation session baseline fingerprint is invalid");
  if (request.priorEvidenceId !== null && !HASH.test(request.priorEvidenceId)) throw new ExecutionContractError("validation session prior evidence ID is invalid");
  if (request.replayOriginEvidenceId !== null && !HASH.test(request.replayOriginEvidenceId)) {
    throw new ExecutionContractError("validation session replay origin evidence ID is invalid");
  }
  if (!["NONE", "VALIDATION_FINDING", "CODE_REGRESSION"].includes(request.failureConclusion)) {
    throw new ExecutionContractError("validation session failure conclusion is invalid");
  }

  const workspace = await resolveExecutionWorkspace(specPath);
  const state = await inspectExecutionState(specPath);
  const task = state.tasks?.get(request.slice);
  if (task === undefined) throw new ExecutionContractError(`validation session slice does not exist: ${request.slice}`);
  const legal = state.legalOperations.some((target) => target.operation === request.operation && target.slice === request.slice);
  if (!legal) throw new ExecutionContractError(`validation session operation is not authorized for ${request.slice} from ${state.state}`);
  const expectedInvocation = expectedValidationInvocation(task, request.operation);
  if (expectedInvocation === null || request.round !== expectedInvocation.round
    || request.priorEvidenceId !== expectedInvocation.priorEvidenceId) {
    throw new ExecutionContractError("validation session round or prior evidence does not match current lifecycle state");
  }
  const projectRoot = await trustedProjectRoot(workspace);
  const sandboxBackend = await validationSandboxBackend();
  if (sandboxBackend === null) {
    throw new ExecutionContractError("validation requires a supported, available OS filesystem sandbox; Windows and other platforms are fail-closed unsupported for v1");
  }
  await assertSandboxBackendAvailable(sandboxBackend);
  const liveExecutionBefore = await fingerprintTree(workspace.executionRoot);
  const liveWorkspaceBefore = await fingerprintTree(projectRoot);
  await assertCopySourceSafe(projectRoot, projectRoot);
  const sessionRoot = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "stnl-validation-session-")));
  const copiedRoot = path.join(sessionRoot, "workspace");
  const runtimeRoot = path.join(sessionRoot, "runtime");
  let cleanup = "clean";
  let result;
  try {
    await fs.cp(projectRoot, copiedRoot, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".git" && !isIgnoredMetadata(path.basename(source)),
    });
    await fs.mkdir(path.join(runtimeRoot, "home"), { recursive: true });
    await fs.mkdir(path.join(runtimeRoot, "tmp"), { recursive: true });
    const executionRelative = path.relative(projectRoot, workspace.executionRoot).split(path.sep).join("/");
    const copiedExecutionRoot = path.join(copiedRoot, executionRelative);
    const copiedTaskDirectory = path.join(copiedRoot, executionRelative, "tasks");
    const isolatedExecutionBefore = await fingerprintTree(copiedExecutionRoot);
    const beforeSubjects = await subjectManifest(copiedTaskDirectory, subjects, copiedRoot);
    const sourceFingerprint = await computeValidationSourceFingerprint(copiedRoot, copiedExecutionRoot);
    const manifestFingerprint = digest("stnl-validation-subject-manifest-v1", beforeSubjects);
    const changedScope = digest("stnl-validation-changed-scope-v1", beforeSubjects.map((entry) => entry.path));
    const stableEnvironment = {
      PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C", TZ: "UTC",
      HOME: "$VALIDATION_HOME", TMPDIR: "$VALIDATION_TMPDIR",
    };
    const commandPlans = [];
    const actualEnvironments = [];
    for (const [index, command] of request.commands.entries()) {
      exactObject(command, COMMAND_KEYS, `validation command ${index + 1}`);
      if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((entry) => typeof entry !== "string" || entry.length === 0)
        || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0) throw new ExecutionContractError(`validation command ${index + 1} is malformed`);
      normalizedRelative(command.cwd, `validation command ${index + 1} cwd`);
      if (!Array.isArray(command.writePaths)) throw new ExecutionContractError(`validation command ${index + 1} writePaths must be an array`);
      const writePaths = command.writePaths.map((entry) => normalizedRelative(entry, `validation command ${index + 1} write path`))
        .sort((a, b) => a.localeCompare(b, "en"));
      if (new Set(writePaths).size !== writePaths.length || writePaths.includes(".")) {
        throw new ExecutionContractError(`validation command ${index + 1} writePaths must be unique bounded paths`);
      }
      for (const writePath of writePaths) {
        if (writePath === executionRelative || writePath.startsWith(`${executionRelative}/`)
          || executionRelative.startsWith(`${writePath}/`)) {
          throw new ExecutionContractError(`validation command ${index + 1} cannot write protected execution state`);
        }
        const absoluteWrite = path.resolve(copiedRoot, writePath);
        if (!within(absoluteWrite, copiedRoot)
          || subjects.some((subject) => {
            const absoluteSubject = path.resolve(copiedTaskDirectory, subject);
            return within(absoluteSubject, absoluteWrite) || within(absoluteWrite, absoluteSubject);
          })) throw new ExecutionContractError(`validation command ${index + 1} write path overlaps validation inputs`);
        await fs.mkdir(absoluteWrite, { recursive: true });
      }
      if (command.env === null || typeof command.env !== "object" || Array.isArray(command.env)
        || Object.entries(command.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string")) {
        throw new ExecutionContractError(`validation command ${index + 1} env is malformed`);
      }
      for (const value of Object.values(command.env)) if (value.includes(projectRoot)) {
        throw new ExecutionContractError(`validation command ${index + 1} env leaks a live project path`);
      }
      const logicalEnv = { ...stableEnvironment, ...command.env };
      const actualEnv = { ...logicalEnv, HOME: path.join(runtimeRoot, "home"), TMPDIR: path.join(runtimeRoot, "tmp") };
      const actualArgv = command.argv.map((value, position) => mapArgument(value, projectRoot, copiedRoot, { executable: position === 0 }));
      commandPlans.push({
        display: shellDisplay(command.argv.map((value) => path.isAbsolute(value) && within(value, projectRoot)
          ? `$PROJECT/${path.relative(projectRoot, value).split(path.sep).join("/")}` : value)),
        argv: command.argv.map((value) => path.isAbsolute(value) && within(value, projectRoot)
          ? `$PROJECT/${path.relative(projectRoot, value).split(path.sep).join("/")}` : value),
        cwd: command.cwd,
        writePaths,
        envFingerprint: digest("stnl-validation-environment-v1", logicalEnvironment(logicalEnv)),
        executableFingerprint: await resolveExecutable({ argv: actualArgv }, actualEnv, path.join(copiedRoot, command.cwd)),
        timeoutMs: command.timeoutMs,
        actualArgv,
      });
      actualEnvironments.push(actualEnv);
    }
    const materialCommands = commandPlans.map(({ actualArgv: _actualArgv, ...command }) => command);
    const inputs = {
      requirementsAuthority: `sha256:${await computeRequirementsAuthority(specPath)}`,
      planRevision: task.revision,
      head: await readValidationHead(projectRoot),
      sourceFingerprint,
      manifestFingerprint,
      baselineFingerprint: request.baselineFingerprint,
      changedScopeFingerprint: changedScope,
      executionFingerprint: "",
    };
    const material = replayComponentMap({
      operation: request.operation, slice: request.slice, round: request.round, cwd: request.cwd,
      executionRoot: executionRelative, inputs, commands: materialCommands,
    });
    inputs.executionFingerprint = digest("stnl-validation-execution-v1", {
      operation: request.operation, slice: request.slice, round: request.round, cwd: request.cwd,
      executionRoot: executionRelative, subjects: beforeSubjects, commands: materialCommands,
      inputs: { ...inputs, executionFingerprint: undefined },
    });
    // JSON serialization omits the undefined self-reference, matching the parser's explicit deletion.
    const currentReplay = { ...material, executionFingerprint: inputs.executionFingerprint };
    let replay = null;
    let replayInvalid = false;
    if (request.replayOriginEvidenceId !== null) {
      const historicalRecords = [
        ...task.implementationChecks, ...task.findingsChecks, ...task.attempts,
      ];
      const originRecord = historicalRecords.find((record) => record.provenance?.evidenceId === request.replayOriginEvidenceId);
      if (originRecord === undefined) {
        throw new ExecutionContractError("validation replay origin is not anchored to persisted slice evidence");
      }
      if (originRecord.provenance.state !== "VERIFIED") {
        throw new ExecutionContractError("validation replay origin must be verified persisted evidence");
      }
      const origin = replayDescriptor(originRecord.provenance);
      const mismatches = Object.keys(currentReplay).filter((key) => origin[key] !== currentReplay[key]).sort();
      replayInvalid = mismatches.length !== 0;
      replay = {
        originalEvidenceId: origin.evidenceId,
        originalFingerprint: origin.executionFingerprint,
        currentFingerprint: inputs.executionFingerprint,
        equivalent: !replayInvalid,
        mismatches,
      };
    }
    if (request.failureConclusion === "CODE_REGRESSION" && request.replayOriginEvidenceId === null) {
      throw new ExecutionContractError("CODE_REGRESSION requires an original replay descriptor");
    }
    const commandEvidence = [];
    const outputs = [];
    for (let index = 0; index < commandPlans.length; index += 1) {
      const plan = commandPlans[index];
      const execution = replayInvalid ? {
        exit: 125, stdout: Buffer.alloc(0), stderr: Buffer.from("replay inputs are not equivalent\n"),
        timedOut: false, sandboxViolation: false,
      }
        : await execute({ argv: plan.actualArgv, timeoutMs: plan.timeoutMs }, {
          backend: sandboxBackend,
          cwd: path.join(copiedRoot, request.commands[index].cwd), environment: actualEnvironments[index],
          sessionRoot, copiedRoot, runtimeRoot,
          writePaths: plan.writePaths.map((entry) => path.resolve(copiedRoot, entry)),
        });
      commandEvidence.push({
        display: plan.display, argv: plan.argv, cwd: plan.cwd, writePaths: plan.writePaths,
        envFingerprint: plan.envFingerprint,
        executableFingerprint: plan.executableFingerprint, timeoutMs: plan.timeoutMs, exit: execution.exit,
        stdoutFingerprint: digest("stnl-validation-stdout-v1", execution.stdout),
        stderrFingerprint: digest("stnl-validation-stderr-v1", execution.stderrForEvidence),
      });
      outputs.push({
        display: plan.display, exit: execution.exit, timedOut: execution.timedOut,
        sandboxViolation: execution.sandboxViolation, sandboxOutcomeUncertain: execution.sandboxOutcomeUncertain,
        stdout: execution.stdout.toString("utf8").slice(-4000), stderr: execution.stderr.toString("utf8").slice(-4000),
      });
    }
    const afterSubjects = await subjectManifest(copiedTaskDirectory, subjects, copiedRoot);
    const sideEffects = [];
    if (outputs.some((output) => output.sandboxViolation)) sideEffects.push("validation-sandbox-boundary-violation");
    if (outputs.some((output) => output.sandboxOutcomeUncertain)) sideEffects.push("validation-sandbox-outcome-indeterminate");
    if (JSON.stringify(beforeSubjects) !== JSON.stringify(afterSubjects)) sideEffects.push("validation-subject-state-changed");
    const isolatedExecutionAfter = await fingerprintTree(copiedExecutionRoot);
    if (isolatedExecutionBefore !== isolatedExecutionAfter) sideEffects.push("isolated-execution-state-changed");
    const liveExecutionAfter = await fingerprintTree(workspace.executionRoot);
    if (liveExecutionBefore !== liveExecutionAfter) sideEffects.push("protected-live-execution-state-changed");
    const liveWorkspaceAfter = await fingerprintTree(projectRoot);
    if (liveWorkspaceBefore !== liveWorkspaceAfter) sideEffects.push("protected-live-workspace-state-changed");
    let classification = sideEffects.length !== 0 ? "VALIDATION_SIDE_EFFECT" : replayInvalid ? "INVALID_REPLAY" : "NONE";
    let evidenceState = classification === "NONE" ? "VERIFIED" : "INVALID";
    const failed = commandEvidence.some((command) => command.exit !== 0);
    let conclusion = evidenceState === "VERIFIED" && failed ? request.failureConclusion : "NONE";
    result = {
      provenance: {
        version: 1, evidenceId: "", priorEvidenceId: request.priorEvidenceId, state: evidenceState,
        classification, conclusion, operation: request.operation, slice: request.slice, round: request.round,
        workspace: {
          kind: "isolated-copy", workspaceId: inputs.executionFingerprint, cwd: request.cwd,
          executionRoot: executionRelative, liveExecutionFingerprintBefore: liveExecutionBefore,
          liveExecutionFingerprintAfter: liveExecutionAfter,
          liveWorkspaceFingerprintBefore: liveWorkspaceBefore, liveWorkspaceFingerprintAfter: liveWorkspaceAfter,
          isolatedExecutionFingerprintBefore: isolatedExecutionBefore, isolatedExecutionFingerprintAfter: isolatedExecutionAfter,
          cleanup: "clean", sideEffects: sideEffects.sort(),
        },
        inputs, subjects: beforeSubjects, commands: commandEvidence, replay,
      },
      outputs,
    };
  } finally {
    try { await fs.rm(sessionRoot, { recursive: true, force: true }); } catch { cleanup = "failed"; }
  }
  if (cleanup !== "clean") {
    result.provenance.workspace.cleanup = cleanup;
    result.provenance.workspace.sideEffects = [...new Set([...result.provenance.workspace.sideEffects, "validation-workspace-cleanup-failed"])].sort();
    result.provenance.state = "INVALID";
    result.provenance.classification = "VALIDATION_SIDE_EFFECT";
    result.provenance.conclusion = "NONE";
  }
  result.provenance.evidenceId = validationEvidenceIdentity(result.provenance);
  return Object.freeze(result);
}

export async function main(arguments_) {
  if (arguments_.length !== 2) {
    process.stderr.write("usage: run-validation-session.mjs SPEC_PATH REQUEST_JSON\n");
    return 2;
  }
  try {
    const result = await runValidationSession(arguments_[0], JSON.parse(arguments_[1]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.provenance.state === "INVALID" ? 1 : 0;
  } catch (error) {
    if (error instanceof ExecutionContractError || error instanceof SyntaxError) {
      process.stderr.write(`BLOCKED: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const executed = process.argv[1] !== undefined
  && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
