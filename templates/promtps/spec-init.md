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
- criar `feature_spec.md`
- criar slices canônicas `SL-001+` somente no tamanho adequado para execução atômica
- criar perguntas `Q-001+` se houver dúvidas bloqueantes
- criar ACs, decisões, riscos e constraints com IDs canônicos quando aplicável
- se a SPEC estiver `Execution Ready`, materializar `qa_checklist`

Restrições excepcionais:
- [somente se houver]


