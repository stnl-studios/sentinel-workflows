Use `stnl-spec-roadmap`.
OPERATION=RECONCILE
PROJECT_ROOT={{PROJECT_ROOT}}
ROADMAP_PATH={{ROADMAP_PATH}}
NEW_INFORMATION={{NEW_INFORMATION}}
Reconcilie o roadmap persistente após inspeção stale-write-safe. `ROADMAP_PATH` vazio significa `docs/roadmap`; qualquer valor explícito deve ser repository-relative POSIX. `roadmap.json` governa apenas decomposition, coverage, candidate relationships e gaps. Estado local do browser não é autoridade Sentinel e nunca satisfaz dependencies. Não crie, altere nem invoque uma SPEC, lifecycle ou execução; apenas registre impactos e entregue handoffs manuais.

Contexto adicional (opcional):
