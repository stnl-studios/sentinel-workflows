import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  installSentinel,
  planSentinelDistribution,
  resolveInstallationScope,
  resolvePlatformSelection,
  resolveSentinelInstallationRoot,
  summarizePlan,
} from "./lib/sentinel-distribution.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "usage: node scripts/install-sentinel.mjs [--scope <user|project>] [--platform <all|codex|claude-code>] [--project <path>] [--dry-run] [--json]",
    "",
    "defaults: --scope user --platform all",
    "--project <path> without --scope is a backwards-compatible project-scope shorthand",
    "--json emits the complete structured result; dry-run remains detailed by default",
    "",
  ].join("\n");
}

export function parseInstallArguments(argv) {
  let scope;
  let platform = "all";
  let projectRoot;
  let dryRun = false;
  let json = false;
  let help = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("duplicate argument: --dry-run");
      dryRun = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new Error("duplicate argument: --json");
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!["--scope", "--platform", "--project"].includes(argument)) throw new Error(`unknown argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    index += 1;
    if (argument === "--scope") scope = value;
    else if (argument === "--platform") platform = value;
    else projectRoot = value;
  }
  if (help) return { help: true };
  const normalizedScope = resolveInstallationScope(scope ?? (projectRoot === undefined ? "user" : "project"));
  resolvePlatformSelection(platform);
  if (normalizedScope === "user" && projectRoot !== undefined) throw new Error("--project cannot be used with user scope");
  if (normalizedScope === "project" && projectRoot === undefined) throw new Error("project scope requires --project <path>");
  return { dryRun, json, scope: normalizedScope, platform, projectRoot: projectRoot === undefined ? undefined : path.resolve(projectRoot) };
}

export function renderInstallResult(result) {
  const lines = [result.status === "unchanged" ? "✓ Sentinel already up to date" : "✓ Sentinel installed"];
  lines.push("", `Scope: ${result.scope}`, `Platforms: ${result.platforms.join(", ")}`);
  if (result.status === "installed") lines.push(`Files: ${result.files.length}`);
  if (result.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runInstallCli(argv, options = {}) {
  const parsed = parseInstallArguments(argv);
  if (parsed.help) return { help: true, output: usage() };
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const homeDirectory = options.homeDirectory ?? os.homedir;
  const installationRoot = await resolveSentinelInstallationRoot({
    scope: parsed.scope,
    projectRoot: parsed.projectRoot,
    homeDirectory,
  });
  const rootFields = {
    installationRoot,
    installationRootType: parsed.scope === "user" ? "user-home" : "project",
  };
  if (parsed.dryRun) {
    const plan = await planSentinelDistribution({
      repositoryRoot,
      scope: parsed.scope,
      platform: parsed.platform,
    });
    return { mode: "dry-run", ...rootFields, ...summarizePlan(plan) };
  }
  const result = await installSentinel({
    repositoryRoot,
    scope: parsed.scope,
    projectRoot: parsed.projectRoot,
    platform: parsed.platform,
    homeDirectory,
  });
  return { status: result.changed ? "installed" : "unchanged", ...rootFields, ...result };
}

async function main() {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseInstallArguments(argv);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runInstallCli(argv);
    if (result.help) process.stdout.write(result.output);
    else if (parsed.json || parsed.dryRun) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(renderInstallResult(result));
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
