# File Purpose Header

```yaml
purpose: Define the strict persisted decomposition model accepted by the SPEC roadmap runtime.
status: not_applicable
read_when: INIT or RECONCILE authors or diagnoses a candidate roadmap model.
do_not_read_when: Only opening an already generated offline roadmap page.
contains: Schema, stable identity, coverage, overlap, dependency, gap, source, and handoff contracts.
owner: stnl-spec-roadmap
update_policy: Change with runtime validators, renderer, fixtures, evals, launchers, and distribution contracts.
```

# Roadmap Model v1

The candidate file and persisted `roadmap.json` are one UTF-8 JSON object with exactly these top-level fields:

```json
{
  "contract_version": 1,
  "roadmap_id": "RM-CHECKOUT",
  "title": "Checkout roadmap",
  "summary": "Broad intent and decomposition boundary.",
  "sources": [],
  "candidates": [],
  "coverage": [],
  "gaps": []
}
```

Use contiguous monotonic IDs. Existing IDs never disappear or change meaning during `RECONCILE`. Source/need, candidate, coverage, and gap semantic identities are immutable. `retired`, `obsolete`, and `resolved` states are terminal tombstones.

## Sources and needs

A source is `{"id":"SRC-001","kind":"user_stories","label":"Checkout stories","state":"active","path":"docs/stories.md","needs":[{"id":"US-001","title":"Pay by card"}]}`. `kind` is `user_stories|text|documentation|adr|contract|rules|spec|other`. `path` is optional; when present, the runtime reads a single-link file and owns the mutable observation field `snapshot_sha256`. A source path cannot be the roadmap directory or anything below it. Retired sources require `retired_reason`, retain their identity and needs, and retain matching retired coverage.

Need IDs are explicit source identifiers and must be globally unique. Every need has exactly one coverage record.

## Candidates

A candidate has `id`, `title`, `disposition`, `spec_path`, `depends_on`, and `requirements_source`. `disposition` is `active|deferred|obsolete`; non-active entries require `disposition_reason`. `additional_context` is optional. Candidate title and SPEC path are immutable identity; an obsolete candidate becomes an immutable terminal tombstone. Dependencies reference candidate IDs and cannot be missing, duplicated, self-referential, obsolete, or cyclic.

For a changed materialized candidate, add:

```json
"materialized_impact": {
  "summary": "Why the canonical SPEC must be resumed or replanned.",
  "handoff": "MODE=RESUME"
}
```

`handoff` is exactly `MODE=RESUME|OPERATION=REPLAN`.

## Coverage and overlap

A coverage record has `id`, `need_id`, `title`, `state`, `status`, `candidate_ids`, `gap_ids`, and `rationale`. Active status is `covered|deferred|blocked`. Covered needs name at least one candidate. Deferred needs name no candidate and an open `INFO` or `ATTENTION` gap. Blocked needs name an open `BLOCKING` gap. Multiple candidates require `overlap: shared_context|ambiguous_ownership`; ambiguous ownership also requires an open `ATTENTION` or `BLOCKING` gap.

Retired coverage requires `retired_reason`, remains as immutable history, and cannot be reactivated.

## Gaps

A gap has `id`, `title`, `severity`, `state`, `detail`, `impact`, `candidate_ids`, and `coverage_ids`. Severity is `INFO|ATTENTION|BLOCKING`; state is `open|resolved`. A resolved gap requires `resolution`, becomes an immutable terminal tombstone, and is never deleted. References must exist in both directions where a coverage record claims a gap.

## Security and determinism

Use repository-relative POSIX paths and valid UTF-8 text. Repository metadata namespaces such as `.git`, roadmap outputs, and case-folded path aliases are forbidden authority. Do not include credentials, cookies, authorization headers, private keys, access tokens, real PII, timestamps, random identifiers, absolute host paths, HTML behavior, JavaScript, CSS, or remote URLs. The runtime normalizes ordering and source fingerprints before deterministic persistence. `RECONCILE` must carry both inspection fingerprints and publishes only if two complete authority snapshots around hydration/projection and the final locked snapshot agree.
