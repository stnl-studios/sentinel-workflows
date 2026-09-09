# File Purpose Header

```yaml
purpose: Show the explicit INIT command sequence for a requirements refinement.
status: not_applicable
read_when: Preparing a first refinement from imperfect requirements.
do_not_read_when: Reconciling an existing refinement.
contains: Default-path inspect and generate commands.
owner: stnl-requirements-refiner
update_policy: Keep synchronized with runtime CLI contracts.
```

# INIT example

```sh
node "<SKILL_ROOT>/runtime/inspect-refinement.mjs" INIT /canonical/project
node "<SKILL_ROOT>/runtime/generate-refinement.mjs" INIT /canonical/project /os/temp/refinement-candidate.json
```

The candidate accepts free-form or structured sources. The second command publishes `docs/refinement/refinement.json` and `docs/refinement/index.html` together. A semantic `handoff.outcome=BLOCKED` still returns operational status `INITIALIZED`.
