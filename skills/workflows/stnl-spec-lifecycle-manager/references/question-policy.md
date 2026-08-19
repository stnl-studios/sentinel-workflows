# File Purpose Header

```yaml
purpose: Define question relevance, blocking classification, resolution provenance, and deterministic retention.
status: not_applicable
read_when: INIT or RESUME finds material ambiguity, or a readiness gate evaluates questions.
do_not_read_when: The SPEC has sufficient signal and no material question exists.
contains: Blocking, non-blocking, and irrelevant classification; links; resolution; and closure retention.
owner: stnl-spec-lifecycle-manager
update_policy: Change when ambiguity, relationship, scope-change, or resolution policy changes.
```

# Question Policy

Classify a potential question before materializing it. Keep facts, hypotheses, and decisions distinct; never replace a missing answer with an assumption.

1. `blocking`: the answer can change scope, observable behavior, an external contract, security, relevant compatibility, a difficult or expensive-to-reverse decision, or the ability to verify acceptance. Persist as `classification: blocking`.
2. `non_blocking`: the question is relevant documentary follow-up, but no possible answer can change readiness or acceptance. Persist only with an explicit explanation in `Por que importa` of why deferral is safe.
3. `irrelevant`: the matter belongs to reversible technical convention, execution planning, implementation preference, already-proven information, or a detail with no acceptance effect. Do not create a new Q. If RESUME reclassifies an existing question as irrelevant, finalize it as `status: dropped`, `classification: irrelevant`, and record why it is outside the SPEC.

An open `blocking` question must carry `blocks`. `blocks: []` means a global documentary blocker; it never means non-blocking. When `blocks` names criteria, every target active AC lists the question in `blocked_by`, and every `blocked_by` entry has the inverse link. An open `non_blocking` question omits `blocks` and has no inverse `blocked_by`. An `irrelevant` question cannot remain open.

Questions use the Markdown schema in `spec-schema.md`. Final states are precise:

- `resolved`: an explicit answer is recorded in `Resolução`.
- `bypassed`: `Resolução` explicitly explains why proceeding without an answer is acceptable.
- `dropped`: `Resolução` explicitly records the scope change, requirement removal, or determination that the matter is outside this SPEC; use `resolved_by: scope_change`.

Use `resolved_by` only for final states, with `answer`, `decision`, `constraint`, or `scope_change`. When the resolution creates or depends on a durable decision, use `resolved_by: decision` plus an existing `linked_decision: D-*`. Do not write non-applicable fields as `null`.

Final questions (`resolved`, `bypassed`, or `dropped`) retain `classification` but do not carry `blocks`. ACs formerly affected by the question remove `blocked_by`; preserve provenance through `linked_decision`, `references`, or the `Resolução` narrative. `bypassed` requires an explicit justification; `dropped` requires an explicit scope change, requirement removal, or irrelevant-to-SPEC determination.

The File Purpose Header of `shared/questions.md` is `blocked` when any open question is classified `blocking`, and `ready` otherwise. The feature header is `blocked` while a blocking question is open. The feature's derived `blocking_questions` list exactly matches open blocking Q headings; readiness must still read the canonical questions, not trust the index alone.

CLOSE permits only `resolved`, `bypassed`, and `dropped`, with no active `blocks` or `blocked_by`. Preserve every final Q record exactly in the closed document; do not infer that its answer was incorporated elsewhere and discard it.
