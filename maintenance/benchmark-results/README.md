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

## Production Pilot #8

Candidate `0be86e69801f51ae32612275bb31f8823b52a5bf` used
`production-v2`. The Sol/high Case A `SPEC_INIT` turn published lifecycle
status `ready`, and official execution readback derived `EMPTY` with legal
handoff `PLAN`. The external measurement driver misread the canonical fenced
YAML status field, recorded the event as `BLOCKED`, and terminalized the Case
before PLAN. The zero-rerun stop policy was honored.

Canonical finalization created the recorded `BLOCKED` raw. It was parsed,
identity-checked, copied byte-for-byte, and hashed before managed-session
cleanup:

- `0be86e69801f51ae32612275bb31f8823b52a5bf/case-a-production-v2.json`
  - status: `BLOCKED`
  - final execution state: `EMPTY`
  - SHA-256: `31ba5fb8de3bfcb32235b72d54c9e293a72fab0bbefdf11566ab83633b631b9c`

Cases B/C and the final reviewer were not run. The official production-v2
baseline remains not established.

## Production Pilot #9

Candidate `22e2cc7950de01353a0099f5917ede4b76fd2025` used
`production-v2`. All frozen-candidate and deterministic repository checks
passed, but the mandatory one-shot GPT-5.6-Luna/medium sandbox probe blocked:
the Harness completed one turn with retry `0`, its only command exited `2`, and
the model returned `PROBE_BLOCKED`.

The probe was not repeated. Pilot Case A, Cases B/C, and the final reviewer
were not run, so no Pilot #9 raw or candidate result directory was created. The
official production-v2 baseline remains not established.

## Production Pilot #10

Candidate `b434bad628bf5050f2c8df94426bb47238ba374e` used the versioned Pilot
driver (`productionPilotDriverVersion=1`) with `production-v2`. Preconditions
passed. Case A stopped on its second `EXECUTE_SLICE` when official readback
reported `AUXILIARY_BLOCKED` for `slice-02`; the runner recorded blocker
`OFFICIAL_AUXILIARY_BLOCKED`, zero retry, and cleanup `PASS`.

The canonical raw produced by the driver was preserved byte-for-byte:

- `b434bad628bf5050f2c8df94426bb47238ba374e/case-a-production-v2.json`
  - status: `BLOCKED`
  - final execution state: `AUXILIARY_BLOCKED`
  - SHA-256: `619cf604d81f4d5731d6170f8ac2e5b19c3094829a6abecc1cbd8cb0668a2201`

Cases B/C were not run. No placeholders were created. The official
production-v2 baseline remains not established.

## Production Pilot #11

Candidate `19b7cde141252f49cce0dde3aef4723a9185830e` used the versioned Pilot
driver (`productionPilotDriverVersion=2`) with `production-v2`. Preconditions
passed. Case A stopped after the `PLAN` operation when official readback
reported `OFFICIAL_TRANSITION_NOT_OBSERVED`; the final execution state was
`EMPTY`, retry count was `0`, and cleanup passed.

The canonical raw produced by the driver was preserved byte-for-byte:

- `19b7cde141252f49cce0dde3aef4723a9185830e/case-a-production-v2.json`
  - status: `BLOCKED`
  - final execution state: `EMPTY`
  - SHA-256: `46112cb76b8d9df7a825f92dd5cc9354e4dd5e3a8276b20a8fa5e7da1f935940`

Cases B/C were not run. No placeholders were created. The official
production-v2 baseline remains not established.

## Production Pilot #12

Candidate `84ea82fef528487b0d3b0472def1199c277b340e` used the versioned Pilot
driver (`driverVersion=2`) with `production-v2`. Preconditions passed. Case A
blocked at operation 8 (`EXECUTE_SLICE`, `slice-02`) with
`OFFICIAL_TRANSITION_NOT_OBSERVED`; retry count was `0`, cleanup passed, and
the driver preserved no causal blocker artifact.

The canonical Case A raw was preserved byte-for-byte:

- `84ea82fef528487b0d3b0472def1199c277b340e/case-a-production-v2.json`
  - status: `BLOCKED`
  - final execution state: `EXECUTION_STARTED`
  - SHA-256: `c416b19ef4bf147ad87deb190987b3fc88656f6ffc8154bae11b42f357ff2631`

Cases B/C were not run. No baseline or gate was promoted; the official
production-v2 baseline remains not established.
