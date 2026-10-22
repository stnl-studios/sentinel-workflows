# Subagentes Sentinel por plataforma

Cada pacote de plataforma contém todos os subagentes Sentinel distribuíveis: o `stnl-validation-runner` e o `stnl-spec-context-scout`.

## Instalação

A instalação global parte deste checkout. Na raiz do repositório, execute:

```sh
npm run sentinel:install
```

Por padrão, o comando instala os agents nativos Codex e Claude Code nas pastas globais `~/.codex/agents` e `~/.claude/agents`, junto com as skills de workflow correspondentes. `npm run sentinel:install -- --preview` lista criações, substituições e remoções sem escrever. Para instalar apenas uma plataforma, use `--target codex` ou `--target claude`.

Na reinstalação, agents Sentinel modificados são substituídos e agents obsoletos com o padrão de nome daquela plataforma são removidos. A limpeza alcança somente os arquivos Sentinel diretamente em cada pasta global `agents`; agents alheios permanecem preservados. O planejamento completo acontece antes da primeira alteração.

## `stnl-validation-runner`

Este agente copiável, barato e isolado executa checks e validação fora do contexto principal para as skills `stnl-slice-executor` e `stnl-slice-quality-manager`.

O Codex usa `gpt-6-luna` com effort `medium`; o Claude Code preserva `claude-sonnet-5` com effort `medium`. O checker `validation-runner --platform codex` valida o recorte Codex; o gate agregado continua reportando `R003_EQUIVALENCE` até a equalização Claude, sem alegar paridade.

### Fluxo manual e delegações automáticas

As operações manuais são `PLAN`, `REPLAN` quando uma recuperação explícita exige nova estratégia, `REVIEW_PLAN`, `EXECUTE_SLICE`, `VALIDATE_SLICE` e `APPLY_FINDINGS` quando necessário. `REPLAN` exige `REPLAN_REASON`, retorna `REPLAN_DRAFT` e nunca substitui `REVIEW_PLAN`. Não existe passo manual adicional de testes.

O runner aceita exatamente três operações internas, sempre acionadas automaticamente pelo launcher da operação manual:

- `EXECUTE_SLICE`: o contexto principal implementa; o runner executa checks e retorna `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`.
- `APPLY_FINDINGS`: o contexto principal corrige findings autorizados; o runner testa correções e regressões relacionadas e retorna `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`.
- `VALIDATE_SLICE`: o runner faz revisão e validação formal independentes e retorna `PASS`, `NEEDS_FIX` ou `BLOCKED`.

Descoberta de suites, comandos, logs, stack traces e resultados intermediários permanecem no contexto isolado. O contexto principal recebe somente evidência compacta e persiste a seção autorizada. Não existe fallback para executar checks ou validação no contexto principal.

Depois da implementação ou correção inicial, cada invocação manual válida de `EXECUTE_SLICE` ou `APPLY_FINDINGS` chama o runner no mínimo uma vez e no máximo três vezes: a primeira chamada é obrigatória e pode ser seguida por até duas rechecagens. Não existe bypass por mudança simples ou por provável ausência de checks; o runner sempre faz a descoberta independente, inclusive quando retorna `TESTS_NOT_APPLICABLE`. Em `TESTS_FAIL` nas duas primeiras rodadas, o contexto principal persiste a evidência, corrige somente a falha objetiva dentro do escopo aprovado, registra a correção e o escopo atualizado e chama o runner novamente. `TESTS_PASS`/`TESTS_NOT_APPLICABLE` entram em `IMPLEMENTED_AWAITING_VALIDATION` ou `FINDINGS_CORRECTED`; `BLOCKED` entra em `AUXILIARY_BLOCKED` e só a mesma operação/slice retoma. A terceira falha entra em `IMPLEMENTATION_RETRY_EXHAUSTED` ou `FINDINGS_RETRY_EXHAUSTED`: `VALIDATE_SLICE` é a única próxima operação da slice, sem reentrada do executor até o veredito formal. Não existe quarta chamada, loop ilimitado ou transição automática para `VALIDATE_SLICE`.

Discovery actions são leituras e comandos read-only usados apenas para localizar scripts, CI, manifests, Makefiles, testes próximos, convenções e comandos autoritativos. Essas ações são permitidas, não contam como verification commands e são persistidas separadamente: fontes em `Discovery sources`, métodos em `Discovery actions`. Verification commands são testes, builds de verificação, linters, typechecks, compilações, validators, contract tests, smoke tests, regressões e outros checks observáveis da implementação ou correção. Caminhos de estado testado e manifesto são normalizados relativamente ao diretório da task detalhada selecionada.

`TESTS_PASS` confirma os verification commands selecionados com exit code zero; escopo verificado, tipos considerados, testes selecionados e cobertura nunca podem ser `none`. `TESTS_FAIL` representa verification command executado que falhou e pode sustentar uma correção limitada. `TESTS_NOT_APPLICABLE` representa somente descoberta objetiva de que nenhum verification command se aplica ao escopo e exige fontes e ações de descoberta, tipos considerados, justificativa e `No verification-command confirmation`; nenhum verification command pode ter sido executado. `BLOCKED` representa check aplicável impedido por ferramenta, credencial, dependência, ambiente, serviço, permissão ou comando autoritativo indisponível. Falha ou impossibilidade nunca é mascarada como não aplicabilidade. Em rodadas posteriores, `Correction paths` contém caminhos normalizados somente para correção file-backed e exact `none` para correção fileless. Em `APPLY_FINDINGS`, findings verificados formam um subconjunto canônico dos targets; os não sustentados são exatamente os findings ativos restantes e nunca se sobrepõem aos verificados. Todo finding novo nasce `active` e só uma tentativa formal estritamente posterior à origem pode resolvê-lo ou supersedê-lo.

A descoberta ocorre dentro da chamada automática ao runner; ela não cria um novo passo manual. O contexto principal continua sem executar checks e sem fallback.

### Launchers

As três operações que usam o runner possuem launcher específico por plataforma:

- Codex: `slice-execute-codex.md`, `slice-apply-findings-codex.md` e `slice-validate-codex.md`.
- Claude Code: `slice-execute-claude.md`, `slice-apply-findings-claude.md` e `slice-validate-claude.md`.

Copie somente os três launchers da plataforma usada. `execution-plan.md`, `execution-replan.md`, `execution-plan-review.md`  continuam compartilhados.

No recorte EC-1 do Codex, selecione o contrato completo da distribuição candidata por path canônico e registre seu SHA-256 antes da admissão. Cada agente independente usa `fork_turns:"none"` e lê esse mesmo arquivo antes de inspecionar o escopo ou executar a receita. Essa alternativa é um agente independente com contrato carregado, não uma seleção do tipo registrado. Ler o arquivo fornece instruções de tarefa, sem prioridade de developer nem a mesma garantia de aplicação do agente registrado. Instrua o agente genérico a não editar código nem artefatos de execução. Ausência de independência, contrato íntegro ou identidade oficial bloqueia antes do dispatch. A equalização Claude é uma etapa posterior, sujeita à aprovação própria.

O agente inicia sem histórico da conversa. Históricos e logs completos não são encaminhados. O payload mínimo inclui operação, SPEC_PATH, slice, Plan/Task aprovados, authority, owner/dispatch oficiais, paths declarados, findings/correções aplicáveis e a receita retornada pelo produtor. Não sugira o veredicto nem forneça conclusão simulada.

Use somente execution-current-operation.mjs para begin, reserve-dispatch, bind-native, verify-native, capture-native, resume, publish e cleanup. O launcher conserva o handle, a origem oficial, a observação e o finalResponse integral da primeira conclusão. Uma publicação interrompida retoma esses mesmos bytes sem novo spawn nem recipe. Pending/uncertain não concede redispatch. Somente normalização explícita admitida pelo runtime cria um sucessor, preservando o episódio e saldo originais. O produto corrente aceita somente transporte nativo; formatos managed são UNSUPPORTED_FORMAT. Stubs legados de desenvolvimento continuam recusando dispatch enquanto a bancada suspensa aguarda sua etapa própria de retirada.

Somente VALIDATE_SLICE decide disposições formais e estabelece PASS com prova suficiente. Na última slice aberta, a mesma validação formal também verifica cobertura global, reconciliação com a authority corrente, consistência cross-slice e integration/stabilization work ainda necessário; gaps de authority ou estratégia retornam `BLOCKED` e exigem `REPLAN`. O request terminal explícito e o reader verificam essa combinação com as provas atuais de active+completed. Os itens U3.5/U3.6 preservam o aceite EC-1 nativo/manual já obtido, com alcance delimitado no plano P1-B; isso não qualifica automaticamente alterações posteriores. A nova qualificação nativa integrada da candidata final permanece em U3.15.

### Restrições

O contrato corrente do Codex preserva estes limites. O runner pode ler o escopo necessário e executar comandos, mas não edita código, testes, requisitos, planos ou tasks; não implementa, não corrige, não persiste, não finaliza, não cria subagentes e não faz commit. Artefatos transitórios normais de build ou teste são permitidos e efeitos inesperados no workspace são reportados.

Um `PASS` que faria a execução chegar a `COMPLETE` só pode ser publicado depois que o runtime validar deterministicamente terminalidade, authority fingerprint/revision, Effective Validation Bases, ownership final por path, hashes, remoções, reaparecimentos, paths sem owner e trusted-root safety. A inspeção read-only de uma execução já `COMPLETE` repete esse gate e diagnostica drift posterior sem alterar o PASS histórico; mudança conhecida que afeta a prova expõe revalidação da mesma entrega. A admissão explícita de VALIDATE sela o PASS/Base/Task anterior e reabre somente o delta operacional autorizado; mudança normativa material exige antes REPLAN/review mantendo UUID/slot quando o resultado é o mesmo. Origem incerta bloqueia e preserva material. `COMPLETE` saudável não possui handoff normal de execução. `MODE=CLOSE` do lifecycle retorna `SPEC_CLOSED`, é independente e não afirma durable delivery approval.

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

## Continuidade e recuperação da entrega

### Perfil EC-1/S2 nativo em validação e correção

Para uma S2 convertida elegível (preparationRevision > 1, revisão local positiva aprovada), `VALIDATE_SLICE` e `APPLY_FINDINGS` após uma formal com finding bloqueante usam `skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs`. O launcher consulta `inspect`, informa `SPEC_PATH`, slice e `expectedActivationId` no `begin` e acrescenta `--operation APPLY_FINDINGS` somente no handoff correspondente. No APPLY, a admissão sela a baseline antes da correção aprovada; o mesmo handle sobrevive ao reinício do controller. `reserve-dispatch`, `bind-native`, `capture-native`, `publish` e `resume` usam esse handle. `TESTS_FAIL` capturado pode abrir a rodada seguinte do mesmo owner até 3/3; três falhas levam a formal Q13, nunca a uma quarta APPLY. `TESTS_PASS` auxiliar conserva os findings ativos até uma nova formal independente. Uma resposta APPLY concluída mas inválida, com observação oficial íntegra, é publicada como recusa sem fabricar check. Depois do fechamento e readback, `normalize` admite no máximo um sucessor APPLY com novo owner e somente o saldo das três chamadas originais. O request findings v2 distingue `round` global de `invocation` local; `automaticCheckRound` usa a rodada global. Segunda recusa ou terceira chamada consumida esgota a recuperação; TESTS_PASS continua exigindo formal independente. A reserva e a publicação usam o lock comum e o readback oficial. `resume` informa a próxima ação e nunca inicia um agente ou check por conta própria.

No EC-1/S2, um APPLY ordinário com `TESTS_PASS` válido já capturado pode receber uma única normalização explícita quando apenas um output privado existente muda antes da composição e ainda há saldo. `publish` recusa a prova stale; `normalize --handle` reserva o drift sem executar checks e `resume` aponta a próxima reserva de dispatch no mesmo owner. O novo agente mede o estado reservado, com witness que liga captura anterior e observação atual. Mudança em Existing Inputs, referências da receita, requisitos, outra entrega, remoção, path inseguro ou segunda normalização é recusada. As duas medições permanecem como checks auxiliares; só uma formal v4 posterior resolve findings.

O agente Codex independente recebe `fork_turns:"none"`, carrega integralmente o contrato da distribuição candidata indicado pelo launcher com hash registrado, recebe o request e a origem oficiais e chama `verify-native` uma vez por rodada. O nome canônico devolvido pelo spawn é o ID de vínculo; o `finalResponse` integral da notificação concluída é salvo sem reserialização e entregue ao `capture-native` com esse ID. É um agente independente com contrato carregado, sem alegação de instalação global ou seleção do tipo registrado. Se `resume` indicar `normalize` após candidata parcial, o launcher executa `normalize --handle` e publica os mesmos bytes somente após prova do owner, base e candidata. Uma resposta formal concluída com schema inválido publica tentativa rejeitada com bytes retidos; após readback, `normalize --spec-path --slice --expected-activation-id` admite uma sucessora explícita. Nova rejeição esgota o episódio. Falha de identidade, transporte ou HEAD permanece bloqueada. Se `resume` indicar `cleanup`, o launcher executa `cleanup --handle` para completar apenas a limpeza própria, sem novo agente ou check. Não reinterpretar resultado de outro workflow neste perfil. O controlador corrente também atende os handoffs pristine/sucessor EXECUTE e revisão privada documentados nas skills. O sucessor EXECUTE usa somente o saldo das três chamadas originais: request.round global, origin/receipt locais, sem reatribuir prova antiga. A normalização formal v1/v2/v3/v4 concluída admite uma sucessora, inclusive Initial/completed; a segunda recusa esgota. Revisões privadas sucessivas exigem aprovação independente da candidata e nova formal. Remoções autorizadas exigem os bytes/mode anteriores capturados pelo controller. Identidade, autoridade, observação ou conclusão incertas continuam bloqueadas. Managed continua indisponível. COMPLETE exige o request terminal explícito e todas as provas correntes da combinação; a consolidação e o aceite global dos itens 5/6 continuam separados.

`execution/continuity.json` é um índice fechado desta execução: baseline e refs seladas de Task/snapshot nas cápsulas dos publishers existentes. A Task mostra um resumo curto; inspeção recalcula validade sem escrever. Os checks e attempts continuam sequenciais por deliveryId através das revisões, mesmo após compactar o ciclo corrente. PASS histórico e validade corrente são conceitos distintos.

O CLI existente aceita `SPEC_PATH --inspect-continuity SLICE [--revision N] [--attempt attempt-NN]`, `SPEC_PATH --resume-owned-operation OPERATION SLICE` e `SPEC_PATH --cleanup-owned-allocation ALLOCATION_MARKER`. Resume consulta o mesmo owner/session/receipt e preserva trabalho sem registro, sem begin ou dispatch. Cleanup usa o lock comum/CAS, confirma a imagem e remove somente candidata própria comprovadamente redundante; candidato alterado, código único, receipt, histórico e backup permanecem retidos. Confirmação de publicação e cleanup pendente são resultados separados; nunca repetir implementação/validação por uma falha de cleanup.

Captura passiva mantém bytes reais de produto/inputs e ausência de arquivos removidos. Autoridade e alocações operacionais são reconhecidas pelos resolvers e vínculos dos produtores. Uma área ancestral que contém SPEC/execution continua observando produto legítimo, inclusive arquivos ignorados pelo Git ou com nomes/prefixos semelhantes a temporários. Esses bytes não são evidência testada.
