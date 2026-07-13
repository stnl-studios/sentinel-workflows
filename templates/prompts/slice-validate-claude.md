Use `stnl-spec-execution-manager`.
OPERATION=VALIDATE_SLICE
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Delegue obrigatoriamente toda a validação independente desta operação, incluindo os testes aplicáveis, para:
@agent-stnl-validation-runner
Aguarde o retorno. O contexto principal apenas persiste e reporta o status e os findings retornados; não repete testes, não refaz a validação e não emite outro veredito.
Se o agente não iniciar ou não retornar resultado válido, retorne `BLOCKED`. Não faça fallback nem substitua, suavize ou promova o resultado.

Contexto adicional (opcional):
