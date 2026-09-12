import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedOutcome,
  questionCurrentGaps,
  questionEstablishedContext,
  questionInteractionState,
  validateReconcile,
  validateRefinement,
} from "../lib/model.mjs";
import { acceptedResolution, clone, historyRaw, recordAcceptedDecision, representativeRaw } from "./helpers.mjs";

function specHandoff(raw, { carried = raw.findings.filter((item) => item.disposition === "bypassed" || (item.disposition === "open" && item.severity !== "BLOCKING")).map((item) => item.id) } = {}) {
  raw.questions.filter((item) => item.status === "OPEN").forEach((item) => {
    recordAcceptedDecision(raw, raw.questions.indexOf(item));
  });
  raw.handoff = {
    outcome: "READY_FOR_SPEC",
    reason: "One coherent boundary is ready for documentary refinement.",
    blocker_ids: [],
    carried_finding_ids: carried,
    next_workflow: "stnl-spec-lifecycle-manager",
    suggested_next_operation: "MODE=INIT",
    payload: {
      kind: "SPEC",
      need_ids: raw.needs.filter((item) => item.state === "ACTIVE").map((item) => item.id),
      finding_ids: carried,
      question_ids: raw.questions.filter((item) => item.status === "OPEN").map((item) => item.id),
      constraint_ids: raw.constraints.filter((item) => item.state === "ACTIVE").map((item) => item.id),
      relationship_ids: raw.relationships.filter((item) => item.state === "ACTIVE").map((item) => item.id),
      evidence_ids: raw.evidence.filter((item) => item.state === "ACTIVE").map((item) => item.id),
      suggested_spec_title: "Order cancellation",
      requirements_source: "A customer can atomically cancel an eligible order before shipping.",
    },
  };
}

test("messy, ID-less, and low-quality input remains analyzable", async () => {
  const raw = await representativeRaw();
  delete raw.sources[0].external_id;
  raw.sources[0].original_text = "precisa cancelar se ainda não saiu";
  raw.input_assessment = { format: "UNSTRUCTURED", quality: "POOR", summary: "Informal but analyzable." };
  const model = validateRefinement(raw);
  assert.equal(model.input_assessment.quality, "POOR");
  assert.equal(model.sources[0].external_id, undefined);
  assert.equal(model.needs[0].id, "NEED-001");
});

test("contract v1 is rejected explicitly after the canonical Requirement migration", async () => {
  const legacy = await representativeRaw();
  legacy.contract_version = 1;
  assert.throws(() => validateRefinement(legacy), /refinement\.contract_version must be 2/u);
});

test("well-structured and mixed multi-source input use the same strict model", async () => {
  const structured = await representativeRaw();
  structured.input_assessment = { format: "STRUCTURED", quality: "SUFFICIENT", summary: "Actor, intent, and context are supplied." };
  assert.equal(validateRefinement(structured).sources.length, 2);
  const mixed = await representativeRaw();
  mixed.input_assessment.format = "MIXED";
  mixed.input_assessment.quality = "PARTIAL";
  assert.equal(validateRefinement(mixed).needs.length, 2);
});

test("all finding families and severities are representable without conflating them", async () => {
  for (const type of ["REQUIREMENT_GAP", "TECHNICAL_GAP", "CROSS_REQUIREMENT_GAP", "REPOSITORY_CONFLICT", "RISK"]) {
    const raw = await representativeRaw();
    raw.findings[0].type = type;
    if (type === "CROSS_REQUIREMENT_GAP") {
      raw.requirements[0].source_ids = ["SRC-001"];
      raw.requirements[0].need_ids = ["NEED-001"];
      raw.requirements.push({
        id: "REQ-002", title: "Shipping", state: "ACTIVE", external_id: "US-42",
        source_ids: ["SRC-002"], need_ids: ["NEED-002"],
      });
      raw.relationships[0].requirement_ids = ["REQ-001", "REQ-002"];
      raw.questions[0].requirement_ids = ["REQ-001", "REQ-002"];
      raw.findings[0].requirement_ids = ["REQ-001", "REQ-002"];
    }
    assert.equal(validateRefinement(raw).findings[0].type, type);
  }
  for (const severity of ["INFO", "ATTENTION"]) {
    const raw = await representativeRaw();
    raw.findings[0].severity = severity;
    specHandoff(raw, { carried: ["FND-001"] });
    assert.equal(validateRefinement(raw).findings[0].severity, severity);
  }
  const invalid = await representativeRaw();
  invalid.findings[0].severity = "CRITICAL";
  assert.throws(() => validateRefinement(invalid), /unsupported value/u);
});

test("accepted resolution uses a positive no-new-gap assertion and rejects the legacy negative field", async () => {
  const accepted = acceptedResolution(await representativeRaw());
  const model = validateRefinement(accepted);
  assert.equal(model.findings[0].resolution.checks.no_new_gap_introduced, "PASS");
  assert.equal(Object.hasOwn(model.findings[0].resolution.checks, "new_gap_introduced"), false);

  const legacy = acceptedResolution(await representativeRaw());
  legacy.findings[0].resolution.checks.new_gap_introduced = "FAIL";
  delete legacy.findings[0].resolution.checks.no_new_gap_introduced;
  assert.throws(() => validateRefinement(legacy), /checks fields are invalid.*new_gap_introduced/u);

  const contradictory = acceptedResolution(await representativeRaw());
  contradictory.findings[0].resolution.checks.no_new_gap_introduced = "FAIL";
  assert.throws(() => validateRefinement(contradictory), /does not demonstrate closure/u);
});

test("duplicate IDs and broken source, evidence, relationship, question, and finding references fail", async () => {
  const duplicate = await representativeRaw();
  duplicate.needs.push({ ...clone(duplicate.needs[0]) });
  assert.throws(() => validateRefinement(duplicate), /IDs must be unique/u);

  const brokenNeed = await representativeRaw();
  brokenNeed.findings[0].need_ids = ["NEED-999"];
  assert.throws(() => validateRefinement(brokenNeed), /references missing NEED-999/u);

  const brokenEvidence = await representativeRaw();
  brokenEvidence.findings[0].evidence_ids = ["EVD-999"];
  assert.throws(() => validateRefinement(brokenEvidence), /references missing EVD-999/u);

  const brokenQuestion = await representativeRaw();
  brokenQuestion.questions[0].finding_ids = [];
  assert.throws(() => validateRefinement(brokenQuestion), /must contain 1-100 items/u);

  const oneSided = await representativeRaw();
  oneSided.findings[0].question_ids = [];
  assert.throws(() => validateRefinement(oneSided), /must reference each other/u);
});

test("epistemic categories remain distinct and cannot promote hypotheses to facts", async () => {
  const raw = await representativeRaw();
  raw.exploration.status = "INSUFFICIENT";
  raw.exploration.limitations = ["The persistence adapter could not be located within the bounded candidate set."];
  raw.evidence[2] = {
    id: "EVD-003",
    kind: "HYPOTHESIS",
    state: "ACTIVE",
    summary: "A race may exist",
    detail: "The asynchronous note suggests competing writes, but repository evidence is insufficient.",
    confidence: "TENTATIVE",
    source_ids: ["SRC-002"],
    need_ids: ["NEED-001", "NEED-002"],
    surface: "Order",
  };
  raw.exploration.files_read = [];
  assert.equal(validateRefinement(raw).evidence[2].confidence, "TENTATIVE");
  raw.evidence[2].confidence = "CONFIRMED";
  assert.throws(() => validateRefinement(raw), /must be TENTATIVE|cannot be CONFIRMED/u);
});

test("repository observations require bounded, explicitly recorded files", async () => {
  const missingScope = await representativeRaw();
  missingScope.exploration.files_read = [];
  assert.throws(() => validateRefinement(missingScope), /must be listed/u);
  const notNeeded = await representativeRaw();
  notNeeded.exploration.status = "NOT_NEEDED";
  assert.throws(() => validateRefinement(notNeeded), /cannot claim repository reads/u);
});

test("handoff is independently derived and open blocking findings cannot be hidden", async () => {
  const raw = await representativeRaw();
  assert.equal(expectedOutcome(validateRefinement(raw)), "BLOCKED");
  raw.handoff.outcome = "READY_FOR_SPEC";
  assert.throws(() => validateRefinement(raw), /must be BLOCKED/u);
  const missingBlocker = await representativeRaw();
  missingBlocker.handoff.blocker_ids = [];
  assert.throws(() => validateRefinement(missingBlocker), /must exactly equal/u);
});

test("READY handoffs reject material OPEN questions", async () => {
  const raw = await representativeRaw();
  raw.findings[0].severity = "ATTENTION";
  specHandoff(raw);
  raw.questions[0].status = "OPEN";
  delete raw.questions[0].answer;
  raw.questions[0].reopened_reason = "The answered decision must be revisited before handoff.";
  raw.questions[0].remaining_gaps = ["The material boundary is not yet ready for handoff."];
  raw.handoff.payload.question_ids = ["QST-001"];
  assert.equal(expectedOutcome({
    questions: [{ status: "OPEN" }],
    findings: [],
    final_assessment: raw.final_assessment,
  }), "BLOCKED");
  assert.throws(() => validateRefinement(raw), /handoff.outcome must be BLOCKED/u);
});

test("BLOCKING severity blocks only while the finding remains open", async () => {
  const open = validateRefinement(await representativeRaw());
  const resolved = validateRefinement(acceptedResolution(await representativeRaw()));
  const bypassRaw = await representativeRaw();
  bypassRaw.findings[0].disposition = "bypassed";
  bypassRaw.findings[0].bypass = {
    reason: "Explicitly outside this delivery.",
    known_risk: "The original concurrency risk remains known.",
  };
  specHandoff(bypassRaw, { carried: ["FND-001"] });
  const bypassed = validateRefinement(bypassRaw);

  assert.deepEqual(
    [open.handoff.outcome, resolved.handoff.outcome, bypassed.handoff.outcome],
    ["BLOCKED", "READY_FOR_SPEC", "READY_FOR_SPEC"],
  );
  assert.deepEqual(
    [open.findings[0].severity, resolved.findings[0].severity, bypassed.findings[0].severity],
    ["BLOCKING", "BLOCKING", "BLOCKING"],
  );
  assert.deepEqual([open.handoff.blocker_ids, resolved.handoff.blocker_ids, bypassed.handoff.blocker_ids], [["FND-001"], [], []]);
});

test("an open ATTENTION finding can follow a unitary boundary into SPEC", async () => {
  const raw = await representativeRaw();
  raw.findings[0].severity = "ATTENTION";
  specHandoff(raw, { carried: ["FND-001"] });
  const model = validateRefinement(raw);
  assert.equal(model.handoff.outcome, "READY_FOR_SPEC");
  assert.deepEqual(model.handoff.carried_finding_ids, ["FND-001"]);
});

test("multiple or ambiguous capabilities conservatively route to roadmap", async () => {
  for (const assessment of [
    { boundary: "MULTIPLE", capability_count: 2, decomposition_value: "MATERIAL", rationale: "Two independent capabilities." },
    { boundary: "AMBIGUOUS", capability_count: 2, decomposition_value: "UNCLEAR", rationale: "Candidate grouping is unclear." },
  ]) {
    const raw = acceptedResolution(await representativeRaw());
    raw.final_assessment = assessment;
    raw.handoff = {
      outcome: "READY_FOR_ROADMAP",
      reason: "Decomposition remains materially useful.",
      blocker_ids: [], carried_finding_ids: [], next_workflow: "stnl-spec-roadmap", suggested_next_operation: "OPERATION=INIT",
      payload: {
        kind: "ROADMAP", need_ids: ["NEED-001", "NEED-002"], finding_ids: [], question_ids: [],
        constraint_ids: ["CON-001"], relationship_ids: ["REL-001"],
        evidence_ids: ["EVD-001", "EVD-002", "EVD-003", "EVD-004"],
        roadmap_source: "Needs and cross-requirement context for decomposition.",
      },
    };
    assert.equal(validateRefinement(raw).handoff.outcome, "READY_FOR_ROADMAP");
  }
});

test("an unestablished boundary blocks even without an open BLOCKING finding", async () => {
  const raw = await representativeRaw();
  raw.findings[0].severity = "ATTENTION";
  raw.final_assessment = { boundary: "UNESTABLISHED", capability_count: 0, decomposition_value: "UNCLEAR", rationale: "The supplied scope cannot yet establish a boundary." };
  raw.handoff.blocker_ids = [];
  assert.equal(validateRefinement(raw).handoff.outcome, "BLOCKED");
});

test("canonical Requirement ownership prevents false Cross scope and preserves provenance", async () => {
  const model = validateRefinement(await historyRaw());
  assert.deepEqual(model.requirements[0].source_ids, ["SRC-001", "SRC-002", "SRC-003"]);
  assert.equal(model.questions[0].requirement_ids.length, 1);
  assert.equal(model.questions[0].source_ids.length, 2);
  assert.equal(questionInteractionState(model.questions[0]), "AWAITING_DECISION");
  assert.deepEqual(model.questions[1].requirement_ids, ["REQ-001", "REQ-003"]);
  assert.equal(questionInteractionState(model.questions[1]), "FOLLOW_UP_REQUIRED");
  assert.deepEqual(questionEstablishedContext(model.questions[1]), ["Search uses LIKE matching.", "Search composes after filters."]);
  assert.deepEqual(questionCurrentGaps(model.questions[1]), ["Accent sensitivity and minimum query length remain undefined."]);
  assert.equal(questionInteractionState(model.questions[2]), "ANSWERED");
  assert.deepEqual(model.evidence.find((item) => item.id === "EVD-005").source_ids, []);
  assert.deepEqual(model.relationships.find((item) => item.id === "REL-003").requirement_ids, ["REQ-001"]);
});

test("source order is not semantic, duplicate Requirement external IDs fail, and source evolution stays explicit", async () => {
  const original = validateRefinement(await historyRaw());
  const reordered = await historyRaw();
  reordered.requirements.reverse();
  reordered.sources.reverse();
  reordered.needs.reverse();
  reordered.evidence.reverse();
  reordered.relationships.reverse();
  reordered.questions.reverse();
  reordered.findings.reverse();
  assert.deepEqual(validateRefinement(reordered), original);

  const duplicateExternalId = await historyRaw();
  duplicateExternalId.requirements[1].external_id = "US 36134";
  assert.throws(() => validateRefinement(duplicateExternalId), /active Requirements cannot share external_id/u);

  const sourceWithoutExternalId = await historyRaw();
  delete sourceWithoutExternalId.sources[1].external_id;
  assert.equal(validateRefinement(sourceWithoutExternalId).requirements[0].id, "REQ-001");

  const addedSource = await historyRaw();
  addedSource.sources.push({ id: "SRC-006", kind: "TEXT", label: "US 36134 later note", state: "ACTIVE", original_text: "Later note for the same logical Requirement." });
  addedSource.requirements[0].source_ids.push("SRC-006");
  const addedModel = validateRefinement(addedSource);
  assert.equal(addedModel.requirements.length, original.requirements.length);
  assert.equal(validateRefinement(addedSource).requirements[0].source_ids.includes("SRC-006"), true);
  assert.doesNotThrow(() => validateReconcile(original, addedModel));

  const retiredSource = clone(addedSource);
  retiredSource.sources.find((item) => item.id === "SRC-003").state = "RETIRED";
  retiredSource.sources.find((item) => item.id === "SRC-003").retired_reason = "Superseded by the consolidated filter notes.";
  const retiredModel = validateRefinement(retiredSource);
  assert.equal(retiredModel.sources.find((item) => item.id === "SRC-003").state, "RETIRED");
  assert.equal(retiredModel.questions[1].reconciliation_attempts.length, original.questions[1].reconciliation_attempts.length);
  assert.doesNotThrow(() => validateReconcile(addedModel, retiredModel));
});

test("global technical findings remain explicit without inventing a Requirement", async () => {
  const raw = await historyRaw();
  raw.findings.push({
    id: "FND-005", title: "Global adapter observability gap", type: "TECHNICAL_GAP", severity: "ATTENTION", disposition: "open",
    requirement_ids: [], source_ids: [], need_ids: [], evidence_ids: ["EVD-005"], relationship_ids: [], question_ids: [],
    problem: "The shared adapter does not expose a diagnostic signal.", why_it_matters: "Operators cannot distinguish a query failure from an empty result.", impact: "The technical concern remains visible outside any single Requirement.",
  });
  raw.handoff.carried_finding_ids.push("FND-005");
  raw.handoff.payload.finding_ids.push("FND-005");
  const model = validateRefinement(raw);
  assert.deepEqual(model.findings.find((item) => item.id === "FND-005").requirement_ids, []);
  assert.equal(model.handoff.carried_finding_ids.includes("FND-005"), true);
});

test("partial reconciliation attempts append, preserve established context, and can close on a later round", async () => {
  const before = validateRefinement(await historyRaw());
  const partialRaw = await historyRaw();
  const partialQuestion = partialRaw.questions[1];
  partialQuestion.reconciliation_attempts.push({
    round: 2,
    human_response: "Accent-insensitive matching is not required; the minimum query length is three characters.",
    assessment: "FOLLOW_UP_REQUIRED",
    established_context: ["Accent-insensitive matching is out of scope."],
    remaining_gaps: ["The empty-query behavior remains undefined."],
    affected_finding_ids: ["FND-002"],
  });
  partialQuestion.remaining_gaps = ["The empty-query behavior remains undefined."];
  const partial = validateRefinement(partialRaw);
  assert.equal(questionInteractionState(partial.questions[1]), "FOLLOW_UP_REQUIRED");
  assert.doesNotThrow(() => validateReconcile(before, partial));

  const closedRaw = clone(partialRaw);
  const closedQuestion = closedRaw.questions[1];
  closedQuestion.status = "ANSWERED";
  closedQuestion.answer = "Search applies LIKE matching to the filtered result, excludes accent-insensitive matching, and requires at least three characters.";
  closedQuestion.canonical_answer_history = [closedQuestion.answer];
  closedQuestion.reconciliation_attempts.push({
    round: 3,
    human_response: "Use the filtered result, require three characters, and leave empty-query behavior out of this release.",
    assessment: "ACCEPTED",
    established_context: ["The empty-query behavior is explicitly out of scope for this release."],
    remaining_gaps: [],
    affected_finding_ids: ["FND-002"],
    canonical_answer: closedQuestion.answer,
  });
  delete closedQuestion.remaining_gaps;
  closedRaw.handoff.payload.question_ids = ["QST-001"];
  const closed = validateRefinement(closedRaw);
  assert.equal(questionInteractionState(closed.questions[1]), "ANSWERED");
  assert.equal(closed.questions[1].reconciliation_attempts.length, 3);
  assert.equal(closed.questions[1].reconciliation_attempts[0].human_response, before.questions[1].reconciliation_attempts[0].human_response);
  assert.doesNotThrow(() => validateReconcile(partial, closed));
});

test("duplicate and conflicting follow-up responses use explicit assessments", async () => {
  const duplicate = await historyRaw();
  duplicate.questions[1].reconciliation_attempts.push({
    round: 2,
    human_response: duplicate.questions[1].reconciliation_attempts[0].human_response,
    assessment: "FOLLOW_UP_REQUIRED",
    established_context: ["The same information was repeated."],
    remaining_gaps: duplicate.questions[1].remaining_gaps,
    affected_finding_ids: ["FND-002"],
  });
  assert.throws(() => validateRefinement(duplicate), /exact duplicate human_response/u);

  const conflicting = await historyRaw();
  conflicting.questions[1].reconciliation_attempts.push({
    round: 2,
    human_response: "Contrary to the first response, search must use exact matching.",
    assessment: "CONFLICTING_INFORMATION",
    established_context: ["The new response contradicts the earlier LIKE matching decision."],
    disputed_context: ["Search uses LIKE matching."],
    remaining_gaps: ["A single matching rule must be selected explicitly."],
    affected_finding_ids: ["FND-002"],
  });
  conflicting.questions[1].remaining_gaps = ["A single matching rule must be selected explicitly."];
  const model = validateRefinement(conflicting);
  assert.equal(model.questions[1].reconciliation_attempts[0].assessment, "FOLLOW_UP_REQUIRED");
  assert.equal(model.questions[1].reconciliation_attempts[1].assessment, "CONFLICTING_INFORMATION");

  const noProgress = await historyRaw();
  noProgress.questions[1].reconciliation_attempts.push({
    round: 2,
    human_response: "I do not have any additional detail for the unresolved search behavior.",
    assessment: "NO_MATERIAL_PROGRESS",
    established_context: [],
    remaining_gaps: noProgress.questions[1].remaining_gaps,
    affected_finding_ids: ["FND-002"],
  });
  const noProgressModel = validateRefinement(noProgress);
  assert.equal(noProgressModel.questions[1].reconciliation_attempts[1].assessment, "NO_MATERIAL_PROGRESS");
  assert.equal(questionInteractionState(noProgressModel.questions[1]), "FOLLOW_UP_REQUIRED");
});
