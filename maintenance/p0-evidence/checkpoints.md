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
- `03724a7f646d6d20f57b7cb85ea6358bdf29c999`
  - Production Profile v2 published with Case A SPEC on Sol/high.
  - All other A/B/C model and effort assignments were preserved.
  - Profile regression checks passed.
  - No Production Pilot was executed in that checkpoint.
- `29b4d6f1979d8d2590260b4888cf15b696631961`
  - Production Pilot #4 stopped Case A in `AUXILIARY_BLOCKED` after three
    state-authorized `EXECUTE_SLICE` attempts for `slice-01`.
  - Cases B and C were not run because the canary gate failed.
  - A truthful partial production-v2 raw was preserved; no baseline or P0 gate
    was promoted.
  - The single final reviewer invocation failed before session creation and was
    not retried.
- `5d9ecc9b4aa143519948f020ab771f257d0186b0`
  - Validation-runner authority verification was aligned to the official
    canonical execution authority.
  - Pre-Pilot Rehearsal v1 passed R01–R06.
  - Live R07 started its child but classified the child result as malformed.
  - The rehearsal stopped BLOCKED; no Production Pilot was executed.
- `bfe0a190993d48428acaaa827b84a6db2e4124b1`
  - R07 forensic identified an abbreviated official-preflight command as the
    exact malformed field value.
  - Runner contract v8 now requires complete commands and has focused
    regression coverage for the observed ellipsis abbreviation.
  - Isolated R07 advanced to a valid runner PASS but terminal publication was
    blocked by an invalid path basis in the deterministic POST-R06 fixture.
  - Full R01–R13 rehearsal was not authorized; no Production Pilot was run.
- `f3aea3598620a4f9d214ab3df44e0f935e058168`
  - The rehearsal fixture now derives implementation paths from each final
    artifact directory and rejects invalid file-backed paths before live R07.
  - The observed `workspaces/r07-isolated` path regression is covered without
    weakening terminal ownership, containment, existence, or hash checks.
  - Isolated R07 reached `COMPLETE`; the fresh full rehearsal passed R01–R10.
  - R11 repeated the historical pre-session reviewer initialization failure,
    so R12/R13 were not run and no Production Pilot was authorized.
- `b1fb9e182c15a2442aba09872cf11f3e6d49dd13`
  - Reviewer and B/C smoke workspaces are initialized as isolated local Git
    repositories and rejected before model launch when Git is not ready.
  - The Git-geometry hypothesis was confirmed; isolated R11 and isolated R12
    both passed with zero retry and independent cleanup.
  - A fresh full rehearsal passed R01-R06, then the pre-live R07 gate rejected
    task-relative `src/invitation.mjs` claims emitted by the real EXECUTE turn.
  - R07 started zero validation calls; R08-R13 and Production Pilot were not
    run, and no second remediation was attempted.
- `1ad5a1b327d1bfbe3c8b2e6c6e987e649ead5f13`
  - File-backed execution records now derive task-relative paths from the final
    task artifact and reject wrong basis, physical identity, or hash before
    candidate publication.
  - Delegated validation preserves canonical `SPEC_PATH`; execution producers
    preserve the exact canonical preflight authority.
  - The critical fixture covers the complete expired-invitation contract.
  - The fresh rehearsal passed R01-R13, including independent review, parallel
    B/C isolation, and all required deterministic checks; no Pilot was run.
- `a546cfe1ddad925da75af6d46e7722549208342a`
  - Production Pilot #5 passed all checkpoint preconditions and historical
    integrity checks against `1ad5a1b` with `production-v2`.
  - Case A reached the terminal validation of `slice-02`, where official
    readback rejected drift in `src/cli.mjs`; B/C were not authorized.
  - The collector created a `BLOCKED` raw in the ephemeral Case root, but the
    driver failed to preserve it before cleanup, so finalization blocked.
  - No baseline or P0 gate was promoted; P0 remains open.
- `6de87f5d3d8f02ee27b8826942481c0529496291`
  - Production Pilot #6 passed the frozen-candidate, functional-equivalence,
    environment, Harness, and deterministic preconditions.
  - Case A stopped at the first executor preflight because the driver supplied
    `slice-01` instead of the contracted unsigned decimal `1`.
  - The collector's canonical `BLOCKED` raw was copied byte-for-byte and hashed
    before managed-session cleanup, proving durable non-PASS finalization.
  - The Pilot #5 terminal-integrity mismatch boundary was not reached; B/C and
    the reviewer were not run, no baseline or gate was promoted, and P0 remains
    open.
- `pending user commit`
  - Production Pilot #7 passed the frozen-candidate, functional-equivalence,
    environment, Harness, historical-integrity, and slice-rendering
    preconditions.
  - Case A stopped during PLAN candidate validation on invalid resolved path
    `plans/list`; the rejected plan was not published and no slice operation
    started.
  - The collector's canonical `BLOCKED` raw was copied byte-for-byte and hashed
    before managed-session cleanup.
  - The terminal-integrity boundary was not reached; B/C and the reviewer were
    not run, no baseline or gate was promoted, and P0 remains open.
