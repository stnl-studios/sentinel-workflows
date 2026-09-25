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

`MODE=CLOSE` returns documentary `SPEC_CLOSED`, not durable delivery approval. It preserves requirements authority; substantive `RESUME` requires `REPLAN`. Lifecycle never rewrites execution artifacts.

## Preconditions

Require explicit `MODE=CLOSE` and active `ready`; use `RESUME` for change. The source snapshot and filesystem identity captured by the publisher protect the operation from source drift.

## Deterministic pipeline

1. Build a disjoint candidate without model generation:
   `node "<SKILL_ROOT>/runtime/build-closed-spec.mjs" <SOURCE> <CANDIDATE>`
2. The renderer verifies the active ready source and authority snapshot, copies externals safely, validates closed form and exact transition, then rechecks immediately before and after renaming its inode-backed candidate; stale state rolls that candidate back.
3. Do not edit the rendered candidate. Publish it only with:
   `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" CLOSE <TARGET> <CANDIDATE>`
4. Publisher revalidates the live source identity and digest and requires the exact deterministic candidate before promotion. A changed source aborts publication.

The model does not copy or paraphrase records, nor rebuild deterministic structure or metadata; renderer and validators do.

## Exact consolidation

The renderer uses fixed closed scaffolding and section order. It carries Objective, Context, Scope as Final Scope, Out of Scope, Business Rules, and Relevant Contracts as Important Contracts without rewriting their bodies. The active derived requirement list is replaced by canonical R record bytes. Optional closed sections appear only for materialized AC, D, C, RK, or Q categories.

The closed ID set exactly equals the source set. Preserve every record's prefix/type, ID, title, status, ordered metadata, narrative, references, record identity, all retired tombstones with their reasons, and all final Q records; only the owning section changes. Preserve valid gaps and Unicode. Add no timestamp, locale-dependent value, filesystem-order value, random value, summary, answer incorporation, session log, command, plan, test, commit, or implementation evidence.

Reject any missing or extra record, changed title/type/text/metadata, duplicate authority, open question, invalid final form, or external difference. Repeated rendering of the same source produces identical bytes and a final newline.

## External and failure boundary

`shared/` is lifecycle input and is absent only in the validated candidate. `execution/` and every other external path are copied without dereferencing symlinks and must compare unchanged; ignored OS packaging metadata is neither authority nor copied. Any renderer failure leaves source and destination untouched. Any publication failure or abrupt interruption is handled by the publisher's journaled recovery; never remove live `shared/` or a valid backup manually.
