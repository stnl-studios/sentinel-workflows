Use `stnl-spec-lifecycle-manager`.
MODE=CLOSE
SPEC_PATH={{SPEC_PATH}}
Exija uma readiness attestation externa `GLOBAL/READY` para o snapshot atual, use somente o renderer determinístico canônico e passe a mesma attestation ao publisher; rejeite attestation stale e não aceite confirmação booleana.
Retorne `SPEC_CLOSED`. Este fechamento consolida autoridade documental, é independente de `OPERATION=CLOSE` da execução e não declara `EXECUTION_APPROVED`.

Contexto adicional (opcional):
