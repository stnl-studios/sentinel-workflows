// Neutral, distributable publication boundary. No execution-state or lifecycle journal imports.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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

async function readFileWithLinks(file, links) {
  await ancestry(file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !links.includes(before.nlink)) fail(`file must be regular and single-link: ${file}`);
    const bytes = await handle.readFile(); const after = await handle.stat(); const pathname = await fs.lstat(file);
    if (!equal(identity(before), identity(after)) || !equal(identity(after), identity(pathname))
      || !links.includes(pathname.nlink) || before.nlink !== after.nlink
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`file changed during read: ${file}`);
    return { file, bytes, identity: identity(after), mode: after.mode & 0o777, links: after.nlink };
  } finally { await handle.close(); }
}
export async function readOwnedFile(file) { return readFileWithLinks(file, [1]); }
export async function captureLifecycleRecoveryControl(file) {
  const current = await readFileWithLinks(file, [1, 2]);
  return { file, identity: current.identity, sha256: digest(current.bytes), links: current.links };
}

export async function syncLockParent(parent) {
  let handle;
  try { handle = await fs.open(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); await handle.sync(); }
  catch (error) { if (!['EBADF','EINVAL','ENOTSUP','EOPNOTSUPP','EISDIR', ...(process.platform === 'win32' ? ['EPERM','EACCES'] : [])].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

export async function writeNew(file, bytes, mode = 0o600) {
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

async function assertNoRecoveryClaim(location) {
  const prefix = `${path.basename(location.lockPath)}.recovery-`;
  if ((await fs.readdir(location.parent)).some(name => name.startsWith(prefix))) fail(`common lease recovery is incomplete; preserve and diagnose: ${location.lockPath}`);
}

async function createExecutionLease(location) {
  const token = randomUUID();
  const bytes = Buffer.from(JSON.stringify({ format: 'stnl-execution-lock-v1', token, executionRoot: location.executionRoot, pid: process.pid }) + '\n');
  let owned;
  try { owned = await writeNew(location.lockPath, bytes); }
  catch (error) {
    if (error.code === 'EEXIST') {
      const blocked = new Error(`execution publication: lock already exists; preserve and diagnose owner: ${location.lockPath}`);
      throw Object.assign(blocked, { code: 'EXECUTION_PUBLICATION_BLOCKED', existingExecutionLock: true });
    }
    throw error;
  }
  const lease = { ...location, token, owned };
  await syncLockParent(location.parent);
  await assertExecutionPublicationLock(lease);
  return lease;
}

export async function acquireExecutionPublicationLock(workspace) {
  const location = await executionLockIdentity(workspace);
  await assertNoRecoveryClaim(location);
  const lease = await createExecutionLease(location);
  try { await assertNoRecoveryClaim(location); }
  catch (error) { await releaseExecutionPublicationLock(lease); throw error; }
  return lease;
}

export function validateLifecycleCommonLeaseBinding(binding) {
  closed(binding, ['format','executionRoot','lockPath','parentIdentity','identity','sha256','token','pid','hostname'], 'lifecycle common lease binding');
  for (const field of ['parentIdentity','identity']) {
    closed(binding[field], ['dev','ino'], `common lease ${field}`);
    if (!Object.values(binding[field]).every(value => typeof value === 'string' && /^\d+$/u.test(value))) fail('common lease has invalid physical identity');
  }
  if (binding.format !== 'stnl-lifecycle-common-lease-v1' || typeof binding.executionRoot !== 'string' || !path.isAbsolute(binding.executionRoot)
    || typeof binding.lockPath !== 'string' || !path.isAbsolute(binding.lockPath)
    || typeof binding.token !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(binding.token)
    || typeof binding.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(binding.sha256)
    || !Number.isSafeInteger(binding.pid) || binding.pid <= 0 || typeof binding.hostname !== 'string' || !binding.hostname || binding.hostname.length > 1024) fail('invalid lifecycle common lease binding');
  return binding;
}

// Only the producer's real acquired lease supplies this persisted witness.
export async function lifecycleCommonLeaseBinding(lease) {
  await assertExecutionPublicationLock(lease);
  return validateLifecycleCommonLeaseBinding({ format: 'stnl-lifecycle-common-lease-v1', executionRoot: lease.executionRoot,
    lockPath: lease.lockPath, parentIdentity: lease.parentIdentity, identity: lease.owned.identity,
    sha256: digest(lease.owned.bytes), token: lease.token, pid: process.pid, hostname: os.hostname() });
}

function assertDeadLifecycleOwner(binding) {
  if (binding.hostname !== os.hostname()) fail('common lease recovery owner belongs to another host');
  try { process.kill(binding.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; fail('common lease recovery owner liveness is uncertain'); }
  fail('common lease recovery owner is alive');
}

function assertBoundCommonFile(current, binding) {
  const record = parseStrictJson(current.bytes.toString('utf8'));
  closed(record, ['format','token','executionRoot','pid'], 'recoverable common lease');
  if (record.format !== 'stnl-execution-lock-v1' || record.token !== binding.token || record.executionRoot !== binding.executionRoot
    || record.pid !== binding.pid || !equal(current.identity, binding.identity)
    || digest(current.bytes) !== binding.sha256) fail('common lease differs from lifecycle binding');
}

async function assertRecoveryControls(proof, location) {
  closed(proof, ['format','binding','controls','absent'], 'lifecycle recovery proof');
  if (proof.format !== 'stnl-lifecycle-common-recovery-v1' || !Array.isArray(proof.controls) || !proof.controls.length || proof.controls.length > 128
    || new Set(proof.controls.map(entry => entry.file)).size !== proof.controls.length || !Array.isArray(proof.absent)) fail('invalid lifecycle recovery controls');
  for (const control of proof.controls) {
    closed(control, ['file','identity','sha256','links'], 'lifecycle recovery control');
    if (!path.isAbsolute(control.file) || path.dirname(control.file) !== location.parent || ![1, 2].includes(control.links)) fail('lifecycle recovery control is outside stable ancestor or has invalid links');
    if (control.links === 2 && proof.controls.filter(other => equal(other.identity, control.identity)
      && other.sha256 === control.sha256 && other.links === 2).length !== 2) fail('lifecycle recovery control has an unbound extra link');
    const current = await readFileWithLinks(control.file, [control.links]);
    if (!equal(current.identity, control.identity) || digest(current.bytes) !== control.sha256) fail('lifecycle recovery control changed');
  }
  for (const file of proof.absent) {
    if (!path.isAbsolute(file) || path.dirname(file) !== location.parent || await stat(file)) fail('absent lifecycle recovery control appeared');
  }
}

// A typed proof from the lifecycle wrapper, never a general takeover predicate.
// The exclusive hardlink is a retirement role of this lease, not a third lock.
async function acquireLifecycleRecoveryLease(workspace, proof) {
  const location = await executionLockIdentity(workspace);
  const binding = validateLifecycleCommonLeaseBinding(proof.binding);
  if (binding.executionRoot !== location.executionRoot || binding.lockPath !== location.lockPath
    || !equal(binding.parentIdentity, location.parentIdentity)) fail('common lease recovery root or ancestor differs');
  await assertNoRecoveryClaim(location);
  await assertRecoveryControls(proof, location);
  assertDeadLifecycleOwner(binding);
  assertBoundCommonFile(await readOwnedFile(location.lockPath), binding);
  const claim = `${location.lockPath}.recovery-${binding.token}`;
  try { await fs.link(location.lockPath, claim); }
  catch (error) { if (['EEXIST','ENOENT'].includes(error.code)) fail('another recovery already claimed the common lease'); throw error; }
  await syncLockParent(location.parent);
  const captured = await readFileWithLinks(claim, [2]);
  // A delayed recoverer may have linked a replacement. Remove only its own
  // just-created extra link, never rename/unlink the replacement's canonical path.
  if (!equal(captured.identity, binding.identity) || digest(captured.bytes) !== binding.sha256) {
    const canonical = await readFileWithLinks(location.lockPath, [2]);
    const rechecked = await readFileWithLinks(claim, [2]);
    if (equal(canonical.identity, captured.identity) && equal(rechecked.identity, captured.identity)
      && canonical.bytes.equals(captured.bytes) && rechecked.bytes.equals(captured.bytes)) {
      await fs.unlink(claim); await syncLockParent(location.parent);
    }
    fail('common lease changed before exclusive recovery claim');
  }
  assertBoundCommonFile(captured, binding);
  await assertRecoveryControls(proof, location);
  assertDeadLifecycleOwner(binding);
  const parent = await fs.lstat(location.parent);
  if (!equal(identity(parent), binding.parentIdentity) || await fs.realpath(location.parent) !== location.parent) fail('common lease recovery ancestor changed');
  assertBoundCommonFile(await readFileWithLinks(location.lockPath, [2]), binding);
  await fs.unlink(location.lockPath);
  await syncLockParent(location.parent);
  const lease = await createExecutionLease(location);
  const retired = await readOwnedFile(claim);
  assertBoundCommonFile(retired, binding);
  await assertExecutionPublicationLock(lease);
  await fs.unlink(claim);
  await syncLockParent(location.parent);
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
  return withPublicationLease(lease, action);
}

// EC-1 keeps the same common lease as legacy writers. The operation-specific
// controller supplies the validated current-image callbacks and an immutable
// binding; this boundary owns the activation CAS and physical tree exchange.
export async function reserveCurrentExecutionOperation({workspace,expectedActivationId,expectedBaseActivation,owner,binding,
  marker,registryReservation,readQuiet,readActive,bindingSha256}) {
  return withExecutionPublicationLock(workspace,async lease=>{
    const base=await readQuiet();
    if(base.activation.activationId!==expectedActivationId || !equal(base.activation,expectedBaseActivation)
      || base.activation.activeAttempt!==null
      || owner.originActivationId!==expectedActivationId) fail('EC-1 reservation base or owner differs');
    const tree=await captureExecutionTree(workspace.executionRoot);
    if(!equal(tree,binding.baseTree)) fail('EC-1 reservation physical base differs');
    const allocation={format:'stnl-execution-publication-owner-v2',binding,phase:'allocated',
      candidate:null,previous:null,expectedInstalledActivation:null,preparation:null,runner:null,
      normalization:null,commonLease:await lifecycleCommonLeaseBinding(lease),confirmation:null,
      cleanup:{status:'none',ownedPaths:[],diagnostics:[]}};
    await registryReservation(allocation);
    await writeNew(marker,Buffer.from(JSON.stringify(allocation,null,2)+'\n'));
    const activation={...base.activation,activationId:randomUUID(),sequence:base.activation.sequence+1,
      previousActivationId:base.activation.activationId,
      activeAttempt:{...owner,operationRef:{operationId:binding.operationId,allocationSha256:bindingSha256}}};
    await assertExecutionPublicationLock(lease);
    await replaceActivation(workspace.executionRoot,activation);
    const admitted=await readActive(activation.activeAttempt);
    if(!equal(admitted.activation,activation)) fail('EC-1 reservation readback uncertain');
    allocation.phase='working';
    await persistAllocation(marker,allocation);
    return {publication:'confirmed',cleanup:'complete',baseActivation:base.activation,
      reservedActivation:activation,owner:activation.activeAttempt,baseTree:tree};
  });
}

export async function publishCurrentExecutionOperation({workspace,marker,binding,candidatePath,previousPath,
  expectedActivationId,owner,readActive,readQuiet,validateCandidate,authorizeCandidate,
  registryCompletion,checkpoint=null}) {
  return withExecutionPublicationLock(workspace,async lease=>{
    const allocated=parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
    if(allocated.format!=='stnl-execution-publication-owner-v2'
      || !equal(allocated.binding,binding) || !['working','prepared','backup_created','candidate_promoted','activation_written','committed'].includes(allocated.phase))
      fail('EC-1 allocation binding/phase differs');
    const terminalOutcome=allocated.terminalTransition?.outcome??'recorded';
    if(!['recorded','rejected'].includes(terminalOutcome)
      || allocated.terminalTransition && allocated.terminalTransition.operationAttemptId!==owner.operationAttemptId
      || terminalOutcome==='rejected' && !allocated.terminalTransition?.normalization)
      fail('EC-1 terminal transition differs from owner');
    const active=await readActive(owner);
    if(active.activation.activationId!==expectedActivationId
      || !equal(active.activation.activeAttempt,owner)) fail('EC-1 publication owner CAS differs');
    if(allocated.phase==='committed') fail('EC-1 already committed; use confirmed readback');
    if(allocated.phase!=='working' && allocated.phase!=='prepared')
      fail(`EC-1 publication phase ${allocated.phase} requires recovery classification`);
    const before=await captureExecutionTree(workspace.executionRoot);
    const candidate=await captureExecutionTree(candidatePath);
    if(!candidate || await stat(previousPath)) fail('EC-1 candidate or previous tree differs');
    if(allocated.candidate!==null && !equal(allocated.candidate,{identity:candidate.identity,tree:candidate.files}))
      fail('EC-1 candidate changed since preparation');
    await authorizeCandidate(active,candidate);
    await validateCandidate(candidatePath);
    if(!equal(candidate,await captureExecutionTree(candidatePath))) fail('EC-1 candidate changed during validation');
    allocated.candidate={identity:candidate.identity,tree:candidate.files};
    allocated.phase='prepared';allocated.commonLease=await lifecycleCommonLeaseBinding(lease);
    await persistAllocation(marker,allocated);
    await assertExecutionPublicationLock(lease);
    if(checkpoint) await checkpoint('before-backup');
    if(!equal(before,await captureExecutionTree(workspace.executionRoot))) fail('EC-1 live tree changed before swap');
    let moved=false,promoted=false,activationWritten=false;
    try {
      await fs.rename(workspace.executionRoot,previousPath); moved=true;
      await syncLockParent(path.dirname(workspace.executionRoot));
      allocated.previous={identity:before.identity,tree:before.files};
      allocated.phase='backup_created';await persistAllocation(marker,allocated);
      if(checkpoint) await checkpoint('after-backup');
      if(await stat(workspace.executionRoot)) fail('EC-1 live target unexpectedly occupied');
      await fs.rename(candidatePath,workspace.executionRoot); promoted=true;
      await syncLockParent(path.dirname(workspace.executionRoot));
      allocated.phase='candidate_promoted';await persistAllocation(marker,allocated);
      if(checkpoint) await checkpoint('after-install');
      if(!equal((await captureExecutionTree(workspace.executionRoot)).files,candidate.files))
        fail('EC-1 installed candidate changed');
      const artifacts=candidate.files.filter(item=>item.type==='file' && item.path!=='activation.json')
        .map(item=>({path:item.path,sha256:item.sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
      const intermediate={...active.activation,activationId:randomUUID(),sequence:active.activation.sequence+1,
        previousActivationId:active.activation.activationId,artifacts};
      allocated.expectedInstalledActivation=intermediate;
      await persistAllocation(marker,allocated);
      if(checkpoint) await checkpoint('before-activation');
      await replaceActivation(workspace.executionRoot,intermediate);activationWritten=true;
      allocated.phase='activation_written';await persistAllocation(marker,allocated);
      if(checkpoint) await checkpoint('after-activation');
      const first=await readActive(owner);
      if(!equal(first.activation,intermediate)) fail('EC-1 intermediate readback differs');
      const terminalId=randomUUID();
      const terminal={...intermediate,activationId:terminalId,sequence:intermediate.sequence+1,
        previousActivationId:intermediate.activationId,activeAttempt:null,
        lastAttempt:{operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,
          slice:owner.slice,operation:owner.operation,terminalActivationId:terminalId,outcome:terminalOutcome,
          operationRef:owner.operationRef}};
      allocated.preparation={...(allocated.preparation??{}),intermediateActivation:intermediate};
      allocated.expectedInstalledActivation=terminal;await persistAllocation(marker,allocated);
      await replaceActivation(workspace.executionRoot,terminal);
      if(checkpoint) await checkpoint('after-terminal-activation');
      const final=await readQuiet();
      if(!equal(final.activation,terminal)) fail('EC-1 terminal readback differs');
      allocated.phase='committed';
      allocated.confirmation={activationId:terminalId,artifactManifestSha256:digest(JSON.stringify(artifacts))};
      allocated.cleanup={status:'pending',ownedPaths:[{role:'previous',path:previousPath,
        identity:before.identity,tree:before.files}],diagnostics:[]};
      await persistAllocation(marker,allocated);
      try {
        const retained=await captureExecutionTree(previousPath);
        if(!equal(retained,before)) fail('EC-1 previous tree changed before own cleanup');
        await fs.rm(previousPath,{recursive:true});
        allocated.cleanup={status:'pending',ownedPaths:[],diagnostics:[]};
        await persistAllocation(marker,allocated);
        if(checkpoint) await checkpoint('before-registry-completion');
        await registryCompletion(allocated);
        allocated.cleanup={status:'complete',ownedPaths:[],diagnostics:[]};
        await persistAllocation(marker,allocated);
      } catch(error) {
        allocated.cleanup.status='pending';allocated.cleanup.diagnostics=[error.message];
        await persistAllocation(marker,allocated);
        return {publication:'confirmed',cleanup:'pending',activation:terminal,allocation:marker,
          cleanupDiagnostics:[error.message]};
      }
      return {publication:'confirmed',cleanup:'complete',activation:terminal,allocation:marker};
    } catch(error) {
      if(!activationWritten) {
        try {
          if(promoted) {
            const installed=await captureExecutionTree(workspace.executionRoot);
            if(!installed || !equal(installed.files,candidate.files)) fail('EC-1 foreign installed bytes; preserve previous');
            await fs.rename(workspace.executionRoot,candidatePath);
          }
          if(moved) {
            if(await stat(workspace.executionRoot) || !equal(await captureExecutionTree(previousPath),before))
              fail('EC-1 previous tree is not own unchanged base');
            await fs.rename(previousPath,workspace.executionRoot);
          }
          await syncLockParent(path.dirname(workspace.executionRoot));
          allocated.phase='working';allocated.previous=null;
          await persistAllocation(marker,allocated);
        } catch(restoreError) {
          error.message+=`; EC-1 restoration uncertain: ${restoreError.message}`;
        }
      } else error.message+='; EC-1 activation outcome requires readback recovery';
      throw error;
    }
  });
}

// Resume only the already installed, byte-verified image for this exact owner.
// The terminal activation is persisted before its CAS so a process failure can
// classify the same intermediate/terminal pair without rebuilding a candidate.
export async function recoverCurrentExecutionOperation({workspace,marker,binding,previousPath,
  expectedActivationId,owner,readActive,readQuiet,registryCompletion}) {
  return withExecutionPublicationLock(workspace,async lease=>{
    const allocated=parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
    if(allocated.format!=='stnl-execution-publication-owner-v2'
      || !equal(allocated.binding,binding) || allocated.phase!=='activation_written'
      || !allocated.candidate || !allocated.previous || !allocated.expectedInstalledActivation)
      fail('EC-1 recovery owner/phase differs');
    const terminalOutcome=allocated.terminalTransition?.outcome??'recorded';
    if(!['recorded','rejected'].includes(terminalOutcome)
      || allocated.terminalTransition && allocated.terminalTransition.operationAttemptId!==owner.operationAttemptId
      || terminalOutcome==='rejected' && !allocated.terminalTransition?.normalization)
      fail('EC-1 recovery terminal transition differs');
    const installed=await captureExecutionTree(workspace.executionRoot);
    const previous=await captureExecutionTree(previousPath);
    const withoutActivation=entries=>entries.filter(item=>item.path!=='activation.json');
    if(!installed || !previous
      || !equal(installed.identity,allocated.candidate.identity)
      || !equal(withoutActivation(installed.files),withoutActivation(allocated.candidate.tree))
      || !equal({identity:previous.identity,tree:previous.files},allocated.previous))
      fail('EC-1 recovery installed or previous tree differs');
    let expected=allocated.expectedInstalledActivation;
    const actual=parseStrictJson((await readOwnedFile(path.join(workspace.executionRoot,'activation.json'))).bytes.toString('utf8'));
    if(actual.activeAttempt!==null) {
      const intermediate=allocated.preparation?.intermediateActivation??expected;
      if(!equal(actual,intermediate) || !equal(actual.activeAttempt,owner)
        || actual.previousActivationId!==expectedActivationId)
        fail('EC-1 recovery intermediate activation differs');
      const readback=await readActive(owner);
      if(!equal(readback.activation,actual)) fail('EC-1 recovery active readback differs');
      if(!allocated.preparation?.intermediateActivation) {
        const terminalId=randomUUID();
        expected={...actual,activationId:terminalId,sequence:actual.sequence+1,
          previousActivationId:actual.activationId,activeAttempt:null,
          lastAttempt:{operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,
            slice:owner.slice,operation:owner.operation,terminalActivationId:terminalId,outcome:terminalOutcome,
            operationRef:owner.operationRef}};
        allocated.preparation={...(allocated.preparation??{}),intermediateActivation:actual};
        allocated.expectedInstalledActivation=expected;
        allocated.commonLease=await lifecycleCommonLeaseBinding(lease);
        await persistAllocation(marker,allocated);
      }
      if(expected.activeAttempt!==null || expected.previousActivationId!==actual.activationId
        || expected.lastAttempt?.operationAttemptId!==owner.operationAttemptId)
        fail('EC-1 recovery terminal descriptor differs');
      await assertExecutionPublicationLock(lease);
      await replaceActivation(workspace.executionRoot,expected);
    } else if(!equal(actual,expected) || expected.activeAttempt!==null
      || expected.lastAttempt?.operationAttemptId!==owner.operationAttemptId)
      fail('EC-1 recovery terminal activation differs');
    const final=await readQuiet();
    if(!equal(final.activation,expected)) fail('EC-1 recovery terminal readback differs');
    allocated.phase='committed';
    allocated.confirmation={activationId:expected.activationId,
      artifactManifestSha256:digest(JSON.stringify(expected.artifacts))};
    allocated.cleanup={status:'pending',ownedPaths:[{role:'previous',path:previousPath,
      identity:previous.identity,tree:previous.files}],diagnostics:[]};
    await persistAllocation(marker,allocated);
    try {
      if(!equal(await captureExecutionTree(previousPath),previous)) fail('EC-1 recovery previous changed before cleanup');
      await fs.rm(previousPath,{recursive:true});
      allocated.cleanup={status:'pending',ownedPaths:[],diagnostics:[]};
      await persistAllocation(marker,allocated);
      await registryCompletion(allocated);
      allocated.cleanup={status:'complete',ownedPaths:[],diagnostics:[]};
      await persistAllocation(marker,allocated);
    } catch(error) {
      allocated.cleanup.status='pending';allocated.cleanup.diagnostics=[error.message];
      await persistAllocation(marker,allocated);
      return {publication:'confirmed',cleanup:'pending',activation:expected,allocation:marker,
        cleanupDiagnostics:[error.message]};
    }
    return {publication:'confirmed',cleanup:'complete',activation:expected,allocation:marker};
  });
}

export async function finishCurrentExecutionCleanup({workspace,marker,binding,previousPath,
  owner,readQuiet,registryCompletion}) {
  return withExecutionPublicationLock(workspace,async()=>{
    const allocated=parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
    if(allocated.format!=='stnl-execution-publication-owner-v2'
      || !equal(allocated.binding,binding) || allocated.phase!=='committed'
      || allocated.cleanup?.status!=='pending' || !allocated.confirmation)
      fail('EC-1 cleanup owner/phase differs');
    const current=await readQuiet();
    if(current.activation.activationId!==allocated.confirmation.activationId
      || current.activation.activeAttempt!==null
      || current.activation.lastAttempt?.operationAttemptId!==owner.operationAttemptId
      || digest(JSON.stringify(current.activation.artifacts))!==allocated.confirmation.artifactManifestSha256)
      fail('EC-1 cleanup confirmed image differs');
    const retained=await captureExecutionTree(previousPath);
    if(retained) {
      if(!allocated.previous
        || !equal({identity:retained.identity,tree:retained.files},allocated.previous))
        fail('EC-1 cleanup previous tree changed');
      await fs.rm(previousPath,{recursive:true});
    }
    allocated.cleanup={status:'pending',ownedPaths:[],diagnostics:[]};
    await persistAllocation(marker,allocated);
    await registryCompletion(allocated);
    allocated.cleanup={status:'complete',ownedPaths:[],diagnostics:[]};
    await persistAllocation(marker,allocated);
    return {publication:'confirmed',cleanup:'complete',activation:current.activation,allocation:marker};
  });
}

export async function withLifecycleRecoveryPublicationLock(workspace, proof, action) {
  const lease = await acquireLifecycleRecoveryLease(workspace, proof);
  return withPublicationLease(lease, action);
}

async function withPublicationLease(lease, action) {
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
    if (!/^(?:plan|tasks)\.md$|^(?:approved-preparation|continuity)\.json$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(relative)) fail(`unknown official artifact: ${relative}`);
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
  const fields = ['operationAttemptId', 'ownershipToken', 'deliveryId', 'slice', 'operation', 'preparationRevision', 'normativeSha256', 'originActivationId', 'runner', 'workCapture'];
  for (const [name, attempt] of [['activeAttempt', activation.activeAttempt], ['lastAttempt', activation.lastAttempt]]) {
    if (attempt === null) continue;
    const ownedFields = [...fields, ...(Object.hasOwn(attempt ?? {}, 'recovery') ? ['recovery'] : [])];
    const expected = name === 'lastAttempt' ? [...ownedFields, 'terminalActivationId'] : ownedFields;
    if (!attempt || Object.keys(attempt).sort().join('\0') !== expected.sort().join('\0')
      || ['operationAttemptId', 'ownershipToken', 'deliveryId', 'originActivationId'].some(key => !uuid(attempt[key]))
      || !/^slice-[0-9]{2,}$/u.test(attempt.slice) || !['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE'].includes(attempt.operation)
      || !Number.isSafeInteger(attempt.preparationRevision) || !/^sha256:[a-f0-9]{64}$/u.test(attempt.normativeSha256)
      || (name === 'lastAttempt' && !uuid(attempt.terminalActivationId))) fail('malformed attempt ownership');
    if (attempt.runner !== null) {
      if (!attempt.runner || Object.keys(attempt.runner).sort().join('\0') !== ['dispatchId', 'receiptFile', 'threadId', 'status'].sort().join('\0')
        || !['pending', 'uncertain', 'captured'].includes(attempt.runner.status)) fail('malformed runner binding');
    }
    if (!attempt.workCapture || Object.keys(attempt.workCapture).sort().join('\0') !== 'path\0sha256'
      || !path.isAbsolute(attempt.workCapture.path) || !/^sha256:[a-f0-9]{64}$/u.test(attempt.workCapture.sha256)) fail('malformed work capture binding');
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
  if (!owner || !attempt || ['operationAttemptId', 'ownershipToken', 'deliveryId', 'slice', 'operation', 'originActivationId', 'preparationRevision', 'normativeSha256'].some(key => attempt[key] !== owner[key])
    || !equal(attempt.workCapture,owner.workCapture) || !equal(attempt.recovery ?? null,owner.recovery ?? null)) fail('active attempt/owner/preparation differs');
  return attempt;
}

export async function assertOwnedPreparationCandidate({ candidateExecutionRoot, specPath = null, resolveWorkspace }) {
  await ancestry(candidateExecutionRoot);
  const root = await fs.realpath(candidateExecutionRoot);
  const marker = parseStrictJson((await readOwnedFile(`${root}.owner.json`)).bytes.toString('utf8'));
  if(marker.format!=='stnl-preparation-allocation-v1' || !hasOwnedAllocationEnvelope(marker,`${root}.owner.json`)) fail('preparation allocation envelope differs');
  await assertPreparationAllocationRoot(marker);
  if (!['PLAN', 'REPLAN', 'REVIEW_PLAN'].includes(marker.operation)
    || (specPath && marker.specPath !== await fs.realpath(specPath))) fail('candidate preparation identity differs');
  const workspace = await resolveWorkspace(marker.specPath);
  await assertRegisteredPreparationAllocation(workspace, marker);
  if (!equal(marker.source, await captureExecutionTree(workspace.executionRoot))) fail('preparation source/CAS is stale');
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

export async function beginExecutionOperation({ workspace, expectedActivationId, operation, slice, readActivated, preflight, captureWork, recovery = null }) {
  return withExecutionPublicationLock(workspace, async lease => {
    const current = await readActivated();
    if (current.activation.activationId !== expectedActivationId) fail('begin activation CAS conflict');
    if (current.activation.activeAttempt && !recovery) fail('an active or uncertain operation already owns execution');
    const succession = recovery ? await recovery(current) : null;
    await preflight();
    const delivery = current.authority.deliveries.find(entry => entry.slice === slice);
    if (!delivery || !['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE'].includes(operation)) fail('operation/delivery is not admitted');
    const owner = { operationAttemptId: randomUUID(), ownershipToken: randomUUID(), deliveryId: delivery.deliveryId, slice, operation,
      preparationRevision: current.activation.preparationRevision, normativeSha256: current.activation.normativeSha256,
      originActivationId: current.activation.activationId, runner: null, workCapture: null, ...(succession ? { recovery: succession } : {}) };
    if (typeof captureWork !== 'function') fail('trusted pre-effect work capture required');
    owner.workCapture = await captureWork(owner, current);
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
export async function copyCurrentCandidateTree(source,target) { await copyTree(source,target); }

// The wrapper supplies fixed operation-specific validation and diff scope, never model-selected callbacks.
export async function publishExecutionUpdate({ workspace, candidateExecutionRoot, expectedTree, expectedActivationId,
  owner = null, terminal = false, draft = false, readActivated, validateCandidate, authorizeDiff, checkpoint = null,
  prepareRetention = null, currentInitial = false }) {
  const location = await executionLockIdentity(workspace);
  await ancestry(candidateExecutionRoot);
  const candidate = await fs.realpath(candidateExecutionRoot);
  if (inside(candidate, workspace.specRoot ?? workspace.executionRoot) || inside(workspace.executionRoot, candidate)) fail('candidate overlaps official execution');
  const candidateTree = await captureExecutionTree(candidate);
  const allocationId = randomUUID();
  const stage = path.join(location.parent, `.stnl-execution-stage-${allocationId}`);
  const retentionRoot = path.join(location.parent, `.stnl-execution-backup-${allocationId}`);
  const backup = path.join(retentionRoot, 'previous');
  const marker = path.join(location.parent, `.stnl-execution-publication-${allocationId}.json`);
  const allocation = { format: 'stnl-execution-publication-owner-v1', allocationId, executionRoot: workspace.executionRoot,
    candidate, stage, backup, retentionRoot, expectedActivationId, expectedTree, owner };
  await writeNew(marker, Buffer.from(JSON.stringify(allocation) + '\n'));
  await fs.mkdir(retentionRoot, { mode: 0o700 });
  if (owner?.workCapture) await registerOwnedAllocation(owner.workCapture, marker);
  await copyTree(candidate, stage);
  if (!equal((await captureExecutionTree(stage)).files, candidateTree.files) || !equal(await captureExecutionTree(candidate), candidateTree)) fail(`candidate changed while staging; retained allocation: ${marker}`);
  let confirmed = false; let markerWritten = false;
  const result = await withExecutionPublicationLock(workspace, async lease => {
    const before = await captureExecutionTree(workspace.executionRoot);
    if (!equal(before, expectedTree)) fail(`publication base changed; retained candidate/allocation: ${marker}`);
    if (currentInitial && (before !== null || expectedActivationId !== null || owner !== null || terminal || draft || prepareRetention))
      fail('EC-1 Initial ingress requires an absent official execution and no predecessor');
    let previous = null;
    if (expectedActivationId !== null) {
      previous = (await readActivated()).activation;
      if (previous.activationId !== expectedActivationId) fail('publication activation CAS conflict');
    }
    if (owner) assertExecutionAttempt(previous, owner);
    else if (previous?.activeAttempt) fail('active/uncertain owner blocks replacement');
    await authorizeDiff(stage, before);
    let recheckRetention=null;
    if (prepareRetention) {
      recheckRetention=await prepareRetention({ stage, backup, marker, allocation, retentionRoot });
      // Only this trusted wrapper may produce the continuity delta, before the final manifest.
      const retainedTree = await captureExecutionTree(stage);
      const mutable = new Set(['continuity.json', 'tasks.md', ...(!owner ? ['approved-preparation.json'] : []), ...candidateTree.files.filter(entry => /^tasks\/slice-[0-9]{2,}\.md$/u.test(entry.path)).map(entry => entry.path)]);
      if (!equal(retainedTree.files.filter(entry => !mutable.has(entry.path)), candidateTree.files.filter(entry => !mutable.has(entry.path)))) fail('retention changed an untyped artifact');
      candidateTree.files = retainedTree.files;
    }
    const authority = await validateCandidate(stage);
    if (currentInitial && authority.preparationRevision !== 1) fail('EC-1 Initial ingress requires preparation revision 1');
    if (!equal((await captureExecutionTree(stage)).files, candidateTree.files)) fail('staged candidate changed during validation');
    if (owner && digest((await readOwnedFile(path.join(stage, 'approved-preparation.json'))).bytes) !== previous.approvedSnapshotSha256) fail('operational update changed protected review snapshot');
    if (owner && (authority.normativeSha256 !== previous.normativeSha256 || authority.preparationRevision !== previous.preparationRevision)) fail('operational update changed preparation authority');
    await assertExecutionPublicationLock(lease);
    let moved = false; let installed = false;
    try {
      if (checkpoint) await checkpoint('before-backup', { stage, backup, marker });
      if (recheckRetention) await recheckRetention();
      if (!equal(await captureExecutionTree(workspace.executionRoot),before)) fail('publication base changed immediately before swap');
      await assertExecutionPublicationLock(lease);
      if (before) { await fs.rename(workspace.executionRoot, backup); moved = true; }
      if (checkpoint) await checkpoint('after-backup', { stage, backup, marker });
      if (await stat(workspace.executionRoot)) fail('official target unexpectedly occupied');
      if (currentInitial) {
        // The reviewed source is outside the publication lock. Recheck it after
        // every pre-swap checkpoint, while this lock still protects the target.
        await authorizeDiff(stage, before);
        if (!equal(await captureExecutionTree(workspace.executionRoot), before)) fail('publication base changed immediately before Initial swap');
        await assertExecutionPublicationLock(lease);
      }
      await fs.rename(stage, workspace.executionRoot); installed = true;
      if (checkpoint) await checkpoint('after-install', { stage, backup, marker });
      if (!equal((await captureExecutionTree(workspace.executionRoot)).files, candidateTree.files)) fail('installed bytes changed');
      let activation = null;
      if (!draft) {
        const snapshotBytes = (await readOwnedFile(path.join(workspace.executionRoot, 'approved-preparation.json'))).bytes;
        activation = { format: currentInitial ? 'stnl-execution-activation-v2' : 'stnl-execution-activation-v1', activationId: randomUUID(), sequence: (previous?.sequence ?? 0) + 1,
          previousActivationId: previous?.activationId ?? null, preparationRevision: authority.preparationRevision,
          requirementsAuthority: authority.requirementsAuthority, normativeSha256: authority.normativeSha256,
          approvedSnapshotSha256: digest(snapshotBytes), artifacts: currentInitial
            ? (await officialManifest(workspace.executionRoot)).sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0)
            : await officialManifest(workspace.executionRoot),
          activeAttempt: previous?.activeAttempt ?? null,
          lastAttempt: previous?.lastAttempt ?? null };
        if (checkpoint) await checkpoint('before-activation', { stage, backup, marker });
        // Any error after entering this call may have installed the marker. Never compensate blindly.
        allocation.expectedInstalledActivation=activation;
        await persistAllocation(marker,allocation);
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
          allocation.expectedInstalledActivation=activation;
          await persistAllocation(marker,allocation);
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
      allocation.confirmation = { activationId: activation?.activationId ?? null,
        artifactManifestSha256: digest(JSON.stringify(activation?.artifacts ?? await officialManifest(workspace.executionRoot))),
        terminalOperationAttemptId: terminal ? owner.operationAttemptId : null };
      allocation.cleanup = { status: 'complete', paths: [], diagnostics: [] };
      try {if(checkpoint) await checkpoint('before-confirmation-persistence',{stage,backup,marker});await persistAllocation(marker, allocation);} catch(error) {
        return {publication:'confirmed',cleanup:'pending',cleanupDiagnostics:[`confirmation persistence pending: ${error.message}`],allocation:marker,
          retainedBackup:moved ? backup : null,activation,expectedActivationId:activation?.activationId ?? null};
      }
      if (checkpoint) {
        try { await checkpoint('cleanup', { stage, backup, marker }); } catch (error) {
          allocation.cleanup = { status: 'pending', paths: [stage], diagnostics: [error.message] };
          try {await persistAllocation(marker, allocation);} catch(persistenceError) {allocation.cleanup.diagnostics.push(`cleanup persistence pending: ${persistenceError.message}`);}
          return { publication: 'confirmed', cleanup: 'pending', cleanupDiagnostics: [error.message], retainedBackup: moved ? backup : null, allocation: marker, activation, expectedActivationId: activation?.activationId ?? null };
        }
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
  if (result.publication === 'confirmed' && result.cleanup === 'pending') {
    allocation.cleanup = { status: 'pending', paths: result.retainedLock ? [result.retainedLock] : allocation.cleanup.paths,
      diagnostics: result.cleanupDiagnostics ?? [] };
    try {await persistAllocation(marker, allocation);} catch(error) {result.cleanupDiagnostics=[...(result.cleanupDiagnostics ?? []),`cleanup acknowledgment pending: ${error.message}`];}
  }
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

function closed(object, fields, label) {
  if (!object || Array.isArray(object) || Object.keys(object).sort().join('\0') !== [...fields].sort().join('\0')) fail(`${label} has unknown or missing fields`);
}
export const retentionSha256 = retention => digest(JSON.stringify(retention));
export async function persistAllocation(marker, allocation) {
  const previous = await readOwnedFile(marker);
  const temporary = `${marker}.${randomUUID()}.tmp`;
  await writeNew(temporary, Buffer.from(JSON.stringify(allocation, null, 2) + '\n'));
  const current = await readOwnedFile(marker);
  if (!current.bytes.equals(previous.bytes) || !equal(current.identity, previous.identity)) fail('allocation changed before update');
  await fs.rename(temporary, marker);
}

// Direct producer references only. No discovery by names, age or directory scans.
export async function readRetainedAllocation(marker, executionRoot, expected = null) {
  const record = parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
  const retention = record.retention;
  closed(retention, ['allocationId', 'executionRoot', 'producer', 'owner', 'retainedPaths'], 'retention');
  if (record.allocationId !== retention.allocationId || record.executionRoot !== executionRoot || retention.executionRoot !== executionRoot
    || !/^[a-f0-9-]{36}$/u.test(retention.allocationId) || typeof retention.producer !== 'string'
    || !Array.isArray(retention.retainedPaths) || !path.isAbsolute(record.retentionRoot)
    || inside(record.retentionRoot, executionRoot) || inside(executionRoot, record.retentionRoot)) fail('retention identity/containment differs');
  if (expected && (expected.allocationId !== retention.allocationId || expected.sha256 !== retentionSha256(retention))) fail('sealed retention descriptor differs');
  let previous = '';
  for (const entry of retention.retainedPaths) {
    closed(entry, ['path', 'sha256'], 'retained path');
    if (!path.isAbsolute(entry.path) || !inside(entry.path, record.retentionRoot) || entry.path.localeCompare(previous, 'en') <= 0
      || digest((await readOwnedFile(entry.path)).bytes) !== entry.sha256) fail('retained bytes/order differ');
    previous = entry.path;
  }
  return record;
}

export async function registerOwnedAllocation(workCapture, marker) {
  const file = `${workCapture.path}.owner.json`;
  const record = parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
  const allocation = parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
  if (record.executionRoot !== allocation.executionRoot || !allocation.owner
    || ['operationAttemptId','ownershipToken','deliveryId','slice','operation','originActivationId'].some(k => record.retention.owner?.[k] !== allocation.owner[k])) fail('allocation registration belongs to another owner');
  const known = record.knownAllocations ?? [];
  if (!known.includes(marker)) await persistAllocation(file, { ...record, knownAllocations: [...known, marker] });
}

export async function registerRunnerAllocation({workspace,owner,root,producer}) {
  await ancestry(root);
  let marker=`${root}.publication.json`;
  if(await stat(marker)) {
    const existing=parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
    if(existing.format!=='stnl-runner-allocation-v1' || existing.executionRoot!==workspace.executionRoot || existing.candidate!==root || existing.retentionRoot!==root || existing.producer!==producer) fail('runner allocation root has foreign ownership');
    if(existing.owner.operationAttemptId===owner.operationAttemptId && existing.owner.ownershipToken===owner.ownershipToken) return marker;
    // Managed tmpdir is reused across legal operations; keep the original root
    // marker and register each owner explicitly, without overwriting old receipts.
    marker=`${root}.publication-${owner.operationAttemptId}.json`;
  }
  const allocation={format:'stnl-runner-allocation-v1',allocationId:randomUUID(),executionRoot:workspace.executionRoot,
    candidate:root,retentionRoot:root,owner,producer,controlFiles:[]};
  await writeNew(marker,Buffer.from(JSON.stringify(allocation)+'\n'));
  await registerOwnedAllocation(owner.workCapture,marker);
  return marker;
}

// A nearby filename/format/UUID is not a producer binding. These are the exact
// envelopes emitted by the existing producers, including a pending publisher.
const hasPhysicalIdentity=value=>value && Object.keys(value).sort().join(',')==='dev,ino'
  && ['dev','ino'].every(key=>typeof value[key]==='string' && /^[0-9]+$/u.test(value[key]));
function hasCapturedSource(source) {
  if(source===null) return true;
  if(!source || Object.keys(source).sort().join(',')!=='files,identity' || !hasPhysicalIdentity(source.identity) || !Array.isArray(source.files)) return false;
  const seen=new Set();
  return source.files.every(entry=>{
    if(!entry || typeof entry.path!=='string' || !entry.path || path.isAbsolute(entry.path)
      || entry.path.split('/').some(part=>!part || ['.','..'].includes(part)) || seen.has(entry.path)) return false;
    seen.add(entry.path);
    if(entry.type==='directory') return Object.keys(entry).sort().join(',')==='path,type';
    return entry.type==='file' && Object.keys(entry).sort().join(',')==='mode,path,sha256,type'
      && /^sha256:[a-f0-9]{64}$/u.test(entry.sha256 ?? '') && Number.isSafeInteger(entry.mode) && entry.mode>=0 && entry.mode<=0o777;
  });
}
async function assertPreparationAllocationRoot(record) {
  await ancestry(record.candidate);
  const metadata=await stat(record.candidate);
  if(!metadata?.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(record.candidate)!==record.candidate
    || !equal(identity(metadata),record.candidateIdentity)) fail('preparation physical allocation identity differs');
}

// Immutable creation associations, separate from freely edited candidate bytes.
// The path comes only from the independently resolved official workspace/U1 lock.
export async function preparationRegistryPath(workspace) {
  const location = await executionLockIdentity(workspace);
  return location.lockPath.replace(/\.lock$/u, '.preparations.json');
}
const preparationBinding = record => Object.fromEntries(['allocationId', 'executionRoot', 'specPath', 'candidate',
  'candidateIdentity', 'operation', 'source', 'expectedActivationId', 'preparationRevision'].map(key => [key, record[key]]));
function validatePreparationRegistry(record, workspace) {
  closed(record, ['format', 'executionRoot', 'allocations'], 'preparation registry');
  if (record.format !== 'stnl-preparation-registry-v1' || record.executionRoot !== workspace.executionRoot
    || !Array.isArray(record.allocations)) fail('preparation registry execution differs');
  const ids = new Set(), roots = new Set();
  for (const binding of record.allocations) {
    closed(binding, ['allocationId', 'executionRoot', 'specPath', 'candidate', 'candidateIdentity', 'operation',
      'source', 'expectedActivationId', 'preparationRevision'], 'preparation association');
    const envelope = { ...binding, format: 'stnl-preparation-allocation-v1', producer: 'preparation', retentionRoot: binding.candidate };
    if (binding.executionRoot !== workspace.executionRoot || !hasOwnedAllocationEnvelope(envelope, `${binding.candidate}.owner.json`)
      || ids.has(binding.allocationId) || roots.has(binding.candidate)) fail('invalid/duplicate preparation association');
    ids.add(binding.allocationId); roots.add(binding.candidate);
  }
  return record;
}
export async function assertRegisteredPreparationAllocation(workspace, record) {
  if (record.executionRoot !== workspace.executionRoot) fail('preparation belongs to another official execution');
  const file = await preparationRegistryPath(workspace);
  let captured;
  try { captured = await readOwnedFile(file); } catch (error) { fail(`preparation registry unavailable: ${error.message}`); }
  const registry = validatePreparationRegistry(parseStrictJson(captured.bytes.toString('utf8')), workspace);
  const binding = registry.allocations.find(entry => entry.allocationId === record.allocationId);
  if (!binding || !equal(binding, preparationBinding(record))) fail('preparation allocation producer association absent or differs');
  await assertPreparationAllocationRoot(record);
  const after = await readOwnedFile(file);
  if (!captured.bytes.equals(after.bytes) || !equal(captured.identity, after.identity)) fail('preparation registry changed during verification');
  return binding;
}
// Creates its own destination. There is no API to adopt/register an existing root.
export async function allocatePreparationCandidate({ workspace, lease, captureParent, metadata }) {
  await assertExecutionPublicationLock(lease);
  if (lease.executionRoot !== workspace.executionRoot) fail('preparation lease differs');
  const source = await captureExecutionTree(workspace.executionRoot);
  const root = await fs.realpath(await fs.mkdtemp(path.join(captureParent, 'stnl-preparation-')));
  if (source) await fs.cp(workspace.executionRoot, root, { recursive: true });
  const tree = await captureExecutionTree(root);
  if (source && !equal(tree.files, source.files)) fail('preparation source changed during copy');
  const record = { ...metadata, format: 'stnl-preparation-allocation-v1', producer: 'preparation', allocationId: randomUUID(),
    candidate: root, retentionRoot: root, candidateIdentity: tree.identity, executionRoot: workspace.executionRoot, source };
  if (!hasOwnedAllocationEnvelope(record, `${root}.owner.json`)) fail('invalid preparation producer metadata');
  await writeNew(`${root}.owner.json`, Buffer.from(JSON.stringify(record) + '\n'));
  const file = await preparationRegistryPath(workspace);
  const existing = await stat(file);
  const registry = existing ? validatePreparationRegistry(parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8')), workspace)
    : { format: 'stnl-preparation-registry-v1', executionRoot: workspace.executionRoot, allocations: [] };
  registry.allocations.push(preparationBinding(record));
  validatePreparationRegistry(registry, workspace);
  await assertExecutionPublicationLock(lease);
  if (!equal(source, await captureExecutionTree(workspace.executionRoot))) fail('preparation source/CAS changed before registration');
  if (existing) await persistAllocation(file, registry);
  else await writeNew(file, Buffer.from(JSON.stringify(registry, null, 2) + '\n'));
  const directory = await fs.open(path.dirname(file), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  await assertExecutionPublicationLock(lease);
  await assertRegisteredPreparationAllocation(workspace, record);
  for (const name of ['activation.json', 'approved-preparation.json']) await fs.rm(path.join(root, name), { force: true });
  return root;
}
export function hasOwnedAllocationEnvelope(record, marker) {
  const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
  if(!record || !uuid(record.allocationId) || !path.isAbsolute(record.executionRoot ?? '') || !path.isAbsolute(record.retentionRoot ?? '')) return false;
  const owner=record.owner;
  const owned=owner && ['operationAttemptId','ownershipToken','deliveryId','originActivationId'].every(k=>uuid(owner[k]))
    && /^slice-[0-9]{2,}$/u.test(owner.slice) && ['EXECUTE_SLICE','APPLY_FINDINGS','VALIDATE_SLICE'].includes(owner.operation)
    && Number.isSafeInteger(owner.preparationRevision) && /^sha256:[a-f0-9]{64}$/u.test(owner.normativeSha256 ?? '')
    && path.isAbsolute(owner.workCapture?.path ?? '') && /^sha256:[a-f0-9]{64}$/u.test(owner.workCapture?.sha256 ?? '');
  if(record.format==='stnl-execution-publication-owner-v1') {
    const parent=path.dirname(record.retentionRoot);
    const capsule=record.retentionRoot===path.join(parent,`.stnl-execution-backup-${record.allocationId}`);
    if(!capsule) return false;
    const publisher=marker===path.join(parent,`.stnl-execution-publication-${record.allocationId}.json`);
    const admission=owned && marker===`${owner.workCapture.path}.owner.json` && inside(owner.workCapture.path,record.retentionRoot);
    if(!publisher && !admission) return false;
    const publicationOrigin=publisher && Object.hasOwn(record,'expectedActivationId') && Object.hasOwn(record,'expectedTree')
      && path.isAbsolute(record.candidate ?? '') && record.stage===path.join(parent,`.stnl-execution-stage-${record.allocationId}`)
      && record.backup===path.join(record.retentionRoot,'previous');
    if(record.retention) return ['preparation-publication','operational-publication','operation-admission','pass-reopening'].includes(record.retention.producer)
      && Object.hasOwn(record,'owner') && equal(record.retention.owner,owner)
      && (record.retention.producer==='operation-admission' ? !!owner : publicationOrigin);
    const firstInitial = record.owner===null && record.expectedActivationId===null && record.expectedTree===null;
    return publicationOrigin && ((owned && uuid(record.expectedActivationId) && record.expectedTree?.files) || firstInitial);
  }
  if(record.retentionRoot!==record.candidate) return false;
  if(record.format==='stnl-preparation-allocation-v1') return record.producer==='preparation' && marker===`${record.candidate}.owner.json`
    && ['PLAN','REPLAN','REVIEW_PLAN'].includes(record.operation) && path.isAbsolute(record.specPath ?? '')
    && hasPhysicalIdentity(record.candidateIdentity) && hasCapturedSource(record.source)
    && Number.isSafeInteger(record.preparationRevision) && record.preparationRevision>0
    && (record.expectedActivationId===null || uuid(record.expectedActivationId))
    && (record.source?.files.some(entry=>entry.path==='activation.json') ?? false)===(record.expectedActivationId!==null);
  if(!owned) return false;
  if(record.format==='stnl-runner-allocation-v1') return ['native-runner','managed-runner'].includes(record.producer)
    && [ `${record.candidate}.publication.json`,`${record.candidate}.publication-${owner.operationAttemptId}.json` ].includes(marker)
    && Array.isArray(record.controlFiles);
  return ['execution-copy','validation-copy'].includes(record.producer) && record.slice===owner.slice && uuid(record.expectedActivationId)
    && path.isAbsolute(record.specPath ?? '') && record.tree?.files
    && marker===`${record.candidate}.${record.producer==='execution-copy'?'copy':'publication'}.json`;
}

export async function classifyOwnedAllocation({ workspace, marker=null, activation, readActivated=null }) {
  if(marker===null) {
    if(typeof readActivated!=='function') fail('official classification requires verified image readback');
    const current=await readActivated();return {classification:'official',executionRoot:workspace.executionRoot,activationId:current.activation.activationId};
  }
  const record = parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
  if(!hasOwnedAllocationEnvelope(record,marker)) fail('unproven allocation: producer envelope is absent or inconsistent');
  if(record.format==='stnl-preparation-allocation-v1') await assertRegisteredPreparationAllocation(workspace,record);
  if (record.executionRoot !== workspace.executionRoot) fail('allocation belongs to another execution');
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(record.allocationId) || !path.isAbsolute(record.retentionRoot)
    || !['stnl-execution-publication-owner-v1','stnl-runner-allocation-v1','stnl-preparation-allocation-v1'].includes(record.format)
      && !['execution-copy','validation-copy'].includes(record.producer)) fail('allocation identity/producer is not positively established');
  await ancestry(record.retentionRoot);
  if (record.retention) {
    await readRetainedAllocation(marker, workspace.executionRoot);
    if(!['preparation-publication','operational-publication','operation-admission','pass-reopening'].includes(record.retention.producer)
      || !equal(record.retention.owner,record.owner)) fail('retention producer/owner differs');
  }
  if(record.format==='stnl-runner-allocation-v1' && !['native-runner','managed-runner'].includes(record.producer)) fail('unknown runner allocation producer');
  if(['execution-copy','validation-copy','native-runner','managed-runner'].includes(record.producer)
    && (!record.owner || !record.owner.workCapture || !record.owner.ownershipToken || !record.owner.operationAttemptId)) fail('allocation owner is absent');
  if(['execution-copy','validation-copy','native-runner','managed-runner'].includes(record.producer)) {
    const admission=await readRetainedAllocation(`${record.owner.workCapture.path}.owner.json`,workspace.executionRoot);
    if(!(admission.knownAllocations ?? []).includes(marker)
      || ['operationAttemptId','ownershipToken','deliveryId','slice','operation','originActivationId'].some(k=>admission.retention.owner?.[k]!==record.owner[k])) fail('allocation producer registration is absent or belongs to another owner');
  }
  for(const root of [record.candidate,record.stage,record.backup,record.retentionRoot].filter(Boolean)) {await ancestry(root);if(inside(root,workspace.executionRoot)||inside(workspace.executionRoot,root)) fail('allocation overlaps official execution');}
  const active = activation?.activeAttempt;
  if (active && record.owner && ['operationAttemptId','ownershipToken','deliveryId','slice','operation','originActivationId'].every(k=>record.owner[k]===active[k])) return { classification: 'active', record };
  if(record.producer==='preparation' && !active && !record.confirmation
    && record.expectedActivationId===(activation?.activationId ?? null)
    && equal(record.source,await captureExecutionTree(workspace.executionRoot))) return {classification:'active',record};
  if (!record.confirmation) return { classification: 'diagnostic', record };
  if (record.confirmation.activationId !== activation?.activationId) return { classification: 'diagnostic', record };
  if(['execution-copy','validation-copy'].includes(record.producer) && record.confirmation) {
    if(!record.confirmedCandidateTree || !record.publicationAllocation) return {classification:'diagnostic',record};
    const image=await captureExecutionTree(record.candidate);
    if(image!==null && !equal(image,record.confirmedCandidateTree)) return {classification:'diagnostic',record};
    const published=await readRetainedAllocation(record.publicationAllocation,workspace.executionRoot);
    if(!equal(published.expectedInstalledActivation,activation)) return {classification:'diagnostic',record};
  }
  const soleCopy = (record.retention?.retainedPaths.length ?? 0) > 0 || (record.backup && await stat(record.backup));
  return { classification: soleCopy ? 'diagnostic' : 'disposable', record };
}

// Only the two trusted candidate publishers call this after their common image
// readback. A candidate remains retained until explicit own-only cleanup.
export async function acknowledgePublishedCandidate({workspace,marker,candidateTree,publication,readActivated}) {
  if(publication.publication!=='confirmed' || publication.activation?.activeAttempt) return;
  return withExecutionPublicationLock(workspace,async()=>{
    const current=await readActivated();
    if(!equal(current.activation,publication.activation)) fail('candidate acknowledgment image advanced');
    const record=parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
    if(!['execution-copy','validation-copy'].includes(record.producer) || record.executionRoot!==workspace.executionRoot
      || !equal(await captureExecutionTree(record.candidate),candidateTree)
      || ['operationAttemptId','ownershipToken','deliveryId','slice','operation','originActivationId'].some(k=>record.owner?.[k]!==current.activation.lastAttempt?.[k])) fail('candidate acknowledgment ownership/content differs');
    const prefix=record.producer==='execution-copy' && workspace.specRoot ? 'execution/' : '';
    if(candidateTree.files.some(e=>e.type==='directory' ? ![prefix.slice(0,-1),prefix+'plans',prefix+'tasks'].includes(e.path)
      : !/^(?:plan|tasks)\.md$|^(?:approved-preparation|continuity|activation)\.json$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(e.path.slice(prefix.length)))) fail('candidate contains material outside its producer artifacts');
    const publicationRecord=await readRetainedAllocation(publication.allocation,workspace.executionRoot);
    if(!equal(publicationRecord.expectedInstalledActivation,current.activation) || !publicationRecord.confirmation) fail('candidate lacks confirmed producer image');
    record.publicationAllocation=publication.allocation;
    record.confirmedCandidateTree=candidateTree;
    record.confirmation=publicationRecord.confirmation;
    record.cleanup={status:'pending',paths:[record.candidate],diagnostics:['Redundant confirmed candidate retained for explicit inspection/cleanup']};
    await persistAllocation(marker,record);
  });
}

export async function cleanupOwnedExecutionAllocation({ workspace, marker, readActivated, checkpoint = null,
  validateInstalledActivation = validateActivation }) {
  async function acknowledge(record, result) {
    try {
      if(checkpoint) await checkpoint('before-cleanup-acknowledgment', {marker});
      await persistAllocation(marker, record);
      return result;
    } catch(error) {
      return {...result,publication:'confirmed',cleanup:'pending',cleanupDiagnostics:[`cleanup acknowledgment pending: ${error.message}`]};
    }
  }
  return withExecutionPublicationLock(workspace, async lease => {
    const current = await readActivated();
    const original=(await readOwnedFile(marker)).bytes;
    const { classification, record } = await classifyOwnedAllocation({ workspace, marker, activation: current.activation });
    if(!record.confirmation && record.expectedInstalledActivation) {
      validateInstalledActivation(record.expectedInstalledActivation);
      if(!equal(record.expectedInstalledActivation,current.activation) || current.activation.activeAttempt) fail('unacknowledged image differs or still has an owner');
      record.confirmation={activationId:current.activation.activationId,artifactManifestSha256:digest(JSON.stringify(current.activation.artifacts)),terminalOperationAttemptId:record.owner?.operationAttemptId ?? null};
      record.cleanup={status:'pending',paths:[record.stage],diagnostics:['Recovered confirmation from exact verified installed image']};
    }
    if (current.activation.activeAttempt || !record.confirmation || record.confirmation.activationId !== current.activation.activationId
      || record.confirmation.artifactManifestSha256 !== digest(JSON.stringify(current.activation.artifacts))) fail('cleanup needs matching confirmed, inactive image');
    closed(record.cleanup, ['status', 'paths', 'diagnostics'], 'cleanup');
    if (!['complete', 'pending'].includes(record.cleanup.status) || !Array.isArray(record.cleanup.paths) || !Array.isArray(record.cleanup.diagnostics)) fail('malformed cleanup');
    if(['execution-copy','validation-copy'].includes(record.producer)) {
      if(classification!=='disposable' || !record.publicationAllocation || !record.confirmedCandidateTree
        || record.cleanup.paths.some(p=>p!==record.candidate)) fail('candidate is not demonstrably disposable');
      const published=await readRetainedAllocation(record.publicationAllocation,workspace.executionRoot);
      if(!equal(published.expectedInstalledActivation,current.activation) || !equal(published.confirmation,record.confirmation)) fail('candidate publication binding differs');
      // Explicit refs are the only retention authority; never discover by names.
      const index=parseStrictJson((await readOwnedFile(path.join(workspace.executionRoot,'continuity.json'))).bytes.toString('utf8'));
      const references=index.deliveries.flatMap(d=>[...(d.baseline ? [d.baseline.allocationRef.path,d.baseline.manifestRef.path]:[]),...d.history.flatMap(h=>[h.allocationRef.path,h.taskRef.path,h.snapshotRef.path])]);
      if(references.some(p=>inside(path.resolve(workspace.executionRoot,p),record.candidate))
        || [current.activation.lastAttempt?.workCapture?.path,current.activation.lastAttempt?.runner?.receiptFile].filter(Boolean).some(p=>inside(p,record.candidate))) fail('candidate still holds required retained material');
      const observed=await captureExecutionTree(record.candidate);
      if(observed!==null && !equal(observed,record.confirmedCandidateTree)) fail('candidate changed; retain foreign/unknown material');
      await assertExecutionPublicationLock(lease);
      if(!equal((await readActivated()).activation,current.activation) || !(await readOwnedFile(marker)).bytes.equals(original)
        || !equal(await captureExecutionTree(record.candidate),observed)) fail('candidate cleanup recheck changed');
      try {if(observed) await fs.rm(record.candidate,{recursive:true});}
      catch(error) {record.cleanup.diagnostics=[error.message];return acknowledge(record,{publication:'confirmed',cleanup:'pending',cleanupDiagnostics:[error.message],allocation:marker,expectedActivationId:current.activation.activationId});}
      record.cleanup={status:'complete',paths:[],diagnostics:[]};
      return acknowledge(record,{publication:'confirmed',cleanup:'complete',classification,allocation:marker,expectedActivationId:current.activation.activationId});
    }
    // Retained backup/history/code is never removed. The retired stage is the only
    // provably redundant publication root; candidate cleanup requires its own producer.
    if (record.cleanup.paths.some(file => file !== record.stage)) fail('cleanup path is foreign or still needed');
    if(typeof record.stage!=='string' || !path.isAbsolute(record.stage)) fail('cleanup needs the publication producer stage');
    const tree = await captureExecutionTree(record.stage);
    if (tree !== null) fail('nonempty/unconfirmed stage retained for diagnosis');
    await assertExecutionPublicationLock(lease);
    const recheck = await readActivated();
    if (!equal(recheck.activation, current.activation)) fail('cleanup activation changed');
    const before = (await readOwnedFile(marker)).bytes;
    if (!before.equals(original)) fail('cleanup allocation changed');
    record.cleanup = { status: 'complete', paths: [], diagnostics: [] };
    return acknowledge(record,{ publication: 'confirmed', cleanup: 'complete', classification, allocation: marker,
      expectedActivationId: current.activation.activationId });
  });
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
