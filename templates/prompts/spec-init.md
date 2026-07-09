Use `stnl-spec-lifecycle-manager`.
MODE=INIT

Objetivo:
- criar uma nova SPEC slice-driven para: [feature, bugfix, mudança ou iniciativa]

Entrada mínima:
- [descreva o problema, objetivo ou mudança em poucas linhas]

Escopo:
- entra: [fluxos, módulos, endpoints, telas, jobs, contratos ou "não informado"]
- fora: [o que não deve entrar ou "não informado"]

Contexto disponível:
- regras conhecidas: [...]
- decisões já tomadas: [...]
- restrições técnicas/produto: [...]
- evidências iniciais: [...]

Resultado esperado:
- criar workspace modular em `specs/<feature-slug>/` quando não houver caminho mais específico
- criar `feature_spec.md` como índice compacto, não como spec monolítica
- criar arquivos compartilhados somente para categorias materializadas
- criar um arquivo `slices/SL-###.md` por slice quando houver sinal suficiente
- criar `lifecycle/traceability.md`, `lifecycle/qa-checklist.md` e `lifecycle/resume-notes.md`
- criar perguntas `Q-001+` se houver dúvidas bloqueantes
- criar ACs, decisões, riscos e constraints com IDs canônicos quando aplicável
- se houver pergunta aberta, manter readiness bloqueada e não criar slice `ready`

Restrições excepcionais:
- [somente se houver]

