# File Purpose Header

```yaml
purpose: Select the installed native platform runner while preserving independence and origin-bound evidence.
status: not_applicable
read_when: Native or manual delegation selects a runner without the managed bridge.
do_not_read_when: Managed invocation already supplies the cross-checked broker and receipt.
contains: Platform selection, independent generic fallback, complete contract loading and native evidence limits.
owner: stnl-slice-quality-manager
update_policy: Keep both consumer guides equivalent when supported platform invocation changes.
```

# Native runner invocation

Without an adapter or managed context, use a fresh independent native context with no inherited conversation history. Select the installed platform runner when supported (Codex `stnl_validation_runner`, Claude Code `@agent-stnl-validation-runner`). If the native API only spawns an independent generic agent, use `fork_turns:"none"` or its platform equivalent and require that agent, before any scope reads or checks, to read and follow the complete installed runner contract (Codex `~/.codex/agents/stnl_validation_runner.toml` `developer_instructions`; Claude Code `~/.claude/agents/stnl-validation-runner.md` body). Require the installed file to identify `stnl-validation-runner` and contain its canonical contract marker; a missing, malformed, or different runner contract blocks. Give it the official preflight identity and minimum operation payload, instruct it to follow the contract's no-write rule, and capture its concluded tool result through the origin-bound native procedure below. Identify this as a contract-loaded independent agent, not a selected registered runner type. Reading `developer_instructions` from a file is task-level instruction loading; it does not confer developer-level priority or the enforcement guarantee of a registered agent. If independent spawning or exact contract loading is unavailable, block; a generic agent without that contract is not the runner. Managed launches use the pathless bridge below. The human launcher supplies no helper path or benchmark sequence.

Use this skill's start-native, bind-native, verify-native and capture-native procedure. Retain the producer receipt and reviewed verification observation; a generic or registered agent's report alone grants no persistence authority. Never replay a pending or uncertain dispatch. Managed contexts use only the configured bridge and cannot be replaced by a native spawn.

For the narrow converted EC-1/S2 `VALIDATE_SLICE` pilot, use `runtime/execution-current-operation.mjs` instead of the legacy native start/capture commands. The launcher supplies the explicit candidate-distribution Codex TOML path and records its hash; the independent agent must load that complete file before checks. `begin` takes `--spec-path`, `--slice`, and `--expected-activation-id`; subsequent commands take the returned `--handle`. `reserve-dispatch` returns the request and origin; spawn a fresh no-history agent, bind the official canonical task name, then let it call `verify-native --origin-file` once. Preserve the notification's complete finalResponse as UTF-8 and pass its official identity in the `--tool-result-file` envelope to `capture-native`. After capture, `resume` may direct publication of the same bytes without another spawn or recipe. If `resume` returns `cleanup`, run `cleanup --handle` for own-only completion without another agent or check. An uncertain or malformed response stops this operation. The pilot does not enable other operations or the legacy malformed-result successor.
