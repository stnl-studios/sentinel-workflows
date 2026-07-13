Use `stnl-spec-execution-manager`.
OPERATION=CLOSE
SPEC_PATH={{SPEC_PATH}}
Selecione obrigatoriamente o papel conceitual stnl-validation-runner, materializado assim: no Claude Code, @agent-stnl-validation-runner; no Codex, faça spawn do agente customizado cujo name é stnl_validation_runner.
Aguarde o retorno válido: o agente faz toda a validação independente, incluindo testes; o contexto principal apenas persiste e reporta seu retorno, sem fallback, testes repetidos, nova validação, segundo veredito, substituição, suavização ou promoção de PASS, NEEDS_FIX, BLOCKED ou findings; se o agente estiver ausente, indisponível, não iniciar ou terminar sem retorno válido, retorne BLOCKED.

Contexto adicional (opcional):
