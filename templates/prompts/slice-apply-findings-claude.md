Use `stnl-spec-execution-manager`.
OPERATION=APPLY_FINDINGS
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Após aplicar os findings, delegue obrigatoriamente os testes desta operação para:
@agent-stnl-validation-runner
Aguarde o retorno. O contexto principal não executa nem repete os testes e usa somente a evidência retornada.
Se o agente não iniciar ou não retornar resultado válido, retorne `BLOCKED`. Não faça fallback.

Contexto adicional (opcional):
