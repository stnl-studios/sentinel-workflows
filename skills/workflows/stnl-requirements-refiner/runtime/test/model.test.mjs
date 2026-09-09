import assert from "node:assert/strict";
import test from "node:test";

import { expectedOutcome, validateRefinement } from "../lib/model.mjs";
import { acceptedResolution, clone, representativeRaw } from "./helpers.mjs";

function specHandoff(raw, { carried = raw.findings.filter((item) => item.disposition === "bypassed" || (item.disposition === "open" && item.severity !== "BLOCKING")).map((item) => item.id) } = {}) {
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
