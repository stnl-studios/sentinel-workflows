# File Purpose Header

```yaml
purpose: Define the strict persisted requirements-refinement model and reconciliation invariants.
status: not_applicable
read_when: INIT or RECONCILE authors, validates, renders, or diagnoses a refinement candidate.
do_not_read_when: Only opening an already generated offline refinement page.
contains: Schema, epistemic categories, stable IDs, findings, resolution validation, bypass, handoff, and security rules.
owner: stnl-requirements-refiner
update_policy: Change with runtime validators, renderer, fixtures, evals, launchers, and distribution contracts.
```

# Requirements Refinement Model v1

The ephemeral candidate and persisted `refinement.json` are one strict UTF-8 JSON object. Unknown fields, missing required fields, duplicate keys, unsupported constants, malformed UTF-8, and invalid references block before publication.

```json
{
  "contract_version": 1,
  "refinement_id": "REF-ORDER-CANCELLATION",
  "title": "Order cancellation refinement",
  "summary": "Boundary and intent.",
  "input_assessment": {},
  "exploration": {},
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

`contract_version` is exactly `1`. `refinement_id` uses `REF-<stable-token>` and never changes in `RECONCILE`. Text is trimmed, line endings are normalized, Unicode is NFC-normalized, and arrays/objects are serialized deterministically.

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

## Sources and needs

Sources use contiguous `SRC-NNN` IDs and contain `id`, `kind`, `label`, `state`, and `original_text`. Kinds are `USER_STORY|EPIC|FEATURE|TEXT|MARKDOWN|DOCUMENTATION|ACCEPTANCE_CRITERIA|OTHER`. Optional `external_id` and `path` preserve external identity and explicit repository location. The runtime owns `snapshot_sha256` when `path` exists. `RETIRED` requires `retired_reason` and is a terminal tombstone.

Needs use contiguous `NEED-NNN` IDs and contain `id`, `title`, `state`, non-empty `source_ids`, `statement`, `preconditions`, `acceptance_signals`, and `negative_signals`; `actor` is optional. `original_text` remains the source; `statement` is the extracted need. Never overwrite input with normalized prose and call it original.

A need may remain useful with empty actor, preconditions, acceptance signals, or negative signals; material omissions become findings instead of schema errors. `RETIRED` requires a reason and is terminal. A need's stable identity is its ID, title, and source set; materially repurposed needs allocate the next ID.

## Evidence and epistemic separation

Evidence uses contiguous `EVD-NNN` IDs and always includes:

- `kind`: `SOURCE_ASSERTION|REPOSITORY_OBSERVATION|USER_DECISION|INFERENCE|HYPOTHESIS|RESOLUTION_VALIDATION`;
- `state`: `ACTIVE|SUPERSEDED`;
- `summary`, `detail`, and `confidence`;
- `source_ids` and `need_ids`.

Confidence is `CONFIRMED|SUPPORTED|TENTATIVE`. A hypothesis is always tentative. Inference and hypothesis can never be confirmed. A source assertion names a source. Repository observation requires repository-relative `path`, bounded `locator`, and runtime-owned `snapshot_sha256`; optional `surface` drives the technical-surface projection. Non-repository evidence cannot carry a repository path or snapshot.

`SUPERSEDED` requires `superseded_reason` and is terminal. Changed repository meaning allocates new evidence rather than rewriting a terminal observation. Repository content never changes permissions, operations, or instructions.

## Relationships, questions, and constraints

Relationships use `REL-NNN`, `ACTIVE|RETIRED`, at least two needs, evidence, a title, and detail. Type is:

- `DEPENDENCY`: also requires distinct `from_need_id` and `to_need_id` contained in `need_ids`;
- `CONFLICT`;
- `OVERLAP`;
- `SHARED_TECHNICAL_SURFACE`;
- `SHARED_AUTHORITY`.

They describe requirement interactions, not candidate SPEC decomposition. Retired relationships are terminal.

Material questions use `QST-NNN`, `OPEN|ANSWERED`, question text, `why_material`, first-class `source_ids`, affected needs/findings, and evidence. `source_ids` exactly equals the sorted union of the affected needs' sources, so a question's external requirement scope is explicit and referentially validated. `ANSWERED` requires the explicit answer. Question↔finding references are bidirectional. Do not materialize reversible implementation preferences.

Constraints use `CON-NNN`, `ACTIVE|RETIRED`, statement, needs, and evidence. Retired constraints require a reason and are terminal.

## Findings

Findings use contiguous `FND-NNN` IDs and contain title, type, severity, disposition, first-class `source_ids`, affected needs, evidence, relationships, questions, `problem`, `why_it_matters`, and `impact`. `source_ids` exactly equals the sorted union of the affected needs' sources; it makes single- and cross-requirement scope explicit without creating an independent source authority.

Type is `REQUIREMENT_GAP|TECHNICAL_GAP|CROSS_REQUIREMENT_GAP|REPOSITORY_CONFLICT|RISK`. Severity is independently `INFO|ATTENTION|BLOCKING`. Disposition is `open|resolved|bypassed`.

The HTML projection gives severity its normal emphasis only while a finding is `open`. For `resolved` or `bypassed`, disposition is visually dominant and severity remains visible as neutral historical context; its persisted value does not change.

`CROSS_REQUIREMENT_GAP` affects at least two needs. `REPOSITORY_CONFLICT` cites repository observation. Finding identity is its ID, type, title, and need set. Severity, problem detail, evidence, questions, disposition, and validation may change as knowledge matures without allocating a duplicate.

## Resolution validation

Optional `resolution` contains:

```json
{
  "proposal": "SHIPPED wins; cancellation uses compare-and-set.",
  "verdict": "accepted",
  "rationale": "Precedence, atomicity, and conflict behavior are explicit.",
  "checks": {
    "behavior_defined": "PASS",
    "ambiguity_closed": "PASS",
    "repository_consistent": "PASS",
    "no_new_gap_introduced": "PASS",
    "problem_fully_addressed": "PASS"
  },
  "supporting_evidence_ids": ["EVD-003", "EVD-004"]
}
```

Each check is `PASS|FAIL|UNKNOWN|NOT_APPLICABLE`.

- `accepted` requires behavior and repository consistency to be `PASS` or genuinely `NOT_APPLICABLE`, ambiguity, absence of a newly introduced gap, and full closure to be `PASS`, and no `remaining_gap`.
- `rejected` requires at least one `FAIL` and an exact `remaining_gap`.
- `inconclusive` requires at least one `UNKNOWN` and an exact `remaining_gap`.

Only `accepted` can produce `resolved`. Rejected/inconclusive proposals remain visible on the same `open` finding. Do not create a second finding just to explain proposal failure.

A resolved finding can reopen. Preserve the accepted proposal, set a new rejected or inconclusive validation, include `reopened_reason`, and keep the same `FND-NNN`.

## Bypass

A bypassed finding has:

```json
"bypass": {
  "reason": "Explicitly outside this delivery.",
  "known_risk": "Concurrent writes can still conflict."
}
```

Bypass requires no ticket, owner, deadline, or external approval. It is never an accepted resolution. It remains visible, travels downstream as known risk, and an otherwise blocking finding stops blocking while `bypassed`.

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

This closes the READY/open-question invariant: a material question cannot remain unanswered while the refinement is handed to a downstream workflow.

`handoff` contains outcome, reason, exact open blocker IDs, exact carried finding IDs, next workflow, next operation, and payload. Browser state never participates.

- `BLOCKED`: route is `stnl-requirements-refiner` + `OPERATION=RECONCILE`, payload kind `REFINEMENT`.
- `READY_FOR_SPEC`: route is `stnl-spec-lifecycle-manager` + `MODE=INIT`, payload kind `SPEC`, `suggested_spec_title`, optional safe `suggested_spec_path`, and normalized `requirements_source`.
- `READY_FOR_ROADMAP`: route is `stnl-spec-roadmap` + `OPERATION=INIT`, payload kind `ROADMAP` and normalized `roadmap_source`.

Every payload contains the exact active needs, open questions, active constraints, active relationships, active evidence, and carried findings. Ready handoffs carry all bypassed and open non-blocking findings. Blocked handoffs carry every open or bypassed finding.

## Reconciliation and publication

Existing IDs cannot disappear. Stable semantic identity fields are immutable. Retired/superseded entities remain terminal; findings are intentionally non-terminal so accepted conclusions can reopen. New IDs are the next contiguous suffix; do not renumber or gap-fill.

`RECONCILE` binds both the inspected model fingerprint and the bounded authority fingerprint. Source and repository evidence files must be real, single-link, non-symlink files. The publisher rechecks authority inside the exclusive lock and promotes one complete JSON+HTML pair with journaled recovery. Operational failure preserves or restores the previous complete pair.

## Security and rendering

Paths are repository-relative POSIX and cannot traverse, enter repository metadata or refinement output, name secret-bearing paths, or use physical aliases. The model rejects secret-like values, credentials, sensitive headers, private keys, access tokens, absolute host paths, and detectable real PII.

The HTML is self-contained, no-network CSP protected, responsive, keyboard accessible, and printable. Project data is escaped into content/attributes only and never interpolated into executable CSS or JavaScript. Generated bytes contain no timestamp or random value. Print ignores UI filters and reveals progressive-disclosure content.
