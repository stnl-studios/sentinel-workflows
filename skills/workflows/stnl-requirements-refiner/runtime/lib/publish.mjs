import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  HTML_FILENAME,
  MODEL_FILENAME,
  ValidationError,
  assertNoSymlinkComponents,
  decodeUtf8,
  isIgnoredMetadata,
  lstatOrNull,
  readStrictJsonFile,
  requireSingleLinkRealFile,
  sha256,
} from "./core.mjs";

const OWNERSHIP = /<!-- stnl-requirements-refiner:v1 fingerprint:([0-9a-f]{64}) -->/u;
const TRANSACTION_VERSION = 1;

function transactionPaths(refinementRoot) {
  const parent = path.dirname(refinementRoot);
  const name = path.basename(refinementRoot);
  return {
    lock: path.join(parent, `.${name}.stnl-refinement.lock`),
    retiredLockPrefix: `.${name}.stnl-refinement.lock-retired-`,
    journal: path.join(parent, `.${name}.stnl-refinement.journal.json`),
    stagePrefix: `.${name}.stnl-refinement.stage-`,
    backupPrefix: `.${name}.stnl-refinement.backup-`,
  };
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM", "EACCES"]).has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeExclusive(filePath, content) {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function allocateDirectory(parent, prefix) {
  for (let counter = 0; counter < 50; counter += 1) {
    const candidate = path.join(parent, `${prefix}${process.pid}-${counter}`);
    try {
      await fs.mkdir(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new ValidationError(`could not allocate transaction directory below ${parent}`);
}

async function ensureParent(context) {
  const parent = path.dirname(context.refinementRoot);
  await assertNoSymlinkComponents(parent, "REFINEMENT_PATH parent");
  await fs.mkdir(parent, { recursive: true });
  await assertNoSymlinkComponents(parent, "REFINEMENT_PATH parent");
  const metadata = await fs.lstat(parent);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ValidationError(`REFINEMENT_PATH parent must be a real directory: ${parent}`);
  }
  return parent;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireLock(context) {
  const parent = await ensureParent(context);
  const paths = transactionPaths(context.refinementRoot);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomUUID();
    try {
      await writeExclusive(paths.lock, `${JSON.stringify({ version: 1, pid: process.pid, token })}\n`);
      await syncDirectory(parent);
      const metadata = await fs.lstat(paths.lock);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new ValidationError("refinement publication lock has invalid physical identity");
      }
      return { ...paths, ownership: { token, dev: String(metadata.dev), ino: String(metadata.ino) } };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await requireSingleLinkRealFile(paths.lock, "refinement publication lock", 16_384);
      let lock;
      try {
        lock = JSON.parse(decodeUtf8(await fs.readFile(paths.lock), "refinement publication lock"));
      } catch {
        throw new ValidationError(`refinement publication lock is malformed: ${paths.lock}`);
      }
      const observed = await fs.lstat(paths.lock);
      if (JSON.stringify(Object.keys(lock ?? {}).sort()) !== JSON.stringify(["pid", "token", "version"])
        || lock.version !== 1 || !Number.isSafeInteger(lock.pid) || lock.pid <= 0
        || typeof lock.token !== "string" || !/^[0-9a-f-]{36}$/u.test(lock.token)) {
        throw new ValidationError(`refinement publication lock is malformed: ${paths.lock}`);
      }
      if (processIsAlive(lock.pid)) throw new ValidationError(`refinement publication is already active for ${context.refinementPath}`);
      const rechecked = await lstatOrNull(paths.lock);
      if (rechecked === null) continue;
      if (String(rechecked.dev) !== String(observed.dev) || String(rechecked.ino) !== String(observed.ino)) continue;
      const retired = path.join(parent, `${paths.retiredLockPrefix}${observed.dev}-${observed.ino}-${randomUUID()}`);
      try {
        await fs.rename(paths.lock, retired);
      } catch (failure) {
        if (failure?.code === "ENOENT") continue;
        throw failure;
      }
      await syncDirectory(parent);
      const moved = await fs.lstat(retired);
      const movedBytes = await fs.readFile(retired, "utf8");
      if (String(moved.dev) !== String(observed.dev) || String(moved.ino) !== String(observed.ino)
        || movedBytes !== `${JSON.stringify(lock)}\n`) {
        if (await lstatOrNull(paths.lock) === null) await fs.rename(retired, paths.lock);
        throw new ValidationError("refinement publication lock changed identity during stale-lock retirement");
      }
      if (await lstatOrNull(paths.lock) !== null) {
        await fs.unlink(retired);
        continue;
      }
      await fs.unlink(retired);
      await syncDirectory(parent);
    }
  }
  throw new ValidationError(`could not acquire refinement publication lock for ${context.refinementPath}`);
}

async function ownedHtmlBytes(filePath) {
  await requireSingleLinkRealFile(filePath, "generated refinement index", 8_000_000);
  const bytes = await fs.readFile(filePath);
  const content = decodeUtf8(bytes, "generated refinement index");
  const match = content.slice(0, 512).match(OWNERSHIP);
  if (match === null) throw new ValidationError(`existing index.html is not owned by stnl-requirements-refiner: ${filePath}`);
  const fingerprint = match[1];
  const marker = `<!-- stnl-requirements-refiner:v1 fingerprint:${fingerprint} -->`;
  const footer = `Refinement offline · fingerprint <code>${fingerprint.slice(0, 12)}</code>`;
  const markerIndex = content.indexOf(marker);
  const footerIndex = content.indexOf(footer);
  if (markerIndex < 0 || content.indexOf(marker, markerIndex + 1) >= 0
    || footerIndex < 0 || content.indexOf(footer, footerIndex + 1) >= 0) {
    throw new ValidationError(`existing generated index.html has invalid ownership slots: ${filePath}`);
  }
  let draft = `${content.slice(0, markerIndex)}<!-- stnl-requirements-refiner:v1 fingerprint:${"0".repeat(64)} -->${content.slice(markerIndex + marker.length)}`;
  const adjustedFooter = draft.indexOf(footer);
  draft = `${draft.slice(0, adjustedFooter)}Refinement offline · fingerprint <code>${"0".repeat(12)}</code>${draft.slice(adjustedFooter + footer.length)}`;
  if (createHash("sha256").update(draft, "utf8").digest("hex") !== fingerprint) {
    throw new ValidationError(`existing generated index.html was modified: ${filePath}`);
  }
  return bytes;
}

async function pairBytes(root, { requireOwned = true } = {}) {
  const metadata = await lstatOrNull(root);
  if (metadata === null) return null;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ValidationError(`refinement root must be a real directory: ${root}`);
  await assertNoSymlinkComponents(root, "refinement root");
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => !isIgnoredMetadata(entry.name));
  const names = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([HTML_FILENAME, MODEL_FILENAME].sort())) {
    throw new ValidationError(`refinement root contains non-canonical entries: ${names.join(", ")}`);
  }
  const modelPath = path.join(root, MODEL_FILENAME);
  await requireSingleLinkRealFile(modelPath, "refinement.json");
  const model = await fs.readFile(modelPath);
  const htmlPath = path.join(root, HTML_FILENAME);
  const html = requireOwned ? await ownedHtmlBytes(htmlPath) : await fs.readFile(htmlPath);
  return { model, html, digest: sha256(Buffer.concat([model, Buffer.from([0]), html])) };
}

async function readJournal(filePath, context) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null) return null;
  let value;
  try {
    value = (await readStrictJsonFile(filePath, "refinement transaction journal")).value;
  } catch {
    throw new ValidationError(`refinement transaction journal is malformed: ${filePath}`);
  }
  const expected = ["backup", "mode", "new_digest", "old_digest", "stage", "target", "version"].sort();
  if (JSON.stringify(Object.keys(value ?? {}).sort()) !== JSON.stringify(expected)
    || value.version !== TRANSACTION_VERSION || !["INIT", "RECONCILE"].includes(value.mode)
    || value.target !== context.refinementRoot || !/^[0-9a-f]{64}$/u.test(value.new_digest)
    || !(value.old_digest === null || /^[0-9a-f]{64}$/u.test(value.old_digest))) {
    throw new ValidationError(`refinement transaction journal has invalid fields: ${filePath}`);
  }
  const parent = path.dirname(context.refinementRoot);
  const paths = transactionPaths(context.refinementRoot);
  for (const [label, candidate, prefix] of [["stage", value.stage, paths.stagePrefix], ["backup", value.backup, paths.backupPrefix]]) {
    if (path.dirname(candidate) !== parent || !path.basename(candidate).startsWith(prefix)) {
      throw new ValidationError(`refinement transaction journal has invalid ${label} path`);
    }
  }
  return value;
}

async function removeTree(filePath) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null) return;
  if (metadata.isSymbolicLink()) throw new ValidationError(`refusing to remove symlink transaction path: ${filePath}`);
  await fs.rm(filePath, { recursive: true, force: false });
}

async function recoverLocked(context, paths) {
  const journal = await readJournal(paths.journal, context);
  if (journal === null) return { recovered: false };
  const target = await pairBytes(journal.target);
  const backup = await pairBytes(journal.backup);
  const stage = await pairBytes(journal.stage);
  if (target !== null && !new Set([journal.old_digest, journal.new_digest]).has(target.digest)) {
    throw new ValidationError("recovery found a refinement target with an unexpected digest");
  }
  if (backup !== null && backup.digest !== journal.old_digest) throw new ValidationError("recovery found a refinement backup with an unexpected digest");
  if (stage !== null && stage.digest !== journal.new_digest) throw new ValidationError("recovery found a refinement stage with an unexpected digest");
  if (target?.digest === journal.new_digest) {
    if (backup !== null) await removeTree(journal.backup);
  } else if (backup !== null) {
    if (target !== null) throw new ValidationError("recovery found both the old target and its backup");
    await fs.rename(journal.backup, journal.target);
  } else if (target === null && journal.mode === "RECONCILE") {
    throw new ValidationError("recovery cannot restore the missing RECONCILE target");
  }
  if (stage !== null) await removeTree(journal.stage);
  await fs.unlink(paths.journal);
  await syncDirectory(path.dirname(context.refinementRoot));
  return { recovered: true };
}

async function releaseLock(paths) {
  const metadata = await lstatOrNull(paths.lock);
  if (metadata === null) throw new ValidationError("refinement publication lock disappeared before release");
  let record;
  try {
    record = JSON.parse(decodeUtf8(await fs.readFile(paths.lock), "refinement publication lock"));
  } catch {
    throw new ValidationError("refinement publication lock became malformed before release");
  }
  if (String(metadata.dev) !== paths.ownership.dev || String(metadata.ino) !== paths.ownership.ino
    || record.token !== paths.ownership.token || record.pid !== process.pid || record.version !== 1) {
    throw new ValidationError("refinement publication lock ownership changed before release");
  }
  const parent = path.dirname(paths.lock);
  const retired = path.join(parent, `${paths.retiredLockPrefix}${metadata.dev}-${metadata.ino}-${paths.ownership.token}`);
  await fs.rename(paths.lock, retired);
  await syncDirectory(parent);
  const moved = await fs.lstat(retired);
  if (String(moved.dev) !== paths.ownership.dev || String(moved.ino) !== paths.ownership.ino) {
    if (await lstatOrNull(paths.lock) === null) await fs.rename(retired, paths.lock);
    throw new ValidationError("refinement publication lock changed during release quarantine");
  }
  await fs.unlink(retired);
  await syncDirectory(parent);
}

export async function recoverRefinementPublication(context) {
  const paths = await acquireLock(context);
  try {
    return await recoverLocked(context, paths);
  } finally {
    await releaseLock(paths);
  }
}

export async function inspectPublishedRefinement(context) {
  const pair = await pairBytes(context.refinementRoot);
  if (pair === null) return null;
  return { ...pair, modelFingerprint: `sha256:${sha256(pair.model)}` };
}

async function writeStage(stage, modelBytes, html) {
  await writeExclusive(path.join(stage, MODEL_FILENAME), modelBytes);
  await writeExclusive(path.join(stage, HTML_FILENAME), html);
  await syncDirectory(stage);
  return pairBytes(stage);
}

export async function publishRefinement({
  context,
  operation,
  modelBytes,
  html,
  expectedFingerprint = null,
  expectedAuthoritySnapshot,
  readAuthoritySnapshot,
}) {
  if (!new Set(["INIT", "RECONCILE"]).has(operation)) throw new ValidationError(`unsupported refinement operation: ${operation}`);
  const paths = await acquireLock(context);
  let journal = null;
  let unjournaledStage = null;
  try {
    await recoverLocked(context, paths);
    const prior = await pairBytes(context.refinementRoot);
    if (operation === "INIT" && prior !== null) throw new ValidationError(`INIT target already exists: ${context.refinementPath}`);
    if (operation === "RECONCILE") {
      if (prior === null) throw new ValidationError(`RECONCILE target does not exist: ${context.refinementPath}`);
      if (expectedFingerprint === null || expectedFingerprint !== `sha256:${sha256(prior.model)}`) {
        throw new ValidationError("refinement.json changed after RECONCILE inspection");
      }
    }
    const parent = path.dirname(context.refinementRoot);
    const stage = await allocateDirectory(parent, paths.stagePrefix);
    unjournaledStage = stage;
    const backup = path.join(parent, `${paths.backupPrefix}${process.pid}`);
    const staged = await writeStage(stage, modelBytes, html);
    journal = {
      version: TRANSACTION_VERSION,
      mode: operation,
      target: context.refinementRoot,
      stage,
      backup,
      old_digest: prior?.digest ?? null,
      new_digest: staged.digest,
    };
    await writeExclusive(paths.journal, `${JSON.stringify(journal)}\n`);
    unjournaledStage = null;
    await syncDirectory(parent);
    if (await readAuthoritySnapshot() !== expectedAuthoritySnapshot) {
      throw new ValidationError("inspected repository authority changed before refinement publication");
    }
    const current = await pairBytes(context.refinementRoot);
    if ((prior === null) !== (current === null) || (prior !== null && current.digest !== prior.digest)) {
      throw new ValidationError("refinement target changed during publication");
    }
    if (operation === "RECONCILE") await fs.rename(context.refinementRoot, backup);
    await fs.rename(stage, context.refinementRoot);
    await syncDirectory(parent);
    const published = await pairBytes(context.refinementRoot);
    if (published.digest !== staged.digest) throw new ValidationError("published refinement pair failed digest verification");
    if (operation === "RECONCILE") await removeTree(backup);
    await fs.unlink(paths.journal);
    journal = null;
    await syncDirectory(parent);
    return { modelPath: context.modelPath, htmlPath: context.htmlPath, digest: published.digest };
  } catch (error) {
    if (journal !== null) {
      try {
        await recoverLocked(context, paths);
        journal = null;
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], `refinement publication failed and recovery also failed: ${error.message}`);
      }
    }
    if (unjournaledStage !== null) await removeTree(unjournaledStage);
    throw error;
  } finally {
    await releaseLock(paths);
  }
}

export function hasRefinementOwnershipMarker(html) {
  OWNERSHIP.lastIndex = 0;
  return OWNERSHIP.test(String(html).slice(0, 512));
}
