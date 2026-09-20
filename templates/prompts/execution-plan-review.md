Use `stnl-plan-reviewer`.
OPERATION=REVIEW_PLAN
SPEC_PATH={{SPEC_PATH}}

Before approving any plan candidate, recompute every reviewed plan claim from its declaring artifact with `path.relative(path.dirname(artifact), physicalTarget)`, normalize `/`, compare by `realpath` with the physical target, and return `BLOCKED` without publication if any claim differs; never approve a plan claim that resolves to another path.

Contexto adicional (opcional):
