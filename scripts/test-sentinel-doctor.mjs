import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SENTINEL_INSTALLATION_CONTRACT,
  acquireSentinelInstallLock,
  installSentinel,
  releaseSentinelInstallLock,
} from "./lib/sentinel-distribution.mjs";
import {
  doctorSentinelInstallation,
  doctorSentinelSource,
} from "./lib/sentinel-doctor.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scripts/doctor-sentinel.mjs");

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

async function sourceFixture(t) {
  const fixture = await temporaryDirectory(t, "stnl-doctor-source-");
  for (const directory of ["skills", "integrations", "templates"]) {
    await fs.cp(path.join(ROOT, directory), path.join(fixture, directory), { recursive: true });
  }
  await fs.mkdir(path.join(fixture, "scripts/lib"), { recursive: true });
  await fs.copyFile(path.join(ROOT, "scripts/check-contracts.mjs"), path.join(fixture, "scripts/check-contracts.mjs"));
  await fs.copyFile(path.join(ROOT, "scripts/lib/skill-registry.mjs"), path.join(fixture, "scripts/lib/skill-registry.mjs"));
  return fixture;
}

async function install(project, platform) {
  return installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform, validateSourceContracts: false });
}

async function snapshotTree(root) {
  const rows = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        rows.push([relative, "directory"]);
        await visit(absolute, relative);
      } else if (entry.isFile()) rows.push([relative, (await fs.readFile(absolute)).toString("base64")]);
      else if (entry.isSymbolicLink()) rows.push([relative, `symlink:${await fs.readlink(absolute)}`]);
      else rows.push([relative, "special"]);
    }
  }
  await visit(root, "");
  return rows;
}

function issueCodes(report) {
  return new Set(report.installation.issues.map((issue) => issue.code));
}

function warningCodes(report) {
  return new Set(report.installation.warnings.map((warning) => warning.code));
}

test("source-only doctor validates both platforms without a consumer project or writes", async (t) => {
  const source = await sourceFixture(t);
  const before = await snapshotTree(source);
  const report = await doctorSentinelSource({ repositoryRoot: source });
  assert.equal(report.status, "OK");
  assert.deepEqual(report.source.platforms.map((item) => item.platform), ["codex", "claude-code"]);
  assert.ok(report.source.platforms.every((item) => /^sha256:[0-9a-f]{64}$/u.test(item.fingerprint)));
  assert.deepEqual(await snapshotTree(source), before);
  const cli = spawnSync(process.execPath, [CLI, "--source-only"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, "OK");
});

test("source doctor fails closed for missing canonical material", async (t) => {
  const source = await sourceFixture(t);
  await fs.unlink(path.join(source, "templates/prompts/execution-plan.md"));
  await assert.rejects(doctorSentinelSource({ repositoryRoot: source }), /launcher registry mismatch|classified production prompt is missing/u);
});

test("source doctor fails closed for unknown prompt and reference content", async (t) => {
  const promptSource = await sourceFixture(t);
  await fs.writeFile(path.join(promptSource, "templates/prompts/unknown.md"), "unknown\n");
  await assert.rejects(doctorSentinelSource({ repositoryRoot: promptSource }), /launcher registry mismatch|unclassified production prompt/u);

  const referenceSource = await sourceFixture(t);
  await fs.writeFile(path.join(referenceSource, "skills/workflows/stnl-execution-planner/references/unknown.md"), "unknown\n");
  await assert.rejects(doctorSentinelSource({ repositoryRoot: referenceSource }), /unclassified semantic reference/u);
});

test("doctor reports healthy Codex and Claude installations and ignores third-party content", async (t) => {
  for (const platform of ["codex", "claude-code"]) {
    await t.test(platform, async (t) => {
      const project = await temporaryDirectory(t, `stnl-doctor-${platform}-`);
      await install(project, platform);
      const thirdPartyRoot = platform === "codex" ? ".agents/skills/third-party" : ".claude/skills/third-party";
      await fs.mkdir(path.join(project, thirdPartyRoot), { recursive: true });
      await fs.writeFile(path.join(project, thirdPartyRoot, "SKILL.md"), "third party\n");
      const before = await snapshotTree(project);
      const report = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: project });
      assert.equal(report.status, "OK");
      assert.equal(report.installation.liveStatus, "OK");
      assert.equal(report.installation.manifest.platform, platform);
      assert.equal(report.installation.fingerprintMatches, true);
      assert.deepEqual(await snapshotTree(project), before);
    });
  }
});

test("doctor detects managed byte drift and a missing managed file", async (t) => {
  const byteProject = await temporaryDirectory(t, "stnl-doctor-byte-");
  await install(byteProject, "codex");
  await fs.appendFile(path.join(byteProject, ".agents", "skills", "stnl-testing", "SKILL.md"), "drift\n");
  const byteReport = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: byteProject });
  assert.equal(byteReport.status, "DRIFT");
  assert.ok(issueCodes(byteReport).has("MANAGED_BYTES_DRIFT"));

  const missingProject = await temporaryDirectory(t, "stnl-doctor-missing-");
  await install(missingProject, "claude-code");
  await fs.unlink(path.join(missingProject, ".claude/agents/stnl-validation-runner.md"));
  const missingReport = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: missingProject });
  assert.equal(missingReport.status, "DRIFT");
  assert.ok(issueCodes(missingReport).has("MISSING_MANAGED_FILE"));
});

test("doctor detects stale files inside a Sentinel-owned skill root", async (t) => {
  const project = await temporaryDirectory(t, "stnl-doctor-stale-");
  await install(project, "codex");
  const stale = path.join(project, ".agents", "skills", "stnl-testing", "stale.md");
  await fs.writeFile(stale, "stale\n");
  const report = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: project });
  assert.equal(report.status, "DRIFT");
  assert.ok(issueCodes(report).has("STALE_MANAGED_SKILL_FILE"));
});

test("doctor blocks on a malformed installation manifest", async (t) => {
  const project = await temporaryDirectory(t, "stnl-doctor-manifest-");
  await install(project, "codex");
  await fs.writeFile(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.manifestPath.split("/")), "{broken\n");
  const report = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: project });
  assert.equal(report.status, "BLOCKED");
  assert.ok(report.installation.blockers.some((blocker) => blocker.code === "MALFORMED_MANIFEST"));
});

test("doctor detects known opposite-platform artifacts", async (t) => {
  const project = await temporaryDirectory(t, "stnl-doctor-opposite-");
  await install(project, "codex");
  const opposite = path.join(project, ".claude/agents/stnl-validation-runner.md");
  await fs.mkdir(path.dirname(opposite), { recursive: true });
  await fs.copyFile(path.join(ROOT, "integrations/claude-code/agents/stnl-validation-runner.md"), opposite);
  const report = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: project });
  assert.equal(report.status, "DRIFT");
  assert.ok(issueCodes(report).has("OPPOSITE_PLATFORM_ARTIFACT"));
});

test("doctor reports residual stages and backups without corrupting healthy status", async (t) => {
  const project = await temporaryDirectory(t, "stnl-doctor-residual-");
  await install(project, "claude-code");
  await fs.mkdir(path.join(project, `${SENTINEL_INSTALLATION_CONTRACT.stagePrefix}leftover`));
  await fs.mkdir(path.join(project, `${SENTINEL_INSTALLATION_CONTRACT.backupPrefix}leftover`));
  const report = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: project });
  assert.equal(report.status, "OK");
  assert.equal(report.installation.liveStatus, "OK");
  assert.ok(warningCodes(report).has("RESIDUAL_STAGE"));
  assert.ok(warningCodes(report).has("RESIDUAL_BACKUP"));
});

test("doctor reports an active installer lock and never removes it", async (t) => {
  const project = await temporaryDirectory(t, "stnl-doctor-lock-");
  await install(project, "codex");
  const lock = await acquireSentinelInstallLock(project);
  try {
    const before = await snapshotTree(project);
    const report = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: project });
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.installation.liveStatus, "OK");
    assert.ok(report.installation.blockers.some((blocker) => blocker.code === "ACTIVE_INSTALLER_LOCK"));
    assert.deepEqual(await snapshotTree(project), before);
  } finally {
    await releaseSentinelInstallLock(lock);
  }
});

test("doctor sees a committed install as healthy after backup cleanup failure", async (t) => {
  const project = await temporaryDirectory(t, "stnl-doctor-commit-");
  await install(project, "codex");
  const result = await installSentinel({
    repositoryRoot: ROOT,
    projectRoot: project,
    platform: "claude-code",
    validateSourceContracts: false,
    removeBackupRoot: async () => { throw new Error("injected EPERM"); },
  });
  assert.equal(result.commitStatus, "committed");
  const report = await doctorSentinelInstallation({ repositoryRoot: ROOT, projectRoot: project });
  assert.equal(report.status, "OK");
  assert.equal(report.installation.liveStatus, "OK");
  assert.equal(report.installation.fingerprintMatches, true);
  assert.ok(warningCodes(report).has("RESIDUAL_BACKUP"));
});
