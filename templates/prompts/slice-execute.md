Use `stnl-spec-execution-manager`.
OPERATION=EXECUTE_SLICE
SLICE=<NN>

Fonte de requisitos:
- <SPEC_PATH>

Execution root:
- <EXECUTION_ROOT>

Objetivo:
- <SLICE_OBJECTIVE>

Entrada mínima:
- `plan.md`, `tasks.md`, `plans/slice-NN.md` e `tasks/slice-NN.md`
- requisitos referenciados pela slice selecionada

Escopo:
- entra: <ADDITIONAL_IN_SCOPE_OR_NONE>
- fora: <ADDITIONAL_OUT_OF_SCOPE_OR_NONE>

Contexto disponível:
- <RECENT_CONTEXT_OR_NONE>
- arquivos e testes descobertos a partir da slice selecionada

Resultado esperado:
- implementar somente a slice selecionada
- entre os artefatos de execução, atualizar somente `tasks/slice-NN.md`
- alterar apenas o código e os testes necessários para a slice selecionada
- marcar tasks individuais concluídas
- executar testes aplicáveis
- registrar arquivos alterados, expansão necessária e resumo do diff
- não marcar a slice global como `[x]`
- não finalizar, não iniciar outra slice e não criar commit

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
