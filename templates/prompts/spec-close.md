Use `stnl-spec-lifecycle-manager`.
MODE=CLOSE

SPEC:
- <SPEC_PATH>

Objetivo:
- fechar documentalmente a SPEC sem depender de execução

Entrada mínima:
- SPEC ativa com critérios, decisões e perguntas resolvidas ou justificadas

Escopo:
- entra: consistência documental, artefato final e bloqueios documentais
- fora: plano de execução, tasks, diff, testes e implementação

Contexto disponível:
- `feature_spec.md` e artefatos compartilhados da SPEC
- decisões, critérios, riscos e perguntas já persistidos

Resultado esperado:
- fechamento persistido quando a SPEC estiver pronta
- bloqueios documentais registrados quando necessário
- retorno curto com status, arquivo final e bloqueios

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
