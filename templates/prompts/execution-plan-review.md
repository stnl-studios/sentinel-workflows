Use `stnl-spec-execution-manager`.
OPERATION=REVIEW_PLAN

Execution root:
- <EXECUTION_ROOT>

Foco adicional da revisão:
- <REVIEW_FOCUS_OR_NONE>

Riscos já suspeitos:
- <KNOWN_RISKS_OR_NONE>

Objetivo:
- revisar e corrigir diretamente o plano de execução quando necessário

Escopo:
- entra: tamanho das slices, dependências ocultas, ordem, cobertura dos requisitos, estado compartilhado, migrações, integrações externas, breaking changes, testabilidade e paralelização
- fora: criação de tasks, implementação de código e replanejamento sem evidência

Contexto disponível:
- `plan.md`
- `plans/slice-NN.md` relevantes
- requisitos referenciados e código somente para riscos concretos

Resultado esperado:
- plano ajustado nos artefatos quando houver correção necessária
- bloqueios registrados quando a correção exigir decisão externa
- nenhuma task criada e nenhum código implementado

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
