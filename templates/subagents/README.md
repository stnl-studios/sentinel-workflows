# `stnl-validation-runner`

Este agente copiável isola testes e validações da sessão principal. Ele não substitui a skill `stnl-spec-execution-manager`.

## Instalação

A cópia parte da pasta `templates/subagents/` deste repositório. Copie somente o adaptador da plataforma usada para a raiz do projeto:

- Codex: copie o conteúdo de `codex/`. O arquivo resultante deve ser `.codex/agents/stnl_validation_runner.toml`.
- Claude Code: copie o conteúdo de `claude-code/`. O arquivo resultante deve ser `.claude/agents/stnl-validation-runner.md`.

Não copie os dois adaptadores para o mesmo projeto.

## Launchers

Os launchers são específicos por plataforma.

- Para Codex, use os arquivos `*-codex.md`.
- Para Claude Code, use os arquivos `*-claude.md`.
- Não use um launcher de uma plataforma na outra.
- Os quatro launchers mistos antigos não existem mais.

## Invocação e retorno

No Codex, o launcher faz spawn do agente customizado `stnl_validation_runner`.
No Claude Code, o launcher usa @agent-stnl-validation-runner como menção direta.
Se o agente estiver ausente, não iniciar ou não retornar resultado válido, o resultado é `BLOCKED`. Não existe fallback.

## Smoke test manual

1. Copie somente o adaptador da plataforma para um projeto.
2. Inicie uma nova sessão quando necessário.
3. Execute um launcher correspondente à plataforma.
4. Confirme que os comandos de teste aparecem somente na thread do subagente e que a sessão principal apenas recebe e persiste o retorno.
