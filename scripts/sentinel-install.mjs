#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DOMAIN_SKILLS, WORKFLOW_SKILLS, canonicalSkillRelativePath } from "./lib/skill-registry.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "..");
const AGENT_FILES = Object.freeze({
  codex: ["stnl_spec_context_scout.toml", "stnl_validation_runner.toml"],
  claude: ["stnl-spec-context-scout.md", "stnl-validation-runner.md"],
});
const EXCLUDED_SEGMENTS = new Set(["__MACOSX", ".git", "node_modules", "evals", "maintenance"]);

function usage() {
  return "Usage: npm run sentinel:install [--preview] [--target codex|claude]\n";
}

export function parseArguments(argv) {
  let target = "all";
  let targetSpecified = false;
  let preview = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target" && !targetSpecified) {
      target = argv[index + 1];
      if (target === undefined) throw new Error("--target requires codex or claude");
      targetSpecified = true;
      index += 1;
    } else if (argument === "--preview" && !preview) {
      preview = true;
    } else {
      throw new Error(`unknown or repeated argument: ${argument}`);
    }
  }
  if ((targetSpecified && !Object.hasOwn(AGENT_FILES, target)) || (!targetSpecified && target !== "all")) {
    throw new Error("--target must be codex or claude");
  }
  return { targets: target === "all" ? ["codex", "claude"] : [target], preview };
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function excluded(relativePath) {
  const parts = toPosix(relativePath).split("/");
  return parts.some((part) => EXCLUDED_SEGMENTS.has(part)
    || part === ".DS_Store" || part.startsWith("._"))
    || parts.some((part, index) => part === "test" && parts[index - 1] === "runtime");
}

async function walkFiles(root, relative = "") {
  const found = [];
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (excluded(child)) continue;
    if (entry.isDirectory()) found.push(...await walkFiles(root, child));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

async function readSkillSource(repositoryRoot, name) {
  const sourceRoot = path.dirname(path.join(repositoryRoot, canonicalSkillRelativePath(name)));
  const files = await walkFiles(sourceRoot);
  if (files.length === 0) throw new Error(`skill source is empty: ${sourceRoot}`);
  return new Map(await Promise.all(files.map(async (relative) => [
    toPosix(relative), await fs.readFile(path.join(sourceRoot, relative)),
  ])));
}

async function sourceAgent(repositoryRoot, target, name) {
  const platformDirectory = target === "codex" ? "codex/.codex/agents" : "claude-code/.claude/agents";
  const source = path.join(repositoryRoot, "agents", platformDirectory, name);
  return { name, source, bytes: await fs.readFile(source) };
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function listImmediate(root) {
  const info = await lstatOrNull(root);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`managed parent is not a regular directory: ${root}`);
  }
  return fs.readdir(root, { withFileTypes: true });
}

async function inventoryTree(destination) {
  const info = await fs.lstat(destination);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const entry of await fs.readdir(destination, { withFileTypes: true })) {
      await inventoryTree(path.join(destination, entry.name));
    }
  }
}

async function inspectSkill(destination, sourceFiles) {
  const info = await lstatOrNull(destination);
  if (!info) return { status: "CREATE", destination, sourceFiles };
  // The skill directory is a known Sentinel component. Removing it does not follow
  // symlinks and keeps the install bounded to that immediate directory.
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { status: "REPLACE", destination, sourceFiles };
  }
  const expectedDirectories = new Set();
  for (const relative of sourceFiles.keys()) {
    const segments = relative.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  let identical = true;
  const foundFiles = new Set();
  async function compareDirectory(directory, relative = "") {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      const childPosix = toPosix(child);
      const expected = sourceFiles.get(childPosix);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!expectedDirectories.has(childPosix)) identical = false;
        await compareDirectory(directory, child);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        if (!expected) identical = false;
        else {
          foundFiles.add(childPosix);
          if (!expected.equals(await fs.readFile(path.join(directory, child)))) identical = false;
        }
      } else {
        identical = false;
      }
    }
  }
  await compareDirectory(destination);
  if (foundFiles.size !== sourceFiles.size) identical = false;
  return { status: identical ? "NO-OP" : "REPLACE", destination, sourceFiles };
}

async function inspectAgent(destination, sourceBytes) {
  const info = await lstatOrNull(destination);
  if (!info) return { status: "CREATE", destination, sourceBytes };
  if (info.isFile() && !info.isSymbolicLink()) {
    const current = await fs.readFile(destination);
    return { status: current.equals(sourceBytes) ? "NO-OP" : "REPLACE", destination, sourceBytes };
  }
  return { status: "REPLACE", destination, sourceBytes };
}

function staleSkillName(name) {
  // The repository's canonical workflow skill namespace is the `stnl-` prefix.
  return name.startsWith("stnl-")
    && !WORKFLOW_SKILLS.includes(name)
    && !DOMAIN_SKILLS.includes(name);
}

function staleAgentName(target, name) {
  return target === "codex"
    ? /^stnl_[a-z0-9_]+\.toml$/u.test(name) && !AGENT_FILES.codex.includes(name)
    : /^stnl-[a-z0-9-]+\.md$/u.test(name) && !AGENT_FILES.claude.includes(name);
}

export async function buildInstallPlan({ repositoryRoot = REPOSITORY_ROOT, home = os.homedir(), targets }) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.some((target) => !Object.hasOwn(AGENT_FILES, target))) {
    throw new Error("targets must contain codex and/or claude");
  }
  const platforms = [];
  const operations = [];
  for (const target of targets) {
    const rootName = target === "codex" ? ".codex" : ".claude";
    const destinationRoot = path.join(home, rootName);
    const rootInfo = await lstatOrNull(destinationRoot);
    if (rootInfo && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) {
      throw new Error(`platform home is not a regular directory: ${destinationRoot}`);
    }
    platforms.push({ target, destinationRoot });
    const skillsRoot = path.join(destinationRoot, "skills");
    const agentsRoot = path.join(destinationRoot, "agents");
    const skillEntries = await listImmediate(skillsRoot);
    const agentEntries = await listImmediate(agentsRoot);
    const currentSkills = new Map();
    for (const name of WORKFLOW_SKILLS) {
      currentSkills.set(name, await readSkillSource(repositoryRoot, name));
    }
    for (const name of WORKFLOW_SKILLS) {
      operations.push({
        kind: "skill",
        target,
        name,
        ...(await inspectSkill(path.join(skillsRoot, name), currentSkills.get(name))),
      });
    }
    for (const entry of skillEntries) {
      if (staleSkillName(entry.name) && entry.name !== "." && entry.name !== "..") {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          throw new Error(`ambiguous Sentinel skill entry; refusing removal: ${path.join(skillsRoot, entry.name)}`);
        }
        const destination = path.join(skillsRoot, entry.name);
        if (entry.isDirectory()) await inventoryTree(destination);
        operations.push({ kind: "remove", target, component: "stale skill", destination });
      }
    }
    const agents = await Promise.all(AGENT_FILES[target].map((name) => sourceAgent(repositoryRoot, target, name)));
    for (const agent of agents) {
      operations.push({
        kind: "agent",
        target,
        name: agent.name,
        ...(await inspectAgent(path.join(agentsRoot, agent.name), agent.bytes)),
      });
    }
    for (const entry of agentEntries) {
      if (staleAgentName(target, entry.name)) {
        if (!entry.isFile() && !entry.isSymbolicLink()) {
          throw new Error(`ambiguous Sentinel agent entry; refusing removal: ${path.join(agentsRoot, entry.name)}`);
        }
        operations.push({ kind: "remove", target, component: "stale agent", destination: path.join(agentsRoot, entry.name) });
      }
    }
  }
  operations.sort((left, right) => left.destination.localeCompare(right.destination, "en"));
  return { targets, repositoryRoot, platforms, operations };
}

export function summarize(plan) {
  const counts = { CREATE: 0, "NO-OP": 0, REPLACE: 0, REMOVE: 0 };
  for (const operation of plan.operations) {
    counts[operation.kind === "remove" ? "REMOVE" : operation.status] += 1;
  }
  return counts;
}

async function copySkill(destination, sourceFiles) {
  await fs.mkdir(destination, { recursive: true });
  for (const [relative, bytes] of sourceFiles) {
    const output = path.join(destination, relative);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, bytes, { mode: 0o644 });
  }
}

export async function applyInstallPlan(plan) {
  const applied = [];
  for (const [index, operation] of plan.operations.entries()) {
    if (operation.kind !== "remove" && operation.status !== "CREATE" && operation.status !== "REPLACE") continue;
    try {
      if (operation.kind === "remove" || operation.status === "REPLACE") {
        await fs.rm(operation.destination, { recursive: true, force: true });
      }
      if (operation.kind === "skill") {
        await copySkill(operation.destination, operation.sourceFiles);
      } else if (operation.kind === "agent") {
        await fs.mkdir(path.dirname(operation.destination), { recursive: true });
        await fs.writeFile(operation.destination, operation.sourceBytes, { mode: 0o644 });
      }
      applied.push(operation.destination);
    } catch (error) {
      const incomplete = plan.operations.slice(index)
        .filter((item) => item.kind === "remove" || item.status === "CREATE" || item.status === "REPLACE")
        .map((item) => item.destination);
      return { applied, blocked: true, incomplete, error };
    }
  }
  return { applied, blocked: false, incomplete: [] };
}

function printPlan(plan, preview) {
  const counts = summarize(plan);
  if (preview) {
    console.log(`Source: ${plan.repositoryRoot}`);
    console.log(`Targets: ${plan.platforms.map(({ target, destinationRoot }) => `${target} (${destinationRoot})`).join(", ")}`);
    console.log(`Components: ${plan.operations.length} — CREATE ${counts.CREATE}, NO-OP ${counts["NO-OP"]}, REPLACE ${counts.REPLACE}, REMOVE ${counts.REMOVE}`);
    for (const operation of plan.operations) {
      const status = operation.kind === "remove" ? "REMOVE" : operation.status;
      console.log(`${status.padEnd(8)} ${operation.destination}`);
    }
    console.log("Preview only. Run without --preview to apply listed replacements and removals.");
    return 0;
  }
  console.log(`Targets: ${plan.platforms.map(({ target }) => target).join(", ")}`);
  console.log(`Changes: CREATE ${counts.CREATE}, NO-OP ${counts["NO-OP"]}, REPLACE ${counts.REPLACE}, REMOVE ${counts.REMOVE}`);
  return null;
}

export async function main(argv, { repositoryRoot = REPOSITORY_ROOT, home = os.homedir() } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage().trimEnd());
    return 2;
  }
  try {
    // Build the full selected-target inventory before applying any removal or write.
    const plan = await buildInstallPlan({ repositoryRoot, home, targets: options.targets });
    const printed = printPlan(plan, options.preview);
    if (printed !== null) return printed;
    const result = await applyInstallPlan(plan);
    if (result.blocked) {
      console.error(`Apply stopped after ${result.applied.length} component(s); incomplete paths:`);
      for (const file of result.incomplete ?? []) console.error(`  ${file}`);
      if (result.error) console.error(result.error.message);
      return 1;
    }
    console.log(result.applied.length === 0
      ? "Installation complete: no changes needed."
      : `Installation complete: applied ${result.applied.length} component change(s).`);
    return 0;
  } catch (error) {
    console.error(`Installation could not be planned: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
