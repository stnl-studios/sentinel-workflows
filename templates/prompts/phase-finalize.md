Use `stnl-spec-execution-manager` na sessão principal.

Fonte de requisitos: `{{SPEC_PATH}}`; diretório de execução: `{{EXECUTION_ROOT}}`; fase: `{{PHASE_NUMBER}}`.
Leia o resultado persistido da validação no artefato da fase; não peça que achados sejam copiados manualmente.
Com validação inicial `PASS`, registre `revalidation: not_required`, finalize evidências, marque a fase concluída e atualize `plan.md` e `tasks.md`, sem segunda validação, modificar código, commit ou próxima fase.
Com `NEEDS_FIX`, corrija somente achados e efeitos necessários; não expanda o escopo silenciosamente.
Execute novamente os testes relevantes em subagente ou contexto independente quando disponível e registre os resultados.
Faça revalidação focada em subagente ou contexto independente e registre `revalidation: PASS` apenas se aprovada.
Se a revalidação falhar, mantenha a fase aberta, persista os achados e não faça commit.
Se surgir mudança real de requisito, escopo ou estratégia, interrompa, registre o desvio e não conclua a fase.
Após revalidação aprovada, finalize evidências, marque a fase concluída e atualize `plan.md` e `tasks.md`; não inicie a próxima fase nem faça commit.

Retorne somente: correções aplicadas; testes; resultado da validação ou revalidação; estado da fase; bloqueios.
