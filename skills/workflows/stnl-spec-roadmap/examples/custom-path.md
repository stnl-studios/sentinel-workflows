# File Purpose Header

```yaml
purpose: Show initialization at an explicit repository-relative custom roadmap path.
status: not_applicable
read_when: Repository policy places roadmap artifacts outside docs/roadmap.
do_not_read_when: The default path is acceptable.
contains: Custom ROADMAP_PATH command positions and output names.
owner: stnl-spec-roadmap
update_policy: Keep synchronized with runtime CLI contracts.
```

# Custom path example

```sh
node "<SKILL_ROOT>/runtime/inspect-roadmap.mjs" INIT /canonical/project planning/spec-roadmap
node "<SKILL_ROOT>/runtime/generate-roadmap.mjs" INIT /canonical/project /os/temp/roadmap-candidate.json planning/spec-roadmap
```

The path remains repository-relative and the filenames remain exactly `roadmap.json` and `index.html`.
