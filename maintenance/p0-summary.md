# P0 Current State

- Published checkpoint: `1a6195816b78f50c686b36143460b26f157baed6`.
- Current repository-hygiene checkpoint: `3a40958dac6edc8ff28c76b72170611ee3983e05`;
  no new live full A/B/C is attributed to it.
- G1 PROVEN; G2 PARTIAL; G3 PARTIAL; G4 PROVEN; G5 PROVEN; G6 PROVEN.
- E2E functional baseline ESTABLISHED. P0 remains open only for G2 and G3.

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

## Residual P0

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
`npm run benchmark:campaign`. These outputs support review of G2/G3 and do not
change their PARTIAL status or automatically close P0.

Detailed P0 convergence history remains available in Git history before the
repository-hygiene checkpoint.
