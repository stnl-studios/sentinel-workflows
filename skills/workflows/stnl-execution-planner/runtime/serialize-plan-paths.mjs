#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";

import {
  validateExecutionCandidate,
  resolveExecutionWorkspace,
  resolvePhysicalImplementationTarget,
  resolveSemanticPhysicalImplementationTarget,
} from "./execution-state.mjs";

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function blocked(message) {
  throw new Error(`plan path serialization blocked: ${message}`);
}

function sectionBounds(text, heading, label) {
  const marker = `## ${heading}\n\n`;
  const start = text.indexOf(marker);
  if (start < 0) blocked(`${label} is missing ## ${heading}`);
  const bodyStart = start + marker.length;
  const nextHeading = text.indexOf("\n## ", bodyStart);
  return {
    start,
    bodyStart,
    end: nextHeading < 0 ? text.length : nextHeading,
    value: text.slice(bodyStart, nextHeading < 0 ? text.length : nextHeading),
  };
}

function codeSpans(value) {
  return [...String(value).matchAll(/`([^`\n]+)`/gu)].map((match) => {
    const raw = match[1];
    // A model may escape the closing Markdown fence as `\\``. Inside these
    // path-only carriers that final backslash is delimiter syntax, not part of
    // the semantic repository-relative target. Interior backslashes remain
    // untouched and are rejected by the existing semantic path authority.
    return raw.endsWith("\\") && !raw.slice(0, -1).includes("\\")
      ? raw.slice(0, -1)
      : raw;
  });
}

function serialPlanTargets(text) {
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
    rows.push({ slice: `slice-${slice}`, lineIndex: index, claims: codeSpans(columns[4]) });
  }
  if (rows.length === 0) blocked("plan.md has no serial slice rows");
  return { section, rows };
}

function rewriteDetailedClaims(text, claims, label) {
  const section = sectionBounds(text, "Likely Areas", label);
  let index = 0;
  const value = section.value.replace(/`([^`\n]+)`/gu, () => {
    if (index >= claims.length) blocked(`${label} contains more path claims than its global slice row`);
    const replacement = `\`${claims[index]}\``;
    index += 1;
    return replacement;
  });
  if (index !== claims.length) blocked(`${label} has ${index} path claims but its global slice row has ${claims.length}`);
  return `${text.slice(0, section.bodyStart)}${value}${text.slice(section.end)}`;
}

function rewriteGlobalClaims(text, rows, canonicalClaimsBySlice, label) {
  const section = sectionBounds(text, "Serial Slice Order", label);
  const lines = section.value.split("\n");
  for (const row of rows) {
    const claims = canonicalClaimsBySlice.get(row.slice);
    if (claims === undefined) blocked(`${label} has no serialized claims for ${row.slice}`);
    const parts = lines[row.lineIndex].split("|");
    const cell = parts[5];
    if (cell === undefined) blocked(`${label} has no Expected areas cell for ${row.slice}`);
    let index = 0;
    parts[5] = cell.replace(/`([^`\n]+)`/gu, () => {
      if (index >= claims.length) blocked(`${label} contains more path claims than ${row.slice}`);
      const replacement = `\`${claims[index]}\``;
      index += 1;
      return replacement;
    });
    if (index !== claims.length) blocked(`${label} has ${index} path claims but ${row.slice} has ${claims.length}`);
    lines[row.lineIndex] = parts.join("|");
  }
  return `${text.slice(0, section.bodyStart)}${lines.join("\n")}${text.slice(section.end)}`;
}

function canonicalClaim(artifact, physicalTarget, label) {
  const claim = path.relative(path.dirname(artifact), physicalTarget).split(path.sep).join("/");
  if (claim === "" || claim === "." || path.posix.isAbsolute(claim) || claim.includes("\\")) {
    blocked(`${label} produced a non-relative canonical claim`);
  }
  return claim;
}

async function selectedPhysicalTarget(specPath, artifact, field, raw) {
  if (raw.startsWith(".")) {
    return resolvePhysicalImplementationTarget(specPath, { artifact, field, raw });
  }
  return resolveSemanticPhysicalImplementationTarget(specPath, { raw });
}

export async function serializePlanPathClaims({ specPath, candidateExecutionRoot }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const candidate = path.resolve(String(candidateExecutionRoot));
  const candidateMetadata = await fs.lstat(candidate).catch(() => null);
  if (candidateMetadata === null || candidateMetadata.isSymbolicLink() || !candidateMetadata.isDirectory()) {
    blocked(`candidate execution root is not a real directory: ${candidate}`);
  }
  if (pathIsWithin(candidate, workspace.executionRoot) || pathIsWithin(workspace.executionRoot, candidate)) {
    blocked("candidate execution root is not isolated from live execution artifacts");
  }

  const planPath = path.join(candidate, "plan.md");
  const planText = await fs.readFile(planPath, "utf8").catch(() => blocked(`candidate is missing ${planPath}`));
  const { rows } = serialPlanTargets(planText);
  const liveGlobalArtifact = path.join(workspace.executionRoot, "plan.md");
  const updates = [];
  const canonicalClaimsBySlice = new Map();
  let serializedClaims = 0;

  for (const row of rows) {
    const detailPath = path.join(candidate, "plans", `${row.slice}.md`);
    const detailText = await fs.readFile(detailPath, "utf8").catch(() => blocked(`candidate is missing ${detailPath}`));
    if (row.claims.length === 0) {
      if (codeSpans(sectionBounds(detailText, "Likely Areas", `${row.slice} plan`).value).length !== 0) {
        blocked(`${row.slice} plan has detailed path claims without global target selections`);
      }
      canonicalClaimsBySlice.set(row.slice, []);
      continue;
    }
    const liveDetailArtifact = path.join(workspace.executionRoot, "plans", `${row.slice}.md`);
    const targets = await Promise.all(row.claims.map((raw) => selectedPhysicalTarget(
      specPath,
      liveGlobalArtifact,
      `plan.md Serial Slice Order ${row.slice} Expected areas`,
      raw,
    )));
    const globalClaims = targets.map((target) => canonicalClaim(
      liveGlobalArtifact,
      target.physicalTarget,
      `plan.md Serial Slice Order ${row.slice} Expected areas`,
    ));
    canonicalClaimsBySlice.set(row.slice, globalClaims);
    const canonicalClaims = targets.map((target) => {
      return canonicalClaim(liveDetailArtifact, target.physicalTarget, `${row.slice} plan Likely Areas`);
    });
    const serialized = rewriteDetailedClaims(detailText, canonicalClaims, `${row.slice} plan Likely Areas`);
    updates.push({ path: detailPath, before: detailText, after: serialized });
    serializedClaims += canonicalClaims.length;
  }

  const serializedPlan = rewriteGlobalClaims(planText, rows, canonicalClaimsBySlice, "plan.md Serial Slice Order");
  updates.push({ path: planPath, before: planText, after: serializedPlan });

  for (const update of updates) {
    if (update.before === update.after) continue;
    const temporary = `${update.path}.stnl-plan-paths-${process.pid}.tmp`;
    await fs.writeFile(temporary, update.after, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, update.path);
  }
  const candidateValidation = await validateExecutionCandidate(specPath, candidate);
  return Object.freeze({
    status: "PASS",
    changedPaths: Object.freeze(updates.filter((update) => update.before !== update.after).map((update) => update.path)),
    serializedClaims,
    candidateValidation: Object.freeze({
      state: candidateValidation.state,
      currentFingerprint: candidateValidation.currentFingerprint,
    }),
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 4 || arguments_[0] !== "--spec-path" || arguments_[2] !== "--candidate-execution-root") {
    throw new Error("usage: serialize-plan-paths.mjs --spec-path SPEC_PATH --candidate-execution-root CANDIDATE_EXECUTION_ROOT");
  }
  const result = await serializePlanPathClaims({ specPath: arguments_[1], candidateExecutionRoot: arguments_[3] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
