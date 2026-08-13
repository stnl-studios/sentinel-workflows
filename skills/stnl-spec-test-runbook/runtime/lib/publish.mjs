import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { assertNoSymlinkComponents, lstatOrNull } from "./core.mjs";

const OWNERSHIP = /<!-- stnl-spec-test-runbook:v1 fingerprint:([0-9a-f]{64}) -->/u;

async function ownedIndex(indexPath) {
  const metadata = await lstatOrNull(indexPath);
  if (metadata === null) return { exists: false, bytes: null };
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`existing runbook index must be a real generated file: ${indexPath}`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`existing runbook index must be a single-link real generated file: ${indexPath}`);
  }
  const bytes = await fs.readFile(indexPath);
  const content = bytes.toString("utf8");
  const match = content.slice(0, 512).match(OWNERSHIP);
  if (match === null) {
    throw new Error(`existing index.html is not owned by stnl-spec-test-runbook and will not be overwritten: ${indexPath}`);
  }
  const fingerprint = match[1];
  const draft = content.replaceAll(fingerprint, "0".repeat(64)).replaceAll(fingerprint.slice(0, 12), "0".repeat(12));
  const actual = createHash("sha256").update(draft, "utf8").digest("hex");
  if (actual !== fingerprint) {
    throw new Error(`existing generated index.html was modified and will not be overwritten: ${indexPath}`);
  }
  return { exists: true, bytes };
}

async function requireOutputDirectory(outputRoot) {
  const resolvedRoot = path.resolve(outputRoot);
  const parent = path.dirname(resolvedRoot);
  await assertNoSymlinkComponents(parent, "runbook output parent");
  let created = false;
  let metadata = await lstatOrNull(outputRoot);
  if (metadata === null) {
    try {
      await fs.mkdir(outputRoot);
      created = true;
      metadata = await fs.lstat(outputRoot);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      metadata = await fs.lstat(outputRoot);
    }
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`runbook output root must be a real directory: ${outputRoot}`);
  }
  await assertNoSymlinkComponents(resolvedRoot, "runbook output root");
  return created;
}

async function createStage(outputRoot, html) {
  for (let counter = 0; counter < 20; counter += 1) {
    const stage = path.join(outputRoot, `.index.html.stnl-${process.pid}-${counter}.tmp`);
    try {
      const handle = await fs.open(stage, "wx", 0o600);
      try {
        await handle.writeFile(html, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return stage;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not allocate a runbook staging file in ${outputRoot}`);
}

export async function publishRunbook(outputRoot, html) {
  const output = path.join(outputRoot, "index.html");
  const createdRoot = await requireOutputDirectory(outputRoot);
  let existing;
  try {
    existing = await ownedIndex(output);
  } catch (error) {
    if (createdRoot) await fs.rmdir(outputRoot).catch(() => {});
    throw error;
  }
  let stage = null;
  try {
    stage = await createStage(outputRoot, html);
    const current = await ownedIndex(output);
    if (current.exists !== existing.exists || (current.exists && !current.bytes.equals(existing.bytes))) {
      throw new Error(`existing runbook changed during regeneration: ${output}`);
    }
    await fs.rename(stage, output);
    stage = null;
    return output;
  } catch (error) {
    if (stage !== null) await fs.unlink(stage).catch(() => {});
    if (createdRoot) await fs.rmdir(outputRoot).catch(() => {});
    throw error;
  }
}

export function hasOwnershipMarker(html) {
  return OWNERSHIP.test(String(html).slice(0, 512));
}
