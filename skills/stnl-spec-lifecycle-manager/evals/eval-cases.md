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

From the Sentinel Workflows repository root, run:

- `node --test scripts/test-lifecycle-contracts.mjs`
- `node --test skills/stnl-spec-lifecycle-manager/runtime/test/core.test.mjs skills/stnl-spec-lifecycle-manager/runtime/test/lifecycle.test.mjs skills/stnl-spec-lifecycle-manager/runtime/test/readiness.test.mjs skills/stnl-spec-lifecycle-manager/runtime/test/closed-spec.test.mjs skills/stnl-spec-lifecycle-manager/runtime/test/publisher.test.mjs`
- `node --test scripts/test-lifecycle-validator-adversarial.mjs scripts/test-lifecycle-readiness-adversarial.mjs scripts/test-lifecycle-renderer-adversarial.mjs`
- `node --test scripts/test-lifecycle-distribution.mjs`
- `node --test scripts/test-runtime-context-budget.mjs`
- `node --test scripts/test-subagent-packages.mjs`
- `bash scripts/test-validation-runner-contract.sh`
- `bash scripts/test-launcher-contract.sh`

`scripts/test-lifecycle-contracts.mjs` consumes `evals/cases.json` for workspace cases and `evals/contract-cases.json` for static policy scenarios. It creates isolated fixtures, invokes the real workspace and transition validators, and validates the complete workspaces under `examples/validator-fixtures/`. The embedded runtime suite exercises readiness, deterministic closure, the transactional publisher, concurrency, rollback, and interruption recovery. The adversarial suites preserve the full negative regression matrix for validator authority, attestations, aliases, filesystem races, rendering, and no-mutation failures. The remaining suites prove isolated distribution, instruction budgets, and platform-subagent packages.

Deterministic executable coverage includes:

- active H1, preamble, exact sections/order, shared-file grammar, duplicate authority, and derived indexes;
- `R-*` requirement coverage through `AC.verifies`, formal justification, disconnected ACs, and invalid references;
- blocking, non-blocking, irrelevant, open, and final question shapes;
- INIT destination and allowed-file checks; RESUME feature/record identity, physical-removal prohibition, retired tombstones/reasons, monotonic allocation, gap/reuse/type/title protection, and external boundaries;
- `LOCAL` and `GLOBAL` READINESS snapshot equality, canonical case-sensitive values, and explicit rejection of lowercase and former aliases;
- exact CLOSE authority equality, including retired tombstones, invented or changed items, discarded questions, attempted answer incorporation, and external immutability;
- strict `GLOBAL/READY` readiness attestations at renderer and publisher, stale/mismatched snapshot rejection, exact deterministic CLOSE feature bytes, rejected OS metadata, isolated candidate validation, post-rename source verification, rollback/conflict recovery, and successful publication;
- prompt-injection-as-data behavior and static Codex/Claude scout boundaries;
- small, medium, large, focused, transversal, all-authority, deterministic-search, scout-eligible, zero-scout, and contractual one-call policy scenarios without invented token metrics;
- explicit negative controls for READINESS scope aliases and scout question/root/survey expansion.

`PLANNING` and the removed boolean CLOSE argument appear only in explicit rejection controls. `broken_references` appears only as a calculated validator diagnostic or a negative persistence mutation. Publisher locks are persistent sibling runtime metadata and are excluded from readiness, rendering, and authority snapshots.

The runner does not invoke Codex or Claude Code as lifecycle models and does not measure model tokens. Static triggering, security, exploration, and token scenarios prove catalog/adapter contract consistency, not real model behavior. A real-model eval may be reported only by an external authenticated run that records the platform, model, observed reads/writes, and actual result.
