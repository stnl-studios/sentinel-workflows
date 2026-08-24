import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { candidateFile, FIXTURES, project, representativeRaw, temporary } from "./helpers.mjs";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPOSITORY_ROOT = path.resolve(SKILL_ROOT, "../../..");
const EXPECTED_CASES = new Set([
  "init-default-path", "init-custom-path", "complete-coverage", "overlap-classification",
  "dependency-cycle", "canonical-materialization", "execution-approval-boundary", "browser-state-boundary",
  "stable-reconcile", "stale-reconcile", "transaction-recovery", "unowned-collision", "secret-exposure",
  "xss-content", "deterministic-render", "offline-page", "lifecycle-handoff", "metadata-noise",
]);

test("eval catalog is complete, unique, and distinguishes manual browser evidence", async () => {
  const cases = JSON.parse(await fs.readFile(path.join(SKILL_ROOT, "evals/cases.json"), "utf8"));
  assert.deepEqual(new Set(cases.map((item) => item.id)), EXPECTED_CASES);
  assert.equal(cases.length, EXPECTED_CASES.size);
  assert.equal(cases.every((item) => typeof item.automated === "boolean" && typeof item.expectation === "string" && item.expectation.length > 20), true);
  assert.deepEqual(
    new Set(cases.filter((item) => item.automated === false).map((item) => item.id)),
    new Set(["browser-state-boundary", "offline-page"]),
  );
});

test("roadmap bundles exact lifecycle and execution authority runtimes", async () => {
  for (const name of ["core.mjs", "lifecycle.mjs", "strict-json.mjs", "unicode-casefold.mjs"]) {
    assert.deepEqual(
      await fs.readFile(path.join(SKILL_ROOT, "runtime/lib/lifecycle", name)),
      await fs.readFile(path.join(REPOSITORY_ROOT, "skills/workflows/stnl-spec-lifecycle-manager/runtime/lib", name)),
      name,
    );
  }
  assert.deepEqual(
    await fs.readFile(path.join(SKILL_ROOT, "runtime/execution-state.mjs")),
    await fs.readFile(path.join(REPOSITORY_ROOT, "skills/workflows/stnl-execution-closer/runtime/execution-state.mjs")),
  );
});

test("runtime is self-contained ESM with no network, dynamic code, package, or repository-script dependency", async () => {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".mjs") && !target.includes(`${path.sep}test${path.sep}`)) files.push(target);
    }
  }
  await visit(path.join(SKILL_ROOT, "runtime"));
  const source = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /(?:^|\W)(?:fetch|XMLHttpRequest|WebSocket|eval|Function)\s*\(/u);
  assert.doesNotMatch(source, /node_modules|npm\s+install|(?:\.\.\/){2,}scripts/u);
  assert.doesNotMatch(source, /https?:\/\//u);
});

test("copied skill executes INIT portably without repository-relative imports", async (t) => {
  const copiedRoot = path.join(await temporary(t, "stnl-roadmap-copy-"), "stnl-spec-roadmap");
  await fs.cp(SKILL_ROOT, copiedRoot, { recursive: true });
  const root = await project(t);
  const candidate = await candidateFile(t, await representativeRaw());
  const result = spawnSync(process.execPath, [path.join(copiedRoot, "runtime/generate-roadmap.mjs"), "INIT", root, candidate], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "INITIALIZED");
  assert.match(await fs.readFile(path.join(root, "docs/roadmap/index.html"), "utf8"), /stnl-spec-roadmap:v1 fingerprint/u);
});

test("CLI rejects unsupported operations and ambiguous arity before writes", async (t) => {
  const root = await project(t);
  const inspect = spawnSync(process.execPath, [path.join(SKILL_ROOT, "runtime/inspect-roadmap.mjs"), "CLOSE", root], { encoding: "utf8" });
  assert.equal(inspect.status, 1);
  assert.match(inspect.stderr, /^BLOCKED: unsupported roadmap operation/u);
  const generate = spawnSync(process.execPath, [path.join(SKILL_ROOT, "runtime/generate-roadmap.mjs"), "INIT", root], { encoding: "utf8" });
  assert.equal(generate.status, 2);
  assert.match(generate.stderr, /^usage:/u);
  await assert.rejects(() => fs.stat(path.join(root, "docs/roadmap")), { code: "ENOENT" });
});

test("representative fixture remains strict JSON and includes source-backed coverage", async () => {
  const fixture = JSON.parse(await fs.readFile(path.join(FIXTURES, "representative-roadmap.json"), "utf8"));
  assert.equal(fixture.sources[0].path, "docs/checkout-stories.md");
  assert.equal(fixture.coverage.length, fixture.sources[0].needs.length);
});
