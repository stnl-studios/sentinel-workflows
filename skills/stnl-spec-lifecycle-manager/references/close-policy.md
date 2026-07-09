# File Purpose Header

```yaml
purpose: Define documentary closure and durable one-file consolidation.
status: not_applicable
read_when: MODE is CLOSE or final documentary consolidation is requested.
do_not_read_when: The SPEC remains active or documentary blockers are unresolved.
contains: Closure checks, blockers, durable content, removal rules, and final structure.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when final artifact policy changes.
```

# CLOSE Policy

CLOSE validates the document, not the implementation of the document. Confirm stable IDs, resolved blocking questions, valid references, clear scope, verifiable criteria, consistent decisions, relevant constraints and risks, and absence of contradictory or duplicated material.

Block closure when a question remains blocking, an ID reference is invalid, essential scope or criteria are unclear, material artifacts conflict, or consolidation would lose durable content.

On success, incorporate durable material into one `feature_spec.md`, then remove `shared/`. Leave any external or execution directory untouched because it is not a lifecycle artifact. Retain the objective, necessary context, scope, out of scope, requirements, business rules, final criteria, durable decisions, relevant constraints, relevant risks, important contracts, and resolved questions that still explain a durable choice.

Do not retain low-value resolved questions, session history, working notes, logs, internal reasoning, operational planning, task records, diffs, test results, command output, or implementation evidence.
