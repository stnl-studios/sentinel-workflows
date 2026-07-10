Use `stnl-spec-execution-manager`.
OPERATION=CLOSE

Fonte de requisitos:
- <SPEC_PATH>

Execution root:
- <EXECUTION_ROOT>

Objetivo:
- fechar ou auditar a execução sem alterar a fonte de requisitos

Entrada mínima:
- fonte de requisitos e execution root existentes
- `tasks.md` com todas as slices concluídas ou bloqueios explícitos

Escopo:
- entra: verificação cruzada de requisitos, `plan.md`, `tasks.md`, planos, tasks detalhadas, código, testes, findings e evidências
- fora: alteração da fonte de requisitos, remoção de artefatos e consolidação não solicitada

Contexto disponível:
- fonte de requisitos
- execution root e artefatos persistidos de execução

Resultado esperado:
- confirmar conclusão das slices, testes e validações
- detectar inconsistências ou bloqueios
- retornar status, bloqueios e arquivos finais relevantes

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
