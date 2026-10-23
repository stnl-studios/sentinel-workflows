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

Use SKILL.md's exact MODE/inputs and conflict rules.

## Mutable-mode publication

1. Resolve authority; snapshot live state and protected paths.
2. Build a complete disjoint INIT/RESUME candidate, never edit live state. CLOSE supplies no candidate; the publisher allocates one owned stage and renders internally.
3. Before INIT validation run `node "<SKILL_ROOT>/runtime/prepare-init-candidate.mjs" <TARGET> <CANDIDATE>`. Owner-only serialization blocks malformed headers; never run it after rejection.
4. Validate candidate structure and transition against unchanged source.
5. Use only `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs"`. Before any write, prove temporary-root exclusion per ../README.md: fixed Git query or explicit nonGit API/CLI roots. Acquire common before lifecycle; use only bound dead-owner recovery per that README. Recheck backup digest before promotion; conflicts restore exact state, failures retain/restore valid state. Renames are not filesystem-wide atomic.
6. Revalidate publication and external snapshot; report failures and stop.

Candidates confer no authority. Runtime verifies structure, relations, preservation, rendering/publication; the model judges semantic sufficiency without invention.

## INIT

Block any existing destination at start or publication, including a file/directory without feature_spec.md. Build minimal valid content from supplied evidence, without empty categories or irrelevant questions. Load global readiness authority only for a justified ready claim; otherwise return valid draft/blocked.

Publish: `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" INIT <TARGET> <CANDIDATE>`.

## RESUME

Require valid active source and a strict ephemeral JSON manifest authorizing sections, IDs and status transitions. No removal, wildcards, generic authority, unknown fields, external paths or post-fact expansion. Preserve omitted bytes, H1, IDs/types/titles, unaffected links/paths; retire in place and allocate above highest suffix. Manifests are consumed on failure.

Create via `node "<SKILL_ROOT>/runtime/create-resume-manifest.mjs" <TARGET>`; publish via `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" RESUME <TARGET> <CANDIDATE> --manifest <MANIFEST>`.

After GLOBAL/READY, status-only draft-to-ready is manifest-free: `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" RESUME <TARGET> <CANDIDATE> --readiness-attestation auto`. The locator's materialRoot/readiness-attestation.json must be absent or publisher-retained for the same compatible retry. Publisher creates it from target identity/candidate snapshot. Never hand-write it or call create-readiness-attestation.mjs on a candidate; reuse only for a publisher-retained retry.

## READINESS

No workspace mutation or lifecycle content creation. First run `node "<SKILL_ROOT>/runtime/validate-spec-lifecycle.mjs" workspace <SPEC_PATH>`; failure stops. On PASS read readiness-gates.md, evaluate scope, take both snapshots and return SKILL.md's JSON.

After semantic GLOBAL/READY, an already-ready workspace may serve an explicitly legitimate external consumer via `node "<SKILL_ROOT>/runtime/create-readiness-attestation.mjs" <SPEC_PATH> <EXTERNAL_ATTESTATION> --scope GLOBAL --verdict READY`. A draft uses publisher-owned status promotion above instead.

## CLOSE

Follow close-policy.md for admission/retirement and target-only publication; never supply a candidate or substitute attestation for authority.

## Outcome contract

After active ready, return `node "<SKILL_ROOT>/runtime/validate-spec-lifecycle.mjs" handoff <SPEC_PATH>` verbatim. That boundary hands off empty execution to OPERATION=PLAN; inspect non-empty execution through its own runtime. MODE=CLOSE remains explicit.

Report status, changes, decisions, findings and validations/transitions/violations without duplicating content or reasoning.
