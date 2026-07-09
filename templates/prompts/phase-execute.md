Use `stnl-spec-execution-manager`.

Fonte de requisitos: `{{SPEC_PATH}}`; diretório de execução: `{{EXECUTION_ROOT}}` quando informado; fase: `{{PHASE_NUMBER}}`.
Leia somente os artefatos da fase, trechos relevantes da fonte de requisitos e código relacionado.
Implemente somente a fase indicada; não execute fases futuras nem altere requisitos silenciosamente.
Registre arquivos alterados e resumo do diff; marque somente tarefas individuais executadas.
Não conclua a fase, não valide, não faça commit e não inicie a próxima fase.
Após implementar, use subagente ou contexto independente para testes relevantes quando disponível, preferindo um modelo de menor custo adequado à tarefa mecânica; registre o resultado no artefato da fase, sem solicitar revisão completa.
Se o contexto da sessão ultrapassar aproximadamente 40%, compacte-o antes de continuar, preservando apenas a fase atual, decisões relevantes, arquivos alterados, testes e pendências. Use `/compact` no Claude Code ou o mecanismo equivalente do ambiente.

Retorne somente: status; arquivos alterados; testes; bloqueios.
