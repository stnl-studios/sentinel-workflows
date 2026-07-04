# File Purpose Header

```yaml
purpose: Define stable canonical IDs for every SPEC artifact.
load_when: Creating, resuming, validating, or closing a spec that contains canonical artifacts.
do_not_load_when: The task is unrelated to SPEC structure or artifact references.
contains: ID formats, stability rules, invalid formats, next-ID calculation, and reference rules.
owner: stnl-spec-lifecycle-manager
update_policy: Treat as invariant contract. Change only with deliberate migration.
```

# Canonical IDs

Every canonical artifact in the SPEC must have a stable ID.

## Allowed formats

| Artifact | Format | Example |
|---|---|---|
| Open questions | `Q-###` | `Q-001` |
| Decisions | `D-###` | `D-001` |
| Acceptance criteria | `AC-###` | `AC-001` |
| Slices | `SL-###` | `SL-001` |
| Risks | `R-###` | `R-001` |
| Constraints | `C-###` | `C-001` |

`###` means sequential, zero-padded, three-digit numeric suffix.

## Forbidden formats

Do not create, preserve as new, or normalize into these formats silently:

- `F-001`
- `S-001`
- `Slice 1`
- `SLICE - 001`
- `Question 1`
- `Decision A`
- `AC1`
- `Risk-001`
- any non-zero-padded format;
- any alternate casing or spacing.

There are no legacy specs in this system. If an invalid ID appears, treat the spec as contract-violating and block until corrected in an allowed mode.

## Required placement

Every canonical artifact must include the ID twice:

1. in the Markdown heading;
2. in an explicit `id:` field inside the item.

Example:

```markdown
### AC-001 — User can create an invitation

id: AC-001
status: active

The user can create an invitation with a valid expiration date.
```

## Stability rules

- Never renumber IDs.
- Never reuse an ID after deletion, dropping, superseding, or closure.
- Never fill gaps.
- Preserve existing valid IDs exactly as written.
- Do not change ID casing, separator, or zero-padding.
- Do not reference canonical artifacts only by title when an ID exists.

## Next-ID calculation

For each artifact type, compute the next ID from the highest existing numeric suffix of that type.

Examples:

| Existing IDs | Next ID |
|---|---|
| `AC-001`, `AC-002`, `AC-005` | `AC-006` |
| `Q-001`, `Q-003` | `Q-004` |
| `SL-001`, `SL-002` | `SL-003` |

Never reuse gaps.

## Reference rules

Use IDs in dependencies, acceptance coverage, decisions, risks, constraints, questions, slice links, and traceability.

Good:

```markdown
linked_acceptance_criteria: [AC-001, AC-003]
linked_constraints: [C-001]
blocked_by: [Q-002]
```

Bad:

```markdown
linked_acceptance_criteria: ["create invitation"]
blocked_by: ["permission question"]
```

## Invalid ID behavior by MODE

| MODE | Behavior |
|---|---|
| `INIT` | Do not create invalid IDs. If source material contains invalid IDs, ask whether to start a clean spec. |
| `RESUME` | Block and require correction. There are no supported legacy migrations by default. |
| `PLANNING` | Return `invalid_canonical_ids` and block readiness. |
| `CLOSE` | Do not close until invalid IDs are corrected or removed as noise. |
