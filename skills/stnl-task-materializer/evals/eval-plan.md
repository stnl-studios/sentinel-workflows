# File Purpose Header

```yaml
purpose: Define regression expectations for task materialization.
status: not_applicable
read_when: Changing MATERIALIZE_TASKS, task templates, or approval checks.
do_not_read_when: Materializing tasks under unchanged contracts.
contains: Approved-plan prerequisites, fidelity, binary progress, and mutation boundaries.
owner: stnl-task-materializer
update_policy: Extend when task materialization loses approved-plan fidelity.
```

# MATERIALIZE_TASKS Eval Cases

1. Rejects missing, draft, unapproved, or inconsistent plans before writing.
2. Creates exactly one global row and one detailed task file per approved slice.
3. Uses only binary global checkboxes and preserves serial dependencies.
4. Never invents work; changes canonical planning artifacts only as part of an approved atomic pristine replacement.
5. Rejects partial/malformed task sets and preserves bytes outside the authorized candidate.
6. Validates and renders the entire set before publishing, leaving no partial artifacts on failure.
7. Renders a real pristine task with sentinels only; no fake check, attempt, finding, divergence, or example heading is persisted.
8. A wholly pristine approved replacement atomically replaces only canonical plans/tasks and leaves the new task set pristine.
9. After operational evidence, commits only an approved append-only extension and exact supersession fields; historical PASS and evidence remain unchanged.
10. Supersession terminalizes the named open predecessor as `[x]`/`SUPERSEDED` with replacement pointer while appending the new active task.
11. Rejects stale fingerprints, non-increasing revisions/slices, or history mutation.
