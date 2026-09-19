Use `stnl-task-materializer`.
OPERATION=MATERIALIZE_TASKS
SPEC_PATH={{SPEC_PATH}}

Para cada caminho concreto em `expected areas`, primeiro resolva a referência aprovada a partir do artifact que a declarou e depois recalcule o claim a partir do próprio arquivo `SPEC_PATH/execution/tasks/slice-NN.md`: `path.relative(path.dirname(taskPath), physicalTarget)`, normalizado para `/`. Não copie, encurte nem ajuste por texto o caminho do plan; `execution/`, `plans/` e `tasks/` são bases diferentes. Em um SPEC aninhado em `workspace/specs/benchmark-case-a`, um alvo `workspace/src/todo-service.mjs` deve aparecer no task como `../../../../src/todo-service.mjs`; `../../../src/todo-service.mjs` resolveria para `workspace/specs/src/todo-service.mjs` e deve ser rejeitado, sem fallback.

Contexto adicional (opcional):
