import { createHash } from "node:crypto";

import {
  questionCurrentGaps,
  questionConflictContext,
  questionEstablishedContext,
  questionInteractionState,
  questionMigrationNotice,
  questionPreviousCanonicalAnswer,
  questionPreviousResponse,
  requirementIdsForNeed,
} from "./model.mjs";

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function prose(value) { return `<p>${escapeHtml(value).replaceAll("\n", "<br>")}</p>`; }
function badge(value, label = value) { return `<span class="badge badge-${escapeHtml(String(value).toLowerCase().replaceAll("_", "-"))}">${escapeHtml(label)}</span>`; }
function list(items, empty = "Nenhum item registrado.") { return items.length === 0 ? `<p class="empty">${escapeHtml(empty)}</p>` : `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`; }
function sourceLabel(source) { return source.external_id === undefined ? source.id : source.external_id; }
function requirementLabel(requirement) { return requirement.external_id === undefined ? requirement.title : requirement.external_id; }
function requirementHeading(requirement) {
  const label = requirementLabel(requirement);
  return label === requirement.title ? label : `${label} — ${requirement.title}`;
}
function scopeLabel(requirementIds, maps) {
  if (requirementIds.length === 0) return "Global technical scope";
  return requirementIds.map((id) => requirementLabel(maps.requirement.get(id))).join(" ↔ ");
}

function mapsFor(model) {
  return {
    requirement: new Map(model.requirements.map((item) => [item.id, item])),
    source: new Map(model.sources.map((item) => [item.id, item])),
    need: new Map(model.needs.map((item) => [item.id, item])),
    finding: new Map(model.findings.map((item) => [item.id, item])),
  };
}

function valueSection(label, values, empty = "Not recorded.") {
  const normalized = values.filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return `<section><h5>${escapeHtml(label)}</h5>${normalized.length === 0 ? `<p class="empty">${escapeHtml(empty)}</p>` : list(normalized)}</section>`;
}

function sourceArtifact(source) {
  const state = source.state === "ACTIVE" ? badge("active", "ACTIVE") : badge("retired", "RETIRED");
  return `<article class="source-artifact"><div>${state} <code>${escapeHtml(source.id)}</code> <strong>${escapeHtml(source.label)}</strong></div><small>${escapeHtml(source.kind)}${source.external_id === undefined ? "" : ` · ${escapeHtml(source.external_id)}`}</small>${prose(source.original_text)}${source.path === undefined ? "" : `<small>Source path: <code>${escapeHtml(source.path)}</code></small>`}</article>`;
}

function requirementEvidence(requirement, model) {
  const needIds = new Set(requirement.need_ids);
  const sourceIds = new Set(requirement.source_ids);
  return model.evidence.filter((item) => item.need_ids.some((id) => needIds.has(id)) || item.source_ids.some((id) => sourceIds.has(id))).map((item) => item.id);
}

function requirementDetails(requirement, needs, model, maps) {
  const sources = requirement.source_ids.map((id) => maps.source.get(id)).filter(Boolean);
  const actors = [...new Set(needs.map((item) => item.actor).filter(Boolean))];
  const preconditions = [...new Set(needs.flatMap((item) => item.preconditions))];
  const acceptance = [...new Set(needs.flatMap((item) => item.acceptance_signals))];
  const negative = [...new Set(needs.flatMap((item) => item.negative_signals))];
  return `<details class="requirement-details"><summary>Requirement details</summary><div class="requirement-detail-grid">${valueSection("Actor", actors)}${valueSection("Preconditions", preconditions)}${valueSection("Acceptance signals", acceptance)}${valueSection("Negative signals", negative)}</div><section class="original-sources"><h5>Sources <span>${sources.length}</span></h5><div class="source-stack">${sources.map(sourceArtifact).join("")}</div></section>${evidenceDetails(requirementEvidence(requirement, model), model)}</details>`;
}

const CHECK_LABELS = {
  behavior_defined: "Behavior defined",
  ambiguity_closed: "Ambiguity closed",
  repository_consistent: "Repository consistent",
  no_new_gap_introduced: "No new gap introduced",
  problem_fully_addressed: "Problem fully addressed",
};

function resolutionChecks(resolution) {
  return `<div class="checks"><h6>Validation checks</h6><dl>${Object.entries(resolution.checks).map(([key, value]) => `<div><dt>${escapeHtml(CHECK_LABELS[key] ?? key)}</dt><dd class="check-${escapeHtml(value.toLowerCase().replaceAll("_", "-"))}">${escapeHtml(value)}</dd></div>`).join("")}</dl></div>`;
}

function resolutionBlock(finding) {
  if (finding.resolution === undefined) return "";
  const resolution = finding.resolution;
  const heading = resolution.verdict === "accepted" ? "Resolution accepted · validation passed"
    : resolution.verdict === "rejected" ? "Resolution rejected · remaining gap"
      : "Resolution inconclusive · unresolved uncertainty";
  return `<section class="resolution resolution-${resolution.verdict}"><h5>${heading}</h5>${prose(resolution.proposal)}${prose(resolution.rationale)}${resolutionChecks(resolution)}${resolution.remaining_gap === undefined ? "" : `<p class="remaining-gap"><strong>Remaining gap:</strong> ${escapeHtml(resolution.remaining_gap)}</p>`}</section>`;
}

function findingState(finding) {
  if (finding.disposition === "open") return `${badge("open", "OPEN")} ${badge(finding.severity, `Severity: ${finding.severity}`)}`;
  return `${badge(finding.disposition, finding.disposition.toUpperCase())} ${badge("historical-severity", `Historical severity: ${finding.severity}`)}`;
}

function evidenceDetails(ids, model) {
  const items = model.evidence.filter((item) => ids.includes(item.id));
  if (items.length === 0) return "";
  return `<details class="evidence-details"><summary>Evidence <span>${items.length}</span></summary><div class="evidence-list">${items.map((item) => `<article><div>${badge(item.kind)} ${badge(item.confidence)} <code>${item.id}</code></div><strong>${escapeHtml(item.summary)}</strong>${prose(item.detail)}${item.path === undefined ? "" : `<small><code>${escapeHtml(item.path)}</code> · ${escapeHtml(item.locator)}</small>`}</article>`).join("")}</div></details>`;
}

function sourceBadge(requirementIds, maps) { return `<span class="requirement-ref">${escapeHtml(scopeLabel(requirementIds, maps))}</span>`; }

function findingCard(finding, model, maps) {
  const activeBlocking = finding.disposition === "open" && finding.severity === "BLOCKING";
  const relatedQuestions = finding.question_ids.map((id) => model.questions.find((item) => item.id === id)).filter(Boolean);
  const relatedEvidence = [...new Set([...finding.evidence_ids, ...(finding.resolution?.supporting_evidence_ids ?? [])])];
  const reopened = finding.reopened_reason === undefined ? "" : `<p class="reopened"><strong>Reopened reason:</strong> ${escapeHtml(finding.reopened_reason)}</p>`;
  const bypass = finding.bypass === undefined ? "" : `<section class="resolution bypass"><h5>Bypassed · known risk remains</h5>${prose(finding.bypass.reason)}${prose(finding.bypass.known_risk)}</section>`;
  return `<article class="finding-card technical-card${activeBlocking ? " is-blocking" : ""}" id="finding-${finding.id}" tabindex="-1"><header><div><code>${finding.id}</code>${sourceBadge(finding.requirement_ids, maps)}<h4>${escapeHtml(finding.title)}</h4></div><div class="badges">${findingState(finding)}${badge(finding.type)}</div></header><p>${escapeHtml(finding.impact)}</p><details><summary>View finding status and context</summary><div class="finding-context"><section><h5>Current state</h5><p>${escapeHtml(finding.disposition.toUpperCase())}</p>${finding.disposition !== "open" ? `<p class="historical"><strong>Historical severity:</strong> ${escapeHtml(finding.severity)}</p>` : ""}</section><section><h5>Gap</h5>${prose(finding.problem)}</section><section><h5>Why it matters</h5>${prose(finding.why_it_matters)}</section><section><h5>Related decisions</h5>${relatedQuestions.length === 0 ? '<p class="empty">No human decision is linked.</p>' : relatedQuestions.map((question) => `<p><a href="#decision-${escapeHtml(question.id)}"><code>${question.id}</code></a> ${escapeHtml(question.question)}</p>`).join("")}</section></div>${resolutionBlock(finding)}${bypass}${reopened}${evidenceDetails(relatedEvidence, model)}</details></article>`;
}

function attemptHistory(question) {
  if (question.reconciliation_attempts.length === 0) return "";
  return `<details class="attempt-history"><summary>Previous reconciliation attempts <span>${question.reconciliation_attempts.length}</span></summary><div class="attempt-stack">${question.reconciliation_attempts.map((attempt) => `<article class="attempt"><header><strong>Round ${attempt.round}</strong>${badge(attempt.assessment)}</header><section><h5>Human response</h5>${prose(attempt.human_response)}</section>${attempt.disputed_context === undefined ? "" : `<section><h5>Previous context disputed in this round</h5>${list(attempt.disputed_context)}</section>`}<section><h5>${attempt.assessment === "CONFLICTING_INFORMATION" ? "New conflicting information in this round" : "What this established"}</h5>${list(attempt.established_context, "Nothing new was established in this round.")}</section><section><h5>Still unresolved</h5>${list(attempt.remaining_gaps, "No remaining gap in this round.")}</section>${attempt.canonical_answer === undefined ? "" : `<section><h5>Canonical answer recorded</h5>${prose(attempt.canonical_answer)}</section>`}${attempt.affected_finding_ids.length === 0 ? "" : `<small>Affected findings: <code>${escapeHtml(attempt.affected_finding_ids.join(", "))}</code></small>`}</article>`).join("")}</div></details>`;
}

function reopenHistory(question) {
  if ((question.reopen_events?.length ?? 0) === 0) return "";
  return `<details class="reopen-history"><summary>Previous reopen cycles <span>${question.reopen_events.length}</span></summary><div class="attempt-stack">${question.reopen_events.map((event) => `<article class="attempt"><header><strong>Reopen ${event.sequence}</strong>${badge("REOPENED")}</header><section><h5>Reason</h5>${prose(event.reason)}</section><section><h5>Canonical answer challenged</h5>${prose(event.prior_canonical_answer)}</section><section><h5>Remaining gaps</h5>${list(event.remaining_gaps)}</section></article>`).join("")}</div></details>`;
}

function decisionInteraction(question) {
  const state = questionInteractionState(question);
  const labels = {
    AWAITING_DECISION: "Awaiting decision",
    FOLLOW_UP_REQUIRED: "Follow-up required",
    ANSWERED: "Answered",
    REOPENED_FOLLOW_UP_REQUIRED: "Reopened · follow-up required",
  };
  return { state, label: labels[state] ?? state };
}

function decisionFollowUpContext(question, interaction) {
  if (interaction.state === "AWAITING_DECISION" || interaction.state === "ANSWERED") return "";
  const previousResponse = questionPreviousResponse(question);
  const previousAnswer = questionPreviousCanonicalAnswer(question);
  const migrationNotice = questionMigrationNotice(question);
  const conflict = questionConflictContext(question);
  const currentContext = questionEstablishedContext(question);
  const responseSection = previousResponse === undefined
    ? migrationNotice === undefined
      ? '<section><h5>Previous response</h5><p class="empty">No previous response recorded.</p></section>'
      : `<section><h5>History note</h5>${prose(migrationNotice)}</section>`
    : `<section><h5>Previous response</h5>${prose(previousResponse)}</section>`;
  const reopened = interaction.state === "REOPENED_FOLLOW_UP_REQUIRED"
    ? `${responseSection}<section><h5>Previous canonical answer</h5>${previousAnswer === undefined ? '<p class="empty">No previous canonical answer recorded.</p>' : prose(previousAnswer)}</section><section><h5>Reopened reason</h5>${prose(question.reopened_reason)}</section>`
    : responseSection;
  const contextSection = conflict === undefined
    ? `<section><h5>Current established context</h5>${list(currentContext, "Nothing has been established yet.")}</section>`
    : `<section><h5>Current established context</h5>${list(currentContext, "No undisputed context is currently established.")}</section><section class="conflict-context"><h5>Previous disputed context</h5>${list(conflict.previous_disputed_context)}<h5>New conflicting information</h5>${list(conflict.conflicting_context)}<p><strong>Current status:</strong> Conflict requires reconciliation</p></section>`;
  return `<section class="follow-up-context"><h5>Follow-up context</h5><div class="follow-up-grid">${reopened}${contextSection}<section><h5>Still unresolved</h5>${list(questionCurrentGaps(question), "No remaining gap recorded.")}</section></div></section>`;
}

function decisionCard(question, model, maps, { anchorId = `decision-${question.id}` } = {}) {
  const findings = question.finding_ids.map((id) => maps.finding.get(id)).filter(Boolean);
  const blocking = findings.some((item) => item.disposition === "open" && item.severity === "BLOCKING");
  const relatedEvidence = [...new Set([...question.evidence_ids, ...findings.flatMap((item) => item.evidence_ids)])];
  const open = question.status === "OPEN";
  const interaction = decisionInteraction(question);
  const identity = scopeLabel(question.requirement_ids, maps);
  const context = `<details><summary>View context</summary><div class="decision-context"><section><h5>Related finding</h5>${findings.map((finding) => `<p><code>${finding.id}</code> ${escapeHtml(finding.title)}</p>`).join("")}</section><section><h5>Conflict / gap</h5>${findings.map((finding) => prose(finding.problem)).join("")}</section><section><h5>Why it matters</h5>${findings.map((finding) => prose(finding.why_it_matters)).join("")}</section><section><h5>Finding state</h5>${findings.map((finding) => `<p>${escapeHtml(finding.disposition.toUpperCase())} · ${finding.disposition === "open" ? escapeHtml(finding.severity) : `Historical severity: ${escapeHtml(finding.severity)}`}</p>`).join("")}</section></div>${findings.map((finding) => `${resolutionBlock(finding)}${finding.bypass === undefined ? "" : `<section class="resolution bypass"><h5>Bypassed · known risk remains</h5>${prose(finding.bypass.reason)}${prose(finding.bypass.known_risk)}</section>`}${finding.reopened_reason === undefined ? "" : `<p class="reopened"><strong>Reopened reason:</strong> ${escapeHtml(finding.reopened_reason)}</p>`}`).join("")}${evidenceDetails(relatedEvidence, model)}</details>`;
  const established = questionEstablishedContext(question).join("\n");
  const gaps = questionCurrentGaps(question).join("\n");
  const previousAnswer = questionPreviousCanonicalAnswer(question) ?? "";
  const conflict = questionConflictContext(question);
  const migrationNotice = questionMigrationNotice(question);
  const answer = open ? `${decisionFollowUpContext(question, interaction)}<section class="decision-draft"><label for="draft-${question.id}">${interaction.state === "AWAITING_DECISION" ? "Your decision — draft" : "Your follow-up — draft"}</label><textarea id="draft-${question.id}" rows="5" spellcheck="true" data-draft-decision data-question-id="${question.id}" data-requirement-ids="${question.requirement_ids.join(" ")}" data-requirement-ids-list="${escapeHtml(question.requirement_ids.join(", "))}" data-source-ids="${question.source_ids.join(" ")}" data-source-ids-list="${escapeHtml(question.source_ids.join(", "))}" data-need-ids="${question.need_ids.join(" ")}" data-need-ids-list="${escapeHtml(question.need_ids.join(", "))}" data-finding-ids="${question.finding_ids.join(" ")}" data-finding-ids-list="${escapeHtml(question.finding_ids.join(", "))}" data-requirement-identity="${escapeHtml(identity)}" data-interaction-state="${interaction.state}" data-previous-response="${escapeHtml(questionPreviousResponse(question) ?? "")}" data-migration-notice="${escapeHtml(migrationNotice ?? "")}" data-previous-canonical-answer="${escapeHtml(previousAnswer)}" data-reopened-reason="${escapeHtml(question.reopened_reason ?? "")}" data-current-established-context="${escapeHtml(established)}" data-conflict-active="${conflict === undefined ? "false" : "true"}" data-previous-disputed-context="${escapeHtml(conflict?.previous_disputed_context.join("\n") ?? "")}" data-new-conflicting-information="${escapeHtml(conflict?.conflicting_context.join("\n") ?? "")}" data-remaining-gaps="${escapeHtml(gaps)}" aria-describedby="draft-note-${question.id}"></textarea><div class="decision-actions"><button type="button" data-copy-decision data-target="draft-${question.id}" aria-controls="draft-${question.id}" disabled>Copy this decision</button><button type="button" data-clear-draft data-target="draft-${question.id}" aria-controls="draft-${question.id}" disabled>Clear</button></div><p class="draft-note" id="draft-note-${question.id}">Browser-only draft. It is not authoritative and is not persisted.</p><p class="decision-copy-status" id="decision-status-${question.id}" aria-live="polite"></p></section>` : `<section class="canonical-answer"><h5>Canonical answer</h5>${prose(question.answer)}${migrationNotice === undefined ? "" : `<p class="migration-note"><strong>History note:</strong> ${escapeHtml(migrationNotice)}</p>`}</section>`;
  return `<article class="decision-card${open ? " is-open" : " is-answered"} decision-state-${interaction.state.toLowerCase().replaceAll("_", "-")}" id="${escapeHtml(anchorId)}" data-decision-card data-open="${open ? "true" : "false"}" tabindex="-1"><header><div><code>${question.id}</code>${sourceBadge(question.requirement_ids, maps)}<h4 class="decision-question" data-question-text>${escapeHtml(question.question)}</h4><p>${escapeHtml(question.why_material)}</p></div><div class="badges">${badge(interaction.state, interaction.label)}${blocking ? badge("BLOCKING") : ""}</div></header>${context}${answer}${attemptHistory(question)}${reopenHistory(question)}</article>`;
}

function requirementCard(requirement, model, maps) {
  const needs = requirement.need_ids.map((id) => maps.need.get(id)).filter(Boolean);
  const relatedQuestions = model.questions.filter((item) => item.requirement_ids.includes(requirement.id));
  const localQuestions = relatedQuestions.filter((item) => item.requirement_ids.length === 1);
  const crossQuestions = relatedQuestions.filter((item) => item.requirement_ids.length > 1);
  const openQuestions = relatedQuestions.filter((item) => item.status === "OPEN");
  const followUps = openQuestions.filter((item) => questionInteractionState(item) !== "AWAITING_DECISION");
  const answered = localQuestions.filter((item) => item.status === "ANSWERED");
  const findings = model.findings.filter((item) => item.requirement_ids.includes(requirement.id));
  const localFindings = findings.filter((item) => item.requirement_ids.length === 1);
  const crossFindings = findings.filter((item) => item.requirement_ids.length > 1);
  const relationships = model.relationships.filter((item) => item.requirement_ids.length === 1 && item.requirement_ids.includes(requirement.id));
  const blockers = findings.filter((item) => item.disposition === "open" && item.severity === "BLOCKING");
  const attention = findings.filter((item) => item.disposition === "open" && item.severity === "ATTENTION");
  const state = requirement.state === "RETIRED" ? "RETIRED" : blockers.length > 0 || openQuestions.length > 0 ? "BLOCKED" : attention.length > 0 || findings.some((item) => item.disposition === "open") ? "ATTENTION" : "READY";
  const decisionSection = localQuestions.length === 0
    ? '<p class="empty">No local decision is linked to this requirement.</p>'
    : localQuestions.filter((question) => question.status === "OPEN").map((question) => decisionCard(question, model, maps)).join("")
      + (answered.length === 0 ? "" : `<details class="answered-decisions"><summary>Answered decisions <span>${answered.length}</span></summary>${answered.map((question) => decisionCard(question, model, maps)).join("")}</details>`);
  const followUpSection = followUps.length === 0 ? "" : `<section class="follow-up-references"><h4>Follow-ups <span>${followUps.length}</span></h4><ul>${followUps.map((question) => `<li><a href="#decision-${escapeHtml(question.id)}"><code>${question.id}</code> · ${escapeHtml(question.question)}</a> <span>${escapeHtml(decisionInteraction(question).label)}</span></li>`).join("")}</ul></section>`;
  const crossReferenceSection = crossQuestions.length === 0 && crossFindings.length === 0 ? "" : `<section class="cross-decision-references"><h4>Cross-requirement references</h4>${crossQuestions.map((question) => crossDecisionReference(question, maps)).join("")}${crossFindings.map((finding) => crossFindingReference(finding, maps)).join("")}</section>`;
  const findingSection = localFindings.length === 0 ? '<p class="empty">No local findings are linked to this requirement.</p>' : `<div class="technical-stack">${localFindings.map((finding) => findingCard(finding, model, maps)).join("")}</div>`;
  const relationshipSection = relationships.length === 0 ? "" : `<section class="relationships"><h4>Dependencies and shared surfaces <span>${relationships.length}</span></h4><div class="dependency-grid">${relationships.map((relationship) => relationshipCard(relationship, model, maps)).join("")}</div></section>`;
  return `<article class="requirement-card${requirement.state === "RETIRED" ? " is-retired" : ""}" id="${escapeHtml(requirement.id)}" tabindex="-1"><header><div><p class="eyebrow"><code>${escapeHtml(requirement.id)}</code> · ${escapeHtml(requirement.state)}</p><h3>${escapeHtml(requirementHeading(requirement))}</h3></div><div class="badges">${badge(state)}<span class="count">${answered.length} / ${localQuestions.length} local decisions answered</span><span class="count">${openQuestions.length} open</span><span class="count">${followUps.length} follow-ups</span><span class="count">${blockers.length} blocking</span><span class="count">${attention.length} attention</span></div></header><div class="requirement-body"><section><h4>What we understood</h4>${needs.length === 0 ? '<p class="empty">No need is linked to this requirement.</p>' : `<ul class="understood">${needs.map((need) => `<li id="${escapeHtml(need.id)}"><code>${need.id}</code> ${escapeHtml(need.statement)}${need.state === "RETIRED" ? ` ${badge("retired", "RETIRED")}` : ""}</li>`).join("")}</ul>`}</section>${requirementDetails(requirement, needs, model, maps)}<section class="decisions"><h4>Decisions <span>${localQuestions.length} local · ${crossQuestions.length} cross reference</span></h4>${decisionSection}</section>${followUpSection}<section class="findings"><h4>Findings <span>${localFindings.length} local · ${crossFindings.length} cross reference</span></h4>${findingSection}</section>${relationshipSection}${crossReferenceSection}</div></article>`;
}

function crossDecisionReference(question, maps) {
  return `<article class="cross-decision-reference"><div><strong>Cross-requirement decision · <code>${question.id}</code></strong>${sourceBadge(question.requirement_ids, maps)}<p>${escapeHtml(question.question)}</p></div><a href="#decision-${escapeHtml(question.id)}">Go to decision</a></article>`;
}

function crossFindingReference(finding, maps) {
  return `<article class="cross-decision-reference"><div><strong>Cross-requirement finding · <code>${finding.id}</code></strong>${sourceBadge(finding.requirement_ids, maps)}<p>${escapeHtml(finding.title)}</p></div><a href="#finding-${escapeHtml(finding.id)}">Go to finding</a></article>`;
}

function relationshipCard(relationship, model, maps) {
  const direction = relationship.type === "DEPENDENCY"
    ? `${scopeLabel(requirementIdsForNeed(model, relationship.from_need_id), maps)} → ${scopeLabel(requirementIdsForNeed(model, relationship.to_need_id), maps)}`
    : scopeLabel(relationship.requirement_ids, maps);
  return `<article class="dependency-card" id="${relationship.id}"><header><code>${relationship.id}</code>${sourceBadge(relationship.requirement_ids, maps)}${badge(relationship.type)}</header><h3>${escapeHtml(direction)}</h3><p>${escapeHtml(relationship.title)}</p><details><summary>View relationship</summary>${prose(relationship.detail)}<p><strong>Needs:</strong> ${relationship.need_ids.map((id) => `<a href="#${id}">${id}</a>`).join(" · ")}</p>${evidenceDetails(relationship.evidence_ids, model)}</details></article>`;
}

function crossGroups(model) {
  const groups = new Map();
  const add = (item, key) => {
    if (item.requirement_ids.length < 2) return;
    const groupKey = item.requirement_ids.join("|");
    const group = groups.get(groupKey) ?? { requirement_ids: item.requirement_ids, questions: [], findings: [], relationships: [] };
    group[key].push(item);
    groups.set(groupKey, group);
  };
  model.questions.forEach((item) => add(item, "questions"));
  model.findings.forEach((item) => add(item, "findings"));
  model.relationships.forEach((item) => add(item, "relationships"));
  return [...groups.values()].sort((left, right) => left.requirement_ids.join("|").localeCompare(right.requirement_ids.join("|"), "en"));
}

function crossRequirementSection(model, maps) {
  const groups = crossGroups(model);
  if (groups.length === 0) return "";
  return `<section class="cross-decisions" id="cross-requirements"><div class="subsection-heading"><p class="eyebrow">Shared interaction and ownership</p><h3>Cross-requirement</h3><p>Cross scope is based on canonical Requirement identity. Each question or finding has one primary projection.</p></div><div class="cross-group-stack">${groups.map((group) => `<article class="cross-group" id="cross-${escapeHtml(group.requirement_ids.join("-"))}"><header><h3>${escapeHtml(scopeLabel(group.requirement_ids, maps))}</h3><span class="count">${group.questions.length} decisions · ${group.findings.length} findings · ${group.relationships.length} relationships</span></header>${group.questions.length === 0 ? "" : `<section><h4>Cross decisions</h4><div class="decision-stack">${group.questions.map((question) => decisionCard(question, model, maps)).join("")}</div></section>`}${group.findings.length === 0 ? "" : `<section><h4>Cross findings</h4><div class="technical-stack">${group.findings.map((finding) => findingCard(finding, model, maps)).join("")}</div></section>`}${group.relationships.length === 0 ? "" : `<section><h4>Dependencies and shared surfaces</h4><div class="dependency-grid">${group.relationships.map((relationship) => relationshipCard(relationship, model, maps)).join("")}</div></section>`}</article>`).join("")}</div></section>`;
}

const PROMPT_CONTRACT = Object.freeze({
  workflowPrefix: "Use `",
  workflowSuffix: "`.",
  newInformation: "NEW_INFORMATION:",
  entryPrefix: "### ",
  entrySeparator: " — ",
  interactionPrefix: "Interaction: ",
  questionPrefix: "Question: ",
  decisionLabel: "Decision:",
  previousResponsePrefix: "Previous response:\n",
  migrationNoticePrefix: "History note:\n",
  previousCanonicalAnswerPrefix: "Previous canonical answer:\n",
  reopenedReasonPrefix: "Reopened reason:\n",
  previousDisputedPrefix: "Previous disputed context:\n",
  conflictingInformationPrefix: "New conflicting information:\n",
  conflictStatusPrefix: "Current status: ",
  conflictStatus: "Conflict requires reconciliation",
  currentEstablishedPrefix: "Current established context:\n",
  remainingPrefix: "Still unresolved:\n",
  requirementIdsPrefix: "Requirement IDs: ",
  sourceIdsPrefix: "Source IDs: ",
  needIdsPrefix: "Need IDs: ",
  findingIdsPrefix: "Related findings: ",
  blockingIdsPrefix: "Blocking finding IDs: ",
  carriedIdsPrefix: "Carried finding IDs: ",
  none: "none",
});

function promptHeader(model, refinementPath) {
  return [
    PROMPT_CONTRACT.workflowPrefix + model.handoff.next_workflow + PROMPT_CONTRACT.workflowSuffix,
    model.handoff.suggested_next_operation,
    "PROJECT_ROOT={{PROJECT_ROOT}}",
    "REFINEMENT_PATH=" + refinementPath,
    "REFINEMENT_ID=" + model.refinement_id,
  ];
}

function promptEntry(question, decision, maps) {
  const interaction = questionInteractionState(question);
  const followUp = interaction !== "AWAITING_DECISION" && interaction !== "ANSWERED";
  const lines = [
    PROMPT_CONTRACT.entryPrefix + question.id + PROMPT_CONTRACT.entrySeparator + scopeLabel(question.requirement_ids, maps),
    PROMPT_CONTRACT.interactionPrefix + interaction,
    PROMPT_CONTRACT.questionPrefix + question.question,
  ];
  if (followUp) {
    const previousResponse = questionPreviousResponse(question);
    if (previousResponse !== undefined) lines.push(PROMPT_CONTRACT.previousResponsePrefix + previousResponse);
    else {
      const migrationNotice = questionMigrationNotice(question);
      if (migrationNotice !== undefined) lines.push(PROMPT_CONTRACT.migrationNoticePrefix + migrationNotice);
    }
    if (interaction === "REOPENED_FOLLOW_UP_REQUIRED") {
      lines.push(
        PROMPT_CONTRACT.previousCanonicalAnswerPrefix + (questionPreviousCanonicalAnswer(question) ?? "none"),
        PROMPT_CONTRACT.reopenedReasonPrefix + (question.reopened_reason ?? "none"),
      );
    }
    const conflict = questionConflictContext(question);
    if (conflict === undefined) {
      lines.push(PROMPT_CONTRACT.currentEstablishedPrefix + (questionEstablishedContext(question).join("\n") || "none"));
    } else {
      lines.push(
        PROMPT_CONTRACT.previousDisputedPrefix + (conflict.previous_disputed_context.join("\n") || "none"),
        PROMPT_CONTRACT.conflictingInformationPrefix + (conflict.conflicting_context.join("\n") || "none"),
        PROMPT_CONTRACT.currentEstablishedPrefix + (questionEstablishedContext(question).join("\n") || "none"),
        PROMPT_CONTRACT.conflictStatusPrefix + PROMPT_CONTRACT.conflictStatus,
      );
    }
    lines.push(PROMPT_CONTRACT.remainingPrefix + (questionCurrentGaps(question).join("\n") || "none"));
  }
  lines.push(
    PROMPT_CONTRACT.decisionLabel,
    String(decision),
    PROMPT_CONTRACT.requirementIdsPrefix + question.requirement_ids.join(", "),
    PROMPT_CONTRACT.sourceIdsPrefix + question.source_ids.join(", "),
    PROMPT_CONTRACT.needIdsPrefix + question.need_ids.join(", "),
    PROMPT_CONTRACT.findingIdsPrefix + question.finding_ids.join(", "),
  );
  return lines.join("\n");
}

function serializePrompt(header, entries) {
  if (entries.length === 0) return "";
  return header.join("\n") + "\n" + PROMPT_CONTRACT.newInformation + "\n\n" + entries.join("\n\n");
}

function isReconciliationHandoff(model) {
  return model.handoff.next_workflow === "stnl-requirements-refiner"
    && /^OPERATION=RECONCILE(?:$|_)/u.test(model.handoff.suggested_next_operation);
}

function reconciliationContext(model) {
  const blocking = model.handoff.blocker_ids;
  const carried = model.handoff.carried_finding_ids.filter((id) => !blocking.includes(id));
  return [
    PROMPT_CONTRACT.blockingIdsPrefix + (blocking.join(", ") || PROMPT_CONTRACT.none),
    ...(carried.length === 0 ? [] : [PROMPT_CONTRACT.carriedIdsPrefix + carried.join(", ")]),
  ];
}

function additionalInformationEntry(information, context) {
  return [String(information), "", ...context].join("\n");
}

export function buildDecisionPrompt(model, question, decision, refinementPath = "docs/refinement") {
  const canonicalQuestion = model.questions.find((item) => item.id === question?.id);
  if (!isReconciliationHandoff(model) || canonicalQuestion === undefined
    || canonicalQuestion.status !== "OPEN" || String(decision).trim() === "") return "";
  return serializePrompt(promptHeader(model, refinementPath), [promptEntry(canonicalQuestion, decision, mapsFor(model))]);
}

export function buildAggregateDecisionPrompt(model, decisions, refinementPath = "docs/refinement") {
  if (!isReconciliationHandoff(model)) return "";
  const values = decisions instanceof Map ? decisions : new Map(Object.entries(decisions));
  const maps = mapsFor(model);
  const entries = model.questions.filter((question) => question.status === "OPEN").map((question) => ({ question, decision: values.get(question.id) })).filter(({ decision }) => decision !== undefined && String(decision).trim() !== "");
  if (entries.length === 0) return "";
  return serializePrompt(promptHeader(model, refinementPath), entries.map(({ question, decision }) => promptEntry(question, decision, maps)));
}

export function buildAdditionalInformationPrompt(model, information, refinementPath = "docs/refinement") {
  if (!isReconciliationHandoff(model) || model.questions.some((question) => question.status === "OPEN") || String(information).trim() === "") return "";
  return serializePrompt(promptHeader(model, refinementPath), [additionalInformationEntry(information, reconciliationContext(model))]);
}

function buildDownstreamHandoffPrompt(model, refinementPath) {
  if (model.handoff.outcome === "BLOCKED") return "";
  const payload = model.handoff.payload;
  const lines = promptHeader(model, refinementPath);
  if (model.handoff.outcome === "READY_FOR_SPEC") {
    lines.push(`SPEC_PATH=${payload.suggested_spec_path === undefined ? "{{SPEC_PATH}}" : payload.suggested_spec_path}`, `REQUIREMENTS_SOURCE=${payload.requirements_source}`);
  } else {
    lines.push(`ROADMAP_SOURCE=${payload.roadmap_source}`);
  }
  lines.push("", `Refinement handoff: ${model.refinement_id} · needs ${payload.need_ids.join(", ") || "none"}${payload.finding_ids.length === 0 ? "" : ` · carried findings ${payload.finding_ids.join(", ")}`}`);
  return lines.join("\n");
}

function workflowLabel(model) {
  if (model.handoff.outcome === "BLOCKED") return "Reconcile refinement";
  if (model.handoff.next_workflow === "stnl-spec-lifecycle-manager") return "Start SPEC";
  if (model.handoff.next_workflow === "stnl-spec-roadmap") return "Start Roadmap";
  return model.handoff.next_workflow;
}

function continueWorkflow(model, refinementPath) {
  const blocked = model.handoff.outcome === "BLOCKED";
  const operationLabel = model.handoff.suggested_next_operation.replace(/^OPERATION=/u, "");
  const openCount = model.questions.filter((item) => item.status === "OPEN").length;
  const draftSummary = openCount > 0 ? `${openCount} open · 0 answered in draft · ${openCount} remaining` : "No OPEN decisions · additional information draft available";
  const blockedControls = blocked && openCount > 0
    ? `<div class="draft-progress" id="draft-summary" aria-live="polite">${draftSummary}</div><p class="draft-boundary">Drafts stay in this browser, are not persisted, and do not change refinement authority.</p><div class="copy-panel"><label for="continue-prompt">Reconciliation prompt from filled decisions</label><textarea id="continue-prompt" readonly rows="10" spellcheck="false" placeholder="Fill at least one OPEN decision to generate a prompt."></textarea><button type="button" id="copy-decisions" aria-controls="continue-prompt" disabled>Copy 0 decisions for ${escapeHtml(operationLabel)}</button><p id="aggregate-copy-status" aria-live="polite">Fill at least one decision to enable aggregate copy.</p></div>`
    : blocked
      ? `<div class="draft-progress" id="draft-summary" aria-live="polite">${draftSummary}</div><p class="draft-boundary">No material question is open. Add clarification, evidence, or a human decision for the current blockers.</p><div class="copy-panel generic-reconciliation"><label for="additional-information-draft">Additional information — draft</label><textarea id="additional-information-draft" data-generic-reconciliation rows="8" spellcheck="true" aria-describedby="additional-information-note" placeholder="Add clarification, new evidence, a correction, or an instruction for the reopened finding."></textarea><div class="decision-actions"><button type="button" data-copy-additional-information id="copy-additional-information" disabled>Copy information for ${escapeHtml(operationLabel)}</button><button type="button" data-clear-additional-information id="clear-additional-information" disabled>Clear</button></div><p class="draft-note" id="additional-information-note">Browser-only draft. It is not authoritative and is not persisted.</p><p id="additional-information-status" aria-live="polite">Enter additional information to enable copy.</p></div>`
      : `<div class="copy-panel"><label for="continue-prompt">Ready-to-copy prompt</label><textarea id="continue-prompt" readonly rows="9" spellcheck="false">${escapeHtml(buildDownstreamHandoffPrompt(model, refinementPath))}</textarea><button type="button" id="copy-prompt" aria-controls="continue-prompt">Copy prompt</button><p id="copy-status" aria-live="polite"></p></div>`;
  return `<section class="section continue" id="continue"><div class="section-heading"><div><p class="eyebrow">Actionable handoff</p><h2>Continue workflow</h2><p>${blocked ? "Reconcile the current authority before starting a downstream workflow." : "The canonical handoff is ready for its recommended workflow."}</p></div></div><article class="continue-card ${blocked ? "is-blocked" : ""}"><div><span>Recommended workflow</span><h3>${escapeHtml(workflowLabel(model))}</h3><p><code>${escapeHtml(model.handoff.next_workflow)}</code> · <code>${escapeHtml(model.handoff.suggested_next_operation)}</code></p>${prose(model.handoff.reason)}${blocked ? "" : '<p class="canonical-note">This prompt uses the canonical handoff payload.</p>'}</div>${blockedControls}</article></section>`;
}

const STYLES = String.raw`
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}:root{--ink:#182230;--muted:#667085;--line:#e4e7ec;--paper:#fff;--canvas:#f8fafc;--brand:#4540a3;--brand-soft:#f0efff;--green:#067647;--green-soft:#ecfdf3;--amber:#b54708;--amber-soft:#fffaeb;--red:#b42318;--red-soft:#fef3f2;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--canvas)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{min-width:320px;margin:0;background:var(--canvas);font-size:16px;line-height:1.5}button,textarea{font:inherit}a{color:var(--brand)}button,a,summary,textarea{outline-offset:3px}button:focus-visible,a:focus-visible,summary:focus-visible,textarea:focus-visible{outline:3px solid #9e9bea}.skip{position:fixed;z-index:10;left:-999px;top:8px;background:#fff;padding:8px}.skip:focus{left:8px}.masthead,main,.page-footer{width:min(calc(100% - 40px),1120px);margin:auto}.masthead{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 0}.brand{display:flex;align-items:center;gap:9px;font-weight:850}.brand>span{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--brand);color:#fff}.brand small{display:block;color:var(--muted);font-size:.64rem;letter-spacing:.09em;text-transform:uppercase}.masthead nav{display:flex;flex-wrap:wrap;gap:3px}.masthead nav a{padding:6px 8px;color:var(--muted);font-size:.75rem;font-weight:700;text-decoration:none}.overview{padding:30px 0 18px;border-bottom:1px solid var(--line)}.eyebrow{margin:0 0 6px;color:var(--brand);font-size:.7rem;font-weight:850;letter-spacing:.1em;text-transform:uppercase}.overview-title{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.overview h1{max-width:760px;margin:0;font-size:clamp(2rem,5vw,3.5rem);letter-spacing:-.052em;line-height:1.02}.overview-title p{max-width:760px;color:var(--muted)}.outcome{flex:none;margin-top:7px;padding:7px 10px;border-radius:999px;font-size:.73rem}.outcome-blocked{background:var(--red-soft);color:var(--red)}.outcome-ready-for-spec{background:var(--green-soft);color:var(--green)}.outcome-ready-for-roadmap{background:var(--brand-soft);color:var(--brand)}.overview-line{margin:24px 0 12px;font-weight:800}.requirement-summary{display:grid;gap:8px}.requirement-summary>a{display:grid;grid-template-columns:minmax(210px,1fr) auto;gap:2px 14px;padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:#fff;text-decoration:none}.requirement-summary span{display:flex;gap:8px;align-items:baseline;min-width:0}.requirement-summary strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}.requirement-summary small{color:var(--muted)}.requirement-summary em{grid-column:1/-1;overflow:hidden;color:var(--muted);font-size:.8rem;font-style:normal;text-overflow:ellipsis;white-space:nowrap}.authority-note{margin:15px 0 0;color:var(--muted);font-size:.78rem}.section{padding-top:55px;scroll-margin-top:8px}.section-heading{margin-bottom:16px}.section-heading h2{margin:0;font-size:1.9rem;letter-spacing:-.035em}.section-heading p:last-child{margin:5px 0 0;color:var(--muted)}.requirement-stack,.technical-stack{display:grid;gap:14px}.requirement-card{overflow:hidden;border:1px solid var(--line);border-radius:16px;background:#fff;box-shadow:0 7px 22px rgba(16,24,40,.04)}.requirement-card>header,.decision-card>header,.technical-card>header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.requirement-card>header{padding:21px 22px;border-bottom:1px solid var(--line)}h3,h4,h5{line-height:1.22}.requirement-card h3{margin:0;font-size:1.35rem}.badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}.badge,.count,.requirement-ref{display:inline-flex;align-items:center;width:max-content;border-radius:999px;padding:3px 7px;font-size:.62rem;font-weight:850;letter-spacing:.03em}.badge{background:#f2f4f7;color:#475467;text-transform:uppercase}.badge-blocking,.badge-blocked{background:var(--red-soft);color:var(--red)}.badge-needs-decision,.badge-attention,.badge-open{background:var(--amber-soft);color:var(--amber)}.badge-clear,.badge-resolved,.badge-answered{background:var(--green-soft);color:var(--green)}.badge-info,.badge-technical-gap,.badge-cross-requirement-gap{background:#eff8ff;color:#175cd3}.count,.requirement-ref{border:1px solid var(--line);background:#fff;color:var(--muted)}.requirement-ref{margin-left:7px;vertical-align:middle;font-weight:750}.requirement-body{padding:20px 22px}.requirement-body>section+section{margin-top:25px}.requirement-body h4{margin:0 0 10px;font-size:.78rem;letter-spacing:.07em;text-transform:uppercase}.understood{display:grid;gap:7px;margin:0;padding-left:20px}.understood code{color:var(--muted);font-size:.76rem}.decisions>h4 span,.other-findings>h4 span{color:var(--muted);font-weight:600}.decision-card{margin-top:10px;border:1px solid var(--line);border-left:4px solid var(--amber);border-radius:11px;background:#fff}.decision-card>header{padding:13px 14px}.decision-card h4,.technical-card h4{margin:5px 0 3px;font-size:1rem}.decision-card header p{margin:0;color:var(--muted);font-size:.84rem}.decision-card details,.technical-card details{border-top:1px solid var(--line);padding:11px 14px}.decision-context,.finding-context{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:13px}.decision-context section,.finding-context section,.resolution{padding:11px;border-radius:9px;background:#f8fafc}.decision-context h5,.finding-context h5,.resolution h5{margin:0 0 5px;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}.decision-context p,.finding-context p,.resolution p{margin:0 0 7px;font-size:.84rem}.other-findings>details,.technical-groups>details,.exploration{padding:13px 14px;border:1px solid var(--line);border-radius:11px;background:#fafbfc}summary{cursor:pointer;color:var(--brand);font-weight:780}.dependency-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dependency-card{padding:17px;border:1px solid var(--line);border-radius:13px;background:#fff}.dependency-card header{display:flex;flex-wrap:wrap;gap:5px}.dependency-card h3{margin:13px 0 4px;font-size:1rem}.dependency-card>p{margin:0;color:var(--muted)}.dependency-card details{margin-top:11px;padding-top:10px;border-top:1px solid var(--line)}.technical-groups{display:grid;gap:9px}.technical-stack{margin-top:12px}.technical-card{overflow:hidden;border:1px solid var(--line);border-radius:11px;background:#fff}.technical-card.is-blocking{border-left:4px solid var(--red)}.technical-card>header{padding:13px}.technical-card>p{margin:0;padding:0 13px 13px;color:var(--muted);font-size:.84rem}.evidence-details{margin-top:11px;padding-top:10px;border-top:1px solid var(--line)}.evidence-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}.evidence-list article{padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff}.evidence-list strong{display:block;margin-top:5px;font-size:.84rem}.evidence-list p,.evidence-list small{margin:4px 0;font-size:.78rem;color:var(--muted)}.exploration{margin-top:14px}.exploration-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}.exploration-grid section{padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff}.exploration-grid h3{margin:0 0 6px;font-size:.8rem}.exploration-grid p,.exploration-grid ul{font-size:.78rem}.readiness-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.readiness-list article{padding:15px;border:1px solid var(--line);border-radius:11px;background:#fff}.readiness-list span,.readiness-list strong,.readiness-list small{display:block}.readiness-list span{color:var(--brand);font-size:.75rem;font-weight:850}.readiness-list strong{margin:5px 0}.readiness-list small{color:var(--muted)}.readiness-next{margin-top:12px;padding:12px;border-radius:9px;background:var(--brand-soft)}.continue{padding-bottom:36px}.continue-card{display:grid;grid-template-columns:.8fr 1.2fr;gap:20px;padding:21px;border:1px solid #cbc9ff;border-radius:15px;background:#f8f7ff}.continue-card.is-blocked{border-color:#fecdca;background:#fff8f7}.continue-card h3{margin:5px 0;font-size:1.4rem}.continue-card>div>span,.copy-panel>label{display:block;color:var(--muted);font-size:.7rem;font-weight:850;letter-spacing:.08em;text-transform:uppercase}.secondary-path{color:var(--muted);font-size:.84rem}.copy-panel textarea{display:block;width:100%;margin-top:6px;padding:10px;border:1px solid #98a2b3;border-radius:8px;background:#fff;color:var(--ink);font:400 .78rem/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}.copy-panel button,.page-footer button{margin-top:8px;padding:8px 11px;border:0;border-radius:8px;background:var(--brand);color:#fff;font-weight:750;cursor:pointer}.copy-panel p{min-height:1.25em;margin:6px 0 0;font-size:.82rem}.empty{color:var(--muted);font-style:italic}.page-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 0 42px;color:var(--muted);font-size:.78rem}.page-footer button{margin:0;background:#fff;color:var(--ink);border:1px solid var(--line)}@media(max-width:760px){.masthead{align-items:flex-start}.masthead nav{display:none}.overview-title,.requirement-card>header,.decision-card>header,.technical-card>header{flex-direction:column}.badges{justify-content:flex-start}.dependency-grid,.readiness-list,.evidence-list,.exploration-grid,.decision-context,.finding-context,.continue-card{grid-template-columns:1fr}.requirement-summary>a{grid-template-columns:1fr}.masthead,main,.page-footer{width:min(calc(100% - 24px),1120px)}}@media print{@page{margin:10mm}*{print-color-adjust:economy!important;-webkit-print-color-adjust:economy!important}body{background:#fff;font-size:9pt}.masthead nav,.copy-panel button,.page-footer button{display:none!important}.masthead,main,.page-footer{width:100%;max-width:none}.section{padding-top:6mm}.requirement-card,.decision-card,.technical-card,.dependency-card{box-shadow:none;break-inside:avoid}.requirement-summary>a{border-color:#777}.technical-groups>details,.other-findings>details,.exploration,details{background:#fff}.requirement-card details>:not(summary),.technical-card details>:not(summary),.decision-card details>:not(summary),.dependency-card details>:not(summary),.technical-groups>details>:not(summary),.other-findings>details>:not(summary),.exploration>:not(summary){display:block!important}.continue-card{grid-template-columns:.8fr 1.2fr}.copy-panel textarea{height:auto}.page-footer{padding-bottom:0}}
`;

const ADDITIONAL_STYLES = ".requirement-details{margin-top:16px;padding:13px 14px;border:1px solid var(--line);border-radius:11px;background:#fafbfc}.requirement-detail-grid,.finding-context{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:13px}.requirement-detail-grid section,.finding-context section{padding:11px;border-radius:9px;background:#f8fafc}.requirement-detail-grid ul{margin:0;padding-left:18px}.original-sources{margin-top:13px}.source-stack{display:grid;gap:8px}.source-stack article{padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff}.source-artifact small{display:block;color:var(--muted);font-size:.76rem}.decision-card.is-answered{border-left-color:var(--green)}.decision-card.decision-state-follow-up-required{border-left-color:var(--amber)}.decision-card.decision-state-reopened-follow-up-required{border-left-color:var(--red)}.canonical-answer{margin:0 14px 14px;padding:13px;border-radius:9px;background:var(--green-soft)}.decision-draft{padding:13px 14px;border-top:1px solid var(--line);background:#fffaf5}.decision-draft textarea{display:block;width:100%;min-height:118px;margin-top:6px;padding:10px;border:1px solid #98a2b3;border-radius:8px;resize:vertical}.decision-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.decision-actions button[disabled],#copy-decisions[disabled]{cursor:not-allowed;opacity:.5}.finding-sections{display:grid;gap:28px}.finding-sections>section>h3{margin:0 0 10px;font-size:1.1rem}.finding-card{overflow:hidden;border:1px solid var(--line);border-radius:11px;background:#fff}.finding-card.is-blocking{border-left:4px solid var(--red)}.finding-card>header{padding:13px}.finding-card>details{border-top:1px solid var(--line);padding:11px 13px}.resolution{margin-top:12px;padding:11px;border-radius:9px;background:#f8fafc}.resolution-accepted{background:var(--green-soft)}.resolution-rejected{background:var(--red-soft)}.resolution-inconclusive{background:var(--amber-soft)}.checks dl{display:grid;gap:4px;margin:0}.checks dl>div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:3px 0}.check-pass{color:var(--green)}.check-fail{color:var(--red)}.check-unknown{color:var(--amber)}.remaining-gap,.reopened{padding:8px;border-left:3px solid var(--red);background:#fff}.follow-up-context{margin:0 14px 12px;padding:13px;border-radius:9px;background:var(--amber-soft)}.follow-up-context>h5{margin:0 0 8px}.follow-up-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.follow-up-grid section{padding:10px;border-radius:8px;background:#fff}.attempt-history{margin:0 14px 14px;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:#fafbfc}.attempt-stack{display:grid;gap:9px;margin-top:10px}.attempt{padding:11px;border:1px solid var(--line);border-radius:8px;background:#fff}.attempt header{display:flex;justify-content:space-between;gap:8px}.attempt section{margin-top:8px}.attempt h5{margin:0 0 4px}.attempt p{margin:0;font-size:.84rem}.follow-up-references ul{margin:0;padding-left:20px}.follow-up-references li{margin:4px 0}.cross-group-stack{display:grid;gap:14px}.cross-group{padding:15px;border:1px solid #cbc9ff;border-radius:12px;background:#fff}.cross-group>header{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.cross-group>header h3{margin:0}.cross-group>section{margin-top:16px}.cross-group>section>h4{margin:0 0 8px}.is-retired{opacity:.9}@media(max-width:760px){.requirement-detail-grid,.finding-context,.follow-up-grid{grid-template-columns:1fr}}@media print{.decision-draft,.decision-actions,.draft-boundary,.decision-copy-status{display:none!important}}";
const HARDENING_STYLES = ".subsection-heading{margin:20px 0 8px}.subsection-heading h3{margin:0;font-size:1.2rem}.subsection-heading p:last-child{margin:5px 0 0;color:var(--muted);font-size:.86rem}.cross-decisions{margin:0 0 26px;padding:17px;border:1px solid #cbc9ff;border-radius:13px;background:#f8f7ff}.cross-decision-reference{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:9px;padding:11px;border:1px solid var(--line);border-radius:9px;background:#fff}.cross-decision-reference strong{display:block}.cross-decision-reference p{margin:4px 0 0;color:var(--muted);font-size:.84rem}.cross-decision-reference a{flex:none;font-weight:750}.generic-reconciliation textarea{min-height:150px}.generic-reconciliation button[disabled]{cursor:not-allowed;opacity:.5}@media print{.generic-reconciliation,.generic-reconciliation~*{display:none!important}.cross-decisions{break-inside:avoid}.cross-group{break-inside:avoid}}";
const HISTORY_STYLES = ".migration-note{margin:8px 0 0;color:var(--muted);font-size:.82rem}.conflict-context{border-left:3px solid var(--red)}.reopen-history{margin:11px 14px 14px;padding-top:10px;border-top:1px solid var(--line)}";

const CLIENT_SCRIPT = String.raw`
(()=>{"use strict";
const FORMAT=${JSON.stringify(PROMPT_CONTRACT)};
  const main=document.getElementById("main");
  const allCards=[...document.querySelectorAll('[data-decision-card][data-open="true"]')];
  const drafts=allCards.map(card=>({card,textarea:card.querySelector("[data-draft-decision]"),copy:card.querySelector("[data-copy-decision]"),clear:card.querySelector("[data-clear-draft]"),status:card.querySelector(".decision-copy-status")})).sort((left,right)=>left.textarea.dataset.questionId.localeCompare(right.textarea.dataset.questionId,"en"));
  const aggregate=document.getElementById("continue-prompt");
  const aggregateCopy=document.getElementById("copy-decisions");
  const aggregateStatus=document.getElementById("aggregate-copy-status");
  const generic=document.getElementById("additional-information-draft");
  const genericCopy=document.getElementById("copy-additional-information");
  const genericClear=document.getElementById("clear-additional-information");
  const genericStatus=document.getElementById("additional-information-status");
  const summaries=[document.getElementById("draft-summary"),document.getElementById("readiness-draft-summary")].filter(Boolean);
  let lastDrafted=-1;
  function announce(status,message){if(status)status.textContent=message}
  function copyText(value,target,status){if(!value.trim()){announce(status,"Enter information before copying.");return}if(navigator.clipboard&&typeof navigator.clipboard.writeText==="function"){navigator.clipboard.writeText(value).then(()=>announce(status,"Copied."),fallback);return}fallback();function fallback(){const helper=document.createElement("textarea");helper.value=value;helper.setAttribute("readonly","");helper.style.position="fixed";helper.style.opacity="0";document.body.append(helper);helper.focus();helper.select();let copied=false;try{copied=document.execCommand("copy")}catch{copied=false}helper.remove();announce(status,copied?"Copied.":"Select and copy the prompt manually.");if(target)target.focus()}}
  function promptHeader(){return [FORMAT.workflowPrefix+main.dataset.handoffWorkflow+FORMAT.workflowSuffix,main.dataset.handoffOperation,"PROJECT_ROOT={{PROJECT_ROOT}}","REFINEMENT_PATH="+main.dataset.refinementPath,"REFINEMENT_ID="+main.dataset.refinementId]}
  function serialize(header,entries){if(entries.length===0)return "";return header.join("\n")+"\n"+FORMAT.newInformation+"\n\n"+entries.join("\n\n")}
  function decisionEntry(card,textarea){const question=card.querySelector("[data-question-text]").textContent;const interaction=textarea.dataset.interactionState;const lines=[FORMAT.entryPrefix+textarea.dataset.questionId+FORMAT.entrySeparator+textarea.dataset.requirementIdentity,FORMAT.interactionPrefix+interaction,FORMAT.questionPrefix+question];if(interaction!=="AWAITING_DECISION"&&interaction!=="ANSWERED"){if(textarea.dataset.previousResponse)lines.push(FORMAT.previousResponsePrefix+textarea.dataset.previousResponse);else if(textarea.dataset.migrationNotice)lines.push(FORMAT.migrationNoticePrefix+textarea.dataset.migrationNotice);if(interaction==="REOPENED_FOLLOW_UP_REQUIRED"){lines.push(FORMAT.previousCanonicalAnswerPrefix+(textarea.dataset.previousCanonicalAnswer||"none"),FORMAT.reopenedReasonPrefix+(textarea.dataset.reopenedReason||"none"))}if(textarea.dataset.conflictActive==="true"){lines.push(FORMAT.previousDisputedPrefix+(textarea.dataset.previousDisputedContext||"none"),FORMAT.conflictingInformationPrefix+textarea.dataset.newConflictingInformation,FORMAT.currentEstablishedPrefix+(textarea.dataset.currentEstablishedContext||"none"),FORMAT.conflictStatusPrefix+FORMAT.conflictStatus)}else lines.push(FORMAT.currentEstablishedPrefix+(textarea.dataset.currentEstablishedContext||"none"));lines.push(FORMAT.remainingPrefix+(textarea.dataset.remainingGaps||"none"))}lines.push(FORMAT.decisionLabel,textarea.value,FORMAT.requirementIdsPrefix+textarea.dataset.requirementIdsList,FORMAT.sourceIdsPrefix+textarea.dataset.sourceIdsList,FORMAT.needIdsPrefix+textarea.dataset.needIdsList,FORMAT.findingIdsPrefix+textarea.dataset.findingIdsList);return lines.join("\n")}
  function additionalEntry(){const lines=[generic.value,"",FORMAT.blockingIdsPrefix+(main.dataset.blockingFindingIdsList||FORMAT.none)];const carried=main.dataset.carriedFindingIdsList;if(carried)lines.push(FORMAT.carriedIdsPrefix+carried);return lines.join("\n")}
  function updateDecisionDrafts(){const filled=drafts.filter(item=>item.textarea.value.trim()!=="");const entries=filled.map(item=>decisionEntry(item.card,item.textarea));const text=drafts.length+" open · "+filled.length+" answered in draft · "+(drafts.length-filled.length)+" remaining";if(main.dataset.draftMode==="decisions"&&filled.length!==lastDrafted){summaries.forEach(item=>{item.textContent=text});lastDrafted=filled.length}drafts.forEach(item=>{const hasValue=item.textarea.value.trim()!=="";item.copy.disabled=!hasValue;item.clear.disabled=!hasValue});if(aggregate&&aggregateCopy){aggregate.value=filled.length===0?"":serialize(promptHeader(),entries);aggregateCopy.disabled=filled.length===0;aggregateCopy.textContent="Copy "+filled.length+" decision"+(filled.length===1?"":"s")+" for "+main.dataset.handoffOperation.replace(/^OPERATION=/u,"");announce(aggregateStatus,filled.length===0?"Fill at least one decision to enable aggregate copy.":filled.length+" decision"+(filled.length===1?"":"s")+" ready to copy.")}}
  function updateGenericDraft(){if(!generic)return;const hasValue=generic.value.trim()!=="";genericCopy.disabled=!hasValue;genericClear.disabled=!hasValue;announce(genericStatus,hasValue?"Additional information ready to copy.":"Enter additional information to enable copy.")}
  drafts.forEach(item=>{item.textarea.addEventListener("input",updateDecisionDrafts);item.copy.addEventListener("click",()=>copyText(serialize(promptHeader(),[decisionEntry(item.card,item.textarea)]),item.textarea,item.status));item.clear.addEventListener("click",()=>{item.textarea.value="";announce(item.status,"Draft cleared.");item.textarea.focus();updateDecisionDrafts()})});
  if(aggregateCopy)aggregateCopy.addEventListener("click",()=>copyText(aggregate.value,aggregate,aggregateStatus));
  if(generic){generic.addEventListener("input",updateGenericDraft);genericCopy.addEventListener("click",()=>copyText(serialize(promptHeader(),[additionalEntry()]),generic,genericStatus));genericClear.addEventListener("click",()=>{generic.value="";generic.focus();updateGenericDraft()})}
  const copyPrompt=document.getElementById("copy-prompt");const target=document.getElementById("continue-prompt");const copyStatus=document.getElementById("copy-status");if(copyPrompt)copyPrompt.addEventListener("click",()=>copyText(target.value,target,copyStatus));
  const print=document.getElementById("print");if(print)print.addEventListener("click",()=>window.print());let opened=[];addEventListener("beforeprint",()=>{opened=[...document.querySelectorAll("details:not([open])")];opened.forEach(item=>{item.open=true})});addEventListener("afterprint",()=>{opened.forEach(item=>{item.open=false});opened=[]});
  updateDecisionDrafts();updateGenericDraft();
})();
`;
export function renderRefinement(model, options = {}) {
  const refinementPath = options.refinementPath ?? "docs/refinement";
  const maps = mapsFor(model);
  const openQuestions = model.questions.filter((item) => item.status === "OPEN");
  const blockingFindings = model.findings.filter((item) => item.disposition === "open" && item.severity === "BLOCKING");
  const blockers = blockingFindings.length;
  const followUpQuestions = openQuestions.filter((item) => questionInteractionState(item) !== "AWAITING_DECISION");
  const draftMode = model.handoff.outcome !== "BLOCKED" ? "none" : openQuestions.length === 0 ? "additional-information" : "decisions";
  const readinessDraftSummary = draftMode !== "none"
    ? `<p class="draft-summary" id="readiness-draft-summary" aria-live="polite">${draftMode === "additional-information" ? "No OPEN decisions · additional information draft available" : `${openQuestions.length} open · 0 answered in draft · ${openQuestions.length} remaining`}</p>`
    : "";
  const globalFindings = model.findings.filter((item) => item.requirement_ids.length === 0);
  const counts = { requirements: model.requirements.length, sources: model.sources.length, open: model.findings.filter((item) => item.disposition === "open").length, resolved: model.findings.filter((item) => item.disposition === "resolved").length, bypassed: model.findings.filter((item) => item.disposition === "bypassed").length, blocking: blockers, follow_ups: followUpQuestions.length };
  const summaryCards = model.requirements.map((requirement) => {
    const questions = model.questions.filter((item) => item.requirement_ids.includes(requirement.id));
    const findings = model.findings.filter((item) => item.requirement_ids.includes(requirement.id));
    const blocking = findings.filter((item) => item.disposition === "open" && item.severity === "BLOCKING");
    const open = questions.filter((item) => item.status === "OPEN");
    const state = requirement.state === "RETIRED" ? "RETIRED" : blocking.length > 0 || open.length > 0 ? "BLOCKED" : findings.some((item) => item.disposition === "open") ? "ATTENTION" : "READY";
    const next = open[0]?.question ?? blocking[0]?.title ?? "No active blocker.";
    return "<a role=\"listitem\" href=\"#" + escapeHtml(requirement.id) + "\"><span><code>" + escapeHtml(requirementLabel(requirement)) + "</code><strong>" + escapeHtml(requirement.title) + "</strong></span>" + badge(state) + "<small>" + open.length + " decisions open · " + blocking.length + " blockers · " + findings.length + " findings</small><em>" + escapeHtml(next) + "</em></a>";
  }).join("");
  const findingGroup = (title, items, empty) => "<section><h3>" + title + " <span>" + items.length + "</span></h3>" + (items.length === 0 ? "<p class=\"empty\">" + empty + "</p>" : "<div class=\"technical-stack\">" + items.map((item) => findingCard(item, model, maps)).join("") + "</div>") + "</section>";
  const compose = (fingerprint) => [
    "<!doctype html>\n<!-- stnl-requirements-refiner:v2 fingerprint:" + fingerprint + " -->",
    "<html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"description\" content=\"" + escapeHtml(model.summary) + "\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'\"><title>" + escapeHtml(model.title) + " · Requirements Refinement</title><style>" + STYLES + ADDITIONAL_STYLES + HARDENING_STYLES + HISTORY_STYLES + "</style></head><body>",
    "<a class=\"skip\" href=\"#main\">Ir para o conteúdo</a><header class=\"masthead\" id=\"top\"><div class=\"brand\"><span aria-hidden=\"true\">S</span><div>Sentinel<small>Requirements Refinement</small></div></div><nav aria-label=\"Seções\"><a href=\"#overview\">Overview</a><a href=\"#requirements\">Requirements</a><a href=\"#cross-requirements\">Cross-requirement</a><a href=\"#findings\">Findings</a><a href=\"#readiness\">Readiness</a><a href=\"#continue\">Continue workflow</a></nav></header>",
    "<main id=\"main\" tabindex=\"-1\" data-handoff-workflow=\"" + escapeHtml(model.handoff.next_workflow) + "\" data-handoff-operation=\"" + escapeHtml(model.handoff.suggested_next_operation) + "\" data-refinement-id=\"" + escapeHtml(model.refinement_id) + "\" data-refinement-path=\"" + escapeHtml(refinementPath) + "\" data-draft-mode=\"" + draftMode + "\" data-blocking-finding-ids-list=\"" + escapeHtml(model.handoff.blocker_ids.join(", ")) + "\" data-carried-finding-ids-list=\"" + escapeHtml(model.handoff.carried_finding_ids.filter((id) => !model.handoff.blocker_ids.includes(id)).join(", ")) + "\">",
    "<section class=\"overview\" id=\"overview\"><p class=\"eyebrow\">" + escapeHtml(model.refinement_id) + " · deterministic projection</p><div class=\"overview-title\"><div><h1>" + escapeHtml(model.title) + "</h1>" + prose(model.summary) + "</div><strong class=\"outcome outcome-" + model.handoff.outcome.toLowerCase().replaceAll("_", "-") + "\">" + escapeHtml(model.handoff.outcome.replaceAll("_", " ")) + "</strong></div><p class=\"overview-line\">" + model.requirements.length + " Requirements · " + model.sources.length + " Sources · " + model.questions.length + " Decisions · " + followUpQuestions.length + " Follow-ups · " + blockers + " Blockers · " + escapeHtml(model.handoff.outcome.replaceAll("_", " ")) + "</p><div class=\"requirement-summary\" role=\"list\">" + summaryCards + "</div><p class=\"authority-note\"><code>refinement.json</code> is the authority. This offline page is a deterministic projection only. Local drafts are ephemeral and are not part of this projection.</p></section>",
    "<section class=\"section\" id=\"requirements\"><div class=\"section-heading\"><div><p class=\"eyebrow\">Requirement → Decision → Finding → Evidence</p><h2>Requirements</h2><p>Each logical Requirement owns its sources; local decisions and findings stay in one card.</p></div></div><div class=\"requirement-stack\">" + model.requirements.map((requirement) => requirementCard(requirement, model, maps)).join("") + "</div></section>" + crossRequirementSection(model, maps),
    "<section class=\"section\" id=\"findings\"><div class=\"section-heading\"><div><p class=\"eyebrow\">Secondary investigation</p><h2>Findings</h2><p>Local and cross findings live at their primary Requirement scope; global technical findings remain here.</p></div></div><div class=\"finding-sections\">" + findingGroup("Global technical findings", globalFindings, "No global findings without a Requirement scope.") + "</div><details class=\"exploration\"><summary>Bounded exploration record</summary><div class=\"exploration-grid\"><section><h3>Status</h3>" + badge(model.exploration.status) + prose(model.exploration.stop_reason) + "</section><section><h3>Anchors</h3>" + list(model.exploration.anchors) + "</section><section><h3>Searches</h3>" + list(model.exploration.searches) + "</section><section><h3>Files read</h3>" + list(model.exploration.files_read) + "</section><section><h3>Limitations</h3>" + list(model.exploration.limitations, "No material limitation recorded.") + "</section></div></details></section>",
    "<section class=\"section\" id=\"readiness\"><div class=\"section-heading\"><div><p class=\"eyebrow\">Operational status</p><h2>Refinement readiness</h2><p>Overall: <strong>" + escapeHtml(model.handoff.outcome.replaceAll("_", " ")) + "</strong></p></div></div><div class=\"readiness-list\">" + model.requirements.map((requirement) => { const related = model.questions.filter((item) => item.requirement_ids.includes(requirement.id)); const pending = related.filter((item) => item.status === "OPEN").length; const followUps = related.filter((item) => item.status === "OPEN" && questionInteractionState(item) !== "AWAITING_DECISION").length; const blocked = model.findings.filter((item) => item.requirement_ids.includes(requirement.id) && item.disposition === "open" && item.severity === "BLOCKING").length; const attention = model.findings.filter((item) => item.requirement_ids.includes(requirement.id) && item.disposition === "open" && item.severity === "ATTENTION").length; return "<article><span>" + escapeHtml(requirementHeading(requirement)) + "</span><strong>" + (related.filter((item) => item.status === "ANSWERED").length) + " / " + related.length + " decisions answered</strong><small>" + pending + " OPEN · " + followUps + " FOLLOW-UP REQUIRED · " + blocked + " blocking · " + attention + " attention</small></article>"; }).join("") + "</div>" + readinessDraftSummary + "<p class=\"readiness-next\">Next operation: <code>" + escapeHtml(model.handoff.next_workflow) + "</code> · <code>" + escapeHtml(model.handoff.suggested_next_operation) + "</code></p></section>" + continueWorkflow(model, refinementPath),
    "</main><footer class=\"page-footer\"><p>Refinement offline · fingerprint <code>" + fingerprint.slice(0, 12) + "</code></p><a href=\"#top\">Back to top</a><button type=\"button\" id=\"print\">Print</button></footer><script>" + CLIENT_SCRIPT + "</script></body></html>",
  ].join("");
  const draft = compose("0".repeat(64));
  const fingerprint = createHash("sha256").update(draft, "utf8").digest("hex");
  return { html: compose(fingerprint), fingerprint, outcome: model.handoff.outcome, counts };
}
