# File Purpose Header

```yaml
purpose: Show the explicit default-path INIT invocation sequence for a SPEC roadmap.
status: not_applicable
read_when: Preparing a first roadmap from broad requirements.
do_not_read_when: Reconciling an existing roadmap.
contains: Default-path inspect and generate commands.
owner: stnl-spec-roadmap
update_policy: Keep synchronized with runtime CLI contracts.
```

# INIT example

```sh
node "<SKILL_ROOT>/runtime/inspect-roadmap.mjs" INIT /canonical/project
node "<SKILL_ROOT>/runtime/generate-roadmap.mjs" INIT /canonical/project /os/temp/roadmap-candidate.json
```

The second command creates `docs/roadmap/roadmap.json` and `docs/roadmap/index.html` as one owned pair.
