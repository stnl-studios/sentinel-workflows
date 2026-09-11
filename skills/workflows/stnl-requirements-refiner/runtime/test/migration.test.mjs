import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { generateRefinement } from "../generate-refinement.mjs";
import { inspectRefinement } from "../inspect-refinement.mjs";
import { snapshotAuthorityInputs } from "../lib/authority.mjs";
import { formattedJson, resolveRefinement } from "../lib/core.mjs";
import { migrateLegacyRefinement, validateLegacyRefinement } from "../lib/migrate.mjs";
import { questionInteractionState, questionMigrationNotice, validateReconcile, validateRefinement } from "../lib/model.mjs";
import { inspectPublishedRefinement, publishRefinement } from "../lib/publish.mjs";
import { buildDecisionPrompt, renderRefinement } from "../lib/render.mjs";
import { clone, FIXTURES, project } from "./helpers.mjs";

async function legacyRaw() {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, "representative-v1-refinement.json"), "utf8"));
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function ownedLegacyHtml(model) {
  const renderedTokens = [
    model.refinement_id, model.title, model.summary,
    ...model.sources.filter((item) => item.state === "ACTIVE").flatMap((item) => [item.id, item.label, item.external_id, item.path, item.original_text]),
    ...model.needs.filter((item) => item.state === "ACTIVE").flatMap((item) => [item.id, item.title, item.statement]),
    ...model.relationships.filter((item) => item.state === "ACTIVE").flatMap((item) => [item.id, item.title, item.detail]),
    ...model.questions.flatMap((item) => [item.id, item.question, item.answer]),
    ...model.findings.flatMap((item) => [item.id, item.title, item.problem, item.impact, item.resolution?.proposal, item.resolution?.remaining_gap]),
  ].filter((value) => value !== undefined && value !== null).map((value) => `<span>${escapeHtml(value)}</span>`).join("");
  const compose = (fingerprint) => [
    `<!doctype html>\n<!-- stnl-requirements-refiner:v1 fingerprint:${fingerprint} -->`,
    `<html><head><meta name="description" content="${escapeHtml(model.summary)}"><title>${escapeHtml(model.title)} · Requirements Refinement</title></head>`,
    `<body><main data-refinement-id="${escapeHtml(model.refinement_id)}">${renderedTokens}</main>`,
    `</body></html>\n<footer>Refinement offline · fingerprint <code>${fingerprint.slice(0, 12)}</code></footer>`,
  ].join("");
  const draft = compose("0".repeat(64));
  const fingerprint = createHash("sha256").update(draft, "utf8").digest("hex");
  return compose(fingerprint);
}

async function readPair(root, refinementPath = "docs/refinement") {
  const directory = path.join(root, refinementPath);
  return {
    model: await fs.readFile(path.join(directory, "refinement.json")),
    html: await fs.readFile(path.join(directory, "index.html")),
  };
}

async function legacyProject(t, rawOverride = null) {
  const root = await project(t);
  const raw = rawOverride ?? await legacyRaw();
  await fs.writeFile(path.join(root, "src/commercial.mjs"), "export function queryCommercialResults() { return []; }\n", "utf8");
  const directory = path.join(root, "docs/refinement");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "refinement.json"), formattedJson(raw), "utf8");
  await fs.writeFile(path.join(directory, "index.html"), ownedLegacyHtml(raw), "utf8");
  return root;
}

async function migrate(t, root, inspection = null) {
  const inspected = inspection ?? await inspectRefinement("MIGRATE", root);
  return generateRefinement({
    operation: "MIGRATE",
    projectRoot: root,
    expectedFingerprint: inspected.expected_fingerprint,
    expectedHtmlFingerprint: inspected.html_sha256,
    expectedAuthorityFingerprint: inspected.authority_fingerprint,
  });
}

test("a valid owned v1 pair is recognized only by the controlled migration path", async (t) => {
  const root = await legacyProject(t);
  const inspection = await inspectRefinement("MIGRATE", root);
  assert.equal(inspection.status, "MIGRATION_REQUIRED");
  assert.equal(inspection.contract_version, 1);
  assert.equal(inspection.target_contract_version, 2);
  assert.match(inspection.suggested_next_operation, /MIGRATE/u);
  const context = await resolveRefinement(root);
  await assert.rejects(() => inspectPublishedRefinement(context), /legacy-only/u);
  assert.equal((await inspectRefinement("RECONCILE", root)).status, "MIGRATION_REQUIRED");
  await assert.rejects(() => generateRefinement({ operation: "RECONCILE", projectRoot: root }), /v1|MIGRATE/u);
});

test("v1 ownership and JSON/HTML correspondence fail closed without changing the pair", async (t) => {
  const modifiedHtmlRoot = await legacyProject(t);
  const beforeModifiedHtml = await readPair(modifiedHtmlRoot);
  await fs.appendFile(path.join(modifiedHtmlRoot, "docs/refinement/index.html"), "\nchanged\n", "utf8");
  await assert.rejects(() => inspectRefinement("MIGRATE", modifiedHtmlRoot), /was modified/u);
  assert.deepEqual(await readPair(modifiedHtmlRoot), { ...beforeModifiedHtml, html: Buffer.concat([beforeModifiedHtml.html, Buffer.from("\nchanged\n")]) });

  const foreignMarkerRoot = await legacyProject(t);
  const foreignPath = path.join(foreignMarkerRoot, "docs/refinement/index.html");
  const foreign = (await fs.readFile(foreignPath, "utf8")).replace("stnl-requirements-refiner:v1", "other-tool:v1");
  await fs.writeFile(foreignPath, foreign, "utf8");
  await assert.rejects(() => inspectRefinement("MIGRATE", foreignMarkerRoot), /not owned|ownership/u);

  const mismatchedRoot = await legacyProject(t);
  const mismatchedBefore = await readPair(mismatchedRoot);
  const mismatched = await legacyRaw();
  mismatched.title = "Different legacy authority";
  await fs.writeFile(path.join(mismatchedRoot, "docs/refinement/refinement.json"), formattedJson(mismatched), "utf8");
  await assert.rejects(() => inspectRefinement("MIGRATE", mismatchedRoot), /does not match|modified/u);
  assert.deepEqual((await readPair(mismatchedRoot)).html, mismatchedBefore.html);

  const changedAfterInspectionRoot = await legacyProject(t);
  const changedAfterInspection = await inspectRefinement("MIGRATE", changedAfterInspectionRoot);
  const changedAfterInspectionHtml = path.join(changedAfterInspectionRoot, "docs/refinement/index.html");
  const changedHtml = await fs.readFile(changedAfterInspectionHtml, "utf8");
  const changedHtmlDraft = changedHtml.replace("</body></html>", "<!-- changed after inspection -->\n</body></html>");
  const changedHtmlZeroed = changedHtmlDraft
    .replace(/stnl-requirements-refiner:v1 fingerprint:[0-9a-f]{64}/u, "stnl-requirements-refiner:v1 fingerprint:" + "0".repeat(64))
    .replace(/Refinement offline · fingerprint <code>[0-9a-f]{12}<\/code>/u, "Refinement offline · fingerprint <code>" + "0".repeat(12) + "</code>");
  const changedHtmlFingerprint = createHash("sha256").update(changedHtmlZeroed, "utf8").digest("hex");
  const changedHtmlOwned = changedHtmlDraft
    .replace(/stnl-requirements-refiner:v1 fingerprint:[0-9a-f]{64}/u, `stnl-requirements-refiner:v1 fingerprint:${changedHtmlFingerprint}`)
    .replace(/Refinement offline · fingerprint <code>[0-9a-f]{12}<\/code>/u, `Refinement offline · fingerprint <code>${changedHtmlFingerprint.slice(0, 12)}</code>`);
  await fs.writeFile(changedAfterInspectionHtml, changedHtmlOwned, "utf8");
  await assert.rejects(() => migrate(t, changedAfterInspectionRoot, changedAfterInspection), /index\.html changed|fingerprint/u);
});

test("v1 migrates once, deterministically, with canonical Requirement ownership and preserved provenance", async (t) => {
  const firstRoot = await legacyProject(t);
  const secondRoot = await legacyProject(t);
  const firstInspection = await inspectRefinement("MIGRATE", firstRoot);
  const secondInspection = await inspectRefinement("MIGRATE", secondRoot);
  const firstResult = await migrate(t, firstRoot, firstInspection);
  const secondResult = await migrate(t, secondRoot, secondInspection);
  assert.equal(firstResult.status, "MIGRATED");
  assert.equal(secondResult.status, "MIGRATED");
  const firstPair = await readPair(firstRoot);
  const secondPair = await readPair(secondRoot);
  assert.deepEqual(firstPair, secondPair);
  const migrated = JSON.parse(firstPair.model);
  assert.equal(migrated.contract_version, 2);
  assert.deepEqual(migrated.requirements.map((item) => [item.id, item.external_id, item.source_ids]), [
    ["REQ-001", "US 36134", ["SRC-001", "SRC-002"]],
    ["REQ-002", "US 36174", ["SRC-003"]],
    ["REQ-003", "US 36198", ["SRC-004"]],
  ]);
  assert.deepEqual(migrated.questions.find((item) => item.id === "QST-001").requirement_ids, ["REQ-001"]);
  assert.deepEqual(migrated.questions.find((item) => item.id === "QST-002").requirement_ids, ["REQ-001", "REQ-002", "REQ-003"]);
  assert.deepEqual(migrated.findings.find((item) => item.id === "FND-002").requirement_ids, ["REQ-001", "REQ-002", "REQ-003"]);
  assert.equal(migrated.migration_provenance.from_contract_version, 1);
  assert.equal(migrated.migration_provenance.legacy_model_fingerprint, firstInspection.expected_fingerprint);
  assert.equal(migrated.migration_provenance.legacy_html_fingerprint, firstInspection.html_sha256);
  assert.match(firstPair.html.toString("utf8"), /stnl-requirements-refiner:v2 fingerprint:/u);

  const rerunInspection = await inspectRefinement("MIGRATE", firstRoot);
  assert.equal(rerunInspection.status, "ALREADY_V2");
  const rerun = await migrate(t, firstRoot, rerunInspection);
  assert.equal(rerun.status, "ALREADY_V2");
  assert.deepEqual(await readPair(firstRoot), firstPair);
});

test("ambiguous v1 source ownership is rejected rather than guessed", async (t) => {
  const raw = await legacyRaw();
  delete raw.sources.find((item) => item.id === "SRC-002").external_id;
  const root = await legacyProject(t, raw);
  const before = await readPair(root);
  const inspection = await inspectRefinement("MIGRATE", root);
  assert.equal(inspection.status, "MIGRATION_REQUIRED");
  await assert.rejects(() => migrate(t, root, inspection), /external_id|ambiguous|ownership/u);
  assert.deepEqual(await readPair(root), before);
});

test("answered and partially reconciled v1 questions preserve only facts actually present", async (t) => {
  const root = await legacyProject(t);
  await migrate(t, root);
  const model = validateRefinement(JSON.parse((await fs.readFile(path.join(root, "docs/refinement/refinement.json"), "utf8"))));
  const answered = model.questions.find((item) => item.id === "QST-001");
  assert.equal(model.questions.filter((item) => item.status === "ANSWERED").length, 2);
  const partial = model.questions.find((item) => item.id === "QST-002");
  const untouched = model.questions.find((item) => item.id === "QST-003");
  assert.equal(answered.answer, "Region and status filters are in scope.");
  assert.deepEqual(answered.canonical_answer_history, [answered.answer]);
  assert.deepEqual(answered.reconciliation_attempts, []);
  assert.equal(answered.migration_history.status, "LEGACY_CANONICAL_ANSWER");
  assert.equal(Object.hasOwn(answered, "human_response"), false);
  assert.equal(partial.status, "OPEN");
  assert.deepEqual(partial.reconciliation_attempts, []);
  assert.equal(Object.hasOwn(partial, "human_response"), false);
  assert.deepEqual(partial.migration_history.remaining_gaps, ["The exported result must identify the exact filter and search state."]);
  assert.equal(partial.migration_history.status, "PRE_V2_INTERACTION_DETAIL_UNAVAILABLE");
  assert.equal(questionInteractionState(partial), "FOLLOW_UP_REQUIRED");
  assert.equal(questionMigrationNotice(partial), "Pre-v2 reconciliation occurred; original human response was not persisted.");
  assert.deepEqual(untouched.canonical_answer_history, []);
  assert.deepEqual(untouched.reconciliation_attempts, []);
  assert.equal(untouched.migration_history.status, "NO_PERSISTED_HISTORY");
  assert.equal(questionInteractionState(untouched), "AWAITING_DECISION");
  assert.deepEqual(model.findings.map((item) => item.resolution?.verdict ?? null), ["accepted", "rejected", null]);
  assert.equal(model.handoff.outcome, "BLOCKED");
  const prompt = buildDecisionPrompt(model, partial, "The exact result state is still under review.");
  assert.doesNotMatch(prompt, /Previous response:\n/u);
  assert.match(prompt, /History note:\nPre-v2 reconciliation occurred/u);
  assert.match(prompt, /Still unresolved:\nThe exported result/u);
  const html = renderRefinement(model).html;
  assert.match(html, /Canonical answer imported from v1; original human response was not persisted./u);
  assert.match(html, /Pre-v2 reconciliation occurred; original human response was not persisted./u);
});

test("migrated provenance, imported answer history, and unavailable-response metadata are immutable", async (t) => {
  const root = await legacyProject(t);
  await migrate(t, root);
  const persisted = validateRefinement(JSON.parse(await fs.readFile(path.join(root, "docs/refinement/refinement.json"), "utf8")));

  const provenanceRemoved = clone(persisted);
  delete provenanceRemoved.migration_provenance;
  provenanceRemoved.questions.forEach((item) => delete item.migration_history);
  assert.throws(() => validateReconcile(persisted, provenanceRemoved), /migration_provenance is immutable/u);

  const answerMutated = clone(persisted);
  const imported = answerMutated.questions.find((item) => item.id === "QST-001");
  imported.answer = "Invented historical answer.";
  imported.canonical_answer_history = ["Invented historical answer."];
  assert.throws(() => validateReconcile(persisted, validateRefinement(answerMutated)), /canonical answer history is append-only/u);

  const fakeResponseMetadata = clone(persisted);
  fakeResponseMetadata.questions.find((item) => item.id === "QST-002").migration_history.human_response_persisted = true;
  assert.throws(() => validateRefinement(fakeResponseMetadata), /human_response_persisted must be false/u);
});

test("failed migration keeps the complete v1 pair and does not leave a transaction", async (t) => {
  const root = await legacyProject(t);
  const inspection = await inspectRefinement("MIGRATE", root);
  const context = await resolveRefinement(root);
  const legacy = JSON.parse((await fs.readFile(context.modelPath, "utf8")));
  const migrated = migrateLegacyRefinement(legacy, {
    legacyModelFingerprint: inspection.expected_fingerprint,
    legacyHtmlFingerprint: inspection.html_sha256,
  });
  const rendered = renderRefinement(migrated, { refinementPath: context.refinementPath });
  const before = await readPair(root);
  await assert.rejects(() => publishRefinement({
    context,
    operation: "MIGRATE",
    modelBytes: Buffer.from(formattedJson(migrated), "utf8"),
    html: rendered.html,
    expectedFingerprint: inspection.expected_fingerprint,
    expectedHtmlFingerprint: inspection.html_sha256,
    expectedAuthoritySnapshot: "before",
    readAuthoritySnapshot: async () => "after",
  }), /authority changed before refinement publication/u);
  assert.deepEqual(await readPair(root), before);
  assert.equal(await fs.access(path.join(root, "docs/.refinement.stnl-refinement.journal.json")).then(() => true, () => false), false);
  assert.equal(await snapshotAuthorityInputs(validateLegacyRefinement(legacy), root), inspection.authority_fingerprint.slice("sha256:".length));
});

test("the v1 migration validator rejects native v2 payloads outside the controlled boundary", async () => {
  const raw = await legacyRaw();
  const migrated = migrateLegacyRefinement(raw, {
    legacyModelFingerprint: `sha256:${"1".repeat(64)}`,
    legacyHtmlFingerprint: `sha256:${"2".repeat(64)}`,
  });
  assert.doesNotThrow(() => validateRefinement(migrated));
  assert.throws(() => validateLegacyRefinement(migrated), /fields are invalid|contract_version must be 1/u);
  assert.equal(migrated.questions.every((item) => item.reconciliation_attempts.length === 0), true);
});
