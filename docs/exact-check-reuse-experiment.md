# Exact implementation-check reuse: isolated experiment

Status: blocked on enforced dependency closure and an explicit deterministic-check contract. No cache hit is enabled by this experiment. Existing verification and independent formal review remain unchanged.

## Scope

The smallest proposed positive case is the latest successful native Initial EXECUTE followed by the first independent VALIDATE for the same delivery. Reuse copies only the executed checks and their output/exit observations. It cannot supply PASS, findings dispositions, requirement coverage, an independent runner identity, or a terminal judgment. The new reviewer must still be admitted, bound, inspect the current authority and implementation, and return its own literal semantic response.

Legacy v1 recipes and observations without the new producer capability always execute fresh checks. Completed/finding-cycle reuse, cross-delivery reuse, and reuse of a previous formal judgment are outside this first implementation.

## Required approved contract

A new reviewed recipe version must explicitly opt into deterministic checks over a closed input set. The approval must cover the exact recipe bytes and dependency definition. A label such as immutable-inputs-only is not proof that an arbitrary program actually obeys it. In particular, identical arguments, environment, executable and project files do not exclude network, current time, random values, external services, dynamically loaded libraries, or child executables.

A positive hit therefore needs a supported producer capability that enforces and attests the closed dependency boundary, plus a deterministic verifier contract. A declaration alone must not enable a hit.

## Producer capability and bindings

The producer-owned versioned attestation must identify its implementation hash, reviewed contract digest, exact read-only dependency tree and hashes, executable/runtime/system-image identity, a fingerprint of the effective environment, denied networking, and isolated permitted temporary writes. Environment values, credentials, and secrets must not be persisted. Capability probes must demonstrate that undeclared reads, writes, child process escapes and network access are denied. A capability must not be inferred merely from the name of a tool or a successful exit.

The source must be a fully validated successful native implementation bundle. Preserve its exact bytes in a bounded source capsule and bind their digest to the new formal request's base.evidenceSha256. Revalidate the original origin, owner, admission, response, receipt, observation and object closure using existing validators. Require exact approved snapshot, normative authority, delivery identity, local/preparation revisions, recipe, commands, arguments, working directories, executable identities, tested work, declared inputs, effective environment, capability version and deterministic contract. The source and formal reviewer identities must differ.

A new observation can name the source capsule, record ID, capability digest and execution-context digest. It must clearly label the checks as reused implementation observations, never freshly executed formal checks. Quiet readback must rederive the reuse linkage from the original bytes rather than trusting the label. Source capsules cannot contain nested reuse chains in the minimal version.

## Persistence and invalidation

Recheck all inputs and the capability before selecting a hit and after preparation of the observation. Persist a started record under the existing operation lease before writing the completed reused result. The existing durable operation protocol owns replay. Pending or uncertain records never authorize another check or a fabricated result. Recovery may replay only the exact saved source and context; changed inputs invalidate it.

Any mismatch, unsupported capability, legacy source, tampered bytes or unknown schema prevents reuse. Ordinary fresh execution may proceed only through the existing authorized verification path, not as a bypass for a denied action.

## Required gates

1. A real capability-positive fixture proves one implementation execution, zero duplicate verification subprocesses in formal validation, and a separately admitted formal reviewer and judgment.
2. Same-operation replay and crash recovery preserve the saved source bytes and execute no additional accepted check.
3. Environment, executable content or mode, command/arguments, cwd, tested file, declared input, approved recipe, authority and capability changes invalidate reuse.
4. Foreign source owner/agent/request, wrong source digest, modified stdout/exit, missing object, unsupported or nested capsule, and changed observation are rejected.
5. An independent reviewer can return NEEDS_FIX or BLOCKED despite a successful reused implementation check.
6. Legacy v1 continues to execute normally, and all distributed readers agree on historical readback.
7. Negative capability tests establish that undeclared files, child processes, network and nondeterministic facilities cannot escape the approved contract.

## Current blocker

Cross-phase reuse requires a supported hermetic executor. Namespace setup may fail with NETLINK_ROUTE EPERM, and ptrace-based observation may fail with PTRACE_TRACEME EPERM. Those capability failures cannot be replaced by a weaker fallback: Node's permission model is not an equivalent adversarial hermetic boundary. A real positive gate must be demonstrated on the selected execution environment.

Declaration-only recipe/schema changes do not establish that capability and are not included in the stable integration. Resume implementation only with a supported executor and reviewed deterministic-check contract, or an explicitly selected weaker cache-assumption contract whose limitations are accurately disclosed.

## Implemented narrower path: same-operation replay and draft preflight

The cross-phase design above remains blocked and disabled. The implemented change is deliberately narrower:

- New private executions use stnl-runner-execution-v2. Their context includes the effective environment hash, platform/architecture, resolved executable content/mode, and an explicit invocation preimage plus digest. The native invocation binds owner, round, dispatch, agent, request digest, exact origin bytes and output destination.
- Replaying the same completed operation requires equality of that context and the existing recipe/work proof. It cannot transplant a completed result into another operation, even with identical files and commands. This is not an assertion that arbitrary checks are deterministic or hermetic, and it grants no reuse across implementation and formal phases.
- The official observation retains the context. Native source validation rederives its invocation against the authenticated origin/agent/owner and request where available, rather than trusting a checksum in isolation. CLOSE compares the private context with the official retained context before retirement.
- New validate-native-response --origin-file ORIGIN --response-json JSON_LITERAL validates a draft after verification and before the first final response. It requires existing completed verification and observation, replays them without another check, and validates the selected envelope, command/exits, parser fields and unresolved template markers. A valid envelope is not a semantic PASS or a publication authorization. The actual CLI is exercised in a separate process.
- A runner can correct malformed head/request/template fields locally within its original turn and emit one final response. No original final bytes are replaced. capture-native still refuses different bytes from the same owner. prepareNativeContinuation remains pre-verification only.
- Legacy private v1 outputs preserve their original behavior and bytes. They never receive a retroactive fingerprint. verify-native explicitly reports legacy-unbound. The new draft helper returns LEGACY_VERIFICATION_CONTEXT_UNAVAILABLE, directing callers to the original observed-result capture flow rather than deleting or rerunning evidence. A synthetic pre-observation restart test verifies that this compatibility route is not stranded.

Tests use synthetic mechanically authored runner responses, not a claim of a live independent model review. They establish one actual verification subprocess despite multiple draft checks, CLI preflight and exact-byte capture retries; a separate formal owner/agent remains required by the unchanged native controller. Negative tests cover changed environment, executable bytes/mode, arguments, cwd, work, output/context tampering, pending output, output destination and owner binding. An actual second-operation transplant and a coherently rehashed foreign invocation in readback are rejected.

The existing normalized Initial-to-CLOSE test's fixture precreated the destination which copyTree requires to be absent. Only the experiment's fixture was corrected to precreate its parent instead. This is not a product or lifecycle relaxation.

### Focused verification

- scripts/test-same-operation-replay.mjs: 15/15 passed, including native CLI preflight, actual successor-operation transplant rejection, coherently rehashed invocation rejection, and legacy pre-observation recovery.
- scripts/test-runner-protocol-rejection.mjs: 42/42 passed.
- Existing native distribution, exact-byte replay and publication-fault recovery selection: 3/3 passed.
- Existing normalized Initial-to-integral-CLOSE selection: 1/1 passed after the synthetic destination-creation fix.
- Existing faithful-owner terminal retirement selection: 1/1 passed.
- Codex runner contract and git diff --check passed. This is a focused experiment gate, not a full-suite or live-agent review claim.
