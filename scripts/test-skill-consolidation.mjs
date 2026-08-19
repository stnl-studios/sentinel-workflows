import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DOMAIN_SKILLS,
  WORKFLOW_SKILLS,
  canonicalSkillRelativePath,
  registrySkills,
} from "./lib/skill-registry.mjs";
import {
  discoverCanonicalSkills,
  resolveCanonicalSkill,
} from "./lib/skill-discovery.mjs";
import { selectDomainSkills, routeSkills } from "./lib/skill-routing.mjs";
import { discoverClaudeSkills, loadClaudeSkill } from "../integrations/claude-code/skill-discovery.mjs";
import { discoverCodexSkills, loadCodexSkill } from "../integrations/codex/skill-discovery.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS = ["coder", "planner", "reviewer", "test-planner", "validator"];
const OBSOLETE_NAMES = [
  "stnl-backend-quality",
  "stnl-backend-sql-quality",
  "stnl-frontend-quality",
  "stnl-database-migrations",
];
const IGNORED_DIRECTORIES = new Set(["targets", "__MACOSX", "node_modules", ".git", "tmp", "dist", "coverage"]);
const TEXT_EXTENSIONS = new Set([".md", ".mjs", ".sh", ".json", ".toml", ".yaml", ".yml"]);

async function directNames(directory) {
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("stnl-"))
    .map((entry) => entry.name)
    .sort();
}

async function textFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) result.push(file);
    }
  }
  await visit(root);
  return result;
}

function runRepositoryContract(root) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts/check-contracts.mjs"), "repository", "--root", root], {
    encoding: "utf8",
  });
}

async function contractFixture(t, mutate) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-skill-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.join(ROOT, "skills"), path.join(root, "skills"), { recursive: true });
  await fs.symlink(path.join(ROOT, "templates"), path.join(root, "templates"), "dir");
  await fs.symlink(path.join(ROOT, "scripts"), path.join(root, "scripts"), "dir");
  await fs.symlink(path.join(ROOT, "integrations"), path.join(root, "integrations"), "dir");
  await fs.symlink(path.join(ROOT, ".gitignore"), path.join(root, ".gitignore"), "file");
  await mutate(root);
  return root;
}

test("registries and filesystem layout remain semantically separate", async () => {
  assert.deepEqual(await directNames(path.join(ROOT, "skills/workflows")), [...WORKFLOW_SKILLS].sort());
  assert.deepEqual(await directNames(path.join(ROOT, "skills/domains")), [...DOMAIN_SKILLS].sort());
  assert.equal(new Set(registrySkills()).size, registrySkills().length);
  assert.equal(WORKFLOW_SKILLS.some((name) => DOMAIN_SKILLS.includes(name)), false);

  for (const name of registrySkills()) {
    const relative = canonicalSkillRelativePath(name);
    const file = path.join(ROOT, relative);
    const source = await fs.readFile(file, "utf8");
    const metadata = /^---\n([\s\S]*?)\n---/u.exec(source)?.[1] ?? "";
    assert.match(metadata, new RegExp(`^name: ${name}$`, "mu"), relative);
    assert.equal(await fs.stat(file).then((value) => value.isFile()), true);
    assert.equal(await fs.stat(path.join(ROOT, "skills", name), { throwIfNoEntry: false }).catch(() => null), null);
  }
});

test("repository contract rejects unknown skills and flat duplicates", async (t) => {
  const unknown = await contractFixture(t, async (root) => {
    await fs.mkdir(path.join(root, "skills/domains/stnl-unknown"));
    await fs.writeFile(path.join(root, "skills/domains/stnl-unknown/SKILL.md"), "---\nname: stnl-unknown\ndescription: unknown\n---\n", "utf8");
  });
  const unknownResult = runRepositoryContract(unknown);
  assert.equal(unknownResult.status, 1, unknownResult.stdout + unknownResult.stderr);
  assert.match(unknownResult.stderr, /C002_SKILL_REGISTRY/u);

  const duplicate = await contractFixture(t, async (root) => {
    await fs.mkdir(path.join(root, "skills/stnl-backend-dotnet"));
    await fs.writeFile(path.join(root, "skills/stnl-backend-dotnet/SKILL.md"), "duplicate\n", "utf8");
  });
  const duplicateResult = runRepositoryContract(duplicate);
  assert.equal(duplicateResult.status, 1, duplicateResult.stdout + duplicateResult.stderr);
  assert.match(duplicateResult.stderr, /C002_SKILL_REGISTRY/u);
});

test("agent allowlists expose every canonical domain and remove obsolete migrations", async () => {
  for (const agent of AGENTS) {
    const source = await fs.readFile(path.join(ROOT, "agents/base", `${agent}.md`), "utf8");
    for (const name of DOMAIN_SKILLS) assert.match(source, new RegExp(`\\x60${name}\\x60`, "u"), `${agent}: ${name}`);
    assert.doesNotMatch(source, /\bstnl-database-migrations\b/u);
  }
});

test("semantic routing selects a primary and only applicable specialized domains", () => {
  assert.deepEqual(selectDomainSkills("ASP.NET Core endpoint"), {
    primaryDomainSkill: "stnl-backend-dotnet",
    specializedDomainSkills: [],
  });
  assert.deepEqual(selectDomainSkills("Node.js TypeScript backend API"), {
    primaryDomainSkill: "stnl-backend-node-typescript",
    specializedDomainSkills: [],
  });
  assert.deepEqual(selectDomainSkills("SQL query, ORM transaction, and database index"), {
    primaryDomainSkill: "stnl-database-persistence",
    specializedDomainSkills: [],
  });
  assert.deepEqual(selectDomainSkills("React frontend component"), {
    primaryDomainSkill: "stnl-frontend-react-next-angular",
    specializedDomainSkills: [],
  });
  assert.deepEqual(selectDomainSkills("SwiftUI iOS screen"), {
    primaryDomainSkill: "stnl-mobile-ios-swift",
    specializedDomainSkills: [],
  });
  assert.deepEqual(selectDomainSkills("authorization claims and tenant security boundary"), {
    primaryDomainSkill: "stnl-security-auth",
    specializedDomainSkills: [],
  });
  assert.deepEqual(selectDomainSkills("test design and contract testing strategy"), {
    primaryDomainSkill: "stnl-testing",
    specializedDomainSkills: [],
  });
  assert.deepEqual(selectDomainSkills(".NET endpoint with SQL persistence and authorization claims"), {
    primaryDomainSkill: "stnl-backend-dotnet",
    specializedDomainSkills: ["stnl-database-persistence", "stnl-security-auth"],
  });
  assert.deepEqual(selectDomainSkills(".NET endpoint with database migrations"), {
    primaryDomainSkill: "stnl-backend-dotnet",
    specializedDomainSkills: ["stnl-database-persistence"],
  });
  assert.deepEqual(selectDomainSkills("simple .NET endpoint"), {
    primaryDomainSkill: "stnl-backend-dotnet",
    specializedDomainSkills: [],
  });
  assert.deepEqual(routeSkills({ workflowSkill: "stnl-slice-executor", scope: ".NET endpoint with SQL" }), {
    workflowSkill: "stnl-slice-executor",
    primaryDomainSkill: "stnl-backend-dotnet",
    specializedDomainSkills: ["stnl-database-persistence"],
  });
  assert.throws(() => routeSkills({ workflowSkill: "stnl-database-persistence", scope: "SQL" }), /unknown workflow skill/u);
});

test("Codex discovers canonical workflow and domain skills without copies", () => {
  const discovered = discoverCodexSkills(ROOT);
  assert.equal(discovered.consumer, "codex");
  assert.equal(discovered.sourceOfTruth, "skills");
  assert.deepEqual(discovered.workflows.map((skill) => skill.name), WORKFLOW_SKILLS);
  assert.deepEqual(discovered.domains.map((skill) => skill.name), DOMAIN_SKILLS);
  assert.ok(discovered.workflows.every((skill) => skill.relativePath.startsWith("skills/workflows/")));
  assert.ok(discovered.domains.every((skill) => skill.relativePath.startsWith("skills/domains/")));
  const loaded = loadCodexSkill(ROOT, "stnl-database-persistence");
  assert.equal(loaded.relativePath, "skills/domains/stnl-database-persistence/SKILL.md");
  assert.match(loaded.content, /^name: stnl-database-persistence$/mu);
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [path.join(ROOT, "integrations/codex/skill-discovery.mjs"), ROOT], { encoding: "utf8" }).stdout).consumer, "codex");
});

test("Claude Code independently discovers canonical workflow and domain skills without copies", () => {
  const discovered = discoverClaudeSkills(ROOT);
  assert.equal(discovered.consumer, "claude-code");
  assert.equal(discovered.sourceOfTruth, "skills");
  assert.deepEqual(discovered.workflows.map((skill) => skill.name), WORKFLOW_SKILLS);
  assert.deepEqual(discovered.domains.map((skill) => skill.name), DOMAIN_SKILLS);
  const loaded = loadClaudeSkill(ROOT, "stnl-backend-dotnet");
  assert.equal(loaded.relativePath, "skills/domains/stnl-backend-dotnet/SKILL.md");
  assert.match(loaded.content, /^name: stnl-backend-dotnet$/mu);
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [path.join(ROOT, "integrations/claude-code/skill-discovery.mjs"), ROOT], { encoding: "utf8" }).stdout).consumer, "claude-code");
});

test("operational sources contain no obsolete taxonomy or flat skill paths", async () => {
  const files = await textFiles(ROOT);
  for (const file of files) {
    if (file === path.join(ROOT, "scripts/test-skill-consolidation.mjs")) continue;
    const source = await fs.readFile(file, "utf8");
    for (const name of OBSOLETE_NAMES) assert.equal(source.includes(name), false, `${path.relative(ROOT, file)} contains ${name}`);
    if (file === path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/maintenance/runtime-context-budget.json")) {
      const manifest = JSON.parse(source);
      for (const contract of Object.values(manifest.modes)) {
        assert.ok(contract.runtime_files.every((value) => value.startsWith("skills/workflows/")));
        assert.ok(contract.baseline.files.every((value) => value.startsWith("skills/stnl-")));
      }
      continue;
    }
    assert.equal(/skills\/stnl-[A-Za-z0-9-]+(?:\/|$)/u.test(source), false, `${path.relative(ROOT, file)} contains a flat skill path`);
  }
});
