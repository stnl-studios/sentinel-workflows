# Sentinel Benchmark Results

Persisted benchmark results are engineering evidence. They are not requirements,
runtime, lifecycle, or execution authority and are never read automatically by
Sentinel skills.

Preserve raw result JSON so comparisons can be regenerated. Result files must
not contain chain-of-thought, complete logs, or user-local paths. Actual token
counts may be stored only when the provider or tool exposes real telemetry; they
must never be estimated.

Future results use this convention:

```text
maintenance/benchmark-results/<sentinel-sha>/
  case-a-production-v1.json
  case-b-production-v1.json
  case-c-production-v1.json
```

No synthetic or placeholder result belongs in this directory.

## Production Pilot #4

Candidate `03724a7f646d6d20f57b7cb85ea6358bdf29c999` used
`production-v2`. The canary stopped before B/C authorization, so only the
truthful partial Case A raw exists:

- `03724a7f646d6d20f57b7cb85ea6358bdf29c999/case-a-production-v2.json`
  - status: `BLOCKED`
  - final execution state: `AUXILIARY_BLOCKED`
  - SHA-256: `fa6b421fe4861a497f15f5432acfdb7f3b5d22e5e3c48780398181f6a794a202`

No official production-v2 baseline is established.

## Production Pilot #5

Candidate `1ad5a1b327d1bfbe3c8b2e6c6e987e649ead5f13` used
`production-v2`. Case A reached terminal validation of `slice-02`; official
execution readback rejected terminal integrity because the recorded and current
SHA-256 values for `src/cli.mjs` differed. The collector created a `BLOCKED`
result in the managed Case root, but the driver treated its expected non-zero
blocked exit as a finalization failure and cleaned the root before copying the
raw.

No Pilot #5 raw is persisted. No placeholder or reconstructed raw was created.
Cases B/C and the final reviewer were not run. The official production-v2
baseline remains not established.

## Production Pilot #6

Candidate `a546cfe1ddad925da75af6d46e7722549208342a` used
`production-v2`. Case A stopped in the first `EXECUTE_SLICE` preflight because
the driver supplied normalized `slice-01` where the operation input contract
requires unsigned decimal `1`. No implementation or validation occurred, so
the Pilot #5 terminal-integrity mismatch was not reproduced.

The canonical collector returned its documented non-zero `BLOCKED` exit after
creating the result. The driver parsed and copied the output byte-for-byte
before managed-session cleanup:

- `a546cfe1ddad925da75af6d46e7722549208342a/case-a-production-v2.json`
  - status: `BLOCKED`
  - final execution state: `MATERIALIZED_PRISTINE`
  - SHA-256: `6c2d421fbdc0aa7341a8874fe6e29e8de4fd557dcf739cbcb3f9c537e15e92f8`

Cases B/C and the final reviewer were not run. The official production-v2
baseline remains not established.

## Production Pilot #7

Candidate `6de87f5d3d8f02ee27b8826942481c0529496291` used
`production-v2`. The canonical slice-input rendering preflight passed for
`slice-01`, `slice-02`, and `slice-10`, but Case A stopped earlier during
`PLAN`: candidate validation rejected `plans/slice-02.md` because its resolved
implementation path was the invalid `plans/list`. The rejected planning
candidate was not published and execution remained `EMPTY`.

The canonical collector returned its documented non-zero `BLOCKED` exit after
creating the result. The output was parsed, identity-checked, copied
byte-for-byte, and hashed before managed-session cleanup:

- `6de87f5d3d8f02ee27b8826942481c0529496291/case-a-production-v2.json`
  - status: `BLOCKED`
  - final execution state: `EMPTY`
  - SHA-256: `b6fb0f60a54e06095155fc60b01fef8ef8cabaf53f12ca1b07fb9340fdc80ab3`

No slice operation, Case B, Case C, or reviewer was run. The official
production-v2 baseline remains not established.
