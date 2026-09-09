#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotAuthorityInputs } from "./lib/authority.mjs";
import {
  ValidationError,
  decodeUtf8,
  formattedJson,
  readStrictJsonFile,
  requireSingleLinkRealFile,
  resolveRefinement,
} from "./lib/core.mjs";
import { hydrateFingerprints, validateReconcile, validateRefinement } from "./lib/model.mjs";
import { inspectPublishedRefinement, publishRefinement, recoverRefinementPublication } from "./lib/publish.mjs";
import { renderRefinement } from "./lib/render.mjs";
import { parseStrictJson } from "./lib/strict-json.mjs";

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readExternalCandidate(candidatePath, context) {
  const requested = path.resolve(String(candidatePath));
  await requireSingleLinkRealFile(requested, "candidate refinement model");
  const physical = await fs.realpath(requested);
  if (isInside(context.projectRoot, physical)) {
    throw new ValidationError("candidate refinement model must be an ephemeral file outside PROJECT_ROOT");
  }
  return (await readStrictJsonFile(physical, "candidate refinement model")).value;
}

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

export async function generateRefinement({
  operation,
  projectRoot,
  candidatePath,
  expectedFingerprint = null,
  expectedAuthorityFingerprint = null,
  refinementPath,
}) {
  if (!new Set(["INIT", "RECONCILE"]).has(operation)) {
    throw new ValidationError(`unsupported refinement operation: ${operation}`);
  }
  const context = await resolveRefinement(projectRoot, refinementPath);
  await recoverRefinementPublication(context);
  const published = await inspectPublishedRefinement(context);
  if (operation === "INIT" && published !== null) throw new ValidationError(`INIT target already exists: ${context.refinementPath}`);
  if (operation === "RECONCILE" && published === null) throw new ValidationError(`RECONCILE target does not exist: ${context.refinementPath}`);
  const previous = operation === "RECONCILE" ? parsePublished(published, context.refinementPath) : null;
  if (previous !== null) {
    if (typeof expectedAuthorityFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expectedAuthorityFingerprint)) {
      throw new ValidationError("RECONCILE requires the exact authority_fingerprint from inspection");
    }
    const current = await snapshotAuthorityInputs(previous, context.projectRoot);
    if (expectedAuthorityFingerprint !== `sha256:${current}`) {
      throw new ValidationError("repository authority changed after RECONCILE inspection");
    }
  }
  const raw = await readExternalCandidate(candidatePath, context);
  let model = validateRefinement(raw, { refinementPath: context.refinementPath });
  const authorityBefore = await snapshotAuthorityInputs(model, context.projectRoot);
  model = await hydrateFingerprints(model, context.projectRoot);
  model = validateRefinement(model, { refinementPath: context.refinementPath });
  if (previous !== null) validateReconcile(previous, model);
  const authorityAfter = await snapshotAuthorityInputs(model, context.projectRoot);
  if (authorityAfter !== authorityBefore) throw new ValidationError("repository authority changed during refinement projection");
  const rendered = renderRefinement(model);
  const publishedResult = await publishRefinement({
    context,
    operation,
    modelBytes: Buffer.from(formattedJson(model), "utf8"),
    html: rendered.html,
    expectedFingerprint,
    expectedAuthoritySnapshot: authorityAfter,
    readAuthoritySnapshot: () => snapshotAuthorityInputs(model, context.projectRoot),
  });
  return {
    status: operation === "INIT" ? "INITIALIZED" : "RECONCILED",
    refinement_path: context.refinementPath,
    model_path: publishedResult.modelPath,
    html_path: publishedResult.htmlPath,
    fingerprint: rendered.fingerprint,
    pair_digest: `sha256:${publishedResult.digest}`,
    handoff: rendered.outcome,
    findings: model.findings.length,
    counts: rendered.counts,
  };
}

export async function main(arguments_) {
  const operation = arguments_[0];
  const validInit = operation === "INIT" && arguments_.length >= 3 && arguments_.length <= 4;
  const validReconcile = operation === "RECONCILE" && arguments_.length >= 5 && arguments_.length <= 6;
  if (!validInit && !validReconcile) {
    process.stderr.write("usage: generate-refinement.mjs INIT PROJECT_ROOT CANDIDATE_MODEL [REFINEMENT_PATH]\n");
    process.stderr.write("   or: generate-refinement.mjs RECONCILE PROJECT_ROOT CANDIDATE_MODEL EXPECTED_FINGERPRINT EXPECTED_AUTHORITY_FINGERPRINT [REFINEMENT_PATH]\n");
    return 2;
  }
  try {
    const result = await generateRefinement({
      operation,
      projectRoot: arguments_[1],
      candidatePath: arguments_[2],
      expectedFingerprint: operation === "RECONCILE" ? arguments_[3] : null,
      expectedAuthorityFingerprint: operation === "RECONCILE" ? arguments_[4] : null,
      refinementPath: operation === "RECONCILE" ? arguments_[5] : arguments_[3],
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
