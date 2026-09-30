# S3 Deterministic Sandbox Probe v1

## Status

`SANDBOX_PROBE_PASS`

## Base

- branch: `feature/atlas-p0`
- HEAD: `5929e883e7d3bd8f0e6e69ad7544f27990222b03`
- parent: `22e2cc7950de01353a0099f5917ede4b76fd2025`

## Pilot #9 blocker

- Harness completed;
- prior child command exit `2`;
- exact prior argv unavailable;
- no Case started.

## Probe setup

- managed session official: yes;
- probe workspace prepared: yes;
- CWD canonical: yes;
- TMPDIR canonical: yes;
- workspace Git-backed and clean: yes.

## Harness

| Fact | Result |
|---|---|
| model | `GPT-5.6-Luna` |
| effort | `medium` |
| sandbox | `workspace-write` |
| Harness | `HARNESS_COMPLETED` |
| provider accepted | yes |
| session started | yes |
| turn started | yes |
| retry | `0` |

## Exact command

`<node> <benchmark.mjs> doctor --probe-workspace <managed-workspace> --expect-tmpdir <managed-runner-tmp>`

The sole structured command event used the provider's shell wrapper with this
exact literal command as its unchanged payload.

## Command result

- semantic commands: `1`;
- exit: `0`;
- stdout JSON status: `PASS`;
- stderr category: none;
- model result: `PROBE_PASS`.

## Official probe facts

| Fact | Result |
|---|---|
| workspace | `true` |
| managedTmpdirInherited | `true` |
| osTmpdirCanonicalMatch | `true` |
| mkdtemp | `true` |
| writeRead | `true` |
| renameRemove | `true` |
| nodeTest | `true` |
| gitTreePreserved | `true` |
| unexpectedEffects | `none` |

## Checkout integrity

PASS.

## Cleanup

PASS.

## Functional diff

`none`

## P0 ledger

Inalterado:

- G1 PROVEN
- G2 PARTIAL
- G3 PARTIAL
- G4 PROVEN
- G5 PROVEN
- G6 NOT_YET_PROVEN

## Baseline

`NOT_YET_ESTABLISHED`

## Next

Publish this evidence checkpoint and execute Production Pilot #10 directly.
Reuse this exact deterministic probe construction. No rehearsal, qualification,
or additional probe proof is justified.

## Resulting commit

`pending user commit`
