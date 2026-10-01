import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WORKFLOW_SKILLS } from "./lib/skill-registry.mjs";
import { applyInstallPlan, buildInstallPlan, parseArguments, summarize } from "./sentinel-install.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function isolatedHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-install-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test("CLI defaults to both platforms and exposes only preview and target selection", () => {
  assert.deepEqual(parseArguments([]), { targets: ["codex", "claude"], preview: false });
  assert.deepEqual(parseArguments(["--preview"]), { targets: ["codex", "claude"], preview: true });
  assert.deepEqual(parseArguments(["--target", "codex"]), { targets: ["codex"], preview: false });
  assert.deepEqual(parseArguments(["--target", "claude", "--preview"]), { targets: ["claude"], preview: true });
  for (const args of [["--apply"], ["--force"], ["--target", "invalid"], ["--target", "all"], ["--preview", "--preview"]]) {
    assert.throws(() => parseArguments(args));
  }
});

test("combined plan contains workflow skills and native agents only", async (t) => {
  const home = await isolatedHome(t);
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex", "claude"] });
  const skillNames = new Set(plan.entries.filter((entry) => entry.destinationRelative.startsWith("skills/"))
    .map((entry) => entry.destinationRelative.split(path.sep)[1]));
  assert.deepEqual([...skillNames].sort(), [...WORKFLOW_SKILLS].sort());
  assert.equal(plan.platforms.length, 2);
  assert.ok(plan.entries.some((entry) => entry.destination.endsWith("stnl_validation_runner.toml")));
  assert.ok(plan.entries.some((entry) => entry.destination.endsWith("stnl-validation-runner.md")));
  for (const entry of plan.entries) {
    assert.doesNotMatch(entry.sourceLabel, /(?:benchmarks|node_modules|\/evals\/|\/maintenance\/|\/runtime\/test\/)/u);
    assert.doesNotMatch(entry.destination, /(?:package-lock\.json|package\.json|validation-runner\.mjs|runner-broker\.mjs)/u);
  }
});

test("preview preflights both destinations without creating either platform home", async (t) => {
  const home = await isolatedHome(t);
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex", "claude"] });
  assert.equal(summarize(plan).CREATE, plan.entries.length);
  assert.deepEqual(await fs.readdir(home), []);
});

test("combined application creates byte-identical skills and only matching native agents", async (t) => {
  const home = await isolatedHome(t);
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex", "claude"] });
  const result = await applyInstallPlan(plan);
  assert.equal(result.blocked, false);
  assert.equal(result.applied.length, plan.entries.length);
  for (const entry of plan.entries) assert.deepEqual(await fs.readFile(entry.destination), await fs.readFile(entry.source));
  assert.equal(await fs.stat(path.join(home, ".codex/agents/stnl_validation_runner.toml")).then((item) => item.isFile()), true);
  assert.equal(await fs.stat(path.join(home, ".claude/agents/stnl-validation-runner.md")).then((item) => item.isFile()), true);
  await assert.rejects(fs.access(path.join(home, ".codex/agents/stnl-validation-runner.md")));
  await assert.rejects(fs.access(path.join(home, ".claude/agents/stnl_validation_runner.toml")));
  await assert.rejects(fs.access(path.join(home, ".codex/package-lock.json")));
});

test("repeated application is a byte-preserving no-op and keeps unrelated files", async (t) => {
  const home = await isolatedHome(t);
  const unrelated = path.join(home, ".codex", "settings.toml");
  await fs.mkdir(path.dirname(unrelated), { recursive: true });
  await fs.writeFile(unrelated, "user_setting = true\n");
  const first = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] });
  assert.equal((await applyInstallPlan(first)).blocked, false);
  const paths = first.entries.map((entry) => entry.destination);
  const before = await Promise.all(paths.map(async (file) => ({
    bytes: await fs.readFile(file), mtime: (await fs.stat(file)).mtimeMs,
  })));
  const second = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] });
  assert.equal(summarize(second)["NO-OP"], second.entries.length);
  assert.equal((await applyInstallPlan(second)).applied.length, 0);
  for (let index = 0; index < paths.length; index += 1) {
    assert.deepEqual(await fs.readFile(paths[index]), before[index].bytes);
    assert.equal((await fs.stat(paths[index])).mtimeMs, before[index].mtime);
  }
  assert.equal(await fs.readFile(unrelated, "utf8"), "user_setting = true\n");
});

test("a conflict on either selected platform blocks every creation", async (t) => {
  const home = await isolatedHome(t);
  const conflict = path.join(home, ".claude/agents/stnl-validation-runner.md");
  await fs.mkdir(path.dirname(conflict), { recursive: true });
  await fs.writeFile(conflict, "keep the existing file\n");
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex", "claude"] });
  assert.ok(summarize(plan).CONFLICT > 0);
  const result = await applyInstallPlan(plan);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.applied, []);
  assert.equal(await fs.readFile(conflict, "utf8"), "keep the existing file\n");
  await assert.rejects(fs.access(path.join(home, ".codex")));
  assert.deepEqual(await fs.readdir(path.dirname(conflict)), ["stnl-validation-runner.md"]);
});

test("an I/O failure after preflight reports applied and incomplete paths", async (t) => {
  const home = await isolatedHome(t);
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] });
  const root = plan.platforms[0].destinationRoot;
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "agents"), "block directory creation");
  const result = await applyInstallPlan(plan);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.applied, []);
  assert.equal(result.incomplete.length, plan.entries.length);
  assert.ok(result.error);
  assert.equal(await fs.readFile(path.join(root, "agents"), "utf8"), "block directory creation");
});

test("single-target installation leaves the other platform untouched", async (t) => {
  const home = await isolatedHome(t);
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["claude"] });
  const result = await applyInstallPlan(plan);
  assert.equal(result.blocked, false);
  await assert.rejects(fs.access(path.join(home, ".codex")));
  assert.equal(await fs.stat(path.join(home, ".claude/agents/stnl-validation-runner.md")).then((item) => item.isFile()), true);
});
