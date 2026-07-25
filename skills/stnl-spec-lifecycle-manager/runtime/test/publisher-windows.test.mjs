import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  filesystemPathForSyscall,
  publishCandidate,
  renameWithRetry,
} from "../lib/publisher.mjs";
import {
  buildResumeFixture,
  removeTemporaryDirectory,
  snapshot,
  temporaryDirectory,
  transactionResidues,
} from "./publisher-fixtures.mjs";

function filesystemError(code) {
  return Object.assign(new Error(code), { code });
}

function win32Absolute(...segments) {
  return path.win32.join(`C:${path.win32.sep}`, ...segments);
}

test("Win32 rename namespaces long paths only at the syscall boundary", async () => {
  const longSegments = Array.from({ length: 24 }, () => "long-directory");
  const source = win32Absolute(...longSegments, "source");
  const destination = win32Absolute(...longSegments, "destination");
  const calls = [];
  await renameWithRetry(source, destination, {
    platform: "win32",
    toNamespacedPath: path.win32.toNamespacedPath,
    rename: async (...arguments_) => calls.push(arguments_),
  });
  assert.deepEqual(calls, [[
    path.win32.toNamespacedPath(source),
    path.win32.toNamespacedPath(destination),
  ]]);
  assert.equal(
    filesystemPathForSyscall(source, {
      platform: "linux",
      toNamespacedPath: path.win32.toNamespacedPath,
    }),
    source,
  );
});

test("Win32 rename retries only transient errors with short deterministic backoff", async () => {
  const calls = [];
  const delays = [];
  await renameWithRetry(win32Absolute("source"), win32Absolute("destination"), {
    platform: "win32",
    toNamespacedPath: path.win32.toNamespacedPath,
    rename: async (...arguments_) => {
      calls.push(arguments_);
      if (calls.length === 1) throw filesystemError("EPERM");
      if (calls.length === 2) throw filesystemError("EBUSY");
    },
    delay: async (milliseconds) => delays.push(milliseconds),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [5, 15]);
});

test("Win32 rename retry is bounded and structural errors are not retried", async () => {
  let transientCalls = 0;
  await assert.rejects(
    renameWithRetry(win32Absolute("source"), win32Absolute("destination"), {
      platform: "win32",
      toNamespacedPath: path.win32.toNamespacedPath,
      rename: async () => {
        transientCalls += 1;
        throw filesystemError("EACCES");
      },
      delay: async () => {},
    }),
    { code: "EACCES" },
  );
  assert.equal(transientCalls, 3);

  let structuralCalls = 0;
  await assert.rejects(
    renameWithRetry(win32Absolute("source"), win32Absolute("destination"), {
      platform: "win32",
      toNamespacedPath: path.win32.toNamespacedPath,
      rename: async () => {
        structuralCalls += 1;
        throw filesystemError("ENOENT");
      },
      delay: async () => {
        throw new Error("structural rename must not back off");
      },
    }),
    { code: "ENOENT" },
  );
  assert.equal(structuralCalls, 1);
});

test("non-Windows rename preserves native paths and existing single-attempt behavior", async () => {
  const calls = [];
  await assert.rejects(
    renameWithRetry("/source", "/destination", {
      platform: "linux",
      toNamespacedPath: () => {
        throw new Error("non-Windows path must not be namespaced");
      },
      rename: async (...arguments_) => {
        calls.push(arguments_);
        throw filesystemError("EPERM");
      },
      delay: async () => {
        throw new Error("non-Windows rename must not retry");
      },
    }),
    { code: "EPERM" },
  );
  assert.deepEqual(calls, [["/source", "/destination"]]);
});

test("real Win32 smoke renames a long path with native APIs", {
  skip: process.platform !== "win32",
}, async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-win32-long-path-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const nested = path.join(base, ...Array.from({ length: 7 }, (_, index) => (
    `segment-${index}-${"x".repeat(32)}`
  )));
  await fs.mkdir(nested, { recursive: true });
  const source = path.join(nested, "source.json");
  const destination = path.join(nested, "destination.json");
  await fs.writeFile(source, "{}\n", "utf8");
  await renameWithRetry(source, destination);
  assert.equal(await fs.readFile(destination, "utf8"), "{}\n");
});

test("a failure before journal promotion leaves the active workspace intact", async (t) => {
  const base = await temporaryDirectory("stnl-publisher-pre-promotion-");
  t.after(() => removeTemporaryDirectory(base));
  const { target, candidate, manifest } = await buildResumeFixture(base);
  const before = snapshot(target);
  await assert.rejects(
    publishCandidate("RESUME", target, candidate, {
      manifestPath: manifest,
      beforePublish: async ({ target: activeTarget }) => {
        assert.equal(snapshot(activeTarget), before);
        throw new Error("fixture structural stop before promotion");
      },
    }),
    /fixture structural stop before promotion/u,
  );
  assert.equal(snapshot(target), before);
  assert.deepEqual(await transactionResidues(target), []);
});
