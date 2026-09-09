Use `stnl-requirements-refiner`.
OPERATION=INIT
PROJECT_ROOT={{PROJECT_ROOT}}
REFINEMENT_PATH={{REFINEMENT_PATH}}
REQUIREMENTS_SOURCE={{REQUIREMENTS_SOURCE}}
Inicialize um único refinamento persistente. `REFINEMENT_PATH` vazio significa `docs/refinement`; qualquer valor explícito deve ser repository-relative POSIX. `refinement.json` é a única autoridade do refinamento. Estado local do browser não é autoridade Sentinel e nunca resolve ou desvia findings. Não crie, altere nem invoque uma SPEC, Roadmap ou workflow downstream; apenas entregue um handoff manual.

Contexto adicional (opcional):
