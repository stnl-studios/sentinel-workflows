import assert from "node:assert/strict";
import test from "node:test";

import { validateRefinement } from "../lib/model.mjs";
import { acceptedResolution, clone, recordAcceptedDecision, representativeRaw } from "./helpers.mjs";

async function directAliasCandidate() {
  const raw = await representativeRaw();
  raw.refinement_id = "REF-ENTITY-ALIAS";
  raw.title = "Entity alias refinement";
  raw.summary = "Expose one bounded capability for assigning a display alias to an entity.";
  raw.input_assessment = { format: "STRUCTURED", quality: "SUFFICIENT", summary: "The actor, behavior, boundary, and outcome are explicit." };
  raw.exploration = { status: "NOT_NEEDED", anchors: ["entity alias"], searches: [], files_read: [], stop_reason: "The supplied contract establishes the single documentary boundary.", limitations: [] };
  raw.requirements = [{ id: "REQ-001", title: "Entity alias", state: "ACTIVE", external_id: "US-17", source_ids: ["SRC-001"], need_ids: ["NEED-001"] }];
  raw.sources = [{ id: "SRC-001", kind: "USER_STORY", label: "Entity alias", state: "ACTIVE", external_id: "US-17", original_text: "As an administrator, I want to assign a display alias to an entity so it is recognizable." }];
  raw.needs = [{ id: "NEED-001", title: "Assign entity display alias", state: "ACTIVE", source_ids: ["SRC-001"], statement: "An administrator assigns one display alias to an entity.", actor: "Administrator", preconditions: ["The entity exists"], acceptance_signals: ["The alias is visible with the entity"], negative_signals: ["The alias does not change entity identity"] }];
  raw.evidence = [{ id: "EVD-001", kind: "SOURCE_ASSERTION", state: "ACTIVE", summary: "Alias behavior is explicit", detail: "The story defines actor, bounded behavior, and visible outcome.", confidence: "CONFIRMED", source_ids: ["SRC-001"], need_ids: ["NEED-001"], surface: "Entity" }];
  raw.relationships = [];
  raw.questions = [];
  raw.constraints = [];
  raw.findings = [];
  raw.final_assessment = { boundary: "UNITARY", capability_count: 1, decomposition_value: "NONE", rationale: "The alias behavior is a single coherent capability with no material decomposition value." };
  raw.handoff = {
    outcome: "READY_FOR_SPEC", reason: "The single entity-alias boundary is established.", blocker_ids: [], carried_finding_ids: [],
    next_workflow: "stnl-spec-lifecycle-manager", suggested_next_operation: "MODE=INIT",
    payload: { kind: "SPEC", need_ids: ["NEED-001"], finding_ids: [], question_ids: [], constraint_ids: [], relationship_ids: [], evidence_ids: ["EVD-001"], suggested_spec_title: "Entity display alias", suggested_spec_path: "specs/entity-alias", requirements_source: "An administrator assigns a display alias without changing entity identity." },
  };
  return raw;
}

function multiDomainCandidate() {
  const labels = ["Cart persistence", "Coupon", "Checkout", "Password recovery"];
  const sources = labels.map((label, index) => ({ id: `SRC-${String(index + 1).padStart(3, "0")}`, kind: "USER_STORY", label, state: "ACTIVE", original_text: `${label} behavior for the current sprint.` }));
  const needs = labels.map((label, index) => ({ id: `NEED-${String(index + 1).padStart(3, "0")}`, title: label, state: "ACTIVE", source_ids: [sources[index].id], statement: `Deliver the independently traceable ${label.toLowerCase()} capability.`, preconditions: [], acceptance_signals: [`${label} has an observable outcome`], negative_signals: [] }));
  const evidence = labels.map((label, index) => ({ id: `EVD-${String(index + 1).padStart(3, "0")}`, kind: "SOURCE_ASSERTION", state: "ACTIVE", summary: `${label} requested`, detail: `The sprint explicitly requests ${label.toLowerCase()}.`, confidence: "CONFIRMED", source_ids: [sources[index].id], need_ids: [needs[index].id] }));
  evidence.push({ id: "EVD-005", kind: "REPOSITORY_OBSERVATION", state: "ACTIVE", summary: "Domain dependencies and Pricing surface", detail: "Checkout consumes Cart state; Coupon and Checkout share Pricing; password recovery has a separate authority.", confidence: "CONFIRMED", source_ids: [], need_ids: needs.map((item) => item.id), path: "src/domain-boundaries.mjs", locator: "Cart, Pricing, Checkout, and Recovery exports", surface: "Pricing" });
  return {
    contract_version: 2, refinement_id: "REF-SPRINT-MULTI-DOMAIN", title: "Multi-domain sprint refinement", summary: "Cross four independently deliverable capabilities and their repository relationships.",
    input_assessment: { format: "STRUCTURED", quality: "PARTIAL", summary: "Stories are clear individually, while sequencing and shared ownership require cross-analysis." },
    exploration: { status: "SUFFICIENT", anchors: ["Cart", "Coupon", "Checkout", "Password recovery", "Pricing"], searches: ["Cart Pricing Checkout Recovery"], files_read: ["src/domain-boundaries.mjs"], stop_reason: "The public boundaries establish the material dependency, shared surface, and independence.", limitations: [] },
    requirements: labels.map((title, index) => ({ id: `REQ-${String(index + 1).padStart(3, "0")}`, title, state: "ACTIVE", external_id: `US-${index + 101}`, source_ids: [sources[index].id], need_ids: [needs[index].id] })),
    sources, needs, evidence,
    relationships: [
      { id: "REL-001", type: "DEPENDENCY", title: "Checkout depends on Cart", state: "ACTIVE", requirement_ids: ["REQ-001", "REQ-003"], need_ids: ["NEED-001", "NEED-003"], evidence_ids: ["EVD-005"], detail: "Checkout consumes the persisted Cart state.", from_need_id: "NEED-003", to_need_id: "NEED-001" },
      { id: "REL-002", type: "SHARED_TECHNICAL_SURFACE", title: "Coupon and Checkout share Pricing", state: "ACTIVE", requirement_ids: ["REQ-002", "REQ-003"], need_ids: ["NEED-002", "NEED-003"], evidence_ids: ["EVD-005"], detail: "Both capabilities use the same Pricing authority." },
      { id: "REL-003", type: "SHARED_AUTHORITY", title: "Password recovery remains independent", state: "ACTIVE", requirement_ids: ["REQ-001", "REQ-004"], need_ids: ["NEED-001", "NEED-004"], evidence_ids: ["EVD-005"], detail: "Recovery has separate authority and no delivery dependency on commerce." },
    ],
    questions: [], constraints: [],
    findings: [{ id: "FND-001", title: "Pricing ownership crosses Coupon and Checkout", type: "CROSS_REQUIREMENT_GAP", severity: "ATTENTION", disposition: "open", requirement_ids: ["REQ-002", "REQ-003"], source_ids: ["SRC-002", "SRC-003"], need_ids: ["NEED-002", "NEED-003"], evidence_ids: ["EVD-005"], relationship_ids: ["REL-002"], question_ids: [], problem: "The stories do not assign ownership of their shared Pricing changes.", why_it_matters: "Independent delivery can create conflicting price calculations.", impact: "The roadmap must sequence or coordinate the shared surface." }],
    final_assessment: { boundary: "MULTIPLE", capability_count: 4, decomposition_value: "MATERIAL", rationale: "Four capabilities include a dependency, a shared authority, and one independent domain." },
    handoff: { outcome: "READY_FOR_ROADMAP", reason: "Multiple capabilities and shared surfaces need decomposition.", blocker_ids: [], carried_finding_ids: ["FND-001"], next_workflow: "stnl-spec-roadmap", suggested_next_operation: "OPERATION=INIT", payload: { kind: "ROADMAP", need_ids: needs.map((item) => item.id), finding_ids: ["FND-001"], question_ids: [], constraint_ids: [], relationship_ids: ["REL-001", "REL-002", "REL-003"], evidence_ids: evidence.map((item) => item.id), roadmap_source: "Decompose Cart, Coupon, Checkout, and Password Recovery while preserving dependency and Pricing ownership evidence." } },
  };
}

test("scenario A routes one entity-alias capability directly to SPEC", async () => {
  const model = validateRefinement(await directAliasCandidate());
  assert.equal(model.handoff.outcome, "READY_FOR_SPEC");
  assert.deepEqual(model.handoff.payload.need_ids, ["NEED-001"]);
});

test("scenario B routes the multi-domain sprint to roadmap with explicit cross-requirement context", () => {
  const model = validateRefinement(multiDomainCandidate());
  assert.equal(model.handoff.outcome, "READY_FOR_ROADMAP");
  assert.equal(model.relationships.length, 3);
  assert.equal(model.findings[0].type, "CROSS_REQUIREMENT_GAP");
});

test("scenario C accepts compare-and-set with SHIPPED precedence on the same cancellation finding", async () => {
  const model = validateRefinement(acceptedResolution(await representativeRaw()));
  assert.equal(model.findings[0].id, "FND-001");
  assert.equal(model.findings[0].resolution.verdict, "accepted");
  assert.equal(model.handoff.outcome, "READY_FOR_SPEC");
});

test("scenario D rejects read-before-write because the cancellation race remains", async () => {
  const raw = await representativeRaw();
  raw.findings[0].resolution = { proposal: "Read status before cancelling.", verdict: "rejected", rationale: "A separate read and write does not eliminate the race.", checks: { behavior_defined: "PASS", ambiguity_closed: "FAIL", repository_consistent: "FAIL", no_new_gap_introduced: "PASS", problem_fully_addressed: "FAIL" }, supporting_evidence_ids: ["EVD-003"], remaining_gap: "Atomicity and transition precedence remain undefined." };
  const model = validateRefinement(raw);
  assert.equal(model.findings.length, 1);
  assert.equal(model.findings[0].disposition, "open");
  assert.equal(model.findings[0].resolution.verdict, "rejected");
});

test("scenario E keeps an explicitly bypassed retry-policy risk visible without blocking handoff", async () => {
  const raw = clone(await representativeRaw());
  recordAcceptedDecision(raw, 0, "The retry policy risk is explicitly carried to the downstream SPEC.");
  raw.findings[0].title = "Delivery retry policy is undefined";
  raw.findings[0].problem = "The delivery does not define retry bounds or duplicate-work handling.";
  raw.findings[0].why_it_matters = "Unbounded or duplicate retries can repeat downstream effects.";
  raw.findings[0].impact = "A known operational risk travels with the downstream requirements.";
  raw.findings[0].disposition = "bypassed";
  raw.findings[0].bypass = { reason: "Explicitly outside this delivery; risk accepted for later treatment.", known_risk: "Retries may still duplicate downstream work until the policy is defined." };
  raw.handoff = { outcome: "READY_FOR_SPEC", reason: "The retry-policy blocker was explicitly bypassed.", blocker_ids: [], carried_finding_ids: ["FND-001"], next_workflow: "stnl-spec-lifecycle-manager", suggested_next_operation: "MODE=INIT", payload: { kind: "SPEC", need_ids: ["NEED-001", "NEED-002"], finding_ids: ["FND-001"], question_ids: [], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"], suggested_spec_title: "Order cancellation", requirements_source: "Cancellation behavior carrying the explicitly bypassed retry-policy risk." } };
  const model = validateRefinement(raw);
  assert.equal(model.findings[0].disposition, "bypassed");
  assert.match(model.findings[0].bypass.known_risk, /duplicate/u);
  assert.equal(model.handoff.outcome, "READY_FOR_SPEC");
});
