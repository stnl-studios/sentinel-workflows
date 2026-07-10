# File Purpose Header

```yaml
purpose: Template for the checklist and complete operational evidence of one execution slice.
status: ready
read_when: Executing, validating, correcting, revalidating, finalizing, or auditing this slice.
do_not_read_when: A different slice is active and does not depend on this detailed evidence.
contains: Plan reference, checklist, expected areas, acceptance, tests, actual changes, scope expansion, divergences, evidence, findings, corrections, revalidation, diff summary, and final result.
owner: stnl-spec-execution-manager
update_policy: MATERIALIZE_TASKS creates; EXECUTE_SLICE, VALIDATE_SLICE, APPLY_FINDINGS, and FINALIZE_SLICE update this slice record.
```

# Slice 01 Tasks - <Name>

## Referências

- Slice: 01
- Plano: `../plans/slice-01.md`
- Fonte de requisitos: `<relative path from this file>`
- Índice global: `../tasks.md`

## Checklist

- [ ] 1.1 <task> | expected areas: <paths or systems> | acceptance: AC-001
- [ ] 1.2 <task> | expected areas: <paths or systems> | acceptance: AC-001

## Expected Tests

- <Relevant test, suite, command, or observable check.>

## Changed Areas

- pending

## Scope Expansion

- none

## Divergências

- nenhuma

## Execution Evidence

- Testes executados: nenhum
- Resultado dos testes: pending
- Validação: pending
- Correções: nenhuma
- Revalidação: pending

Use `Resultado dos testes: PASS` only with at least one real test item. If no test applies, use `Resultado dos testes: not_applicable` and one objective `Justificativa sem teste`. Omit that justification when tests run.

## Validation Findings

- pending

## Corrections Applied

- pending

## Revalidation

- pending

## Diff Summary

- pending

## Final Result

- pending
