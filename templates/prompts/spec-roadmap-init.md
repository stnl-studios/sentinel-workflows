Use `stnl-spec-roadmap`.
OPERATION=INIT
PROJECT_ROOT={{PROJECT_ROOT}}
ROADMAP_PATH={{ROADMAP_PATH}}
ROADMAP_SOURCE={{ROADMAP_SOURCE}}
Inicialize um único roadmap persistente. `ROADMAP_PATH` vazio significa `docs/roadmap`; qualquer valor explícito deve ser repository-relative POSIX. `roadmap.json` governa apenas decomposition, coverage, candidate relationships e gaps. Estado local do browser não é autoridade Sentinel e nunca satisfaz dependencies. Não crie, altere nem invoque uma SPEC, lifecycle ou execução; apenas entregue handoffs manuais.

Contexto adicional (opcional):
