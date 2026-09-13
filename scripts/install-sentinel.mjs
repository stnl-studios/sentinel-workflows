import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  installSentinel,
  planSentinelDistribution,
  summarizePlan,
} from "./lib/sentinel-distribution.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return "usage: node scripts/install-sentinel.mjs --platform <codex|claude-code> --project <path> [--dry-run]\n";
}

function parseArguments(argv) {
  let platform;
  let projectRoot;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument !== "--platform" && argument !== "--project") throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    index += 1;
    if (argument === "--platform") platform = value;
    else projectRoot = value;
  }
  if (!platform || !projectRoot) throw new Error("--platform and --project are required");
  if (!new Set(["codex", "claude-code"]).has(platform)) throw new Error(`unsupported platform: ${platform}`);
  return { dryRun, platform, projectRoot: path.resolve(projectRoot) };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  try {
    const projectMetadata = await fs.lstat(options.projectRoot);
    if (!projectMetadata.isDirectory() || projectMetadata.isSymbolicLink()) {
      throw new Error(`project root must be an existing real directory: ${options.projectRoot}`);
    }
    if (options.dryRun) {
      const plan = await planSentinelDistribution({ repositoryRoot: REPOSITORY_ROOT, platform: options.platform });
      process.stdout.write(`${JSON.stringify({ mode: "dry-run", project: await fs.realpath(options.projectRoot), ...summarizePlan(plan) }, null, 2)}\n`);
      return;
    }
    const result = await installSentinel({
      repositoryRoot: REPOSITORY_ROOT,
      projectRoot: options.projectRoot,
      platform: options.platform,
    });
    process.stdout.write(`${JSON.stringify({ status: result.changed ? "installed" : "unchanged", project: await fs.realpath(options.projectRoot), ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

await main();
