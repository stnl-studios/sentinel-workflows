Use `stnl-spec-execution-manager`.
OPERATION=VALIDATE_SLICE
SLICE=<NN>

Execution root:
- <EXECUTION_ROOT>

Objetivo:
- validar a slice de forma independente e somente leitura para código

Entrada mínima:
- `plans/slice-NN.md`, `tasks/slice-NN.md`, requisitos referenciados e diff da slice
- evidência de testes registrada ou justificativa objetiva

Escopo:
- entra: diff da slice, requisitos referenciados, `plan.md`, `plans/slice-NN.md`, `tasks/slice-NN.md`, evidências de teste e código necessário para verificar o diff
- fora: correção de código, atualização de `tasks.md` e marcação `[x]`

Contexto disponível:
- foco adicional: <VALIDATION_FOCUS_OR_NONE>
- evidências já disponíveis: <AVAILABLE_EVIDENCE_OR_NONE>

Resultado esperado:
- identificar divergências, testes faltantes, código morto e mudanças fora da slice
- se a validação inicial estiver pendente, persistir `Validação: PASS` ou `Validação: NEEDS_FIX`
- se a validação inicial estiver `NEEDS_FIX`, houver correções e a revalidação estiver pendente, persistir `Revalidação: PASS` ou `Revalidação: NEEDS_FIX`
- bloquear combinações incompatíveis e não sobrescrever o histórico da validação inicial
- retornar exatamente um verdict: `PASS` ou `NEEDS_FIX`; manter o resumo curto nos findings persistidos

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
