# File Purpose Header

```yaml
purpose: Show a ready modular SPEC with only meaningful shared categories.
status: ready
read_when: A concrete active workspace layout is needed.
do_not_read_when: Only a blocked or closed shape is needed.
contains: Tree and compact artifact-discovery example.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with the workspace and schema references.
```

# Modular Workspace

```text
specs/invitation-expiration/
├── feature_spec.md
└── shared/
    ├── acceptance-criteria.md
    ├── constraints.md
    └── risks.md
```

The feature document declares the objective, scope, business rules, and these artifact paths. `acceptance-criteria.md` contains `AC-001` and `AC-002`; `constraints.md` contains `C-001`; `risks.md` contains `R-001`. There are no empty decisions or questions files because neither category has content.
