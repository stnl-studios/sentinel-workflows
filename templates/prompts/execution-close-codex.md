Use `stnl-spec-execution-manager`.
OPERATION=CLOSE
SPEC_PATH={{SPEC_PATH}}
Faça spawn do agente customizado `stnl_validation_runner` para executar todo o cross-check independente do fechamento, incluindo os testes aplicáveis.
Aguarde o retorno. O contexto principal apenas persiste e reporta o status, os findings e os bloqueios retornados; não repete testes, não refaz a validação e não emite outro veredito.
Se o agente não iniciar ou não retornar resultado válido, retorne `BLOCKED`. Não faça fallback nem substitua, suavize ou promova o resultado.

Contexto adicional (opcional):
