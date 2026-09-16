# Adicionar prioridade ao Todo

## Objetivo

Adicionar prioridade aos itens Todo.

## Comportamento

- Os valores permitidos são `low`, `medium` e `high`.
- `add` aceita prioridade opcional, com default `medium`.
- Prioridade inválida é rejeitada sem persistência parcial.
- A prioridade é persistida e fica observável em `list`.
- Dados antigos sem o campo `priority` continuam válidos e se comportam como `medium`.
- `add`, `list` e `complete` permanecem compatíveis.
- Testes cobrem domínio, persistência e CLI.
- Nenhuma dependência externa é adicionada.
