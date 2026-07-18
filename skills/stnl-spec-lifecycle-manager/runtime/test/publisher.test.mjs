import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ValidationError, validateWorkspace, workspaceSnapshot } from "../lib/lifecycle.mjs";
import { createReadinessAttestation } from "../lib/readiness.mjs";
import { buildClosedCandidate } from "../lib/closed-spec.mjs";
import {
  SOURCE_CONFLICT_DIAGNOSTIC,
  TEST_ONLY_ACK,
  TEST_ONLY_ACK_ENV,
  TEST_ONLY_CRASH_ENV,
  TEST_ONLY_FORCE_ROLLBACK_ENV,
  TEST_ONLY_MUTATE_SOURCE_ENV,
  TEST_ONLY_MUTATE_WINDOW_ENV,
  journalPath,
  lockPath,
  publishCandidate,
  recoverIncompletePublication,
} from "../lib/publisher.mjs";
import {
  PUBLISHER_CLI,
  buildResumeFixture,
  copyTree,
  readJson,
  removeTemporaryDirectory,
  snapshot,
  temporaryDirectory,
  transactionResidues,
  writeResumeManifest,
} from "./publisher-fixtures.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(TEST_DIRECTORY, "publisher-child.mjs");
const HOOK_ENVIRONMENT_KEYS = [
  TEST_ONLY_CRASH_ENV,
  TEST_ONLY_FORCE_ROLLBACK_ENV,
  TEST_ONLY_MUTATE_SOURCE_ENV,
  TEST_ONLY_MUTATE_WINDOW_ENV,
  TEST_ONLY_ACK_ENV,
];
const LINK_UNAVAILABLE_CODES = new Set([
  "EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV",
]);

function linkUnavailable(error) {
  return LINK_UNAVAILABLE_CODES.has(error?.code);
}

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const key of HOOK_ENVIRONMENT_KEYS) delete environment[key];
  return { ...environment, ...extra };
}

function runCli(
  mode,
  target,
  candidate,
  manifest = null,
  { environment = {}, cwd = null, readinessAttestation = null } = {},
) {
  const arguments_ = [PUBLISHER_CLI, mode, target, candidate];
  if (manifest !== null) arguments_.push("--manifest", manifest);
  if (readinessAttestation !== null) {
    arguments_.push("--readiness-attestation", readinessAttestation);
  }
  return spawnSync(process.execPath, arguments_, {
    cwd: cwd ?? path.dirname(target),
    env: cleanEnvironment(environment),
    encoding: "utf8",
    windowsHide: true,
  });
}

async function withTemporaryDirectory(prefix, action) {
  const directory = await temporaryDirectory(prefix);
  try {
    return await action(directory);
  } finally {
    await removeTemporaryDirectory(directory);
  }
}

function strictLockRecord(overrides = {}) {
  return {
    version: 1,
    state: "active",
    owner_id: "a".repeat(32),
    operation_id: "b".repeat(32),
    transaction_id: null,
    pid: process.pid,
    hostname: os.hostname(),
    started_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function writeLock(target, payload) {
  await fs.writeFile(lockPath(target), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function assertKilled(result, checkpoint) {
  assert.notEqual(result.status, 0, `${checkpoint}: crash hook exited successfully`);
  assert.ok(
    result.signal === "SIGKILL" || result.status === 137 || result.status === 9 || result.status === 1,
    `${checkpoint}: unexpected crash result ${JSON.stringify({ status: result.status, signal: result.signal, stderr: result.stderr })}`,
  );
}

async function captureFileEvidence(filePaths) {
  const evidence = new Map();
  for (const filePath of filePaths) {
    evidence.set(filePath, {
      metadata: await fs.lstat(filePath, { bigint: true }),
      bytes: await fs.readFile(filePath),
    });
  }
  return evidence;
}

async function assertFileEvidencePreserved(evidence) {
  for (const [filePath, before] of evidence) {
    const after = await fs.lstat(filePath, { bigint: true });
    assert.equal(after.dev, before.metadata.dev);
    assert.equal(after.ino, before.metadata.ino);
    assert.deepEqual(await fs.readFile(filePath), before.bytes);
  }
}

async function captureLockCreateSwapEvidence(target) {
  const canonical = lockPath(target);
  const proof = `${canonical}.test-owned-original`;
  const tempNames = (await fs.readdir(path.dirname(target))).filter((name) =>
    name.includes("lifecycle-lock-tmp-") && !name.endsWith(".test-owned-original"));
  assert.equal(tempNames.length, 1);
  const temp = path.join(path.dirname(target), tempNames[0]);
  const canonicalMetadata = await fs.lstat(canonical, { bigint: true });
  const proofMetadata = await fs.lstat(proof, { bigint: true });
  const tempMetadata = await fs.lstat(temp, { bigint: true });
  assert.equal(canonicalMetadata.nlink, 1n);
  assert.equal(proofMetadata.nlink, 2n);
  assert.equal(tempMetadata.nlink, 2n);
  assert.equal(proofMetadata.dev, tempMetadata.dev);
  assert.equal(proofMetadata.ino, tempMetadata.ino);
  assert.notEqual(canonicalMetadata.ino, tempMetadata.ino);
  assert.deepEqual(await fs.readFile(proof), await fs.readFile(temp));
  assert.notEqual((await readJson(canonical)).owner_id, (await readJson(temp)).owner_id);
  return captureFileEvidence([canonical, proof, temp]);
}

test("CLI preserves parser exit codes, failure category, direct aliases, and paths with spaces", async (t) => {
  await withTemporaryDirectory("stnl publisher cli ", async (base) => {
    const missing = spawnSync(process.execPath, [PUBLISHER_CLI], {
      cwd: base,
      env: cleanEnvironment(),
      encoding: "utf8",
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /arguments are required/u);

    const invalidMode = spawnSync(process.execPath, [PUBLISHER_CLI, "READINESS", "x", "y"], {
      cwd: base,
      env: cleanEnvironment(),
      encoding: "utf8",
    });
    assert.equal(invalidMode.status, 2);
    assert.match(invalidMode.stderr, /invalid choice/u);

    for (const option of ["--manifest", "--readiness-attestation"]) {
      const missingOptionValue = spawnSync(
        process.execPath,
        [PUBLISHER_CLI, "RESUME", "target", "candidate", option, "--help"],
        { cwd: base, env: cleanEnvironment(), encoding: "utf8" },
      );
      assert.equal(missingOptionValue.status, 2);
      assert.match(
        missingOptionValue.stderr,
        new RegExp(`argument ${option}: expected one argument`),
      );
      const equalsValue = spawnSync(
        process.execPath,
        [PUBLISHER_CLI, "RESUME", "target", "candidate", `${option}=--literal-value`],
        { cwd: base, env: cleanEnvironment(), encoding: "utf8" },
      );
      assert.equal(equalsValue.status, 1, equalsValue.stderr);
      assert.doesNotMatch(equalsValue.stderr, /expected one argument/u);
    }

    const { target, candidate, manifest } = await buildResumeFixture(base);
    const result = runCli("RESUME", target, candidate, manifest, { cwd: path.dirname(base) });
    assert.equal(result.status, 0, result.stderr);
    const publishedWorkspace = validateWorkspace(target);
    assert.equal(
      result.stdout,
      `PASS: RESUME published validated candidate at ${publishedWorkspace.root}\n`,
    );
    assert.deepEqual(await transactionResidues(target), []);

    const wrongOption = runCli("INIT", path.join(base, "new"), candidate, manifest);
    assert.equal(wrongOption.status, 1);
    assert.match(wrongOption.stderr, /^FAIL: --manifest is valid only for RESUME, not INIT/mu);

    await writeResumeManifest(manifest, target);
    const repeatedOption = spawnSync(
      process.execPath,
      [
        PUBLISHER_CLI,
        "RESUME",
        target,
        candidate,
        "--manifest=missing-first-value.json",
        "--manifest",
        manifest,
      ],
      { cwd: path.dirname(base), env: cleanEnvironment(), encoding: "utf8" },
    );
    assert.equal(repeatedOption.status, 0, repeatedOption.stderr);

    const aliasedEntrypoint = path.join(base, "aliased publisher entrypoint.mjs");
    try {
      await fs.symlink(PUBLISHER_CLI, aliasedEntrypoint);
      const aliasedHelp = spawnSync(process.execPath, [aliasedEntrypoint, "--help"], {
        cwd: path.dirname(base),
        env: cleanEnvironment(),
        encoding: "utf8",
      });
      assert.equal(aliasedHelp.status, 0, aliasedHelp.stderr);
      assert.match(aliasedHelp.stdout, /^usage: publish-spec-lifecycle\.mjs/u);
    } catch (error) {
      if (!linkUnavailable(error)) throw error;
      t.diagnostic(`entrypoint symlink unavailable: ${error.code}`);
    }
  });
});

test("RESUME is deterministic, idempotent, UTF-8 safe, and preserves hardlink/symlink topology", async (t) => {
  await withTemporaryDirectory("stnl-publisher-unicode-", async (base) => {
    const target = path.join(base, "origem ç 雪");
    const candidate = path.join(base, "candidato ç 雪");
    const manifest = path.join(base, "manifesto ç.json");
    const fixture = await buildResumeFixture(path.join(base, "seed"));
    await fs.rename(fixture.target, target);
    await fs.rm(fixture.candidate, { recursive: true });
    const execution = path.join(target, "execution");
    const evidence = path.join(target, "evidence");
    await fs.mkdir(execution, { recursive: true });
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(execution, "ação-雪.txt"), "conteúdo UTF-8 — 雪\n", "utf8");
    const hardA = path.join(execution, "hard-a.bin");
    const hardB = path.join(evidence, "hard-b.bin");
    await fs.writeFile(hardA, Buffer.from("hardlink topology\0", "utf8"));
    let hardlinksAvailable = true;
    try {
      await fs.link(hardA, hardB);
    } catch (error) {
      if (linkUnavailable(error)) {
        hardlinksAvailable = false;
        t.diagnostic(`hardlinks unavailable: ${error.code}`);
        await fs.copyFile(hardA, hardB);
      } else {
        throw error;
      }
    }
    const symlink = path.join(execution, "unicode-link");
    let symlinksAvailable = true;
    try {
      await fs.symlink("ação-雪.txt", symlink);
    } catch (error) {
      if (linkUnavailable(error)) {
        symlinksAvailable = false;
        t.diagnostic(`symlinks unavailable: ${error.code}`);
      } else {
        throw error;
      }
    }
    await copyTree(target, candidate);
    // fs.cp is not required to preserve link groups, so establish the exact candidate topology.
    if (hardlinksAvailable) {
      await fs.unlink(path.join(candidate, "evidence", "hard-b.bin"));
      await fs.link(
        path.join(candidate, "execution", "hard-a.bin"),
        path.join(candidate, "evidence", "hard-b.bin"),
      );
    }
    await writeResumeManifest(manifest, target);
    const expected = snapshot(candidate);

    await publishCandidate("RESUME", target, candidate, { manifestPath: manifest });
    assert.equal(snapshot(target), expected);
    assert.equal(
      await fs.readFile(path.join(target, "execution", "ação-雪.txt"), "utf8"),
      "conteúdo UTF-8 — 雪\n",
    );
    if (hardlinksAvailable) {
      const targetHardA = await fs.stat(path.join(target, "execution", "hard-a.bin"), { bigint: true });
      const targetHardB = await fs.stat(path.join(target, "evidence", "hard-b.bin"), { bigint: true });
      assert.equal(targetHardA.ino, targetHardB.ino);
    }
    if (symlinksAvailable) {
      assert.equal(await fs.readlink(path.join(target, "execution", "unicode-link")), "ação-雪.txt");
    }

    await writeResumeManifest(manifest, target);
    await publishCandidate("RESUME", target, candidate, { manifestPath: manifest });
    assert.equal(snapshot(target), expected);
    assert.deepEqual(await transactionResidues(target), []);
  });
});

test("invalid candidates and candidate hardlinks crossing the boundary fail without source mutation", async (t) => {
  await withTemporaryDirectory("stnl-publisher-no-mutation-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    const before = snapshot(target);
    await fs.writeFile(path.join(candidate, "feature_spec.md"), "invalid candidate\n", "utf8");
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, { manifestPath: manifest }),
      ValidationError,
    );
    assert.equal(snapshot(target), before);
    assert.deepEqual(await transactionResidues(target), []);
  });

  await withTemporaryDirectory("stnl-publisher-cross-link-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    const before = snapshot(target);
    const external = path.join(base, "external.bin");
    const internal = path.join(candidate, "execution", "linked.bin");
    await fs.mkdir(path.dirname(internal), { recursive: true });
    await fs.writeFile(external, "outside link group\n", "utf8");
    try {
      await fs.link(external, internal);
    } catch (error) {
      if (linkUnavailable(error)) {
        t.diagnostic(`hardlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, { manifestPath: manifest }),
      /candidate hardlink group crosses the publication boundary/u,
    );
    assert.equal(snapshot(target), before);
    assert.equal(await fs.readFile(external, "utf8"), "outside link group\n");
    assert.deepEqual(await transactionResidues(target), []);
  });
});

test("all seven durable crash windows recover to a complete state and recovery is idempotent", async (t) => {
  const expectedLayouts = {
    JOURNAL_PREPARED: ["prepared", true, true, false],
    TARGET_TO_BACKUP_RENAMED: ["prepared", false, true, true],
    STAGE_TO_TARGET_RENAMED: ["backup_verified", true, false, true],
    BEFORE_TARGET_VALIDATION: ["candidate_promoted", true, false, true],
    AFTER_TARGET_VALIDATION: ["candidate_validated", true, false, true],
    BEFORE_BACKUP_REMOVAL: ["committed", true, false, true],
    DURING_ROLLBACK: ["rollback_required", false, true, true],
  };
  for (const [checkpoint, expected] of Object.entries(expectedLayouts)) {
    await t.test(checkpoint, async () => {
      await withTemporaryDirectory(`stnl-publisher-${checkpoint.toLowerCase()}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, {
          candidateWhitespaceChange: true,
        });
        const sourceState = snapshot(target);
        const candidateState = snapshot(candidate);
        const environment = {
          [TEST_ONLY_CRASH_ENV]: checkpoint,
          [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
        };
        if (checkpoint === "DURING_ROLLBACK") environment[TEST_ONLY_FORCE_ROLLBACK_ENV] = "1";
        const result = runCli("RESUME", target, candidate, manifest, { environment });
        assertKilled(result, checkpoint);
        const journal = await readJson(journalPath(target));
        assert.equal(journal.phase, expected[0]);
        assert.equal(await fs.stat(lockPath(target)).then(() => true, () => false), true);
        assert.equal(await fs.stat(target).then(() => true, () => false), expected[1]);
        const stage = path.join(path.dirname(target), journal.stage);
        const backup = path.join(path.dirname(target), journal.backup);
        assert.equal(await fs.stat(stage).then(() => true, () => false), expected[2]);
        assert.equal(await fs.stat(backup).then(() => true, () => false), expected[3]);

        assert.equal(await recoverIncompletePublication(target), true);
        validateWorkspace(target);
        const expectedState = new Set(["AFTER_TARGET_VALIDATION", "BEFORE_BACKUP_REMOVAL"])
          .has(checkpoint) ? candidateState : sourceState;
        assert.equal(snapshot(target), expectedState);
        assert.deepEqual(await transactionResidues(target), []);
        const recovered = snapshot(target);
        assert.equal(await recoverIncompletePublication(target), false);
        assert.equal(snapshot(target), recovered);
      });
    });
  }
});

test("all journal CAS crash windows recover without losing transaction authority", async (t) => {
  const checkpoints = new Map([
    ["JOURNAL_CREATE_READY", "source"],
    ["JOURNAL_UPDATE_READY", "source"],
    ["JOURNAL_UPDATE_QUARANTINED", "source"],
    ["JOURNAL_UPDATE_CLAIMED", "source"],
    ["JOURNAL_CLEANUP_QUARANTINED", "candidate"],
  ]);
  for (const [checkpoint, expected] of checkpoints) {
    await t.test(checkpoint, async () => {
      await withTemporaryDirectory(`stnl-publisher-${checkpoint.toLowerCase()}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, {
          candidateWhitespaceChange: true,
        });
        const sourceState = snapshot(target);
        const candidateState = snapshot(candidate);
        const result = runCli("RESUME", target, candidate, manifest, {
          environment: {
            [TEST_ONLY_CRASH_ENV]: checkpoint,
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assertKilled(result, checkpoint);
        assert.equal(await recoverIncompletePublication(target), true);
        assert.equal(snapshot(target), expected === "source" ? sourceState : candidateState);
        assert.deepEqual(await transactionResidues(target), []);
        assert.equal(await recoverIncompletePublication(target), false);
      });
    });
  }
});

test("ownership and lock CAS crash windows recover pre-journal state without losing authority", async (t) => {
  for (const checkpoint of [
    "OWNERSHIP_UPDATE_READY",
    "OWNERSHIP_UPDATE_QUARANTINED",
    "OWNERSHIP_UPDATE_CLAIMED",
    "LOCK_UPDATE_READY",
    "LOCK_UPDATE_QUARANTINED",
    "LOCK_UPDATE_CLAIMED",
  ]) {
    await t.test(checkpoint, async () => {
      await withTemporaryDirectory(`stnl-publisher-${checkpoint.toLowerCase()}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, {
          candidateWhitespaceChange: true,
        });
        const sourceState = snapshot(target);
        const result = runCli("RESUME", target, candidate, manifest, {
          environment: {
            [TEST_ONLY_CRASH_ENV]: checkpoint,
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assertKilled(result, checkpoint);
        assert.equal(await recoverIncompletePublication(target), false);
        assert.equal(snapshot(target), sourceState);
        assert.deepEqual(await transactionResidues(target), []);
        assert.equal(await recoverIncompletePublication(target), false);
      });
    });
  }
});

test("ownership and lock CAS reject foreign canonical replacements and preserve all evidence", async (t) => {
  const cases = [
    [
      "OWNERSHIP_UPDATE_CANONICAL_SWAP",
      "lifecycle-ownership-",
      "foreign ownership update sentinel\n",
      /transaction ownership was replaced before atomic promotion/u,
    ],
    [
      "LOCK_UPDATE_CANONICAL_SWAP",
      "lifecycle.lock",
      "foreign lock update sentinel\n",
      /workspace publication lock was replaced before atomic promotion/u,
    ],
  ];
  for (const [window, canonicalMarker, sentinel, expectedError] of cases) {
    await t.test(window, async () => {
      await withTemporaryDirectory(`stnl-publisher-${window.toLowerCase()}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, {
          candidateWhitespaceChange: true,
        });
        process.env[TEST_ONLY_MUTATE_WINDOW_ENV] = window;
        process.env[TEST_ONLY_ACK_ENV] = TEST_ONLY_ACK;
        try {
          await assert.rejects(
            publishCandidate("RESUME", target, candidate, { manifestPath: manifest }),
            expectedError,
          );
        } finally {
          delete process.env[TEST_ONLY_MUTATE_WINDOW_ENV];
          delete process.env[TEST_ONLY_ACK_ENV];
        }
        const names = await fs.readdir(path.dirname(target));
        const canonicalName = window === "LOCK_UPDATE_CANONICAL_SWAP"
          ? path.basename(lockPath(target))
          : names.find((name) =>
            name.startsWith(`.${path.basename(target)}.${canonicalMarker}`) &&
            /^[.]json$/u.test(name.slice(-5)) && !name.includes("-tmp-"));
        assert.ok(canonicalName, `missing exact foreign canonical for ${window}`);
        const canonical = path.join(path.dirname(target), canonicalName);
        const canonicalMetadata = await fs.lstat(canonical, { bigint: true });
        const canonicalBytes = await fs.readFile(canonical);
        assert.equal(canonicalBytes.toString("utf8"), sentinel);
        const roleEvidence = new Map();
        for (const name of names.filter((entry) => entry.includes("-tmp-"))) {
          const filePath = path.join(path.dirname(target), name);
          roleEvidence.set(filePath, {
            metadata: await fs.lstat(filePath, { bigint: true }),
            bytes: await fs.readFile(filePath),
          });
        }
        assert.ok(roleEvidence.size > 0, `missing CAS role for ${window}`);

        await assert.rejects(recoverIncompletePublication(target));
        const preservedCanonical = await fs.lstat(canonical, { bigint: true });
        assert.equal(preservedCanonical.dev, canonicalMetadata.dev);
        assert.equal(preservedCanonical.ino, canonicalMetadata.ino);
        assert.deepEqual(await fs.readFile(canonical), canonicalBytes);
        for (const [filePath, evidence] of roleEvidence) {
          const preserved = await fs.lstat(filePath, { bigint: true });
          assert.equal(preserved.dev, evidence.metadata.dev);
          assert.equal(preserved.ino, evidence.metadata.ino);
          assert.deepEqual(await fs.readFile(filePath), evidence.bytes);
        }
      });
    });
  }
});

test("lock create claim rejects valid foreign canonical swaps live and during recovery", async (t) => {
  await t.test("live claim settlement", async () => {
    await withTemporaryDirectory("stnl-publisher-lock-create-live-swap-", async (base) => {
      const { target } = await buildResumeFixture(base);
      const before = snapshot(target);
      process.env[TEST_ONLY_MUTATE_WINDOW_ENV] = "LOCK_CREATE_LIVE_CANONICAL_SWAP";
      process.env[TEST_ONLY_ACK_ENV] = TEST_ONLY_ACK;
      try {
        await assert.rejects(
          recoverIncompletePublication(target),
          /workspace publication lock create claim changed before settlement/u,
        );
      } finally {
        delete process.env[TEST_ONLY_MUTATE_WINDOW_ENV];
        delete process.env[TEST_ONLY_ACK_ENV];
      }
      assert.equal(snapshot(target), before);
      const evidence = await captureLockCreateSwapEvidence(target);
      await assert.rejects(
        recoverIncompletePublication(target),
        /another publisher already holds the workspace lock/u,
      );
      await assertFileEvidencePreserved(evidence);
    });
  });

  await t.test("crash recovery settlement", async () => {
    await withTemporaryDirectory("stnl-publisher-lock-create-recovery-swap-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base);
      const before = snapshot(target);
      const crashed = runCli("RESUME", target, candidate, manifest, {
        environment: {
          [TEST_ONLY_CRASH_ENV]: "LOCK_CLAIM_LINKED",
          [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
        },
      });
      assertKilled(crashed, "LOCK_CLAIM_LINKED");
      process.env[TEST_ONLY_MUTATE_WINDOW_ENV] = "LOCK_CREATE_RECOVERY_CANONICAL_SWAP";
      process.env[TEST_ONLY_ACK_ENV] = TEST_ONLY_ACK;
      try {
        await assert.rejects(
          recoverIncompletePublication(target),
          /workspace publication lock create claim changed before settlement/u,
        );
      } finally {
        delete process.env[TEST_ONLY_MUTATE_WINDOW_ENV];
        delete process.env[TEST_ONLY_ACK_ENV];
      }
      assert.equal(snapshot(target), before);
      const evidence = await captureLockCreateSwapEvidence(target);
      await assert.rejects(
        recoverIncompletePublication(target),
        /another publisher already holds the workspace lock/u,
      );
      await assertFileEvidencePreserved(evidence);
    });
  });
});

test("failed exclusive creates never unlink replacement ownership or lock candidates", async (t) => {
  await t.test("ownership create EEXIST cleanup", async () => {
    await withTemporaryDirectory("stnl-publisher-ownership-create-cleanup-race-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      const sourceState = snapshot(target);
      process.env[TEST_ONLY_MUTATE_WINDOW_ENV] = "OWNERSHIP_CREATE_CLEANUP_SWAP";
      process.env[TEST_ONLY_ACK_ENV] = TEST_ONLY_ACK;
      try {
        await assert.rejects(
          publishCandidate("RESUME", target, candidate, { manifestPath: manifest }),
          /transaction ownership exclusive-create candidate changed before failed-claim cleanup/u,
        );
      } finally {
        delete process.env[TEST_ONLY_MUTATE_WINDOW_ENV];
        delete process.env[TEST_ONLY_ACK_ENV];
      }
      assert.equal(snapshot(target), sourceState);
      const parent = path.dirname(target);
      const names = await fs.readdir(parent);
      const prefix = `.${path.basename(target)}.lifecycle-ownership-`;
      const canonicalName = names.find((name) => name.startsWith(prefix) && name.endsWith(".json"));
      const foreignTempName = names.find((name) =>
        name.includes(".lifecycle-ownership-tmp-") && !name.endsWith(".test-owned-original"));
      const ownedProofName = names.find((name) =>
        name.includes(".lifecycle-ownership-tmp-") && name.endsWith(".test-owned-original"));
      assert.ok(canonicalName);
      assert.ok(foreignTempName);
      assert.ok(ownedProofName);
      const canonical = path.join(parent, canonicalName);
      const foreignTemp = path.join(parent, foreignTempName);
      const ownedProof = path.join(parent, ownedProofName);
      assert.equal(
        await fs.readFile(canonical, "utf8"),
        "foreign ownership exclusive-create canonical sentinel\n",
      );
      assert.equal(
        await fs.readFile(foreignTemp, "utf8"),
        "foreign transaction ownership exclusive-create candidate sentinel\n",
      );
      const proof = await readJson(ownedProof);
      assert.equal(proof.version, 1);
      assert.match(proof.transaction_id, /^[0-9a-f]{32}$/u);
      const evidence = await captureFileEvidence([canonical, foreignTemp, ownedProof]);
      await assert.rejects(recoverIncompletePublication(target));
      await assertFileEvidencePreserved(evidence);
    });
  });

  await t.test("lock create EEXIST cleanup", async () => {
    await withTemporaryDirectory("stnl-publisher-lock-create-cleanup-race-", async (base) => {
      const { target } = await buildResumeFixture(base);
      const sourceState = snapshot(target);
      process.env[TEST_ONLY_MUTATE_WINDOW_ENV] = "LOCK_CREATE_CLEANUP_SWAP";
      process.env[TEST_ONLY_ACK_ENV] = TEST_ONLY_ACK;
      try {
        await assert.rejects(
          recoverIncompletePublication(target),
          /workspace publication lock exclusive-create candidate changed before failed-claim cleanup/u,
        );
      } finally {
        delete process.env[TEST_ONLY_MUTATE_WINDOW_ENV];
        delete process.env[TEST_ONLY_ACK_ENV];
      }
      assert.equal(snapshot(target), sourceState);
      const parent = path.dirname(target);
      const names = await fs.readdir(parent);
      const foreignTempName = names.find((name) =>
        name.includes(".lifecycle-lock-tmp-") && !name.endsWith(".test-owned-original"));
      const ownedProofName = names.find((name) =>
        name.includes(".lifecycle-lock-tmp-") && name.endsWith(".test-owned-original"));
      assert.ok(foreignTempName);
      assert.ok(ownedProofName);
      const canonical = lockPath(target);
      const foreignTemp = path.join(parent, foreignTempName);
      const ownedProof = path.join(parent, ownedProofName);
      assert.equal(
        await fs.readFile(foreignTemp, "utf8"),
        "foreign workspace publication lock exclusive-create candidate sentinel\n",
      );
      assert.equal((await readJson(canonical)).state, "active");
      assert.equal((await readJson(ownedProof)).state, "active");
      const evidence = await captureFileEvidence([canonical, foreignTemp, ownedProof]);
      await assert.rejects(
        recoverIncompletePublication(target),
        /another publisher already holds the workspace lock/u,
      );
      await assertFileEvidencePreserved(evidence);
    });
  });
});

test("interrupted journal operations reject and preserve unexpected canonical files", async (t) => {
  const cases = [
    ["JOURNAL_CREATE_READY", "create", "valid-copy"],
    ["JOURNAL_UPDATE_READY", "next", "owned-copy"],
    ["JOURNAL_UPDATE_QUARANTINED", "previous", "valid-copy"],
    ["JOURNAL_UPDATE_CLAIMED", "next", "sentinel"],
    ["JOURNAL_CLEANUP_QUARANTINED", "cleanup", "valid-copy"],
  ];
  for (const [checkpoint, sourceRole, foreignKind] of cases) {
    await t.test(checkpoint, async () => {
      await withTemporaryDirectory(`stnl-publisher-foreign-${checkpoint.toLowerCase()}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, {
          candidateWhitespaceChange: true,
        });
        const result = runCli("RESUME", target, candidate, manifest, {
          environment: {
            [TEST_ONLY_CRASH_ENV]: checkpoint,
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assertKilled(result, checkpoint);
        const parent = path.dirname(target);
        const prefix = `.${path.basename(target)}.lifecycle-journal-tmp-`;
        const rolePaths = (await fs.readdir(parent))
          .filter((name) => name.startsWith(prefix))
          .map((name) => path.join(parent, name));
        assert.ok(rolePaths.length > 0);
        const source = rolePaths.find((filePath) => path.basename(filePath).includes(`-${sourceRole}-`));
        assert.ok(source, `missing ${sourceRole} role at ${checkpoint}`);

        let ownedCanonicalEvidence = null;
        if (await fs.stat(journalPath(target)).then(() => true, () => false)) {
          ownedCanonicalEvidence = path.join(base, `owned canonical ${checkpoint}.json`);
          await fs.rename(journalPath(target), ownedCanonicalEvidence);
        }
        const evidence = new Map();
        for (const filePath of rolePaths) {
          evidence.set(filePath, {
            metadata: await fs.lstat(filePath, { bigint: true }),
            bytes: await fs.readFile(filePath),
          });
        }
        let ownedCanonicalRecord = null;
        if (ownedCanonicalEvidence !== null) {
          ownedCanonicalRecord = {
            metadata: await fs.lstat(ownedCanonicalEvidence, { bigint: true }),
            bytes: await fs.readFile(ownedCanonicalEvidence),
          };
        }
        const foreignBytes = foreignKind === "valid-copy"
          ? await fs.readFile(source)
          : foreignKind === "owned-copy"
            ? ownedCanonicalRecord.bytes
            : Buffer.from(`FOREIGN ${checkpoint} JOURNAL SENTINEL\n`, "utf8");
        await fs.writeFile(journalPath(target), foreignBytes, { mode: 0o600 });
        const foreignMetadata = await fs.lstat(journalPath(target), { bigint: true });

        await assert.rejects(
          recoverIncompletePublication(target),
          /transaction journal canonical (?:path appeared in an interrupted atomic operation|identity or payload changed before atomic update)/u,
        );
        const preservedForeign = await fs.lstat(journalPath(target), { bigint: true });
        assert.equal(preservedForeign.dev, foreignMetadata.dev);
        assert.equal(preservedForeign.ino, foreignMetadata.ino);
        assert.deepEqual(await fs.readFile(journalPath(target)), foreignBytes);
        for (const [filePath, before] of evidence) {
          const after = await fs.lstat(filePath, { bigint: true });
          assert.equal(after.dev, before.metadata.dev);
          assert.equal(after.ino, before.metadata.ino);
          assert.deepEqual(await fs.readFile(filePath), before.bytes);
        }
        if (ownedCanonicalEvidence !== null) {
          const after = await fs.lstat(ownedCanonicalEvidence, { bigint: true });
          assert.equal(after.dev, ownedCanonicalRecord.metadata.dev);
          assert.equal(after.ino, ownedCanonicalRecord.metadata.ino);
          assert.deepEqual(await fs.readFile(ownedCanonicalEvidence), ownedCanonicalRecord.bytes);
        }
      });
    });
  }

  await t.test("JOURNAL_UPDATE_READY in-place payload mutation", async () => {
    await withTemporaryDirectory("stnl-publisher-foreign-update-ready-payload-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      const result = runCli("RESUME", target, candidate, manifest, {
        environment: {
          [TEST_ONLY_CRASH_ENV]: "JOURNAL_UPDATE_READY",
          [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
        },
      });
      assertKilled(result, "JOURNAL_UPDATE_READY");
      const parent = path.dirname(target);
      const nextPath = (await fs.readdir(parent))
        .filter((name) => name.includes(".lifecycle-journal-tmp-") && name.includes("-next-"))
        .map((name) => path.join(parent, name))[0];
      assert.ok(nextPath);
      const nextMetadata = await fs.lstat(nextPath, { bigint: true });
      const nextBytes = await fs.readFile(nextPath);
      const canonical = journalPath(target);
      const canonicalMetadata = await fs.lstat(canonical, { bigint: true });
      const originalBytes = await fs.readFile(canonical);
      await fs.writeFile(path.join(base, "owned canonical payload evidence.json"), originalBytes);
      const payload = JSON.parse(originalBytes.toString("utf8"));
      payload.phase = "candidate_promoted";
      const foreignBytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
      const handle = await fs.open(canonical, "r+");
      try {
        await handle.truncate(0);
        await handle.writeFile(foreignBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const mutatedMetadata = await fs.lstat(canonical, { bigint: true });
      assert.equal(mutatedMetadata.dev, canonicalMetadata.dev);
      assert.equal(mutatedMetadata.ino, canonicalMetadata.ino);

      await assert.rejects(
        recoverIncompletePublication(target),
        /transaction journal canonical identity or payload changed before atomic update/u,
      );
      const preservedCanonical = await fs.lstat(canonical, { bigint: true });
      assert.equal(preservedCanonical.dev, canonicalMetadata.dev);
      assert.equal(preservedCanonical.ino, canonicalMetadata.ino);
      assert.deepEqual(await fs.readFile(canonical), foreignBytes);
      const preservedNext = await fs.lstat(nextPath, { bigint: true });
      assert.equal(preservedNext.dev, nextMetadata.dev);
      assert.equal(preservedNext.ino, nextMetadata.ino);
      assert.deepEqual(await fs.readFile(nextPath), nextBytes);
    });
  });
});

test("journal creation and updates preserve foreign canonical replacements and owned evidence", async (t) => {
  await t.test("exclusive creation", async () => {
    await withTemporaryDirectory("stnl-publisher-journal-create-race-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      const sourceState = snapshot(target);
      const sentinel = "FOREIGN JOURNAL CREATION SENTINEL\n";
      await assert.rejects(
        publishCandidate("RESUME", target, candidate, {
          manifestPath: manifest,
          beforePublish: async () => {
            await fs.writeFile(journalPath(target), sentinel, "utf8");
          },
        }),
        /transaction journal appeared during exclusive creation/u,
      );
      assert.equal(await fs.readFile(journalPath(target), "utf8"), sentinel);
      assert.equal(snapshot(target), sourceState);
    });
  });

  await t.test("phase update inode replacement", async () => {
    await withTemporaryDirectory("stnl-publisher-journal-update-race-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      const sourceState = snapshot(target);
      const ownedEvidence = path.join(base, "owned prepared journal evidence.json");
      let foreignBytes;
      await assert.rejects(
        publishCandidate("RESUME", target, candidate, {
          manifestPath: manifest,
          afterJournalPrepared: async () => {
            foreignBytes = await fs.readFile(journalPath(target));
            await fs.rename(journalPath(target), ownedEvidence);
            await fs.writeFile(journalPath(target), foreignBytes);
          },
        }),
        /transaction journal changed ownership identity or payload/u,
      );
      assert.deepEqual(await fs.readFile(journalPath(target)), foreignBytes);
      const original = await readJson(ownedEvidence);
      assert.equal(original.phase, "prepared");
      assert.match(original.transaction_id, /^[0-9a-f]{32}$/u);
      assert.equal(await fs.stat(target).then(() => true, () => false), false);
      assert.equal(snapshot(path.join(path.dirname(target), original.backup)), sourceState);
    });
  });

  await t.test("phase update payload mutation", async () => {
    await withTemporaryDirectory("stnl-publisher-journal-payload-race-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      const sourceState = snapshot(target);
      const ownedEvidence = path.join(base, "owned payload journal evidence.json");
      let foreignBytes;
      await assert.rejects(
        publishCandidate("RESUME", target, candidate, {
          manifestPath: manifest,
          afterJournalPrepared: async () => {
            const originalBytes = await fs.readFile(journalPath(target));
            await fs.writeFile(ownedEvidence, originalBytes);
            const payload = JSON.parse(originalBytes.toString("utf8"));
            payload.phase = "candidate_promoted";
            foreignBytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
            await fs.writeFile(journalPath(target), foreignBytes);
          },
        }),
        /transaction journal changed ownership identity or payload/u,
      );
      assert.deepEqual(await fs.readFile(journalPath(target)), foreignBytes);
      const original = await readJson(ownedEvidence);
      assert.equal(original.phase, "prepared");
      assert.equal(await fs.stat(target).then(() => true, () => false), false);
      assert.equal(snapshot(path.join(path.dirname(target), original.backup)), sourceState);
    });
  });

  await t.test("committed cleanup", async () => {
    await withTemporaryDirectory("stnl-publisher-journal-cleanup-race-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      const sourceState = snapshot(target);
      const candidateState = snapshot(candidate);
      const ownedEvidence = path.join(base, "owned committed journal evidence.json");
      const sentinel = "FOREIGN JOURNAL CLEANUP SENTINEL\n";
      let backupPath;
      await assert.rejects(
        publishCandidate("RESUME", target, candidate, {
          manifestPath: manifest,
          beforeCommittedCleanup: async ({ backup }) => {
            backupPath = backup;
            await fs.rename(journalPath(target), ownedEvidence);
            await fs.writeFile(journalPath(target), sentinel, "utf8");
          },
        }),
        /transaction journal is malformed|changed ownership identity or payload/u,
      );
      assert.equal(await fs.readFile(journalPath(target), "utf8"), sentinel);
      const original = await readJson(ownedEvidence);
      assert.equal(original.phase, "committed");
      assert.match(original.transaction_id, /^[0-9a-f]{32}$/u);
      assert.equal(snapshot(target), candidateState);
      assert.equal(snapshot(backupPath), sourceState);
    });
  });
});

test("real competing publishers serialize through the portable lock", async () => {
  await withTemporaryDirectory("stnl-publisher-concurrency-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    const child = spawn(process.execPath, [CHILD, target, candidate, manifest], {
      cwd: path.dirname(base),
      env: cleanEnvironment(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const firstMessage = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`lock holder timed out: ${stderr}`)), 20_000);
      child.once("message", (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`lock holder exited early (${code}): ${stderr}`));
      });
    });
    assert.deepEqual(firstMessage, { state: "locked" });
    const competing = runCli("RESUME", target, candidate, manifest);
    assert.equal(competing.status, 1);
    assert.match(competing.stderr, /another publisher already holds the workspace lock/u);
    child.send({ state: "release" });
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0, stderr);
    validateWorkspace(target);
    assert.deepEqual(await transactionResidues(target), []);
    assert.equal((await readJson(lockPath(target))).state, "released");
  });
});

test("active, orphan, symlink, and hardlinked locks are handled conservatively", async (t) => {
  await withTemporaryDirectory("stnl-publisher-active-lock-", async (base) => {
    const { target } = await buildResumeFixture(base);
    const active = strictLockRecord();
    // Use the exact hostname selected by the runtime, learned from a completed lock if needed.
    await writeLock(target, active);
    await assert.rejects(
      recoverIncompletePublication(target),
      /another publisher already holds the workspace lock/u,
    );
    assert.deepEqual(await readJson(lockPath(target)), active);
  });

  await withTemporaryDirectory("stnl-publisher-orphan-lock-", async (base) => {
    const { target } = await buildResumeFixture(base);
    // First acquire/release once to capture the runtime's portable hostname spelling.
    assert.equal(await recoverIncompletePublication(target), false);
    const seed = await readJson(lockPath(target));
    const orphan = strictLockRecord({ hostname: seed.hostname, pid: 2_147_483_647 });
    await writeLock(target, orphan);
    assert.equal(await recoverIncompletePublication(target), false);
    const reclaimed = await readJson(lockPath(target));
    assert.equal(reclaimed.state, "released");
    assert.notEqual(reclaimed.owner_id, orphan.owner_id);
  });

  await withTemporaryDirectory("stnl-publisher-lock-symlink-", async (base) => {
    const { target } = await buildResumeFixture(base);
    const outside = path.join(base, "outside.lock");
    await fs.writeFile(outside, "external sentinel\n", "utf8");
    try {
      await fs.symlink(outside, lockPath(target));
    } catch (error) {
      if (linkUnavailable(error)) {
        t.diagnostic(`symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(recoverIncompletePublication(target), /lock must not be a symlink/u);
    assert.equal(await fs.readFile(outside, "utf8"), "external sentinel\n");
  });

  await withTemporaryDirectory("stnl-publisher-lock-hardlink-", async (base) => {
    const { target } = await buildResumeFixture(base);
    const outside = path.join(base, "outside.lock");
    await fs.writeFile(outside, "external sentinel\n", "utf8");
    try {
      await fs.link(outside, lockPath(target));
    } catch (error) {
      if (linkUnavailable(error)) {
        t.diagnostic(`hardlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(recoverIncompletePublication(target), /lock must be a single-link regular file/u);
    assert.equal(await fs.readFile(outside, "utf8"), "external sentinel\n");
    assert.equal((await fs.stat(outside)).nlink, 2);
  });
});

test("final-window source mutations are restored exactly and never overwritten by the candidate", async (t) => {
  for (const action of ["ADD", "MODIFY", "REMOVE", "SYMLINK"]) {
    await t.test(action, async (subtest) => {
      await withTemporaryDirectory(`stnl-publisher-mutation-${action.toLowerCase()}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, { withRaceFiles: true });
        if (action === "SYMLINK") {
          const probe = path.join(base, "symlink-probe");
          try {
            await fs.symlink("missing", probe);
            await fs.unlink(probe);
          } catch (error) {
            if (linkUnavailable(error)) {
              subtest.skip(`symlinks unavailable: ${error.code}`);
              return;
            }
            throw error;
          }
        }
        const result = runCli("RESUME", target, candidate, manifest, {
          environment: {
            [TEST_ONLY_MUTATE_SOURCE_ENV]: action,
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, new RegExp(SOURCE_CONFLICT_DIAGNOSTIC));
        validateWorkspace(target);
        const race = path.join(target, "execution", "publisher-race");
        if (action === "ADD") assert.equal(await fs.readFile(path.join(race, "added.txt"), "utf8"), "concurrent add\n");
        if (action === "MODIFY") assert.equal(await fs.readFile(path.join(race, "modified.txt"), "utf8"), "concurrent modification\n");
        if (action === "REMOVE") await assert.rejects(fs.stat(path.join(race, "removed.txt")), { code: "ENOENT" });
        if (action === "SYMLINK") assert.equal(await fs.readlink(path.join(race, "link-slot.txt")), "modified.txt");
        assert.deepEqual(await transactionResidues(target), []);
        assert.equal(await recoverIncompletePublication(target), false);
      });
    });
  }
});

test("CLOSE requires a fresh attestation and the exact deterministic renderer candidate", async () => {
  await withTemporaryDirectory("stnl-publisher-close-", async (base) => {
    const fixture = await buildResumeFixture(path.join(base, "seed"));
    const target = fixture.target;
    const candidate = path.join(base, "closed candidate");
    const attestation = path.join(base, "readiness attestation.json");
    createReadinessAttestation(target, attestation, { scope: "GLOBAL", verdict: "READY" });
    buildClosedCandidate(target, candidate, { readinessAttestation: attestation });
    const expected = snapshot(candidate);
    const result = runCli("CLOSE", target, candidate, null, {
      readinessAttestation: attestation,
      cwd: path.dirname(base),
    });
    assert.equal(result.status, 0, result.stderr);
    const closed = validateWorkspace(target);
    assert.equal(closed.closed, true);
    assert.equal(snapshot(target), expected);
    assert.deepEqual(await transactionResidues(target), []);
    assert.equal(await fs.stat(attestation).then(() => true, () => false), false);

    const stable = snapshot(target);
    await assert.rejects(
      publishCandidate("CLOSE", target, candidate, { readinessAttestation: attestation }),
      /readiness attestation requires an active ready workspace/u,
    );
    assert.equal(snapshot(target), stable);
    assert.deepEqual(await transactionResidues(target), []);
  });

  await withTemporaryDirectory("stnl-publisher-close-stale-", async (base) => {
    const { target } = await buildResumeFixture(path.join(base, "seed"));
    const candidate = path.join(base, "closed candidate");
    const attestation = path.join(base, "readiness.json");
    createReadinessAttestation(target, attestation, { scope: "GLOBAL", verdict: "READY" });
    buildClosedCandidate(target, candidate, { readinessAttestation: attestation });
    const feature = path.join(target, "feature_spec.md");
    const text = await fs.readFile(feature, "utf8");
    await fs.writeFile(
      feature,
      text.replace(
        "Provide deterministic invitation expiration behavior.\n",
        "Provide deterministic invitation expiration behavior. \n",
      ),
      "utf8",
    );
    const sourceState = snapshot(target);
    const candidateState = snapshot(candidate);
    await assert.rejects(
      publishCandidate("CLOSE", target, candidate, { readinessAttestation: attestation }),
      /readiness attestation is stale; rerun READINESS GLOBAL/u,
    );
    assert.equal(snapshot(target), sourceState);
    assert.equal(snapshot(candidate), candidateState);
    assert.equal(await fs.stat(lockPath(target)).then(() => true, () => false), false);
    assert.deepEqual(await transactionResidues(target), []);
  });

  await withTemporaryDirectory("stnl-publisher-close-noncanonical-", async (base) => {
    const { target } = await buildResumeFixture(path.join(base, "seed"));
    const candidate = path.join(base, "closed candidate");
    const attestation = path.join(base, "readiness.json");
    createReadinessAttestation(target, attestation, { scope: "GLOBAL", verdict: "READY" });
    buildClosedCandidate(target, candidate, { readinessAttestation: attestation });
    const feature = path.join(candidate, "feature_spec.md");
    const text = await fs.readFile(feature, "utf8");
    await fs.writeFile(
      feature,
      text.replace(
        "Provide deterministic invitation expiration behavior.\n",
        "Provide deterministic invitation expiration behavior. \n",
      ),
      "utf8",
    );
    validateWorkspace(candidate);
    const sourceState = snapshot(target);
    await assert.rejects(
      publishCandidate("CLOSE", target, candidate, { readinessAttestation: attestation }),
      /CLOSE candidate is not the exact deterministic rendering of the attested source/u,
    );
    assert.equal(snapshot(target), sourceState);
    assert.deepEqual(await transactionResidues(target), []);
  });

  await withTemporaryDirectory("stnl-publisher-close-receipt-cleanup-race-", async (base) => {
    const { target } = await buildResumeFixture(path.join(base, "seed"));
    const candidate = path.join(base, "closed candidate");
    const attestation = path.join(base, "readiness.json");
    createReadinessAttestation(target, attestation, { scope: "GLOBAL", verdict: "READY" });
    buildClosedCandidate(target, candidate, { readinessAttestation: attestation });
    await assert.rejects(
      publishCandidate("CLOSE", target, candidate, {
        readinessAttestation: attestation,
        beforeAttestationCleanup: async () => {
          await fs.unlink(attestation);
          await fs.writeFile(attestation, "concurrently replaced receipt\n", "utf8");
        },
      }),
      /readiness attestation changed identity before terminal cleanup/u,
    );
    assert.equal(validateWorkspace(target).closed, true);
    assert.equal(await fs.stat(journalPath(target)).then(() => true, () => false), true);
    assert.equal(await fs.readFile(attestation, "utf8"), "concurrently replaced receipt\n");
    assert.equal(await recoverIncompletePublication(target), true);
    assert.equal(validateWorkspace(target).closed, true);
    assert.equal(await fs.readFile(attestation, "utf8"), "concurrently replaced receipt\n");
    assert.deepEqual(await transactionResidues(target), []);
  });

  await withTemporaryDirectory("stnl-publisher-close-receipt-quarantine-race-", async (base) => {
    const { target } = await buildResumeFixture(path.join(base, "seed"));
    const candidate = path.join(base, "closed candidate");
    const attestation = path.join(base, "readiness.json");
    createReadinessAttestation(target, attestation, { scope: "GLOBAL", verdict: "READY" });
    buildClosedCandidate(target, candidate, { readinessAttestation: attestation });
    process.env[TEST_ONLY_MUTATE_WINDOW_ENV] = "ATTESTATION_QUARANTINE_SWAP";
    process.env[TEST_ONLY_ACK_ENV] = TEST_ONLY_ACK;
    try {
      await assert.rejects(
        publishCandidate("CLOSE", target, candidate, { readinessAttestation: attestation }),
        /attestation quarantine changed immediately before terminal removal/u,
      );
    } finally {
      delete process.env[TEST_ONLY_MUTATE_WINDOW_ENV];
      delete process.env[TEST_ONLY_ACK_ENV];
    }
    assert.equal(validateWorkspace(target).closed, true);
    const foreign = (await fs.readdir(base)).find((name) =>
      name.startsWith(".readiness.json.lifecycle-attestation-retired-") &&
      !name.endsWith("test-owned-original"));
    assert.ok(foreign);
    assert.equal(
      await fs.readFile(path.join(base, foreign), "utf8"),
      "foreign attestation quarantine sentinel\n",
    );
    assert.equal((await readJson(journalPath(target))).phase, "committed");
  });
});

test("CLOSE recovery is independent of the ephemeral attestation after journaling", async (t) => {
  for (const [checkpoint, attestationAction, expectedClosed] of [
    ["TARGET_TO_BACKUP_RENAMED", "remove", false],
    ["AFTER_TARGET_VALIDATION", "corrupt", true],
    ["AFTER_ATTESTATION_REMOVAL", "already-removed", true],
  ]) {
    await t.test(checkpoint, async () => {
      await withTemporaryDirectory(`stnl-publisher-close-recovery-${checkpoint.toLowerCase()}-`, async (base) => {
        const { target } = await buildResumeFixture(path.join(base, "seed"));
        const candidate = path.join(base, "closed candidate");
        const attestation = path.join(base, "readiness.json");
        createReadinessAttestation(target, attestation, { scope: "GLOBAL", verdict: "READY" });
        buildClosedCandidate(target, candidate, { readinessAttestation: attestation });
        const sourceState = snapshot(target);
        const candidateState = snapshot(candidate);
        const result = runCli("CLOSE", target, candidate, null, {
          readinessAttestation: attestation,
          environment: {
            [TEST_ONLY_CRASH_ENV]: checkpoint,
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assertKilled(result, checkpoint);
        const journalText = await fs.readFile(journalPath(target), "utf8");
        assert.doesNotMatch(journalText, /readiness|attestation|workspace_identity/u);
        if (attestationAction === "remove") await fs.unlink(attestation);
        else if (attestationAction === "corrupt") {
          await fs.writeFile(attestation, "corrupted ephemeral receipt\n", "utf8");
        } else {
          assert.equal(await fs.stat(attestation).then(() => true, () => false), false);
        }
        assert.equal(await recoverIncompletePublication(target), true);
        const workspace = validateWorkspace(target);
        assert.equal(workspace.closed, expectedClosed);
        assert.equal(snapshot(target), expectedClosed ? candidateState : sourceState);
        assert.deepEqual(await transactionResidues(target), []);
      });
    });
  }
});

test("recovery precedes late candidate and manifest validation", async (t) => {
  for (const missingInput of ["candidate", "manifest"]) {
    await t.test(missingInput, async () => {
      await withTemporaryDirectory(`stnl-publisher-late-${missingInput}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, {
          candidateWhitespaceChange: true,
        });
        const sourceState = snapshot(target);
        const result = runCli("RESUME", target, candidate, manifest, {
          environment: {
            [TEST_ONLY_CRASH_ENV]: "TARGET_TO_BACKUP_RENAMED",
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assertKilled(result, "TARGET_TO_BACKUP_RENAMED");
        if (missingInput === "candidate") await fs.rm(candidate, { recursive: true });
        else await fs.unlink(manifest);
        await assert.rejects(
          publishCandidate("RESUME", target, candidate, { manifestPath: manifest }),
          missingInput === "candidate" ? /candidate must be a real directory/u : /RESUME manifest must be a real file/u,
        );
        validateWorkspace(target);
        assert.equal(snapshot(target), sourceState);
        assert.deepEqual(await transactionResidues(target), []);
        assert.equal(await recoverIncompletePublication(target), false);
      });
    });
  }
});

test("forced rollback and invalid concurrent source preserve the official pre-publication bytes", async () => {
  await withTemporaryDirectory("stnl-publisher-forced-rollback-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base, {
      candidateWhitespaceChange: true,
    });
    const sourceState = snapshot(target);
    const result = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_FORCE_ROLLBACK_ENV]: "1",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /test-only forced rollback requested/u);
    validateWorkspace(target);
    assert.equal(snapshot(target), sourceState);
    assert.deepEqual(await transactionResidues(target), []);
  });

  await withTemporaryDirectory("stnl-publisher-invalid-concurrent-source-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base, { withRaceFiles: true });
    const result = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_MUTATE_SOURCE_ENV]: "INVALID_SCHEMA",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /official target restored but workspace validation failed/u);
    assert.equal(
      await fs.readFile(path.join(target, "feature_spec.md"), "utf8"),
      "temporarily invalid concurrent source bytes\n",
    );
    await assert.rejects(Promise.resolve().then(() => validateWorkspace(target)), ValidationError);
    assert.deepEqual(await transactionResidues(target), []);
    assert.equal(await recoverIncompletePublication(target), false);
  });
});

test("runtime metadata namespace rejects exact, casefold, and Unicode-normalized aliases pre-lock", async () => {
  await withTemporaryDirectory("stnl-publisher-runtime-namespace-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    const targetName = path.basename(target);
    const collisionNames = [
      `.${targetName}.lifecycle-transaction.json`,
      `.${targetName}.lifecycle.lock`,
      `.${targetName}.lifecycle-stage-collision`,
      `.${targetName}.lifecycle-backup-collision`,
      `.${targetName}.lifecycle-journal-tmp-collision`,
      `.${targetName.toUpperCase()}.LIFECYCLE-STAGE-COLLISION`,
    ];
    const sourceState = snapshot(target);
    for (const name of collisionNames) {
      const collision = path.join(path.dirname(target), name);
      await copyTree(candidate, collision);
      await assert.rejects(
        publishCandidate("RESUME", target, collision, { manifestPath: manifest }),
        /candidate collides with target-owned publisher runtime metadata namespace/u,
      );
      assert.equal(snapshot(target), sourceState);
      assert.equal(
        await fs.stat(lockPath(target)).then(() => true, () => false),
        path.resolve(collision) === path.resolve(lockPath(target)),
      );
      await fs.rm(collision, { recursive: true });
    }

    const manifestCollision = path.join(
      path.dirname(target),
      `.${targetName.toUpperCase()}.LIFECYCLE-JOURNAL-TMP-MANIFEST`,
    );
    await fs.copyFile(manifest, manifestCollision);
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, { manifestPath: manifestCollision }),
      /RESUME manifest collides with target-owned publisher runtime metadata namespace/u,
    );
    assert.equal(snapshot(target), sourceState);
    assert.equal(await fs.stat(lockPath(target)).then(() => true, () => false), false);
  });

  await withTemporaryDirectory("stnl-publisher-unicode-namespace-", async (base) => {
    const seed = await buildResumeFixture(path.join(base, "seed"));
    const target = path.join(base, "Cafe\u0301");
    const candidate = path.join(base, "candidate");
    const manifest = path.join(base, "manifest.json");
    await fs.rename(seed.target, target);
    await fs.rename(seed.candidate, candidate);
    await writeResumeManifest(manifest, target);
    const collision = path.join(base, ".Caf\u00e9.lifecycle-stage-collision");
    await copyTree(candidate, collision);
    const before = snapshot(target);
    await assert.rejects(
      publishCandidate("RESUME", target, collision, { manifestPath: manifest }),
      /candidate collides with target-owned publisher runtime metadata namespace/u,
    );
    assert.equal(snapshot(target), before);
    assert.equal(await fs.stat(lockPath(target)).then(() => true, () => false), false);
  });
});

test("byte-identical hardlink swaps are detected before journaling and preserved", async (t) => {
  await withTemporaryDirectory("stnl-publisher-hardlink-swap-", async (base) => {
    const seed = await buildResumeFixture(path.join(base, "seed"));
    const target = seed.target;
    const candidate = path.join(base, "candidate");
    const manifest = path.join(base, "manifest.json");
    const victim = path.join(target, "execution", "victim.txt");
    const external = path.join(base, "external-victim.txt");
    await fs.mkdir(path.dirname(victim), { recursive: true });
    await fs.writeFile(victim, "byte-identical hardlink payload\n", "utf8");
    await fs.writeFile(external, "byte-identical hardlink payload\n", "utf8");
    await copyTree(target, candidate);
    await writeResumeManifest(manifest, target);
    try {
      await publishCandidate("RESUME", target, candidate, {
        manifestPath: manifest,
        beforePublish: async () => {
          await fs.unlink(victim);
          await fs.link(external, victim);
        },
      });
      assert.fail("hardlink swap was accepted");
    } catch (error) {
      if (linkUnavailable(error)) {
        t.skip(`hardlinks unavailable: ${error.code}`);
        return;
      }
      assert.match(error.message, /source changed after candidate validation/u);
    }
    const victimMetadata = await fs.stat(victim, { bigint: true });
    const externalMetadata = await fs.stat(external, { bigint: true });
    assert.equal(victimMetadata.ino, externalMetadata.ino);
    assert.equal(victimMetadata.nlink, 2n);
    assert.equal(await fs.readFile(victim, "utf8"), "byte-identical hardlink payload\n");
    assert.deepEqual(await transactionResidues(target), []);
    assert.equal(await fs.stat(lockPath(target)).then(() => true, () => false), true);
  });
});

test("journal and residue inconsistencies preserve every recovery artifact for inspection", async (t) => {
  for (const corruption of ["missing-stage", "unexpected-residue", "traversal-stage", "lock-transaction-mismatch"]) {
    await t.test(corruption, async () => {
      await withTemporaryDirectory(`stnl-publisher-inconsistent-${corruption}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, {
          candidateWhitespaceChange: true,
        });
        const sourceState = snapshot(target);
        const result = runCli("RESUME", target, candidate, manifest, {
          environment: {
            [TEST_ONLY_CRASH_ENV]: "JOURNAL_PREPARED",
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assertKilled(result, "JOURNAL_PREPARED");
        const journal = await readJson(journalPath(target));
        const stage = path.join(path.dirname(target), journal.stage);
        let expected;
        let extra = null;
        if (corruption === "missing-stage") {
          await fs.rm(stage, { recursive: true });
          expected = /no recoverable source\/stage layout/u;
        } else if (corruption === "unexpected-residue") {
          extra = path.join(
            path.dirname(target),
            `.${path.basename(target)}.lifecycle-stage-${"d".repeat(32)}`,
          );
          await fs.mkdir(extra);
          expected = /transaction journal does not own publisher residues/u;
        } else if (corruption === "traversal-stage") {
          journal.stage = "../outside";
          await fs.writeFile(journalPath(target), `${JSON.stringify(journal)}\n`, "utf8");
          expected = /stage is not the transaction-owned sibling path/u;
        } else {
          const lock = await readJson(lockPath(target));
          lock.transaction_id = "e".repeat(32);
          await fs.writeFile(lockPath(target), `${JSON.stringify(lock)}\n`, "utf8");
          expected = /lock transaction identity does not match the recovery journal/u;
        }
        await assert.rejects(recoverIncompletePublication(target), expected);
        assert.equal(snapshot(target), sourceState);
        assert.equal(await fs.stat(journalPath(target)).then(() => true, () => false), true);
        if (corruption !== "missing-stage") {
          assert.equal(await fs.stat(stage).then(() => true, () => false), true);
        }
        if (extra !== null) assert.equal(await fs.stat(extra).then(() => true, () => false), true);
      });
    });
  }

  await withTemporaryDirectory("stnl-publisher-journal-hardlink-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    const sourceState = snapshot(target);
    const result = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_CRASH_ENV]: "JOURNAL_PREPARED",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assertKilled(result, "JOURNAL_PREPARED");
    const outside = path.join(base, "external-journal.json");
    try {
      await fs.link(journalPath(target), outside);
    } catch (error) {
      if (linkUnavailable(error)) {
        t.diagnostic(`journal hardlink unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      recoverIncompletePublication(target),
      /transaction journal must be a single-link regular file/u,
    );
    assert.equal(snapshot(target), sourceState);
    assert.equal((await fs.stat(outside)).nlink, 2);
  });
});

test("validated orphan lock-update residues are recovered, while foreign-host owners are never stolen", async () => {
  await withTemporaryDirectory("stnl-publisher-lock-update-residue-", async (base) => {
    const { target } = await buildResumeFixture(base);
    assert.equal(await recoverIncompletePublication(target), false);
    const seed = await readJson(lockPath(target));
    const stale = strictLockRecord({
      owner_id: "1".repeat(32),
      operation_id: "2".repeat(32),
      hostname: seed.hostname,
      pid: 2_147_483_647,
    });
    const hostDigest = createHash("sha256")
      .update(stale.hostname, "utf8")
      .digest("hex")
      .slice(0, 16);
    const residue = path.join(
      path.dirname(target),
      `.${path.basename(target)}.lifecycle-lock-tmp-${stale.owner_id}-` +
        `${stale.operation_id}-${stale.pid}-${hostDigest}-${"f".repeat(32)}`,
    );
    await fs.writeFile(residue, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    assert.equal(await recoverIncompletePublication(target), false);
    assert.equal(await fs.stat(residue).then(() => true, () => false), false);
    assert.equal((await readJson(lockPath(target))).state, "released");
  });

  await withTemporaryDirectory("stnl-publisher-foreign-host-lock-", async (base) => {
    const { target } = await buildResumeFixture(base);
    const foreign = strictLockRecord({ hostname: "definitely-another-host.invalid", pid: 2_147_483_647 });
    await writeLock(target, foreign);
    await assert.rejects(
      recoverIncompletePublication(target),
      /another publisher already holds the workspace lock/u,
    );
    assert.deepEqual(await readJson(lockPath(target)), foreign);
  });
});

test("path aliases and malformed journal evidence are rejected without destructive cleanup", async (t) => {
  await withTemporaryDirectory("stnl-publisher-alias-", async (base) => {
    const real = path.join(base, "real");
    await fs.mkdir(real);
    const { target, candidate, manifest } = await buildResumeFixture(real);
    const alias = path.join(base, "alias");
    try {
      await fs.symlink(real, alias, "dir");
    } catch (error) {
      if (linkUnavailable(error)) {
        t.diagnostic(`symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const before = snapshot(target);
    await assert.rejects(
      publishCandidate("RESUME", target, path.join(alias, path.basename(candidate)), { manifestPath: manifest }),
      /candidate must not contain symlink components/u,
    );
    assert.equal(snapshot(target), before);
    assert.equal(await fs.stat(lockPath(target)).then(() => true, () => false), false);
  });

  await withTemporaryDirectory("stnl-publisher-malformed-journal-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base);
    const result = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_CRASH_ENV]: "JOURNAL_PREPARED",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assertKilled(result, "JOURNAL_PREPARED");
    const before = snapshot(target);
    await fs.writeFile(journalPath(target), '{"version":2,"version":2}\n', "utf8");
    await assert.rejects(recoverIncompletePublication(target), /duplicate JSON key 'version'/u);
    assert.equal(snapshot(target), before);
    assert.equal(await fs.stat(journalPath(target)).then(() => true, () => false), true);
    assert.notDeepEqual(await transactionResidues(target), []);
  });

  await withTemporaryDirectory("stnl-publisher-orphan-residue-", async (base) => {
    const { target } = await buildResumeFixture(base);
    const orphan = path.join(path.dirname(target), `.${path.basename(target)}.lifecycle-stage-${"c".repeat(32)}`);
    await fs.mkdir(orphan);
    const before = JSON.stringify(workspaceSnapshot(target));
    await assert.rejects(recoverIncompletePublication(target), /orphan publisher residues require manual inspection/u);
    assert.equal(JSON.stringify(workspaceSnapshot(target)), before);
    assert.equal(await fs.stat(orphan).then(() => true, () => false), true);
  });
});

test("action and lock-release failures are both reported and every lease field is protected", async (t) => {
  const mutations = [
    ["owner_id", "9".repeat(32)],
    ["operation_id", "8".repeat(32)],
    ["transaction_id", "7".repeat(32)],
    ["pid", 2_147_483_647],
    ["hostname", "mutated-host.invalid"],
    ["started_at", "2035-01-01T00:00:00.000Z"],
    ["state", "released"],
    ["inode", null],
  ];
  for (const [field, replacement] of mutations) {
    await t.test(field, async () => {
      await withTemporaryDirectory(`stnl-publisher-lock-lease-${field}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base);
        const before = snapshot(target);
        await assert.rejects(
          publishCandidate("RESUME", target, candidate, {
            manifestPath: manifest,
            beforePublish: async ({ lock }) => {
              const payload = await readJson(lock);
              if (field === "inode") {
                await fs.unlink(lock);
                await fs.writeFile(lock, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
              } else {
                payload[field] = replacement;
                await fs.writeFile(lock, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
              }
              throw new Error(`action sentinel ${field}`);
            },
          }),
          (error) => {
            assert.match(error.message, new RegExp(`workspace action failed: action sentinel ${field}`));
            assert.match(error.message, /workspace lock release also failed/u);
            assert.ok(error.cause instanceof AggregateError);
            assert.equal(error.cause.errors.length, 2);
            return true;
          },
        );
        assert.equal(snapshot(target), before);
        assert.deepEqual(await transactionResidues(target), []);
      });
    });
  }
});

test("pre-journal stage and both atomic lock-claim crash windows recover without manual cleanup", async (t) => {
  for (const checkpoint of [
    "LOCK_BUILD_ALLOCATED",
    "LOCK_TEMP_WRITTEN",
    "LOCK_CLAIM_LINKED",
    "STAGE_ALLOCATED",
    "CANDIDATE_STAGED",
  ]) {
    await t.test(checkpoint, async () => {
      await withTemporaryDirectory(`stnl-publisher-claim-${checkpoint.toLowerCase()}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base);
        const before = snapshot(target);
        const result = runCli("RESUME", target, candidate, manifest, {
          environment: {
            [TEST_ONLY_CRASH_ENV]: checkpoint,
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assertKilled(result, checkpoint);
        assert.equal(await recoverIncompletePublication(target), false);
        assert.equal(snapshot(target), before);
        assert.deepEqual(await transactionResidues(target), []);
        const names = await fs.readdir(path.dirname(target));
        assert.equal(names.some((name) => name.includes("lifecycle-lock-tmp-")), false);
        if (checkpoint === "LOCK_BUILD_ALLOCATED") {
          assert.equal(names.some((name) => name.includes("lifecycle-lock-build-")), true);
          assert.equal(await recoverIncompletePublication(target), false);
        }
      });
    });
  }

  await t.test("truncated foreign claim temp is preserved", async () => {
    await withTemporaryDirectory("stnl-publisher-claim-truncated-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base);
      const result = runCli("RESUME", target, candidate, manifest, {
        environment: {
          [TEST_ONLY_CRASH_ENV]: "LOCK_TEMP_WRITTEN",
          [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
        },
      });
      assertKilled(result, "LOCK_TEMP_WRITTEN");
      const name = (await fs.readdir(path.dirname(target))).find((entry) =>
        entry.includes("lifecycle-lock-tmp-"));
      assert.ok(name);
      const residue = path.join(path.dirname(target), name);
      await fs.writeFile(residue, "foreign truncated sentinel", "utf8");
      await assert.rejects(
        recoverIncompletePublication(target),
        /malformed; preserving untrusted evidence/u,
      );
      assert.equal(await fs.readFile(residue, "utf8"), "foreign truncated sentinel");
    });
  });

  await t.test("claim temp payload/name mismatch is preserved", async () => {
    await withTemporaryDirectory("stnl-publisher-claim-name-mismatch-", async (base) => {
      const { target } = await buildResumeFixture(base);
      assert.equal(await recoverIncompletePublication(target), false);
      const seed = await readJson(lockPath(target));
      const stale = strictLockRecord({
        owner_id: "1".repeat(32),
        operation_id: "2".repeat(32),
        hostname: seed.hostname,
        pid: 2_147_483_647,
      });
      const hostDigest = createHash("sha256").update(stale.hostname).digest("hex").slice(0, 16);
      const residue = path.join(
        path.dirname(target),
        `.${path.basename(target)}.lifecycle-lock-tmp-${"3".repeat(32)}-` +
          `${stale.operation_id}-${stale.pid}-${hostDigest}-${"4".repeat(32)}`,
      );
      await fs.writeFile(residue, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
      await assert.rejects(
        recoverIncompletePublication(target),
        /payload does not match its claim identity/u,
      );
      assert.deepEqual(await readJson(residue), stale);
    });
  });
});

test("recovery lock is transaction-bound across crash, recovery crash, and final recovery", async () => {
  await withTemporaryDirectory("stnl-publisher-triple-recovery-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base, {
      candidateWhitespaceChange: true,
    });
    const sourceState = snapshot(target);
    const first = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_CRASH_ENV]: "TARGET_TO_BACKUP_RENAMED",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assertKilled(first, "TARGET_TO_BACKUP_RENAMED");
    const firstJournal = await readJson(journalPath(target));

    const second = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_CRASH_ENV]: "DURING_ROLLBACK",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assertKilled(second, "DURING_ROLLBACK");
    const recoveryLock = await readJson(lockPath(target));
    const recoveryJournal = await readJson(journalPath(target));
    assert.equal(recoveryLock.transaction_id, firstJournal.transaction_id);
    assert.equal(recoveryJournal.transaction_id, firstJournal.transaction_id);
    assert.equal(recoveryJournal.phase, "rollback_required");

    assert.equal(await recoverIncompletePublication(target), true);
    assert.equal(snapshot(target), sourceState);
    assert.deepEqual(await transactionResidues(target), []);
    assert.equal(await recoverIncompletePublication(target), false);
  });
});

test("lock-residue quarantine is revalidated immediately before deletion", async () => {
  await withTemporaryDirectory("stnl-publisher-lock-residue-quarantine-", async (base) => {
    const { target } = await buildResumeFixture(base);
    assert.equal(await recoverIncompletePublication(target), false);
    const seed = await readJson(lockPath(target));
    const stale = strictLockRecord({
      owner_id: "1".repeat(32),
      operation_id: "2".repeat(32),
      hostname: seed.hostname,
      pid: 2_147_483_647,
    });
    const hostDigest = createHash("sha256").update(stale.hostname).digest("hex").slice(0, 16);
    const residue = path.join(
      path.dirname(target),
      `.${path.basename(target)}.lifecycle-lock-tmp-${stale.owner_id}-` +
        `${stale.operation_id}-${stale.pid}-${hostDigest}-${"f".repeat(32)}`,
    );
    await fs.writeFile(residue, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    process.env[TEST_ONLY_MUTATE_WINDOW_ENV] = "LOCK_RESIDUE_QUARANTINE_SWAP";
    process.env[TEST_ONLY_ACK_ENV] = TEST_ONLY_ACK;
    try {
      await assert.rejects(recoverIncompletePublication(target), /lock is malformed/u);
    } finally {
      delete process.env[TEST_ONLY_MUTATE_WINDOW_ENV];
      delete process.env[TEST_ONLY_ACK_ENV];
    }
    const foreign = (await fs.readdir(path.dirname(target))).find((name) =>
      name.includes("lifecycle-lock-retired-") && !name.endsWith("test-owned-original"));
    assert.ok(foreign);
    assert.equal(
      await fs.readFile(path.join(path.dirname(target), foreign), "utf8"),
      "foreign lock residue quarantine sentinel\n",
    );
  });
});

test("a crash after owned-tree quarantine resumes cleanup without trusting path replacement", async () => {
  await withTemporaryDirectory("stnl-publisher-owned-removal-crash-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base, {
      candidateWhitespaceChange: true,
    });
    const candidateState = snapshot(candidate);
    const result = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_CRASH_ENV]: "DURING_OWNED_REMOVAL",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assertKilled(result, "DURING_OWNED_REMOVAL");
    assert.equal((await readJson(journalPath(target))).phase, "committed");
    assert.ok((await fs.readdir(path.dirname(target))).some((name) =>
      name.includes("lifecycle-retired-tree-")));
    assert.equal(await recoverIncompletePublication(target), true);
    assert.equal(snapshot(target), candidateState);
    assert.deepEqual(await transactionResidues(target), []);
  });
});

test("foreign content added inside a crashed quarantine is preserved and blocks cleanup", async () => {
  await withTemporaryDirectory("stnl-publisher-owned-removal-foreign-content-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base, {
      candidateWhitespaceChange: true,
    });
    const result = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_CRASH_ENV]: "DURING_OWNED_REMOVAL",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assertKilled(result, "DURING_OWNED_REMOVAL");
    const retiredName = (await fs.readdir(path.dirname(target))).find((name) =>
      name.includes("lifecycle-retired-tree-"));
    assert.ok(retiredName);
    const sentinel = path.join(path.dirname(target), retiredName, "foreign-after-crash.txt");
    await fs.writeFile(sentinel, "foreign quarantine content\n", "utf8");
    await assert.rejects(
      recoverIncompletePublication(target),
      /quarantined backup during recovery changed bytes or topology/u,
    );
    assert.equal(await fs.readFile(sentinel, "utf8"), "foreign quarantine content\n");
    assert.equal((await readJson(journalPath(target))).phase, "committed");
  });
});

test("a crash during ownership-sidecar retirement is recovered from the transaction-bound lock", async () => {
  await withTemporaryDirectory("stnl-publisher-ownership-removal-crash-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base, {
      candidateWhitespaceChange: true,
    });
    const candidateState = snapshot(candidate);
    const result = runCli("RESUME", target, candidate, manifest, {
      environment: {
        [TEST_ONLY_CRASH_ENV]: "DURING_OWNERSHIP_REMOVAL",
        [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
      },
    });
    assertKilled(result, "DURING_OWNERSHIP_REMOVAL");
    assert.equal(await fs.stat(journalPath(target)).then(() => true, () => false), false);
    assert.ok((await fs.readdir(path.dirname(target))).some((name) =>
      name.includes("lifecycle-ownership-") && name.includes(".retired-")));
    assert.equal(await recoverIncompletePublication(target), false);
    assert.equal(snapshot(target), candidateState);
    assert.deepEqual(await transactionResidues(target), []);
  });
});

test("prepared source conflicts clean only the owned stage and are idempotent", async () => {
  await withTemporaryDirectory("stnl-publisher-prepared-conflict-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base, { withRaceFiles: true });
    const changed = path.join(target, "execution", "publisher-race", "modified.txt");
    await assert.rejects(
      publishCandidate("RESUME", target, candidate, {
        manifestPath: manifest,
        afterJournalPrepared: async () => {
          await fs.writeFile(changed, "prepared concurrent source mutation\n", "utf8");
        },
      }),
      new RegExp(SOURCE_CONFLICT_DIAGNOSTIC),
    );
    assert.equal(await fs.readFile(changed, "utf8"), "prepared concurrent source mutation\n");
    assert.deepEqual(await transactionResidues(target), []);
    assert.equal(await recoverIncompletePublication(target), false);
  });
});

test("an FD opened before backup rename can mutate the backup and the exact conflict is restored", async () => {
  await withTemporaryDirectory("stnl-publisher-backup-fd-conflict-", async (base) => {
    const { target, candidate, manifest } = await buildResumeFixture(base, { withRaceFiles: true });
    const file = path.join(target, "execution", "publisher-race", "modified.txt");
    const handle = await fs.open(file, "r+");
    try {
      await assert.rejects(
        publishCandidate("RESUME", target, candidate, {
          manifestPath: manifest,
          afterBackupVerified: async () => {
            await handle.truncate(0);
            await handle.writeFile("mutation through pre-opened source FD\n", "utf8");
            await handle.sync();
          },
        }),
        new RegExp(SOURCE_CONFLICT_DIAGNOSTIC),
      );
    } finally {
      await handle.close();
    }
    assert.equal(await fs.readFile(file, "utf8"), "mutation through pre-opened source FD\n");
    assert.deepEqual(await transactionResidues(target), []);
    assert.equal(await recoverIncompletePublication(target), false);
  });
});

test("candidate_validated target mutations roll back safely in normal and crash recovery paths", async (t) => {
  await t.test("normal window", async () => {
    await withTemporaryDirectory("stnl-publisher-target-mutated-normal-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      const sourceState = snapshot(target);
      await assert.rejects(
        publishCandidate("RESUME", target, candidate, {
          manifestPath: manifest,
          afterCandidateValidated: async ({ target: promoted }) => {
            await fs.mkdir(path.join(promoted, "execution"), { recursive: true });
            await fs.writeFile(
              path.join(promoted, "execution", "candidate-window.txt"),
              "mutated candidate window\n",
              "utf8",
            );
          },
        }),
        /transaction candidate changed bytes or topology/u,
      );
      assert.equal(snapshot(target), sourceState);
      assert.deepEqual(await transactionResidues(target), []);
    });
  });

  await t.test("crashed candidate_validated recovery", async () => {
    await withTemporaryDirectory("stnl-publisher-target-mutated-recovery-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      const sourceState = snapshot(target);
      const result = runCli("RESUME", target, candidate, manifest, {
        environment: {
          [TEST_ONLY_CRASH_ENV]: "AFTER_TARGET_VALIDATION",
          [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
        },
      });
      assertKilled(result, "AFTER_TARGET_VALIDATION");
      await fs.mkdir(path.join(target, "execution"), { recursive: true });
      await fs.writeFile(
        path.join(target, "execution", "recovery-window.txt"),
        "mutated after candidate validation crash\n",
        "utf8",
      );
      assert.equal(await recoverIncompletePublication(target), true);
      assert.equal(snapshot(target), sourceState);
      assert.deepEqual(await transactionResidues(target), []);
    });
  });
});

test("committed foreign backup, stage, and quarantine replacements are never deleted", async (t) => {
  await t.test("backup replacement", async () => {
    await withTemporaryDirectory("stnl-publisher-foreign-backup-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      let foreignBackup;
      await assert.rejects(
        publishCandidate("RESUME", target, candidate, {
          manifestPath: manifest,
          beforeCommittedCleanup: async ({ backup }) => {
            await fs.rename(backup, path.join(base, "preserved owned backup"));
            await fs.mkdir(backup);
            foreignBackup = backup;
            await fs.writeFile(path.join(backup, "sentinel.txt"), "foreign backup sentinel\n", "utf8");
          },
        }),
        /transaction source\/backup changed filesystem identity/u,
      );
      assert.equal(await fs.readFile(path.join(foreignBackup, "sentinel.txt"), "utf8"), "foreign backup sentinel\n");
      assert.equal((await readJson(journalPath(target))).phase, "committed");
    });
  });

  await t.test("stage replacement", async () => {
    await withTemporaryDirectory("stnl-publisher-foreign-stage-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      let foreignStage;
      await assert.rejects(
        publishCandidate("RESUME", target, candidate, {
          manifestPath: manifest,
          beforeCommittedCleanup: async ({ stage }) => {
            await fs.mkdir(stage);
            foreignStage = stage;
            await fs.writeFile(path.join(stage, "sentinel.txt"), "foreign stage sentinel\n", "utf8");
          },
        }),
        /transaction-owned stage changed filesystem identity/u,
      );
      assert.equal(await fs.readFile(path.join(foreignStage, "sentinel.txt"), "utf8"), "foreign stage sentinel\n");
      assert.equal((await readJson(journalPath(target))).phase, "committed");
    });
  });

  await t.test("quarantine replacement", async () => {
    await withTemporaryDirectory("stnl-publisher-foreign-quarantine-", async (base) => {
      const { target, candidate, manifest } = await buildResumeFixture(base, {
        candidateWhitespaceChange: true,
      });
      process.env[TEST_ONLY_MUTATE_WINDOW_ENV] = "QUARANTINE_SWAP";
      process.env[TEST_ONLY_ACK_ENV] = TEST_ONLY_ACK;
      try {
        await assert.rejects(
          publishCandidate("RESUME", target, candidate, { manifestPath: manifest }),
          /quarantined backup immediately before removal changed filesystem identity/u,
        );
      } finally {
        delete process.env[TEST_ONLY_MUTATE_WINDOW_ENV];
        delete process.env[TEST_ONLY_ACK_ENV];
      }
      const retired = (await fs.readdir(path.dirname(target))).find((name) =>
        name.includes("lifecycle-retired-tree-") && !name.endsWith("test-owned-original"));
      assert.ok(retired);
      assert.equal(
        await fs.readFile(path.join(path.dirname(target), retired, "foreign-sentinel.txt"), "utf8"),
        "foreign quarantine sentinel\n",
      );
    });
  });
});

test("foreign ownership sidecars and ownership temps never authorize transaction-tree deletion", async (t) => {
  for (const corruption of ["canonical", "temp"]) {
    await t.test(corruption, async () => {
      await withTemporaryDirectory(`stnl-publisher-foreign-ownership-${corruption}-`, async (base) => {
        const { target, candidate, manifest } = await buildResumeFixture(base, {
          candidateWhitespaceChange: true,
        });
        const sourceState = snapshot(target);
        const result = runCli("RESUME", target, candidate, manifest, {
          environment: {
            [TEST_ONLY_CRASH_ENV]: "JOURNAL_PREPARED",
            [TEST_ONLY_ACK_ENV]: TEST_ONLY_ACK,
          },
        });
        assertKilled(result, "JOURNAL_PREPARED");
        const journal = await readJson(journalPath(target));
        const ownershipName = `.${path.basename(target)}.lifecycle-ownership-${journal.transaction_id}.json`;
        const ownership = path.join(path.dirname(target), ownershipName);
        let sentinel = ownership;
        if (corruption === "temp") {
          sentinel = path.join(
            path.dirname(target),
            `.${path.basename(target)}.lifecycle-ownership-tmp-${journal.transaction_id}-${"f".repeat(32)}`,
          );
        }
        await fs.writeFile(sentinel, `foreign ${corruption} ownership sentinel`, "utf8");
        await assert.rejects(
          recoverIncompletePublication(target),
          /transaction ownership.*malformed|transaction ownership root must be a JSON object/u,
        );
        assert.equal(await fs.readFile(sentinel, "utf8"), `foreign ${corruption} ownership sentinel`);
        assert.equal(snapshot(target), sourceState);
        assert.equal(await fs.stat(path.join(path.dirname(target), journal.stage)).then(() => true), true);
      });
    });
  }
});
