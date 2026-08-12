import { createHash } from "node:crypto";

import { canonicalJson } from "./core.mjs";

const STATUS_LABELS = {
  not_run: "Not run",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  skipped: "Skipped",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function label(value) {
  const acronyms = new Map([
    ["Api", "API"], ["Http", "HTTP"], ["Id", "ID"], ["Ids", "IDs"],
    ["Qa", "QA"], ["Sql", "SQL"], ["Ui", "UI"], ["Utc", "UTC"],
  ]);
  return String(value)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase())
    .replace(/\b(?:Api|Http|Ids?|Qa|Sql|Ui|Utc)\b/gu, (term) => acronyms.get(term));
}

function list(values, empty = "Not determined") {
  if (values.length === 0) return `<p class="empty-state">${escapeHtml(empty)}</p>`;
  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function detailCards(items, empty) {
  if (items.length === 0) return `<p class="empty-state">${escapeHtml(empty)}</p>`;
  return `<div class="mini-grid">${items.map((item) => `<article class="mini-card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p>${item.kind === undefined ? "" : `<span class="tag">${escapeHtml(label(item.kind))}</span>`}</article>`).join("")}</div>`;
}

function scenarioSection(title, values, className = "presentation-secondary") {
  if (values.length === 0) return "";
  return `<section class="scenario-subsection ${className}"><h4>${escapeHtml(title)}</h4>${list(values)}</section>`;
}

function originList(origins) {
  return origins.map((origin) => `<li><span class="origin-kind">${escapeHtml(label(origin.kind))}</span><code>${escapeHtml(origin.ref)}</code>${origin.label === undefined ? "" : `<span>${escapeHtml(origin.label)}</span>`}</li>`).join("");
}

function inputTable(inputs) {
  if (inputs.length === 0) return "";
  return `<section class="scenario-subsection presentation-secondary"><h4>Inputs</h4><div class="table-scroll"><table><thead><tr><th>Name</th><th>Value or instruction</th></tr></thead><tbody>${inputs.map((input) => `<tr><th scope="row"><code>${escapeHtml(input.name)}</code></th><td>${input.sensitive ? "Provide securely at execution time; no value is embedded." : escapeHtml(input.value)}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function steps(scenario) {
  return `<section class="scenario-subsection"><h4>Execution steps</h4><ol class="steps">${scenario.steps.map((step, index) => `<li><div class="step-index" aria-hidden="true">${index + 1}</div><div class="step-body"><p class="step-label">Action</p><p>${escapeHtml(step.action)}</p><p class="step-label expected-label">Expected result</p><p>${escapeHtml(step.expected)}</p>${step.evidence.length === 0 ? "" : `<p class="step-label">Evidence</p><ul class="inline-list">${step.evidence.map((entry) => `<li>${escapeHtml(label(entry))}</li>`).join("")}</ul>`}</div></li>`).join("")}</ol></section>`;
}

function scenarioCard(scenario, typeKeys) {
  const statusOptions = Object.entries(STATUS_LABELS).map(([value, text]) => `<option value="${value}"${value === scenario.initial_status ? " selected" : ""}>${text}</option>`).join("");
  return `<article class="scenario" id="${scenario.id}" data-scenario-id="${scenario.id}" data-status="${scenario.initial_status}" data-initial-status="${scenario.initial_status}" data-criticality="${scenario.criticality}" data-type-keys="${typeKeys.join(" ")}">
  <header class="scenario-header">
    <div><div class="eyebrow"><code>${scenario.id}</code><span>${escapeHtml(scenario.domain)}</span></div><h3>${escapeHtml(scenario.title)}</h3><p>${escapeHtml(scenario.objective)}</p></div>
    <div class="scenario-badges"><span class="status-badge status-${scenario.initial_status}" data-status-badge>${STATUS_LABELS[scenario.initial_status]}</span><span class="criticality criticality-${scenario.criticality}">${escapeHtml(label(scenario.criticality))} criticality</span></div>
  </header>
  <div class="scenario-toolbar operational-only">
    <label>Status <select data-scenario-status aria-label="Status for ${scenario.id}">${statusOptions}</select></label>
    <button type="button" class="quiet-button" data-collapse aria-expanded="true" aria-controls="${scenario.id}-body">Collapse details</button>
  </div>
  <p class="status-print">Execution status: <strong data-status-print>${STATUS_LABELS[scenario.initial_status]}</strong></p>
  <div class="scenario-body" id="${scenario.id}-body">
    <section class="scenario-subsection"><h4>Why this test exists</h4><ul class="origin-list">${originList(scenario.origins)}</ul></section>
    <div class="scenario-columns">
      <section class="scenario-subsection"><h4>Preconditions</h4>${list(scenario.preconditions)}</section>
      <section class="scenario-subsection"><h4>Environment</h4><p>${escapeHtml(scenario.environment ?? "Not determined")}</p></section>
    </div>
    ${scenarioSection("Preparation", scenario.preparation)}
    ${inputTable(scenario.inputs)}
    ${steps(scenario)}
    <section class="scenario-subsection"><h4>Evidence expected</h4><ul class="inline-list">${scenario.evidence.map((entry) => `<li>${escapeHtml(label(entry))}</li>`).join("")}</ul></section>
    <div class="scenario-columns">
      ${scenarioSection("Approval criteria", scenario.approval_criteria, "")}
      ${scenarioSection("Cleanup", scenario.cleanup)}
      ${scenarioSection("Related regressions", scenario.regressions)}
      ${scenarioSection("Risks", scenario.risks, "")}
      ${scenarioSection("Known issues", scenario.known_issues, "")}
      ${scenarioSection("Source notes", scenario.notes)}
    </div>
    <section class="execution-capture operational-only" aria-label="Local execution notes for ${scenario.id}">
      <div class="local-only-callout"><strong>Local convenience only.</strong> Notes and status below are browser-local and are not Sentinel validation evidence.</div>
      <label>Execution notes<textarea rows="4" data-notes placeholder="Observed result, blockers, or references"></textarea></label>
      <p class="print-value" data-notes-print></p>
      <label>Evidence references<textarea rows="3" data-evidence-notes placeholder="Screenshot filename, video link reference, request ID, log ID, or database record ID"></textarea></label>
      <p class="print-value" data-evidence-print></p>
    </section>
  </div>
</article>`;
}

function coverageTable(items) {
  if (items.length === 0) return `<p class="empty-state">No deterministic coverage denominator was available.</p>`;
  return `<div class="table-scroll"><table class="coverage-table"><thead><tr><th>Source</th><th>Coverage</th><th>Scenarios</th><th>Rationale</th></tr></thead><tbody>${items.map((item) => `<tr><th scope="row"><code>${escapeHtml(item.source_id)}</code><span>${escapeHtml(item.title)}</span></th><td><span class="coverage-status coverage-${item.status}">${escapeHtml(label(item.status))}</span></td><td>${item.scenario_ids.length === 0 ? "—" : item.scenario_ids.map((id) => `<a href="#${id}">${id}</a>`).join(", ")}</td><td>${escapeHtml(item.rationale)}</td></tr>`).join("")}</tbody></table></div>`;
}

function sourceList(sources) {
  return `<ul class="source-list">${sources.map((source) => `<li><code>${escapeHtml(source.path)}</code><span>${escapeHtml(label(source.role))}</span>${source.ids.length === 0 ? "" : `<small>${source.ids.map((id) => escapeHtml(id)).join(", ")}</small>`}</li>`).join("")}</ul>`;
}

function preparationCards(items) {
  if (items.length === 0) return `<p class="empty-state">No data preparation was determined.</p>`;
  return `<div class="mini-grid">${items.map((item) => `<article class="mini-card"><div class="card-topline"><span class="tag">${escapeHtml(label(item.method))}</span><span class="tag tag-${item.status}">${escapeHtml(label(item.status))}</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.instructions)}</p>${item.source === undefined ? "" : `<p><strong>Reuse:</strong> <code>${escapeHtml(item.source)}</code></p>`}</article>`).join("")}</div>`;
}

function helperTable(items) {
  if (items.length === 0) return "";
  return `<section id="helpers" class="content-section"><div class="section-heading"><div><span class="section-kicker">Optional support</span><h2>Helper artifacts</h2></div></div><div class="table-scroll"><table><thead><tr><th>Path</th><th>Purpose</th><th>Cleanup</th></tr></thead><tbody>${items.map((item) => `<tr><th scope="row"><code>${escapeHtml(item.path)}</code></th><td>${escapeHtml(item.purpose)}</td><td>${item.cleanup === undefined ? "Manual or not applicable" : `<code>${escapeHtml(item.cleanup)}</code>`}</td></tr>`).join("")}</tbody></table></div><p class="section-note">Helpers are subordinate to this HTML and exist only when explicitly requested, necessary, and validated.</p></section>`;
}

export function renderRunbook(manifest) {
  const coverageCounts = Object.fromEntries([...new Set([...COVERAGE_ORDER, ...manifest.coverage.map((item) => item.status)])].map((status) => [status, manifest.coverage.filter((item) => item.status === status).length]));
  const criticalCount = manifest.scenarios.filter((scenario) => scenario.criticality === "critical").length;
  const blockedCount = manifest.scenarios.filter((scenario) => scenario.initial_status === "blocked").length;
  const types = [...new Set(manifest.scenarios.flatMap((scenario) => scenario.types))].sort();
  const typeKey = new Map(types.map((type, index) => [type, `type-${index}`]));
  const scenarioHtml = manifest.scenarios.map((scenario) => scenarioCard(scenario, scenario.types.map((type) => typeKey.get(type)))).join("\n");
  const scopeSelection = Object.keys(manifest.scope.selection).length === 0 ? "Complete scope" : canonicalJson(manifest.scope.selection);
  const coverageSummary = COVERAGE_ORDER.map((status) => `<li><span class="coverage-dot coverage-${status}" aria-hidden="true"></span><span>${escapeHtml(label(status))}</span><strong>${coverageCounts[status] ?? 0}</strong></li>`).join("");
  const navigation = [
    ["overview", "Overview"], ["setup", "Setup"], ["data", "Test data"], ["coverage", "Coverage"],
    ["scenarios", "Scenarios"], ["risks", "Risks & gaps"], ["sources", "Sources"],
  ];
  if (manifest.helper_artifacts.length !== 0) navigation.splice(6, 0, ["helpers", "Helpers"]);

  const compose = (fingerprint) => `<!doctype html>
<!-- stnl-spec-test-runbook:v1 fingerprint:${fingerprint} -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(manifest.title)} · Test Runbook</title>
  <style>${STYLES}</style>
</head>
<body data-view="operational">
  <a class="skip-link" href="#main-content">Skip to runbook content</a>
  <header class="hero" id="top">
    <div class="hero-grid">
      <div><div class="product-mark"><span class="mark" aria-hidden="true">S</span><span>Sentinel test runbook</span></div><p class="hero-kicker">${escapeHtml(label(manifest.scope.kind))} validation</p><h1>${escapeHtml(manifest.title)}</h1><p class="hero-summary">${escapeHtml(manifest.summary)}</p></div>
      <dl class="hero-meta">
        <div><dt>Audience</dt><dd>${manifest.configuration.audience.map((entry) => escapeHtml(label(entry))).join(", ")}</dd></div>
        <div><dt>Environment</dt><dd>${escapeHtml(manifest.configuration.environment ?? "Not determined")}</dd></div>
        <div><dt>Depth</dt><dd>${escapeHtml(label(manifest.configuration.depth))}</dd></div>
        <div><dt>Selection</dt><dd><code>${escapeHtml(scopeSelection)}</code></dd></div>
      </dl>
    </div>
  </header>
  <div class="layout">
    <aside class="sidebar" aria-label="Runbook navigation and filters">
      <nav aria-label="Runbook sections"><p class="sidebar-label">Contents</p><ul>${navigation.map(([id, text]) => `<li><a href="#${escapeHtml(id)}">${escapeHtml(text)}</a></li>`).join("")}</ul></nav>
      <div class="filter-panel operational-only">
        <p class="sidebar-label">Find scenarios</p>
        <label for="scenario-search">Search</label><input id="scenario-search" type="search" placeholder="ID, title, origin, step…" autocomplete="off">
        <label for="status-filter">Status</label><select id="status-filter"><option value="">All statuses</option>${Object.entries(STATUS_LABELS).map(([value, text]) => `<option value="${value}">${text}</option>`).join("")}</select>
        <label for="type-filter">Test type</label><select id="type-filter"><option value="">All types</option>${types.map((type) => `<option value="${typeKey.get(type)}">${escapeHtml(label(type))}</option>`).join("")}</select>
        <label for="criticality-filter">Criticality</label><select id="criticality-filter"><option value="">All criticalities</option>${[...CRITICALITY_ORDER].map((entry) => `<option value="${entry}">${label(entry)}</option>`).join("")}</select>
        <p class="results" id="filter-results" aria-live="polite">${manifest.scenarios.length} scenarios visible</p>
        <div class="button-row"><button type="button" class="quiet-button" id="expand-all">Expand all</button><button type="button" class="quiet-button" id="collapse-all">Collapse all</button></div>
      </div>
      <div class="local-panel operational-only">
        <label class="check-label"><input id="persist-state" type="checkbox"> Remember status and notes on this device</label>
        <p>Off by default. Browser-local state is never repository evidence.</p>
        <button type="button" class="danger-button" id="reset-state">Reset local state</button>
      </div>
    </aside>
    <main id="main-content" tabindex="-1">
      <div class="view-switch" role="group" aria-label="Runbook view">
        <span>View</span><button type="button" class="view-button active" data-view-button="operational" aria-pressed="true">Operational</button>${manifest.configuration.presentation ? `<button type="button" class="view-button" data-view-button="presentation" aria-pressed="false">Presentation</button>` : ""}
      </div>
      <section id="overview" class="content-section overview-section">
        <div class="section-heading"><div><span class="section-kicker">At a glance</span><h2>Validation overview</h2></div><p class="overall-status">Overall local status: <strong id="overall-status">${blockedCount > 0 ? "Blocked" : "Not run"}</strong></p></div>
        <div class="metric-grid">
          <article class="metric"><span>Scenarios</span><strong>${manifest.scenarios.length}</strong><small>in explicit scope</small></article>
          <article class="metric"><span>Critical</span><strong>${criticalCount}</strong><small>highest attention</small></article>
          <article class="metric"><span>Blocked initially</span><strong>${blockedCount}</strong><small>generated baseline</small></article>
          <article class="metric"><span>Coverage records</span><strong>${manifest.coverage.length}</strong><small>deterministic classifications</small></article>
        </div>
        <div class="summary-grid"><article class="summary-card"><h3>Coverage profile</h3><ul class="coverage-summary">${coverageSummary}</ul></article><article class="summary-card"><h3>Requested test types</h3><ul class="inline-list">${manifest.configuration.test_types.map((entry) => `<li>${escapeHtml(label(entry))}</li>`).join("")}</ul><h3>Execution states</h3><ul class="status-counts">${Object.entries(STATUS_LABELS).map(([status, text]) => `<li><span>${text}</span><strong data-count-status="${status}">${manifest.scenarios.filter((scenario) => scenario.initial_status === status).length}</strong></li>`).join("")}</ul></article></div>
      </section>
      <section id="setup" class="content-section"><div class="section-heading"><div><span class="section-kicker">Before execution</span><h2>Environment and setup</h2></div></div>${detailCards(manifest.setup, "No setup instruction could be determined from current evidence.")}</section>
      <section id="data" class="content-section"><div class="section-heading"><div><span class="section-kicker">Preparation</span><h2>Test data</h2></div></div>${preparationCards(manifest.data_preparation)}</section>
      <section id="coverage" class="content-section"><div class="section-heading"><div><span class="section-kicker">Traceability</span><h2>Coverage matrix</h2></div><p>No inferred percentages</p></div>${coverageTable(manifest.coverage)}</section>
      <section id="scenarios" class="content-section scenarios-section"><div class="section-heading"><div><span class="section-kicker">Operational sequence</span><h2>Test scenarios</h2></div><p>Generated order is stable</p></div><div class="scenario-list">${scenarioHtml}</div></section>
      <section id="risks" class="content-section"><div class="section-heading"><div><span class="section-kicker">Decision surface</span><h2>Risks, known issues, and gaps</h2></div></div><div class="risk-grid"><div><h3>Risks</h3>${detailCards(manifest.risks, "No sourced risk was recorded.")}</div><div><h3>Known issues</h3>${detailCards(manifest.known_issues, "No sourced known issue was recorded.")}</div><div><h3>Information gaps</h3>${detailCards(manifest.gaps, "No material information gap was recorded.")}</div><div><h3>Global cleanup</h3>${detailCards(manifest.cleanup, "No global cleanup was determined.")}</div></div></section>
      ${helperTable(manifest.helper_artifacts)}
      <section id="sources" class="content-section"><div class="section-heading"><div><span class="section-kicker">Provenance</span><h2>Sources used</h2></div></div>${sourceList(manifest.sources)}<p class="section-note">Source paths are relative. The runbook is a human testing projection; Sentinel requirements, tasks, and validation artifacts remain authoritative.</p></section>
    </main>
  </div>
  <footer><p>Offline, self-contained runbook · Content fingerprint <code>${fingerprint.slice(0, 12)}</code></p><a href="#top">Back to top</a></footer>
  <script>${SCRIPT.replaceAll("__FINGERPRINT__", fingerprint)}</script>
</body>
</html>
`;
  const draft = compose("0".repeat(64));
  const fingerprint = createHash("sha256").update(draft, "utf8").digest("hex");
  const html = compose(fingerprint);
  return { html, fingerprint };
}

const COVERAGE_ORDER = ["covered", "partial", "no_scenario", "not_manually_testable", "out_of_scope", "blocked"];
const CRITICALITY_ORDER = ["critical", "high", "medium", "low"];

const STYLES = String.raw`
main{min-width:0}
body[data-view="presentation"] .operational-only{display:none}
:root{--ink:#152438;--muted:#526173;--paper:#fff;--canvas:#edf2f5;--line:#d5dde4;--navy:#132b42;--teal:#087f78;--teal-soft:#dff4f1;--amber:#9a5d00;--amber-soft:#fff0cc;--red:#a3303b;--red-soft:#fde7e9;--green:#187447;--green-soft:#e3f4ea;--blue:#315c9b;--blue-soft:#e9f0fb;--shadow:0 12px 32px rgba(19,43,66,.09);--radius:16px;--focus:#f0a400}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--canvas);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}a{color:var(--teal);text-underline-offset:3px}button,input,select,textarea{font:inherit}button,input,select,textarea,a{outline-offset:3px}:focus-visible{outline:3px solid var(--focus)}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;overflow-wrap:anywhere}.skip-link{position:fixed;z-index:100;top:8px;left:8px;transform:translateY(-160%);padding:10px 14px;border-radius:8px;background:#fff;color:#000}.skip-link:focus{transform:none}.hero{color:#fff;background:linear-gradient(125deg,#0f2940 0%,#143d52 62%,#0a6f6b 140%);padding:42px clamp(24px,5vw,76px) 48px}.hero-grid{max-width:1500px;margin:auto;display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,.75fr);gap:60px;align-items:end}.product-mark{display:flex;align-items:center;gap:10px;font-size:.82rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase;color:#b8ddd9}.mark{display:grid;place-items:center;width:29px;height:29px;border:1px solid #81bcb8;border-radius:8px}.hero-kicker,.section-kicker{margin:24px 0 5px;color:#86cdc7;text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;font-weight:800}.hero h1{max-width:900px;margin:0;font-size:clamp(2.05rem,4vw,4.5rem);line-height:1.03;letter-spacing:-.045em}.hero-summary{max-width:820px;margin:18px 0 0;color:#d8e6ed;font-size:1.05rem}.hero-meta{margin:0;display:grid;grid-template-columns:1fr 1fr;border:1px solid rgba(255,255,255,.18);border-radius:14px;overflow:hidden;background:rgba(255,255,255,.06)}.hero-meta div{padding:14px;border-right:1px solid rgba(255,255,255,.13);border-bottom:1px solid rgba(255,255,255,.13)}.hero-meta div:nth-child(2n){border-right:0}.hero-meta div:nth-last-child(-n+2){border-bottom:0}.hero-meta dt{color:#9bc5ce;font-size:.72rem;text-transform:uppercase;letter-spacing:.09em}.hero-meta dd{margin:4px 0 0;font-weight:650;overflow-wrap:anywhere}.layout{max-width:1600px;margin:auto;display:grid;grid-template-columns:260px minmax(0,1fr);gap:30px;padding:30px}.sidebar{position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px);overflow:auto;padding:20px;border:1px solid var(--line);border-radius:var(--radius);background:rgba(255,255,255,.92);box-shadow:var(--shadow)}.sidebar-label{margin:0 0 8px;color:var(--muted);font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.sidebar nav ul{list-style:none;margin:0;padding:0}.sidebar nav a{display:block;padding:7px 9px;border-radius:7px;color:var(--ink);text-decoration:none}.sidebar nav a:hover{background:var(--teal-soft)}.filter-panel,.local-panel{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}.filter-panel label,.local-panel label{display:block;margin:11px 0 5px;font-size:.8rem;font-weight:700}.filter-panel input,.filter-panel select,.scenario-toolbar select,textarea{width:100%;border:1px solid #b9c5cf;border-radius:8px;background:#fff;color:var(--ink);padding:8px}.results,.local-panel p{color:var(--muted);font-size:.76rem}.button-row{display:flex;gap:7px;flex-wrap:wrap}.quiet-button,.danger-button,.view-button{border:1px solid #b7c2cc;border-radius:8px;background:#fff;color:var(--ink);padding:7px 10px;cursor:pointer}.quiet-button:hover,.view-button:hover{border-color:var(--teal);background:var(--teal-soft)}.danger-button{border-color:#e1a4aa;color:var(--red)}.check-label{display:flex!important;gap:8px;align-items:flex-start}.check-label input{width:auto;margin-top:4px}.view-switch{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin-bottom:14px}.view-switch span{color:var(--muted);font-size:.78rem;font-weight:700}.view-button.active{border-color:var(--teal);background:var(--teal);color:#fff}.content-section{margin-bottom:24px;padding:clamp(20px,3vw,34px);border:1px solid var(--line);border-radius:var(--radius);background:var(--paper);box-shadow:var(--shadow)}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:22px}.section-heading h2{margin:2px 0 0;font-size:clamp(1.45rem,2.5vw,2.05rem);letter-spacing:-.025em}.section-heading p{margin:0;color:var(--muted);font-size:.84rem}.section-kicker{margin:0;color:var(--teal)}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:13px}.metric{padding:18px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(150deg,#fff,#f6f9fa)}.metric span,.metric small{display:block;color:var(--muted)}.metric strong{display:block;margin:2px 0;font-size:2.2rem;line-height:1}.metric small{font-size:.75rem}.summary-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:14px;margin-top:14px}.summary-card{padding:20px;border-radius:12px;background:#f5f8f9}.summary-card h3{margin:0 0 12px}.coverage-summary,.status-counts{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.coverage-summary li,.status-counts li{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:7px 9px;border-radius:8px;background:#fff}.status-counts li{grid-template-columns:1fr auto}.coverage-dot{width:10px;height:10px;border-radius:50%}.coverage-covered{background:var(--green-soft);color:var(--green)}.coverage-partial{background:var(--amber-soft);color:var(--amber)}.coverage-no_scenario,.coverage-blocked{background:var(--red-soft);color:var(--red)}.coverage-not_manually_testable{background:var(--blue-soft);color:var(--blue)}.coverage-out_of_scope{background:#edf0f3;color:#5f6874}.mini-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.mini-card{padding:16px;border:1px solid var(--line);border-radius:11px;background:#fbfcfc}.mini-card h3{margin:7px 0;font-size:1rem}.mini-card p{margin:5px 0;color:#34465a}.tag,.coverage-status,.criticality,.status-badge{display:inline-flex;align-items:center;width:max-content;border-radius:999px;padding:4px 8px;font-size:.7rem;font-weight:800;letter-spacing:.02em}.tag{background:#e9eff2;color:#405367}.tag-reused,.tag-not_needed{background:var(--green-soft);color:var(--green)}.tag-required{background:var(--blue-soft);color:var(--blue)}.tag-blocked{background:var(--red-soft);color:var(--red)}.card-topline{display:flex;gap:6px;flex-wrap:wrap}.table-scroll{max-width:100%;overflow-x:auto;border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:12px 13px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}thead th{background:#f0f4f6;color:#425367;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase}tbody tr:last-child>*{border-bottom:0}tbody th span{display:block;margin-top:3px;font-weight:500;color:var(--muted)}.coverage-table{min-width:750px}.coverage-status{white-space:nowrap}.scenario-list{display:grid;gap:18px}.scenario{scroll-margin-top:18px;border:1px solid #cbd5dd;border-radius:14px;overflow:hidden;background:#fff}.scenario[hidden]{display:none}.scenario-header{display:flex;justify-content:space-between;gap:20px;padding:22px;background:linear-gradient(120deg,#f6f9fa,#fff)}.scenario-header h3{margin:4px 0 8px;font-size:1.38rem}.scenario-header p{margin:0;color:#425367}.eyebrow{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.75rem;font-weight:750;text-transform:uppercase;letter-spacing:.06em}.eyebrow code{padding:3px 6px;border-radius:5px;background:var(--navy);color:#fff}.scenario-badges{display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap;justify-content:flex-end}.status-not_run{background:#e9edf1;color:#4b5967}.status-passed{background:var(--green-soft);color:var(--green)}.status-failed{background:var(--red-soft);color:var(--red)}.status-blocked{background:var(--amber-soft);color:var(--amber)}.status-skipped{background:var(--blue-soft);color:var(--blue)}.criticality-critical{background:#5e1730;color:#fff}.criticality-high{background:var(--red-soft);color:var(--red)}.criticality-medium{background:var(--amber-soft);color:var(--amber)}.criticality-low{background:var(--blue-soft);color:var(--blue)}.scenario-toolbar{display:flex;align-items:end;justify-content:space-between;gap:14px;padding:12px 22px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#f7f9fa}.scenario-toolbar label{font-size:.75rem;font-weight:750}.scenario-toolbar select{display:block;min-width:150px;margin-top:4px}.scenario-body{padding:4px 22px 22px}.scenario-subsection{margin-top:20px;min-width:0}.scenario-subsection h4{margin:0 0 8px;color:#394c60;font-size:.76rem;text-transform:uppercase;letter-spacing:.08em}.scenario-subsection p,.scenario-subsection ul{margin-top:0}.scenario-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.origin-list{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:7px}.origin-list li{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:#f7f9fa}.origin-kind{color:var(--muted);font-size:.66rem;font-weight:800;text-transform:uppercase}.steps{list-style:none;margin:0;padding:0;counter-reset:none;display:grid;gap:10px}.steps>li{display:grid;grid-template-columns:34px 1fr;gap:12px;padding:14px;border:1px solid var(--line);border-radius:10px}.step-index{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--navy);color:#fff;font-weight:800}.step-body p{margin:0 0 8px}.step-label{color:var(--muted);font-size:.68rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.expected-label{margin-top:13px!important;color:var(--teal)}.inline-list{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}.inline-list li{padding:4px 8px;border-radius:999px;background:#eaf1f3;font-size:.75rem}.execution-capture{margin-top:22px;padding:16px;border:1px dashed #9aacb8;border-radius:11px;background:#f8fafb}.execution-capture label{display:block;margin-top:12px;font-size:.8rem;font-weight:750}.execution-capture textarea{display:block;margin-top:5px;resize:vertical}.local-only-callout{padding:10px 12px;border-left:4px solid var(--teal);background:var(--teal-soft);font-size:.82rem}.status-print,.print-value{display:none}.risk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}.risk-grid>div>h3{font-size:1rem}.empty-state{margin:0;color:var(--muted);font-style:italic}.source-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}.source-list li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px}.source-list span,.source-list small{color:var(--muted)}.section-note{margin:16px 0 0;color:var(--muted);font-size:.8rem}body[data-view="presentation"] .presentation-secondary,body[data-view="presentation"] .execution-capture{display:none}body[data-view="presentation"] .scenarios-section .scenario:not([data-criticality="critical"]):not([data-status="blocked"]):not([data-status="failed"]){opacity:.82}footer{display:flex;justify-content:space-between;gap:20px;max-width:1600px;margin:0 auto;padding:5px 30px 35px;color:var(--muted);font-size:.78rem}footer p{margin:0}@media(max-width:1050px){.layout{grid-template-columns:1fr}.sidebar{position:static;max-height:none;display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}.filter-panel,.local-panel{margin:0;padding:0;border:0}.hero-grid{grid-template-columns:1fr}.metric-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:700px){.hero{padding:30px 19px}.hero-grid{gap:30px}.hero-meta{grid-template-columns:1fr}.hero-meta div,.hero-meta div:nth-child(2n){border-right:0;border-bottom:1px solid rgba(255,255,255,.13)}.hero-meta div:last-child{border-bottom:0}.layout{padding:14px}.sidebar{grid-template-columns:1fr}.content-section{border-radius:12px}.section-heading,.scenario-header{align-items:flex-start;flex-direction:column}.scenario-badges{justify-content:flex-start}.metric-grid,.summary-grid,.scenario-columns,.risk-grid{grid-template-columns:1fr}.coverage-summary{grid-template-columns:1fr}.source-list li{grid-template-columns:1fr}.view-switch{justify-content:flex-start;overflow-x:auto}.scenario-toolbar{align-items:stretch;flex-direction:column}.button-row>*{flex:1}.steps>li{grid-template-columns:1fr}.table-scroll{border-radius:6px}footer{padding:5px 18px 25px;flex-direction:column}}@media print{@page{margin:12mm}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}html{font-size:9.5pt}body{background:#fff;color:#000}.hero{padding:0 0 8mm;background:#fff;color:#000;border-bottom:2px solid #222}.hero-grid{display:block}.product-mark,.hero-kicker{color:#333}.hero h1{font-size:24pt}.hero-summary{color:#222}.hero-meta{margin-top:5mm;border:1px solid #777;background:#fff}.hero-meta div,.hero-meta div:nth-child(2n){border-color:#aaa}.hero-meta dt,.hero-meta dd{color:#111}.layout{display:block;max-width:none;padding:0}.sidebar,.view-switch,.scenario-toolbar,.operational-only,.skip-link,footer{display:none!important}main{width:100%}.content-section{margin:0;padding:7mm 0;border:0;border-bottom:1px solid #aaa;border-radius:0;box-shadow:none}.section-heading{margin-bottom:4mm}.section-kicker{color:#333}.metric-grid{grid-template-columns:repeat(4,1fr)}.metric,.mini-card,.summary-card{box-shadow:none;background:#fff;border:1px solid #aaa}.scenario{display:block!important;break-inside:auto;margin-bottom:7mm;border-color:#777}.scenario-header{break-after:avoid;background:#fff}.scenario-body{display:block!important}.presentation-secondary,.execution-capture,body[data-view="presentation"] .presentation-secondary,body[data-view="presentation"] .execution-capture{display:block!important}.execution-capture{border:1px solid #aaa;background:#fff}.local-only-callout,textarea{display:none!important}.status-print,.print-value{display:block}.print-value:empty{display:none}.steps>li,.mini-card,.scenario-subsection h4{break-inside:avoid}.table-scroll{overflow:visible;border-color:#888}table,.coverage-table{min-width:0;table-layout:auto}thead{display:table-header-group}tr{break-inside:avoid}th,td{padding:6px;overflow-wrap:anywhere}.scenario[hidden]{display:block!important}.risk-grid{grid-template-columns:1fr 1fr}a{color:#000;text-decoration:none}.content-section:last-child{border-bottom:0}}
@media print{.execution-capture:not(.has-content){display:none!important}}
:root{--focus:#005fcc}
`;

const SCRIPT = String.raw`
(()=>{"use strict";document.documentElement.classList.add("js");const fingerprint="__FINGERPRINT__";const storageKey="stnl-runbook:v1:"+fingerprint;const settingsKey=storageKey+":settings";const cards=[...document.querySelectorAll("[data-scenario-id]")];const search=document.getElementById("scenario-search");const statusFilter=document.getElementById("status-filter");const typeFilter=document.getElementById("type-filter");const criticalityFilter=document.getElementById("criticality-filter");const results=document.getElementById("filter-results");const persist=document.getElementById("persist-state");const statusLabels={not_run:"Not run",passed:"Passed",failed:"Failed",blocked:"Blocked",skipped:"Skipped"};let printCollapsed=[];function safeGet(key){try{return localStorage.getItem(key)}catch{return null}}function safeSet(key,value){try{localStorage.setItem(key,value)}catch{}}function safeRemove(key){try{localStorage.removeItem(key)}catch{}}function updateCard(card,status){card.dataset.status=status;const badge=card.querySelector("[data-status-badge]");badge.textContent=statusLabels[status];badge.className="status-badge status-"+status;card.querySelector("[data-status-print]").textContent=statusLabels[status]}function save(){if(!persist.checked)return;const state={version:1,fingerprint,scenarios:{}};for(const card of cards){state.scenarios[card.dataset.scenarioId]={status:card.querySelector("[data-scenario-status]").value,notes:card.querySelector("[data-notes]").value,evidence:card.querySelector("[data-evidence-notes]").value}}safeSet(storageKey,JSON.stringify(state))}function load(){const raw=safeGet(storageKey);if(!raw)return;try{const state=JSON.parse(raw);if(state.version!==1||state.fingerprint!==fingerprint||!state.scenarios)return;for(const card of cards){const value=state.scenarios[card.dataset.scenarioId];if(!value||!Object.hasOwn(statusLabels,value.status))continue;card.querySelector("[data-scenario-status]").value=value.status;card.querySelector("[data-notes]").value=typeof value.notes==="string"?value.notes:"";card.querySelector("[data-evidence-notes]").value=typeof value.evidence==="string"?value.evidence:"";updateCard(card,value.status);syncPrint(card)}}catch{safeRemove(storageKey)}}function syncPrint(card){const notes=card.querySelector("[data-notes]").value;const evidence=card.querySelector("[data-evidence-notes]").value;card.querySelector("[data-notes-print]").textContent=notes?"Execution notes: "+notes:"";card.querySelector("[data-evidence-print]").textContent=evidence?"Evidence references: "+evidence:"";card.querySelector(".execution-capture").classList.toggle("has-content",Boolean(notes||evidence))}function counts(){for(const status of Object.keys(statusLabels)){const count=cards.filter(card=>card.dataset.status===status).length;document.querySelectorAll('[data-count-status="'+status+'"]').forEach(node=>{node.textContent=String(count)})}const failed=cards.some(card=>card.dataset.status==="failed");const blocked=cards.some(card=>card.dataset.status==="blocked");const passed=cards.length>0&&cards.every(card=>card.dataset.status==="passed"||card.dataset.status==="skipped");document.getElementById("overall-status").textContent=failed?"Failed":blocked?"Blocked":passed?"Passed":"In progress / not run"}function applyFilters(){const query=search.value.trim().toLocaleLowerCase("en");let visible=0;for(const card of cards){const types=card.dataset.typeKeys.split(" ");const matches=(!query||card.textContent.toLocaleLowerCase("en").includes(query))&&(!statusFilter.value||card.dataset.status===statusFilter.value)&&(!typeFilter.value||types.includes(typeFilter.value))&&(!criticalityFilter.value||card.dataset.criticality===criticalityFilter.value);card.hidden=!matches;if(matches)visible++}results.textContent=visible+" of "+cards.length+" scenarios visible";counts()}function setCollapsed(card,collapsed){card.classList.toggle("is-collapsed",collapsed);const body=card.querySelector(".scenario-body");body.hidden=collapsed;const button=card.querySelector("[data-collapse]");button.setAttribute("aria-expanded",String(!collapsed));button.textContent=collapsed?"Expand details":"Collapse details"}for(const control of [search,statusFilter,typeFilter,criticalityFilter])control.addEventListener("input",applyFilters);for(const card of cards){const status=card.querySelector("[data-scenario-status]");status.addEventListener("change",()=>{updateCard(card,status.value);applyFilters();save()});card.querySelector("[data-collapse]").addEventListener("click",()=>setCollapsed(card,!card.querySelector(".scenario-body").hidden));for(const input of [card.querySelector("[data-notes]"),card.querySelector("[data-evidence-notes]")])input.addEventListener("input",()=>{syncPrint(card);save()})}document.getElementById("expand-all").addEventListener("click",()=>cards.forEach(card=>setCollapsed(card,false)));document.getElementById("collapse-all").addEventListener("click",()=>cards.forEach(card=>setCollapsed(card,true)));for(const button of document.querySelectorAll("[data-view-button]")){button.addEventListener("click",()=>{document.body.dataset.view=button.dataset.viewButton;if(button.dataset.viewButton==="presentation"){search.value="";statusFilter.value="";typeFilter.value="";criticalityFilter.value="";cards.forEach(card=>setCollapsed(card,false));applyFilters()}document.querySelectorAll("[data-view-button]").forEach(item=>{const active=item===button;item.classList.toggle("active",active);item.setAttribute("aria-pressed",String(active))})})}persist.checked=safeGet(settingsKey)==="enabled";if(persist.checked)load();persist.addEventListener("change",()=>{if(persist.checked){safeSet(settingsKey,"enabled");save()}else{safeRemove(settingsKey);safeRemove(storageKey)}});document.getElementById("reset-state").addEventListener("click",()=>{if(!window.confirm("Reset local status and notes for this runbook?"))return;safeRemove(settingsKey);safeRemove(storageKey);persist.checked=false;for(const card of cards){const status=card.querySelector("[data-scenario-status]");status.value=card.dataset.initialStatus;card.querySelector("[data-notes]").value="";card.querySelector("[data-evidence-notes]").value="";updateCard(card,status.value);syncPrint(card)}applyFilters()});window.addEventListener("beforeprint",()=>{printCollapsed=cards.filter(card=>card.querySelector(".scenario-body").hidden);cards.forEach(card=>setCollapsed(card,false))});window.addEventListener("afterprint",()=>printCollapsed.forEach(card=>setCollapsed(card,true)));applyFilters()})();
`;
