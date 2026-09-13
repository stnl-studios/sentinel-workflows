import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  checkDistributableSkill,
  checkDistributableSkillContents,
} from "./check-distributable-skill.mjs";
import { discoverCanonicalSkills } from "./skill-discovery.mjs";
import { registrySkills } from "./skill-registry.mjs";
import {
  DEVELOPMENT_ONLY_SKILL_TOP_LEVEL,
  SENTINEL_DISTRIBUTION_POLICY_VERSION,
  distributablePolicyForSkill,
  referenceDecisionsForSkill,
} from "./skill-distribution-policy.mjs";

const MANIFEST_PATH = ".sentinel/install-manifest.json";
const INSTALL_LOCK_PATH = ".sentinel/install.lock";
const STAGE_PREFIX = ".sentinel-install-stage-";
const BACKUP_PREFIX = ".sentinel-install-backup-";
const MANIFEST_SCHEMA_VERSION = 1;
const JUNK_NAMES = new Set([".DS_Store", "__MACOSX", "Thumbs.db", "desktop.ini"]);

export const SHARED_PRODUCTION_PROMPTS = Object.freeze([
  "execution-close.md",
  "execution-plan-review.md",
  "execution-plan.md",
  "execution-replan.md",
  "execution-tasks-review.md",
  "execution-tasks.md",
  "requirements-refinement-init.md",
  "requirements-refinement-reconcile.md",
  "spec-close.md",
  "spec-init.md",
  "spec-readiness.md",
  "spec-resume.md",
  "spec-roadmap-init.md",
  "spec-roadmap-reconcile.md",
  "spec-test-runbook.md",
]);

export const PLATFORM_LAUNCHERS = Object.freeze({
  codex: Object.freeze([
    "slice-apply-findings-codex.md",
    "slice-execute-codex.md",
    "slice-validate-codex.md",
  ]),
  "claude-code": Object.freeze([
    "slice-apply-findings-claude.md",
    "slice-execute-claude.md",
    "slice-validate-claude.md",
  ]),
});

const PLATFORMS = Object.freeze({
  codex: Object.freeze({
    skillRoot: ".agents/skills",
    agentSourceRoot: "integrations/codex/agents",
    agentDestinationRoot: ".codex/agents",
    agentFiles: Object.freeze(["stnl_spec_context_scout.toml", "stnl_validation_runner.toml"]),
    promptRoot: ".sentinel/prompts",
  }),
  "claude-code": Object.freeze({
    skillRoot: ".claude/skills",
    agentSourceRoot: "integrations/claude-code/agents",
    agentDestinationRoot: ".claude/agents",
    agentFiles: Object.freeze(["stnl-spec-context-scout.md", "stnl-validation-runner.md"]),
    promptRoot: ".claude/commands",
  }),
});

const ALL_PROMPTS = Object.freeze([
  ...SHARED_PRODUCTION_PROMPTS,
  ...PLATFORM_LAUNCHERS.codex,
  ...PLATFORM_LAUNCHERS["claude-code"],
].sort());

function isJunkName(name) {
  return JUNK_NAMES.has(name) || name.startsWith("._");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
    throw new Error("distribution path must be a non-empty string without NUL bytes");
  }
  if (relativePath.includes("\\")) throw new Error(`distribution path must use POSIX separators: ${relativePath}`);
  if (path.posix.isAbsolute(relativePath)) throw new Error(`absolute distribution path is forbidden: ${relativePath}`);
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`distribution path escapes or is not canonical: ${relativePath}`);
  }
  return relativePath;
}

function joinWithin(root, relativePath) {
  assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relation = path.relative(resolvedRoot, candidate);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`path escapes root: ${relativePath}`);
  }
  return candidate;
}

async function metadata(file) {
  return fs.lstat(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
}

async function walkRegularFiles(root, options = {}) {
  const files = [];
  const skip = options.skip ?? (() => false);
  async function visit(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (isJunkName(entry.name)) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (skip(relativePath, entry)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`unexpected symlink in canonical source: ${toPosix(absolutePath)}`);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`unsupported special file in canonical source: ${toPosix(absolutePath)}`);
    }
  }
  await visit(root, "");
  return files;
}

async function requireDirectory(directory, label) {
  const value = await metadata(directory);
  if (!value?.isDirectory() || value.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${directory}`);
}

async function runSourceContract(repositoryRoot, scope, root) {
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, "scripts/check-contracts.mjs"),
    scope,
    "--root",
    root,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`source ${scope} contract failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

async function validateCanonicalSourceContracts(repositoryRoot) {
  await runSourceContract(repositoryRoot, "subagents", path.join(repositoryRoot, "integrations"));
  await runSourceContract(repositoryRoot, "launchers", path.join(repositoryRoot, "templates/prompts"));
}

async function validateCanonicalSkillInventory(repositoryRoot, discovery) {
  for (const [family, descriptors] of [["workflows", discovery.workflows], ["domains", discovery.domains]]) {
    const familyRoot = joinWithin(repositoryRoot, `skills/${family}`);
    await requireDirectory(familyRoot, `canonical ${family} skills`);
    const expected = descriptors.map((descriptor) => descriptor.name).sort();
    const entries = (await fs.readdir(familyRoot, { withFileTypes: true })).filter((entry) => !isJunkName(entry.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`unexpected symlink in canonical skill inventory: skills/${family}/${entry.name}`);
      if (!entry.isDirectory()) throw new Error(`unexpected non-directory in canonical skill inventory: skills/${family}/${entry.name}`);
    }
    const actual = entries.map((entry) => entry.name).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`canonical ${family} skill inventory differs from registry; expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
    }
  }
}

function sourceSkillRoot(repositoryRoot, descriptor) {
  return path.dirname(joinWithin(repositoryRoot, descriptor.relativePath));
}

async function productionSkillFiles(repositoryRoot, descriptor, platform) {
  const skillRoot = sourceSkillRoot(repositoryRoot, descriptor);
  await requireDirectory(skillRoot, `canonical skill ${descriptor.name}`);
  const rootEntries = await fs.readdir(skillRoot, { withFileTypes: true });
  const rootNames = new Set(rootEntries.filter((entry) => !isJunkName(entry.name)).map((entry) => entry.name));
  if (!rootNames.has("SKILL.md")) throw new Error(`canonical skill is missing SKILL.md: ${descriptor.name}`);

  const allowedTopLevel = new Set(["SKILL.md", "runtime", "templates", "references", "agents", ...DEVELOPMENT_ONLY_SKILL_TOP_LEVEL]);
  for (const entry of rootEntries) {
    if (isJunkName(entry.name)) continue;
    if (!allowedTopLevel.has(entry.name)) {
      throw new Error(`unclassified skill top-level content: ${descriptor.name}/${entry.name}`);
    }
    if (entry.isSymbolicLink()) throw new Error(`unexpected symlink in canonical skill: ${descriptor.name}/${entry.name}`);
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new Error(`unsupported special file in canonical skill: ${descriptor.name}/${entry.name}`);
    }
  }

  const result = ["SKILL.md"];
  for (const directory of ["runtime", "templates"]) {
    if (!rootNames.has(directory)) continue;
    const directoryPath = path.join(skillRoot, directory);
    await requireDirectory(directoryPath, `${descriptor.name}/${directory}`);
    const files = await walkRegularFiles(directoryPath, {
      skip: directory === "runtime" ? (relativePath) => relativePath === "test" || relativePath.startsWith("test/") : undefined,
    });
    result.push(...files.map((file) => `${directory}/${file}`));
  }

  const referenceDecision = referenceDecisionsForSkill(descriptor.name);
  if (rootNames.has("references")) {
    const referencesRoot = path.join(skillRoot, "references");
    await requireDirectory(referencesRoot, `${descriptor.name}/references`);
    const actualReferences = await walkRegularFiles(referencesRoot);
    const classified = new Set([...referenceDecision.production, ...referenceDecision.development]);
    for (const reference of actualReferences) {
      if (!classified.has(reference)) throw new Error(`unclassified semantic reference: ${descriptor.name}/references/${reference}`);
    }
    for (const reference of classified) {
      if (!actualReferences.includes(reference)) throw new Error(`classified reference is missing: ${descriptor.name}/references/${reference}`);
    }
    result.push(...referenceDecision.production.map((file) => `references/${file}`));
  } else if (referenceDecision.production.length > 0 || referenceDecision.development.length > 0) {
    throw new Error(`classified references directory is missing: ${descriptor.name}`);
  }

  if (rootNames.has("agents")) {
    const agentsRoot = path.join(skillRoot, "agents");
    await requireDirectory(agentsRoot, `${descriptor.name}/agents`);
    const agentFiles = await walkRegularFiles(agentsRoot);
    if (agentFiles.some((file) => file !== "openai.yaml")) {
      throw new Error(`unclassified skill agent metadata: ${descriptor.name}/agents/${agentFiles.find((file) => file !== "openai.yaml")}`);
    }
    if (!agentFiles.includes("openai.yaml")) throw new Error(`skill agents directory lacks openai.yaml: ${descriptor.name}`);
    if (platform === "codex") result.push("agents/openai.yaml");
  }

  return result.sort();
}

function addPlannedEntry(entries, entry) {
  assertSafeRelativePath(entry.sourceRelativePath);
  assertSafeRelativePath(entry.destinationRelativePath);
  if (entries.some((candidate) => candidate.destinationRelativePath === entry.destinationRelativePath)) {
    throw new Error(`duplicate installation destination: ${entry.destinationRelativePath}`);
  }
  entries.push(Object.freeze(entry));
}

async function readPlannedEntry(repositoryRoot, family, sourceRelativePath, destinationRelativePath) {
  const source = joinWithin(repositoryRoot, sourceRelativePath);
  const value = await metadata(source);
  if (!value?.isFile() || value.isSymbolicLink()) throw new Error(`planned source is not a regular file: ${sourceRelativePath}`);
  return {
    family,
    sourceRelativePath,
    destinationRelativePath,
    bytes: await fs.readFile(source),
  };
}

async function classifyPrompts(repositoryRoot) {
  const promptRoot = path.join(repositoryRoot, "templates/prompts");
  await requireDirectory(promptRoot, "canonical prompts");
  const actual = await walkRegularFiles(promptRoot);
  for (const prompt of actual) {
    if (!ALL_PROMPTS.includes(prompt)) throw new Error(`unclassified production prompt: ${prompt}`);
  }
  for (const prompt of ALL_PROMPTS) {
    if (!actual.includes(prompt)) throw new Error(`classified production prompt is missing: ${prompt}`);
  }
}

async function classifyAgents(repositoryRoot, platform) {
  const config = PLATFORMS[platform];
  const root = joinWithin(repositoryRoot, config.agentSourceRoot);
  await requireDirectory(root, `${platform} agent source`);
  const actual = await walkRegularFiles(root);
  if (actual.length !== config.agentFiles.length || actual.some((file) => !config.agentFiles.includes(file))) {
    throw new Error(`${platform} agent source does not match its canonical registry: ${JSON.stringify(actual)}`);
  }
}

export function fingerprintEntries(platform, entries) {
  if (!PLATFORMS[platform]) throw new Error(`unsupported platform: ${platform}`);
  const hash = createHash("sha256");
  hash.update(`sentinel-distribution\0${SENTINEL_DISTRIBUTION_POLICY_VERSION}\0${platform}\0`, "utf8");
  for (const entry of [...entries].sort((left, right) => left.destinationRelativePath.localeCompare(right.destinationRelativePath, "en"))) {
    assertSafeRelativePath(entry.destinationRelativePath);
    const bytes = Buffer.from(entry.bytes);
    hash.update(entry.destinationRelativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(bytes.length), "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function planSentinelDistribution({ repositoryRoot, platform, validateSourceContracts = true }) {
  if (!PLATFORMS[platform]) throw new Error(`unsupported platform: ${platform}`);
  const root = await fs.realpath(path.resolve(repositoryRoot));
  if (validateSourceContracts) await validateCanonicalSourceContracts(root);
  await classifyPrompts(root);
  await classifyAgents(root, platform);

  const config = PLATFORMS[platform];
  const discovery = discoverCanonicalSkills(root);
  await validateCanonicalSkillInventory(root, discovery);
  const descriptors = [...discovery.workflows, ...discovery.domains];
  const canonicalNames = registrySkills();
  if (descriptors.length !== canonicalNames.length || descriptors.some((item) => !canonicalNames.includes(item.name))) {
    throw new Error("canonical skill discovery does not match the registry");
  }

  const entries = [];
  for (const descriptor of descriptors) {
    for (const skillFile of await productionSkillFiles(root, descriptor, platform)) {
      const sourceRelativePath = `${toPosix(path.relative(root, sourceSkillRoot(root, descriptor)))}/${skillFile}`;
      const destinationRelativePath = `${config.skillRoot}/${descriptor.name}/${skillFile}`;
      addPlannedEntry(entries, await readPlannedEntry(root, "skill", sourceRelativePath, destinationRelativePath));
    }
  }
  for (const agentFile of config.agentFiles) {
    const sourceRelativePath = `${config.agentSourceRoot}/${agentFile}`;
    const destinationRelativePath = `${config.agentDestinationRoot}/${agentFile}`;
    addPlannedEntry(entries, await readPlannedEntry(root, "agent", sourceRelativePath, destinationRelativePath));
  }
  for (const prompt of [...SHARED_PRODUCTION_PROMPTS, ...PLATFORM_LAUNCHERS[platform]].sort()) {
    addPlannedEntry(entries, await readPlannedEntry(
      root,
      "prompt",
      `templates/prompts/${prompt}`,
      `${config.promptRoot}/${prompt}`,
    ));
  }
  entries.sort((left, right) => left.destinationRelativePath.localeCompare(right.destinationRelativePath, "en"));
  const plan = Object.freeze({
    schemaVersion: 1,
    policyVersion: SENTINEL_DISTRIBUTION_POLICY_VERSION,
    platform,
    entries: Object.freeze(entries),
    fingerprint: fingerprintEntries(platform, entries),
  });
  validateDistributionPlan(plan);
  return plan;
}

function planPaths(plan) {
  return new Set(plan.entries.map((entry) => entry.destinationRelativePath));
}

function expectedSkillRoots(platform) {
  return registrySkills().map((name) => `${PLATFORMS[platform].skillRoot}/${name}`);
}

function desiredManagedUnits(plan) {
  const config = PLATFORMS[plan.platform];
  return [
    ...expectedSkillRoots(plan.platform),
    ...config.agentFiles.map((file) => `${config.agentDestinationRoot}/${file}`),
    ...[...SHARED_PRODUCTION_PROMPTS, ...PLATFORM_LAUNCHERS[plan.platform]].map((file) => `${config.promptRoot}/${file}`),
    MANIFEST_PATH,
  ].sort();
}

export function validateDistributionPlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.policyVersion !== SENTINEL_DISTRIBUTION_POLICY_VERSION || !PLATFORMS[plan.platform]) {
    throw new Error("invalid Sentinel distribution plan metadata");
  }
  const paths = planPaths(plan);
  if (paths.size !== plan.entries.length) throw new Error("distribution plan contains duplicate destinations");
  for (const entry of plan.entries) {
    assertSafeRelativePath(entry.sourceRelativePath);
    assertSafeRelativePath(entry.destinationRelativePath);
    if (!Buffer.isBuffer(entry.bytes) && !(entry.bytes instanceof Uint8Array)) throw new Error(`missing planned bytes: ${entry.destinationRelativePath}`);
  }
  const config = PLATFORMS[plan.platform];
  for (const name of registrySkills()) {
    if (!paths.has(`${config.skillRoot}/${name}/SKILL.md`)) throw new Error(`plan omits canonical skill: ${name}`);
  }
  for (const agent of config.agentFiles) {
    if (!paths.has(`${config.agentDestinationRoot}/${agent}`)) throw new Error(`plan omits platform agent: ${agent}`);
  }
  for (const prompt of SHARED_PRODUCTION_PROMPTS) {
    if (!paths.has(`${config.promptRoot}/${prompt}`)) throw new Error(`plan omits shared prompt: ${prompt}`);
  }
  for (const launcher of PLATFORM_LAUNCHERS[plan.platform]) {
    if (!paths.has(`${config.promptRoot}/${launcher}`)) throw new Error(`plan omits platform launcher: ${launcher}`);
  }
  const opposite = plan.platform === "codex" ? "claude-code" : "codex";
  if (plan.entries.some((entry) => entry.destinationRelativePath.startsWith(`${PLATFORMS[opposite].agentDestinationRoot}/`) || PLATFORM_LAUNCHERS[opposite].some((name) => entry.destinationRelativePath.endsWith(`/${name}`)))) {
    throw new Error("distribution plan mixes platform-specific adapters or launchers");
  }
  if (plan.fingerprint !== fingerprintEntries(plan.platform, plan.entries)) throw new Error("distribution plan fingerprint is invalid");
  return true;
}

export function manifestForPlan(plan) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    policyVersion: plan.policyVersion,
    platform: plan.platform,
    fingerprint: plan.fingerprint,
    files: [...plan.entries.map((entry) => entry.destinationRelativePath), MANIFEST_PATH].sort(),
    managedUnits: desiredManagedUnits(plan),
  };
}

function manifestBytes(plan) {
  return Buffer.from(`${JSON.stringify(manifestForPlan(plan), null, 2)}\n`, "utf8");
}

async function writeStage(plan, projectRoot) {
  validateDistributionPlan(plan);
  const stageRoot = await fs.mkdtemp(path.join(projectRoot, STAGE_PREFIX));
  try {
    for (const entry of plan.entries) {
      const destination = joinWithin(stageRoot, entry.destinationRelativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, entry.bytes, { flag: "wx", mode: 0o600 });
    }
    const manifest = joinWithin(stageRoot, MANIFEST_PATH);
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, manifestBytes(plan), { flag: "wx", mode: 0o600 });
    return stageRoot;
  } catch (error) {
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function resourceExists(resource, installedPaths) {
  return installedPaths.has(resource) || [...installedPaths].some((candidate) => candidate.startsWith(`${resource}/`));
}

function textualResourceReferences(source, relativeFile, skillName) {
  const references = new Set();
  for (const match of source.matchAll(/<SKILL_ROOT>\/(runtime|references|templates)\/([A-Za-z0-9._/-]+)/gu)) {
    if (!match[2].includes("<") && !match[2].includes(">")) references.add(`${match[1]}/${match[2].replace(/[.,;:]+$/u, "")}`);
  }
  for (const match of source.matchAll(/\b(runtime|references|templates)\/([A-Za-z0-9._/-]+\.(?:mjs|md|json|toml|yaml|yml))/gu)) {
    references.add(`${match[1]}/${match[2]}`);
  }
  for (const match of source.matchAll(/\]\(([^)\s]+)\)/gu)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^(?:[a-z]+:|#|\/)/iu.test(target)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), target));
    if (resolved === ".." || resolved.startsWith("../")) {
      throw new Error(`textual resource link escapes distributed skill ${skillName}: ${relativeFile} -> ${target}`);
    }
    if (/^(?:runtime|references|templates)(?:\/|$)/u.test(resolved)) references.add(resolved);
  }
  return references;
}

function plannedSkillFiles(plan, skillName) {
  const config = PLATFORMS[plan.platform];
  const skillPrefix = `${config.skillRoot}/${skillName}/`;
  return plan.entries
    .filter((entry) => entry.destinationRelativePath.startsWith(skillPrefix))
    .map((entry) => ({
      relativePath: entry.destinationRelativePath.slice(skillPrefix.length),
      bytes: Buffer.from(entry.bytes),
    }));
}

function validateTextualResourceClosure(plan, skillName, files) {
  const installedPaths = new Set(files.map((file) => file.relativePath));
  const developmentReferences = new Set(referenceDecisionsForSkill(skillName).development.map((item) => `references/${item}`));
  for (const { relativePath: relativeFile, bytes } of files) {
    if (!/\.(?:md|mjs|json|toml|yaml|yml)$/u.test(relativeFile)) continue;
    const source = bytes.toString("utf8");
    for (const reference of textualResourceReferences(source, relativeFile, skillName)) {
      if (developmentReferences.has(reference) || reference === "runtime/test" || reference.startsWith("runtime/test/")) continue;
      if (!resourceExists(reference, installedPaths)) {
        throw new Error(`missing staged textual resource in ${skillName}: ${relativeFile} -> ${reference}`);
      }
    }
  }
}

export function validatePlannedDistribution(plan) {
  validateDistributionPlan(plan);
  for (const name of registrySkills()) {
    const files = plannedSkillFiles(plan, name);
    const findings = checkDistributableSkillContents(name, files, distributablePolicyForSkill(name));
    if (findings.length > 0) throw new Error(`planned skill is not distributable (${name}): ${findings.join("; ")}`);
    validateTextualResourceClosure(plan, name, files);
  }
  return true;
}

async function stagedFiles(stageRoot) {
  return walkRegularFiles(stageRoot);
}

export async function validateStagedInstallation(plan, stageRoot) {
  validatePlannedDistribution(plan);
  const actualFiles = await stagedFiles(stageRoot);
  const expectedFiles = [...plan.entries.map((entry) => entry.destinationRelativePath), MANIFEST_PATH].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`staged installation file set differs from plan; expected=${JSON.stringify(expectedFiles)}, actual=${JSON.stringify(actualFiles)}`);
  }
  for (const entry of plan.entries) {
    const actual = await fs.readFile(joinWithin(stageRoot, entry.destinationRelativePath));
    if (!actual.equals(Buffer.from(entry.bytes))) throw new Error(`staged file bytes differ from plan: ${entry.destinationRelativePath}`);
  }
  const stagedManifest = await fs.readFile(joinWithin(stageRoot, MANIFEST_PATH));
  if (!stagedManifest.equals(manifestBytes(plan))) throw new Error("staged installation manifest differs from plan");

  const config = PLATFORMS[plan.platform];
  for (const name of registrySkills()) {
    const skillRoot = joinWithin(stageRoot, `${config.skillRoot}/${name}`);
    const findings = await checkDistributableSkill(skillRoot, distributablePolicyForSkill(name));
    if (findings.length > 0) throw new Error(`staged skill is not distributable (${name}): ${findings.join("; ")}`);
  }
  return true;
}

async function canonicalProjectRoot(projectRoot) {
  const requested = path.resolve(projectRoot);
  const value = await metadata(requested);
  if (!value?.isDirectory() || value.isSymbolicLink()) throw new Error(`project root must be an existing real directory: ${requested}`);
  return fs.realpath(requested);
}

async function assertDestinationSafe(projectRoot, relativePath) {
  assertSafeRelativePath(relativePath);
  let current = projectRoot;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const value = await metadata(current);
    if (!value) return;
    if (value.isSymbolicLink()) throw new Error(`destination path contains a symlink: ${relativePath}`);
    if (index < segments.length - 1 && !value.isDirectory()) throw new Error(`destination parent is not a directory: ${relativePath}`);
    if (index === segments.length - 1 && !value.isDirectory() && !value.isFile()) throw new Error(`destination is a special file: ${relativePath}`);
  }
}

export async function acquireSentinelInstallLock(projectRoot) {
  const root = await canonicalProjectRoot(projectRoot);
  await assertDestinationSafe(root, INSTALL_LOCK_PATH);
  const lockPath = joinWithin(root, INSTALL_LOCK_PATH);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      const locked = new Error(`Sentinel installation already in progress for project: ${root}`);
      locked.code = "SENTINEL_INSTALL_LOCKED";
      throw locked;
    }
    throw error;
  }
  const diagnostic = {
    schemaVersion: 1,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  try {
    await handle.writeFile(`${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
    throw error;
  }
  await handle.close();
  return Object.freeze({ projectRoot: root, path: lockPath, token });
}

export async function releaseSentinelInstallLock(lock) {
  if (!lock || typeof lock.path !== "string" || typeof lock.token !== "string") {
    throw new Error("invalid Sentinel installation lock identity");
  }
  let value;
  try {
    value = JSON.parse(await fs.readFile(lock.path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return Object.freeze({ released: false, reason: "missing" });
    if (error instanceof SyntaxError) throw new Error("Sentinel installation lock metadata is malformed; refusing to release it", { cause: error });
    throw error;
  }
  if (value.token !== lock.token) {
    throw new Error("Sentinel installation lock ownership changed; refusing to release it");
  }
  await fs.unlink(lock.path);
  return Object.freeze({ released: true });
}

export async function inspectSentinelTransactionArtifacts(projectRoot) {
  const root = await canonicalProjectRoot(projectRoot);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const stages = entries.filter((entry) => entry.name.startsWith(STAGE_PREFIX)).map((entry) => entry.name).sort();
  const backups = entries.filter((entry) => entry.name.startsWith(BACKUP_PREFIX)).map((entry) => entry.name).sort();
  const lockPath = joinWithin(root, INSTALL_LOCK_PATH);
  const lockMetadata = await metadata(lockPath);
  let lock = null;
  if (lockMetadata) {
    let diagnostic = null;
    if (lockMetadata.isFile() && !lockMetadata.isSymbolicLink()) {
      try {
        const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
        diagnostic = {
          schemaVersion: parsed.schemaVersion ?? null,
          pid: Number.isInteger(parsed.pid) ? parsed.pid : null,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
        };
      } catch {
        diagnostic = null;
      }
    }
    lock = {
      path: INSTALL_LOCK_PATH,
      type: lockMetadata.isSymbolicLink() ? "symlink" : lockMetadata.isFile() ? "file" : lockMetadata.isDirectory() ? "directory" : "special",
      diagnostic,
    };
  }
  return Object.freeze({ stages: Object.freeze(stages), backups: Object.freeze(backups), lock: lock ? Object.freeze(lock) : null });
}

function canonicalSkillNameFromText(source) {
  return /^---\r?\n[\s\S]*?^name:\s*([^\r\n]+)\r?$/mu.exec(source)?.[1].trim() ?? null;
}

async function assertClaimableSkillDirectory(projectRoot, relativeRoot, expectedName) {
  const directory = joinWithin(projectRoot, relativeRoot);
  const value = await metadata(directory);
  if (!value) return;
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`canonical Sentinel skill destination is not a real directory: ${relativeRoot}`);
  const skillFile = path.join(directory, "SKILL.md");
  const skillMetadata = await metadata(skillFile);
  if (!skillMetadata?.isFile() || skillMetadata.isSymbolicLink()) throw new Error(`existing skill cannot be attributed to Sentinel: ${relativeRoot}`);
  const name = canonicalSkillNameFromText(await fs.readFile(skillFile, "utf8"));
  if (name !== expectedName) throw new Error(`existing skill identity conflicts with Sentinel: ${relativeRoot}`);
}

function allKnownSkillRoots() {
  return [".agents/skills", ".codex/skills", ".claude/skills"];
}

function knownAgentPaths() {
  return Object.values(PLATFORMS).flatMap((config) => config.agentFiles.map((file) => `${config.agentDestinationRoot}/${file}`));
}

function knownPromptPaths() {
  return [".sentinel/prompts", ".claude/commands"].flatMap((root) => ALL_PROMPTS.map((file) => `${root}/${file}`));
}

function isKnownSentinelPath(relativePath) {
  if (relativePath === MANIFEST_PATH) return true;
  if (knownAgentPaths().includes(relativePath) || knownPromptPaths().includes(relativePath)) return true;
  return allKnownSkillRoots().some((root) => registrySkills().some((name) => relativePath === `${root}/${name}` || relativePath.startsWith(`${root}/${name}/`)));
}

function manifestOwnsPath(manifest, relativePath) {
  return Boolean(manifest?.managedUnits?.some((unit) => relativePath === unit || relativePath.startsWith(`${unit}/`)));
}

function canonicalSourceForKnownFile(relativePath) {
  for (const config of Object.values(PLATFORMS)) {
    for (const file of config.agentFiles) {
      if (relativePath === `${config.agentDestinationRoot}/${file}`) return `${config.agentSourceRoot}/${file}`;
    }
  }
  for (const promptRoot of [".sentinel/prompts", ".claude/commands"]) {
    const prefix = `${promptRoot}/`;
    if (!relativePath.startsWith(prefix)) continue;
    const prompt = relativePath.slice(prefix.length);
    if (ALL_PROMPTS.includes(prompt)) return `templates/prompts/${prompt}`;
  }
  return null;
}

async function assertClaimableKnownFile(repositoryRoot, projectRoot, relativePath, installedManifest) {
  if (manifestOwnsPath(installedManifest, relativePath)) return;
  const sourceRelativePath = canonicalSourceForKnownFile(relativePath);
  if (!sourceRelativePath) throw new Error(`path is not a known Sentinel file: ${relativePath}`);
  const destination = joinWithin(projectRoot, relativePath);
  const destinationMetadata = await metadata(destination);
  if (!destinationMetadata?.isFile() || destinationMetadata.isSymbolicLink()) {
    throw new Error(`existing Sentinel file destination is not a regular file: ${relativePath}`);
  }
  const source = joinWithin(repositoryRoot, sourceRelativePath);
  const sourceMetadata = await metadata(source);
  if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`canonical Sentinel file source is not a regular file: ${sourceRelativePath}`);
  }
  if (!(await fs.readFile(destination)).equals(await fs.readFile(source))) {
    throw new Error(`existing file cannot be attributed to Sentinel: ${relativePath}`);
  }
}

export function validateInstalledManifest(value, options = {}) {
  const requireCurrentPolicy = options.requireCurrentPolicy ?? true;
  if (!value || value.schemaVersion !== MANIFEST_SCHEMA_VERSION || typeof value.policyVersion !== "string" || value.policyVersion.length === 0 || !PLATFORMS[value.platform] || !/^sha256:[0-9a-f]{64}$/u.test(value.fingerprint)) {
    throw new Error("existing Sentinel installation manifest has invalid metadata");
  }
  if (requireCurrentPolicy && value.policyVersion !== SENTINEL_DISTRIBUTION_POLICY_VERSION) {
    throw new Error("existing Sentinel installation manifest has an unsupported policy version");
  }
  for (const field of ["files", "managedUnits"]) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== "string" || !isKnownSentinelPath(item))) {
      throw new Error(`existing Sentinel installation manifest has invalid ${field}`);
    }
    for (const item of value[field]) assertSafeRelativePath(item);
    if (new Set(value[field]).size !== value[field].length) throw new Error(`existing Sentinel installation manifest has duplicate ${field}`);
  }
  return value;
}

export async function readInstalledManifest(projectRoot, options = {}) {
  const manifest = joinWithin(projectRoot, MANIFEST_PATH);
  const value = await metadata(manifest);
  if (!value) return null;
  if (!value.isFile() || value.isSymbolicLink()) throw new Error("existing Sentinel installation manifest is not a regular file");
  try {
    return validateInstalledManifest(JSON.parse(await fs.readFile(manifest, "utf8")), options);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("existing Sentinel installation manifest is not valid JSON", { cause: error });
    throw error;
  }
}

async function existingKnownCleanupUnits(repositoryRoot, projectRoot, plan, installedManifest) {
  const desired = new Set(desiredManagedUnits(plan));
  const cleanup = new Set(installedManifest?.managedUnits?.filter((item) => !desired.has(item)) ?? []);
  const selectedSkillRoot = PLATFORMS[plan.platform].skillRoot;
  for (const root of allKnownSkillRoots()) {
    if (root === selectedSkillRoot) continue;
    for (const name of registrySkills()) {
      const relativeRoot = `${root}/${name}`;
      if (await metadata(joinWithin(projectRoot, relativeRoot))) {
        await assertClaimableSkillDirectory(projectRoot, relativeRoot, name);
        cleanup.add(relativeRoot);
      }
    }
  }
  for (const agentPath of knownAgentPaths()) {
    if (!desired.has(agentPath) && await metadata(joinWithin(projectRoot, agentPath))) {
      await assertClaimableKnownFile(repositoryRoot, projectRoot, agentPath, installedManifest);
      cleanup.add(agentPath);
    }
  }
  for (const promptPath of knownPromptPaths()) {
    if (!desired.has(promptPath) && await metadata(joinWithin(projectRoot, promptPath))) {
      await assertClaimableKnownFile(repositoryRoot, projectRoot, promptPath, installedManifest);
      cleanup.add(promptPath);
    }
  }
  return [...cleanup].sort();
}

async function liveMatchesPlan(projectRoot, plan, cleanupUnits) {
  if (cleanupUnits.length > 0) return false;
  const manifest = await readInstalledManifest(projectRoot);
  if (!manifest || manifest.fingerprint !== plan.fingerprint || manifest.platform !== plan.platform) return false;
  for (const entry of plan.entries) {
    const file = joinWithin(projectRoot, entry.destinationRelativePath);
    const value = await metadata(file);
    if (!value?.isFile() || value.isSymbolicLink()) return false;
    if (!(await fs.readFile(file)).equals(Buffer.from(entry.bytes))) return false;
  }
  const config = PLATFORMS[plan.platform];
  for (const name of registrySkills()) {
    const root = joinWithin(projectRoot, `${config.skillRoot}/${name}`);
    const files = await walkRegularFiles(root);
    const prefix = `${config.skillRoot}/${name}/`;
    const expected = plan.entries.filter((entry) => entry.destinationRelativePath.startsWith(prefix)).map((entry) => entry.destinationRelativePath.slice(prefix.length)).sort();
    if (JSON.stringify(files) !== JSON.stringify(expected)) return false;
  }
  return true;
}

function collapseNestedUnits(units) {
  const result = [];
  for (const unit of [...new Set(units)].sort((left, right) => left.length - right.length || left.localeCompare(right, "en"))) {
    if (!result.some((parent) => unit.startsWith(`${parent}/`))) result.push(unit);
  }
  return result.sort();
}

async function moveIfPresent(sourceRoot, destinationRoot, relativePath) {
  const source = joinWithin(sourceRoot, relativePath);
  if (!await metadata(source)) return false;
  const destination = joinWithin(destinationRoot, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  return true;
}

async function removeExplicitUnits(root, units) {
  for (const unit of [...units].reverse()) await fs.rm(joinWithin(root, unit), { recursive: true, force: true });
}

async function publishStage(repositoryRoot, projectRoot, stageRoot, plan, cleanupUnits, installedManifest, options = {}) {
  const desiredUnits = desiredManagedUnits(plan);
  const existingDesired = [];
  for (const unit of desiredUnits) {
    await assertDestinationSafe(projectRoot, unit);
    if (await metadata(joinWithin(projectRoot, unit))) existingDesired.push(unit);
  }
  for (const name of registrySkills()) {
    await assertClaimableSkillDirectory(projectRoot, `${PLATFORMS[plan.platform].skillRoot}/${name}`, name);
  }
  for (const unit of existingDesired) {
    if (canonicalSourceForKnownFile(unit)) {
      await assertClaimableKnownFile(repositoryRoot, projectRoot, unit, installedManifest);
    }
  }
  for (const unit of cleanupUnits) await assertDestinationSafe(projectRoot, unit);
  const backupRoot = await fs.mkdtemp(path.join(projectRoot, BACKUP_PREFIX));
  const backedUp = [];
  const installed = [];
  const removeUnits = collapseNestedUnits([...existingDesired, ...cleanupUnits]);
  try {
    for (const unit of removeUnits) {
      if (await moveIfPresent(projectRoot, backupRoot, unit)) backedUp.push(unit);
    }
    for (const unit of desiredUnits) {
      if (options.beforePublishUnit) await options.beforePublishUnit(unit);
      if (!await moveIfPresent(stageRoot, projectRoot, unit)) throw new Error(`staged publication unit is missing: ${unit}`);
      installed.push(unit);
    }
    for (const entry of plan.entries) {
      const actual = await fs.readFile(joinWithin(projectRoot, entry.destinationRelativePath));
      if (!actual.equals(Buffer.from(entry.bytes))) throw new Error(`published readback differs: ${entry.destinationRelativePath}`);
    }
    const publishedManifest = await fs.readFile(joinWithin(projectRoot, MANIFEST_PATH));
    if (!publishedManifest.equals(manifestBytes(plan))) throw new Error("published manifest readback differs");
    validateInstalledManifest(JSON.parse(publishedManifest.toString("utf8")));
  } catch (error) {
    await removeExplicitUnits(projectRoot, installed).catch(() => {});
    for (const unit of [...backedUp].reverse()) {
      await moveIfPresent(backupRoot, projectRoot, unit).catch(() => {});
    }
    await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  try {
    const removeBackupRoot = options.removeBackupRoot ?? ((directory) => fs.rm(directory, { recursive: true, force: true }));
    await removeBackupRoot(backupRoot);
    return Object.freeze({ warnings: Object.freeze([]) });
  } catch (error) {
    return Object.freeze({
      warnings: Object.freeze([Object.freeze({
        code: "POST_COMMIT_BACKUP_CLEANUP_FAILED",
        message: `installation committed, but the transaction backup could not be removed: ${path.basename(backupRoot)} (${error.message})`,
        path: path.basename(backupRoot),
      })]),
    });
  }
}

export async function installSentinel({
  repositoryRoot,
  projectRoot,
  platform,
  stageMutator,
  beforePublishUnit,
  removeBackupRoot,
  afterLockAcquired,
  validateSourceContracts = true,
}) {
  const root = await canonicalProjectRoot(projectRoot);
  const sourceRoot = await fs.realpath(path.resolve(repositoryRoot));
  const plan = await planSentinelDistribution({ repositoryRoot: sourceRoot, platform, validateSourceContracts });
  const lock = await acquireSentinelInstallLock(root);
  let stageRoot = null;
  let outcome = null;
  let operationError = null;
  const finalizationErrors = [];
  const finalizationWarnings = [];
  try {
    if (afterLockAcquired) await afterLockAcquired(lock);
    stageRoot = await writeStage(plan, root);
    if (stageMutator) await stageMutator(stageRoot, plan);
    await validateStagedInstallation(plan, stageRoot);
    const installedManifest = await readInstalledManifest(root);
    const cleanupUnits = await existingKnownCleanupUnits(sourceRoot, root, plan, installedManifest);
    if (await liveMatchesPlan(root, plan, cleanupUnits)) {
      outcome = { changed: false, commitStatus: "already-current", platform, fingerprint: plan.fingerprint, files: manifestForPlan(plan).files, warnings: [] };
    } else {
      const publication = await publishStage(sourceRoot, root, stageRoot, plan, cleanupUnits, installedManifest, {
        beforePublishUnit,
        removeBackupRoot,
      });
      outcome = { changed: true, commitStatus: "committed", platform, fingerprint: plan.fingerprint, files: manifestForPlan(plan).files, warnings: [...publication.warnings] };
    }
  } catch (error) {
    operationError = error;
  }
  if (stageRoot) {
    try {
      await fs.rm(stageRoot, { recursive: true, force: true });
    } catch (error) {
      finalizationErrors.push(error);
      finalizationWarnings.push({
        code: "STAGE_CLEANUP_FAILED",
        message: `installation stage could not be removed: ${path.basename(stageRoot)} (${error.message})`,
        path: path.basename(stageRoot),
      });
    }
  }
  try {
    const released = await releaseSentinelInstallLock(lock);
    if (!released.released) {
      finalizationErrors.push(new Error(`installation lock was already missing: ${INSTALL_LOCK_PATH}`));
      finalizationWarnings.push({
        code: "INSTALL_LOCK_RELEASE_FAILED",
        message: `installation completed, but its lock was already missing: ${INSTALL_LOCK_PATH}`,
        path: INSTALL_LOCK_PATH,
      });
    }
  } catch (error) {
    finalizationErrors.push(error);
    finalizationWarnings.push({
      code: "INSTALL_LOCK_RELEASE_FAILED",
      message: `installation completed, but its lock could not be released: ${INSTALL_LOCK_PATH} (${error.message})`,
      path: INSTALL_LOCK_PATH,
    });
  }
  if (operationError) {
    if (finalizationErrors.length > 0) {
      throw new AggregateError([operationError, ...finalizationErrors], `${operationError.message}; transaction finalization also failed`, { cause: operationError });
    }
    throw operationError;
  }
  let residuals = Object.freeze({ stages: Object.freeze([]), backups: Object.freeze([]), lock: null });
  try {
    residuals = await inspectSentinelTransactionArtifacts(root);
  } catch (error) {
    finalizationWarnings.push({
      code: "TRANSACTION_RESIDUAL_INSPECTION_FAILED",
      message: `installation completed, but transaction residuals could not be inspected (${error.message})`,
    });
  }
  for (const backup of residuals.backups) {
    if (!outcome.warnings.some((warning) => warning.path === backup)) {
      finalizationWarnings.push({
        code: "TRANSACTION_BACKUP_RESIDUAL",
        message: `residual transaction backup remains: ${backup}`,
        path: backup,
      });
    }
  }
  for (const stage of residuals.stages) {
    finalizationWarnings.push({
      code: "TRANSACTION_STAGE_RESIDUAL",
      message: `residual installation stage remains: ${stage}`,
      path: stage,
    });
  }
  return Object.freeze({
    ...outcome,
    warnings: Object.freeze([...outcome.warnings, ...finalizationWarnings].map((warning) => Object.freeze(warning))),
    residuals,
  });
}

export function summarizePlan(plan) {
  validateDistributionPlan(plan);
  return {
    schemaVersion: plan.schemaVersion,
    policyVersion: plan.policyVersion,
    platform: plan.platform,
    fingerprint: plan.fingerprint,
    files: plan.entries.map((entry) => ({
      family: entry.family,
      source: entry.sourceRelativePath,
      destination: entry.destinationRelativePath,
      bytes: Buffer.from(entry.bytes).length,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    })),
  };
}

export const SENTINEL_INSTALLATION_CONTRACT = Object.freeze({
  manifestPath: MANIFEST_PATH,
  lockPath: INSTALL_LOCK_PATH,
  stagePrefix: STAGE_PREFIX,
  backupPrefix: BACKUP_PREFIX,
  knownSkillRoots: Object.freeze(allKnownSkillRoots()),
  platforms: PLATFORMS,
});
