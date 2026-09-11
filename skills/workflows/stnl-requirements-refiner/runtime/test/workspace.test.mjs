import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as vm from "node:vm";
import test from "node:test";

import { validateRefinement } from "../lib/model.mjs";
import { buildAdditionalInformationPrompt, buildAggregateDecisionPrompt, buildDecisionPrompt, renderRefinement } from "../lib/render.mjs";
import { acceptedResolution, clone, representativeRaw } from "./helpers.mjs";

async function multiRaw() {
  return JSON.parse(await fs.readFile(new URL("./fixtures/multi-us-refinement.json", import.meta.url), "utf8"));
}

function roadmapReady(raw) {
  const next = clone(raw);
  next.findings[0].severity = "ATTENTION";
  next.questions[0].status = "ANSWERED";
  next.questions[0].answer = "The roadmap carries the remaining non-blocking finding context.";
  next.handoff = {
    outcome: "READY_FOR_ROADMAP", reason: "Three material capabilities require decomposition.", blocker_ids: [], carried_finding_ids: ["FND-001"],
    next_workflow: "stnl-spec-roadmap", suggested_next_operation: "OPERATION=INIT",
    payload: { kind: "ROADMAP", need_ids: ["NEED-001", "NEED-002"], finding_ids: ["FND-001"], question_ids: [], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"], roadmap_source: "Cancellation and shipping boundaries require a roadmap." },
  };
  next.final_assessment = { boundary: "MULTIPLE", capability_count: 2, decomposition_value: "MATERIAL", rationale: "Two capabilities need decomposition." };
  return next;
}

class FakeElement {
  constructor({ id = "", dataset = {}, textContent = "", value = "" } = {}) {
    this.id = id;
    this.dataset = dataset;
    this.textContent = textContent;
    this.value = value;
    this.disabled = false;
    this.listeners = new Map();
    this.style = {};
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }

  focus() {}
  select() {}
  setAttribute() {}
}

class FakeDecisionCard extends FakeElement {
  constructor(question, maps) {
    const textarea = new FakeElement({
      id: `draft-${question.id}`,
      dataset: {
        questionId: question.id,
        sourceIdsList: question.source_ids.join(", "),
        needIdsList: question.need_ids.join(", "),
        findingIdsList: question.finding_ids.join(", "),
        requirementIdentity: question.source_ids.map((id) => maps.source.get(id).external_id ?? id).join(" ↔ "),
      },
    });
    super({ dataset: { questionId: question.id }, textContent: "" });
    this.textarea = textarea;
    this.questionText = new FakeElement({ textContent: question.question });
    this.copy = new FakeElement();
    this.clear = new FakeElement();
    this.status = new FakeElement();
    this.open = true;
  }

  querySelector(selector) {
    if (selector === "[data-draft-decision]") return this.textarea;
    if (selector === "[data-question-id]") return this.textarea;
    if (selector === "[data-question-text]") return this.questionText;
    if (selector === "[data-copy-decision]") return this.copy;
    if (selector === "[data-clear-draft]") return this.clear;
    if (selector === ".decision-copy-status") return this.status;
    return null;
  }
}

function browserRuntime(model, refinementPath = "docs/refinement") {
  const html = renderRefinement(model, { refinementPath }).html;
  const script = html.match(/<script>([\s\S]*)<\/script>/u)?.[1];
  assert.ok(script, "rendered page must contain its active client script");
  const maps = { source: new Map(model.sources.map((item) => [item.id, item])) };
  const openQuestions = model.questions.filter((item) => item.status === "OPEN");
  const draftMode = model.handoff.outcome !== "BLOCKED" ? "none" : openQuestions.length === 0 ? "additional-information" : "decisions";
  const cards = draftMode === "decisions" ? [...openQuestions].reverse().map((item) => new FakeDecisionCard(item, maps)) : [];
  const main = new FakeElement({ dataset: {
    handoffWorkflow: model.handoff.next_workflow,
    handoffOperation: model.handoff.suggested_next_operation,
    refinementId: model.refinement_id,
    refinementPath,
    draftMode,
    blockingFindingIdsList: model.handoff.blocker_ids.join(", "),
    carriedFindingIdsList: model.handoff.carried_finding_ids.filter((id) => !model.handoff.blocker_ids.includes(id)).join(", "),
  } });
  const elements = new Map([["main", main], ["print", new FakeElement()]]);
  const summary = draftMode === "none" ? null : new FakeElement({ id: "draft-summary" });
  const readinessSummary = draftMode === "none" ? null : new FakeElement({ id: "readiness-draft-summary" });
  if (summary) elements.set("draft-summary", summary);
  if (readinessSummary) elements.set("readiness-draft-summary", readinessSummary);
  const copied = [];
  if (draftMode === "additional-information") {
    elements.set("additional-information-draft", new FakeElement({ id: "additional-information-draft" }));
    elements.set("copy-additional-information", new FakeElement({ id: "copy-additional-information" }));
    elements.set("clear-additional-information", new FakeElement({ id: "clear-additional-information" }));
    elements.set("additional-information-status", new FakeElement({ id: "additional-information-status" }));
  } else if (draftMode === "decisions") {
    elements.set("continue-prompt", new FakeElement({ id: "continue-prompt" }));
    elements.set("copy-decisions", new FakeElement({ id: "copy-decisions" }));
    elements.set("aggregate-copy-status", new FakeElement({ id: "aggregate-copy-status" }));
  } else {
    elements.set("continue-prompt", new FakeElement({ id: "continue-prompt" }));
    elements.set("copy-prompt", new FakeElement({ id: "copy-prompt" }));
    elements.set("copy-status", new FakeElement({ id: "copy-status" }));
  }
  const document = {
    body: { append() {} },
    getElementById(id) { return elements.get(id) ?? null; },
    querySelectorAll(selector) {
      if (selector === '[data-decision-card][data-open="true"]') return cards;
      return [];
    },
    createElement() { return new FakeElement(); },
    execCommand() { return false; },
  };
  const context = {
    document,
    navigator: { clipboard: { writeText(value) { copied.push(value); return Promise.resolve(); } } },
    window: { print() {} },
    addEventListener() {},
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(script, context, { filename: "rendered-refinement-client.js" });
  return { html, cards, elements, copied, summary, readinessSummary };
}

function rejected(raw) {
  raw.findings[0].resolution = {
    proposal: "Read status before cancelling.",
    verdict: "rejected",
    rationale: "A separate read and write does not eliminate the race.",
    checks: { behavior_defined: "PASS", ambiguity_closed: "FAIL", repository_consistent: "FAIL", no_new_gap_introduced: "PASS", problem_fully_addressed: "FAIL" },
    supporting_evidence_ids: ["EVD-003"],
    remaining_gap: "Atomicity and transition precedence remain undefined.",
  };
  return raw;
}

function inconclusive(raw) {
  raw.findings[0].resolution = {
    proposal: "Use a conditional transition after clarifying the eligible states.",
    verdict: "inconclusive",
    rationale: "The repository does not establish the required conflict response.",
    checks: { behavior_defined: "PASS", ambiguity_closed: "UNKNOWN", repository_consistent: "UNKNOWN", no_new_gap_introduced: "PASS", problem_fully_addressed: "UNKNOWN" },
    supporting_evidence_ids: ["EVD-003"],
    remaining_gap: "The conflict response and eligible state set remain unknown.",
  };
  return raw;
}

function bypassed(raw) {
  raw.questions[0].status = "ANSWERED";
  raw.questions[0].answer = "The bypassed risk is explicitly carried to the downstream handoff.";
  raw.findings[0].disposition = "bypassed";
  raw.findings[0].bypass = { reason: "Explicitly outside this delivery.", known_risk: "The race remains known and observable." };
  raw.handoff = {
    outcome: "READY_FOR_SPEC", reason: "The blocker was explicitly bypassed.", blocker_ids: [], carried_finding_ids: ["FND-001"],
    next_workflow: "stnl-spec-lifecycle-manager", suggested_next_operation: "MODE=INIT",
    payload: { kind: "SPEC", need_ids: ["NEED-001", "NEED-002"], finding_ids: ["FND-001"], question_ids: [], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"], suggested_spec_title: "Order cancellation", requirements_source: "Cancellation behavior with an explicitly bypassed concurrency risk." },
  };
  return raw;
}

function reopened(raw) {
  const accepted = clone(raw);
  accepted.findings[0].disposition = "resolved";
  accepted.findings[0].resolution = {
    proposal: "SHIPPED wins; cancellation uses compare-and-set on current state.",
    verdict: "accepted",
    rationale: "The transition is atomic and its conflict behavior is defined.",
    checks: { behavior_defined: "PASS", ambiguity_closed: "PASS", repository_consistent: "PASS", no_new_gap_introduced: "PASS", problem_fully_addressed: "PASS" },
    supporting_evidence_ids: ["EVD-003"],
  };
  accepted.questions[0].status = "ANSWERED";
  accepted.questions[0].answer = "SHIPPED wins and cancellation uses compare-and-set.";
  accepted.handoff = {
    outcome: "READY_FOR_SPEC", reason: "The unitary cancellation boundary is ready.", blocker_ids: [], carried_finding_ids: [],
    next_workflow: "stnl-spec-lifecycle-manager", suggested_next_operation: "MODE=INIT",
    payload: { kind: "SPEC", need_ids: ["NEED-001", "NEED-002"], finding_ids: [], question_ids: [], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"], suggested_spec_title: "Atomic cancellation", requirements_source: "Atomic cancellation before shipment." },
  };
  accepted.findings[0].disposition = "open";
  accepted.findings[0].reopened_reason = "New repository evidence shows a worker path that can still win after the read.";
  accepted.findings[0].resolution = {
    proposal: "SHIPPED wins; cancellation uses compare-and-set on current state.",
    verdict: "inconclusive",
    rationale: "The new path is not covered by the accepted validation.",
    checks: { behavior_defined: "PASS", ambiguity_closed: "UNKNOWN", repository_consistent: "UNKNOWN", no_new_gap_introduced: "UNKNOWN", problem_fully_addressed: "UNKNOWN" },
    supporting_evidence_ids: ["EVD-003"],
    remaining_gap: "The newly observed worker path still needs an atomic conflict rule.",
  };
  accepted.handoff = {
    outcome: "BLOCKED", reason: "The resolved finding was reopened by new evidence.", blocker_ids: ["FND-001"], carried_finding_ids: ["FND-001"],
    next_workflow: "stnl-requirements-refiner", suggested_next_operation: "OPERATION=RECONCILE",
    payload: { kind: "REFINEMENT", need_ids: ["NEED-001", "NEED-002"], finding_ids: ["FND-001"], question_ids: [], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"] },
  };
  return accepted;
}

function questionlessBlocking(raw) {
  raw.questions = [];
  raw.findings.forEach((finding) => { finding.question_ids = []; });
  raw.handoff.blocker_ids = raw.findings.filter((finding) => finding.disposition === "open" && finding.severity === "BLOCKING").map((finding) => finding.id);
  raw.handoff.carried_finding_ids = raw.findings.map((finding) => finding.id);
  raw.handoff.payload.question_ids = [];
  return raw;
}

async function tenOpenQuestions() {
  const raw = await representativeRaw();
  raw.questions = Array.from({ length: 10 }, (_, index) => ({
    id: `QST-${String(index + 1).padStart(3, "0")}`,
    question: `Decision ${index + 1} is required.`, status: "OPEN", why_material: "The answer changes the documented behavior.",
    source_ids: ["SRC-001", "SRC-002"], need_ids: ["NEED-001", "NEED-002"], finding_ids: [`FND-${String(index + 1).padStart(3, "0")}`], evidence_ids: ["EVD-001"],
  }));
  raw.findings = Array.from({ length: 10 }, (_, index) => ({
    id: `FND-${String(index + 1).padStart(3, "0")}`, title: `Open finding ${index + 1}`, type: "TECHNICAL_GAP", severity: "BLOCKING", disposition: "open",
    source_ids: ["SRC-001", "SRC-002"], need_ids: ["NEED-001", "NEED-002"], evidence_ids: ["EVD-001"], relationship_ids: [],
    question_ids: [`QST-${String(index + 1).padStart(3, "0")}`], problem: "The behavior is not established.", why_it_matters: "The result would be ambiguous.", impact: "The refinement remains blocked.",
  }));
  raw.handoff = {
    outcome: "BLOCKED", reason: "Ten open blocking findings require reconciliation.", blocker_ids: raw.findings.map((item) => item.id), carried_finding_ids: raw.findings.map((item) => item.id),
    next_workflow: "stnl-requirements-refiner", suggested_next_operation: "OPERATION=RECONCILE",
    payload: { kind: "REFINEMENT", need_ids: ["NEED-001", "NEED-002"], finding_ids: raw.findings.map((item) => item.id), question_ids: raw.questions.map((item) => item.id), constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"] },
  };
  return raw;
}

test("canonical suggested operation is copied literally and never re-derived by the renderer", async () => {
  const model = validateRefinement(await representativeRaw());
  model.handoff.suggested_next_operation = "OPERATION=RECONCILE_CUSTOM";
  const prompt = buildDecisionPrompt(model, model.questions[0], "Use the existing transition.", "planning/refinement");
  assert.match(prompt, /OPERATION=RECONCILE_CUSTOM/u);
  assert.doesNotMatch(prompt, /\nOPERATION=RECONCILE\n/u);
  assert.match(renderRefinement(model).html, /data-handoff-operation="OPERATION=RECONCILE_CUSTOM"/u);
});

test("ready prompts retain canonical lifecycle operation and payload", async () => {
  const raw = await representativeRaw();
  const { acceptedResolution } = await import("./helpers.mjs");
  const model = validateRefinement(acceptedResolution(raw));
  const html = renderRefinement(model).html;
  assert.match(html, /data-handoff-operation="MODE=INIT"/u);
  assert.match(html, /MODE=INIT/u);
  assert.match(html, /SPEC_PATH=specs\/order-cancellation/u);
  assert.doesNotMatch(html, /OPERATION=RECONCILE_CUSTOM/u);
});

test("READY client startup tolerates the absent reconciliation summaries and controls", async () => {
  const models = [
    validateRefinement(acceptedResolution(await representativeRaw())),
    validateRefinement(roadmapReady(await representativeRaw())),
  ];
  for (const model of models) {
    let runtime;
    assert.doesNotThrow(() => { runtime = browserRuntime(model); });
    assert.equal(runtime.elements.get("main").dataset.draftMode, "none");
    assert.equal(runtime.elements.get("draft-summary"), undefined);
    assert.equal(runtime.elements.get("readiness-draft-summary"), undefined);
    assert.equal(runtime.summary, null);
    assert.equal(runtime.readinessSummary, null);
    assert.equal(runtime.cards.length, 0);
    assert.ok(runtime.elements.get("copy-prompt"));
  }
});

test("requirement details progressively disclose all canonical detail fields and source paths", async () => {
  const raw = await representativeRaw();
  raw.needs[0].preconditions = ["The order exists"];
  raw.needs[0].acceptance_signals = ["The order becomes cancelled"];
  raw.needs[0].negative_signals = ["A shipped order is not cancelled"];
  const html = renderRefinement(validateRefinement(raw)).html;
  assert.match(html, /Requirement details/u);
  assert.match(html, /Customer/u);
  assert.match(html, /The order exists/u);
  assert.match(html, /The order becomes cancelled/u);
  assert.match(html, /A shipped order is not cancelled/u);
  assert.match(html, /precisa colocar um botão para cancelar pedido/u);
  assert.match(html, /docs\/requirements\.md/u);
  assert.match(html, /<details class="requirement-details">/u);
  const firstRequirementStart = html.indexOf('<article class="requirement-card" id="SRC-001"');
  const secondRequirementStart = html.indexOf('<article class="requirement-card" id="SRC-002"');
  const firstRequirement = html.slice(firstRequirementStart, secondRequirementStart);
  const originalSources = firstRequirement.match(/<section class="original-sources">[\s\S]*?<\/section>/u)?.[0] ?? "";
  assert.match(originalSources, /SRC-001/u);
  assert.doesNotMatch(originalSources, /SRC-002|O worker de expedição/u);
});

test("browser serializer matches the Node contract and aggregates entries directly in canonical order", async () => {
  const model = validateRefinement(await multiRaw());
  const runtime = browserRuntime(model, "planning/refinement");
  const decisions = new Map([
    ["QST-002", "shared NEW_INFORMATION:\n`code` ✓ <\/textarea> & \"quotes\""],
    ["QST-001", "first line\nsecond line"],
  ]);
  for (const card of runtime.cards) {
    const decision = decisions.get(card.textarea.dataset.questionId);
    if (decision !== undefined) {
      card.textarea.value = decision;
      card.textarea.dispatch("input");
    }
  }
  const expected = buildAggregateDecisionPrompt(model, decisions, "planning/refinement");
  assert.equal(runtime.elements.get("continue-prompt").value, expected);
  assert.equal(runtime.summary.textContent, "3 open · 2 answered in draft · 1 remaining");
  assert.match(runtime.elements.get("continue-prompt").value, /NEW_INFORMATION:/gu);
  assert.ok(runtime.elements.get("continue-prompt").value.indexOf("### QST-001") < runtime.elements.get("continue-prompt").value.indexOf("### QST-002"));
  assert.doesNotMatch(runtime.html.match(/<script>([\s\S]*)<\/script>/u)?.[1] ?? "", /\.split\(/u);

  const individual = runtime.cards.find((card) => card.textarea.dataset.questionId === "QST-002");
  individual.copy.dispatch("click");
  assert.equal(runtime.copied.at(-1), buildDecisionPrompt(model, model.questions.find((item) => item.id === "QST-002"), decisions.get("QST-002"), "planning/refinement"));
});

test("renderer contains one active implementation and one client script", async () => {
  const source = await fs.readFile(new URL("../lib/render.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\blegacy[A-Z]\w*/u);
  assert.doesNotMatch(source, /CLIENT_SCRIPT_V2/u);
  assert.equal((source.match(/const CLIENT_SCRIPT\s*=/gu) ?? []).length, 1);
  assert.equal((source.match(/export function renderRefinement/gu) ?? []).length, 1);
});

test("resolution projection preserves accepted, rejected, inconclusive, bypassed, historical, and reopened semantics", async () => {
  const accepted = renderRefinement(validateRefinement((await import("./helpers.mjs")).acceptedResolution(await representativeRaw()))).html;
  assert.match(accepted, /Resolution accepted · validation passed/u);
  assert.match(accepted, /Historical severity: BLOCKING/u);
  assert.doesNotMatch(accepted, /finding-card technical-card is-blocking/u);
  for (const [candidate, markers] of [[rejected(await representativeRaw()), ["Resolution rejected · remaining gap", "Atomicity and transition precedence remain undefined.", "FAIL"]], [inconclusive(await representativeRaw()), ["Resolution inconclusive · unresolved uncertainty", "The conflict response and eligible state set remain unknown.", "UNKNOWN"]], [bypassed(await representativeRaw()), ["BYPASSED", "Historical severity: BLOCKING", "The race remains known and observable."]], [reopened(await representativeRaw()), ["OPEN", "Reopened reason:", "The newly observed worker path still needs an atomic conflict rule."]]]) {
    const html = renderRefinement(validateRefinement(candidate)).html;
    markers.forEach((marker) => assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")));
  }
});

test("questionless findings use a neutral Other findings group while preserving every type badge", async () => {
  const raw = await multiRaw();
  raw.findings.push(
    { id: "FND-005", title: "Risk without a decision", type: "RISK", severity: "ATTENTION", disposition: "open", source_ids: ["SRC-001"], need_ids: ["NEED-001"], evidence_ids: ["EVD-001"], relationship_ids: [], question_ids: [], problem: "A risk is not bounded.", why_it_matters: "The risk can surprise delivery.", impact: "Risk remains visible." },
    { id: "FND-006", title: "Requirement gap without a decision", type: "REQUIREMENT_GAP", severity: "ATTENTION", disposition: "open", source_ids: ["SRC-001"], need_ids: ["NEED-001"], evidence_ids: ["EVD-001"], relationship_ids: [], question_ids: [], problem: "A requirement detail is missing.", why_it_matters: "The result cannot be verified.", impact: "Requirement gap remains visible." },
    { id: "FND-007", title: "Cross requirement gap without a decision", type: "CROSS_REQUIREMENT_GAP", severity: "ATTENTION", disposition: "open", source_ids: ["SRC-001", "SRC-002", "SRC-003"], need_ids: ["NEED-001", "NEED-002", "NEED-003"], evidence_ids: ["EVD-004"], relationship_ids: ["REL-003"], question_ids: [], problem: "The shared rule is missing.", why_it_matters: "Requirements can diverge.", impact: "Cross requirement gap remains visible." },
  );
  raw.handoff.carried_finding_ids.push("FND-005", "FND-006", "FND-007");
  raw.handoff.payload.finding_ids.push("FND-005", "FND-006", "FND-007");
  const html = renderRefinement(validateRefinement(raw)).html;
  assert.match(html, /Other findings <span>3<\/span>/u);
  for (const type of ["RISK", "REQUIREMENT_GAP", "CROSS_REQUIREMENT_GAP"]) assert.match(html, new RegExp(type, "u"));
  assert.match(html, /Technical findings <span>1<\/span>/u);
});

test("OPEN and ANSWERED decisions have distinct projection affordances", async () => {
  const openHtml = renderRefinement(validateRefinement(await representativeRaw())).html;
  assert.match(openHtml, /data-draft-decision/u);
  assert.match(openHtml, /Copy this decision/u);
  assert.match(openHtml, /data-copy-decision[^>]+disabled/u);
  assert.match(openHtml, /data-clear-draft[^>]+disabled/u);
  assert.match(openHtml, /for="draft-QST-001"/u);
  const answeredHtml = renderRefinement(validateRefinement((await import("./helpers.mjs")).acceptedResolution(await representativeRaw()))).html;
  assert.match(answeredHtml, /Canonical answer/u);
  assert.match(answeredHtml, /SHIPPED wins; cancellation uses a conditional update/u);
  assert.doesNotMatch(answeredHtml, /<textarea[^>]*data-draft-decision/u);
});

test("blocked aggregate copy starts disabled while ready handoffs keep their canonical prompt", async () => {
  const blockedHtml = renderRefinement(validateRefinement(await multiRaw())).html;
  assert.match(blockedHtml, /id="copy-decisions"[^>]+disabled/u);
  assert.match(blockedHtml, /Copy 0 decisions for RECONCILE/u);
  const { acceptedResolution } = await import("./helpers.mjs");
  const readyHtml = renderRefinement(validateRefinement(acceptedResolution(await representativeRaw()))).html;
  assert.doesNotMatch(readyHtml, /<button[^>]+id="copy-decisions"/u);
  assert.match(readyHtml, /<textarea id="continue-prompt"[^>]*>[^<]*MODE=INIT/u);
});

test("reopened BLOCKED finding without OPEN questions gets a generic reconciliation draft", async () => {
  const model = validateRefinement(reopened(await representativeRaw()));
  const html = renderRefinement(model, { refinementPath: "planning/refinement" }).html;
  assert.equal(model.handoff.outcome, "BLOCKED");
  assert.equal(model.questions.filter((question) => question.status === "OPEN").length, 0);
  assert.match(html, /Additional information — draft/u);
  assert.match(html, /data-generic-reconciliation/u);
  assert.match(html, /id="copy-additional-information"[^>]+disabled/u);
  assert.doesNotMatch(html, /<button[^>]+id="copy-decisions"|<textarea[^>]+data-draft-decision/u);

  const runtime = browserRuntime(model, "planning/refinement");
  const draft = runtime.elements.get("additional-information-draft");
  const copy = runtime.elements.get("copy-additional-information");
  assert.equal(copy.disabled, true);
  const information = "Reopened clarification\nNEW_INFORMATION:\n`code` <\/textarea> <script> ✓ & \"quotes\"";
  draft.value = information;
  draft.dispatch("input");
  assert.equal(copy.disabled, false);
  copy.dispatch("click");
  assert.equal(runtime.copied.at(-1), buildAdditionalInformationPrompt(model, information, "planning/refinement"));
  assert.match(runtime.copied.at(-1), /Blocking finding IDs: FND-001/u);
});

test("questionless BLOCKING findings also expose the generic reconciliation path", async () => {
  const model = validateRefinement(questionlessBlocking(await representativeRaw()));
  const html = renderRefinement(model).html;
  assert.equal(model.questions.length, 0);
  assert.equal(model.handoff.outcome, "BLOCKED");
  assert.match(html, /Additional information — draft/u);
  assert.doesNotMatch(html, /<button[^>]+id="copy-decisions"|<textarea[^>]+id="continue-prompt"/u);
  assert.match(buildAdditionalInformationPrompt(model, "A human confirms the blocker context."), /Blocking finding IDs: FND-001/u);
});

test("aggregate reconciliation supports partial input, ignores blanks, and preserves canonical order", async () => {
  const model = validateRefinement(await tenOpenQuestions());
  const decisions = new Map([["QST-004", "four"], ["QST-001", "one"], ["QST-002", "two"], ["QST-003", "three"], ["QST-005", "   "]]);
  const prompt = buildAggregateDecisionPrompt(model, decisions, "docs/refinement");
  assert.match(prompt, /OPERATION=RECONCILE/u);
  assert.equal(["QST-001", "QST-002", "QST-003", "QST-004"].filter((id) => prompt.includes("### " + id)).length, 4);
  assert.match(prompt, /### QST-001/u);
  assert.match(prompt, /### QST-004/u);
  assert.doesNotMatch(prompt, /QST-005|QST-006|QST-007|QST-008|QST-009|QST-010/u);
  assert.equal(buildAggregateDecisionPrompt(model, new Map(), "docs/refinement"), "");
  assert.equal(model.handoff.outcome, "BLOCKED");
  assert.equal(model.questions.filter((item) => item.status === "OPEN").length, 10);
});

test("individual prompt carries full scope, authority metadata, and hostile multiline text as data, not markup", async () => {
  const model = validateRefinement(await representativeRaw());
  const decision = "<script>\n</textarea> & \"quotes\" `code` — decisão";
  const prompt = buildDecisionPrompt(model, model.questions[0], decision, "planning/refinement");
  for (const marker of ["OPERATION=RECONCILE", "REFINEMENT_PATH=planning/refinement", "REFINEMENT_ID=REF-ORDER-CANCELLATION", "QST-001", "US-41 ↔ SRC-002", "SRC-001, SRC-002", "FND-001", decision]) assert.match(prompt, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const html = renderRefinement(model).html;
  assert.doesNotMatch(html, /<script>\n<\/textarea>/u);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie|fetch\s*\(|eval\s*\(|new Function/u);
  assert.match(html, /data-source-ids="SRC-001 SRC-002"/u);
  assert.match(html, /data-finding-ids="FND-001"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /data-draft-decision[^>]*><\/textarea>/u);
  const repeat = renderRefinement(model);
  assert.equal(repeat.html, html);
  assert.equal(repeat.fingerprint, renderRefinement(model).fingerprint);
});
