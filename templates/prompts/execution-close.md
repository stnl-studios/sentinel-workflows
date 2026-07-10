Use `stnl-spec-execution-manager`.
OPERATION=CLOSE

Fonte de requisitos:
- <SPEC_PATH>

Execution root:
- <EXECUTION_ROOT>

Política explícita de fechamento:
- <CLOSE_POLICY>; use somente `validate_only`, `validate_and_keep` ou `validate_and_remove`

Objetivo:
- fechar ou auditar a execução sem alterar a fonte de requisitos

Escopo:
- entra: verificação cruzada de requisitos, `plan.md`, `tasks.md`, planos, tasks detalhadas, código, testes, findings e evidências
- fora: alteração da fonte de requisitos, remoção implícita de artefatos e consolidação não solicitada

Resultado esperado:
- confirmar conclusão das slices, testes e validações
- detectar inconsistências ou bloqueios
- aplicar remoção somente quando a política for `validate_and_remove` e a validação passar
- retornar status, política aplicada, bloqueios e arquivos finais relevantes

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
