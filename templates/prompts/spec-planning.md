Use `stnl-spec-lifecycle-manager`.
MODE=PLANNING

SPEC alvo:
- [path para feature_spec.md ou pasta da SPEC]

Alvo da validação:
- [SL-001, próxima slice ready/planned ou SPEC inteira]

Objetivo:
- validar se a SPEC ou slice alvo está pronta para execução atômica por agentes

Resultado esperado:
- executar readiness gates
- validar o workspace modular sem mutações
- validar paths indexados, arquivos de slice, File Purpose Headers e IDs
- validar perguntas abertas
- validar tamanho da slice
- validar ACs, constraints, riscos, decisões e rastreabilidade
- validar `validation_hints`
- validar `lifecycle/qa-checklist.md`
- retornar status de readiness

Contrato:
- se houver pergunta aberta, bloquear
- se a slice estiver grande demais, pequena demais ou vaga, bloquear e indicar `MODE=RESUME`
- se houver referência quebrada, bloquear e indicar `MODE=RESUME`
- se faltar material essencial, bloquear e listar o mínimo necessário
- não replanejar diretamente
- não criar, editar, dividir ou mesclar arquivos
- não alterar escopo sem delta explícito
- não gerar plano de execução

Restrições excepcionais:
- [somente se houver]
