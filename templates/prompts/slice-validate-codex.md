Use `stnl-slice-quality-manager`.
OPERATION=VALIDATE_SLICE
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Faça spawn do agente customizado `stnl_validation_runner` com `OPERATION=VALIDATE_SLICE`, o SPEC path, execution root derivado, slice, paths de plans e tasks, evidências de implementação e findings, incluindo `TESTS_NOT_APPLICABLE`, histórico de validação, escopo alterado, diff, overlaps e o contexto adicional aplicável.
Não passe logs completos. Aguarde o retorno. O contexto principal somente adiciona a Validation Attempt e, em `PASS` válido, substitui a Effective Validation Base e finaliza a slice; não repete testes, não refaz a validação e não emite outro veredito.
Exija revisão independente da descoberta e justificativa de qualquer `TESTS_NOT_APPLICABLE`; o runner pode rejeitar essa evidência, descobrir e executar check aplicável ou exigir inspeção adicional. Não promova não aplicabilidade a `PASS`; a validação formal continua somente `PASS | NEEDS_FIX | BLOCKED`.
Se o agente não iniciar ou não retornar resultado válido, persista e retorne `BLOCKED`. Não faça fallback nem substitua, suavize ou promova o resultado.

Contexto adicional (opcional):
