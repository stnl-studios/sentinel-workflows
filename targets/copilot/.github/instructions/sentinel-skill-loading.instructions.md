---
applyTo: "**"
---

# Sentinel Skill Loading

Agent responsibility comes from `.agent.md`; specialization comes from `SKILL.md`. Load only skills that the slice stack, approved plan, test framework, touched sensitive area, or specific validation rule requires. Do not load skills just in case or for routing/close consolidation.

Planner, test-planner, and reviewer may use all Sentinel skills when relevant. Coder and validator may use database/migration and security/auth skills only when the approved plan or touched diff explicitly requires them. Orchestrator and finalizer load no skills.

Stack differences never justify new stack-specific agents.
