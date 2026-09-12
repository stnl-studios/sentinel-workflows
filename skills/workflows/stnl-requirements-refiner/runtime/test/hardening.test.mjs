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

function conflictAttempt(round, response, assessment, establishedContext, remainingGaps, disputedContext = undefined) {
  return {
    round,
    human_response: response,
    assessment,
    established_context: establishedContext,
    ...(disputedContext === undefined ? {} : { disputed_context: disputedContext }),
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
    assessment === "NO_MATERIAL_PROGRESS" ? undefined : ["Search uses LIKE matching."],
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

test("compatible follow-ups accumulate current context and NO_MATERIAL_PROGRESS preserves it", async () => {
  const baseline = validateRefinement(await historyRaw());
  const compatibleRaw = await historyRaw();
  const compatibleQuestion = compatibleRaw.questions[1];
  compatibleQuestion.reconciliation_attempts.push(conflictAttempt(
    2,
    "The minimum query length is three characters.",
    "FOLLOW_UP_REQUIRED",
    ["Minimum query length is 3."],
    ["Accent sensitivity remains undefined."],
  ));
  compatibleQuestion.remaining_gaps = ["Accent sensitivity remains undefined."];
  const compatible = validateRefinement(compatibleRaw);
  assert.deepEqual(questionEstablishedContext(compatible.questions[1]), [
    "Search uses LIKE matching.",
    "Search composes after filters.",
    "Minimum query length is 3.",
  ]);
  assert.doesNotThrow(() => validateReconcile(baseline, compatible));

  const noProgressRaw = clone(compatibleRaw);
  const noProgressQuestion = noProgressRaw.questions[1];
  noProgressQuestion.reconciliation_attempts.push(conflictAttempt(
    3,
    "No additional information is available.",
    "NO_MATERIAL_PROGRESS",
    [],
    ["Accent sensitivity remains undefined."],
  ));
  const noProgress = validateRefinement(noProgressRaw);
  assert.deepEqual(questionEstablishedContext(noProgress.questions[1]), questionEstablishedContext(compatible.questions[1]));
  assert.equal(questionConflictContext(noProgress.questions[1]), undefined);
  assert.doesNotThrow(() => validateReconcile(compatible, noProgress));
});

test("a conflict invalidates only explicitly disputed context without erasing history", async () => {
  const baseline = validateRefinement(await historyRaw());
  const noProgress = validateRefinement(historyConflict(await historyRaw(), "NO_MATERIAL_PROGRESS"));
  assert.deepEqual(questionEstablishedContext(noProgress.questions[1]), ["Search uses LIKE matching.", "Search composes after filters."]);
  assert.equal(questionConflictContext(noProgress.questions[1]), undefined);
  assert.doesNotThrow(() => validateReconcile(baseline, noProgress));

  const conflicting = validateRefinement(historyConflict(await historyRaw()));
  const question = conflicting.questions[1];
  assert.deepEqual(questionEstablishedContext(question), ["Search composes after filters."]);
  assert.deepEqual(questionHistoricalEstablishedContext(question), [
    "Search uses LIKE matching.",
    "Search composes after filters.",
    "Exact matching is required.",
  ]);
  assert.deepEqual(questionConflictContext(question), {
    round: 2,
    previous_disputed_context: ["Search uses LIKE matching."],
    conflicting_context: ["Exact matching is required."],
    remaining_gaps: ["Choose the matching rule for the shared result."],
  });
  const prompt = buildDecisionPrompt(conflicting, question, "Resolve the matching rule.");
  assert.match(prompt, /Previous disputed context:\nSearch uses LIKE matching\./u);
  assert.match(prompt, /New conflicting information:\nExact matching is required\./u);
  assert.match(prompt, /Current established context:\nSearch composes after filters\./u);
  assert.match(prompt, /Current status: Conflict requires reconciliation/u);
  assert.doesNotMatch(prompt, /Current established context:[\s\S]*Search uses LIKE matching\./u);
  const html = renderRefinement(conflicting).html;
  assert.match(html, /Previous disputed context/u);
  assert.match(html, /Current established context/u);
  assert.match(html, /New conflicting information/u);
  assert.match(html, /Conflict requires reconciliation/u);
  assert.match(html, /data-previous-disputed-context="Search uses LIKE matching\./u);
  assert.match(html, /data-new-conflicting-information="Exact matching is required\./u);
});

test("multiple disputed facts are removed while unrelated follow-ups accumulate under an active conflict", async () => {
  const cumulativeRaw = await historyRaw();
  const cumulativeQuestion = cumulativeRaw.questions[1];
  cumulativeQuestion.reconciliation_attempts.push(conflictAttempt(
    2, "C is established.", "FOLLOW_UP_REQUIRED", ["C"], ["One decision remains."],
  ));
  cumulativeQuestion.remaining_gaps = ["One decision remains."];
  const cumulative = validateRefinement(cumulativeRaw);

  const conflictRaw = clone(cumulativeRaw);
  const conflictQuestion = conflictRaw.questions[1];
  conflictQuestion.reconciliation_attempts.push(conflictAttempt(
    3,
    "The matching rule and C are both disputed by new information.",
    "CONFLICTING_INFORMATION",
    ["D"],
    ["Resolve the two disputed facts."],
    ["Search uses LIKE matching.", "C"],
  ));
  conflictQuestion.remaining_gaps = ["Resolve the two disputed facts."];
  const conflicting = validateRefinement(conflictRaw);
  assert.deepEqual(questionEstablishedContext(conflicting.questions[1]), ["Search composes after filters."]);
  assert.deepEqual(questionConflictContext(conflicting.questions[1]).previous_disputed_context, ["Search uses LIKE matching.", "C"]);
  assert.doesNotThrow(() => validateReconcile(cumulative, conflicting));

  const noProgressRaw = clone(conflictRaw);
  const noProgressQuestion = noProgressRaw.questions[1];
  noProgressQuestion.reconciliation_attempts.push(conflictAttempt(
    4,
    "No additional conflict resolution is available.",
    "NO_MATERIAL_PROGRESS",
    [],
    ["Resolve the two disputed facts."],
  ));
  const noProgress = validateRefinement(noProgressRaw);
  assert.deepEqual(questionEstablishedContext(noProgress.questions[1]), questionEstablishedContext(conflicting.questions[1]));
  assert.deepEqual(questionConflictContext(noProgress.questions[1]), questionConflictContext(conflicting.questions[1]));
  assert.doesNotThrow(() => validateReconcile(conflicting, noProgress));

  const followUpRaw = clone(noProgressRaw);
  const followUpQuestion = followUpRaw.questions[1];
  followUpQuestion.reconciliation_attempts.push(conflictAttempt(
    5,
    "An unrelated fact E is now established.",
    "FOLLOW_UP_REQUIRED",
    ["E"],
    ["Resolve the two disputed facts."],
  ));
  followUpQuestion.remaining_gaps = ["Resolve the two disputed facts."];
  const followUp = validateRefinement(followUpRaw);
  assert.deepEqual(questionEstablishedContext(followUp.questions[1]), ["Search composes after filters.", "E"]);
  assert.deepEqual(questionConflictContext(followUp.questions[1]), questionConflictContext(conflicting.questions[1]));
  assert.equal(followUp.questions[1].status, "OPEN");
  assert.doesNotThrow(() => validateReconcile(noProgress, followUp));

  const resolvedRaw = clone(followUpRaw);
  const resolvedQuestion = resolvedRaw.questions[1];
  const answer = "B, D, and E are the final canonical interpretation.";
  resolvedQuestion.reconciliation_attempts.push({
    ...conflictAttempt(6, "Resolve with B, D, and E.", "ACCEPTED", ["B", "D", "E"], []),
    canonical_answer: answer,
  });
  resolvedQuestion.status = "ANSWERED";
  resolvedQuestion.answer = answer;
  resolvedQuestion.canonical_answer_history = [answer];
  delete resolvedQuestion.remaining_gaps;
  resolvedRaw.handoff.payload.question_ids = ["QST-001"];
  const resolved = validateRefinement(resolvedRaw);
  assert.deepEqual(questionEstablishedContext(resolved.questions[1]), ["B", "D", "E"]);
  assert.equal(questionConflictContext(resolved.questions[1]), undefined);
  assert.equal(resolved.questions[1].reconciliation_attempts[2].assessment, "CONFLICTING_INFORMATION");
  assert.doesNotThrow(() => validateReconcile(followUp, resolved));
});

test("conflicts reject unknown, duplicate, and silently restored disputed context", async () => {
  const missingScope = await historyRaw();
  missingScope.questions[1].reconciliation_attempts.push(conflictAttempt(
    2, "Exact matching conflicts with LIKE.", "CONFLICTING_INFORMATION", ["Exact matching is required."], ["Resolve the conflict."],
  ));
  missingScope.questions[1].remaining_gaps = ["Resolve the conflict."];
  assert.throws(() => validateRefinement(missingScope), /requires conflicting established_context and non-empty disputed_context/u);

  const emptyNewContext = await historyRaw();
  emptyNewContext.questions[1].reconciliation_attempts.push(conflictAttempt(
    2, "LIKE is disputed without a replacement fact.", "CONFLICTING_INFORMATION", [], ["Resolve the conflict."], ["Search uses LIKE matching."],
  ));
  emptyNewContext.questions[1].remaining_gaps = ["Resolve the conflict."];
  assert.throws(() => validateRefinement(emptyNewContext), /requires conflicting established_context/u);

  const wrongAssessment = await historyRaw();
  wrongAssessment.questions[1].reconciliation_attempts.push(conflictAttempt(
    2, "A compatible follow-up cannot carry dispute scope.", "FOLLOW_UP_REQUIRED", ["E"], ["One gap remains."], ["Search uses LIKE matching."],
  ));
  wrongAssessment.questions[1].remaining_gaps = ["One gap remains."];
  assert.throws(() => validateRefinement(wrongAssessment), /reserved for CONFLICTING_INFORMATION/u);

  const unknown = await historyRaw();
  unknown.questions[1].reconciliation_attempts.push(conflictAttempt(
    2, "Unknown context is disputed.", "CONFLICTING_INFORMATION", ["D"], ["Resolve the conflict."], ["Never established"],
  ));
  unknown.questions[1].remaining_gaps = ["Resolve the conflict."];
  assert.throws(() => validateRefinement(unknown), /not currently established/u);

  const duplicate = historyConflict(await historyRaw());
  duplicate.questions[1].reconciliation_attempts[1].disputed_context.push("Search uses LIKE matching.");
  assert.throws(() => validateRefinement(duplicate), /contains duplicates/u);

  const restored = historyConflict(await historyRaw());
  restored.questions[1].reconciliation_attempts.push(conflictAttempt(
    3,
    "Restore the disputed LIKE fact without resolving the conflict.",
    "FOLLOW_UP_REQUIRED",
    ["Search uses LIKE matching."],
    ["Choose the matching rule for the shared result."],
  ));
  restored.questions[1].remaining_gaps = ["Choose the matching rule for the shared result."];
  assert.throws(() => validateRefinement(restored), /cannot restore active conflict facts/u);
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

test("reopened context accumulates independently and conflicts can dispute only that current cycle", async () => {
  const initialRaw = acceptedResolution(await representativeRaw());
  const initial = validateRefinement(initialRaw);
  const reopenedRaw = answeredToOpen(
    initialRaw,
    1,
    "New evidence reopens the accepted cancellation rule.",
    initial.questions[0].answer,
    ["The replacement eligibility rule remains open."],
  );
  const reopened = validateRefinement(reopenedRaw);
  assert.deepEqual(questionEstablishedContext(reopened.questions[0]), []);

  const followUpRaw = clone(reopenedRaw);
  followUpRaw.questions[0].reconciliation_attempts.push({
    round: 2,
    human_response: "PACKING is currently considered eligible.",
    assessment: "FOLLOW_UP_REQUIRED",
    established_context: ["PACKING is eligible for cancellation."],
    remaining_gaps: ["The race precedence remains open."],
    affected_finding_ids: ["FND-001"],
  });
  followUpRaw.questions[0].remaining_gaps = ["The race precedence remains open."];
  const followUp = validateRefinement(followUpRaw);
  assert.deepEqual(questionEstablishedContext(followUp.questions[0]), ["PACKING is eligible for cancellation."]);
  assert.doesNotThrow(() => validateReconcile(reopened, followUp));

  const invalidPriorCycle = clone(followUpRaw);
  invalidPriorCycle.questions[0].reconciliation_attempts.push({
    round: 3,
    human_response: "Dispute a fact from the challenged prior answer.",
    assessment: "CONFLICTING_INFORMATION",
    established_context: ["The prior answer is no longer valid."],
    disputed_context: [initial.questions[0].reconciliation_attempts[0].established_context[0]],
    remaining_gaps: ["The reopened rule remains unresolved."],
    affected_finding_ids: ["FND-001"],
  });
  invalidPriorCycle.questions[0].remaining_gaps = ["The reopened rule remains unresolved."];
  assert.throws(() => validateRefinement(invalidPriorCycle), /not currently established/u);

  const conflictRaw = clone(followUpRaw);
  conflictRaw.questions[0].reconciliation_attempts.push({
    round: 3,
    human_response: "PACKING is not eligible after all.",
    assessment: "CONFLICTING_INFORMATION",
    established_context: ["PACKING is not eligible for cancellation."],
    disputed_context: ["PACKING is eligible for cancellation."],
    remaining_gaps: ["Choose the reopened PACKING rule."],
    affected_finding_ids: ["FND-001"],
  });
  conflictRaw.questions[0].remaining_gaps = ["Choose the reopened PACKING rule."];
  const conflicting = validateRefinement(conflictRaw);
  assert.deepEqual(questionEstablishedContext(conflicting.questions[0]), []);
  assert.deepEqual(questionConflictContext(conflicting.questions[0]).previous_disputed_context, ["PACKING is eligible for cancellation."]);
  assert.doesNotThrow(() => validateReconcile(followUp, conflicting));

  const finalAnswer = "PACKING is not eligible; SHIPPED retains precedence.";
  const resolved = validateRefinement(appendAccepted(conflicting, 4, "Confirm the reopened replacement rule.", finalAnswer));
  assert.deepEqual(questionEstablishedContext(resolved.questions[0]), [finalAnswer]);
  assert.equal(questionConflictContext(resolved.questions[0]), undefined);
  assert.deepEqual(resolved.questions[0].canonical_answer_history, [initial.questions[0].answer, finalAnswer]);
  assert.doesNotThrow(() => validateReconcile(conflicting, resolved));
});
