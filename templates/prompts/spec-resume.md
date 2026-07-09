Use `stnl-spec-lifecycle-manager`.
MODE=RESUME

SPEC alvo:
- [path para feature_spec.md ou pasta da SPEC]

Objetivo desta retomada:
- [continuar, corrigir, replanejar, resolver bloqueio, incorporar decisão ou consolidar delta]

Delta novo:
- [nova evidência, decisão, resposta de pergunta, blocker ou ajuste de direção]

Não reabrir:
- [decisões, escopos, constraints ou temas que devem permanecer fechados]

Resultado esperado:
- preservar IDs canônicos existentes
- começar por `feature_spec.md` e `lifecycle/resume-notes.md`
- carregar somente a slice candidata e os artefatos vinculados, salvo justificativa concreta
- atualizar somente os arquivos modulares afetados
- replanejar slices criando novos arquivos quando alguma estiver grande demais, pequena demais, vaga ou bloqueada
- criar novos IDs canônicos apenas quando necessário
- manter `feature_spec.md`, traceability, QA checklist e resume notes consistentes
- migrar spec operacional monolítica antiga para o workspace modular se necessário, sem renumerar IDs

Restrições excepcionais:
- [somente se houver]
