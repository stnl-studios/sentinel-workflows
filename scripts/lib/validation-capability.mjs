import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export const VALIDATION_RUNNER_PROTOCOL = "stnl-validation-runner/v10";
export const VALIDATION_HARNESS_PROTOCOL = "stnl-validation-harness/v10";
export const VALIDATION_CAPABILITY_SCHEMA_VERSION = 1;
export const VALIDATION_CAPABILITY_MANIFEST = "runtime/validation-capability.json";

export const VALIDATION_CAPABILITY_PACKAGES = Object.freeze({
  "stnl-slice-executor": Object.freeze([
    "SKILL.md",
    "references/execution-record-schema.md",
    "runtime/execution-state.mjs",
    "runtime/resolve-validation-runtime.mjs",
    "runtime/run-validation-session.mjs",
    "runtime/validate-execution-state.mjs",
    "runtime/validation-capability.mjs",
  ]),
  "stnl-slice-quality-manager": Object.freeze([
    "SKILL.md",
    "references/execution-record-schema.md",
    "references/validation-base.md",
    "runtime/execution-state.mjs",
    "runtime/resolve-validation-runtime.mjs",
    "runtime/run-validation-session.mjs",
    "runtime/validate-execution-state.mjs",
    "runtime/validation-capability.mjs",
  ]),
});

const INTEGRATIONS = Object.freeze({
  codex: "integrations/codex/agents/stnl_validation_runner.toml",
  claudeCode: "integrations/claude-code/agents/stnl-validation-runner.md",
});

const IDENTITY_DECLARATIONS = Object.freeze([
  ...Object.values(INTEGRATIONS),
  ...Object.keys(VALIDATION_CAPABILITY_PACKAGES).flatMap((owner) => [
    `skills/workflows/${owner}/SKILL.md`,
    `skills/workflows/${owner}/runtime/validation-capability.mjs`,
  ]),
  "skills/workflows/stnl-execution-closer/runtime/execution-state.mjs",
  "skills/workflows/stnl-execution-planner/runtime/execution-state.mjs",
  "skills/workflows/stnl-plan-reviewer/runtime/execution-state.mjs",
  "skills/workflows/stnl-slice-executor/runtime/execution-state.mjs",
  "skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs",
  "skills/workflows/stnl-spec-roadmap/runtime/execution-state.mjs",
  "skills/workflows/stnl-spec-test-runbook/runtime/execution-state.mjs",
  "skills/workflows/stnl-task-materializer/runtime/execution-state.mjs",
  "skills/workflows/stnl-task-reviewer/runtime/execution-state.mjs",
]);

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

export function normalizeValidationCapabilityBytes(bytes) {
  return Buffer.from(bytes).toString("utf8")
    .replace(/(VALIDATION_CAPABILITY_IDENTITY\s*=\s*"?)sha256:[0-9a-f]{64}/gu, "$1sha256:<capability>")
    .replace(/(VALIDATION_CAPABILITY=)sha256:[0-9a-f]{64}/gu, "$1sha256:<capability>")
    .replace(/(validation-capability-identity:\s*)sha256:[0-9a-f]{64}/gu, "$1sha256:<capability>");
}

export function validationCapabilityFileIdentity(bytes) {
  return digest("stnl-validation-capability-file-v1", normalizeValidationCapabilityBytes(bytes));
}

export function validationPackageIdentity(owner, files) {
  return digest("stnl-validation-package-v1", { owner, files });
}

export function validationCapabilityIdentity(material) {
  const { identity: _identity, ...identityMaterial } = material;
  return digest("stnl-validation-capability-v1", identityMaterial);
}

function validationCapabilityPackageManifest(capability, owner) {
  return {
    identity: capability.identity,
    schemaVersion: capability.schemaVersion,
    runnerProtocol: capability.runnerProtocol,
    harnessProtocol: capability.harnessProtocol,
    package: { owner, ...capability.packages[owner] },
  };
}

export async function buildValidationCapability(repositoryRoot) {
  const root = await fs.realpath(repositoryRoot);
  const integrations = {};
  for (const [name, relative] of Object.entries(INTEGRATIONS)) {
    integrations[name] = validationCapabilityFileIdentity(await fs.readFile(path.join(root, relative)));
  }
  const packages = {};
  for (const [owner, relativeFiles] of Object.entries(VALIDATION_CAPABILITY_PACKAGES)) {
    const skillRoot = path.join(root, "skills", "workflows", owner);
    const files = {};
    for (const relative of relativeFiles) {
      files[relative] = validationCapabilityFileIdentity(await fs.readFile(path.join(skillRoot, relative)));
    }
    packages[owner] = { fingerprint: validationPackageIdentity(owner, files), files };
  }
  const material = {
    schemaVersion: VALIDATION_CAPABILITY_SCHEMA_VERSION,
    runnerProtocol: VALIDATION_RUNNER_PROTOCOL,
    harnessProtocol: VALIDATION_HARNESS_PROTOCOL,
    integrations,
    packages,
  };
  return Object.freeze({ identity: validationCapabilityIdentity(material), ...material });
}

export async function validateValidationCapabilitySource(repositoryRoot) {
  const expected = await buildValidationCapability(repositoryRoot);
  for (const owner of Object.keys(VALIDATION_CAPABILITY_PACKAGES)) {
    const manifestPath = path.join(repositoryRoot, "skills", "workflows", owner, VALIDATION_CAPABILITY_MANIFEST);
    let actual;
    try { actual = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch {
      throw new Error(`validation capability manifest is missing or malformed: ${owner}`);
    }
    if (JSON.stringify(actual) !== JSON.stringify(validationCapabilityPackageManifest(expected, owner))) {
      throw new Error(`validation capability manifest differs from canonical source: ${owner}`);
    }
  }
  return expected;
}

export async function writeValidationCapabilitySource(repositoryRoot) {
  const root = await fs.realpath(repositoryRoot);
  const expected = await buildValidationCapability(root);
  for (const relative of IDENTITY_DECLARATIONS) {
    const target = path.join(root, relative);
    const original = await fs.readFile(target, "utf8");
    const updated = original
      .replace(/(VALIDATION_CAPABILITY_IDENTITY\s*=\s*")sha256:[0-9a-f]{64}/gu, `$1${expected.identity}`)
      .replace(/(VALIDATION_CAPABILITY=)sha256:[0-9a-f]{64}/gu, `$1${expected.identity}`)
      .replace(/(validation-capability-identity:\s*)sha256:[0-9a-f]{64}/gu, `$1${expected.identity}`);
    if (updated === original && !original.includes(expected.identity)) {
      throw new Error(`validation capability identity declaration is missing: ${relative}`);
    }
    await fs.writeFile(target, updated, "utf8");
  }
  const final = await buildValidationCapability(root);
  if (final.identity !== expected.identity) throw new Error("validation capability normalization is not stable");
  for (const owner of Object.keys(VALIDATION_CAPABILITY_PACKAGES)) {
    const manifestPath = path.join(root, "skills", "workflows", owner, VALIDATION_CAPABILITY_MANIFEST);
    await fs.writeFile(manifestPath, `${JSON.stringify(validationCapabilityPackageManifest(final, owner), null, 2)}\n`, "utf8");
  }
  return validateValidationCapabilitySource(root);
}
