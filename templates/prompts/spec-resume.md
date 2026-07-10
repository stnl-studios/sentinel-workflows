Use `stnl-spec-lifecycle-manager`.
MODE=RESUME

SPEC:
- {{SPEC_PATH}}

Novas informações:
- {{NEW_INFORMATION}}

Objetivo:
- incorporar informações novas preservando a coerência documental da SPEC

Entrada mínima:
- `{{SPEC_PATH}}/feature_spec.md` preexistente
- RESUME não cria workspace novo
- incorporar somente `{{NEW_INFORMATION}}`

Escopo:
- entra: artefatos afetados, IDs existentes, inconsistências documentais e perguntas materiais
- fora: planejamento de execução, tasks e implementação
- preservar IDs, trabalhar por delta e não reescrever toda a SPEC sem necessidade
- materializar nova categoria somente quando exigida por informação real; não criar arquivos vazios

Contexto disponível:
- SPEC existente
- novas informações fornecidas pelo usuário
- remova `blocks` e `blocked_by` quando uma pergunta for resolvida
- preserve histórico durável por decisão, referência ou resolução, conforme a skill

Resultado esperado:
- artefatos da SPEC atualizados apenas onde necessário
- antes de mudar para `ready`, reaplique os readiness gates da skill e confirme ausência de perguntas abertas, bloqueios ativos e critérios ativos bloqueados
- `ready` exige ao menos um acceptance criterion ativo e não bloqueado, além das demais regras da skill
- retorno curto com status anterior e atual, arquivos alterados, IDs criados ou atualizados, perguntas resolvidas ou abertas, blockers restantes e próxima ação documental aplicável quando houver

Restrições excepcionais:
- {{EXCEPTIONAL_CONSTRAINTS_OR_NONE}}
