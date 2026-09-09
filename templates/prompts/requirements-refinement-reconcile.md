Use `stnl-requirements-refiner`.
OPERATION=RECONCILE
PROJECT_ROOT={{PROJECT_ROOT}}
REFINEMENT_PATH={{REFINEMENT_PATH}}
NEW_INFORMATION={{NEW_INFORMATION}}
Reconcilie o refinamento persistente após inspeção stale-write-safe. `REFINEMENT_PATH` vazio significa `docs/refinement`; qualquer valor explícito deve ser repository-relative POSIX. `refinement.json` é a única autoridade do refinamento. Estado local do browser não é autoridade Sentinel e nunca resolve ou desvia findings. Não crie, altere nem invoque uma SPEC, Roadmap ou workflow downstream; apenas atualize a autoridade e entregue um handoff manual.

Contexto adicional (opcional):
