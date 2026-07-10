Use `stnl-spec-execution-manager`.
OPERATION=VALIDATE_SLICE
SLICE=<NN>

Execution root:
- <EXECUTION_ROOT>

Foco adicional:
- <VALIDATION_FOCUS_OR_NONE>

Evidências já disponíveis:
- <AVAILABLE_EVIDENCE_OR_NONE>

Objetivo:
- validar a slice de forma independente e somente leitura para código

Escopo:
- entra: diff da slice, requisitos referenciados, `plan.md`, `plans/slice-NN.md`, `tasks/slice-NN.md`, evidências de teste e código necessário para verificar o diff
- fora: correção de código, atualização de `tasks.md`, marcação `[x]` e commit

Resultado esperado:
- identificar divergências, testes faltantes, código morto e mudanças fora da slice
- se `validation` estiver pendente, persistir `validation: PASS` ou `validation: NEEDS_FIX`
- se `validation` estiver `NEEDS_FIX`, houver correções e `revalidation` estiver pendente, persistir `revalidation: PASS` ou `revalidation: NEEDS_FIX`
- bloquear estados incompatíveis e não sobrescrever o histórico da validação inicial
- retornar exatamente um verdict: `PASS` ou `NEEDS_FIX`; manter o resumo curto nos findings persistidos

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
