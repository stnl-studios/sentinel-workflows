Use `stnl-slice-quality-manager`.
OPERATION=VALIDATE_SLICE
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Delegue obrigatoriamente a validação independente em uma sessão delegada independente sem histórico da conversa, com somente `OPERATION=VALIDATE_SLICE`, `SPEC_PATH`, execution root derivado, slice, paths de plans e tasks, evidências compactas de implementação e findings, incluindo `TESTS_NOT_APPLICABLE`, resumo das tentativas válidas, escopo alterado, diff, overlaps e contexto adicional estritamente necessário para:
@agent-stnl-validation-runner
Não passe logs completos. Aguarde o retorno. O contexto principal somente adiciona a Validation Attempt e, em `PASS` válido, substitui a Effective Validation Base e finaliza a slice; não repete testes, não refaz a validação e não emite outro veredito.
Exija revisão independente da descoberta e justificativa de qualquer `TESTS_NOT_APPLICABLE`; o runner pode rejeitar essa evidência, descobrir e executar check aplicável ou exigir inspeção adicional. Não promova não aplicabilidade a `PASS`; a validação formal continua somente `PASS | NEEDS_FIX | BLOCKED`.
Se a sessão não iniciar ou o transporte falhar, faça no máximo uma nova tentativa técnica em outra sessão independente com o mesmo payload mínimo; ela não cria nem consome `attempt-NN`, não muda `initial` para `revalidation` e, após a segunda falha, mantém somente um `Runner Initialization Blocker`. Saída malformada após início é distinta, não recebe retry de transporte e não cria tentativa fabricada. Em nova chamada bloqueada exclusivamente pela inicialização, retome diretamente na delegação sem duplicar blocker ou reiniciar o próximo identificador. Não faça fallback nem substitua, suavize ou promova o resultado.
Nunca crie scratch file, script auxiliar, manifest ou relatório ad hoc dentro da SPEC; reporte qualquer path não canônico exatamente, não o apague e use somente diretório temporário externo quando necessário.

Contexto adicional (opcional):
