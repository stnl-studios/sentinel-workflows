import { createHash } from "node:crypto";

const LOCAL_STATUSES = [
  ["pending", "Pendente"],
  ["specifying", "Em especificação"],
  ["ready", "Pronta para execução"],
  ["development", "Em desenvolvimento"],
  ["validation", "Em validação"],
  ["blocked", "Bloqueada"],
  ["completed", "Concluída"],
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdown(value) {
  const lines = String(value).split("\n");
  const output = [];
  let list = [];
  const flush = () => {
    if (list.length === 0) return;
    output.push(`<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const line of lines) {
    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      continue;
    }
    flush();
    const heading = line.match(/^(#{1,4})\s+(\S.*)$/u);
    if (heading !== null) {
      const level = Math.min(heading[1].length + 2, 6);
      output.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
    } else if (line.trim().length === 0) output.push("<span class=md-space></span>");
    else output.push(`<p>${escapeHtml(line)}</p>`);
  }
  flush();
  return output.join("");
}

function badge(value, label = value) {
  return `<span class="badge badge-${escapeHtml(String(value).toLowerCase())}">${escapeHtml(label)}</span>`;
}

function candidateCoverage(candidateId, model) {
  return model.coverage.filter((item) => item.candidate_ids.includes(candidateId));
}

function candidateGaps(candidateId, coverage, model) {
  const coverageIds = new Set(coverage.map((item) => item.id));
  return model.gaps.filter((gap) => gap.candidate_ids.includes(candidateId)
    || gap.coverage_ids.some((id) => coverageIds.has(id)));
}

function dependencyList(candidate, model, projections) {
  if (candidate.depends_on.length === 0) return '<p class="empty">Nenhuma dependency explícita.</p>';
  const byId = new Map(model.candidates.map((item) => [item.id, item]));
  return `<ul class="dependency-list">${candidate.depends_on.map((id) => {
    const edge = projections.dependencyEdges.find((item) => item.candidate_id === candidate.id && item.prerequisite_id === id);
    return `<li><a href="#${id}" data-focus-link>${id} · ${escapeHtml(byId.get(id).title)}</a>${badge(edge.verdict, edge.verdict)}<small>${escapeHtml(edge.detail)}</small></li>`;
  }).join("")}</ul>`;
}

function compactDependencies(candidate, projections) {
  if (candidate.depends_on.length === 0) return "";
  return `<p class="compact-fact"><strong>Depende de:</strong> ${candidate.depends_on.map((id) => {
    const edge = projections.dependencyEdges.find(
      (item) => item.candidate_id === candidate.id && item.prerequisite_id === id,
    );
    return `<a href="#${id}" data-focus-link>${id}</a> ${badge(edge.verdict, edge.verdict)}`;
  }).join('<span aria-hidden="true"> · </span>')}</p>`;
}

function gapList(items) {
  if (items.length === 0) return '<p class="empty">Nenhum gap associado.</p>';
  return `<ul class="gap-list">${items.map((gap) => `<li>${badge(gap.severity)}<div><strong>${gap.id} · ${escapeHtml(gap.title)}</strong><p>${escapeHtml(gap.detail)}</p><small>Impacto: ${escapeHtml(gap.impact)}</small>${gap.state === "resolved" ? `<small>Resolução: ${escapeHtml(gap.resolution)}</small>` : ""}</div></li>`).join("")}</ul>`;
}

function coverageList(items) {
  if (items.length === 0) return '<p class="empty">Nenhuma necessidade atribuída.</p>';
  return `<ul class="need-list">${items.map((item) => `<li><code>${escapeHtml(item.need_id)}</code><span>${escapeHtml(item.title)}</span>${badge(item.status)}${item.overlap === undefined ? "" : badge(item.overlap)}</li>`).join("")}</ul>`;
}

function materializationLabel(value) {
  return value === "materialized" ? "SPEC materializada"
    : value === "invalid" ? "Path inválido"
      : "Candidate";
}

function candidateSummary(candidate) {
  const line = String(candidate.requirements_source)
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !/^#{1,6}\s/u.test(item) && !/^```/u.test(item));
  if (line === undefined) return "";
  const normalized = line.replace(/^[-*+]\s+/u, "").replace(/^>\s?/u, "");
  const points = Array.from(normalized);
  return points.length <= 220 ? normalized : `${points.slice(0, 219).join("")}…`;
}

function candidateCard(candidate, model, projections, index) {
  const projection = projections.candidates.get(candidate.id);
  const coverage = candidateCoverage(candidate.id, model);
  const gaps = candidateGaps(candidate.id, coverage, model);
  const openGaps = gaps.filter((item) => item.state === "open");
  const blocking = openGaps.filter((item) => item.severity === "BLOCKING");
  const handoffId = `${candidate.id}-handoff`;
  const titleId = `${candidate.id}-title`;
  const localNoteId = `${candidate.id}-local-note`;
  const summary = candidateSummary(candidate);
  const search = [
    candidate.id,
    candidate.title,
    candidate.spec_path,
    candidate.requirements_source,
    candidate.additional_context ?? "",
    ...coverage.flatMap((item) => [item.need_id, item.title]),
    ...gaps.flatMap((item) => [item.id, item.title, item.detail]),
  ].join(" ").toLocaleLowerCase("pt-BR");
  const candidateBadges = [
    candidate.disposition === "active" ? "" : badge(candidate.disposition),
    badge(projection.materialization, materializationLabel(projection.materialization)),
    blocking.length === 0 ? "" : badge("BLOCKING", `${blocking.length} BLOCKING`),
  ].join("");
  const lifecycle = projection.lifecycle_handoff === null
    ? `<details class="spec-details lifecycle-details"><summary>Ver contexto para lifecycle INIT</summary><p class="handoff-unavailable"><strong>MODE=INIT indisponível:</strong> o path já existe. A Roadmap Skill não altera a SPEC canônica.</p></details>`
    : `<details class="spec-details lifecycle-details"><summary>Ver contexto para lifecycle INIT</summary><div class="lifecycle-context"><button type="button" class="copy-context-button" data-copy-target="${handoffId}" aria-controls="${handoffId}" aria-label="Copiar contexto de lifecycle de ${candidate.id}">Copiar Markdown</button><textarea id="${handoffId}" readonly rows="10" spellcheck="false" aria-label="Contexto de lifecycle de ${candidate.id}">${escapeHtml(projection.lifecycle_handoff)}</textarea><pre class="handoff-print" aria-hidden="true">${escapeHtml(projection.lifecycle_handoff)}</pre><p data-copy-status aria-live="polite"></p></div></details>`;

  return `<article class="spec-card candidate-card${index === 0 ? " is-focused" : ""}" id="${candidate.id}" tabindex="-1" aria-labelledby="${titleId}" data-candidate-id="${candidate.id}" data-disposition="${candidate.disposition}" data-local-status="pending" data-search="${escapeHtml(search)}">
  <div class="spec-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</div>
  <div class="spec-main">
    <div class="spec-meta"><code class="spec-id">${candidate.id}</code><code class="path">${escapeHtml(candidate.spec_path)}</code><span class="candidate-badges">${candidateBadges}</span></div>
    <h3 id="${titleId}">${escapeHtml(candidate.title)}</h3>
    ${summary.length === 0 ? "" : `<p class="spec-description">${escapeHtml(summary)}</p>`}
    <div class="compact-facts">
      ${coverage.length === 0 ? "" : `<p class="compact-fact"><strong>Cobre:</strong> ${coverage.map((item) => `<code>${escapeHtml(item.need_id)}</code>`).join('<span aria-hidden="true"> · </span>')}</p>`}
      ${compactDependencies(candidate, projections)}
      ${openGaps.length === 0 ? "" : `<p class="compact-fact gap-fact${blocking.length > 0 ? " has-blocking" : ""}"><strong>⚠ ${openGaps.length} ${openGaps.length === 1 ? "ponto" : "pontos"} para validar</strong>${blocking.length === 0 ? "" : ` · ${blocking.length} BLOCKING`}</p>`}
    </div>
    ${candidate.disposition_reason === undefined ? "" : `<p class="candidate-note"><strong>${escapeHtml(candidate.disposition)}:</strong> ${escapeHtml(candidate.disposition_reason)}</p>`}
  ${candidate.materialized_impact === undefined ? "" : `<aside class="impact"><strong>Impacto em SPEC materializada · ${escapeHtml(candidate.materialized_impact.handoff)}</strong><p>${escapeHtml(candidate.materialized_impact.summary)}</p></aside>`}
    <details class="spec-details coverage-details"><summary>Ver cobertura principal <span>${coverage.length} ${coverage.length === 1 ? "need" : "needs"}</span></summary>${coverageList(coverage)}</details>
    ${lifecycle}
    <details class="spec-details sentinel-details"><summary>Ver estado Sentinel</summary><div class="sentinel-panel"><div class="sentinel-grid"><div><span>Documentary lifecycle</span><strong>${projection.documentary_status === null ? "Sem lifecycle" : escapeHtml(projection.documentary_status)}</strong></div><div><span>Execution snapshot</span><strong>${escapeHtml(projection.execution_state ?? "N/A")}</strong></div><div><span>Dependency verdict</span><strong>${escapeHtml(projection.dependency_verdict)}</strong></div></div><p>${escapeHtml(projection.detail)}</p><h4>Dependencies</h4>${dependencyList(candidate, model, projections)}</div></details>
    ${openGaps.length === 0 ? "" : `<details class="spec-details gap-details"><summary>Gaps e riscos previsíveis <span>${openGaps.length}${blocking.length === 0 ? "" : ` · ${blocking.length} BLOCKING`}</span></summary>${gapList(gaps)}</details>`}
    <details class="spec-details requirements-details"><summary>Ver REQUIREMENTS_SOURCE</summary><div class="markdown">${markdown(candidate.requirements_source)}</div></details>
    ${candidate.additional_context === undefined ? "" : `<details class="spec-details additional-details"><summary>Ver ADDITIONAL_CONTEXT</summary><div class="markdown">${markdown(candidate.additional_context)}</div></details>`}
  </div>
  <div class="spec-actions">
    <label class="status-label" for="${candidate.id}-status">Status local</label>
    <select class="status-select" id="${candidate.id}-status" data-local-status-select aria-describedby="${localNoteId}" aria-label="Status local de ${candidate.id} — ${escapeHtml(candidate.title)}">${LOCAL_STATUSES.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
    <small id="${localNoteId}">Só neste navegador; não é Sentinel state.</small>
    <button class="focus-button" type="button" data-focus-button="${candidate.id}"${index === 0 ? " disabled" : ""}>${index === 0 ? "Em foco" : "Definir como atual"}</button>
  </div>
  </article>`;
}

function coverageTable(model) {
  return `<div class="table-scroll"><table><thead><tr><th>Need</th><th>Coverage</th><th>Candidates</th><th>Overlap</th><th>Rationale</th></tr></thead><tbody>${model.coverage.filter((item) => item.state === "active").map((item) => `<tr><th scope="row"><code>${escapeHtml(item.need_id)}</code><span>${escapeHtml(item.title)}</span></th><td>${badge(item.status)}</td><td>${item.candidate_ids.length === 0 ? "—" : item.candidate_ids.map((id) => `<a href="#${id}" data-focus-link>${id}</a>`).join(", ")}</td><td>${item.overlap === undefined ? "—" : escapeHtml(item.overlap)}</td><td>${escapeHtml(item.rationale)}</td></tr>`).join("")}</tbody></table></div>`;
}

function sourceList(model) {
  return `<ul class="source-list">${model.sources.map((source) => `<li><div><code>${source.id}</code><strong>${escapeHtml(source.label)}</strong><span>${escapeHtml(source.kind)}</span></div><p>${source.path === undefined ? "Contexto fornecido diretamente" : `<code>${escapeHtml(source.path)}</code>`}</p><small>${source.needs.length} needs · ${source.snapshot_sha256 === undefined ? "sem file snapshot" : `sha256:${source.snapshot_sha256.slice(0, 12)}`}</small></li>`).join("")}</ul>`;
}

function gapOverview(model) {
  if (model.gaps.length === 0) return '<p class="empty">Nenhum gap registrado.</p>';
  return gapList(model.gaps);
}

export function renderRoadmap(model, projections) {
  const activeCandidates = model.candidates.filter((item) => item.disposition === "active");
  const activeCoverage = model.coverage.filter((item) => item.state === "active");
  const covered = activeCoverage.filter((item) => item.status === "covered").length;
  const openGaps = model.gaps.filter((item) => item.state === "open");
  const blocking = openGaps.filter((item) => item.severity === "BLOCKING").length;
  const materialized = [...projections.candidates.values()].filter((item) => item.materialization === "materialized").length;
  const invalid = [...projections.candidates.values()].filter((item) => item.materialization === "invalid").length;
  const dependencyWarnings = projections.dependencyEdges.filter((item) => item.verdict !== "SATISFIED").length;
  const roadmapState = blocking > 0 || invalid > 0 || activeCoverage.some((item) => item.status === "blocked") ? "BLOCKED" : "READY";
  const cards = model.candidates.map((candidate, index) => candidateCard(candidate, model, projections, index)).join("\n");
  const compose = (fingerprint) => `<!doctype html>
<!-- stnl-spec-roadmap:v1 fingerprint:${fingerprint} -->
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(model.summary)}">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(model.title)} · SPEC Roadmap</title>
  <style>${STYLES}</style>
</head>
<body data-roadmap-id="${escapeHtml(model.roadmap_id)}">
  <a class="skip" href="#main">Ir para o roadmap</a>
  <div class="page-shell" id="top">
    <header class="topbar">
      <div class="brand" aria-label="Sentinel SPEC Roadmap"><span class="brand-mark" aria-hidden="true">S</span><span>Sentinel · SPEC Roadmap</span></div>
      <div class="topbar-meta"><strong>${escapeHtml(model.roadmap_id)}</strong><br>Projection health: ${roadmapState}</div>
    </header>
    <main id="main" tabindex="-1">
      <section class="hero" aria-labelledby="page-title">
        <div class="hero-copy"><p class="eyebrow">Roadmap decomposition · ${escapeHtml(model.roadmap_id)}</p><h1 id="page-title">${escapeHtml(model.title)}</h1><p>${escapeHtml(model.summary)}</p></div>
        <aside class="hero-current" aria-live="polite" aria-label="Foco local atual">
          <p class="hero-current-label">Foco local neste navegador</p>
          <p class="hero-current-id" id="focus-id">${model.candidates[0].id}</p>
          <h2 id="focus-title">${escapeHtml(model.candidates[0].title)}</h2>
          <p id="focus-meta">${escapeHtml(model.candidates[0].spec_path)}</p>
          <p class="hero-current-status">Status local: <strong id="focus-status">Pendente</strong></p>
          <button class="jump-button" id="jump-focus" type="button">Ir para candidate em foco</button>
        </aside>
      </section>
      <section class="stats" aria-label="Resumo local e health do roadmap">
        <article class="stat-card"><span class="stat-label">Candidates ativas</span><strong class="stat-value">${activeCandidates.length}</strong><span class="stat-note">Decomposition canônica</span></article>
        <article class="stat-card"><span class="stat-label">Concluídas localmente</span><strong class="stat-value" id="local-completed">0</strong><span class="stat-note" id="local-completed-note">0 de ${activeCandidates.length} ativas</span></article>
        <article class="stat-card"><span class="stat-label">Gaps abertos</span><strong class="stat-value">${openGaps.length}</strong><span class="stat-note">${blocking} BLOCKING</span></article>
        <article class="stat-card progress-card"><span class="stat-label">Progresso local</span><strong class="stat-value" id="local-progress">0%</strong><div class="progress-track" id="local-progress-track" role="progressbar" aria-label="Progresso local baseado em candidates ativas concluídas" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-bar" id="local-progress-bar"></div></div><span class="stat-note">Conveniência do navegador</span></article>
      </section>
      <aside class="notice notice-${roadmapState.toLowerCase()}">
        <span class="notice-icon" aria-hidden="true">${roadmapState === "READY" ? "✓" : "!"}</span>
        <p><strong>Roadmap health: ${roadmapState}.</strong> Coverage ${covered}/${activeCoverage.length}; ${materialized} SPEC${materialized === 1 ? "" : "s"} materializada${materialized === 1 ? "" : "s"}; ${blocking} gap${blocking === 1 ? "" : "s"} BLOCKING; ${invalid} path${invalid === 1 ? "" : "s"} inválido${invalid === 1 ? "" : "s"}; ${dependencyWarnings} dependency warning${dependencyWarnings === 1 ? "" : "s"}. <span>Source of truth boundary: <code>roadmap.json</code> governa a decomposição; status local não é Sentinel state.</span></p>
      </aside>
      <section class="candidate-section" aria-labelledby="roadmap-title">
        <div class="section-heading"><div><p class="section-kicker">SPEC Roadmap</p><h2 id="roadmap-title">SPEC Candidates</h2><p>Informação principal primeiro; projeções e handoffs sob demanda.</p></div></div>
        <div class="toolbar" role="region" aria-label="Busca e filtros">
          <label class="search-control">Buscar<input id="search" type="search" maxlength="500" placeholder="Candidate, US, gap ou path…" autocomplete="off"></label>
          <label>Status local<select id="status-filter"><option value="">Todos</option>${LOCAL_STATUSES.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
          <label>Disposition<select id="disposition-filter"><option value="">Todas</option><option value="active">Active</option><option value="deferred">Deferred</option><option value="obsolete">Obsolete</option></select></label>
          <div class="toolbar-actions"><button type="button" id="expand">Abrir detalhes</button><button type="button" id="collapse">Fechar detalhes</button></div>
          <p id="result-count" aria-live="polite">${model.candidates.length} candidates visíveis</p>
        </div>
        <div class="roadmap candidates">${cards}<p id="empty-results" class="empty-results" hidden>Nenhuma candidate corresponde aos filtros.</p></div>
      </section>
      <section class="reference" aria-labelledby="reference-title">
        <div class="section-heading"><div><p class="section-kicker">Referências</p><h2 id="reference-title">Coverage, gaps e sources</h2><p>Contexto global do roadmap, sem substituir suas authorities.</p></div></div>
        <details class="reference-card"><summary>Coverage geral <span>${covered}/${activeCoverage.length} covered; todas as needs possuem disposition explícita</span></summary>${coverageTable(model)}</details>
        <details class="reference-card"><summary>Gaps <span>${openGaps.length} abertos · ${blocking} BLOCKING</span></summary>${gapOverview(model)}</details>
        <details class="reference-card"><summary>Sources <span>${model.sources.length} context sources</span></summary>${sourceList(model)}</details>
      </section>
    </main>
    <footer class="footer">
      <div><p>Roadmap offline · fingerprint <code>${fingerprint.slice(0, 12)}</code></p><a href="#top">Voltar ao topo</a></div>
      <div class="footer-actions">
        <button type="button" id="export">Exportar progresso</button>
        <label class="import-button">Importar progresso<input id="import" type="file" accept="application/json,.json"></label>
        <button type="button" id="print">Imprimir</button>
        <button type="button" id="reset" class="danger">Reset local</button>
      </div>
      <p id="import-status" class="footer-feedback" aria-live="polite"></p>
    </footer>
  </div>
  <script>${clientScript()}</script>
</body>
</html>
`;
  const draft = compose("0".repeat(64));
  const fingerprint = createHash("sha256").update(draft, "utf8").digest("hex");
  return { html: compose(fingerprint), fingerprint, state: roadmapState };
}

const STYLES = String.raw`
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto!important}*,*::before,*::after{transition:none!important;animation:none!important}}
:root{color-scheme:light;--brand:#5b5bd6;--brand-dark:#4545b8;--brand-soft:#ecebfb;--brand-softer:#f5f4ff;--warm-bg:#f6f4ef;--paper:#fff;--paper-muted:#fbfaf8;--text:#1c1c1e;--text-secondary:#6e6e73;--text-muted:#6e6e73;--line:#e8e5de;--success:#247a50;--success-soft:#e3f4ea;--warning:#9b620f;--warning-soft:#fff6e6;--danger:#b83e38;--danger-soft:#fce8e7;--info:#2868b3;--info-soft:#eaf3ff;--shadow-sm:0 2px 8px rgba(35,32,25,.06);--shadow-md:0 14px 40px rgba(38,35,31,.1);--shadow-brand:0 18px 44px rgba(91,91,214,.22);--radius-sm:10px;--radius-md:16px;--radius-lg:24px;--page-width:1180px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",system-ui,sans-serif;color:var(--text);background:var(--warm-bg)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
button,input,select,textarea{font:inherit}
body{min-width:320px;margin:0;background:radial-gradient(circle at 8% 0%,rgba(91,91,214,.1),transparent 28rem),linear-gradient(180deg,#fbfaf8 0,var(--warm-bg) 34rem);color:var(--text);font-size:16px;line-height:1.5}
button,select,.import-button{min-height:44px}
button{border:0;cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,a:focus-visible,.import-button:focus-within{outline:3px solid rgba(91,91,214,.42);outline-offset:2px}
a{color:var(--brand-dark)}
code{overflow-wrap:anywhere}
.skip{position:fixed;z-index:100;top:10px;left:-999px;padding:8px 12px;border-radius:8px;background:#fff;color:var(--brand-dark)}
.skip:focus{left:10px}
.page-shell{width:min(calc(100% - 32px),var(--page-width));margin:0 auto;padding:28px 0 64px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:28px}
.brand{display:flex;grid-column:auto;align-items:center;gap:12px;font-size:1.02rem;font-weight:800;letter-spacing:-.02em;text-transform:none}
.brand-mark,.brand span.brand-mark{display:grid;width:42px;height:42px;place-items:center;border-radius:14px;background:var(--brand);box-shadow:0 8px 22px rgba(91,91,214,.32);color:#fff;font-size:1rem}
.topbar-meta{color:var(--text-secondary);font-size:.82rem;text-align:right}
main{width:auto;margin:0}
.hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.55fr);gap:32px;padding:38px;border:0;border-radius:var(--radius-lg);background:radial-gradient(circle at 100% 0%,rgba(255,255,255,.2),transparent 24rem),linear-gradient(135deg,#4f4fc5 0%,var(--brand) 58%,#7070e2 100%);box-shadow:var(--shadow-brand);color:#fff}
.hero::after{position:absolute;right:-72px;bottom:-96px;width:280px;height:280px;border:1px solid rgba(255,255,255,.18);border-radius:50%;content:""}
.eyebrow,.section-kicker{margin:0 0 10px;font-size:.75rem;font-weight:800;letter-spacing:.11em;text-transform:uppercase}
.hero .eyebrow{color:inherit}
.hero h1{max-width:750px;margin:0;font-family:inherit;font-size:clamp(2rem,4vw,3.65rem);line-height:1.02;letter-spacing:-.055em}
.hero-copy>p:last-child{max-width:680px;margin:18px 0 0;color:rgba(255,255,255,.84);font-size:1.02rem}
.hero-current{position:relative;z-index:1;align-self:stretch;padding:22px;border:1px solid rgba(255,255,255,.35);border-radius:20px;background:rgba(33,33,99,.42);backdrop-filter:blur(8px)}
.hero-current-label{margin:0 0 14px;color:#fff;font-size:.75rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.hero-current-id{margin:0 0 4px;color:#fff;font-size:.78rem;font-weight:750}
.hero-current h2{margin:0;font-family:inherit;font-size:1.35rem;line-height:1.18;letter-spacing:-.025em}
.hero-current>p:not(.hero-current-label):not(.hero-current-id){margin:10px 0;color:#fff;font-size:.87rem;overflow-wrap:anywhere}
.hero-current-status{padding-top:8px;border-top:1px solid rgba(255,255,255,.18)}
.jump-button{width:100%;margin-top:8px;padding:10px 16px;border-radius:12px;background:#fff;color:var(--brand-dark);font-weight:750}
.jump-button:disabled{cursor:default;opacity:.66}
.stats{display:grid;grid-column:auto;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:22px 0;padding:0;border:0}
.stats .stat-card{min-height:124px;padding:20px;border:1px solid rgba(232,229,222,.82);border-radius:var(--radius-md);background:rgba(255,255,255,.9);box-shadow:var(--shadow-sm)}
.stat-label{display:block;margin-bottom:12px;color:var(--text-secondary);font-size:.75rem;font-weight:750;letter-spacing:.055em;text-transform:uppercase}
.stat-value{display:block;font-size:2rem;font-weight:820;line-height:1;letter-spacing:-.04em}
.stat-note{display:block;margin-top:9px;color:var(--text-muted);font-size:.8rem}
.progress-track{overflow:hidden;height:9px;margin-top:14px;border-radius:999px;background:#e8e5ef}
.progress-bar{width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--brand),#8585ef);transition:width 300ms ease}
.notice{display:flex;align-items:flex-start;gap:14px;margin:0 0 22px;padding:16px 18px;border:1px solid #d8d2f1;border-radius:14px;background:var(--brand-softer);color:#484168}
.notice-blocked{border-color:#f0d7a5;background:var(--warning-soft);color:#6e4a11}
.notice-icon{flex:0 0 auto;display:grid;width:24px;height:24px;place-items:center;border-radius:50%;background:rgba(255,255,255,.7);font-weight:850}
.notice p{margin:0;font-size:.88rem}
.section-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin:40px 0 16px}
.section-heading .section-kicker{margin-bottom:5px;color:var(--brand-dark)}
.section-heading h2{margin:0;font-family:inherit;font-size:1.7rem;letter-spacing:-.035em}
.section-heading p:last-child{margin:5px 0 0;color:var(--text-secondary)}
.toolbar{position:static;display:grid;grid-template-columns:minmax(220px,1fr) minmax(180px,.34fr) minmax(160px,.28fr) auto;gap:10px;margin-bottom:18px;padding:12px;border:1px solid var(--line);border-radius:var(--radius-md);background:rgba(255,255,255,.82);backdrop-filter:none}
.toolbar label{color:var(--text-secondary);font-size:.72rem;font-weight:800}
.toolbar input[type=search],.toolbar select{display:block;width:100%;min-height:44px;margin-top:4px;padding:0 13px;border:1px solid #dcd8d0;border-radius:11px;background:#fff;color:var(--text)}
.toolbar-actions{display:flex;grid-column:auto;align-items:flex-end;gap:8px}
.toolbar-actions button,.footer-actions button,.import-button,.focus-button{min-height:44px;padding:0 14px;border:1px solid #dcd8d0;border-radius:11px;background:#fff;color:var(--text);font-size:inherit;font-weight:700}
.toolbar-actions button:hover,.footer-actions button:hover,.import-button:hover,.focus-button:hover{border-color:var(--brand);color:var(--brand-dark)}
#result-count{grid-column:1/-1;margin:0;color:var(--text-muted);font-size:.78rem}
.roadmap{display:grid;gap:12px}
.spec-card{position:relative;display:grid;grid-template-columns:56px minmax(0,1fr) minmax(190px,.32fr);gap:18px;overflow:visible;padding:20px;border:1px solid var(--line);border-radius:var(--radius-md);background:rgba(255,255,255,.95);box-shadow:var(--shadow-sm);scroll-margin-top:18px;transition:transform 160ms ease,border-color 160ms ease,box-shadow 160ms ease}
.spec-card[hidden]{display:none}
.spec-card:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(35,32,25,.08)}
.spec-card.is-focused{border-color:rgba(91,91,214,.58);box-shadow:0 0 0 3px rgba(91,91,214,.08),0 12px 30px rgba(91,91,214,.12)}
.spec-card.is-focused::before{position:absolute;top:14px;right:18px;padding:4px 8px;border-radius:999px;background:var(--brand-soft);color:var(--brand-dark);content:"EM FOCO";font-size:.62rem;font-weight:850;letter-spacing:.08em}
.spec-card:focus{outline:none}
.spec-card:focus-visible{outline:3px solid rgba(91,91,214,.38);outline-offset:3px}
.spec-number{display:grid;width:48px;height:48px;place-items:center;border-radius:15px;background:var(--brand-softer);color:var(--brand-dark);font-weight:850}
.spec-main{min-width:0}
.spec-meta{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:0 80px 5px 0}
.spec-id{color:var(--brand-dark);font-size:.74rem;font-weight:800;letter-spacing:.035em}
.path{max-width:100%;color:var(--text-muted);font-size:.72rem}
.candidate-badges{display:flex;justify-content:flex-start;flex-wrap:wrap;gap:5px;max-width:none}
.spec-main h3{margin:0;padding-right:82px;font-size:1.15rem;line-height:1.24;letter-spacing:-.02em;text-transform:none}
.spec-description{margin:8px 0 0;color:var(--text-secondary);font-size:.9rem}
.compact-facts{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px}
.compact-fact{margin:0;color:var(--text-secondary);font-size:.78rem}
.compact-fact a{font-weight:750;text-decoration:none}
.compact-fact .badge{margin-left:3px;vertical-align:middle}
.gap-fact{color:var(--warning)}
.gap-fact.has-blocking{color:var(--danger)}
.badge{display:inline-flex;align-items:center;width:max-content;padding:3px 7px;border-radius:999px;background:#eee9f0;color:#5d5363;font-size:.6rem;font-weight:850;letter-spacing:.035em;text-transform:uppercase}
.badge-active,.badge-covered,.badge-materialized,.badge-info{background:var(--success-soft);color:var(--success)}
.badge-blocking,.badge-blocked,.badge-invalid,.badge-unknown{background:var(--danger-soft);color:var(--danger)}
.badge-attention,.badge-deferred,.badge-unsatisfied{background:var(--warning-soft);color:var(--warning)}
.candidate-note,.handoff-unavailable,.impact{margin:12px 0 0;padding:12px;border-radius:10px;background:var(--paper-muted);font-size:.83rem}
.impact{background:var(--warning-soft);color:#70430b}
.impact p{margin:4px 0 0}
.spec-actions{display:flex;align-self:start;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:7px;padding-top:32px}
.status-label{color:var(--text-muted);font-size:.69rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase}
.status-select{width:100%;padding:0 10px;border:1px solid #dcd8d0;border-radius:11px;background:#fff;color:var(--text)}
.spec-actions small{color:var(--text-muted);font-size:.69rem}
.focus-button{margin-top:3px;border-color:rgba(91,91,214,.2);background:var(--brand-soft);color:var(--brand-dark)}
.focus-button:disabled{cursor:default;opacity:.65}
.candidate-card .spec-details{margin-top:10px;padding:0;border:0}
.candidate-card .spec-details summary{width:fit-content;color:var(--brand-dark);cursor:pointer;font-size:.8rem;font-weight:740}
.candidate-card .spec-details summary span{color:var(--text-muted);font-weight:500}
.candidate-card .spec-details[open]{width:100%}
.need-list,.dependency-list,.gap-list,.source-list{list-style:none;padding:0;margin:10px 0 0}
.need-list li{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:9px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}
.need-list li span:nth-child(2){font-size:.83rem}
.dependency-list li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 9px;padding:9px 0;border-bottom:1px solid var(--line)}
.dependency-list a{color:var(--brand-dark);font-weight:750;text-decoration:none}
.dependency-list small{grid-column:1/-1;color:var(--text-muted)}
.sentinel-panel,.markdown{margin-top:12px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--paper-muted)}
.sentinel-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.sentinel-grid>div{min-width:0}
.sentinel-grid span{display:block;color:var(--text-muted);font-size:.65rem;font-weight:750;letter-spacing:.06em;text-transform:uppercase}
.sentinel-grid strong{display:block;margin-top:2px;overflow-wrap:anywhere;font-size:.84rem}
.sentinel-panel>p{margin:10px 0 0;color:var(--text-secondary);font-size:.8rem}
.sentinel-panel h4{margin:14px 0 0;font-size:.76rem;letter-spacing:.05em;text-transform:uppercase}
.markdown p{margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.markdown h3,.markdown h4,.markdown h5,.markdown h6{margin:14px 0 6px;text-transform:none}
.md-space{display:block;height:8px}
.gap-list{display:grid;gap:10px}
.gap-list li{display:grid;grid-template-columns:auto 1fr;gap:11px;padding:12px;border:1px solid var(--line);border-radius:12px}
.gap-list p{margin:3px 0}
.gap-list small{display:block;color:var(--text-muted)}
.lifecycle-context{position:relative;margin-top:12px}
.lifecycle-context textarea{display:block;overflow:auto;width:100%;height:260px;max-height:460px;margin:0;padding:48px 16px 16px;border:1px solid #38364a;border-radius:12px;background:#242334;color:#f6f4ff;caret-color:#fff;font:400 .75rem/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical;white-space:pre;tab-size:2}
.copy-context-button{position:absolute;z-index:1;top:8px;right:8px;min-height:32px;padding:5px 10px;border:1px solid rgba(255,255,255,.24);border-radius:8px;background:rgba(255,255,255,.12);color:#fff;font-size:.72rem;font-weight:750}
.lifecycle-context [data-copy-status]{min-height:1.1em;margin:6px 0 0;color:var(--success);font-size:.75rem}
.handoff-print{display:none;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:.75rem}
.empty-results{padding:42px 24px;border:1px dashed #ccc7bc;border-radius:var(--radius-md);background:rgba(255,255,255,.62);color:var(--text-secondary);text-align:center}
.empty{color:var(--text-muted);font-style:italic}
.reference{margin-top:42px;border:0}
.reference .section-heading{margin-bottom:16px}
.reference>.reference-card{margin-bottom:10px;padding:0 18px;border:1px solid var(--line);border-radius:var(--radius-md);background:rgba(255,255,255,.86);box-shadow:var(--shadow-sm)}
.reference>.reference-card>summary{padding:16px 0;color:var(--text);cursor:pointer;font-family:inherit;font-size:1rem;font-weight:800}
.reference>.reference-card>summary span{float:right;color:var(--text-muted);font-size:.75rem;font-weight:400}
.reference>.reference-card[open]{padding-bottom:18px}
.table-scroll{overflow:auto;border:1px solid var(--line);border-radius:12px}
table{width:100%;min-width:820px;border-collapse:collapse;background:var(--paper)}
th,td{padding:11px;border-bottom:1px solid var(--line);font-size:.78rem;text-align:left;vertical-align:top}
th span{display:block;color:var(--text-muted);font-weight:400}
td a{color:var(--brand-dark)}
.source-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.source-list li{padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--paper)}
.source-list li div{display:flex;align-items:center;flex-wrap:wrap;gap:9px}
.source-list p{margin:7px 0}
.source-list small{color:var(--text-muted)}
.footer{display:grid;width:auto;grid-template-columns:1fr auto;gap:14px 20px;margin-top:42px;padding:20px 0 0;border-top:1px solid var(--line);color:var(--text-muted);font-size:.78rem}
.footer p{margin:0}
.footer>div:first-child{display:flex;align-items:center;gap:14px}
.footer-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.import-button{position:relative;display:inline-grid;place-items:center;cursor:pointer}
.import-button input{position:absolute;width:1px;height:1px;opacity:0}
.danger{border-color:#f1c8c4!important;background:var(--danger-soft)!important;color:#a7352e!important}
.footer-feedback{grid-column:1/-1;min-height:1.2em}
@media(max-width:900px){.hero{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.toolbar{grid-template-columns:1fr 1fr}.toolbar-actions{grid-column:1/-1}.spec-card{grid-template-columns:48px minmax(0,1fr)}.spec-actions{grid-column:2;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;padding-top:0}.spec-actions small{grid-column:1/-1}.focus-button{grid-column:2;grid-row:1/3}.candidate-card .spec-details[open]{width:100%}.source-list{grid-template-columns:1fr}}
@media(max-width:620px){.page-shell{width:min(calc(100% - 20px),var(--page-width));padding-top:16px}.topbar{align-items:flex-start;margin-bottom:18px}.topbar-meta{font-size:.72rem}.brand{font-size:.9rem}.brand-mark,.brand span.brand-mark{width:38px;height:38px;border-radius:12px}.hero{gap:24px;padding:26px 22px;border-radius:20px}.hero h1{font-size:2.25rem}.stats{gap:10px}.stats .stat-card{min-height:110px;padding:16px}.stat-value{font-size:1.7rem}.notice{padding:14px}.section-heading{align-items:flex-start;flex-direction:column}.toolbar{grid-template-columns:1fr}.toolbar-actions{grid-column:auto;display:grid;grid-template-columns:1fr 1fr}.spec-card{grid-template-columns:40px minmax(0,1fr);gap:12px;padding:16px}.spec-number{width:40px;height:40px;border-radius:12px;font-size:.85rem}.spec-card.is-focused::before{position:static;grid-column:1/-1;grid-row:1;width:fit-content;margin-bottom:-4px}.spec-card.is-focused .spec-number,.spec-card.is-focused .spec-main{grid-row:2}.spec-meta{margin-right:0}.spec-main h3{padding-right:0}.spec-actions{grid-column:1/-1;display:grid;grid-template-columns:1fr}.spec-actions small,.focus-button{grid-column:1;grid-row:auto}.status-select,.focus-button{width:100%}.need-list li{grid-template-columns:auto minmax(0,1fr)}.need-list .badge{grid-column:auto}.sentinel-grid{grid-template-columns:1fr}.lifecycle-context textarea{height:300px}.reference>.reference-card>summary span{float:none;display:block;margin-top:4px}.footer{grid-template-columns:1fr}.footer>div:first-child{align-items:flex-start;flex-direction:column;gap:4px}.footer-actions{display:grid;grid-template-columns:1fr 1fr;justify-content:stretch}.footer-actions>*{width:100%}.footer-feedback{grid-column:1}.source-list{grid-template-columns:1fr}}
@media(max-width:390px){.hero h1{font-size:2rem}.stat-label{font-size:.67rem}.compact-facts{display:grid}.footer-actions{grid-template-columns:1fr}}
@media print{@page{margin:11mm}*{print-color-adjust:economy!important;-webkit-print-color-adjust:economy!important}:root,body{background:#fff!important}body{font-size:9pt}.page-shell{width:100%;max-width:none;padding:0}.topbar{margin-bottom:4mm}.brand-mark,.brand span.brand-mark{box-shadow:none}.hero{grid-template-columns:1.45fr .55fr;padding:6mm;border:1px solid #777;background:#fff!important;box-shadow:none;color:#111}.hero::after{display:none}.hero-copy>p:last-child,.hero-current>p:not(.hero-current-label):not(.hero-current-id){color:#333}.hero-current{border-color:#999;background:#fff;color:#111}.hero-current-label{color:#555}.jump-button,.toolbar,.focus-button,.status-select,.status-label,.spec-actions small,.footer-actions,.footer a,.copy-context-button,.lifecycle-context [data-copy-status]{display:none!important}.stats{gap:3mm;margin:4mm 0}.stats .stat-card{min-height:0;padding:3mm;border-color:#999;box-shadow:none}.notice{margin-bottom:4mm;border-color:#999;background:#fff;color:#111}.section-heading{margin:6mm 0 3mm}.spec-card{display:block;position:relative;break-inside:auto;margin:0 0 5mm;padding:4mm 4mm 4mm 18mm;border-color:#888;box-decoration-break:clone;-webkit-box-decoration-break:clone;box-shadow:none}.spec-card[hidden]{display:block}.spec-number{position:absolute;top:4mm;left:4mm}.spec-card:hover{transform:none}.spec-card.is-focused{box-shadow:none}.spec-actions{display:none}.candidate-card .spec-details[open]{width:100%}.candidate-card .spec-details{break-inside:avoid}.candidate-card .spec-details>summary{list-style:none}.candidate-card .spec-details>summary::marker{display:none}.candidate-card .spec-details>:not(summary){display:block!important}.sentinel-grid{grid-template-columns:1fr}.need-list li,.sentinel-panel,.gap-list li,.impact{break-inside:avoid}.lifecycle-context textarea{display:none}.handoff-print{display:block;padding:4mm;border:1px solid #777;border-radius:2mm;background:#fff;color:#111;max-height:none}.reference{margin-top:0}.reference .section-heading{display:none}.reference>.reference-card{break-inside:auto;box-shadow:none}.reference>.reference-card:first-of-type{break-before:auto!important;page-break-before:auto!important}.reference>.reference-card>:not(summary){display:block!important}.table-scroll{overflow:visible}table{min-width:0;table-layout:fixed}th,td{overflow-wrap:anywhere;word-break:break-word}.table-scroll th:nth-child(1){width:22%}.table-scroll th:nth-child(2){width:14%}.table-scroll th:nth-child(3){width:18%}.table-scroll th:nth-child(4){width:13%}.table-scroll th:nth-child(5){width:33%}tr{break-inside:avoid}.source-list{grid-template-columns:1fr 1fr}.footer{display:grid;width:100%;margin-top:4mm;padding-top:3mm;break-inside:avoid}}
`;

function clientScript() {
  return CLIENT_SCRIPT;
}

const CLIENT_SCRIPT = String.raw`
(()=>{
  "use strict";
  document.documentElement.classList.add("js");
  const roadmapId=document.body.dataset.roadmapId;
  const storageKey="stnl-roadmap:v1:"+roadmapId;
  const allowed=new Set(["pending","specifying","ready","development","validation","blocked","completed"]);
  const labels={pending:"Pendente",specifying:"Em especificação",ready:"Pronta para execução",development:"Em desenvolvimento",validation:"Em validação",blocked:"Bloqueada",completed:"Concluída"};
  const cards=[...document.querySelectorAll("[data-candidate-id]")];
  const activeCards=cards.filter(card=>card.dataset.disposition==="active");
  const byId=new Map(cards.map(card=>[card.dataset.candidateId,card]));
  const search=document.getElementById("search");
  const statusFilter=document.getElementById("status-filter");
  const dispositionFilter=document.getElementById("disposition-filter");
  const count=document.getElementById("result-count");
  const empty=document.getElementById("empty-results");
  const importStatus=document.getElementById("import-status");
  const jumpFocus=document.getElementById("jump-focus");
  let focus=cards[0]?.dataset.candidateId??null;

  function safeGet(){try{return localStorage.getItem(storageKey)}catch{return null}}
  function safeSet(value){try{localStorage.setItem(storageKey,value)}catch{}}
  function safeRemove(){try{localStorage.removeItem(storageKey)}catch{}}
  function state(){
    const candidates={};
    for(const card of cards)candidates[card.dataset.candidateId]={status:card.dataset.localStatus};
    return{version:1,roadmap_id:roadmapId,focus,filters:{search:search.value.slice(0,500),status:statusFilter.value,disposition:dispositionFilter.value},candidates};
  }
  function save(){safeSet(JSON.stringify(state()))}
  function setStatus(card,value){
    if(!allowed.has(value))return;
    card.dataset.localStatus=value;
    card.querySelector("[data-local-status-select]").value=value;
  }
  function updateLocalSummary(){
    const completed=activeCards.filter(card=>card.dataset.localStatus==="completed").length;
    const progress=activeCards.length===0?0:Math.round(completed/activeCards.length*100);
    document.getElementById("local-completed").textContent=String(completed);
    document.getElementById("local-completed-note").textContent=completed+" de "+activeCards.length+" ativas";
    document.getElementById("local-progress").textContent=progress+"%";
    document.getElementById("local-progress-bar").style.width=progress+"%";
    document.getElementById("local-progress-track").setAttribute("aria-valuenow",String(progress));
  }
  function updateFocusPanel(card,hiddenByFilters=false){
    if(card===null){
      document.getElementById("focus-id").textContent="—";
      document.getElementById("focus-title").textContent="Nenhuma candidate visível";
      document.getElementById("focus-meta").textContent="Ajuste os filtros para retomar o foco.";
      document.getElementById("focus-status").textContent="—";
      jumpFocus.disabled=true;
      return;
    }
    document.getElementById("focus-id").textContent=card.dataset.candidateId;
    document.getElementById("focus-title").textContent=card.querySelector("h3").textContent;
    document.getElementById("focus-meta").textContent=(hiddenByFilters?"Oculta pelos filtros · ":"")+card.querySelector(".path").textContent;
    document.getElementById("focus-status").textContent=labels[card.dataset.localStatus];
    jumpFocus.disabled=false;
  }
  function setFocus(id,scroll=false){
    const card=byId.get(id);
    if(!card)return;
    focus=id;
    for(const item of cards)item.classList.toggle("is-focused",item===card);
    for(const button of document.querySelectorAll("[data-focus-button]")){
      const active=button.dataset.focusButton===id;
      button.disabled=active;
      button.textContent=active?"Em foco":"Definir como atual";
    }
    updateFocusPanel(card,card.hidden);
    if(scroll){
      card.scrollIntoView({block:"center"});
      card.focus({preventScroll:true});
    }
    save();
  }
  function clearFocus(){
    focus=null;
    for(const item of cards)item.classList.remove("is-focused");
    for(const button of document.querySelectorAll("[data-focus-button]")){
      button.disabled=false;
      button.textContent="Definir como atual";
    }
    updateFocusPanel(null);
  }
  function apply(){
    const query=search.value.trim().toLocaleLowerCase("pt-BR");
    let visible=0;
    for(const card of cards){
      const match=(!query||card.dataset.search.includes(query))
        &&(!statusFilter.value||card.dataset.localStatus===statusFilter.value)
        &&(!dispositionFilter.value||card.dataset.disposition===dispositionFilter.value);
      card.hidden=!match;
      if(match)visible++;
    }
    const focused=focus===null?null:byId.get(focus);
    if(focused===null){
      const first=cards.find(card=>!card.hidden);
      if(first)setFocus(first.dataset.candidateId,false);
      else clearFocus();
    }else updateFocusPanel(focused,focused.hidden);
    count.textContent=visible+" de "+cards.length+" candidates visíveis";
    empty.hidden=visible!==0;
    updateLocalSummary();
    save();
  }
  function accept(raw){
    if(raw===null||typeof raw!=="object"||Array.isArray(raw)||raw.version!==1||raw.roadmap_id!==roadmapId||raw.candidates===null||typeof raw.candidates!=="object"||Array.isArray(raw.candidates))throw new Error("Arquivo não pertence a este roadmap.");
    for(const[id,value]of Object.entries(raw.candidates)){
      if(!byId.has(id)||value===null||typeof value!=="object"||!allowed.has(value.status))throw new Error("Candidate/status local inválido: "+id);
    }
    for(const card of cards){
      const value=raw.candidates[card.dataset.candidateId];
      if(value)setStatus(card,value.status);
    }
    if(raw.filters&&typeof raw.filters==="object"){
      search.value=typeof raw.filters.search==="string"?raw.filters.search.slice(0,500):"";
      statusFilter.value=allowed.has(raw.filters.status)?raw.filters.status:"";
      dispositionFilter.value=["active","deferred","obsolete"].includes(raw.filters.disposition)?raw.filters.disposition:"";
    }
    if(typeof raw.focus==="string"&&byId.has(raw.focus))focus=raw.focus;
    apply();
    if(focus!==null)setFocus(focus,false);
  }
  function load(){
    const raw=safeGet();
    if(!raw)return;
    try{accept(JSON.parse(raw))}catch{safeRemove()}
  }

  for(const card of cards){
    const select=card.querySelector("[data-local-status-select]");
    select.addEventListener("change",event=>{
      const hadFocus=document.activeElement===event.target;
      const index=cards.indexOf(card);
      setStatus(card,event.target.value);
      apply();
      if(hadFocus&&card.hidden){
        const ordered=[...cards.slice(index+1),...cards.slice(0,index)];
        const next=ordered.find(item=>!item.hidden);
        (next?.querySelector("[data-local-status-select]")??statusFilter).focus();
      }
    });
  }
  for(const control of[search,statusFilter,dispositionFilter])control.addEventListener("input",apply);
  document.querySelectorAll("[data-focus-button]").forEach(button=>button.addEventListener("click",()=>setFocus(button.dataset.focusButton,true)));
  document.querySelectorAll("[data-focus-link]").forEach(link=>link.addEventListener("click",event=>{
    const id=link.getAttribute("href")?.slice(1);
    const card=byId.get(id);
    if(!card)return;
    event.preventDefault();
    if(card.hidden){
      search.value="";
      statusFilter.value="";
      dispositionFilter.value="";
      apply();
    }
    setFocus(id,true);
  }));
  document.querySelectorAll("[data-copy-target]").forEach(button=>button.addEventListener("click",async()=>{
    const target=document.getElementById(button.dataset.copyTarget);
    let copied=false;
    try{await navigator.clipboard.writeText(target.value);copied=true}catch{
      target.focus();
      target.select();
      try{copied=document.execCommand("copy")}catch{copied=false}
    }
    button.closest(".lifecycle-context").querySelector("[data-copy-status]").textContent=copied?"Contexto copiado.":"Selecione e copie o texto manualmente.";
  }));
  document.getElementById("expand").addEventListener("click",()=>document.querySelectorAll(".candidate-card details").forEach(item=>{item.open=true}));
  document.getElementById("collapse").addEventListener("click",()=>document.querySelectorAll(".candidate-card details").forEach(item=>{item.open=false}));
  jumpFocus.addEventListener("click",()=>{
    if(focus===null)return;
    const card=byId.get(focus);
    if(card?.hidden){
      search.value="";
      statusFilter.value="";
      dispositionFilter.value="";
      apply();
    }
    setFocus(focus,true);
  });
  document.getElementById("print").addEventListener("click",()=>window.print());
  document.getElementById("reset").addEventListener("click",()=>{
    if(!window.confirm("Remover todo o progresso local deste roadmap?"))return;
    for(const card of cards)setStatus(card,"pending");
    search.value="";
    statusFilter.value="";
    dispositionFilter.value="";
    focus=cards[0]?.dataset.candidateId??null;
    importStatus.textContent="";
    apply();
    if(focus!==null)setFocus(focus,false);
    safeRemove();
  });
  document.getElementById("export").addEventListener("click",()=>{
    const blob=new Blob([JSON.stringify(state(),null,2)+"\n"],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");
    link.href=url;
    link.download=roadmapId.toLowerCase()+"-local-progress.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),0);
  });
  document.getElementById("import").addEventListener("change",event=>{
    const file=event.target.files?.[0];
    if(!file)return;
    if(file.size>1000000){
      importStatus.textContent="Arquivo excede 1 MB.";
      event.target.value="";
      return;
    }
    const reader=new FileReader();
    reader.addEventListener("load",()=>{
      try{
        accept(JSON.parse(String(reader.result)));
        save();
        importStatus.textContent="Progresso local importado.";
      }catch(error){
        importStatus.textContent="Importação recusada: "+error.message;
      }
      event.target.value="";
    });
    reader.addEventListener("error",()=>{
      importStatus.textContent="Não foi possível ler o arquivo.";
      event.target.value="";
    });
    reader.readAsText(file,"utf-8");
  });
  let opened=[];
  addEventListener("beforeprint",()=>{
    opened=[...document.querySelectorAll("details:not([open])")];
    for(const item of opened)item.open=true;
  });
  addEventListener("afterprint",()=>{
    for(const item of opened)item.open=false;
    opened=[];
  });
  load();
  apply();
  if(focus!==null)setFocus(focus,false);
})();
`;
