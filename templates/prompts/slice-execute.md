Use `stnl-spec-execution-manager`.
OPERATION=EXECUTE_SLICE
SLICE=<NN>

Fonte de requisitos:
- <SPEC_PATH>

Execution root:
- <EXECUTION_ROOT>

Objetivo:
- <SLICE_OBJECTIVE>

Escopo adicional:
- entra: <ADDITIONAL_IN_SCOPE_OR_NONE>
- fora: <ADDITIONAL_OUT_OF_SCOPE_OR_NONE>

Contexto recente relevante:
- <RECENT_CONTEXT_OR_NONE>

Resultado esperado:
- implementar somente a slice selecionada
- atualizar somente `tasks/slice-NN.md`
- marcar tasks individuais concluídas
- executar testes aplicáveis
- registrar arquivos alterados, expansão necessária e resumo do diff
- não marcar a slice global como `[x]`
- não finalizar, não iniciar outra slice e não criar commit

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
