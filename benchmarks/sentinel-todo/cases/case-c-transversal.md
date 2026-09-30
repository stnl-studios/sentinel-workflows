# Arquivar e desarquivar Todos

## Objetivo

Adicionar archive e unarchive preservando a compatibilidade dos dados
existentes.

## Interface e listagem

- Os novos comandos são `archive <id>`, `unarchive <id>` e `list --archived`.
- `list` mostra somente itens não arquivados.
- `list --archived` mostra somente itens arquivados e é a única nova forma de
  `list`.
- A ordem relativa dos itens permanece estável.
- Cada item listado é impresso como um JSON object em uma única linha.
- Nenhuma correspondência produz stdout vazio e exit code `0`.
- `list` e `list --archived` são somente leitura e não alteram o storage.
- Flags desconhecidas seguem o contrato existente de erro de uso.

## Persistência e estados

- Um item arquivado permanece no storage.
- Dados antigos sem `archived` equivalem a `archived=false`; somente ler ou
  listar esses dados não reescreve o storage.
- Archive de item ativo persiste `archived=true` e retorna o Todo atual.
- Archive de item já arquivado é sucesso idempotente e retorna o estado atual.
- Unarchive de item arquivado persiste `archived=false` e retorna o Todo atual.
- Unarchive de item já ativo é sucesso idempotente e retorna o estado atual.
- Archive e unarchive bem-sucedidos retornam exit code `0` e imprimem o Todo
  como um JSON object em uma única linha.
- Id inexistente é erro de domínio: exit code `1`, mensagem em stderr iniciada
  por `error:` e identificando a causa, stdout vazio e nenhum write parcial.
- Archive ou unarchive sem exatamente um id é erro de uso: exit code `2`, usage
  em stderr, stdout vazio e storage inalterado.

## Comandos existentes

- `add` cria um item ativo.
- `complete` continua funcionando para item ativo.
- `complete` em item arquivado é erro de domínio: exit code `1`, mensagem em
  stderr iniciada por `error:`, stdout vazio e storage inalterado.
- Archive e unarchive preservam `completed`.
- Para itens ativos, os comandos existentes preservam seus exit codes,
  JSON-line output, ordem e semântica de persistência atuais.
- Nenhuma migration framework ou dependência externa é adicionada.

## Verificação do comportamento

O comportamento deve ser verificável para archive, unarchive, idempotência, id
inexistente, listagem normal e arquivada, ausência de correspondências, dados
antigos e persistência. Também deve cobrir complete em item ativo e arquivado e
a compatibilidade de `add` e `complete`.
