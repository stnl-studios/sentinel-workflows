import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { REPOSITORY_ROOT, SKILL_ROOT } from "./helpers.mjs";

test("eval catalog contains the complete unique 18-case contract", async () => {
  const cases = JSON.parse(await fs.readFile(path.join(SKILL_ROOT, "evals", "cases.json"), "utf8"));
  const expected = [
    "complete-spec", "explicit-slice", "missing-selection", "traceable-requirements",
    "insufficient-evidence", "reuse-existing-seed", "unnecessary-seed-request", "secret-exposure",
    "xss-content", "regeneration", "explicit-only-close", "blocked-scenario", "combined-test-types",
    "functional-audience", "technical-audience", "presentation-mode", "print-output", "inconsistent-authority",
  ];
  assert.deepEqual(cases.map((item) => item.id), expected);
  assert.equal(new Set(cases.map((item) => item.id)).size, 18);
  for (const item of cases) {
    assert.equal(typeof item.expectation, "string");
    assert.equal(typeof item.automated, "boolean");
  }
});

test("generation remains exclusively reachable through its own launcher", async () => {
  const promptRoot = path.join(REPOSITORY_ROOT, "templates", "prompts");
  const files = (await fs.readdir(promptRoot)).filter((name) => name.endsWith(".md"));
  const mentions = [];
  for (const name of files) {
    const content = await fs.readFile(path.join(promptRoot, name), "utf8");
    if (/GENERATE_RUNBOOK|stnl-spec-test-runbook/u.test(content)) mentions.push(name);
  }
  assert.deepEqual(mentions, ["spec-test-runbook.md"]);
  for (const relative of [
    "templates/prompts/execution-close.md", "templates/prompts/spec-close.md",
    "skills/stnl-execution-closer/SKILL.md", "skills/stnl-spec-lifecycle-manager/SKILL.md",
    "skills/stnl-slice-executor/SKILL.md", "skills/stnl-slice-quality-manager/SKILL.md",
  ]) {
    const content = await fs.readFile(path.join(REPOSITORY_ROOT, relative), "utf8");
    assert.equal(/GENERATE_RUNBOOK|stnl-spec-test-runbook/u.test(content), false, `${relative} must not generate a runbook`);
  }
});

test("runbook runtime uses no network, external package, child process, or dynamic code", async () => {
  const runtime = path.join(SKILL_ROOT, "runtime");
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".mjs") && !candidate.includes(`${path.sep}test${path.sep}`)) files.push(candidate);
    }
  }
  await visit(runtime);
  const joined = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");
  for (const forbidden of ["node:child_process", "node:http", "node:https", "fetch(", "eval(", "new Function", "package.json"]) {
    assert.equal(joined.includes(forbidden), false, `runtime contains forbidden capability: ${forbidden}`);
  }
});

