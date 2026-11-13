# Exemplo de evidência semântica

Este exemplo pequeno demonstra uma matriz requisito → cenário → assertion. Foi inspirado nas classes de defeitos do diagnóstico da OS 39146, mas seus dez contratos são **sintéticos e explícitos**. Não reproduz o domínio completo, não usa código ou dados da OS e não valida o comportamento de agentes.

Execute:

```sh
node --test scripts/test-semantic-recovery.mjs
```

A fixture em `scripts/fixtures/semantic-recovery.mjs` oferece uma implementação correta e dez mutações intencionais. Cada assertion roda uma vez contra a implementação correta e uma vez contra seu mutante. O segundo teste só passa quando a assertion rejeita o comportamento defeituoso. Um erro arbitrário não conta: a rejeição precisa ser `ERR_ASSERTION`.

| Contrato sintético | Cenário | Observável exigido | Mutação rejeitada |
| --- | --- | --- | --- |
| SEM-001 | Ausência e zero legítimo | `null` permanece diferente de `0` | Substituir ausência por zero |
| SEM-002 | Data ausente e fornecida | Preservar ambas | Inventar data mínima |
| SEM-003 | Histórico e PCR discordam | Campo e filtro usam situação PCR | Usar situação histórica |
| SEM-004 | Identificador inexistente | Retornar ausência | Fabricar registro |
| SEM-005 | Consulta, erro, recuperação | Limpar linhas/total no erro e recuperar normalmente | Manter total antigo |
| SEM-006 | Posição parcial e ausente | Preservar parte conhecida; tooltip de inexistência só na ausência | Tratar posição parcial como inexistente |
| SEM-007 | Exportação maior que uma página | Exportar todos os resultados filtrados; preservar vazio/zero | Exportar apenas página corrente |
| SEM-008 | Primeira, última, vazia e filtrada | Offset e total consistentes | Deslocar página incorretamente |
| SEM-009 | Rótulo sem fonte | Não inventar “não sublocado” | Converter ausência em afirmação negativa |
| SEM-010 | SAP sem/com número | Link somente quando existe número | Gerar link vazio |

## Como usar no trabalho real

Parta dos requisitos aprovados do produto, não destes valores de exemplo. Para cada variante material, escolha entrada que diferencie a implementação correta do defeito e uma assertion sobre saída observável. Execute contra o caminho real e demonstre que um defeito relevante seria detectado. Evite usar uma cópia da implementação como resultado esperado.

A prova aqui é restrita: as assertions detectam os dez mutantes nessa fixture determinística. CSV, mensagens, IDs, datas e status são escolhas do exemplo, não novas regras da OS. Não mede banco, UI, exportador real, autenticação, concorrência, desempenho ou integração. Em particular, paginação em memória **não comprova** ausência de materialização de todos os históricos na ordenação por cumprimento; isso exige evidência específica no acesso a dados real. Também não comprova que um reviewer LLM encontrará os defeitos sem ajuda.
