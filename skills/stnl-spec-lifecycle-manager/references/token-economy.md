# File Purpose Header

```yaml
purpose: Explain maintenance rationale and measured runtime budgets without adding lifecycle runtime rules.
status: not_applicable
read_when: Maintaining instruction dependencies, budgets, or measured lifecycle cost.
do_not_read_when: Running INIT, RESUME, READINESS, or CLOSE.
contains: Total-cost rationale, measurement method, and maintenance/runtime separation.
owner: stnl-spec-lifecycle-manager
update_policy: Keep rationale and the machine-checked budget manifest aligned with runtime authorities.
```

# Token Economy

Optimize total cost to a correct stable SPEC: instructions, SPEC evidence, tool calls, correction rounds, rework, and handoffs. Shortening a read that causes an unsupported verdict is a loss. Global semantic authority remains complete even when validator-first removes redundant structural manuals.

`maintenance/runtime-context-budget.json` is the single measured dependency and budget manifest. Its baseline is the pre-change `HEAD`; words use whitespace-separated `wc -w` semantics and bytes use UTF-8 file bytes. No tokenizer was required, so it records no estimated tokens. `scripts/test-runtime-context-budget.py` verifies canonical dependencies, maintenance exclusion, ceilings, and required reductions while printing current measured results.

Runtime authorities are `SKILL.md` and the references named by that manifest. This rationale, maintenance files, implementation details, attestation schema, and extended examples are not runtime dependencies. Runtime text carries only the minimal attestation commands and failure behavior. Structural rules already proved by the validator are diagnostic-only after a failure; deterministic CLOSE rendering stays in code; semantic gates stay in `readiness-gates.md`; material SPEC evidence is never counted as an instruction manual or removed for economy.
