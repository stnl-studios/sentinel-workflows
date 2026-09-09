# File Purpose Header

```yaml
purpose: Show stale-write-safe RECONCILE with a resolution or bypass update.
status: not_applicable
read_when: New information changes findings, evidence, sources, or handoff.
do_not_read_when: Initializing the first refinement.
contains: Reconcile inspection, fingerprint binding, and candidate publication.
owner: stnl-requirements-refiner
update_policy: Keep synchronized with runtime CLI and model contracts.
```

# RECONCILE example

```sh
node "<SKILL_ROOT>/runtime/inspect-refinement.mjs" RECONCILE /canonical/project
node "<SKILL_ROOT>/runtime/generate-refinement.mjs" RECONCILE /canonical/project /os/temp/refinement-candidate.json sha256:<inspected-model-hash> sha256:<inspected-authority-hash>
```

Carry the exact two fingerprints from inspection. A proposal is validated in the replacement model; rejected/inconclusive proposals keep the same finding open, while an explicit bypass records its reason and known risk.

An accepted proposal records the absence of a newly introduced gap as a positive assertion:

```json
"checks": {
  "behavior_defined": "PASS",
  "ambiguity_closed": "PASS",
  "repository_consistent": "PASS",
  "no_new_gap_introduced": "PASS",
  "problem_fully_addressed": "PASS"
}
```
