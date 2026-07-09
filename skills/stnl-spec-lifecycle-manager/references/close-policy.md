# File Purpose Header

```yaml
purpose: Define how CLOSE compacts a modular workspace into a clean final feature_spec.md.
load_when: MODE is CLOSE or the user asks to finalize/clean the spec.
do_not_load_when: Creating, executing, or replanning active slices.
contains: Closure gates, durable content rules, operational removal rules, final structure, and blockers.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when final artifact rules change.
```

# CLOSE Policy

`CLOSE` transforms the modular operational workspace into a clean final `feature_spec.md`.

## Core Rule

The final feature folder contains exactly one file:

```text
specs/<feature-slug>/
└── feature_spec.md
```

Remove `shared/`, `slices/`, and `lifecycle/` only after durable content has been safely consolidated. No archive, changelog, execution log, close-input file, or secondary artifact is produced by default.

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

- operational slice files;
- detailed slice execution history;
- failed attempts;
- agent logs;
- intermediate plans;
- lifecycle traceability;
- QA checklist details;
- resume notes;
- context-loading hints;
- unresolved operational TODOs;
- resolved questions without durable value;
- planning notes;
- speculative comments;
- internal debate or discarded approaches.

## Slices in Final Spec

Do not keep detailed slice history.

A slice may influence the final spec only if it produced durable knowledge, such as:

- a business rule;
- an acceptance criterion;
- a durable decision;
- a constraint;
- a risk;
- an essential technical note.

Do not preserve a list of completed slices merely as history.

## Questions in Final Spec

No open questions may remain in a closed spec.

Do not keep resolved questions unless the answer is important long-term context. If important, convert the resolution into a business rule, decision, constraint, or technical note.

## Closure Blockers

Block `CLOSE` when:

- open questions remain;
- final acceptance criteria are not stable;
- closure would hide unresolved ambiguity;
- invalid canonical IDs remain in sections that must be preserved;
- durable content has not been consolidated safely;
- removing operational directories would lose important business or technical context.

## Final Header

The final file header should mark the spec as closed:

```yaml
purpose: Final feature specification for <feature>.
status: closed
read_when: Maintaining, extending, validating, or revisiting this feature.
do_not_read_when: Looking for historical execution logs; those are intentionally not preserved.
contains: Durable objective, final scope, acceptance criteria, decisions, constraints, risks, and essential notes.
owner: stnl-spec-lifecycle-manager
update_policy: Update only through an explicit future spec lifecycle action.
```

## Style

The final spec should be concise, factual, and durable. Prefer stable product and technical facts over narrative history.
