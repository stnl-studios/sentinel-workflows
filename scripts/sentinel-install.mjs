#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WORKFLOW_SKILLS, canonicalSkillRelativePath } from "./lib/skill-registry.mjs";

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

async function sourceEntries(repositoryRoot, target) {
  const result = [];
  for (const name of WORKFLOW_SKILLS) {
    const skillPath = canonicalSkillRelativePath(name);
    const sourceRoot = path.dirname(path.join(repositoryRoot, skillPath));
    for (const relative of await walkFiles(sourceRoot)) {
      result.push({
        source: path.join(sourceRoot, relative),
        sourceLabel: toPosix(path.relative(repositoryRoot, path.join(sourceRoot, relative))),
        destinationRelative: path.join("skills", name, relative),
      });
    }
  }

  const platformDirectory = target === "codex" ? "codex/.codex/agents" : "claude-code/.claude/agents";
  for (const file of AGENT_FILES[target]) {
    result.push({
      source: path.join(repositoryRoot, "agents", platformDirectory, file),
      sourceLabel: toPosix(path.join("agents", platformDirectory, file)),
      destinationRelative: path.join("agents", file),
    });
  }
  return result.sort((left, right) => left.destinationRelative.localeCompare(right.destinationRelative, "en"));
}

async function inspectDestination(root, relative, expected) {
  const destination = path.join(root, relative);
  const components = path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean);
  let parent = root;
  for (const component of components) {
    parent = path.join(parent, component);
    try {
      const info = await fs.lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return { status: "CONFLICT", reason: "destination parent is not a regular directory" };
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }

  try {
    const info = await fs.lstat(destination);
    if (!info.isFile() || info.isSymbolicLink()) {
      return { status: "CONFLICT", reason: "destination is not a regular file" };
    }
    const current = await fs.readFile(destination);
    return current.equals(expected)
      ? { status: "NO-OP" }
      : { status: "CONFLICT", reason: "destination bytes differ" };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "CREATE" };
    throw error;
  }
}

export async function buildInstallPlan({ repositoryRoot = REPOSITORY_ROOT, home = os.homedir(), targets }) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.some((target) => !Object.hasOwn(AGENT_FILES, target))) {
    throw new Error("targets must contain codex and/or claude");
  }
  const entries = [];
  const platforms = [];
  for (const target of targets) {
    const rootName = target === "codex" ? ".codex" : ".claude";
    const destinationRoot = path.join(home, rootName);
    const rootInfo = await fs.lstat(destinationRoot).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const rootConflict = rootInfo !== null && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink());
    platforms.push({ target, destinationRoot });
    for (const item of await sourceEntries(repositoryRoot, target)) {
      const bytes = await fs.readFile(item.source);
      const checked = rootConflict
        ? { status: "CONFLICT", reason: "platform home is not a regular directory" }
        : await inspectDestination(destinationRoot, item.destinationRelative, bytes);
      entries.push({ ...item, target, destinationRoot,
        destination: path.join(destinationRoot, item.destinationRelative), bytes, ...checked });
    }
  }
  return { targets, repositoryRoot, platforms, entries };
}

export function summarize(plan) {
  const counts = { CREATE: 0, "NO-OP": 0, CONFLICT: 0 };
  for (const entry of plan.entries) counts[entry.status] += 1;
  return counts;
}

export async function applyInstallPlan(plan) {
  const conflicts = plan.entries.filter((entry) => entry.status === "CONFLICT");
  if (conflicts.length > 0) return { applied: [], blocked: true, conflicts };

  const applied = [];
  for (const entry of plan.entries) {
    if (entry.status !== "CREATE") continue;
    let handle;
    try {
      await fs.mkdir(path.dirname(entry.destination), { recursive: true });
      handle = await fs.open(entry.destination, "wx", 0o644);
      await handle.writeFile(entry.bytes);
      await handle.close();
      applied.push(entry.destination);
    } catch (error) {
      await handle?.close().catch(() => {});
      const incomplete = plan.entries
        .filter((item) => item.status === "CREATE" && !applied.includes(item.destination))
        .map((item) => item.destination);
      return { applied, blocked: true, incomplete, error };
    }
  }
  return { applied, blocked: false, incomplete: [] };
}

function printPlan(plan, apply) {
  const counts = summarize(plan);
  console.log(`Source: ${plan.repositoryRoot}`);
  console.log(`Targets: ${plan.platforms.map(({ target, destinationRoot }) => `${target} (${destinationRoot})`).join(", ")}`);
  console.log(`Files: ${plan.entries.length} — CREATE ${counts.CREATE}, NO-OP ${counts["NO-OP"]}, CONFLICT ${counts.CONFLICT}`);
  for (const entry of plan.entries) {
    console.log(`${entry.status.padEnd(8)} ${entry.destination}`);
    if (entry.reason) console.log(`         ${entry.reason}`);
  }
  if (counts.CONFLICT > 0) {
    console.error("Blocked: resolve every conflict before applying; no files were written.");
    return 1;
  }
  if (!apply) {
    console.log("Preview only. Run without --preview to create missing files.");
    return 0;
  }
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
    const plan = await buildInstallPlan({ repositoryRoot, home, targets: options.targets });
    const printed = printPlan(plan, !options.preview);
    if (printed !== null) return printed;
    const result = await applyInstallPlan(plan);
    if (result.blocked) {
      console.error(`Apply stopped after ${result.applied.length} file(s); incomplete paths:`);
      for (const file of result.incomplete ?? []) console.error(`  ${file}`);
      if (result.error) console.error(result.error.message);
      return 1;
    }
    console.log(`Applied ${result.applied.length} new file(s).`);
    return 0;
  } catch (error) {
    console.error(`Installation could not be planned: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
