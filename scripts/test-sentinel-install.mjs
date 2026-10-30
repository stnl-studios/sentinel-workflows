import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import { DOMAIN_SKILLS, WORKFLOW_SKILLS, isDistributedSkillResource, registrySkills } from "./lib/skill-registry.mjs";
import { selectDomainSkills } from "./lib/skill-routing.mjs";
import { applyInstallPlan, buildInstallPlan, main, parseArguments, summarize } from "./sentinel-install.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function isolatedHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-install-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function captureLogs(action) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(" "));
  try {
    return { result: await action(), output: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

async function install(home, targets = ["codex", "claude"]) {
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets });
  const result = await applyInstallPlan(plan);
  assert.equal(result.blocked, false);
  return plan;
}

async function sourceFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sentinel-install-source-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [family, names] of [["workflows", WORKFLOW_SKILLS], ["domains", DOMAIN_SKILLS]]) {
    for (const name of names) {
      const source = path.join(REPOSITORY_ROOT, "skills", family, name);
      const destination = path.join(root, "skills", family, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(source, destination, { recursive: true });
    }
  }
  for (const relative of ["agents/codex/.codex/agents", "agents/claude-code/.claude/agents"]) {
    await fs.cp(path.join(REPOSITORY_ROOT, relative), path.join(root, relative), { recursive: true });
  }
  return root;
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

test("clean install includes all workflow and domain skills plus native platform agents only", async (t) => {
  const home = await isolatedHome(t);
  const plan = await install(home);
  const skillNames = new Set(plan.operations.filter((item) => item.kind === "skill").map((item) => item.name));
  assert.deepEqual([...skillNames].sort(), [...registrySkills()].sort());
  assert.equal(new Set([...skillNames].map(name => name.toLocaleLowerCase("en-US"))).size, 14);
  assert.equal(plan.platforms.length, 2);
  assert.equal(skillNames.size, 14);
  assert.equal(plan.operations.length, 32);
  for (const target of ["codex", "claude"]) {
    assert.equal(plan.operations.filter(item => item.target === target && item.kind === "skill").length, 14);
    assert.equal(plan.operations.filter(item => item.target === target && item.kind === "agent").length, 2);
  }
  assert.equal(plan.operations.some((item) => item.destination.endsWith("stnl_validation_runner.toml")), true);
  assert.equal(plan.operations.some((item) => item.destination.endsWith("stnl-validation-runner.md")), true);
  for (const operation of plan.operations) {
    assert.doesNotMatch(operation.destination, /(?:package-lock\.json|package\.json|validation-runner\.mjs|runner-broker\.mjs)/u);
    assert.doesNotMatch(operation.destination, /(?:benchmarks?|sdk|app-server)/iu);
    for (const relative of operation.sourceFiles?.keys() ?? []) {
      assert.doesNotMatch(operation.sourceFiles.get(relative).toString("utf8"), /\bcommand_execution\b|App Server|benchmark/iu);
      assert.doesNotMatch(relative, /(?:^|\/)(?:benchmarks?|node_modules|maintenance|evals|sdk|app-server)(?:\/|$)|(?:^|\/)runtime\/test(?:\/|$)/iu);
      assert.doesNotMatch(relative, /^(?:runtime\/runner-command-events\.mjs|runtime\/runner-validate-response\.schema\.json)$/u);
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
  const managedRoots = [WORKFLOW_SKILLS[0], DOMAIN_SKILLS[0]].map(name => path.join(home, ".codex/skills", name));
  const managedFiles = managedRoots.map(root => path.join(root, "SKILL.md"));
  const extraFiles = managedRoots.map(root => path.join(root, "user-dirt.txt"));
  for (const file of managedFiles) await fs.writeFile(file, "locally modified\n");
  for (const file of extraFiles) await fs.writeFile(file, "remove this\n");
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] });
  assert.equal(plan.operations.find((item) => item.kind === "skill" && item.name === WORKFLOW_SKILLS[0]).status, "REPLACE");
  assert.equal(plan.operations.find((item) => item.kind === "skill" && item.name === DOMAIN_SKILLS[0]).status, "REPLACE");
  await applyInstallPlan(plan);
  assert.deepEqual(await fs.readFile(managedFiles[0]), await fs.readFile(path.join(REPOSITORY_ROOT, "skills/workflows", WORKFLOW_SKILLS[0], "SKILL.md")));
  assert.deepEqual(await fs.readFile(managedFiles[1]), await fs.readFile(path.join(REPOSITORY_ROOT, "skills/domains", DOMAIN_SKILLS[0], "SKILL.md")));
  for (const file of extraFiles) await assert.rejects(fs.access(file));
});

test("reinstall removes obsolete Sentinel skills and agents but keeps unrelated components", async (t) => {
  const home = await isolatedHome(t);
  await install(home, ["codex"]);
  const staleSkill = path.join(home, ".codex/skills/stnl-obsolete-skill/old.txt");
  const unrelatedSkill = path.join(home, ".codex/skills/other-skill/keep.txt");
  const staleAgent = path.join(home, ".codex/agents/stnl_old_runner.toml");
  const unrelatedAgent = path.join(home, ".codex/agents/custom.toml");
  for (const file of [staleSkill, unrelatedSkill, staleAgent, unrelatedAgent]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "keep or remove as appropriate\n");
  }
  const plan = await buildInstallPlan({ repositoryRoot: REPOSITORY_ROOT, home, targets: ["codex"] });
  assert.equal(summarize(plan).REMOVE, 2);
  await applyInstallPlan(plan);
  for (const file of [staleSkill, staleAgent]) await assert.rejects(fs.access(file));
  for (const file of [unrelatedSkill, unrelatedAgent]) assert.equal(await fs.readFile(file, "utf8"), "keep or remove as appropriate\n");
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
  const preview = await captureLogs(() => main(["--target", "claude", "--preview"], { repositoryRoot: REPOSITORY_ROOT, home }));
  assert.equal(preview.result, 0);
  assert.ok(preview.output.includes(path.dirname(stale)));
  assert.match(preview.output, /REMOVE\s+/u);
  assert.match(preview.output, /Preview only/u);
  assert.deepEqual(await fs.readFile(stale), before);
  assert.deepEqual(await fs.readdir(path.join(home, ".claude/skills")), ["stnl-removed-skill"]);
});

test("normal install prints a concise target summary without per-path details", async (t) => {
  const home = await isolatedHome(t);
  const applied = await captureLogs(() => main([], { repositoryRoot: REPOSITORY_ROOT, home }));
  assert.equal(applied.result, 0);
  assert.match(applied.output, /Targets: codex, claude/u);
  assert.match(applied.output, /Changes: CREATE \d+, NO-OP 0, REPLACE 0, REMOVE 0/u);
  assert.match(applied.output, /Installation complete: applied \d+ component change\(s\)\./u);
  assert.equal(applied.output.includes(path.join(home, ".codex", "skills", WORKFLOW_SKILLS[0])), false);
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

test("source-root and internal skill symlinks block preflight before destination changes", async t => {
  for (const kind of ["source-root", "internal"]) {
    await t.test(kind, async child => {
      const home = await isolatedHome(child);
      const source = await sourceFixture(child);
      const stale = path.join(home, ".codex/skills/stnl-obsolete-before-source-check/old.md");
      const personal = path.join(home, ".codex/settings.toml");
      await fs.mkdir(path.dirname(stale), { recursive: true });
      await fs.writeFile(stale, "preserve stale entry until inventory succeeds\n");
      await fs.writeFile(personal, "user configuration\n");
      const skillRoot = path.join(source, "skills/domains", DOMAIN_SKILLS[0]);
      if (kind === "source-root") {
        const replacement = `${skillRoot}.real`;
        await fs.rename(skillRoot, replacement);
        await fs.symlink(replacement, skillRoot, "dir");
      } else {
        await fs.symlink("SKILL.md", path.join(skillRoot, "linked-resource.md"), "file");
      }
      await assert.rejects(buildInstallPlan({ repositoryRoot: source, home, targets: ["codex"] }), /symlink in canonical skill source|skill source root/u);
      assert.equal(await fs.readFile(stale, "utf8"), "preserve stale entry until inventory succeeds\n");
      assert.equal(await fs.readFile(personal, "utf8"), "user configuration\n");
      await assert.rejects(fs.access(path.join(home, ".codex/agents")));
    });
  }
});

test("install fixture exposes a fourteen-skill catalog and focused on-demand lookup", async t => {
  const home = await isolatedHome(t);
  await install(home);
  const selectedBodies = [];
  for (const target of ["codex", "claude"]) {
    const root = path.join(home, target === "codex" ? ".codex/skills" : ".claude/skills");
    const names = (await fs.readdir(root)).sort();
    assert.deepEqual(names, [...registrySkills()].sort());
    const catalog = new Map();
    for (const name of names) {
      const source = await fs.readFile(path.join(root, name, "SKILL.md"), "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(source)?.[1] ?? "";
      const skillName = /^name:\s*(.+)$/mu.exec(frontmatter)?.[1];
      const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1];
      assert.equal(skillName, name);
      assert.ok(description?.trim(), `${name} must be catalogable by native description`);
      catalog.set(name, description);
      for (const [, href] of source.matchAll(/\]\(([^)]+)\)/gu)) {
        if (/^(?:[a-z]+:|\/|#)/iu.test(href)) continue;
        const relative = href.split("#", 1)[0];
        if (relative) await fs.access(path.resolve(root, name, relative));
      }
    }
    assert.equal(catalog.size, 14);
    const scope = ".NET endpoint with SQL persistence and tenant authorization";
    const routing = selectDomainSkills(scope);
    const selected = [routing.primaryDomainSkill, ...routing.specializedDomainSkills];
    assert.deepEqual(selected, ["stnl-backend-dotnet", "stnl-database-persistence", "stnl-security-auth"]);
    for (const name of selected) {
      assert.ok(catalog.has(name));
      selectedBodies.push(name);
      const body = await fs.readFile(path.join(root, name, "SKILL.md"), "utf8");
      assert.ok(body.length > 0);
    }
    assert.deepEqual(selectDomainSkills("documentation only, no product change"), {
      primaryDomainSkill: null,
      specializedDomainSkills: [],
    });
  }
  assert.deepEqual(selectedBodies, [
    "stnl-backend-dotnet", "stnl-database-persistence", "stnl-security-auth",
    "stnl-backend-dotnet", "stnl-database-persistence", "stnl-security-auth",
  ]);
});

test("partial application returns applied and incomplete paths without rollback claims", async t => {
  const home = await isolatedHome(t);
  const appliedPath = path.join(home, ".codex/agents/stnl-scout.toml");
  const blockedParent = path.join(home, ".codex/skills-blocked-parent");
  await fs.mkdir(path.dirname(blockedParent), { recursive: true });
  await fs.writeFile(blockedParent, "not a directory\n");
  const finalPath = path.join(home, ".codex/agents/stnl-runner.toml");
  const result = await applyInstallPlan({ operations: [
    { kind: "agent", status: "CREATE", destination: appliedPath, sourceBytes: Buffer.from("written\n") },
    { kind: "skill", status: "CREATE", destination: path.join(blockedParent, "skill"), sourceFiles: new Map([["SKILL.md", Buffer.from("source\n")]]) },
    { kind: "agent", status: "CREATE", destination: finalPath, sourceBytes: Buffer.from("not reached\n") },
  ] });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.applied, [appliedPath]);
  assert.deepEqual(result.incomplete, [path.join(blockedParent, "skill"), finalPath]);
  assert.equal(await fs.readFile(appliedPath, "utf8"), "written\n");
  await assert.rejects(fs.access(finalPath));
  assert.ok(result.error);
});

test('native packages exclude development stubs and SDK event artifacts for both clients, removing prior copies on reinstall',async t=>{
 const home=await isolatedHome(t),stub='runtime/managed-slice-context.mjs',names=['stnl-slice-executor','stnl-slice-quality-manager'];
 const sdkResources=[
   ['stnl-slice-executor','runtime/runner-command-events.mjs'],
   ['stnl-slice-executor','runtime/runner-validate-response.schema.json'],
   ['stnl-slice-quality-manager','runtime/runner-command-events.mjs'],
 ];
 for(const name of WORKFLOW_SKILLS){assert.equal(isDistributedSkillResource(name,stub),!names.includes(name));assert.equal(isDistributedSkillResource(name,'references/managed-slice-context.mjs'),true);assert.equal(isDistributedSkillResource(name,'runtime/nested/managed-slice-context.mjs'),true);}
 for(const [name,relative] of sdkResources){assert.equal(isDistributedSkillResource(name,relative),false);}
 assert.equal(isDistributedSkillResource('unrelated-skill',stub),true);
 await install(home);
 for(const target of ['codex','claude']){
   const platformRoot=target==='codex'?'.codex':'.claude';
   for(const name of names){
     const sourceStub=path.join(REPOSITORY_ROOT,'skills/workflows',name,stub);
     const installedStub=path.join(home,platformRoot,'skills',name,stub);
     assert.equal((await fs.stat(sourceStub)).isFile(),true);
     await assert.rejects(fs.access(installedStub));
     await fs.writeFile(installedStub,'old installed managed stub\n');
   }
   for(const [name,relative] of sdkResources){
     const source=path.join(REPOSITORY_ROOT,'skills/workflows',name,relative);
     const installed=path.join(home,platformRoot,'skills',name,relative);
     assert.equal((await fs.stat(source)).isFile(),true);
     await fs.mkdir(path.dirname(installed),{recursive:true});
     await fs.copyFile(source,installed);
     const helper=path.join(home,platformRoot,'skills',name,'runtime/runner-verification.mjs');
     assert.equal((await fs.stat(helper)).isFile(),true);
   }
 }
 const before=await buildInstallPlan({repositoryRoot:REPOSITORY_ROOT,home,targets:['codex','claude']});
 for(const target of ['codex','claude'])for(const name of names)assert.equal(before.operations.find(item=>item.target===target&&item.kind==='skill'&&item.name===name).status,'REPLACE');
 await applyInstallPlan(before);
 for(const target of ['codex','claude']){
   const platformRoot=target==='codex'?'.codex':'.claude';
   for(const name of names)await assert.rejects(fs.access(path.join(home,platformRoot,'skills',name,stub)));
   for(const [name,relative] of sdkResources)await assert.rejects(fs.access(path.join(home,platformRoot,'skills',name,relative)));
   for(const name of names)assert.equal((await fs.stat(path.join(home,platformRoot,'skills',name,'runtime/runner-verification.mjs'))).isFile(),true);
 }
 const after=await buildInstallPlan({repositoryRoot:REPOSITORY_ROOT,home,targets:['codex','claude']});assert.equal(after.operations.every(item=>item.status==='NO-OP'),true);
});

test('installed reader closure runs outside the checkout without development stubs or benchmark',async t=>{
 const home=await fs.realpath(await isolatedHome(t));await install(home,['codex']);await fs.mkdir(path.join(home,'.git'));
 const target=path.join(home,'closed-spec');await fs.cp(path.join(REPOSITORY_ROOT,'skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/closed'),target,{recursive:true});
 const readers=WORKFLOW_SKILLS.map(name=>path.join(home,'.codex/skills',name,name==='stnl-spec-lifecycle-manager'?'runtime/lib/execution-current-reader.mjs':'runtime/execution-current-reader.mjs'));
 const code=`import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';for(const file of JSON.parse(process.argv[2])){const module=await import(pathToFileURL(file));const result=await module.inspectCurrentExecution(process.argv[1]);assert.equal(result.state,'SPEC_CLOSED');assert.equal(result.normalHandoff,null);}console.log('installed closed readers passed');`;
 const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',code,target,JSON.stringify(readers)],{cwd:home,timeout:30000});assert.match(result.stdout,/installed closed readers passed/u);
});
