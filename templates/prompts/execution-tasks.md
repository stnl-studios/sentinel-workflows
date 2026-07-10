Use `stnl-spec-execution-manager`.
OPERATION=MATERIALIZE_TASKS

Execution root:
- <EXECUTION_ROOT>

Granularidade excepcional:
- <EXCEPTIONAL_GRANULARITY_OR_NONE>

Observações conhecidas:
- <KNOWN_NOTES_OR_NONE>

Objetivo:
- materializar tarefas operacionais a partir do plano aprovado

Entrada mínima:
- `plan.md`
- todos os `plans/slice-NN.md` aprovados
- requisitos citados necessários para critérios objetivos

Escopo:
- entra: `tasks.md`, todos os `tasks/slice-NN.md`, checklist numerado, áreas esperadas, aceite por task e testes esperados
- fora: nova exploração ampla da codebase e implementação

Resultado esperado:
- `tasks.md` criado ou atualizado como autoridade global de progresso
- todos os `tasks/slice-NN.md` criados
- nenhuma implementação realizada

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
