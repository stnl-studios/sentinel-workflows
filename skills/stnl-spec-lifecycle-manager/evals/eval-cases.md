# File Purpose Header

```yaml
purpose: Index deterministic lifecycle regressions, static policy fixtures, real examples, and model-eval limits.
status: not_applicable
read_when: Changing lifecycle contracts, templates, examples, prompts, parser, or validators.
do_not_read_when: Running an ordinary SPEC lifecycle operation.
contains: Runner command, catalogs, validator and transition coverage, static-contract scope, and model-eval limits.
owner: stnl-spec-lifecycle-manager
update_policy: Keep synchronized with both JSON catalogs, committed validator fixtures, and the executable runner.
```

# Executable Eval Cases

Run:

`python3 scripts/test-spec-lifecycle.py`

The runner consumes `evals/cases.json` for workspace cases and `evals/contract-cases.json` for static policy scenarios. It creates isolated fixtures, invokes the real workspace and transition validators, exercises the safe publisher, checks runtime instruction/adapters, and validates the complete workspaces under `examples/validator-fixtures/`.

Deterministic executable coverage includes:

- active H1, preamble, exact sections/order, shared-file grammar, duplicate authority, and derived indexes;
- `R-*` requirement coverage through `AC.verifies`, formal justification, disconnected ACs, and invalid references;
- blocking, non-blocking, irrelevant, open, and final question shapes;
- INIT destination and allowed-file checks; RESUME feature/record identity, ID preservation, monotonic allocation, gap/reuse/removal/type/title protection, and external boundaries;
- localized and global READINESS snapshot equality plus explicit rejection of the legacy name;
- exact CLOSE authority equality, including invented R/AC/D/C/RK/Q items, changed titles/content, discarded questions, attempted answer incorporation, and external immutability;
- isolated candidate validation, interruption before publish, rollback/no-partial-state behavior, and successful INIT/CLOSE publication;
- prompt-injection-as-data behavior and static Codex/Claude scout boundaries;
- small, medium, large, localized, transversal, global, deterministic-search, scout-eligible, zero-scout, and one-scout-cap policy scenarios without invented token metrics.

`PLANNING` appears only in an explicit negative fixture and CLI rejection check; it is never accepted as a mode or alias. `broken_references` appears only as a calculated validator diagnostic or a negative persistence mutation.

The runner does not invoke Codex or Claude Code as lifecycle models and does not measure model tokens. Static triggering, security, exploration, and token scenarios prove catalog/adapter contract consistency, not real model behavior. A real-model eval may be reported only by an external authenticated run that records the platform, model, observed reads/writes, and actual result.
