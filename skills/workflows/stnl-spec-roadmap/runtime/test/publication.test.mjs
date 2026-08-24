import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { formattedJson, lstatOrNull, resolveRoadmap, sha256 } from "../lib/core.mjs";
import { generateRoadmap } from "../generate-roadmap.mjs";
import { hydrateSourceFingerprints, validateRoadmap } from "../lib/model.mjs";
import { projectRoadmap } from "../lib/projection.mjs";
import { inspectRoadmap } from "../inspect-roadmap.mjs";
import { publishRoadmap, recoverRoadmapPublication, verifyReleaseQuarantine } from "../lib/publish.mjs";
import { renderRoadmap } from "../lib/render.mjs";
import { candidateFile, clone, project, representativeRaw } from "./helpers.mjs";

async function generate(t, root, operation = "INIT", overrides = {}) {
  const raw = overrides.raw ?? await representativeRaw();
  const candidatePath = await candidateFile(t, raw);
  return generateRoadmap({
    operation,
    projectRoot: root,
    candidatePath,
    expectedFingerprint: overrides.expectedFingerprint ?? null,
    expectedAuthorityFingerprint: overrides.expectedAuthorityFingerprint ?? null,
    roadmapPath: overrides.roadmapPath,
  });
}

async function pair(root, roadmapPath = "docs/roadmap") {
  const roadmapRoot = path.join(root, ...roadmapPath.split("/"));
  return {
    model: await fs.readFile(path.join(roadmapRoot, "roadmap.json")),
    html: await fs.readFile(path.join(roadmapRoot, "index.html")),
  };
}

async function stagedNextPair(root, suffix) {
  const raw = clone(await representativeRaw());
  raw.summary = `Reconciled summary for recovery window ${suffix}.`;
  let next = validateRoadmap(raw);
  next = await hydrateSourceFingerprints(next, root);
  const rendered = renderRoadmap(next, await projectRoadmap(next, root));
  const parent = path.join(root, "docs");
  const stage = path.join(parent, `.roadmap.stnl-roadmap.stage-test-${suffix}`);
  const backup = path.join(parent, `.roadmap.stnl-roadmap.backup-test-${suffix}`);
  await fs.mkdir(stage);
  const model = Buffer.from(formattedJson(next), "utf8");
  const html = Buffer.from(rendered.html, "utf8");
  await fs.writeFile(path.join(stage, "roadmap.json"), model);
  await fs.writeFile(path.join(stage, "index.html"), html);
  return { stage, backup, model, html, digest: sha256(Buffer.concat([model, Buffer.from([0]), html])) };
}

async function writeRecoveryJournal(root, context, values) {
  const journal = path.join(root, "docs/.roadmap.stnl-roadmap.journal.json");
  await fs.writeFile(journal, `${JSON.stringify({
    version: 1,
    target: context.roadmapRoot,
    ...values,
  })}\n`, "utf8");
  return journal;
}

test("INIT publishes exactly the deterministic default pair and RECONCILE is byte-idempotent", async (t) => {
  const root = await project(t);
  const initialized = await generate(t, root);
  assert.equal(initialized.status, "INITIALIZED");
  assert.equal(initialized.roadmap_path, "docs/roadmap");
  assert.deepEqual((await fs.readdir(path.join(root, "docs/roadmap"))).sort(), ["index.html", "roadmap.json"]);
  const before = await pair(root);
  const inspection = await inspectRoadmap("RECONCILE", root);
  assert.match(inspection.expected_fingerprint, /^sha256:[0-9a-f]{64}$/u);
  const reconciled = await generate(t, root, "RECONCILE", {
    expectedFingerprint: inspection.expected_fingerprint,
    expectedAuthorityFingerprint: inspection.authority_fingerprint,
  });
  assert.equal(reconciled.status, "RECONCILED");
  assert.deepEqual(await pair(root), before);
});

test("custom ROADMAP_PATH is normalized and kept within the project", async (t) => {
  const root = await project(t);
  const result = await generate(t, root, "INIT", { roadmapPath: "planning/spec-roadmap" });
  assert.equal(result.roadmap_path, "planning/spec-roadmap");
  assert.deepEqual((await fs.readdir(path.join(root, "planning/spec-roadmap"))).sort(), ["index.html", "roadmap.json"]);
  await assert.rejects(() => generate(t, root, "INIT", { roadmapPath: "../escape" }), /forbidden path segment/u);
});

test("INIT collisions, stale fingerprints, and modified owned output preserve existing bytes", async (t) => {
  const collisionRoot = await project(t);
  await fs.mkdir(path.join(collisionRoot, "docs/roadmap"), { recursive: true });
  await fs.writeFile(path.join(collisionRoot, "docs/roadmap/notes.txt"), "owner data\n", "utf8");
  await assert.rejects(() => generate(t, collisionRoot), /non-canonical entries/u);
  assert.equal(await fs.readFile(path.join(collisionRoot, "docs/roadmap/notes.txt"), "utf8"), "owner data\n");

  const root = await project(t);
  await generate(t, root);
  const before = await pair(root);
  await assert.rejects(() => generate(t, root, "RECONCILE", {
    expectedFingerprint: `sha256:${"0".repeat(64)}`,
    expectedAuthorityFingerprint: `sha256:${"0".repeat(64)}`,
  }), /changed after RECONCILE inspection|authority changed after RECONCILE inspection/u);
  assert.deepEqual(await pair(root), before);

  const htmlPath = path.join(root, "docs/roadmap/index.html");
  await fs.appendFile(htmlPath, "\nmodified by owner\n", "utf8");
  const modified = await fs.readFile(htmlPath);
  await assert.rejects(() => inspectRoadmap("RECONCILE", root), /was modified/u);
  assert.deepEqual(await fs.readFile(htmlPath), modified);
});

test("HTML ownership verification rejects fingerprint-like user content and invalid UTF-8", async (t) => {
  const collisionRoot = await project(t);
  const collisionRaw = await representativeRaw();
  collisionRaw.title = "000000000000";
  await generate(t, collisionRoot, "INIT", { raw: collisionRaw });
  const collisionHtmlPath = path.join(collisionRoot, "docs/roadmap/index.html");
  const collisionHtml = await fs.readFile(collisionHtmlPath, "utf8");
  const fingerprint = /stnl-spec-roadmap:v1 fingerprint:([0-9a-f]{64})/u.exec(collisionHtml)?.[1];
  assert.match(fingerprint, /^[0-9a-f]{64}$/u);
  await fs.writeFile(
    collisionHtmlPath,
    collisionHtml.replace("<title>000000000000", `<title>${fingerprint.slice(0, 12)}`),
    "utf8",
  );
  await assert.rejects(() => inspectRoadmap("RECONCILE", collisionRoot), /was modified/u);

  const invalidRoot = await project(t);
  const invalidRaw = await representativeRaw();
  invalidRaw.title = "Replacement \uFFFD marker";
  await generate(t, invalidRoot, "INIT", { raw: invalidRaw });
  const invalidHtmlPath = path.join(invalidRoot, "docs/roadmap/index.html");
  const validBytes = await fs.readFile(invalidHtmlPath);
  const replacement = Buffer.from([0xef, 0xbf, 0xbd]);
  const index = validBytes.indexOf(replacement);
  assert.notEqual(index, -1);
  await fs.writeFile(invalidHtmlPath, Buffer.concat([validBytes.subarray(0, index), Buffer.from([0xff]), validBytes.subarray(index + replacement.length)]));
  await assert.rejects(() => inspectRoadmap("RECONCILE", invalidRoot), /valid UTF-8/u);
});

test("source changes are visible at inspection and refreshed by reconciliation", async (t) => {
  const root = await project(t);
  await generate(t, root);
  await fs.appendFile(path.join(root, "docs/checkout-stories.md"), "new fact\n", "utf8");
  const inspection = await inspectRoadmap("RECONCILE", root);
  assert.deepEqual(inspection.changed_sources, ["SRC-001"]);
  await generate(t, root, "RECONCILE", {
    expectedFingerprint: inspection.expected_fingerprint,
    expectedAuthorityFingerprint: inspection.authority_fingerprint,
  });
  assert.deepEqual((await inspectRoadmap("RECONCILE", root)).changed_sources, []);
});

test("candidate JSON, source, and controlled output reject duplicate keys, hard links, and symlinks", async (t) => {
  const duplicateRoot = await project(t);
  const duplicateCandidate = await candidateFile(t, await representativeRaw());
  const source = await fs.readFile(duplicateCandidate, "utf8");
  await fs.writeFile(duplicateCandidate, source.replace('{\n  "contract_version": 1,', '{\n  "contract_version": 1,\n  "contract_version": 1,'), "utf8");
  await assert.rejects(() => generateRoadmap({ operation: "INIT", projectRoot: duplicateRoot, candidatePath: duplicateCandidate }), /duplicate JSON key/u);

  const hardlinkRoot = await project(t);
  await fs.link(path.join(hardlinkRoot, "docs/checkout-stories.md"), path.join(hardlinkRoot, "docs/checkout-stories-copy.md"));
  await assert.rejects(() => generate(t, hardlinkRoot), /single-link real file|hard-linked file/u);

  const symlinkRoot = await project(t);
  const outside = path.join(symlinkRoot, "real-roadmap");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(symlinkRoot, "docs/roadmap"));
  await assert.rejects(() => generate(t, symlinkRoot), /symlink component/u);
});

test("RECONCILE rejects an authority change after inspection and preserves the pair", async (t) => {
  const root = await project(t);
  await generate(t, root);
  const before = await pair(root);
  const inspection = await inspectRoadmap("RECONCILE", root);
  await fs.appendFile(path.join(root, "docs/checkout-stories.md"), "late authority change\n", "utf8");
  await assert.rejects(() => generate(t, root, "RECONCILE", {
    expectedFingerprint: inspection.expected_fingerprint,
    expectedAuthorityFingerprint: inspection.authority_fingerprint,
  }), /authority changed after RECONCILE inspection/u);
  assert.deepEqual(await pair(root), before);
});

test("candidate JSON rejects invalid UTF-8 without output", async (t) => {
  const root = await project(t);
  const candidate = await candidateFile(t, await representativeRaw());
  await fs.writeFile(candidate, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
  await assert.rejects(
    () => generateRoadmap({ operation: "INIT", projectRoot: root, candidatePath: candidate }),
    /valid UTF-8/u,
  );
  assert.equal(await lstatOrNull(path.join(root, "docs/roadmap")), null);
});

test("authority mutation during publication rolls back to the complete old pair", async (t) => {
  const root = await project(t);
  await generate(t, root);
  const before = await pair(root);
  const inspection = await inspectRoadmap("RECONCILE", root);
  const context = await resolveRoadmap(root);
  await assert.rejects(() => publishRoadmap({
    context,
    operation: "RECONCILE",
    modelBytes: before.model,
    html: before.html.toString("utf8"),
    expectedFingerprint: inspection.expected_fingerprint,
    expectedAuthoritySnapshot: "before",
    readAuthoritySnapshot: async () => "after",
  }), /authority changed before roadmap publication/u);
  assert.deepEqual(await pair(root), before);
  assert.deepEqual((await fs.readdir(path.join(root, "docs"))).sort(), ["checkout-stories.md", "roadmap"]);
});

test("stale locks are retired by physical identity while active locks remain untouched", async (t) => {
  const staleRoot = await project(t);
  const staleContext = await resolveRoadmap(staleRoot);
  const staleLock = path.join(staleRoot, "docs/.roadmap.stnl-roadmap.lock");
  await fs.writeFile(staleLock, `${JSON.stringify({ version: 1, pid: 999_999_999, token: randomUUID() })}\n`, "utf8");
  assert.equal((await recoverRoadmapPublication(staleContext)).recovered, false);
  assert.equal(await lstatOrNull(staleLock), null);
  assert.equal((await fs.readdir(path.join(staleRoot, "docs"))).some((name) => name.includes("lock-retired")), false);

  const activeRoot = await project(t);
  const activeContext = await resolveRoadmap(activeRoot);
  const activeLock = path.join(activeRoot, "docs/.roadmap.stnl-roadmap.lock");
  const activeBytes = `${JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() })}\n`;
  await fs.writeFile(activeLock, activeBytes, "utf8");
  await assert.rejects(() => recoverRoadmapPublication(activeContext), /already active/u);
  assert.equal(await fs.readFile(activeLock, "utf8"), activeBytes);
});

test("lock release refuses to delete a substituted foreign lock", async (t) => {
  const root = await project(t);
  await generate(t, root);
  const before = await pair(root);
  const context = await resolveRoadmap(root);
  const inspection = await inspectRoadmap("RECONCILE", root);
  const lock = path.join(root, "docs/.roadmap.stnl-roadmap.lock");
  const displaced = path.join(root, "docs/.roadmap.stnl-roadmap.displaced-test-lock");
  const foreign = `${JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() })}\n`;
  await assert.rejects(() => publishRoadmap({
    context,
    operation: "RECONCILE",
    modelBytes: before.model,
    html: before.html.toString("utf8"),
    expectedFingerprint: inspection.expected_fingerprint,
    expectedAuthoritySnapshot: "before",
    readAuthoritySnapshot: async () => {
      await fs.rename(lock, displaced);
      await fs.writeFile(lock, foreign, { encoding: "utf8", flag: "wx" });
      return "after";
    },
  }), /lock ownership changed before release/u);
  assert.equal(await fs.readFile(lock, "utf8"), foreign);
  assert.deepEqual(await pair(root), before);
});

test("release quarantine restores a foreign lock substituted after ownership validation", async (t) => {
  const root = await project(t);
  const lock = path.join(root, "docs/.roadmap.stnl-roadmap.lock");
  const retired = path.join(root, "docs/.roadmap.stnl-roadmap.lock-retired-race");
  const foreign = `${JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() })}\n`;
  await fs.writeFile(retired, foreign, "utf8");
  await assert.rejects(() => verifyReleaseQuarantine({
    lock,
    ownership: { dev: "0", ino: "0", token: randomUUID() },
  }, retired), /changed during release quarantine/u);
  assert.equal(await fs.readFile(lock, "utf8"), foreign);
  assert.equal(await lstatOrNull(retired), null);
});

test("journal recovery is idempotent across INIT and RECONCILE interruption windows", async (t) => {
  for (const window of ["reconcile-prepared", "reconcile-backed-up", "reconcile-committed"]) {
    await t.test(window, async (subtest) => {
      const root = await project(subtest);
      await generate(subtest, root);
      const before = await pair(root);
      const oldDigest = sha256(Buffer.concat([before.model, Buffer.from([0]), before.html]));
      const context = await resolveRoadmap(root);
      const next = await stagedNextPair(root, window);
      if (window === "reconcile-backed-up") await fs.rename(context.roadmapRoot, next.backup);
      if (window === "reconcile-committed") {
        await fs.rename(context.roadmapRoot, next.backup);
        await fs.rename(next.stage, context.roadmapRoot);
      }
      await writeRecoveryJournal(root, context, {
        mode: "RECONCILE", stage: next.stage, backup: next.backup,
        old_digest: oldDigest, new_digest: next.digest,
      });
      assert.equal((await recoverRoadmapPublication(context)).recovered, true);
      const expected = window === "reconcile-committed" ? { model: next.model, html: next.html } : before;
      assert.deepEqual(await pair(root), expected);
      assert.equal(await lstatOrNull(next.stage), null);
      assert.equal(await lstatOrNull(next.backup), null);
      assert.equal((await recoverRoadmapPublication(context)).recovered, false);
    });
  }

  for (const window of ["init-prepared", "init-committed"]) {
    await t.test(window, async (subtest) => {
      const root = await project(subtest);
      const context = await resolveRoadmap(root);
      const next = await stagedNextPair(root, window);
      if (window === "init-committed") await fs.rename(next.stage, context.roadmapRoot);
      await writeRecoveryJournal(root, context, {
        mode: "INIT", stage: next.stage, backup: next.backup,
        old_digest: null, new_digest: next.digest,
      });
      assert.equal((await recoverRoadmapPublication(context)).recovered, true);
      if (window === "init-committed") assert.deepEqual(await pair(root), { model: next.model, html: next.html });
      else assert.equal(await lstatOrNull(context.roadmapRoot), null);
      assert.equal(await lstatOrNull(next.stage), null);
      assert.equal(await lstatOrNull(next.backup), null);
      assert.equal((await recoverRoadmapPublication(context)).recovered, false);
    });
  }
});
