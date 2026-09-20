Use `stnl-execution-planner`.
OPERATION=PLAN
SPEC_PATH={{SPEC_PATH}}

Before candidate validation, recompute every plan claim from its declaring artifact with `path.relative(path.dirname(artifact), physicalTarget)`, normalize `/`, compare by `realpath` with the physical target, and return `BLOCKED` without publication if any claim differs; never publish a plan claim that resolves to another path.

Contexto adicional (opcional):
