import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { validateRoadmap } from "../lib/model.mjs";
import { projectRoadmap } from "../lib/projection.mjs";
import { hasRoadmapOwnershipMarker } from "../lib/publish.mjs";
import { renderRoadmap } from "../lib/render.mjs";
import { project, representativeRaw } from "./helpers.mjs";

test("renderer is deterministic, self-contained, owned, and fingerprint-verifiable", async (t) => {
  const root = await project(t);
  const model = validateRoadmap(await representativeRaw());
  const projections = await projectRoadmap(model, root);
  const first = renderRoadmap(model, projections);
  const second = renderRoadmap(model, projections);
  assert.deepEqual(second, first);
  assert.equal(hasRoadmapOwnershipMarker(first.html), true);
  const draft = first.html.replaceAll(first.fingerprint, "0".repeat(64)).replaceAll(first.fingerprint.slice(0, 12), "0".repeat(12));
  assert.equal(createHash("sha256").update(draft, "utf8").digest("hex"), first.fingerprint);
  assert.match(first.html, /Content-Security-Policy[^>]+default-src 'none'/u);
  assert.doesNotMatch(first.html, /<link\b|<img\b|https?:\/\//iu);
});

test("untrusted project data is escaped and never enters executable JavaScript", async (t) => {
  const root = await project(t);
  const raw = await representativeRaw();
  raw.title = '</script><script id="owned">alert(1)</script>';
  raw.summary = '"quoted" <svg onload=alert(3)> unicode café 漢字 😀';
  raw.candidates[0].requirements_source += '\n<img src=x onerror="alert(2)">\n</textarea><script>alert(4)</script>';
  const model = validateRoadmap(raw);
  const rendered = renderRoadmap(model, await projectRoadmap(model, root)).html;
  assert.doesNotMatch(rendered, /<script id="owned">|<img src=x/iu);
  assert.match(rendered, /&lt;\/script&gt;&lt;script id=&quot;owned&quot;&gt;/u);
  assert.match(rendered, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;/u);
  assert.match(rendered, /&lt;\/textarea&gt;&lt;script&gt;alert\(4\)&lt;\/script&gt;/u);
  assert.match(rendered, /&quot;quoted&quot; &lt;svg onload=alert\(3\)&gt; unicode café 漢字 😀/u);
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/u.exec(rendered)?.[1] ?? "";
  assert.doesNotMatch(script, /owned|alert\([1-4]\)|Checkout Evolution|café|漢字/u);
});

test("HTML follows the approved compact UI hierarchy without changing projection semantics", async (t) => {
  const root = await project(t);
  const model = validateRoadmap(await representativeRaw());
  const html = renderRoadmap(model, await projectRoadmap(model, root)).html;
  for (const marker of [
    'class="topbar"', 'class="hero"', 'class="hero-current"', 'class="stats"',
    'class="notice notice-blocked"', 'class="toolbar"', 'class="spec-card candidate-card',
    'class="roadmap candidates"',
    'class="spec-number"', "Status local", "Definir como atual", "Cobre:", "Depende de:",
    "Ver cobertura principal", "Ver contexto para lifecycle INIT", "Ver estado Sentinel",
    "Documentary lifecycle", "Execution snapshot", "Dependency verdict", "UNSATISFIED",
    "Gaps e riscos previsíveis", "Coverage geral", "shared_context", "BLOCKING", "MODE=INIT",
    "stnl-spec-lifecycle-manager", "Source of truth boundary", "roadmap.json",
    "Concluídas localmente", "Progresso local", "Candidate", "Coverage, gaps e sources",
    "Exportar progresso", "Importar progresso", "Reset local",
  ]) assert.match(html, new RegExp(marker, "u"));
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/u);
  assert.doesNotMatch(html, /Georgia|listou\.|MVP Core|EP01/u);
});

test("client contract keeps bounded local state separate and supports offline exploration and print", async (t) => {
  const root = await project(t);
  const model = validateRoadmap(await representativeRaw());
  const html = renderRoadmap(model, await projectRoadmap(model, root)).html;
  for (const label of ["Pendente", "Em especificação", "Pronta para execução", "Em desenvolvimento", "Em validação", "Bloqueada", "Concluída"]) {
    assert.match(html, new RegExp(label, "u"));
  }
  for (const contract of [
    'storageKey="stnl-roadmap:v1:"+roadmapId', "roadmap_id:roadmapId", "Exportar progresso",
    "Importar progresso", "Reset local", "data-focus-link", "data-focus-button", "beforeprint",
    "afterprint", "@media print", "prefers-reduced-motion", 'maxlength="500"',
    'search.value.slice(0,500)', 'activeCards.filter(card=>card.dataset.localStatus==="completed")',
  ]) assert.match(html, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(html, /window\.print\(\)/u);
  assert.match(html, /file\.size>1000000/u);
  assert.match(html, /safeRemove\(\);\s*\}\);/u);
  assert.match(html, /\.import-button:focus-within/u);
  assert.match(html, /\.spec-card\[hidden\]\{display:none\}/u);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)\{html\{scroll-behavior:auto!important\}/u);
  assert.match(html, /--text-muted:#6e6e73/u);
  assert.match(html, /\.hero-current\{[^}]*background:rgba\(33,33,99,\.42\)/u);
  assert.match(html, /\.hero-current-label\{[^}]*color:#fff/u);
  assert.match(html, /class="handoff-print"/u);
  assert.match(html, /\.handoff-print\{display:block/u);
  assert.match(html, /Nenhuma candidate visível/u);
  assert.match(html, /const first=cards\.find\(card=>!card\.hidden\)/u);
  assert.match(html, /if\(card\.hidden\)\{\s*search\.value="";\s*statusFilter\.value="";\s*dispositionFilter\.value="";/u);
  assert.match(html, /card\.focus\(\{preventScroll:true\}\)/u);
  assert.match(html, /const card=byId\.get\(focus\)/u);
  assert.match(html, /if\(card\?\.hidden\)\{/u);
  assert.match(html, /Oculta pelos filtros/u);
  assert.match(html, /updateFocusPanel\(card,card\.hidden\)/u);
  assert.match(html, /document\.querySelectorAll\("\.candidate-card details"\)/u);
  assert.match(html, /aria-label="Status local de CAND-001 — Card Payment Foundation"/u);
  assert.match(html, /aria-label="Contexto de lifecycle de CAND-001"/u);
  assert.match(html, /connect-src 'none'; img-src 'none'/u);
  assert.match(html, /\.candidate-card \.spec-details\{break-inside:avoid\}/u);
  assert.match(html, /table\{min-width:0;table-layout:fixed\}/u);
  assert.match(html, /\.sentinel-grid\{grid-template-columns:1fr\}/u);
});
