# `stnl-validation-runner`

Este agente copiável isola testes e validações da sessão principal. Ele não substitui a skill `stnl-spec-execution-manager`.

Os dois adaptadores implementam o mesmo papel conceitual `stnl-validation-runner`. O Codex usa o identificador técnico `stnl_validation_runner`, enquanto o Claude Code usa `stnl-validation-runner`, porque os runtimes possuem regras de nomenclatura diferentes.

Não normalize, troque ou iguale esses nomes físicos entre as plataformas.

Copie somente um adaptador para a raiz do projeto:

- Codex: copie `codex/` para obter `.codex/agents/stnl_validation_runner.toml`.
- Claude Code: copie `claude-code/` para obter `.claude/agents/stnl-validation-runner.md`.

## Invocação e retorno

No Claude Code, os launchers enviam @agent-stnl-validation-runner como menção direta, sem crases, aspas, escape, link ou bloco de código. Citar apenas o nome em linguagem natural não é o contrato canônico do Claude Code.

No Codex, a sessão principal faz spawn do agente customizado pelo nome stnl_validation_runner. A sessão principal aguarda o retorno, não repete testes nem validações e preserva integralmente o status e os findings retornados.

Se o agente estiver ausente, indisponível, não iniciar ou terminar sem retorno válido, o resultado é BLOCKED. Não existe fallback para a sessão principal. Abra uma nova sessão quando a pasta de agentes ainda não tiver sido carregada.

Não copie este agente para `targets/`. Ele não implementa nem corrige trabalho.

## Smoke test manual

1. Copie somente o adaptador da plataforma para um projeto.
2. Inicie uma nova sessão quando necessário.
3. Execute um dos quatro launchers.
4. Confirme visualmente que o agente correto da plataforma foi iniciado: `stnl_validation_runner` no Codex ou `stnl-validation-runner` no Claude Code.
5. Confirme que os comandos de teste aparecem somente na thread do subagente.
6. Confirme que a sessão principal apenas recebe e persiste o resumo.
7. Confirme que a saída contém todas as seções canônicas.
8. Remova temporários criados exclusivamente para o smoke test.
