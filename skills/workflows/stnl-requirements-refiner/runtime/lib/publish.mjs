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
import { parseStrictJson } from "./strict-json.mjs";

const OWNERSHIP_BY_VERSION = Object.freeze({
  1: /<!-- stnl-requirements-refiner:v1 fingerprint:([0-9a-f]{64}) -->/u,
  2: /<!-- stnl-requirements-refiner:v2 fingerprint:([0-9a-f]{64}) -->/u,
});
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

function ownershipMarker(version, fingerprint) {
  return `<!-- stnl-requirements-refiner:v${version} fingerprint:${fingerprint} -->`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function ownedHtmlBytes(filePath, expectedVersion, model) {
  await requireSingleLinkRealFile(filePath, "generated refinement index", 8_000_000);
  const bytes = await fs.readFile(filePath);
  const content = decodeUtf8(bytes, "generated refinement index");
  const pattern = OWNERSHIP_BY_VERSION[expectedVersion];
  if (pattern === undefined) throw new ValidationError(`unsupported refinement contract version for ownership validation: ${expectedVersion}`);
  pattern.lastIndex = 0;
  const match = content.slice(0, 512).match(pattern);
  if (match === null) throw new ValidationError(`existing index.html is not owned by stnl-requirements-refiner: ${filePath}`);
  const fingerprint = match[1];
  const marker = ownershipMarker(expectedVersion, fingerprint);
  const footer = `Refinement offline · fingerprint <code>${fingerprint.slice(0, 12)}</code>`;
  const markerIndex = content.indexOf(marker);
  const footerIndex = content.indexOf(footer);
  if (markerIndex < 0 || content.indexOf(marker, markerIndex + 1) >= 0
    || footerIndex < 0 || content.indexOf(footer, footerIndex + 1) >= 0) {
    throw new ValidationError(`existing generated index.html has invalid ownership slots: ${filePath}`);
  }
  let draft = `${content.slice(0, markerIndex)}${ownershipMarker(expectedVersion, "0".repeat(64))}${content.slice(markerIndex + marker.length)}`;
  const adjustedFooter = draft.indexOf(footer);
  draft = `${draft.slice(0, adjustedFooter)}Refinement offline · fingerprint <code>${"0".repeat(12)}</code>${draft.slice(adjustedFooter + footer.length)}`;
  if (createHash("sha256").update(draft, "utf8").digest("hex") !== fingerprint) {
    throw new ValidationError(`existing generated index.html was modified: ${filePath}`);
  }
  if (expectedVersion === 1) {
    const identity = [
      `<title>${escapeHtml(model.title)} · Requirements Refinement</title>`,
      escapeHtml(model.refinement_id),
      `content=\"${escapeHtml(model.summary)}\"`,
    ];
    const renderedTokenGroups = [
      model.refinement_id, model.title, model.summary,
      ...(Array.isArray(model.sources) ? model.sources.filter((item) => item.state === "ACTIVE").flatMap((item) => [item.id, item.label, item.external_id, item.path, item.original_text]) : []),
      ...(Array.isArray(model.needs) ? model.needs.filter((item) => item.state === "ACTIVE").flatMap((item) => [item.id, item.statement]) : []),
      ...(Array.isArray(model.relationships) ? model.relationships.filter((item) => item.state === "ACTIVE").flatMap((item) => [item.id, item.title, item.detail]) : []),
      ...(Array.isArray(model.questions) ? model.questions.flatMap((item) => [item.id, item.question, item.answer]) : []),
      ...(Array.isArray(model.findings) ? model.findings.flatMap((item) => [item.id, item.title, item.problem, item.impact, item.resolution?.proposal, item.resolution?.remaining_gap]) : []),
    ].filter((value) => value !== undefined && value !== null && String(value).length > 0)
      .map((value) => {
        const escaped = escapeHtml(value);
        return [escaped, escaped.replaceAll("\n", "<br>")];
      });
    if (identity.some((value) => !content.includes(value)) || renderedTokenGroups.some((group) => !group.some((value) => content.includes(value)))) {
      throw new ValidationError(`legacy v1 index.html does not match its refinement.json authority: ${filePath}`);
    }
  }
  return { bytes, fingerprint, contractVersion: expectedVersion };
}

async function pairBytes(root, { requireOwned = true, expectedVersion = null } = {}) {
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
  let parsedModel;
  try {
    parsedModel = parseStrictJson(
      decodeUtf8(model, "refinement.json"),
      (key) => `refinement.json contains duplicate JSON key '${key}'`,
      (constant) => `refinement.json contains unsupported JSON constant '${constant}'`,
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`refinement.json is invalid JSON: ${error.message}`);
  }
  const contractVersion = parsedModel?.contract_version;
  if (![1, 2].includes(contractVersion)) throw new ValidationError("refinement.json has an unsupported contract_version");
  if (expectedVersion !== null && contractVersion !== expectedVersion) {
    throw new ValidationError(`refinement pair contract version ${contractVersion} does not match expected version ${expectedVersion}`);
  }
  const htmlPath = path.join(root, HTML_FILENAME);
  const ownedHtml = requireOwned ? await ownedHtmlBytes(htmlPath, contractVersion, parsedModel) : null;
  const html = ownedHtml?.bytes ?? await fs.readFile(htmlPath);
  return {
    model,
    html,
    contractVersion,
    htmlFingerprint: ownedHtml?.fingerprint ?? null,
    digest: sha256(Buffer.concat([model, Buffer.from([0]), html])),
  };
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
    || value.version !== TRANSACTION_VERSION || !["INIT", "RECONCILE", "MIGRATE"].includes(value.mode)
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
  } else if (target === null && new Set(["RECONCILE", "MIGRATE"]).has(journal.mode)) {
    throw new ValidationError(`recovery cannot restore the missing ${journal.mode} target`);
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

export async function inspectPublishedRefinement(context, { allowLegacy = false } = {}) {
  const pair = await pairBytes(context.refinementRoot);
  if (pair === null) return null;
  if (pair.contractVersion === 1 && !allowLegacy) {
    throw new ValidationError("persisted contract v1 is legacy-only; inspect it through the controlled MIGRATE path");
  }
  return {
    ...pair,
    modelFingerprint: `sha256:${sha256(pair.model)}`,
    htmlFingerprint: pair.htmlFingerprint === null ? null : `sha256:${pair.htmlFingerprint}`,
  };
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
  expectedHtmlFingerprint = null,
  expectedAuthoritySnapshot,
  readAuthoritySnapshot,
}) {
  if (!new Set(["INIT", "RECONCILE", "MIGRATE"]).has(operation)) throw new ValidationError(`unsupported refinement operation: ${operation}`);
  const paths = await acquireLock(context);
  let journal = null;
  let unjournaledStage = null;
  try {
    await recoverLocked(context, paths);
    const prior = await pairBytes(context.refinementRoot);
    if (operation === "INIT" && prior !== null) throw new ValidationError(`INIT target already exists: ${context.refinementPath}`);
    if (operation === "RECONCILE") {
      if (prior === null) throw new ValidationError(`RECONCILE target does not exist: ${context.refinementPath}`);
      if (prior.contractVersion !== 2) throw new ValidationError("RECONCILE cannot write a legacy v1 authority; run MIGRATE first");
      if (expectedFingerprint === null || expectedFingerprint !== `sha256:${sha256(prior.model)}`) {
        throw new ValidationError("refinement.json changed after RECONCILE inspection");
      }
    }
    if (operation === "MIGRATE") {
      if (prior === null) throw new ValidationError(`MIGRATE target does not exist: ${context.refinementPath}`);
      if (prior.contractVersion !== 1) throw new ValidationError("MIGRATE requires a persisted v1 authority");
      if (expectedFingerprint === null || expectedFingerprint !== `sha256:${sha256(prior.model)}`) {
        throw new ValidationError("legacy refinement.json changed after MIGRATE inspection");
      }
      if (expectedHtmlFingerprint === null || expectedHtmlFingerprint !== `sha256:${prior.htmlFingerprint}`) {
        throw new ValidationError("legacy index.html changed after MIGRATE inspection");
      }
    }
    const parent = path.dirname(context.refinementRoot);
    const stage = await allocateDirectory(parent, paths.stagePrefix);
    unjournaledStage = stage;
    const backup = path.join(parent, `${paths.backupPrefix}${process.pid}`);
    const staged = await writeStage(stage, modelBytes, html);
    if (staged.contractVersion !== 2) throw new ValidationError(`${operation} must publish a v2 authority`);
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
    if (new Set(["RECONCILE", "MIGRATE"]).has(operation)) await fs.rename(context.refinementRoot, backup);
    await fs.rename(stage, context.refinementRoot);
    await syncDirectory(parent);
    const published = await pairBytes(context.refinementRoot);
    if (published.digest !== staged.digest) throw new ValidationError("published refinement pair failed digest verification");
    if (new Set(["RECONCILE", "MIGRATE"]).has(operation)) await removeTree(backup);
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
  const source = String(html).slice(0, 512);
  const pattern = OWNERSHIP_BY_VERSION[2];
  pattern.lastIndex = 0;
  return pattern.test(source);
}
