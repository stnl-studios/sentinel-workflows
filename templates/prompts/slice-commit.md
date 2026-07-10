Use `stnl-spec-execution-manager`.
OPERATION=COMMIT_SLICE
SLICE=<NN>

Execution root:
- <EXECUTION_ROOT>

Convenção ou escopo excepcional:
- <COMMIT_CONVENTION_OR_DEFAULT>

Restrições adicionais de commit:
- <COMMIT_CONSTRAINTS_OR_NONE>

Objetivo:
- criar um commit opcional apenas para a slice já finalizada

Entrada mínima:
- slice marcada `[x]` em `tasks.md`
- validação final compatível com `PASS`
- `git status` revisado

Resultado esperado:
- verificar que somente mudanças da slice entram no commit
- usar mensagem convencional
- não incluir arquivos alheios
- acrescentar metadata operacional do hash em `tasks/slice-NN.md` quando o contrato permitir
- preservar conteúdo funcional, tasks, testes, findings e resultado final já concluídos
- não iniciar outra slice

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
