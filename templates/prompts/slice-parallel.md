Use `stnl-spec-execution-manager`.
OPERATION=PARALLELIZE_SLICES
SLICES=<NN, NN>

Execution root:
- <EXECUTION_ROOT>

Slices candidatas:
- <PARALLELIZATION_CANDIDATES>

Objetivo:
- avaliar e, quando seguro, executar slices independentes com integração serial posterior

Entrada mínima:
- `plan.md`, `tasks.md` e planos detalhados das slices candidatas
- números das slices explicitamente solicitados

Escopo:
- entra: dependências, arquivos, estado compartilhado, schemas, contratos, fixtures, recursos externos, testes mutáveis e ordem
- fora: atualização concorrente de `tasks.md` e topologia obrigatória de agentes

Contexto disponível:
- <INDEPENDENCE_EVIDENCE_OR_UNKNOWN>
- evidência concreta de não sobreposição, quando existir

Resultado esperado:
- bloquear quando não houver prova de independência
- executar cada slice aprovada com leitura e escrita isoladas
- manter cada execução restrita ao próprio `tasks/slice-NN.md` e aos arquivos de implementação da slice
- retornar resultados para integração serial

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
