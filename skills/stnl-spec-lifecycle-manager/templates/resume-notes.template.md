# File Purpose Header

```yaml
purpose: Store minimal resume state for <feature>.
status: draft
read_when: Resuming the workflow or discovering the next candidate slice.
do_not_read_when: Executing an already prepared slice package.
contains: Last completed slice, next candidate, blockers, files/IDs to load, and compact continuity note.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME and developer completion keep compact and operational; do not store logs or chat history.
```

# Resume Notes

```yaml
last_completed_slice: null
next_candidate_slice: null
blocked_by: []
load_next:
  slice: null
  shared_ids: []
  lifecycle_files: []
continuity: Initial workspace created.
```
