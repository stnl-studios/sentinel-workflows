import * as fs from "node:fs/promises";
import path from "node:path";

import { registrySkills } from "./skill-registry.mjs";
import {
  PLATFORM_LAUNCHERS,
  SENTINEL_INSTALLATION_CONTRACT,
  SHARED_PRODUCTION_PROMPTS,
  SUPPORTED_PRODUCTION_PLATFORMS,
  inspectSentinelTransactionArtifacts,
  manifestForPlan,
  planSentinelDistribution,
  readInstalledManifest,
  resolveInstallationScope,
  resolvePlatformSelection,
  resolveSentinelInstallationRoot,
  validatePlannedDistribution,
} from "./sentinel-distribution.mjs";
import { validateValidationCapabilitySource } from "./validation-capability.mjs";

const JUNK_NAMES = new Set([".DS_Store", "__MACOSX", "Thumbs.db", "desktop.ini"]);

function isJunkName(name) {
  return JUNK_NAMES.has(name) || name.startsWith("._");
}

function installationPath(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

async function canonicalDirectory(root, label) {
  const requested = path.resolve(root);
  const value = await fs.lstat(requested).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!value?.isDirectory() || value.isSymbolicLink()) throw new Error(`${label} must be an existing real directory: ${requested}`);
  return fs.realpath(requested);
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addFinding(collection, code, message, relativePath) {
  collection.push(Object.freeze({ code, message, ...(relativePath ? { path: relativePath } : {}) }));
}

function sortFindings(findings) {
  return findings.sort((left, right) => `${left.code}\0${left.path ?? ""}\0${left.message}`.localeCompare(`${right.code}\0${right.path ?? ""}\0${right.message}`, "en"));
}

async function inspectManagedPath(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const value = await fs.lstat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!value) return { kind: "missing", path: current };
    if (value.isSymbolicLink()) return { kind: "symlink", path: current };
    if (current !== installationPath(root, relativePath) && !value.isDirectory()) return { kind: "invalid-parent", path: current };
    if (current === installationPath(root, relativePath)) {
      return { kind: value.isFile() ? "file" : value.isDirectory() ? "directory" : "special", path: current };
    }
  }
  return { kind: "missing", path: installationPath(root, relativePath) };
}

async function regularFilesForDoctor(root, findings, relativeRoot) {
  const files = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (isJunkName(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) addFinding(findings, "UNSAFE_MANAGED_PATH", `managed skill contains a symlink: ${relativeRoot}/${relative}`, `${relativeRoot}/${relative}`);
      else if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else addFinding(findings, "UNSAFE_MANAGED_PATH", `managed skill contains a special file: ${relativeRoot}/${relative}`, `${relativeRoot}/${relative}`);
    }
  }
  await visit(root, "");
  return files.sort();
}

function sourceSummary(plan) {
  return Object.freeze({
    status: "OK",
    platform: plan.platforms[0],
    policyVersion: plan.policyVersion,
    fingerprint: plan.fingerprint,
    fileCount: plan.entries.length,
  });
}

function defaultInstallationSummary(plan) {
  return Object.freeze({
    status: "OK",
    scope: plan.scope,
    platforms: plan.platforms,
    policyVersion: plan.policyVersion,
    fingerprint: plan.fingerprint,
    fileCount: plan.entries.length,
  });
}

async function buildSourceHealth(repositoryRoot, scope = "user") {
  const root = await canonicalDirectory(repositoryRoot, "repository root");
  const validationCapability = await validateValidationCapabilitySource(root);
  const plans = new Map();
  const platforms = [];
  for (const platform of SUPPORTED_PRODUCTION_PLATFORMS) {
    const plan = await planSentinelDistribution({ repositoryRoot: root, platform, scope });
    validatePlannedDistribution(plan);
    plans.set(platform, plan);
    platforms.push(sourceSummary(plan));
  }
  const defaultPlan = await planSentinelDistribution({ repositoryRoot: root, platform: "all", scope });
  validatePlannedDistribution(defaultPlan);
  plans.set("all", defaultPlan);
  return {
    plans,
    report: Object.freeze({
      status: "OK",
      repository: root,
      platforms: Object.freeze(platforms),
      defaultInstallation: defaultInstallationSummary(defaultPlan),
      validationCapability: Object.freeze({
        status: "OK",
        identity: validationCapability.identity,
        runnerProtocol: validationCapability.runnerProtocol,
        harnessProtocol: validationCapability.harnessProtocol,
      }),
    }),
  };
}

export async function doctorSentinelSource({ repositoryRoot }) {
  const { report } = await buildSourceHealth(repositoryRoot);
  return Object.freeze({ status: "OK", mode: "source-only", source: report });
}

function knownNonselectedPaths(plan) {
  const expected = new Set(plan.entries.map((entry) => entry.destinationRelativePath));
  const paths = [];
  const selectedSkillRoots = new Set(plan.platforms.map((platform) => SENTINEL_INSTALLATION_CONTRACT.platforms[platform].skillRoot));
  for (const root of SENTINEL_INSTALLATION_CONTRACT.knownSkillRoots) {
    if (selectedSkillRoots.has(root)) continue;
    for (const name of registrySkills()) paths.push(`${root}/${name}`);
  }
  for (const config of Object.values(SENTINEL_INSTALLATION_CONTRACT.platforms)) {
    for (const file of config.agentFiles) {
      const relativePath = `${config.agentDestinationRoot}/${file}`;
      if (!expected.has(relativePath)) paths.push(relativePath);
    }
  }
  const allPrompts = [...SHARED_PRODUCTION_PROMPTS, ...SUPPORTED_PRODUCTION_PLATFORMS.flatMap((platform) => PLATFORM_LAUNCHERS[platform])];
  for (const root of new Set(Object.values(SENTINEL_INSTALLATION_CONTRACT.platforms).map((config) => config.promptRoot))) {
    for (const prompt of allPrompts) {
      const relativePath = `${root}/${prompt}`;
      if (!expected.has(relativePath)) paths.push(relativePath);
    }
  }
  return [...new Set(paths)].sort();
}

async function inspectInstalledHealth(root, plan) {
  const artifacts = await inspectSentinelTransactionArtifacts(root);
  const issues = [];
  const blockers = [];
  const warnings = [];
  if (artifacts.lock) addFinding(blockers, "ACTIVE_INSTALLER_LOCK", `installer lock is present: ${artifacts.lock.path}`, artifacts.lock.path);
  for (const stage of artifacts.stages) addFinding(warnings, "RESIDUAL_STAGE", `residual installation stage is present: ${stage}`, stage);
  for (const backup of artifacts.backups) addFinding(warnings, "RESIDUAL_BACKUP", `residual transaction backup is present: ${backup}`, backup);

  let manifest;
  try {
    manifest = await readInstalledManifest(root, { requireCurrentPolicy: false });
  } catch (error) {
    addFinding(blockers, "MALFORMED_MANIFEST", error.message, SENTINEL_INSTALLATION_CONTRACT.manifestPath);
  }
  if (!manifest) {
    if (blockers.length === 0) addFinding(blockers, "MISSING_MANIFEST", "Sentinel installation manifest is missing", SENTINEL_INSTALLATION_CONTRACT.manifestPath);
    return Object.freeze({
      status: "BLOCKED",
      liveStatus: "UNKNOWN",
      scope: plan.scope,
      installationRoot: root,
      manifest: null,
      expected: null,
      transactionArtifacts: artifacts,
      blockers: Object.freeze(sortFindings(blockers)),
      issues: Object.freeze([]),
      warnings: Object.freeze(sortFindings(warnings)),
    });
  }

  const expectedManifest = manifestForPlan(plan);
  if (manifest.schemaVersion !== expectedManifest.schemaVersion) addFinding(issues, "MANIFEST_SCHEMA_UPGRADE_REQUIRED", `installed manifest schema ${manifest.schemaVersion} must be upgraded to ${expectedManifest.schemaVersion}`, SENTINEL_INSTALLATION_CONTRACT.manifestPath);
  if (manifest.scope !== plan.scope) addFinding(issues, "INSTALLATION_SCOPE_DRIFT", `installed scope ${manifest.scope} differs from expected ${plan.scope}`, SENTINEL_INSTALLATION_CONTRACT.manifestPath);
  if (!sameArray(manifest.platforms, plan.platforms)) addFinding(issues, "PLATFORM_SELECTION_DRIFT", `installed platforms ${JSON.stringify(manifest.platforms)} differ from expected ${JSON.stringify(plan.platforms)}`, SENTINEL_INSTALLATION_CONTRACT.manifestPath);
  if (manifest.policyVersion !== plan.policyVersion) addFinding(issues, "POLICY_VERSION_DRIFT", `installed policy ${manifest.policyVersion} differs from expected ${plan.policyVersion}`);
  if (manifest.fingerprint !== plan.fingerprint) addFinding(issues, "FINGERPRINT_DRIFT", `installed fingerprint ${manifest.fingerprint} differs from expected ${plan.fingerprint}`);
  if (!sameArray(manifest.files, expectedManifest.files)) addFinding(issues, "MANIFEST_FILES_DRIFT", "manifest files do not match the current installation plan", SENTINEL_INSTALLATION_CONTRACT.manifestPath);
  if (!sameArray(manifest.managedUnits, expectedManifest.managedUnits)) addFinding(issues, "MANIFEST_OWNERSHIP_DRIFT", "manifest managedUnits do not match the current ownership plan", SENTINEL_INSTALLATION_CONTRACT.manifestPath);

  for (const entry of plan.entries) {
    const inspected = await inspectManagedPath(root, entry.destinationRelativePath);
    if (inspected.kind === "missing") addFinding(issues, "MISSING_MANAGED_FILE", `managed file is missing: ${entry.destinationRelativePath}`, entry.destinationRelativePath);
    else if (inspected.kind !== "file") addFinding(issues, "UNSAFE_MANAGED_PATH", `managed file is not a regular file (${inspected.kind}): ${entry.destinationRelativePath}`, entry.destinationRelativePath);
    else if (!(await fs.readFile(inspected.path)).equals(Buffer.from(entry.bytes))) addFinding(issues, "MANAGED_BYTES_DRIFT", `managed file bytes differ from source: ${entry.destinationRelativePath}`, entry.destinationRelativePath);
  }

  const manifestInspection = await inspectManagedPath(root, SENTINEL_INSTALLATION_CONTRACT.manifestPath);
  if (manifestInspection.kind === "file") {
    const expectedBytes = Buffer.from(`${JSON.stringify(expectedManifest, null, 2)}\n`, "utf8");
    if (!(await fs.readFile(manifestInspection.path)).equals(expectedBytes)) addFinding(issues, "MANIFEST_BYTES_DRIFT", "installation manifest bytes differ from the current canonical manifest", SENTINEL_INSTALLATION_CONTRACT.manifestPath);
  }

  for (const platform of plan.platforms) {
    const config = SENTINEL_INSTALLATION_CONTRACT.platforms[platform];
    for (const name of registrySkills()) {
      const relativeRoot = `${config.skillRoot}/${name}`;
      const inspected = await inspectManagedPath(root, relativeRoot);
      if (inspected.kind !== "directory") continue;
      const actual = await regularFilesForDoctor(inspected.path, issues, relativeRoot);
      const prefix = `${relativeRoot}/`;
      const expected = plan.entries.filter((entry) => entry.destinationRelativePath.startsWith(prefix)).map((entry) => entry.destinationRelativePath.slice(prefix.length)).sort();
      for (const stale of actual.filter((file) => !expected.includes(file))) addFinding(issues, "STALE_MANAGED_SKILL_FILE", `unexpected file remains in managed skill root: ${relativeRoot}/${stale}`, `${relativeRoot}/${stale}`);
    }
  }

  for (const relativePath of knownNonselectedPaths(plan)) {
    const inspected = await inspectManagedPath(root, relativePath);
    if (inspected.kind !== "missing") addFinding(issues, "OPPOSITE_PLATFORM_ARTIFACT", `known nonselected Sentinel artifact remains: ${relativePath}`, relativePath);
  }

  const liveStatus = issues.length > 0 ? "DRIFT" : "OK";
  const status = blockers.length > 0 ? "BLOCKED" : liveStatus;
  const validationPaths = plan.entries
    .filter((entry) => entry.destinationRelativePath.includes("stnl-validation-runner")
      || entry.destinationRelativePath.includes("stnl_validation_runner")
      || entry.destinationRelativePath.includes("stnl-slice-executor/")
      || entry.destinationRelativePath.includes("stnl-slice-quality-manager/"))
    .map((entry) => entry.destinationRelativePath);
  const validationDriftPaths = issues
    .filter((issue) => issue.path !== undefined && validationPaths.some((relative) => (
      issue.path === relative || issue.path.startsWith(`${relative}/`) || relative.startsWith(`${issue.path}/`)
    )))
    .map((issue) => issue.path)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  return Object.freeze({
    status,
    liveStatus,
    scope: plan.scope,
    installationRoot: root,
    manifest: Object.freeze({
      status: "VALID",
      schemaVersion: manifest.schemaVersion,
      scope: manifest.scope,
      platforms: manifest.platforms,
      upgradeRequired: manifest.legacy,
      policyVersion: manifest.policyVersion,
      fingerprint: manifest.fingerprint,
    }),
    expected: Object.freeze({
      schemaVersion: expectedManifest.schemaVersion,
      scope: plan.scope,
      platforms: plan.platforms,
      policyVersion: plan.policyVersion,
      fingerprint: plan.fingerprint,
    }),
    fingerprintMatches: manifest.fingerprint === plan.fingerprint,
    validationCapability: Object.freeze({
      status: validationDriftPaths.length === 0 ? "OK" : "DRIFT",
      affectedPaths: Object.freeze(validationDriftPaths),
    }),
    transactionArtifacts: artifacts,
    blockers: Object.freeze(sortFindings(blockers)),
    issues: Object.freeze(sortFindings(issues)),
    warnings: Object.freeze(sortFindings(warnings)),
  });
}

export async function doctorSentinelInstallation({ repositoryRoot, scope, projectRoot, platform, homeDirectory } = {}) {
  const inferredLegacyProjectCall = scope === undefined && projectRoot !== undefined && platform === undefined;
  const normalizedScope = resolveInstallationScope(scope ?? (projectRoot === undefined ? "user" : "project"));
  const installationRoot = await resolveSentinelInstallationRoot({ scope: normalizedScope, projectRoot, homeDirectory, requireWritable: false });
  let selectedPlatform = platform ?? "all";
  if (inferredLegacyProjectCall) {
    const installed = await readInstalledManifest(installationRoot, { requireCurrentPolicy: false }).catch(() => null);
    if (installed?.platforms.length === 1) [selectedPlatform] = installed.platforms;
  }
  resolvePlatformSelection(selectedPlatform);
  const source = await buildSourceHealth(repositoryRoot, normalizedScope);
  const plan = await planSentinelDistribution({
    repositoryRoot,
    scope: normalizedScope,
    platform: selectedPlatform,
    validateSourceContracts: false,
  });
  const installation = await inspectInstalledHealth(installationRoot, plan);
  return Object.freeze({
    status: installation.status,
    mode: normalizedScope === "user" ? "installed-user" : "installed-project",
    source: source.report,
    installation,
  });
}
