# Recuperação do fluxo Sentinel

Esta mudança corrige o fluxo existente, sem adicionar servidor, framework ou outro orquestrador.

## Comportamento

- O principal coordena o trabalho autorizado após aprovação de Plan/Tasks. Cada operação mantém admissão, revisão independente e publicação próprias. Ele para antes de CLOSE, decisões materiais, permissões ou bloqueios reais.
- O planejamento usa a menor decomposição serial justificável e define desde o início a prova integral. Após PASS local, a última contribuição integral elegível da ordem aprovada pode receber o julgamento terminal sem dois replans artificiais.
- O runbook em escopo SPEC usa os requisitos e independe de execution. Escopos operacionais explícitos continuam autenticando sua execução e distinguem slices ativas, concluídas preservadas e aposentadas.
- Plan/Tasks editáveis ficam em um único container `<nome-da-SPEC>-planning/`. Controles de captura/aprovação ficam num namespace técnico irmão da área operacional da execução, fora da pasta documental e da aposentadoria de execução. Caminhos antigos continuam legíveis.
- Repetir PLAN retorna sua única preparação registrada, sem alocar outra pasta. A retomada preserva captura/aprovação existentes. Múltiplas preparações legadas exigem recuperação explícita, sem escolher uma arbitrariamente.
- `preparation-draft.mjs revise` permite corrigir a mesma preparação não ativada. Arquiva a captura e aprovação anteriores antes de invalidar a aprovação. Nova captura exige nova aprovação. Remoções de slices também são refletidas na cópia técnica.
- Create, capture, approve, revise e geração Initial compartilham o lock de publicação. Uma instalação já iniciada precisa ser retomada, não revisada como se fosse um novo draft.
- Um draft cuja cópia foi interrompida não pode ser capturado como se as slices ausentes tivessem sido removidas de propósito. Repetir create completa somente documentos ausentes; conteúdo parcial alterado é preservado e bloqueia a retomada automática.
- CLOSE não pode declarar uma execução originalmente ausente quando controles autenticados provam que ela existiu. A execução oficial precisa ser restaurada e validada antes do fechamento.

## Evidências e responsabilidade

A preservação de arquivos externos pelo CLOSE já existia. Novas regressões cobrem results.json, runbook, visual, evidência binária, notas, plano visível, alteração concorrente e interrupção. A perda histórica de QA na OS 39146 não foi atribuída ao CLOSE: o arquivo ainda aparecia depois de sua confirmação.

A normalização já existente reaproveita receipts autenticados nas correções de formato. As instruções agora direcionam o principal a esse caminho em vez de abortar e repetir testes. Não há cache geral entre operações e provas inválidas não são reutilizadas.

Preflight e revisão passam a exigir correspondência entre requisito, cenário e assertion, casos de ausência/erro, callers/fixtures e cobertura de todos os repositórios, inclusive documentação. Isso melhora o contrato dos agentes; teste documental não prova por si só que todo modelo futuro cumprirá essas instruções.

## Compatibilidade e limites

- Sem migração automática, movimentação ou exclusão de execuções e candidatos antigos. `revise` evita novas pastas em correções futuras, mas não é descarte de alocações supersedidas.
- Histórico técnico preservado não deve ser removido por uma limpeza genérica de temporários.
- Não houve alteração na OS 39146, RECONCILE, merge na main, publicação remota ou instalação global nesta implementação.
- Os testes mecânicos exercitam o runtime em fixtures isoladas. Não substituem validação real em Windows, nem uma campanha nova de modelos nos clientes Claude/Codex.

## Verificação desta alteração (2026-11-13)

- Catálogo: 126 arquivos de teste aprovados ao combinar execuções retomadas e retestes, duas delegações shell verificadas e validação estrutural final aprovada.
- Não foi uma execução única: 31 arquivos concluídos antes da interrupção têm resultado observado no histórico, mas seus logs temporários se perderam. Os 95 restantes têm log e relatório persistidos. O relatório bruto preserva a falha inicial de contrato dos launchers; o reteste passou após mover o exemplo de continuidade para documentação.
- Alterações finais: draft 20/20; concorrência Initial/revise 2/2; publicação/retomada Initial 5/5; orçamento de contexto 6/6; launcher/continuidade 13/13. As jornadas integradas do gerente também passaram.
- Evidência sintética é identificada como tal. Os dez contratos de exemplo semântico têm variante correta e mutante reprovado (20 verificações), mas não constituem aprovação da aplicação da OS 39146.

### Rastreabilidade dos achados

| Achado | Tratamento e limite |
| --- | --- |
| F01 | Seleção terminal pela última contribuição integral elegível, com prova autenticada e regressão até COMPLETE. |
| F02 | Runbook aceita execução concluída autenticada e documentos preservados; ausência de documentos aposentados é explícita. |
| F03 | Escopo SPEC não lê execution; HTML independe de execução ausente, quebrada ou ligada por symlink. |
| F04 | Contrato requisito/cenário/assertion e exemplos semânticos com mutantes; sem campanha nova de modelo na aplicação real. |
| F05 | Preflight de callers/fixtures exigido antes da aprovação; não foram executados testes da OS real. |
| F06 | Orientação para normalizar respostas com receipts existentes; sem novo launcher ou bypass de prova. |
| F07 | CLOSE recusa ausência contradita por controles conhecidos; restauração e retomada cobertas. |
| F08 | Preservação de QA/evidências e concorrência testadas; causa da perda histórica continua indeterminada. |
| F09 | Container visível, controles separados, PLAN reutilizado e revise; sem descarte/migração automática do legado. |
| F10 | Decisões resolvidas não devem reaparecer; READY estrutural separado de suficiência semântica nas instruções. |
| F11 | Inventário de todos os repositórios, incluindo Bundle/documentação; não equivale a nova auditoria da OS. |
| F12 | Retomada e classificação de falhas explícitas, sem repetir efeitos incertos; interrupções de draft/Initial têm regressões. |

### Piloto nativo fora da bancada

O primeiro piloto Codex real (projeto Todo isolado, skills locais e sem manager de benchmark) gerou SPEC, readiness, uma slice, captura/aprovação exata, revisão independente, implementação e runbook. O runner então revelou um defeito não exposto pelos testes anteriores: `verify-native` recusava uma origem relativa apesar de ela apontar ao controle correto. As fronteiras públicas agora resolvem caminhos relativos lexicalmente, mantendo rejeição de symlink, adulteração e identidade estrangeira; três novas regressões e o arquivo completo de replay (18 testes) passaram.

Esse primeiro piloto não concluiu testes de produto nem aceitação formal. O caso bloqueado foi preservado. A sessão CLI retomada não expôs o runner anterior/coletor necessário à continuação autenticada; não foi criado outro runner para substituí-lo. A QA visual também encontrou uma recusa explícita de acesso do browser à origem local. A correção de caminhos não constitui prova de recuperação dessa sessão nem de QA visual. Nova jornada do candidato corrigido é uma execução separada, não uma recuperação retroativa.

A segunda jornada nativa executou uma receita real (14 testes, exit 0), mas a validação da resposta recusou o fingerprint de ambiente. Chamadas separadas do cliente variam `CODEX_TOOL_CALL_ID`; uma regressão em processos separados reproduziu e isolou esse falso stale. Esse metadado agora é removido do ambiente efetivamente entregue à recipe e do seu fingerprint. Variáveis funcionais continuam vinculadas. A regressão comprova uma única execução, ausência da chave na recipe e rejeição de alteração funcional; o arquivo de replay passou 19/19. A observação antiga, que contém somente digest agregado, não foi reescrita ou convertida em PASS. O segundo caso bloqueado também foi preservado; uso integral e QA visual continuam dependentes de uma nova jornada concluída.

A terceira jornada nativa, já com as duas correções, concluiu a parte autorizada fora da bancada: SPEC READY; Plan/Tasks de uma slice; aprovação exata; revisão independente; implementação; runner TESTS_PASS; validação independente local PASS; publicações confirmadas e cleanup completo. Cada fase executou 8 regressões e 4 testes da CLI real, com exit 0. Não houve repetição para corrigir formato. O runbook SPEC foi gerado antes de existir execution. Nenhum finding foi emitido, portanto APPLY_FINDINGS não foi percorrido nesse piloto real (permanece coberto por testes mecânicos).

Uma nova mensagem literal `Continue` reinspecionou a mesma execução, manteve o bloqueio de browser e não repetiu preparação nem checks. Os arquivos da execução permaneceram byte a byte idênticos. A prova local está current/PASS, sem operação ativa; o diagnóstico EVIDENCE_INCOMPLETE refere-se exclusivamente ao julgamento terminal ainda ausente. QA visual, julgamento terminal e aceitação integral continuam pendentes. Claude Code não foi testado nativamente por ausência de autenticação. Os três projetos e seus registros foram preservados; nenhum CLOSE, RECONCILE, merge ou instalação global foi realizado. O servidor local de QA foi encerrado enquanto se aguarda permissão.

### Cenário negativo real e recuperação de APPLY_FINDINGS

Após o happy path, uma falha controlada e explicitamente identificada inverteu uma comparação de filtro em `src/cli.mjs`, sem alterar testes, requisitos ou controles. O runner independente observou regressão exit 0 e CLI exit 1 e publicou NEEDS_FIX/finding-01. Somente após o handoff e admissão de APPLY_FINDINGS o produto foi corrigido. Seus checks reais passaram, mas a publicação revelou outro defeito: a segunda validação havia descartado a primeira âncora formal ainda necessária à implementação retida.

O produtor agora preserva essa âncora. Para o caso já afetado, foi acrescentada a [recuperação autenticada de evidência histórica](authenticated-historical-evidence-recovery.md), restrita à publicação capturada de APPLY: verifica a fonte pelo CAS selado, autoridade e counters, sem reescrever source/capture ou criar formato novo. Fonte adulterada, ownership divergente e symlink são recusados sem efeitos. Cinco jornadas de regressão passaram; a recuperação interrompida e retomada também passou. Testes adicionais de findings, recuperação e replay passaram 11/11, 15/15 e 19/19, além da validação estrutural.

No piloto nativo, a mesma captura foi publicada pelo novo caminho oficial sem repetir checks de APPLY. Sete artefatos originais de captura/verificação permaneceram byte a byte idênticos. Nova validação independente passou; finding-01 está resolvido, nenhum finding está aberto, a primeira âncora está retida e a CLI coincide com a cópia boa. Counters: implementationChecks=1, validationAttempts=3, findings=1, findingsChecks=1. Publicação e cleanup confirmados. O estado local é current/PASS; somente julgamento terminal está ausente.

O usuário autorizou posteriormente a origem local de QA, mas a única nova tentativa do browser foi novamente recusada pelo gate. Não houve contorno, troca de superfície ou QA fabricada. Assim, QA visual e aceitação terminal permanecem bloqueadas apesar dessa autorização. O servidor foi encerrado; o projeto e seus handles/evidências foram preservados para retomada. O ciclo negativo comprova APPLY_FINDINGS real com falha induzida, não descoberta espontânea nem validação visual.
