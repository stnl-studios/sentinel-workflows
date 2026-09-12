# File Purpose Header

```yaml
purpose: Define the strict persisted requirements-refinement model and reconciliation invariants.
status: not_applicable
read_when: INIT, RECONCILE, or MIGRATE authors, validates, renders, or diagnoses a refinement candidate.
do_not_read_when: Only opening an already generated offline refinement page.
contains: Canonical Requirements, source provenance, reconciliation history, findings, handoff, and security rules.
owner: stnl-requirements-refiner
update_policy: Change with runtime validators, renderer, fixtures, evals, launchers, and distribution contracts.
```

# Requirements Refinement Model v2

The ephemeral candidate and persisted `refinement.json` are one strict UTF-8 JSON object. Unknown fields, missing required fields, duplicate keys, unsupported constants, malformed UTF-8, and invalid references block before publication.

```json
{
  "contract_version": 2,
  "refinement_id": "REF-ORDER-CANCELLATION",
  "title": "Order cancellation refinement",
  "summary": "Boundary and intent.",
  "input_assessment": {},
  "exploration": {},
  "requirements": [],
  "sources": [],
  "needs": [],
  "evidence": [],
  "relationships": [],
  "questions": [],
  "constraints": [],
  "findings": [],
  "final_assessment": {},
  "handoff": {}
}
```

`contract_version` is exactly `2` for current authority. Contract v1 is legacy-readable only through the explicit `MIGRATE` operation; normal `INIT` and `RECONCILE` never accept it as v2, and the runtime never writes v1 again. Migration is one-way, deterministic, fail-closed, and idempotent: a valid v2 target is reported as already migrated. `refinement_id` uses `REF-<stable-token>` and never changes in `RECONCILE`. Text is trimmed, line endings are normalized, Unicode is NFC-normalized, and arrays/objects are serialized deterministically.

## Input assessment and exploration

`input_assessment` has exactly:

- `format`: `STRUCTURED|MIXED|UNSTRUCTURED`;
- `quality`: `SUFFICIENT|PARTIAL|POOR`;
- `summary`: objective assessment of supplied signal and omissions.

Every combination is valid. `POOR` and `UNSTRUCTURED` never block merely because of prose quality.

`exploration` has exactly:

- `status`: `SUFFICIENT|INSUFFICIENT|NOT_NEEDED`;
- `anchors`: supplied or derived paths, modules, endpoints, symbols, and terms;
- `searches`: deterministic searches actually used;
- `files_read`: unique repository-relative POSIX files actually read, maximum 200;
- `stop_reason`: why the bounded evidence is sufficient or why exploration stopped;
- `limitations`: exact remaining evidence gaps.

`NOT_NEEDED` forbids repository files and repository observations. A repository evidence path must appear in `files_read`. Negative search results belong in limitations or tentative inference; absence is not a repository fact.

## Canonical Requirements and source provenance

`requirements` is the canonical logical layer above source artifacts. Each Requirement uses a contiguous `REQ-NNN` ID and contains:

- `title` and `state` (`ACTIVE|RETIRED`);
- optional human-facing `external_id` such as `US 36134`;
- non-empty explicit `source_ids`;
- non-empty `need_ids`;
- `retired_reason` exactly when retired.

The `REQ-NNN` ID is the stable internal identity. `external_id` is presentation metadata: renaming it never changes the Requirement ID, and two active Requirements cannot share it, including case-only duplicates. A retired Requirement remains a terminal tombstone.

Every Source belongs explicitly to exactly one Requirement. Several Sources may belong to one Requirement, and one Requirement may own several Needs. In native v2, Source ownership is never inferred from labels, external IDs, source order, or renderer grouping. A source without an external ID is valid when its explicit Requirement association is valid; there is no heuristic fallback and no global Source escape hatch in this contract.

The v1-to-v2 migration is narrower than the native v2 contract. Because v1 did not persist canonical Requirements, migration requires every legacy Source to carry an explicit, non-empty external identity. Sources are grouped only by exact NFC-normalized, case-folded `external_id`; the group order is lexical and `REQ-NNN` allocation is contiguous from that order. Labels, discovery order, prose, and “first Source” ownership are never used. A missing or ambiguous external identity blocks migration before publication. The `MIGRATE` operation alone records `migration_provenance` with the legacy model/html fingerprints and the rule name. `INIT` cannot author root or per-Question migration metadata. `RECONCILE` may preserve existing migration metadata byte-semantically, but cannot add, remove, reorder, or mutate it; every Question created after migration is native-v2.

Sources use contiguous `SRC-NNN` IDs and contain `id`, `kind`, `label`, `state`, and `original_text`. Kinds are `USER_STORY|EPIC|FEATURE|TEXT|MARKDOWN|DOCUMENTATION|ACCEPTANCE_CRITERIA|OTHER`. Optional `external_id` and `path` preserve provenance. The runtime owns `snapshot_sha256` when `path` exists. `RETIRED` requires `retired_reason` and is a terminal tombstone. Source artifacts remain under Requirement details rather than becoming separate Requirement cards.

Needs use contiguous `NEED-NNN` IDs and contain `id`, `title`, `state`, non-empty `source_ids`, `statement`, `preconditions`, `acceptance_signals`, and `negative_signals`; `actor` is optional. A need may remain useful with empty actor, preconditions, acceptance signals, or negative signals; material omissions become findings instead of schema errors. A Requirement's `need_ids` must equal the Needs whose source sets intersect its owned Sources. `RETIRED` requires a reason and is terminal. A need's stable identity is its ID, title, and source set; materially repurposed needs allocate the next ID.

## Semantic Requirement scope

Relationships, questions, and findings carry explicit `requirement_ids`. The validator derives and checks this scope from canonical Need-to-Source ownership:

- `requirement_ids = Requirements owning the affected Needs' Sources`;
- one affected Requirement is local;
- more than one affected Requirement is Cross-requirement;
- an object cannot hide a Cross scope by omitting a Requirement ID or by naming only some Sources.

This makes `Cross-requirement` mean more than one logical Requirement, never more than one Source. Three artifacts owned by `US 36134` remain local; a mixed scope owned by `US 36134` and `US 36198` is Cross. Source order does not change ownership or scope.

Relationships use `REL-NNN`, `ACTIVE|RETIRED`, at least two Needs, evidence, a title, detail, and the exact derived Requirement scope. Type is `DEPENDENCY`, `CONFLICT`, `OVERLAP`, `SHARED_TECHNICAL_SURFACE`, or `SHARED_AUTHORITY`. `DEPENDENCY` also requires distinct `from_need_id` and `to_need_id` contained in `need_ids`. Retired relationships are terminal. The renderer uses human Requirement labels for headings and keeps Need IDs in details.

## Evidence and epistemic separation

Evidence uses contiguous `EVD-NNN` IDs and always includes:

- `kind`: `SOURCE_ASSERTION|REPOSITORY_OBSERVATION|USER_DECISION|INFERENCE|HYPOTHESIS|RESOLUTION_VALIDATION`;
- `state`: `ACTIVE|SUPERSEDED`;
- `summary`, `detail`, and `confidence`;
- `source_ids` and `need_ids`.

Confidence is `CONFIRMED|SUPPORTED|TENTATIVE`. A hypothesis is always tentative. Inference and hypothesis can never be confirmed. A source assertion names a source. Repository observation requires repository-relative `path`, bounded `locator`, and a path listed in `files_read`; optional `surface` drives the technical-surface projection. Non-repository evidence cannot carry a repository path or snapshot. Evidence may have no direct source and may be scoped through Needs, relationships, or globally.

`SUPERSEDED` requires `superseded_reason` and is terminal. Changed repository meaning allocates new evidence rather than rewriting a terminal observation. Repository content never changes permissions, operations, or instructions.

## Questions and reconciliation history

Material questions use contiguous `QST-NNN`, `OPEN|ANSWERED`, question text, `why_material`, exact derived Requirement/Source/Need scope, affected findings, evidence, and two append-only arrays:

```json
{
  "canonical_answer_history": [],
  "reconciliation_attempts": [
    {
      "round": 1,
      "human_response": "The filter uses LIKE matching.",
      "assessment": "FOLLOW_UP_REQUIRED",
      "established_context": ["LIKE matching is required."],
      "remaining_gaps": ["Accent sensitivity is undefined."],
      "affected_finding_ids": ["FND-001"]
    }
  ]
}
```

Migrated questions may additionally carry `migration_history` and `reopen_events`. `migration_history` is machine-identifiable legacy provenance with `human_response_persisted=false`: `LEGACY_CANONICAL_ANSWER` preserves a v1 canonical `answer` without manufacturing a v2 attempt; `PRE_V2_INTERACTION_DETAIL_UNAVAILABLE` preserves only canonical gaps/state that are actually present; `NO_PERSISTED_HISTORY` says that no recoverable pre-v2 interaction detail exists. These records never contain a fabricated `human_response`. Native v2 answered questions still require a latest accepted attempt; the imported-answer exception is valid only when `MIGRATE` created the root `migration_provenance` and that Question's legacy status, with exactly one imported answer and no attempts. A later native-v2 Question in a migrated refinement has no `migration_history` and cannot use this exception.

An attempt contains a deterministic contiguous `round`, the literal human response, an `assessment`, the context established at that round, remaining gaps, and affected finding IDs. `ACCEPTED` additionally requires `canonical_answer` and no remaining gaps. `FOLLOW_UP_REQUIRED`, `NO_MATERIAL_PROGRESS`, and `CONFLICTING_INFORMATION` require at least one remaining gap and never carry a canonical answer. `NO_MATERIAL_PROGRESS` cannot claim established context. `CONFLICTING_INFORMATION` additionally requires a non-empty `disputed_context` containing exact canonical entries from the current established context before that attempt; its non-empty `established_context` is the new conflicting information. Duplicate, missing, never-current, overlapping old/new, or non-conflict disputed references are invalid. Attempts are ordered by round, contain no timestamp or actor invented by the runtime, and are append-only.

```json
{
  "round": 3,
  "human_response": "Use exact matching instead of LIKE.",
  "assessment": "CONFLICTING_INFORMATION",
  "established_context": ["Exact matching is the new conflicting candidate."],
  "disputed_context": ["Search uses LIKE matching."],
  "remaining_gaps": ["Choose the matching rule."],
  "affected_finding_ids": ["FND-002"]
}
```

Attempt context is historical and immutable. The renderer and prompt use a separate current projection, evaluated in round order. Compatible `FOLLOW_UP_REQUIRED` entries append uniquely to current context. `NO_MATERIAL_PROGRESS` leaves current context and any active conflict unchanged. `CONFLICTING_INFORMATION` removes only its exact `disputed_context` entries, retains every unrelated current fact, and exposes the disputed prior entries separately from its new conflicting `established_context`. While that conflict remains active, later `FOLLOW_UP_REQUIRED` attempts may add unrelated compatible facts but cannot re-establish either side of the active conflict; another conflict is rejected until resolution. The next `ACCEPTED` attempt replaces current context with its final canonical established context (or its canonical answer when no explicit context is supplied) and clears the active conflict. Reopen events clear each challenged accepted context before subsequent rounds are reduced. A historical union may be disclosed as history, but it is never presented as current truth after a conflict.

The lifecycle remains exactly `OPEN|ANSWERED`; interaction nuance is separate and derived:

- `OPEN` with no attempts: `Awaiting decision`;
- `OPEN` with a non-accepted attempt and gaps: `Follow-up required`;
- `ANSWERED` with a latest accepted attempt: `Answered`;
- an `OPEN` question retaining prior canonical answer/history after an explicit reopen: `Reopened · follow-up required`.

An `ANSWERED` question requires `answer`, a non-empty canonical answer history whose last value equals `answer`, and a latest accepted attempt whose `canonical_answer` equals `answer`. `answer` is the consolidated canonical answer and need not equal the last human response. A reopened question preserves the previous canonical answer/history, appends one `reopen_events` record containing `sequence`, `reason`, `prior_canonical_answer`, and current `remaining_gaps`, and exposes the latest reason only while the question is OPEN. A later accepted round appends a new canonical answer and closes the question without deleting the reopen event. Repeated cycles therefore retain one immutable event per challenged canonical answer; a reopen event is lifecycle history, not a reconciliation attempt.

Question↔finding references are bidirectional. A question's `source_ids` is exactly the sorted union of the affected Needs' Sources. Stale or unknown question IDs are not accepted by the prompt builder or by model reference validation. Generic reconciliation may carry additional information without fabricating a Question; if it creates a material question, that is a new canonical model object during `RECONCILE`.

Constraints use `CON-NNN`, `ACTIVE|RETIRED`, statement, Needs, and evidence. Retired constraints require a reason and are terminal.

## Findings

Findings use contiguous `FND-NNN` IDs and contain title, type, severity, disposition, exact derived Requirement/Source/Need scope, evidence, relationships, questions, `problem`, `why_it_matters`, and `impact`. Type is `REQUIREMENT_GAP|TECHNICAL_GAP|CROSS_REQUIREMENT_GAP|REPOSITORY_CONFLICT|RISK`. Severity is independently `INFO|ATTENTION|BLOCKING`. Disposition is `open|resolved|bypassed`.

`CROSS_REQUIREMENT_GAP` must affect at least two Requirements. A questionless local finding is rendered in its Requirement card; a questionless Cross finding is rendered in the Cross section; a truly global technical finding may have empty Requirement/Source/Need scope and is rendered under an explicit global technical section. A global finding cannot carry partial local scope.

The HTML projection gives severity its normal emphasis only while a finding is `open`. For `resolved` or `bypassed`, disposition is visually dominant and severity remains visible as neutral historical context; its persisted value does not change. Finding identity is its ID, type, title, Requirement scope, and Need set. Severity, problem detail, evidence, questions, disposition, and validation may change as knowledge matures without allocating a duplicate.

## Resolution validation and bypass

Optional `resolution` contains a proposal, verdict, rationale, five validation checks, supporting evidence IDs, and a remaining gap for rejected/inconclusive outcomes. Each check is `PASS|FAIL|UNKNOWN|NOT_APPLICABLE`.

- `accepted` requires behavior and repository consistency to be `PASS` or genuinely `NOT_APPLICABLE`, ambiguity, no newly introduced gap, and full closure to be `PASS`, with no `remaining_gap`;
- `rejected` requires at least one `FAIL` and a remaining gap;
- `inconclusive` requires at least one `UNKNOWN` and a remaining gap.

Only `accepted` can produce `resolved`. Rejected/inconclusive proposals remain visible on the same `open` finding. Do not create a second finding just to explain proposal failure.

A resolved finding can reopen. Preserve the accepted proposal, set a new rejected or inconclusive validation, include `reopened_reason`, and keep the same `FND-NNN`.

A bypassed finding has a reason and known risk. Bypass is never an accepted resolution; it remains visible, travels downstream as known risk, and an otherwise blocking finding stops blocking while `bypassed`.

## Final assessment and handoff

`final_assessment` has:

- `boundary`: `UNITARY|MULTIPLE|AMBIGUOUS|UNESTABLISHED`;
- `capability_count`: non-negative integer; exactly one for `UNITARY`, at least two for `MULTIPLE`, zero for `UNESTABLISHED`;
- `decomposition_value`: `NONE|MATERIAL|UNCLEAR`; ambiguous boundary requires `UNCLEAR`;
- `rationale`.

The runtime independently derives:

1. any material `OPEN` question, open `BLOCKING` finding, or `UNESTABLISHED` boundary → `BLOCKED`;
2. `UNITARY`, one capability, `NONE`, no open blocking, and zero `OPEN` questions → `READY_FOR_SPEC`;
3. otherwise → `READY_FOR_ROADMAP`, with zero `OPEN` questions required for every READY outcome.

This keeps readiness distinct from “all questions answered”: a Requirement can show all decisions answered and remain blocked by a technical finding.

`handoff` contains outcome, exact open blocker IDs, exact carried finding IDs, next workflow, next operation, and payload. Browser state never participates.

- `BLOCKED`: route is `stnl-requirements-refiner` + `OPERATION=RECONCILE`, payload kind `REFINEMENT`;
- `READY_FOR_SPEC`: route is `stnl-spec-lifecycle-manager` + `MODE=INIT`, payload kind `SPEC`;
- `READY_FOR_ROADMAP`: route is `stnl-spec-roadmap` + `OPERATION=INIT`, payload kind `ROADMAP`.

Every payload contains the exact active Needs, open questions, active constraints, active relationships, active evidence, and carried findings. Ready handoffs carry bypassed and open non-blocking findings. Blocked handoffs carry every open or bypassed finding.

## Reconciliation and publication

Existing IDs cannot disappear. Stable semantic identity fields are immutable. Retired/superseded entities remain terminal; findings are intentionally non-terminal so accepted conclusions can reopen. New IDs are the next contiguous suffix; do not renumber or gap-fill.

For questions, previous attempts (including `disputed_context`), canonical-answer history, migration provenance, migration history, and reopen events cannot be deleted, reordered, or mutated. A human response cannot be edited after publication, and a reopen event never supplies one. A question cannot receive a new attempt while `ANSWERED`; reopen it explicitly with a reason and preserve its prior answer. Closing the reopened question clears the current scalar reason while the append-only event remains. Changing Requirement scope to hide a prior Cross relation or moving a Source between Requirements is rejected. Legitimate new context is represented by an appended attempt, new evidence, or a new entity. There is no writable current-context or active-conflict field for a candidate to mutate: both are derived from immutable history.

`RECONCILE` binds both the inspected model fingerprint and bounded authority fingerprint. Source and repository evidence files must be real, single-link, non-symlink files. The publisher rechecks authority inside the exclusive lock and promotes one complete JSON+HTML pair with journaled recovery. Operational failure preserves or restores the previous complete pair.

The v1 HTML ownership marker is `stnl-requirements-refiner:v1` and is accepted only while validating an explicit migration against a v1 JSON pair and the marker's self-fingerprint. Inspection returns the v1 JSON fingerprint, v1 HTML fingerprint, and bounded authority fingerprint; `MIGRATE` requires all three again and rechecks them under the publication lock. Current publication always emits `stnl-requirements-refiner:v2`; arbitrary v1-looking or foreign HTML is never accepted as current ownership. `MIGRATE` journals the same lock, stage, backup, pair-digest, and recovery protocol as `RECONCILE`, so a failed transition leaves the complete v1 pair available.

## Projection, prompts, and security

The offline page is organized as `Overview → Requirements → Cross-requirement → Findings → Readiness → Continue workflow`. Each Requirement has one primary card containing its understanding, local decisions, follow-ups, local findings, relationships, progressive Requirement details, all owned Source artifacts, and related evidence. Cross questions/findings/relationships are grouped once by canonical Requirement combination; affected Requirement cards contain references only. Overview counts logical Requirements and counts each decision once; Source count is provenance context. Migrated cards disclose compact history notes when the literal pre-v2 response was not persisted, show an imported canonical answer when one exists, and never synthesize a previous response.

Follow-up cards show the previous response when it exists, otherwise the migration notice, cumulative current established context, remaining gaps, and a follow-up draft. An active conflict shows three separate concepts: retained current established context, previous disputed context, and new conflicting information. Reopened cards additionally show the previous canonical answer and current reopen reason. Previous attempts and reopen cycles are behind progressive disclosure, including the disputed references recorded in historical conflict rounds. The copied prompt declares the target question, interaction state, Requirement IDs, Source IDs, Need IDs, findings, and—when needed—previous response, migration notice, retained current context, both sides of an active conflict, remaining gaps, prior canonical answer, and reopen reason. The browser serializer consumes these already-derived canonical values from page data and never reimplements the reducer. A first-answer prompt remains equivalent in shape to the prior question/decision/scope flow. Aggregate prompts preserve canonical question order and may mix first-time, follow-up, and Cross entries. Human text, including `NEW_INFORMATION:`, delimiters, multiline Unicode, and HTML-like content, remains data.

The generic `BLOCKED` fallback remains `Additional information — draft` when there are zero open questions. Browser drafts are ephemeral, excluded from the canonical model and fingerprint, and use no storage APIs. The HTML is self-contained, no-network CSP protected, responsive, keyboard accessible, and printable. Project data is escaped into content and attributes only; generated bytes contain no timestamp or random value. Paths are repository-relative POSIX and cannot traverse, enter repository metadata or refinement output, use physical aliases, or expose credentials/real PII.
