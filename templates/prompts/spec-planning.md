Use `stnl-spec-lifecycle-manager`.
MODE=PLANNING

SPEC:
- {{SPEC_PATH}}

Foco adicional:
- {{PLANNING_REVIEW_FOCUS_OR_NONE}}

Objetivo:
- revisar a prontidão documental da SPEC para planejamento posterior

Entrada mínima:
- `{{SPEC_PATH}}/feature_spec.md`
- artefatos materializados e indexados, quando existirem; `shared/` pode não existir

Escopo:
- entra: clareza, consistência, critérios, decisões, riscos, restrições e perguntas abertas
- fora: alterar, criar ou corrigir arquivos; alterar status; resolver perguntas; criar plano, tasks ou artefatos operacionais

Contexto disponível:
- leia primeiro o File Purpose Header e o Artifact Index
- carregue somente categorias materializadas e siga leitura seletiva por IDs
- não carregue todas as categorias por padrão

Resultado esperado:
- retornar somente `READY` ou `NEEDS_RESUME`
- quando `NEEDS_RESUME`, informar gate falho, arquivo, ID relacionado quando existir, problema objetivo e informação ou correção documental necessária
- indicar RESUME como ação documental apropriada apenas quando houver finding corrigível
- não exigir etapa obrigatória seguinte

Restrições excepcionais:
- {{EXCEPTIONAL_CONSTRAINTS_OR_NONE}}
