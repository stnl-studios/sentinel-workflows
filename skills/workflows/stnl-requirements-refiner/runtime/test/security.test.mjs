import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { generateRefinement } from "../generate-refinement.mjs";
import { validateRefinement } from "../lib/model.mjs";
import { candidateFile, project, representativeRaw } from "./helpers.mjs";

test("traversal, absolute paths, repository metadata, output authority, and secret paths fail", async () => {
  for (const [pathValue, pattern] of [
    ["../escape", /forbidden path segment/u], ["/tmp/secret", /repository-relative/u], [".git/config", /repository metadata/u],
    ["docs/refinement/input.md", /must not read from REFINEMENT_PATH/u], [".env", /secret-bearing path/u],
  ]) {
    const raw = await representativeRaw();
    raw.sources[0].path = pathValue;
    assert.throws(() => validateRefinement(raw), pattern);
  }
});

test("secret-like content, host paths, real email, and CPF-like PII fail closed", async () => {
  for (const value of [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "Read /Users/alice/private.txt",
    "Contact real.person@corp.internal",
    "CPF 123.456.789-10",
  ]) {
    const raw = await representativeRaw();
    raw.summary = value;
    assert.throws(() => validateRefinement(raw), /secret or credential|absolute host path|real PII/u);
  }
});

test("duplicate JSON keys, invalid UTF-8, hard links, and symlinks block before output", async (t) => {
  const duplicateRoot = await project(t);
  const duplicate = await candidateFile(t, await representativeRaw());
  const source = await fs.readFile(duplicate, "utf8");
  await fs.writeFile(duplicate, source.replace('{\n  "contract_version": 1,', '{\n  "contract_version": 1,\n  "contract_version": 1,'), "utf8");
  await assert.rejects(() => generateRefinement({ operation: "INIT", projectRoot: duplicateRoot, candidatePath: duplicate }), /duplicate JSON key/u);

  const utfRoot = await project(t);
  const invalid = await candidateFile(t, await representativeRaw());
  await fs.writeFile(invalid, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
  await assert.rejects(() => generateRefinement({ operation: "INIT", projectRoot: utfRoot, candidatePath: invalid }), /valid UTF-8/u);

  const hardRoot = await project(t);
  await fs.link(path.join(hardRoot, "src/order.mjs"), path.join(hardRoot, "src/order-copy.mjs"));
  const hardCandidate = await candidateFile(t, await representativeRaw());
  await assert.rejects(() => generateRefinement({ operation: "INIT", projectRoot: hardRoot, candidatePath: hardCandidate }), /single-link real file/u);

  const symlinkRoot = await project(t);
  const outside = path.join(symlinkRoot, "real-refinement");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(symlinkRoot, "docs/refinement"));
  const symlinkCandidate = await candidateFile(t, await representativeRaw());
  await assert.rejects(() => generateRefinement({ operation: "INIT", projectRoot: symlinkRoot, candidatePath: symlinkCandidate }), /symlink component/u);
});

test("OS metadata is ignored without changing the canonical output pair", async (t) => {
  const root = await project(t);
  await fs.writeFile(path.join(root, "docs/.DS_Store"), "noise", "utf8");
  await fs.writeFile(path.join(root, "docs/._noise"), "noise", "utf8");
  const candidate = await candidateFile(t, await representativeRaw());
  await generateRefinement({ operation: "INIT", projectRoot: root, candidatePath: candidate });
  await fs.writeFile(path.join(root, "docs/refinement/.DS_Store"), "noise", "utf8");
  const entries = await fs.readdir(path.join(root, "docs/refinement"));
  assert.deepEqual(entries.filter((name) => !name.startsWith(".")).sort(), ["index.html", "refinement.json"]);
});
