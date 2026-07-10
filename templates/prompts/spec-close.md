Use `stnl-spec-lifecycle-manager`.
MODE=CLOSE

SPEC:
- <SPEC_PATH>

Objetivo:
- fechar documentalmente a SPEC sem depender de execução

Entrada mínima:
- SPEC ativa sem perguntas `open`; perguntas apenas `resolved`, `bypassed` ou `dropped`

Escopo:
- entra: consistência documental, artefato final e bloqueios documentais
- fora: plano de execução, tasks, diff, testes e implementação

Contexto disponível:
- `feature_spec.md` e artefatos compartilhados da SPEC
- decisões, critérios, riscos e perguntas já persistidos

Resultado esperado:
- conteúdo durável consolidado e verificado antes da remoção de `shared/`
- fechamento persistido apenas quando todos os gates documentais passarem
- diretórios externos, incluindo `execution/`, confirmados como inalterados
- bloqueios documentais registrados quando necessário
- retorno curto com status, arquivo final e bloqueios

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
