# File Purpose Header

```yaml
purpose: Template for one pristine slice checklist and its empty execution and validation record.
status: ready
read_when: Materializing or classifying a pristine slice task.
do_not_read_when: Operational record schemas are needed after execution starts.
contains: References, checklist, expected tests, exact pristine sentinels, and pending final result.
owner: stnl-task-materializer
update_policy: MATERIALIZE_TASKS creates; later operations replace only their authorized sentinels using the execution-record schema.
```

# Slice 01 Tasks - Compatibilidade de persistência

## References

- Slice: 01
- Plan: `../plans/slice-01.md`
- Requirements source: `../../feature_spec.md`
- Requirements authority: sha256:556920f531f150e8dae1ec2140e0fbf1ff99b6dd53046176fcd67b0a457e4509
- Plan revision: 1
- Global tasks: `../tasks.md`

## Checklist

- [x] 1.1 Implementar validação e storage compatíveis. | observable result: dados legados são ativos sem migração por leitura e archived booleano é preservado. | expected areas: `../../../../src/validation.mjs`; validação; `../../../../src/todo-store.mjs`; storage | requirement: R-005; AC-009
- [x] 1.2 Demonstrar compatibilidade e limites de implementação. | observable result: testes preservam bytes e o manifesto continua sem dependência ou migração. | expected areas: `../../../../test/todo-store.test.mjs`; testes; `../../../../package.json`; manifesto | requirement: R-012; AC-016

## Expected Tests

- Executar a suíte de storage para leitura legada, booleanos, ordem e invariância de bytes; inspecionar manifesto e diff.

## Changed Areas

- `../../../../src/validation.mjs`
- `../../../../test/todo-store.test.mjs`

## Scope Expansion

- none

## Prior Validation Overlap

- none

## Divergences

- none

## Delegation Blocker

- Operation: EXECUTE_SLICE
- Kind: malformed-output
- State: active
- After record: none
- Causes:
  - Runner returned a raw file digest as Requirements authority evidence and reported divergence despite the official preflight, selected artifacts, and payload carrying the identical official authority token.
  - Runner output used non-canonical field names and did not conform to the required auxiliary-result schema.
- Required action: Resume EXECUTE_SLICE for slice-01 directly at delegation with the exact official preflight authority and canonical runner-result schema; do not reimplement or allocate a check before runner start.

## Implementation Test Evidence

- none

## Findings Test Evidence

- none

## Validation Attempts

- none

## Validation Findings

- none

## Corrections Applied

- none

## Effective Validation Base

- none

## Diff Summary

- A validação aceita shapes legado e com archived booleano, normaliza legado como ativo em memória e a cobertura verifica round-trip, rejeições e invariância byte a byte.

## Final Result

- pending
