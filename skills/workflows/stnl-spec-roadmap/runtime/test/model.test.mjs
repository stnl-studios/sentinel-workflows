import assert from "node:assert/strict";
import test from "node:test";

import { validateReconcile, validateRoadmap } from "../lib/model.mjs";
import { clone, representativeRaw } from "./helpers.mjs";

test("representative roadmap normalizes stable IDs, coverage, overlap, and dependencies", async () => {
  const model = validateRoadmap(await representativeRaw());
  assert.deepEqual(model.candidates.map((item) => item.id), ["CAND-001", "CAND-002", "CAND-003"]);
  assert.equal(model.coverage.length, 4);
  assert.equal(model.coverage[3].overlap, "shared_context");
  assert.deepEqual(model.candidates[1].depends_on, ["CAND-001"]);
});

test("every need requires exactly one explicit coverage disposition", async () => {
  const missing = await representativeRaw();
  missing.coverage.pop();
  assert.throws(() => validateRoadmap(missing), /missing coverage.*US-004/u);

  const duplicate = await representativeRaw();
  duplicate.coverage.push({ ...clone(duplicate.coverage[0]), id: "COV-005" });
  assert.throws(() => validateRoadmap(duplicate), /duplicate coverage/u);
});

test("overlap, blocking, and reciprocal gap contracts are strict", async () => {
  const overlap = await representativeRaw();
  delete overlap.coverage[3].overlap;
  assert.throws(() => validateRoadmap(overlap), /overlap classification/u);

  const blocked = await representativeRaw();
  blocked.gaps[0].severity = "ATTENTION";
  assert.throws(() => validateRoadmap(blocked), /blocked status requires/u);

  const reciprocal = await representativeRaw();
  reciprocal.gaps[0].coverage_ids = [];
  assert.throws(() => validateRoadmap(reciprocal), /must reference each other/u);
});

test("dependency graph rejects missing, obsolete, self, and cyclic edges", async () => {
  const missing = await representativeRaw();
  missing.candidates[1].depends_on = ["CAND-999"];
  assert.throws(() => validateRoadmap(missing), /missing dependency/u);

  const obsolete = await representativeRaw();
  obsolete.candidates[0].disposition = "obsolete";
  obsolete.candidates[0].disposition_reason = "Superseded.";
  assert.throws(() => validateRoadmap(obsolete), /obsolete candidate/u);

  const self = await representativeRaw();
  self.candidates[0].depends_on = ["CAND-001"];
  assert.throws(() => validateRoadmap(self), /self dependency/u);

  const cycle = await representativeRaw();
  cycle.candidates[0].depends_on = ["CAND-002"];
  assert.throws(() => validateRoadmap(cycle), /dependency cycle/u);
});

test("paths, duplicate physical paths, IDs, and secret-like content fail closed", async () => {
  const traversal = await representativeRaw();
  traversal.candidates[0].spec_path = "../escape";
  assert.throws(() => validateRoadmap(traversal), /forbidden path segment/u);

  const duplicate = await representativeRaw();
  duplicate.candidates[1].spec_path = "DOCS/spec/CARD-PAYMENT";
  assert.throws(() => validateRoadmap(duplicate), /same physical SPEC path/u);

  const ids = await representativeRaw();
  ids.candidates[2].id = "CAND-004";
  ids.coverage[2].candidate_ids = ["CAND-004"];
  ids.gaps[0].candidate_ids = ["CAND-004"];
  assert.throws(() => validateRoadmap(ids), /contiguous, monotonic/u);

  const secret = await representativeRaw();
  secret.summary = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
  assert.throws(() => validateRoadmap(secret), /secret or credential/u);

  const metadata = await representativeRaw();
  metadata.sources[0].path = ".GiT/config";
  assert.throws(() => validateRoadmap(metadata), /repository metadata path/u);

  const sourceOutput = await representativeRaw();
  sourceOutput.sources[0].path = "DOCS/ROADMAP/roadmap.json";
  assert.throws(() => validateRoadmap(sourceOutput), /must not read from ROADMAP_PATH/u);

  const roadmapCollision = await representativeRaw();
  roadmapCollision.candidates[0].spec_path = "DOCS/ROADMAP/candidate";
  assert.throws(() => validateRoadmap(roadmapCollision), /collides with ROADMAP_PATH/u);
});

test("RECONCILE preserves tombstones and immutable candidate identity", async () => {
  const previous = validateRoadmap(await representativeRaw());

  const removedGap = await representativeRaw();
  removedGap.coverage[2].status = "covered";
  removedGap.coverage[2].gap_ids = [];
  removedGap.gaps = [];
  const validWithoutGap = validateRoadmap(removedGap);
  assert.throws(() => validateReconcile(previous, validWithoutGap), /gap identities cannot be removed/u);

  const changedPath = await representativeRaw();
  changedPath.candidates[0].spec_path = "docs/SPEC/card-payment-v2";
  const changedPathModel = validateRoadmap(changedPath);
  assert.throws(() => validateReconcile(previous, changedPathModel), /stable title and SPEC path are immutable/u);

  const changedSource = await representativeRaw();
  changedSource.sources[0].label = "Repurposed source identity";
  assert.throws(() => validateReconcile(previous, validateRoadmap(changedSource)), /stable source identity is immutable/u);

  const changedNeed = await representativeRaw();
  changedNeed.sources[0].needs[0].title = "Repurposed need identity";
  assert.throws(() => validateReconcile(previous, validateRoadmap(changedNeed)), /stable need identity is immutable/u);

  const changedCoverage = await representativeRaw();
  [changedCoverage.coverage[0].need_id, changedCoverage.coverage[1].need_id] = [
    changedCoverage.coverage[1].need_id, changedCoverage.coverage[0].need_id,
  ];
  assert.throws(() => validateReconcile(previous, validateRoadmap(changedCoverage)), /stable coverage identity is immutable/u);

  const changedGap = await representativeRaw();
  changedGap.gaps[0].title = "Repurposed gap identity";
  assert.throws(() => validateReconcile(previous, validateRoadmap(changedGap)), /stable gap identity is immutable/u);
});

test("RECONCILE cannot reopen terminal source, candidate, coverage, or gap tombstones", async () => {
  const retiredRaw = await representativeRaw();
  retiredRaw.sources[0].state = "retired";
  retiredRaw.sources[0].retired_reason = "The source was superseded.";
  for (const item of retiredRaw.coverage) {
    item.state = "retired";
    item.retired_reason = "The source was superseded.";
  }
  const retired = validateRoadmap(retiredRaw);
  const active = validateRoadmap(await representativeRaw());
  assert.throws(() => validateReconcile(retired, active), /terminal retired source tombstone/u);
  const alteredRetiredCoverage = clone(retiredRaw);
  alteredRetiredCoverage.coverage[0].rationale = "A rewritten tombstone rationale.";
  assert.throws(
    () => validateReconcile(retired, validateRoadmap(alteredRetiredCoverage)),
    /terminal retired coverage tombstone/u,
  );

  const obsoleteRaw = await representativeRaw();
  obsoleteRaw.candidates[2].disposition = "obsolete";
  obsoleteRaw.candidates[2].disposition_reason = "Superseded by the foundational candidate.";
  obsoleteRaw.coverage[2].candidate_ids = ["CAND-001"];
  const obsolete = validateRoadmap(obsoleteRaw);
  const reopenedCandidate = clone(obsoleteRaw);
  reopenedCandidate.candidates[2].disposition = "active";
  delete reopenedCandidate.candidates[2].disposition_reason;
  assert.throws(() => validateReconcile(obsolete, validateRoadmap(reopenedCandidate)), /terminal obsolete candidate tombstone/u);

  const resolvedRaw = await representativeRaw();
  resolvedRaw.gaps[0].state = "resolved";
  resolvedRaw.gaps[0].resolution = "Ownership was assigned.";
  resolvedRaw.coverage[2].status = "covered";
  const resolved = validateRoadmap(resolvedRaw);
  const reopenedGap = clone(resolvedRaw);
  reopenedGap.gaps[0].state = "open";
  delete reopenedGap.gaps[0].resolution;
  reopenedGap.coverage[2].status = "blocked";
  assert.throws(() => validateReconcile(resolved, validateRoadmap(reopenedGap)), /terminal resolved gap tombstone/u);
});

test("materialized candidate changes require an explicit lifecycle or replan handoff", async () => {
  const previous = validateRoadmap(await representativeRaw());
  const raw = await representativeRaw();
  raw.candidates[0].requirements_source += "\n- Capture provider reference.";
  const next = validateRoadmap(raw);
  const projections = new Map([["CAND-001", { materialization: "materialized" }]]);
  assert.throws(() => validateReconcile(previous, next, projections), /without materialized_impact/u);

  raw.candidates[0].materialized_impact = {
    summary: "The canonical SPEC must absorb the provider reference requirement.",
    handoff: "MODE=RESUME",
  };
  assert.equal(validateReconcile(previous, validateRoadmap(raw), projections).candidates[0].materialized_impact.handoff, "MODE=RESUME");
});
