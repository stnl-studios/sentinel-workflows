Use `stnl-spec-lifecycle-manager`.
MODE=RESUME

SPEC:
- <SPEC_PATH>

Novas informações:
- <NEW_INFORMATION>

Objetivo:
- incorporar informações novas preservando a coerência documental da SPEC

Entrada mínima:
- `feature_spec.md` preexistente
- informações novas ou respostas a perguntas abertas

Escopo:
- entra: artefatos afetados, IDs existentes, inconsistências documentais e perguntas materiais
- fora: planejamento de execução, tasks e implementação

Contexto disponível:
- SPEC existente
- novas informações fornecidas pelo usuário

Resultado esperado:
- artefatos da SPEC atualizados apenas onde necessário
- IDs preservados sem renumeração ou reutilização e inconsistências resolvidas
- retorno curto com status, alterações relevantes, perguntas abertas e próximo MODE

Restrições excepcionais:
- <EXCEPTIONAL_CONSTRAINTS_OR_NONE>
