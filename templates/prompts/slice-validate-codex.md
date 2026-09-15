Use `stnl-slice-quality-manager`.
OPERATION=VALIDATE_SLICE
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}

Treat the concrete recovery operation and slice returned by deterministic preflight as authority; derive neither from this request. If recovery belongs to `EXECUTE_SLICE`, report its exact owner/operation/slice. A formal `RUNNER_RESULT_BLOCKED` resumes without allocating or changing `attempt-NN`.

Faça spawn obrigatório do custom agent `stnl_validation_runner` with `fork_turns="none"`, no inherited thread. Send only operation/slice, `SPEC_PATH`, authority/revision, changed scope/diff, compact evidence and project references. Never send skill/install/runtime/harness paths, filenames, schemas, secrets, logs or envelope.

The runner independently returns only `stnl-validation-plan/v1`; it does not execute, and result-shaped output is rejected before harness handling. The owner invokes its loaded bridge; the bridge validates, invokes the harness and returns compact summary plus private receipt. Send only summary, evidence ID and plan identity to the independent role for one `stnl-validation-assessment/v1`. Assessment does not execute, reconstruct evidence or publish.

Return assessment to the bridge, prepare owner sections in an isolated candidate, then ask the bridge to stage sealed evidence and validate. Only then publish selected task/global row and confirm read-back. Exit 0 or accepted plan alone cannot publish `PASS | ACCEPTED | NEEDS_FIX | BLOCKED`. Exija revisão independente of non-applicability and Gates. Não promova não aplicabilidade a `PASS`; não repete testes. Não faça fallback.

Initialization/transport gets at most one retry; attempts do not create/consume `attempt-NN` or change initial/revalidation. Malformed output has no retry. Preserve the singleton Delegation Blocker.

Contexto adicional (opcional):
