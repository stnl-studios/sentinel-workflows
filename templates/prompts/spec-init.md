Use `stnl-spec-lifecycle-manager` em `MODE=INIT`.

Use `{{SPEC_PATH}}` quando o caminho já estiver definido.
Crie ou amadureça uma nova SPEC com as informações fornecidas e consulte apenas o código estritamente necessário para esclarecê-las.
Não implemente, não crie plano de execução nem tarefas.
Persista os detalhes nos artefatos da SPEC e pare quando houver pergunta bloqueante.

Retorne somente: status; caminho; perguntas bloqueantes; próximo MODE.
