Use `stnl-spec-execution-manager`.
OPERATION=FINALIZE_SLICE
SLICE=<NN>

Execution root:
- <EXECUTION_ROOT>

Objetivo:
- concluir a slice somente quando todos os critérios de conclusão estiverem satisfeitos

Entrada mínima:
- `plan.md`, `tasks.md`, `plans/slice-NN.md` e `tasks/slice-NN.md`
- evidências de teste, validação, findings, correções, revalidação e diff final

Escopo:
- entra: verificação do checklist, testes, validation, findings, correções, revalidation e isolamento do diff
- fora: implementação, correção de código, próxima slice e commit automático

Resultado esperado:
- se a validação inicial for `PASS`, registrar `revalidation: not_required`
- se a validação inicial for `NEEDS_FIX`, exigir correções registradas e `revalidation: PASS`
- bloquear quando findings, correções ou revalidação forem incompatíveis
- atualizar o resultado final da slice
- marcar a slice como `[x]` em `tasks.md` somente se tudo estiver satisfeito

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
