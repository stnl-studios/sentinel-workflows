import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderDoctorReport } from "./doctor-sentinel.mjs";
import { renderInstallResult } from "./install-sentinel.mjs";
import {
  SENTINEL_INSTALLATION_CONTRACT,
  acquireSentinelInstallLock,
  installSentinel,
  releaseSentinelInstallLock,
} from "./lib/sentinel-distribution.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const INSTALL_CLI = path.join(ROOT, "scripts/install-sentinel.mjs");
const DOCTOR_CLI = path.join(ROOT, "scripts/doctor-sentinel.mjs");

async function temporaryProject(t, prefix = "stnl-cli-output-") {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  return fs.realpath(project);
}

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...options });
}

function projectArguments(project) {
  return ["--scope", "project", "--project", project];
}

test("changed and unchanged installer output is concise human text", async (t) => {
  const home = await temporaryProject(t, "stnl-cli-home-");
  const environment = { ...process.env, HOME: home, USERPROFILE: home };
  const first = run(INSTALL_CLI, [], { env: environment });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^✓ Sentinel installed$/mu);
  assert.match(first.stdout, /^Scope: user$/mu);
  assert.match(first.stdout, /^Platforms: codex, claude-code$/mu);
  assert.match(first.stdout, /^Files: \d+$/mu);
  assert.ok(first.stdout.trim().split("\n").length <= 6);
  assert.doesNotMatch(first.stdout, /sha256:|fingerprint|installationRoot|commitStatus|\.agents\/skills\//u);

  const second = run(INSTALL_CLI, [], { env: environment });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^✓ Sentinel already up to date$/mu);
  assert.match(second.stdout, /^Scope: user$/mu);
  assert.match(second.stdout, /^Platforms: codex, claude-code$/mu);
  assert.doesNotMatch(second.stdout, /^Files:/mu);
  assert.ok(second.stdout.trim().split("\n").length <= 4);
});

test("installer warnings remain visible in concise successful output", () => {
  const output = renderInstallResult({
    status: "installed",
    scope: "user",
    platforms: ["codex", "claude-code"],
    files: ["one", "two"],
    warnings: [{
      code: "POST_COMMIT_BACKUP_CLEANUP_FAILED",
      message: "installation committed, but the transaction backup could not be removed: .sentinel-install-backup-example (busy)",
    }],
  });
  assert.match(output, /^✓ Sentinel installed$/mu);
  assert.match(output, /^Warnings:$/mu);
  assert.match(output, /transaction backup could not be removed/u);
  assert.doesNotMatch(output, /POST_COMMIT_BACKUP_CLEANUP_FAILED|commitStatus|residuals/u);
});

test("installer --json preserves the complete result and installation semantics", async (t) => {
  const humanProject = await temporaryProject(t, "stnl-cli-human-");
  const jsonProject = await temporaryProject(t, "stnl-cli-json-");
  const human = run(INSTALL_CLI, projectArguments(humanProject));
  const machine = run(INSTALL_CLI, [...projectArguments(jsonProject), "--json"]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(machine.status, 0, machine.stderr);
  const result = JSON.parse(machine.stdout);
  assert.equal(result.status, "installed");
  assert.equal(result.scope, "project");
  assert.deepEqual(result.platforms, ["codex", "claude-code"]);
  assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(result.files.length > 100);
  assert.equal(result.commitStatus, "committed");
  assert.equal(result.installationRoot, jsonProject);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.residuals, { stages: [], backups: [], lock: null });

  const manifestPath = SENTINEL_INSTALLATION_CONTRACT.manifestPath.split("/");
  const humanManifest = await fs.readFile(path.join(humanProject, ...manifestPath), "utf8");
  const jsonManifest = await fs.readFile(path.join(jsonProject, ...manifestPath), "utf8");
  assert.equal(jsonManifest, humanManifest);
});

test("installer dry-run stays detailed and supports --json", async (t) => {
  const project = await temporaryProject(t);
  const detailed = run(INSTALL_CLI, [...projectArguments(project), "--dry-run"]);
  const explicitJson = run(INSTALL_CLI, [...projectArguments(project), "--dry-run", "--json"]);
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(explicitJson.status, 0, explicitJson.stderr);
  const plan = JSON.parse(detailed.stdout);
  assert.equal(plan.mode, "dry-run");
  assert.match(plan.fingerprint, /^sha256:/u);
  assert.ok(plan.files.length > 100);
  assert.ok(plan.files.some((file) => file.source && file.destination && file.sha256));
  assert.deepEqual(JSON.parse(explicitJson.stdout), plan);
  await assert.rejects(fs.access(path.join(project, ".sentinel")), { code: "ENOENT" });
});

test("installer rejects duplicate --json with a precise argument error", () => {
  const result = run(INSTALL_CLI, ["--json", "--json"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^ERROR: duplicate argument: --json$/mu);
  assert.match(result.stderr, /usage: node scripts\/install-sentinel\.mjs/u);
});

test("healthy doctor output is concise while --json preserves the complete report", async (t) => {
  const home = await temporaryProject(t, "stnl-cli-doctor-home-");
  const environment = { ...process.env, HOME: home, USERPROFILE: home };
  await installSentinel({ repositoryRoot: ROOT, scope: "user", homeDirectory: () => home, platform: "all", validateSourceContracts: false });

  const human = run(DOCTOR_CLI, [], { env: environment });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^✓ Sentinel healthy$/mu);
  assert.match(human.stdout, /^Scope: user$/mu);
  assert.match(human.stdout, /^Platforms: codex, claude-code$/mu);
  assert.match(human.stdout, /^Source: OK$/mu);
  assert.match(human.stdout, /^Installation: OK$/mu);
  assert.ok(human.stdout.trim().split("\n").length <= 6);
  assert.doesNotMatch(human.stdout, /sha256:|fingerprint|installationRoot|transactionArtifacts|\.agents\/skills\//u);

  const machine = run(DOCTOR_CLI, ["--json"], { env: environment });
  assert.equal(machine.status, 0, machine.stderr);
  const report = JSON.parse(machine.stdout);
  assert.equal(report.status, "OK");
  assert.equal(report.installation.liveStatus, "OK");
  assert.equal(report.installation.installationRoot, home);
  assert.match(report.installation.expected.fingerprint, /^sha256:/u);
  assert.deepEqual(report.installation.transactionArtifacts, { stages: [], backups: [], lock: null });
});

test("doctor DRIFT output reports useful issue paths and preserves the drift exit code", async (t) => {
  const project = await temporaryProject(t);
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex", validateSourceContracts: false });
  const changed = [".agents", "skills", "stnl-testing", "SKILL.md"].join("/");
  await fs.appendFile(path.join(project, ...changed.split("/")), "\ndrift\n");

  const result = run(DOCTOR_CLI, ["--project", project, "--platform", "codex"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^✗ Sentinel drift detected$/mu);
  assert.match(result.stdout, /^Issues:$/mu);
  assert.match(result.stdout, new RegExp(changed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(result.stdout, /sha256:|fingerprint|transactionArtifacts|Source: OK/u);
});

test("doctor prioritizes the cause of large drift cascades and points to complete JSON", () => {
  const missing = Array.from({ length: 20 }, (_, index) => ({
    code: "MISSING_MANAGED_FILE",
    message: `managed file is missing: managed/file-${index}.md`,
  }));
  const output = renderDoctorReport({
    status: "DRIFT",
    mode: "installed-user",
    source: { status: "OK" },
    installation: {
      scope: "user",
      liveStatus: "DRIFT",
      expected: { platforms: ["codex", "claude-code"] },
      blockers: [],
      warnings: [],
      issues: [
        { code: "FINGERPRINT_DRIFT", message: "installed fingerprint sha256:aaaa differs from expected sha256:bbbb" },
        ...missing,
        { code: "PLATFORM_SELECTION_DRIFT", message: "installed platforms [\"codex\"] differ from expected [\"codex\",\"claude-code\"]" },
      ],
    },
  });
  assert.match(output, /^Issues:\n- installed platforms/mu);
  assert.match(output, /additional issues; run with --json for complete details/u);
  assert.doesNotMatch(output, /sha256:|aaaa|bbbb/u);
  assert.doesNotMatch(output, /managed\/file-19\.md/u);
});

test("doctor BLOCKED output distinguishes a healthy live install from an active lock", async (t) => {
  const project = await temporaryProject(t);
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex", validateSourceContracts: false });
  const lock = await acquireSentinelInstallLock(project);
  try {
    const result = run(DOCTOR_CLI, ["--project", project, "--platform", "codex"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /^! Sentinel blocked$/mu);
    assert.match(result.stdout, /^Installation: OK$/mu);
    assert.match(result.stdout, /^Blockers:$/mu);
    assert.match(result.stdout, /installer lock is present: \.sentinel\/install\.lock/u);
    assert.doesNotMatch(result.stdout, /corrupt|fingerprint/u);
  } finally {
    await releaseSentinelInstallLock(lock);
  }
});

test("doctor shows residual warnings without corrupting healthy status", async (t) => {
  const project = await temporaryProject(t);
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex", validateSourceContracts: false });
  await fs.mkdir(path.join(project, `${SENTINEL_INSTALLATION_CONTRACT.stagePrefix}review`));
  await fs.mkdir(path.join(project, `${SENTINEL_INSTALLATION_CONTRACT.backupPrefix}review`));

  const result = run(DOCTOR_CLI, ["--project", project, "--platform", "codex"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^✓ Sentinel healthy$/mu);
  assert.match(result.stdout, /^Installation: OK$/mu);
  assert.match(result.stdout, /^Warnings:$/mu);
  assert.match(result.stdout, /residual installation stage is present/u);
  assert.match(result.stdout, /residual transaction backup is present/u);
});

test("source-only doctor uses concise human output and complete JSON", () => {
  const human = run(DOCTOR_CLI, ["--source-only"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^✓ Sentinel source healthy$/mu);
  assert.match(human.stdout, /^Platforms: codex, claude-code$/mu);
  assert.match(human.stdout, /^Default installation: OK$/mu);
  assert.doesNotMatch(human.stdout, /sha256:|fingerprint|fileCount|repository/u);

  const machine = run(DOCTOR_CLI, ["--source-only", "--json"]);
  assert.equal(machine.status, 0, machine.stderr);
  const report = JSON.parse(machine.stdout);
  assert.equal(report.status, "OK");
  assert.equal(report.mode, "source-only");
  assert.deepEqual(report.source.defaultInstallation.platforms, ["codex", "claude-code"]);
  assert.match(report.source.defaultInstallation.fingerprint, /^sha256:/u);
  assert.ok(report.source.defaultInstallation.fileCount > 100);
  assert.ok(report.source.platforms.every((platform) => platform.fingerprint && platform.fileCount));
});

test("doctor rejects duplicate --json and keeps invalid-argument exit semantics", () => {
  const duplicate = run(DOCTOR_CLI, ["--json", "--json"]);
  assert.equal(duplicate.status, 2);
  assert.match(JSON.parse(duplicate.stdout).blockers[0].message, /duplicate argument: --json/u);

  const invalid = run(DOCTOR_CLI, ["--scope", "project"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stdout, /^! Sentinel blocked$/mu);
  assert.match(invalid.stdout, /project scope requires --project <path>/u);
  assert.match(invalid.stderr, /usage: node scripts\/doctor-sentinel\.mjs/u);
});

test("doctor warning renderer omits healthy internal structures", () => {
  const output = renderDoctorReport({
    status: "OK",
    mode: "installed-user",
    source: { status: "OK" },
    installation: {
      scope: "user",
      liveStatus: "OK",
      expected: { platforms: ["codex"] },
      issues: [],
      blockers: [],
      warnings: [{ message: "residual transaction backup is present: .sentinel-install-backup-example" }],
    },
  });
  assert.match(output, /^✓ Sentinel healthy$/mu);
  assert.match(output, /residual transaction backup/u);
  assert.doesNotMatch(output, /issues|blockers|expected|fingerprint/u);
});
