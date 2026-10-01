import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DOMAIN_SKILLS, WORKFLOW_SKILLS } from "./lib/skill-registry.mjs";
import { applyInstallPlan, buildInstallPlan, main, parseArguments, summarize } from "./sentinel-install.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function isolatedHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-install-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function install(home, targets = ["codex", "claude"]) {
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets });
  const result = await applyInstallPlan(plan);
  assert.equal(result.blocked, false);
  return plan;
}

test("CLI defaults to both platforms and exposes only preview and target selection", async () => {
  assert.deepEqual(parseArguments([]), { targets: ["codex", "claude"], preview: false });
  assert.deepEqual(parseArguments(["--preview"]), { targets: ["codex", "claude"], preview: true });
  assert.deepEqual(parseArguments(["--target", "codex"]), { targets: ["codex"], preview: false });
  assert.deepEqual(parseArguments(["--target", "claude", "--preview"]), { targets: ["claude"], preview: true });
  for (const args of [["--apply"], ["--force"], ["--target", "invalid"], ["--target", "all"], ["--preview", "--preview"]]) {
    assert.throws(() => parseArguments(args));
  }
  await assert.rejects(buildInstallPlan({ targets: [] }), /targets must contain/u);
});

test("clean install includes workflow skills and native platform agents only", async (t) => {
  const home = await isolatedHome(t);
  const plan = await install(home);
  const skillNames = new Set(plan.operations.filter((item) => item.kind === "skill").map((item) => item.name));
  assert.deepEqual([...skillNames].sort(), [...WORKFLOW_SKILLS].sort());
  assert.equal(plan.platforms.length, 2);
  assert.equal(plan.operations.some((item) => item.destination.endsWith("stnl_validation_runner.toml")), true);
  assert.equal(plan.operations.some((item) => item.destination.endsWith("stnl-validation-runner.md")), true);
  for (const operation of plan.operations) {
    assert.doesNotMatch(operation.destination, /(?:package-lock\.json|package\.json|validation-runner\.mjs|runner-broker\.mjs)/u);
    for (const relative of operation.sourceFiles?.keys() ?? []) {
      assert.doesNotMatch(relative, /(?:^|\/)(?:benchmarks?|node_modules|maintenance|evals)(?:\/|$)|(?:^|\/)runtime\/test(?:\/|$)/u);
    }
  }
  for (const target of ["codex", "claude"]) {
    for (const operation of plan.operations.filter((item) => item.target === target && item.kind === "skill")) {
      const destination = operation.destination;
      const sourceFiles = [...operation.sourceFiles.keys()].sort();
      const listDestination = async (root) => {
        const found = [];
        async function visit(relative = "") {
          for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
            const child = path.join(relative, entry.name);
            if (entry.isDirectory()) await visit(child);
            else if (entry.isFile()) found.push(child.split(path.sep).join("/"));
          }
        }
        await visit();
        return found.sort();
      };
      assert.deepEqual(await listDestination(destination), sourceFiles);
      for (const relative of sourceFiles) assert.deepEqual(await fs.readFile(path.join(destination, relative)), operation.sourceFiles.get(relative));
    }
  }
  await assert.rejects(fs.access(path.join(home, ".codex/package-lock.json")));
});

test("identical second install is a no-op and preserves unrelated files", async (t) => {
  const home = await isolatedHome(t);
  await install(home);
  const unrelated = path.join(home, ".codex/skills/other-skill/README.md");
  const setting = path.join(home, ".codex/agents/custom.toml");
  await fs.mkdir(path.dirname(unrelated), { recursive: true });
  await fs.mkdir(path.dirname(setting), { recursive: true });
  await fs.writeFile(unrelated, "user skill\n");
  await fs.writeFile(setting, "user agent\n");
  const managed = path.join(home, ".codex/skills", WORKFLOW_SKILLS[0], "SKILL.md");
  const before = { bytes: await fs.readFile(managed), mtime: (await fs.stat(managed)).mtimeMs };
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] });
  assert.equal(summarize(plan)["NO-OP"], plan.operations.filter((item) => item.kind !== "remove").length);
  assert.equal(summarize(plan).REMOVE, 0);
  assert.equal((await applyInstallPlan(plan)).applied.length, 0);
  assert.deepEqual(await fs.readFile(managed), before.bytes);
  assert.equal((await fs.stat(managed)).mtimeMs, before.mtime);
  assert.equal(await fs.readFile(unrelated, "utf8"), "user skill\n");
  assert.equal(await fs.readFile(setting, "utf8"), "user agent\n");
});

test("reinstall replaces modified Sentinel files and removes extra dirt inside a known skill", async (t) => {
  const home = await isolatedHome(t);
  await install(home, ["codex"]);
  const skillRoot = path.join(home, ".codex/skills", WORKFLOW_SKILLS[0]);
  const managedFile = path.join(skillRoot, "SKILL.md");
  const extraFile = path.join(skillRoot, "user-dirt.txt");
  await fs.writeFile(managedFile, "locally modified\n");
  await fs.writeFile(extraFile, "remove this\n");
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] });
  assert.equal(plan.operations.find((item) => item.kind === "skill" && item.name === WORKFLOW_SKILLS[0]).status, "REPLACE");
  await applyInstallPlan(plan);
  assert.deepEqual(await fs.readFile(managedFile), await fs.readFile(path.join(REPOSITORY_ROOT, "skills/workflows", WORKFLOW_SKILLS[0], "SKILL.md")));
  await assert.rejects(fs.access(extraFile));
});

test("reinstall removes obsolete Sentinel skills and agents but keeps unrelated components", async (t) => {
  const home = await isolatedHome(t);
  await install(home, ["codex"]);
  const staleSkill = path.join(home, ".codex/skills/stnl-obsolete-skill/old.txt");
  const unrelatedSkill = path.join(home, ".codex/skills/other-skill/keep.txt");
  const domainSkill = path.join(home, ".codex/skills", DOMAIN_SKILLS[0], "keep.txt");
  const staleAgent = path.join(home, ".codex/agents/stnl_old_runner.toml");
  const unrelatedAgent = path.join(home, ".codex/agents/custom.toml");
  for (const file of [staleSkill, unrelatedSkill, domainSkill, staleAgent, unrelatedAgent]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "keep or remove as appropriate\n");
  }
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] });
  assert.equal(summarize(plan).REMOVE, 2);
  await applyInstallPlan(plan);
  for (const file of [staleSkill, staleAgent]) await assert.rejects(fs.access(file));
  for (const file of [unrelatedSkill, domainSkill, unrelatedAgent]) assert.equal(await fs.readFile(file, "utf8"), "keep or remove as appropriate\n");
});

test("preview inventory does not write and lists changes before apply", async (t) => {
  const home = await isolatedHome(t);
  const stale = path.join(home, ".claude/skills/stnl-removed-skill/old.txt");
  await fs.mkdir(path.dirname(stale), { recursive: true });
  await fs.writeFile(stale, "stale\n");
  const before = await fs.readFile(stale);
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["claude"] });
  assert.ok(summarize(plan).CREATE > 0);
  assert.equal(summarize(plan).REMOVE, 1);
  assert.deepEqual(await fs.readFile(stale), before);
  assert.deepEqual(await fs.readdir(home), [".claude"]);
  assert.deepEqual(await fs.readdir(path.join(home, ".claude/skills")), ["stnl-removed-skill"]);
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await main(["--target", "claude", "--preview"], { repositoryRoot: REPOSITORY_ROOT, home }), 0);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(await fs.readFile(stale), before);
  assert.deepEqual(await fs.readdir(path.join(home, ".claude/skills")), ["stnl-removed-skill"]);
});

test("target selection leaves the other platform untouched", async (t) => {
  const home = await isolatedHome(t);
  await install(home, ["claude"]);
  await assert.rejects(fs.access(path.join(home, ".codex")));
  const unrelated = path.join(home, ".codex/skills/other-skill/file.txt");
  await fs.mkdir(path.dirname(unrelated), { recursive: true });
  await fs.writeFile(unrelated, "untouched\n");
  await install(home, ["claude"]);
  assert.equal(await fs.readFile(unrelated, "utf8"), "untouched\n");
});

test("missing source and ambiguous managed names fail during preflight", async (t) => {
  const home = await isolatedHome(t);
  const badSource = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-install-source-"));
  t.after(() => fs.rm(badSource, { recursive: true, force: true }));
  await assert.rejects(buildInstallPlan({ repositoryRoot: badSource, home, targets: ["codex"] }));
  assert.deepEqual(await fs.readdir(home), []);
  const ambiguous = path.join(home, ".codex/skills/stnl-not-a-directory");
  await fs.mkdir(path.dirname(ambiguous), { recursive: true });
  await fs.writeFile(ambiguous, "keep\n");
  await assert.rejects(buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] }), /ambiguous Sentinel skill entry/u);
  await assert.deepEqual(await fs.readdir(home), [".codex"]);
  assert.equal(await fs.readFile(ambiguous, "utf8"), "keep\n");
});
