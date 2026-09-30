# File Purpose Header

```yaml
purpose: Define preconditions, changes, safe publication, and completion for the four SPEC lifecycle modes.
status: not_applicable
read_when: Selecting or applying INIT, RESUME, READINESS, or CLOSE.
do_not_read_when: Only a canonical item shape or isolated relationship rule is needed.
contains: Explicit mode boundaries, transition restrictions, candidate publication, and concise outcomes.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when lifecycle semantics change.
```

# Lifecycle MODEs

Require one exact `MODE=INIT|RESUME|READINESS|CLOSE`; reject aliases, variants, combinations, or inference. Transient context cannot replace persisted authority, required inputs, or mode boundaries. Material conflicts block the affected work and name the artifact or ID.

## Mutable-mode publication

`INIT`, `RESUME`, and `CLOSE` use the same recovery-safe boundary:

1. Resolve authority; snapshot live state and protected paths.
2. Build the complete disjoint candidate; never edit live state.
3. Before INIT validation, run `node "<SKILL_ROOT>/runtime/prepare-init-candidate.mjs" <TARGET> <CANDIDATE>`; owner-only serialization blocks malformed headers. Never after rejection.
4. Validate candidate structure and mode transition against unchanged source.
5. Publish only with `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs"`. Its portable exclusive lock precedes recovery; verify renamed backup digest before promotion. Conflicts restore exact state; failures retain or restore valid state. It is not filesystem-wide atomic.
6. Revalidate published state and external snapshot; report failures and stop.

The candidate cannot justify its changes. The runtime proves structure, relations, preservation, rendering, and publication; the model owns semantic sufficiency and non-invention.

Commands:

- INIT: `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" INIT <TARGET> <CANDIDATE>`; CLOSE: `close-policy.md`.
- RESUME: `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" RESUME <TARGET> <CANDIDATE> --manifest <MANIFEST>`

## INIT

Require `SPEC_PATH` and `REQUIREMENTS_SOURCE`. The destination must be absent at start and publication; block any existing file or directory, including one without `feature_spec.md`.

Bootstrap the smallest structurally valid workspace from supplied evidence. Do not materialize empty categories or irrelevant questions. Load readiness authority only when evidence can support a ready claim; otherwise stop at valid `draft` or `blocked` instead of manufacturing completeness.

## RESUME

Require `SPEC_PATH` and `NEW_INFORMATION` for an existing valid active workspace. Normal changes use a strict ephemeral JSON manifest naming authorized feature sections, IDs, and status transitions; it cannot authorize removal. Omitted authority is byte-preserved. Wildcards, generic authority, unknown fields, external paths, and post-fact expansion are invalid.

Preserve H1, IDs/types/titles and unaffected bytes/links/paths; retire in place and allocate above highest suffix. Manifests are consumed on failure. After `GLOBAL/READY`, status-only `draft → ready` is manifest-free: run `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" RESUME <TARGET> <CANDIDATE> --readiness-attestation <ATTESTATION>` with absent sibling `.<workspace-name>.readiness-attestation.json`. Publisher creates it from target identity/candidate snapshot. Never call `create-readiness-attestation.mjs` on a candidate or hand-write JSON; reuse only for a publisher-retained retry.

## READINESS

Require `SPEC_PATH`, exactly `READINESS_SCOPE=LOCAL|GLOBAL`, and bounded `READINESS_FOCUS` for `LOCAL`. The mode is read-only: never mutate the workspace or create lifecycle content.

Run `node "<SKILL_ROOT>/runtime/validate-spec-lifecycle.mjs" workspace <SPEC_PATH>` first; stop on failure. On PASS load `readiness-gates.md`: `LOCAL` reads focus/dependencies, `GLOBAL` all authority. Write nothing. Capture `node "<SKILL_ROOT>/runtime/readiness-snapshot.mjs" <SPEC_PATH>` before and after evaluation and return the exact JSON result described in `SKILL.md`; changed identity is an evaluation error. `LOCAL_CLEAR` is focal only. After `GLOBAL/READY`, `ready` may run `node "<SKILL_ROOT>/runtime/create-readiness-attestation.mjs" <SPEC_PATH> <EXTERNAL_ATTESTATION> --scope GLOBAL --verdict READY` for a legitimate external consumer; `draft` defers status-only promotion attestation creation to the publisher above.

## CLOSE

Require a valid active `ready` source. Follow `close-policy.md`; the runtime verifies, renders, validates, and publishes directly. Implementation evidence and terminal readiness attestation are never gates.

## Outcome contract

After active `ready`, return `node "<SKILL_ROOT>/runtime/validate-spec-lifecycle.mjs" handoff <SPEC_PATH>` verbatim. It owns only the lifecycle/execution boundary: empty execution normally hands off to `OPERATION=PLAN`; non-empty execution must be inspected by its own runtime. `MODE=CLOSE` stays explicit.

Return status, changes, decisions, findings, validations, or transition/violation. Do not repeat content or reasoning.
