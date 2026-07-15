# `stnl-validation-runner`

Este agente copiável executa somente a validação independente de uma slice para a skill `stnl-slice-quality-manager`.

## Instalação

A cópia parte da pasta `templates/subagents/` deste repositório. Copie somente o adaptador da plataforma usada para a raiz do projeto:

- Codex: copie o conteúdo de `codex/`. O arquivo resultante deve ser `.codex/agents/stnl_validation_runner.toml`.
- Claude Code: copie o conteúdo de `claude-code/`. O arquivo resultante deve ser `.claude/agents/stnl-validation-runner.md`.

Não copie os dois adaptadores para o mesmo projeto.

## Launchers

Somente a validação possui launchers específicos por plataforma:

- Codex: `slice-validate-codex.md`.
- Claude Code: `slice-validate-claude.md`.
- Não use um launcher de uma plataforma na outra.

Execução, correção de findings e fechamento usam launchers compartilhados e não invocam este agente.

## Invocação e retorno

No Codex, o launcher faz spawn do agente customizado `stnl_validation_runner`.
No Claude Code, o launcher usa @agent-stnl-validation-runner como menção direta.
Se o agente estiver ausente, não iniciar ou não retornar resultado válido, a validação persiste `BLOCKED`. Não existe fallback.

Cada invocação gera uma Validation Attempt append-only. Somente `PASS` fornece o manifesto final completo usado para criar ou substituir a única Effective Validation Base; `NEEDS_FIX` e `BLOCKED` nunca criam essa autoridade. Em revalidação, o manifesto cobre o estado final inteiro da slice e regressões justificadas para overlaps com slices anteriores.

## Smoke test manual

1. Copie somente o adaptador da plataforma para um projeto.
2. Inicie uma nova sessão quando necessário.
3. Execute o launcher de validação correspondente à plataforma.
4. Confirme que os comandos aparecem somente na thread do subagente e que a sessão principal apenas persiste o retorno e finaliza quando ele for `PASS`.
