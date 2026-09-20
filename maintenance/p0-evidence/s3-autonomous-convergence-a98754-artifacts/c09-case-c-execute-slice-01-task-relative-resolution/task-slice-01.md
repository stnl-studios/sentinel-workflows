# File Purpose Header

```yaml
purpose: Pristine checklist and execution record for Todo persistence compatibility.
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
- Requirements authority: sha256:c16ab980e94f84cc70348308f631cad48eede997236a81a3313154afe57a9624
- Plan revision: 1
- Global tasks: `../tasks.md`

## Checklist

- [x] 1.1 Validar formatos legado e archived | observable result: registros legados e registros com archived booleano são aceitos sem migração implícita | expected areas: `../../../../src/validation.mjs`; validação de persistência | requirement: R-003, R-010; AC-003, AC-010
- [x] 1.2 Preservar leitura e escrita atômica | observable result: leitura normaliza archived somente em memória e escrita persiste estados ordenados sem alterar bytes legados durante read | expected areas: `../../../../src/todo-store.mjs`; adaptador de storage | requirement: R-003, R-010; AC-003, AC-010
- [x] 1.3 Provar compatibilidade do storage | observable result: testes cobrem bytes legados, round-trip archived e formas inválidas | expected areas: `../../../../test/todo-store.test.mjs`; testes de persistência | requirement: R-003, R-010; AC-003, AC-010

## Expected Tests

- `node --test test/todo-store.test.mjs`
- Ler fixture legado sem `archived`, confirmar `archived=false` em memória e bytes inalterados após leitura.
- Confirmar round-trip de ativos e arquivados em ordem de id e rejeição de valores/formas inválidas.

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
  - runner returned Tested state path `../../../src/validation.mjs`, which resolves from dirname(tasks/slice-01.md) to `/.../specs/src/validation.mjs` instead of physical target `/.../src/validation.mjs`
  - runner returned Tested state path `../../../test/todo-store.test.mjs`, which resolves from dirname(tasks/slice-01.md) to `/.../specs/test/todo-store.test.mjs` instead of physical target `/.../test/todo-store.test.mjs`
- Required action: resume EXECUTE_SLICE for slice-01 with a runner response using canonical task-relative Tested state paths

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

- Validação aceita registros legados e explícitos, normaliza archived=false em memória e os testes cobrem leitura sem reescrita, round-trip ordenado e rejeição de tipos inválidos.

## Final Result

- pending
