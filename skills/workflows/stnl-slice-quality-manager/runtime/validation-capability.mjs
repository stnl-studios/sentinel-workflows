import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VALIDATION_CAPABILITY_IDENTITY = "sha256:56230f59db5e27c2aaf45081b86aa0ed643f0ffc15ff775f9d16cfefa8e55e35";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(domain, value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical([domain, value]))).digest("hex")}`;
}

function normalize(bytes) {
  return Buffer.from(bytes).toString("utf8")
    .replace(/(VALIDATION_CAPABILITY_IDENTITY\s*=\s*"?)sha256:[0-9a-f]{64}/gu, "$1sha256:<capability>")
    .replace(/(VALIDATION_CAPABILITY=)sha256:[0-9a-f]{64}/gu, "$1sha256:<capability>")
    .replace(/(validation-capability-identity:\s*)sha256:[0-9a-f]{64}/gu, "$1sha256:<capability>");
}

function fileIdentity(bytes) {
  return digest("stnl-validation-capability-file-v1", normalize(bytes));
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function inspectOwnValidationCapability(moduleUrl = import.meta.url) {
  const loaded = await fs.realpath(fileURLToPath(moduleUrl));
  const runtimeRoot = path.dirname(loaded);
  const skillRoot = await fs.realpath(path.dirname(runtimeRoot));
  const owner = path.basename(skillRoot);
  const manifestPath = path.join(runtimeRoot, "validation-capability.json");
  const mismatches = [];
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch {
    return Object.freeze({ owner, skillRoot, identity: VALIDATION_CAPABILITY_IDENTITY, packageIdentity: null, coherent: false, mismatches: Object.freeze(["runtime/validation-capability.json"]) });
  }
  if (manifest?.identity !== VALIDATION_CAPABILITY_IDENTITY
    || manifest?.schemaVersion !== 1
    || manifest?.runnerProtocol !== "stnl-validation-runner/v10"
    || manifest?.harnessProtocol !== "stnl-validation-harness/v10"
    || manifest?.package?.owner !== owner
    || manifest?.package?.files === null
    || typeof manifest?.package?.files !== "object"
    || Array.isArray(manifest?.package?.files)) {
    return Object.freeze({ owner, skillRoot, identity: VALIDATION_CAPABILITY_IDENTITY, packageIdentity: null, coherent: false, mismatches: Object.freeze(["runtime/validation-capability.json"]) });
  }
  const files = {};
  for (const relative of Object.keys(manifest.package.files).sort()) {
    if (relative === "" || relative.includes("\\") || path.posix.isAbsolute(relative)
      || path.posix.normalize(relative) !== relative || relative === ".." || relative.startsWith("../")) {
      mismatches.push(relative || "<empty>");
      continue;
    }
    const requested = path.resolve(skillRoot, ...relative.split("/"));
    if (!within(requested, skillRoot)) {
      mismatches.push(relative);
      continue;
    }
    const metadata = await fs.lstat(requested).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      mismatches.push(relative);
      continue;
    }
    files[relative] = fileIdentity(await fs.readFile(requested));
    if (files[relative] !== manifest.package.files[relative]) mismatches.push(relative);
  }
  const packageIdentity = digest("stnl-validation-package-v1", { owner, files });
  if (packageIdentity !== manifest.package.fingerprint) mismatches.push("<package-fingerprint>");
  const skillSource = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8").catch(() => "");
  if (!skillSource.includes(`validation-capability-identity: ${VALIDATION_CAPABILITY_IDENTITY}`)) mismatches.push("SKILL.md#validation-capability-identity");
  return Object.freeze({
    owner, skillRoot, identity: VALIDATION_CAPABILITY_IDENTITY, packageIdentity,
    coherent: mismatches.length === 0, mismatches: Object.freeze([...new Set(mismatches)].sort()),
  });
}
