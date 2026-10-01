# Sentinel Workflows

Skills de workflow e agents nativos para usar o fluxo Sentinel no Codex ou no Claude Code. O repositório também contém benchmarks; eles são uma área separada e seus arquivos não fazem parte da instalação global.

## Requisitos

- Node.js 18 ou mais recente.
- Este repositório clonado localmente.
- Codex CLI e/ou Claude Code instalados e autenticados no cliente que você pretende usar.

## Instalação global

Na raiz deste repositório, o comando padrão instala as duas plataformas:

```sh
npm run sentinel:install
```

Ele copia skills de workflow para `~/.codex/skills` e `~/.claude/skills`, e os agents nativos para `~/.codex/agents` e `~/.claude/agents`. A cópia preserva os bytes dos arquivos distribuídos. Recursos internos necessários às skills acompanham cada skill; arquivos de avaliação, manutenção, testes internos, benchmarks, SDK e runtime de benchmark ficam fora do pacote.

Use a prévia para listar criações, substituições e remoções antes de escrever:

```sh
npm run sentinel:install -- --preview
```

Para instalar uma plataforma somente:

```sh
npm run sentinel:install -- --target codex
npm run sentinel:install -- --target claude
```

Antes de qualquer alteração, o instalador inventaria os destinos selecionados e as fontes completas. Skills registradas são componentes gerenciados: arquivos modificados ou extras dentro delas são substituídos pela cópia canônica; componentes idênticos são `NO-OP`. Agents Sentinel existentes também são substituídos quando diferem. Skills obsoletas com prefixo `stnl-` e agents obsoletos no padrão de nomes da plataforma são removidos. A prévia lista cada criação, substituição e remoção sem escrever.

O escopo de limpeza fica restrito às pastas imediatas das skills e agents globais. Skills fora do namespace de workflow gerenciado (incluindo as skills de domínio do repositório) e agents fora dos padrões nativos Sentinel permanecem preservados. Uma entrada ambígua no namespace Sentinel interrompe o planejamento antes de qualquer alteração. Uma falha de I/O durante a aplicação informa o componente e os caminhos incompletos; não há rollback automático.

O instalador não altera projetos consumidores nem instala dependências. A reinstalação padrão atualiza o payload Sentinel e limpa skills Sentinel obsoletas nos destinos selecionados.

## Primeiro uso

Abra um novo chat no cliente escolhido para que ele descubra as skills e os agents globais. Os prompts de operação ficam em `templates/prompts/`; forneça `SPEC_PATH` e, quando a operação exigir, uma `SLICE` explícita. Use somente uma operação de cada vez.

O caminho normal é:

1. `stnl-spec-lifecycle-manager` prepara ou atualiza a autoridade da SPEC.
2. `stnl-execution-planner` cria o plano; `stnl-plan-reviewer` revisa e aprova.
3. `stnl-task-materializer` materializa tasks; `stnl-task-reviewer` revisa o conjunto inicial.
4. `stnl-slice-executor` executa uma slice e delega checks ao agent `stnl-validation-runner`.
5. `stnl-slice-quality-manager` faz a validação formal independente. `NEEDS_FIX` permite a operação explícita `APPLY_FINDINGS`, seguida de nova validação.

O runner executa checks auxiliares e não decide o PASS formal. O estado persistido determina os próximos handoffs; cada operação retorna e para.

## Mapa do repositório

- `skills/workflows/`: skills de lifecycle, planejamento, revisão, tasks, execução, validação, roadmap e runbook.
- `skills/domains/`: orientações especializadas de domínio; não fazem parte deste instalador de workflow.
- `agents/codex/.codex/agents/` e `agents/claude-code/.claude/agents/`: agents nativos de cada cliente.
- `templates/prompts/`: entradas manuais curtas por operação e plataforma.
- `scripts/sentinel-install.mjs`: prévia, comparação e instalação global.
- `benchmarks/`: avaliação interna separada, fora da instalação global.

## Verificação do instalador

Execute a suíte focada com:

```sh
node --test scripts/test-sentinel-install.mjs
```

Ela usa HOME temporário para conferir instalação limpa, repetição idêntica, substituição de mudanças locais dentro de componentes Sentinel, limpeza obsoleta, preservação de conteúdo alheio, prévia e isolamento do destino selecionado.
