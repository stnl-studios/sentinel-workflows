# Sentinel Workflows

O Sentinel reúne skills e agents nativos para **Codex** e **Claude Code**. Ele ajuda equipes de software a transformar um pedido em plano aprovado, implementar mudanças delimitadas e manter evidências para uma validação independente.

O fluxo é explícito e conduzido pelo usuário. Cada operação devolve o controle com um handoff; o Sentinel não executa o ciclo inteiro em segundo plano nem trata checks de implementação como aceite formal.

<p align="center">
  <img src="docs/workflow.svg" alt="Fluxo Sentinel: definir uma SPEC, preparar e revisar Plan e Tasks, executar uma slice e validá-la de forma independente. Findings retornam a um handoff explícito de correção." width="100%">
</p>

## Fluxo de trabalho

```text
SPEC → PLAN → REVIEW_PLAN → EXECUTE_SLICE → VALIDATE_SLICE
                                 ↑                 │
                                 └─ APPLY_FINDINGS ┘
```

1. **Defina o trabalho.** `stnl-spec-lifecycle-manager` registra requisitos, critérios de aceite, restrições, riscos e decisões numa SPEC.
2. **Prepare em conjunto.** `stnl-execution-planner` cria o Plan serial e as Tasks operacionais como uma única candidata.
3. **Revise antes de executar.** `stnl-plan-reviewer` revisa Plan e Tasks completos de forma independente, incluindo o checklist inicial e a capacidade das provas, e ativa somente o conteúdo revisado.
4. **Execute uma slice.** `stnl-slice-executor` trabalha dentro da autoridade aprovada. Ele pode delegar os checks da recipe ao runner nativo de validação.
5. **Valide de forma independente.** `stnl-slice-quality-manager` decide a disposição formal dos findings. Somente um `PASS` formal e atual conclui uma slice. `NEEDS_FIX` pode levar a um handoff explícito de `APPLY_FINDINGS` e a outra validação formal.

Cada etapa é uma operação separada. Um check bem-sucedido durante a implementação é evidência de apoio; não significa que a slice passou pela validação formal. Siga o handoff da operação atual em vez de presumir o próximo passo.

### Skills de workflow opcionais

- `stnl-spec-roadmap` decompõe requisitos amplos em SPECs candidatas e cobertura de dependências. Não substitui o ciclo de vida nem a autoridade de execução de uma SPEC.
- `stnl-spec-test-runbook` cria um runbook offline para QA ou aceite humano quando solicitado explicitamente. A geração não é automática e não executa nem valida testes.

### Orientação por domínio

O catálogo também inclui sete guias técnicos especializados. Planejamento, revisão, execução e validação consultam o guia principal e apenas as especializações aplicáveis ao escopo aprovado.

| Skill | Aplicação |
| --- | --- |
| `stnl-backend-dotnet` | Backend .NET e C# |
| `stnl-backend-node-typescript` | Backend Node.js e TypeScript |
| `stnl-database-persistence` | Banco de dados, cache, migrações e persistência |
| `stnl-frontend-react-next-angular` | React, Next.js e Angular |
| `stnl-mobile-ios-swift` | iOS e Swift |
| `stnl-security-auth` | Autenticação, autorização, sessões, segredos e limites de confiança |
| `stnl-testing` | Desenho de testes, execução e qualidade das evidências |

A orientação por domínio ajuda a identificar riscos e checks aplicáveis; não acrescenta requisitos nem amplia o escopo aprovado.

## Instalação

### Requisitos

- Node.js 18 ou mais recente.
- Clone local deste repositório.
- Codex CLI e/ou Claude Code instalado e autenticado para o cliente que você pretende usar.

Na raiz do repositório, instale os pacotes dos dois clientes:

```sh
npm run sentinel:install
```

Confira as mudanças planejadas sem gravar arquivos:

```sh
npm run sentinel:install -- --preview
```

Instale ou atualize somente um cliente:

```sh
npm run sentinel:install -- --target codex
npm run sentinel:install -- --target claude
```

O instalador usa módulos nativos do Node; esse comando não instala dependências npm. Depois da instalação, abra uma conversa nova para o cliente descobrir as skills e os agents. O instalador não altera o projeto onde você usa o Sentinel.

### O que a instalação altera

Para cada cliente selecionado, o instalador administra estes diretórios globais:

- Codex: `~/.codex/skills` e `~/.codex/agents`
- Claude Code: `~/.claude/skills` e `~/.claude/agents`

Ele instala 14 skills (sete de workflow e sete de domínio) e dois agents nativos por cliente. Skills e agents Sentinel gerenciados são substituídos quando o conteúdo diverge; entradas Sentinel obsoletas que correspondam às regras de nomes gerenciados podem ser removidas. Skills, agents, projetos e arquivos alheios fora dessas entradas são preservados. Use `--preview` para inspecionar criações, substituições e remoções antes de aplicar.

O instalador planeja e lê o pacote selecionado antes da primeira gravação. Se houver falha de I/O durante a aplicação, ele informa os caminhos aplicados e incompletos; não promete rollback transacional.

## Primeiro uso

1. Inicie uma conversa nova no Codex ou Claude Code.
2. Escolha a operação que corresponde ao handoff atual. Para um trabalho novo, comece com `stnl-spec-lifecycle-manager` e informe o caminho da SPEC e a fonte dos requisitos.
3. Use uma operação por vez. Os [templates de prompt por operação](templates/prompts/) listam as entradas necessárias; execução e validação também precisam da `SLICE` selecionada.
4. Preserve os caminhos dos artefatos, as decisões e o handoff retornado para a próxima operação explicitamente solicitada.

Exemplo ilustrativo: para adicionar histórico de compras, primeiro defina quem pode consultar quais compras e os critérios de aceite. Conforme o repositório real, o planner pode dividir o trabalho em slices seriais, como acesso a dados e apresentação. Revise o plano completo antes de ativá-lo, execute uma slice selecionada e obtenha um resultado de validação formal separado. Esses artefatos são exemplos; nem todo produto precisa dessas slices.

## Agents

Cada pacote de cliente inclui:

- **`stnl-spec-context-scout`** — faz uma busca delimitada e somente de leitura por contexto do repositório para o fluxo de SPEC.
- **`stnl-validation-runner`** — executa checks selecionados ou faz a revisão formal independente quando uma operação o delega. É somente de leitura; a operação principal é responsável pelas mudanças de implementação e pela disposição dos findings.

O runner faz parte do handoff da operação. Não existe uma etapa manual separada de “rodar testes” nem um fallback silencioso que execute checks delegados no contexto principal. O [guia dos agents](agents/README.md) descreve os launchers de cada cliente, os contratos de entrada e os significados dos resultados.

## Mapa do repositório

| Caminho | Conteúdo |
| --- | --- |
| `skills/workflows/` | Sete skills de workflow, orientações por operação e recursos de runtime |
| `skills/domains/` | Sete guias técnicos de qualidade por domínio |
| `agents/` | Definições de agents nativos para Codex e Claude Code e seu guia |
| `templates/prompts/` | Prompts curtos para operações explícitas |
| `scripts/sentinel-install.mjs` | Instalação global, prévia e seleção de cliente |
| `integrations/` | Helpers de descoberta dos clientes no checkout; não são instalados como etapas de workflow |
| `benchmarks/` | Ferramenta independente para avaliar fluxos em um workspace isolado; não é incluída nos pacotes dos clientes |

Os pacotes dos clientes contêm somente as skills e os agents administrados pelo instalador. Os helpers locais do Codex e as ferramentas de benchmark permanecem no repositório e fora da distribuição instalada.

## Limites e evidências

- O Sentinel não executa operações futuras automaticamente nem aceita um plano apenas porque ele é sintaticamente válido.
- Descoberta nativa e checks do pacote não provam como uma sessão futura de modelo vai se comportar. O uso real de cada cliente e versão é uma observação separada.
- O resultado do runner prova somente os checks ou a revisão que ele de fato realizou. Não garante efeitos externos arbitrários nem substitui o julgamento do mantenedor.
- Não alegamos ganhos de desempenho, custo ou tokens sem medições completas e comparáveis.
- A instalação grava nos diretórios globais Sentinel selecionados. Use a prévia para inspecionar uma atualização; uma falha parcial de I/O não tem rollback automático.

## Checks para mantenedores

O repositório não tem um único script `npm test`. Rode os checks pertinentes à área alterada. Exemplos:

```sh
node --test scripts/test-sentinel-install.mjs
node scripts/check-contracts.mjs repository --root .
node scripts/check-contracts.mjs validation-runner --root agents
node scripts/check-distributable-skills.mjs skills/workflows/stnl-execution-planner skills/domains/stnl-backend-node-typescript
```

Esses comandos cobrem contratos diferentes; passar um deles não significa que toda a suíte do repositório ou o comportamento nativo dos clientes foi testado.
