# Interfaces da bancada Sentinel Todo

Este documento pertence à bancada. Descreve interfaces normais do produto;
não cria contrato, callback, variável ou ferramenta nas skills.

## Estado da adaptação

U3.15-D qualificou o produto no cliente nativo, até CLOSE e leitores novos.
Isso não qualificou o manager Node/SDK. O gate estático S1 de U3.16 continua
`NATIVE_TRANSPORT_UNPROVEN`. Aj autorizou posteriormente o recorte S2/App Server:
o adaptador e sua captura foram implementados/testados offline (§25.11 do plano).
O manager/provider normal já foi composto e testado mecanicamente até CLOSE,
finalizer/export e retenção, nos regimes declarados. A emissão real dos dados e
o carregamento efetivo do bundle ainda não estão comprovados. O consumidor
terminal convertido verifica fonte current+completed e percorre CLOSE/export offline.
O bloqueio de retenção de §25.13 foi corrigido no produto sob autorização específica,
com QA mecânica e revisão (§25.14); escopo offline concluído. A nova fonte
não herda o PASS nativo da candidata D. Não iniciar prova real/campanha por este aceite.

## Quem controla cada fronteira

| Entrada/retorno normal | Dono | Consumo externo permitido |
| --- | --- | --- |
| Requirements source, SPEC_PATH, operação e slice | Usuário/cenário | Manager fornece inputs e segue somente handoffs públicos legais. |
| PLAN: candidata/root e pedido de revisão | Produtor de preparação | Reter root exato retornado; não procurar/adotar diretórios privados. |
| REVIEW_PLAN: bytes aprovados e activation | Revisor/publicador normais | Observar readback; autoria diferente exige revisão dos bytes finais. |
| EXECUTE/APPLY/VALIDATE: admissão, binding, recipe, captura | Cliente/controller/runners normais | Observar fatos e consumo; não reservar owner, executar recipe ou publicar veredicto em lugar deles. |
| Captura oficial: agentId, completed, finalResponse | Ferramenta oficial e produtor normal ainda a demonstrar para S1 | Preservar primeira resposta integral e correlação com handle; parent final/resumo não substitui o filho. |
| COMPLETE integral e CLOSE | Quality/lifecycle normais | Reter fatos públicos antes de CLOSE; correlacionar retorno, digest/settlement e leitor SPEC_CLOSED. |

`NO_EXECUTION` não prova PLAN publicado: uma candidata pode estar aguardando
revisão. `TESTS_FAIL` não equivale a finding formal. Leitor quiet recusando
owner não prova perda de owner. Retomar estado do processo Node não inicia
outro turno; `resumeThread().run()` inicia e deve contar um turno novo.
Efeito incerto, identidade ausente ou bytes divergentes bloqueiam; não corrigir
artifacts/controles para forçar uma transição.

## Contextos e comparações

O principal usa contexto novo por operação. Um cenário adicional offline cobre
continuidade de autoria no mesmo fluxo, em trecho declarado antecipadamente;
reviews/runners permanecem independentes. Isso representa a preferência de Aj,
não um limiar numérico de contexto baixo. Não alternar regime silenciosamente.

Registrar regime/trecho, versão, bundle, modelos e IDs de thread/turno disponíveis
na identidade/evidência externa existente. Separar agregados por regime. Um
contraste explícito entre políticas não é economia atribuível apenas ao produto.
Ausência de dados fica unavailable, nunca zero. Esse cenário offline não prova
capacidade ou qualidade de contexto do cliente real nem acrescenta FULLs.

## Gate público ainda aberto

A integração SDK anterior foi retirada do caminho ativo. Seus diagnósticos S1
permanecem históricos: não demonstraram o resultado integral do filho nem a
seleção inequívoca do bundle com HOME normal. A implementação corrente usa o
provider S2 abaixo, com byte capture e correlação exercitados somente offline.
Ainda falta a prova focal real autorizada separadamente; não inferir capacidade
runtime de fixtures de protocolo.

O consumidor normal é `captureNative` em
`skills/workflows/stnl-slice-quality-manager/runtime/execution-current-operation.mjs`.
Ele exige esses dados oficiais e preserva bytes/owner/binding; não será adaptado
à bancada. A seleção S2 exige paths e hashes congelados; só a prova real futura demonstrará
que o cliente usa esses mesmos recursos em execução. Não substituir esses dois elos por inferência, prompt ou resumo.

S1 permanece como diagnóstico da integração SDK anterior; não prova uma limitação
universal. A investigação pública e o recorte S2 foram aprovados depois dele.
Não medir apenas o principal como substituto do filho, ler sessões privadas,
copiar autenticação ou introduzir hooks nas skills.

## Adaptador S2 — alcance offline

`agents/codex/runtime/app-server-transport.mjs` contém o transporte JSONL limitado
e funções explícitas; importar o módulo não inicia cliente nem modelo.
`connectAppServer` é opt-in, possui somente o processo stdio que cria e herda o
ambiente normal sem escrever HOME/CODEX_HOME/config. Não conecta ao desktop.
O caller deve verificar a integridade do snapshot/CLI completo pelo mecanismo
existente, fornecer o hash do launcher e possuir o processo até encerrá-lo.
O pin do launcher e o handshake0.163 não substituem o hash do binário do snapshot.
Pedido de interação/aprovação, erro de permissão, protocolo inválido, timeout ou
desconexão bloqueia; o adaptador não aceita permissões nem reconecta/reenvia.
Efeito de `turn/start` sem resposta permanece incerto para o ledger do caller.

- `describeAppServerBundle` descreve todos os arquivos de skills/siblings e o
  TOML do runner da distribuição candidata. O caller congela essa identidade
  junto ao snapshot existente; `assertAppServerBundle` recusa drift. Não há novo
  journal, engine ou parser de contrato: a leitura do TOML reutiliza o módulo atual.
- `selectAppServerBundle` usa `skills/extraRoots/set` só nesse processo e
  `skills/list` com reload. Exige caminhos físicos, todos os siblings descobertos
  e a skill exata habilitada; homônimos externos Sentinel são desabilitados só
  no config da thread. A entrada normal é `{type:"skill",name,path}` e o override
  do papel aponta para o TOML congelado. Não há fallback para a cópia pessoal.
- `startAppServerTurn` oferece início fresh e continuidade somente de thread
  autoral previamente admitida, com ID/cwd/bundle exatos. Reviews/runners não
  herdam esse contexto. A bancada declara antecipadamente o trecho reutilizado;
  não há limiar inventado de contexto baixo. Orçamento/contexto/ownership continuam
  com o manager/controller normal, não com o transporte.
- `bindAppServerChild` consulta somente os itens do turno pai conhecido e retém
  `agentPath`/`agentThreadId` oficiais, modelo/effort. O caller guarda esse binding
  no estado externo já existente; o adaptador não cria armazenamento paralelo.
- `readAppServerChild` consulta esse mesmo pai e o filho correlacionado via
  `thread/read`, `thread/turns/list`, `thread/items/list`, com paginação completa e
  limitada. Exige filho fresh do pai, papel correto, uma única rodada concluída
  sem erro e última resposta integral. Divergência entre fontes bloqueia.
  `wait_agent`/mailbox concluído e resposta do principal nunca certificam o filho.
- `captureAppServerChild` grava automaticamente o envelope normal
  `{agentId,status:"completed",finalResponse}` para `capture-native`. Não altera
  texto nem escolhe um veredicto. Arquivo anterior divergente é preservado e
  bloqueia; o mesmo binding após reinício só consulta dados públicos e reutiliza
  os mesmos bytes, sem start/resume/followup ou recipe. O controller normal ainda
  verifica owner, observação, receipt e semântica; a bancada não os substitui.

O caminho mecânico exercitou essa captura até o consumidor normal real, incluindo
falha de persistência e replay. O servidor foi falso; isso não atesta dados reais
nem o uso do TOML pelo cliente. Paths/hashes são checagens nas fronteiras, sem
garantia de isolamento contra alguém que mude os arquivos do host entre elas.
O manager atual usa `native-provider.mjs`; os callers exclusivos SDK/managed,
HOME descartável, broker e wrappers de retry/reassessment foram retirados. Os
mecanismos de conversão histórica do produto e os checks ambientais de temporários
foram preservados. Não houve mudança de skill/template/TOML/SDK package.

## Composição normal da bancada — checkpoint offline

- Entrada: `node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --case A`
  (campanha permanece posterior). O teste de entrada usa essa mesma análise de
  argumentos e núcleo, com provider injetado exclusivamente em checkout próprio
  marcado `OFFLINE_TEST_ONLY` e SDK compartilhado verificado; não abre cliente real.
- `native-provider.mjs` observa o principal e os filhos oficiais. Permissões são
  herdadas por `approvalPolicy:null`/`sandbox:null`; a bancada não força Full Access
  ou never. A política efetiva não retornada fica unavailable. Requisição de
  aprovação é bloqueio, sem consentimento automático.
- PLAN retorna `AWAITING_REVIEW` e root público validado; REVIEW_PLAN recebe esse
  root como input normal. O manager não fabrica owner, receipt ou publicação.
  A formal recebe pedido integral explícito, conforme o contrato normal.
- O ledger reserva principal e margem legal de filhos antes do despacho, conta
  cada UUID observado uma vez e retém margem durante incerteza. Descendants não
  admitidos são contados e bloqueiam. Usage não fornecida fica null/unavailable.
- Interrupção com dispatch persistido permite somente observar esse turno por
  APIs públicas. O mesmo resultado é reaproveitado byte a byte, sem novo turno,
  recipe, publicação ou nova candidata. Ausência de identidade suficiente bloqueia.
  Primeira resposta/evidência permanece preservada.
- Antes de CLOSE, reter imagem pública COMPLETE, activation, manifest, observação
  e disposition. Após CLOSE, conferir recibo/transação/digest e reader SPEC_CLOSED;
  revalidar imagem Initial/fontes/carriers pelos validators públicos e recomputar
  métricas dos bytes retidos. Sumário COMPLETE, recibo absent e workspace alheia
  não bastam. A imagem convertida ainda para explicitamente como UNPROVEN.
- Export diagnóstico de case/focal é permitido, identificado pelo escopo; promoção
  e comparação de FULL continuam exigindo FULL íntegro. Contextos diferentes ou
  ausentes na identidade não produzem economia comparável. Offline jamais promove
  resultado runtime.
- `clean --run ID` exige run própria inativa, prova terminal/ledger/export íntegros
  e ausência de symlinks/consumo pendente. Retém por rename atômico em
  `benchmark-temp/.retained/ID`; export já concluído só é reutilizado se igual ao
  atual. Essa retenção local é explícita, não exigência eterna do produto. Nenhuma
  purga de históricos é executada no startup. Falha preserva a fonte própria.
- `run --resume ID` depois de FOCAL_STOP continua o mesmo caso. Ao passar
  explicitamente de focal para case, preserva journal/raw anteriores e altera
  somente o escopo do journal externo: finalizer passa a exigir oracle e CLOSE.

Limites deste checkpoint: provider/juízos de testes são fictícios, testes usam APIs
públicas reais para efeitos mecânicos em fixtures e nenhum julgamento de modelo
foi certificado. REPLAN/retained-completed pós-CLOSE está bloqueado por retenção
do produto congelado; os gates
restantes de U3.16 e U3.17/U3.18 continuam separados.

### Schema e prova futura

Exportação oficial da instalação efetiva0.163 foi conferida pelo gate read-only
`node scripts/check-app-server-schema.mjs EXPORTED_SCHEMA_DIRECTORY` contra os
campos necessários do tag público
[`rust-v0.163.0`](https://github.com/openai/codex/tree/rust-v0.163.0/codex-rs/app-server-protocol).
O gate retorna `PASS_SCHEMA_ONLY`, não compatibilidade comportamental universal.
Usa `skills/extraRoots/set`; não supõe campos de documentação mais recente, como
`perCwdExtraUserRoots`. Overrides pontuados são processados pelo
[loader público](https://raw.githubusercontent.com/openai/codex/rust-v0.163.0/codex-rs/config/src/overrides.rs);
o [handler público](https://raw.githubusercontent.com/openai/codex/rust-v0.163.0/codex-rs/app-server/src/request_processors/catalog_processor.rs)
mantém extra roots em memória.

Próximo gate offline: resolver por decisão separada a retenção do produto que
bloqueia CLOSE convertido e revalidar esse percurso. O consumidor externo não
remove controles nem altera a guarda do produto. O percurso Initial sem managed até CLOSE/export já foi exercido,
incluindo findings e os dois regimes; isso não encerra a unidade. Depois,
uma U3.17 separadamente autorizada deve demonstrar carregamento do bundle, spawn
correto, resposta integral real e retomada. Incompatibilidade, identidade ambígua,
texto incompleto, drift ou necessidade de tocar skills/permissões são parada,
sem trocar superfície, simular prova ou gastar outro turno automaticamente.

## Medição e retenção

Oracle e instrumentação de storage são exclusivos da bancada, fora do workspace
candidato. O observer é limitado às APIs Node declaradas no seu módulo e à raiz
de storage do subprocesso CLI. Não é sandbox do host nem garantia contra um
processo adversarial que contorne deliberadamente o runtime JavaScript. Uma
capacidade não observada invalida a evidência correspondente; comparação de
bytes antes/depois sozinha não detecta tentativa de escrita ou write/restore.

O preload `product-write-observer.cjs` observa as variantes disponíveis de
write/append/truncate/remove/mkdir/chmod/chown/utimes, rename/copy/link/symlink,
open com flags de escrita, descritores, FileHandle e streams, nas APIs Node
sync/callback/promises listadas no módulo. Resolve symlinks/ancestrais existentes
e aliases de inode dos arquivos de storage presentes no início. Fecha o vínculo
de descritores quando fechados. Subprocesso, Worker e addon nativo recusados,
trace ausente/incompleto ou overflow resultam em `PRODUCT_OBSERVATION_UNPROVEN`,
consumido como BLOCKED; tentativa de escrita observada é falha funcional.
Essa cobertura não prova interceptação de código nativo/internal bindings ou
manipulação hostil do preload. As APIs do host não se tornam um sandbox.

Acceptancev2 usa IDs estáveis de checks (ordem não é semântica), hash separado
do oracle+observer e vínculo root/hash do workspace físico. O export verifica
esse vínculo contra o workspace do caso e a identidade congelada do instrumento.
Um receipt genuíno de outro workspace/bytes não qualifica o atual. Não há signer
ou autenticação contra alguém que forje todos os arquivos do host; integridade
do snapshot e da entrada permanece obrigatória. Históricos v1 são diagnóstico,
não recebem certificação retroativa. A validação manual/API/CLI e o engine
JSON Schema Ajv2020 foram exercidos sobre o resultado real da fixture offline.
O finalizer literal pós-CLOSE passou no percurso Initial; convertido/REPLAN
permanece pendente de .8. Ajv é dependência de desenvolvimento local da bancada,
sem modificar o package/lock do SDK.

## N e publicação da campanha

Nas entradas funcional e formal, `campaign.fullRuns` tem padrão3. Override
`--runs N` exige inteiro positivo seguro e argumentos únicos/conhecidos. As FULLs
são sequenciais; A continua antecedendo B/C dentro de cada uma. Na primeira falha
ou efeito incerto, não há próximo FULL. Os testes usam hooks controlados, não
executam os runners/manager reais.

Cada resultado disponível é retido sem promover a campanha. Somente N/N PASS
qualificados atualizam latest (funcional) ou promovem o conjunto formal. Baseline
ausente, malformada ou incompatível deixa comparação/deltas unavailable, sem
inventar economia e sem invalidar qualidade atual independente. Erro inesperado
num comparador compatível bloqueia. Iniciar uma campanha não apaga nem republica
históricos, ledgers ou owners; só o lock temporário próprio é retirado ao sair.
Retenção/export e cleanup explícito do manager passaram mecanicamente para o
percurso Initial; os gates .8/.10 de evidências convertidas continuam pendentes.

Congelar produto e instrumento separadamente. Antes de cleanup, reter os fatos
e primeiras respostas necessários ao resultado/diagnóstico. Não exigir Tasks ou
execution após CLOSE, manter witness eterno ou executar modelo para reconstruir
história desnecessária. Preservar owners/episódios pendentes; excluir somente
material próprio comprovadamente dispensável.

O registro sandbox-probe-v1/CLI0.160 é histórico e não certifica0.163 ou S1.
SDK instalado com provider offline verificado serve à QA mecânica; não é prova
nativa. U3.17 e U3.18 exigem autorização e orçamento próprios.

Autoridade de planejamento: [P1-B, §25](../../maintenance/P1-B-PLANO.md#u316-integral).
