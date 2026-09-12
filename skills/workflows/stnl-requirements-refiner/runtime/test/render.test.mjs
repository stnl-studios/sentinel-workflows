import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateRefinement } from "../lib/model.mjs";
import { hasRefinementOwnershipMarker } from "../lib/publish.mjs";
import { buildDecisionPrompt, renderRefinement } from "../lib/render.mjs";
import { acceptedResolution, clone, FIXTURES, historyRaw, recordAcceptedDecision, representativeRaw } from "./helpers.mjs";

async function multiRaw() {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, "multi-us-refinement.json"), "utf8"));
}

function specReady(raw) {
  const next = acceptedResolution(raw);
  return next;
}

function roadmapReady(raw) {
  raw.findings[0].severity = "ATTENTION";
  recordAcceptedDecision(raw, 0, "The roadmap carries the remaining non-blocking finding context.");
  raw.handoff = {
    outcome: "READY_FOR_ROADMAP", reason: "Three material capabilities require decomposition.", blocker_ids: [], carried_finding_ids: ["FND-001"],
    next_workflow: "stnl-spec-roadmap", suggested_next_operation: "OPERATION=INIT",
    payload: { kind: "ROADMAP", need_ids: ["NEED-001", "NEED-002"], finding_ids: ["FND-001"], question_ids: [], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"], roadmap_source: "Cancellation and shipping boundaries require a roadmap." },
  };
  raw.final_assessment = { boundary: "MULTIPLE", capability_count: 2, decomposition_value: "MATERIAL", rationale: "Two capabilities need decomposition." };
  return raw;
}

function blockedWithoutOpen(raw) {
  const next = clone(raw);
  recordAcceptedDecision(next, 0, "The clarification is recorded while the blocking finding remains open.");
  next.handoff.payload.question_ids = [];
  return next;
}

function visibleMarkup(html) {
  return html.replace(/<script>[\s\S]*?<\/script>/u, "");
}

test("renderer is deterministic, offline, owned, and fingerprint-verifiable", async () => {
  const model = validateRefinement(await representativeRaw());
  const first = renderRefinement(model);
  assert.deepEqual(renderRefinement(model), first);
  assert.equal(hasRefinementOwnershipMarker(first.html), true);
  const draft = first.html.replaceAll(first.fingerprint, "0".repeat(64)).replaceAll(first.fingerprint.slice(0, 12), "0".repeat(12));
  assert.equal(createHash("sha256").update(draft, "utf8").digest("hex"), first.fingerprint);
  assert.match(first.html, /Content-Security-Policy[^>]+default-src 'none'/u);
  assert.doesNotMatch(first.html, /<link\b|<img\b|https?:\/\//iu);
});

test("single requirement stays compact while retaining its visible requirement identity", async () => {
  const raw = await representativeRaw();
  raw.sources = [raw.sources[0]];
  raw.needs = [raw.needs[0]];
  raw.requirements[0].source_ids = ["SRC-001"];
  raw.requirements[0].need_ids = ["NEED-001"];
  raw.evidence = [raw.evidence[0]];
  raw.relationships = [];
  raw.questions[0].source_ids = ["SRC-001"];
  raw.questions[0].need_ids = ["NEED-001"];
  raw.questions[0].evidence_ids = ["EVD-001"];
  raw.findings[0].source_ids = ["SRC-001"];
  raw.findings[0].need_ids = ["NEED-001"];
  raw.findings[0].evidence_ids = ["EVD-001"];
  raw.findings[0].relationship_ids = [];
  raw.constraints = [];
  raw.handoff.payload = { kind: "REFINEMENT", need_ids: ["NEED-001"], finding_ids: ["FND-001"], question_ids: ["QST-001"], constraint_ids: [], relationship_ids: [], evidence_ids: ["EVD-001"] };
  const html = renderRefinement(validateRefinement(raw)).html;
  assert.match(html, /US-41/u);
  assert.match(html, /1 Requirements · 1 Sources · 1 Decisions · 0 Follow-ups · 1 Blockers · BLOCKED/u);
  assert.match(html, /Requirements<\/h2>/u);
  assert.doesNotMatch(html, /SRC-002/u);
});

test("multi-US projection groups decisions/findings and keeps cross-US identity", async () => {
  const html = renderRefinement(validateRefinement(await multiRaw())).html;
  for (const marker of ["US 36134", "US 36174", "US 36198", "Which advanced filters are in scope?", "Which current result does Excel export represent?", "Which fields participate in free-text search?", "Result adapter is currently hardcoded", "US 36134 ↔ US 36174 ↔ US 36198"]) {
    assert.match(html, new RegExp(marker, "u"));
  }
  assert.match(html, /3 Requirements · 3 Sources · 3 Decisions · 0 Follow-ups · 3 Blockers · BLOCKED/u);
  assert.match(html, /US 36198 → US 36134/u);
  assert.match(html, /US 36174 → US 36134/u);
  assert.match(html, /Cross findings/u);
  assert.equal((html.match(/<article class="requirement-card"/gu) ?? []).length, 3);
});

test("cross-US decisions have one canonical interaction surface and references in every affected requirement", async () => {
  const html = renderRefinement(validateRefinement(await multiRaw())).html;
  assert.match(html, /id="cross-requirements"[\s\S]*?Cross decisions/u);
  assert.match(html, /id="decision-QST-002"/u);
  assert.equal((html.match(/data-question-id="QST-002"/gu) ?? []).length, 1);
  assert.equal((html.match(/Cross-requirement decision · <code>QST-002<\/code>/gu) ?? []).length, 3);
  assert.match(html, /US 36134 ↔ US 36174 ↔ US 36198/u);
  assert.doesNotMatch(html, /id="SRC-001-QST-002"|id="SRC-002-QST-002"|id="SRC-003-QST-002"/u);
  assert.match(html, /3 Requirements · 3 Sources · 3 Decisions · 0 Follow-ups · 3 Blockers · BLOCKED/u);
});

test("requirement source disclosure stays local when findings or decisions are cross-US", async () => {
  const raw = await multiRaw();
  const html = renderRefinement(validateRefinement(raw)).html;
  const starts = ["REQ-001", "REQ-002", "REQ-003"].map((id) => html.indexOf(`<article class="requirement-card" id="${id}"`));
  const texts = raw.sources.map((source) => source.original_text);
  starts.forEach((start, index) => {
    const end = index === starts.length - 1 ? html.indexOf('<section class="cross-decisions"') : starts[index + 1];
    const card = html.slice(start, end);
    const disclosure = card.match(/<section class="original-sources">[\s\S]*?<\/section>/u)?.[0] ?? "";
    assert.match(disclosure, new RegExp(texts[index].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    texts.filter((_, otherIndex) => otherIndex !== index).forEach((text) => {
      assert.doesNotMatch(disclosure, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    });
  });
});

test("decision cards lead while technical-only and questionless blockers remain represented", async () => {
  const raw = await multiRaw();
  raw.findings[3].severity = "BLOCKING";
  raw.handoff.blocker_ids = ["FND-001", "FND-002", "FND-003", "FND-004"];
  const html = renderRefinement(validateRefinement(raw)).html;
  assert.match(html, /class="decision-card(?:\s|")/u);
  assert.match(html, /QST-001/u);
  assert.match(html, /Result adapter is currently hardcoded/u);
  assert.match(html, /technical-card is-blocking/u);
});

test("BLOCKED continue workflow is canonical RECONCILE with exact rendered copy payload", async () => {
  const html = renderRefinement(validateRefinement(await multiRaw()), { refinementPath: "planning/refinement" }).html;
  assert.match(html, /Recommended workflow<\/span><h3>Reconcile refinement/u);
  assert.match(html, /OPERATION=RECONCILE/u);
  assert.match(html, /data-refinement-path="planning\/refinement"/u);
  for (const questionId of ["QST-001", "QST-002", "QST-003"]) assert.match(html, new RegExp(questionId, "u"));
  assert.doesNotMatch(html, /Start SPEC|Start Roadmap/u);
  assert.match(html, /id="copy-decisions"/u);
  assert.match(html, /navigator\.clipboard\.writeText\(value\)/u);
  assert.match(html, /document\.execCommand\("copy"\)/u);
});

test("ready handoffs produce SPEC and Roadmap prompts from canonical payload", async () => {
  const spec = renderRefinement(validateRefinement(specReady(await representativeRaw()))).html;
  assert.match(spec, /Start SPEC/u);
  assert.match(spec, /MODE=INIT/u);
  assert.match(spec, /SPEC_PATH=specs\/order-cancellation/u);
  assert.match(spec, /REQUIREMENTS_SOURCE=Customer cancellation/u);

  const roadmap = renderRefinement(validateRefinement(roadmapReady(await representativeRaw()))).html;
  assert.match(roadmap, /Start Roadmap/u);
  assert.match(roadmap, /OPERATION=INIT/u);
  assert.match(roadmap, /ROADMAP_SOURCE=Cancellation and shipping boundaries require a roadmap/u);
});

test("draft summary exists only for an active reconciliation workspace", async () => {
  const blockedOpen = renderRefinement(validateRefinement(await multiRaw())).html;
  assert.match(blockedOpen, /<p class="draft-summary" id="readiness-draft-summary"[^>]*>3 open · 0 answered in draft · 3 remaining<\/p>/u);
  assert.match(blockedOpen, /data-draft-decision/u);
  assert.match(blockedOpen, /id="copy-decisions"/u);

  const blockedWithoutQuestions = renderRefinement(validateRefinement(blockedWithoutOpen(await representativeRaw()))).html;
  assert.match(blockedWithoutQuestions, /<p class="draft-summary" id="readiness-draft-summary"[^>]*>No OPEN decisions · additional information draft available<\/p>/u);
  assert.match(blockedWithoutQuestions, /data-generic-reconciliation/u);
  assert.match(blockedWithoutQuestions, /Additional information — draft/u);

  const readySpec = renderRefinement(validateRefinement(specReady(await representativeRaw()))).html;
  const readyRoadmap = renderRefinement(validateRefinement(roadmapReady(await representativeRaw()))).html;
  for (const html of [readySpec, readyRoadmap]) {
    assert.match(html, /data-draft-mode="none"/u);
    assert.doesNotMatch(html, /id="readiness-draft-summary"/u);
    assert.doesNotMatch(visibleMarkup(html), /answered in draft|additional information draft available|Additional information — draft/iu);
  }
  assert.match(readySpec, /<h3>Start SPEC<\/h3>/u);
  assert.match(readySpec, /MODE=INIT/u);
  assert.match(readySpec, /SPEC_PATH=specs\/order-cancellation/u);
  assert.match(readySpec, /REQUIREMENTS_SOURCE=Customer cancellation before shipment uses an atomic conditional state transition; SHIPPED wins and cancellation returns conflict\./u);
  assert.match(readyRoadmap, /<h3>Start Roadmap<\/h3>/u);
  assert.match(readyRoadmap, /OPERATION=INIT/u);
  assert.match(readyRoadmap, /ROADMAP_SOURCE=Cancellation and shipping boundaries require a roadmap/u);
});

test("renderer escapes content, including copy-prompt payload, and preserves accessibility, responsive, and print behavior", async () => {
  const raw = await representativeRaw();
  raw.title = '</textarea><script id="owned">alert(1)</script>';
  raw.questions[0].question = '<svg onload="alert(2)">';
  raw.handoff.reason = '<img src=x onerror="alert(3)">';
  const html = renderRefinement(validateRefinement(raw)).html;
  assert.doesNotMatch(html, /<script id="owned">|<svg onload|<img src=x/iu);
  assert.match(html, /&lt;\/textarea&gt;&lt;script id=&quot;owned&quot;&gt;/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/u);
  assert.match(html, /@media\(max-width:760px\)/u);
  assert.match(html, /@media print/u);
  assert.match(html, /details>:not\(summary\)[^}]*display:block!important/u);
});

test("source scope is first-class, exact, and rejects unknown or inconsistent associations", async () => {
  const unknown = await representativeRaw();
  unknown.questions[0].source_ids = ["SRC-999"];
  assert.throws(() => validateRefinement(unknown), /references missing SRC-999/u);
  const inconsistent = await representativeRaw();
  inconsistent.findings[0].source_ids = ["SRC-001"];
  assert.throws(() => validateRefinement(inconsistent), /must exactly match sources of its affected needs/u);
});

test("history fixture renders local, Cross, answered, follow-up, and untouched states once", async () => {
  const model = validateRefinement(await historyRaw());
  const html = renderRefinement(model).html;
  assert.match(html, /3 Requirements · 5 Sources · 3 Decisions · 1 Follow-ups · 2 Blockers · BLOCKED/u);
  assert.equal((html.match(/<article class="requirement-card/g) ?? []).length, 3);
  assert.equal((html.match(/data-question-id="QST-002"/gu) ?? []).length, 1);
  assert.equal((html.match(/id="finding-FND-002"/gu) ?? []).length, 1);
  assert.equal((html.match(/id="REL-001"/gu) ?? []).length, 1);
  assert.match(html, /Awaiting decision/u);
  assert.match(html, /Follow-up required/u);
  assert.match(html, /Answered/u);
  assert.match(html, /Previous response/u);
  assert.match(html, /Current established context/u);
  assert.match(html, /What this established/u);
  assert.match(html, /Accent sensitivity and minimum query length remain undefined/u);
  assert.match(html, /Previous reconciliation attempts <span>1<\/span>/u);
  assert.match(html, /Canonical answer recorded/u);
  assert.match(html, /US 36134 ↔ US 36198/u);
  assert.match(html, /US 36134 ↔ US 36174/u);
  const requirementOne = html.slice(html.indexOf('<article class="requirement-card" id="REQ-001"'), html.indexOf('<article class="requirement-card" id="REQ-002"'));
  assert.match(requirementOne, /SRC-001[\s\S]*SRC-002[\s\S]*SRC-003/u);
  assert.doesNotMatch(requirementOne, /data-question-id="QST-002"/u);
});

test("follow-up prompts carry canonical context while first and answered questions keep their boundaries", async () => {
  const model = validateRefinement(await historyRaw());
  const followUp = buildDecisionPrompt(model, model.questions[1], "The minimum query length is three characters.");
  assert.match(followUp, /Interaction: FOLLOW_UP_REQUIRED/u);
  assert.match(followUp, /Previous response:\nLIKE matching is required/u);
  assert.match(followUp, /Current established context:\nSearch uses LIKE matching\./u);
  assert.match(followUp, /Still unresolved:\nAccent sensitivity and minimum query length remain undefined\./u);
  assert.doesNotMatch(followUp, /Previous canonical answer/u);

  const first = buildDecisionPrompt(model, model.questions[0], "Region and status are in scope.");
  assert.match(first, /Interaction: AWAITING_DECISION/u);
  assert.doesNotMatch(first, /Previous response|Current established context|Still unresolved/u);
  assert.equal(buildDecisionPrompt(model, model.questions[2], "Do not accept a new answer."), "");
  assert.equal(buildDecisionPrompt(model, { id: "QST-999", status: "OPEN" }, "Stale question"), "");
});

test("reopened decisions retain prior canonical answers and explain the follow-up boundary", async () => {
  const raw = await historyRaw();
  const question = raw.questions[2];
  question.status = "OPEN";
  question.reopened_reason = "A newly discovered export path invalidates the earlier answer boundary.";
  question.remaining_gaps = ["The export path's authorization behavior remains undefined."];
  raw.handoff.payload.question_ids = ["QST-001", "QST-002", "QST-003"];
  const model = validateRefinement(raw);
  const html = renderRefinement(model).html;
  assert.match(html, /Reopened · follow-up required/u);
  assert.match(html, /Previous canonical answer/u);
  assert.match(html, /A newly discovered export path invalidates the earlier answer boundary./u);
  assert.match(html, /data-question-id="QST-003"[^>]*data-interaction-state="REOPENED_FOLLOW_UP_REQUIRED"/u);

  const prompt = buildDecisionPrompt(model, model.questions[2], "Define the export authorization behavior.");
  assert.match(prompt, /Interaction: REOPENED_FOLLOW_UP_REQUIRED/u);
  assert.match(prompt, /Previous canonical answer:\n/u);
  assert.match(prompt, /Reopened reason:\nA newly discovered export path invalidates the earlier answer boundary\./u);
  assert.match(prompt, /Still unresolved:\nThe export path's authorization behavior remains undefined\./u);
});
