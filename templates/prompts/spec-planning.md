Use `stnl-spec-lifecycle-manager`.
MODE=PLANNING

SPEC:
- <SPEC_PATH>

Foco adicional:
- <PLANNING_REVIEW_FOCUS_OR_NONE>

Objetivo:
- revisar a prontidão documental da SPEC para planejamento posterior

Entrada mínima:
- `feature_spec.md` e artefatos compartilhados da SPEC

Escopo:
- entra: clareza, consistência, critérios, decisões, riscos, restrições e perguntas abertas
- fora: alteração de arquivos, plano de execução, tasks e implementação

Contexto disponível:
- `feature_spec.md`
- artefatos compartilhados e perguntas abertas da SPEC

Resultado esperado:
- retornar `READY` ou `NEEDS_RESUME`
- listar somente achados acionáveis com referências quando houver
- indicar apenas os artefatos relevantes para cada achado
- não modificar artefatos

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
