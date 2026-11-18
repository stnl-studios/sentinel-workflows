# File Purpose Header

```yaml
purpose: Coordinate approved work through current handoffs and pause before CLOSE.
status: not_applicable
read_when: The user authorizes an end-to-end workflow or resumes it with continue.
do_not_read_when: Only one bounded operation was requested.
contains: Authorization, continuation, terminal proof, runbook and interruption boundaries.
owner: stnl-plan-reviewer
update_policy: Keep workflow consumers aligned without bypassing runtime admission.
```

# Approved workflow continuation

Continuation is coordination by the principal, not a new runtime operation or a runner permission. Keep each producer's admission, independent review, publication, readback and cleanup intact. The principal consumes the resulting legal handoff instead of asking the user to operate every transition.

## Authorization and stops

After the user approves the complete final Plan and Tasks and authorizes execution, the principal continues within that approved scope: independent REVIEW_PLAN, EXECUTE_SLICE, VALIDATE_SLICE and admitted APPLY_FINDINGS, then the next eligible slice. A request limited to planning, review, validation or one slice remains limited; approval of document content alone does not expand a narrower request. Respect a later pause or cancellation immediately.

Stop before CLOSE and request the user's explicit closing decision. Also stop for a material requirement/strategy change, a needed permission, an unresolved product decision, a real external blocker, an uncertain effect or exhausted runtime recovery. Do not turn these into automatic REPLAN, RECONCILE, scope expansion, budget reset, merge, deployment or deletion. A routine handoff inside approved execution is not itself a new user decision.

## Follow the existing state

1. Inspect the current execution before selecting work. If a saved operation handle is pending, resume that handle and settle its exact publication/cleanup before beginning another operation. Never infer that an interrupted call did not execute.
2. On a legal EXECUTE_SLICE or APPLY_FINDINGS handoff, invoke the executor with the exact current target. On VALIDATE_SLICE, invoke the quality manager and an independent runner. Checks during implementation are not formal acceptance.
3. After publication/readback/own cleanup, inspect again. Follow only the returned eligible handoff. NEEDS_FIX uses admitted APPLY_FINDINGS and a fresh independent validation, preserving the original retry limits. BLOCKED is not permission to loop.
4. Plan criterion coverage from the outset. Each slice records execution, independent VALIDATE/PASS and evidence for its approved criteria and impacts. The final slice may cover remaining whole-delivery criteria; a separate validation slice or terminal dispatch is not mandatory.
5. Reuse authenticated historical coverage. If the reader reports COMPLETE, do not manufacture another validation or Q20. For missing or contradicted criteria, follow its legal validation handoff; an absent owner requires the applicable review decision, not a guessed target or synthesized PASS.
6. When runbook/QA is included in the approved delivery, generate the SPEC-derived runbook and carry out only the authorized QA. An independently requested runbook remains usable without execution controls. Preserve QA results; missing manual QA is a reported pending acceptance, never a simulated PASS. Apply actionable in-scope findings through the normal admitted correction/validation path.
7. After criterion-covered COMPLETE and the planned QA, present results, evidence, limitations and the closing question. Do not run CLOSE until the user explicitly agrees.

## Continue after interruption

A user's “continue” resumes the same approved work, not a fresh plan. Read the approved Plan/Tasks, current inspection and saved operation handles; recover the existing operation before choosing the next handoff. Do not rerun a recipe merely to recover its already captured result. If durable documents remain but operational controls are missing, use the documented documentary-resumption route and independent current review. Unknown historical approval, consumption or evidence stays unknown: do not fabricate it, silently reset limits or bypass that route's requirement for a new explicit decision. Ask only for the specific missing decision that blocks safe continuation.
