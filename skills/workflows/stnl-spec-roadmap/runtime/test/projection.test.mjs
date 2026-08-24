import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateRoadmap } from "../lib/model.mjs";
import { projectExecutionDependency, projectRoadmap, snapshotAuthorityInputs } from "../lib/projection.mjs";
import { FIXTURES, project, representativeRaw } from "./helpers.mjs";

test("absent SPEC paths are not materialized and expose deterministic lifecycle handoffs", async (t) => {
  const root = await project(t);
  const model = validateRoadmap(await representativeRaw());
  const projection = await projectRoadmap(model, root);
  const first = projection.candidates.get("CAND-001");
  assert.equal(first.materialization, "not_materialized");
  assert.equal(first.dependency_verdict, "UNSATISFIED");
  assert.match(first.lifecycle_handoff, /^Use `stnl-spec-lifecycle-manager`\.\nMODE=INIT\nSPEC_PATH=docs\/SPEC\/card-payment/mu);
  assert.equal(projection.dependencyEdges.find((item) => item.candidate_id === "CAND-002").verdict, "UNSATISFIED");
});

test("an existing noncanonical path is invalid, never treated as an absent SPEC", async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, "docs/SPEC"), { recursive: true });
  await fs.writeFile(path.join(root, "docs/SPEC/card-payment"), "not a workspace\n", "utf8");
  const projection = await projectRoadmap(validateRoadmap(await representativeRaw()), root);
  const first = projection.candidates.get("CAND-001");
  assert.equal(first.materialization, "invalid");
  assert.equal(first.dependency_verdict, "UNKNOWN");
  assert.equal(first.lifecycle_handoff, null);
});

test("only a lifecycle-valid workspace is materialized and pending execution is unsatisfied", async (t) => {
  const root = await project(t);
  const target = path.join(root, "docs/SPEC/card-payment");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(path.join(FIXTURES, "materialized-pending"), target, { recursive: true });
  await fs.writeFile(path.join(target, ".DS_Store"), "noise", "utf8");
  const projection = await projectRoadmap(validateRoadmap(await representativeRaw()), root);
  const first = projection.candidates.get("CAND-001");
  assert.equal(first.materialization, "materialized");
  assert.equal(first.documentary_status, "ready");
  assert.notEqual(first.execution_state, null);
  assert.equal(first.dependency_verdict, "UNSATISFIED");
  assert.equal(first.lifecycle_handoff, null);
});

test("mechanical COMPLETE cannot satisfy a dependency without current EXECUTION_APPROVED semantics", () => {
  assert.deepEqual(projectExecutionDependency("COMPLETE"), {
    verdict: "UNKNOWN",
    detail: "Execution is mechanically COMPLETE, but only a current stnl-execution-closer EXECUTION_APPROVED verdict can satisfy dependencies.",
  });
  assert.equal(projectExecutionDependency("IN_PROGRESS").verdict, "UNSATISFIED");
});

test("bounded authority snapshots are deterministic and detect source or SPEC changes", async (t) => {
  const root = await project(t);
  const model = validateRoadmap(await representativeRaw());
  const before = await snapshotAuthorityInputs(model, root);
  assert.equal(await snapshotAuthorityInputs(model, root), before);
  await fs.appendFile(path.join(root, "docs/checkout-stories.md"), "changed\n", "utf8");
  assert.notEqual(await snapshotAuthorityInputs(model, root), before);
});
