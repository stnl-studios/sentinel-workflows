Use `stnl-slice-quality-manager`.
OPERATION=VALIDATE_SLICE
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Delegue obrigatoriamente a validação independente em uma sessão delegada independente sem histórico da conversa, com somente `OPERATION=VALIDATE_SLICE`, `SPEC_PATH`, execution root derivado, slice, paths de plans e tasks, Requirements authority, Plan revision, evidências compactas de implementação e findings, incluindo `TESTS_NOT_APPLICABLE`, resumo de findings ativos/históricos e tentativas válidas, escopo alterado, diff, overlaps e contexto adicional estritamente necessário para:
@agent-stnl-validation-runner
Não passe logs completos. Aguarde o retorno. O contexto principal adiciona a Validation Attempt, persiste as disposições completas de findings existentes e novos findings estruturados e, em `PASS` válido, exige zero finding bloqueante ativo, substitui a Effective Validation Base e finaliza a slice; não repete testes, não refaz a validação e não emite outro veredito.
Exija revisão independente da descoberta e justificativa de qualquer `TESTS_NOT_APPLICABLE`; o runner pode rejeitar essa evidência, descobrir e executar check aplicável ou exigir inspeção adicional. Não promova não aplicabilidade a `PASS`; a validação formal continua somente `PASS | NEEDS_FIX | BLOCKED`.
Se a sessão não iniciar ou o transporte falhar, faça no máximo uma nova tentativa técnica em outra sessão independente com o mesmo payload mínimo; essas tentativas não consomem rodada, não criam nem consomem `attempt-NN`, não mudam `initial` para `revalidation` e, após a segunda falha, mantêm somente o `Delegation Blocker` canônico de inicialização (compatibilidade: `Runner Initialization Blocker`). Saída malformada usa o mesmo singleton com `Kind: malformed-output`, não recebe retry de transporte e não cria tentativa fabricada. Em nova chamada bloqueada exclusivamente pela inicialização, retome diretamente na delegação sem duplicar blocker ou reiniciar o próximo identificador; a recuperação de saída malformada segue o mesmo gate. Não faça fallback nem substitua, suavize ou promova o resultado.
Nunca crie scratch file, script auxiliar, manifest ou relatório ad hoc dentro da SPEC; reporte qualquer path não canônico exatamente, não o apague e use somente diretório temporário externo quando necessário.

Contexto adicional (opcional):
