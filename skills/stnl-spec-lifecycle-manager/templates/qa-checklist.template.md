# File Purpose Header

```yaml
purpose: Store the Spec Quality Gate for <feature>.
status: draft
read_when: INIT, RESUME, PLANNING, or developer completion validates workspace quality.
do_not_read_when: Implementing or reviewing code for a prepared slice package.
contains: Compact quality gate status and ID-based blockers only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME and developer completion update only to reflect real workspace state.
```

# QA Checklist

```yaml
qa_checklist:
  spec_quality_gate:
    status: incomplete
    blockers: []
    checks:
      canonical_ids: pass
      workspace_paths: pass
      open_questions: pass
      acceptance_coverage: fail
      anti_drift_constraints: fail
      risk_coverage: fail
      traceability: pass
      slice_readiness: fail
      validation_hints: fail
```
