import assert from "node:assert/strict";
import test from "node:test";

import { validateReconcile, validateRefinement } from "../lib/model.mjs";
import { acceptedResolution, clone, historyRaw, recordAcceptedDecision, representativeRaw } from "./helpers.mjs";

function rejected(raw, verdict = "rejected") {
  const next = clone(raw);
  next.findings[0].resolution = {
    proposal: "Read the status before cancelling.",
    verdict,
    rationale: verdict === "rejected" ? "A separate read and write does not eliminate the race." : "The persistence primitive is not yet known.",
    checks: {
      behavior_defined: "PASS",
      ambiguity_closed: verdict === "rejected" ? "FAIL" : "UNKNOWN",
      repository_consistent: verdict === "rejected" ? "FAIL" : "UNKNOWN",
      no_new_gap_introduced: "PASS",
      problem_fully_addressed: verdict === "rejected" ? "FAIL" : "UNKNOWN",
    },
    supporting_evidence_ids: ["EVD-003"],
    remaining_gap: verdict === "rejected" ? "Atomicity and race precedence remain undefined." : "The repository write contract is still unknown.",
  };
  return next;
}

test("a valid resolution closes the same finding with structured validation", async () => {
  const before = validateRefinement(await representativeRaw());
  const after = validateRefinement(acceptedResolution(await representativeRaw()));
  assert.equal(validateReconcile(before, after).findings[0].id, "FND-001");
  assert.equal(after.findings[0].resolution.verdict, "accepted");
  assert.equal(after.handoff.outcome, "READY_FOR_SPEC");
});

test("incomplete or invalid resolution remains open and does not allocate a duplicate finding", async () => {
  for (const verdict of ["rejected", "inconclusive"]) {
    const raw = rejected(await representativeRaw(), verdict);
    const model = validateRefinement(raw);
    assert.equal(model.findings.length, 1);
    assert.equal(model.findings[0].disposition, "open");
    assert.equal(model.findings[0].resolution.verdict, verdict);
    assert.equal(model.handoff.outcome, "BLOCKED");
  }
});

test("structurally dishonest resolution verdicts fail closed", async () => {
  const accepted = acceptedResolution(await representativeRaw());
  accepted.findings[0].resolution.checks.problem_fully_addressed = "FAIL";
  assert.throws(() => validateRefinement(accepted), /does not demonstrate closure/u);
  const rejectedRaw = rejected(await representativeRaw());
  for (const key of Object.keys(rejectedRaw.findings[0].resolution.checks)) rejectedRaw.findings[0].resolution.checks[key] = "PASS";
  assert.throws(() => validateRefinement(rejectedRaw), /requires at least one failed check/u);
});

test("explicit bypass is distinct from resolution, preserves risk, and stops blocking", async () => {
  const raw = await representativeRaw();
  recordAcceptedDecision(raw, 0, "The concurrency risk is explicitly carried to the downstream handoff.");
  raw.findings[0].disposition = "bypassed";
  raw.findings[0].bypass = {
    reason: "Out of scope for this delivery; risk explicitly accepted.",
    known_risk: "Concurrent shipping and cancellation may still conflict until a later delivery.",
  };
  raw.handoff = {
    outcome: "READY_FOR_SPEC", reason: "The only BLOCKING finding was explicitly bypassed.", blocker_ids: [],
    carried_finding_ids: ["FND-001"], next_workflow: "stnl-spec-lifecycle-manager", suggested_next_operation: "MODE=INIT",
    payload: {
      kind: "SPEC", need_ids: ["NEED-001", "NEED-002"], finding_ids: ["FND-001"], question_ids: [],
      constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"],
      suggested_spec_title: "Order cancellation", requirements_source: "Customer cancellation before shipping, carrying the bypassed concurrency risk.",
    },
  };
  const model = validateRefinement(raw);
  assert.equal(model.findings[0].disposition, "bypassed");
  assert.equal(model.findings[0].resolution, undefined);
  assert.match(model.findings[0].bypass.known_risk, /still conflict/u);
  assert.equal(model.handoff.outcome, "READY_FOR_SPEC");

  const masquerade = clone(raw);
  masquerade.findings[0].resolution = acceptedResolution(await representativeRaw()).findings[0].resolution;
  assert.throws(() => validateRefinement(masquerade), /masquerade/u);
});

test("changed requirement content preserves identity, while repurposed identity fails", async () => {
  const before = validateRefinement(await representativeRaw());
  const changed = await representativeRaw();
  changed.needs[0].statement = "A customer needs to cancel an eligible order before a committed shipment.";
  assert.equal(validateReconcile(before, validateRefinement(changed)).needs[0].id, "NEED-001");
  const repurposed = await representativeRaw();
  repurposed.needs[0].title = "Refund an invoice";
  assert.throws(() => validateReconcile(before, validateRefinement(repurposed)), /stable need identity changed/u);
});

test("new evidence and relationships allocate only the next monotonic IDs", async () => {
  const before = validateRefinement(await representativeRaw());
  const raw = await representativeRaw();
  raw.evidence.push({ id: "EVD-004", kind: "INFERENCE", state: "ACTIVE", summary: "A conditional write may be required", detail: "The shared state suggests an atomic guard may be necessary.", confidence: "SUPPORTED", source_ids: [], need_ids: ["NEED-001", "NEED-002"], surface: "Order" });
  raw.relationships.push({ id: "REL-002", type: "SHARED_TECHNICAL_SURFACE", title: "Shared Order persistence", state: "ACTIVE", requirement_ids: ["REQ-001"], need_ids: ["NEED-001", "NEED-002"], evidence_ids: ["EVD-003", "EVD-004"], detail: "Both needs change the same persisted aggregate." });
  raw.findings[0].evidence_ids.push("EVD-004");
  raw.findings[0].relationship_ids.push("REL-002");
  raw.handoff.payload.evidence_ids.push("EVD-004");
  raw.handoff.payload.relationship_ids.push("REL-002");
  const after = validateRefinement(raw);
  assert.equal(validateReconcile(before, after).relationships[1].id, "REL-002");
  const gap = await representativeRaw();
  gap.evidence.push({ ...clone(raw.evidence[3]), id: "EVD-005" });
  gap.handoff.payload.evidence_ids.push("EVD-005");
  assert.throws(() => validateRefinement(gap), /contiguous and monotonic/u);
});

test("accepted resolution can reopen under new evidence without changing finding identity", async () => {
  const acceptedRaw = acceptedResolution(await representativeRaw());
  const before = validateRefinement(acceptedRaw);
  const reopened = clone(acceptedRaw);
  reopened.findings[0].disposition = "open";
  reopened.findings[0].reopened_reason = "New repository evidence shows that the adapter cannot perform conditional updates.";
  reopened.findings[0].resolution.verdict = "rejected";
  reopened.findings[0].resolution.rationale = "The preserved proposal no longer closes the gap against current repository evidence.";
  reopened.findings[0].resolution.checks.repository_consistent = "FAIL";
  reopened.findings[0].resolution.checks.problem_fully_addressed = "FAIL";
  reopened.findings[0].resolution.remaining_gap = "No atomic persistence primitive is available yet.";
  reopened.handoff = {
    outcome: "BLOCKED", reason: "FND-001 was reopened.", blocker_ids: ["FND-001"], carried_finding_ids: ["FND-001"],
    next_workflow: "stnl-requirements-refiner", suggested_next_operation: "OPERATION=RECONCILE",
    payload: { kind: "REFINEMENT", need_ids: ["NEED-001", "NEED-002"], finding_ids: ["FND-001"], question_ids: [], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003", "EVD-004"] },
  };
  const after = validateRefinement(reopened);
  assert.equal(validateReconcile(before, after).findings[0].id, "FND-001");
});

test("reopening without reason or by replacing the accepted proposal fails", async () => {
  const before = validateRefinement(acceptedResolution(await representativeRaw()));
  const raw = acceptedResolution(await representativeRaw());
  raw.findings[0].disposition = "open";
  raw.findings[0].resolution = rejected(await representativeRaw()).findings[0].resolution;
  raw.handoff = (await representativeRaw()).handoff;
  raw.handoff.payload.question_ids = [];
  raw.handoff.payload.evidence_ids.push("EVD-004");
  const withoutReason = validateRefinement(raw);
  assert.throws(() => validateReconcile(before, withoutReason), /reopening requires reopened_reason/u);
  raw.findings[0].reopened_reason = "New evidence invalidated the decision.";
  assert.throws(() => validateReconcile(before, validateRefinement(raw)), /must preserve its proposal/u);
});

test("reconciliation history is append-only and cannot be edited, deleted, or reordered", async () => {
  const before = validateRefinement(await historyRaw());

  const mutated = await historyRaw();
  mutated.questions[1].reconciliation_attempts[0].human_response = "Edited after publication.";
  assert.throws(() => validateReconcile(before, validateRefinement(mutated)), /append-only and prior entries are immutable/u);

  const deleted = await historyRaw();
  deleted.questions[1].reconciliation_attempts = [];
  delete deleted.questions[1].remaining_gaps;
  assert.throws(() => validateReconcile(before, validateRefinement(deleted)), /reconciliation attempts cannot be deleted/u);

  const reordered = await historyRaw();
  reordered.questions[1].reconciliation_attempts.push({
    round: 2,
    human_response: "A second response adds another unresolved search rule.",
    assessment: "FOLLOW_UP_REQUIRED",
    established_context: ["A second search rule is now explicit."],
    remaining_gaps: ["The matching rule is still unresolved."],
    affected_finding_ids: ["FND-002"],
  });
  reordered.questions[1].remaining_gaps = ["The matching rule is still unresolved."];
  reordered.questions[1].reconciliation_attempts.reverse();
  assert.throws(() => validateRefinement(reordered), /rounds must be contiguous and monotonic/u);
});

test("disputed-context references in published attempts are append-only", async () => {
  const raw = await historyRaw();
  raw.questions[1].reconciliation_attempts.push({
    round: 2,
    human_response: "Use exact matching instead of LIKE matching.",
    assessment: "CONFLICTING_INFORMATION",
    established_context: ["Exact matching is required."],
    disputed_context: ["Search uses LIKE matching."],
    remaining_gaps: ["Choose the matching rule."],
    affected_finding_ids: ["FND-002"],
  });
  raw.questions[1].remaining_gaps = ["Choose the matching rule."];
  const before = validateRefinement(raw);
  const changed = clone(raw);
  changed.questions[1].reconciliation_attempts[1].disputed_context = ["Search composes after filters."];
  const candidate = validateRefinement(changed);
  assert.throws(() => validateReconcile(before, candidate), /append-only and prior entries are immutable/u);
});

test("reconcile rejects changing Requirement scope or moving a Source to hide prior Cross context", async () => {
  const before = validateRefinement(await historyRaw());
  const hiddenCross = await historyRaw();
  hiddenCross.questions[1].requirement_ids = ["REQ-001"];
  assert.throws(() => validateRefinement(hiddenCross), /requirement_ids must exactly equal/u);

  const moved = await historyRaw();
  const first = moved.requirements.find((item) => item.id === "REQ-001");
  const third = moved.requirements.find((item) => item.id === "REQ-003");
  first.source_ids = ["SRC-001", "SRC-002"];
  first.need_ids = ["NEED-001"];
  third.source_ids = ["SRC-003", "SRC-005"];
  third.need_ids = ["NEED-002", "NEED-004"];
  moved.relationships[2].requirement_ids = ["REQ-001", "REQ-003"];
  assert.throws(() => validateReconcile(before, validateRefinement(moved)), /cannot move between Requirements/u);
});

test("a question must be explicitly reopened before receiving another attempt", async () => {
  const before = validateRefinement(acceptedResolution(await representativeRaw()));
  const raw = acceptedResolution(await representativeRaw());
  const question = raw.questions[0];
  const nextAnswer = "The previously accepted answer is revised after a new repository observation.";
  question.reconciliation_attempts.push({
    round: 2,
    human_response: nextAnswer,
    assessment: "ACCEPTED",
    established_context: ["A new observation changes the accepted decision."],
    remaining_gaps: [],
    affected_finding_ids: ["FND-001"],
    canonical_answer: nextAnswer,
  });
  question.canonical_answer_history.push(nextAnswer);
  question.answer = nextAnswer;
  const after = validateRefinement(raw);
  assert.throws(() => validateReconcile(before, after), /cannot receive an attempt while ANSWERED/u);
});

test("reopening preserves the previous canonical answer and allows a later follow-up", async () => {
  const before = validateRefinement(acceptedResolution(await representativeRaw()));
  const reopenedRaw = acceptedResolution(await representativeRaw());
  reopenedRaw.questions[0].status = "OPEN";
  reopenedRaw.questions[0].reopened_reason = "New repository evidence invalidated the previous conclusion.";
  reopenedRaw.questions[0].remaining_gaps = ["The new conflict behavior is undefined."];
  reopenedRaw.handoff = {
    outcome: "BLOCKED", reason: "The answered decision was reopened.", blocker_ids: [], carried_finding_ids: [],
    next_workflow: "stnl-requirements-refiner", suggested_next_operation: "OPERATION=RECONCILE",
    payload: { kind: "REFINEMENT", need_ids: ["NEED-001", "NEED-002"], finding_ids: [], question_ids: ["QST-001"], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003", "EVD-004"] },
  };
  const reopened = validateRefinement(reopenedRaw);
  assert.equal(reopened.questions[0].canonical_answer_history.length, 1);
  assert.doesNotThrow(() => validateReconcile(before, reopened));

  const lost = clone(reopenedRaw);
  lost.questions[0].canonical_answer_history = [];
  delete lost.questions[0].answer;
  assert.throws(() => validateRefinement(lost), /canonical_answer_history/u);
});
