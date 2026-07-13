Use `stnl-spec-execution-manager`.
OPERATION=APPLY_FINDINGS
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Após aplicar os findings, faça spawn do agente customizado `stnl_validation_runner` para executar os testes desta operação.
Aguarde o retorno. O contexto principal não executa nem repete os testes e usa somente a evidência retornada.
Se o agente não iniciar ou não retornar resultado válido, retorne `BLOCKED`. Não faça fallback.

Contexto adicional (opcional):
