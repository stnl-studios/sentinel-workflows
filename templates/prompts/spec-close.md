# File Purpose Header

```yaml
purpose: Prompt template for documentary finalization of a feature SPEC.
status: ready
read_when: MODE CLOSE is requested for a document-ready SPEC.
do_not_read_when: A documentary blocker or required correction remains.
contains: Closure input, documentary cross-check, blockers, and cleanup result.
owner: stnl-spec-lifecycle-manager
update_policy: Update when CLOSE policy changes.
```

Use stnl-spec-lifecycle-manager.
MODE=CLOSE

SPEC path: <feature_spec.md or workspace>
Known documentary limits: <open questions, contradictions, or none>

Validate IDs, references, questions, scope, criteria, decisions, constraints, risks, and duplicate content. Block on unresolved documentary gaps. On success, consolidate durable content into one `feature_spec.md` and remove `shared/`. Do not require code, tests, diffs, commits, or delivery records.
