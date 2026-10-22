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

Use the exact MODE/inputs and conflict rules in `SKILL.md`.

## Mutable-mode publication

Mutable modes share this recovery-safe boundary:

1. Resolve authority; snapshot live state and protected paths.
2. INIT/RESUME build the complete disjoint candidate without editing live state. CLOSE supplies no candidate: the publisher allocates its own single stage and renders internally.
3. For INIT before validation, run `node "<SKILL_ROOT>/runtime/prepare-init-candidate.mjs" <TARGET> <CANDIDATE>`; owner-only serialization blocks malformed headers. Never after rejection.
4. Validate candidate structure and mode transition against unchanged source.
5. Publish only with `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs"`. Before any publisher write, prove the temporary-root exclusion per `../README.md` (fixed Git query, or explicit non-Git API/CLI roots). Acquire common before lifecycle; bound dead-owner recovery follows `../README.md`. Recheck backup digest before promotion. Conflicts restore exact state; failures retain or restore valid state. Renames are not filesystem-wide atomic.
6. Revalidate published state and external snapshot; report failures and stop.

Candidates cannot authorize changes. Runtime proves structure, relations, preservation, rendering/publication; the model owns semantic sufficiency and non-invention.

Commands:

- INIT: `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" INIT <TARGET> <CANDIDATE>`; CLOSE: `close-policy.md`.
- RESUME: create the manifest with `node "<SKILL_ROOT>/runtime/create-resume-manifest.mjs" <TARGET>`; publish with `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" RESUME <TARGET> <CANDIDATE> --manifest <MANIFEST>`.

## INIT

Destination must be absent at start/publication; block any existing file/directory, even without `feature_spec.md`.

Build the smallest valid workspace from supplied evidence, without empty categories or irrelevant questions. Load readiness authority only for a supported ready claim; otherwise return valid `draft` or `blocked`.

## RESUME

Source must be valid and active. Normal changes require a strict ephemeral JSON manifest of authorized sections, IDs, and status transitions. No removal, wildcards, generic authority, unknown fields, external paths, or post-fact expansion. Preserve omitted authority bytes.

Preserve H1, IDs/types/titles and unaffected bytes/links/paths; retire in place and allocate above highest suffix. Manifests are consumed on failure. After `GLOBAL/READY`, status-only `draft → ready` is manifest-free: run `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" RESUME <TARGET> <CANDIDATE> --readiness-attestation auto` with the persistent locator-derived attestation at `materialRoot/readiness-attestation.json` absent or retained by the same compatible retry. Publisher creates it from target identity/candidate snapshot. Never call `create-readiness-attestation.mjs` on a candidate or hand-write JSON; reuse only for a publisher-retained retry.

## READINESS

Never mutate the workspace or create lifecycle content.

Run `node "<SKILL_ROOT>/runtime/validate-spec-lifecycle.mjs" workspace <SPEC_PATH>` first; stop on failure. On PASS load `readiness-gates.md`, evaluate the scope, capture both snapshots, and return JSON per `SKILL.md`. Changed identity is an evaluation error; `LOCAL_CLEAR` is focal only. After `GLOBAL/READY`, `ready` may run `node "<SKILL_ROOT>/runtime/create-readiness-attestation.mjs" <SPEC_PATH> <EXTERNAL_ATTESTATION> --scope GLOBAL --verdict READY` for a legitimate external consumer; `draft` defers status-only promotion attestation creation to the publisher above.

## CLOSE

Source must be valid active `ready`. Follow `close-policy.md`; invoke `publish-spec-lifecycle.mjs CLOSE <TARGET>` without a candidate. Runtime derives execution disposition and renders directly into its owned stage. An absent execution needs no implementation PASS; an existing execution requires current integral COMPLETE from the normal reader plus ownership/retirement checks. A terminal readiness attestation is optional, not substitute authority.

## Outcome contract

After active `ready`, return `node "<SKILL_ROOT>/runtime/validate-spec-lifecycle.mjs" handoff <SPEC_PATH>` verbatim. It owns only the lifecycle/execution boundary: empty execution normally hands off to `OPERATION=PLAN`; non-empty execution must be inspected by its own runtime. `MODE=CLOSE` stays explicit.

Report status, changes, decisions, findings, validations, or transition/violation without repeating content/reasoning.
