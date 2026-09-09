#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotAuthorityInputs } from "./lib/authority.mjs";
import { ValidationError, decodeUtf8, resolveRefinement, sha256 } from "./lib/core.mjs";
import { hydrateFingerprints, validateRefinement } from "./lib/model.mjs";
import { inspectPublishedRefinement, recoverRefinementPublication } from "./lib/publish.mjs";
import { parseStrictJson } from "./lib/strict-json.mjs";

function parsePublished(published, refinementPath) {
  try {
    return validateRefinement(parseStrictJson(
      decodeUtf8(published.model, "refinement.json"),
      (key) => `refinement.json contains duplicate JSON key '${key}'`,
      (constant) => `refinement.json contains unsupported JSON constant '${constant}'`,
    ), { refinementPath });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`refinement.json is invalid JSON: ${error.message}`);
  }
}

export async function inspectRefinement(operation, projectRoot, refinementPath) {
  if (!new Set(["INIT", "RECONCILE"]).has(operation)) {
    throw new ValidationError(`unsupported refinement operation: ${operation}`);
  }
  const context = await resolveRefinement(projectRoot, refinementPath);
  const recovery = await recoverRefinementPublication(context);
  const published = await inspectPublishedRefinement(context);
  if (operation === "INIT") {
    if (published !== null) throw new ValidationError(`INIT target already exists: ${context.refinementPath}`);
    return {
      status: "INSPECTED",
      operation,
      refinement_path: context.refinementPath,
      model_path: context.modelPath,
      html_path: context.htmlPath,
      expected_fingerprint: null,
      recovered_transaction: recovery.recovered,
    };
  }
  if (published === null) throw new ValidationError(`RECONCILE target does not exist: ${context.refinementPath}`);
  const model = parsePublished(published, context.refinementPath);
  const authorityBefore = await snapshotAuthorityInputs(model, context.projectRoot);
  const hydrated = await hydrateFingerprints(model, context.projectRoot);
  const changedSources = model.sources
    .filter((item) => item.path !== undefined)
    .filter((item) => hydrated.sources.find((candidate) => candidate.id === item.id).snapshot_sha256 !== item.snapshot_sha256)
    .map((item) => item.id);
  const changedEvidence = model.evidence
    .filter((item) => item.kind === "REPOSITORY_OBSERVATION")
    .filter((item) => hydrated.evidence.find((candidate) => candidate.id === item.id).snapshot_sha256 !== item.snapshot_sha256)
    .map((item) => item.id);
  const authorityAfter = await snapshotAuthorityInputs(model, context.projectRoot);
  if (authorityAfter !== authorityBefore) throw new ValidationError("repository authority changed during refinement inspection");
  return {
    status: "INSPECTED",
    operation,
    refinement_path: context.refinementPath,
    model_path: context.modelPath,
    html_path: context.htmlPath,
    expected_fingerprint: published.modelFingerprint,
    authority_fingerprint: `sha256:${authorityAfter}`,
    changed_sources: changedSources,
    changed_evidence: changedEvidence,
    recovered_transaction: recovery.recovered,
    model_sha256: `sha256:${sha256(published.model)}`,
    handoff: model.handoff.outcome,
  };
}

export async function main(arguments_) {
  if (arguments_.length < 2 || arguments_.length > 3) {
    process.stderr.write("usage: inspect-refinement.mjs OPERATION PROJECT_ROOT [REFINEMENT_PATH]\n");
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(await inspectRefinement(arguments_[0], arguments_[1], arguments_[2]), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    return 1;
  }
}

const executed = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
