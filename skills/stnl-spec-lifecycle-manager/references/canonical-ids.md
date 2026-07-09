# File Purpose Header

```yaml
purpose: Define stable canonical IDs and reference rules for an independent SPEC.
status: not_applicable
read_when: Creating, resuming, reviewing, or closing canonical SPEC artifacts.
do_not_read_when: A document section has no canonical item or cross-reference.
contains: Allowed ID formats, stability rules, references, and next-ID calculation.
owner: stnl-spec-lifecycle-manager
update_policy: Change only through a deliberate compatibility decision.
```

# Canonical IDs

Canonical artifacts use only these formats:

| Artifact | Format |
|---|---|
| Questions | `Q-###` |
| Decisions | `D-###` |
| Acceptance criteria | `AC-###` |
| Risks | `R-###` |
| Constraints | `C-###` |

Each item has its ID in the Markdown heading and an explicit YAML `id:` field. Preserve every valid existing ID exactly: never renumber, reuse, fill gaps, or change casing. Refer to a materialized item by its ID, not its title alone.

Allocate a new ID from the highest suffix of that type across the workspace. Deleted, superseded, or skipped IDs remain reserved. A referenced ID must exist in its materialized category; a missing, malformed, or ambiguous reference blocks documentary readiness and closure.
