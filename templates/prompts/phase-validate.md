Use `stnl-spec-execution-manager`.

Fonte de requisitos: `{{SPEC_PATH}}`; diretório de execução: `{{EXECUTION_ROOT}}` quando informado; fase: `{{PHASE_NUMBER}}`.
Valide em subagente ou contexto independente quando disponível, preferindo modelo de menor custo adequado à revisão mecânica.
Revise somente o diff da fase contra a fonte, plano, tarefas e testes; identifique divergências, critérios não atendidos, testes ausentes, código morto e mudanças fora do escopo.
Registre os achados no artefato detalhado da fase.
Não modifique código, não corrija achados, não marque a fase `[x]`, não atualize `plan.md` ou `tasks.md` e não faça commit.

Quando aprovado, retorne somente `PASS`.
Quando houver problemas, retorne `NEEDS_FIX` seguido apenas de achados numerados: problema; evidência; referência; correção esperada.
