# File Purpose Header

```yaml
purpose: Resume an explicitly requested current operation from durable documentary scope.
status: not_applicable
read_when: Execution controls are missing or a resumed context receives another explicit request.
do_not_read_when: The ordinary integral context already provides its exact current handoff.
contains: Current decision, transactional resumption, native checks and bounded request rules.
owner: stnl-slice-executor
update_policy: Change with the current controller, proof contracts and recovery tests.
```

# Documentary resumption of an explicit operation

For an explicitly requested EXECUTE_SLICE or VALIDATE_SLICE, use the existing controller's `inspect-request --spec-path SPEC_PATH --slice SLICE --operation OPERATION --request-id REQUEST_ID` before requiring the three execution controls. REQUEST_ID identifies the current user instruction and stays unchanged across inspection, controller restarts, dependencies and retries. Never mint a new ID to bypass a consumed attempt. Ordinary integral contexts retain their original admission and evidence semantics.

When the result is `documentary-resumption`, use `prepare-documentary-resumption` with the exact spec, slice, operation and returned `--expected-decision-sha256`. This prepares new carriers for the existing documentary scope. It does not approve them, run checks, certify historical PASS, restore historical counters or require REPLAN. Submit the complete prepare result (saved handle, candidateExecutionRoot, authority and resumption), the current user operation/target, and its original documentary source to an independent stnl-plan-reviewer using its Documentary preparation handoff route. That route reviews exact candidate bytes and all global/delivery authority hashes with the existing review JSON shape, without prepare-task-candidate, preparation-draft or publish-task-candidate. The reviewer returns the actual decision/file to this invoking controller; state explicitly that this is a new decision on current scope, not recovery of an earlier approval. If material documents disagree or a necessary pair is missing, ask one concrete decision about that source; never invent the missing content.

Pass the saved preparation handle and the actual review with `install-documentary-resumption --handle HANDLE --review-file REVIEW`. Installation uses the existing publication lock and exact-tree compare-and-swap. The former execution tree remains byte-for-byte in the returned retained backup, including old proof, corrupt or incomplete evidence, human explanations and controls. It is inert history, never a current proof source. Do not delete it. A publication interruption uses `recover-documentary-resumption --handle HANDLE --allocation MARKER`; recovery restores the exact old tree or confirms the already installed new one and never runs a recipe. Preserve uncertain owners and outcomes.

The installed context returns to normal begin/reserve-dispatch/bind-native/verify-native/capture-native/publish. Existing implementation can be observed without an edit. VALIDATE requests and prerequisite bootstrap admit observation/checking only: they do not authorize product corrections. If code needs a change, stop and request the distinct implementation/correction action. Dependencies without verifiable current proof require fresh checks and formal proof before the selected delivery. Unrelated earlier rows are not dependencies and are not automatically selected. Preserved completed Plan/Task pairs can supply documentary scope for a new review; their old checkmarks, PASS text and revisions are never restored as evidence.

For later explicitly requested targets in this same context, call `inspect-request` with that target and its current stable REQUEST_ID. Save the returned `documentaryRequest` object and pass it as `--documentary-request-file FILE` to `begin`, alongside its exact eligible handoff, operation and activation. This updates the current selection without another bootstrap or rewriting the snapshot. Each admitted request/slice/phase permits one new invocation, with historical consumption explicitly unknown. Existing allocations and native evidence reject reuse of that request for another attempt. Reinspection, another handle, normalization, or a successor is not a new user instruction. An additional attempt requires a new explicit decision, not a silent reset. The existing implementation/formal counters still record observed new consumption.

Use `inspect-request --terminal` only for an explicitly requested integral validation. Pass the returned request and its terminal selection to the normal dispatcher. A local formal and a requested integral formal are distinct phases, each with its own single invocation. Target-only completion returns TARGET_CURRENT; it does not mean the entire execution is COMPLETE. Only the existing verified integral certification can establish COMPLETE.

The three controls can be regenerated as the local context, but are not indispensable historical truth. Durable Markdown remains scope, and native records remain proof only when verified. Never edit historical origin paths to make a copied proof appear local. Unknown mutable environment, database or input state always requires current verification.
