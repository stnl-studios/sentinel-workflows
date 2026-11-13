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
