# File Purpose Header

```yaml
purpose: Optional prompt template for committing one concluded phase when requested.
status: ready
read_when: A caller explicitly requests a commit after phase conclusion.
do_not_read_when: No commit was requested or phase evidence is incomplete.
contains: Commit scope and non-closure boundaries.
owner: stnl-spec-execution-manager
update_policy: Update when optional commit guidance changes.
```

If the caller requested a commit, commit only concluded phase <NN>.

Confirm `PASS` and complete phase evidence. Include only that phase's intended changes and exclude unrelated working-tree changes. A commit is optional; it does not close the requirements source or operational delivery workspace.
