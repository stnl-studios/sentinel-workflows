Use `stnl-task-materializer`.
OPERATION=MATERIALIZE_TASKS
SPEC_PATH={{SPEC_PATH}}

Para cada caminho concreto em `expected areas`, normalize `SPEC_PATH` com a authority exportada `resolveExecutionWorkspace(SPEC_PATH)` de `runtime/execution-state.mjs`, use o `executionRoot` retornado e não derive o execution workspace em paralelo. Defina `taskPath = path.join(executionRoot, "tasks", "slice-NN.md")`; resolva a referência aprovada a partir do artifact que a declarou para obter `physicalTarget`; depois recalcule o claim como `path.relative(path.dirname(taskPath), physicalTarget)`, normalizado para `/`. Não copie, encurte nem ajuste por texto o caminho do plan; `execution/`, `plans/` e `tasks/` são bases diferentes. Candidate validation deve rejeitar bases inválidas sem fallback ou autocorreção.

Contexto adicional (opcional):
