Use `stnl-spec-execution-manager`.
OPERATION=APPLY_FINDINGS
SLICE=<NN>

Execution root:
- <EXECUTION_ROOT>

Findings a aplicar:
- <FINDINGS_SELECTION_OR_ALL>

Objetivo:
- corrigir somente achados validados para a slice selecionada

Entrada mínima:
- findings persistidos em `tasks/slice-NN.md`
- plano da slice, arquivos afetados, testes relacionados e requisitos diretamente envolvidos

Escopo:
- entra: correções dos findings registrados ou explicitamente selecionados e efeitos necessários
- fora: refactors oportunistas, mudanças de requisito, expansão silenciosa de escopo e finalização da slice

Resultado esperado:
- correções registradas no arquivo detalhado da slice
- testes afetados executados ou justificativa objetiva registrada
- slice pronta para revalidação
- slice não marcada como concluída

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
