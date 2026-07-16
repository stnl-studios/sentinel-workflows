# File Purpose Header

```yaml
purpose: Explain maintenance rationale for total-token economy without adding runtime rules.
status: not_applicable
read_when: Maintaining instruction structure, evaluating duplication, or interpreting measured lifecycle cost.
do_not_read_when: Running an ordinary INIT, RESUME, READINESS, or CLOSE operation.
contains: Total-cost rationale and the reasons behind progressive disclosure and bounded exploration.
owner: stnl-spec-lifecycle-manager
update_policy: Keep rationale aligned with runtime authorities; do not duplicate their procedures here.
```

# Token Economy

The optimization target is total cost to a correct, stable SPEC, not the tokens in one call. Relevant cost includes loaded instructions, files read, tool calls, output, correction rounds, rework, principal-model use, and any scout handoff. Shortening a read that causes an unsupported conclusion or another round is a loss.

The runtime contracts express that tradeoff through one authority per rule, progressive disclosure by mode, proportional evidence, compact outputs, minimal materialization, deterministic validation before publication, and bounded repository exploration. Local work avoids unrelated categories; global readiness and closure deliberately pay for complete material authority. The optional single scout can isolate a difficult search without creating fan-out or contaminating the principal context with broad raw reads.

Measure actual input, output, tools, files, rounds, rework, and tokens when the platform exposes them. Never invent savings or model-eval numbers. Operational authority remains in `SKILL.md`, `modes.md`, `spec-workspace.md`, `spec-schema.md`, `readiness-gates.md`, and `close-policy.md`; ordinary lifecycle runs do not load this rationale.
