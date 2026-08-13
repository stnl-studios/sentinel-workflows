Use `stnl-execution-planner`.
OPERATION=REPLAN
SPEC_PATH={{SPEC_PATH}}
REPLAN_REASON={{REPLAN_REASON}}
Derive exactly one mutation class from deterministic execution state: planning-only atomic replacement at revision 1 with no historical recovery fields; materialized-pristine replacement; or append-only extension after execution history. Return `REPLAN_DRAFT`; require `REVIEW_PLAN` and then `MATERIALIZE_TASKS`. If a new product decision is required, hand off to lifecycle `RESUME` without drafting.

Contexto adicional (opcional):
