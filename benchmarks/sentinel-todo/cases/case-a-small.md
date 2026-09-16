# Filtrar Todos por estado

## Objetivo

Permitir filtrar a listagem por estado.

## Comportamento

- Adicionar `list --completed` para retornar somente itens com `completed=true`.
- Adicionar `list --pending` para retornar somente itens com `completed=false`.
- `list` sem flag preserva o comportamento atual.
- Usar as duas flags juntas é inválido e não altera o storage.
- Os comandos `add` e `complete` permanecem compatíveis.
- Testes cobrem o novo comportamento e as regressões.

O formato persistido não deve mudar se isso não for necessário.
