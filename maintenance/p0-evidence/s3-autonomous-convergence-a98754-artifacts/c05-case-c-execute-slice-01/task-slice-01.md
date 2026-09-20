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

# Slice 01 Tasks - Archive-aware persistence compatibility

## References

- Slice: 01
- Plan: `../plans/slice-01.md`
- Requirements source: `../../feature_spec.md`
- Requirements authority: sha256:bca2f51fa8ea7002534bc02f5d6121c7f2e21a11a6c3c945ea8789c666de55ed
- Plan revision: 1
- Global tasks: `../tasks.md`

## Checklist

- [x] 1.1 Update persisted Todo validation for legacy and archive-aware records | observable result: legacy records read as active while invalid archive values remain rejected | expected areas: `../../../../src/validation.mjs`; persisted-shape validation | requirement: AC-011
- [x] 1.2 Preserve Todo storage order and read-only legacy bytes | observable result: reads do not rewrite storage and writes retain archived records in persisted order | expected areas: `../../../../src/todo-store.mjs`; store compatibility | requirement: AC-011, AC-015
- [x] 1.3 Prove persistence compatibility and dependency boundaries | observable result: focused store coverage verifies byte preservation, round trips, ordering, failures, and no dependency expansion | expected areas: `../../../../test/todo-store.test.mjs`; `../../../../package.json`; focused coverage and dependency boundary | requirement: AC-011, AC-015

## Expected Tests

- Run the Todo store suite for legacy reads, archive-aware round trips, invalid archive values, order preservation, and atomic write failures.
- Run the complete existing test suite and inspect the dependency manifest for migration or dependency additions.

## Changed Areas

- none

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
- Tested scope: none
- Tested state: none
- Fileless reason: Verification impedida por caminhos de autoridade inexistentes.
- Discovery sources: package.json; specs/benchmark-case-c/execution/plan.md; specs/benchmark-case-c/execution/tasks/slice-01.md; specs/benchmark-case-c/shared/requirements.md
- Discovery actions: inspeção read-only de arquivos, `git status`, `git rev-parse HEAD`, verificação dos caminhos fornecidos e SHA-256
- Verification types considered: testes unitários e suíte completa Node.js
- Commands: none
- Selected checks: none
- Selection rationale: Autoridade da slice não resolvida devido aos paths fornecidos inexistentes.
- Coverage: none
- Failures: none
- Blockers: `SPEC_PATH`, `EXECUTION_ROOT`, `PLAN_PATH` e `TASK_PATH` fornecidos não existem na sessão delegada; os artefatos reais estão sob o workspace da sessão.
- Unexpected workspace effects: nenhum; estado Git permaneceu inalterado.
- No verification-command confirmation: Nenhum verification command foi executado.
- Persistence summary: Persistir o bloqueio oficial da rodada 1/3; não executar verificação, não corrigir e encerrar em AUXILIARY_BLOCKED.

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

- Added archive-aware persisted Todo validation with a false default for legacy records and strict boolean rejection.
- Preserved persisted array order during reads and writes instead of sorting by id.
- Added focused coverage for archive round-trips, legacy byte preservation, ordering, invalid archive values, and validation-failure atomicity; dependency manifest remains unchanged.

## Final Result

- pending
