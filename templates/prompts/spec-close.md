Use `stnl-spec-lifecycle-manager`.
MODE=CLOSE

SPEC:
- <SPEC_PATH>

Política de fechamento:
- <CLOSE_POLICY>

Objetivo:
- fechar documentalmente a SPEC sem depender de execução

Entrada mínima:
- SPEC ativa com critérios, decisões e perguntas resolvidas ou justificadas

Escopo:
- entra: consistência documental, artefato final e bloqueios documentais
- fora: plano, tasks, diff, commits, testes e implementação

Resultado esperado:
- fechamento persistido quando a SPEC estiver pronta
- bloqueios documentais registrados quando necessário
- retorno curto com status, arquivo final e bloqueios

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
