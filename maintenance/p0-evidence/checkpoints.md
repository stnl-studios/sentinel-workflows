# P0 Checkpoints

- `c0b2b6afdc2f532a6ebc26e38deef5e2dc7010e1`
  - Operational subagents moved from templates to `agents/`.
- `ab8eb7f65e25c26609412d2611aa7bf95e5da7dd`
  - Runner/scout models aligned.
  - Executor readback corrected.
- `21f6a5834f2cc154bcf21cbec9370c05a63767e9`
  - Candidate shadow isolated in OS temp.
  - Logical workspace preserved.
- `cbe2f9026b207a2c1502a35e836f8f8d95e1f66f`
  - Execution closer and `OPERATION=CLOSE` removed.
  - Terminal guarantees redistributed.
- `82b56e0c4bd5acd444ecfcd47f6409720c8d5488`
  - Legacy `targets/` and `agents/base/` removed.
  - `validate.sh` became the entrypoint.
  - S1 declared ready for candidate freeze.
- `51af7df0d8e1abad319b514cfb548c121e571211`
  - Deterministic artifact-relative implementation-path enforcement.
  - PLAN/TASKS path claims explicitly delimited.
  - Invalid candidates rejected before publication or execution.
  - Safe future targets preserved.
  - P0 evidence history added.
- `e7e5289dcc7f9e9cebf035e5962be989ee1db046`
  - Reusable `sentinel-todo` benchmark with independent A/B/C fixture cases.
  - Production Profile v1 with an external journal and bounded budgets.
  - Raw result collection and before/after comparator.
  - Cheap deterministic integrity tests.
- `577928c5af65df0f61782f3e907a222899eb7557`
  - First Production Pilot attempted on the `e7e5289` benchmark.
  - Case A stopped at lifecycle DRAFT/READINESS.
  - Cases B and C were not executed under the stop-loss rule.
  - The raw blocked result was preserved and P0 remained open.
- `6b193cdd751d7d772d2288709169913f8e8c30e7`
  - Benchmark Correction #1 matured A/B/C into self-contained behavioral
    requirements.
  - `SPEC_READINESS` aligned to `REVIEW_VALIDATE`.
  - The artificial INIT parent retry was removed by preparing an empty
    `specs/` parent.
  - The comparator now blocks incompatible result definitions.
- `abefcb5d7a5d1e0a3a752388f69b74fd3f299648`
  - Production Pilot #2 reached execution `COMPLETE`, GLOBAL READY, lifecycle
    `CLOSED`, and final tests PASS.
  - The Luna Production Profile was proven at runtime with five Luna/medium
    validation runners, zero fallback, and zero Sol escalation.
  - The collector finalized Case A as `BLOCKED`, and a later official terminal
    inspection exposed an ownership inconsistency.
  - Cases B and C stopped under the stop-loss rule; P0 remained open.
- `81e0258295c8e6b57e85d81f083c47f76469fda8`
  - Terminal collector semantics corrected.
  - Recovered `BLOCKED` made historical after effective recovery.
  - Terminal flow aligned to `COMPLETE -> GLOBAL READY -> CLOSE`.
  - Final execution authority delegated to the official runtime.
  - Ownership R1-R5 reproducer passed.
  - No functional Sentinel runtime changed.
- `2f4bf84e45d94e6b2bdb503edcbb2f8927e133de`
  - Production Pilot #3 stopped Case A in documentary readiness.
  - The Pilot #2 ownership inconsistency did not recur.
  - No environment retry or failure was observed in that run.
  - Cases B and C were not run; P0 remained open.
- `eeac1c293147c1e14a50e71e8ac8e7b26d6a5ecd`
  - Benchmark Environment Qualification v1.
  - Doctor passed twice during qualification.
  - Managed TMPDIR and the Luna/medium sandbox probe were qualified.
  - Git, global configuration, and repository bytes were preserved.
  - The environment was frozen as READY.
- `6a7939b2f5b8ffee24223182c61cebf3a16d7236`
  - Case A SPEC Qualification was attempted after deterministic environment
    checks passed.
  - The Luna probe was blocked before session creation by an invalid external
    harness invocation.
  - Terra and Sol were not run, and the P0 ledger remained unchanged.
- `9972a4534cf7c80a9923fd66570a9504a2a3facf`
  - Benchmark Agent Harness v1 centralized external provider invocation.
  - Provider capabilities and the sanitized fingerprint were qualified.
  - The invalid `-a` placement regression was covered deterministically.
  - A one-shot Luna/medium live probe passed through the official harness.
  - Benchmark Environment Qualification v1 remained READY.
  - No Sentinel functional behavior changed.
- `8d9e35d4e3e1d0e6aeab53cd2511ec2d4f639b6d`
  - Case A SPEC Qualification v2: Terra/high READY and Sol/high READY.
  - Both producers preserved 11/11 explicit authorities; no invention was observed.
  - Case A requirements were sufficient; Terra variance was observed.
  - No environment or Agent Harness blocker was observed.
