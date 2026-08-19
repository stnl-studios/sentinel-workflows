import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  TEST_ONLY_ACK,
  TEST_ONLY_ACK_ENV,
  TEST_ONLY_CRASH_ENV,
  journalPath,
  publishCandidate,
  recoverIncompletePublication,
} from "../lib/publisher.mjs";
import {
  PUBLISHER_CLI,
  buildResumeFixture,
  removeTemporaryDirectory,
  snapshot,
  temporaryDirectory,
  transactionResidues,
} from "./publisher-fixtures.mjs";

async function withTemporaryDirectory(prefix, action) {
  const base = await temporaryDirectory(prefix);
  try {
    return await action(base);
  } finally {
    await removeTemporaryDirectory(base);
  }
}

test("RESUME consumes its known manifest on success and pre-publication failure", async () => {
  await withTemporaryDirectory("stnl-manifest-success-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    await publishCandidate("RESUME", target, candidate, { manifestPath: manifest });
    assert.equal(await fs.stat(manifest).then(() => true, () => false), false);
  });

  await withTemporaryDirectory("stnl-manifest-failure-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    const before = snapshot(target);
    await fs.writeFile(path.join(candidate, "feature_spec.md"), "invalid candidate\n", "utf8");
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, { manifestPath: manifest }),
    );
    assert.equal(snapshot(target), before);
    assert.equal(await fs.stat(manifest).then(() => true, () => false), false);
    assert.deepEqual(await transactionResidues(target), []);
  });
});

test("a changed manifest is preserved while transaction-owned residue is still removed", async () => {
  await withTemporaryDirectory("stnl-manifest-replacement-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, {
        manifestPath: manifest,
        beforePublish: async () => {
          await fs.writeFile(manifest, "{\"unknown\":true}\n", "utf8");
        },
      }),
      /RESUME manifest changed bytes before terminal cleanup/u,
    );
    assert.equal(await fs.readFile(manifest, "utf8"), "{\"unknown\":true}\n");
    assert.deepEqual(await transactionResidues(target), []);
  });
});

test("journal and ownership survive a crash, while the manifest is already consumed", async () => {
  await withTemporaryDirectory("stnl-manifest-recovery-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    const crashed = spawnSync(
      process.execPath,
      [PUBLISHER_CLI, "RESUME", target, candidate, "--manifest", manifest],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          [TEST_ONLY_CRASH_ENV]: "JOURNAL_PREPARED",
        },
      },
    );
    assert.notEqual(crashed.status, 0);
    assert.equal(await fs.stat(manifest).then(() => true, () => false), false);
    assert.equal(await fs.stat(journalPath(target)).then(() => true, () => false), true);
    assert.ok((await transactionResidues(target)).some((name) =>
      name.includes("lifecycle-ownership-")));
    await recoverIncompletePublication(target);
    assert.deepEqual(await transactionResidues(target), []);
  });
});
