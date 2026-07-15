Use `stnl-slice-executor`.
OPERATION=APPLY_FINDINGS
SPEC_PATH={{SPEC_PATH}}
SLICE={{SLICE}}
Após aplicar os findings e registrar correções e escopo alterado, delegue obrigatoriamente a primeira chamada dos testes desta operação com `OPERATION=APPLY_FINDINGS`, o SPEC path, execution root derivado, slice, paths de plans e tasks, findings pendentes, correções, evidências relevantes, escopo alterado, rodada automática e o contexto adicional aplicável para:
@agent-stnl-validation-runner
Invoque o runner no mínimo uma vez e no máximo três vezes nesta mesma operação manual, nas rodadas `1/3`, `2/3` e `3/3`; nunca faça uma quarta chamada nem use loop ilimitado. Não pule o runner por correção simples nem por acreditar que nenhum check seja aplicável; a descoberta independente e `TESTS_NOT_APPLICABLE` pertencem ao runner.
Não passe logs completos. Não execute no contexto principal testes, builds, linters, typechecks, compilações ou outros comandos de verificação. Aguarde cada retorno e persista-o append-only em `Findings Test Evidence`, com o próximo `findings-check-NN` global, ciclo de findings, rodada, descoberta de checks, justificativa de não aplicabilidade, estado, comandos, falhas, correções cobertas e escopo.
Em `TESTS_FAIL` nas rodadas 1 ou 2, depois de persistir a evidência, ajuste automaticamente no contexto principal somente findings persistidos, falhas introduzidas ou expostas pelas correções e regressões diretamente relacionadas dentro do escopo aprovado; registre falha, evidência, alteração, arquivos, correções e escopo atualizado, e então chame o runner novamente. Na terceira falha, persista, preserve os findings e encerre sem nova correção automática.
Aceite somente `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`. Encerre em `TESTS_PASS`, `TESTS_NOT_APPLICABLE`, `BLOCKED`, terceira falha ou decisão fora do escopo; preserve findings e Validation Attempts, mantenha a slice aberta e não crie Effective Validation Base ou conclusão `[x]`. `TESTS_NOT_APPLICABLE` exige descoberta objetiva, fontes e ações read-only resumidas, justificativa e nenhum comando de verificação executado e não resolve findings por si só.
Se o agente não iniciar ou retornar saída inválida, persista `BLOCKED` com a causa e encerre. Não faça fallback, não marque findings como resolvidos sem sustentação, não crie etapa manual de retry, não amplie escopo e não inicie `VALIDATE_SLICE` nem outra operação automaticamente.

Contexto adicional (opcional):
