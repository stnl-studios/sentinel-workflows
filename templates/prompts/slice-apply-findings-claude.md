Use `stnl-slice-executor`.
OPERATION=APPLY_FINDINGS
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}

Treat the concrete recovery operation and slice returned by deterministic preflight as authority; derive neither from this request. On `RUNNER_RESULT_BLOCKED`, resume the stored operation/slice: não reaplique findings, reset history or allocate a new round.

After authorized corrections, delegue obrigatoriamente to `@agent-stnl-validation-runner` in a fresh session sem histórico da conversa. Invoque o planner no mínimo uma vez e no máximo três vezes for `1/3`, `2/3`, `3/3`; never a fourth call. Send only operation/slice, `SPEC_PATH`, authority/revision, active finding IDs/cycle, relevant scope/references, compact evidence and recovery context. Never send installation/skill/runtime/harness paths, filenames, schemas, secrets or logs.

The runner returns only independent discovery as `stnl-validation-plan/v1`; it neither executes nor returns statuses/exits/counts/provenance. The owner invokes its loaded packaged bridge; the bridge validates and dispatches the harness, retains the envelope and stages derived `findings-check-NN` evidence. The owner validates/publishes the candidate and read-back. Não execute verification commands diretamente. Não faça fallback.

`TESTS_NOT_APPLICABLE` requires objective discovery and sealed no-command evidence and não resolve findings por si só. Real `TESTS_FAIL` in rounds 1 or 2 permits only bounded correction; round 3 preserves active findings and enters `FINDINGS_RETRY_EXHAUSTED`, then `VALIDATE_SLICE` is the only next operation. Do not create Effective Validation Base or `[x]`.

Initialization/transport gets at most one technical retry with identical payload; it não consome rodada `N/3`, does not create `findings-check-NN` or authorize correction. Malformed planner output has no retry.

Contexto adicional (opcional):
