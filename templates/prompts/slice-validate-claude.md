Use `stnl-slice-quality-manager`.
OPERATION=VALIDATE_SLICE
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Delegue obrigatoriamente a validação independente para:
@agent-stnl-validation-runner
Aguarde o retorno. O contexto principal somente adiciona a Validation Attempt e, em `PASS` válido, substitui a Effective Validation Base e finaliza a slice; não repete testes, não refaz a validação e não emite outro veredito.
Se o agente não iniciar ou não retornar resultado válido, persista e retorne `BLOCKED`. Não faça fallback nem substitua, suavize ou promova o resultado.

Contexto adicional (opcional):
