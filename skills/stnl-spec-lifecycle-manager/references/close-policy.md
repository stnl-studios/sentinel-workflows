# File Purpose Header

```yaml
purpose: Define lossless documentary closure and protected external boundaries.
status: not_applicable
read_when: MODE is CLOSE or final one-file consolidation is requested.
do_not_read_when: The SPEC remains active or any documentary blocker is unresolved.
contains: Preconditions, durable preservation, safe order, removal rule, and final validation.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when documentary closure or preservation policy changes.
```

# CLOSE Policy

CLOSE validates the document, never its implementation. It requires no open question, active `blocked_by`, broken internal reference, material conflict, or blocking documentary gap. Active criteria must have already passed semantic observability review during lifecycle work; the structural parser does not infer observability from keyword lists. Question states permitted at closure are exactly `resolved`, `bypassed`, and `dropped`.

## Durable final content

Consolidate Objective; Context; Final Scope; Out of Scope; Requirements; Business Rules; Final Acceptance Criteria; Durable Decisions; Relevant Constraints; Relevant Risks; Important Contracts; and Durable Resolved Questions when relevant.

Preserve canonical IDs and meaningful structural references. Preserve AC prose; every decision's `Contexto`, `Decisão`, and `Impacto`; every relevant constraint's `Restrição` and `Razão`; every relevant risk's `Risco`, `impact`, and `Mitigação`; and final questions that explain durable decisions or boundaries. Do not preserve active blocker metadata as history: final ACs have no `blocked_by`, and final questions have no `blocks`. Use `linked_decision`, `references`, and resolution narrative for durable provenance. Do not flatten these structures into one string or delete information merely to shorten the file.

Low-value resolved question history may be omitted only after its answer is durably incorporated elsewhere without information loss. Never retain session logs, internal reasoning, command output, operational records, diffs, tests, commits, or implementation evidence as requirements content.

## Safe order

1. Validate every readiness and closure gate.
2. Build the complete final `feature_spec.md` while `shared/` still exists.
3. Compare source and consolidation to verify durable structural and narrative preservation.
4. Only after that check passes, remove `shared/`.
5. Validate the final one-file structure.
6. Confirm every external directory is unchanged.

Never remove `shared/` before the consolidation is validated.

## External boundary

CLOSE must not alter, remove, or move `execution/` or any other directory not owned by the documentary lifecycle. It must not use code, tests, tasks, commits, diffs, or delivery state as a closure gate. External contents may be compared for preservation but are not documentary input.
