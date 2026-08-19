import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateWorkspace } from "../lib/lifecycle.mjs";
import { validateReadinessAttestation } from "../lib/readiness.mjs";
import {
  TEST_ONLY_ACK,
  TEST_ONLY_ACK_ENV,
  TEST_ONLY_CRASH_ENV,
  publishCandidate,
  readinessAttestationPath,
  recoverIncompletePublication,
} from "../lib/publisher.mjs";
import {
  PUBLISHER_CLI,
  READY_FIXTURE,
  copyTree,
  removeTemporaryDirectory,
  snapshot,
  temporaryDirectory,
  transactionResidues,
  writeResumeManifest,
} from "./publisher-fixtures.mjs";

async function readyPromotionFixture(base) {
  const target = path.join(base, "draft workspace");
  const candidate = path.join(base, "ready candidate");
  await copyTree(READY_FIXTURE, target);
  const targetFeature = path.join(target, "feature_spec.md");
  await fs.writeFile(
    targetFeature,
    (await fs.readFile(targetFeature, "utf8")).replace("status: ready", "status: draft"),
    "utf8",
  );
  await copyTree(target, candidate);
  const candidateFeature = path.join(candidate, "feature_spec.md");
  await fs.writeFile(
    candidateFeature,
    (await fs.readFile(candidateFeature, "utf8")).replace("status: draft", "status: ready"),
    "utf8",
  );
  return {
    target,
    candidate,
    attestation: readinessAttestationPath(target),
  };
}

async function withTemporaryDirectory(prefix, action) {
  const base = await temporaryDirectory(prefix);
  try {
    return await action(base);
  } finally {
    await removeTemporaryDirectory(base);
  }
}

function crashPublisher(target, candidate, attestation, checkpoint) {
  return spawnSync(
    process.execPath,
    [
      PUBLISHER_CLI,
      "RESUME",
      target,
      candidate,
      "--readiness-attestation",
      attestation,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
        [TEST_ONLY_CRASH_ENV]: checkpoint,
      },
    },
  );
}

test("RESUME publishes exact draft to ready promotion and materializes a current attestation", async () => {
  await withTemporaryDirectory("stnl-ready-promotion-", async (base) => {
    const { target, candidate, attestation } = await readyPromotionFixture(base);
    await publishCandidate("RESUME", target, candidate, {
      readinessAttestation: attestation,
    });
    assert.equal(validateWorkspace(target).status, "ready");
    assert.doesNotThrow(() => validateReadinessAttestation(target, attestation));
    assert.deepEqual(await transactionResidues(target), []);
  });
});

test("publisher CLI performs ready promotion without a manifest or hand-written JSON", async () => {
  await withTemporaryDirectory("stnl-ready-promotion-cli-", async (base) => {
    const { target, candidate, attestation } = await readyPromotionFixture(base);
    const result = spawnSync(
      process.execPath,
      [
        PUBLISHER_CLI,
        "RESUME",
        target,
        candidate,
        "--readiness-attestation",
        attestation,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS: RESUME published validated candidate/u);
    assert.match(result.stdout, /PASS: readiness attestation available at /u);
    assert.equal(validateWorkspace(target).status, "ready");
    assert.doesNotThrow(() => validateReadinessAttestation(target, attestation));
  });
});

test("ready promotion rejects manifests and any content change beyond status", async () => {
  await withTemporaryDirectory("stnl-ready-promotion-bounds-", async (base) => {
    const { target, candidate, attestation } = await readyPromotionFixture(base);
    const manifest = path.join(base, "manual.json");
    await writeResumeManifest(manifest, target);
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, {
        manifestPath: manifest,
        readinessAttestation: attestation,
      }),
      /uses no external manifest/u,
    );
    assert.equal(await fs.stat(manifest).then(() => true, () => false), true);

    const feature = path.join(candidate, "feature_spec.md");
    await fs.writeFile(
      feature,
      (await fs.readFile(feature, "utf8")).replace(
        "Provide deterministic",
        "Provide changed deterministic",
      ),
      "utf8",
    );
    const before = snapshot(target);
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, {
        readinessAttestation: attestation,
      }),
      /feature section changes/u,
    );
    assert.equal(snapshot(target), before);
    assert.equal(await fs.stat(attestation).then(() => true, () => false), false);
  });
});

test("safe rollback retains a validated promotion attestation for a direct retry", async () => {
  await withTemporaryDirectory("stnl-ready-promotion-retry-", async (base) => {
    const { target, candidate, attestation } = await readyPromotionFixture(base);
    const before = snapshot(target);
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, {
        readinessAttestation: attestation,
        afterBackupVerified: async () => {
          throw new Error("fixture failure after backup verification");
        },
      }),
      /readiness attestation intentionally retained for retry/u,
    );
    assert.equal(snapshot(target), before);
    assert.equal(await fs.stat(attestation).then(() => true, () => false), true);
    assert.deepEqual(await transactionResidues(target), []);

    await publishCandidate("RESUME", target, candidate, {
      readinessAttestation: attestation,
    });
    assert.equal(validateWorkspace(target).status, "ready");
    assert.doesNotThrow(() => validateReadinessAttestation(target, attestation));
  });
});

test("candidate-validated recovery commits only with the matching attestation", async (t) => {
  for (const removeAttestation of [false, true]) {
    await t.test(removeAttestation ? "missing attestation rolls back" : "matching attestation commits", async () => {
      await withTemporaryDirectory("stnl-ready-promotion-recovery-", async (base) => {
        const { target, candidate, attestation } = await readyPromotionFixture(base);
        const crashed = crashPublisher(
          target,
          candidate,
          attestation,
          "AFTER_TARGET_VALIDATION",
        );
        assert.notEqual(crashed.status, 0);
        assert.equal(await fs.stat(attestation).then(() => true, () => false), true);
        if (removeAttestation) await fs.unlink(attestation);
        await recoverIncompletePublication(target);
        assert.equal(validateWorkspace(target).status, removeAttestation ? "draft" : "ready");
        if (!removeAttestation) {
          assert.doesNotThrow(() => validateReadinessAttestation(target, attestation));
        }
        assert.deepEqual(await transactionResidues(target), []);
      });
    });
  }
});
