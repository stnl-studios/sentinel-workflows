import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLATFORM_LAUNCHERS,
  SENTINEL_INSTALLATION_CONTRACT,
  SHARED_PRODUCTION_PROMPTS,
  acquireSentinelInstallLock,
  assertSafeRelativePath,
  fingerprintEntries,
  installSentinel,
  planSentinelDistribution,
  releaseSentinelInstallLock,
  validateInstalledManifest,
  validateDistributionPlan,
} from "./lib/sentinel-distribution.mjs";
import { registrySkills } from "./lib/skill-registry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scripts/install-sentinel.mjs");

function codexSkillPath(name, suffix = "") {
  return [".agents", "skills", name, suffix].filter(Boolean).join("/");
}

function claudeSkillPath(name, suffix = "") {
  return [".claude", "skills", name, suffix].filter(Boolean).join("/");
}

async function temporaryDirectory(t, prefix = "stnl-distribution-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

async function sourceFixture(t) {
  const fixture = await temporaryDirectory(t, "stnl-source-");
  for (const directory of ["skills", "integrations", "templates"]) {
    await fs.cp(path.join(ROOT, directory), path.join(fixture, directory), { recursive: true });
  }
  return fixture;
}

async function fixturePlan(root, platform = "codex") {
  return planSentinelDistribution({ repositoryRoot: root, scope: "project", platform, validateSourceContracts: false });
}

async function fixtureInstall(source, project, platform, options = {}) {
  return installSentinel({
    repositoryRoot: source,
    projectRoot: project,
    platform,
    validateSourceContracts: false,
    ...options,
  });
}

function destinationSet(plan) {
  return new Set(plan.entries.map((entry) => entry.destinationRelativePath));
}

async function exists(file) {
  return Boolean(await fs.lstat(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)));
}

function filesystemError(code) {
  return Object.assign(new Error(`injected ${code}`), { code });
}

async function waitForPath(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function childExit(child) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stderr };
}

async function snapshotTree(root) {
  const rows = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith(".sentinel-install-stage-") || entry.name.startsWith(".sentinel-install-backup-")) continue;
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

test("canonical registry is the complete production skill inventory", async () => {
  const plan = await planSentinelDistribution({ repositoryRoot: ROOT, platform: "codex" });
  const paths = destinationSet(plan);
  assert.equal(registrySkills().length, 18);
  for (const name of registrySkills()) assert.ok(paths.has(`.agents/skills/${name}/SKILL.md`), name);
  assert.equal(plan.entries.filter((entry) => entry.family === "skill" && entry.destinationRelativePath.endsWith("/SKILL.md")).length, registrySkills().length);
});

test("skill production filtering preserves runtime closure and excludes development content", async () => {
  const plan = await planSentinelDistribution({ repositoryRoot: ROOT, platform: "codex" });
  const paths = [...destinationSet(plan)];
  assert.ok(paths.includes(codexSkillPath("stnl-spec-lifecycle-manager", "runtime/validate-spec-lifecycle.mjs")));
  assert.ok(paths.includes(codexSkillPath("stnl-spec-lifecycle-manager", "templates/feature_spec.template.md")));
  assert.ok(paths.includes(codexSkillPath("stnl-spec-lifecycle-manager", "references/spec-schema.md")));
  assert.ok(paths.includes(codexSkillPath("stnl-requirements-refiner", "references/refinement-model.md")));
  assert.ok(paths.includes(codexSkillPath("stnl-spec-roadmap", "references/roadmap-model.md")));
  assert.ok(paths.includes(codexSkillPath("stnl-spec-test-runbook", "references/runbook-manifest.md")));
  assert.equal(paths.some((file) => file.includes("/runtime/test/")), false);
  assert.equal(paths.some((file) => file.includes("/evals/")), false);
  assert.equal(paths.some((file) => file.includes("/examples/")), false);
  assert.equal(paths.some((file) => file.includes("/maintenance/")), false);
  assert.equal(paths.some((file) => file.endsWith("/README.md")), false);
  assert.equal(paths.some((file) => file.endsWith("/references/eval-guidance.md")), false);
  assert.equal(paths.some((file) => file.endsWith("/references/token-economy.md")), false);
});

test("platform plans select only native agents, launchers, and metadata", async () => {
  const codex = await planSentinelDistribution({ repositoryRoot: ROOT, platform: "codex" });
  const claude = await planSentinelDistribution({ repositoryRoot: ROOT, platform: "claude-code" });
  const codexPaths = destinationSet(codex);
  const claudePaths = destinationSet(claude);
  assert.ok(codexPaths.has(".codex/agents/stnl_validation_runner.toml"));
  assert.ok(codexPaths.has(".codex/agents/stnl_spec_context_scout.toml"));
  assert.equal([...codexPaths].some((file) => file.startsWith(".claude/agents/")), false);
  assert.ok(claudePaths.has(".claude/agents/stnl-validation-runner.md"));
  assert.ok(claudePaths.has(".claude/agents/stnl-spec-context-scout.md"));
  assert.equal([...claudePaths].some((file) => file.startsWith(".codex/agents/")), false);
  for (const launcher of PLATFORM_LAUNCHERS.codex) assert.ok(codexPaths.has(`.sentinel/prompts/${launcher}`));
  for (const launcher of PLATFORM_LAUNCHERS["claude-code"]) assert.equal(codexPaths.has(`.sentinel/prompts/${launcher}`), false);
  for (const launcher of PLATFORM_LAUNCHERS["claude-code"]) assert.ok(claudePaths.has(`.claude/commands/${launcher}`));
  for (const launcher of PLATFORM_LAUNCHERS.codex) assert.equal(claudePaths.has(`.claude/commands/${launcher}`), false);
  assert.ok([...codexPaths].some((file) => file.endsWith("/agents/openai.yaml")));
  assert.equal([...claudePaths].some((file) => file.endsWith("/agents/openai.yaml")), false);
  for (const prompt of SHARED_PRODUCTION_PROMPTS) {
    assert.ok(codexPaths.has(`.sentinel/prompts/${prompt}`));
    assert.ok(claudePaths.has(`.claude/commands/${prompt}`));
  }
});

test("platform-independent skill bytes remain equivalent", async () => {
  const codex = await planSentinelDistribution({ repositoryRoot: ROOT, platform: "codex" });
  const claude = await planSentinelDistribution({ repositoryRoot: ROOT, platform: "claude-code" });
  const bySource = (plan) => new Map(plan.entries.filter((entry) => entry.family === "skill" && !entry.sourceRelativePath.endsWith("/agents/openai.yaml")).map((entry) => [entry.sourceRelativePath, Buffer.from(entry.bytes)]));
  const codexSkills = bySource(codex);
  const claudeSkills = bySource(claude);
  assert.deepEqual([...codexSkills.keys()], [...claudeSkills.keys()]);
  for (const [source, bytes] of codexSkills) assert.ok(bytes.equals(claudeSkills.get(source)), source);
});

test("unknown skill top-level content fails closed", async (t) => {
  const source = await sourceFixture(t);
  await fs.writeFile(path.join(source, "skills/domains/stnl-testing/notes.txt"), "unknown\n");
  await assert.rejects(fixturePlan(source), /unclassified skill top-level content/u);
});

test("unknown semantic references fail closed", async (t) => {
  const source = await sourceFixture(t);
  await fs.writeFile(path.join(source, "skills/workflows/stnl-execution-planner/references/new-policy.md"), "# New\n");
  await assert.rejects(fixturePlan(source), /unclassified semantic reference/u);
});

test("unknown prompts fail closed", async (t) => {
  const source = await sourceFixture(t);
  await fs.writeFile(path.join(source, "templates/prompts/new-flow.md"), "unknown\n");
  await assert.rejects(fixturePlan(source), /unclassified production prompt/u);
});

test("missing staged runtime imports fail resource closure", async (t) => {
  const source = await sourceFixture(t);
  const project = await temporaryDirectory(t, "stnl-project-");
  await fs.unlink(path.join(source, "skills/workflows/stnl-requirements-refiner/runtime/lib/core.mjs"));
  await fs.writeFile(path.join(project, "preserved.txt"), "before\n");
  await assert.rejects(fixtureInstall(source, project, "codex"), /missing relative import/u);
  assert.equal(await fs.readFile(path.join(project, "preserved.txt"), "utf8"), "before\n");
  assert.equal(await exists(path.join(project, ".agents")), false);
});

test("textual references to omitted local resources fail staged validation", async (t) => {
  const source = await sourceFixture(t);
  const project = await temporaryDirectory(t, "stnl-project-");
  const skill = path.join(source, "skills/domains/stnl-testing/SKILL.md");
  await fs.appendFile(skill, "\nUse `<SKILL_ROOT>/runtime/missing-runtime.mjs`.\n");
  await assert.rejects(fixtureInstall(source, project, "codex"), /missing staged textual resource/u);
});

test("OS metadata and targets have zero influence on plan or fingerprint", async (t) => {
  const source = await sourceFixture(t);
  const before = await fixturePlan(source);
  await fs.writeFile(path.join(source, "templates/prompts/.DS_Store"), "junk-a");
  await fs.writeFile(path.join(source, "skills/domains/stnl-testing/._SKILL.md"), "junk-b");
  await fs.mkdir(path.join(source, "skills/domains/stnl-testing/__MACOSX"));
  await fs.writeFile(path.join(source, "skills/domains/stnl-testing/__MACOSX/conflict"), "junk-c");
  await fs.mkdir(path.join(source, "targets/conflicting/skills"), { recursive: true });
  await fs.writeFile(path.join(source, "targets/conflicting/skills/SKILL.md"), "opposite platform content\n");
  const after = await fixturePlan(source);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.entries.map((entry) => entry.destinationRelativePath), before.entries.map((entry) => entry.destinationRelativePath));
});

test("external source symlinks fail planning", async (t) => {
  const source = await sourceFixture(t);
  const externalRoot = await temporaryDirectory(t, "stnl-external-");
  const runtime = path.join(source, "skills/workflows/stnl-execution-planner/runtime");
  if (process.platform === "win32") {
    await fs.writeFile(path.join(externalRoot, "outside.mjs"), "export default true;\n");
    await fs.symlink(externalRoot, path.join(runtime, "external"), "junction");
  } else {
    const external = path.join(externalRoot, "outside.mjs");
    await fs.writeFile(external, "export default true;\n");
    await fs.symlink(external, path.join(runtime, "external.mjs"));
  }
  await assert.rejects(fixturePlan(source), /unexpected symlink/u);
});

test("special source files fail planning", { skip: process.platform === "win32" }, async (t) => {
  const source = await fs.mkdtemp(path.join("/tmp", "ss-"));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  for (const directory of ["skills", "integrations", "templates"]) {
    await fs.cp(path.join(ROOT, directory), path.join(source, directory), { recursive: true });
  }
  const runtime = path.join(source, "skills/domains/stnl-testing/runtime");
  await fs.mkdir(runtime);
  const socketPath = path.join(runtime, "source.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  try {
    await assert.rejects(fixturePlan(source), /unsupported special file/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("special files cannot hide behind development-only top-level names", { skip: process.platform === "win32" }, async (t) => {
  const source = await fs.mkdtemp(path.join("/tmp", "st-"));
  t.after(() => fs.rm(source, { recursive: true, force: true }));
  for (const directory of ["skills", "integrations", "templates"]) {
    await fs.cp(path.join(ROOT, directory), path.join(source, directory), { recursive: true });
  }
  const socketPath = path.join(source, "skills/domains/stnl-testing/maintenance");
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  try {
    await assert.rejects(fixturePlan(source), /unsupported special file/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("path traversal and absolute paths are rejected", () => {
  for (const value of ["../escape", "skills/../escape", "/absolute", "C:\\escape", "C:/escape", "C:escape", "a\\b"]) {
    assert.throws(() => assertSafeRelativePath(value), /path|absolute|separators/u);
  }
  assert.equal(assertSafeRelativePath(codexSkillPath("stnl-testing", "SKILL.md")), codexSkillPath("stnl-testing", "SKILL.md"));
});

test("plans and fingerprints are deterministic across source locations", async (t) => {
  const firstSource = await sourceFixture(t);
  const secondSource = await sourceFixture(t);
  const first = await fixturePlan(firstSource, "claude-code");
  const second = await fixturePlan(secondSource, "claude-code");
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.entries.map((entry) => entry.destinationRelativePath), second.entries.map((entry) => entry.destinationRelativePath));
  assert.deepEqual(first.entries.map((entry) => entry.sourceRelativePath), second.entries.map((entry) => entry.sourceRelativePath));
});

test("fingerprint changes with material bytes and rejects an altered plan", async () => {
  const plan = await planSentinelDistribution({ repositoryRoot: ROOT, platform: "codex" });
  const entries = plan.entries.map((entry, index) => index === 0 ? { ...entry, bytes: Buffer.concat([Buffer.from(entry.bytes), Buffer.from("changed")]) } : entry);
  assert.notEqual(fingerprintEntries(plan.scope, plan.platforms, entries), plan.fingerprint);
  assert.throws(() => validateDistributionPlan({ ...plan, entries }), /fingerprint is invalid/u);
});

test("installation is idempotent and preserves unrelated project content", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  await fs.mkdir(path.join(project, ".agents/skills/third-party"), { recursive: true });
  await fs.writeFile(path.join(project, ".agents/skills/third-party/SKILL.md"), "third party\n");
  await fs.mkdir(path.join(project, ".codex/agents"), { recursive: true });
  await fs.writeFile(path.join(project, ".codex/agents/user.toml"), "user = true\n");
  await fs.writeFile(path.join(project, "application.txt"), "untouched\n");
  const first = await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" });
  const firstSnapshot = await snapshotTree(project);
  const second = await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(await snapshotTree(project), firstSnapshot);
  assert.equal(await fs.readFile(path.join(project, ".agents/skills/third-party/SKILL.md"), "utf8"), "third party\n");
  assert.equal(await fs.readFile(path.join(project, ".codex/agents/user.toml"), "utf8"), "user = true\n");
  assert.equal(await fs.readFile(path.join(project, "application.txt"), "utf8"), "untouched\n");
});

test("manual full Sentinel skill copies are reconciled without deleting third-party skills", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const skillDestination = path.join(project, ".agents", "skills", "stnl-spec-lifecycle-manager");
  await fs.mkdir(path.dirname(skillDestination), { recursive: true });
  await fs.cp(path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager"), skillDestination, { recursive: true });
  await fs.mkdir(path.join(project, ".agents/skills/third-party"));
  await fs.writeFile(path.join(project, ".agents/skills/third-party/SKILL.md"), "third party\n");
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" });
  assert.equal(await exists(path.join(skillDestination, "runtime/test")), false);
  assert.equal(await exists(path.join(skillDestination, "evals")), false);
  assert.equal(await exists(path.join(skillDestination, "examples")), false);
  assert.equal(await exists(path.join(skillDestination, "maintenance")), false);
  assert.equal(await exists(path.join(skillDestination, "references/eval-guidance.md")), false);
  assert.equal(await fs.readFile(path.join(project, ".agents/skills/third-party/SKILL.md"), "utf8"), "third party\n");
});

test("an exact canonical skill root replaces unmanaged content regardless of declared identity", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const destination = path.join(project, ".agents", "skills", "stnl-testing");
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "SKILL.md"), "---\nname: someone-else\n---\n");
  await fs.writeFile(path.join(destination, "stale.txt"), "stale\n");
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" });
  assert.ok((await fs.readFile(path.join(destination, "SKILL.md"))).equals(await fs.readFile(path.join(ROOT, "skills/domains/stnl-testing/SKILL.md"))));
  assert.equal(await exists(path.join(destination, "stale.txt")), false);
});

test("explicit project install authoritatively replaces an unmanaged different canonical agent", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const destination = path.join(project, ".claude/agents/stnl-validation-runner.md");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, "old manual project-local Claude agent\n");
  const installed = spawnSync(process.execPath, [CLI, "--scope", "project", "--project", project], { encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok((await fs.readFile(destination)).equals(await fs.readFile(path.join(ROOT, "integrations/claude-code/agents/stnl-validation-runner.md"))));
  const manifest = JSON.parse(await fs.readFile(path.join(project, ".sentinel/install-manifest.json"), "utf8"));
  validateInstalledManifest(manifest);
  assert.equal(manifest.scope, "project");
  assert.deepEqual(manifest.platforms, ["codex", "claude-code"]);
});

test("ordinary directories at exact canonical file destinations are replaced", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const agent = path.join(project, ".claude/agents/stnl-validation-runner.md");
  const manifestPath = path.join(project, ".sentinel/install-manifest.json");
  for (const destination of [agent, manifestPath]) {
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "stale.txt"), "stale directory content\n");
  }
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "all" });
  assert.equal((await fs.stat(agent)).isFile(), true);
  assert.ok((await fs.readFile(agent)).equals(await fs.readFile(path.join(ROOT, "integrations/claude-code/agents/stnl-validation-runner.md"))));
  assert.equal((await fs.stat(manifestPath)).isFile(), true);
  validateInstalledManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
});

test("switching platforms removes only known opposite Sentinel artifacts", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  await fs.writeFile(path.join(project, "keep.txt"), "keep\n");
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" });
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "claude-code" });
  assert.equal(await exists(path.join(project, ".codex/agents/stnl_validation_runner.toml")), false);
  assert.equal(await exists(path.join(project, ".agents", "skills", "stnl-testing")), false);
  assert.equal(await exists(path.join(project, ".sentinel/prompts/execution-plan.md")), false);
  assert.equal(await exists(path.join(project, ...claudeSkillPath("stnl-testing", "SKILL.md").split("/"))), true);
  assert.equal(await exists(path.join(project, ".claude/agents/stnl-validation-runner.md")), true);
  assert.equal(await fs.readFile(path.join(project, "keep.txt"), "utf8"), "keep\n");
});

test("staging validation failure preserves the previous installation byte-for-byte", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" });
  const before = await snapshotTree(project);
  await assert.rejects(installSentinel({
    repositoryRoot: ROOT,
    projectRoot: project,
    platform: "codex",
    stageMutator: async (stageRoot, plan) => {
      await fs.appendFile(path.join(stageRoot, ...plan.entries[0].destinationRelativePath.split("/")), "tampered\n");
    },
  }), /staged file bytes differ/u);
  assert.deepEqual(await snapshotTree(project), before);
});

test("in-process publication failure rolls back every Sentinel unit", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" });
  const before = await snapshotTree(project);
  let count = 0;
  await assert.rejects(installSentinel({
    repositoryRoot: ROOT,
    projectRoot: project,
    platform: "claude-code",
    beforePublishUnit: async () => {
      count += 1;
      if (count === 5) throw new Error("injected publication failure");
    },
  }), /injected publication failure/u);
  assert.deepEqual(await snapshotTree(project), before);
});

test("filesystem lock identity cannot be released by a non-owner", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const lock = await acquireSentinelInstallLock(project);
  assert.equal(await exists(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.lockPath.split("/"))), true);
  await assert.rejects(
    releaseSentinelInstallLock({ ...lock, token: "not-the-owner" }),
    /ownership changed/u,
  );
  assert.equal(await exists(lock.path), true);
  assert.deepEqual(await releaseSentinelInstallLock(lock), { released: true });
  assert.equal(await exists(lock.path), false);
});

test("lock release rechecks ownership after transient unlink contention", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const lock = await acquireSentinelInstallLock(project);
  let attempts = 0;
  await assert.rejects(
    releaseSentinelInstallLock(lock, {
      unlink: async (lockPath) => {
        attempts += 1;
        await fs.unlink(lockPath);
        await fs.writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, token: "replacement-owner", pid: 123, createdAt: new Date(0).toISOString() })}\n`, { flag: "wx" });
        throw filesystemError("EPERM");
      },
    }),
    /ownership changed/u,
  );
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(await fs.readFile(lock.path, "utf8")).token, "replacement-owner");
});

test("malformed replacement lock fails closed", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const lock = await acquireSentinelInstallLock(project);
  await fs.writeFile(lock.path, "{malformed\n");
  await assert.rejects(releaseSentinelInstallLock(lock), /metadata is malformed/u);
  assert.equal(await fs.readFile(lock.path, "utf8"), "{malformed\n");
});

test("transient lock unlink contention is retried and bounded", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const lock = await acquireSentinelInstallLock(project);
  let attempts = 0;
  const result = await releaseSentinelInstallLock(lock, {
    unlink: async (lockPath) => {
      attempts += 1;
      if (attempts < 3) throw filesystemError("EBUSY");
      await fs.unlink(lockPath);
    },
  });
  assert.deepEqual(result, { released: true });
  assert.equal(attempts, 3);
  assert.equal(await exists(lock.path), false);
});

test("lock cleanup does not retry unrecognized filesystem errors", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const lock = await acquireSentinelInstallLock(project);
  let attempts = 0;
  await assert.rejects(releaseSentinelInstallLock(lock, {
    unlink: async () => {
      attempts += 1;
      throw filesystemError("EACCES");
    },
  }), /injected EACCES/u);
  assert.equal(attempts, 1);
  assert.equal(await exists(lock.path), true);
});

test("concurrent process cannot enter the same project transaction", async (t) => {
  const source = await sourceFixture(t);
  const project = await temporaryDirectory(t, "stnl-project-");
  const coordination = await temporaryDirectory(t, "stnl-lock-coordination-");
  const ready = path.join(coordination, "ready");
  const release = path.join(coordination, "release");
  const moduleUrl = new URL("./lib/sentinel-distribution.mjs", import.meta.url).href;
  const script = `
    import * as fs from "node:fs/promises";
    import { installSentinel } from ${JSON.stringify(moduleUrl)};
    const present = async (file) => Boolean(await fs.lstat(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)));
    await installSentinel({
      repositoryRoot: process.env.STNL_SOURCE,
      projectRoot: process.env.STNL_PROJECT,
      platform: "codex",
      validateSourceContracts: false,
      afterLockAcquired: async () => {
        await fs.writeFile(process.env.STNL_READY, "ready\\n");
        while (!await present(process.env.STNL_RELEASE)) await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
  `;
  const first = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, STNL_SOURCE: source, STNL_PROJECT: project, STNL_READY: ready, STNL_RELEASE: release },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => { if (first.exitCode === null) first.kill(); });
  await waitForPath(ready);
  const beforeSecond = await snapshotTree(project);
  await assert.rejects(fixtureInstall(source, project, "codex"), /installation already in progress/u);
  assert.deepEqual(await snapshotTree(project), beforeSecond);
  await fs.writeFile(release, "release\n");
  const completed = await childExit(first);
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.signal, null);
  assert.equal(await exists(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.lockPath.split("/"))), false);
  assert.equal(await exists(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.manifestPath.split("/"))), true);
});

test("lock is released after a pre-commit installation failure", async (t) => {
  const source = await sourceFixture(t);
  const project = await temporaryDirectory(t, "stnl-project-");
  await assert.rejects(fixtureInstall(source, project, "codex", {
    stageMutator: async () => { throw new Error("injected pre-commit failure"); },
  }), /injected pre-commit failure/u);
  assert.equal(await exists(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.lockPath.split("/"))), false);
  const retry = await fixtureInstall(source, project, "codex");
  assert.equal(retry.commitStatus, "committed");
});

test("locks are project-local and do not block a different consumer project", async (t) => {
  const source = await sourceFixture(t);
  const firstProject = await temporaryDirectory(t, "stnl-project-a-");
  const secondProject = await temporaryDirectory(t, "stnl-project-b-");
  const firstLock = await acquireSentinelInstallLock(firstProject);
  try {
    const result = await fixtureInstall(source, secondProject, "claude-code");
    assert.equal(result.commitStatus, "committed");
  } finally {
    await releaseSentinelInstallLock(firstLock);
  }
});

test("transient post-commit backup cleanup contention is retried successfully", async (t) => {
  const source = await sourceFixture(t);
  const project = await temporaryDirectory(t, "stnl-project-");
  await fixtureInstall(source, project, "codex");
  let attempts = 0;
  const result = await fixtureInstall(source, project, "claude-code", {
    removeBackupRoot: async (backupRoot) => {
      attempts += 1;
      if (attempts < 3) throw filesystemError("EPERM");
      await fs.rm(backupRoot, { recursive: true, force: true });
    },
  });
  assert.equal(result.changed, true);
  assert.equal(result.commitStatus, "committed");
  assert.equal(result.fingerprint, (await fixturePlan(source, "claude-code")).fingerprint);
  assert.equal(attempts, 3);
  assert.equal(result.warnings.some((warning) => warning.code === "POST_COMMIT_BACKUP_CLEANUP_FAILED"), false);
  assert.deepEqual(result.residuals.backups, []);
  assert.equal(await exists(path.join(project, ".claude/agents/stnl-validation-runner.md")), true);
  assert.equal(await exists(path.join(project, ".codex/agents/stnl_validation_runner.toml")), false);
  const manifest = JSON.parse(await fs.readFile(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.manifestPath.split("/")), "utf8"));
  validateInstalledManifest(manifest);
  assert.equal(manifest.fingerprint, result.fingerprint);
});

test("installation supports nested project paths containing spaces", async (t) => {
  const root = await temporaryDirectory(t, "stnl path root ");
  const project = path.join(root, "nested workspace", "consumer project", "sentinel target");
  await fs.mkdir(project, { recursive: true });
  const result = await installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" });
  assert.equal(result.commitStatus, "committed");
  assert.equal(result.residuals.lock, null);
  assert.deepEqual(result.residuals.stages, []);
  assert.deepEqual(result.residuals.backups, []);
  const manifest = JSON.parse(await fs.readFile(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.manifestPath.split("/")), "utf8"));
  validateInstalledManifest(manifest);
  assert.equal(manifest.fingerprint, result.fingerprint);
});

test("pre-existing transaction residuals are observed but never trusted or consumed", async (t) => {
  const source = await sourceFixture(t);
  const project = await temporaryDirectory(t, "stnl-project-");
  const staleStage = path.join(project, `${SENTINEL_INSTALLATION_CONTRACT.stagePrefix}operator-review`);
  const staleBackup = path.join(project, `${SENTINEL_INSTALLATION_CONTRACT.backupPrefix}operator-review`);
  await fs.mkdir(path.join(staleStage, ".sentinel"), { recursive: true });
  await fs.writeFile(path.join(staleStage, ".sentinel", "install-manifest.json"), "untrusted stage bytes\n");
  await fs.mkdir(staleBackup);
  await fs.writeFile(path.join(staleBackup, "evidence.txt"), "preserve for review\n");

  const plan = await fixturePlan(source, "codex");
  const result = await fixtureInstall(source, project, "codex");
  assert.equal(result.fingerprint, plan.fingerprint);
  assert.ok(result.warnings.some((warning) => warning.code === "TRANSACTION_STAGE_RESIDUAL"));
  assert.ok(result.warnings.some((warning) => warning.code === "TRANSACTION_BACKUP_RESIDUAL"));
  assert.equal(await fs.readFile(path.join(staleStage, ".sentinel", "install-manifest.json"), "utf8"), "untrusted stage bytes\n");
  assert.equal(await fs.readFile(path.join(staleBackup, "evidence.txt"), "utf8"), "preserve for review\n");
  const manifest = JSON.parse(await fs.readFile(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.manifestPath.split("/")), "utf8"));
  validateInstalledManifest(manifest);
  assert.equal(manifest.fingerprint, plan.fingerprint);
});

test("cross-component incomplete plans cannot validate or publish", async () => {
  const plan = await planSentinelDistribution({ repositoryRoot: ROOT, platform: "codex" });
  const entries = plan.entries.filter((entry) => entry.destinationRelativePath !== ".codex/agents/stnl_validation_runner.toml");
  const invalid = { ...plan, entries, fingerprint: fingerprintEntries(plan.scope, plan.platforms, entries) };
  assert.throws(() => validateDistributionPlan(invalid), /omits platform agent/u);
});

test("destination symlinks fail without changing the external target", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const external = await temporaryDirectory(t, "stnl-external-");
  await fs.mkdir(path.join(project, ".codex"));
  await fs.symlink(external, path.join(project, ".codex/agents"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(external, "marker.txt"), "external\n");
  await assert.rejects(installSentinel({ repositoryRoot: ROOT, projectRoot: project, platform: "codex" }), /destination path contains a symlink/u);
  assert.equal(await fs.readFile(path.join(external, "marker.txt"), "utf8"), "external\n");
  assert.deepEqual((await fs.readdir(external)).sort(), ["marker.txt"]);
});

test("CLI dry-run is deterministic and installation writes the ownership manifest", async (t) => {
  const project = await temporaryDirectory(t, "stnl-project-");
  const first = spawnSync(process.execPath, [CLI, "--platform", "claude-code", "--project", project, "--dry-run"], { encoding: "utf8" });
  const second = spawnSync(process.execPath, [CLI, "--platform", "claude-code", "--project", project, "--dry-run"], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
  assert.equal(await exists(path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.lockPath.split("/"))), false);
  const install = spawnSync(process.execPath, [CLI, "--platform", "claude-code", "--project", project], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  const result = JSON.parse(install.stdout);
  assert.equal(result.status, "installed");
  const manifestPath = path.join(project, ...SENTINEL_INSTALLATION_CONTRACT.manifestPath.split("/"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.fingerprint, result.fingerprint);
  assert.equal("timestamp" in manifest, false);
  assert.equal(JSON.stringify(manifest).includes(project), false);
});
