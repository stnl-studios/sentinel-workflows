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

# Slice 01 Tasks - Modelo arquivado e compatibilidade legada

## References

- Slice: 01
- Plan: `../plans/slice-01.md`
- Requirements source: `../../feature_spec.md`
- Requirements authority: sha256:ceb301c2ac77f830c8ec8927f895948eb7f611f5b6acc9a8e5c3e7a9e219947b
- Plan revision: 1
- Global tasks: `../tasks.md`

## Checklist

- [x] 1.1 Normalizar o campo archived compatível | observable result: Todos legados tornam-se ativos em memória sem migração ou escrita | expected areas: `../../../../src/validation.mjs` | requirement: R-005; AC-008
- [x] 1.2 Preservar o limite de leitura e escrita | observable result: O formato ampliado mantém todos, IDs e ordem estável | expected areas: `../../../../src/todo-store.mjs` | requirement: R-007; AC-011; C-001
- [x] 1.3 Cobrir compatibilidade persistida | observable result: Testes provam leitura legada sem mutação, round-trip e rejeições | expected areas: `../../../../test/todo-store.test.mjs` | requirement: R-005; R-007; AC-008; AC-011

## Expected Tests

- Testes unitários do store para ler Todos sem `archived` como ativos sem alterar o arquivo.
- Testes de round-trip para `archived=true` e `archived=false`, preservando completed, IDs e ordem.
- Testes negativos para `archived` não booleano e propriedades fora das formas aceitas.
- Execução da suíte Node com `npm test` ao final da slice.

## Changed Areas

- `../../../../src/todo-store.mjs`
- `../../../../src/validation.mjs`
- `../../../../test/todo-store.test.mjs`

## Scope Expansion

- none

## Prior Validation Overlap

- none

## Divergences

- none

## Delegation Blocker

- none

## Implementation Test Evidence

### implementation-check-01

- Automatic check round: 1/3
- Status: BLOCKED
- HEAD: d05f8d47c8eec59cebb06e795b5354ac6aaef1c8
- Tested scope: Slice-01 storage compatibility
- Tested state:
  - `../../../../src/todo-store.mjs` | sha256:95f27e05fec20b553f137abd3a4071f2abf7c4ce350086e752e7a103c6a3dc38
  - `../../../../src/validation.mjs` | sha256:c8bd197491229d25b293ef407aee7725dcbafbc4a12ddba2c0a4dea8e9d8e078
  - `../../../../test/todo-store.test.mjs` | sha256:e2af39f4da044f33a6e4659c2813a4f7290012ae017dd6d37b2ad70d4dd38eaf
- Discovery sources: execution/plans/slice-01.md; execution/tasks/slice-01.md; shared/requirements.md; package.json
- Discovery actions: read-only artifact inspection; independent runner discovery; git status; git rev-parse HEAD; diff inspection
- Verification types considered: Node unit tests
- Commands: none
- Selected checks: npm test (not executed)
- Selection rationale: Authoritative package script identified; runner blocked before verification command.
- Coverage: Not established because verification was not started.
- Failures: none
- Blockers: Runner reported a producer-authority comparison against a separately computed raw requirements digest; official preflight and selected artifacts agree, so no documentary divergence is created.
- Unexpected workspace effects: none
- Persistence summary: Persisted the valid runner BLOCKED result as implementation-check-01; no correction, retry, divergence, or formal validation was performed.

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

- Added strict optional archived-state validation, legacy in-memory normalization, expanded persistence, and focused store compatibility coverage.

## Final Result

- pending
