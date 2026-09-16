# Arquivar e desarquivar Todos

## Objetivo

Adicionar archive e unarchive preservando a compatibilidade dos dados existentes.

## Comportamento

- Um Todo pode ser arquivado e permanece persistido.
- A listagem padrão não mostra itens arquivados.
- `list --archived` mostra itens arquivados.
- `archive` e `unarchive` recebem um id.
- Dados antigos sem `archived` são interpretados como não arquivados.
- `add` e `complete` continuam funcionando para itens ativos.
- Archive ou unarchive de id inexistente é erro.
- Erros não produzem write parcial.
- Testes cobrem backward compatibility, persistência, CLI e regressão.
- Nenhuma migration framework ou dependência externa é adicionada.
