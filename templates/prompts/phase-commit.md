Use `stnl-spec-execution-manager`.

Fonte de requisitos: `{{SPEC_PATH}}`; diretório de execução: `{{EXECUTION_ROOT}}` quando informado; fase: `{{PHASE_NUMBER}}`; tipo: `{{COMMIT_TYPE}}`.
Confirme que a fase está concluída e possui `PASS`; revise `git status`.
Inclua somente mudanças da fase e exclua mudanças não relacionadas.
Crie um commit convencional usando `{{COMMIT_TYPE}}` quando preenchido ou inferindo o tipo correto quando vazio.
Não modifique código, não feche a execução e não inicie a próxima fase.

Retorne `Commit criado: <hash curto> <mensagem>` ou `BLOQUEADO: <motivo curto>`.
