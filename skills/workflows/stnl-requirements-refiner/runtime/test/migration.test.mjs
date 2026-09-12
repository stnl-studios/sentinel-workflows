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
import {
  questionEstablishedContext, questionInteractionState, questionMigrationNotice, validateReconcile, validateRefinement,
} from "../lib/model.mjs";
import { inspectPublishedRefinement, publishRefinement } from "../lib/publish.mjs";
import { buildDecisionPrompt, renderRefinement } from "../lib/render.mjs";
import { candidateFile, clone, FIXTURES, project, representativeRaw } from "./helpers.mjs";

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

function forgedProvenance() {
  return {
    from_contract_version: 1,
    legacy_model_fingerprint: `sha256:${"1".repeat(64)}`,
    legacy_html_fingerprint: `sha256:${"2".repeat(64)}`,
    requirement_ownership_rule: "EXACT_NORMALIZED_SOURCE_EXTERNAL_ID",
  };
}

function addNativeQuestionAfterMigration(raw) {
  const next = clone(raw);
  next.questions.push({
    id: "QST-005",
    question: "Is search case-sensitive?",
    status: "OPEN",
    why_material: "The answer changes native-v2 search matching semantics.",
    requirement_ids: ["REQ-003"],
    source_ids: ["SRC-004"],
    need_ids: ["NEED-003"],
    finding_ids: ["FND-003"],
    evidence_ids: ["EVD-003"],
    canonical_answer_history: [],
    reconciliation_attempts: [],
  });
  next.findings.find((item) => item.id === "FND-003").question_ids.push("QST-005");
  next.handoff.payload.question_ids.push("QST-005");
  return next;
}

test("INIT rejects root and per-Question migration metadata before publication", async (t) => {
  const provenanceRoot = await project(t);
  const withProvenance = await representativeRaw();
  withProvenance.migration_provenance = forgedProvenance();
  const provenanceCandidate = await candidateFile(t, withProvenance);
  await assert.rejects(() => generateRefinement({
    operation: "INIT",
    projectRoot: provenanceRoot,
    candidatePath: provenanceCandidate,
  }), /INIT cannot author migration_provenance/u);

  const historyRoot = await project(t);
  const withHistory = await representativeRaw();
  withHistory.questions[0].migration_history = {
    status: "NO_PERSISTED_HISTORY",
    human_response_persisted: false,
    remaining_gaps: [],
  };
  const historyCandidate = await candidateFile(t, withHistory);
  await assert.rejects(() => generateRefinement({
    operation: "INIT",
    projectRoot: historyRoot,
    candidatePath: historyCandidate,
  }), /INIT cannot author QST-001\.migration_history/u);
  await assert.rejects(() => fs.access(path.join(provenanceRoot, "docs/refinement")), { code: "ENOENT" });
  await assert.rejects(() => fs.access(path.join(historyRoot, "docs/refinement")), { code: "ENOENT" });
});

test("native-v2 cannot forge a legacy canonical answer with or without root provenance", async () => {
  const forge = async (withRoot) => {
    const raw = await representativeRaw();
    const question = raw.questions[0];
    question.status = "ANSWERED";
    question.answer = "Forged imported answer.";
    question.canonical_answer_history = [question.answer];
    question.reconciliation_attempts = [];
    question.migration_history = {
      status: "LEGACY_CANONICAL_ANSWER",
      human_response_persisted: false,
      remaining_gaps: [],
    };
    if (withRoot) raw.migration_provenance = forgedProvenance();
    return raw;
  };
  const withoutRoot = await forge(false);
  const withRoot = await forge(true);
  assert.throws(() => validateRefinement(withoutRoot, { validationContext: "INIT" }), /INIT cannot author QST-001\.migration_history/u);
  assert.throws(() => validateRefinement(withRoot, { validationContext: "INIT" }), /INIT cannot author migration_provenance/u);
});

test("RECONCILE cannot inject migration provenance into native-v2 authority", async (t) => {
  const previous = validateRefinement(await representativeRaw(), { validationContext: "PERSISTED" });
  const injected = await representativeRaw();
  injected.migration_provenance = forgedProvenance();
  const candidate = validateRefinement(injected, { validationContext: "RECONCILE" });
  assert.throws(() => validateReconcile(previous, candidate), /migration_provenance is immutable/u);

  const root = await project(t);
  const initialCandidate = await candidateFile(t, await representativeRaw());
  await generateRefinement({ operation: "INIT", projectRoot: root, candidatePath: initialCandidate });
  const inspected = await inspectRefinement("RECONCILE", root);
  const injectedCandidate = await candidateFile(t, injected);
  await assert.rejects(() => generateRefinement({
    operation: "RECONCILE",
    projectRoot: root,
    candidatePath: injectedCandidate,
    expectedFingerprint: inspected.expected_fingerprint,
    expectedAuthorityFingerprint: inspected.authority_fingerprint,
  }), /migration_provenance is immutable/u);
});

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
  const model = validateRefinement(
    JSON.parse((await fs.readFile(path.join(root, "docs/refinement/refinement.json"), "utf8"))),
    { validationContext: "PERSISTED" },
  );
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
  const persisted = validateRefinement(
    JSON.parse(await fs.readFile(path.join(root, "docs/refinement/refinement.json"), "utf8")),
    { validationContext: "PERSISTED" },
  );

  const provenanceRemoved = clone(persisted);
  delete provenanceRemoved.migration_provenance;
  provenanceRemoved.questions.forEach((item) => delete item.migration_history);
  assert.throws(() => validateReconcile(persisted, provenanceRemoved), /migration_provenance is immutable/u);

  const answerMutated = clone(persisted);
  const imported = answerMutated.questions.find((item) => item.id === "QST-001");
  imported.answer = "Invented historical answer.";
  imported.canonical_answer_history = ["Invented historical answer."];
  assert.throws(() => validateReconcile(
    persisted,
    validateRefinement(answerMutated, { validationContext: "RECONCILE" }),
  ), /canonical answer history is append-only/u);

  const fakeResponseMetadata = clone(persisted);
  fakeResponseMetadata.questions.find((item) => item.id === "QST-002").migration_history.human_response_persisted = true;
  assert.throws(() => validateRefinement(fakeResponseMetadata, { validationContext: "RECONCILE" }), /human_response_persisted must be false/u);
});

test("an imported canonical answer can be reopened and replaced without clearing the native accepted resolution", async () => {
  const migrated = migrateLegacyRefinement(await legacyRaw(), {
    legacyModelFingerprint: `sha256:${"5".repeat(64)}`,
    legacyHtmlFingerprint: `sha256:${"6".repeat(64)}`,
  });
  const importedQuestion = migrated.questions.find((item) => item.id === "QST-001");
  const reopenedRaw = clone(migrated);
  const reopenedQuestion = reopenedRaw.questions.find((item) => item.id === "QST-001");
  const gaps = ["Confirm the revised filter scope."];
  reopenedQuestion.status = "OPEN";
  reopenedQuestion.reopened_reason = "New evidence challenges the imported filter scope.";
  reopenedQuestion.remaining_gaps = gaps;
  reopenedQuestion.reopen_events = [{
    sequence: 1,
    reason: reopenedQuestion.reopened_reason,
    prior_canonical_answer: importedQuestion.answer,
    remaining_gaps: gaps,
  }];
  reopenedRaw.handoff.payload.question_ids = [...new Set([
    ...reopenedRaw.handoff.payload.question_ids,
    reopenedQuestion.id,
  ])].sort();
  const reopened = validateRefinement(reopenedRaw, { validationContext: "RECONCILE" });
  assert.deepEqual(questionEstablishedContext(reopened.questions.find((item) => item.id === "QST-001")), []);
  assert.doesNotThrow(() => validateReconcile(migrated, reopened));

  const resolvedRaw = clone(reopened);
  const resolvedQuestion = resolvedRaw.questions.find((item) => item.id === "QST-001");
  const resolvedAnswer = "Region, status, and tenant filters are in scope.";
  resolvedQuestion.status = "ANSWERED";
  resolvedQuestion.answer = resolvedAnswer;
  resolvedQuestion.canonical_answer_history.push(resolvedAnswer);
  resolvedQuestion.reconciliation_attempts.push({
    round: 1,
    human_response: "Include the tenant filter as well.",
    assessment: "ACCEPTED",
    established_context: [resolvedAnswer],
    remaining_gaps: [],
    affected_finding_ids: resolvedQuestion.finding_ids,
    canonical_answer: resolvedAnswer,
  });
  delete resolvedQuestion.remaining_gaps;
  delete resolvedQuestion.reopened_reason;
  resolvedRaw.handoff.payload.question_ids = resolvedRaw.handoff.payload.question_ids.filter((id) => id !== resolvedQuestion.id);
  const resolved = validateRefinement(resolvedRaw, { validationContext: "RECONCILE" });
  assert.deepEqual(questionEstablishedContext(resolved.questions.find((item) => item.id === "QST-001")), [resolvedAnswer]);
  assert.doesNotThrow(() => validateReconcile(reopened, resolved));
});

test("Questions created after migration remain native-v2 and cannot acquire legacy history", async () => {
  const migrated = migrateLegacyRefinement(await legacyRaw(), {
    legacyModelFingerprint: `sha256:${"3".repeat(64)}`,
    legacyHtmlFingerprint: `sha256:${"4".repeat(64)}`,
  });
  const preserved = validateRefinement(clone(migrated), { validationContext: "RECONCILE" });
  assert.deepEqual(preserved.migration_provenance, migrated.migration_provenance);
  assert.doesNotThrow(() => validateReconcile(migrated, preserved));

  const legitimate = validateRefinement(addNativeQuestionAfterMigration(migrated), { validationContext: "RECONCILE" });
  const nativeQuestion = legitimate.questions.find((item) => item.id === "QST-005");
  assert.equal(nativeQuestion.migration_history, undefined);
  assert.equal(nativeQuestion.status, "OPEN");
  assert.doesNotThrow(() => validateReconcile(migrated, legitimate));
  assert.equal(migrated.questions.find((item) => item.id === "QST-001").migration_history.status, "LEGACY_CANONICAL_ANSWER");

  const forgedAtCreation = addNativeQuestionAfterMigration(migrated);
  forgedAtCreation.questions.find((item) => item.id === "QST-005").migration_history = {
    status: "NO_PERSISTED_HISTORY",
    human_response_persisted: false,
    remaining_gaps: [],
  };
  const forgedCreationCandidate = validateRefinement(forgedAtCreation, { validationContext: "RECONCILE" });
  assert.throws(() => validateReconcile(migrated, forgedCreationCandidate), /QST-005 is native-v2 and cannot receive migration_history/u);

  const forgedLater = clone(legitimate);
  forgedLater.questions.find((item) => item.id === "QST-005").migration_history = {
    status: "NO_PERSISTED_HISTORY",
    human_response_persisted: false,
    remaining_gaps: [],
  };
  const forgedLaterCandidate = validateRefinement(forgedLater, { validationContext: "RECONCILE" });
  assert.throws(() => validateReconcile(legitimate, forgedLaterCandidate), /QST-005 migration history is immutable/u);

  const unansweredAttempt = clone(legitimate);
  const attemptedShortcut = unansweredAttempt.questions.find((item) => item.id === "QST-005");
  attemptedShortcut.status = "ANSWERED";
  attemptedShortcut.answer = "Search is case-sensitive.";
  attemptedShortcut.canonical_answer_history = [attemptedShortcut.answer];
  unansweredAttempt.handoff.payload.question_ids = ["QST-002", "QST-003"];
  assert.throws(
    () => validateRefinement(unansweredAttempt, { validationContext: "RECONCILE" }),
    /canonical_answer_history must be supported|requires an accepted reconciliation attempt/u,
  );

  const acceptedRaw = clone(legitimate);
  const acceptedQuestion = acceptedRaw.questions.find((item) => item.id === "QST-005");
  acceptedQuestion.status = "ANSWERED";
  acceptedQuestion.answer = "Search is case-sensitive.";
  acceptedQuestion.canonical_answer_history = [acceptedQuestion.answer];
  acceptedQuestion.reconciliation_attempts = [{
    round: 1,
    human_response: "Search is case-sensitive.",
    assessment: "ACCEPTED",
    established_context: ["Search is case-sensitive."],
    remaining_gaps: [],
    affected_finding_ids: ["FND-003"],
    canonical_answer: acceptedQuestion.answer,
  }];
  acceptedRaw.handoff.payload.question_ids = ["QST-002", "QST-003"];
  const accepted = validateRefinement(acceptedRaw, { validationContext: "RECONCILE" });
  assert.equal(accepted.questions.find((item) => item.id === "QST-005").migration_history, undefined);
  assert.doesNotThrow(() => validateReconcile(legitimate, accepted));
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
  assert.throws(() => validateRefinement(migrated), /NATIVE cannot author migration_provenance/u);
  assert.doesNotThrow(() => validateRefinement(migrated, { validationContext: "MIGRATE" }));
  assert.throws(() => validateLegacyRefinement(migrated), /fields are invalid|contract_version must be 1/u);
  assert.equal(migrated.questions.every((item) => item.reconciliation_attempts.length === 0), true);
});
