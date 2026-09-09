import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { generateRefinement } from "../generate-refinement.mjs";
import { inspectRefinement } from "../inspect-refinement.mjs";
import { lstatOrNull, resolveRefinement } from "../lib/core.mjs";
import { publishRefinement } from "../lib/publish.mjs";
import { candidateFile, project, representativeRaw } from "./helpers.mjs";

async function generate(t, root, operation = "INIT", overrides = {}) {
  const candidate = await candidateFile(t, overrides.raw ?? await representativeRaw());
  return generateRefinement({
    operation, projectRoot: root, candidatePath: candidate,
    expectedFingerprint: overrides.expectedFingerprint ?? null,
    expectedAuthorityFingerprint: overrides.expectedAuthorityFingerprint ?? null,
    refinementPath: overrides.refinementPath,
  });
}

async function pair(root, refinementPath = "docs/refinement") {
  return {
    model: await fs.readFile(path.join(root, refinementPath, "refinement.json")),
    html: await fs.readFile(path.join(root, refinementPath, "index.html")),
  };
}

test("INIT publishes exactly one deterministic pair and idempotent RECONCILE preserves bytes", async (t) => {
  const root = await project(t);
  const result = await generate(t, root);
  assert.equal(result.status, "INITIALIZED");
  assert.equal(result.handoff, "BLOCKED");
  assert.deepEqual((await fs.readdir(path.join(root, "docs/refinement"))).sort(), ["index.html", "refinement.json"]);
  const before = await pair(root);
  const inspection = await inspectRefinement("RECONCILE", root);
  const reconciled = await generate(t, root, "RECONCILE", {
    expectedFingerprint: inspection.expected_fingerprint,
    expectedAuthorityFingerprint: inspection.authority_fingerprint,
  });
  assert.equal(reconciled.status, "RECONCILED");
  assert.deepEqual(await pair(root), before);
});

test("custom REFINEMENT_PATH remains repository-relative and collision-safe", async (t) => {
  const root = await project(t);
  const result = await generate(t, root, "INIT", { refinementPath: "planning/refinement" });
  assert.equal(result.refinement_path, "planning/refinement");
  assert.deepEqual((await fs.readdir(path.join(root, "planning/refinement"))).sort(), ["index.html", "refinement.json"]);
  const another = await project(t);
  await assert.rejects(() => generate(t, another, "INIT", { refinementPath: "../escape" }), /forbidden path segment/u);
});

test("unowned collisions and modified owned output preserve existing bytes", async (t) => {
  const collision = await project(t);
  await fs.mkdir(path.join(collision, "docs/refinement"));
  await fs.writeFile(path.join(collision, "docs/refinement/notes.txt"), "owner data\n", "utf8");
  await assert.rejects(() => generate(t, collision), /non-canonical entries/u);
  assert.equal(await fs.readFile(path.join(collision, "docs/refinement/notes.txt"), "utf8"), "owner data\n");

  const root = await project(t);
  await generate(t, root);
  const htmlPath = path.join(root, "docs/refinement/index.html");
  await fs.appendFile(htmlPath, "\nmodified\n", "utf8");
  const modified = await fs.readFile(htmlPath);
  await assert.rejects(() => inspectRefinement("RECONCILE", root), /was modified/u);
  assert.deepEqual(await fs.readFile(htmlPath), modified);
});

test("source or repository evidence changes after inspection block and preserve the pair", async (t) => {
  const root = await project(t);
  await generate(t, root);
  const before = await pair(root);
  const inspection = await inspectRefinement("RECONCILE", root);
  await fs.appendFile(path.join(root, "src/order.mjs"), "// concurrent change\n", "utf8");
  await assert.rejects(() => generate(t, root, "RECONCILE", {
    expectedFingerprint: inspection.expected_fingerprint,
    expectedAuthorityFingerprint: inspection.authority_fingerprint,
  }), /authority changed after RECONCILE inspection/u);
  assert.deepEqual(await pair(root), before);
});

test("stale refinement fingerprint blocks without replacing the prior pair", async (t) => {
  const root = await project(t);
  await generate(t, root);
  const before = await pair(root);
  const inspection = await inspectRefinement("RECONCILE", root);
  await assert.rejects(() => generate(t, root, "RECONCILE", {
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    expectedAuthorityFingerprint: inspection.authority_fingerprint,
  }), /changed after RECONCILE inspection/u);
  assert.deepEqual(await pair(root), before);
});

test("authority mutation at the locked publication boundary preserves the previous complete pair", async (t) => {
  const root = await project(t);
  await generate(t, root);
  const before = await pair(root);
  const inspection = await inspectRefinement("RECONCILE", root);
  const context = await resolveRefinement(root);
  await assert.rejects(() => publishRefinement({
    context, operation: "RECONCILE", modelBytes: before.model, html: before.html.toString("utf8"),
    expectedFingerprint: inspection.expected_fingerprint, expectedAuthoritySnapshot: "before", readAuthoritySnapshot: async () => "after",
  }), /authority changed before refinement publication/u);
  assert.deepEqual(await pair(root), before);
  assert.equal(await lstatOrNull(path.join(root, "docs/.refinement.stnl-refinement.journal.json")), null);
});
