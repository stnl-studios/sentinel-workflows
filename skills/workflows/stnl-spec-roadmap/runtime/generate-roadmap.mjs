#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ValidationError,
  decodeUtf8,
  formattedJson,
  readStrictJsonFile,
  requireSingleLinkRealFile,
  resolveRoadmap,
} from "./lib/core.mjs";
import { hydrateSourceFingerprints, validateReconcile, validateRoadmap } from "./lib/model.mjs";
import { projectRoadmap, snapshotAuthorityInputs } from "./lib/projection.mjs";
import { inspectPublishedRoadmap, publishRoadmap, recoverRoadmapPublication } from "./lib/publish.mjs";
import { renderRoadmap } from "./lib/render.mjs";
import { parseStrictJson } from "./lib/lifecycle/strict-json.mjs";

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readExternalCandidate(candidatePath, context) {
  const requested = path.resolve(String(candidatePath));
  await requireSingleLinkRealFile(requested, "candidate roadmap model");
  const physical = await fs.realpath(requested);
  if (isInside(context.projectRoot, physical)) {
    throw new ValidationError("candidate roadmap model must be an ephemeral file outside PROJECT_ROOT");
  }
  return (await readStrictJsonFile(physical, "candidate roadmap model")).value;
}

function parsePublishedModel(published, roadmapPath) {
  try {
    return validateRoadmap(parseStrictJson(
      decodeUtf8(published.model, "roadmap.json"),
      (key) => `roadmap.json contains duplicate JSON key '${key}'`,
      (constant) => `roadmap.json contains unsupported JSON constant '${constant}'`,
    ), { roadmapPath });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`roadmap.json is invalid JSON: ${error.message}`);
  }
}

export async function generateRoadmap({
  operation,
  projectRoot,
  candidatePath,
  expectedFingerprint = null,
  expectedAuthorityFingerprint = null,
  roadmapPath,
}) {
  if (!new Set(["INIT", "RECONCILE"]).has(operation)) {
    throw new ValidationError(`unsupported roadmap operation: ${operation}`);
  }
  const context = await resolveRoadmap(projectRoot, roadmapPath);
  await recoverRoadmapPublication(context);
  const published = await inspectPublishedRoadmap(context);
  if (operation === "INIT" && published !== null) throw new ValidationError(`INIT target already exists: ${context.roadmapPath}`);
  if (operation === "RECONCILE" && published === null) throw new ValidationError(`RECONCILE target does not exist: ${context.roadmapPath}`);

  const previous = operation === "RECONCILE" ? parsePublishedModel(published, context.roadmapPath) : null;
  if (previous !== null) {
    if (typeof expectedAuthorityFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expectedAuthorityFingerprint)) {
      throw new ValidationError("RECONCILE requires the exact authority_fingerprint from inspection");
    }
    const currentPreviousAuthority = await snapshotAuthorityInputs(previous, context.projectRoot);
    if (expectedAuthorityFingerprint !== `sha256:${currentPreviousAuthority}`) {
      throw new ValidationError("canonical source/SPEC/execution authority changed after RECONCILE inspection");
    }
  }

  const raw = await readExternalCandidate(candidatePath, context);
  let model = validateRoadmap(raw, { roadmapPath: context.roadmapPath });
  const authoritySnapshot = await snapshotAuthorityInputs(model, context.projectRoot);
  model = await hydrateSourceFingerprints(model, context.projectRoot);
  model = validateRoadmap(model, { roadmapPath: context.roadmapPath });
  if (previous !== null) {
    const previousProjections = await projectRoadmap(previous, context.projectRoot);
    validateReconcile(previous, model, previousProjections.candidates);
  }
  const projections = await projectRoadmap(model, context.projectRoot);
  const recheckedAuthoritySnapshot = await snapshotAuthorityInputs(model, context.projectRoot);
  if (recheckedAuthoritySnapshot !== authoritySnapshot) {
    throw new ValidationError("source or canonical SPEC/execution authority changed during roadmap projection");
  }
  const rendered = renderRoadmap(model, projections);
  const result = await publishRoadmap({
    context,
    operation,
    modelBytes: Buffer.from(formattedJson(model), "utf8"),
    html: rendered.html,
    expectedFingerprint,
    expectedAuthoritySnapshot: recheckedAuthoritySnapshot,
    readAuthoritySnapshot: () => snapshotAuthorityInputs(model, context.projectRoot),
  });
  return {
    status: operation === "INIT" ? "INITIALIZED" : "RECONCILED",
    roadmap_path: context.roadmapPath,
    model_path: result.modelPath,
    html_path: result.htmlPath,
    fingerprint: rendered.fingerprint,
    pair_digest: `sha256:${result.digest}`,
    state: rendered.state,
    candidates: model.candidates.length,
    coverage_records: model.coverage.length,
    gaps: model.gaps.length,
  };
}

export async function main(arguments_) {
  const operation = arguments_[0];
  const validInit = operation === "INIT" && arguments_.length >= 3 && arguments_.length <= 4;
  const validReconcile = operation === "RECONCILE" && arguments_.length >= 5 && arguments_.length <= 6;
  if (!validInit && !validReconcile) {
    process.stderr.write("usage: generate-roadmap.mjs INIT PROJECT_ROOT CANDIDATE_MODEL [ROADMAP_PATH]\n");
    process.stderr.write("   or: generate-roadmap.mjs RECONCILE PROJECT_ROOT CANDIDATE_MODEL EXPECTED_FINGERPRINT EXPECTED_AUTHORITY_FINGERPRINT [ROADMAP_PATH]\n");
    return 2;
  }
  try {
    const result = await generateRoadmap({
      operation,
      projectRoot: arguments_[1],
      candidatePath: arguments_[2],
      expectedFingerprint: operation === "RECONCILE" ? arguments_[3] : null,
      expectedAuthorityFingerprint: operation === "RECONCILE" ? arguments_[4] : null,
      roadmapPath: operation === "RECONCILE" ? arguments_[5] : arguments_[3],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    return 1;
  }
}

const executed = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
