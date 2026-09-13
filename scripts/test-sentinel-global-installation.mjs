import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLATFORM_LAUNCHERS,
  SENTINEL_INSTALLATION_CONTRACT,
  SHARED_PRODUCTION_PROMPTS,
  SUPPORTED_PRODUCTION_PLATFORMS,
  acquireSentinelInstallLock,
  installSentinel,
  planSentinelDistribution,
  readInstalledManifest,
  releaseSentinelInstallLock,
} from "./lib/sentinel-distribution.mjs";
import { registrySkills } from "./lib/skill-registry.mjs";
import { parseInstallArguments, runInstallCli } from "./install-sentinel.mjs";
import { parseDoctorArguments, runDoctorCli } from "./doctor-sentinel.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const INSTALL_CLI = path.join(ROOT, "scripts/install-sentinel.mjs");
const DOCTOR_CLI = path.join(ROOT, "scripts/doctor-sentinel.mjs");

async function temporaryDirectory(t, prefix = "stnl-global-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

async function nestedFakeHome(t) {
  const outer = await temporaryDirectory(t, "stnl fake home ");
  const home = path.join(outer, "nested user", "home with spaces");
  await fs.mkdir(home, { recursive: true });
  return fs.realpath(home);
}

async function sourceFixture(t) {
  const fixture = await temporaryDirectory(t, "stnl-global-source-");
  for (const directory of ["skills", "integrations", "templates"]) {
    await fs.cp(path.join(ROOT, directory), path.join(fixture, directory), { recursive: true });
  }
  return fixture;
}

async function exists(file) {
  return Boolean(await fs.lstat(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)));
}

async function snapshotTree(root) {
  const rows = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.name.startsWith(SENTINEL_INSTALLATION_CONTRACT.stagePrefix) || entry.name.startsWith(SENTINEL_INSTALLATION_CONTRACT.backupPrefix)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) rows.push([relative, (await fs.readFile(absolute)).toString("base64")]);
      else if (entry.isSymbolicLink()) rows.push([relative, `symlink:${await fs.readlink(absolute)}`]);
      else rows.push([relative, "special"]);
    }
  }
  await visit(root, "");
  return rows;
}

function homeResolver(home) {
  return () => home;
}

function managedPath(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

function nativeSkillPath(platform, name, suffix = "") {
  const nativeRoot = platform === "codex" ? ".agents" : ".claude";
  return [nativeRoot, "skills", name, suffix].filter(Boolean).join("/");
}

function legacyFingerprintForPlan(platform, plan) {
  const hash = createHash("sha256");
  hash.update(`sentinel-distribution\0${plan.policyVersion}\0${platform}\0`, "utf8");
  for (const entry of [...plan.entries].sort((left, right) => left.destinationRelativePath.localeCompare(right.destinationRelativePath, "en"))) {
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

async function installUser(home, platform = "all", options = {}) {
  return installSentinel({
    repositoryRoot: ROOT,
    scope: "user",
    platform,
    homeDirectory: homeResolver(home),
    validateSourceContracts: false,
    ...options,
  });
}

async function installProject(project, platform = "all", options = {}) {
  return installSentinel({
    repositoryRoot: ROOT,
    scope: "project",
    projectRoot: project,
    platform,
    validateSourceContracts: false,
    ...options,
  });
}

test("no-argument installer and doctor use fake user home with all production platforms", async (t) => {
  const home = await nestedFakeHome(t);
  assert.notEqual(home, path.resolve(os.homedir()));
  assert.deepEqual(parseInstallArguments([]), { dryRun: false, scope: "user", platform: "all", projectRoot: undefined });
  assert.deepEqual(SUPPORTED_PRODUCTION_PLATFORMS, ["codex", "claude-code"]);

  const fakeHomeEnvironment = { ...process.env, HOME: home, USERPROFILE: home };
  const installProcess = spawnSync(process.execPath, [INSTALL_CLI], { encoding: "utf8", env: fakeHomeEnvironment });
  assert.equal(installProcess.status, 0, installProcess.stderr);
  const installed = JSON.parse(installProcess.stdout);
  assert.equal(installed.status, "installed");
  assert.equal(installed.scope, "user");
  assert.deepEqual(installed.platforms, ["codex", "claude-code"]);
  assert.equal(await exists(managedPath(home, ".sentinel/install.lock")), false);

  for (const skill of registrySkills()) {
    assert.equal(await exists(path.join(home, ".agents", "skills", skill, "SKILL.md")), true, `Codex ${skill}`);
    assert.equal(await exists(path.join(home, ".claude", "skills", skill, "SKILL.md")), true, `Claude ${skill}`);
  }
  for (const relative of [
    ".codex/agents/stnl_spec_context_scout.toml",
    ".codex/agents/stnl_validation_runner.toml",
    ".claude/agents/stnl-spec-context-scout.md",
    ".claude/agents/stnl-validation-runner.md",
    ".sentinel/prompts/execution-plan.md",
    ".claude/commands/execution-plan.md",
  ]) assert.equal(await exists(managedPath(home, relative)), true, relative);
  for (const prompt of [...SHARED_PRODUCTION_PROMPTS, ...PLATFORM_LAUNCHERS.codex]) {
    assert.equal(await exists(path.join(home, ".sentinel", "prompts", prompt)), true, `Codex prompt ${prompt}`);
  }
  for (const prompt of [...SHARED_PRODUCTION_PROMPTS, ...PLATFORM_LAUNCHERS["claude-code"]]) {
    assert.equal(await exists(path.join(home, ".claude", "commands", prompt)), true, `Claude command ${prompt}`);
  }

  const manifest = JSON.parse(await fs.readFile(managedPath(home, SENTINEL_INSTALLATION_CONTRACT.manifestPath), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.scope, "user");
  assert.deepEqual(manifest.platforms, ["codex", "claude-code"]);
  assert.equal("platform" in manifest, false);

  assert.deepEqual(parseDoctorArguments([]), { sourceOnly: false, scope: "user", platform: "all", projectRoot: undefined });
  const doctorProcess = spawnSync(process.execPath, [DOCTOR_CLI], { encoding: "utf8", env: fakeHomeEnvironment });
  assert.equal(doctorProcess.status, 0, doctorProcess.stderr);
  const report = JSON.parse(doctorProcess.stdout);
  assert.equal(report.status, "OK");
  assert.equal(report.mode, "installed-user");
  assert.deepEqual(report.installation.manifest.platforms, ["codex", "claude-code"]);
  assert.equal(report.installation.installationRoot, home);
});

test("default dry-run plans user/all without creating metadata", async (t) => {
  const home = await nestedFakeHome(t);
  const result = await runInstallCli(["--dry-run"], { repositoryRoot: ROOT, homeDirectory: homeResolver(home) });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.scope, "user");
  assert.deepEqual(result.platforms, ["codex", "claude-code"]);
  assert.equal(result.installationRootType, "user-home");
  assert.ok(result.files.some((entry) => entry.destination.startsWith(".agents/skills/")));
  assert.ok(result.files.some((entry) => entry.destination.startsWith(".claude/skills/")));
  assert.equal(await exists(path.join(home, ".sentinel")), false);
});

test("CLI scope combinations fail closed and preserve project shorthand", () => {
  const project = path.resolve("consumer project");
  assert.deepEqual(parseInstallArguments(["--platform", "codex", "--project", project]), {
    dryRun: false,
    scope: "project",
    platform: "codex",
    projectRoot: project,
  });
  assert.throws(() => parseInstallArguments(["--scope", "user", "--project", project]), /cannot be used with user scope/u);
  assert.throws(() => parseInstallArguments(["--scope", "project"]), /requires --project/u);
  assert.throws(() => parseInstallArguments(["--scope", "system"]), /unsupported installation scope/u);
  assert.throws(() => parseInstallArguments(["--platform", "automatic"]), /unsupported platform/u);
});

test("combined stage contains both platforms before any publication", async (t) => {
  const home = await nestedFakeHome(t);
  let inspected = false;
  await installUser(home, "all", {
    stageMutator: async (stageRoot) => {
      assert.equal(await exists(managedPath(stageRoot, nativeSkillPath("codex", "stnl-testing", "SKILL.md"))), true);
      assert.equal(await exists(managedPath(stageRoot, nativeSkillPath("claude-code", "stnl-testing", "SKILL.md"))), true);
      assert.equal(await exists(managedPath(stageRoot, ".codex/agents/stnl_validation_runner.toml")), true);
      assert.equal(await exists(managedPath(stageRoot, ".claude/agents/stnl-validation-runner.md")), true);
      inspected = true;
    },
    beforePublishUnit: async () => assert.equal(inspected, true),
  });
  assert.equal(inspected, true);
});

for (const [name, tamperedPath, oppositeLivePath] of [
  ["Claude", nativeSkillPath("claude-code", "stnl-testing", "SKILL.md"), ".codex/agents/stnl_validation_runner.toml"],
  ["Codex", nativeSkillPath("codex", "stnl-testing", "SKILL.md"), ".claude/agents/stnl-validation-runner.md"],
]) {
  test(`${name}-side stage validation failure prevents all-platform publication`, async (t) => {
    const home = await nestedFakeHome(t);
    let publicationStarted = false;
    await assert.rejects(installUser(home, "all", {
      stageMutator: (stageRoot) => fs.appendFile(managedPath(stageRoot, tamperedPath), "tampered\n"),
      beforePublishUnit: async () => { publicationStarted = true; },
    }), /staged file bytes differ/u);
    assert.equal(publicationStarted, false);
    assert.equal(await exists(managedPath(home, oppositeLivePath)), false);
    assert.equal(await exists(managedPath(home, SENTINEL_INSTALLATION_CONTRACT.manifestPath)), false);
  });
}

test("partial publication failure restores the previous complete all-platform installation", async (t) => {
  const source = await sourceFixture(t);
  const home = await nestedFakeHome(t);
  const install = (options = {}) => installSentinel({
    repositoryRoot: source,
    scope: "user",
    platform: "all",
    homeDirectory: homeResolver(home),
    validateSourceContracts: false,
    ...options,
  });
  await install();
  const before = await snapshotTree(home);
  await fs.appendFile(path.join(source, "integrations/codex/agents/stnl_validation_runner.toml"), "\n# changed codex\n");
  await fs.appendFile(path.join(source, "integrations/claude-code/agents/stnl-validation-runner.md"), "\nchanged claude\n");
  let moved = 0;
  await assert.rejects(install({
    beforePublishUnit: async () => {
      moved += 1;
      if (moved === 7) throw new Error("injected combined publication failure");
    },
  }), /injected combined publication failure/u);
  assert.ok(moved > 1);
  assert.deepEqual(await snapshotTree(home), before);
});

test("combined fingerprint is stable, root-independent, scope-aware, and changes with either platform", async (t) => {
  const firstSource = await sourceFixture(t);
  const secondSource = await sourceFixture(t);
  const baseline = await planSentinelDistribution({ repositoryRoot: firstSource, scope: "user", platform: "all", validateSourceContracts: false });
  const equivalent = await planSentinelDistribution({ repositoryRoot: secondSource, scope: "user", platform: "all", validateSourceContracts: false });
  assert.equal(baseline.fingerprint, equivalent.fingerprint);

  const projectPlan = await planSentinelDistribution({ repositoryRoot: firstSource, scope: "project", platform: "all", validateSourceContracts: false });
  assert.notEqual(projectPlan.fingerprint, baseline.fingerprint);
  await fs.appendFile(path.join(secondSource, "integrations/codex/agents/stnl_validation_runner.toml"), "\n# codex material change\n");
  const codexChanged = await planSentinelDistribution({ repositoryRoot: secondSource, scope: "user", platform: "all", validateSourceContracts: false });
  assert.notEqual(codexChanged.fingerprint, baseline.fingerprint);

  await fs.cp(path.join(ROOT, "integrations/codex/agents/stnl_validation_runner.toml"), path.join(secondSource, "integrations/codex/agents/stnl_validation_runner.toml"), { force: true });
  await fs.appendFile(path.join(secondSource, "integrations/claude-code/agents/stnl-validation-runner.md"), "\nclaude material change\n");
  const claudeChanged = await planSentinelDistribution({ repositoryRoot: secondSource, scope: "user", platform: "all", validateSourceContracts: false });
  assert.notEqual(claudeChanged.fingerprint, baseline.fingerprint);
});

test("user and project installations remain isolated in both directions", async (t) => {
  const home = await nestedFakeHome(t);
  const project = await temporaryDirectory(t, "stnl-project-scope-");
  await installUser(home, "all");
  await installProject(project, "all");
  const projectDoctor = await runDoctorCli(["--scope", "project", "--project", project], { repositoryRoot: ROOT });
  assert.equal(projectDoctor.status, "OK");
  assert.deepEqual(projectDoctor.installation.manifest.platforms, ["codex", "claude-code"]);
  const projectBefore = await snapshotTree(project);
  await installUser(home, "codex");
  assert.deepEqual(await snapshotTree(project), projectBefore);
  const homeBefore = await snapshotTree(home);
  await installProject(project, "claude-code");
  assert.deepEqual(await snapshotTree(home), homeBefore);
});

test("user and project locks are independent while identical roots conflict", async (t) => {
  const home = await nestedFakeHome(t);
  const project = await temporaryDirectory(t, "stnl-project-lock-");
  const userLock = await acquireSentinelInstallLock(home);
  try {
    const projectResult = await installProject(project, "codex");
    assert.equal(projectResult.commitStatus, "committed");
  } finally {
    await releaseSentinelInstallLock(userLock);
  }
  const projectLock = await acquireSentinelInstallLock(project);
  try {
    const userResult = await installUser(home, "claude-code");
    assert.equal(userResult.commitStatus, "committed");
  } finally {
    await releaseSentinelInstallLock(projectLock);
  }
});

test("two concurrent user installs share one lock and conflict", async (t) => {
  const home = await nestedFakeHome(t);
  let ready;
  let release;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const first = installUser(home, "all", {
    afterLockAcquired: async () => {
      ready();
      await releasePromise;
    },
  });
  await readyPromise;
  assert.equal(await exists(managedPath(home, SENTINEL_INSTALLATION_CONTRACT.lockPath)), true);
  assert.equal(await exists(path.join(home, ".codex", "install.lock")), false);
  assert.equal(await exists(path.join(home, ".claude", "install.lock")), false);
  await assert.rejects(installUser(home, "codex"), /installation already in progress/u);
  release();
  assert.equal((await first).commitStatus, "committed");
});

for (const selected of ["codex", "claude-code"]) {
  test(`subset transitions all -> ${selected} -> all clean only owned artifacts`, async (t) => {
    const home = await nestedFakeHome(t);
    await fs.mkdir(path.join(home, ".agents/skills/third-party"), { recursive: true });
    await fs.writeFile(path.join(home, ".agents/skills/third-party/SKILL.md"), "third party Codex\n");
    await fs.mkdir(path.join(home, ".claude/skills/third-party"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude/skills/third-party/SKILL.md"), "third party Claude\n");
    await fs.mkdir(path.join(home, ".claude/commands"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude/commands/user-command.md"), "user command\n");
    await installUser(home, "all");
    await installUser(home, selected);
    const manifest = await readInstalledManifest(home);
    assert.deepEqual(manifest.platforms, [selected]);
    const omittedPath = selected === "codex"
      ? ".claude/agents/stnl-validation-runner.md"
      : ".codex/agents/stnl_validation_runner.toml";
    const selectedPath = selected === "codex"
      ? ".codex/agents/stnl_validation_runner.toml"
      : ".claude/agents/stnl-validation-runner.md";
    assert.equal(await exists(managedPath(home, omittedPath)), false);
    assert.equal(await exists(managedPath(home, selectedPath)), true);
    assert.equal(await fs.readFile(path.join(home, ".agents/skills/third-party/SKILL.md"), "utf8"), "third party Codex\n");
    assert.equal(await fs.readFile(path.join(home, ".claude/skills/third-party/SKILL.md"), "utf8"), "third party Claude\n");
    assert.equal(await fs.readFile(path.join(home, ".claude/commands/user-command.md"), "utf8"), "user command\n");
    await installUser(home, "all");
    assert.deepEqual((await readInstalledManifest(home)).platforms, ["codex", "claude-code"]);
    assert.equal(await exists(managedPath(home, omittedPath)), true);
  });
}

for (const platform of ["codex", "claude-code"]) {
  test(`legacy schema-v1 ${platform} project manifest is diagnosed and upgraded without losing ownership`, async (t) => {
    const project = await temporaryDirectory(t, `stnl-legacy-${platform}-`);
    await installProject(project, platform);
    const plan = await planSentinelDistribution({ repositoryRoot: ROOT, scope: "project", platform, validateSourceContracts: false });
    const manifestPath = managedPath(project, SENTINEL_INSTALLATION_CONTRACT.manifestPath);
    const current = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const legacy = {
      schemaVersion: 1,
      policyVersion: current.policyVersion,
      platform,
      fingerprint: legacyFingerprintForPlan(platform, plan),
      files: current.files,
      managedUnits: current.managedUnits,
    };
    assert.notEqual(legacy.fingerprint, current.fingerprint);
    await fs.writeFile(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const before = await runDoctorCli(["--project", project], { repositoryRoot: ROOT });
    assert.equal(before.status, "DRIFT");
    assert.equal(before.installation.manifest.schemaVersion, 1);
    assert.equal(before.installation.manifest.upgradeRequired, true);
    assert.ok(before.installation.issues.some((issue) => issue.code === "MANIFEST_SCHEMA_UPGRADE_REQUIRED"));
    assert.ok(before.installation.issues.some((issue) => issue.code === "FINGERPRINT_DRIFT"));

    const upgraded = await installProject(project, platform);
    assert.equal(upgraded.changed, true);
    const afterManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(afterManifest.schemaVersion, 2);
    assert.equal(afterManifest.scope, "project");
    assert.deepEqual(afterManifest.platforms, [platform]);
    assert.equal("platform" in afterManifest, false);
    const after = await runDoctorCli(["--scope", "project", "--project", project, "--platform", platform], { repositoryRoot: ROOT });
    assert.equal(after.status, "OK");
  });
}

test("missing, unusable, and symlink user homes fail before managed mutation", async (t) => {
  const parent = await temporaryDirectory(t, "stnl-home-safety-");
  const missing = path.join(parent, "missing home");
  await assert.rejects(installSentinel({ repositoryRoot: ROOT, homeDirectory: homeResolver(missing), validateSourceContracts: false }), /existing real directory/u);
  assert.deepEqual(await fs.readdir(parent), []);

  const unusable = path.join(parent, "home-file");
  await fs.writeFile(unusable, "not a directory\n");
  await assert.rejects(installSentinel({ repositoryRoot: ROOT, homeDirectory: homeResolver(unusable), validateSourceContracts: false }), /existing real directory/u);
  assert.equal(await fs.readFile(unusable, "utf8"), "not a directory\n");

  const real = path.join(parent, "real-home");
  const linked = path.join(parent, "linked-home");
  await fs.mkdir(real);
  await fs.writeFile(path.join(real, "preserved.txt"), "preserved\n");
  await fs.symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(installSentinel({ repositoryRoot: ROOT, homeDirectory: homeResolver(linked), validateSourceContracts: false }), /existing real directory/u);
  assert.deepEqual(await fs.readdir(real), ["preserved.txt"]);
});

test("default doctor rejects a healthy user subset when all platforms are expected", async (t) => {
  const home = await nestedFakeHome(t);
  await installUser(home, "codex");
  const defaultReport = await runDoctorCli([], { repositoryRoot: ROOT, homeDirectory: homeResolver(home) });
  assert.equal(defaultReport.status, "DRIFT");
  assert.ok(defaultReport.installation.issues.some((issue) => issue.code === "PLATFORM_SELECTION_DRIFT"));
  assert.ok(defaultReport.installation.issues.some((issue) => issue.code === "MISSING_MANAGED_FILE"));
  const subsetReport = await runDoctorCli(["--scope", "user", "--platform", "codex"], { repositoryRoot: ROOT, homeDirectory: homeResolver(home) });
  assert.equal(subsetReport.status, "OK");
});
