# File Purpose Header

```yaml
purpose: Store material risks for <feature>.
status: draft
read_when: A slice links R-### IDs or readiness validation checks risk coverage.
do_not_read_when: The current slice links no risks and risk absence is explicit in the index.
contains: R-### artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME may update; finalizer may append durable risks after a fully successful round.
```

# Risks

### R-001 - <Risk title>

```yaml
id: R-001
status: open
risk: <What could go wrong.>
impact: low | medium | high
mitigation: <How the spec constrains or handles the risk.>
linked_artifacts: [SL-001, C-001]
```
