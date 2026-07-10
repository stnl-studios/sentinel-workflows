Use `stnl-spec-lifecycle-manager`.
MODE=INIT

SPEC:
- {{SPEC_PATH}}

Fonte de requisitos:
- {{REQUIREMENTS_SOURCE}}

Objetivo:
- criar uma nova SPEC documental independente no menor workspace suficiente

Entrada mínima:
- workspace documental ainda inexistente em `{{SPEC_PATH}}`
- se `feature_spec.md` já existir, INIT não é aplicável; use RESUME
- problema, objetivo ou mudança desejada
- decisões já conhecidas: {{KNOWN_DECISIONS_OR_NONE}}

Escopo:
- entra: `feature_spec.md` e somente categorias materializadas necessárias, incluindo decisões quando houver conteúdo real
- fora: plano de execução, tasks, implementação e arquivos vazios
- pode iniciar com `artifacts: {}` ou SPEC `blocked` contendo apenas perguntas

Contexto disponível:
- fonte de requisitos informada
- decisões já conhecidas e perguntas materiais, quando existirem
- não invente decisões, riscos, restrições, critérios ou perguntas para completar estrutura

Resultado esperado:
- menor SPEC documental suficiente criada
- `ready` apenas quando todos os readiness gates aplicáveis da skill passarem; caso contrário, `draft` ou `blocked`
- perguntas materiais abertas explícitas
- retorno curto com status documental, arquivos criados, perguntas abertas, blockers/gaps e próxima ação documental aplicável quando houver

Restrições excepcionais:
- {{EXCEPTIONAL_CONSTRAINTS_OR_NONE}}
