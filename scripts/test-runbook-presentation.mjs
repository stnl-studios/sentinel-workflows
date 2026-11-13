import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { inspectWorkspace } from "../skills/workflows/stnl-spec-test-runbook/runtime/lib/core.mjs";
import { validateManifest } from "../skills/workflows/stnl-spec-test-runbook/runtime/lib/manifest.mjs";
import { renderRunbook } from "../skills/workflows/stnl-spec-test-runbook/runtime/lib/render.mjs";
import { copyFixture, readManifest } from "../skills/workflows/stnl-spec-test-runbook/runtime/test/helpers.mjs";

async function validated(t) {
  const root = await copyFixture(t);
  const raw = await readManifest(root);
  const inspection = await inspectWorkspace(root, raw.scope.kind, raw.scope.selection);
  return { manifest: validateManifest(raw, inspection) };
}

test("presentation filters keep counts and focus within the displayed subset", async (t) => {
  const { manifest } = await validated(t);
  const html = renderRunbook(manifest).html;
  const source = html.match(/function applyFilters\(\)\{[\s\S]*?\}function closeTools/u)[0].replace(/function closeTools$/u, "");
  const cards = [
    { dataset: { scenarioId: "TR-001", status: "not_run" }, textContent: "Normal high-priority scenario" },
    { dataset: { scenarioId: "TR-010", status: "blocked" }, textContent: "Blocked scenario" },
  ];
  const rows = cards.map((card, index) => ({
    dataset: { scenarioRow: card.dataset.scenarioId, status: card.dataset.status, typeKeys: "functional", criticality: "high" },
    textContent: card.textContent, hidden: false,
    classList: { contains: (name) => name === "presentation-relevant" && index === 1 },
  }));
  const context = {
    cards, rows, cardById: new Map(cards.map(card => [card.dataset.scenarioId, card])),
    rowById: new Map(rows.map(row => [row.dataset.scenarioRow, row])), focusedCard: cards[0],
    document: { body: { dataset: { view: "presentation" } }, querySelectorAll: () => [] },
    ui: { locale: "en-US", visible: "{visible}/{total}" }, search: { value: "" },
    statusFilter: { value: "" }, typeFilter: { value: "" }, criticalityFilter: { value: "" },
    results: { textContent: "" }, noScenarios: { hidden: true }, counts: () => {},
    focusCard: (card) => { context.focusedCard = card; },
  };
  vm.runInNewContext(source + ";applyFilters();", context);
  assert.equal(context.focusedCard, cards[1]);
  assert.equal(context.results.textContent, "1/2");
  assert.equal(rows[0].hidden, true);
  assert.equal(rows[1].hidden, false);
  let focusChanges = 0;
  context.focusCard = (card) => { context.focusedCard = card; focusChanges += 1; };
  vm.runInNewContext("applyFilters();", context);
  assert.equal(focusChanges, 0, "keep the explicitly focused scenario while it remains visible");
  context.search.value = "no matches";
  vm.runInNewContext("applyFilters();", context);
  assert.equal(context.focusedCard, null);
  assert.equal(context.noScenarios.hidden, false);
  assert.equal(context.results.textContent, "0/2");
  context.document.body.dataset.view = "operational";
  context.search.value = "";
  vm.runInNewContext("applyFilters();", context);
  assert.equal(context.focusedCard, cards[0]);
  assert.equal(context.results.textContent, "2/2");
});
