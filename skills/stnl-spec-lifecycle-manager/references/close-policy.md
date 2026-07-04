# File Purpose Header

```yaml
purpose: Define how CLOSE creates a clean final feature_spec.md.
load_when: MODE is CLOSE or the user asks to finalize/clean the spec.
do_not_load_when: Creating, executing, or replanning active slices.
contains: Closure rules, what to keep, what to remove, final file structure, and blocking conditions.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when final artifact rules change.
```

# CLOSE Policy

`CLOSE` transforms the living spec into a clean final `feature_spec.md`.

## Core rule

The final output is exactly one file:

```text
feature_spec.md
```

No archive, changelog, execution log, or secondary file is produced unless the user explicitly asks outside this skill's default contract.

## Keep

Keep only information that is durable and useful for future maintenance:

- objective;
- final scope;
- out of scope;
- business rules;
- final acceptance criteria;
- durable decisions;
- relevant constraints;
- relevant risks;
- essential technical notes;
- compatibility or migration notes when important;
- API, data, permission, or integration contracts when important.

## Remove

Remove:

- slice execution history;
- failed attempts;
- agent logs;
- intermediate plans;
- unresolved operational TODOs;
- resolved questions without durable value;
- verbose QA checklist details;
- traceability matrix if it no longer helps maintenance;
- planning notes;
- context-loading hints;
- speculative comments;
- internal debate or discarded approaches.

## Slices in final spec

Do not keep detailed slice history.

A slice may influence the final spec only if it produced durable knowledge, such as:

- a business rule;
- an acceptance criterion;
- a durable decision;
- a constraint;
- a risk;
- an essential technical note.

Do not preserve a list of completed slices merely as history.

## Questions in final spec

Do not keep resolved questions unless the answer is important long-term context. If important, convert the resolution into a business rule, decision, constraint, or technical note.

No open questions may remain in a closed spec.

## Closure blockers

Block `CLOSE` when:

- open questions remain;
- final acceptance criteria are not stable;
- closure would hide unresolved ambiguity;
- invalid canonical IDs remain in sections that must be preserved;
- the spec still contains obvious execution history that cannot be safely separated from durable content.

## Final header

The final file header should mark the spec as closed:

```yaml
purpose: Final feature specification for <feature>.
status: closed
mode_last_updated: CLOSE
read_when: Maintaining, extending, validating, or revisiting this feature.
do_not_read_when: Looking for historical execution logs; those are intentionally not preserved.
```

## Style

The final spec should be concise, factual, and durable. Prefer stable product and technical facts over narrative history.
