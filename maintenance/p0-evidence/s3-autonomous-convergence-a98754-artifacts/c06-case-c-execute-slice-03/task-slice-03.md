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

# Slice 03 Tasks - Contratos e integração final da CLI

## References

- Slice: 03
- Plan: `../plans/slice-03.md`
- Requirements source: `../../feature_spec.md`
- Requirements authority: sha256:a134343db6cc928687edc1a08cba94cf9081abccd6f171392256f54c05405d2f
- Plan revision: 1
- Global tasks: `../tasks.md`

## Checklist

- [x] 3.1 Integrar comandos e contratos observáveis da CLI | observable result: archive, unarchive e list --archived funcionam ponta a ponta com aridade, streams, códigos, persistência e regressão dos comandos existentes | expected areas: `../../../../src/cli.mjs`; parsing e apresentação; `../../../../test/cli.test.mjs`; cenários integrados | requirement: R-001, R-002, R-003, R-004, R-005, R-006, R-007; AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007, AC-008, AC-009, AC-010, AC-011

## Expected Tests

- Executar `node --test test/cli.test.mjs` e `npm test`; verificar matriz de comandos, integridade de arquivos, regressão e ausência de dependências ou migração novas.

## Changed Areas

- `../../../../src/cli.mjs`
- `../../../../test/cli.test.mjs`

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
  - Runner returned file-backed Tested state paths src/cli.mjs and test/cli.test.mjs, which are not canonical task-relative paths from dirname(tasks/slice-03.md); required paths are ../../../../src/cli.mjs and ../../../../test/cli.test.mjs, so the output cannot be published or silently rebased.
- Required action: Resume EXECUTE_SLICE for slice-03 directly at delegation with the same minimum payload after the malformed runner result is replaced by a contract-compliant result.

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

- Integrados archive, unarchive e list --archived na CLI com usage atualizado, aridade estrita, streams e códigos de saída; adicionada cobertura ponta a ponta de persistência, filtros, somente leitura e rejeição de complete em item arquivado.

## Final Result

- pending
