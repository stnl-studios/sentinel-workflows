Use `stnl-spec-lifecycle-manager`.
MODE=CLOSE

SPEC alvo:
- [path para feature_spec.md ou pasta da SPEC]

Condição de fechamento:
- [feature aceita, escopo encerrado, todas as slices necessárias concluídas ou fechamento com residuals aprovado]

Evidências disponíveis:
- validação automatizada: [...]
- validação manual: [...]
- revisão: [...]
- limites conhecidos: [...]
- decisões finais: [...]

Resultado esperado:
- consolidar tudo em um único `feature_spec.md`
- remover `shared/`, `slices/` e `lifecycle/`
- remover histórico operacional e ruído de desenvolvimento
- preservar apenas regras de negócio, ACs finais, decisões duráveis, constraints relevantes, riscos relevantes e notas técnicas essenciais

Contrato de fechamento:
- se fechar como `closed`, não manter histórico de execução
- se fechar como `closed_with_residuals`, registrar limites conhecidos no `feature_spec.md`
- se algum arquivo operacional ainda for necessário para entender a SPEC, retornar `not_closed`
- se alguma restrição exigir preservar histórico técnico ou diretórios operacionais, bloquear fechamento

Não preservar:
- logs de execução
- tentativas falhas
- comandos detalhados
- checklist técnico granular
- session summaries
- planning intermediário
- histórico de slices como execução

Restrições excepcionais:
- [somente se houver]
