Use `stnl-spec-lifecycle-manager`.
MODE=INIT

SPEC:
- <SPEC_PATH>

Fonte de requisitos:
- <REQUIREMENTS_SOURCE>

Objetivo:
- criar ou amadurecer uma SPEC documental independente

Entrada mínima:
- problema, objetivo ou mudança desejada
- decisões já conhecidas: <KNOWN_DECISIONS_OR_NONE>

Escopo:
- entra: clareza documental, critérios, riscos, restrições e perguntas bloqueantes
- fora: plano de execução, tasks e implementação

Contexto disponível:
- fonte de requisitos informada
- decisões já conhecidas e perguntas materiais, quando existirem

Resultado esperado:
- artefatos da SPEC criados ou atualizados
- perguntas bloqueantes persistidas quando faltarem decisões materiais
- retorno curto com status, caminho e próximo MODE

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
