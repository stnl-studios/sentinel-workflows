Use `stnl-spec-execution-manager`.
OPERATION=EXECUTE_SLICE
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Selecione obrigatoriamente o papel conceitual stnl-validation-runner, materializado assim: no Claude Code, @agent-stnl-validation-runner; no Codex, faça spawn do agente customizado cujo name é stnl_validation_runner.
Aguarde o retorno válido: somente o agente executa ou repete testes e produz a evidência; o contexto principal só pode interpretar e persistir o retorno, sem fallback, repetição, evidência inventada ou substituição de status; se o agente estiver ausente, indisponível, não iniciar ou terminar sem retorno válido, retorne BLOCKED.

Contexto adicional (opcional):
