# File Purpose Header

```yaml
purpose: Show stale-write-safe RECONCILE for an existing SPEC roadmap.
status: not_applicable
read_when: New scope, decisions, source changes, or canonical SPEC state affect a roadmap.
do_not_read_when: Initializing the first roadmap.
contains: Reconcile inspection, expected fingerprint, and generation commands.
owner: stnl-spec-roadmap
update_policy: Keep synchronized with runtime CLI contracts.
```

# RECONCILE example

```sh
node "<SKILL_ROOT>/runtime/inspect-roadmap.mjs" RECONCILE /canonical/project
node "<SKILL_ROOT>/runtime/generate-roadmap.mjs" RECONCILE /canonical/project /os/temp/roadmap-candidate.json sha256:<inspected-model-hash> sha256:<inspected-authority-hash>
```

Carry the exact `expected_fingerprint` and `authority_fingerprint` returned by inspection. A concurrent roadmap or authority change blocks publication.
