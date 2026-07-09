# File Purpose Header

```yaml
purpose: Define question creation, blocking, resolution, and durable conversion.
status: not_applicable
read_when: INIT or RESUME encounters material ambiguity or a gate detects an open question.
do_not_read_when: The SPEC has sufficient signal and no material question exists.
contains: Blocking rules, question shape, resolution options, and closure treatment.
owner: stnl-spec-lifecycle-manager
update_policy: Change when ambiguity or scope policy changes.
```

# Question Policy

Questions are canonical `Q-###` artifacts in `shared/questions.md`. Create one when missing information materially changes behavior, permissions, contracts, data, integrations, security, migration, irreversible architecture, scope, criteria, or risk posture.

Keep the SPEC blocked while a question is open. Do not replace a missing answer with an undocumented assumption.

Use a compact shape:

```yaml
id: Q-001
status: open | resolved | bypassed | dropped
question: <smallest decision required>
why_it_matters: <scope, behavior, or risk impact>
blocks: [AC-001]
resolution: null
resolved_by: user | decision | scope_change | constraint
linked_decision: D-001 | null
```

Resolve, bypass, or drop a question only through an explicit answer, durable decision, constraint, approved scope change, or removal of the affected requirement. CLOSE keeps a resolved question only when its answer has lasting explanatory value.
