import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const FIXTURES = path.join(HERE, "fixtures");

export async function temporary(t, prefix = "stnl-refinement-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t?.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

export async function representativeRaw() {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, "representative-refinement.json"), "utf8"));
}

export async function historyRaw() {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, "representative-history-refinement.json"), "utf8"));
}

export async function project(t) {
  const root = await temporary(t, "stnl-refinement-project-");
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "docs/requirements.md"), "precisa colocar um botão para cancelar pedido caso ainda não tenha saído\n", "utf8");
  await fs.writeFile(path.join(root, "src/order.mjs"), "export const ORDER_STATES = ['CREATED', 'PAID', 'PACKING', 'SHIPPED'];\nexport function shipOrder(order) { order.status = 'SHIPPED'; }\n", "utf8");
  return root;
}

export async function candidateFile(t, value) {
  const root = await temporary(t, "stnl-refinement-candidate-");
  const file = path.join(root, "candidate.json");
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

export function clone(value) {
  return structuredClone(value);
}

export function recordAcceptedDecision(raw, questionIndex = 0, answer = "The material decision is recorded for the downstream handoff.") {
  const question = raw.questions[questionIndex];
  question.status = "ANSWERED";
  question.answer = answer;
  question.canonical_answer_history = [...(question.canonical_answer_history ?? []), answer];
  question.reconciliation_attempts = [
    ...(question.reconciliation_attempts ?? []),
    {
      round: (question.reconciliation_attempts?.length ?? 0) + 1,
      human_response: answer,
      assessment: "ACCEPTED",
      established_context: [answer],
      remaining_gaps: [],
      affected_finding_ids: [...question.finding_ids],
      canonical_answer: answer,
    },
  ];
  delete question.remaining_gaps;
  return raw;
}

export function acceptedResolution(raw) {
  const next = clone(raw);
  if (!next.evidence.some((item) => item.id === "EVD-004")) {
    next.evidence.push({
      id: "EVD-004",
      kind: "USER_DECISION",
      state: "ACTIVE",
      summary: "Shipping wins concurrent transition",
      detail: "SHIPPED wins; cancellation uses compare-and-set and returns conflict when shipping won.",
      confidence: "CONFIRMED",
      source_ids: [],
      need_ids: ["NEED-001", "NEED-002"],
      surface: "Order",
    });
  }
  const answer = "SHIPPED wins; cancellation uses a conditional update and returns conflict.";
  recordAcceptedDecision(next, 0, answer);
  if (!next.questions[0].evidence_ids.includes("EVD-004")) next.questions[0].evidence_ids.push("EVD-004");
  next.findings[0].disposition = "resolved";
  if (!next.findings[0].evidence_ids.includes("EVD-004")) next.findings[0].evidence_ids.push("EVD-004");
  next.findings[0].resolution = {
    proposal: "SHIPPED wins; cancellation uses compare-and-set on current state and returns conflict if shipping won.",
    verdict: "accepted",
    rationale: "Precedence, atomicity, and failure behavior are defined and consistent with the state model.",
    checks: {
      behavior_defined: "PASS",
      ambiguity_closed: "PASS",
      repository_consistent: "PASS",
      no_new_gap_introduced: "PASS",
      problem_fully_addressed: "PASS",
    },
    supporting_evidence_ids: ["EVD-003", "EVD-004"],
  };
  next.handoff = {
    outcome: "READY_FOR_SPEC",
    reason: "The unitary cancellation boundary has no open BLOCKING findings.",
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
      suggested_spec_path: "specs/order-cancellation",
      requirements_source: "Customer cancellation before shipment uses an atomic conditional state transition; SHIPPED wins and cancellation returns conflict.",
    },
  };
  return next;
}
