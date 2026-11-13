import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { REPOSITORY_ROOT, SKILL_ROOT } from "./helpers.mjs";

test("eval catalog contains the complete unique 21-case contract", async () => {
  const cases = JSON.parse(await fs.readFile(path.join(SKILL_ROOT, "evals", "cases.json"), "utf8"));
  const expected = [
    "complete-spec", "explicit-slice", "missing-selection", "traceable-requirements",
    "insufficient-evidence", "reuse-existing-seed", "unnecessary-seed-request", "secret-exposure",
    "xss-content", "regeneration", "explicit-only-close", "blocked-scenario", "combined-test-types",
    "functional-audience", "technical-audience", "presentation-mode", "print-output", "inconsistent-authority",
    "runtime-options", "locale-en-us", "locale-pt-br",
  ];
  assert.deepEqual(cases.map((item) => item.id), expected);
  assert.equal(new Set(cases.map((item) => item.id)).size, 21);
  for (const item of cases) {
    assert.equal(typeof item.expectation, "string");
    assert.equal(typeof item.automated, "boolean");
  }
});

test("runbook invocation accepts approved workflows without making completion implicit approval", async () => {
  const skill = await fs.readFile(path.join(SKILL_ROOT, "SKILL.md"), "utf8");
  assert.match(skill, /requested directly or covered by the approved workflow/u);
  assert.match(skill, /completion alone is not approval to generate/u);
  assert.match(skill, /Generation never executes tests, grants PASS, or invokes CLOSE/u);
  const launcher = await fs.readFile(path.join(REPOSITORY_ROOT, "templates/prompts/spec-test-runbook.md"), "utf8");
  assert.match(launcher, /GENERATE_RUNBOOK/u);
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
