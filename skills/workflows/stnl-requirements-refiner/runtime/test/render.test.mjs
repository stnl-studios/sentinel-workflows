import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { validateRefinement } from "../lib/model.mjs";
import { hasRefinementOwnershipMarker } from "../lib/publish.mjs";
import { renderRefinement } from "../lib/render.mjs";
import { acceptedResolution, clone, representativeRaw } from "./helpers.mjs";

function rejected(raw) {
  raw.findings[0].resolution = {
    proposal: "Read status before write.", verdict: "rejected", rationale: "Read-before-write leaves a race.",
    checks: { behavior_defined: "PASS", ambiguity_closed: "FAIL", repository_consistent: "FAIL", no_new_gap_introduced: "PASS", problem_fully_addressed: "FAIL" },
    supporting_evidence_ids: ["EVD-003"], remaining_gap: "Atomicity remains undefined.",
  };
  return raw;
}

function bypassed(raw) {
  raw.findings[0].disposition = "bypassed";
  raw.findings[0].bypass = { reason: "Explicitly outside this delivery.", known_risk: "The race remains known and observable." };
  raw.handoff = {
    outcome: "READY_FOR_SPEC", reason: "The blocker was explicitly bypassed.", blocker_ids: [], carried_finding_ids: ["FND-001"],
    next_workflow: "stnl-spec-lifecycle-manager", suggested_next_operation: "MODE=INIT",
    payload: { kind: "SPEC", need_ids: ["NEED-001", "NEED-002"], finding_ids: ["FND-001"], question_ids: ["QST-001"], constraint_ids: ["CON-001"], relationship_ids: ["REL-001"], evidence_ids: ["EVD-001", "EVD-002", "EVD-003"], suggested_spec_title: "Order cancellation", requirements_source: "Cancellation behavior with an explicitly bypassed concurrency risk." },
  };
  return raw;
}

function findingHeader(html, variant) {
  const match = new RegExp(`<article class="finding-card finding-${variant}"[^>]*>\\s*<header>([\\s\\S]*?)</header>`, "u").exec(html);
  assert.notEqual(match, null);
  return match[1];
}

function validationPanel(html) {
  const match = /<section class="validation-panel">([\s\S]*?)<\/section>/u.exec(html);
  assert.notEqual(match, null);
  return match[1];
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

test("open BLOCKING cards retain critical severity emphasis", async () => {
  const html = renderRefinement(validateRefinement(await representativeRaw())).html;
  for (const marker of ["Gap", "Why it matters", "Needs decision", "FND-001", "QST-001", "BLOCKED"]) assert.match(html, new RegExp(marker, "u"));
  const header = findingHeader(html, "open");
  assert.match(html, /finding-open"[^>]*data-status="open"[^>]*data-severity="BLOCKING"/u);
  assert.match(header, /badge-open[^>]*>open</u);
  assert.match(header, /badge-blocking[^>]*>BLOCKING</u);
  assert.doesNotMatch(header, /severity-history/u);
  assert.match(html, /\.finding-open\[data-severity="BLOCKING"\]\{border-left-color:var\(--red\)\}/u);
});

test("resolved BLOCKING cards make resolution dominant and render only positive accepted checks", async () => {
  const html = renderRefinement(validateRefinement(acceptedResolution(await representativeRaw()))).html;
  for (const marker of ["finding-resolved", "Gap", "Resolution", "Validation", "Problema integralmente tratado", "READY FOR SPEC"]) {
    assert.match(html, new RegExp(marker, "iu"));
  }
  const header = findingHeader(html, "resolved");
  const validation = validationPanel(html);
  assert.match(html, /finding-resolved"[^>]*data-status="resolved"[^>]*data-severity="BLOCKING"/u);
  assert.match(header, /badge-resolved[^>]*>resolved</u);
  assert.match(header, /severity-history[^>]*><span>Original severity:<\/span> <strong>BLOCKING<\/strong>/u);
  assert.doesNotMatch(header, /badge-blocking/u);
  assert.match(validation, /Nenhum novo gap introduzido/u);
  assert.equal((validation.match(/badge-pass/gu) ?? []).length, 5);
  assert.doesNotMatch(validation, /badge-fail|Novo gap introduzido|new_gap_introduced/u);
});

test("rejected and inconclusive proposals remain visually distinct", async () => {
  const rejectedHtml = renderRefinement(validateRefinement(rejected(await representativeRaw()))).html;
  assert.match(rejectedHtml, /finding-rejected/u);
  assert.match(rejectedHtml, /Proposed resolution/u);
  assert.match(rejectedHtml, /Validation failed/u);
  assert.match(rejectedHtml, /Gap restante/u);

  const inconclusive = rejected(await representativeRaw());
  inconclusive.findings[0].resolution.verdict = "inconclusive";
  inconclusive.findings[0].resolution.rationale = "The persistence contract is unknown.";
  inconclusive.findings[0].resolution.checks.ambiguity_closed = "UNKNOWN";
  inconclusive.findings[0].resolution.checks.repository_consistent = "UNKNOWN";
  inconclusive.findings[0].resolution.checks.problem_fully_addressed = "UNKNOWN";
  const inconclusiveHtml = renderRefinement(validateRefinement(inconclusive)).html;
  assert.match(inconclusiveHtml, /finding-inconclusive/u);
  assert.match(inconclusiveHtml, /Validation inconclusive/u);
});

test("bypassed BLOCKING cards preserve historical severity without looking resolved or currently blocking", async () => {
  const html = renderRefinement(validateRefinement(bypassed(await representativeRaw()))).html;
  const header = findingHeader(html, "bypassed");
  assert.match(html, /finding-bypassed/u);
  assert.match(html, /finding-bypassed"[^>]*data-status="bypassed"[^>]*data-severity="BLOCKING"/u);
  assert.match(html, /Bypass decision/u);
  assert.match(html, /Known risk remains/u);
  assert.match(header, /badge-bypassed[^>]*>bypassed</u);
  assert.match(header, /severity-history[^>]*><span>Original severity:<\/span> <strong>BLOCKING<\/strong>/u);
  assert.doesNotMatch(header, /badge-blocking|badge-resolved/u);
  assert.doesNotMatch(html, /<article class="finding-card finding-resolved"/u);
});

test("untrusted content is escaped and absent from executable JavaScript", async () => {
  const raw = await representativeRaw();
  raw.title = '</script><script id="owned">alert(1)</script>';
  raw.summary = '<svg onload="alert(2)"> café 漢字 😀';
  raw.sources[0].original_text = '</pre><img src=x onerror="alert(3)">';
  raw.findings[0].problem = '</section><script>alert(4)</script>';
  const html = renderRefinement(validateRefinement(raw)).html;
  assert.doesNotMatch(html, /<script id="owned">|<img src=x|<svg onload/iu);
  assert.match(html, /&lt;\/script&gt;&lt;script id=&quot;owned&quot;&gt;/u);
  assert.match(html, /&lt;\/pre&gt;&lt;img src=x onerror=&quot;alert\(3\)&quot;&gt;/u);
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/u.exec(html)?.[1] ?? "";
  assert.doesNotMatch(script, /owned|alert\([1-4]\)|café|漢字/u);
});

test("filters, responsive layout, navigation, accessibility, and complete print are built in", async () => {
  const html = renderRefinement(validateRefinement(await representativeRaw())).html;
  for (const marker of [
    "Requirements / USs", "Cross-US", "Technical Surface", "Handoff", 'id="search"', 'id="type"', 'id="severity"',
    'name="status"', "All", "Open", "Resolved", "Bypassed", "Requirement", "Technical", "Cross-requirement", "Repository", "Risk",
    "Blocking", "Attention", "Info", "beforeprint", "afterprint", "@media print", "@media(max-width:680px)",
    'aria-live="polite"', 'class="skip"', "Manual handoff only", "refinement.json",
  ]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
  assert.match(html, /\.finding-card\[hidden\]\{display:block\}/u);
  assert.match(html, /finding-card details>:not\(summary\)[^}]*display:block!important/u);
});

test("20+ findings and long text remain structurally compact", async () => {
  const raw = await representativeRaw();
  for (let index = 2; index <= 24; index += 1) {
    raw.findings.push({
      ...clone(raw.findings[0]),
      id: `FND-${String(index).padStart(3, "0")}`,
      title: `Additional material finding ${index}`,
      type: index % 2 === 0 ? "RISK" : "REQUIREMENT_GAP",
      severity: index % 3 === 0 ? "ATTENTION" : "INFO",
      need_ids: ["NEED-001"], evidence_ids: ["EVD-001"], relationship_ids: [], question_ids: [],
      problem: `A long but structured gap ${index}. `.repeat(25),
    });
  }
  const ids = raw.findings.map((item) => item.id);
  raw.handoff.carried_finding_ids = ids;
  raw.handoff.payload.finding_ids = ids;
  const html = renderRefinement(validateRefinement(raw)).html;
  assert.equal((html.match(/data-finding(?:\s|>)/gu) ?? []).length, 24);
  assert.match(html, /24 findings visíveis/u);
  assert.match(html, /finding-columns three/u);
});
