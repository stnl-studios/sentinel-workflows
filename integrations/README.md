# Integrações Sentinel por plataforma

Cada integração de plataforma contém os dois subagentes Sentinel ativos: o `stnl-validation-runner` e o `stnl-spec-context-scout`.

## Fonte canônica e instalação

A fonte canônica dos adapters vive diretamente nas fronteiras de integração deste repositório:

- Codex: `integrations/codex/agents/stnl_validation_runner.toml` e `integrations/codex/agents/stnl_spec_context_scout.toml`.
- Claude Code: `integrations/claude-code/agents/stnl-validation-runner.md` e `integrations/claude-code/agents/stnl-spec-context-scout.md`.

Esses caminhos são de fonte, não de instalação. O fluxo principal
`node scripts/install-sentinel.mjs` instala Codex e Claude Code juntos para o
usuário atual: `~/.codex/agents/` no Codex e `~/.claude/agents/` no Claude Code,
além das skills e catálogos nativos de cada plataforma. O modo secundário
`--scope project --project <path>` usa os mesmos layouts relativos dentro do
projeto consumidor. Um filtro `--platform` instala somente o adapter escolhido;
sem filtro, as duas integrações participam da mesma transação. Consulte
`INSTALL.md` para layouts, ownership, transições e opções completas.

Os nomes nativos permanecem `.codex/agents/stnl_validation_runner.toml` e
`.codex/agents/stnl_spec_context_scout.toml` no Codex, e
`.claude/agents/stnl-validation-runner.md` e
`.claude/agents/stnl-spec-context-scout.md` no Claude Code.

## `stnl-validation-runner`

Este agente copiável, barato e isolado executa checks e validação fora do contexto principal para as skills `stnl-slice-executor` e `stnl-slice-quality-manager`.

O Codex preserva `gpt-5.6-luna` com effort `medium`; o Claude Code preserva Haiku com effort `medium`.

### Fluxo manual e delegações automáticas

As operações manuais são `PLAN`, `REPLAN` quando uma recuperação explícita exige nova estratégia, `REVIEW_PLAN`, `MATERIALIZE_TASKS`, `REVIEW_TASKS` opcional, `EXECUTE_SLICE`, `VALIDATE_SLICE`, `APPLY_FINDINGS` quando necessário e `OPERATION=CLOSE`. `REPLAN` exige `REPLAN_REASON`, retorna `REPLAN_DRAFT` e nunca substitui `REVIEW_PLAN` ou `MATERIALIZE_TASKS`. Não existe passo manual adicional de testes.

O runner aceita exatamente três operações internas, sempre acionadas automaticamente pelo launcher da operação manual:

- `EXECUTE_SLICE`: o contexto principal implementa; o runner executa checks e retorna `TESTS_PASS`, `TESTS_ACCEPTED`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`.
- `APPLY_FINDINGS`: o contexto principal corrige findings autorizados; o runner testa correções e regressões relacionadas e retorna `TESTS_PASS`, `TESTS_ACCEPTED`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`.
- `VALIDATE_SLICE`: o runner faz revisão e validação formal independentes e retorna `PASS`, `ACCEPTED`, `NEEDS_FIX` ou `BLOCKED`.

Descoberta de suites, comandos, logs, stack traces e resultados intermediários permanecem no contexto isolado. O contexto principal recebe somente evidência compacta e persiste a seção autorizada. Não existe fallback para executar checks ou validação no contexto principal.

Depois da implementação ou correção inicial, cada invocação manual válida de `EXECUTE_SLICE` ou `APPLY_FINDINGS` chama o runner no mínimo uma vez e no máximo três vezes: a primeira chamada é obrigatória e pode ser seguida por até duas rechecagens. Não existe bypass por mudança simples ou por provável ausência de checks; o runner sempre faz a descoberta independente, inclusive quando retorna `TESTS_NOT_APPLICABLE`. Em `TESTS_FAIL` nas duas primeiras rodadas, o contexto principal persiste a evidência, corrige somente a falha objetiva dentro do escopo aprovado, registra a correção e o escopo atualizado e chama o runner novamente. `TESTS_PASS`/`TESTS_ACCEPTED`/`TESTS_NOT_APPLICABLE` entram em `IMPLEMENTED_AWAITING_VALIDATION` ou `FINDINGS_CORRECTED`; `BLOCKED` após entrada em check entra em `AUXILIARY_BLOCKED`, enquanto pre-check autenticado de infraestrutura fica em `RUNNER_RESULT_BLOCKED` sem criar check nem consumir rodada; só a mesma operação/slice retoma. A terceira falha entra em `IMPLEMENTATION_RETRY_EXHAUSTED` ou `FINDINGS_RETRY_EXHAUSTED`: `VALIDATE_SLICE` é a única próxima operação da slice, sem reentrada do executor até o veredito formal. Não existe quarta chamada, loop ilimitado ou transição automática para `VALIDATE_SLICE`.

Discovery actions são leituras e comandos read-only usados apenas para localizar scripts, CI, manifests, Makefiles, testes próximos, convenções e comandos autoritativos. Essas ações são permitidas, não contam como verification commands e são persistidas separadamente: fontes em `Discovery sources`, métodos em `Discovery actions`. Verification commands são testes, builds de verificação, linters, typechecks, compilações, validators, contract tests, smoke tests, regressões e outros checks observáveis da implementação ou correção. Caminhos de estado testado e manifesto são normalizados relativamente ao diretório da task detalhada selecionada.

`TESTS_PASS` confirma os comandos obrigatórios com exit code zero e classifica integralmente falhas externas independentes como non_blocking em Gate assessments; escopo verificado, tipos considerados, testes selecionados e cobertura nunca podem ser `none`. `TESTS_FAIL` representa verification command executado que falhou e pode sustentar uma correção limitada. `TESTS_NOT_APPLICABLE` representa somente descoberta objetiva de que nenhum verification command se aplica ao escopo e exige fontes e ações de descoberta, tipos considerados, justificativa e `No verification-command confirmation`; nenhum verification command pode ter sido executado. `BLOCKED` representa check aplicável impedido por ferramenta, credencial, dependência, ambiente, serviço, permissão ou comando autoritativo indisponível. Falha ou impossibilidade nunca é mascarada como não aplicabilidade. Em rodadas posteriores, `Correction paths` contém caminhos normalizados somente para correção file-backed e exact `none` para correção fileless. Em `APPLY_FINDINGS`, findings verificados formam um subconjunto canônico dos targets; os não sustentados são exatamente os findings ativos restantes e nunca se sobrepõem aos verificados. Todo finding novo nasce `active` e só uma tentativa formal estritamente posterior à origem pode resolvê-lo ou supersedê-lo.

Todo verification command passa pelo runtime de validação distribuído com `stnl-slice-executor` e `stnl-slice-quality-manager`, resolvido internamente pela skill dona a partir de sua localização carregada. O operador e o payload não informam skill root, nome de arquivo ou path físico do harness. Antes de copiar ou executar, o runtime confirma operação, slice, round e prior evidence ID contra o lifecycle atual. Symlinks são admitidos pelo target canônico final dentro da raiz canônica do projeto; links internos são preservados ou rebaseados na cópia e targets externos, quebrados ou ambíguos bloqueiam. Launchers externos só são admitidos a partir de um `bin` canônico herdado do PATH, com package boundary e interpreter derivados dentro da mesma instalação concreta; o runtime autentica um snapshot esparso read-only e inclui as identidades antes/depois no evidence e replay. O runtime copia o projeto para temp do sistema, aplica sandbox do SO sem rede, mantém source e `execution/` protegidos, permite somente HOME/TMP privados, diretórios `writePaths` e arquivos exatos `writeFiles` declarados, captura provenance/fingerprints e limpa a sessão. Mudança no workspace live mantém o fingerprint global fail-closed e persiste delta limitado a 64 paths ordenados, com contagens e fingerprint/truncation do conjunto completo. Ambiente sem sandbox suportada bloqueia sem fallback. Pre-check de infraestrutura produz provenance determinística `INVALID/INFRASTRUCTURE_BLOCKED/NONE`, sem subjects/comandos nem workspace isolado. Mutação protegida observada é `VALIDATION_SIDE_EFFECT`; acesso autenticado negado antes de mutation, sem delta protegido, é `SANDBOX_BOUNDARY_BLOCKED` com diagnóstico estruturado determinístico. Evidência inválida, stale, side-effecting, boundary-blocked ou replay não equivalente não pode sustentar finding ou sucesso. Manifestos preservam cada identidade de arquivo; agregação de diretório é apenas derivada. Replay de regressão precisa resolver uma evidência histórica `VERIFIED` persistida e provar equivalência material antes de executar.

A resolução física é project-defined execution first, por comando lógico. `host` mantém o fluxo anterior. `docker-compose` exige Compose file, service, imagem local declarada e fontes de instrução explícitas do projeto; Dockerfile isolado, Docker disponível, falha host ou autoridade ambígua nunca selecionam container. O harness confirma a imagem por ID e por labels de containers materializados quando existirem, mas executa em um container novo e descartável: não usa `compose exec`, não monta o workspace live e não expõe Docker socket, rede, capabilities, privilégios adicionais ou paths externos. Somente a cópia isolada read-only e `writePaths` internos limitados entram no container. Quando um cache é indispensável, `cacheVolumes` só admite um named volume local declarado no mesmo serviço e no mapping top-level do Compose com `name` explícito; o harness autentica sua identidade, copia-o uma vez para temp por container descartável, rejeita entries inseguras e monta somente esse snapshot read-only. O volume Compose live nunca entra no container de validação, e metadata e conteúdo do snapshot entram nos fingerprints. Falha de daemon/imagem/configuração gera pre-check autenticado de execution-environment e não cai para host; falha autenticada em create/start/wait/logs/kill depois da admissão gera `INVALID/INFRASTRUCTURE_BLOCKED/NONE` com stage `environment-execution`, nunca finding ou regressão. A seleção, as fontes autoritativas, o Compose, a imagem e qualquer cache isolado entram nos fingerprints de provenance/replay. Uma instalação .NET host continua separada e só é admitida pelo executável `dotnet` com `sdk/` dentro do mesmo package boundary autenticado.

O runtime exato é declarado no frontmatter da própria skill e resolvido pelo helper empacotado a partir de `import.meta.url`; a localização do launcher de integração não participa dessa resolução. Um `writeFiles` precisa estar ausente no snapshot inicial e ter parent real já existente; o harness não cria placeholder. No macOS, a policy autoriza somente o literal futuro, sem escrita no parent ou siblings. No Linux, `bwrap` bloqueia `writeFiles` no pre-check com `LINUX_EXACT_WRITE_FILE_UNSUPPORTED`, porque bind de arquivo exige objeto existente e write no parent ampliaria autoridade; use `writePaths` somente quando o diretório gerado inteiro for legitimamente necessário.

A descoberta ocorre dentro da chamada automática ao runner; ela não cria um novo passo manual. O contexto principal continua sem executar checks e sem fallback.

### Launchers

As três operações que usam o runner possuem launcher específico por plataforma:

- Codex: `slice-execute-codex.md`, `slice-apply-findings-codex.md` e `slice-validate-codex.md`.
- Claude Code: `slice-execute-claude.md`, `slice-apply-findings-claude.md` e `slice-validate-claude.md`.

O instalador copia os três launchers nativos de cada plataforma selecionada a
partir de `templates/prompts/`, preservando os nomes acima. Claude Code usa
`.claude/commands/` sob a raiz de instalação escolhida. Como o Codex não possui
um destino nativo equivalente e o mecanismo antigo é deprecated, o catálogo
explícito Sentinel usa `.sentinel/prompts/` tanto na raiz do usuário quanto na
raiz do projeto. Os adapters canônicos continuam vindo de
`integrations/codex/agents/` e `integrations/claude-code/agents/`.
`execution-plan.md`, `execution-replan.md`, `execution-plan-review.md`,
`execution-tasks.md`, `execution-tasks-review.md` e `execution-close.md`
continuam compartilhados; as demais famílias classificadas também são
distribuídas. Consulte `INSTALL.md` para o contrato completo.

No Codex, os launchers fazem spawn do agente customizado `stnl_validation_runner` em sessão independente com `fork_turns="none"`; nunca combinam o agente customizado com fork completo da thread ou do contexto principal. No Claude Code, delegam diretamente a `@agent-stnl-validation-runner` sem histórico da conversa. Os payloads mínimos incluem somente operação, `SPEC_PATH`, slice, Requirements authority, Plan revision, findings ou correções aplicáveis, escopo alterado, evidências compactas, rodada automática quando aplicável e contexto adicional estritamente necessário. Execution root, paths de plan/task, schema e runtime são derivados internamente e não atravessam a fronteira do payload. Históricos e logs completos não são encaminhados. O contrato carregado do runner envia sua identidade de capability já carregada; resolver e harness comparam essa identidade ao manifesto e aos bytes do pacote instalado antes de qualquer verification command. O resolver transporta stdout formal válido do harness em envelope opaco, sem reconstrução pelo agente.

Falha de inicialização ou transporte recebe no máximo uma segunda tentativa técnica em nova sessão independente e com o mesmo payload mínimo. Essas tentativas não consomem rodada `N/3`, não criam `implementation-check-NN`, `findings-check-NN` ou `attempt-NN`, e não autorizam correção. Duas falhas persistem o singleton `Delegation Blocker` com `Kind: initialization` e estado `RUNNER_INITIALIZATION_BLOCKED`; saída malformada usa `Kind: malformed-output` e `RUNNER_RESULT_BLOCKED`. Pre-check autenticado de infraestrutura/source-isolation usa `Kind: infrastructure`, preserva provenance/causa exatas, não cria record nem consome rodada e também fica em `RUNNER_RESULT_BLOCKED`. Um `BLOCKED` que entrou em check, `TESTS_FAIL` e falha de verification command permanecem categorias distintas; somente `TESTS_FAIL` válido pode autorizar a correção automática delimitada. O harness pode repetir uma vez a mesma rodada ou tentativa apenas quando o diagnóstico autenticado identifica um output legítimo dentro do workspace isolado; ele deriva o arquivo exato ou o primeiro diretório ausente necessário, não aloca rodada nova e não abre subject, execution root, HOME, NVM, toolchain, temp arbitrário ou workspace live.

O preflight compartilhado deriva recovery targets somente do estado persistido. Cada target informa operação, slice anulável, owner, record/round/retry quando aplicáveis e se a retomada exige a mesma operação. Os launchers preservam essa autoridade: blockers scoped reportam a operação e a slice concretas, enquanto recovery global mantém slice nula e nunca copia uma slice do pedido atual.

O singleton auxiliar registra `Pending automatic round: N/3`. Uma nova chamada da mesma operação, quando implementação ou correção e escopo já foram persistidos e o único bloqueio final é de inicialização, resultado malformado ou pre-check de infraestrutura, retoma diretamente na delegação, na rodada ainda não consumida. Não reimplementa, não reaplica findings, não duplica checklist, diff, evidência ou blocker, não reinicia identificadores e não cria rodada antes de a sessão iniciar. O fallback no contexto principal é proibido.

### Test evidence e formal validation

Depois de cada chamada de `EXECUTE_SLICE`, o contexto principal adiciona um registro append-only em `Implementation Test Evidence`, com `implementation-check-NN` globalmente sequencial na seção e a rodada automática `N/3`. Depois de cada chamada de `APPLY_FINDINGS`, adiciona `findings-check-NN` nas mesmas condições em `Findings Test Evidence`, associado ao ciclo de findings. Uma invocação manual posterior continua a numeração. Cada registro preserva estado, comandos, exit codes, falhas, correções entre rodadas, arquivos, escopo, descoberta de checks, justificativa de não aplicabilidade e efeitos inesperados. Esses checks são evidência auxiliar: não criam Validation Attempt, não criam Effective Validation Base, não emitem `PASS` formal e não marcam a slice `[x]`.

Somente `VALIDATE_SLICE` cria uma Validation Attempt e decide o estado de findings persistidos. `NEEDS_FIX` pode resolver findings corrigidos, manter problemas ativos, superseder identidade com outro `finding-NN` e criar novos findings. `PASS` deve resolver ou superseder atomicamente todo finding bloqueante ainda ativo. O runner confere atualidade, autoridade, cobertura e risco das evidências anteriores e decide proporcionalmente quais checks executar ou repetir. Quando recebe `TESTS_NOT_APPLICABLE`, revisa independentemente a descoberta e a justificativa, podendo rejeitá-las, descobrir um check aplicável ou exigir inspeção adicional. Evidência atual pode reduzir repetição injustificada, mas nunca substitui a revisão independente. A validação formal continua aceitando somente `PASS`, `ACCEPTED`, `NEEDS_FIX` ou `BLOCKED`; não aplicabilidade auxiliar não garante `PASS`. Somente um `PASS` ou `ACCEPTED` formal atual fornece o manifesto final completo, cria ou substitui a Effective Validation Base e permite a finalização automática da slice.

### Restrições

Os dois adaptadores implementam o mesmo contrato. O runner pode ler o escopo necessário e solicitar verification commands somente ao runtime interno, mas não edita código, testes, requisitos, planos ou tasks; não implementa, não corrige, não persiste, não finaliza, não cria subagentes e não faz commit. Artefatos transitórios de build ou teste são permitidos somente nos `writePaths` isolados ou `writeFiles` exatos declarados; efeito ou acesso não autorizado fora desses limites invalida a evidência.

`OPERATION=CLOSE` permanece read-only e retorna `EXECUTION_APPROVED` ou `EXECUTION_BLOCKED`; não usa runner, não executa testes, não faz retry e não aplica correções. Ele verifica resultados terminais `PASS|ACCEPTED|SUPERSEDED`, authority fingerprint/revision atual, findings/divergences bloqueantes ativos, Effective Validation Bases, ownership final por path, hashes, remoções, reaparecimentos, paths sem owner e drift posterior ao último `PASS`. Drift imutável, integração ausente ou authority stale roteiam para `REPLAN` com `REPLAN_REASON`, nunca para revalidar uma slice concluída. `MODE=CLOSE` do lifecycle retorna `SPEC_CLOSED`, é independente e não afirma delivery approval.

### Revalidação e aceitação de gates

O contrato canônico atual é `stnl-validation-runner/v10`, com handshake exato contra `stnl-validation-harness/v10`. Toda request operacional nova carrega ambos os protocolos e cada comando declara `executionEnvironment` explicitamente; ausência, versão desconhecida ou mixed version produz `INVALID/INFRASTRUCTURE_BLOCKED/NONE` antes de qualquer verification command. O resolver carregado pela skill verifica a capability exportada pelo runtime antes do dispatch. A provenance v10 inclui o protocolo e receipt do harness nos fingerprints e na identidade de evidence; runner e owner apenas transportam a saída exata, sem reconstrução. O candidate validator rejeita output textual/raw, provenance sem receipt, receipt adulterado e evidence histórica reapresentada como record novo. Registros v1/v9 históricos suportados continuam legíveis, mas não autorizam execução, append ou replay novos.

O runner v10 descobre e planeja checks lógicos; somente o packaged harness executa fisicamente build, test, lint, typecheck, compiler, validator ou regression. Codex e Claude ainda concedem ao subagente um shell geral para discovery e para acionar o resolver, pois as integrações atuais não oferecem uma allowlist de executáveis equivalente. Assim, o boundary mecânico garante autoridade — um comando direto não pode produzir evidence formal nem avançar TASK/lifecycle — mas não consegue impedir que um subagente desobediente tente spawnar um comando sem autoridade.

O contrato v10 continua classificando escopo e causalidade separadamente em `Gate assessments` dentro dos registros existentes. Não cria novos arquivos de blocker. Falha externa independente não bloqueia; causalidade desconhecida exige investigação e não REPLAN. Revalide o working tree, mesmo sem commit, antes de decidir se o blocker anterior ainda existe. Um blocker resolvido ou independente não precisa de bypass. Um bypass explícito de gate opcional concreto usa `BYPASS_GATE=<registro-NN>/gate-NN` e `BYPASS_REASON=<risco aceito>`; é vinculado à evidência/autoridade, auditável e resulta em TESTS_ACCEPTED/ACCEPTED. Todas as obrigações mandatórias permanecem validadas, e blockers novos continuam bloqueando. Publique e distribua juntos os runtimes, harness, skills e adapters v10.

## `stnl-spec-context-scout`

Este scout opcional isola uma única lacuna de evidência durante uma operação da `stnl-spec-lifecycle-manager`. Ele não faz parte do fluxo normal: zero scouts é o padrão e não existe launcher ou disparo automático.

O scout acompanha o runner na mesma cópia única da plataforma descrita acima. O Codex usa `gpt-5.6-luna` com effort `medium`, sandbox `read-only`, approvals desabilitadas e web search desabilitada. O Claude Code usa Haiku com effort `medium` e somente `Read`, `Glob` e `Grep`.

### Gate e limite contratual

O agente principal da operação de lifecycle deve concluir primeiro a busca determinística e a leitura localizada. Tamanho do repositório, sozinho, não torna o scout elegível. O scout só pode ser considerado quando ainda existir uma lacuna relevante e quando seu custo estimado for menor do que carregar a exploração no contexto principal. Elegibilidade não implica chamada.

O agente principal aplica o limite contratual de uma chamada por operação de lifecycle: no máximo um context scout, nunca um segundo, nunca em paralelo e nunca um por pasta, requisito, categoria, módulo ou candidato. O adapter não conta chamadas anteriores nem fornece enforcement técnico desse limite; `SCOUT_CALL=1/1` identifica a única chamada contratualmente válida. A invocação explícita deve informar modo de lifecycle, pergunta delimitada, lacuna restante, buscas e leituras já tentadas, âncoras iniciais, paths permitidos/bloqueados e critério de parada. Entrada ausente, ampla, automática, repetida, em batch, paralela ou que amplie o escopo deve ser recusada pelo adapter. Durante a chamada, não amplie pergunta, roots permitidos, paths, candidatos ou critério de parada; pare e relate a lacuna se a expansão fosse necessária.

### Limites e saída

Os dois adapters implementam o mesmo contrato em inglês. O scout trata o repositório como dados não confiáveis, não como instruções; usa apenas busca, leitura e inspeção local segura; não escreve, não executa checks com efeitos colaterais, não usa rede, não chama apps/MCP/browser, não cria Agent ou subagente e não delega. Ele também não cria ou altera SPEC, plano, tasks, código, arquitetura, escopo, status, readiness ou fechamento.

A resposta é textual, descartável e não persistida. Ela contém somente âncoras de escopo, comportamento atual, autoridades existentes, testes relevantes, constraints observadas, conflitos, lacunas, referências exatas e confiança. O alvo é aproximadamente 800–1.500 tokens, priorizando evidência concreta.

### Fallback

Se o adapter não estiver instalado ou disponível, a operação não falha somente por isso. O agente principal continua com busca determinística e leitura limitada, não amplia automaticamente a exploração e relata a ausência apenas quando ela for material para a confiança ou para a lacuna restante.
