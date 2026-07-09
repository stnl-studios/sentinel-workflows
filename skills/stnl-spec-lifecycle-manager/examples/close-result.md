# File Purpose Header

```yaml
purpose: Show CLOSE compaction from a modular workspace to a final one-file spec.
status: example
read_when: The agent needs a concrete CLOSE result example.
do_not_read_when: Working on INIT, RESUME, or PLANNING only.
contains: Before/after trees and compact final feature_spec.md example.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with references/close-policy.md.
```

# CLOSE Result Example

## Before `CLOSE`

```text
specs/invitation-expiration/
├── feature_spec.md
├── shared/
├── slices/
└── lifecycle/
```

## After Successful `CLOSE`

```text
specs/invitation-expiration/
└── feature_spec.md
```

## Final `feature_spec.md`

~~~markdown
# File Purpose Header

```yaml
purpose: Final feature specification for invitation expiration.
status: closed
read_when: Maintaining, extending, validating, or revisiting invitation expiration.
do_not_read_when: Looking for historical execution logs; those are intentionally not preserved.
contains: Durable objective, final scope, acceptance criteria, decisions, constraints, risks, and essential notes.
owner: stnl-spec-lifecycle-manager
update_policy: Update only through an explicit future spec lifecycle action.
```

# Invitation Expiration - Feature Spec

## Objective

Allow invitations to expire after a configured expiration timestamp so stale invitations cannot be accepted indefinitely.

## Final Scope

- Invitations with past expiration timestamps cannot be accepted.
- Invitation lookup exposes expiration state while preserving existing fields.

## Out of Scope

- Admin UI changes.
- Notifications.
- Email-template changes.

## Final Acceptance Criteria

### AC-001 - Expired invitation cannot be accepted

An invitation with an expiration timestamp in the past cannot be accepted.

### AC-002 - Expiration is observable in lookup

Invitation lookup exposes whether the invitation is expired while preserving existing fields.

## Durable Decisions

### D-001 - Preserve existing invitation lookup contract

Add expiration status without removing existing response fields.

## Relevant Constraints

### C-001 - Preserve public response compatibility

Do not remove or rename existing invitation lookup response fields.

## Relevant Risks

### R-001 - Time comparison inconsistency

Expiration behavior depends on consistent use of the system's existing time handling convention.
~~~
