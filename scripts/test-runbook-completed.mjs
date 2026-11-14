import assert from "node:assert/strict";
import test from "node:test";
import { inspectWorkspace } from "../skills/workflows/stnl-spec-test-runbook/runtime/lib/core.mjs";

test("explicit execution accepts an authenticated completed delivery without requiring retired files", async (t) => {
  const { completedNativeCase } = await import("./fixtures/current-completed-native.mjs");
  const fixture = await completedNativeCase(t, { drift: false });
  const execution = await inspectWorkspace(fixture.specPath, "EXECUTION", {});
  assert.ok(execution.mandatory_sources.some((source) => source.endsWith("/plans/slice-02.md")));
  assert.ok(!execution.mandatory_sources.some((source) => source.endsWith("/plans/slice-01.md")));
  await assert.rejects(inspectWorkspace(fixture.specPath, "SLICE", { slice: "1" }), /no retained readable plan/);
});

test("explicit execution keeps authenticated retained completed plans without confusing them with active order", async (t) => {
  const { completedNativeCase } = await import("./fixtures/current-completed-native.mjs");
  const { retireActive } = await import("./fixtures/current-reader-campaign.mjs");
  const { reseal, writeImage } = await import("./fixtures/current-quiet-reader.mjs");
  const fixture = await completedNativeCase(t, { drift: false, retire: false });
  const retained = new Map(["plans/slice-01.md", "tasks/slice-01.md"].map((name) => [name, fixture.view.files.get(name)]));
  await retireActive(fixture.view, ["slice-01"]);
  for (const [name, bytes] of retained) fixture.view.files.set(name, bytes);
  reseal(fixture.view);
  await writeImage(fixture.view);
  const execution = await inspectWorkspace(fixture.specPath, "EXECUTION", {});
  assert.ok(execution.mandatory_sources.some((source) => source.endsWith("/plans/slice-01.md")));
  const completed = await inspectWorkspace(fixture.specPath, "SLICE", { slice: "1" });
  assert.ok(completed.mandatory_sources.some((source) => source.endsWith("/tasks/slice-01.md")));
  const multi = await inspectWorkspace(fixture.specPath, "MULTI_SLICE", { slices: ["2", "1"] });
  assert.deepEqual(multi.scope.selection.slices, ["slice-01", "slice-02"]);
});

test("explicit execution supports an authenticated all-completed set with no active slice rows", async (t) => {
  const { completedNativeCase } = await import("./fixtures/current-completed-native.mjs");
  const { retireActive } = await import("./fixtures/current-reader-campaign.mjs");
  const fixture = await completedNativeCase(t, { drift: false, retire: false });
  await retireActive(fixture.view);
  const execution = await inspectWorkspace(fixture.specPath, "EXECUTION", {});
  assert.ok(execution.mandatory_sources.some((source) => source.endsWith("/plan.md")));
  assert.ok(!execution.mandatory_sources.some((source) => /\/(?:plans|tasks)\/slice-/.test(source)));
});
