import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findNonCanonicalExecutionPaths,
  validateExecutionLayout,
} from "../skills/stnl-execution-closer/runtime/validate-execution-layout.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stnl-execution-layout-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "feature_spec.md"), "# Fixture\n", "utf8");
  const execution = path.join(root, "execution");
  await fs.mkdir(path.join(execution, "plans"), { recursive: true });
  await fs.mkdir(path.join(execution, "tasks"), { recursive: true });
  await fs.writeFile(path.join(execution, "plan.md"), "# Plan\n", "utf8");
  await fs.writeFile(path.join(execution, "tasks.md"), "# Tasks\n", "utf8");
  await fs.writeFile(path.join(execution, "plans", "slice-01.md"), "# Plan 01\n", "utf8");
  await fs.writeFile(path.join(execution, "tasks", "slice-01.md"), "# Task 01\n", "utf8");
  return { root, execution };
}

test("canonical layout passes without creating or changing artifacts", async (t) => {
  const { root, execution } = await fixture(t);
  const before = await fs.readdir(execution);
  await validateExecutionLayout(root);
  assert.deepEqual(await fs.readdir(execution), before);
});

test("auxiliary files and scripts are reported exactly and never deleted", async (t) => {
  const { root, execution } = await fixture(t);
  const residues = [
    path.join(root, "manifest.json"),
    path.join(execution, "slice-03-analysis.md"),
    path.join(execution, "tasks", "slice-04-review-checklist.md"),
    path.join(execution, "helper.mjs"),
  ];
  for (const residue of residues) await fs.writeFile(residue, "owned by fixture\n", "utf8");
  const findings = await findNonCanonicalExecutionPaths(root);
  assert.deepEqual(findings, [...residues].sort());
  await assert.rejects(validateExecutionLayout(root), /non-canonical paths/u);
  for (const residue of residues) {
    assert.equal(await fs.readFile(residue, "utf8"), "owned by fixture\n");
  }
});

test("missing pairs and symlinked canonical names block deterministically", async (t) => {
  const { root, execution } = await fixture(t);
  await fs.unlink(path.join(execution, "tasks", "slice-01.md"));
  await fs.symlink("plan.md", path.join(execution, "scratch-link"));
  const findings = await findNonCanonicalExecutionPaths(root);
  assert.deepEqual(findings, [
    path.join(execution, "scratch-link"),
    path.join(execution, "tasks", "slice-01.md"),
  ].sort());
});

test("CLI is compact, read-only, and invokes no test or runner process", async (t) => {
  const { root, execution } = await fixture(t);
  const residue = path.join(execution, "slice-03-analysis.md");
  await fs.writeFile(residue, "preserve me\n", "utf8");
  const entry = path.resolve(
    "skills/stnl-execution-closer/runtime/validate-execution-layout.mjs",
  );
  const result = spawnSync(process.execPath, [entry, root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.match(result.stderr, new RegExp(residue.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.equal(await fs.readFile(residue, "utf8"), "preserve me\n");
});
