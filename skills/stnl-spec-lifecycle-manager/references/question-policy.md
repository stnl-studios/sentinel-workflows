# File Purpose Header

```yaml
purpose: Define question creation, global and criterion blocking, resolution, and durable retention.
status: not_applicable
read_when: INIT or RESUME finds material ambiguity, or a readiness gate evaluates questions.
do_not_read_when: The SPEC has sufficient signal and no material question exists.
contains: Question states, blocks semantics, resolution provenance, inverse links, and closure treatment.
owner: stnl-spec-lifecycle-manager
update_policy: Change when ambiguity, relationship, scope-change, or resolution policy changes.
```

# Question Policy

Create a canonical `Q-*` item when missing information materially changes behavior, permissions, contracts, data, integrations, security, irreversible architecture, scope, criteria, or risk posture. Never replace a missing answer with an undocumented assumption.

Every `open` question blocks readiness and must carry `blocks`. `blocks: []` is a global documentary blocker, not the absence of blocking. When `blocks` names criteria, every target active AC must list the question in `blocked_by`, and every `blocked_by` entry must have the inverse open-question link.

Questions use the Markdown schema in `spec-schema.md`. Final states are precise:

- `resolved`: an explicit answer is recorded in `Resolução`.
- `bypassed`: `Resolução` explicitly explains why proceeding without an answer is acceptable.
- `dropped`: `Resolução` explicitly records the scope change or requirement removal; use `resolved_by: scope_change`.

Use `resolved_by` only for final states, with `answer`, `decision`, `constraint`, or `scope_change`. When the resolution creates or depends on a durable decision, use `resolved_by: decision` plus an existing `linked_decision: D-*`. Do not write non-applicable fields as `null`.

Final questions (`resolved`, `bypassed`, or `dropped`) do not carry `blocks`. ACs formerly affected by the question must remove `blocked_by`; preserve history through `linked_decision`, `references`, or the `Resolução` narrative. `bypassed` requires an explicit justification in `Resolução`; `dropped` requires an explicit scope change or requirement removal.

The File Purpose Header of `shared/questions.md` is `blocked` whenever any question is open and `ready` otherwise. The feature header must also be `blocked` while any question is open, and its `open_questions` list must exactly match the open headings.

CLOSE permits only `resolved`, `bypassed`, and `dropped`, with no active `blocks` or `blocked_by`. Preserve a final question when it explains a durable decision or boundary; low-value answers already incorporated without loss into durable content need not remain as question history.
