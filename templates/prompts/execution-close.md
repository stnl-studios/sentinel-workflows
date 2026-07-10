Use `stnl-spec-execution-manager`.
OPERATION=CLOSE

Fonte de requisitos:
- <SPEC_PATH>

Execution root:
- <EXECUTION_ROOT>

Objetivo:
- validar e reportar o estado final da execução sem alterar artefatos

Entrada mínima:
- fonte de requisitos e execution root existentes
- `tasks.md` com todas as slices concluídas ou bloqueios explícitos

Escopo:
- entra: verificação cruzada de requisitos, `plan.md`, `tasks.md`, planos, tasks detalhadas, código, testes, findings e evidências
- fora: alteração da fonte de requisitos, artefatos da lifecycle manager, código, artefatos de execução, remoção de arquivos, retenção e limpeza

Contexto disponível:
- fonte de requisitos
- execution root e artefatos persistidos de execução

Resultado esperado:
- confirmar conclusão das slices, testes e validações
- detectar inconsistências, slices incompletas, divergências bloqueantes, findings bloqueantes e lacunas de evidência
- retornar status, bloqueios e arquivos finais relevantes
- não modificar nem remover nenhum artefato

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
