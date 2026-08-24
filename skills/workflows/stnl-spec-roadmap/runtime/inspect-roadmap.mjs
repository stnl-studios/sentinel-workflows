#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeUtf8, resolveRoadmap, sha256, ValidationError } from "./lib/core.mjs";
import { hydrateSourceFingerprints, validateRoadmap } from "./lib/model.mjs";
import { projectRoadmap, snapshotAuthorityInputs } from "./lib/projection.mjs";
import { inspectPublishedRoadmap, recoverRoadmapPublication } from "./lib/publish.mjs";
import { parseStrictJson } from "./lib/lifecycle/strict-json.mjs";

function projectionSummary(projections) {
  return [...projections.candidates.values()].map((item) => ({
    candidate_id: item.candidate_id,
    materialization: item.materialization,
    documentary_status: item.documentary_status,
    execution_state: item.execution_state,
    dependency_verdict: item.dependency_verdict,
  }));
}

export async function inspectRoadmap(operation, projectRoot, roadmapPath) {
  if (!new Set(["INIT", "RECONCILE"]).has(operation)) {
    throw new ValidationError(`unsupported roadmap operation: ${operation}`);
  }
  const context = await resolveRoadmap(projectRoot, roadmapPath);
  const recovery = await recoverRoadmapPublication(context);
  const published = await inspectPublishedRoadmap(context);
  if (operation === "INIT") {
    if (published !== null) throw new ValidationError(`INIT target already exists: ${context.roadmapPath}`);
    return {
      status: "INSPECTED",
      operation,
      roadmap_path: context.roadmapPath,
      model_path: context.modelPath,
      html_path: context.htmlPath,
      expected_fingerprint: null,
      recovered_transaction: recovery.recovered,
    };
  }
  if (published === null) throw new ValidationError(`RECONCILE target does not exist: ${context.roadmapPath}`);
  let raw;
  try {
    raw = parseStrictJson(
      decodeUtf8(published.model, "roadmap.json"),
      (key) => `roadmap.json contains duplicate JSON key '${key}'`,
      (constant) => `roadmap.json contains unsupported JSON constant '${constant}'`,
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`roadmap.json is invalid JSON: ${error.message}`);
  }
  const model = validateRoadmap(raw, { roadmapPath: context.roadmapPath });
  const authorityBefore = await snapshotAuthorityInputs(model, context.projectRoot);
  const projections = await projectRoadmap(model, context.projectRoot);
  const changedSources = [];
  for (const source of model.sources.filter((item) => item.path !== undefined)) {
    const current = await hydrateSourceFingerprints({ ...model, sources: [source] }, context.projectRoot);
    if (current.sources[0].snapshot_sha256 !== source.snapshot_sha256) changedSources.push(source.id);
  }
  const authorityAfter = await snapshotAuthorityInputs(model, context.projectRoot);
  if (authorityAfter !== authorityBefore) {
    throw new ValidationError("source or canonical SPEC/execution authority changed during roadmap inspection");
  }
  return {
    status: "INSPECTED",
    operation,
    roadmap_path: context.roadmapPath,
    model_path: context.modelPath,
    html_path: context.htmlPath,
    expected_fingerprint: published.modelFingerprint,
    authority_fingerprint: `sha256:${authorityAfter}`,
    changed_sources: changedSources,
    projections: projectionSummary(projections),
    recovered_transaction: recovery.recovered,
    model_sha256: `sha256:${sha256(published.model)}`,
  };
}

export async function main(arguments_) {
  if (arguments_.length < 2 || arguments_.length > 3) {
    process.stderr.write("usage: inspect-roadmap.mjs OPERATION PROJECT_ROOT [ROADMAP_PATH]\n");
    return 2;
  }
  try {
    const result = await inspectRoadmap(arguments_[0], arguments_[1], arguments_[2]);
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
