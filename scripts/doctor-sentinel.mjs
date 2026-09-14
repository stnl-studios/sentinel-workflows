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
    "usage: node scripts/doctor-sentinel.mjs [--scope <user|project>] [--platform <all|codex|claude-code>] [--project <path>] [--json]",
    "       node scripts/doctor-sentinel.mjs --source-only [--json]",
    "",
    "defaults: --scope user --platform all",
    "--project <path> without --scope preserves legacy project-installation diagnosis",
    "--json emits the complete structured report",
    "",
  ].join("\n");
}

export function parseDoctorArguments(argv) {
  let sourceOnly = false;
  let scope;
  let platform;
  let projectRoot;
  let json = false;
  let help = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--source-only") {
      if (sourceOnly) throw new Error("duplicate argument: --source-only");
      sourceOnly = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new Error("duplicate argument: --json");
      json = true;
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
  if (help) return { help: true };
  if (sourceOnly) {
    if (scope !== undefined || platform !== undefined || projectRoot !== undefined) throw new Error("--source-only cannot be combined with installation options");
    return { sourceOnly: true, json };
  }
  const explicitScope = scope !== undefined;
  const normalizedScope = resolveInstallationScope(scope ?? (projectRoot === undefined ? "user" : "project"));
  if (platform !== undefined) resolvePlatformSelection(platform);
  if (normalizedScope === "user" && projectRoot !== undefined) throw new Error("--project cannot be used with user scope");
  if (normalizedScope === "project" && projectRoot === undefined) throw new Error("project scope requires --project <path>");
  return {
    sourceOnly: false,
    json,
    scope: normalizedScope,
    platform: platform ?? (explicitScope || normalizedScope === "user" ? "all" : undefined),
    projectRoot,
  };
}

function writeJsonReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const ISSUE_PRIORITY = Object.freeze({
  PLATFORM_SELECTION_DRIFT: 0,
  INSTALLATION_SCOPE_DRIFT: 1,
  MANAGED_BYTES_DRIFT: 2,
  MISSING_MANAGED_FILE: 3,
  STALE_MANAGED_SKILL_FILE: 4,
  OPPOSITE_PLATFORM_ARTIFACT: 5,
  UNSAFE_MANAGED_PATH: 6,
});

function humanFindingMessage(finding) {
  if (finding.code === "FINGERPRINT_DRIFT") return "installed content identity differs from the current source";
  return finding.message;
}

function appendFindings(lines, label, findings, { limit } = {}) {
  if (!findings?.length) return;
  const visible = limit === undefined ? findings : findings.slice(0, limit);
  lines.push("", `${label}:`);
  for (const finding of visible) lines.push(`- ${humanFindingMessage(finding)}`);
  if (visible.length < findings.length) lines.push(`- ${findings.length - visible.length} additional issues; run with --json for complete details`);
}

export function renderDoctorReport(report) {
  if (report.mode === "source-only") {
    const defaultInstallation = report.source.defaultInstallation;
    return [
      "✓ Sentinel source healthy",
      "",
      `Platforms: ${defaultInstallation.platforms.join(", ")}`,
      `Default installation: ${defaultInstallation.status}`,
      "",
    ].join("\n");
  }

  const installation = report.installation;
  const lines = [report.status === "OK"
    ? "✓ Sentinel healthy"
    : report.status === "DRIFT"
      ? "✗ Sentinel drift detected"
      : "! Sentinel blocked"];

  if (installation) {
    const platforms = installation.expected?.platforms
      ?? installation.manifest?.platforms
      ?? report.source?.defaultInstallation?.platforms;
    lines.push("", `Scope: ${installation.scope}`);
    if (platforms) lines.push(`Platforms: ${platforms.join(", ")}`);
    if (report.status === "OK") lines.push(`Source: ${report.source.status}`);
    lines.push(`Installation: ${installation.liveStatus}`);
    const issues = [...(installation.issues ?? [])].sort((left, right) =>
      (ISSUE_PRIORITY[left.code] ?? 100) - (ISSUE_PRIORITY[right.code] ?? 100));
    appendFindings(lines, "Issues", issues, { limit: 12 });
    appendFindings(lines, "Blockers", installation.blockers);
    appendFindings(lines, "Warnings", installation.warnings);
  } else {
    appendFindings(lines, "Blockers", report.blockers);
    appendFindings(lines, "Warnings", report.warnings);
  }
  return `${lines.join("\n")}\n`;
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
  let parsed;
  try {
    parsed = parseDoctorArguments(argv);
  } catch (error) {
    const report = { status: "BLOCKED", mode: "arguments", blockers: [{ code: "INVALID_ARGUMENTS", message: error.message }] };
    if (argv.includes("--json")) writeJsonReport(report);
    else process.stdout.write(renderDoctorReport(report));
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
    if (parsed.json) writeJsonReport(report);
    else process.stdout.write(renderDoctorReport(report));
    if (report.status === "DRIFT") process.exitCode = 1;
    else if (report.status === "BLOCKED") process.exitCode = 2;
  } catch (error) {
    const report = {
      status: "BLOCKED",
      mode: "installation",
      blockers: [{ code: "SOURCE_INVALID", message: error.message }],
    };
    if (parsed.json) writeJsonReport(report);
    else process.stdout.write(renderDoctorReport(report));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
