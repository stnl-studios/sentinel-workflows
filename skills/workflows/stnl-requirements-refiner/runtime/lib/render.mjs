import { createHash } from "node:crypto";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function prose(value) {
  return `<p>${escapeHtml(value).replaceAll("\n", "<br>")}</p>`;
}

function badge(value, label = value) {
  return `<span class="badge badge-${escapeHtml(String(value).toLowerCase().replaceAll("_", "-"))}">${escapeHtml(label)}</span>`;
}

function severityPresentation(finding) {
  if (finding.disposition === "open") return badge(finding.severity);
  return `<span class="severity-history"><span>Original severity:</span> <strong>${escapeHtml(finding.severity)}</strong></span>`;
}

function list(items, empty = "Nenhum item registrado.") {
  if (items.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function validation(resolution) {
  const labels = {
    behavior_defined: "Comportamento definido",
    ambiguity_closed: "Ambiguidade fechada",
    repository_consistent: "Consistência com repository",
    no_new_gap_introduced: "Nenhum novo gap introduzido",
    problem_fully_addressed: "Problema integralmente tratado",
  };
  return `<div class="validation-summary">${Object.entries(resolution.checks).map(([key, value]) => (
    `<div class="validation-row"><span>${escapeHtml(labels[key])}</span>${badge(value)}</div>`
  )).join("")}</div>${prose(resolution.rationale)}${resolution.remaining_gap === undefined ? "" : `<aside class="remaining-gap"><strong>Gap restante</strong>${prose(resolution.remaining_gap)}</aside>`}`;
}

function evidenceDetails(finding, model) {
  const ids = new Set([
    ...finding.evidence_ids,
    ...(finding.resolution?.supporting_evidence_ids ?? []),
  ]);
  const items = model.evidence.filter((item) => ids.has(item.id));
  if (items.length === 0) return "";
  return `<details class="evidence-details"><summary>Evidências relacionadas <span>${items.length}</span></summary><div class="evidence-list">${items.map((item) => `<article><div>${badge(item.kind)} ${badge(item.confidence)} <code>${item.id}</code></div><strong>${escapeHtml(item.summary)}</strong>${prose(item.detail)}${item.path === undefined ? "" : `<small><code>${escapeHtml(item.path)}</code> · ${escapeHtml(item.locator)}</small>`}</article>`).join("")}</div></details>`;
}

function linkedQuestions(finding, model) {
  const questions = model.questions.filter((item) => finding.question_ids.includes(item.id));
  if (questions.length === 0) return '<p class="empty">Nenhuma decisão adicional materializada.</p>';
  return `<ul class="question-list">${questions.map((item) => `<li><code>${item.id}</code><span>${escapeHtml(item.question)}</span>${badge(item.status)}</li>`).join("")}</ul>`;
}

function findingCard(finding, model) {
  const rejected = finding.disposition === "open" && finding.resolution?.verdict === "rejected";
  const inconclusive = finding.disposition === "open" && finding.resolution?.verdict === "inconclusive";
  const variant = finding.disposition === "resolved" ? "resolved"
    : finding.disposition === "bypassed" ? "bypassed"
      : rejected ? "rejected" : inconclusive ? "inconclusive" : "open";
  const search = [
    finding.id, finding.title, finding.type, finding.severity, finding.problem, finding.why_it_matters,
    finding.impact, finding.resolution?.proposal ?? "", finding.resolution?.rationale ?? "",
    finding.bypass?.reason ?? "", finding.bypass?.known_risk ?? "",
  ].join(" ").toLocaleLowerCase("pt-BR");
  let body;
  if (finding.disposition === "resolved") {
    body = `<div class="finding-columns three"><section><h4>Gap</h4>${prose(finding.problem)}<small>${escapeHtml(finding.why_it_matters)}</small></section><section class="resolution-panel"><h4>Resolution</h4>${prose(finding.resolution.proposal)}</section><section class="validation-panel"><h4>Validation</h4>${validation(finding.resolution)}</section></div>`;
  } else if (finding.disposition === "bypassed") {
    body = `<div class="finding-columns three"><section><h4>Gap</h4>${prose(finding.problem)}</section><section class="bypass-panel"><h4>Bypass decision</h4>${prose(finding.bypass.reason)}</section><section class="risk-panel"><h4>Known risk remains</h4>${prose(finding.bypass.known_risk)}<small>${escapeHtml(finding.impact)}</small></section></div>`;
  } else if (rejected || inconclusive) {
    const heading = rejected ? "Validation failed" : "Validation inconclusive";
    body = `<div class="finding-columns three"><section><h4>Gap</h4>${prose(finding.problem)}</section><section class="proposal-panel"><h4>Proposed resolution</h4>${prose(finding.resolution.proposal)}</section><section class="validation-panel validation-${finding.resolution.verdict}"><h4>${heading}</h4>${validation(finding.resolution)}</section></div>`;
  } else {
    body = `<div class="finding-columns three"><section><h4>Gap</h4>${prose(finding.problem)}</section><section><h4>Why it matters</h4>${prose(finding.why_it_matters)}<small>Impacto: ${escapeHtml(finding.impact)}</small></section><section class="decision-panel"><h4>Needs decision</h4>${linkedQuestions(finding, model)}</section></div>`;
  }
  return `<article class="finding-card finding-${variant}" id="${finding.id}" tabindex="-1" data-finding data-status="${finding.disposition}" data-type="${finding.type}" data-severity="${finding.severity}" data-search="${escapeHtml(search)}">
    <header><div><code>${finding.id}</code><h3>${escapeHtml(finding.title)}</h3></div><div class="badges">${badge(finding.disposition)}${severityPresentation(finding)}${badge(finding.type)}</div></header>
    ${finding.reopened_reason === undefined ? "" : `<aside class="reopened"><strong>Reopened</strong>${prose(finding.reopened_reason)}</aside>`}
    ${body}
    <footer><span>Needs: ${finding.need_ids.map((id) => `<a href="#${id}">${id}</a>`).join(" · ")}</span><span>Relationships: ${finding.relationship_ids.length === 0 ? "—" : finding.relationship_ids.map((id) => `<a href="#${id}">${id}</a>`).join(" · ")}</span></footer>
    ${evidenceDetails(finding, model)}
  </article>`;
}

function needCard(need, model) {
  const sources = model.sources.filter((item) => need.source_ids.includes(item.id));
  const findings = model.findings.filter((item) => item.need_ids.includes(need.id));
  const relationships = model.relationships.filter((item) => item.need_ids.includes(need.id) && item.state === "ACTIVE");
  const openBlocking = findings.some((item) => item.disposition === "open" && item.severity === "BLOCKING");
  const status = openBlocking ? "BLOCKED" : findings.some((item) => item.disposition === "open") ? "ATTENTION" : "CLEAR";
  return `<article class="need-card" id="${need.id}"><header><div><code>${need.id}</code><h3>${escapeHtml(need.title)}</h3></div>${badge(status)}</header><div class="need-grid"><section><h4>Extracted need</h4>${prose(need.statement)}${need.actor === undefined ? "" : `<p><strong>Ator:</strong> ${escapeHtml(need.actor)}</p>`}</section><section><h4>Signals</h4><strong>Preconditions</strong>${list(need.preconditions, "Não informadas.")}<strong>Acceptance</strong>${list(need.acceptance_signals, "Não informado.")}<strong>Negative behavior</strong>${list(need.negative_signals, "Não informado.")}</section></div><div class="need-links"><span>Findings: ${findings.length === 0 ? "—" : findings.map((item) => `<a href="#${item.id}">${item.id}</a>`).join(" · ")}</span><span>Relationships: ${relationships.length === 0 ? "—" : relationships.map((item) => `<a href="#${item.id}">${item.id}</a>`).join(" · ")}</span></div><details><summary>Comparar com input original</summary>${sources.map((source) => `<section class="source-original"><div><code>${source.id}</code>${source.external_id === undefined ? "" : ` ${badge(source.external_id)}`}</div><strong>${escapeHtml(source.label)}</strong>${prose(source.original_text)}${source.path === undefined ? "" : `<small><code>${escapeHtml(source.path)}</code></small>`}</section>`).join("")}</details></article>`;
}

function relationshipCard(item) {
  const direction = item.type === "DEPENDENCY" ? `<p><code>${item.from_need_id}</code> → <code>${item.to_need_id}</code></p>` : "";
  return `<article class="relationship-card" id="${item.id}"><header><code>${item.id}</code>${badge(item.type)}</header><h3>${escapeHtml(item.title)}</h3>${direction}${prose(item.detail)}<footer>${item.need_ids.map((id) => `<a href="#${id}">${id}</a>`).join(" · ")}</footer></article>`;
}

function technicalSurface(model) {
  const groups = new Map();
  for (const evidence of model.evidence.filter((item) => item.state === "ACTIVE" && item.surface !== undefined)) {
    const group = groups.get(evidence.surface) ?? { evidence: [], needs: new Set(), findings: new Set() };
    group.evidence.push(evidence.id);
    evidence.need_ids.forEach((id) => group.needs.add(id));
    for (const finding of model.findings.filter((item) => item.evidence_ids.includes(evidence.id))) group.findings.add(finding.id);
    groups.set(evidence.surface, group);
  }
  if (groups.size === 0) return '<p class="empty surface-empty">Nenhuma technical surface foi sustentada pela evidência disponível.</p>';
  return `<div class="surface-grid">${[...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, group]) => `<article><span class="surface-icon" aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span><h3>${escapeHtml(name)}</h3><p><strong>Needs</strong> ${[...group.needs].map((id) => `<a href="#${id}">${id}</a>`).join(" · ") || "—"}</p><p><strong>Findings</strong> ${[...group.findings].map((id) => `<a href="#${id}">${id}</a>`).join(" · ") || "—"}</p><small>Evidence: ${group.evidence.join(" · ")}</small></article>`).join("")}</div>`;
}

function handoffPayload(model) {
  return escapeHtml(`${JSON.stringify(model.handoff.payload, null, 2)}\n`);
}

export function renderRefinement(model) {
  const counts = {
    open: model.findings.filter((item) => item.disposition === "open").length,
    resolved: model.findings.filter((item) => item.disposition === "resolved").length,
    bypassed: model.findings.filter((item) => item.disposition === "bypassed").length,
    blocking: model.findings.filter((item) => item.disposition === "open" && item.severity === "BLOCKING").length,
  };
  const activeSources = model.sources.filter((item) => item.state === "ACTIVE").length;
  const outcomeClass = model.handoff.outcome.toLowerCase().replaceAll("_", "-");
  const findingCards = model.findings.map((item) => findingCard(item, model)).join("\n");
  const compose = (fingerprint) => `<!doctype html>
<!-- stnl-requirements-refiner:v1 fingerprint:${fingerprint} -->
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(model.summary)}">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(model.title)} · Requirements Refinement</title>
  <style>${STYLES}</style>
</head>
<body>
  <a class="skip" href="#main">Ir para o conteúdo</a>
  <header class="masthead" id="top"><div class="brand"><span aria-hidden="true">S</span><div>Sentinel<small>Requirements Refinement</small></div></div><nav aria-label="Seções"><a href="#findings">Findings</a><a href="#requirements">Requirements / USs</a><a href="#relationships">Cross-US</a><a href="#technical">Technical Surface</a><a href="#handoff">Handoff</a></nav></header>
  <main id="main" tabindex="-1">
    <section class="hero"><div><p class="eyebrow">${escapeHtml(model.refinement_id)} · input ${escapeHtml(model.input_assessment.quality.toLowerCase())}</p><h1>${escapeHtml(model.title)}</h1>${prose(model.summary)}<p class="source-summary">${activeSources} requirement source${activeSources === 1 ? "" : "s"} · ${model.needs.filter((item) => item.state === "ACTIVE").length} extracted needs</p><p><code>refinement.json</code> é a autoridade; esta página é somente uma projection determinística.</p></div><aside class="handoff-hero handoff-${outcomeClass}"><span>Recommended handoff</span><strong>${escapeHtml(model.handoff.outcome.replaceAll("_", " "))}</strong>${prose(model.handoff.reason)}<a href="#handoff">Ver payload e próximo passo</a></aside></section>
    <section class="stats" aria-label="Resumo"><article><span>Requirements / USs</span><strong>${activeSources}</strong></article><article><span>Total findings</span><strong>${model.findings.length}</strong></article><article><span>Open</span><strong>${counts.open}</strong></article><article><span>Resolved</span><strong>${counts.resolved}</strong></article><article><span>Bypassed</span><strong>${counts.bypassed}</strong></article><article class="stat-blocking"><span>Blocking open</span><strong>${counts.blocking}</strong></article></section>
    <section class="section" id="findings"><div class="section-heading"><div><p class="eyebrow">Decision surface</p><h2>Findings</h2><p>Gap, resolução e validação em planos visuais distintos.</p></div></div><div class="toolbar" role="region" aria-label="Filtros de findings"><label class="search">Busca<input id="search" type="search" maxlength="500" placeholder="Finding, gap, resolution…" autocomplete="off"></label><fieldset><legend>Status</legend><label><input type="radio" name="status" value="" checked>All</label><label><input type="radio" name="status" value="open">Open</label><label><input type="radio" name="status" value="resolved">Resolved</label><label><input type="radio" name="status" value="bypassed">Bypassed</label></fieldset><label>Type<select id="type"><option value="">All</option><option value="REQUIREMENT_GAP">Requirement</option><option value="TECHNICAL_GAP">Technical</option><option value="CROSS_REQUIREMENT_GAP">Cross-requirement</option><option value="REPOSITORY_CONFLICT">Repository</option><option value="RISK">Risk</option></select></label><label>Severity<select id="severity"><option value="">All</option><option value="BLOCKING">Blocking</option><option value="ATTENTION">Attention</option><option value="INFO">Info</option></select></label><p id="result-count" aria-live="polite">${model.findings.length} findings visíveis</p></div><div class="finding-list">${findingCards}<p id="empty-results" class="empty empty-results" hidden>Nenhum finding corresponde aos filtros.</p></div></section>
    <section class="section" id="requirements"><div class="section-heading"><div><p class="eyebrow">Source → need</p><h2>Requirements / USs</h2><p>O input original permanece comparável à necessidade extraída.</p></div></div><div class="need-list">${model.needs.map((item) => needCard(item, model)).join("\n")}</div></section>
    <section class="section" id="relationships"><div class="section-heading"><div><p class="eyebrow">Cross-requirement</p><h2>Dependencies, conflicts & shared surfaces</h2><p>Relações referenciáveis entre needs, sem antecipar candidate SPECs.</p></div></div>${model.relationships.filter((item) => item.state === "ACTIVE").length === 0 ? '<p class="empty">Nenhuma relação cross-requirement material identificada.</p>' : `<div class="relationship-grid">${model.relationships.filter((item) => item.state === "ACTIVE").map(relationshipCard).join("")}</div>`}</section>
    <section class="section" id="technical"><div class="section-heading"><div><p class="eyebrow">Repository evidence</p><h2>Technical Surface</h2><p>Áreas sustentadas por observações e contexto técnico registrado.</p></div></div>${technicalSurface(model)}<details class="exploration"><summary>Bounded exploration record</summary><div class="exploration-grid"><section><h3>Status</h3>${badge(model.exploration.status)}${prose(model.exploration.stop_reason)}</section><section><h3>Anchors</h3>${list(model.exploration.anchors)}</section><section><h3>Searches</h3>${list(model.exploration.searches)}</section><section><h3>Files read</h3>${list(model.exploration.files_read)}</section><section><h3>Limitations</h3>${list(model.exploration.limitations, "Nenhuma limitação material registrada.")}</section></div></details></section>
    <section class="section handoff-section" id="handoff"><div class="handoff-banner handoff-${outcomeClass}"><div><p class="eyebrow">Final assessment</p><h2>${escapeHtml(model.handoff.outcome.replaceAll("_", " "))}</h2>${prose(model.handoff.reason)}</div><div class="next-operation"><span>Suggested next manual operation</span><strong>${escapeHtml(model.handoff.next_workflow)}</strong><code>${escapeHtml(model.handoff.suggested_next_operation)}</code></div></div><div class="handoff-grid"><section><h3>Current blockers</h3>${model.handoff.blocker_ids.length === 0 ? '<p class="empty">Nenhum finding BLOCKING open.</p>' : list(model.handoff.blocker_ids)}<h3>Carried forward</h3>${list(model.handoff.carried_finding_ids, "Nenhum finding precisa seguir.")}</section><section><h3>Downstream payload</h3><pre>${handoffPayload(model)}</pre><p class="authority-note"><strong>Manual handoff only.</strong> Este dashboard não cria SPEC, Roadmap, plano, task ou implementação.</p></section></div></section>
  </main>
  <footer class="page-footer"><p>Refinement offline · fingerprint <code>${fingerprint.slice(0, 12)}</code></p><a href="#top">Voltar ao topo</a><button type="button" id="print">Imprimir</button></footer>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
  const draft = compose("0".repeat(64));
  const fingerprint = createHash("sha256").update(draft, "utf8").digest("hex");
  return { html: compose(fingerprint), fingerprint, outcome: model.handoff.outcome, counts };
}

const STYLES = String.raw`
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
:root{--ink:#171923;--muted:#667085;--line:#e4e7ec;--paper:#fff;--canvas:#f4f6fb;--brand:#4945c4;--brand-dark:#3633a7;--brand-soft:#eeedff;--green:#157347;--green-soft:#e7f6ed;--amber:#9a5b08;--amber-soft:#fff4dc;--red:#b42318;--red-soft:#feeceb;--blue:#175cd3;--blue-soft:#eaf2ff;--violet:#6941c6;--violet-soft:#f2ecff;--shadow:0 12px 34px rgba(22,31,56,.08);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--canvas)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{min-width:320px;margin:0;background:radial-gradient(circle at 8% 0,#e8e7ff 0,transparent 30rem),var(--canvas);font-size:16px;line-height:1.48}button,input,select{font:inherit}a{color:var(--brand-dark)}button,input,select,summary,a{outline-offset:3px}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #8d8aef}.skip{position:fixed;z-index:100;top:8px;left:-999px;padding:8px 12px;background:#fff}.skip:focus{left:8px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:24px;width:min(calc(100% - 40px),1240px);margin:0 auto;padding:24px 0}.brand{display:flex;align-items:center;gap:10px;font-weight:850}.brand>span{display:grid;width:42px;height:42px;place-items:center;border-radius:13px;background:var(--brand);box-shadow:0 8px 18px rgba(73,69,196,.3);color:#fff}.brand small{display:block;color:var(--muted);font-size:.65rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.masthead nav{display:flex;flex-wrap:wrap;gap:8px}.masthead nav a{padding:7px 9px;border-radius:8px;color:var(--muted);font-size:.78rem;font-weight:700;text-decoration:none}.masthead nav a:hover{background:#fff;color:var(--brand-dark)}main,.page-footer{width:min(calc(100% - 40px),1240px);margin:0 auto}.hero{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr);gap:32px;padding:44px;border-radius:28px;background:linear-gradient(135deg,#24245e 0,#4541b8 62%,#625edf);box-shadow:0 24px 60px rgba(47,44,142,.23);color:#fff}.hero h1{max-width:760px;margin:4px 0 14px;font-size:clamp(2.2rem,5vw,4.3rem);line-height:.98;letter-spacing:-.055em}.hero p{max-width:750px;color:#e7e6ff}.eyebrow{margin:0 0 6px!important;color:var(--brand-dark);font-size:.72rem;font-weight:850;letter-spacing:.11em;text-transform:uppercase}.hero .eyebrow{color:#cbc9ff}.source-summary{margin-top:24px!important;font-weight:750}.handoff-hero{align-self:stretch;padding:24px;border:1px solid rgba(255,255,255,.28);border-radius:21px;background:rgba(19,19,65,.42)}.handoff-hero>span,.next-operation>span{display:block;font-size:.68rem;font-weight:850;letter-spacing:.1em;text-transform:uppercase}.handoff-hero>strong{display:block;margin:12px 0 8px;font-size:clamp(1.65rem,3vw,2.6rem);line-height:1}.handoff-hero p{font-size:.88rem}.handoff-hero a{display:inline-block;margin-top:14px;color:#fff;font-weight:750}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:18px 0 0}.stats article{padding:16px 18px;border:1px solid var(--line);border-radius:15px;background:rgba(255,255,255,.93);box-shadow:0 4px 16px rgba(22,31,56,.04)}.stats span{display:block;color:var(--muted);font-size:.68rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase}.stats strong{display:block;margin-top:6px;font-size:1.8rem}.stats .stat-blocking{border-color:#f5b7b2;background:var(--red-soft);color:var(--red)}.section{padding-top:64px;scroll-margin-top:10px}.section-heading{display:flex;justify-content:space-between;gap:20px;margin-bottom:17px}.section-heading h2{margin:0;font-size:2rem;letter-spacing:-.035em}.section-heading p:last-child{margin:6px 0 0;color:var(--muted)}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) auto minmax(170px,.35fr) minmax(150px,.3fr);gap:12px;margin-bottom:16px;padding:14px;border:1px solid var(--line);border-radius:17px;background:rgba(255,255,255,.9)}.toolbar label,.toolbar legend{color:var(--muted);font-size:.7rem;font-weight:800;text-transform:uppercase}.toolbar input[type=search],.toolbar select{display:block;width:100%;min-height:44px;margin-top:4px;padding:0 12px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:var(--ink)}.toolbar fieldset{display:flex;align-items:center;gap:8px;margin:0;padding:0 4px 2px;border:0}.toolbar fieldset legend{margin-bottom:5px}.toolbar fieldset label{display:flex;align-items:center;gap:3px;padding:8px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);font-size:.72rem;text-transform:none}.toolbar #result-count{grid-column:1/-1;margin:0;color:var(--muted);font-size:.78rem}.finding-list,.need-list{display:grid;gap:14px}.finding-card{overflow:hidden;border:1px solid var(--line);border-left:6px solid var(--amber);border-radius:18px;background:var(--paper);box-shadow:var(--shadow);scroll-margin-top:16px}.finding-card[hidden]{display:none}.finding-card>header,.need-card>header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:20px 22px;border-bottom:1px solid var(--line)}.finding-card header>div:first-child,.need-card header>div:first-child{min-width:0}.finding-card h3,.need-card h3{margin:3px 0 0;font-size:1.18rem;line-height:1.2}.badges{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:5px}.badge,.severity-history{display:inline-flex;width:max-content;padding:3px 7px;border-radius:999px;font-size:.61rem;letter-spacing:.035em}.badge{background:#f0f1f3;color:#475467;font-weight:850;text-transform:uppercase}.severity-history{gap:3px;border:1px solid var(--line);background:#f8fafc;color:var(--muted)}.severity-history strong{color:#475467}.badge-open,.badge-attention,.badge-inconclusive,.badge-unknown{background:var(--amber-soft);color:var(--amber)}.badge-resolved,.badge-pass,.badge-clear,.badge-confirmed{background:var(--green-soft);color:var(--green)}.badge-bypassed,.badge-not-applicable,.badge-supported{background:var(--violet-soft);color:var(--violet)}.badge-blocking,.badge-fail,.badge-rejected,.badge-blocked{background:var(--red-soft);color:var(--red)}.badge-info,.badge-tentative{background:var(--blue-soft);color:var(--blue)}.finding-open[data-severity="BLOCKING"]{border-left-color:var(--red)}.finding-resolved{border-left-color:var(--green)}.finding-bypassed{border-left-color:var(--violet)}.finding-rejected{border-left-color:var(--red)}.finding-inconclusive{border-left-color:var(--amber)}.finding-columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.finding-columns>section{min-width:0;padding:21px 22px;border-right:1px solid var(--line)}.finding-columns>section:last-child{border-right:0}.finding-columns h4{margin:0 0 12px;color:var(--muted);font-size:.7rem;letter-spacing:.09em;text-transform:uppercase}.finding-columns p{margin:0 0 8px;overflow-wrap:anywhere}.finding-columns small{color:var(--muted)}.resolution-panel{background:linear-gradient(145deg,#f5fff8,#fff)}.validation-panel{background:#f8fafc}.bypass-panel{background:var(--violet-soft)}.risk-panel{background:#fffaf1}.proposal-panel{background:#fff7f6}.validation-rejected{background:var(--red-soft)}.validation-inconclusive{background:var(--amber-soft)}.validation-summary{display:grid;gap:6px}.validation-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:5px;border-bottom:1px solid rgba(102,112,133,.15);font-size:.75rem}.remaining-gap{margin-top:10px;padding:10px;border-radius:9px;background:rgba(255,255,255,.68);color:var(--red);font-size:.8rem}.remaining-gap p{margin:3px 0}.finding-card>footer,.need-links{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;padding:11px 22px;border-top:1px solid var(--line);color:var(--muted);font-size:.72rem}.finding-card details,.need-card details{padding:12px 22px;border-top:1px solid var(--line)}summary{cursor:pointer;color:var(--brand-dark);font-weight:780}.evidence-details summary span{float:right}.evidence-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}.evidence-list article{padding:12px;border:1px solid var(--line);border-radius:11px;background:#fafbfc}.evidence-list strong{display:block;margin-top:6px}.evidence-list p{margin:4px 0;font-size:.8rem}.evidence-list small{color:var(--muted)}.question-list{display:grid;gap:7px;margin:0;padding:0;list-style:none}.question-list li{display:grid;grid-template-columns:auto 1fr auto;gap:7px;align-items:start;padding:8px;border:1px solid var(--line);border-radius:9px;background:#fff;font-size:.8rem}.reopened{padding:10px 22px;background:var(--amber-soft);color:var(--amber)}.reopened p{display:inline;margin-left:8px}.empty{color:var(--muted);font-style:italic}.empty-results{padding:44px;border:1px dashed #98a2b3;border-radius:16px;text-align:center}.need-card{overflow:hidden;border:1px solid var(--line);border-radius:18px;background:var(--paper);box-shadow:0 6px 22px rgba(22,31,56,.05);scroll-margin-top:16px}.need-grid{display:grid;grid-template-columns:1.15fr .85fr}.need-grid>section{padding:20px 22px;border-right:1px solid var(--line)}.need-grid>section:last-child{border-right:0}.need-grid h4,.source-original strong{display:block;margin:0 0 10px}.need-grid p{overflow-wrap:anywhere}.need-grid ul{margin:4px 0 12px;padding-left:19px;font-size:.85rem}.source-original{margin-top:12px;padding:15px;border:1px solid var(--line);border-radius:11px;background:#fafafa}.source-original p{white-space:normal;overflow-wrap:anywhere}.relationship-grid,.surface-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.relationship-card,.surface-grid article{padding:18px;border:1px solid var(--line);border-radius:16px;background:#fff;box-shadow:0 6px 22px rgba(22,31,56,.05)}.relationship-card header{display:flex;justify-content:space-between}.relationship-card h3,.surface-grid h3{margin:11px 0 6px}.relationship-card footer{padding-top:10px;border-top:1px solid var(--line);font-size:.76rem}.surface-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:11px;background:var(--blue-soft);color:var(--blue);font-weight:850}.surface-grid p{margin:7px 0;color:var(--muted);font-size:.8rem}.surface-grid small{color:var(--muted)}.exploration{margin-top:14px;padding:16px 18px;border:1px solid var(--line);border-radius:15px;background:#fff}.exploration-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:15px}.exploration-grid section{padding:12px;border:1px solid var(--line);border-radius:11px}.exploration-grid h3{margin:0 0 7px;font-size:.78rem}.exploration-grid p,.exploration-grid li{font-size:.78rem}.exploration-grid ul{margin:5px 0;padding-left:18px}.handoff-section{padding-bottom:32px}.handoff-banner{display:grid;grid-template-columns:1fr minmax(250px,.45fr);gap:24px;padding:30px;border-radius:22px;background:#252460;color:#fff}.handoff-banner .eyebrow{color:#c9c7ff}.handoff-banner h2{margin:4px 0 8px;font-size:2.8rem;letter-spacing:-.04em}.handoff-banner p{color:#e5e4ff}.next-operation{align-self:stretch;padding:18px;border:1px solid rgba(255,255,255,.25);border-radius:15px}.next-operation strong,.next-operation code{display:block;margin-top:9px;overflow-wrap:anywhere}.handoff-ready-for-spec{background:linear-gradient(135deg,#12633f,#23875c)!important}.handoff-ready-for-roadmap{background:linear-gradient(135deg,#3432a4,#5a56d5)!important}.handoff-blocked{background:linear-gradient(135deg,#8d2f28,#c2473d)!important}.handoff-grid{display:grid;grid-template-columns:.35fr .65fr;gap:12px;margin-top:12px}.handoff-grid>section{min-width:0;padding:20px;border:1px solid var(--line);border-radius:16px;background:#fff}.handoff-grid h3{margin:0 0 8px}.handoff-grid h3:not(:first-child){margin-top:20px}.handoff-grid pre{overflow:auto;max-height:520px;padding:16px;border-radius:12px;background:#171728;color:#f3f2ff;font:400 .75rem/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.authority-note{padding:12px;border-radius:10px;background:var(--brand-soft);font-size:.82rem}.page-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 0 50px;color:var(--muted);font-size:.76rem}.page-footer button{min-height:40px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:#fff;cursor:pointer}
@media(max-width:980px){.hero{grid-template-columns:1fr}.stats{grid-template-columns:repeat(3,minmax(0,1fr))}.toolbar{grid-template-columns:1fr 1fr}.toolbar fieldset{grid-column:1/-1}.finding-columns{grid-template-columns:1fr}.finding-columns>section{border-right:0;border-bottom:1px solid var(--line)}.finding-columns>section:last-child{border-bottom:0}.relationship-grid,.surface-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.handoff-grid{grid-template-columns:1fr}}
@media(max-width:680px){.masthead{align-items:flex-start}.masthead nav{display:none}main,.page-footer,.masthead{width:min(calc(100% - 20px),1240px)}.hero{padding:27px 22px;border-radius:20px}.hero h1{font-size:2.4rem}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.toolbar{grid-template-columns:1fr}.toolbar fieldset{grid-column:auto;align-items:flex-start;flex-wrap:wrap}.finding-card>header,.need-card>header{flex-direction:column}.badges{justify-content:flex-start}.need-grid{grid-template-columns:1fr}.need-grid>section{border-right:0;border-bottom:1px solid var(--line)}.relationship-grid,.surface-grid,.exploration-grid,.evidence-list{grid-template-columns:1fr}.handoff-banner{grid-template-columns:1fr;padding:23px}.handoff-banner h2{font-size:2rem}.page-footer{align-items:flex-start;flex-direction:column}}
@media print{@page{margin:10mm}*{print-color-adjust:economy!important;-webkit-print-color-adjust:economy!important}body{background:#fff;font-size:9pt}.masthead{padding:0 0 4mm}.masthead nav,.toolbar,.page-footer button{display:none!important}main,.page-footer,.masthead{width:100%;max-width:none}.hero{grid-template-columns:1.4fr .6fr;padding:6mm;border:1px solid #777;background:#fff!important;box-shadow:none;color:#111}.hero p,.hero .eyebrow{color:#333}.handoff-hero{border-color:#777;background:#fff;color:#111}.handoff-hero a{display:none}.stats{gap:2mm;margin-top:3mm}.stats article{padding:3mm;box-shadow:none}.section{padding-top:6mm}.section-heading{margin-bottom:3mm}.finding-card[hidden]{display:block}.finding-card,.need-card,.relationship-card,.surface-grid article{break-inside:avoid;box-shadow:none}.finding-card{border-color:#777}.finding-columns{grid-template-columns:repeat(3,minmax(0,1fr))}.finding-columns>section{padding:3mm}.finding-card details>summary,.need-card details>summary,.exploration>summary{list-style:none}.finding-card details>:not(summary),.need-card details>:not(summary),.exploration>:not(summary){display:block!important}.evidence-list{grid-template-columns:1fr 1fr}.need-grid{grid-template-columns:1.15fr .85fr}.relationship-grid,.surface-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.handoff-banner{grid-template-columns:1fr .55fr;padding:5mm;border:1px solid #777;background:#fff!important;color:#111}.handoff-banner p,.handoff-banner .eyebrow{color:#333}.handoff-grid{grid-template-columns:.35fr .65fr}.handoff-grid pre{max-height:none;background:#fff;color:#111;border:1px solid #777}.page-footer{padding:5mm 0 0}}
`;

const CLIENT_SCRIPT = String.raw`
(()=>{
  "use strict";
  document.documentElement.classList.add("js");
  const cards=[...document.querySelectorAll("[data-finding]")];
  const search=document.getElementById("search");
  const type=document.getElementById("type");
  const severity=document.getElementById("severity");
  const count=document.getElementById("result-count");
  const empty=document.getElementById("empty-results");
  function status(){return document.querySelector('input[name="status"]:checked')?.value??""}
  function apply(){
    const query=search.value.trim().toLocaleLowerCase("pt-BR");
    let visible=0;
    for(const card of cards){
      const match=(!query||card.dataset.search.includes(query))&&(!status()||card.dataset.status===status())&&(!type.value||card.dataset.type===type.value)&&(!severity.value||card.dataset.severity===severity.value);
      card.hidden=!match;
      if(match)visible++;
    }
    count.textContent=visible+" de "+cards.length+" findings visíveis";
    empty.hidden=visible!==0;
  }
  for(const control of[search,type,severity,...document.querySelectorAll('input[name="status"]')])control.addEventListener("input",apply);
  document.getElementById("print").addEventListener("click",()=>window.print());
  let opened=[];
  addEventListener("beforeprint",()=>{opened=[...document.querySelectorAll("details:not([open])")];for(const item of opened)item.open=true});
  addEventListener("afterprint",()=>{for(const item of opened)item.open=false;opened=[]});
  apply();
})();
`;
