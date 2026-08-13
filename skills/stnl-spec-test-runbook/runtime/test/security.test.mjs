import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateRunbook } from "../generate-runbook.mjs";
import { publishRunbook } from "../lib/publish.mjs";
import { copyFixture, externalManifest } from "./helpers.mjs";

function ownedHtml() {
  const zeros = "0".repeat(64);
  const draft = `<!doctype html>\n<!-- stnl-spec-test-runbook:v1 fingerprint:${zeros} -->\n<title>Controlled runbook</title>\n`;
  const fingerprint = createHash("sha256").update(draft, "utf8").digest("hex");
  return draft.replace(zeros, fingerprint);
}

test("generator rejects a hard-linked manifest without creating output or changing either link", async (t) => {
  const root = await copyFixture(t, "stnl hardlink manifest fixture ");
  const source = await externalManifest(root, "hardlink-manifest-source.json");
  const linked = path.join(path.dirname(source), "hardlink-manifest-input.json");
  await fs.link(source, linked);
  const before = await fs.readFile(source);

  await assert.rejects(generateRunbook(root, linked), /manifest must be a single-link real file/u);

  assert.deepEqual(await fs.readFile(source), before);
  assert.deepEqual(await fs.readFile(linked), before);
  assert.equal((await fs.lstat(source)).nlink, 2);
  assert.equal(await fs.stat(path.join(root, "test-runbook")).catch(() => null), null);
});

test("publisher rejects a hard-linked controlled index without mutation or staging residue", async (t) => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stnl hardlink index ")));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const outputRoot = path.join(temporary, "test-runbook");
  const external = path.join(temporary, "external-owned-index.html");
  const index = path.join(outputRoot, "index.html");
  const bytes = Buffer.from(ownedHtml(), "utf8");
  await fs.mkdir(outputRoot);
  await fs.writeFile(external, bytes);
  await fs.link(external, index);

  await assert.rejects(
    publishRunbook(outputRoot, ownedHtml()),
    /existing runbook index must be a single-link real generated file/u,
  );

  assert.deepEqual(await fs.readFile(external), bytes);
  assert.deepEqual(await fs.readFile(index), bytes);
  assert.equal((await fs.lstat(index)).nlink, 2);
  assert.deepEqual((await fs.readdir(outputRoot)).sort(), ["index.html"]);
});
