# File Purpose Header

```yaml
purpose: Define the owner-visible validation environment discovery and selection forms.
status: ready
read_when: Resolving validation environments before an independent planning invocation.
do_not_read_when: Interpreting persisted evidence or changing validation implementation.
contains: Discovery statuses, valid choice forms, cache confirmation, and planner/bridge separation.
owner: stnl-slice-executor
update_policy: Keep synchronized across validation owners and the installed entrypoint contract.
```

# Validation environment selection

Use one choice per discovery scope:

- `{}` is sufficient only when every scope is already `resolved` from structured, unequivocal project configuration.
- `{"scope":"optionId"}` is sufficient for a concrete discovered option that does not require direct Compose confirmation. An option ID with empty `authoritySources` is not confirmation.
- `{"scope":{"configurationPath":"shared/compose.yml","service":"api-check"}}` is required for a `confirmation-required` Compose candidate.
- Add `cacheVolumes:[{"source":"name","target":"/absolute/container/path"}]` only when the operator explicitly confirms those exact bindings and discovery lists each binding in `availableCacheVolumes`. Omission authorizes no cache.

Prose that merely mentions a Compose file and service is an `instructionReferences` candidate, not documentary authority. Review it for prohibitions, examples, stale guidance, and conflicts. A source reported in `conflictingInstructionReferences` requires clarification and cannot be silently overridden by a syntactically valid choice; other prose-only candidates still require direct confirmation. Structured launch/task configuration may remain documentary authority when it unambiguously binds the component, cwd, Compose file, service, and image.

If the operator names a project file that discovery has not inspected, add that exact aggregate-relative file only to the affected scope's bounded `references`, rerun discovery, and resolve the new fingerprint. Never fabricate `authoritySources`, edit discovery output, or make the plan authorize its own environment.

Give the resolved selection descriptor to the planner as a read-only restriction. After the planner independently returns a plan, pass the same owner-held descriptor separately to `--execute-plan`; do not copy confirmation fields into the plan. The bridge, not the owner or planner, binds a document-free confirmation into harness evidence. Owners never reconstruct the evidence envelope.
