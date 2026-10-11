// Neutral, distributable publication boundary. No execution-state or lifecycle journal imports.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = message => { throw Object.assign(new Error(`execution publication: ${message}`), { code: 'EXECUTION_PUBLICATION_BLOCKED' }); };
const inside = (child, parent) => { const relative = path.relative(parent, child); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
async function stat(file) { return fs.lstat(file).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }); }
const identity = metadata => ({ dev: String(metadata.dev), ino: String(metadata.ino) });

async function ancestry(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const segment of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); const metadata = await stat(current);
    if (!metadata) break;
    if (metadata.isSymbolicLink() && !(process.platform === 'darwin' && ['/var', '/tmp', '/etc'].includes(current))) fail(`symlink ancestry: ${current}`);
  }
}

export async function readOwnedFile(file) {
  await ancestry(file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) fail(`file must be regular and single-link: ${file}`);
    const bytes = await handle.readFile(); const after = await handle.stat(); const pathname = await fs.lstat(file);
    if (!equal(identity(before), identity(after)) || !equal(identity(after), identity(pathname))
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`file changed during read: ${file}`);
    return { file, bytes, identity: identity(after), mode: after.mode & 0o777 };
  } finally { await handle.close(); }
}

async function writeNew(file, bytes, mode = 0o600) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return readOwnedFile(file);
}

export async function executionLockIdentity({ executionRoot, specRoot = null }) {
  if (!path.isAbsolute(executionRoot) || (specRoot !== null && !path.isAbsolute(specRoot))) fail('official roots must be absolute');
  const parentPath = path.dirname(specRoot ?? executionRoot);
  await ancestry(parentPath);
  const parent = await fs.realpath(parentPath); const parentMetadata = await fs.lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) fail('stable lock ancestor is not a real directory');
  const canonicalSpec = specRoot === null ? null : path.join(parent, path.basename(specRoot));
  const canonicalRoot = specRoot === null ? path.join(parent, path.basename(executionRoot)) : path.join(canonicalSpec, 'execution');
  if (path.resolve(executionRoot) !== canonicalRoot) fail('execution root is not the canonical official root');
  await ancestry(canonicalRoot);
  const key = createHash('sha256').update(canonicalRoot, 'utf8').digest('hex');
  return { executionRoot: canonicalRoot, specRoot: canonicalSpec, parent, parentIdentity: identity(parentMetadata), lockPath: path.join(parent, `.stnl-execution-${key}.lock`) };
}

export async function acquireExecutionPublicationLock(workspace) {
  const location = await executionLockIdentity(workspace);
  const token = randomUUID();
  const bytes = Buffer.from(JSON.stringify({ format: 'stnl-execution-lock-v1', token, executionRoot: location.executionRoot, pid: process.pid }) + '\n');
  let owned;
  try { owned = await writeNew(location.lockPath, bytes); }
  catch (error) { if (error.code === 'EEXIST') fail(`lock already exists; preserve and diagnose owner: ${location.lockPath}`); throw error; }
  const lease = { ...location, token, owned };
  await assertExecutionPublicationLock(lease);
  return lease;
}

export async function assertExecutionPublicationLock(lease) {
  const current = await readOwnedFile(lease.lockPath);
  const parent = await fs.lstat(lease.parent);
  if (!equal(identity(parent), lease.parentIdentity) || await fs.realpath(lease.parent) !== lease.parent
    || !equal(current.identity, lease.owned.identity) || !current.bytes.equals(lease.owned.bytes)) fail('lock ownership or stable ancestor changed');
}

export async function releaseExecutionPublicationLock(lease) {
  await assertExecutionPublicationLock(lease);
  const retired = `${lease.lockPath}.retired-${lease.token}`;
  await fs.rename(lease.lockPath, retired);
  const captured = await readOwnedFile(retired);
  if (!equal(captured.identity, lease.owned.identity) || !captured.bytes.equals(lease.owned.bytes)) {
    if (!await stat(lease.lockPath)) await fs.link(retired, lease.lockPath);
    fail(`lock changed at release; foreign lease preserved at ${retired}`);
  }
  await fs.unlink(retired);
}

export async function withExecutionPublicationLock(workspace, action) {
  const lease = await acquireExecutionPublicationLock(workspace);
  let result; let failure;
  try { result = await action(lease); } catch (error) { failure = error; }
  if (failure?.retainExecutionLock) { failure.message += `; common lock retained for uncertain ownership: ${lease.lockPath}`; throw failure; }
  try { await releaseExecutionPublicationLock(lease); }
  catch (error) {
    if (result?.publication === 'confirmed') return { ...result, cleanup: 'pending', cleanupDiagnostics: [...(result.cleanupDiagnostics ?? []), error.message], retainedLock: lease.lockPath };
    if (failure) failure.message += `; lock release failed: ${error.message}`;
    else failure = error;
  }
  if (failure) throw failure;
  return result;
}

export async function captureExecutionTree(root) {
  await ancestry(root);
  const metadata = await stat(root);
  if (!metadata) return null;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('execution tree is not a real directory');
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name); const item = await fs.lstat(target);
      if (item.isSymbolicLink()) fail(`symlink in execution tree: ${relative}`);
      if (item.isDirectory()) { files.push({ path: relative, type: 'directory' }); await walk(target, relative); }
      else { const captured = await readOwnedFile(target); files.push({ path: relative, type: 'file', sha256: digest(captured.bytes), mode: captured.mode }); }
    }
  }
  await walk(root);
  const after = await fs.lstat(root);
  if (!equal(identity(metadata), identity(after)) || after.isSymbolicLink() || !after.isDirectory()) fail('execution tree root changed during capture');
  return { identity: identity(metadata), files };
}

async function officialManifest(root) {
  const tree = await captureExecutionTree(root);
  if (!tree) fail('official execution tree is absent');
  if (tree.files.some(entry => entry.type === 'directory' && !['plans', 'tasks'].includes(entry.path))) fail('unknown official directory');
  return tree.files.filter(entry => entry.type === 'file' && entry.path !== 'activation.json').map(({ path: relative, sha256 }) => {
    if (!/^(?:plan|tasks)\.md$|^approved-preparation\.json$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(relative)) fail(`unknown official artifact: ${relative}`);
    return { path: relative, sha256 };
  });
}

function validateActivation(activation) {
  const expected = ['format', 'activationId', 'sequence', 'previousActivationId', 'preparationRevision', 'requirementsAuthority', 'normativeSha256', 'approvedSnapshotSha256', 'artifacts', 'activeAttempt', 'lastAttempt'];
  if (!activation || Object.keys(activation).sort().join('\0') !== expected.sort().join('\0')
    || activation.format !== 'stnl-execution-activation-v1' || !/^[a-f0-9-]{36}$/u.test(activation.activationId)
    || !Number.isSafeInteger(activation.sequence) || activation.sequence < 1 || !Array.isArray(activation.artifacts)) fail('malformed activation');
  const uuid = value => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
  if (!uuid(activation.activationId) || !Number.isSafeInteger(activation.preparationRevision) || activation.preparationRevision < 1
    || (activation.sequence === 1 ? activation.previousActivationId !== null : !uuid(activation.previousActivationId))) fail('invalid activation identity/revision');
  const fields = ['operationAttemptId', 'ownershipToken', 'deliveryId', 'slice', 'operation', 'preparationRevision', 'normativeSha256', 'originActivationId', 'runner'];
  for (const [name, attempt] of [['activeAttempt', activation.activeAttempt], ['lastAttempt', activation.lastAttempt]]) {
    if (attempt === null) continue;
    const expected = name === 'lastAttempt' ? [...fields, 'terminalActivationId'] : fields;
    if (!attempt || Object.keys(attempt).sort().join('\0') !== expected.sort().join('\0')
      || ['operationAttemptId', 'ownershipToken', 'deliveryId', 'originActivationId'].some(key => !uuid(attempt[key]))
      || !/^slice-[0-9]{2,}$/u.test(attempt.slice) || !['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE'].includes(attempt.operation)
      || !Number.isSafeInteger(attempt.preparationRevision) || !/^sha256:[a-f0-9]{64}$/u.test(attempt.normativeSha256)
      || (name === 'lastAttempt' && !uuid(attempt.terminalActivationId))) fail('malformed attempt ownership');
    if (attempt.runner !== null) {
      if (!attempt.runner || Object.keys(attempt.runner).sort().join('\0') !== ['dispatchId', 'receiptFile', 'threadId', 'status'].sort().join('\0')
        || !['pending', 'uncertain', 'captured'].includes(attempt.runner.status)) fail('malformed runner binding');
    }
  }
  for (const value of [activation.requirementsAuthority, activation.normativeSha256, activation.approvedSnapshotSha256]) if (!/^sha256:[a-f0-9]{64}$/u.test(value)) fail('invalid activation digest');
}

// Resolver A -> all artifacts -> B. A changed marker never admits a mixed image.
export async function readActivatedExecution({ executionRoot, requirementsAuthority, projectAuthority, validateSnapshot, parseJson, readCheckpoint = null }) {
  if (typeof projectAuthority !== 'function' || typeof validateSnapshot !== 'function' || typeof parseJson !== 'function') fail('trusted preparation validators required');
  const marker = path.join(executionRoot, 'activation.json');
  let a;
  try { a = await readOwnedFile(marker); } catch (error) { fail(`draft, incomplete or incompatible legacy execution; activation unavailable: ${error.message}`); }
  const activation = parseJson(a.bytes.toString('utf8')); validateActivation(activation);
  if (readCheckpoint) await readCheckpoint('A');
  const snapshotFile = await readOwnedFile(path.join(executionRoot, 'approved-preparation.json'));
  if (digest(snapshotFile.bytes) !== activation.approvedSnapshotSha256) fail('approved snapshot digest differs');
  const snapshot = parseJson(snapshotFile.bytes.toString('utf8')); const approved = validateSnapshot(snapshot);
  const authority = await projectAuthority(executionRoot);
  for (const name of ['preparationRevision', 'requirementsAuthority', 'normativeSha256']) {
    if (activation[name] !== approved[name] || activation[name] !== authority[name]) fail(`current ${name} differs from approved preparation`);
  }
  if (activation.requirementsAuthority !== requirementsAuthority) fail('requirements authority is stale');
  if (activation.activeAttempt !== null) {
    const active = activation.activeAttempt;
    if (active.preparationRevision !== authority.preparationRevision || active.normativeSha256 !== authority.normativeSha256
      || !authority.deliveries.some(entry => entry.slice === active.slice && entry.deliveryId === active.deliveryId)) fail('active attempt no longer belongs to preparation');
  }
  const manifest = await officialManifest(executionRoot);
  if (!equal(manifest, activation.artifacts)) fail('activation manifest does not cover current artifacts');
  if (readCheckpoint) await readCheckpoint('artifacts');
  const tree = await captureExecutionTree(executionRoot);
  const treeManifest = tree.files.filter(entry => entry.type === 'file' && entry.path !== 'activation.json').map(({path, sha256}) => ({path, sha256}));
  if (!equal(treeManifest, activation.artifacts)) fail('artifacts changed during resolution');
  const b = await readOwnedFile(marker);
  if (!a.bytes.equals(b.bytes) || !equal(a.identity, b.identity)) fail('activation changed during resolution; retryable mixed read blocked');
  return { activation, snapshot, authority, tree };
}

export function assertExecutionAttempt(activation, owner) {
  const attempt = activation.activeAttempt;
  if (!owner || !attempt || ['operationAttemptId', 'ownershipToken', 'deliveryId', 'slice', 'operation', 'originActivationId', 'preparationRevision', 'normativeSha256'].some(key => attempt[key] !== owner[key])) fail('active attempt/owner/preparation differs');
  return attempt;
}

export async function assertOwnedPreparationCandidate({ candidateExecutionRoot, specPath = null, resolveWorkspace }) {
  await ancestry(candidateExecutionRoot);
  const root = await fs.realpath(candidateExecutionRoot);
  const marker = parseStrictJson((await readOwnedFile(`${root}.owner.json`)).bytes.toString('utf8'));
  if (!['PLAN', 'REPLAN', 'REVIEW_PLAN'].includes(marker.operation)
    || (specPath && marker.specPath !== await fs.realpath(specPath))) fail('candidate preparation identity differs');
  const workspace = await resolveWorkspace(marker.specPath);
  if (marker.executionRoot !== workspace.executionRoot || inside(root, workspace.executionRoot)
    || inside(workspace.executionRoot, root) || (workspace.specRoot && inside(root, workspace.specRoot))) fail('preparation requires an isolated owned candidate');
  await captureExecutionTree(root);
  return { root, marker, workspace };
}

// Both checklist and evidence writers use the same isolated-candidate/owner boundary.
export async function assertOwnedOperationalCandidate({ candidateExecutionRoot, slice, resolveWorkspace, readActivated }) {
  await ancestry(candidateExecutionRoot);
  const root = await fs.realpath(candidateExecutionRoot);
  const candidates = [`${root}.copy.json`, `${path.dirname(root)}.copy.json`, `${root}.publication.json`];
  for (const file of candidates) {
    if (!await stat(file)) continue;
    const marker = parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
    const official = await resolveWorkspace(marker.specPath);
    if (marker.executionRoot !== official.executionRoot || inside(root, official.executionRoot)
      || inside(official.executionRoot, root) || (official.specRoot && inside(root, official.specRoot))) fail('writer requires isolated candidate; live/overlapping execution is forbidden');
    if (!marker.owner || marker.slice !== slice) fail('candidate slice/owner differs');
    assertExecutionAttempt((await readActivated(marker.specPath)).activation, marker.owner);
    await captureExecutionTree(root);
    return { root, marker, workspace: official };
  }
  fail('writer requires an owned isolated candidate; live mutation is forbidden');
}

async function replaceActivation(root, activation) {
  const file = path.join(root, 'activation.json'); const temporary = `${file}.${randomUUID()}.tmp`;
  await writeNew(temporary, Buffer.from(JSON.stringify(activation, null, 2) + '\n'));
  await fs.rename(temporary, file);
}

export async function beginExecutionOperation({ workspace, expectedActivationId, operation, slice, readActivated, preflight }) {
  return withExecutionPublicationLock(workspace, async lease => {
    const current = await readActivated();
    if (current.activation.activationId !== expectedActivationId) fail('begin activation CAS conflict');
    if (current.activation.activeAttempt) fail('an active or uncertain operation already owns execution');
    await preflight();
    const delivery = current.authority.deliveries.find(entry => entry.slice === slice);
    if (!delivery || !['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE'].includes(operation)) fail('operation/delivery is not admitted');
    const owner = { operationAttemptId: randomUUID(), ownershipToken: randomUUID(), deliveryId: delivery.deliveryId, slice, operation,
      preparationRevision: current.activation.preparationRevision, normativeSha256: current.activation.normativeSha256,
      originActivationId: current.activation.activationId, runner: null };
    const activation = { ...current.activation, activationId: randomUUID(), sequence: current.activation.sequence + 1,
      previousActivationId: current.activation.activationId, activeAttempt: owner };
    await assertExecutionPublicationLock(lease);
    await replaceActivation(workspace.executionRoot, activation);
    const readback = await readActivated();
    if (!equal(readback.activation, activation)) fail('begin readback uncertain; preserve ownership');
    return { publication: 'confirmed', cleanup: 'complete', owner, expectedActivationId: activation.activationId, activation };
  });
}

async function copyTree(source, target) {
  await fs.mkdir(target, { mode: 0o700 });
  for (const entry of (await fs.readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const from = path.join(source, entry.name); const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else { const file = await readOwnedFile(from); await writeNew(to, file.bytes, file.mode); }
  }
}

// The wrapper supplies fixed operation-specific validation and diff scope, never model-selected callbacks.
export async function publishExecutionUpdate({ workspace, candidateExecutionRoot, expectedTree, expectedActivationId,
  owner = null, terminal = false, draft = false, readActivated, validateCandidate, authorizeDiff, checkpoint = null }) {
  const location = await executionLockIdentity(workspace);
  await ancestry(candidateExecutionRoot);
  const candidate = await fs.realpath(candidateExecutionRoot);
  if (inside(candidate, workspace.specRoot ?? workspace.executionRoot) || inside(workspace.executionRoot, candidate)) fail('candidate overlaps official execution');
  const candidateTree = await captureExecutionTree(candidate);
  const allocationId = randomUUID();
  const stage = path.join(location.parent, `.stnl-execution-stage-${allocationId}`);
  const backup = path.join(location.parent, `.stnl-execution-backup-${allocationId}`);
  const marker = path.join(location.parent, `.stnl-execution-publication-${allocationId}.json`);
  await writeNew(marker, Buffer.from(JSON.stringify({ format: 'stnl-execution-publication-owner-v1', allocationId, executionRoot: workspace.executionRoot,
    candidate, stage, backup, expectedActivationId, expectedTree, owner }) + '\n'));
  await copyTree(candidate, stage);
  if (!equal((await captureExecutionTree(stage)).files, candidateTree.files) || !equal(await captureExecutionTree(candidate), candidateTree)) fail(`candidate changed while staging; retained allocation: ${marker}`);
  let confirmed = false; let markerWritten = false;
  const result = await withExecutionPublicationLock(workspace, async lease => {
    const before = await captureExecutionTree(workspace.executionRoot);
    if (!equal(before, expectedTree)) fail(`publication base changed; retained candidate/allocation: ${marker}`);
    let previous = null;
    if (expectedActivationId !== null) {
      previous = (await readActivated()).activation;
      if (previous.activationId !== expectedActivationId) fail('publication activation CAS conflict');
    }
    if (owner) assertExecutionAttempt(previous, owner);
    else if (previous?.activeAttempt) fail('active/uncertain owner blocks replacement');
    await authorizeDiff(stage, before);
    const authority = await validateCandidate(stage);
    if (!equal((await captureExecutionTree(stage)).files, candidateTree.files)) fail('staged candidate changed during validation');
    if (owner && digest((await readOwnedFile(path.join(stage, 'approved-preparation.json'))).bytes) !== previous.approvedSnapshotSha256) fail('operational update changed protected review snapshot');
    if (owner && (authority.normativeSha256 !== previous.normativeSha256 || authority.preparationRevision !== previous.preparationRevision)) fail('operational update changed preparation authority');
    await assertExecutionPublicationLock(lease);
    let moved = false; let installed = false;
    try {
      if (checkpoint) await checkpoint('before-backup', { stage, backup, marker });
      if (before) { await fs.rename(workspace.executionRoot, backup); moved = true; }
      if (checkpoint) await checkpoint('after-backup', { stage, backup, marker });
      if (await stat(workspace.executionRoot)) fail('official target unexpectedly occupied');
      await fs.rename(stage, workspace.executionRoot); installed = true;
      if (checkpoint) await checkpoint('after-install', { stage, backup, marker });
      if (!equal((await captureExecutionTree(workspace.executionRoot)).files, candidateTree.files)) fail('installed bytes changed');
      let activation = null;
      if (!draft) {
        const snapshotBytes = (await readOwnedFile(path.join(workspace.executionRoot, 'approved-preparation.json'))).bytes;
        activation = { format: 'stnl-execution-activation-v1', activationId: randomUUID(), sequence: (previous?.sequence ?? 0) + 1,
          previousActivationId: previous?.activationId ?? null, preparationRevision: authority.preparationRevision,
          requirementsAuthority: authority.requirementsAuthority, normativeSha256: authority.normativeSha256,
          approvedSnapshotSha256: digest(snapshotBytes), artifacts: await officialManifest(workspace.executionRoot),
          activeAttempt: previous?.activeAttempt ?? null,
          lastAttempt: previous?.lastAttempt ?? null };
        if (checkpoint) await checkpoint('before-activation', { stage, backup, marker });
        // Any error after entering this call may have installed the marker. Never compensate blindly.
        markerWritten = true;
        await replaceActivation(workspace.executionRoot, activation);
        if (checkpoint) await checkpoint('after-activation', { stage, backup, marker });
        const readback = await readActivated();
        if (!equal(readback.activation, activation)) fail('activation readback uncertain');
        if (terminal) {
          // Preserve ownership through the first image readback. Only confirmed image publication
          // can seal a terminal record and clear the owner; this is a new CAS identity.
          const terminalId = randomUUID();
          activation = { ...activation, previousActivationId: activation.activationId, activationId: terminalId,
            sequence: activation.sequence + 1, activeAttempt: null,
            lastAttempt: { ...previous.activeAttempt, terminalActivationId: terminalId } };
          await replaceActivation(workspace.executionRoot, activation);
          try {
            if (checkpoint) await checkpoint('after-terminal-activation', { stage, backup, marker });
            const terminalReadback = await readActivated();
            if (!equal(terminalReadback.activation, activation)) fail('terminal readback uncertain');
          } catch (terminalError) {
            // Terminal acknowledgment is uncertain. Keep the final artifact image, but
            // conservatively hold this owner. Never overwrite an unobserved/foreign marker.
            try {
              const observed = parseStrictJson((await readOwnedFile(path.join(workspace.executionRoot, 'activation.json'))).bytes.toString('utf8'));
              if (!equal(observed, activation)) fail('cannot prove ownership of terminal marker');
              await assertExecutionPublicationLock(lease);
              const hold = { ...activation, previousActivationId: activation.activationId, activationId: randomUUID(),
                sequence: activation.sequence + 1, activeAttempt: previous.activeAttempt, lastAttempt: previous.lastAttempt };
              await replaceActivation(workspace.executionRoot, hold);
              const held = parseStrictJson((await readOwnedFile(path.join(workspace.executionRoot, 'activation.json'))).bytes.toString('utf8'));
              if (!equal(held, hold)) fail('ownership hold readback uncertain');
              terminalError.message += `; owner preserved at activation ${hold.activationId}`;
            } catch (holdError) {
              terminalError.retainExecutionLock = true;
              terminalError.message += `; ownership hold uncertain: ${holdError.message}`;
            }
            throw terminalError;
          }
        }
      } else {
        if (await stat(path.join(workspace.executionRoot, 'activation.json'))) fail('draft retained an executable marker');
        await validateCandidate(workspace.executionRoot);
      }
      confirmed = true;
      if (checkpoint) {
        try { await checkpoint('cleanup', { stage, backup, marker }); } catch (error) { return { publication: 'confirmed', cleanup: 'pending', cleanupDiagnostics: [error.message], retainedBackup: moved ? backup : null, allocation: marker, activation, expectedActivationId: activation?.activationId ?? null }; }
      }
      // Retain previous approved snapshots/evidence with their ownership marker until U2 retention policy.
      return { publication: 'confirmed', cleanup: 'complete', retainedBackup: moved ? backup : null, allocation: marker,
        activation, expectedActivationId: activation?.activationId ?? null };
    } catch (error) {
      if (!confirmed && !markerWritten) {
        try {
          if (installed) {
            if (!equal((await captureExecutionTree(workspace.executionRoot)).files, candidateTree.files)) fail('cannot prove ownership of installed image; preserve backup');
            await fs.rename(workspace.executionRoot, stage);
          }
          if (moved) {
            if (!equal(await captureExecutionTree(backup), before) || await stat(workspace.executionRoot)) fail('cannot prove restoration ownership');
            if (checkpoint) await checkpoint('before-restore', { stage, backup, marker });
            await fs.rename(backup, workspace.executionRoot);
          }
        } catch (restoreError) { error.message += `; restore failed: ${restoreError.message}; retained backup ${backup}, stage ${stage}`; }
      } else error.message += '; activation outcome uncertain; preserve owner and inspect marker before any retry';
      error.allocation = marker; throw error;
    }
  });
  return result;
}

// Lifecycle acquires this boundary before observing existence/base, then its private journal lock.
export async function assertLifecycleExecutionUnowned(executionRoot) {
  const marker = path.join(executionRoot, 'activation.json');
  if (!await stat(marker)) return;
  const bytes = (await readOwnedFile(marker)).bytes;
  let activation; try { activation = parseStrictJson(bytes.toString('utf8')); } catch { fail('lifecycle found malformed activation'); }
  validateActivation(activation);
  if (activation.activeAttempt !== null) fail('active or uncertain execution prevents lifecycle replacement');
}

// JSON.parse alone silently accepts duplicate keys. Walk the JSON grammar first.
export function parseStrictJson(text) {
  let i = 0;
  const ws = () => { while (/\s/u.test(text[i] ?? '') && i < text.length) i += 1; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    fail('unterminated JSON string');
  };
  const value = () => {
    ws();
    if (text[i] === '{') {
      i += 1; ws(); const keys = new Set();
      if (text[i] === '}') { i += 1; return; }
      while (i < text.length) {
        if (text[i] !== '"') fail('invalid JSON object');
        const key = string(); if (keys.has(key)) fail(`duplicate JSON key ${key}`); keys.add(key);
        ws(); if (text[i++] !== ':') fail('invalid JSON field'); value(); ws();
        if (text[i] === '}') { i += 1; return; }
        if (text[i++] !== ',') fail('invalid JSON object delimiter'); ws();
      }
    } else if (text[i] === '[') {
      i += 1; ws(); if (text[i] === ']') { i += 1; return; }
      while (i < text.length) { value(); ws(); if (text[i] === ']') { i += 1; return; } if (text[i++] !== ',') fail('invalid JSON array'); }
    } else if (text[i] === '"') string();
    else { const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(i)); if (!match) fail('invalid JSON value'); i += match[0].length; }
  };
  value(); ws(); if (i !== text.length) fail('trailing JSON content'); return JSON.parse(text);
}


export async function readOperationOwner(specPath, environment = process.env) {
  const file = environment.STNL_OPERATION_OWNER_FILE;
  if (!file || !path.isAbsolute(file)) fail('runtime operation owner file is required');
  const record = parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
  if (record.specPath !== await fs.realpath(specPath)) fail('operation owner file belongs to another requirements source');
  return record.owner;
}

export async function bindExecutionBroker({ workspace, owner, runner, readActivated }) {
  return withExecutionPublicationLock(workspace, async lease => {
    const current = await readActivated();
    const attempt = assertExecutionAttempt(current.activation, owner);
    if (attempt.runner !== null) fail('attempt already has a runner broker; preserve pending/uncertain dispatch');
    const activation = { ...current.activation, activationId: randomUUID(), sequence: current.activation.sequence + 1,
      previousActivationId: current.activation.activationId, activeAttempt: { ...attempt, runner } };
    validateActivation(activation);
    await assertExecutionPublicationLock(lease); await replaceActivation(workspace.executionRoot, activation);
    const after = await readActivated();
    if (!equal(after.activation, activation)) fail('broker binding readback uncertain');
    return { publication: 'confirmed', cleanup: 'complete', expectedActivationId: activation.activationId };
  });
}
