# S3 Benchmark Agent Harness Qualification v1

## Base

- branch: `feature/atlas-p0`
- HEAD: `6a7939b2f5b8ffee24223182c61cebf3a16d7236`
- parent: `eeac1c293147c1e14a50e71e8ac8e7b26d6a5ecd`
- commit: `docs(benchmark): record Case A SPEC qualification`
- initial working tree: clean, with no relevant untracked files
- parent-to-HEAD scope: historical evidence for the blocked Case A SPEC
  Qualification only
- Environment Qualification commit: published at
  `eeac1c293147c1e14a50e71e8ac8e7b26d6a5ecd`

## Trigger

`SPEC_QUALIFICATION_BLOCKED_ENVIRONMENT`

The prior one-shot Luna probe stopped before session creation because the
provider rejected the launcher invocation.

## Root cause

The external benchmark model launcher had no versioned authority in the
repository. Its command line was assembled ad hoc for the qualification and
placed the short approval option `-a` after the `exec` subcommand. The installed
Codex CLI exposes approval control at the global command surface; its `exec`
surface rejected that placement with `unexpected argument '-a'` before any
model session existed.

Benchmark Environment Qualification v1 begins after a process already exists
and therefore correctly proved filesystem, Node, Git, managed TMPDIR, child
environment, paths, and cleanup without proving provider session creation. The
missing boundary was external provider discovery and model-turn invocation.
No Sentinel functional launcher caused the failure.

## Pente fino

| Area | Finding | Status |
| --- | --- | --- |
| External launch authority | No repository-owned provider argv authority existed. | Blocker corrected by Benchmark Agent Harness v1. |
| Approval placement | The ad hoc invocation used an option placement rejected by the installed CLI. | Corrected with installed-help-derived long-form global approval control and H03 regression. |
| Process/provider failures | Init, timeout, malformed protocol, output overflow, and model-turn failure lacked one normalized external boundary. | Guardrail added with bounded classifications and zero internal retry. |
| User/project state | User config, rules, project instructions, shell profile, and persisted session state could otherwise vary an experiment. | Isolated explicitly; existing authentication remains available to the provider process. |
| Duplicate launch construction | Delimited search found no other benchmark provider argv builder. | No problem remains; fake-provider argv exists only in deterministic tests. |
| Sentinel launchers | Internal Codex/Claude validation-runner launchers are a different native delegation boundary. | No causal finding; byte-unchanged. |

The review stopped at the authorized benchmark-to-model boundary after these
findings were closed.

## Harness contract

| Field | Value |
| --- | --- |
| Contract version | 1 |
| Provider | `codex` |
| Provider version | `codex-cli 0.154.0` |
| Capability hash | `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441` |
| Structured output | JSONL, required |
| Prompt stdin | supported and required |
| Sandbox override | `read-only`, `workspace-write` |
| Model override | explicit |
| Effort override | explicit config key |
| User-config isolation | supported and required |
| Timeout owner | benchmark harness |

The installed bundled model catalog was inspected read-only before
implementation. It contained exact entries for `gpt-5.6-luna`,
`gpt-5.6-terra`, and `gpt-5.6-sol`; each advertised `low`, `medium`, `high`, and
`xhigh`. Those are the only public mappings in Harness v1. The capability hash
also binds the provider version/help surfaces, contract version, all three
mappings, and the canonical isolation/transport policy. Full help, executable
path, HOME, configuration paths, and authentication data are not persisted.

Requalification is required after a provider CLI version or capability
fingerprint change; a harness contract or model/effort/sandbox mapping change;
or a config-isolation, prompt-transport, structured-output, or timeout policy
change.

## Canonical invocation

The Codex adapter constructs one argv array with this fixed category order:

1. global long-form approval policy set to noninteractive `never`;
2. `exec`;
3. strict config, ephemeral session, ignored user config and ignored rules;
4. color disabled and JSONL enabled;
5. explicit model, sandbox, canonical CWD, and explicit reasoning effort;
6. project instruction discovery disabled;
7. shell environment inherited from the harness-owned minimal environment,
   without loading a user shell profile and with secret-name defaults excluded;
8. `-` as the stdin prompt marker.

No executable command string, shell interpolation, command prefix, approval
fallback, or retry is constructed. Test-provider command injection exists only
as a programmatic seam and is not a public CLI option.

## Isolation

- CWD is mandatory, absolute, existing, non-symlink, already canonical, outside
  the Sentinel checkout, and below the managed session `workspaces/` root.
- TMPDIR is mandatory, absolute, existing, non-symlink, already canonical,
  outside the checkout, and exactly the sibling managed `runner-tmp` directory.
- Environment v1 remains the owner of session creation and cleanup. Harness v1
  receives that TMPDIR and injects it into the provider process before start.
- The provider process receives a minimal allowlist needed for executable
  discovery, existing authentication, locale, proxy/certificate support, and
  the managed TMPDIR. Git redirect variables are removed.
- User config and rules are ignored, project instruction loading is disabled,
  and the provider session is ephemeral. The neutral disposable workspace has
  no project `.codex` configuration or custom agents.
- Prompt bytes travel through child stdin with `shell: false`.
- JSONL is the only accepted provider automation protocol. Intermediate logs
  are bounded and are not persisted.

## Failure taxonomy

| Status | Meaning |
| --- | --- |
| `HARNESS_COMPLETED` | Session and turn started and reached structured terminal success. |
| `HARNESS_INIT_FAILED` | Invalid request/path or provider process/session failed before observable start. |
| `HARNESS_TIMEOUT` | Harness wall-clock deadline terminated the provider. |
| `HARNESS_PROTOCOL_ERROR` | Structured output was malformed, incomplete, or exceeded the capture bound. |
| `HARNESS_CAPABILITY_MISSING` | Installed provider lacks a required discovered capability. |
| `HARNESS_MODEL_UNSUPPORTED` | Requested model is outside the single mapping authority. |
| `HARNESS_EFFORT_UNSUPPORTED` | Requested effort is outside the single mapping authority. |
| `HARNESS_SANDBOX_UNSUPPORTED` | Requested sandbox is outside the single mapping authority. |
| `MODEL_TURN_FAILED` | A session/turn started but terminated at model-turn level. |

These are harness/model facts, not Sentinel outcomes. A Sentinel result exists
only after a valid model session produces and persists the requested Sentinel
operation result.

## Deterministic tests

The fake provider executable and its control files are created only inside
test-owned managed temp. No deterministic test calls a real provider.

| ID | Contract | Result |
| --- | --- | --- |
| H01 | complete capability discovery | PASS |
| H02 | required capability missing fails closed | PASS |
| H03 | short approval regression and valid global placement | PASS |
| H04 | canonical deterministic argv | PASS |
| H05 | unique Luna/Terra/Sol mapping and unknown rejection before spawn | PASS |
| H06 | explicit low/medium/high/xhigh mapping and unknown rejection | PASS |
| H07 | read-only/workspace-write mapping and unknown rejection | PASS |
| H08 | canonical CWD with spaces and Unicode | PASS |
| H09 | managed TMPDIR in process environment only | PASS |
| H10 | byte-identical stdin prompt transport | PASS |
| H11 | shell metacharacters remain literal | PASS |
| H12 | valid structured terminal success | PASS |
| H13 | malformed JSONL protocol | PASS |
| H14 | provider nonzero before session | PASS |
| H15 | model-turn failure after session start | PASS |
| H16 | timeout classification and termination | PASS |
| H17 | bounded excessive output | PASS |
| H18 | canonical config-isolation construction | PASS |
| H19 | deterministic capability fingerprint | PASS |
| H20 | provider help/version invalidation | PASS |

The suite reported 20 top-level H checks and 24 total test assertions/subtests,
all PASS. Environment tests reported 5/5 PASS, including exported session
ownership and bounded cleanup.

## Live Luna probe

Exactly one live probe was executed after all deterministic tests passed. It
used the same `runHarness` helper exposed to future benchmark callers. There was
no retry.

| Fact | Result |
| --- | --- |
| Model | `GPT-5.6-Luna` requested |
| Effort | `medium` requested |
| Sandbox | `workspace-write` requested |
| Provider-reported model | unavailable; not inferred |
| Capability check | PASS |
| Invocation accepted | PASS |
| Session started | PASS |
| Turn started and terminal | PASS |
| Managed TMPDIR present before provider start | PASS |
| Prompt via stdin | PASS |
| Structured JSONL parse | PASS |
| Provider command events | one, exit 0 |
| CWD confirmation | PASS |
| TMPDIR inherited | PASS |
| `os.tmpdir()` canonical match | PASS |
| seed `node --test` | PASS |
| `mkdtemp` | PASS |
| write/read | PASS |
| rename/remove | PASS |
| Git final clean | PASS |
| Session cleanup | PASS |
| Sentinel checkout preserved | PASS |
| Global Git config preserved | PASS |
| Retry | 0 |
| Unexpected effects | none |

The public result records requested model and effort separately from provider
telemetry. Because this CLI's JSONL did not report a model field, no
`providerReportedModel` value was fabricated.

## Historical integrity

| Raw result | Before SHA-256 | After SHA-256 | Identity |
| --- | --- | --- | --- |
| Pilot #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| Pilot #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| Pilot #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |

## Reviewer

The independent GPT-5.6-Sol / high read-only reviewer returned:

`PASS`

No second audit was opened.

## Scope preservation

- `skills/**`, `agents/**`, `templates/**`, and `integrations/**`: unchanged.
- Sentinel execution and lifecycle runtimes: unchanged.
- benchmark Cases, requirements, Production Profile, budgets, and seed
  behavior: unchanged.
- result and journal schemas and `benchmarkVersion`: unchanged.
- Sentinel internal retry semantics: unchanged.
- no Terra/Sol qualification arm and no Production Pilot executed.

## Status

`BENCHMARK_AGENT_HARNESS_READY`

## P0 ledger

- G1 = PROVEN
- G2 = PARTIAL
- G3 = PARTIAL
- G4 = PROVEN
- G5 = PROVEN
- G6 = NOT_YET_PROVEN

No gate was promoted or reopened.

## Resulting commit

`9972a4534cf7c80a9923fd66570a9504a2a3facf`
