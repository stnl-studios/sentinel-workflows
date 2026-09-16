# Adicionar prioridade ao Todo

## Objetivo

Adicionar prioridade `low`, `medium` ou `high` aos itens Todo, com default
`medium` e compatibilidade com dados existentes.

## Interface e comportamento

- A forma existente continua sendo `add <title...>`.
- A única forma com prioridade é
  `add --priority <low|medium|high> <title...>`.
- O title continua obrigatório.
- Sem `--priority`, o novo Todo recebe e persiste `medium`.
- Com uma prioridade válida, o novo Todo persiste o valor informado.
- `add` bem-sucedido retorna exit code `0` e imprime o Todo como um JSON object
  em uma única linha.
- Prioridade inválida é erro de domínio/input: exit code `1`, mensagem em stderr
  iniciada por `error:` e identificando a prioridade inválida, stdout vazio e
  storage preservado byte a byte.
- Ausência de valor após `--priority` é erro de uso: exit code `2`, usage em
  stderr, stdout vazio e storage inalterado.
- Nenhum erro produz write parcial.
- `list` torna `priority` observável em cada JSON object e preserva a ordem
  estável atual; nenhuma correspondência mantém stdout vazio e exit code `0`.
- Dados antigos sem `priority` são interpretados como `medium`; somente ler ou
  listar esses dados não reescreve o storage.
- `complete` funciona em um registro antigo e preserva sua prioridade.
- Um write legítimo posterior pode materializar o default `medium` em dados
  antigos, desde que o comportamento permaneça compatível.
- Os demais comportamentos de `add`, `list` e `complete` preservam seus exit
  codes, JSON-line output, ordem e semântica de persistência atuais.
- Nenhuma dependência externa é adicionada.

## Verificação do comportamento

O comportamento deve ser verificável para add sem prioridade, cada valor
válido, prioridade inválida, flag sem valor, persistência e listagem. Também
deve cobrir registro antigo sem o campo, complete nesse registro e a
compatibilidade de `add`, `list` e `complete`.
