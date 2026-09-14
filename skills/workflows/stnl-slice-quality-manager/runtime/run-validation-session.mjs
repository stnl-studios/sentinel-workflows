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
const LIVE_WORKSPACE_DELTA_LIMIT = 64;
const SYSTEM_READ_ROOTS = [
  "/System", "/Library/Apple", "/Library/Preferences", "/usr/bin", "/usr/lib", "/usr/libexec", "/usr/sbin", "/usr/share",
  "/bin", "/sbin", "/private/etc", "/private/var/db/timezone",
];
const SYSTEM_READ_FILES = [
  "/", "/dev/autofs_nowait", "/dev/dtracehelper", "/dev/null", "/dev/random", "/dev/tty", "/dev/urandom",
  "/private/var/select/sh",
];
const OPERATIONS = new Set(["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]);
const REQUEST_KEYS = new Set([
  "operation", "slice", "round", "cwd", "subjects", "commands", "baselineFingerprint",
  "priorEvidenceId", "failureConclusion", "replayOriginEvidenceId",
]);
const COMMAND_KEYS = new Set(["argv", "cwd", "writePaths", "writeFiles", "env", "timeoutMs"]);
const LEGACY_COMMAND_KEYS = new Set([...COMMAND_KEYS].filter((key) => key !== "writeFiles"));

class ValidationInfrastructureError extends ExecutionContractError {
  constructor(kind, stage, code, message, target = null) {
    super(message, target === null ? [] : [target]);
    this.blocker = Object.freeze({ kind, stage, code, message, target });
  }
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionContractError(`${label} must be an object with exact fields`);
  }
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key)).sort((left, right) => left.localeCompare(right, "en"));
  const unknown = actual.filter((key) => !keys.has(key));
  if (missing.length !== 0 || unknown.length !== 0) {
    throw new ExecutionContractError(`${label} field mismatch; missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}`);
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

async function statOrNull(filePath) {
  try { return await fs.stat(filePath); } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") return null;
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

async function assertCopySourceSafe(directory, projectRoot, canonicalRoot = null, symlinks = []) {
  canonicalRoot ??= await fs.realpath(projectRoot);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || isIgnoredMetadata(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    const metadata = await fs.lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      const relative = path.relative(projectRoot, entryPath).split(path.sep).join("/");
      let physical;
      try {
        physical = await fs.realpath(entryPath);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") {
          throw new ValidationInfrastructureError(
            "source-isolation", "source-admission", "UNRESOLVED_SYMLINK",
            `validation source symlink cannot be resolved: ${relative}`, relative,
          );
        }
        throw error;
      }
      if (!within(physical, canonicalRoot)) {
        throw new ValidationInfrastructureError(
          "source-isolation", "source-admission", "SYMLINK_ESCAPE",
          `validation source symlink escapes its trusted project: ${relative}`, relative,
        );
      }
      symlinks.push({
        relative,
        raw: await fs.readlink(entryPath),
        targetRelative: path.relative(canonicalRoot, physical),
      });
    } else if (metadata.isDirectory()) await assertCopySourceSafe(entryPath, projectRoot, canonicalRoot, symlinks);
  }
  return symlinks;
}

async function copyValidationSource(projectRoot, copiedRoot, symlinks) {
  await fs.cp(projectRoot, copiedRoot, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => path.basename(source) !== ".git" && !isIgnoredMetadata(path.basename(source)),
  });
  // Absolute links that canonically point into the live project are safe source
  // entries, but they must be rebased so the isolated copy cannot read live files.
  for (const symlink of symlinks.filter((entry) => path.isAbsolute(entry.raw))) {
    const copiedLink = path.join(copiedRoot, symlink.relative);
    const copiedTarget = path.join(copiedRoot, symlink.targetRelative);
    await fs.unlink(copiedLink);
    await fs.symlink(path.relative(path.dirname(copiedLink), copiedTarget), copiedLink);
  }
  await assertCopySourceSafe(copiedRoot, copiedRoot);
}

async function snapshotTree(root, { ignoreMetadata = true } = {}) {
  const metadata = await lstatOrNull(root);
  if (metadata === null) return { fingerprint: digest("stnl-validation-tree-v1", []), entries: [] };
  const entries = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (ignoreMetadata && isIgnoredMetadata(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath).split(path.sep).join("/");
      const item = await fs.lstat(entryPath);
      if (item.isSymbolicLink()) entries.push([relative, "symlink", item.mode & 0o777, await fs.readlink(entryPath)]);
      else if (item.isDirectory()) {
        entries.push([relative, "directory", item.mode & 0o777]);
        await visit(entryPath);
      } else if (item.isFile()) entries.push([relative, "file", item.mode & 0o777, createHash("sha256").update(await fs.readFile(entryPath)).digest("hex")]);
      else entries.push([relative, "other", item.mode & 0o777]);
    }
  }
  await visit(root);
  return { fingerprint: digest("stnl-validation-tree-v1", entries), entries };
}

async function fingerprintTree(root) {
  return (await snapshotTree(root)).fingerprint;
}

function treeDelta(before, after) {
  const beforeEntries = new Map(before.entries.map((entry) => [entry[0], entry]));
  const afterEntries = new Map(after.entries.map((entry) => [entry[0], entry]));
  const changes = [];
  for (const identity of [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])].sort((a, b) => a.localeCompare(b, "en"))) {
    const previous = beforeEntries.get(identity);
    const current = afterEntries.get(identity);
    if (previous === undefined) changes.push({ path: identity, disposition: "added" });
    else if (current === undefined) changes.push({ path: identity, disposition: "removed" });
    else if (JSON.stringify(previous) !== JSON.stringify(current)) changes.push({ path: identity, disposition: "modified" });
  }
  if (changes.length === 0) return null;
  const counts = Object.fromEntries(["added", "modified", "removed"].map((disposition) => [
    disposition, changes.filter((entry) => entry.disposition === disposition).length,
  ]));
  return {
    limit: LIVE_WORKSPACE_DELTA_LIMIT,
    total: changes.length,
    counts,
    changes: changes.slice(0, LIVE_WORKSPACE_DELTA_LIMIT),
    truncated: changes.length > LIVE_WORKSPACE_DELTA_LIMIT,
    fingerprint: digest("stnl-validation-live-workspace-delta-v1", changes),
  };
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

async function fileIdentity(filePath) {
  const metadata = await fs.stat(filePath);
  return {
    mode: metadata.mode & 0o777,
    content: createHash("sha256").update(await fs.readFile(filePath)).digest("hex"),
  };
}

function isSystemPath(candidate) {
  return SYSTEM_READ_ROOTS.some((root) => within(candidate, root));
}

async function inheritedPathDirectories(cwd) {
  const output = new Set();
  for (const entry of String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(cwd, entry);
    const metadata = await statOrNull(candidate);
    if (metadata?.isDirectory()) output.add(await fs.realpath(candidate));
  }
  return output;
}

async function assertSymlinkTreeBounded(directory, boundary) {
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const metadata = await fs.lstat(entryPath);
      if (metadata.isSymbolicLink()) {
        const rawTarget = await fs.readlink(entryPath);
        const directTarget = path.resolve(path.dirname(entryPath), rawTarget);
        if (path.isAbsolute(rawTarget) || !within(directTarget, boundary)) {
          throw new ExecutionContractError("external toolchain dependency symlink leaves its canonical package boundary");
        }
        let target;
        try { target = await fs.realpath(entryPath); } catch {
          throw new ExecutionContractError("external toolchain contains an unresolved dependency symlink");
        }
        if (!within(target, boundary)) {
          throw new ExecutionContractError("external toolchain dependency escapes its canonical package boundary");
        }
      } else if (metadata.isDirectory()) await visit(entryPath);
      else if (metadata.isFile() && metadata.nlink !== 1) {
        throw new ExecutionContractError("external toolchain dependency aliases a file outside its canonical package boundary");
      } else if (!metadata.isFile()) {
        throw new ExecutionContractError("external toolchain dependency contains an unsupported filesystem entry");
      }
    }
  }
  await visit(directory);
}

async function packageBoundary(executable, installationRoot) {
  let current = path.dirname(executable);
  while (current !== installationRoot && within(current, installationRoot)) {
    const manifest = path.join(current, "package.json");
    const metadata = await lstatOrNull(manifest);
    if (metadata?.isFile() && !metadata.isSymbolicLink()) {
      let parsed;
      try { parsed = JSON.parse(await fs.readFile(manifest, "utf8")); } catch {
        throw new ExecutionContractError("external toolchain package boundary has invalid package metadata");
      }
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        && typeof parsed.name === "string" && parsed.name.length !== 0) return current;
      throw new ExecutionContractError("external toolchain package boundary has invalid package metadata");
    }
    current = path.dirname(current);
  }
  throw new ExecutionContractError("external executable dependency root cannot be safely determined");
}

async function shebangInterpreter(executable, installationRoot, binDirectory) {
  const firstLine = (await fs.readFile(executable, "utf8")).split(/\r?\n/u, 1)[0];
  if (!firstLine.startsWith("#!")) throw new ExecutionContractError("external launcher target has no bounded interpreter dependency");
  const words = firstLine.slice(2).trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) throw new ExecutionContractError("external launcher target has an invalid interpreter dependency");
  let interpreter = words[0];
  if (path.basename(interpreter) === "env") {
    const name = words.find((entry, index) => index > 0 && !entry.startsWith("-"));
    if (name === undefined || name.includes(path.sep)) {
      throw new ExecutionContractError("external launcher target has an ambiguous env interpreter dependency");
    }
    interpreter = path.join(binDirectory, name);
  }
  const canonical = await fs.realpath(interpreter).catch(() => null);
  if (canonical === null) throw new ExecutionContractError("external launcher interpreter dependency is unresolved");
  if (isSystemPath(canonical)) return null;
  if (!within(canonical, installationRoot)) {
    throw new ExecutionContractError("external launcher interpreter escapes its canonical installation boundary");
  }
  const metadata = await fs.stat(canonical);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o111) === 0) {
    throw new ExecutionContractError("external launcher interpreter dependency is not executable");
  }
  return canonical;
}

async function externalToolchain(candidate, canonicalExecutable, trustedPathDirectories) {
  const candidateDirectory = await fs.realpath(path.dirname(candidate));
  if (!trustedPathDirectories.has(candidateDirectory) || path.basename(candidateDirectory) !== "bin") {
    throw new ExecutionContractError("external executable is not rooted in an inherited canonical toolchain bin directory");
  }
  const installationRoot = await fs.realpath(path.dirname(candidateDirectory));
  if (installationRoot === path.parse(installationRoot).root || within(os.homedir(), installationRoot)
    || !within(canonicalExecutable, installationRoot)) {
    throw new ExecutionContractError("external executable has an unsafe canonical installation boundary");
  }
  const rawLauncher = await fs.readlink(candidate);
  const directTarget = path.resolve(path.dirname(candidate), rawLauncher);
  if (!within(directTarget, installationRoot) || (await fs.lstat(directTarget)).isSymbolicLink()) {
    throw new ExecutionContractError("external launcher has an ambiguous or escaping dependency chain");
  }
  const packageRoot = await packageBoundary(canonicalExecutable, installationRoot);
  await assertSymlinkTreeBounded(packageRoot, packageRoot);
  const interpreter = await shebangInterpreter(canonicalExecutable, installationRoot, candidateDirectory);
  const packageSnapshot = await snapshotTree(packageRoot, { ignoreMetadata: false });
  const material = {
    launcher: path.relative(installationRoot, candidate).split(path.sep).join("/"),
    launcherTarget: path.relative(installationRoot, canonicalExecutable).split(path.sep).join("/"),
    launcherValue: rawLauncher,
    packageRoot: path.relative(installationRoot, packageRoot).split(path.sep).join("/"),
    packageFingerprint: packageSnapshot.fingerprint,
    interpreter: interpreter === null ? null : path.relative(installationRoot, interpreter).split(path.sep).join("/"),
    interpreterIdentity: interpreter === null ? null : await fileIdentity(interpreter),
  };
  return {
    sourceRoot: installationRoot, sourceBin: candidateDirectory, packageRoot, interpreter,
    material, fingerprint: digest("stnl-validation-external-toolchain-v1", {
      root: digest("stnl-validation-external-toolchain-root-v1", installationRoot), material,
    }),
  };
}

async function resolveExecutable(command, environment, cwd, copiedRoot) {
  const executable = command.argv[0];
  const candidates = path.isAbsolute(executable) ? [executable]
    : executable.includes(path.sep) ? [path.resolve(cwd, executable)]
      : String(environment.PATH ?? "").split(path.delimiter).filter(Boolean)
        .map((directory) => path.resolve(cwd, directory, executable));
  const trustedPathDirectories = await inheritedPathDirectories(cwd);
  for (const candidate of candidates) {
    const metadata = await statOrNull(candidate);
    if (!metadata?.isFile() || (metadata.mode & 0o111) === 0) continue;
    const physicalCandidate = path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate));
    const canonicalExecutable = await fs.realpath(physicalCandidate);
    const candidateMetadata = await fs.lstat(physicalCandidate);
    const stablePath = within(canonicalExecutable, copiedRoot)
      ? `$PROJECT/${path.relative(copiedRoot, canonicalExecutable).split(path.sep).join("/")}` : canonicalExecutable;
    const executableFingerprint = digest("stnl-validation-executable-v2", {
      path: stablePath, identity: await fileIdentity(canonicalExecutable),
    });
    if (within(canonicalExecutable, copiedRoot) || isSystemPath(canonicalExecutable)
      || (!candidateMetadata.isSymbolicLink() && canonicalExecutable === await fs.realpath(process.execPath))) {
      return { candidate: physicalCandidate, canonicalExecutable, executableFingerprint, toolchain: null };
    }
    if (!candidateMetadata.isSymbolicLink()) {
      throw new ExecutionContractError("external executable has no safely derivable dependency boundary");
    }
    return {
      candidate: physicalCandidate, canonicalExecutable, executableFingerprint,
      toolchain: await externalToolchain(physicalCandidate, canonicalExecutable, trustedPathDirectories),
    };
  }
  throw new ExecutionContractError(`validation executable cannot be resolved: ${executable}`);
}

async function currentToolchainFingerprint(toolchain) {
  const canonicalExecutable = await fs.realpath(path.join(toolchain.sourceRoot, toolchain.material.launcher)).catch(() => null);
  if (canonicalExecutable === null) return null;
  try {
    const current = await externalToolchain(
      path.join(toolchain.sourceRoot, toolchain.material.launcher),
      canonicalExecutable,
      new Set([toolchain.sourceBin]),
    );
    return current.fingerprint;
  } catch {
    return null;
  }
}

async function copyTrustedToolchain(toolchain, toolchainsRoot) {
  const destination = path.join(toolchainsRoot, toolchain.fingerprint.slice("sha256:".length));
  const packageRelative = path.relative(toolchain.sourceRoot, toolchain.packageRoot);
  await fs.mkdir(path.dirname(path.join(destination, packageRelative)), { recursive: true });
  await fs.cp(toolchain.packageRoot, path.join(destination, packageRelative), {
    recursive: true, verbatimSymlinks: true,
  });
  if (toolchain.interpreter !== null) {
    const interpreterRelative = path.relative(toolchain.sourceRoot, toolchain.interpreter);
    await fs.mkdir(path.dirname(path.join(destination, interpreterRelative)), { recursive: true });
    await fs.copyFile(toolchain.interpreter, path.join(destination, interpreterRelative));
    await fs.chmod(path.join(destination, interpreterRelative), (await fs.stat(toolchain.interpreter)).mode & 0o777);
  }
  const launcher = path.join(toolchain.sourceRoot, toolchain.material.launcher);
  const copiedLauncher = path.join(destination, toolchain.material.launcher);
  await fs.mkdir(path.dirname(copiedLauncher), { recursive: true });
  const rawLauncher = await fs.readlink(launcher);
  const copiedTarget = path.join(destination, toolchain.material.launcherTarget);
  await fs.symlink(path.isAbsolute(rawLauncher) ? path.relative(path.dirname(copiedLauncher), copiedTarget) : rawLauncher, copiedLauncher);
  const copiedCanonical = await fs.realpath(copiedLauncher).catch(() => null);
  if (copiedCanonical === null || copiedCanonical !== copiedTarget) {
    throw new ExecutionContractError("external toolchain snapshot did not preserve its canonical launcher identity");
  }
  const copiedPackage = await snapshotTree(path.join(destination, packageRelative), { ignoreMetadata: false });
  if (copiedPackage.fingerprint !== toolchain.material.packageFingerprint
    || (toolchain.interpreter !== null
      && JSON.stringify(await fileIdentity(path.join(destination, toolchain.material.interpreter)))
        !== JSON.stringify(toolchain.material.interpreterIdentity))
    || await currentToolchainFingerprint(toolchain) !== toolchain.fingerprint) {
    throw new ExecutionContractError("external toolchain changed while its authenticated snapshot was created");
  }
  return {
    root: destination,
    bin: path.join(destination, path.relative(toolchain.sourceRoot, toolchain.sourceBin)),
    launcher: copiedLauncher,
  };
}

async function admittedToolchainFingerprintAfter(toolchain, snapshot) {
  if (await currentToolchainFingerprint(toolchain) !== toolchain.fingerprint) return null;
  try {
    const copiedTarget = path.join(snapshot.root, toolchain.material.launcherTarget);
    if (await fs.realpath(snapshot.launcher) !== copiedTarget) return null;
    const packageRoot = path.join(snapshot.root, toolchain.material.packageRoot);
    if ((await snapshotTree(packageRoot, { ignoreMetadata: false })).fingerprint
      !== toolchain.material.packageFingerprint) return null;
    if (toolchain.material.interpreter !== null
      && JSON.stringify(await fileIdentity(path.join(snapshot.root, toolchain.material.interpreter)))
        !== JSON.stringify(toolchain.material.interpreterIdentity)) return null;
    return toolchain.fingerprint;
  } catch {
    return null;
  }
}

async function sandboxPath(environmentPath, cwd, copiedRoot, toolchain, snapshot) {
  const output = [];
  for (const entry of String(environmentPath ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(cwd, entry);
    let canonical;
    try { canonical = await fs.realpath(candidate); } catch { continue; }
    if (within(canonical, copiedRoot) || isSystemPath(canonical)) output.push(candidate);
    else if (toolchain !== null && canonical === toolchain.sourceBin) output.push(snapshot.bin);
  }
  if (toolchain !== null && !output.includes(snapshot.bin)) output.unshift(snapshot.bin);
  return [...new Set(output)].join(path.delimiter);
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

async function existingReadFiles(paths) {
  const output = [];
  for (const candidate of paths) {
    const metadata = await lstatOrNull(candidate);
    if (metadata?.isFile() || metadata?.isDirectory()) output.push(candidate);
    else if (metadata?.isSymbolicLink()) {
      output.push(candidate);
      const target = await fs.realpath(candidate).catch(() => null);
      if (target !== null) output.push(target);
    }
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
    async stop(shouldQuery, supplementalTranscript = "") {
      // Unified Log delivery is asynchronous; retain the authenticated observer
      // briefly after the child has exited before collecting its result.
      if (!shouldQuery) {
        watcher.kill();
        return [];
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
      return authenticatedSandboxEvents(`${transcript}\n${historical}\n${supplementalTranscript}`, marker);
    },
  };
}

function redactAuthenticatedMarker(stderr, marker) {
  if (marker === null) return stderr;
  return Buffer.from(stderr.toString("utf8").replaceAll(marker, "STNL_VALIDATION_SANDBOX:<authenticated>"));
}

function authenticatedSandboxEvents(transcript, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `(?:Sandbox:\\s+)?([A-Za-z0-9._+-]+)\\(\\d+\\)\\s+deny\\(\\d+\\)\\s+(file-[a-z0-9-]+)\\s+([^\\n]+?)(?:\\n|\\s)+${escaped}(?=\\n|$)`,
    "gu",
  );
  const unique = new Map();
  for (const match of transcript.matchAll(pattern)) {
    const event = { process: match[1], operation: match[2], requestedPath: match[3].trim() };
    if (event.operation.startsWith("file-read")
      && (SYSTEM_READ_FILES.includes(event.requestedPath) || isSystemPath(event.requestedPath))) continue;
    unique.set(JSON.stringify(event), event);
  }
  return [...unique.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

async function sandboxInvocation(command, { backend, cwd, environment, sessionRoot, copiedRoot, runtimeRoot, writePaths, writeFiles = [], toolchainRoots = [], observeDenials = true }) {
  if (backend.kind === "darwin-sandbox-exec") {
    const readRoots = await existingReadPaths([
      copiedRoot, runtimeRoot, ...toolchainRoots, ...SYSTEM_READ_ROOTS,
      ...String(environment.PATH ?? "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(cwd, entry)),
      ...(path.isAbsolute(command.argv[0]) ? [command.argv[0]] : []),
      path.join(os.homedir(), ".CFUserTextEncoding"),
    ]);
    const readFiles = await existingReadFiles(SYSTEM_READ_FILES);
    const writableDirectories = [runtimeRoot, ...writePaths];
    // The nonce is not in the child environment or argv. The observer authenticates
    // only the matching macOS Unified Log file-write event, never application stderr.
    const violationMarker = observeDenials ? `STNL_VALIDATION_SANDBOX:${randomUUID()}` : null;
    const profile = [
      "(version 1)", `(deny default${violationMarker === null ? "" : ` (with message ${sandboxLiteral(violationMarker)})`})`,
      '(import "system.sb")', "(deny network*)", "(allow process*)",
      ...parentDirectories([...readRoots, ...readFiles]).map((entry) => `(allow file-read-metadata file-test-existence (literal ${sandboxLiteral(entry)}))`),
      `(deny file-read* (require-all ${[
        ...readRoots.map((entry) => `(require-not (subpath ${sandboxLiteral(entry)}))`),
        ...readFiles.map((entry) => `(require-not (literal ${sandboxLiteral(entry)}))`),
      ].join(" ")})${violationMarker === null ? "" : ` (with message ${sandboxLiteral(violationMarker)})`})`,
      `(allow file-read* file-test-existence ${[
        ...readRoots.map((entry) => `(subpath ${sandboxLiteral(entry)})`),
        ...readFiles.map((entry) => `(literal ${sandboxLiteral(entry)})`),
      ].join(" ")})`,
      `(deny file-write* (require-all ${[
        ...writableDirectories.map((entry) => `(require-not (subpath ${sandboxLiteral(entry)}))`),
        ...writeFiles.map((entry) => `(require-not (literal ${sandboxLiteral(entry)}))`),
      ].join(" ")})${violationMarker === null ? "" : ` (with message ${sandboxLiteral(violationMarker)})`})`,
      `(allow file-write* ${[
        ...writableDirectories.map((entry) => `(subpath ${sandboxLiteral(entry)})`),
        ...writeFiles.map((entry) => `(literal ${sandboxLiteral(entry)})`),
      ].join(" ")})`,
    ].join(" ");
    return { argv: [backend.executable, "-p", profile, "--", ...command.argv], cwd, violationMarker };
  }
  if (backend.kind === "linux-bwrap") {
    const arguments_ = [
      backend.executable, "--die-with-parent", "--unshare-net", "--ro-bind", "/", "/",
      "--tmpfs", os.homedir(),
      "--bind", runtimeRoot, runtimeRoot,
    ];
    for (const toolchainRoot of toolchainRoots) arguments_.push("--ro-bind", toolchainRoot, toolchainRoot);
    for (const writable of writePaths) arguments_.push("--bind", writable, writable);
    for (const writable of writeFiles) arguments_.push("--bind", writable, writable);
    arguments_.push("--chdir", cwd, "--", ...command.argv);
    return { argv: arguments_, cwd, violationMarker: null };
  }
  throw new ExecutionContractError("validation requires an available OS filesystem sandbox (macOS sandbox-exec or Linux bwrap)");
}

function remapSandboxPath(value, sourceRoot, targetRoot) {
  return value === sourceRoot || value.startsWith(`${sourceRoot}${path.sep}`)
    ? path.join(targetRoot, path.relative(sourceRoot, value)) : value;
}

function normalizeGeneratedPath(value) {
  return value
    .replace(/timestamp-[0-9]+-[0-9a-f]+(?=\.)/gu, "timestamp-<generated>")
    .replace(/\/([^/]+)-[A-Za-z0-9]{6}(?=\/|$)/gu, "/$1-<generated>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, "<nonce>");
}

async function resolvedAccessPath(requestedPath) {
  if (requestedPath === null || !path.isAbsolute(requestedPath)) return requestedPath;
  let current = requestedPath;
  const suffix = [];
  for (;;) {
    try {
      const canonical = await fs.realpath(current);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if (!new Set(["ENOENT", "ENOTDIR"]).has(error?.code)) return requestedPath;
    }
    const parent = path.dirname(current);
    if (parent === current) return requestedPath;
    suffix.push(path.basename(current));
    current = parent;
  }
}

function classifiedPath(value, roots) {
  if (value === null) return { value: null, trustedRoot: "unavailable" };
  const mappings = [
    [roots.copiedRoot, "$PROJECT", "isolated-workspace"],
    [roots.runtimeRoot, "$VALIDATION_RUNTIME", "validation-runtime"],
    ...roots.toolchainRoots.map((root) => [root, "$AUTHENTICATED_TOOLCHAIN", "authenticated-toolchain"]),
    [roots.projectRoot, "$LIVE_PROJECT", "live-workspace"],
    [os.homedir(), "$HOME", "user-home"],
    ...roots.systemTempRoots.map((root) => [root, "$SYSTEM_TEMP", "system-temp"]),
    ...SYSTEM_READ_ROOTS.map((root) => [root, "$SYSTEM", "system"]),
  ];
  for (const [root, label, trustedRoot] of mappings) {
    if (!within(value, root)) continue;
    const relative = path.relative(root, value).split(path.sep).join("/");
    return { value: normalizeGeneratedPath(relative === "" ? label : `${label}/${relative}`), trustedRoot };
  }
  const basename = path.basename(value);
  return {
    value: normalizeGeneratedPath(`$ABSOLUTE/<external>/${basename === path.parse(value).root ? "<root>" : basename}`),
    trustedRoot: "external",
  };
}

async function boundaryDiagnostic(event, {
  commandIndex, commandExecutable, copiedRoot, runtimeRoot, toolchainRoots, projectRoot,
  executionRoot, subjects, writePaths, writeFiles, liveWorkspaceChanged,
}) {
  const systemTempRoots = [...new Set([
    os.tmpdir(), await fs.realpath(os.tmpdir()).catch(() => os.tmpdir()),
  ])];
  const classificationRoots = { copiedRoot, runtimeRoot, toolchainRoots, projectRoot, systemTempRoots };
  const resolvedRaw = await resolvedAccessPath(event.requestedPath);
  const requested = classifiedPath(event.requestedPath, classificationRoots);
  const resolved = classifiedPath(resolvedRaw, classificationRoots);
  const target = resolvedRaw ?? event.requestedPath;
  const writeOperation = typeof event.operation === "string" && event.operation.startsWith("file-write");
  const operation = typeof event.operation === "string" && event.operation.startsWith("file-")
    ? event.operation.slice("file-".length) : "unknown";
  let boundary = "external-filesystem";
  let rule = "external-path-denied";
  if (target !== null && within(target, copiedRoot)) {
    const inExecution = within(target, executionRoot);
    const inSubject = subjects.some((subject) => target === subject || within(target, subject) || within(subject, target));
    const declaredDirectory = writePaths.some((allowed) => within(target, allowed));
    const declaredFile = writeFiles.some((allowed) => target === allowed);
    boundary = inExecution || inSubject ? "protected-validation-inputs" : "declared-isolated-outputs";
    rule = inExecution || inSubject ? "protected-input-write-denied"
      : declaredDirectory || declaredFile ? "declared-output-rule-mismatch"
        : writeOperation ? "write-outside-declared-isolated-outputs" : "read-outside-isolated-source";
  } else if (target !== null && toolchainRoots.some((root) => within(target, root))) {
    boundary = "authenticated-toolchain-snapshot";
    rule = writeOperation ? "authenticated-toolchain-is-read-only" : "toolchain-read-rule-mismatch";
  } else if (target !== null && within(target, projectRoot)) {
    boundary = "live-workspace";
    rule = "live-workspace-access-denied";
  } else if (target !== null && within(target, runtimeRoot)) {
    boundary = "validation-runtime";
    rule = "validation-runtime-rule-mismatch";
  } else if (target !== null && within(target, os.homedir())) {
    boundary = "user-home";
    rule = "unrelated-user-home-access-denied";
  } else if (target !== null && systemTempRoots.some((root) => within(target, root))) {
    boundary = "system-temp";
    rule = "unmanaged-system-temp-access-denied";
  }
  return {
    kind: event.requestedPath === null ? "sandbox-outcome-indeterminate" : "sandbox-denial",
    operation,
    process: event.process,
    command: commandIndex,
    commandExecutable,
    requestedPath: requested.value,
    resolvedPath: resolved.value,
    trustedRoot: resolved.trustedRoot,
    boundary,
    rule,
    deniedBeforeMutation: writeOperation ? true : null,
    liveWorkspaceChanged,
  };
}

async function preparePermissiveProbe({ command, backend, cwd, environment, sessionRoot, copiedRoot, runtimeRoot, toolchainRoots }) {
  // A fresh isolated permissive copy is used only to disambiguate a failed
  // protected run; its outputs never become evidence or replay material.
  const probeRoot = await fs.mkdtemp(path.join(sessionRoot, "probe-"));
  await fs.cp(copiedRoot, probeRoot, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => path.basename(source) !== ".git" && !isIgnoredMetadata(path.basename(source)),
  });
  const beforeSnapshot = await snapshotTree(probeRoot);
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
    beforeSnapshot,
    options: {
      backend, cwd: probeCommand.cwd, environment: probeEnvironment, sessionRoot,
      copiedRoot: probeRoot, runtimeRoot: probeRuntimeRoot, writePaths: [probeRoot], writeFiles: [],
      toolchainRoots, observeDenials: false,
    },
  };
}

async function execute(command, { backend, cwd, environment, sessionRoot, copiedRoot, runtimeRoot, writePaths, writeFiles = [], toolchainRoots = [], probeOnFailure = true, observeDenials = true }) {
  const probe = probeOnFailure && backend.kind === "darwin-sandbox-exec"
    ? await preparePermissiveProbe({ command, backend, cwd, sessionRoot, copiedRoot, runtimeRoot, environment, toolchainRoots }) : null;
  const isolatedBeforeSnapshot = probe === null ? null : await snapshotTree(copiedRoot);
  const isolated = await sandboxInvocation(command, { backend, cwd, environment, sessionRoot, copiedRoot, runtimeRoot, writePaths, writeFiles, toolchainRoots, observeDenials });
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
      // A launcher may catch or mask a denied write and still exit zero. Always
      // authenticate the matching audit stream before evidence can be VERIFIED.
      let sandboxEvents = audit === null ? [] : await audit.stop(true, payload.stderr.toString("utf8"));
      if (sandboxEvents.length === 0 && probe !== null && payload.exit !== 0 && !payload.timedOut && !payload.signaled) {
        const isolatedDelta = treeDelta(isolatedBeforeSnapshot, await snapshotTree(copiedRoot));
        const permissive = await execute(probe.command, { ...probe.options, probeOnFailure: false });
        const delta = treeDelta(probe.beforeSnapshot, await snapshotTree(probe.options.copiedRoot));
        const isolatedPaths = new Set((isolatedDelta?.changes ?? []).map((change) => normalizeGeneratedPath(change.path)));
        const deniedChanges = (delta?.changes ?? []).filter((change) => !isolatedPaths.has(normalizeGeneratedPath(change.path)));
        if (deniedChanges.length !== 0) {
          sandboxEvents = deniedChanges.map((change) => ({
            process: path.basename(command.argv[0]),
            operation: change.disposition === "added" ? "file-write-create"
              : change.disposition === "removed" ? "file-write-unlink" : "file-write-data",
            requestedPath: path.join(copiedRoot, change.path),
          }));
        } else if (permissive.exit === 0 && !permissive.timedOut && !permissive.signaled) {
          sandboxEvents = [{ process: null, operation: "unknown", requestedPath: null }];
        }
      }
      const sandboxOutcomeUncertain = backend.kind === "linux-bwrap" && payload.exit !== 0 && !payload.timedOut && !payload.signaled;
      resolve({ ...payload, sandboxViolation: sandboxEvents.length !== 0, sandboxEvents, sandboxOutcomeUncertain,
        stderrForEvidence: sandboxEvents.length !== 0 ? redactAuthenticatedMarker(payload.stderr, isolated.violationMarker) : payload.stderr });
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
      display, argv, cwd, writePaths, writeFiles, envFingerprint, executableFingerprint, toolchainFingerprint, timeoutMs,
    }) => ({ display, argv, cwd, writePaths, writeFiles, envFingerprint, executableFingerprint, toolchainFingerprint, timeoutMs }))),
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
  else if (previous?.status === "BLOCKED") round = `${previous.round}/3`;
  else if (previous !== null) return null;
  if (task.delegationBlocker?.state === "active" && task.delegationBlocker.operation === operation
    && task.delegationBlocker.pendingRound !== null) round = `${task.delegationBlocker.pendingRound}/3`;
  return { round, priorEvidenceId: records.at(-1)?.provenance?.evidenceId ?? null };
}

async function blockedPrecheckResult({
  specPath, request, task, workspace, projectRoot, liveExecutionBefore, liveWorkspaceBefore, blocker,
  cleanup = "not-required",
}) {
  const liveExecutionAfter = await fingerprintTree(workspace.executionRoot);
  const liveWorkspaceAfter = await fingerprintTree(projectRoot);
  if (liveExecutionBefore !== liveExecutionAfter || liveWorkspaceBefore !== liveWorkspaceAfter) {
    throw new ExecutionContractError("validation pre-check changed protected live state; authenticated infrastructure provenance is unavailable");
  }
  const executionRoot = path.relative(projectRoot, workspace.executionRoot).split(path.sep).join("/");
  const unavailable = digest("stnl-validation-isolated-not-created-v1", []);
  const subjects = [];
  const commands = [];
  const inputs = {
    requirementsAuthority: `sha256:${await computeRequirementsAuthority(specPath)}`,
    planRevision: task.revision,
    head: await readValidationHead(projectRoot),
    sourceFingerprint: digest("stnl-validation-source-precheck-v1", { liveWorkspaceBefore, blocker }),
    manifestFingerprint: digest("stnl-validation-subject-manifest-v1", subjects),
    baselineFingerprint: request.baselineFingerprint,
    changedScopeFingerprint: digest("stnl-validation-changed-scope-v1", []),
    executionFingerprint: "",
  };
  inputs.executionFingerprint = digest("stnl-validation-execution-v1", {
    operation: request.operation, slice: request.slice, round: request.round, cwd: request.cwd,
    executionRoot, subjects, commands, inputs: { ...inputs, executionFingerprint: undefined },
  });
  const provenance = {
    version: 1, evidenceId: "", priorEvidenceId: request.priorEvidenceId, state: "INVALID",
    classification: "INFRASTRUCTURE_BLOCKED", conclusion: "NONE",
    operation: request.operation, slice: request.slice, round: request.round,
    workspace: {
      kind: "pre-check", workspaceId: inputs.executionFingerprint, cwd: request.cwd, executionRoot,
      liveExecutionFingerprintBefore: liveExecutionBefore, liveExecutionFingerprintAfter: liveExecutionAfter,
      liveWorkspaceFingerprintBefore: liveWorkspaceBefore, liveWorkspaceFingerprintAfter: liveWorkspaceAfter,
      liveWorkspaceDelta: null,
      isolatedExecutionFingerprintBefore: unavailable, isolatedExecutionFingerprintAfter: unavailable,
      cleanup, sideEffects: [], boundaryViolations: [],
    },
    inputs, subjects, commands, replay: null, blocker,
  };
  provenance.evidenceId = validationEvidenceIdentity(provenance);
  return Object.freeze({ provenance: Object.freeze(provenance), outputs: Object.freeze([]) });
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
  const projectRoot = await fs.realpath(await trustedProjectRoot(workspace));
  const liveExecutionBefore = await fingerprintTree(workspace.executionRoot);
  const liveWorkspaceBeforeSnapshot = await snapshotTree(projectRoot);
  const liveWorkspaceBefore = liveWorkspaceBeforeSnapshot.fingerprint;
  let sandboxBackend;
  let sourceSymlinks;
  let sourceFingerprint;
  try {
    sandboxBackend = await validationSandboxBackend();
    if (sandboxBackend === null) {
      throw new ValidationInfrastructureError(
        "infrastructure", "sandbox-preflight", "SANDBOX_UNAVAILABLE",
        "validation requires a supported, available OS filesystem sandbox; Windows and other platforms are fail-closed unsupported for v1",
      );
    }
    try {
      await assertSandboxBackendAvailable(sandboxBackend);
    } catch (error) {
      throw new ValidationInfrastructureError(
        "infrastructure", "sandbox-preflight", "SANDBOX_PREFLIGHT_FAILED",
        error instanceof Error ? error.message : "validation OS filesystem sandbox is unavailable",
      );
    }
    sourceSymlinks = await assertCopySourceSafe(projectRoot, projectRoot);
    try {
      sourceFingerprint = await computeValidationSourceFingerprint(projectRoot, workspace.executionRoot);
    } catch (error) {
      throw new ValidationInfrastructureError(
        "source-isolation", "source-admission", "SOURCE_SNAPSHOT_REJECTED",
        error instanceof Error ? error.message : "validation source snapshot was rejected",
      );
    }
  } catch (error) {
    if (!(error instanceof ValidationInfrastructureError)) throw error;
    return blockedPrecheckResult({
      specPath, request, task, workspace, projectRoot, liveExecutionBefore, liveWorkspaceBefore,
      blocker: error.blocker,
    });
  }
  const sessionRoot = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "stnl-validation-session-")));
  const copiedRoot = path.join(sessionRoot, "workspace");
  const runtimeRoot = path.join(sessionRoot, "runtime");
  const toolchainsRoot = path.join(sessionRoot, "toolchains");
  let cleanup = "clean";
  let result;
  try {
    try {
      await copyValidationSource(projectRoot, copiedRoot, sourceSymlinks);
    } catch (error) {
      const blocker = error instanceof ValidationInfrastructureError ? error.blocker : Object.freeze({
        kind: "source-isolation", stage: "source-copy", code: "SOURCE_COPY_FAILED",
        message: error instanceof Error ? error.message : "validation source copy failed", target: null,
      });
      try {
        await fs.rm(sessionRoot, { recursive: true, force: true });
      } catch {
        throw new ExecutionContractError("validation source copy failed and its temporary workspace could not be cleaned");
      }
      return await blockedPrecheckResult({
        specPath, request, task, workspace, projectRoot, liveExecutionBefore, liveWorkspaceBefore,
        blocker, cleanup: "clean",
      });
    }
    await fs.mkdir(path.join(runtimeRoot, "home"), { recursive: true });
    await fs.mkdir(path.join(runtimeRoot, "tmp"), { recursive: true });
    await fs.mkdir(toolchainsRoot, { recursive: true });
    const executionRelative = path.relative(projectRoot, workspace.executionRoot).split(path.sep).join("/");
    const copiedExecutionRoot = path.join(copiedRoot, executionRelative);
    const copiedTaskDirectory = path.join(copiedRoot, executionRelative, "tasks");
    const isolatedExecutionBefore = await fingerprintTree(copiedExecutionRoot);
    const beforeSubjects = await subjectManifest(copiedTaskDirectory, subjects, copiedRoot);
    const manifestFingerprint = digest("stnl-validation-subject-manifest-v1", beforeSubjects);
    const changedScope = digest("stnl-validation-changed-scope-v1", beforeSubjects.map((entry) => entry.path));
    const stableEnvironment = {
      PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C", TZ: "UTC",
      HOME: "$VALIDATION_HOME", TMPDIR: "$VALIDATION_TMPDIR",
    };
    const commandPlans = [];
    const declaredExactWriteFiles = new Set();
    const actualEnvironments = [];
    const toolchainSnapshots = new Map();
    for (const [index, command] of request.commands.entries()) {
      exactObject(command, Object.hasOwn(command, "writeFiles") ? COMMAND_KEYS : LEGACY_COMMAND_KEYS, `validation command ${index + 1}`);
      if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((entry) => typeof entry !== "string" || entry.length === 0)
        || !Number.isSafeInteger(command.timeoutMs) || command.timeoutMs <= 0) throw new ExecutionContractError(`validation command ${index + 1} is malformed`);
      normalizedRelative(command.cwd, `validation command ${index + 1} cwd`);
      if (!Array.isArray(command.writePaths)) throw new ExecutionContractError(`validation command ${index + 1} writePaths must be an array`);
      const writePaths = command.writePaths.map((entry) => normalizedRelative(entry, `validation command ${index + 1} write path`))
        .sort((a, b) => a.localeCompare(b, "en"));
      if (new Set(writePaths).size !== writePaths.length || writePaths.includes(".")) {
        throw new ExecutionContractError(`validation command ${index + 1} writePaths must be unique bounded paths`);
      }
      if (command.writeFiles !== undefined && !Array.isArray(command.writeFiles)) {
        throw new ExecutionContractError(`validation command ${index + 1} writeFiles must be an array`);
      }
      const writeFiles = (command.writeFiles ?? []).map((entry) => normalizedRelative(entry, `validation command ${index + 1} write file`))
        .sort((a, b) => a.localeCompare(b, "en"));
      if (new Set(writeFiles).size !== writeFiles.length || writeFiles.includes(".")
        || writeFiles.some((entry) => writePaths.some((directory) => entry === directory || entry.startsWith(`${directory}/`)))) {
        throw new ExecutionContractError(`validation command ${index + 1} writeFiles must be unique and outside declared writePaths`);
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
      for (const writeFile of writeFiles) {
        if (writeFile === executionRelative || writeFile.startsWith(`${executionRelative}/`)) {
          throw new ExecutionContractError(`validation command ${index + 1} cannot write protected execution state`);
        }
        const absoluteWrite = path.resolve(copiedRoot, writeFile);
        if (!within(absoluteWrite, copiedRoot)
          || subjects.some((subject) => {
            const absoluteSubject = path.resolve(copiedTaskDirectory, subject);
            return absoluteWrite === absoluteSubject;
          })) throw new ExecutionContractError(`validation command ${index + 1} write file overlaps validation inputs`);
        const metadata = await lstatOrNull(absoluteWrite);
        if (metadata?.isSymbolicLink() || (metadata !== null && !metadata.isFile())) {
          throw new ExecutionContractError(`validation command ${index + 1} write file must be a regular isolated file`);
        }
        if (metadata !== null && !declaredExactWriteFiles.has(writeFile)) {
          throw new ExecutionContractError(`validation command ${index + 1} write file must identify a new isolated generated output`);
        }
        await fs.mkdir(path.dirname(absoluteWrite), { recursive: true });
        if (metadata === null) await fs.writeFile(absoluteWrite, "", { flag: "wx" });
        declaredExactWriteFiles.add(writeFile);
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
      const resolution = await resolveExecutable({ argv: actualArgv }, actualEnv, path.join(copiedRoot, command.cwd), copiedRoot);
      let toolchainSnapshot = null;
      if (resolution.toolchain !== null) {
        toolchainSnapshot = toolchainSnapshots.get(resolution.toolchain.fingerprint) ?? null;
        if (toolchainSnapshot === null) {
          toolchainSnapshot = await copyTrustedToolchain(resolution.toolchain, toolchainsRoot);
          toolchainSnapshots.set(resolution.toolchain.fingerprint, toolchainSnapshot);
        }
        actualArgv[0] = toolchainSnapshot.launcher;
      }
      actualEnv.PATH = await sandboxPath(
        actualEnv.PATH, path.join(copiedRoot, command.cwd), copiedRoot, resolution.toolchain, toolchainSnapshot,
      );
      commandPlans.push({
        display: shellDisplay(command.argv.map((value) => path.isAbsolute(value) && within(value, projectRoot)
          ? `$PROJECT/${path.relative(projectRoot, value).split(path.sep).join("/")}` : value)),
        argv: command.argv.map((value) => path.isAbsolute(value) && within(value, projectRoot)
          ? `$PROJECT/${path.relative(projectRoot, value).split(path.sep).join("/")}` : value),
        cwd: command.cwd,
        writePaths, writeFiles,
        envFingerprint: digest("stnl-validation-environment-v1", logicalEnvironment(logicalEnv)),
        executableFingerprint: resolution.executableFingerprint,
        toolchainFingerprint: resolution.toolchain?.fingerprint ?? null,
        timeoutMs: command.timeoutMs,
        actualArgv, toolchain: resolution.toolchain, toolchainRoot: toolchainSnapshot?.root ?? null,
      });
      actualEnvironments.push(actualEnv);
    }
    const materialCommands = commandPlans.map(({
      actualArgv: _actualArgv, toolchain: _toolchain, toolchainRoot: _toolchainRoot, ...command
    }) => command);
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
      if (originRecord.provenance.legacySecurityModel === true) {
        throw new ExecutionContractError("validation replay origin predates authenticated external toolchain provenance");
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
        stderrForEvidence: Buffer.from("replay inputs are not equivalent\n"),
        timedOut: false, signaled: false, sandboxViolation: false, sandboxEvents: [], sandboxOutcomeUncertain: false,
      }
        : await execute({ argv: plan.actualArgv, timeoutMs: plan.timeoutMs }, {
          backend: sandboxBackend,
          cwd: path.join(copiedRoot, request.commands[index].cwd), environment: actualEnvironments[index],
          sessionRoot, copiedRoot, runtimeRoot,
          writePaths: plan.writePaths.map((entry) => path.resolve(copiedRoot, entry)),
          writeFiles: plan.writeFiles.map((entry) => path.resolve(copiedRoot, entry)),
          toolchainRoots: plan.toolchainRoot === null ? [] : [plan.toolchainRoot],
        });
      commandEvidence.push({
        display: plan.display, argv: plan.argv, cwd: plan.cwd, writePaths: plan.writePaths, writeFiles: plan.writeFiles,
        envFingerprint: plan.envFingerprint,
        executableFingerprint: plan.executableFingerprint,
        toolchainFingerprint: plan.toolchainFingerprint, toolchainFingerprintAfter: plan.toolchainFingerprint,
        timeoutMs: plan.timeoutMs, exit: execution.exit,
        stdoutFingerprint: digest("stnl-validation-stdout-v1", execution.stdout),
        stderrFingerprint: digest("stnl-validation-stderr-v1", execution.stderrForEvidence),
      });
      outputs.push({
        display: plan.display, exit: execution.exit, timedOut: execution.timedOut,
        sandboxViolation: execution.sandboxViolation, sandboxOutcomeUncertain: execution.sandboxOutcomeUncertain,
        sandboxEvents: execution.sandboxEvents,
        stdout: execution.stdout.toString("utf8").slice(-4000), stderr: execution.stderr.toString("utf8").slice(-4000),
      });
    }
    const afterSubjects = await subjectManifest(copiedTaskDirectory, subjects, copiedRoot);
    for (let index = 0; index < commandPlans.length; index += 1) {
      const toolchain = commandPlans[index].toolchain;
      commandEvidence[index].toolchainFingerprintAfter = toolchain === null
        ? null : await admittedToolchainFingerprintAfter(
          toolchain, toolchainSnapshots.get(commandPlans[index].toolchainFingerprint),
        );
    }
    const sideEffects = [];
    if (JSON.stringify(beforeSubjects) !== JSON.stringify(afterSubjects)) sideEffects.push("validation-subject-state-changed");
    if (commandEvidence.some((command) => command.toolchainFingerprint !== command.toolchainFingerprintAfter)) {
      sideEffects.push("trusted-external-toolchain-state-changed");
    }
    const isolatedExecutionAfter = await fingerprintTree(copiedExecutionRoot);
    if (isolatedExecutionBefore !== isolatedExecutionAfter) sideEffects.push("isolated-execution-state-changed");
    const liveExecutionAfter = await fingerprintTree(workspace.executionRoot);
    if (liveExecutionBefore !== liveExecutionAfter) sideEffects.push("protected-live-execution-state-changed");
    const liveWorkspaceAfterSnapshot = await snapshotTree(projectRoot);
    const liveWorkspaceAfter = liveWorkspaceAfterSnapshot.fingerprint;
    const liveWorkspaceDelta = liveWorkspaceBefore === liveWorkspaceAfter
      ? null : treeDelta(liveWorkspaceBeforeSnapshot, liveWorkspaceAfterSnapshot);
    if (liveWorkspaceBefore !== liveWorkspaceAfter) sideEffects.push("protected-live-workspace-state-changed");
    const liveWorkspaceChanged = liveWorkspaceBefore !== liveWorkspaceAfter;
    const boundaryViolations = (await Promise.all(outputs.flatMap((output, index) => [
      ...output.sandboxEvents,
      ...(output.sandboxOutcomeUncertain && output.sandboxEvents.length === 0
        ? [{ process: null, operation: "unknown", requestedPath: null }] : []),
    ].map((event) => boundaryDiagnostic(event, {
      commandIndex: index + 1,
      commandExecutable: commandEvidence[index].executableFingerprint,
      copiedRoot, runtimeRoot,
      toolchainRoots: commandPlans[index].toolchainRoot === null ? [] : [commandPlans[index].toolchainRoot],
      projectRoot, executionRoot: copiedExecutionRoot,
      subjects: subjects.map((subject) => path.resolve(copiedTaskDirectory, subject)),
      writePaths: commandPlans[index].writePaths.map((entry) => path.resolve(copiedRoot, entry)),
      writeFiles: commandPlans[index].writeFiles.map((entry) => path.resolve(copiedRoot, entry)),
      liveWorkspaceChanged,
    }))))).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
    for (const output of outputs) delete output.sandboxEvents;
    let classification = sideEffects.length !== 0 ? "VALIDATION_SIDE_EFFECT"
      : boundaryViolations.length !== 0 ? "SANDBOX_BOUNDARY_BLOCKED"
        : replayInvalid ? "INVALID_REPLAY" : "NONE";
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
          liveWorkspaceDelta,
          isolatedExecutionFingerprintBefore: isolatedExecutionBefore, isolatedExecutionFingerprintAfter: isolatedExecutionAfter,
          cleanup: "clean", sideEffects: sideEffects.sort(), boundaryViolations,
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

async function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  const invokedPath = await fs.realpath(path.resolve(process.argv[1])).catch(() => path.resolve(process.argv[1]));
  const canonicalModule = await fs.realpath(modulePath).catch(() => modulePath);
  return invokedPath === canonicalModule;
}

if (await isDirectInvocation()) process.exitCode = await main(process.argv.slice(2));
