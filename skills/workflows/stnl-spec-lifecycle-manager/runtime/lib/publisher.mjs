import { execFile } from 'node:child_process';
import {
  withExecutionPublicationLock, withLifecycleRecoveryPublicationLock,
  lifecycleCommonLeaseBinding, validateLifecycleCommonLeaseBinding, resolveExecutionFilesystemRoots,
  captureLifecycleRecoveryControl, readOwnedFile, assertLifecycleExecutionUnowned, executionLockIdentity, ensureExecutionMaterialRoot, validateLifecycleLockPayload, assertNoLegacyExecutionControls, assertNoPendingExecutionPublication,validateCurrentOperationAllocationBinding,validateCurrentOperationRetirementRecord,parseStrictJson,validatePreparationRegistry,validateLifecycleRetirementManifest,beginLifecycleTerminalRetirement,validateLifecycleCloseBinding,captureLifecycleRetirementRoles,
} from './execution-publication.mjs';
import {projectCurrentRequirements} from './execution-workspace.mjs';
import {inspectLifecycleTerminalRetirement,acquireLifecycleTerminalRetirementLock,assertLifecycleTerminalRetirementState,
  removeLifecycleTerminalRetirementRole,removeLifecycleTerminalRetirementNamespace,retireLifecycleTerminalRetirementLease,
  finishLifecycleTerminalRetirementSettlement} from './execution-publication.mjs';
import {captureCurrentExecution} from './execution-current-reader.mjs';
import {validateCurrentAbortDisposition} from './execution-current.mjs';
import {restoreCaptureSources,verifyWorkObservation} from './execution-evidence-proof.mjs';
import { constants as FS_CONSTANTS } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  ValidationError,
  canonicalPathWithoutSymlinks,
  filesystemComponentKey,
  isOsMetadata,
  validateCloseTransition, deriveCloseExecutionDisposition,
  validateInitTransition,
  validateReadyPromotionTransition,
  validateResumeTransition,
  validateWorkspace,
  workspaceSnapshot,
} from "./lifecycle.mjs";
import {
  createReadyPromotionAttestation,
  validateReadinessAttestation,
  validateReadyPromotionAttestation,
} from "./readiness.mjs";
import { renderClosedFeature, populateOwnedClosedStage, linkOwnedStageSymlink } from "./closed-spec.mjs";

export const MUTABLE_MODES = new Set(["INIT", "RESUME", "CLOSE"]);
export const JOURNAL_VERSION = 2;
export const PHASE_PREPARED = "prepared";
export const PHASE_BACKUP_CREATED = "backup_created";
export const PHASE_BACKUP_VERIFIED = "backup_verified";
export const PHASE_CANDIDATE_PROMOTED = "candidate_promoted";
export const PHASE_CANDIDATE_VALIDATED = "candidate_validated";
export const PHASE_COMMITTED = "committed";
export const PHASE_ROLLBACK_REQUIRED = "rollback_required";

const TRANSACTION_PHASES = new Set([
  PHASE_PREPARED,
  PHASE_BACKUP_CREATED,
  PHASE_BACKUP_VERIFIED,
  PHASE_CANDIDATE_PROMOTED,
  PHASE_CANDIDATE_VALIDATED,
  PHASE_COMMITTED,
  PHASE_ROLLBACK_REQUIRED,
]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 16 * 1024;
const JOURNAL_TOKEN = Symbol("journalToken");
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_RENAME_BACKOFF_MS = [5, 15];
const DIRECTORY_FSYNC_UNSUPPORTED = new Set([
  "EBADF",
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EISDIR",
  ...(process.platform === "win32" ? ["EPERM", "EACCES"] : []),
]);

export const TEST_ONLY_CRASH_ENV = "STNL_PUBLISHER_TEST_ONLY_CRASH_AT_CHECKPOINT";
export const TEST_ONLY_FORCE_ROLLBACK_ENV = "STNL_PUBLISHER_TEST_ONLY_FORCE_ROLLBACK";
export const TEST_ONLY_MUTATE_SOURCE_ENV =
  "STNL_PUBLISHER_TEST_ONLY_MUTATE_SOURCE_BEFORE_BACKUP_RENAME";
export const TEST_ONLY_MUTATE_WINDOW_ENV =
  "STNL_PUBLISHER_TEST_ONLY_MUTATE_AT_WINDOW";
export const TEST_ONLY_ACK_ENV = "STNL_PUBLISHER_TEST_ONLY_ACKNOWLEDGE_PROCESS_KILL";
export const TEST_ONLY_ACK = "YES_THIS_IS_AN_ISOLATED_PUBLISHER_CRASH_TEST";
export const TEST_ONLY_CHECKPOINTS = new Set([
  "TERMINAL_WITNESS_DURABLE",
  "TERMINAL_LAST_CONTROL_REMOVED",
  "TERMINAL_NAMESPACE_REMOVED",
  "TERMINAL_LEASE_RETIRED",
  "JOURNAL_PREPARED",
  "TARGET_TO_BACKUP_RENAMED",
  "STAGE_TO_TARGET_RENAMED",
  "BEFORE_TARGET_VALIDATION",
  "AFTER_TARGET_VALIDATION",
  "BEFORE_BACKUP_REMOVAL",
  "AFTER_ATTESTATION_REMOVAL",
  "DURING_ROLLBACK",
  "STAGE_ALLOCATED",
  "LOCK_TEMP_WRITTEN",
  "LOCK_CLAIM_LINKED",
  "LOCK_BUILD_ALLOCATED",
  "CANDIDATE_STAGED",
  "DURING_OWNED_REMOVAL",
  "DURING_OWNERSHIP_REMOVAL",
  "JOURNAL_UPDATE_QUARANTINED",
  "JOURNAL_UPDATE_CLAIMED",
  "JOURNAL_UPDATE_READY",
  "JOURNAL_CLEANUP_QUARANTINED",
  "JOURNAL_CREATE_READY",
  "OWNERSHIP_UPDATE_READY",
  "OWNERSHIP_UPDATE_QUARANTINED",
  "OWNERSHIP_UPDATE_CLAIMED",
  "LOCK_UPDATE_READY",
  "LOCK_UPDATE_QUARANTINED",
  "LOCK_UPDATE_CLAIMED",
]);
const TEST_ONLY_SOURCE_MUTATIONS = new Set([
  "ADD",
  "MODIFY",
  "REMOVE",
  "SYMLINK",
  "INVALID_SCHEMA",
]);
const TEST_ONLY_MUTATION_DIRECTORY = path.join("execution", "publisher-race");
const TEST_ONLY_WINDOW_MUTATIONS = new Set([
  "QUARANTINE_SWAP",
  "ATTESTATION_QUARANTINE_SWAP",
  "LOCK_RESIDUE_QUARANTINE_SWAP",
  "OWNERSHIP_UPDATE_CANONICAL_SWAP",
  "LOCK_UPDATE_CANONICAL_SWAP",
  "OWNERSHIP_ROLE_CLEANUP_SWAP",
  "OWNERSHIP_CLEANUP_QUARANTINE_SWAP",
  "LOCK_ROLE_CLEANUP_SWAP",
  "LOCK_RETIRE_QUARANTINE_SWAP",
  "LOCK_CREATE_LIVE_CANONICAL_SWAP",
  "LOCK_CREATE_RECOVERY_CANONICAL_SWAP",
  "OWNERSHIP_CREATE_CLEANUP_SWAP",
  "LOCK_CREATE_CLEANUP_SWAP",
]);
export const SOURCE_CONFLICT_DIAGNOSTIC =
  "source changed during publish; publication aborted; concurrent source preserved";
export const RESTORED_SOURCE_INVALID_DIAGNOSTIC =
  "official target restored but workspace validation failed";

function fail(message, filePath = null) {
  throw new ValidationError(filePath === null ? message : `${message}: ${filePath}`);
}

function randomIdentity() {
  return randomBytes(16).toString("hex");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function filesystemPathForSyscall(
  filePath,
  { platform = process.platform, toNamespacedPath = path.toNamespacedPath } = {},
) {
  return platform === "win32" ? toNamespacedPath(filePath) : filePath;
}

export async function renameWithRetry(
  source,
  destination,
  {
    platform = process.platform,
    rename = fs.rename,
    delay = wait,
    toNamespacedPath = path.toNamespacedPath,
  } = {},
) {
  const syscallSource = filesystemPathForSyscall(source, { platform, toNamespacedPath });
  const syscallDestination = filesystemPathForSyscall(destination, {
    platform,
    toNamespacedPath,
  });
  const attempts = platform === "win32" ? WINDOWS_RENAME_BACKOFF_MS.length + 1 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(syscallSource, syscallDestination);
      return;
    } catch (error) {
      const retry = platform === "win32"
        && WINDOWS_TRANSIENT_RENAME_CODES.has(error?.code)
        && attempt + 1 < attempts;
      if (!retry) throw error;
      await delay(WINDOWS_RENAME_BACKOFF_MS[attempt]);
    }
  }
}

function expandUser(value) {
  const text = String(value);
  if (text === "~") return os.homedir();
  if (text.startsWith(`~${path.sep}`) || (path.sep !== "/" && text.startsWith("~/"))) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

async function lstatOrNull(filePath, options = undefined) {
  try {
    return await fs.lstat(filePath, options);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function lexists(filePath) {
  return (await lstatOrNull(filePath)) !== null;
}

function compareCodePoints(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

async function directoryEntries(directory) {
  return (await fs.readdir(directory)).sort(compareCodePoints);
}

function inodeKey(metadata) {
  return `${metadata.dev.toString()}:${metadata.ino.toString()}`;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removePath(filePath) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    await fs.unlink(filePath);
  } else {
    await fs.rm(filePath, { recursive: true, force: false });
  }
}

async function copyMetadata(sourceMetadata, destination, { directory = false } = {}) {
  if (!sourceMetadata.isSymbolicLink()) {
    await fs.chmod(destination, Number(sourceMetadata.mode & 0o7777n));
    await fs.utimes(destination, sourceMetadata.atime, sourceMetadata.mtime);
  } else if (directory) {
    fail("candidate directory unexpectedly became a symlink", destination);
  }
}

async function copyCandidateEntry(source, destination, linkGroups, stage) {
  const metadata = await fs.lstat(source, { bigint: true });
  const isLink = metadata.isSymbolicLink();
  const isFile = metadata.isFile();
  let key = null;
  let kind = null;
  if (isLink || isFile) {
    kind = isLink ? "symlink" : "file";
    key = inodeKey(metadata);
    const group = metadata.nlink > 1n ? linkGroups.get(key) : null;
    if (group !== null && group !== undefined) {
      if (group.sourceLinkCount !== metadata.nlink || group.kind !== kind) {
        fail("candidate hardlink group changed while staging", source);
      }
      if(kind==='symlink'&&process.platform==='darwin')linkOwnedStageSymlink(stage.root,stage.identity,group.firstStagePath,destination,
        {...group.firstStageIdentity,nlink:String(group.seen),payload:group.payload});
      else await fs.link(group.firstStagePath, destination);
      group.seen += 1n;
      return;
    }
  }
  if (isLink) {
    await fs.symlink(await fs.readlink(source), destination);
    if (metadata.nlink > 1n) {
      const staged=await fs.lstat(destination,{bigint:true});
      linkGroups.set(key, {
        firstStagePath: destination,
        sourceLinkCount: metadata.nlink,
        seen: 1n,
        kind,
        firstStageIdentity:{dev:String(staged.dev),ino:String(staged.ino)},
        payload:isLink?await fs.readlink(destination):null,
      });
    }
    return;
  }
  if (isFile) {
    await fs.copyFile(source, destination, FS_CONSTANTS.COPYFILE_EXCL);
    await copyMetadata(metadata, destination);
    if (metadata.nlink > 1n) {
      const staged=await fs.lstat(destination,{bigint:true});
      linkGroups.set(key, {
        firstStagePath: destination,
        sourceLinkCount: metadata.nlink,
        seen: 1n,
        kind,
        firstStageIdentity:{dev:String(staged.dev),ino:String(staged.ino)},
        payload:isLink?await fs.readlink(destination):null,
      });
    }
    return;
  }
  if (metadata.isDirectory()) {
    await fs.mkdir(destination);
    for (const child of await directoryEntries(source)) {
      await copyCandidateEntry(path.join(source, child), path.join(destination, child), linkGroups,stage);
    }
    await copyMetadata(metadata, destination, { directory: true });
    return;
  }
  fail("candidate contains an unsupported filesystem entry", source);
}

async function copyCandidateTree(candidate, stage, stageIdentity) {
  if ((await fs.readdir(stage)).length !== 0) {
    fail("transaction-owned stage must be empty before candidate copy", stage);
  }
  const linkGroups = new Map();
  for (const child of await directoryEntries(candidate)) {
    await copyCandidateEntry(path.join(candidate, child), path.join(stage, child), linkGroups,{root:stage,identity:stageIdentity});
  }
  for (const group of linkGroups.values()) {
    if (group.seen !== group.sourceLinkCount) {
      fail("candidate hardlink group crosses the publication boundary", candidate);
    }
    const staged = await fs.lstat(group.firstStagePath, { bigint: true });
    if (staged.nlink !== group.sourceLinkCount) {
      fail("staged candidate hardlink topology changed during copy", stage);
    }
  }
  await copyMetadata(await fs.lstat(candidate, { bigint: true }), stage, { directory: true });
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_DIRECTORY ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      fail("expected a real directory for durability synchronization", directory);
    }
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function collectTree(root) {
  const files = [];
  const directories = [root];
  async function visit(directory) {
    for (const name of await directoryEntries(directory)) {
      const child = path.join(directory, name);
      const metadata = await fs.lstat(child);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        directories.push(child);
        await visit(child);
      } else if (metadata.isFile()) {
        files.push(child);
      }
    }
  }
  await visit(root);
  return { files, directories };
}

async function fsyncTree(root) {
  const { files, directories } = await collectTree(root);
  files.sort(compareCodePoints);
  for (const file of files) {
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      fail("staged file changed type while synchronizing", file);
    }
    const handle = await fs.open(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameInode(before, opened)) {
        fail("staged file changed type while synchronizing", file);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  directories.sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
  for (const directory of directories) await fsyncDirectory(directory);
}

function queryLifecycleGitIgnore(productRoot, ignoredPath) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', productRoot, 'check-ignore', '-q', '--', ignoredPath], {
      shell: false, timeout: 10000, maxBuffer: 16384, encoding: 'utf8', windowsHide: true,
    }, error => error ? reject(error) : resolve());
  });
}


// One immutable operation context, local to this invocation. No global registry,
// async-local state, alternate target or cached locator is used.
function lifecyclePublisher(roots,{legacyInspection=false}={}) {
  const policy={productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots};
  const workspace={specRoot:roots.specRoot,executionRoot:roots.executionRoot,filesystemContext:policy};
  const filesystemProof={format:'stnl-lifecycle-filesystem-context-v1',specRoot:roots.specRoot,executionRoot:roots.executionRoot,
    policy,targetParent:{path:roots.targetParent,identity:roots.targetParentIdentity},
    leaseParent:{path:roots.leaseParent,identity:roots.leaseParentIdentity},
    materialParent:{path:roots.materialRoot,identity:roots.materialRootIdentity}};
  function materialParent(target){
    if(target!==roots.specRoot)fail('lifecycle helper target differs from sealed official context',target);
    return roots.materialRoot;
  }
  function assertFilesystemProof(proof){
    if(!proof||typeof proof!=='object'||Array.isArray(proof))fail('lifecycle control lacks its physical context');
    if(JSON.stringify(sortedJsonValue(proof))!==JSON.stringify(sortedJsonValue(filesystemProof)))
      fail('lifecycle physical context differs from persisted control');
  }
  async function assertPhysicalRoles(){
    try {
      const current=await resolveExecutionFilesystemRoots(workspace);
      for(const field of ['specRoot','executionRoot','productRoot','temporaryRoot','materialRoot',
        'targetParentIdentity','leaseParentIdentity','materialRootIdentity'])
        if(JSON.stringify(current[field])!==JSON.stringify(roots[field]))fail('lifecycle physical role changed: '+field);
    }catch(error){error.retainExecutionLock=true;throw error;}
  }
async function durableReplace(source, destination) {
  await assertPhysicalRoles();
  const sourceParent=path.dirname(source),destinationParent=path.dirname(destination);
  const pair=new Set([sourceParent,destinationParent]);
  if(pair.size>1&&!(pair.size===2&&pair.has(roots.targetParent)&&pair.has(roots.materialRoot)))
    fail("critical publication rename has unbound parents");
  if(pair.size===1&&!pair.has(roots.materialRoot))fail("critical control rename has an unbound parent");
  if (await lexists(destination)) {
    fail("critical rename destination unexpectedly exists", destination);
  }
  try{await renameWithRetry(source, destination);
    for(const parent of new Set([sourceParent,destinationParent]))await fsyncDirectory(parent);
    await assertPhysicalRoles();}
  catch(error){error.retainExecutionLock=true;throw error;}
}

function retiredTreePath(target, transactionId, role, identity) {
  return path.join(
    materialParent(target),
    `${retiredTreePrefix(target)}${transactionId}-${role}-${identity.dev}-${identity.ino}`,
  );
}

async function validateOwnedDirectory(filePath, identity, expectedDigest, label) {
  const metadata = await lstatOrNull(filePath, { bigint: true });
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory() ||
      !sameFilesystemIdentity(metadata, identity)) {
    fail(`${label} changed filesystem identity`, filePath);
  }
  if (expectedDigest !== null && await snapshotDigest(filePath) !== expectedDigest) {
    fail(`${label} changed bytes or topology`, filePath);
  }
  return metadata;
}

async function removeOwnedDirectory(target, transactionId, role, filePath, identity, expectedDigest) {
  await assertPhysicalRoles();
  if (identity === null) fail(`transaction has no persisted ${role} filesystem identity`, filePath);
  const retired = retiredTreePath(target, transactionId, role, identity);
  const canonical = await lstatOrNull(filePath, { bigint: true });
  const retiredMetadata = await lstatOrNull(retired, { bigint: true });
  if (canonical !== null && retiredMetadata !== null) {
    fail(`transaction-owned ${role} exists at both canonical and quarantine paths`, materialParent(target));
  }
  if (canonical !== null) {
    await validateOwnedDirectory(filePath, identity, expectedDigest, `transaction-owned ${role}`);
    await durableReplace(filePath, retired);
    await validateOwnedDirectory(retired, identity, expectedDigest, `quarantined ${role}`);
  } else if (retiredMetadata !== null) {
    await validateOwnedDirectory(
      retired,
      identity,
      expectedDigest,
      `quarantined ${role} during recovery`,
    );
  } else {
    return;
  }
  testOnlyCheckpoint("DURING_OWNED_REMOVAL");
  if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] === "QUARANTINE_SWAP") {
    const preserved = `${retired}.test-owned-original`;
    await renameWithRetry(retired, preserved);
    await fs.mkdir(retired);
    await fs.writeFile(path.join(retired, "foreign-sentinel.txt"), "foreign quarantine sentinel\n", "utf8");
  }
  await validateOwnedDirectory(
    retired,
    identity,
    expectedDigest,
    `quarantined ${role} immediately before removal`,
  );
  await removePath(retired);
  await fsyncDirectory(path.dirname(retired));
}

function asciiJson(text) {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    output += code >= 0x80 ? `\\u${code.toString(16).padStart(4, "0")}` : text[index];
  }
  return output;
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      result[key] = sortedJsonValue(value[key]);
    }
    return result;
  }
  return value;
}

function compactAsciiJson(value) {
  return asciiJson(JSON.stringify(value));
}

function prettySortedAsciiJson(value) {
  return `${asciiJson(JSON.stringify(sortedJsonValue(value), null, 2))}\n`;
}

async function snapshotDigest(root) {
  const snapshot = await validateMaybePromise(workspaceSnapshot(root));
  return createHash("sha256").update(compactAsciiJson(snapshot), "utf8").digest("hex");
}

async function walkRelative(root) {
  const result = [];
  async function visit(directory, relativeDirectory) {
    for (const name of await directoryEntries(directory)) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      result.push(relative);
      const metadata = await fs.lstat(absolute);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await visit(absolute, relative);
    }
  }
  await visit(root, "");
  return result;
}

async function rejectCloseCandidateMetadata(root) {
  const forbidden = (await walkRelative(root)).filter((relative) => isOsMetadata(relative));
  forbidden.sort(compareCodePoints);
  if (forbidden.length !== 0) {
    fail(
      `CLOSE candidate contains OS metadata absent from deterministic rendering: ${JSON.stringify(forbidden)}`,
      root,
    );
  }
}

async function requireCandidateSnapshot(filePath, expectedDigest, mode, mismatch) {
  if (mode === "CLOSE") await rejectCloseCandidateMetadata(filePath);
  if ((await snapshotDigest(filePath)) !== expectedDigest) fail(mismatch, filePath);
}

async function captureEphemeralFileIdentity(filePath, label) {
  const before = await fs.lstat(filePath, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) fail(`${label} must remain a single-link regular file`, filePath);
  const handle = await fs.open(filePath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0) | (FS_CONSTANTS.O_NONBLOCK ?? 0));
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n || !sameInode(before, metadata)) {
      fail(`${label} must remain a single-link regular file`, filePath);
    }
    const bytes = await handle.readFile();
    const after = await fs.lstat(filePath, { bigint: true });
    if (!sameInode(metadata, after) || after.nlink !== 1n) {
      fail(`${label} changed identity while being captured`, filePath);
    }
    return { metadata, digest: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}

async function assertEphemeralFileIdentity(filePath, expected, label) {
  const actual = await captureEphemeralFileIdentity(filePath, label);
  if (!sameInode(actual.metadata, expected.metadata)) {
    fail(`${label} changed identity before terminal cleanup`, filePath);
  }
  if (actual.digest !== expected.digest) {
    fail(`${label} changed bytes before terminal cleanup`, filePath);
  }
  return actual;
}

async function removeEphemeralFile(
  filePath,
  expected,
  { label, retirementToken, afterQuarantine = null },
) {
  await assertEphemeralFileIdentity(filePath, expected, label);
  const identity = filesystemIdentity(expected.metadata);
  const retired = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${retirementToken}-${identity.dev}-${identity.ino}-${expected.digest}`,
  );
  if (await lexists(retired)) fail(`${label} quarantine already exists`, retired);
  await renameWithRetry(filePath, retired);
  const moved = await captureEphemeralFileIdentity(retired, label);
  if (!sameInode(moved.metadata, expected.metadata) || moved.digest !== expected.digest) {
    if (!(await lexists(filePath))) await renameWithRetry(retired, filePath);
    fail(`${label} changed identity during terminal quarantine`, filePath);
  }
  if (afterQuarantine !== null) await afterQuarantine(retired);
  const final = await captureEphemeralFileIdentity(retired, label);
  if (!sameInode(final.metadata, expected.metadata) || final.digest !== expected.digest) {
    fail(`${label} quarantine changed immediately before terminal removal`, retired);
  }
  await fs.unlink(retired);
  await fsyncDirectory(path.dirname(filePath));
}

async function captureEphemeralAttestationIdentity(filePath) {
  return captureEphemeralFileIdentity(filePath, "readiness attestation");
}

async function assertEphemeralAttestationIdentity(filePath, expected, point) {
  return assertEphemeralFileIdentity(filePath, expected, "readiness attestation");
}

async function removeEphemeralAttestation(filePath, expected) {
  await removeEphemeralFile(filePath, expected, {
    label: "readiness attestation",
    retirementToken: "lifecycle-attestation-retired",
    afterQuarantine: async (retired) => {
      if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] === "ATTESTATION_QUARANTINE_SWAP") {
        await renameWithRetry(retired, `${retired}.test-owned-original`);
        await fs.writeFile(retired, "foreign attestation quarantine sentinel\n", "utf8");
      }
    },
  });
}

async function removeEphemeralManifest(filePath, expected) {
  await removeEphemeralFile(filePath, expected, {
    label: "RESUME manifest",
    retirementToken: "lifecycle-manifest-retired",
  });
}

function journalPath(target) {
  materialParent(target);return roots.lifecycleJournal;
}

function lockPath(target) {
  materialParent(target);return roots.lifecycleLock;
}

function readinessAttestationPath(target) {
  materialParent(target);return roots.readinessAttestation;
}

function journalTempPrefix(target) {
  return `.${path.basename(target)}.lifecycle-journal-tmp-`;
}

function journalBuildPrefix(target) {
  return `.${path.basename(target)}.lifecycle-journal-build-`;
}

function lockTempPrefix(target) {
  return `.${path.basename(target)}.lifecycle-lock-tmp-`;
}

function lockBuildPrefix(target) {
  return `.${path.basename(target)}.lifecycle-lock-build-`;
}

function lockRetiredPrefix(target) {
  return `.${path.basename(target)}.lifecycle-lock-retired-`;
}

function stagePrefix(target) {
  return `.${path.basename(target)}.lifecycle-stage-`;
}

function backupPrefix(target) {
  return `.${path.basename(target)}.lifecycle-backup-`;
}

function ownershipPrefix(target) {
  return `.${path.basename(target)}.lifecycle-ownership-`;
}

function ownershipTempPrefix(target) {
  return `.${path.basename(target)}.lifecycle-ownership-tmp-`;
}

function ownershipBuildPrefix(target) {
  return `.${path.basename(target)}.lifecycle-ownership-build-`;
}

function ownershipPath(target, transactionId) {
  return path.join(materialParent(target), `${ownershipPrefix(target)}${transactionId}.json`);
}

function retiredTreePrefix(target) {
  return `.${path.basename(target)}.lifecycle-retired-tree-`;
}

async function normalizeTarget(target) {
  const requested = expandUser(target);
  const name = path.basename(requested);
  if (name === "" || name === "." || name === "..") {
    fail("target must name a workspace directory", requested);
  }
  const requestedMetadata = await lstatOrNull(requested);
  if (requestedMetadata?.isSymbolicLink()) fail("target must not be a symlink", requested);
  const normalized = await validateMaybePromise(
    canonicalPathWithoutSymlinks(requested, "target"),
  );
  const parent = path.dirname(normalized);
  const parentMetadata = await lstatOrNull(parent);
  if (parentMetadata?.isSymbolicLink() || !parentMetadata?.isDirectory()) {
    fail("target parent must be a real directory", parent);
  }
  if(normalized!==roots.specRoot)fail('lifecycle target differs from sealed official context',normalized);
  await assertPhysicalRoles();
  return normalized;
}

async function preflightCandidatePath(candidate) {
  const requested = expandUser(candidate);
  const metadata = await lstatOrNull(requested);
  if (metadata?.isSymbolicLink()) fail("candidate must not be a symlink", requested);
  return validateMaybePromise(canonicalPathWithoutSymlinks(requested, "candidate"));
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function preflightManifestPath(
  mode,
  manifestPath,
  target,
  candidate,
  { readyPromotion = false } = {},
) {
  if (mode !== "RESUME") {
    if (manifestPath !== null && manifestPath !== undefined) {
      fail(`--manifest is valid only for RESUME, not ${mode}`);
    }
    return null;
  }
  if (readyPromotion) {
    if (manifestPath !== null && manifestPath !== undefined) {
      fail("ready promotion RESUME uses no external manifest; omit --manifest");
    }
    return null;
  }
  if (manifestPath === null || manifestPath === undefined) {
    fail("RESUME publication requires --manifest PATH");
  }
  const requested = expandUser(manifestPath);
  if ((await lstatOrNull(requested))?.isSymbolicLink()) {
    fail("RESUME manifest must not be a symlink", requested);
  }
  const manifest = await validateMaybePromise(
    canonicalPathWithoutSymlinks(requested, "RESUME manifest"),
  );
  if (isWithin(manifest, target) || isWithin(manifest, candidate)) {
    fail("RESUME manifest must remain outside source and candidate workspaces", manifest);
  }
  return manifest;
}

async function preflightReadinessAttestationPath(mode, readinessAttestation, target, candidate) {
  if(readinessAttestation==='auto') {
    if(mode!=='RESUME')fail('readiness attestation auto is only valid for RESUME draft to ready promotion');
    readinessAttestation=readinessAttestationPath(target);
  }
  if (mode === "INIT") {
    if (readinessAttestation !== null && readinessAttestation !== undefined) {
      fail("--readiness-attestation is valid only for RESUME ready promotion or CLOSE, not INIT");
    }
    return null;
  }
  if (mode === "RESUME" && (readinessAttestation === null || readinessAttestation === undefined)) {
    return null;
  }
  if (mode === "CLOSE" && (readinessAttestation === null || readinessAttestation === undefined)) {
    return null;
  }
  const requested = expandUser(readinessAttestation);
  if ((await lstatOrNull(requested))?.isSymbolicLink()) {
    fail("readiness attestation must not be a symlink", requested);
  }
  const attestation = await validateMaybePromise(
    canonicalPathWithoutSymlinks(requested, "readiness attestation"),
  );
  if (isWithin(attestation, target) || candidate!==null&&isWithin(attestation, candidate)) {
    fail("readiness attestation must remain outside source and candidate workspaces", attestation);
  }
  if (mode === "RESUME" && attestation !== readinessAttestationPath(target)) {
    fail(
      `RESUME ready promotion attestation must use the deterministic sibling path ${readinessAttestationPath(target)}`,
      attestation,
    );
  }
  return attestation;
}

async function validateCandidatePath(candidate) {
  const metadata = await lstatOrNull(candidate);
  if (metadata?.isSymbolicLink() || !metadata?.isDirectory()) {
    fail("candidate must be a real directory", candidate);
  }
}

async function validateManifestPath(manifest) {
  if (manifest === null) return;
  const metadata = await lstatOrNull(manifest);
  if (metadata?.isSymbolicLink() || !metadata?.isFile()) {
    fail("RESUME manifest must be a real file", manifest);
  }
}

function pathComponents(filePath) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  const rest = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  return [parsed.root, ...rest];
}

function validateRuntimeMetadataNamespace(target, inputPath, label) {
  const parentParts = pathComponents(materialParent(target));
  const inputParts = pathComponents(inputPath);
  if (inputParts.length <= parentParts.length) return;
  for (let index = 0; index < parentParts.length; index += 1) {
    if (filesystemComponentKey(parentParts[index]) !== filesystemComponentKey(inputParts[index])) return;
  }
  const siblingName = filesystemComponentKey(inputParts[parentParts.length]);
  const exactNames = new Set([
    filesystemComponentKey(path.basename(journalPath(target))),
    filesystemComponentKey(path.basename(lockPath(target))),
    filesystemComponentKey(path.basename(readinessAttestationPath(target))),
  ]);
  const prefixes = [
    stagePrefix(target),
    backupPrefix(target),
    journalTempPrefix(target),
    journalBuildPrefix(target),
    lockTempPrefix(target),
    lockBuildPrefix(target),
    lockRetiredPrefix(target),
    ownershipPrefix(target),
    ownershipTempPrefix(target),
    ownershipBuildPrefix(target),
    retiredTreePrefix(target),
  ].map(filesystemComponentKey);
  if (exactNames.has(siblingName) || prefixes.some((prefix) => siblingName.startsWith(prefix))) {
    fail(`${label} collides with target-owned publisher runtime metadata namespace`, inputPath);
  }
}

function validateStaticInputRelationships(target, candidate, manifest, readinessAttestation) {
  if (candidate!==null&&(candidate === target || isWithin(candidate, target) || isWithin(target, candidate))) {
    fail("candidate and target must be disjoint directories");
  }
  if(candidate!==null)validateRuntimeMetadataNamespace(target, candidate, "candidate");
  if (manifest !== null) validateRuntimeMetadataNamespace(target, manifest, "RESUME manifest");
  if (
    readinessAttestation !== null
    && readinessAttestation !== readinessAttestationPath(target)
  ) {
    validateRuntimeMetadataNamespace(target, readinessAttestation, "readiness attestation");
  }
}

function validateTestOnlyHookConfiguration(environment = process.env) {
  const checkpoint = environment[TEST_ONLY_CRASH_ENV];
  const forceRollback = environment[TEST_ONLY_FORCE_ROLLBACK_ENV];
  const sourceMutation = environment[TEST_ONLY_MUTATE_SOURCE_ENV];
  const windowMutation = environment[TEST_ONLY_MUTATE_WINDOW_ENV];
  if (checkpoint === undefined && forceRollback === undefined && sourceMutation === undefined &&
      windowMutation === undefined) return;
  if (environment[TEST_ONLY_ACK_ENV] !== TEST_ONLY_ACK) {
    fail("test-only publisher hooks require the exact isolated-crash acknowledgement");
  }
  if (checkpoint !== undefined && !TEST_ONLY_CHECKPOINTS.has(checkpoint)) {
    fail(`unknown test-only publisher crash checkpoint ${JSON.stringify(checkpoint)}`);
  }
  if (forceRollback !== undefined && forceRollback !== "1") {
    fail(`${TEST_ONLY_FORCE_ROLLBACK_ENV} accepts only the explicit value '1'`);
  }
  if (sourceMutation !== undefined && !TEST_ONLY_SOURCE_MUTATIONS.has(sourceMutation)) {
    fail(`unknown test-only source mutation ${JSON.stringify(sourceMutation)}`);
  }
  if (windowMutation !== undefined && !TEST_ONLY_WINDOW_MUTATIONS.has(windowMutation)) {
    fail(`unknown test-only publisher window mutation ${JSON.stringify(windowMutation)}`);
  }
}

function testOnlyCheckpoint(name, environment = process.env) {
  if (environment[TEST_ONLY_CRASH_ENV] !== name) return;
  process.kill(process.pid, "SIGKILL");
  process.abort();
}

function testOnlyForceRollback(environment = process.env) {
  if (environment[TEST_ONLY_FORCE_ROLLBACK_ENV] === "1") {
    fail("test-only forced rollback requested");
  }
}

async function testOnlySwapPrivateFile(filePath, window, label, environment = process.env) {
  if (environment[TEST_ONLY_MUTATE_WINDOW_ENV] !== window) return;
  const preserved = `${filePath}.test-owned-original`;
  await renameWithRetry(filePath, preserved);
  await fs.writeFile(filePath, `foreign ${label} sentinel\n`, { mode: 0o600 });
}

async function testOnlyMutateSourceBeforeBackupRename(target, environment = process.env) {
  const action = environment[TEST_ONLY_MUTATE_SOURCE_ENV];
  if (action === undefined) return;
  const fixture = path.join(target, TEST_ONLY_MUTATION_DIRECTORY);
  const fixtureMetadata = await lstatOrNull(fixture);
  if (fixtureMetadata?.isSymbolicLink() || !fixtureMetadata?.isDirectory()) {
    fail("test-only source mutation fixture directory is missing", fixture);
  }
  const added = path.join(fixture, "added.txt");
  const modified = path.join(fixture, "modified.txt");
  const removed = path.join(fixture, "removed.txt");
  const linkSlot = path.join(fixture, "link-slot.txt");
  if (action === "ADD") {
    if (await lexists(added)) fail("test-only ADD fixture path already exists", added);
    await fs.writeFile(added, "concurrent add\n", "utf8");
  } else if (action === "MODIFY") {
    const metadata = await lstatOrNull(modified);
    if (metadata?.isSymbolicLink() || !metadata?.isFile()) {
      fail("test-only MODIFY fixture path is not a regular file", modified);
    }
    await fs.writeFile(modified, "concurrent modification\n", "utf8");
  } else if (action === "REMOVE") {
    const metadata = await lstatOrNull(removed);
    if (metadata?.isSymbolicLink() || !metadata?.isFile()) {
      fail("test-only REMOVE fixture path is not a regular file", removed);
    }
    await fs.unlink(removed);
  } else if (action === "SYMLINK") {
    const metadata = await lstatOrNull(linkSlot);
    if (metadata?.isSymbolicLink() || !metadata?.isFile()) {
      fail("test-only SYMLINK fixture path is not a regular file", linkSlot);
    }
    await fs.unlink(linkSlot);
    await fs.symlink("modified.txt", linkSlot);
  } else {
    const feature = path.join(target, "feature_spec.md");
    const metadata = await lstatOrNull(feature);
    if (metadata?.isSymbolicLink() || !metadata?.isFile()) {
      fail("test-only INVALID_SCHEMA feature path is not a regular file", feature);
    }
    await fs.writeFile(feature, "temporarily invalid concurrent source bytes\n", "utf8");
  }
}

function parseJsonWithoutDuplicateKeys(text) {
  let cursor = 0;
  function skipWhitespace() {
    while (/[ \t\r\n]/u.test(text[cursor] ?? "")) cursor += 1;
  }
  function parseString() {
    const start = cursor;
    if (text[cursor] !== '"') throw new SyntaxError("expected JSON string");
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === '"') {
        cursor += 1;
        return JSON.parse(text.slice(start, cursor));
      }
      if (text[cursor] === "\\") {
        cursor += 2;
      } else {
        if (text.charCodeAt(cursor) < 0x20) throw new SyntaxError("control character in JSON string");
        cursor += 1;
      }
    }
    throw new SyntaxError("unterminated JSON string");
  }
  function parseValue() {
    skipWhitespace();
    if (text[cursor] === '"') return parseString();
    if (text[cursor] === "{") return parseObject();
    if (text[cursor] === "[") return parseArray();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return value;
      }
    }
    const match = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (match === null) throw new SyntaxError("invalid JSON value");
    cursor += match[0].length;
    return Number(match[0]);
  }
  function parseObject() {
    cursor += 1;
    const result = {};
    const keys = new Set();
    skipWhitespace();
    if (text[cursor] === "}") {
      cursor += 1;
      return result;
    }
    while (true) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) {
        throw new SyntaxError(`duplicate JSON key '${key.replaceAll("'", "\\'")}'`);
      }
      keys.add(key);
      skipWhitespace();
      if (text[cursor] !== ":") throw new SyntaxError("expected ':' after JSON key");
      cursor += 1;
      result[key] = parseValue();
      skipWhitespace();
      if (text[cursor] === "}") {
        cursor += 1;
        return result;
      }
      if (text[cursor] !== ",") throw new SyntaxError("expected ',' in JSON object");
      cursor += 1;
    }
  }
  function parseArray() {
    cursor += 1;
    const result = [];
    skipWhitespace();
    if (text[cursor] === "]") {
      cursor += 1;
      return result;
    }
    while (true) {
      result.push(parseValue());
      skipWhitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return result;
      }
      if (text[cursor] !== ",") throw new SyntaxError("expected ',' in JSON array");
      cursor += 1;
    }
  }
  const value = parseValue();
  skipWhitespace();
  if (cursor !== text.length) throw new SyntaxError("trailing data after JSON value");
  return value;
}

async function readBoundedSingleLinkFile(filePath, maxBytes, label) {
  const before = await lstatOrNull(filePath, { bigint: true });
  if (before === null) return null;
  if (before.isSymbolicLink()) fail(`${label} must not be a symlink`, filePath);
  const handle = await fs.open(filePath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n || !sameInode(before, metadata)) {
      fail(`${label} must be a single-link regular file`, filePath);
    }
    if (metadata.size > BigInt(maxBytes)) fail(`${label} exceeds the safe size limit`, filePath);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail(`${label} exceeds the safe size limit`, filePath);
    return { bytes, metadata };
  } finally {
    await handle.close();
  }
}

async function testOnlySwapExclusiveCreateCandidate(filePath, window, label) {
  if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] !== window) return;
  const preserved = `${filePath}.test-owned-original`;
  await renameWithRetry(filePath, preserved);
  await fs.writeFile(filePath, `foreign ${label} sentinel\n`, { flag: "wx", mode: 0o600 });
  await fsyncDirectory(path.dirname(filePath));
}

async function cleanupExclusiveCreateCandidate(
  filePath,
  expectedMetadata,
  expectedBytes,
  { label, mutationWindow },
) {
  await testOnlySwapExclusiveCreateCandidate(filePath, mutationWindow, label);
  const observed = await readBoundedSingleLinkFile(filePath, expectedBytes.length, label);
  if (observed === null || !sameInode(observed.metadata, expectedMetadata) ||
      !observed.bytes.equals(expectedBytes)) {
    fail(`${label} changed before failed-claim cleanup; preserving evidence`, filePath);
  }
  const quarantine = `${filePath}.cleanup-${expectedMetadata.dev.toString()}-` +
    `${expectedMetadata.ino.toString()}-${randomIdentity()}`;
  await renameWithRetry(filePath, quarantine);
  await fsyncDirectory(path.dirname(filePath));
  const moved = await readBoundedSingleLinkFile(quarantine, expectedBytes.length, label);
  if (moved === null || !sameInode(moved.metadata, expectedMetadata) ||
      !moved.bytes.equals(expectedBytes)) {
    fail(`${label} changed during failed-claim quarantine; preserving evidence`, quarantine);
  }
  const final = await fs.lstat(quarantine, { bigint: true });
  if (!sameInode(final, expectedMetadata) || final.nlink !== 1n) {
    fail(`${label} changed immediately before failed-claim cleanup`, quarantine);
  }
  await fs.unlink(quarantine);
  await fsyncDirectory(path.dirname(filePath));
}

function journalBytes(transaction) {
  return Buffer.from(prettySortedAsciiJson(transactionPayload(transaction)), "utf8");
}

function journalRolePath(
  target,
  transactionId,
  role,
  identity,
  priorIdentity = null,
  priorDigest = null,
) {
  const prior = role === "next"
    ? `-${priorIdentity.dev}-${priorIdentity.ino}-${priorDigest}`
    : "";
  return path.join(
    materialParent(target),
    `${journalTempPrefix(target)}${transactionId}-${role}-${identity.dev}-${identity.ino}${prior}-${randomIdentity()}`,
  );
}

function parseJournalRoleName(target, name) {
  const prefix = journalTempPrefix(target);
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  const next = suffix.match(
    /^([0-9a-f]{32})-next-(\d+)-(\d+)-(\d+)-(\d+)-([0-9a-f]{64})-([0-9a-f]{32})$/u,
  );
  if (next !== null) {
    return {
      transactionId: next[1],
      role: "next",
      identity: { dev: next[2], ino: next[3] },
      priorIdentity: { dev: next[4], ino: next[5] },
      priorDigest: next[6],
    };
  }
  const match = suffix.match(
    /^([0-9a-f]{32})-(create|previous|cleanup)-(\d+)-(\d+)-([0-9a-f]{32})$/u,
  );
  if (match === null) return null;
  return {
    transactionId: match[1],
    role: match[2],
    identity: { dev: match[3], ino: match[4] },
    priorIdentity: null,
    priorDigest: null,
  };
}

function attachJournalToken(transaction, metadata, bytes) {
  transaction[JOURNAL_TOKEN] = {
    identity: filesystemIdentity(metadata),
    bytes: Buffer.from(bytes),
  };
  return transaction;
}

function requireJournalToken(transaction, journal) {
  const token = transaction?.[JOURNAL_TOKEN];
  if (token === undefined || token === null ||
      !Buffer.isBuffer(token.bytes) || token.identity === null) {
    fail("transaction journal ownership identity is unavailable", journal);
  }
  return token;
}

async function readStableJournalRecord(filePath, { allowLinkedClaim = false } = {}) {
  const before = await lstatOrNull(filePath, { bigint: true });
  if (before === null) return null;
  const allowedLinks = allowLinkedClaim ? new Set([1n, 2n]) : new Set([1n]);
  if (before.isSymbolicLink() || !before.isFile() || !allowedLinks.has(before.nlink)) {
    fail(
      allowLinkedClaim
        ? "transaction journal must be a one- or two-link regular file during atomic claim"
        : "transaction journal must be a single-link regular file",
      filePath,
    );
  }
  const handle = await fs.open(filePath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  let bytes;
  let metadata;
  try {
    metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || !allowedLinks.has(metadata.nlink) || !sameInode(before, metadata)) {
      fail("transaction journal changed identity while being read", filePath);
    }
    if (metadata.size > BigInt(MAX_JOURNAL_BYTES)) {
      fail("transaction journal exceeds the safe size limit", filePath);
    }
    bytes = await handle.readFile();
    if (bytes.length > MAX_JOURNAL_BYTES) {
      fail("transaction journal exceeds the safe size limit", filePath);
    }
  } finally {
    await handle.close();
  }
  const after = await lstatOrNull(filePath, { bigint: true });
  if (after === null || !sameInode(metadata, after) || !allowedLinks.has(after.nlink)) {
    fail("transaction journal changed identity after being read", filePath);
  }
  let payload;
  try {
    payload = parseJsonWithoutDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    fail(`transaction journal is malformed (${error.message})`, filePath);
  }
  return { bytes, metadata: after, payload };
}

function assertJournalRecordMatches(record, expected, message, filePath) {
  if (record === null || !sameFilesystemIdentity(record.metadata, expected.identity) ||
      !record.bytes.equals(expected.bytes)) {
    fail(message, filePath);
  }
}

async function assertOwnedJournal(target, transaction, { allowLinkedClaim = false } = {}) {
  await assertPhysicalRoles();
  const journal = journalPath(target);
  const token = requireJournalToken(transaction, journal);
  const record = await readStableJournalRecord(journal, { allowLinkedClaim });
  assertJournalRecordMatches(
    record,
    token,
    "transaction journal changed ownership identity or payload",
    journal,
  );
  return record;
}

async function buildJournalCandidate(
  target,
  transaction,
  bytes,
  role,
  priorIdentity = null,
  priorDigest = null,
) {
  let build = null;
  let handle = null;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = path.join(
        materialParent(target),
        `${journalBuildPrefix(target)}${randomIdentity()}`,
      );
      try {
        handle = await fs.open(candidate, "wx", 0o600);
        build = candidate;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (handle === null || build === null) {
      fail("could not allocate a unique transaction journal temp file", materialParent(target));
    }
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    await handle.close();
    handle = null;
    const temp = journalRolePath(
      target,
      transaction.transactionId,
      role,
      filesystemIdentity(metadata),
      priorIdentity,
      priorDigest,
    );
    await renameWithRetry(build, temp);
    build = null;
    await fsyncDirectory(materialParent(target));
    const record = await readStableJournalRecord(temp);
    assertJournalRecordMatches(
      record,
      { identity: filesystemIdentity(metadata), bytes },
      "transaction journal candidate changed after durable construction",
      temp,
    );
    return { path: temp, record };
  } finally {
    await handle?.close();
    if (build !== null && await lexists(build)) {
      const metadata = await fs.lstat(build);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        fail("journal build path unexpectedly changed type", build);
      }
      await fs.unlink(build);
    }
  }
}

async function validateLinkedJournalClaim(target, linkedPath, expectedIdentity, expectedBytes) {
  const journal = journalPath(target);
  const canonical = await readStableJournalRecord(journal, { allowLinkedClaim: true });
  const linked = await readStableJournalRecord(linkedPath, { allowLinkedClaim: true });
  const expected = { identity: expectedIdentity, bytes: expectedBytes };
  assertJournalRecordMatches(
    canonical,
    expected,
    "transaction journal atomic claim changed before completion",
    journal,
  );
  assertJournalRecordMatches(
    linked,
    expected,
    "transaction journal claim residue changed before completion",
    linkedPath,
  );
  if (!sameInode(canonical.metadata, linked.metadata) ||
      canonical.metadata.nlink !== 2n || linked.metadata.nlink !== 2n) {
    fail("transaction journal atomic claim does not identify one shared file", journal);
  }
  return { canonical, linked };
}

async function settleLinkedJournalClaim(target, linkedPath, expectedIdentity, expectedBytes) {
  const journal = journalPath(target);
  const expected = { identity: expectedIdentity, bytes: expectedBytes };
  const { linked } = await validateLinkedJournalClaim(
    target,
    linkedPath,
    expectedIdentity,
    expectedBytes,
  );
  const finalLinked = await fs.lstat(linkedPath, { bigint: true });
  if (!sameInode(linked.metadata, finalLinked) || finalLinked.nlink !== 2n) {
    fail("transaction journal claim residue changed immediately before settlement", linkedPath);
  }
  await fs.unlink(linkedPath);
  await fsyncDirectory(materialParent(target));
  const installed = await readStableJournalRecord(journal);
  assertJournalRecordMatches(
    installed,
    expected,
    "transaction journal atomic claim was not durably settled",
    journal,
  );
  return installed;
}

async function removeOwnedJournalResidue(filePath, expected, label) {
  const record = await readStableJournalRecord(filePath);
  assertJournalRecordMatches(record, expected, `${label} changed before cleanup`, filePath);
  const final = await fs.lstat(filePath, { bigint: true });
  if (!sameInode(record.metadata, final) || final.nlink !== 1n) {
    fail(`${label} changed immediately before cleanup`, filePath);
  }
  await fs.unlink(filePath);
  await fsyncDirectory(path.dirname(filePath));
}

function journalTransitionCompatible(previous, next) {
  return previous.transactionId === next.transactionId &&
    previous.mode === next.mode &&
    previous.targetName === next.targetName &&
    previous.stageName === next.stageName &&
    previous.backupName === next.backupName &&
    previous.sourceSnapshotSha256 === next.sourceSnapshotSha256 &&
    previous.candidateSnapshotSha256 === next.candidateSnapshotSha256 &&
    compactAsciiJson(previous.closeBinding??null)===compactAsciiJson(next.closeBinding??null) &&
    (previous.phase !== next.phase ||
      previous.observedSourceSnapshotSha256 !== next.observedSourceSnapshotSha256);
}

function journalPriorRecordMatches(next, record) {
  return sameFilesystemIdentity(record.metadata, next.priorIdentity) &&
    createHash("sha256").update(record.bytes).digest("hex") === next.priorDigest;
}

async function journalRoleRecords(target) {
  const records = [];
  for (const name of (await fs.readdir(materialParent(target))).sort(compareCodePoints)) {
    const role = parseJournalRoleName(target, name);
    if (role === null) continue;
    const filePath = path.join(materialParent(target), name);
    const record = await readStableJournalRecord(filePath, { allowLinkedClaim: true });
    assertJournalRecordMatches(
      record,
      { identity: role.identity, bytes: record.bytes },
      "transaction journal recovery residue changed filesystem identity",
      filePath,
    );
    const transaction = parseJournal(target, record.payload);
    if (transaction.transactionId !== role.transactionId) {
      fail("transaction journal recovery residue belongs to a different transaction", filePath);
    }
    records.push({ ...role, filePath, record, transaction });
  }
  return records;
}

async function settleJournalState(target, { validateOnly = false } = {}) {
  await assertPhysicalRoles();
  const journal = journalPath(target);
  const canonicalMetadata = await lstatOrNull(journal, { bigint: true });
  const roles = await journalRoleRecords(target);
  const next = roles.filter((entry) => entry.role === "next");
  const previous = roles.filter((entry) => entry.role === "previous");
  const cleanup = roles.filter((entry) => entry.role === "cleanup");
  const create = roles.filter((entry) => entry.role === "create");
  if (canonicalMetadata !== null) {
    if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isFile() ||
        !new Set([1n, 2n]).has(canonicalMetadata.nlink)) {
      fail("transaction journal changed type or link count during recovery", journal);
    }
    if (canonicalMetadata.nlink === 2n) {
      const linked = roles.filter((entry) => sameInode(canonicalMetadata, entry.record.metadata));
      if (linked.length !== 1) {
        fail("transaction journal must be a single-link regular file", journal);
      }
      const claim = linked[0];
      if (claim.role === "next") {
        if (create.length !== 0 || cleanup.length !== 0 || next.length !== 1 ||
            previous.length > 1) {
          fail("transaction journal atomic update residues are ambiguous", materialParent(target));
        }
        await validateLinkedJournalClaim(
          target,
          claim.filePath,
          claim.identity,
          claim.record.bytes,
        );
        if (previous.length === 1) {
          if (!journalPriorRecordMatches(claim, previous[0].record) ||
              !journalTransitionCompatible(previous[0].transaction, claim.transaction)) {
            fail("transaction journal atomic update residues do not match", materialParent(target));
          }
          if (validateOnly) return claim.transaction;
          await removeOwnedJournalResidue(
            previous[0].filePath,
            { identity: previous[0].identity, bytes: previous[0].record.bytes },
            "previous transaction journal",
          );
        }
      } else if (claim.role === "create") {
        if (roles.length !== 1 || claim.transaction.phase !== PHASE_PREPARED) {
          fail("transaction journal atomic creation residues are ambiguous", materialParent(target));
        }
      } else if (claim.role === "cleanup") {
        if (roles.length !== 1) {
          fail("transaction journal cleanup residues are ambiguous", materialParent(target));
        }
      } else {
        fail("transaction journal atomic claim has an invalid residue role", claim.filePath);
      }
      if (validateOnly) {
        await validateLinkedJournalClaim(target, claim.filePath, claim.identity, claim.record.bytes);
        return claim.transaction;
      }
      await settleLinkedJournalClaim(
        target,
        claim.filePath,
        claim.identity,
        claim.record.bytes,
      );
      return;
    }
    if (roles.length === 0) return validateOnly ? parseJournal(target, (await readStableJournalRecord(journal)).payload) : undefined;
    if (next.length === 1 && previous.length === 0 && create.length === 0 && cleanup.length === 0) {
      const canonical = await readStableJournalRecord(journal);
      if (!journalPriorRecordMatches(next[0], canonical)) {
        fail("transaction journal canonical identity or payload changed before atomic update", journal);
      }
      const canonicalTransaction = parseJournal(target, canonical.payload);
      if (!journalTransitionCompatible(canonicalTransaction, next[0].transaction)) {
        fail("transaction journal candidate does not advance the canonical journal", next[0].filePath);
      }
      if (validateOnly) return canonicalTransaction;
      await removeOwnedJournalResidue(
        next[0].filePath,
        { identity: next[0].identity, bytes: next[0].record.bytes },
        "unclaimed transaction journal update",
      );
      return;
    }
    fail("transaction journal canonical path appeared in an interrupted atomic operation", journal);
  }
  if (roles.length === 0) return null;
  let selected;
  if (create.length === 1 && next.length === 0 && previous.length === 0 && cleanup.length === 0 &&
      create[0].transaction.phase === PHASE_PREPARED) {
    selected = create[0];
  } else if (create.length === 0 && next.length === 1 && previous.length === 1 && cleanup.length === 0 &&
      journalPriorRecordMatches(next[0], previous[0].record) &&
      journalTransitionCompatible(previous[0].transaction, next[0].transaction)) {
    selected = next[0];
  } else if (create.length === 0 && next.length === 0 && previous.length === 0 && cleanup.length === 1) {
    selected = cleanup[0];
  } else {
    fail("transaction journal recovery residues do not describe one recoverable atomic operation", materialParent(target));
  }
  if (validateOnly) return selected.transaction;
  try {
    await fs.link(selected.filePath, journal);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("transaction journal appeared during interrupted-operation recovery", journal);
    }
    throw error;
  }
  await fsyncDirectory(materialParent(target));
  if (selected.role === "next") {
    await validateLinkedJournalClaim(
      target,
      selected.filePath,
      selected.identity,
      selected.record.bytes,
    );
    await removeOwnedJournalResidue(
      previous[0].filePath,
      { identity: previous[0].identity, bytes: previous[0].record.bytes },
      "previous transaction journal",
    );
  }
  await settleLinkedJournalClaim(
    target,
    selected.filePath,
    selected.identity,
    selected.record.bytes,
  );
}

async function writeJournal(target, transaction) {
  await assertPhysicalRoles();
  const journal = journalPath(target);
  const bytes = journalBytes(transaction);
  const token = transaction[JOURNAL_TOKEN] ?? null;
  const candidate = await buildJournalCandidate(
    target,
    transaction,
    bytes,
    token === null ? "create" : "next",
    token?.identity ?? null,
    token === null ? null : createHash("sha256").update(token.bytes).digest("hex"),
  );
  if (token === null) {
    testOnlyCheckpoint("JOURNAL_CREATE_READY");
    if (await lexists(journal)) {
      await removeOwnedJournalResidue(
        candidate.path,
        { identity: filesystemIdentity(candidate.record.metadata), bytes },
        "unclaimed transaction journal candidate",
      );
      fail("transaction journal appeared during exclusive creation", journal);
    }
    try {
      await fs.link(candidate.path, journal);
    } catch (error) {
      if (error?.code === "EEXIST") {
        await removeOwnedJournalResidue(
          candidate.path,
          { identity: filesystemIdentity(candidate.record.metadata), bytes },
          "unclaimed transaction journal candidate",
        );
        fail("transaction journal appeared during exclusive creation", journal);
      }
      throw error;
    }
    await fsyncDirectory(materialParent(target));
    const installed = await settleLinkedJournalClaim(
      target,
      candidate.path,
      filesystemIdentity(candidate.record.metadata),
      bytes,
    );
    return attachJournalToken(transaction, installed.metadata, installed.bytes);
  }

  testOnlyCheckpoint("JOURNAL_UPDATE_READY");
  await assertOwnedJournal(target, transaction);
  const previousPath = journalRolePath(
    target,
    transaction.transactionId,
    "previous",
    token.identity,
  );
  await renameWithRetry(journal, previousPath);
  await fsyncDirectory(materialParent(target));
  const previous = await readStableJournalRecord(previousPath);
  assertJournalRecordMatches(
    previous,
    token,
    "transaction journal changed ownership during atomic update quarantine",
    previousPath,
  );
  testOnlyCheckpoint("JOURNAL_UPDATE_QUARANTINED");
  if (await lexists(journal)) {
    fail("transaction journal was replaced during atomic update", journal);
  }
  try {
    await fs.link(candidate.path, journal);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("transaction journal was replaced during atomic update", journal);
    }
    throw error;
  }
  await fsyncDirectory(materialParent(target));
  testOnlyCheckpoint("JOURNAL_UPDATE_CLAIMED");
  await validateLinkedJournalClaim(
    target,
    candidate.path,
    filesystemIdentity(candidate.record.metadata),
    bytes,
  );
  await removeOwnedJournalResidue(
    previousPath,
    token,
    "previous transaction journal",
  );
  const installed = await settleLinkedJournalClaim(
    target,
    candidate.path,
    filesystemIdentity(candidate.record.metadata),
    bytes,
  );
  return attachJournalToken(transaction, installed.metadata, installed.bytes);
}

function filesystemIdentity(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}

function sameFilesystemIdentity(metadata, identity) {
  return identity !== null && metadata.dev.toString() === identity.dev &&
    metadata.ino.toString() === identity.ino;
}

function ownershipPayload(ownership) {
  return {filesystem_context:filesystemProof,
    version: 1,
    mode: ownership.mode,
    target: ownership.targetName,
    stage: ownership.stageName,
    backup: ownership.backupName,
    transaction_id: ownership.transactionId,
    stage_identity: ownership.stageIdentity,
    candidate_snapshot_sha256: ownership.candidateSnapshotSha256,
    source_identity: ownership.sourceIdentity,
    source_snapshot_sha256: ownership.sourceSnapshotSha256,
    backup_identity: ownership.backupIdentity,
    promoted_identity: ownership.promotedIdentity,
    ...(ownership.mode==='CLOSE'?{close_binding:ownership.closeBinding??null}:{}),
  };
}

function parseIdentity(value, field, filePath) {
  if (value === null) return null;
  if (Array.isArray(value) || typeof value !== "object") {
    fail(`transaction ownership field ${field} must be an identity object`, filePath);
  }
  exactKeys(value, ["dev", "ino"], `transaction ownership ${field}`, filePath);
  if (typeof value.dev !== "string" || !/^\d+$/u.test(value.dev) ||
      typeof value.ino !== "string" || !/^\d+$/u.test(value.ino)) {
    fail(`transaction ownership field ${field} has an invalid filesystem identity`, filePath);
  }
  return { dev: value.dev, ino: value.ino };
}

function parseOwnership(target, transactionId, payload) {
  assertFilesystemProof(payload?.filesystem_context);
  const filePath = ownershipPath(target, transactionId);
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    fail("transaction ownership root must be a JSON object", filePath);
  }
  exactKeys(payload, [
    "filesystem_context",
    "version", "mode", "target", "stage", "backup", "transaction_id",
    "stage_identity", "candidate_snapshot_sha256", "source_identity",
    "source_snapshot_sha256", "backup_identity", "promoted_identity",
    ...(payload.mode==='CLOSE'?['close_binding']:[]),
  ], "transaction ownership", filePath);
  if (payload.version !== 1) fail("unsupported transaction ownership version", filePath);
  if (!MUTABLE_MODES.has(payload.mode)) fail("transaction ownership has an invalid mode", filePath);
  if (payload.target !== path.basename(target) || payload.transaction_id !== transactionId) {
    fail("transaction ownership identity does not match the requested workspace", filePath);
  }
  if (payload.stage !== `${stagePrefix(target)}${transactionId}`) {
    fail("transaction ownership stage is not the transaction-owned sibling path", filePath);
  }
  const expectedBackup = payload.mode === "INIT" ? null : `${backupPrefix(target)}${transactionId}`;
  if (payload.backup !== expectedBackup) {
    fail("transaction ownership backup is not the transaction-owned sibling path", filePath);
  }
  for (const field of ["candidate_snapshot_sha256", "source_snapshot_sha256"]) {
    if (payload[field] !== null &&
        (typeof payload[field] !== "string" || !DIGEST_PATTERN.test(payload[field]))) {
      fail(`transaction ownership has an invalid ${field}`, filePath);
    }
  }
  if (payload.mode === "INIT" &&
      (payload.source_identity !== null || payload.source_snapshot_sha256 !== null ||
       payload.backup_identity !== null)) {
    fail("INIT transaction ownership must not identify a source or backup", filePath);
  }
  return {
    mode: payload.mode,
    targetName: payload.target,
    stageName: payload.stage,
    backupName: payload.backup,
    transactionId: payload.transaction_id,
    stageIdentity: parseIdentity(payload.stage_identity, "stage_identity", filePath),
    candidateSnapshotSha256: payload.candidate_snapshot_sha256,
    sourceIdentity: parseIdentity(payload.source_identity, "source_identity", filePath),
    sourceSnapshotSha256: payload.source_snapshot_sha256,
    backupIdentity: parseIdentity(payload.backup_identity, "backup_identity", filePath),
    promotedIdentity: parseIdentity(payload.promoted_identity, "promoted_identity", filePath),
    ...(payload.mode==='CLOSE'?{closeBinding:validateCloseBinding(payload.close_binding,filePath,{nullable:payload.candidate_snapshot_sha256===null})}:{}),
  };
}

function ownershipRecordsEqual(left, right) {
  return compactAsciiJson(ownershipPayload(left)) === compactAsciiJson(ownershipPayload(right));
}

async function readOwnershipRecord(target, transactionId, { allowLinkedClaim = false } = {}) {
  const filePath = ownershipPath(target, transactionId);
  const before = await lstatOrNull(filePath, { bigint: true });
  if (before === null) return null;
  if (before.isSymbolicLink()) fail("transaction ownership must not be a symlink", filePath);
  const handle = await fs.open(filePath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat({ bigint: true });
    const allowedLinks = allowLinkedClaim ? new Set([1n, 2n]) : new Set([1n]);
    if (!metadata.isFile() || !allowedLinks.has(metadata.nlink) || !sameInode(before, metadata)) {
      fail("transaction ownership must be a single-link regular file", filePath);
    }
    if (metadata.size > BigInt(MAX_JOURNAL_BYTES)) {
      fail("transaction ownership exceeds the safe size limit", filePath);
    }
    const bytes = await handle.readFile();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const after = await lstatOrNull(filePath, { bigint: true });
    if (after === null || !sameInode(metadata, after) || !allowedLinks.has(after.nlink)) {
      fail("transaction ownership changed identity after being read", filePath);
    }
    return {
      ownership: parseOwnership(target, transactionId, parseJsonWithoutDuplicateKeys(text)),
      metadata: after,
      bytes,
    };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail(`transaction ownership is malformed (${error.message})`, filePath);
  } finally {
    await handle.close();
  }
}

function ownershipRolePath(target, transactionId, role, identity, prior = null) {
  const suffix = role === "next"
    ? `-${prior.identity.dev}-${prior.identity.ino}-${prior.digest}`
    : "";
  return path.join(
    materialParent(target),
    `${ownershipTempPrefix(target)}${transactionId}-${role}-${identity.dev}-${identity.ino}${suffix}-${randomIdentity()}`,
  );
}

function parseOwnershipRoleName(target, transactionId, name) {
  const prefix = `${ownershipTempPrefix(target)}${transactionId}-`;
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  const next = suffix.match(
    /^next-(\d+)-(\d+)-(\d+)-(\d+)-([0-9a-f]{64})-([0-9a-f]{32})$/u,
  );
  if (next !== null) {
    return {
      role: "next",
      identity: { dev: next[1], ino: next[2] },
      priorIdentity: { dev: next[3], ino: next[4] },
      priorDigest: next[5],
    };
  }
  const simple = suffix.match(/^(create|previous)-(\d+)-(\d+)-([0-9a-f]{32})$/u);
  if (simple === null) return null;
  return {
    role: simple[1],
    identity: { dev: simple[2], ino: simple[3] },
    priorIdentity: null,
    priorDigest: null,
  };
}

function ownershipRecordMatches(record, expected) {
  return record !== null && sameFilesystemIdentity(record.metadata, expected.identity) &&
    record.bytes.equals(expected.bytes);
}

function ownershipTransitionCompatible(previous, next) {
  for (const field of ["mode", "targetName", "stageName", "backupName", "transactionId"]) {
    if (compactAsciiJson(previous[field]) !== compactAsciiJson(next[field])) return false;
  }
  const oldClose=previous.closeBinding??null,nextClose=next.closeBinding??null;
  if(oldClose!==null&&compactAsciiJson(oldClose)!==compactAsciiJson(nextClose))return false;
  let changed=compactAsciiJson(oldClose)!==compactAsciiJson(nextClose);
  for (const field of [
    "stageIdentity", "candidateSnapshotSha256", "sourceIdentity",
    "sourceSnapshotSha256", "backupIdentity", "promotedIdentity",
  ]) {
    const before = compactAsciiJson(previous[field]);
    const after = compactAsciiJson(next[field]);
    if (previous[field] !== null && before !== after) return false;
    if (before !== after) changed = true;
  }
  return changed;
}

async function ownershipRoleRecords(target, transactionId) {
  const records = [];
  for (const name of (await fs.readdir(materialParent(target))).sort(compareCodePoints)) {
    const role = parseOwnershipRoleName(target, transactionId, name);
    if (role === null) continue;
    const filePath = path.join(materialParent(target), name);
    const before = await lstatOrNull(filePath, { bigint: true });
    if (before === null || before.isSymbolicLink() || !before.isFile() ||
        !new Set([1n, 2n]).has(before.nlink) ||
        !sameFilesystemIdentity(before, role.identity)) {
      fail("transaction ownership role changed encoded filesystem identity", filePath);
    }
    const handle = await fs.open(filePath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    let record;
    try {
      const metadata = await handle.stat({ bigint: true });
      const bytes = await handle.readFile();
      if (!sameInode(before, metadata) || !new Set([1n, 2n]).has(metadata.nlink) ||
          bytes.length > MAX_JOURNAL_BYTES) {
        fail("transaction ownership role changed while being read", filePath);
      }
      record = { metadata, bytes };
    } finally {
      await handle.close();
    }
    let ownership;
    try {
      ownership = parseOwnership(
        target,
        transactionId,
        parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(record.bytes)),
      );
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      fail(`transaction ownership role is malformed (${error.message})`, filePath);
    }
    records.push({ ...role, filePath, record: { ...record, ownership } });
  }
  return records;
}

async function validateLinkedOwnershipClaim(target, transactionId, role) {
  const canonical = await readOwnershipRecord(target, transactionId, { allowLinkedClaim: true });
  const linked = await readOwnershipRecordAtRole(target, transactionId, role, true);
  if (canonical === null || linked === null ||
      !sameInode(canonical.metadata, linked.metadata) ||
      canonical.metadata.nlink !== 2n || linked.metadata.nlink !== 2n ||
      !canonical.bytes.equals(linked.bytes)) {
    fail("transaction ownership has an invalid atomic claim residue", ownershipPath(target, transactionId));
  }
  return canonical;
}

async function readOwnershipRecordAtRole(target, transactionId, role, allowLinkedClaim = false) {
  const before = await lstatOrNull(role.filePath, { bigint: true });
  if (before === null) return null;
  const allowedLinks = allowLinkedClaim ? new Set([1n, 2n]) : new Set([1n]);
  if (before.isSymbolicLink() || !before.isFile() || !allowedLinks.has(before.nlink) ||
      !sameFilesystemIdentity(before, role.identity)) {
    fail("transaction ownership role changed filesystem identity", role.filePath);
  }
  const handle = await fs.open(role.filePath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    if (!sameInode(before, metadata) || !allowedLinks.has(metadata.nlink) ||
        !bytes.equals(role.record.bytes)) {
      fail("transaction ownership role changed during read", role.filePath);
    }
    return { metadata, bytes };
  } finally {
    await handle.close();
  }
}

async function settleLinkedOwnershipClaim(target, transactionId, role) {
  const canonical = await validateLinkedOwnershipClaim(target, transactionId, role);
  await testOnlySwapPrivateFile(
    role.filePath,
    "OWNERSHIP_ROLE_CLEANUP_SWAP",
    "ownership role cleanup",
  );
  const final = await fs.lstat(role.filePath, { bigint: true });
  if (!sameFilesystemIdentity(final, role.identity) || final.nlink !== 2n) {
    fail("transaction ownership claim residue changed before settlement", role.filePath);
  }
  await fs.unlink(role.filePath);
  await fsyncDirectory(materialParent(target));
  const installed = await readOwnershipRecord(target, transactionId);
  if (installed === null || !sameInode(installed.metadata, canonical.metadata) ||
      !installed.bytes.equals(canonical.bytes)) {
    fail("transaction ownership claim was not durably settled", ownershipPath(target, transactionId));
  }
  return installed;
}

async function removeOwnedOwnershipRole(role, label) {
  const before = await readOwnershipRecordAtRole(null, null, role);
  if (before === null) return;
  await testOnlySwapPrivateFile(
    role.filePath,
    "OWNERSHIP_ROLE_CLEANUP_SWAP",
    "ownership role cleanup",
  );
  const final = await fs.lstat(role.filePath, { bigint: true });
  if (!sameFilesystemIdentity(final, role.identity) || final.nlink !== 1n) {
    fail(`${label} changed immediately before cleanup`, role.filePath);
  }
  await fs.unlink(role.filePath);
  await fsyncDirectory(path.dirname(role.filePath));
}

function ownershipPriorMatches(next, previous) {
  return sameFilesystemIdentity(previous.record.metadata, next.priorIdentity) &&
    createHash("sha256").update(previous.record.bytes).digest("hex") === next.priorDigest &&
    ownershipTransitionCompatible(previous.record.ownership, next.record.ownership);
}

async function claimOwnershipNext(target, transactionId, next, previous) {
  const filePath = ownershipPath(target, transactionId);
  if (await lexists(filePath)) fail("transaction ownership was replaced before atomic promotion", filePath);
  try {
    await fs.link(next.filePath, filePath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("transaction ownership was replaced before atomic promotion", filePath);
    }
    throw error;
  }
  await fsyncDirectory(materialParent(target));
  testOnlyCheckpoint("OWNERSHIP_UPDATE_CLAIMED");
  await validateLinkedOwnershipClaim(target, transactionId, next);
  if (previous !== null) await removeOwnedOwnershipRole(previous, "previous transaction ownership");
  return settleLinkedOwnershipClaim(target, transactionId, next);
}

async function settleOwnershipClaim(target, transactionId, { validateOnly = false } = {}) {
  const filePath = ownershipPath(target, transactionId);
  const metadata = await lstatOrNull(filePath, { bigint: true });
  const roles = await ownershipRoleRecords(target, transactionId);
  const create = roles.filter((entry) => entry.role === "create");
  const next = roles.filter((entry) => entry.role === "next");
  const previous = roles.filter((entry) => entry.role === "previous");
  if (metadata !== null) {
    if (metadata.isSymbolicLink() || !metadata.isFile() || !new Set([1n, 2n]).has(metadata.nlink)) {
      fail("transaction ownership must be a single-link regular file", filePath);
    }
    if (metadata.nlink === 2n) {
      const linked = roles.filter((entry) => sameInode(metadata, entry.record.metadata));
      if (linked.length !== 1) fail("transaction ownership has an incomplete atomic claim", filePath);
      const claim = linked[0];
      if (claim.role === "create") {
        if (roles.length !== 1) fail("transaction ownership creation residues are ambiguous", filePath);
      } else if (claim.role === "next") {
        if (create.length !== 0 || next.length !== 1 || previous.length > 1) {
          fail("transaction ownership update residues are ambiguous", filePath);
        }
        await validateLinkedOwnershipClaim(target, transactionId, claim);
        if (previous.length === 1) {
          if (!ownershipPriorMatches(claim, previous[0])) {
            fail("transaction ownership update residues do not match", filePath);
          }
          if (validateOnly) return claim.record.ownership;
          await removeOwnedOwnershipRole(previous[0], "previous transaction ownership");
        }
      } else {
        fail("transaction ownership atomic claim has an invalid role", claim.filePath);
      }
      if (validateOnly) return (await validateLinkedOwnershipClaim(target, transactionId, claim)).ownership;
      await settleLinkedOwnershipClaim(target, transactionId, claim);
      return;
    }
    if (roles.length === 0) return validateOnly ? (await readOwnershipRecord(target, transactionId)).ownership : undefined;
    if (next.length === 1 && create.length === 0 && previous.length === 0) {
      const canonical = await readOwnershipRecord(target, transactionId);
      const prior = {
        record: { metadata: canonical.metadata, bytes: canonical.bytes, ownership: canonical.ownership },
      };
      if (!ownershipPriorMatches(next[0], prior)) {
        fail("transaction ownership canonical identity or payload changed before atomic update", filePath);
      }
      if (validateOnly) return next[0].record.ownership;
      const previousPath = ownershipRolePath(
        target,
        transactionId,
        "previous",
        filesystemIdentity(canonical.metadata),
      );
      await renameWithRetry(filePath, previousPath);
      const previousRole = {
        role: "previous",
        identity: filesystemIdentity(canonical.metadata),
        filePath: previousPath,
        record: { metadata: canonical.metadata, bytes: canonical.bytes, ownership: canonical.ownership },
      };
      const moved = await readOwnershipRecordAtRole(target, transactionId, previousRole);
      if (moved === null) fail("transaction ownership changed during update quarantine", previousPath);
      await fsyncDirectory(materialParent(target));
      return claimOwnershipNext(target, transactionId, next[0], previousRole);
    }
    fail("transaction ownership canonical path appeared in an interrupted atomic operation", filePath);
  }
  if (roles.length === 0) return null;
  if (create.length === 1 && next.length === 0 && previous.length === 0) {
    if (validateOnly) return create[0].record.ownership;
    try {
      await fs.link(create[0].filePath, filePath);
    } catch (error) {
      if (error?.code === "EEXIST") fail("transaction ownership appeared during claim recovery", filePath);
      throw error;
    }
    await fsyncDirectory(materialParent(target));
    await settleLinkedOwnershipClaim(target, transactionId, create[0]);
    return;
  }
  if (create.length === 0 && next.length === 1 && previous.length === 1 &&
      ownershipPriorMatches(next[0], previous[0])) {
    if (validateOnly) return next[0].record.ownership;
    await claimOwnershipNext(target, transactionId, next[0], previous[0]);
    return;
  }
  fail("transaction ownership recovery residues are ambiguous", materialParent(target));
}

async function readOwnership(target, transactionId) {
  await settleOwnershipClaim(target, transactionId);
  return (await readOwnershipRecord(target, transactionId))?.ownership ?? null;
}

async function writeOwnership(target, ownership) {
  await assertPhysicalRoles();
  const filePath = ownershipPath(target, ownership.transactionId);
  await settleOwnershipClaim(target, ownership.transactionId);
  const existing = await readOwnershipRecord(target, ownership.transactionId);
  const build = path.join(
    materialParent(target),
    `${ownershipBuildPrefix(target)}${ownership.transactionId}-${randomIdentity()}`,
  );
  const handle = await fs.open(build, "wx", 0o600);
  try {
    await handle.writeFile(prettySortedAsciiJson(ownershipPayload(ownership)), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const buildMetadata = await fs.lstat(build, { bigint: true });
  const role = existing === null ? "create" : "next";
  const temp = ownershipRolePath(
    target,
    ownership.transactionId,
    role,
    filesystemIdentity(buildMetadata),
    existing === null ? null : {
      identity: filesystemIdentity(existing.metadata),
      digest: createHash("sha256").update(existing.bytes).digest("hex"),
    },
  );
  await renameWithRetry(build, temp);
  await fsyncDirectory(materialParent(target));
  const tempRecord = (await ownershipRoleRecords(target, ownership.transactionId))
    .find((entry) => entry.filePath === temp);
  if (tempRecord === undefined || !ownershipRecordsEqual(tempRecord.record.ownership, ownership)) {
    fail("transaction ownership candidate changed after durable construction", temp);
  }
  if (existing === null) {
    if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] === "OWNERSHIP_CREATE_CLEANUP_SWAP") {
      await fs.writeFile(
        filePath,
        "foreign ownership exclusive-create canonical sentinel\n",
        { flag: "wx", mode: 0o600 },
      );
      await fsyncDirectory(materialParent(target));
    }
    try {
      await fs.link(temp, filePath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        await cleanupExclusiveCreateCandidate(
          temp,
          tempRecord.record.metadata,
          tempRecord.record.bytes,
          {
            label: "transaction ownership exclusive-create candidate",
            mutationWindow: "OWNERSHIP_CREATE_CLEANUP_SWAP",
          },
        );
        fail("transaction ownership appeared during exclusive creation", filePath);
      }
      throw error;
    }
    await fsyncDirectory(materialParent(target));
    await settleLinkedOwnershipClaim(target, ownership.transactionId, tempRecord);
  } else {
    testOnlyCheckpoint("OWNERSHIP_UPDATE_READY");
    const rechecked = await readOwnershipRecord(target, ownership.transactionId);
    if (rechecked === null || !sameInode(rechecked.metadata, existing.metadata) ||
        !ownershipRecordsEqual(rechecked.ownership, existing.ownership)) {
      fail("transaction ownership changed during atomic update", filePath);
    }
    const previousPath = ownershipRolePath(
      target,
      ownership.transactionId,
      "previous",
      filesystemIdentity(existing.metadata),
    );
    await renameWithRetry(filePath, previousPath);
    await fsyncDirectory(materialParent(target));
    const previousRole = {
      role: "previous",
      identity: filesystemIdentity(existing.metadata),
      filePath: previousPath,
      record: { metadata: existing.metadata, bytes: existing.bytes, ownership: existing.ownership },
    };
    const moved = await readOwnershipRecordAtRole(target, ownership.transactionId, previousRole);
    if (moved === null) fail("transaction ownership changed during update quarantine", previousPath);
    testOnlyCheckpoint("OWNERSHIP_UPDATE_QUARANTINED");
    if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] === "OWNERSHIP_UPDATE_CANONICAL_SWAP") {
      await fs.writeFile(filePath, "foreign ownership update sentinel\n", { flag: "wx", mode: 0o600 });
    }
    await claimOwnershipNext(target, ownership.transactionId, tempRecord, previousRole);
  }
  await fsyncDirectory(materialParent(target));
  const installed = await readOwnership(target, ownership.transactionId);
  if (installed === null || !ownershipRecordsEqual(installed, ownership)) {
    fail("transaction ownership update was not durably installed", filePath);
  }
}

async function removeOwnership(target, ownership) {
  await assertPhysicalRoles();
  const filePath = ownershipPath(target, ownership.transactionId);
  const before = await lstatOrNull(filePath, { bigint: true });
  if (before === null) {
    await cleanupRetiredOwnership(target, ownership.transactionId, ownership);
    return;
  }
  const read = await readOwnership(target, ownership.transactionId);
  if (read === null) return;
  if (compactAsciiJson(ownershipPayload(read)) !== compactAsciiJson(ownershipPayload(ownership))) {
    fail("transaction ownership changed before cleanup", filePath);
  }
  const rechecked = await fs.lstat(filePath, { bigint: true });
  if (!sameInode(before, rechecked) || rechecked.nlink !== 1n) {
    fail("transaction ownership changed identity before cleanup", filePath);
  }
  const identity = filesystemIdentity(before);
  const retired = `${filePath}.retired-${identity.dev}-${identity.ino}-${randomIdentity()}`;
  await renameWithRetry(filePath, retired);
  const moved = await fs.lstat(retired, { bigint: true });
  if (!sameInode(before, moved)) {
    fail("transaction ownership changed identity during cleanup", retired);
  }
  testOnlyCheckpoint("DURING_OWNERSHIP_REMOVAL");
  await cleanupRetiredOwnership(target, ownership.transactionId, ownership);
}

async function cleanupRetiredOwnership(target, transactionId, expected = null) {
  const canonical = ownershipPath(target, transactionId);
  const prefix = `${path.basename(canonical)}.retired-`;
  const names = (await fs.readdir(materialParent(target)))
    .filter((name) => name.startsWith(prefix))
    .sort(compareCodePoints);
  if (names.length > 1) fail("multiple retired transaction ownership records require inspection", materialParent(target));
  if (names.length === 0) return false;
  const name = names[0];
  const suffix = name.slice(prefix.length);
  const match = suffix.match(/^(\d+)-(\d+)(?:-([0-9a-f]{32}))?$/u);
  if (match === null) fail("retired transaction ownership has an invalid filesystem identity", name);
  const filePath = path.join(materialParent(target), name);
  const metadata = await fs.lstat(filePath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n ||
      metadata.dev.toString() !== match[1] || metadata.ino.toString() !== match[2]) {
    fail("retired transaction ownership changed filesystem identity", filePath);
  }
  const read = await readBoundedSingleLinkFile(filePath, MAX_JOURNAL_BYTES, "retired transaction ownership");
  let retiredOwnership;
  try {
    retiredOwnership = parseOwnership(
      target,
      transactionId,
      parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)),
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail(`retired transaction ownership is malformed (${error.message})`, filePath);
  }
  if (expected !== null && !ownershipRecordsEqual(retiredOwnership, expected)) {
    fail("retired transaction ownership payload changed before cleanup", filePath);
  }
  if (await lexists(canonical)) {
    fail("transaction ownership canonical path appeared during retired cleanup", canonical);
  }
  await testOnlySwapPrivateFile(
    filePath,
    "OWNERSHIP_CLEANUP_QUARANTINE_SWAP",
    "ownership cleanup quarantine",
  );
  const final = await readBoundedSingleLinkFile(
    filePath,
    MAX_JOURNAL_BYTES,
    "retired transaction ownership",
  );
  const rechecked = await fs.lstat(filePath, { bigint: true });
  if (final === null || !sameInode(metadata, final.metadata) ||
      !sameInode(final.metadata, rechecked) || !final.bytes.equals(read.bytes)) {
    fail("retired transaction ownership changed identity immediately before cleanup", filePath);
  }
  if (await lexists(canonical)) {
    fail("transaction ownership canonical path appeared during retired cleanup", canonical);
  }
  await fs.unlink(filePath);
  await fsyncDirectory(materialParent(target));
  return true;
}

function validateOwnershipAgainstTransaction(target, ownership, transaction) {
  if (ownership === null || ownership.mode !== transaction.mode ||
      ownership.targetName !== transaction.targetName ||
      ownership.stageName !== transaction.stageName ||
      ownership.backupName !== transaction.backupName ||
      ownership.transactionId !== transaction.transactionId ||
      ownership.candidateSnapshotSha256 !== transaction.candidateSnapshotSha256 ||
      ownership.sourceSnapshotSha256 !== transaction.sourceSnapshotSha256 ||
      compactAsciiJson(ownership.closeBinding??null)!==compactAsciiJson(transaction.closeBinding??null) ||
      (transaction.mode==='CLOSE'&&compactAsciiJson(transaction.closeBinding.sourceIdentity)!==compactAsciiJson(ownership.sourceIdentity)) ||
      ownership.stageIdentity === null ||
      (transaction.mode !== "INIT" && ownership.sourceIdentity === null)) {
    fail("transaction ownership does not match the recovery journal", ownershipPath(target, transaction.transactionId));
  }
}

function validateCloseBinding(binding,filePath,{nullable=false}={}) {
  if(binding===null&&nullable)return null;
  try{return sortedJsonValue(validateLifecycleCloseBinding(binding));}
  catch(error){fail(error.message,filePath);}
}

async function captureRetirementRoles(root,options={}){return sortedJsonValue(await captureLifecycleRetirementRoles(root,options));}

async function captureCloseOperationalInventory(target,transactionId){
  await assertPhysicalRoles();
  const names=(await fs.readdir(materialParent(target))).sort(compareCodePoints);
  const own=new Set([path.basename(lockPath(target)),path.basename(journalPath(target)),
    ...(transactionId===null?[]:[`${stagePrefix(target)}${transactionId}`,`${backupPrefix(target)}${transactionId}`,path.basename(ownershipPath(target,transactionId))])]);
  const selected=names.filter(name=>!own.has(name));
  const image=await lexists(path.join(target,'execution'))?await captureCurrentExecution(path.join(target,'feature_spec.md')):null;
  if(image!==null&&image.inspection.state!=='COMPLETE')fail('CLOSE retirement requires current integral COMPLETE',target);
  const proofs=[];
  if(image!==null)for(const [name,bytes] of image.files)if(/^evidence\/[^/]+\.json$/u.test(name)){
    const bundle=parseStrictJson(Buffer.from(bytes).toString('utf8')),objects=new Map(bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')]));
    for(const record of [...bundle.implementation,bundle.validation,...bundle.findingsChecks,...bundle.support].filter(Boolean)){
      if(record.origin?.transport!=='native')continue;
      const op=record.origin.operation,profile=op==='EXECUTE_SLICE'?'initial-implementation':op==='APPLY_FINDINGS'?'current-findings':'current-validation';
      const capture=restoreCaptureSources(profile,record,objects),origin=parseStrictJson(Buffer.from(capture.origin).toString('utf8'));
      if(origin.admission)proofs.push({capture,origin,record});
    }
  }
  const json=async file=>parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
  const same=(a,b)=>compactAsciiJson(sortedJsonValue(a))===compactAsciiJson(sortedJsonValue(b));
  for(const name of selected){
    const file=path.join(materialParent(target),name);
    if(file===roots.preparationRegistry){const registry=validatePreparationRegistry(await json(file),workspace);if(registry.allocations.length)fail('CLOSE retirement has pending preparation allocations',file);continue;}
    if(file===roots.operationRegistry){const registry=await json(file);exactKeys(registry,['format','executionRoot','operations'],'CLOSE operation registry',file);if(registry.format!=='stnl-current-operation-registry-v1'||registry.executionRoot!==roots.executionRoot||!Array.isArray(registry.operations)||registry.operations.length)fail('CLOSE retirement has an active or uncertain operation registry',file);continue;}
    if(file===roots.readinessAttestation){await validateReadinessAttestation(target,file);continue;}
    const metadata=await fs.lstat(file,{bigint:true});
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(name)||!metadata.isDirectory()||metadata.isSymbolicLink())fail('CLOSE retirement preserves foreign or unproven material',file);
    const record=await json(path.join(file,'owner.json'));
    validateCurrentOperationRetirementRecord(record);
    const refusal=record.terminalTransition.outcome==='rejected';
    const binding=validateCurrentOperationAllocationBinding(record,{operationId:name,specKey:roots.specKey,logicalExecutionRoot:roots.executionRoot,logicalSpecRoot:roots.specRoot,
      ownershipToken:record.binding?.owner?.ownershipToken,namespaceIdentity:roots.materialRootIdentity,filesystemDevice:roots.materialRootIdentity.dev,filesystemContext:policy,
      filesystemBinding:{targetParentIdentity:roots.targetParentIdentity,leaseParentIdentity:roots.leaseParentIdentity,materialRootIdentity:roots.materialRootIdentity}});
    const allowed=new Set(['owner.json','base.activation.json',...(binding.owner.operation==='VALIDATE_SLICE'?[]:['base.work.json'])]);
    if(record.phase==='aborted') {
      if(record.commonLease.lockPath!==roots.lockPath)fail('CLOSE abort common lease path differs',file);
      const terminal=record.expectedInstalledActivation;
      const successor=proofs.find(item=>item.record.kind==='validation'
        &&item.origin.owner.operation==='VALIDATE_SLICE'
        &&item.origin.owner.deliveryId===binding.owner.deliveryId&&item.origin.owner.slice===binding.owner.slice
        &&item.origin.owner.operationAttemptId!==binding.owner.operationAttemptId
        &&same(item.origin.admission.baseActivation,terminal));
      if(!successor)fail('CLOSE retirement abort lacks its verified formal successor replica',file);
      const last=successor.origin.admission.baseActivation.lastAttempt,parsed=validateCurrentAbortDisposition(last);
      if(!same(last,terminal.lastAttempt)||!same(parsed.origin.admission.binding,binding))
        fail('CLOSE retirement abort disposition differs from official admission',file);
      for(const key of ['origin','request','baseline','agent','claim']) {
        const leaf=`round-1.${key}.json`;allowed.add(leaf);
        if(!(await readOwnedFile(path.join(file,leaf))).bytes.equals(Buffer.from(last.abort[key+'Utf8'],'utf8')))
          fail('CLOSE retirement aborted source differs from official replica',path.join(file,leaf));
      }
      const base=await readOwnedFile(path.join(file,'base.activation.json'));
      if(!same(parseStrictJson(base.bytes.toString('utf8')),parsed.origin.admission.baseActivation)
        ||binding.baseTree.files.find(item=>item.path==='activation.json')?.sha256!=='sha256:'+createHash('sha256').update(base.bytes).digest('hex'))
        fail('CLOSE retirement aborted base differs from official replica',file);
      const actual=(await fs.readdir(file)).sort(compareCodePoints);
      if(actual.length!==allowed.size||actual.some(name=>!allowed.has(name)))
        fail('CLOSE retirement preserves extra or unique aborted material',file);
      continue;
    }
    let first=null;
    for(let round=1;round<=record.runner.round;round++){
      const proof=proofs.find(item=>same(item.origin.admission.binding,binding)&&item.origin.attempt===round);
      if(!proof)fail('CLOSE retirement preserves an operation capture without an official faithful replica',file);
      first??=proof;
      const continued=parseStrictJson(Buffer.from(proof.capture.concludedToolResult).toString('utf8')).preVerificationContinuation??null;
      if(!same(continued,record.preVerificationContinuation?.round===round?record.preVerificationContinuation:null))
        fail('CLOSE retirement continuation differs from its faithful replica',file);
      for(const [suffix,key] of [['origin','origin'],['baseline','baselineCapture'],['request',binding.owner.operation==='APPLY_FINDINGS'?'applyRequest':'validationRequest'],['agent','agentBinding'],['claim','agentClaim'],['observation','verificationObservation'],['response','rawResponse'],['tool-result','concludedToolResult'],['receipt','receipt']]){
        const leaf=`round-${round}.${suffix}.json`;allowed.add(leaf);
        if(key==='validationRequest'&&binding.owner.operation==='EXECUTE_SLICE'){
          // After COMPLETE this request is dispensable by its two official
          // digest bindings, not by a literal capsule replica that does not exist.
          const request=(await readOwnedFile(path.join(file,leaf))).bytes;
          const observation=parseStrictJson(Buffer.from(proof.capture.verificationObservation).toString('utf8'));
          if(proof.origin.responseVariant!=='stnl-current-native-judgment-v1'
            ||observation.format!=='stnl-runner-verification-v3'
            ||proof.origin.requestSha256!=='sha256:'+createHash('sha256').update(request).digest('hex')
            ||observation.binding?.requestSha256!==proof.origin.requestSha256)
            fail('CLOSE retirement implementation request is not bound to official proof',file);
          continue;
        }
        if(!proof.capture[key]||!(await readOwnedFile(path.join(file,leaf))).bytes.equals(Buffer.from(proof.capture[key])))fail('CLOSE retirement captured bytes differ from official proof',path.join(file,leaf));
      }
      const leaf=`round-${round}.verification.json`,verification=await json(path.join(file,leaf)),observed=parseStrictJson(Buffer.from(proof.capture.verificationObservation).toString('utf8')),baseline=parseStrictJson(Buffer.from(proof.capture.baselineCapture).toString('utf8'));
      allowed.add(leaf);exactKeys(verification,['format','status','verification','workStateSha256','checks'],'CLOSE private recipe observation',file);
      if(verification.format!=='stnl-runner-verification-v1'||verification.status!=='completed'||!same(verification.verification,proof.origin.verification)||!same(verification.checks,observed.checks)
        ||verification.workStateSha256!=='sha256:'+createHash('sha256').update(JSON.stringify(observed.before)).digest('hex'))fail('CLOSE retirement private verification is not replicated in the official observation',file);
      for(const bytes of proof.capture.removalProofs){const removal=parseStrictJson(Buffer.from(bytes).toString('utf8')),leaf=`round-${round}.removal-${createHash('sha256').update(removal.path).digest('hex')}.json`;allowed.add(leaf);if(!(await readOwnedFile(path.join(file,leaf))).bytes.equals(Buffer.from(bytes)))fail('CLOSE retirement removal source differs',file);}
      if(binding.owner.operation!=='VALIDATE_SLICE'){
        // Refusals have no authored contract record. Their bounded accepted
        // successor carries the same verified local authority, never a wider one.
        const sourceContract=proof.record.contract??proofs.find(item=>item.record.kind!=='rejection'
          &&['deliveryId','slice','preparationRevision','localRevision','normativeSha256','operation']
            .every(key=>item.record.origin[key]===proof.record.origin[key]))?.record.contract;
        if(!sourceContract)fail('CLOSE retirement refusal has no verified matching operation contract',file);
        const info=verifyWorkObservation('initial-implementation',{context:baseline.context,
          delivery:sourceContract.delivery,slice:binding.owner.slice});
        for(const entry of baseline.manifest.entries.filter(item=>item.kind==='file'
          &&info.areas.some(area=>area.path===item.path||area.kind==='directory'&&item.path.startsWith(area.path+'/'))
          &&!info.inputs.some(input=>input.path===item.path))){
          const leaf=`round-${round}.removal-${createHash('sha256').update(entry.path).digest('hex')}.json`;
          if(allowed.has(leaf)||!await lexists(path.join(file,leaf)))continue;
          // begin reserves preimages before it knows which files will be
          // removed. An unused preimage is dispensable after COMPLETE only
          // when its exact bytes/owner remain bound to the official baseline.
          if(observed.after.entries.find(item=>item.path===entry.path)?.kind!=='file')
            fail('CLOSE retirement missing official removal source',file);
          const removal=await json(path.join(file,leaf));
          exactKeys(removal,['format','owner','round','path','sha256','mode','bytesBase64'],'unused removal preimage',file);
          const bytes=typeof removal.bytesBase64==='string'?Buffer.from(removal.bytesBase64,'base64'):null;
          if(removal.format!=='stnl-current-removal-proof-v1'||!same(removal.owner,binding.owner)
            ||removal.round!==round||removal.path!==entry.path||removal.sha256!==entry.sha256||removal.mode!==entry.mode
            ||bytes===null||bytes.toString('base64')!==removal.bytesBase64
            ||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==entry.sha256)
            fail('CLOSE retirement unused preimage differs from official baseline',file);
          allowed.add(leaf);
        }
      }
    }
    const last=proofs.find(item=>same(item.origin.admission.binding,binding)&&item.origin.attempt===record.runner.round);
    const receipt=parseStrictJson(Buffer.from(last.capture.receipt).toString('utf8'));
    const reserved=last.origin.admission.reservedActivation,intermediate=record.preparation.intermediateActivation;
    if(intermediate.previousActivationId!==reserved.activationId||intermediate.sequence!==reserved.sequence+1||!same(intermediate.activeAttempt,reserved.activeAttempt)
      ||!same(intermediate.lastAttempt,reserved.lastAttempt)
      ||['format','preparationRevision','requirementsAuthority','normativeSha256','approvedSnapshotSha256'].some(key=>intermediate[key]!==reserved[key])
      ||!same(record.previous.tree.filter(row=>row.path!=='activation.json'),binding.baseTree.files.filter(row=>row.path!=='activation.json'))
      ||record.previous.tree.find(row=>row.path==='activation.json')?.sha256!=='sha256:'+createHash('sha256').update(JSON.stringify(reserved,null,2)+'\n').digest('hex'))fail('CLOSE terminal operation does not follow the official reservation',file);
    if(record.runner.dispatchId!==last.origin.dispatchId||record.runner.agentId!==receipt.agentId&&record.runner.agentId!==receipt.threadId
      ||record.runner.originFile!==path.join(file,`round-${record.runner.round}.origin.json`)
      ||record.runner.requestFile!==path.join(file,`round-${record.runner.round}.request.json`)
      ||record.runner.responseFile!==path.join(file,`round-${record.runner.round}.response.json`)
      ||record.runner.captureClass!==(refusal?(binding.owner.operation==='EXECUTE_SLICE'?'initial-rejection':binding.owner.operation==='APPLY_FINDINGS'?'findings-rejection':receipt.reviewTriage?'formal-review-incomplete':'formal-rejection'):'formal-response')
      ||(record.runner.resultStatus??null)!==receipt.semanticResponseStatus||(record.responseVariant??null)!==(last.origin.responseVariant??null))fail('CLOSE terminal runner is not replicated by official conclusion',file);
    if(refusal){
      const normalization=record.terminalTransition.normalization;
      // Every retained refusal must have its next verified edge. That edge may
      // itself be a refusal; the current image separately proves the complete
      // bounded chain and final accepted result before CLOSE.
      const successor=proofs.find(item=>item.origin.owner.operation===binding.owner.operation
        &&item.origin.owner.operationAttemptId!==binding.owner.operationAttemptId
        &&same(item.origin.admission.baseActivation,record.expectedInstalledActivation)
        &&Object.entries(normalization).every(([key,value])=>same(item.origin.admission.binding.normalization?.[key],value)));
      if(!successor)fail('CLOSE retirement refusal lacks its verified bounded successor',file);
    }
    const base=await readOwnedFile(path.join(file,'base.activation.json'));
    if(!same(parseStrictJson(base.bytes.toString('utf8')),first.origin.admission.baseActivation)||binding.baseTree.files.find(item=>item.path==='activation.json')?.sha256!=='sha256:'+createHash('sha256').update(base.bytes).digest('hex'))fail('CLOSE retirement base activation is not bound to official admission',file);
    if(binding.owner.operation!=='VALIDATE_SLICE'){
      const work=await json(path.join(file,'base.work.json')),baseline=parseStrictJson(Buffer.from(first.capture.baselineCapture).toString('utf8'));if(!same(work,baseline.manifest))fail('CLOSE retirement base work is not replicated',file);
    }
    const actual=(await fs.readdir(file)).sort(compareCodePoints);if(actual.length!==allowed.size||actual.some(name=>!allowed.has(name)))fail('CLOSE retirement preserves extra or unique operation material',file);
  }
  const rows=await captureRetirementRoles(materialParent(target),{names:selected});
  if(compactAsciiJson(names)!==compactAsciiJson((await fs.readdir(materialParent(target))).sort(compareCodePoints)))fail('CLOSE retirement namespace changed during inventory',materialParent(target));
  return rows;
}

async function closeRequirementsAuthority(target) {
  const files=new Map(),authorityPath=path.join(target,'feature_spec.md');
  files.set(authorityPath,(await readOwnedFile(authorityPath)).bytes);
  const shared=path.join(target,'shared');
  if(await lexists(shared))for(const name of (await fs.readdir(shared)).sort(compareCodePoints))if(name.endsWith('.md')&&!isOsMetadata(name)){
    const file=path.join(shared,name);files.set(file,(await readOwnedFile(file)).bytes);
  }
  return projectCurrentRequirements({workspace:{kind:'lifecycle',specRoot:target,authorityPath},files}).requirementsAuthority;
}

function closePublicationResult(target,transaction,{diagnostics=[]}={}) {
  validateCloseBinding(transaction.closeBinding,journalPath(target));
  return {target,transactionId:transaction.transactionId,publication:'confirmed',cleanup:'pending',
    requirementsAuthority:transaction.closeBinding.requirementsAuthority,
    closedSnapshotSha256:`sha256:${transaction.candidateSnapshotSha256}`,
    sourceExecutionDisposition:transaction.closeBinding.sourceExecutionDisposition,
    ...(diagnostics.length?{cleanupDiagnostics:diagnostics}:{})};
}

async function prepareCloseTerminalRetirement(target,transaction,ownership,executionLease){
  const {backup}=await transactionPaths(target,transaction);
  await validateSourceIdentity(backup,transaction,ownership);
  await validateCandidateIdentity(target,transaction,ownership);
  const selected=[...new Set(transaction.closeBinding.operationalInventory.map(row=>row.path.split('/')[0]))].sort(compareCodePoints);
  const current=await captureRetirementRoles(materialParent(target),{names:selected});
  if(compactAsciiJson(current)!==compactAsciiJson(transaction.closeBinding.operationalInventory))fail('CLOSE operational inventory changed after admission',materialParent(target));
  await assertOwnedJournal(target,transaction);
  const roles=await captureRetirementRoles(materialParent(target));
  const ownNames=new Set([...selected,path.basename(lockPath(target)),path.basename(journalPath(target)),path.basename(ownershipPath(target,transaction.transactionId)),transaction.backupName]);
  if(roles.some(row=>!ownNames.has(row.path.split('/')[0])))fail('CLOSE terminal inventory has unbound controls or foreign material',materialParent(target));
  const witness={format:'stnl-lifecycle-terminal-retirement-v1',transactionId:transaction.transactionId,
    sourceCommonLease:await lifecycleCommonLeaseBinding(executionLease),filesystemContext:{specRoot:roots.specRoot,productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,
      excludedRoots:roots.excludedRoots,targetParentIdentity:roots.targetParentIdentity,leaseParentIdentity:roots.leaseParentIdentity},
    materialRootIdentity:roots.materialRootIdentity,targetIdentity:ownership.promotedIdentity??ownership.stageIdentity,
    closedSnapshotSha256:'sha256:'+transaction.candidateSnapshotSha256,closeBinding:transaction.closeBinding,roles,targetRoles:await captureRetirementRoles(target),intent:'cleanup'};
  await beginLifecycleTerminalRetirement(executionLease,witness);
  testOnlyCheckpoint('TERMINAL_WITNESS_DURABLE');
  return witness;
}

async function validateTerminalPublisherState(inspection){
  const witness=typeof inspection.intent==='object'?inspection.intent:inspection;
  validateCloseBinding(witness.closeBinding,roots.lockPath);
  if(witness.filesystemContext.specRoot!==roots.specRoot||!validateWorkspace(roots.specRoot).closed
    ||await snapshotDigest(roots.specRoot)!==witness.closedSnapshotSha256.slice(7)
    ||await closeRequirementsAuthority(roots.specRoot)!==witness.closeBinding.requirementsAuthority)fail('terminal witness does not match the current closed document',roots.specRoot);
  const backupName=`${backupPrefix(roots.specRoot)}${witness.transactionId}`;
  const backupRole=witness.roles.find(row=>row.path===backupName);
  if(backupRole?.kind!=='directory'||compactAsciiJson(backupRole.identity)!==compactAsciiJson(witness.closeBinding.sourceIdentity))fail('terminal source binding differs from sealed backup role');
  const journal=journalPath(roots.specRoot);
  if(await lexists(journal)){
    const transaction=parseJournal(roots.specRoot,await readJournalPayload(journal));
    if(transaction.mode!=='CLOSE'||transaction.phase!==PHASE_COMMITTED||transaction.transactionId!==witness.transactionId
      ||compactAsciiJson(transaction.closeBinding)!==compactAsciiJson(witness.closeBinding))fail('terminal journal and external witness disagree',journal);
  }
  if(await lexists(lockPath(roots.specRoot))){
    const lock=(await readLockRecord(lockPath(roots.specRoot))).record;
    if(lock.transactionId!==witness.transactionId||compactAsciiJson(sortedJsonValue(lock.commonLease))!==compactAsciiJson(sortedJsonValue(witness.sourceCommonLease)))fail('terminal lifecycle lease and external witness disagree');
  }
  return witness;
}
function terminalPublicationResult(witness,cleanup){
  return {target:roots.specRoot,transactionId:witness.transactionId,publication:'confirmed',...cleanup,
    requirementsAuthority:witness.closeBinding.requirementsAuthority,closedSnapshotSha256:witness.closedSnapshotSha256,
    sourceExecutionDisposition:witness.closeBinding.sourceExecutionDisposition};
}
async function cleanupTerminalRetirement(executionLease,witness){
  try{
    await validateTerminalPublisherState(witness);
    await assertLifecycleTerminalRetirementState(executionLease);
    // All remaining roles/extras are proved before the first removal. Deeper
    // children leave first; only the journal, ownership and lifecycle lease stay
    // until the source material has gone. The external witness owns both passes.
    const finalControls=new Set([path.basename(journalPath(roots.specRoot)),path.basename(lockPath(roots.specRoot)),path.basename(ownershipPath(roots.specRoot,witness.transactionId))]);
    const order=(a,b)=>b.path.split('/').length-a.path.split('/').length||compareCodePoints(a.path,b.path);
    for(const row of witness.roles.filter(row=>!finalControls.has(row.path)).sort(order))await removeLifecycleTerminalRetirementRole(executionLease,row.path);
    for(const row of witness.roles.filter(row=>finalControls.has(row.path)).sort(order))await removeLifecycleTerminalRetirementRole(executionLease,row.path);
    testOnlyCheckpoint('TERMINAL_LAST_CONTROL_REMOVED');
    await removeLifecycleTerminalRetirementNamespace(executionLease);
    testOnlyCheckpoint('TERMINAL_NAMESPACE_REMOVED');
    const retired=await retireLifecycleTerminalRetirementLease(executionLease);
    testOnlyCheckpoint('TERMINAL_LEASE_RETIRED');
    return terminalPublicationResult(witness,await finishLifecycleTerminalRetirementSettlement(executionLease,retired));
  }catch(error){return terminalPublicationResult(witness,{cleanup:'pending',cleanupDiagnostics:[error.message]});}
}
async function recoverTerminalRetirement(inspection){
  validateTestOnlyHookConfiguration();
  const witness=await validateTerminalPublisherState(inspection);
  await proveLifecycleTemporaryExclusion(workspace,policy);
  const lease=await acquireLifecycleTerminalRetirementLock(workspace,inspection);
  return cleanupTerminalRetirement(lease,witness);
}

function transactionPayload(transaction) {
  return {filesystem_context:filesystemProof,
    version: JOURNAL_VERSION,
    mode: transaction.mode,
    target: transaction.targetName,
    stage: transaction.stageName,
    backup: transaction.backupName,
    phase: transaction.phase,
    source_snapshot_sha256: transaction.sourceSnapshotSha256,
    candidate_snapshot_sha256: transaction.candidateSnapshotSha256,
    observed_source_snapshot_sha256: transaction.observedSourceSnapshotSha256,
    transaction_id: transaction.transactionId,
    ...(transaction.mode==='CLOSE'?{close_binding:transaction.closeBinding}:{}),
  };
}

async function readJournalPayload(filePath) {
  const read = await readBoundedSingleLinkFile(
    filePath,
    MAX_JOURNAL_BYTES,
    "transaction journal",
  );
  if (read === null) return null;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    return parseJsonWithoutDuplicateKeys(text);
  } catch (error) {
    fail(`transaction journal is malformed (${error.message})`, filePath);
  }
}

function exactKeys(payload, expectedKeys, label, filePath) {
  const actual = new Set(Object.keys(payload));
  const expected = new Set(expectedKeys);
  const missing = [...expected].filter((key) => !actual.has(key)).sort(compareCodePoints);
  const extra = [...actual].filter((key) => !expected.has(key)).sort(compareCodePoints);
  if (missing.length !== 0 || extra.length !== 0) {
    fail(`${label} keys are inconsistent (missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)})`, filePath);
  }
}

function parseJournal(target, payload) {
  assertFilesystemProof(payload?.filesystem_context);
  const journal = journalPath(target);
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    fail("transaction journal root must be a JSON object", journal);
  }
  if (!("version" in payload)) {
    fail("transaction journal keys are inconsistent (missing=['version'], extra=[])", journal);
  }
  if (!Number.isInteger(payload.version) || payload.version !== JOURNAL_VERSION) {
    fail(`unsupported transaction journal version ${JSON.stringify(payload.version)}`, journal);
  }
  const expectedKeys = [
    "filesystem_context",
    "version", "mode", "target", "stage", "backup", "phase",
    "source_snapshot_sha256", "candidate_snapshot_sha256",
    "observed_source_snapshot_sha256", "transaction_id",
    ...(payload.mode==='CLOSE'?['close_binding']:[]),
  ];
  exactKeys(payload, expectedKeys, "transaction journal", journal);
  for (const field of ["mode", "target", "stage", "phase", "candidate_snapshot_sha256", "transaction_id"]) {
    if (typeof payload[field] !== "string") {
      fail(`transaction journal field ${JSON.stringify(field)} must be a string`, journal);
    }
  }
  if (!MUTABLE_MODES.has(payload.mode)) {
    fail(`transaction journal contains unsupported mode ${JSON.stringify(payload.mode)}`, journal);
  }
  if (payload.target !== path.basename(target)) {
    fail("transaction journal target does not match the requested workspace", journal);
  }
  if (!TRANSACTION_PHASES.has(payload.phase)) {
    fail(`transaction journal contains unknown phase ${JSON.stringify(payload.phase)}`, journal);
  }
  if (!TRANSACTION_ID_PATTERN.test(payload.transaction_id)) {
    fail("transaction journal has an invalid transaction identity", journal);
  }
  const expectedStage = `${stagePrefix(target)}${payload.transaction_id}`;
  if (payload.stage !== expectedStage) {
    fail("transaction journal stage is not the transaction-owned sibling path", journal);
  }
  const expectedBackup = payload.mode === "INIT" ? null : `${backupPrefix(target)}${payload.transaction_id}`;
  if (payload.backup !== expectedBackup) {
    fail("transaction journal backup is not the transaction-owned sibling path", journal);
  }
  if (payload.mode === "INIT") {
    if (payload.source_snapshot_sha256 !== null) {
      fail("INIT transaction journal must not contain a source snapshot", journal);
    }
  } else if (typeof payload.source_snapshot_sha256 !== "string" || !DIGEST_PATTERN.test(payload.source_snapshot_sha256)) {
    fail("mutable transaction journal has an invalid source snapshot digest", journal);
  }
  if (typeof payload.candidate_snapshot_sha256 !== "string" || !DIGEST_PATTERN.test(payload.candidate_snapshot_sha256)) {
    fail("transaction journal has an invalid candidate snapshot digest", journal);
  }
  if (payload.observed_source_snapshot_sha256 !== null &&
      (typeof payload.observed_source_snapshot_sha256 !== "string" ||
       !DIGEST_PATTERN.test(payload.observed_source_snapshot_sha256))) {
    fail("transaction journal has an invalid observed source snapshot digest", journal);
  }
  if (payload.mode === "INIT" && payload.observed_source_snapshot_sha256 !== null) {
    fail("INIT transaction journal must not contain an observed source snapshot", journal);
  }
  if (payload.observed_source_snapshot_sha256 !== null &&
      payload.observed_source_snapshot_sha256 === payload.source_snapshot_sha256) {
    fail("observed source snapshot must identify a real source conflict", journal);
  }
  if (payload.observed_source_snapshot_sha256 !== null && payload.phase !== PHASE_ROLLBACK_REQUIRED) {
    fail("observed source snapshot is valid only while rollback is required", journal);
  }
  return {
    mode: payload.mode,
    targetName: payload.target,
    stageName: payload.stage,
    backupName: payload.backup,
    phase: payload.phase,
    sourceSnapshotSha256: payload.source_snapshot_sha256,
    candidateSnapshotSha256: payload.candidate_snapshot_sha256,
    observedSourceSnapshotSha256: payload.observed_source_snapshot_sha256,
    transactionId: payload.transaction_id,
    ...(payload.mode==='CLOSE'?{closeBinding:validateCloseBinding(payload.close_binding,journal)}:{}),
  };
}

async function readJournal(target) {
  await settleJournalState(target);
  const record = await readStableJournalRecord(journalPath(target));
  if (record === null) return null;
  return attachJournalToken(
    parseJournal(target, record.payload),
    record.metadata,
    record.bytes,
  );
}

function lockPayload(record) {
  return {...(legacyInspection?{}:{filesystem_context:filesystemProof}),
    version: record.commonLease === undefined ? 1 : 2,
    state: record.state,
    owner_id: record.ownerId,
    operation_id: record.operationId,
    transaction_id: record.transactionId,
    pid: record.pid,
    hostname: record.hostname,
    started_at: record.startedAt,
    ...(record.commonLease === undefined ? {} : { common_lease: sortedJsonValue(record.commonLease) }),
  };
}

function lockRecordsEqual(left, right) {
  return compactAsciiJson(lockPayload(left)) === compactAsciiJson(lockPayload(right));
}

function parseLockPayload(filePath,payload) {
  if(payload===null||Array.isArray(payload)||typeof payload!=='object')fail('workspace publication lock root must be a JSON object',filePath);
  let structural=payload;
  if(!legacyInspection) {
    assertFilesystemProof(payload.filesystem_context);
    const {filesystem_context,...rest}=payload;structural=rest;
  }
  try{return validateLifecycleLockPayload(structural);}
  catch(error){fail(error.message,filePath);}
}

async function readLockRecord(filePath, { allowLinkedClaim = false } = {}) {
  const before = await lstatOrNull(filePath, { bigint: true });
  if (before === null) return null;
  const allowedLinks = allowLinkedClaim ? new Set([1n, 2n]) : new Set([1n]);
  if(before.isSymbolicLink())fail("workspace publication lock must not be a symlink",filePath);
  if(!before.isFile()||!allowedLinks.has(before.nlink))fail("workspace publication lock must be a single-link regular file",filePath);
  if(before.size>BigInt(MAX_LOCK_BYTES))fail("workspace publication lock exceeds the safe size limit",filePath);
  const handle = await fs.open(filePath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0) | (FS_CONSTANTS.O_NONBLOCK ?? 0));
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || !allowedLinks.has(metadata.nlink) || !sameInode(before, metadata)) {
      fail("workspace publication lock must be a single-link regular file", filePath);
    }
    if (metadata.size > BigInt(MAX_LOCK_BYTES)) {
      fail("workspace publication lock exceeds the safe size limit", filePath);
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_LOCK_BYTES) fail("workspace publication lock exceeds the safe size limit", filePath);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const after = await lstatOrNull(filePath, { bigint: true });
    if (after === null || !sameInode(metadata, after) || !allowedLinks.has(after.nlink)) {
      fail("workspace publication lock changed identity after being read", filePath);
    }
    return { record: parseLockPayload(filePath, parseJsonWithoutDuplicateKeys(text)), metadata: after, bytes };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail(`workspace publication lock is malformed (${error.message})`, filePath);
  } finally {
    await handle.close();
  }
}

// Observation for the coordinated locator cutover, not writer admission. Keep
// this beside the existing lock parser; neither settle nor recovery runs here.
async function inspectLifecycleLocatorTransition(target) {
  target = await normalizeTarget(target);
  const parent = path.dirname(target);
  const journalPath=value=>path.join(path.dirname(value), `.${path.basename(value)}.lifecycle-transaction.json`);
  const lockPath=value=>path.join(path.dirname(value), `.${path.basename(value)}.lifecycle.lock`);
  const readinessAttestationPath=value=>path.join(path.dirname(value), `.${path.basename(value)}.readiness-attestation.json`);
  // Historical controls keep their original geometry after normal leases move.
  const location={executionRoot:roots.executionRoot,parentIdentity:roots.targetParentIdentity,
    lockPath:path.join(parent,`.stnl-execution-${roots.specKey}.lock`)};
  const common = path.basename(location.lockPath);
  const prefixes = [journalTempPrefix(target), journalBuildPrefix(target), lockTempPrefix(target),
    lockBuildPrefix(target), lockRetiredPrefix(target), stagePrefix(target), backupPrefix(target),
    ownershipPrefix(target), retiredTreePrefix(target), `${common}.recovery-`, `${common}.retired-`,
    `.${path.basename(readinessAttestationPath(target))}.lifecycle-attestation-retired-`].map(filesystemComponentKey);
  const exact = new Set([path.basename(lockPath(target)), path.basename(journalPath(target)),
    path.basename(readinessAttestationPath(target)), common, common.replace(/\.lock$/u, '.preparations.json')].map(filesystemComponentKey));
  const related = names => names.filter(name => {
    const key = filesystemComponentKey(name);
    return exact.has(key) || prefixes.some(prefix => key.startsWith(prefix));
  }).sort(compareCodePoints);
  const before = related(await fs.readdir(parent));
  const lockName = path.basename(lockPath(target)),attestationName=path.basename(readinessAttestationPath(target));
  if (before.some(name => name !== lockName&&name!==attestationName))
    fail('locator transition has pending or uncertain legacy controls; preserve them', target);
  let readinessInput=null;
  if(before.includes(attestationName)) {
    const file=readinessAttestationPath(target),captured=await captureEphemeralAttestationIdentity(file);
    await validateMaybePromise(validateReadinessAttestation(target,file));
    await assertEphemeralAttestationIdentity(file,captured,'legacy readiness input classification');
    readinessInput={file,identity:filesystemIdentity(captured.metadata),sha256:`sha256:${captured.digest}`};
  }
  let observed = null;
  if (before.includes(lockName)) {
    observed = await readLockRecord(lockPath(target));
    if (observed === null || observed.record.state !== 'released' || observed.record.transactionId !== null)
      fail('locator transition legacy lock is active or uncertain; preserve it', target);
    const binding = observed.record.commonLease;
    if (binding !== undefined && (binding.executionRoot !== location.executionRoot || binding.lockPath !== location.lockPath
      || compactAsciiJson(binding.parentIdentity) !== compactAsciiJson(location.parentIdentity)))
      fail('locator transition legacy lock binding differs from the official context', target);
  }
  if (compactAsciiJson(before) !== compactAsciiJson(related(await fs.readdir(parent))))
    fail('locator transition legacy controls changed during inspection', target);
  if (observed !== null) {
    const after = await readLockRecord(lockPath(target));
    if (after === null || !sameInode(observed.metadata, after.metadata) || !observed.bytes.equals(after.bytes))
      fail('locator transition legacy lock changed during inspection', target);
  }
  if(readinessInput!==null) {
    const finalInput=await captureEphemeralAttestationIdentity(readinessInput.file);
    if(compactAsciiJson(readinessInput.identity)!==compactAsciiJson(filesystemIdentity(finalInput.metadata))
      ||readinessInput.sha256!==`sha256:${finalInput.digest}`)fail('legacy readiness input changed during inspection');
    await validateMaybePromise(validateReadinessAttestation(target,readinessInput.file));
  }
  const finalParent=await fs.lstat(parent,{bigint:true});
  if(!finalParent.isDirectory()||finalParent.isSymbolicLink()||await fs.realpath(parent)!==parent
    || compactAsciiJson(location.parentIdentity) !== compactAsciiJson(filesystemIdentity(finalParent)))
    fail('locator transition official parent changed during inspection', target);
  return {target, classification:observed===null&&readinessInput===null?'clear':'historical-inert',activation:'read-only',
    legacyReadinessInput:readinessInput,
    legacyLock:observed === null ? null : {file:lockPath(target), identity:filesystemIdentity(observed.metadata),
      sha256:`sha256:${createHash('sha256').update(observed.bytes).digest('hex')}`}};
}

function ownerIsProvablyDead(record) {
  if (record.hostname !== os.hostname()) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function validateLockJournalRelationship(target, record) {
  const transaction = await readJournal(target);
  if (transaction === null) return;
  if (record.transactionId === null || record.transactionId !== transaction.transactionId) {
    fail("workspace publication lock transaction identity does not match the recovery journal", lockPath(target));
  }
}

async function retireValidatedLock(target, observed) {
  await assertPhysicalRoles();
  const current = await readLockRecord(lockPath(target));
  if (current === null) return false;
  if (!sameInode(current.metadata, observed.metadata) ||
      !lockRecordsEqual(current.record, observed.record)) return false;
  const retired = path.join(materialParent(target), `${lockRetiredPrefix(target)}${observed.record.ownerId}-${randomIdentity()}`);
  try {
    await renameWithRetry(lockPath(target), retired);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const moved = await readLockRecord(retired);
  if (moved === null || !lockRecordsEqual(moved.record, observed.record) ||
      !sameInode(moved.metadata, observed.metadata)) {
    fail("workspace publication lock changed identity during validated retirement", retired);
  }
  if (await lexists(lockPath(target))) {
    fail("workspace publication lock canonical path appeared during validated retirement", lockPath(target));
  }
  await testOnlySwapPrivateFile(
    retired,
    "LOCK_RETIRE_QUARANTINE_SWAP",
    "lock retirement quarantine",
  );
  const final = await readLockRecord(retired);
  if (final === null || !lockRecordsEqual(final.record, observed.record) ||
      !sameInode(final.metadata, observed.metadata)) {
    fail("workspace publication lock changed immediately before retirement cleanup", retired);
  }
  const rechecked = await fs.lstat(retired, { bigint: true });
  if (!sameInode(final.metadata, rechecked) || rechecked.nlink !== 1n) {
    fail("workspace publication lock changed immediately before retirement cleanup", retired);
  }
  if (await lexists(lockPath(target))) {
    fail("workspace publication lock canonical path appeared during validated retirement", lockPath(target));
  }
  await fs.unlink(retired);
  await fsyncDirectory(materialParent(target));
  return true;
}

function lockHostDigest(hostname) {
  return createHash("sha256").update(hostname, "utf8").digest("hex").slice(0, 16);
}

function lockTempName(target, record) {
  return `${lockTempPrefix(target)}${record.ownerId}-${record.operationId}-${record.pid}-` +
    `${lockHostDigest(record.hostname)}-${randomIdentity()}`;
}

function parseLockTempName(target, name) {
  const prefix = lockTempPrefix(target);
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  const updateNext = suffix.match(
    /^u-n-(\d+)-(\d+)-(\d+)-(\d+)-([0-9a-f]{64})-([0-9a-f]{32})$/u,
  );
  if (updateNext !== null) {
    return {
      ownerId: null, operationId: null, pid: null,
      hostDigest: null, role: "next",
      identity: { dev: updateNext[1], ino: updateNext[2] },
      priorIdentity: { dev: updateNext[3], ino: updateNext[4] },
      priorDigest: updateNext[5],
    };
  }
  const updatePrevious = suffix.match(
    /^u-p-(\d+)-(\d+)-([0-9a-f]{32})$/u,
  );
  if (updatePrevious !== null) {
    return {
      ownerId: null, operationId: null, pid: null,
      hostDigest: null, role: "previous",
      identity: { dev: updatePrevious[1], ino: updatePrevious[2] },
      priorIdentity: null, priorDigest: null,
    };
  }
  const match = suffix.match(
    /^([0-9a-f]{32})-([0-9a-f]{32})-(\d+)-([0-9a-f]{16})-([0-9a-f]{32})$/u,
  );
  if (match === null) return null;
  const pid = Number(match[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return {
    ownerId: match[1], operationId: match[2], pid, hostDigest: match[4],
    role: "create", identity: null, priorIdentity: null, priorDigest: null,
  };
}

function lockUpdateRolePath(target, record, role, identity, prior = null) {
  void record;
  const base = `${lockTempPrefix(target)}u-${role === "next" ? "n" : "p"}-` +
    `${identity.dev}-${identity.ino}`;
  const suffix = role === "next"
    ? `-${prior.identity.dev}-${prior.identity.ino}-${prior.digest}`
    : "";
  return path.join(materialParent(target), `${base}${suffix}-${randomIdentity()}`);
}

function lockTransitionCompatible(previous, next) {
  return previous.state === "active" &&
    new Set(["active", "released"]).has(next.state) &&
    previous.ownerId === next.ownerId && previous.operationId === next.operationId &&
    previous.pid === next.pid && previous.hostname === next.hostname &&
    previous.startedAt === next.startedAt &&
    compactAsciiJson(sortedJsonValue(previous.commonLease ?? null)) === compactAsciiJson(sortedJsonValue(next.commonLease ?? null)) &&
    (previous.state !== next.state || previous.transactionId !== next.transactionId);
}

async function lockUpdateRoleRecords(target) {
  const roles = [];
  for (const name of (await fs.readdir(materialParent(target))).sort(compareCodePoints)) {
    const parsed = parseLockTempName(target, name);
    if (parsed === null || parsed.role === "create") continue;
    const filePath = path.join(materialParent(target), name);
    const observed = await readLockRecord(filePath, { allowLinkedClaim: true });
    if (observed === null || !sameFilesystemIdentity(observed.metadata, parsed.identity) ||
        (parsed.ownerId !== null &&
         (parsed.ownerId !== observed.record.ownerId || parsed.operationId !== observed.record.operationId ||
          parsed.pid !== observed.record.pid || parsed.hostDigest !== lockHostDigest(observed.record.hostname)))) {
      fail("workspace publication lock update role changed encoded identity", filePath);
    }
    roles.push({ ...parsed, filePath, observed });
  }
  return roles;
}

function lockPriorMatches(next, previous) {
  return sameFilesystemIdentity(previous.observed.metadata, next.priorIdentity) &&
    createHash("sha256").update(previous.observed.bytes).digest("hex") === next.priorDigest &&
    lockTransitionCompatible(previous.observed.record, next.observed.record);
}

async function validateLinkedLockUpdate(target, next) {
  const canonical = await readLockRecord(lockPath(target), { allowLinkedClaim: true });
  const linked = await readLockRecord(next.filePath, { allowLinkedClaim: true });
  if (canonical === null || linked === null ||
      canonical.metadata.nlink !== 2n || linked.metadata.nlink !== 2n ||
      !sameInode(canonical.metadata, linked.metadata) ||
      !canonical.bytes.equals(linked.bytes) ||
      !lockRecordsEqual(canonical.record, next.observed.record)) {
    fail("workspace publication lock update has an invalid atomic claim", lockPath(target));
  }
  return canonical;
}

async function removeOwnedLockRole(role, label) {
  const observed = await readLockRecord(role.filePath);
  if (observed === null || !sameFilesystemIdentity(observed.metadata, role.identity) ||
      !observed.bytes.equals(role.observed.bytes)) {
    fail(`${label} changed before cleanup`, role.filePath);
  }
  await testOnlySwapPrivateFile(
    role.filePath,
    "LOCK_ROLE_CLEANUP_SWAP",
    "lock role cleanup",
  );
  const final = await fs.lstat(role.filePath, { bigint: true });
  if (!sameFilesystemIdentity(final, role.identity) || final.nlink !== 1n) {
    fail(`${label} changed immediately before cleanup`, role.filePath);
  }
  await fs.unlink(role.filePath);
  await fsyncDirectory(path.dirname(role.filePath));
}

async function settleLinkedLockUpdate(target, next) {
  const canonical = await validateLinkedLockUpdate(target, next);
  await testOnlySwapPrivateFile(
    next.filePath,
    "LOCK_ROLE_CLEANUP_SWAP",
    "lock role cleanup",
  );
  const final = await fs.lstat(next.filePath, { bigint: true });
  if (!sameFilesystemIdentity(final, next.identity) || final.nlink !== 2n) {
    fail("workspace publication lock update claim changed before settlement", next.filePath);
  }
  await fs.unlink(next.filePath);
  await fsyncDirectory(materialParent(target));
  const installed = await readLockRecord(lockPath(target));
  if (installed === null || !sameInode(installed.metadata, canonical.metadata) ||
      !installed.bytes.equals(canonical.bytes)) {
    fail("workspace publication lock update was not durably settled", lockPath(target));
  }
  return installed;
}

async function claimLockNext(target, next, previous, { checkpoints = false } = {}) {
  const filePath = lockPath(target);
  if (await lexists(filePath)) fail("workspace publication lock was replaced before atomic promotion", filePath);
  try {
    await fs.link(next.filePath, filePath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("workspace publication lock was replaced before atomic promotion", filePath);
    }
    throw error;
  }
  await fsyncDirectory(materialParent(target));
  if (checkpoints) testOnlyCheckpoint("LOCK_UPDATE_CLAIMED");
  await validateLinkedLockUpdate(target, next);
  if (previous !== null) await removeOwnedLockRole(previous, "previous workspace publication lock");
  return settleLinkedLockUpdate(target, next);
}

async function testOnlySwapLockCreateCanonical(target, expected, window) {
  if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] !== window) return;
  const filePath = lockPath(target);
  const preserved = `${filePath}.test-owned-original`;
  const foreignOwner = expected.ownerId === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32);
  const foreignOperation = expected.operationId === "d".repeat(32)
    ? "c".repeat(32)
    : "d".repeat(32);
  const foreign = {
    ...expected,
    ownerId: foreignOwner,
    operationId: foreignOperation,
    transactionId: null,
    pid: process.pid,
    hostname: os.hostname(),
    commonLease: undefined,
  };
  await renameWithRetry(filePath, preserved);
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(prettySortedAsciiJson(lockPayload(foreign)), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(materialParent(target));
}

async function validateLinkedLockCreate(target, tempPath, expected = null) {
  const filePath = lockPath(target);
  const parsed = parseLockTempName(target, path.basename(tempPath));
  const canonical = await readLockRecord(filePath, { allowLinkedClaim: true });
  const temp = await readLockRecord(tempPath, { allowLinkedClaim: true });
  if (parsed?.role !== "create" || canonical === null || temp === null ||
      canonical.metadata.nlink !== 2n || temp.metadata.nlink !== 2n ||
      !sameInode(canonical.metadata, temp.metadata) ||
      !canonical.bytes.equals(temp.bytes) ||
      !lockRecordsEqual(canonical.record, temp.record) ||
      (expected !== null && !lockRecordsEqual(canonical.record, expected)) ||
      parsed.ownerId !== canonical.record.ownerId ||
      parsed.operationId !== canonical.record.operationId ||
      parsed.pid !== canonical.record.pid ||
      parsed.hostDigest !== lockHostDigest(canonical.record.hostname)) {
    fail("workspace publication lock create claim changed before settlement", filePath);
  }
  return { canonical, temp };
}

async function settleLinkedLockCreate(target, tempPath, expected = null, mutationWindow = null) {
  const filePath = lockPath(target);
  const first = await validateLinkedLockCreate(target, tempPath, expected);
  if (mutationWindow !== null) {
    await testOnlySwapLockCreateCanonical(target, first.canonical.record, mutationWindow);
  }
  const final = await validateLinkedLockCreate(target, tempPath, expected);
  if (!sameInode(first.canonical.metadata, final.canonical.metadata) ||
      !first.canonical.bytes.equals(final.canonical.bytes)) {
    fail("workspace publication lock create claim changed before settlement", filePath);
  }
  await fs.unlink(tempPath);
  await fsyncDirectory(materialParent(target));
  const installed = await readLockRecord(filePath);
  if (installed === null || !sameInode(installed.metadata, first.canonical.metadata) ||
      !installed.bytes.equals(first.canonical.bytes) ||
      !lockRecordsEqual(installed.record, first.canonical.record)) {
    fail("workspace publication lock create claim changed during settlement", filePath);
  }
  return installed;
}

async function settleLinkedLockClaim(target, { validateOnly = false } = {}) {
  const filePath = lockPath(target);
  const lockMetadata = await lstatOrNull(filePath, { bigint: true });
  const updateRoles = await lockUpdateRoleRecords(target);
  const next = updateRoles.filter((entry) => entry.role === "next");
  const previous = updateRoles.filter((entry) => entry.role === "previous");
  if (lockMetadata === null) {
    if (updateRoles.length === 0) return;
    if (next.length === 1 && previous.length === 1 && lockPriorMatches(next[0], previous[0])) {
      if (validateOnly) return next[0].observed.record;
      await claimLockNext(target, next[0], previous[0]);
      return;
    }
    fail("workspace publication lock recovery residues are ambiguous", materialParent(target));
  }
  if (lockMetadata.isSymbolicLink()) {
    fail("workspace publication lock must not be a symlink", filePath);
  }
  if (!lockMetadata.isFile() || !new Set([1n, 2n]).has(lockMetadata.nlink)) {
    fail("workspace publication lock must be a single-link regular file", filePath);
  }
  if (lockMetadata.nlink === 2n) {
    const matches = [];
    for (const name of await fs.readdir(materialParent(target))) {
      if (!name.startsWith(lockTempPrefix(target))) continue;
      const candidate = path.join(materialParent(target), name);
      const metadata = await lstatOrNull(candidate, { bigint: true });
      if (metadata !== null && sameInode(metadata, lockMetadata)) matches.push(candidate);
    }
    if (matches.length !== 1) {
      fail("workspace publication lock must be a single-link regular file; no valid atomic claim residue exists", filePath);
    }
    const parsed = parseLockTempName(target, path.basename(matches[0]));
    if (parsed?.role === "next") {
      const claim = next.find((entry) => entry.filePath === matches[0]);
      if (claim === undefined || next.length !== 1 || previous.length > 1) {
        fail("workspace publication lock update residues are ambiguous", filePath);
      }
      await validateLinkedLockUpdate(target, claim);
      if (previous.length === 1) {
        if (!lockPriorMatches(claim, previous[0])) {
          fail("workspace publication lock update residues do not match", filePath);
        }
        if (validateOnly) return claim.observed.record;
        await removeOwnedLockRole(previous[0], "previous workspace publication lock");
      }
      if (validateOnly) return claim.observed.record;
      await settleLinkedLockUpdate(target, claim);
      return;
    }
    if (parsed?.role !== "create" || updateRoles.length !== 0) {
      fail("workspace publication lock has an invalid atomic claim residue", filePath);
    }
    if (validateOnly) return (await validateLinkedLockCreate(target, matches[0])).canonical.record;
    await settleLinkedLockCreate(
      target,
      matches[0],
      null,
      "LOCK_CREATE_RECOVERY_CANONICAL_SWAP",
    );
    return;
  }
  if (updateRoles.length === 0) return validateOnly ? (await readLockRecord(filePath)).record : undefined;
  if (next.length === 1 && previous.length === 0) {
    const canonical = await readLockRecord(filePath);
    const prior = { observed: canonical };
    if (!lockPriorMatches(next[0], prior)) {
      fail("workspace publication lock canonical identity or payload changed before atomic update", filePath);
    }
    if (validateOnly) return next[0].observed.record;
    const previousPath = lockUpdateRolePath(
      target,
      canonical.record,
      "previous",
      filesystemIdentity(canonical.metadata),
    );
    await renameWithRetry(filePath, previousPath);
    await fsyncDirectory(materialParent(target));
    const previousObserved = await readLockRecord(previousPath);
    if (previousObserved === null || !sameInode(previousObserved.metadata, canonical.metadata) ||
        !previousObserved.bytes.equals(canonical.bytes)) {
      fail("workspace publication lock changed during update quarantine", previousPath);
    }
    const previousRole = {
      role: "previous", identity: filesystemIdentity(canonical.metadata),
      filePath: previousPath, observed: previousObserved,
    };
    await claimLockNext(target, next[0], previousRole);
    return;
  }
  fail("workspace publication lock canonical path appeared in an interrupted atomic operation", filePath);
}

async function createExclusiveLock(target, record) {
  await assertPhysicalRoles();
  const filePath = lockPath(target);
  const temp = path.join(materialParent(target), lockTempName(target, record));
  const build = path.join(
    materialParent(target),
    `${lockBuildPrefix(target)}${record.ownerId}-${randomIdentity()}`,
  );
  let handle = await fs.open(build, "wx", 0o600);
  testOnlyCheckpoint("LOCK_BUILD_ALLOCATED");
  try {
    await handle.writeFile(prettySortedAsciiJson(lockPayload(record)), "utf8");
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n) {
      fail("workspace publication lock claim build must be a single-link regular file", build);
    }
  } finally {
    await handle.close();
  }
  await renameWithRetry(build, temp);
  await fsyncDirectory(materialParent(target));
  testOnlyCheckpoint("LOCK_TEMP_WRITTEN");
  const ownedTemp = await readLockRecord(temp);
  if (ownedTemp === null || !lockRecordsEqual(ownedTemp.record, record)) {
    fail("workspace publication lock claim candidate changed after construction", temp);
  }
  if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] === "LOCK_CREATE_CLEANUP_SWAP") {
    const foreign = {
      ...record,
      ownerId: record.ownerId === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32),
      operationId: record.operationId === "d".repeat(32) ? "c".repeat(32) : "d".repeat(32),
      transactionId: null,
      pid: process.pid,
      hostname: os.hostname(),
    };
    const foreignHandle = await fs.open(filePath, "wx", 0o600);
    try {
      await foreignHandle.writeFile(prettySortedAsciiJson(lockPayload(foreign)), "utf8");
      await foreignHandle.sync();
    } finally {
      await foreignHandle.close();
    }
    await fsyncDirectory(materialParent(target));
  }
  try {
    await fs.link(temp, filePath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      await cleanupExclusiveCreateCandidate(
        temp,
        ownedTemp.metadata,
        ownedTemp.bytes,
        {
          label: "workspace publication lock exclusive-create candidate",
          mutationWindow: "LOCK_CREATE_CLEANUP_SWAP",
        },
      );
      return null;
    }
    throw error;
  }
  await fsyncDirectory(materialParent(target));
  testOnlyCheckpoint("LOCK_CLAIM_LINKED");
  return settleLinkedLockCreate(
    target,
    temp,
    record,
    "LOCK_CREATE_LIVE_CANONICAL_SWAP",
  );
}

async function replaceOwnedLock(target, previous, next) {
  await assertPhysicalRoles();
  const filePath = lockPath(target);
  const current = await readLockRecord(filePath);
  if (current === null || !sameInode(current.metadata, previous.metadata) ||
      !lockRecordsEqual(current.record, previous.record) || previous.record.state !== "active") {
    fail("workspace publication lock ownership changed during operation", filePath);
  }
  const build = path.join(
    materialParent(target),
    `${lockBuildPrefix(target)}${next.ownerId}-${randomIdentity()}`,
  );
  let handle = await fs.open(build, "wx", 0o600);
  try {
    await handle.writeFile(prettySortedAsciiJson(lockPayload(next)), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
    handle = null;
  }
  const buildMetadata = await fs.lstat(build, { bigint: true });
  const temp = lockUpdateRolePath(
    target,
    next,
    "next",
    filesystemIdentity(buildMetadata),
    {
      identity: filesystemIdentity(previous.metadata),
      digest: createHash("sha256").update(previous.bytes).digest("hex"),
    },
  );
  await renameWithRetry(build, temp);
  await fsyncDirectory(materialParent(target));
  const nextRole = (await lockUpdateRoleRecords(target)).find((entry) => entry.filePath === temp);
  if (nextRole === undefined || !lockRecordsEqual(nextRole.observed.record, next)) {
    fail("workspace publication lock update candidate changed after construction", temp);
  }
  testOnlyCheckpoint("LOCK_UPDATE_READY");
  const rechecked = await readLockRecord(filePath);
  if (rechecked === null || !lockRecordsEqual(rechecked.record, previous.record) ||
      !sameInode(rechecked.metadata, previous.metadata)) {
    fail("workspace publication lock ownership changed during operation", filePath);
  }
  const previousPath = lockUpdateRolePath(
    target,
    previous.record,
    "previous",
    filesystemIdentity(previous.metadata),
  );
  await renameWithRetry(filePath, previousPath);
  await fsyncDirectory(materialParent(target));
  const previousObserved = await readLockRecord(previousPath);
  if (previousObserved === null || !sameInode(previousObserved.metadata, previous.metadata) ||
      !previousObserved.bytes.equals(previous.bytes)) {
    fail("workspace publication lock changed during update quarantine", previousPath);
  }
  const previousRole = {
    role: "previous", identity: filesystemIdentity(previous.metadata),
    filePath: previousPath, observed: previousObserved,
  };
  testOnlyCheckpoint("LOCK_UPDATE_QUARANTINED");
  if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] === "LOCK_UPDATE_CANONICAL_SWAP") {
    await fs.writeFile(filePath, "foreign lock update sentinel\n", { flag: "wx", mode: 0o600 });
  }
  const replaced = await claimLockNext(
    target,
    nextRole,
    previousRole,
    { checkpoints: true },
  );
  if (replaced === null || !lockRecordsEqual(replaced.record, next)) {
    fail("workspace publication lock update was not durably installed", filePath);
  }
  return replaced;
}

async function cleanupMalformedLockTemp(target, residue, parsedName) {
  void target;
  void parsedName;
  fail("publisher lock temp residue is malformed; preserving untrusted evidence", residue);
}

async function quarantineAndRemoveLockResidue(target, residue, observed) {
  const quarantine = path.join(
    materialParent(target),
    `${lockRetiredPrefix(target)}${observed.record.ownerId}-${randomIdentity()}`,
  );
  await renameWithRetry(residue, quarantine);
  await fsyncDirectory(materialParent(target));
  const moved = await readLockRecord(quarantine);
  if (moved === null || !sameInode(moved.metadata, observed.metadata) ||
      !lockRecordsEqual(moved.record, observed.record)) {
    fail("publisher lock residue changed during quarantine", quarantine);
  }
  if (process.env[TEST_ONLY_MUTATE_WINDOW_ENV] === "LOCK_RESIDUE_QUARANTINE_SWAP") {
    await renameWithRetry(quarantine, `${quarantine}.test-owned-original`);
    await fs.writeFile(quarantine, "foreign lock residue quarantine sentinel\n", "utf8");
  }
  const final = await readLockRecord(quarantine);
  if (final === null || !sameInode(final.metadata, observed.metadata) ||
      !lockRecordsEqual(final.record, observed.record)) {
    fail("publisher lock residue changed immediately before cleanup", quarantine);
  }
  await fs.unlink(quarantine);
  await fsyncDirectory(materialParent(target));
}

async function cleanupValidatedLockResidues(target, currentOwnerId) {
  const names = (await fs.readdir(materialParent(target)))
    .filter((name) =>
      name.startsWith(lockTempPrefix(target)) || name.startsWith(lockRetiredPrefix(target)))
    .sort(compareCodePoints);
  for (const name of names) {
    const residue = path.join(materialParent(target), name);
    let observed;
    try {
      observed = await readLockRecord(residue);
    } catch (error) {
      if (!name.startsWith(lockTempPrefix(target))) throw error;
      await cleanupMalformedLockTemp(target, residue, parseLockTempName(target, name));
      continue;
    }
    if (observed === null) continue;
    if (observed.record.ownerId === currentOwnerId) {
      fail("active workspace lock owns an unexpected lock residue", residue);
    }
    if (name.startsWith(lockTempPrefix(target))) {
      const parsedName = parseLockTempName(target, name);
      if (parsedName === null || parsedName.ownerId !== observed.record.ownerId ||
          parsedName.operationId !== observed.record.operationId ||
          parsedName.pid !== observed.record.pid ||
          parsedName.hostDigest !== lockHostDigest(observed.record.hostname)) {
        fail("publisher lock temp residue payload does not match its claim identity", residue);
      }
    }
    if (observed.record.state === "active" && !ownerIsProvablyDead(observed.record)) {
      fail("publisher lock residue belongs to an owner that is not provably dead", residue);
    }
    await validateLockJournalRelationship(target, observed.record);
    const rechecked = await readLockRecord(residue);
    if (rechecked === null) continue;
    if (!sameInode(rechecked.metadata, observed.metadata) ||
        !lockRecordsEqual(rechecked.record, observed.record)) {
      fail("publisher lock residue changed identity before cleanup", residue);
    }
    await quarantineAndRemoveLockResidue(target, residue, observed);
  }
}

async function acquireWorkspaceLock(target, commonLease) {
  await assertPhysicalRoles();
  const operationId = randomIdentity();
  const record = {
    state: "active",
    ownerId: randomIdentity(),
    operationId,
    transactionId: null,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    commonLease,
  };
  for (let attempt = 0; attempt < 64; attempt += 1) {
    await settleLinkedLockClaim(target);
    const created = await createExclusiveLock(target, record);
    if (created !== null) {
      let current = created;
      try {
        await cleanupValidatedLockResidues(target, current.record.ownerId);
      } catch (error) {
        const released = { ...current.record, state: "released" };
        try {
          await replaceOwnedLock(target, current, released);
        } catch (releaseError) {
          const combined = new ValidationError(
            `workspace lock residue validation failed: ${error.message}; ` +
            `workspace lock release also failed: ${releaseError.message}`,
          );
          combined.cause = new AggregateError(
            [error, releaseError],
            "lock residue validation and lock release both failed",
          );
          throw combined;
        }
        throw error;
      }
      return {
        get record() { return current.record; },
        async setTransactionId(transactionId) {
          if (!TRANSACTION_ID_PATTERN.test(transactionId)) fail("invalid publisher transaction identity");
          const next = { ...current.record, transactionId };
          current = await replaceOwnedLock(target, current, next);
        },
        async clearTransactionId() {
          const next = { ...current.record, transactionId: null };
          current = await replaceOwnedLock(target, current, next);
        },
        async release() {
          const released = { ...current.record, state: "released" };
          current = await replaceOwnedLock(target, current, released);
        },
      };
    }
    await settleLinkedLockClaim(target);
    const observed = await readLockRecord(lockPath(target));
    if (observed === null) continue;
    if (observed.record.state === "active") {
      if (!ownerIsProvablyDead(observed.record)) {
        fail("another publisher already holds the workspace lock", lockPath(target));
      }
      await validateLockJournalRelationship(target, observed.record);
      if ((await readJournal(target)) === null && observed.record.transactionId !== null) {
        await cleanupAbandonedPreJournalTransaction(target, observed.record.transactionId);
      }
    } else {
      await validateLockJournalRelationship(target, observed.record);
      if ((await readJournal(target)) === null && observed.record.transactionId !== null) {
        await cleanupAbandonedPreJournalTransaction(target, observed.record.transactionId);
      }
    }
    await retireValidatedLock(target, observed);
  }
  fail("could not acquire the workspace publication lock", lockPath(target));
}

async function withWorkspaceLock(target, action, commonLease) {
  await assertPhysicalRoles();
  const lease = await acquireWorkspaceLock(target, commonLease);
  let result;
  let actionError = null;
  try {
    result = await action(lease);
  } catch (error) {
    actionError = error;
  }
  if(actionError?.retainExecutionLock)throw actionError;
  if(result?.publication==='confirmed'&&['pending','complete'].includes(result.cleanup))return result;
  let releaseError = null;
  try {
    await lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (actionError !== null && releaseError !== null) {
    const combined = new ValidationError(
      `workspace action failed: ${actionError.message}; workspace lock release also failed: ${releaseError.message}`,
    );
    combined.cause = new AggregateError([actionError, releaseError], "action and lock release both failed");
    if(actionError.retainExecutionLock||releaseError.retainExecutionLock)combined.retainExecutionLock=true;
    throw combined;
  }
  if (actionError !== null) throw actionError;
  if (releaseError !== null) throw releaseError;
  return result;
}

async function transactionPaths(target, transaction) {
  const stage = path.join(materialParent(target), transaction.stageName);
  const backup = transaction.backupName === null ? null : path.join(materialParent(target), transaction.backupName);
  for (const [label, candidate] of [["stage", stage], ["backup", backup]]) {
    if (candidate === null) continue;
    const metadata = await lstatOrNull(candidate);
    if (metadata === null) continue;
    if (metadata.isSymbolicLink()) fail(`transaction ${label} must not be a symlink`, candidate);
    if (!metadata.isDirectory()) fail(`transaction ${label} must be a real directory`, candidate);
  }
  const targetMetadata = await lstatOrNull(target);
  if (targetMetadata?.isSymbolicLink()) fail("transaction target must not be a symlink", target);
  if (targetMetadata !== null && !targetMetadata.isDirectory()) fail("transaction target must be a real directory", target);
  return { stage, backup };
}

async function cleanupAbandonedPreJournalTransaction(target, transactionId) {
  const ownership = await readOwnership(target, transactionId);
  const stage = path.join(materialParent(target), `${stagePrefix(target)}${transactionId}`);
  const backup = path.join(materialParent(target), `${backupPrefix(target)}${transactionId}`);
  if (ownership === null) {
    if (await lexists(stage) || await lexists(backup)) {
      fail("pre-journal transaction residues have no durable ownership record", materialParent(target));
    }
    // A crash while atomically creating the initial sidecar may leave only a
    // transaction-named temp file. The dead lock's transaction id authorizes
    // cleanup of that exact single-link sibling, never an arbitrary file.
    await cleanupOwnershipTemps(target, transactionId);
    await cleanupRetiredOwnership(target, transactionId);
    return;
  }
  if (await lexists(backup)) {
    fail("pre-journal transaction unexpectedly has a backup residue", backup);
  }
  if (await lexists(stage)) {
    if (ownership.stageIdentity === null) {
      fail("pre-journal stage has no persisted filesystem identity", stage);
    }
    await removeOwnedDirectory(
      target,
      transactionId,
      "stage",
      stage,
      ownership.stageIdentity,
      ownership.candidateSnapshotSha256,
    );
  } else if (ownership.stageIdentity !== null) {
    await removeOwnedDirectory(
      target,
      transactionId,
      "stage",
      stage,
      ownership.stageIdentity,
      ownership.candidateSnapshotSha256,
    );
  }
  await removeOwnership(target, ownership);
  await cleanupOwnershipTemps(target, transactionId);
  await cleanupRetiredOwnership(target, transactionId, ownership);
}

async function cleanupOwnershipTemps(target, transactionId) {
  const prefix = `${ownershipTempPrefix(target)}${transactionId}-`;
  const canonical = await readOwnership(target, transactionId);
  for (const name of (await fs.readdir(materialParent(target))).sort(compareCodePoints)) {
    if (!name.startsWith(prefix)) continue;
    const filePath = path.join(materialParent(target), name);
    const metadata = await lstatOrNull(filePath, { bigint: true });
    if (metadata === null) continue;
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n) {
      fail("transaction ownership temp must be a single-link regular file", filePath);
    }
    const read = await readBoundedSingleLinkFile(
      filePath,
      MAX_JOURNAL_BYTES,
      "transaction ownership temp",
    );
    let tempOwnership;
    try {
      tempOwnership = parseOwnership(
        target,
        transactionId,
        parseJsonWithoutDuplicateKeys(
          new TextDecoder("utf-8", { fatal: true }).decode(read.bytes),
        ),
      );
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      fail(`transaction ownership temp is malformed (${error.message}); preserving untrusted evidence`, filePath);
    }
    if (canonical !== null) {
      for (const field of [
        "mode", "targetName", "stageName", "backupName", "transactionId",
        "stageIdentity", "candidateSnapshotSha256", "sourceIdentity",
        "sourceSnapshotSha256", "backupIdentity", "promotedIdentity",
        ...(canonical.mode==='CLOSE'?['closeBinding']:[]),
      ]) {
        const existing = compactAsciiJson(canonical[field]);
        const candidate = compactAsciiJson(tempOwnership[field]);
        if (canonical[field] !== null && existing !== candidate) {
          fail("transaction ownership temp conflicts with the canonical ownership record", filePath);
        }
      }
    }
    const retired = `${filePath}.retired-${randomIdentity()}`;
    await renameWithRetry(filePath, retired);
    const moved = await fs.lstat(retired, { bigint: true });
    if (!sameInode(metadata, moved)) {
      fail("transaction ownership temp changed identity during cleanup", retired);
    }
    await fs.unlink(retired);
    await fsyncDirectory(materialParent(target));
  }
}

async function scanResidues(target) {
  await assertPhysicalRoles();
  const prefixes = [
    stagePrefix(target), backupPrefix(target), journalTempPrefix(target),
    ownershipPrefix(target), ownershipTempPrefix(target), retiredTreePrefix(target),
  ];
  return (await fs.readdir(materialParent(target)))
    .filter((name) =>
      !name.startsWith(ownershipBuildPrefix(target)) &&
      prefixes.some((prefix) => name.startsWith(prefix)))
    .sort(compareCodePoints)
    .map((name) => path.join(materialParent(target), name));
}

async function validateResidueSet(target, transaction) {
  const residues = await scanResidues(target);
  if (transaction === null) {
    if (residues.length !== 0) {
      fail(
        `orphan publisher residues require manual inspection; no journal authorizes recovery: ${JSON.stringify(residues.map((value) => path.basename(value)))}`,
        materialParent(target),
      );
    }
    return [];
  }
  const allowed = new Set([
    transaction.stageName,
    path.basename(ownershipPath(target, transaction.transactionId)),
  ]);
  if (transaction.backupName !== null) allowed.add(transaction.backupName);
  const journalTemps = [];
  const unexpected = [];
  for (const residue of residues) {
    const name = path.basename(residue);
    if (allowed.has(name) || name.startsWith(
      `${retiredTreePrefix(target)}${transaction.transactionId}-`,
    )) continue;
    if (name.startsWith(journalTempPrefix(target))) {
      const metadata = await fs.lstat(residue);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        fail("transaction journal temp residue must be a real file", residue);
      }
      const tempTransaction = parseJournal(target, await readJournalPayload(residue));
      if (tempTransaction.transactionId !== transaction.transactionId) {
        fail("transaction journal temp belongs to a different transaction", residue);
      }
      journalTemps.push(residue);
    } else if (name.startsWith(`${ownershipTempPrefix(target)}${transaction.transactionId}-`)) {
      const metadata = await fs.lstat(residue, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1n) {
        fail("transaction ownership temp residue must be a single-link regular file", residue);
      }
      journalTemps.push(residue);
    } else {
      unexpected.push(name);
    }
  }
  if (unexpected.length !== 0) {
    fail(`transaction journal does not own publisher residues ${JSON.stringify(unexpected)}`, materialParent(target));
  }
  return journalTemps;
}

async function removeJournal(target, transaction) {
  await assertPhysicalRoles();
  const journal = journalPath(target);
  const token = requireJournalToken(transaction, journal);
  await assertOwnedJournal(target, transaction);
  const retired = journalRolePath(
    target,
    transaction.transactionId,
    "cleanup",
    token.identity,
  );
  await renameWithRetry(journal, retired);
  await fsyncDirectory(materialParent(target));
  const moved = await readStableJournalRecord(retired);
  assertJournalRecordMatches(
    moved,
    token,
    "transaction journal changed ownership during cleanup quarantine",
    retired,
  );
  testOnlyCheckpoint("JOURNAL_CLEANUP_QUARANTINED");
  if (await lexists(journal)) {
    fail("transaction journal was replaced during cleanup", journal);
  }
  await removeOwnedJournalResidue(retired, token, "quarantined transaction journal");
  if (await lexists(journal)) {
    fail("transaction journal appeared during cleanup", journal);
  }
  delete transaction[JOURNAL_TOKEN];
}

async function cleanupJournalTemps(paths, target, transaction) {
  for (const temp of paths) {
    const metadata = await lstatOrNull(temp);
    if (metadata === null) continue;
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("journal temp residue changed type before cleanup", temp);
    }
    const tempTransaction = parseJournal(target, await readJournalPayload(temp));
    if (tempTransaction.transactionId !== transaction.transactionId) {
      fail("transaction journal temp belongs to a different transaction", temp);
    }
    const role = parseJournalRoleName(target, path.basename(temp));
    if (role !== null && !sameFilesystemIdentity(
      await fs.lstat(temp, { bigint: true }),
      role.identity,
    )) {
      fail("transaction journal temp changed its encoded ownership identity", temp);
    }
    const before = await fs.lstat(temp, { bigint: true });
    const retired = `${temp}.retired-${before.dev.toString()}-${before.ino.toString()}`;
    await renameWithRetry(temp, retired);
    const moved = await fs.lstat(retired, { bigint: true });
    if (!sameInode(before, moved)) fail("journal temp changed identity during quarantine", retired);
    const movedTransaction = parseJournal(target, await readJournalPayload(retired));
    if (movedTransaction.transactionId !== transaction.transactionId) {
      fail("journal temp changed payload during quarantine", retired);
    }
    const final = await fs.lstat(retired, { bigint: true });
    if (!sameInode(before, final)) fail("journal temp changed identity before cleanup", retired);
    await fs.unlink(retired);
    await fsyncDirectory(path.dirname(temp));
  }
}

async function advance(target, transaction, phase) {
  const updated = { ...transaction, phase };
  await writeJournal(target, updated);
  return updated;
}

function rollbackSourceDigest(transaction) {
  const digest = transaction.observedSourceSnapshotSha256 ?? transaction.sourceSnapshotSha256;
  if (digest === null) fail("transaction has no rollback source identity");
  return digest;
}

async function validateSourceIdentity(filePath, transaction, ownership, expectedDigest = null) {
  if (ownership.sourceIdentity === null || transaction.sourceSnapshotSha256 === null) {
    fail("transaction has no source identity for rollback", filePath);
  }
  const digest = expectedDigest ?? transaction.sourceSnapshotSha256;
  await validateOwnedDirectory(
    filePath,
    ownership.sourceIdentity,
    digest,
    "transaction source/backup",
  );
}

async function captureOwnedDirectoryDigest(filePath, identity, label) {
  await validateOwnedDirectory(filePath, identity, null, label);
  return snapshotDigest(filePath);
}

async function markSourceConflict(target, transaction, actualDigest) {
  if (actualDigest === transaction.sourceSnapshotSha256) return transaction;
  if (transaction.observedSourceSnapshotSha256 !== null &&
      transaction.observedSourceSnapshotSha256 !== actualDigest) {
    fail("transaction rollback source changed more than once during recovery", target);
  }
  const updated = {
    ...transaction,
    observedSourceSnapshotSha256: actualDigest,
    phase: PHASE_ROLLBACK_REQUIRED,
  };
  await writeJournal(target, updated);
  return updated;
}

async function restoredSourceValidationError(filePath) {
  try {
    await validateMaybePromise(validateWorkspace(filePath));
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return error.message;
    throw error;
  }
}

async function validateCandidateIdentity(filePath, transaction, ownership) {
  const identity = ownership.promotedIdentity ?? ownership.stageIdentity;
  if (identity === null) fail("transaction has no persisted candidate filesystem identity", filePath);
  await validateOwnedDirectory(
    filePath,
    identity,
    transaction.candidateSnapshotSha256,
    "transaction candidate",
  );
  await validateMaybePromise(validateWorkspace(filePath));
  await requireCandidateSnapshot(
    filePath,
    transaction.candidateSnapshotSha256,
    transaction.mode,
    "published candidate no longer matches the journaled validated stage",
  );
}

async function rollbackInit(target, transaction, ownership) {
  const { stage } = await transactionPaths(target, transaction);
  if (transaction.phase !== PHASE_ROLLBACK_REQUIRED) {
    transaction = await advance(target, transaction, PHASE_ROLLBACK_REQUIRED);
  }
  let discardedDigest = transaction.candidateSnapshotSha256;
  if (await lexists(target)) {
    if (await lexists(stage)) fail("INIT rollback found both target and stage; refusing destructive cleanup", target);
    discardedDigest = await captureOwnedDirectoryDigest(
      target,
      ownership.promotedIdentity ?? ownership.stageIdentity,
      "transaction-owned INIT target",
    );
    await durableReplace(target, stage);
  }
  testOnlyCheckpoint("DURING_ROLLBACK");
  await assertOwnedJournal(target, transaction);
  await removeOwnedDirectory(
    target,
    transaction.transactionId,
    "stage",
    stage,
    ownership.stageIdentity,
    discardedDigest,
  );
  await removeJournal(target, transaction);
  await removeOwnership(target, ownership);
}

async function finishRestoredUpdate(
  target,
  transaction,
  stage,
  ownership,
  { sourceConflict, discardedStageDigest },
) {
  await validateSourceIdentity(target, transaction, ownership, rollbackSourceDigest(transaction));
  const validationError = await restoredSourceValidationError(target);
  await assertOwnedJournal(target, transaction);
  await removeOwnedDirectory(
    target,
    transaction.transactionId,
    "stage",
    stage,
    ownership.stageIdentity,
    discardedStageDigest,
  );
  await removeJournal(target, transaction);
  await removeOwnership(target, ownership);
  return { sourceConflict, restoredValidationError: validationError };
}

function raiseRollbackOutcome(target, outcome) {
  if (outcome.restoredValidationError !== null) {
    const prefix = outcome.sourceConflict ? SOURCE_CONFLICT_DIAGNOSTIC : "publication rollback completed";
    fail(`${prefix}; ${RESTORED_SOURCE_INVALID_DIAGNOSTIC}: ${outcome.restoredValidationError}`, target);
  }
  if (outcome.sourceConflict) fail(SOURCE_CONFLICT_DIAGNOSTIC, target);
}

async function rollbackUpdate(target, transaction, ownership) {
  const paths = await transactionPaths(target, transaction);
  const stage = paths.stage;
  const backup = paths.backup;
  if (backup === null) fail("mutable transaction is missing its backup path");
  let conflict = transaction.observedSourceSnapshotSha256 !== null;
  let discardedStageDigest = transaction.candidateSnapshotSha256;
  const backupExists = await lexists(backup);
  if (backupExists) {
    const backupIdentity = ownership.backupIdentity ?? ownership.sourceIdentity;
    const actualDigest = await captureOwnedDirectoryDigest(
      backup,
      backupIdentity,
      "transaction rollback backup",
    );
    if (actualDigest !== transaction.sourceSnapshotSha256) {
      transaction = await markSourceConflict(target, transaction, actualDigest);
      conflict = true;
    } else if (transaction.observedSourceSnapshotSha256 !== null &&
               actualDigest !== transaction.observedSourceSnapshotSha256) {
      fail("transaction rollback source no longer matches its journaled identity", backup);
    }
  } else if (transaction.phase === PHASE_PREPARED ||
             (transaction.phase === PHASE_ROLLBACK_REQUIRED && await lexists(stage))) {
    if (!(await lexists(target))) {
      fail("prepared transaction journal has no recoverable source/stage layout", materialParent(target));
    }
    const actualDigest = await captureOwnedDirectoryDigest(
      target,
      ownership.sourceIdentity,
      "prepared transaction source",
    );
    if (actualDigest !== transaction.sourceSnapshotSha256) {
      transaction = await markSourceConflict(target, transaction, actualDigest);
      conflict = true;
    } else if (transaction.phase !== PHASE_ROLLBACK_REQUIRED) {
      transaction = await advance(target, transaction, PHASE_ROLLBACK_REQUIRED);
    }
    return finishRestoredUpdate(target, transaction, stage, ownership, {
      sourceConflict: conflict,
      discardedStageDigest,
    });
  }
  if (transaction.phase !== PHASE_ROLLBACK_REQUIRED) {
    transaction = await advance(target, transaction, PHASE_ROLLBACK_REQUIRED);
  }
  if (await lexists(backup)) {
    await validateSourceIdentity(backup, transaction, ownership, rollbackSourceDigest(transaction));
    if (await lexists(target)) {
      if (await lexists(stage)) fail("rollback found target, backup, and stage simultaneously", materialParent(target));
      discardedStageDigest = await captureOwnedDirectoryDigest(
        target,
        ownership.promotedIdentity ?? ownership.stageIdentity,
        "transaction-owned promoted target",
      );
      await durableReplace(target, stage);
      await validateOwnedDirectory(
        stage,
        ownership.stageIdentity,
        discardedStageDigest,
        "rolled-back candidate stage",
      );
    }
    testOnlyCheckpoint("DURING_ROLLBACK");
    await durableReplace(backup, target);
    await validateSourceIdentity(target, transaction, ownership, rollbackSourceDigest(transaction));
    return finishRestoredUpdate(target, transaction, stage, ownership, {
      sourceConflict: conflict,
      discardedStageDigest,
    });
  }
  if (!(await lexists(target))) {
    fail("rollback cannot restore the source because both target and backup are absent", target);
  }
  await validateSourceIdentity(target, transaction, ownership, rollbackSourceDigest(transaction));
  testOnlyCheckpoint("DURING_ROLLBACK");
  return finishRestoredUpdate(target, transaction, stage, ownership, {
    sourceConflict: conflict,
    discardedStageDigest,
  });
}

async function rollbackTransaction(target, transaction, ownership) {
  if (transaction.mode === "INIT") {
    await rollbackInit(target, transaction, ownership);
    return { sourceConflict: false, restoredValidationError: null };
  }
  return rollbackUpdate(target, transaction, ownership);
}

async function finishInitRecovery(target, transaction, stage, ownership) {
  if (transaction.phase === PHASE_ROLLBACK_REQUIRED) {
    await rollbackInit(target, transaction, ownership);
    return;
  }
  if (new Set([PHASE_BACKUP_CREATED, PHASE_BACKUP_VERIFIED]).has(transaction.phase)) {
    fail("INIT transaction cannot enter a backup phase", journalPath(target));
  }
  if (transaction.phase === PHASE_PREPARED) {
    if (!(await lexists(target)) && await lexists(stage)) {
      await validateCandidateIdentity(stage, transaction, ownership);
      await durableReplace(stage, target);
      ownership = { ...ownership, promotedIdentity: ownership.stageIdentity };
      await writeOwnership(target, ownership);
    } else if (!((await lexists(target)) && !(await lexists(stage)))) {
      fail("prepared INIT journal has an inconsistent target/stage layout", materialParent(target));
    }
    transaction = await advance(target, transaction, PHASE_CANDIDATE_PROMOTED);
  }
  if (transaction.phase === PHASE_CANDIDATE_PROMOTED) {
    if (!(await lexists(target)) || await lexists(stage)) {
      fail("promoted INIT journal has an inconsistent target/stage layout", materialParent(target));
    }
    await validateCandidateIdentity(target, transaction, ownership);
    transaction = await advance(target, transaction, PHASE_CANDIDATE_VALIDATED);
  }
  if (transaction.phase === PHASE_CANDIDATE_VALIDATED) {
    if (!(await lexists(target)) || await lexists(stage)) {
      fail("validated INIT journal has an inconsistent target/stage layout", materialParent(target));
    }
    await validateCandidateIdentity(target, transaction, ownership);
    transaction = await advance(target, transaction, PHASE_COMMITTED);
  }
  if (transaction.phase === PHASE_COMMITTED) {
    if (!(await lexists(target))) fail("committed INIT journal has no live target", target);
    await validateCandidateIdentity(target, transaction, ownership);
    await assertOwnedJournal(target, transaction);
    await removeOwnedDirectory(
      target,
      transaction.transactionId,
      "stage",
      stage,
      ownership.stageIdentity,
      transaction.candidateSnapshotSha256,
    );
    await removeJournal(target, transaction);
    await removeOwnership(target, ownership);
  }
}

async function validateReadyPromotionAttestationIfRequired(target, source, candidate) {
  const sourceWorkspace = await validateMaybePromise(validateWorkspace(source));
  const candidateWorkspace = await validateMaybePromise(validateWorkspace(candidate));
  if (sourceWorkspace.status !== "draft" || candidateWorkspace.status !== "ready") {
    return false;
  }
  await validateMaybePromise(validateReadyPromotionTransition(source, candidate));
  await validateMaybePromise(
    validateReadinessAttestation(candidate, readinessAttestationPath(target)),
  );
  return true;
}

async function finishUpdateCommit(target, transaction, stage, backup, ownership) {
  if (!(await lexists(target))) fail("validated/committed transaction has no live target", target);
  await validateCandidateIdentity(target, transaction, ownership);
  if (await lexists(backup)) {
    await validateReadyPromotionAttestationIfRequired(target, backup, target);
  }
  if (transaction.phase !== PHASE_COMMITTED) {
    if (!(await lexists(backup))) fail("candidate was validated but its rollback backup is missing", backup);
    await validateCandidateIdentity(target, transaction, ownership);
    await validateSourceIdentity(backup, transaction, ownership);
    transaction = await advance(target, transaction, PHASE_COMMITTED);
  }
  if(transaction.mode==='CLOSE'){
    // Until terminal retirement has its own durable witness, this is the last
    // source tree. A confirmation cannot silently adopt a missing/replaced copy.
    if(!(await lexists(backup)))fail('CLOSE retained source backup is missing',backup);
    await validateSourceIdentity(backup,transaction,ownership);
    await validateCandidateIdentity(target,transaction,ownership);
    return closePublicationResult(target,transaction);
  }
  await validateCandidateIdentity(target, transaction, ownership);
  if (await lexists(backup)) await validateSourceIdentity(backup, transaction, ownership);
  await assertOwnedJournal(target, transaction);
  await removeOwnedDirectory(
    target,
    transaction.transactionId,
    "backup",
    backup,
    ownership.backupIdentity ?? ownership.sourceIdentity,
    transaction.sourceSnapshotSha256,
  );
  await assertOwnedJournal(target, transaction);
  await removeOwnedDirectory(
    target,
    transaction.transactionId,
    "stage",
    stage,
    ownership.stageIdentity,
    transaction.candidateSnapshotSha256,
  );
  await removeJournal(target, transaction);
  await removeOwnership(target, ownership);
}

async function recoverUpdate(target, transaction, stage, backup, ownership) {
  const targetExists = await lexists(target);
  const stageExists = await lexists(stage);
  const backupExists = await lexists(backup);
  if (!targetExists && backupExists) return rollbackUpdate(target, transaction, ownership);
  if (transaction.phase === PHASE_PREPARED) {
    if (targetExists && stageExists && !backupExists) {
      return rollbackUpdate(target, transaction, ownership);
    }
    if (targetExists && backupExists) return rollbackUpdate(target, transaction, ownership);
    fail("prepared transaction journal has no recoverable source/stage layout", materialParent(target));
  }
  if (new Set([
    PHASE_BACKUP_CREATED,
    PHASE_BACKUP_VERIFIED,
    PHASE_CANDIDATE_PROMOTED,
    PHASE_ROLLBACK_REQUIRED,
  ]).has(transaction.phase)) {
    if (backupExists) return rollbackUpdate(target, transaction, ownership);
    if (transaction.phase === PHASE_ROLLBACK_REQUIRED && targetExists) {
      return rollbackUpdate(target, transaction, ownership);
    }
    fail(`${transaction.phase} transaction is missing its rollback backup`, backup);
  }
  if (transaction.phase === PHASE_CANDIDATE_VALIDATED) {
    if (targetExists && backupExists) {
      try {
        await validateCandidateIdentity(target, transaction, ownership);
        await validateSourceIdentity(backup, transaction, ownership);
        await validateReadyPromotionAttestationIfRequired(target, backup, target);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return rollbackUpdate(target, transaction, ownership);
      }
      await finishUpdateCommit(target, transaction, stage, backup, ownership);
      return { sourceConflict: false, restoredValidationError: null };
    }
    fail("candidate_validated transaction has an inconsistent target/backup layout", materialParent(target));
  }
  if (transaction.phase === PHASE_COMMITTED) {
    if (targetExists) {
      await finishUpdateCommit(target, transaction, stage, backup, ownership);
      return { sourceConflict: false, restoredValidationError: null };
    }
    fail("committed transaction has no target or recoverable backup", materialParent(target));
  }
  fail(`unhandled transaction recovery phase ${JSON.stringify(transaction.phase)}`, journalPath(target));
}

async function recoverLocked(target, lease) {
  await assertPhysicalRoles();
  const transaction = await readJournal(target);
  await recoveryExecutionGuard(target, transaction);
  if (transaction !== null) await lease.setTransactionId(transaction.transactionId);
  let ownership = null;
  if (transaction !== null) {
    ownership = await readOwnership(target, transaction.transactionId);
    validateOwnershipAgainstTransaction(target, ownership, transaction);
    await cleanupOwnershipTemps(target, transaction.transactionId);
  }
  const journalTemps = await validateResidueSet(target, transaction);
  if (transaction === null) return null;
  const { stage, backup } = await transactionPaths(target, transaction);
  let outcome = { sourceConflict: false, restoredValidationError: null };
  if (transaction.mode === "INIT") {
    await finishInitRecovery(target, transaction, stage, ownership);
  } else {
    if (backup === null) fail("mutable transaction journal has no backup path");
    outcome = await recoverUpdate(target, transaction, stage, backup, ownership);
  }
  await cleanupJournalTemps(journalTemps, target, transaction);
  if (!(await lexists(journalPath(target)))) await lease.clearTransactionId();
  raiseRollbackOutcome(target, outcome);
  return transaction;
}

async function recoverIncompletePublicationLocked(target, commonLease,executionLease) {
  const targetPath = await normalizeTarget(target);
  validateTestOnlyHookConfiguration();
  return withWorkspaceLock(
    targetPath,
    async lease=>{const transaction=await recoverLocked(targetPath,lease);
      if(transaction?.mode==='CLOSE'&&await lexists(journalPath(targetPath))){const held=await readJournal(targetPath);if(held.phase===PHASE_COMMITTED){const ownership=await readOwnership(targetPath,held.transactionId);validateOwnershipAgainstTransaction(targetPath,ownership,held);await validateCandidateIdentity(targetPath,held,ownership);const witness=await prepareCloseTerminalRetirement(targetPath,held,ownership,executionLease);return cleanupTerminalRetirement(executionLease,witness);}}
      return transaction!==null;},
    commonLease,
  );
}

async function validateCandidate(
  mode,
  target,
  candidate,
  manifest,
  readinessAttestation,
  readinessIdentity = null,
  readyPromotion = false,
) {
  if (mode === "INIT") {
    return validateMaybePromise(validateInitTransition(target, candidate));
  } else if (mode === "RESUME") {
    if (readyPromotion) {
      return validateMaybePromise(validateReadyPromotionTransition(target, candidate));
    }
    return validateMaybePromise(validateResumeTransition(target, candidate, manifest));
  } else {
    await rejectCloseCandidateMetadata(candidate);
    await validateMaybePromise(validateCloseTransition(target, candidate));
    const expectedFeature = await validateMaybePromise(renderClosedFeature(target));
    const candidateFeature = await fs.readFile(path.join(candidate, "feature_spec.md"));
    if (!candidateFeature.equals(Buffer.from(expectedFeature))) {
      fail("CLOSE candidate is not the exact deterministic rendering of the active source", path.join(candidate, "feature_spec.md"));
    }
    return null;
  }
}

async function allocateTransactionPaths(target, mode, lease) {
  await assertPhysicalRoles();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const transactionId = randomIdentity();
    const stage = path.join(materialParent(target), `${stagePrefix(target)}${transactionId}`);
    const backup = mode === "INIT" ? null : path.join(materialParent(target), `${backupPrefix(target)}${transactionId}`);
    if (await lexists(stage) || (backup !== null && await lexists(backup)) ||
        await lexists(ownershipPath(target, transactionId))) continue;
    await lease.setTransactionId(transactionId);
    let ownership = {
      mode,
      targetName: path.basename(target),
      stageName: path.basename(stage),
      backupName: backup === null ? null : path.basename(backup),
      transactionId,
      stageIdentity: null,
      candidateSnapshotSha256: null,
      sourceIdentity: null,
      sourceSnapshotSha256: null,
      backupIdentity: null,
      promotedIdentity: null,
    };
    await writeOwnership(target, ownership);
    try {
      await fs.mkdir(stage, { mode: 0o700 });
    } catch (error) {
      await removeOwnership(target, ownership);
      if (error?.code === "EEXIST") {
        fail("transaction stage path appeared after exclusive allocation", stage);
      }
      throw error;
    }
    await fsyncDirectory(materialParent(target));
    const stageMetadata = await fs.lstat(stage, { bigint: true });
    if (stageMetadata.isSymbolicLink() || !stageMetadata.isDirectory()) {
      fail("allocated transaction stage is not a real directory", stage);
    }
    ownership = { ...ownership, stageIdentity: filesystemIdentity(stageMetadata) };
    await writeOwnership(target, ownership);
    testOnlyCheckpoint("STAGE_ALLOCATED");
    return { transactionId, stage, backup, ownership };
  }
  fail("could not allocate transaction-owned stage and backup paths", materialParent(target));
}

function validateMaybePromise(value) {
  return Promise.resolve(value);
}

async function preflightInputs(mode,targetPath,candidate,{manifestPath=null,readinessAttestation=null}={}) {
  if(mode==='CLOSE'&&candidate!=null)fail('CLOSE does not accept an external candidate; omit candidate');
  const candidatePath = mode==='CLOSE'?null:await preflightCandidatePath(candidate);
  const readyPromotion=mode==='RESUME'&&readinessAttestation!=null;
  const manifest = await preflightManifestPath(
    mode,
    manifestPath,
    targetPath,
    candidatePath,
    { readyPromotion },
  );
  const attestation = await preflightReadinessAttestationPath(
    mode,
    readinessAttestation,
    targetPath,
    candidatePath,
  );
  validateStaticInputRelationships(targetPath, candidatePath, manifest, attestation);
  return {candidatePath,manifest,attestation,readyPromotion};
}

async function publishCandidateLocked(mode, target, candidate, {
  manifestPath = null,
  readinessAttestation = null,
  beforePublish = null,
  afterJournalPrepared = null,
  afterBackupVerified = null,
  afterCandidateValidated = null,
  beforeCommittedCleanup = null,
  beforeAttestationCleanup = null,
} = {}, commonLease,executionLease) {
  if (!MUTABLE_MODES.has(mode)) {
    throw new ValidationError("publisher accepts only explicit INIT, RESUME, or CLOSE");
  }
  const targetPath = await normalizeTarget(target);
  const {candidatePath,manifest,attestation,readyPromotion}=await preflightInputs(mode,targetPath,candidate,{manifestPath,readinessAttestation});
  validateTestOnlyHookConfiguration();

  let preflightCloseAttestationIdentity = null;
  if (mode === "CLOSE" && attestation !== null && !(await lexists(journalPath(targetPath)))) {
    const workspace = await validateMaybePromise(validateWorkspace(targetPath));
    if (workspace.closed || workspace.status !== "ready") {
      fail("CLOSE requires an active ready workspace");
    }
    preflightCloseAttestationIdentity = await captureEphemeralAttestationIdentity(attestation);
    await validateMaybePromise(
      validateReadinessAttestation(targetPath, attestation, { candidate: candidatePath }),
    );
    await assertEphemeralAttestationIdentity(
      attestation,
      preflightCloseAttestationIdentity,
      "pre-lock validation",
    );
  }

  return withWorkspaceLock(targetPath, async (lease) => {
    await recoverLocked(targetPath, lease);
    if(mode!=='CLOSE')await validateCandidatePath(candidatePath);
    if(readinessAttestation==='auto')await validateReadyPromotionTransition(targetPath,candidatePath);
    await validateManifestPath(manifest);
    if (mode === "INIT") {
      if (await lexists(targetPath)) fail("INIT destination already exists", targetPath);
    } else {
      const metadata = await lstatOrNull(targetPath);
      if (metadata?.isSymbolicLink() || !metadata?.isDirectory()) {
        fail(`${mode} target must be an existing workspace directory`, targetPath);
      }
    }
    if (mode === "CLOSE") {
      const workspace = await validateMaybePromise(validateWorkspace(targetPath));
      if (workspace.closed || workspace.status !== "ready") {
        fail("CLOSE requires an active ready workspace");
      }
    }

    const closeDisposition=mode==='CLOSE'?await deriveCloseExecutionDisposition(targetPath):null;
    const manifestIdentity = manifest === null
      ? null
      : await captureEphemeralFileIdentity(manifest, "RESUME manifest");
    let manifestConsumed = false;
    const consumeManifest = async () => {
      if (manifestIdentity === null || manifestConsumed) return;
      await removeEphemeralManifest(manifest, manifestIdentity);
      manifestConsumed = true;
    };

    let allocated;
    try {
      allocated = await allocateTransactionPaths(targetPath, mode, lease);
    } catch (error) {
      await consumeManifest();
      throw error;
    }
    const { transactionId, stage, backup } = allocated;
    let ownership = allocated.ownership;
    let journalPersisted = false;
    let committed = false;
    let transaction = null;
    let closeAttestationIdentity = null;
    let readyPromotionAttestationIdentity = null;
    let readyPromotionAttestationRetained = false;
    let retainOperationForRecovery = false;
    const withRetainedReadyAttestation = (error) => {
      if (!readyPromotionAttestationRetained) return error;
      const retained = new ValidationError(
        `${error.message}; readiness attestation intentionally retained for retry: ${attestation}`,
      );
      retained.cause = error;
      if(error.retainExecutionLock)retained.retainExecutionLock=true;
      return retained;
    };
    try {
      if(mode==='CLOSE')populateOwnedClosedStage(targetPath,stage,ownership.stageIdentity);
      else await copyCandidateTree(candidatePath, stage,ownership.stageIdentity);
      testOnlyCheckpoint("CANDIDATE_STAGED");
      const candidateDigest = await snapshotDigest(stage);
      let sourceDigest = null;
      if (mode !== "INIT") {
        const sourceMetadata = await fs.lstat(targetPath, { bigint: true });
        ownership = { ...ownership, sourceIdentity: filesystemIdentity(sourceMetadata) };
        sourceDigest = await captureOwnedDirectoryDigest(
          targetPath,
          ownership.sourceIdentity,
          `${mode} source`,
        );
      }
      const closeBinding=mode==='CLOSE'?validateCloseBinding({format:'stnl-lifecycle-close-binding-v1',sourceIdentity:ownership.sourceIdentity,requirementsAuthority:await closeRequirementsAuthority(targetPath),sourceExecutionDisposition:closeDisposition,
        operationalInventory:await captureCloseOperationalInventory(targetPath,transactionId)},targetPath):null;
      if(closeBinding!==null){validateCloseBinding(closeBinding,targetPath);if(await closeRequirementsAuthority(stage)!==closeBinding.requirementsAuthority)fail('CLOSE rendered requirements authority differs');}
      ownership = {
        ...ownership,
        candidateSnapshotSha256: candidateDigest,
        sourceSnapshotSha256: sourceDigest,
        ...(mode==='CLOSE'?{closeBinding}:{}),
      };
      await writeOwnership(targetPath, ownership);
      if (mode === "CLOSE" && attestation !== null) {
        closeAttestationIdentity = preflightCloseAttestationIdentity ??
          await captureEphemeralAttestationIdentity(attestation);
        await assertEphemeralAttestationIdentity(
          attestation,
          closeAttestationIdentity,
          "locked validation",
        );
      }
      const transition = await validateCandidate(
        mode,
        targetPath,
        stage,
        manifest,
        attestation,
        closeAttestationIdentity,
        readyPromotion,
      );
      if (
        mode === "RESUME"
        && !readyPromotion
        && transition?.[0]?.status === "draft"
        && transition?.[1]?.status === "ready"
      ) {
        fail(
          "draft -> ready RESUME requires the deterministic --readiness-attestation promotion path and no manifest",
        );
      }
      if (readyPromotion) {
        if (await lexists(attestation)) {
          await validateMaybePromise(
            validateReadyPromotionAttestation(targetPath, stage, attestation),
          );
        } else {
          createReadyPromotionAttestation(targetPath, stage, attestation);
        }
        readyPromotionAttestationIdentity = await captureEphemeralAttestationIdentity(
          attestation,
        );
        await validateMaybePromise(
          validateReadyPromotionAttestation(targetPath, stage, attestation),
        );
        await assertEphemeralAttestationIdentity(
          attestation,
          readyPromotionAttestationIdentity,
          "ready promotion validation",
        );
        readyPromotionAttestationRetained = true;
      // The existing attestation writer already fsyncs its file. Persist its
      // directory entry too before a journal or official rename can rely on it.
      try{await fsyncDirectory(path.dirname(attestation));await assertPhysicalRoles();}
      catch(error){error.retainExecutionLock=true;throw error;}
      }
      await requireCandidateSnapshot(stage, candidateDigest, mode, `${mode} candidate changed during validation`);
      if (sourceDigest !== null) {
        try {
          await validateSourceIdentity(targetPath, {
            sourceSnapshotSha256: sourceDigest,
          }, ownership, sourceDigest);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          fail(`${mode} source changed during candidate validation`, targetPath);
        }
      }
      await fsyncTree(stage);
      await requireCandidateSnapshot(stage, candidateDigest, mode, `${mode} candidate changed while synchronizing`);
      if (sourceDigest !== null) {
        try {
          await validateSourceIdentity(targetPath, {
            sourceSnapshotSha256: sourceDigest,
          }, ownership, sourceDigest);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          fail(`${mode} source changed while synchronizing candidate`, targetPath);
        }
      }
      if (beforePublish !== null) await beforePublish({
        target: targetPath, stage, backup, transactionId, lock: lockPath(targetPath),
      });
      if(mode==='CLOSE'&&compactAsciiJson(await deriveCloseExecutionDisposition(targetPath))!==compactAsciiJson(closeDisposition))fail('CLOSE execution disposition changed before publication');
      await consumeManifest();
      await requireCandidateSnapshot(stage, candidateDigest, mode, `${mode} candidate changed after validation`);
      if (mode === "INIT") {
        if (await lexists(targetPath)) fail("INIT destination appeared before publication", targetPath);
      } else {
        try {
          await validateSourceIdentity(targetPath, {
            sourceSnapshotSha256: sourceDigest,
          }, ownership, sourceDigest);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          fail(`${mode} source changed after candidate validation`, targetPath);
        }
      }
      if (readyPromotion) {
        await assertEphemeralAttestationIdentity(
          attestation,
          readyPromotionAttestationIdentity,
          "pre-journal ready promotion",
        );
      }
      transaction = {
        mode,
        targetName: path.basename(targetPath),
        stageName: path.basename(stage),
        backupName: backup === null ? null : path.basename(backup),
        phase: PHASE_PREPARED,
        sourceSnapshotSha256: sourceDigest,
        candidateSnapshotSha256: candidateDigest,
        observedSourceSnapshotSha256: null,
        transactionId,
        ...(mode==='CLOSE'?{closeBinding:ownership.closeBinding}:{}),
      };
      await writeJournal(targetPath, transaction);
      journalPersisted = true;
      testOnlyCheckpoint("JOURNAL_PREPARED");
      if (afterJournalPrepared !== null) await afterJournalPrepared({
        target: targetPath, stage, backup, transactionId,
      });

      if (mode === "INIT") {
        if (await lexists(targetPath)) fail("INIT destination appeared before the publication rename", targetPath);
      } else {
        await validateSourceIdentity(targetPath, transaction, ownership);
        await testOnlyMutateSourceBeforeBackupRename(targetPath);
        if(mode==='CLOSE'){
          if(compactAsciiJson(await deriveCloseExecutionDisposition(targetPath))!==compactAsciiJson(closeDisposition))fail('CLOSE execution disposition changed at publication barrier');
          if(compactAsciiJson(await captureCloseOperationalInventory(targetPath,transactionId))!==compactAsciiJson(transaction.closeBinding.operationalInventory))fail('CLOSE operational inventory changed at publication barrier');
        }
        await durableReplace(targetPath, backup);
        await validateOwnedDirectory(
          backup,
          ownership.sourceIdentity,
          null,
          "transaction backup after source rename",
        );
        ownership = { ...ownership, backupIdentity: ownership.sourceIdentity };
        await writeOwnership(targetPath, ownership);
        testOnlyCheckpoint("TARGET_TO_BACKUP_RENAMED");
        transaction = await advance(targetPath, transaction, PHASE_BACKUP_CREATED);
        const backupDigest = await snapshotDigest(backup);
        if (backupDigest !== sourceDigest) {
          transaction = { ...transaction, observedSourceSnapshotSha256: backupDigest };
          transaction = await advance(targetPath, transaction, PHASE_ROLLBACK_REQUIRED);
          fail(SOURCE_CONFLICT_DIAGNOSTIC, backup);
        }
        await validateMaybePromise(validateWorkspace(backup));
        transaction = await advance(targetPath, transaction, PHASE_BACKUP_VERIFIED);
        if (afterBackupVerified !== null) await afterBackupVerified({
          target: targetPath, stage, backup, transactionId,
        });
        const verifiedBackupDigest = await captureOwnedDirectoryDigest(
          backup,
          ownership.backupIdentity,
          "verified transaction backup",
        );
        if (verifiedBackupDigest !== sourceDigest) {
          transaction = await markSourceConflict(targetPath, transaction, verifiedBackupDigest);
          fail(SOURCE_CONFLICT_DIAGNOSTIC, backup);
        }
      }

      await validateOwnedDirectory(
        stage,
        ownership.stageIdentity,
        candidateDigest,
        `${mode} staged candidate before promotion`,
      );
      await requireCandidateSnapshot(stage, candidateDigest, mode, `${mode} candidate changed before the publication rename`);
      await durableReplace(stage, targetPath);
      await validateOwnedDirectory(
        targetPath,
        ownership.stageIdentity,
        candidateDigest,
        `${mode} promoted candidate`,
      );
      ownership = { ...ownership, promotedIdentity: ownership.stageIdentity };
      await writeOwnership(targetPath, ownership);
      testOnlyCheckpoint("STAGE_TO_TARGET_RENAMED");
      transaction = await advance(targetPath, transaction, PHASE_CANDIDATE_PROMOTED);
      testOnlyCheckpoint("BEFORE_TARGET_VALIDATION");
      testOnlyForceRollback();
      await validateCandidateIdentity(targetPath, transaction, ownership);
      if (readyPromotion) {
        await assertEphemeralAttestationIdentity(
          attestation,
          readyPromotionAttestationIdentity,
          "promoted ready validation",
        );
        await validateMaybePromise(validateReadinessAttestation(targetPath, attestation));
      }
      if (backup !== null) {
        await validateReadyPromotionAttestationIfRequired(targetPath, backup, targetPath);
      }
      transaction = await advance(targetPath, transaction, PHASE_CANDIDATE_VALIDATED);
      testOnlyCheckpoint("AFTER_TARGET_VALIDATION");
      if (afterCandidateValidated !== null) await afterCandidateValidated({
        target: targetPath, stage, backup, transactionId,
      });
      await validateCandidateIdentity(targetPath, transaction, ownership);
      if (backup !== null) await validateSourceIdentity(backup, transaction, ownership);
      transaction = await advance(targetPath, transaction, PHASE_COMMITTED);
      committed = true;
      testOnlyCheckpoint("BEFORE_BACKUP_REMOVAL");
      if (beforeCommittedCleanup !== null) await beforeCommittedCleanup({
        target: targetPath, stage, backup, transactionId,
      });
      if(mode==='CLOSE'){
        if(attestation!==null){if(beforeAttestationCleanup!==null)await beforeAttestationCleanup({target:targetPath,stage,backup,attestation,transactionId});await removeEphemeralAttestation(attestation,closeAttestationIdentity);testOnlyCheckpoint('AFTER_ATTESTATION_REMOVAL');}
        const witness=await prepareCloseTerminalRetirement(targetPath,transaction,ownership,executionLease);
        return cleanupTerminalRetirement(executionLease,witness);
      }
      await assertOwnedJournal(targetPath, transaction);
      await validateCandidateIdentity(targetPath, transaction, ownership);
      if (backup !== null) {
        await validateSourceIdentity(backup, transaction, ownership);
        await removeOwnedDirectory(
          targetPath,
          transactionId,
          "backup",
          backup,
          ownership.backupIdentity,
          sourceDigest,
        );
      }
      await assertOwnedJournal(targetPath, transaction);
      await removeOwnedDirectory(
        targetPath,
        transactionId,
        "stage",
        stage,
        ownership.stageIdentity,
        candidateDigest,
      );
      if (mode === "CLOSE" && attestation !== null) {
        await assertOwnedJournal(targetPath, transaction);
        if (beforeAttestationCleanup !== null) await beforeAttestationCleanup({
          target: targetPath, stage, backup, attestation, transactionId,
        });
        await removeEphemeralAttestation(attestation, closeAttestationIdentity);
        testOnlyCheckpoint("AFTER_ATTESTATION_REMOVAL");
      }
      await removeJournal(targetPath, transaction);
      journalPersisted = false;
      await removeOwnership(targetPath, ownership);
      return targetPath;
    } catch (publicationError) {
      if(mode==='CLOSE'&&committed&&transaction!==null){retainOperationForRecovery=true;return closePublicationResult(targetPath,transaction,{diagnostics:[publicationError.message]});}
      retainOperationForRecovery=publicationError.retainExecutionLock===true;
      if (journalPersisted && !committed && transaction !== null && !retainOperationForRecovery) {
        let outcome;
        try {
          outcome = await rollbackTransaction(targetPath, transaction, ownership);
          journalPersisted = false;
        } catch (rollbackError) {
          const combined = new ValidationError(
            `publication failed and safe rollback is incomplete; journal retained for recovery: ${rollbackError.message}`,
          );
          combined.cause = new AggregateError(
            [publicationError, rollbackError],
            "publication and rollback both failed",
          );
          if(publicationError.retainExecutionLock||rollbackError.retainExecutionLock)combined.retainExecutionLock=true;
          throw withRetainedReadyAttestation(combined);
        }
        if (outcome.restoredValidationError !== null || outcome.sourceConflict) {
          try {
            raiseRollbackOutcome(targetPath, outcome);
          } catch (restoredError) {
            restoredError.cause = publicationError;
            throw withRetainedReadyAttestation(restoredError);
          }
        }
      }
      throw withRetainedReadyAttestation(publicationError);
    } finally {
      let terminalCleanupError = null;
      try {
        await consumeManifest();
      } catch (error) {
        terminalCleanupError = error;
      }
      if (!journalPersisted && !retainOperationForRecovery) {
        try {
          const persisted = await readOwnership(targetPath, transactionId);
          if (persisted !== null) {
            await removeOwnedDirectory(
              targetPath,
              transactionId,
              "stage",
              stage,
              persisted.stageIdentity,
              persisted.candidateSnapshotSha256,
            );
            await removeOwnership(targetPath, persisted);
          }
        } catch (error) {
          if (terminalCleanupError === null) {
            terminalCleanupError = error;
          } else {
            const combined = new ValidationError(
              `terminal cleanup preserved unowned input and transaction recovery evidence: ${terminalCleanupError.message}; ${error.message}`,
            );
            combined.cause = new AggregateError(
              [terminalCleanupError, error],
              "manifest and transaction cleanup both failed",
            );
            terminalCleanupError = combined;
          }
        }
      }
      if (terminalCleanupError !== null) throw terminalCleanupError;
    }
  }, commonLease);
}

function isFilesystemError(error) {
  return error !== null && typeof error === "object" && typeof error.code === "string";
}

async function recoveryExecutionGuard(target, transaction = null) {
  const roots = [target];
  if (transaction !== null) {
    const { stage, backup } = await transactionPaths(target, transaction);
    roots.push(stage, backup);
  }
  for (const root of roots.filter(Boolean)) await assertLifecycleExecutionUnowned(path.join(root, 'execution'));
}

async function lifecycleCommonRecoveryProof(target) {
  // Validate the existing atomic roles without settling any lifecycle control
  // before acquiring common ownership. The same validators own settlement later.
  const names = (await fs.readdir(materialParent(target))).sort(compareCodePoints);
  const recoveryPaths = currentNames => [...new Set([lockPath(target), journalPath(target),
    ...currentNames.filter(name => name.startsWith(lockTempPrefix(target)) || name.startsWith(journalTempPrefix(target))
      || name.startsWith(ownershipPrefix(target)) || name.startsWith(ownershipTempPrefix(target)))
      .map(name => path.join(materialParent(target), name))])];
  const paths = recoveryPaths(names);
  if (paths.length > 128) fail('lifecycle recovery controls exceed the bounded limit', target);
  const controls = [], absent = [];
  for (const file of paths) {
    if (await lexists(file)) controls.push(await captureLifecycleRecoveryControl(file));
    else absent.push(file);
  }
  let record = await settleLinkedLockClaim(target, { validateOnly: true });
  if (record === undefined && !(await lexists(lockPath(target)))) {
    const claims = names.filter(name => name.startsWith(lockTempPrefix(target)));
    if (claims.length !== 1) fail('common lease recovery has no unambiguous durable lifecycle claim; execution publication: lock already exists', lockPath(target));
    const parsed = parseLockTempName(target, claims[0]);
    const claimPath = path.join(materialParent(target), claims[0]);
    let observed;
    try { observed = await readLockRecord(claimPath); }
    catch { await cleanupMalformedLockTemp(target, claimPath, parsed); }
    if (parsed?.role !== 'create' || observed === null || parsed.ownerId !== observed.record.ownerId
      || parsed.operationId !== observed.record.operationId || parsed.pid !== observed.record.pid
      || parsed.hostDigest !== lockHostDigest(observed.record.hostname)) fail('publisher lock temp residue payload does not match its claim identity', lockPath(target));
    record = observed.record;
  }
  if (record.state !== 'active' || record.commonLease === undefined || !ownerIsProvablyDead(record)) {
    fail('common lease recovery requires an intact lifecycle binding and a proven-dead local owner; execution publication: lock already exists', lockPath(target));
  }
  const transaction = await settleJournalState(target, { validateOnly: true });
  if (transaction !== null && record.transactionId !== transaction.transactionId) {
    fail('workspace publication lock transaction identity does not match the recovery journal', lockPath(target));
  }
  if (record.transactionId !== null) {
    const ownership = await settleOwnershipClaim(target, record.transactionId, { validateOnly: true });
    if (transaction !== null) validateOwnershipAgainstTransaction(target, ownership, transaction);
    if(transaction?.mode==='CLOSE'&&transaction.phase===PHASE_COMMITTED){
      const {backup}=await transactionPaths(target,transaction);
      if(!(await lexists(backup)))fail('CLOSE retained source backup is missing',backup);
      await validateSourceIdentity(backup,transaction,ownership);
    }
  }
  await recoveryExecutionGuard(target, transaction ?? (record.transactionId === null ? null : {
    stageName: `${stagePrefix(target)}${record.transactionId}`, backupName: `${backupPrefix(target)}${record.transactionId}`,
  }));
  if (compactAsciiJson(paths) !== compactAsciiJson(recoveryPaths((await fs.readdir(materialParent(target))).sort(compareCodePoints)))) {
    fail('lifecycle recovery control paths changed during validation', target);
  }
  if (record.transactionId !== null && !paths.includes(ownershipPath(target, record.transactionId))) {
    absent.push(ownershipPath(target, record.transactionId));
  }
  for (const expected of controls) {
    if (compactAsciiJson(await captureLifecycleRecoveryControl(expected.file)) !== compactAsciiJson(expected)) fail('lifecycle recovery control changed during validation', expected.file);
  }
  for (const file of absent) if (await lexists(file)) fail('absent lifecycle recovery control appeared during validation', file);
  return { format: 'stnl-lifecycle-common-recovery-v2',filesystemContext:filesystemProof,binding: record.commonLease,
    controls, absent };
}

// The producer alone owns this fixed read-only capability. No caller supplies
// executable, argv, options or callback. Kernels and readers remain command-free.

async function proveLifecycleTemporaryExclusion(workspace, filesystemContext) {
  const roots = await resolveExecutionFilesystemRoots(workspace, filesystemContext);
  if (roots.exclusion.kind === 'git-ignore-unverified') {
    // -C cannot neutralize inherited repository/index or runtime-config selectors.
    // Refuse them without inspecting/logging values or changing the environment.
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'].some(name => Object.hasOwn(process.env, name)))
      fail('TEMP_ROOT_UNPROVEN: Git repository/index/configuration overrides are not accepted');
    try {
      // A directory query also proves a not-yet-created ignored namespace.
      await queryLifecycleGitIgnore(roots.productRoot, roots.temporaryRoot + path.sep);
    } catch {
      fail('TEMP_ROOT_UNPROVEN: Git exclusion query failed; publication blocked before writing');
    }
  }
  return roots;
}

async function withCommonExecutionLock(target, action, { recovery = false, filesystemContext = null,mode=null } = {}) {
  const intended = expandUser(target);
  const parent = await fs.realpath(path.dirname(intended));
  const specRoot = path.join(parent, path.basename(intended));
  const executionRoot = path.join(specRoot, 'execution');
  if(specRoot!==roots.specRoot)fail('common writer target differs from sealed context');
  const workspace = { specRoot, executionRoot,filesystemContext:policy };
  await proveLifecycleTemporaryExclusion(workspace, policy);
  await assertPhysicalRoles();
  const run = async lease => {
    await assertNoLegacyExecutionControls(workspace);
    if(!recovery)await assertNoPendingExecutionPublication(workspace);
    if(!recovery&&!await hasPendingPublication())
      await lifecyclePublisher(roots,{legacyInspection:true}).inspectLifecycleLocatorTransition(specRoot);
    await assertLifecycleExecutionUnowned(executionRoot);
    if (recovery) {
      const transaction = await settleJournalState(specRoot, { validateOnly: true });
      await recoveryExecutionGuard(specRoot, transaction);
    }
    const commonLease = await lifecycleCommonLeaseBinding(lease);
    const result=await action({specRoot,executionRoot,commonLease,executionLease:lease});
    if(result?.publication==='confirmed'&&result.cleanup==='pending')lease.retainExecutionLock=true;
    return result;
  };
  try { return await withExecutionPublicationLock(workspace, run); }
  catch (error) {
    if (!error.existingExecutionLock) throw error;
    if (recovery) {
      const proof = await lifecycleCommonRecoveryProof(specRoot);
      return withLifecycleRecoveryPublicationLock(workspace, proof, run);
    }
    // Only the lifecycle recovery entry can transfer the stale common lease.
    // Complete the existing transaction before considering this new candidate.
    const recovered=await recoverIncompletePublication(specRoot,{filesystemContext});
    if(recovered?.publication==='confirmed'){
      if(mode==='CLOSE')return recovered;
      fail(`prior CLOSE publication is confirmed; cleanup is ${recovered.cleanup}; re-evaluate the new lifecycle intent against the closed document`,specRoot);
    }
    await proveLifecycleTemporaryExclusion(workspace, filesystemContext);
    return withExecutionPublicationLock(workspace, run);
  }
}
async function recoverIncompletePublication(target, { filesystemContext = null } = {}) {
  return withCommonExecutionLock(target, ({ commonLease,executionLease }) => recoverIncompletePublicationLocked(target, commonLease,executionLease), { recovery: true, filesystemContext });
}
async function lifecycleExecutionSnapshot(specRoot) {
  const root = path.join(specRoot, 'execution');
  const meta = await fs.lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (meta === null) return null;
  // Lifecycle preserves opaque legacy entries with its existing topology-aware snapshot.
  // Executable preparation retains the stricter consumer grammar and single-link guards.
  return workspaceSnapshot(specRoot).filter(record => record[1] === 'execution' || record[1].startsWith('execution/'));
}
async function publishCandidate(mode, target, candidate, options = {}) {
  return withCommonExecutionLock(target, async ({ specRoot, commonLease,executionLease }) => {
    if(mode!=='CLOSE') {
      const source=await lifecycleExecutionSnapshot(specRoot),proposed=await lifecycleExecutionSnapshot(candidate);
      if(JSON.stringify(source)!==JSON.stringify(proposed))fail('lifecycle candidate does not preserve execution captured under common lock; refresh stale candidate',candidate);
    }
    return publishCandidateLocked(mode, target, candidate, options, commonLease,executionLease);
  }, { filesystemContext: options.filesystemContext ?? null,mode });
}

  async function hasPendingPublication() {
    await assertPhysicalRoles();
    if(roots.materialRootIdentity===null)return false;
    if(await settleJournalState(roots.specRoot,{validateOnly:true})!=null)return true;
    const record=await settleLinkedLockClaim(roots.specRoot,{validateOnly:true});
    return record!=null&&(record.transactionId!==null||record.state==='active');
  }
  if(legacyInspection)return {inspectLifecycleLocatorTransition};
  return {journalPath,lockPath,readinessAttestationPath,publishCandidate,recoverIncompletePublication,recoverTerminalRetirement,hasPendingPublication,preflightInputs};
}

async function lifecycleRoots(target,filesystemContext,{allocate=false}={}) {
  const requested=path.resolve(expandUser(target));
  const canonical=await canonicalPathWithoutSymlinks(requested,'target');
  const workspace={specRoot:canonical,executionRoot:path.join(canonical,'execution'),
    ...(filesystemContext===null?{}:{filesystemContext})};
  const roots=await resolveExecutionFilesystemRoots(workspace);
  if(!allocate)return roots;
  await assertNoLegacyExecutionControls(workspace);
  // Pending typed controls own their recovery. External inputs cannot prevent
  // restoration of that operation while the official target is temporarily absent.
  if(!await lifecyclePublisher(roots).hasPendingPublication())
    await lifecyclePublisher(roots,{legacyInspection:true}).inspectLifecycleLocatorTransition(roots.specRoot);
  // Use the same existing named producer capability before even mkdir.
  // The method is read-only until the primitive allocates its proved roles.
  if(roots.exclusion.kind==='git-ignore-unverified') {
    if(['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS'].some(name=>Object.hasOwn(process.env,name)))
      fail('TEMP_ROOT_UNPROVEN: Git repository/index/configuration overrides are not accepted');
    try{await queryLifecycleGitIgnore(roots.productRoot,roots.temporaryRoot+path.sep);}
    catch{fail('TEMP_ROOT_UNPROVEN: Git exclusion query failed; publication blocked before writing');}
  }
  return ensureExecutionMaterialRoot(workspace,roots);
}
export async function journalPath(target,{filesystemContext=null}={}) {return (await lifecycleRoots(target,filesystemContext)).lifecycleJournal;}
export async function lockPath(target,{filesystemContext=null}={}) {return (await lifecycleRoots(target,filesystemContext)).lifecycleLock;}
export async function readinessAttestationPath(target,{filesystemContext=null}={}) {return (await lifecycleRoots(target,filesystemContext)).readinessAttestation;}
export async function inspectLifecycleLocatorTransition(target,{filesystemContext=null}={}) {
  const roots=await lifecycleRoots(target,filesystemContext);
  return lifecyclePublisher(roots,{legacyInspection:true}).inspectLifecycleLocatorTransition(roots.specRoot);
}
export async function publishCandidate(mode,target,candidate,options={}) {
  if(!MUTABLE_MODES.has(mode))fail('publisher accepts only explicit INIT, RESUME, or CLOSE');
  const observedRoots=await lifecycleRoots(target,options.filesystemContext??null);
  await lifecyclePublisher(observedRoots).preflightInputs(mode,observedRoots.specRoot,candidate,options);
  const terminal=await inspectLifecycleTerminalRetirement({specRoot:observedRoots.specRoot,executionRoot:observedRoots.executionRoot,
    filesystemContext:{productRoot:observedRoots.productRoot,temporaryRoot:observedRoots.temporaryRoot,excludedRoots:observedRoots.excludedRoots}});
  if(terminal!==null){if(mode!=='CLOSE')fail('prior CLOSE terminal cleanup is pending; use its recovery before new lifecycle work');return lifecyclePublisher(observedRoots).recoverTerminalRetirement(terminal);}
  if(options.readinessAttestation==='auto') {
    if(mode!=='RESUME')fail('readiness attestation auto is only valid for RESUME draft to ready promotion');
    if(options.manifestPath!==undefined&&options.manifestPath!==null)fail('ready promotion RESUME uses no external manifest; omit --manifest');
    const observed=await lifecycleRoots(target,options.filesystemContext??null);
    if(!await lifecyclePublisher(observed).hasPendingPublication())
      await validateReadyPromotionTransition(observed.specRoot,candidate);
  }
  if(mode==='CLOSE'&&!await lifecyclePublisher(observedRoots).hasPendingPublication())await deriveCloseExecutionDisposition(observedRoots.specRoot);
  const roots=await lifecycleRoots(target,options.filesystemContext??null,{allocate:true});
  return lifecyclePublisher(roots).publishCandidate(mode,roots.specRoot,candidate,options);
}
export async function recoverIncompletePublication(target,{filesystemContext=null}={}) {
  const observed=await lifecycleRoots(target,filesystemContext);
  const workspace={specRoot:observed.specRoot,executionRoot:observed.executionRoot,filesystemContext:{productRoot:observed.productRoot,temporaryRoot:observed.temporaryRoot,excludedRoots:observed.excludedRoots}};
  const terminal=await inspectLifecycleTerminalRetirement(workspace);
  if(terminal!==null)return lifecyclePublisher(observed).recoverTerminalRetirement(terminal);
  if(await lifecyclePublisher(observed).hasPendingPublication())return lifecyclePublisher(observed).recoverIncompletePublication(observed.specRoot,{filesystemContext});
  if(await lexists(observed.specRoot)&&validateWorkspace(observed.specRoot).closed){
    await assertNoLegacyExecutionControls(workspace);
    if(await lexists(observed.lockPath)||observed.materialRootIdentity!==null)fail('closed document has unbound operational controls; preserve and inspect before recovery');
    return false; // Documentary state only. No transaction or PASS is reconstructed.
  }
  const roots=await lifecycleRoots(target,filesystemContext,{allocate:true});
  return lifecyclePublisher(roots).recoverIncompletePublication(roots.specRoot,{filesystemContext});
}
export function isFilesystemError(error) {return error!==null&&typeof error==='object'&&typeof error.code==='string';}
