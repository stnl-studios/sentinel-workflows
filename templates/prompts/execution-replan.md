Use `stnl-execution-planner`.
OPERATION=REPLAN
SPEC_PATH={{SPEC_PATH}}
REPLAN_REASON={{REPLAN_REASON}}
Derive pristine replacement versus append-only extension only from deterministic execution state. Return `REPLAN_DRAFT`; require `REVIEW_PLAN` and then `MATERIALIZE_TASKS`. If a new product decision is required, hand off to lifecycle `RESUME` without drafting.

Contexto adicional (opcional):
