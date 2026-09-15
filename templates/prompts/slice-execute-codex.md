Use `stnl-slice-executor`.
OPERATION=EXECUTE_SLICE
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}

Treat the concrete recovery operation and slice returned by deterministic preflight as authority; derive neither from this request. On `RUNNER_RESULT_BLOCKED`, resume the stored operation/slice without reimplementation, checklist reset, history rewrite or new round allocation.

After the owner implements and records the approved scope, faça spawn obrigatório do custom agent `stnl_validation_runner` with `fork_turns="none"`, no full-thread fork and no conversation history. Invoque o planner no mínimo uma vez e no máximo três vezes, only for automatic rounds `1/3`, `2/3`, `3/3`; never a fourth call or unbounded loop. Send only operation/slice, `SPEC_PATH`, Requirements authority, Plan revision, relevant scope/references, compact prior evidence and recovery context. Do not send installation/skill/runtime/harness paths, packaged filenames, schemas, secrets or full logs.

The runner performs independent read-only discovery and returns only `stnl-validation-plan/v1`. It does not execute checks or return `TESTS_PASS`, exits, counts or provenance. Reject result-shaped or malformed output before treating it as harness evidence; malformed planner output does not receive transport retry and does not consume the round.

The owner then invokes the packaged bridge from its own loaded skill location exactly as instructed by that skill. Bridge invocation is allowed orchestration, not direct toolchain execution. The bridge validates lifecycle/identity/environment, resolves and invokes the harness, keeps the opaque envelope out of model output, and stages its programmatically derived evidence in the isolated candidate. The owner validates/publishes only accepted candidate paths and confirms read-back. Do not execute tests/build/lint/typecheck/compiler/validator directly in the main context. Não faça fallback.

`TESTS_NOT_APPLICABLE` requires objective discovery and sealed proof that nenhum comando de verificação executado. A real `TESTS_FAIL` in rounds 1 or 2 may authorize only a bounded in-slice correction before the next plan; round 3 enters `IMPLEMENTATION_RETRY_EXHAUSTED`, and a única próxima ação da slice é `VALIDATE_SLICE`. Never create Validation Attempt, Effective Validation Base or `[x]` completion here.

Initialization/transport may receive no máximo uma nova tentativa técnica with the same minimal payload. These attempts não consomem rodada `N/3`, do not create `implementation-check-NN` and do not authorize correction. Persist a single canonical Delegation Blocker after definitive initialization failure; preserve historical blockers and resolve them only through the resumed accepted bridge record.

Contexto adicional (opcional):
