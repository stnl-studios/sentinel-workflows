import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  doctorSentinelInstallation,
  doctorSentinelSource,
} from "./lib/sentinel-doctor.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return "usage: node scripts/doctor-sentinel.mjs (--source-only | --project <path>)\n";
}

function parseArguments(argv) {
  let sourceOnly = false;
  let projectRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--source-only") {
      sourceOnly = true;
      continue;
    }
    if (argument !== "--project") throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("missing value for --project");
    projectRoot = path.resolve(value);
    index += 1;
  }
  if (sourceOnly === Boolean(projectRoot)) throw new Error("choose exactly one of --source-only or --project <path>");
  return { sourceOnly, projectRoot };
}

function writeReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    writeReport({ status: "BLOCKED", mode: "arguments", blockers: [{ code: "INVALID_ARGUMENTS", message: error.message }] });
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  try {
    const report = options.sourceOnly
      ? await doctorSentinelSource({ repositoryRoot: REPOSITORY_ROOT })
      : await doctorSentinelInstallation({ repositoryRoot: REPOSITORY_ROOT, projectRoot: options.projectRoot });
    writeReport(report);
    if (report.status === "DRIFT") process.exitCode = 1;
    else if (report.status === "BLOCKED") process.exitCode = 2;
  } catch (error) {
    writeReport({
      status: "BLOCKED",
      mode: options.sourceOnly ? "source-only" : "installed-project",
      blockers: [{ code: "SOURCE_INVALID", message: error.message }],
    });
    process.exitCode = 2;
  }
}

await main();
