# File Purpose Header

```yaml
purpose: Define deterministic lossless closure, global-readiness preconditions, and protected external boundaries.
status: not_applicable
read_when: MODE is CLOSE and structural validation plus global semantic readiness passed.
do_not_read_when: The SPEC remains active or any documentary blocker is unresolved.
contains: Closure preconditions, renderer and publisher commands, exact preservation, and failure behavior.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when documentary closure or preservation policy changes.
```

# CLOSE Policy

`MODE=CLOSE` returns documentary `SPEC_CLOSED`, not durable delivery approval. It preserves requirements authority; substantive `RESUME` requires `REPLAN`. CLOSE omits execution only when absent or independently inspected as current integral COMPLETE; other external paths remain exact. This does not retain durable implementation approval after execution is discarded.

## Preconditions

Require explicit `MODE=CLOSE` and active `ready`; use `RESUME` for change. The source snapshot and filesystem identity captured by the publisher protect the operation from source drift.

## Deterministic pipeline

1. Use the normal publisher directly: `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" CLOSE <TARGET>`.
2. Do not supply a candidate. The publisher derives execution disposition through the normal current reader, obtains the common and lifecycle leases, allocates its own single stage and renders into that owned inode.
3. Preview through pure `renderClosedFeature` is documentary only. It neither admits nor publishes CLOSE.
4. Before promotion, revalidate source identity/digest, execution authority/activation/manifest and exact rendered bytes under the common lease. Pending or uncertain producers and foreign material block discard.
5. Retain source/backup through commit until sealed ownership and dispensability are proved. Delete only those bound roles, then the empty namespace and common lease. Keep recovery authority while cleanup remains pending; no eternal residue is required after settlement. Never interpret partial integration as permission to discard.

The model does not copy or paraphrase records, nor rebuild deterministic structure or metadata; renderer and validators do.

## Exact consolidation

The renderer uses fixed closed scaffolding and section order. It carries Objective, Context, Scope as Final Scope, Out of Scope, Business Rules, and Relevant Contracts as Important Contracts without rewriting their bodies. The active derived requirement list is replaced by canonical R record bytes. Optional closed sections appear only for materialized AC, D, C, RK, or Q categories.

The closed ID set exactly equals the source set. Preserve every record's prefix/type, ID, title, status, ordered metadata, narrative, references, record identity, all retired tombstones with their reasons, and all final Q records; only the owning section changes. Preserve valid gaps and Unicode. Add no timestamp, locale-dependent value, filesystem-order value, random value, summary, answer incorporation, session log, command, plan, test, commit, or implementation evidence.

Reject any missing or extra record, changed title/type/text/metadata, duplicate authority, open question, invalid final form, or external difference. Repeated rendering of the same source produces identical bytes and a final newline.

## External and failure boundary

`shared/` is lifecycle input and is absent only in the validated candidate. `execution/` is absent in the result only after the normal admissibility/discard checks. Every other external path is copied without dereferencing symlinks and must compare unchanged; ignored OS packaging metadata is neither authority nor copied. Renderer failure preserves the source and never promotes its partial owned stage. Any publication failure or abrupt interruption is handled by the publisher's journaled recovery and ownership checks; never remove live `shared/`, a valid backup or a foreign stage replacement manually.

On Darwin, additional members of an existing symlink hardlink group use only the fixed `/bin/ln -P -h --` capability from the shared owned-stage copy helper, with a two-second timeout, 4-KiB output limits and no shell. Both normal candidate copy and CLOSE reuse it. Source payloads are literal, including dangling or absolute targets; regular hardlinks and isolated symlinks retain their native Node paths. The destination must be absent, both names must remain within the sealed stage/filesystem, and identities, parents, payload and exact inode/link topology are checked before and after the call. Failure blocks promotion without retries or alternate executables; ownership mismatch preserves foreign material. Path barriers detect observed replacement, but cannot promise zero external effect under arbitrary hostile mutation during the OS syscall.

## Terminal observation

CLOSE returns publication `confirmed` with cleanup `complete` or `pending`, its transaction, authority, digest and derived disposition. A final unlink followed by failed parent fsync reports `FINAL_SETTLEMENT_DURABILITY_UNCONFIRMED` with cleanup pending, without inventing a retained lock or reconstructing removed names. Recovery uses valid remaining authority and finishes the same cleanup; with every control absent it observes only the valid closed document and returns false, without republishing or invoking a model.

Closed readers do not depend on removed operational files. Execution readers report `SPEC_CLOSED` with no normal handoff; the documentary lifecycle handoff remains `NOT_APPLICABLE`. Roadmap delivery dependencies without structured retained evidence remain `UNKNOWN`. The runbook inspector can inspect the consolidated SPEC, but execution/slice/task selections without current execution report `SPEC_CLOSED`; it does not reconstruct historical sources or generate approval.
