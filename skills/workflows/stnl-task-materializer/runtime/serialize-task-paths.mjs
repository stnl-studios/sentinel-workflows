#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";

import {
  inspectExecutionState,
  resolveExecutionWorkspace,
  resolvePhysicalImplementationTarget,
} from "./execution-state.mjs";

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function blocked(message) {
  throw new Error(`task path serialization blocked: ${message}`);
}

function sectionBounds(text, heading, label) {
  const marker = `## ${heading}\n\n`;
  const start = text.indexOf(marker);
  if (start < 0) blocked(`${label} is missing ## ${heading}`);
  const bodyStart = start + marker.length;
  const nextHeading = text.indexOf("\n## ", bodyStart);
  return {
    bodyStart,
    end: nextHeading < 0 ? text.length : nextHeading,
    value: text.slice(bodyStart, nextHeading < 0 ? text.length : nextHeading),
  };
}

function codeSpans(value) {
  return [...String(value).matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
}

function serialSlices(text) {
  const section = sectionBounds(text, "Serial Slice Order", "plan.md");
  const lines = section.value.split("\n");
  const header = "| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |";
  const separator = "|---|---|---|---|---|---|";
  const headerIndex = lines.indexOf(header);
  if (headerIndex < 0 || lines[headerIndex + 1] !== separator) blocked("plan.md has no canonical Serial Slice Order table");
  const rows = [];
  for (let index = headerIndex + 2; index < lines.length && lines[index].startsWith("|"); index += 1) {
    const columns = lines[index].split("|").slice(1, -1).map((column) => column.trim());
    const slice = columns[0]?.match(/^([0-9]{2,}) - \S.*$/u)?.[1];
    if (columns.length !== 6 || slice === undefined || columns[5] !== `plans/slice-${slice}.md`) {
      blocked(`plan.md has malformed slice row: ${lines[index]}`);
    }
    rows.push(`slice-${slice}`);
  }
  if (rows.length === 0) blocked("plan.md has no serial slice rows");
  return rows;
}

function checklistRows(text, label) {
  const section = sectionBounds(text, "Checklist", label);
  return section.value.split("\n")
    .filter((line) => line.length !== 0)
    .map((line) => {
      const marker = " | expected areas: ";
      const start = line.indexOf(marker);
      const end = line.indexOf(" | requirement: ", start + marker.length);
      if (!line.startsWith("- [") || start < 0 || end < 0) blocked(`${label} has malformed Checklist expected areas`);
      return {
        line,
        start: start + marker.length,
        end,
        claims: codeSpans(line.slice(start + marker.length, end)),
      };
    });
}

function canonicalClaim(artifact, physicalTarget, label) {
  const claim = path.relative(path.dirname(artifact), physicalTarget).split(path.sep).join("/");
  if (claim === "" || claim === "." || path.posix.isAbsolute(claim) || claim.includes("\\")) {
    blocked(`${label} produced a non-relative canonical claim`);
  }
  return claim;
}

function rewriteCodeSpans(value, claims, label) {
  let claimIndex = 0;
  const rewritten = value.replace(/`([^`\n]+)`/gu, () => {
    if (claimIndex >= claims.length) blocked(`${label} contains more path claims than its approved plan`);
    const replacement = `\`${claims[claimIndex]}\``;
    claimIndex += 1;
    return replacement;
  });
  if (claimIndex !== claims.length) blocked(`${label} has ${claimIndex} task path claims but its approved plan has ${claims.length}`);
  return rewritten;
}

function rewriteChecklistClaims(text, rows, claims, label) {
  const section = sectionBounds(text, "Checklist", label);
  let claimIndex = 0;
  const rewritten = section.value.split("\n").map((line) => {
    if (line.length === 0) return line;
    const row = rows.shift();
    if (row === undefined) blocked(`${label} has more checklist rows than its parsed candidate`);
    if (row.claims.length === 0) return line;
    const replacement = claims.slice(claimIndex, claimIndex + row.claims.length);
    if (replacement.length !== row.claims.length) blocked(`${label} has more task path claims than its approved plan`);
    claimIndex += row.claims.length;
    const area = line.slice(row.start, row.end);
    const rewrittenArea = rewriteCodeSpans(area, replacement, `${label} row`);
    return `${line.slice(0, row.start)}${rewrittenArea}${line.slice(row.end)}`;
  });
  if (claimIndex !== claims.length) blocked(`${label} has ${claimIndex} task path claims but its approved plan has ${claims.length}`);
  return `${text.slice(0, section.bodyStart)}${rewritten.join("\n")}${text.slice(section.end)}`;
}

export async function serializeTaskPathClaims({ specPath, candidateExecutionRoot }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const candidate = path.resolve(String(candidateExecutionRoot));
  const candidateMetadata = await fs.lstat(candidate).catch(() => null);
  if (candidateMetadata === null || candidateMetadata.isSymbolicLink() || !candidateMetadata.isDirectory()) {
    blocked(`candidate execution root is not a real directory: ${candidate}`);
  }
  if (pathIsWithin(candidate, workspace.executionRoot) || pathIsWithin(workspace.executionRoot, candidate)) {
    blocked("candidate execution root is not isolated from live execution artifacts");
  }

  const planPath = path.join(workspace.executionRoot, "plan.md");
  const planText = await fs.readFile(planPath, "utf8").catch(() => blocked(`live execution is missing ${planPath}`));
  const slices = serialSlices(planText);
  const liveState = await inspectExecutionState(specPath);
  const updates = [];
  let serializedClaims = 0;

  for (const slice of slices) {
    const livePlanArtifact = path.join(workspace.executionRoot, "plans", `${slice}.md`);
    const approvedPlan = await fs.readFile(livePlanArtifact, "utf8").catch(() => blocked(`live execution is missing ${livePlanArtifact}`));
    const approvedClaims = codeSpans(sectionBounds(approvedPlan, "Likely Areas", `${slice} plan`).value);
    const taskPath = path.join(candidate, "tasks", `${slice}.md`);
    const taskText = await fs.readFile(taskPath, "utf8").catch(() => blocked(`candidate is missing ${taskPath}`));
    const taskRows = checklistRows(taskText, `${slice} task`);
    const taskClaims = taskRows.flatMap((row) => row.claims);

    const liveTaskPath = path.join(workspace.executionRoot, "tasks", `${slice}.md`);
    const liveTaskMetadata = await fs.lstat(liveTaskPath).catch(() => null);
    const historicalTask = liveTaskMetadata !== null && liveState.state !== "MATERIALIZED_PRISTINE";
    if (historicalTask) {
      const liveTask = await fs.readFile(liveTaskPath);
      const candidateTask = await fs.readFile(taskPath);
      if (!candidateTask.equals(liveTask)) blocked(`${slice} historical task changed during materialization`);
      continue;
    }

    if (taskClaims.length !== approvedClaims.length) {
      blocked(`${slice} task has ${taskClaims.length} path claims but its approved plan has ${approvedClaims.length}`);
    }
    const canonicalClaims = await Promise.all(approvedClaims.map(async (raw) => {
      const target = await resolvePhysicalImplementationTarget(specPath, {
        artifact: livePlanArtifact,
        field: `${slice} plan Likely Areas`,
        raw,
      });
      return canonicalClaim(path.join(workspace.executionRoot, "tasks", `${slice}.md`), target.physicalTarget, `${slice} task Checklist`);
    }));
    const rewritten = rewriteChecklistClaims(taskText, taskRows, canonicalClaims, `${slice} task Checklist`);
    updates.push({ path: taskPath, before: taskText, after: rewritten });
    serializedClaims += canonicalClaims.length;
  }

  for (const update of updates) {
    if (update.before === update.after) continue;
    const temporary = `${update.path}.stnl-task-paths-${process.pid}.tmp`;
    await fs.writeFile(temporary, update.after, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, update.path);
  }
  return Object.freeze({
    status: "PASS",
    changedPaths: Object.freeze(updates.filter((update) => update.before !== update.after).map((update) => update.path)),
    serializedClaims,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 4 || arguments_[0] !== "--spec-path" || arguments_[2] !== "--candidate-execution-root") {
    throw new Error("usage: serialize-task-paths.mjs --spec-path SPEC_PATH --candidate-execution-root CANDIDATE_EXECUTION_ROOT");
  }
  const result = await serializeTaskPathClaims({ specPath: arguments_[1], candidateExecutionRoot: arguments_[3] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
