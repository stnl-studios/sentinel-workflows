# Benchmark interfaces and evidence

The benchmark drives the published Sentinel operations and observes their public outputs. It does not create requirements, activate plans, publish findings or decide workflow outcomes on behalf of the product.

## Ownership boundaries

| Information | Owner | Benchmark responsibility |
| --- | --- | --- |
| Requirements, SPEC, selected operation and slice | Scenario and Sentinel workflow | Provide the declared case inputs and follow the returned public handoff. |
| Plan and Tasks approval | Plan reviewer and publisher | Retain the approved bytes and activation identity; do not substitute a private candidate. |
| Implementation checks | Validation runner | Observe selected checks and preserve their result and evidence. |
| Formal slice disposition | Quality manager | Record `PASS`, `NEEDS_FIX` or `BLOCKED` only from the formal response and current evidence. |
| SPEC closure | Lifecycle manager | Verify the public closure result and its evidence independently of slice completion. |
| Product behavior | Case oracle | Run the checks declared for the Todo CLI and record their result separately from workflow disposition. |
| Usage and duration | Public provider events and benchmark ledger | Preserve observed counters, identities and time boundaries; leave unsupported values unavailable. |

The benchmark follows operation handoffs from official readback. `NO_EXECUTION` does not prove a plan was published, `TESTS_FAIL` is not a formal finding, and a completed run does not imply that the independent product oracle passed.

## Runtime and client data

The campaign provider uses the pinned Codex SDK and the repository's native Codex helpers. The App Server transport is opt-in: importing it does not start a client, and it creates only the stdio process it owns. It does not connect to the desktop application or change Codex configuration. Protocol errors, timeouts, permission requests, incomplete responses and uncertain effects stop the operation; the benchmark does not approve permissions or automatically redispatch an uncertain call.

The provider preserves the official parent and child identities, role, completed status and full final response. A parent summary or a completed notification alone is not evidence of a completed child. Retries, corrections and child turns remain attributable to their own public identities and ledger entries.

Each measured run uses a frozen source snapshot and separate case workspaces. The benchmark's hashes and ownership checks detect observed drift; they are not a host security sandbox. The process may have access permitted by the host and account. Do not treat workspace separation as protection for credentials or unrelated host files.

## Result and measurement rules

Workflow disposition, case-oracle result and measurement completeness are exported separately. A complete full result requires every declared case and terminal check on the same frozen candidate. Focal and single-case runs are diagnostic and cannot fill a full campaign result.

For comparisons, preserve the public usage counters before normalization and bind them to the relevant thread, turn and operation. Count retries and child turns, avoid double-counting cached or reasoning subtotals, and keep failed or cancelled attempts visible. Wall time uses recorded boundaries; summed concurrent case time is not run wall time. Billing, context-window occupancy and unsupported time splits are not inferred.

Missing counters or identity, gaps, resets, forks, incompatible profiles or uncertain provider semantics make measurement incomplete or incomparable. They are not converted to zero. A diagnostic export may describe known values but cannot qualify a full measurement or support savings claims.

## Local evidence and cleanup

Run state, prompts, snapshots, workspaces, ledgers, events and raw diagnostics are written below the ignored `benchmark-temp/` directory. Read-only `status` and `inspect` do not make model calls. Starting a run does not delete prior runs or rewrite retained measurement history.

Explicit cleanup is limited to an owned, inactive, terminal run whose evidence and cleanup preconditions pass. It retains the run by moving it into the benchmark's local retained area; it does not erase the retained run. Preserve a canonical report before moving raw evidence needed for later inspection. Published files in `measurements/` and reference inputs in `baselines/` are not campaign scratch and are not replaced by diagnostic exports.

The root customer installer does not distribute benchmark providers, App Server transport, benchmark SDK dependencies, case workspaces or measurement artifacts.
