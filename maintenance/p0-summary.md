# P0 Current State

- **Integrated post-P0 checkpoint on `main`:** `e114555f94ceeeb76c83ecf7337fa3b19d621feb` (PR #1).
- **P0: CLOSED.** Final acceptance is recorded below; BL-01/BL-02 are ATENDIDO.
- Published checkpoint: `1a6195816b78f50c686b36143460b26f157baed6`.
- Current repository-hygiene checkpoint: `3a40958dac6edc8ff28c76b72170611ee3983e05`;
  no new live full A/B/C is attributed to it.
- G1 PROVEN; G2 PROVEN; G3 PROVEN; G4 PROVEN; G5 PROVEN; G6 PROVEN.
- E2E functional baseline ESTABLISHED; operational benchmark validated.
- **P0 CLOSED — 2026-09-30 (America/Sao_Paulo).** BL-01 and BL-02 ATENDIDO;
  final acceptance is recorded below. P1 starts only when requested.

## Functional baseline

- Reference: `run-20260927034729-712b2b42`, 2026-09-27 03:47–05:02 UTC.
- Profile: `production-v2`.
- Functional source: `sha256:f27aa88249b86e12ae8fb791e7bddc64027e9119b51178deb4dc3f5ec6650c8a`.
- Frozen snapshot: `sha256:756ea114ca305699a95cec0192d7c70c78c3c77dcba6a1a23e4c4b9a5134b93a`.
- Same-revision A/B/C PASS; execution COMPLETE, SPECs CLOSED, finalizers PASS;
  no terminal READINESS. Source and snapshot integrity PASS; ChatGPT/openai
  restricted isolation held. The durable measurement reference lives in
  [`benchmarks/sentinel-todo/baselines/baseline-v1.json`](../benchmarks/sentinel-todo/baselines/baseline-v1.json);
  its protocol is in
  [`benchmarks/sentinel-todo/README.md`](../benchmarks/sentinel-todo/README.md).

## Current architecture decisions

- Execution COMPLETE proceeds directly to SPEC CLOSE.
- The manager carries managed slice identity; the independent runner owns its
  own validation work, with official publishers and validators retaining their
  authority.
- Raw benchmark details stay in ignored, disposable `benchmark-temp/` until
  important measurements are promoted to Git. The benchmark is measurement and
  regression tooling, not requirements, lifecycle, or execution authority.

## Historical residual P0 (before final acceptance)

The following checkpoint assessment is preserved as pre-acceptance history and
superseded by the final acceptance below; it is not the current P0 status.

G2 and G3 remain PARTIAL under their separate criteria. Benchmark Protocol v1
makes them measurable; comparable repeated full runs and an explicit gate
decision remain necessary to prove either gate.

The operational entrypoint is now `npm run benchmark`: one fresh full manager
run, safe preparation, and compact publication of available terminal results,
including BLOCKED. The most recent published observation is available in
[`measurements/latest.md`](../benchmarks/sentinel-todo/measurements/latest.md)
and its faithful
[`latest.json`](../benchmarks/sentinel-todo/measurements/latest.json); per-run
JSON history is retained beside them. The formal campaign remains explicit at
`npm run benchmark:campaign`. At that historical checkpoint, these outputs
supported review of G2/G3 and did not change their then-PARTIAL status or
automatically close P0.

Detailed P0 convergence history remains available in Git history before the
repository-hygiene checkpoint.

## Final acceptance — 2026-09-30

**Decision: P0 CLOSED.** Scope authority: BL-01/BL-02 from the external
`Sentinel_Backlog_Referencia_v1.0.md`, consistent with the criteria reproduced
in the closure request. No new acceptance threshold or gate is introduced.

- **BL-01 — ATENDIDO.** The documented bounded review produced focused fixes
  to validation evidence/ownership, runner verification commands and managed
  evidence serialization (`1a61958`, `b0a01ba`, `04075e0`). Relevant test changes
  and the existing full PASS runs demonstrate proportional verification and
  functional convergence. No current functional or formal blocker is demonstrated;
  resolved findings, recovered model responses and optional improvements do not
  keep the original objective open.
- **BL-02 — ATENDIDO.** Real plans/tasks guided execution with explicit scope,
  decisions, dependencies, observable results and verifiable checks. In the
  latest case A, the plan review clarified valid filter combinations and the
  task review passed without corrections; compact indexes reference local
  checklists rather than copying the entire SPEC. Luna performed execution and
  review/validation, with independent runner checks and successful completion.
  Across the three runs, cases used 1–3 slices with no demonstrated systematic
  fragmentation, concentration or artificially fixed count. Quality, recovery,
  rework and consumption were observed in real slices; no recurring material
  structural rework or unnecessary context is demonstrated.
- **G2 — PROVEN.** Comparable complete runs show zero repeated slice executions
  and zero repeated plan/task reviews. Findings corrections, revalidation and
  occasional invalid-response recovery are visible and completed through the
  official workflow; universal operation-count reduction was not required.
- **G3 — PROVEN.** Attributable main/runner input/output telemetry has full
  coverage in all three runs, including mean, median and peak input per turn.
  This proves observability and reliable evaluation of token/context pressure,
  not token reduction. Main input increased from baseline **42,877,945** to
  **65,236,562**, **52,558,099** and **71,091,730**, respectively. There was no
  formal reduction threshold; material redundant context sufficient to block
  BL-02 has not been demonstrated. Input per turn remains a pressure proxy,
  not measured context-window occupancy or billing.

Acceptance evidence (all full `production-v2`, A/B/C PASS, executions COMPLETE,
SPECs closed, finalizers and final tests PASS, no profile mismatches):

- [`run-20260930004635-bc76d6a3`](../benchmarks/sentinel-todo/measurements/run-20260930004635-bc76d6a3.json).
- [`run-20260930130114-e85e1d4f`](../benchmarks/sentinel-todo/measurements/run-20260930130114-e85e1d4f.json).
- [`run-20260930183513-d0009216`](../benchmarks/sentinel-todo/measurements/run-20260930183513-d0009216.json),
  the latest PASS after the structural corrections, matching `latest.json`.
  It records five APPLY_FINDINGS operations and three repeat validations. Case A
  recovered an invalid findings-cycle response by repeating APPLY_FINDINGS,
  then passed formal validation; these resolved events are non-blocking.

This is the explicit documentary acceptance of existing evidence. The protocol's
earlier PARTIAL/pending-campaign wording describes the pre-decision checkpoint;
no new campaign, run, tests or functional implementation was performed for this
closure. Historical baseline/checkpoint identities remain unchanged.

**Next step: P1 only when requested. Do not start P1 automatically.**
