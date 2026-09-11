import assert from "node:assert/strict";
import test from "node:test";

import { buildDecisionPrompt, renderRefinement } from "../lib/render.mjs";
import {
  questionConflictContext,
  questionEstablishedContext,
  questionHistoricalEstablishedContext,
  questionInteractionState,
  validateReconcile,
  validateRefinement,
} from "../lib/model.mjs";
import { acceptedResolution, clone, historyRaw, representativeRaw } from "./helpers.mjs";

function conflictAttempt(round, response, assessment, establishedContext, remainingGaps) {
  return {
    round,
    human_response: response,
    assessment,
    established_context: establishedContext,
    remaining_gaps: remainingGaps,
    affected_finding_ids: ["FND-002"],
  };
}

function historyConflict(raw, assessment = "CONFLICTING_INFORMATION") {
  const next = clone(raw);
  const question = next.questions[1];
  const gaps = ["Choose the matching rule for the shared result."];
  question.reconciliation_attempts.push(conflictAttempt(
    2,
    assessment === "NO_MATERIAL_PROGRESS" ? "No additional matching information is available." : "Actually search should use exact matching.",
    assessment,
    assessment === "NO_MATERIAL_PROGRESS" ? [] : ["Exact matching is required."],
    gaps,
  ));
  question.remaining_gaps = gaps;
  return next;
}

function answerConflict(raw) {
  const next = historyConflict(raw);
  const question = next.questions[1];
  const answer = "Search uses exact matching over the filtered result.";
  question.reconciliation_attempts.push({
    ...conflictAttempt(3, "Confirm exact matching over the filtered result.", "ACCEPTED", ["Exact matching is required."], []),
    canonical_answer: answer,
  });
  question.status = "ANSWERED";
  question.answer = answer;
  question.canonical_answer_history = [answer];
  delete question.remaining_gaps;
  next.handoff.payload.question_ids = ["QST-001"];
  return next;
}

function blockedHandoff(raw, questionIds = ["QST-001"]) {
  raw.handoff = {
    outcome: "BLOCKED",
    reason: "The current decision requires reconciliation.",
    blocker_ids: [],
    carried_finding_ids: [],
    next_workflow: "stnl-requirements-refiner",
    suggested_next_operation: "OPERATION=RECONCILE",
    payload: {
      kind: "REFINEMENT",
      need_ids: raw.needs.filter((item) => item.state === "ACTIVE").map((item) => item.id),
      finding_ids: [],
      question_ids: questionIds,
      constraint_ids: raw.constraints.filter((item) => item.state === "ACTIVE").map((item) => item.id),
      relationship_ids: raw.relationships.filter((item) => item.state === "ACTIVE").map((item) => item.id),
      evidence_ids: raw.evidence.filter((item) => item.state === "ACTIVE").map((item) => item.id),
    },
  };
  return raw;
}

test("NO_MATERIAL_PROGRESS preserves current context while conflict invalidates it without erasing history", async () => {
  const baseline = validateRefinement(await historyRaw());
  const noProgress = validateRefinement(historyConflict(await historyRaw(), "NO_MATERIAL_PROGRESS"));
  assert.deepEqual(questionEstablishedContext(noProgress.questions[1]), ["Search uses LIKE matching.", "Search composes after filters."]);
  assert.equal(questionConflictContext(noProgress.questions[1]), undefined);
  assert.doesNotThrow(() => validateReconcile(baseline, noProgress));

  const conflicting = validateRefinement(historyConflict(await historyRaw()));
  const question = conflicting.questions[1];
  assert.deepEqual(questionEstablishedContext(question), []);
  assert.deepEqual(questionHistoricalEstablishedContext(question), [
    "Search uses LIKE matching.",
    "Search composes after filters.",
    "Exact matching is required.",
  ]);
  assert.deepEqual(questionConflictContext(question), {
    round: 2,
    previous_context: ["Search uses LIKE matching.", "Search composes after filters."],
    conflicting_context: ["Exact matching is required."],
    remaining_gaps: ["Choose the matching rule for the shared result."],
  });
  const prompt = buildDecisionPrompt(conflicting, question, "Resolve the matching rule.");
  assert.match(prompt, /Previous established context:\nSearch uses LIKE matching\./u);
  assert.match(prompt, /New conflicting information:\nExact matching is required\./u);
  assert.match(prompt, /Current status: Conflict requires reconciliation/u);
  assert.doesNotMatch(prompt, /What this established:\nSearch uses LIKE matching\./u);
  const html = renderRefinement(conflicting).html;
  assert.match(html, /Previous established context/u);
  assert.match(html, /New conflicting information/u);
  assert.match(html, /Conflict requires reconciliation/u);
  assert.match(html, /data-previous-established-context="Search uses LIKE matching\./u);
  assert.match(html, /data-conflicting-information="Exact matching is required\./u);
});

test("an accepted third round replaces disputed context and closes the question", async () => {
  const before = validateRefinement(await historyRaw());
  const conflicting = validateRefinement(historyConflict(await historyRaw()));
  const resolved = validateRefinement(answerConflict(await historyRaw()));
  const question = resolved.questions[1];
  assert.equal(question.status, "ANSWERED");
  assert.deepEqual(question.reconciliation_attempts.map((attempt) => attempt.assessment), [
    "FOLLOW_UP_REQUIRED", "CONFLICTING_INFORMATION", "ACCEPTED",
  ]);
  assert.deepEqual(questionEstablishedContext(question), ["Exact matching is required."]);
  assert.equal(questionConflictContext(question), undefined);
  assert.deepEqual(question.canonical_answer_history, ["Search uses exact matching over the filtered result."]);
  assert.equal(questionInteractionState(question), "ANSWERED");
  assert.doesNotThrow(() => validateReconcile(before, conflicting));
  assert.doesNotThrow(() => validateReconcile(conflicting, resolved));
});

function answeredToOpen(raw, sequence, reason, priorAnswer, gaps) {
  const next = clone(raw);
  const question = next.questions[0];
  question.status = "OPEN";
  question.reopened_reason = reason;
  question.remaining_gaps = gaps;
  question.reopen_events = [
    ...(question.reopen_events ?? []),
    { sequence, reason, prior_canonical_answer: priorAnswer, remaining_gaps: gaps },
  ];
  blockedHandoff(next, ["QST-001"]);
  return next;
}

function appendFollowUp(raw, round, response, gap) {
  const next = clone(raw);
  const question = next.questions[0];
  question.reconciliation_attempts.push({
    round,
    human_response: response,
    assessment: "FOLLOW_UP_REQUIRED",
    established_context: [],
    remaining_gaps: [gap],
    affected_finding_ids: ["FND-001"],
  });
  question.remaining_gaps = [gap];
  blockedHandoff(next, ["QST-001"]);
  return next;
}

function appendAccepted(raw, round, response, answer) {
  const next = clone(raw);
  const question = next.questions[0];
  question.status = "ANSWERED";
  question.answer = answer;
  question.canonical_answer_history.push(answer);
  question.reconciliation_attempts.push({
    round,
    human_response: response,
    assessment: "ACCEPTED",
    established_context: [answer],
    remaining_gaps: [],
    affected_finding_ids: ["FND-001"],
    canonical_answer: answer,
  });
  delete question.remaining_gaps;
  delete question.reopened_reason;
  next.handoff = {
    outcome: "READY_FOR_SPEC",
    reason: "The current answer closes the unitary decision.",
    blocker_ids: [],
    carried_finding_ids: [],
    next_workflow: "stnl-spec-lifecycle-manager",
    suggested_next_operation: "MODE=INIT",
    payload: {
      kind: "SPEC",
      need_ids: ["NEED-001", "NEED-002"],
      finding_ids: [],
      question_ids: [],
      constraint_ids: ["CON-001"],
      relationship_ids: ["REL-001"],
      evidence_ids: ["EVD-001", "EVD-002", "EVD-003", "EVD-004"],
      suggested_spec_title: "Atomic order cancellation",
      requirements_source: answer,
    },
  };
  return next;
}

test("reopen events and canonical answers retain every lifecycle cycle without fabricating attempts", async () => {
  const initialRaw = acceptedResolution(await representativeRaw());
  const initial = validateRefinement(initialRaw);
  const answerA = initial.questions[0].answer;
  assert.equal(questionInteractionState(initial.questions[0]), "ANSWERED");

  const reopenOne = validateRefinement(answeredToOpen(initialRaw, 1, "R1: new evidence invalidates answer A.", answerA, ["The new evidence must be reconciled."]));
  assert.equal(questionInteractionState(reopenOne.questions[0]), "REOPENED_FOLLOW_UP_REQUIRED");
  assert.deepEqual(questionEstablishedContext(reopenOne.questions[0]), []);
  assert.deepEqual(reopenOne.questions[0].reopen_events.map((event) => event.reason), ["R1: new evidence invalidates answer A."]);
  assert.doesNotThrow(() => validateReconcile(initial, reopenOne));

  const followOne = validateRefinement(appendFollowUp(reopenOne, 2, "The first follow-up adds the new evidence.", "The first new evidence remains unresolved."));
  assert.equal(questionInteractionState(followOne.questions[0]), "REOPENED_FOLLOW_UP_REQUIRED");
  assert.equal(followOne.questions[0].reconciliation_attempts.length, 2);
  assert.doesNotThrow(() => validateReconcile(reopenOne, followOne));

  const answerBText = "The current state is checked atomically before cancellation.";
  const answerB = validateRefinement(appendAccepted(followOne, 3, "Confirm answer B.", answerBText));
  assert.equal(questionInteractionState(answerB.questions[0]), "ANSWERED");
  assert.deepEqual(answerB.questions[0].canonical_answer_history, [answerA, answerBText]);
  assert.deepEqual(questionEstablishedContext(answerB.questions[0]), [answerBText]);
  assert.deepEqual(answerB.questions[0].reopen_events.map((event) => event.reason), ["R1: new evidence invalidates answer A."]);
  assert.equal(answerB.questions[0].reopened_reason, undefined);
  assert.doesNotThrow(() => validateReconcile(followOne, answerB));

  const reopenTwo = validateRefinement(answeredToOpen(answerB, 2, "R2: a different source invalidates answer B.", answerBText, ["The second evidence conflict must be resolved."]));
  assert.equal(questionInteractionState(reopenTwo.questions[0]), "REOPENED_FOLLOW_UP_REQUIRED");
  assert.deepEqual(questionEstablishedContext(reopenTwo.questions[0]), []);
  assert.deepEqual(reopenTwo.questions[0].reopen_events.map((event) => event.reason), [
    "R1: new evidence invalidates answer A.",
    "R2: a different source invalidates answer B.",
  ]);
  assert.equal(reopenTwo.questions[0].reopened_reason, "R2: a different source invalidates answer B.");
  assert.doesNotThrow(() => validateReconcile(answerB, reopenTwo));

  const followTwo = validateRefinement(appendFollowUp(reopenTwo, 4, "The second follow-up identifies the replacement rule.", "The replacement rule remains unresolved."));
  const answerCText = "The replacement rule is authoritative for the next release.";
  const answerC = validateRefinement(appendAccepted(followTwo, 5, "Confirm answer C.", answerCText));
  assert.doesNotThrow(() => validateReconcile(reopenTwo, followTwo));
  assert.doesNotThrow(() => validateReconcile(followTwo, answerC));
  assert.deepEqual(answerC.questions[0].canonical_answer_history, [answerA, answerBText, answerCText]);
  assert.deepEqual(answerC.questions[0].reopen_events.map((event) => event.reason), [
    "R1: new evidence invalidates answer A.",
    "R2: a different source invalidates answer B.",
  ]);
  assert.equal(answerC.questions[0].answer, answerCText);
  assert.equal(answerC.questions[0].reopened_reason, undefined);
  assert.equal(answerC.questions[0].reconciliation_attempts.length, 5);
  assert.equal(answerC.questions[0].reconciliation_attempts.some((attempt) => Object.hasOwn(attempt, "reopen_reason")), false);
  assert.equal(questionInteractionState(answerC.questions[0]), "ANSWERED");
  const historyMarkup = renderRefinement(answerC).html;
  assert.match(historyMarkup, /Previous reopen cycles <span>2<\/span>/u);
  assert.match(historyMarkup, /R1: new evidence invalidates answer A\./u);
  assert.match(historyMarkup, /R2: a different source invalidates answer B\./u);

  const reorderedEvents = clone(answerC);
  reorderedEvents.questions[0].reopen_events.reverse();
  assert.throws(() => validateReconcile(answerC, validateRefinement(reorderedEvents)), /append-only|sequences/u);
  const changedFirstReason = clone(answerC);
  changedFirstReason.questions[0].reopen_events[0].reason = "Changed historical reason.";
  assert.throws(() => validateReconcile(answerC, validateRefinement(changedFirstReason)), /append-only/u);
});
