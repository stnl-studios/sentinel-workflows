Use `stnl-spec-execution-manager`.

Fonte de requisitos: `{{SPEC_PATH}}`.
Diretório de execução: `{{EXECUTION_ROOT}}` quando informado.
Leia o plano aprovado e materialize somente as tarefas da próxima fase executável, atualizando os índices necessários.
Não gere antecipadamente tarefas de outras fases, não implemente e não reproduza a lista completa.

Retorne somente: fase; quantidade de tarefas; critérios cobertos; bloqueios.
