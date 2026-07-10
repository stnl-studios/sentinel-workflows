Use `stnl-spec-lifecycle-manager`.
MODE=CLOSE

SPEC:
- {{SPEC_PATH}}

Objetivo:
- fechar documentalmente a SPEC sem depender de execução

Entrada mínima:
- `{{SPEC_PATH}}/feature_spec.md` com status documental `ready`
- todos os readiness gates e closure gates aplicáveis devem passar
- perguntas finais, quando existirem, somente `resolved`, `bypassed` ou `dropped`

Escopo:
- entra: `feature_spec.md`, todos os artefatos materializados e indexados, e diretórios externos apenas para confirmar preservação
- fora: plano de execução, tasks, diff, testes, implementação, correção de blockers e RESUME implícito

Contexto disponível:
- não pressupor que todas as categorias existam
- diretórios externos, incluindo `execution/`, devem permanecer inalterados
- não usar evidência de implementação como gate documental

Resultado esperado:
- sucesso: consolidar conteúdo durável, validar que nada necessário foi perdido antes da remoção de `shared/`, substituir `feature_spec.md`, remover `shared/` somente após essa validação e retornar `closed`
- sucesso: informar arquivo final, categorias consolidadas, remoção de `shared/` e diretórios externos preservados
- falha: não modificar arquivos, não remover `shared/`, não produzir consolidação parcial, não alterar status e não tentar corrigir blockers
- falha: retornar `NEEDS_RESUME`, gates falhos, arquivos e IDs envolvidos, com bloqueios documentais retornados sem mutação quando o fechamento não for permitido

Restrições excepcionais:
- {{EXCEPTIONAL_CONSTRAINTS_OR_NONE}}
