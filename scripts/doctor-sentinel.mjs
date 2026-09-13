import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  doctorSentinelInstallation,
  doctorSentinelSource,
} from "./lib/sentinel-doctor.mjs";
import {
  resolveInstallationScope,
  resolvePlatformSelection,
} from "./lib/sentinel-distribution.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "usage: node scripts/doctor-sentinel.mjs [--scope <user|project>] [--platform <all|codex|claude-code>] [--project <path>]",
    "       node scripts/doctor-sentinel.mjs --source-only",
    "",
    "defaults: --scope user --platform all",
    "--project <path> without --scope preserves legacy project-installation diagnosis",
    "",
  ].join("\n");
}

export function parseDoctorArguments(argv) {
  let sourceOnly = false;
  let scope;
  let platform;
  let projectRoot;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--source-only") {
      if (sourceOnly) throw new Error("duplicate argument: --source-only");
      sourceOnly = true;
      continue;
    }
    if (!["--scope", "--platform", "--project"].includes(argument)) throw new Error(`unknown argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    if (argument === "--scope") scope = value;
    else if (argument === "--platform") platform = value;
    else projectRoot = path.resolve(value);
    index += 1;
  }
  if (sourceOnly) {
    if (scope !== undefined || platform !== undefined || projectRoot !== undefined) throw new Error("--source-only cannot be combined with installation options");
    return { sourceOnly: true };
  }
  const explicitScope = scope !== undefined;
  const normalizedScope = resolveInstallationScope(scope ?? (projectRoot === undefined ? "user" : "project"));
  if (platform !== undefined) resolvePlatformSelection(platform);
  if (normalizedScope === "user" && projectRoot !== undefined) throw new Error("--project cannot be used with user scope");
  if (normalizedScope === "project" && projectRoot === undefined) throw new Error("project scope requires --project <path>");
  return {
    sourceOnly: false,
    scope: normalizedScope,
    platform: platform ?? (explicitScope || normalizedScope === "user" ? "all" : undefined),
    projectRoot,
  };
}

function writeReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function runDoctorCli(argv, options = {}) {
  const parsed = parseDoctorArguments(argv);
  if (parsed.help) return { help: true, output: usage() };
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const homeDirectory = options.homeDirectory ?? os.homedir;
  return parsed.sourceOnly
    ? doctorSentinelSource({ repositoryRoot })
    : doctorSentinelInstallation({
      repositoryRoot,
      scope: parsed.scope,
      projectRoot: parsed.projectRoot,
      platform: parsed.platform,
      homeDirectory,
    });
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    parseDoctorArguments(argv);
  } catch (error) {
    writeReport({ status: "BLOCKED", mode: "arguments", blockers: [{ code: "INVALID_ARGUMENTS", message: error.message }] });
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const report = await runDoctorCli(argv);
    if (report.help) {
      process.stdout.write(report.output);
      return;
    }
    writeReport(report);
    if (report.status === "DRIFT") process.exitCode = 1;
    else if (report.status === "BLOCKED") process.exitCode = 2;
  } catch (error) {
    writeReport({
      status: "BLOCKED",
      mode: "installation",
      blockers: [{ code: "SOURCE_INVALID", message: error.message }],
    });
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
