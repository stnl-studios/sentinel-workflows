# Filtrar Todos por estado

## Objetivo

Permitir filtrar a listagem por estado sem alterar os demais comandos nem o
formato persistido.

## Interface e comportamento

- `list` mantém exatamente a listagem normal atual.
- `list --completed` inclui somente Todos com `completed=true`.
- `list --pending` inclui somente Todos com `completed=false`.
- A ordem relativa dos itens filtrados é preservada.
- Cada item listado é impresso como um JSON object em uma única linha.
- Nenhuma correspondência produz stdout vazio e exit code `0`.
- Todas as variantes de `list` são somente leitura e não alteram o storage.
- Usar `--completed` e `--pending` juntos é erro de uso: exit code `2`, usage
  em stderr, stdout vazio e storage preservado byte a byte.
- Flags não reconhecidas continuam seguindo o mesmo contrato de erro de uso.
- `add` e `complete` preservam seus exit codes, JSON-line output, ordem e
  semântica de persistência atuais.

## Verificação do comportamento

O comportamento deve ser verificável para listagem sem filtro, cada filtro,
filtro sem correspondências, flags mutuamente exclusivas e flags desconhecidas.
Também deve demonstrar que listagens e erros de flags não alteram o storage e
que `add` e `complete` continuam compatíveis.
