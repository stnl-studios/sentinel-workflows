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
import { migrateLegacyRefinement, validateLegacyRefinement } from "./lib/migrate.mjs";
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

function parsePublished(published, refinementPath, { allowLegacy = false } = {}) {
  let raw;
  try {
    raw = parseStrictJson(
      decodeUtf8(published.model, "refinement.json"),
      (key) => `refinement.json contains duplicate JSON key '${key}'`,
      (constant) => `refinement.json contains unsupported JSON constant '${constant}'`,
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`refinement.json is invalid JSON: ${error.message}`);
  }
  if (raw?.contract_version === 1) {
    if (!allowLegacy) throw new ValidationError("persisted contract v1 is readable only through the controlled MIGRATE operation");
    return validateLegacyRefinement(raw);
  }
  return validateRefinement(raw, { refinementPath, validationContext: "PERSISTED" });
}

export async function generateRefinement({
  operation,
  projectRoot,
  candidatePath,
  expectedFingerprint = null,
  expectedHtmlFingerprint = null,
  expectedAuthorityFingerprint = null,
  refinementPath,
}) {
  if (!new Set(["INIT", "RECONCILE", "MIGRATE"]).has(operation)) {
    throw new ValidationError(`unsupported refinement operation: ${operation}`);
  }
  const context = await resolveRefinement(projectRoot, refinementPath);
  await recoverRefinementPublication(context);
  const published = await inspectPublishedRefinement(context, { allowLegacy: operation !== "INIT" });
  if (operation === "INIT" && published !== null) throw new ValidationError(`INIT target already exists: ${context.refinementPath}`);
  if (new Set(["RECONCILE", "MIGRATE"]).has(operation) && published === null) {
    throw new ValidationError(`${operation} target does not exist: ${context.refinementPath}`);
  }
  const previous = new Set(["RECONCILE", "MIGRATE"]).has(operation)
    ? parsePublished(published, context.refinementPath, { allowLegacy: true }) : null;
  if (operation === "MIGRATE" && previous.contract_version === 2) {
    return {
      status: "ALREADY_V2",
      contract_version: 2,
      refinement_path: context.refinementPath,
      fingerprint: published.modelFingerprint,
      pair_digest: `sha256:${published.digest}`,
    };
  }
  if (operation === "RECONCILE" && previous.contract_version === 1) {
    throw new ValidationError("RECONCILE encountered persisted contract v1; run MIGRATE after MIGRATE inspection");
  }
  if (previous !== null) {
    if (typeof expectedAuthorityFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expectedAuthorityFingerprint)) {
      throw new ValidationError(`${operation} requires the exact authority_fingerprint from inspection`);
    }
    const current = await snapshotAuthorityInputs(previous, context.projectRoot);
    if (expectedAuthorityFingerprint !== `sha256:${current}`) {
      throw new ValidationError(`repository authority changed after ${operation} inspection`);
    }
  }
  if (operation === "MIGRATE") {
    if (typeof expectedHtmlFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expectedHtmlFingerprint)) {
      throw new ValidationError("MIGRATE requires the exact html_sha256 from inspection");
    }
    if (published.htmlFingerprint !== expectedHtmlFingerprint) {
      throw new ValidationError("legacy index.html changed after MIGRATE inspection");
    }
    const modelBeforeHydration = migrateLegacyRefinement(previous, {
      legacyModelFingerprint: published.modelFingerprint,
      legacyHtmlFingerprint: expectedHtmlFingerprint,
    });
    let model = await hydrateFingerprints(modelBeforeHydration, context.projectRoot);
    model = validateRefinement(model, { refinementPath: context.refinementPath, validationContext: "MIGRATE" });
    const authorityAfter = await snapshotAuthorityInputs(model, context.projectRoot);
    const rendered = renderRefinement(model, { refinementPath: context.refinementPath });
    const publishedResult = await publishRefinement({
      context,
      operation,
      modelBytes: Buffer.from(formattedJson(model), "utf8"),
      html: rendered.html,
      expectedFingerprint,
      expectedHtmlFingerprint,
      expectedAuthoritySnapshot: authorityAfter,
      readAuthoritySnapshot: () => snapshotAuthorityInputs(model, context.projectRoot),
    });
    return {
      status: "MIGRATED",
      contract_version: 2,
      migrated_from_contract_version: 1,
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
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    throw new ValidationError(`${operation} requires an external candidate refinement model`);
  }
  const raw = await readExternalCandidate(candidatePath, context);
  let model = validateRefinement(raw, { refinementPath: context.refinementPath, validationContext: operation });
  const authorityBefore = await snapshotAuthorityInputs(model, context.projectRoot);
  model = await hydrateFingerprints(model, context.projectRoot);
  model = validateRefinement(model, { refinementPath: context.refinementPath, validationContext: operation });
  if (previous !== null) validateReconcile(previous, model);
  const authorityAfter = await snapshotAuthorityInputs(model, context.projectRoot);
  if (authorityAfter !== authorityBefore) throw new ValidationError("repository authority changed during refinement projection");
  const rendered = renderRefinement(model, { refinementPath: context.refinementPath });
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
  const validMigrate = operation === "MIGRATE" && arguments_.length >= 5 && arguments_.length <= 6;
  if (!validInit && !validReconcile && !validMigrate) {
    process.stderr.write("usage: generate-refinement.mjs INIT PROJECT_ROOT CANDIDATE_MODEL [REFINEMENT_PATH]\n");
    process.stderr.write("   or: generate-refinement.mjs RECONCILE PROJECT_ROOT CANDIDATE_MODEL EXPECTED_FINGERPRINT EXPECTED_AUTHORITY_FINGERPRINT [REFINEMENT_PATH]\n");
    process.stderr.write("   or: generate-refinement.mjs MIGRATE PROJECT_ROOT EXPECTED_FINGERPRINT EXPECTED_HTML_FINGERPRINT EXPECTED_AUTHORITY_FINGERPRINT [REFINEMENT_PATH]\n");
    return 2;
  }
  try {
    const result = await generateRefinement({
      operation,
      projectRoot: arguments_[1],
      candidatePath: operation === "MIGRATE" ? undefined : arguments_[2],
      expectedFingerprint: new Set(["RECONCILE", "MIGRATE"]).has(operation) ? arguments_[3 - (operation === "MIGRATE" ? 1 : 0)] : null,
      expectedHtmlFingerprint: operation === "MIGRATE" ? arguments_[3] : null,
      expectedAuthorityFingerprint: operation === "RECONCILE" ? arguments_[4] : operation === "MIGRATE" ? arguments_[4] : null,
      refinementPath: operation === "RECONCILE" ? arguments_[5] : operation === "MIGRATE" ? arguments_[5] : arguments_[3],
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
