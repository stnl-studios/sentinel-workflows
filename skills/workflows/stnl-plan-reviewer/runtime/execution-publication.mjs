// Neutral, distributable publication boundary. No execution-state or lifecycle journal imports.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {unicodeCaseFold} from './unicode-casefold.mjs';
import {validateCurrentActivation,currentOperationBindingSha256,validateCurrentAbortDisposition} from './execution-current.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = message => { throw Object.assign(new Error(`execution publication: ${message}`), { code: 'EXECUTION_PUBLICATION_BLOCKED' }); };
const inside = (child, parent) => { const relative = path.relative(parent, child); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
async function stat(file) { return fs.lstat(file).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }); }
const identity = metadata => ({ dev: String(metadata.dev), ino: String(metadata.ino) });
const TERMINAL_SETTLED=Symbol('terminal retirement settled by its owner');

async function ancestry(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const segment of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); const metadata = await stat(current);
    if (!metadata) break;
    if (metadata.isSymbolicLink() && !(process.platform === 'darwin' && ['/var', '/tmp', '/etc'].includes(current))) fail(`symlink ancestry: ${current}`);
  }
}

async function readFileWithLinks(file, links, maxBytes=Infinity) {
  await ancestry(file);
  const observed = await fs.lstat(file);
  if (!observed.isFile() || !links.includes(observed.nlink) || observed.size > maxBytes) fail(`file must be a bounded regular owned file: ${file}`);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || !links.includes(before.nlink) || !equal(identity(observed),identity(before))) fail(`file must be regular and single-link: ${file}`);
    if(before.size>maxBytes)fail('bounded owned file exceeds its byte limit');
    let bytes;
    if(Number.isFinite(maxBytes)){
      const buffer=Buffer.alloc(maxBytes+1);let offset=0;
      while(offset<buffer.length){const result=await handle.read(buffer,offset,buffer.length-offset,null);if(!result.bytesRead)break;offset+=result.bytesRead;}
      bytes=buffer.subarray(0,offset);
    }else bytes=await handle.readFile();
    if(bytes.length>maxBytes)fail('bounded owned file exceeds its byte limit');const after = await handle.stat(); const pathname = await fs.lstat(file);
    if (!equal(identity(before), identity(after)) || !equal(identity(after), identity(pathname))
      || !links.includes(pathname.nlink) || before.nlink !== after.nlink
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`file changed during read: ${file}`);
    return { file, bytes, identity: identity(after), mode: after.mode & 0o777, links: after.nlink };
  } finally { await handle.close(); }
}
export async function readOwnedFile(file) { return readFileWithLinks(file, [1]); }
// The same physical owner binding is consumed by the operational controller
// and lifecycle's read-only retirement inventory. This proves identity only;
// terminality and dispensability remain the consuming producer's obligation.
export function validateCurrentOperationAllocationBinding(record,expected) {
  const binding=record?.binding;
  if(record?.format!=='stnl-execution-publication-owner-v2'
    ||binding?.operationId!==expected.operationId||binding?.specKey!==expected.specKey
    ||binding?.logicalExecutionRoot!==expected.logicalExecutionRoot||binding?.logicalSpecRoot!==expected.logicalSpecRoot
    ||binding?.owner?.ownershipToken!==expected.ownershipToken
    ||!equal(binding.namespaceIdentity,expected.namespaceIdentity)||binding.filesystemDevice!==expected.filesystemDevice
    ||!equal(binding.filesystemContext,expected.filesystemContext)||!equal(binding.filesystemBinding,expected.filesystemBinding)
    ||binding.candidatePath!=='candidate'||binding.previousPath!=='previous')fail('operation binding or physical namespace differs');
  return binding;
}
export function validateCurrentOperationRetirementRecord(record){
  closed(record,['format','binding','phase','candidate','previous','expectedInstalledActivation','preparation','runner','normalization','commonLease','confirmation','cleanup',
    ...(Object.hasOwn(record,'responseVariant')?['responseVariant']:[]),
    ...(Object.hasOwn(record,'preVerificationContinuation')?['preVerificationContinuation']:[]),'terminalTransition'],'terminal operation owner');
  const binding=record.binding,owner=binding?.owner;
  if(record.phase==='aborted') {
    if(record.preVerificationContinuation)fail('aborted operation cannot discard a continuation');
    // No verification capture exists in this bounded disposition. Its sources
    // must instead be replicated in the verified successor's native admission.
    closed(record.preparation,['abortSourceActivation'],'aborted operation preparation');
    closed(record.terminalTransition,['operationAttemptId','outcome'],'aborted operation transition');
    closed(record.runner,['dispatchId','agentId','status','round','consumedInvocations','originFile','requestFile','responseFile'],'aborted operation runner');
    closed(record.confirmation,['activationId','artifactManifestSha256'],'aborted operation confirmation');
    closed(record.cleanup,['status','ownedPaths','diagnostics'],'aborted operation cleanup');
    validateCurrentActivation(record.expectedInstalledActivation);
    validateLifecycleCommonLeaseBinding(record.commonLease);
    const last=record.expectedInstalledActivation.lastAttempt,parsed=validateCurrentAbortDisposition(last);
    if(parsed.request.format!=='stnl-current-validation-request-v1'
      ||record.format!=='stnl-execution-publication-owner-v2'||record.candidate!==null||record.previous!==null
      ||record.normalization!==null||record.responseVariant!=='stnl-current-native-judgment-v1'
      ||record.commonLease.executionRoot!==binding.logicalExecutionRoot
      ||!isDeepStrictEqual(record.commonLease.parentIdentity,binding.filesystemBinding.leaseParentIdentity)
      ||record.commonLease.sha256!==digest(Buffer.from(JSON.stringify({format:'stnl-execution-lock-v1',
        token:record.commonLease.token,executionRoot:record.commonLease.executionRoot,pid:record.commonLease.pid})+'\n'))
      ||record.terminalTransition.outcome!=='aborted'||record.terminalTransition.operationAttemptId!==owner?.operationAttemptId
      ||!isDeepStrictEqual(parsed.origin.admission.binding,binding)
      ||!isDeepStrictEqual(parsed.origin.admission.reservedActivation,record.preparation.abortSourceActivation)
      ||record.runner.status!=='aborted'||record.runner.round!==1||record.runner.consumedInvocations!==1
      ||record.runner.dispatchId!==parsed.origin.dispatchId||record.runner.agentId!==parsed.toolResult.agentId
      ||record.runner.originFile!==parsed.agent.originFile
      ||record.runner.requestFile!==path.join(path.dirname(record.runner.originFile),'round-1.request.json')
      ||record.runner.responseFile!==path.join(path.dirname(record.runner.originFile),'round-1.response.json')
      ||record.expectedInstalledActivation.activeAttempt!==null||last.operationAttemptId!==owner.operationAttemptId
      ||record.confirmation.activationId!==record.expectedInstalledActivation.activationId
      ||record.confirmation.artifactManifestSha256!==digest(JSON.stringify(record.expectedInstalledActivation.artifacts))
      ||record.cleanup.status!=='complete'||!Array.isArray(record.cleanup.ownedPaths)||record.cleanup.ownedPaths.length
      ||!Array.isArray(record.cleanup.diagnostics)||record.cleanup.diagnostics.length)
      fail('aborted Initial operation is not confirmed and bound');
    return record;
  }
  for(const key of ['candidate','previous']){
    closed(record[key],['identity','tree'],'terminal operation '+key);
    if(!hasCapturedSource({identity:record[key].identity,files:record[key].tree}))fail('terminal operation has invalid tree metadata');
  }
  closed(record.preparation,['candidateComposition','intermediateActivation'],'terminal operation preparation');
  closed(record.preparation.candidateComposition,['identity','baseTree'],'terminal candidate composition');
  if(!hasCapturedSource({identity:record.preparation.candidateComposition.identity,files:record.preparation.candidateComposition.baseTree}))fail('terminal candidate composition differs');
  validateCurrentActivation(record.expectedInstalledActivation);validateCurrentActivation(record.preparation.intermediateActivation);
  validateLifecycleCommonLeaseBinding(record.commonLease);
  closed(record.confirmation,['activationId','artifactManifestSha256'],'terminal operation confirmation');
  closed(record.cleanup,['status','ownedPaths','diagnostics'],'terminal operation cleanup');
  closed(record.terminalTransition,['operationAttemptId','outcome','normalization'],'terminal operation transition');
  const rejected=record.terminalTransition.outcome==='rejected';
  const normalization=record.terminalTransition.normalization;
  if(rejected){
    closed(normalization,['episodeId','operation','causeSha256','sourceOperationAttemptId','used','consumedInvocations','round','status'],'terminal refusal normalization');
    if(normalization.episodeId!==owner?.operationAttemptId||normalization.sourceOperationAttemptId!==owner.operationAttemptId
      ||normalization.operation!==owner.operation||normalization.used!==1||normalization.round!==1
      ||normalization.status!=='settled'||!/^sha256:[a-f0-9]{64}$/u.test(normalization.causeSha256)
      ||normalization.consumedInvocations!==record.runner.consumedInvocations
      ||normalization.consumedInvocations>=(owner.operation==='VALIDATE_SLICE'?2:3))fail('terminal refusal is not bounded and settled');
  }
  closed(record.runner,['dispatchId','agentId','status','round','consumedInvocations','originFile','requestFile','responseFile','captureClass',...(rejected&&!Object.hasOwn(record.runner,'resultStatus')?[]:['resultStatus'])],'terminal operation runner');
  if(record.phase!=='committed'||record.normalization!==null||(!rejected&&(normalization!==null||record.terminalTransition.outcome!=='recorded'))
    ||record.terminalTransition.operationAttemptId!==owner?.operationAttemptId||record.cleanup.status!=='complete'
    ||!Array.isArray(record.cleanup.ownedPaths)||record.cleanup.ownedPaths.length||!Array.isArray(record.cleanup.diagnostics)||record.cleanup.diagnostics.length
    ||record.expectedInstalledActivation.activeAttempt!==null||record.confirmation.activationId!==record.expectedInstalledActivation.activationId
    ||record.confirmation.artifactManifestSha256!==digest(JSON.stringify(record.expectedInstalledActivation.artifacts))
    ||record.expectedInstalledActivation.lastAttempt?.operationAttemptId!==owner?.operationAttemptId
    ||record.expectedInstalledActivation.lastAttempt?.operationRef?.operationId!==binding.operationId
    ||record.expectedInstalledActivation.lastAttempt?.operationRef?.allocationSha256!==currentOperationBindingSha256(binding)
    ||record.runner.status!=='captured'||!Number.isSafeInteger(record.runner.round)||record.runner.round<1||record.runner.round>3
    ||record.runner.consumedInvocations!==record.runner.round)fail('operation is not a closed supported terminal record');
  if(Object.hasOwn(record,'responseVariant')&&record.responseVariant!=='stnl-current-native-judgment-v1')fail('unsupported terminal response variant');
  const same=isDeepStrictEqual,intermediate=record.preparation.intermediateActivation,terminal=record.expectedInstalledActivation;
  const operationRef={operationId:binding.operationId,allocationSha256:currentOperationBindingSha256(binding)};
  const stable=activation=>{const {activationId,sequence,previousActivationId,activeAttempt,lastAttempt,...rest}=activation;return rest;};
  if(!same(record.candidate.identity,record.preparation.candidateComposition.identity)||!same(record.previous.identity,binding.baseTree.identity)
    ||!same(record.previous.tree,record.preparation.candidateComposition.baseTree)
    ||terminal.previousActivationId!==intermediate.activationId||terminal.sequence!==intermediate.sequence+1||!same(stable(intermediate),stable(terminal))
    ||!same(intermediate.activeAttempt,{...owner,operationRef})
    ||!same(terminal.lastAttempt,{operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,slice:owner.slice,operation:owner.operation,
      terminalActivationId:terminal.activationId,outcome:rejected?'rejected':'recorded',operationRef})
    ||!same(terminal.artifacts,record.candidate.tree.filter(item=>item.type==='file'&&item.path!=='activation.json').map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)))fail('terminal operation transition or tree association differs');
  return record;
}
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

function filesystemFailure(code, message) {
  throw Object.assign(new Error(`execution filesystem: ${message}`), {code});
}

function absoluteFilesystemInput(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)
    || path.normalize(value) !== value || (value !== path.parse(value).root && value.endsWith(path.sep)))
    filesystemFailure('UNSAFE_PATH', `${label} must be a normalized absolute path`);
  return value;
}

// Resolve the logical tail without creating it. A temporarily absent official
// target must retain the same identity as its later real directory.
async function physicalFilesystemPath(value, label) {
  const requested = absoluteFilesystemInput(value, label);
  try { await ancestry(requested); }
  catch { filesystemFailure('UNSAFE_PATH', `${label} has unsafe ancestry`); }
  const tail = [];
  let anchor = requested;
  let metadata = await stat(anchor);
  while (metadata === null) {
    tail.unshift(path.basename(anchor));
    const parent = path.dirname(anchor);
    if (parent === anchor) filesystemFailure('UNSAFE_PATH', `${label} has no real ancestor`);
    anchor = parent;
    metadata = await stat(anchor);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    filesystemFailure('UNSAFE_PATH', `${label} ancestor must be a real directory`);
  const canonicalAnchor = await fs.realpath(anchor);
  const rechecked = await fs.lstat(anchor);
  if (!equal(identity(metadata), identity(rechecked)) || rechecked.isSymbolicLink())
    filesystemFailure('UNSAFE_PATH', `${label} ancestor changed`);
  return {path: path.join(canonicalAnchor, ...tail),
    anchor: {path: canonicalAnchor, identity: identity(rechecked)},
    identity: tail.length === 0 ? identity(rechecked) : null};
}

async function filesystemGitAncestor(start) {
  let current = start;
  for (;;) {
    const marker = await stat(path.join(current, '.git'));
    if (marker !== null) {
      if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())
        || (marker.isFile() && marker.nlink !== 1))
        filesystemFailure('UNSAFE_PATH', 'Git root marker is not a real directory or single-link file');
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Copy only the normal policy input. A resolved locator is an observation, not
// an exclusion attestation or a new authority that callers may inject here.
export function normalizeExecutionFilesystemPolicy(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.getOwnPropertyNames(value).sort().join('\0') !== ['excludedRoots','productRoot','temporaryRoot'].join('\0'))
    filesystemFailure('TEMP_ROOT_UNPROVEN', 'filesystemContext requires productRoot, temporaryRoot and excludedRoots');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.values(fields).some(field => !Object.hasOwn(field, 'value')))
    filesystemFailure('TEMP_ROOT_UNPROVEN', 'filesystemContext must contain data properties');
  const roots = fields.excludedRoots.value;
  if (!Array.isArray(roots) || Object.getPrototypeOf(roots) !== Array.prototype || roots.length > 32
    || Reflect.ownKeys(roots).length !== roots.length + 1)
    filesystemFailure('TEMP_ROOT_UNPROVEN', 'excludedRoots must be a bounded plain array');
  const excludedRoots = [];
  for (let index = 0; index < roots.length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(roots, index);
    if (!field || !Object.hasOwn(field, 'value'))
      filesystemFailure('TEMP_ROOT_UNPROVEN', 'excludedRoots must contain data properties');
    excludedRoots.push(absoluteFilesystemInput(field.value, 'excludedRoot'));
  }
  return {productRoot:absoluteFilesystemInput(fields.productRoot.value, 'productRoot'),
    temporaryRoot:absoluteFilesystemInput(fields.temporaryRoot.value, 'temporaryRoot'), excludedRoots};
}

// Read-only locator increment. This does not authorize allocation or verify Git
// ignore. Existing writers intentionally keep their current leases/paths until
// every producer and its exclusion check can be activated together.
export async function resolveExecutionFilesystemRoots({executionRoot, specRoot = null, filesystemContext:forwardedContext = null}, filesystemContext = null) {
  const forwarded = normalizeExecutionFilesystemPolicy(forwardedContext);
  const explicit = normalizeExecutionFilesystemPolicy(filesystemContext);
  if (forwarded !== null && explicit !== null && !equal(forwarded, explicit)) {
    const canonicalPolicy = async policy => {
      const productRoot = (await physicalFilesystemPath(policy.productRoot, 'productRoot')).path;
      const temporaryRoot = (await physicalFilesystemPath(policy.temporaryRoot, 'temporaryRoot')).path;
      const excludedRoots = [];
      for (const root of policy.excludedRoots) {
        const canonical = (await physicalFilesystemPath(root, 'excludedRoot')).path;
        if (excludedRoots.includes(canonical)) filesystemFailure('TEMP_ROOT_UNPROVEN', 'duplicate excluded root');
        excludedRoots.push(canonical);
      }
      return {productRoot, temporaryRoot, excludedRoots:excludedRoots.sort()};
    };
    if (!equal(await canonicalPolicy(forwarded), await canonicalPolicy(explicit)))
      filesystemFailure('TEMP_ROOT_UNPROVEN', 'forwarded and explicit filesystem policies differ');
  }
  filesystemContext = explicit ?? forwarded;
  const execution = await physicalFilesystemPath(executionRoot, 'executionRoot');
  const spec = specRoot === null ? null : await physicalFilesystemPath(specRoot, 'specRoot');
  if (spec !== null && execution.path !== path.join(spec.path, 'execution'))
    filesystemFailure('UNSAFE_PATH', 'executionRoot differs from the official SPEC execution');
  const official = spec ?? execution;
  const gitRoot = await filesystemGitAncestor(official.anchor.path);
  if (filesystemContext === null && gitRoot === null) {
    filesystemFailure('TEMP_ROOT_UNPROVEN', 'non-Git workspace requires an explicit excluded temporary root');
  }
  const product = await physicalFilesystemPath(filesystemContext?.productRoot ?? gitRoot, 'productRoot');
  if (product.identity === null || (gitRoot !== null && product.path !== gitRoot))
    filesystemFailure('TEMP_ROOT_UNPROVEN', 'productRoot is absent or differs from the trusted Git root');
  if (execution.path === product.path || !inside(execution.path, product.path)
    || (spec !== null && !inside(spec.path, product.path)))
    filesystemFailure('UNSAFE_PATH', 'official roots escape productRoot');
  const defaultTemporary = path.join(product.path, 'tmp', 'sentinel');
  const temporary = await physicalFilesystemPath(filesystemContext?.temporaryRoot ?? defaultTemporary, 'temporaryRoot');
  if (gitRoot !== null && temporary.path !== defaultTemporary)
    filesystemFailure('TEMP_ROOT_UNPROVEN', 'temporaryRoot differs from the normal Git workspace policy');
  if (inside(temporary.path, official.path) || inside(official.path, temporary.path))
    filesystemFailure('UNSAFE_PATH', 'temporaryRoot overlaps the official tree');
  if (temporary.anchor.identity.dev !== official.anchor.identity.dev
    || product.identity.dev !== official.anchor.identity.dev)
    filesystemFailure('CROSS_FILESYSTEM', 'operational and official roots are on different filesystems');
  const excluded = [];
  for (const root of filesystemContext?.excludedRoots ?? []) {
    const resolved = await physicalFilesystemPath(root, 'excludedRoot');
    if (excluded.includes(resolved.path)) filesystemFailure('TEMP_ROOT_UNPROVEN', 'duplicate excluded root');
    excluded.push(resolved.path);
  }
  if (gitRoot === null && !excluded.includes(temporary.path))
    filesystemFailure('TEMP_ROOT_UNPROVEN', 'temporaryRoot must be explicitly excluded exactly');
  excluded.sort();
  const key = createHash('sha256').update(execution.path, 'utf8').digest('hex');
  const officialParent = await physicalFilesystemPath(path.dirname(official.path), 'officialParent');
  const material = await physicalFilesystemPath(path.join(temporary.path, key), 'materialRoot');
  if (material.anchor.identity.dev !== official.anchor.identity.dev)
    filesystemFailure('CROSS_FILESYSTEM', 'operation namespace is on another filesystem');
  return {executionRoot: execution.path, specRoot: spec?.path ?? null, productRoot: product.path,
    temporaryRoot: temporary.path, specKey: key, lockPath: path.join(temporary.path, `${key}.lock`),
    materialRoot: material.path, preparationRegistry: path.join(material.path, 'preparations.json'),
    operationRegistry: path.join(material.path, 'registry.json'),
    lifecycleLock: path.join(material.path, 'lifecycle.lock'),
    lifecycleJournal: path.join(material.path, 'lifecycle-transaction.json'),
    readinessAttestation: path.join(material.path, 'readiness-attestation.json'),
    excludedRoots: excluded,
    targetParent: officialParent.path, targetParentIdentity: officialParent.identity,
    targetParentAnchor: officialParent.anchor,
    leaseParent: temporary.path, leaseParentIdentity: temporary.identity,
    leaseParentAnchor: temporary.anchor,
    materialRootIdentity: material.identity, materialRootAnchor: material.anchor,
    materialParentIdentity: material.identity, officialParent: officialParent.path,
    officialParentIdentity: officialParent.identity, officialAnchor: official.anchor,
    exclusion: {kind: gitRoot === null ? 'launcher-declared' : 'git-ignore-unverified', root: temporary.path},
    activation: 'read-only'};
}

// Transition checks stay separate so existing lifecycle recovery may inspect roots
// without treating its own retained legacy lease as a migration request.
export async function resolveExecutionFilesystemContext(workspace,filesystemContext=null) {
  const roots=await resolveExecutionFilesystemRoots(workspace,filesystemContext);
  await assertNoLegacyExecutionControls({...workspace,filesystemContext:{productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots}});
  return roots;
}

// Allocation primitive used only after the named producer has proved exclusion.
// It cannot execute commands or turn a locator observation into an attestation.
export async function ensureExecutionMaterialRoot(workspace, expected) {
  const current = await resolveExecutionFilesystemRoots(workspace);
  for (const field of ['executionRoot','specRoot','productRoot','temporaryRoot','materialRoot',
    'targetParentIdentity','leaseParentIdentity','materialRootIdentity','officialAnchor','leaseParentAnchor'])
    if (!equal(current[field], expected[field])) fail(`filesystem context changed before allocation: ${field}`);
  let parent = current.leaseParentAnchor.path;
  let parentMetadata = await fs.lstat(parent);
  if (!equal(identity(parentMetadata), current.leaseParentAnchor.identity)) fail('operational ancestor changed before allocation');
  const relative = path.relative(parent, current.temporaryRoot);
  const directories = [];
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    parent = path.join(parent, segment); directories.push(parent);
  }
  directories.push(current.materialRoot);
  for (const directory of directories) {
    const ancestor = path.dirname(directory), before = await fs.lstat(ancestor);
    await ancestry(directory);
    if (!await stat(directory)) {
      try { await fs.mkdir(directory, {mode:0o700}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await syncLockParent(ancestor);
    }
    const metadata = await fs.lstat(directory), after = await fs.lstat(ancestor);
    if (!equal(identity(before), identity(after)) || !metadata.isDirectory() || metadata.isSymbolicLink()
      || await fs.realpath(directory) !== directory || String(metadata.dev) !== current.officialAnchor.identity.dev)
      fail('operational parent, directory identity or filesystem changed during allocation');
  }
  return resolveExecutionFilesystemRoots(workspace);
}

export async function executionLockIdentity(workspace) {
  const roots=await resolveExecutionFilesystemRoots(workspace);
  return {executionRoot:roots.executionRoot,specRoot:roots.specRoot,parent:roots.leaseParent,
    parentIdentity:roots.leaseParentIdentity,lockPath:roots.lockPath,
    targetParent:roots.targetParent,targetParentIdentity:roots.targetParentIdentity,
    filesystemContext:{productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots}};
}

function lockPayloadKeys(payload,expectedKeys,label) {
  const actual=new Set(Object.keys(payload)),expected=new Set(expectedKeys);
  const missing=[...expected].filter(key=>!actual.has(key)).sort(),extra=[...actual].filter(key=>!expected.has(key)).sort();
  if(missing.length||extra.length)fail(`${label} keys are inconsistent (missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)})`);
}
export function validateLifecycleLockPayload(payload) {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    fail("workspace publication lock root must be a JSON object");
  }
  lockPayloadKeys(payload, [
    "version", "state", "owner_id", "operation_id", "transaction_id",
    "pid", "hostname", "started_at",
    ...(payload.version === 2 ? ["common_lease"] : []),
  ], "workspace publication lock");
  if (![1, 2].includes(payload.version)) fail(`unsupported workspace publication lock version ${JSON.stringify(payload.version)}`);
  if (!new Set(["active", "released"]).has(payload.state)) fail("workspace publication lock has an invalid state");
  for (const field of ["owner_id", "operation_id"]) {
    if (typeof payload[field] !== "string" || !/^[0-9a-f]{32}$/u.test(payload[field])) {
      fail(`workspace publication lock has an invalid ${field.replaceAll("_", " ")}`);
    }
  }
  if (payload.transaction_id !== null &&
      (typeof payload.transaction_id !== "string" || !/^[0-9a-f]{32}$/u.test(payload.transaction_id))) {
    fail("workspace publication lock has an invalid transaction identity");
  }
  if (!Number.isSafeInteger(payload.pid) || payload.pid <= 0) fail("workspace publication lock has an invalid process identity");
  if (typeof payload.hostname !== "string" || payload.hostname.length === 0 || payload.hostname.length > 1024) {
    fail("workspace publication lock has an invalid host identity");
  }
  if (typeof payload.started_at !== "string" || Number.isNaN(Date.parse(payload.started_at))) {
    fail("workspace publication lock has an invalid acquisition timestamp");
  }
  if (payload.version === 2) {
    validateLifecycleCommonLeaseBinding(payload.common_lease);
    if (payload.common_lease.pid !== payload.pid || payload.common_lease.hostname !== payload.hostname) {
      fail("workspace publication lock common lease owner differs");
    }
  }
  return {
    state: payload.state,
    ownerId: payload.owner_id,
    operationId: payload.operation_id,
    transactionId: payload.transaction_id,
    pid: payload.pid,
    hostname: payload.hostname,
    startedAt: payload.started_at,
    ...(payload.version === 2 ? { commonLease: payload.common_lease } : {}),
  };
}

// Every family observes old CONTROL roles before and after normal acquisition.
// Readiness files remain external lifecycle inputs and confer no kernel authority.
export async function assertNoLegacyExecutionControls(workspace) {
  const roots=await resolveExecutionFilesystemRoots(workspace),parent=roots.targetParent;
  if(roots.targetParentIdentity===null)return roots;
  const common=`.stnl-execution-${roots.specKey}.lock`,name=roots.specRoot===null?null:path.basename(roots.specRoot);
  const lifecycle=name===null?null:`.${name}.lifecycle.lock`;
  const exact=[common,common.replace(/\.lock$/u,'.preparations.json'),...(name===null?[]:[lifecycle,`.${name}.lifecycle-transaction.json`])].map(unicodeCaseFold);
  const prefixes=[`${common}.recovery-`,`${common}.retired-`,...(name===null?[]:[
    ...['stage','backup','journal-tmp','journal-build','lock-tmp','lock-build','lock-retired','ownership','retired-tree']
      .map(role=>`.${name}.lifecycle-${role}-`),
    `..${name}.readiness-attestation.json.lifecycle-attestation-retired-`])].map(unicodeCaseFold);
  const related=names=>names.filter(value=>{const folded=unicodeCaseFold(value);return exact.includes(folded)||prefixes.some(prefix=>folded.startsWith(prefix));}).sort();
  const before=related(await fs.readdir(parent));
  if(before.some(value=>value!==lifecycle))fail('pending or uncertain old common/lifecycle controls remain; preserve before locator transition');
  let captured=null;
  if(before.length) {
    const file=path.join(parent,lifecycle);captured=await readFileWithLinks(file,[1],16384);
    let payload;try{payload=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(captured.bytes));}catch{fail('old lifecycle lock is malformed; preserve it');}
    const record=validateLifecycleLockPayload(payload);
    if(record.state!=='released'||record.transactionId!==null)fail('old lifecycle lock is active or uncertain; preserve it');
    if(record.commonLease&&(record.commonLease.executionRoot!==roots.executionRoot||record.commonLease.lockPath!==path.join(parent,common)
      ||!equal({dev:record.commonLease.parentIdentity.dev,ino:record.commonLease.parentIdentity.ino},roots.targetParentIdentity)))
      fail('old lifecycle lock binding differs from official geometry');
    const after=await readFileWithLinks(file,[1],16384);
    if(!equal(captured.identity,after.identity)||!captured.bytes.equals(after.bytes))fail('old lifecycle lock changed during inspection');
  }
  if(!equal(before,related(await fs.readdir(parent))))fail('old controls changed during inspection');
  const final=await resolveExecutionFilesystemRoots(workspace);
  if(!equal(roots.targetParentIdentity,final.targetParentIdentity))fail('old controls official parent changed during inspection');
  return roots;
}

async function assertNoRecoveryClaim(location) {
  const canonical=path.basename(location.lockPath),foldedCanonical=unicodeCaseFold(canonical);
  const prefixes=[`${canonical}.recovery-`,`${canonical}.retired-`].map(unicodeCaseFold);
  if ((await fs.readdir(location.parent)).some(name => {const folded=unicodeCaseFold(name);
    return prefixes.some(prefix=>folded.startsWith(prefix))||folded===foldedCanonical&&name!==canonical;})) fail(`common lease recovery is incomplete; preserve and diagnose: ${location.lockPath}`);
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
  await assertNoLegacyExecutionControls(workspace);
  if(location.parentIdentity===null)fail('operational lease parent is absent; named producer must prove exclusion before allocation');
  await assertNoRecoveryClaim(location);
  const lease = await createExecutionLease(location);
  try { await assertNoRecoveryClaim(location);await assertNoLegacyExecutionControls(workspace); }
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

async function assertRecoveryControls(proof, location, workspace) {
  const physical=proof.format==='stnl-lifecycle-common-recovery-v2';
  if(!physical)fail('legacy lifecycle recovery proof cannot transfer a coordinated common lease');
  closed(proof, ['format','binding','controls','absent',...(physical?['filesystemContext']:[])], 'lifecycle recovery proof');
  let controlParent=location.parent;
  if(physical) {
    const roots=await resolveExecutionFilesystemRoots(workspace),held=proof.filesystemContext;
    closed(held,['format','specRoot','executionRoot','policy','targetParent','leaseParent','materialParent'],'lifecycle filesystem context');
    const policy=normalizeExecutionFilesystemPolicy(held.policy);
    if(held.format!=='stnl-lifecycle-filesystem-context-v1'||held.specRoot!==roots.specRoot||held.executionRoot!==roots.executionRoot
      ||!equal(policy,{productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots}))fail('lifecycle recovery filesystem policy differs');
    for(const [role,file,expected] of [['targetParent',roots.targetParent,roots.targetParentIdentity],
      ['leaseParent',roots.leaseParent,roots.leaseParentIdentity],['materialParent',roots.materialRoot,roots.materialRootIdentity]]) {
      closed(held[role],['path','identity'],'lifecycle '+role);
      if(!hasPhysicalIdentity(held[role].identity)||held[role].path!==file
        ||!equal({dev:held[role].identity.dev,ino:held[role].identity.ino},expected))fail('lifecycle recovery parent identity differs');
    }
    controlParent=roots.materialRoot;
  }
  if (!['stnl-lifecycle-common-recovery-v1','stnl-lifecycle-common-recovery-v2'].includes(proof.format) || !Array.isArray(proof.controls) || !proof.controls.length || proof.controls.length > 128
    || new Set(proof.controls.map(entry => entry.file)).size !== proof.controls.length || !Array.isArray(proof.absent)) fail('invalid lifecycle recovery controls');
  for (const control of proof.controls) {
    closed(control, ['file','identity','sha256','links'], 'lifecycle recovery control');
    if (!path.isAbsolute(control.file) || path.dirname(control.file) !== controlParent || ![1, 2].includes(control.links)) fail('lifecycle recovery control is outside stable ancestor or has invalid links');
    if (control.links === 2 && proof.controls.filter(other => equal(other.identity, control.identity)
      && other.sha256 === control.sha256 && other.links === 2).length !== 2) fail('lifecycle recovery control has an unbound extra link');
    const current = await readFileWithLinks(control.file, [control.links]);
    if (!equal(current.identity, control.identity) || digest(current.bytes) !== control.sha256) fail('lifecycle recovery control changed');
  }
  for (const file of proof.absent) {
    if (!path.isAbsolute(file) || path.dirname(file) !== controlParent || await stat(file)) fail('absent lifecycle recovery control appeared');
  }
}

// A typed proof from the lifecycle wrapper, never a general takeover predicate.
// The exclusive hardlink is a retirement role of this lease, not a third lock.
async function acquireLifecycleRecoveryLease(workspace, proof) {
  await assertNoLegacyExecutionControls(workspace);
  const location = await executionLockIdentity(workspace);
  const binding = validateLifecycleCommonLeaseBinding(proof.binding);
  if (binding.executionRoot !== location.executionRoot || binding.lockPath !== location.lockPath
    || !equal(binding.parentIdentity, location.parentIdentity)) fail('common lease recovery root or ancestor differs');
  await assertNoRecoveryClaim(location);
  await assertRecoveryControls(proof, location, workspace);
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
  await assertRecoveryControls(proof, location, workspace);
  assertDeadLifecycleOwner(binding);
  const parent = await fs.lstat(location.parent);
  if (!equal(identity(parent), binding.parentIdentity) || await fs.realpath(location.parent) !== location.parent) fail('common lease recovery ancestor changed');
  assertBoundCommonFile(await readFileWithLinks(location.lockPath, [2]), binding);
  await assertNoLegacyExecutionControls(workspace);
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
  const location=await executionLockIdentity({executionRoot:lease.executionRoot,specRoot:lease.specRoot,filesystemContext:lease.filesystemContext});
  if(location.lockPath!==lease.lockPath||!equal(location.parentIdentity,lease.parentIdentity)
    ||!equal(location.targetParentIdentity,lease.targetParentIdentity))fail('common lease physical context changed');
  const current = await readOwnedFile(lease.lockPath);
  const parent = await fs.lstat(lease.parent);
  if (!equal(identity(parent), lease.parentIdentity) || await fs.realpath(lease.parent) !== lease.parent
    || !equal(current.identity, lease.owned.identity) || !current.bytes.equals(lease.owned.bytes)) fail('lock ownership or stable ancestor changed');
}

export async function captureLifecycleRetirementRoles(root,{names=null}={}){
  await ancestry(root);const rootBefore=await fs.lstat(root);if(!rootBefore.isDirectory()||rootBefore.isSymbolicLink())fail('retirement root is not a real directory');
  const rows=[];const retirementOrder=(a,b)=>a<b?-1:a>b?1:0;
  async function visit(relative){
    if(rows.length>=1024)fail('retirement manifest exceeds its bounded entry limit');
    const file=path.join(root,...relative.split('/')),before=await fs.lstat(file,{bigint:true});
    const row={path:relative,kind:null,identity:identity(before),mode:Number(before.mode&0o777n),sha256:null,linkTarget:null};
    if(before.isSymbolicLink()){row.kind='symlink';row.linkTarget=await fs.readlink(file);}
    else if(before.isDirectory()){row.kind='directory';rows.push(row);for(const name of (await fs.readdir(file)).sort(retirementOrder))await visit(relative+'/'+name);}
    else if(before.isFile()){
      row.kind='file';const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
      try{const opened=await handle.stat({bigint:true});if(!equal(identity(before),identity(opened)))fail('retirement file changed before capture',file);const bytes=await handle.readFile();const after=await handle.stat({bigint:true});if(!equal(identity(before),identity(after))||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)fail('retirement file changed during capture',file);row.sha256='sha256:'+createHash('sha256').update(bytes).digest('hex');}finally{await handle.close();}
    }else fail('unsupported material in retirement inventory',file);
    if(!equal(identity(before),identity(await fs.lstat(file,{bigint:true}))))fail('retirement role changed during capture',file);
    if(row.kind!=='directory')rows.push(row);
  }
  for(const name of names??(await fs.readdir(root)).sort(retirementOrder))await visit(name);
  rows.sort((a,b)=>retirementOrder(a.path,b.path));validateLifecycleRetirementManifest(rows);if(!equal(identity(rootBefore),identity(await fs.lstat(root))))fail('retirement root changed during capture');return rows;
}


// Closed data contracts on the existing lease. Ordinary v1 headers remain
// exactly four fields; this witness is only for a confirmed lifecycle CLOSE.
export function validateLifecycleRetirementManifest(entries) {
  if(!Array.isArray(entries)||entries.length>1024)fail('retirement manifest exceeds its bounded entry limit');
  const names=new Set();
  for(const entry of entries){
    closed(entry,['path','kind','identity','mode','sha256','linkTarget'],'retirement role');
    if(typeof entry.path!=='string'||!entry.path||/[\\\0]/u.test(entry.path)||path.posix.normalize(entry.path)!==entry.path||path.win32.isAbsolute(entry.path)||path.isAbsolute(entry.path)||entry.path.split('/').some(p=>!p||p==='.'||p==='..')
      ||names.has(entry.path)||!hasPhysicalIdentity(entry.identity)||!Number.isSafeInteger(entry.mode)||entry.mode<0||entry.mode>0o777)fail('retirement role has invalid path or identity');
    names.add(entry.path);
    if(entry.kind==='file'){
      if(!/^sha256:[0-9a-f]{64}$/u.test(entry.sha256??'')||entry.linkTarget!==null)fail('invalid retirement file digest');
    }else if(entry.kind==='directory'){
      if(entry.sha256!==null||entry.linkTarget!==null)fail('invalid retirement directory');
    }else if(entry.kind==='symlink'){
      if(entry.sha256!==null||typeof entry.linkTarget!=='string')fail('invalid retirement symlink');
    }else fail('unknown retirement role kind');
  }
  const byName=new Map(entries.map(entry=>[entry.path,entry]));
  for(const entry of entries){const parent=path.posix.dirname(entry.path);if(parent!=='.'&&byName.get(parent)?.kind!=='directory')fail('retirement role has an unbound parent');}
  return entries;
}
export function validateLifecycleTerminalRetirement(value) {
  closed(value,['format','transactionId','sourceCommonLease','filesystemContext','materialRootIdentity','targetIdentity','closedSnapshotSha256','closeBinding','roles','targetRoles','intent'],'terminal retirement');
  validateLifecycleCommonLeaseBinding(value.sourceCommonLease);
  closed(value.filesystemContext,['specRoot','productRoot','temporaryRoot','excludedRoots','targetParentIdentity','leaseParentIdentity'],'terminal filesystem context');
  normalizeExecutionFilesystemPolicy({productRoot:value.filesystemContext.productRoot,temporaryRoot:value.filesystemContext.temporaryRoot,excludedRoots:value.filesystemContext.excludedRoots});
  const context=value.filesystemContext;
  if(value.format!=='stnl-lifecycle-terminal-retirement-v1'||value.intent!=='cleanup'||!/^[0-9a-f]{32}$/u.test(value.transactionId??'')
    ||!hasPhysicalIdentity(value.materialRootIdentity)||!hasPhysicalIdentity(value.targetIdentity)
    ||!hasPhysicalIdentity(value.filesystemContext.targetParentIdentity)||!hasPhysicalIdentity(value.filesystemContext.leaseParentIdentity)
    ||!/^sha256:[0-9a-f]{64}$/u.test(value.closedSnapshotSha256??'')||!value.closeBinding||typeof value.closeBinding!=='object')fail('invalid terminal retirement binding');
  validateLifecycleCloseBinding(value.closeBinding);
  if(typeof context.specRoot!=='string'||!path.isAbsolute(context.specRoot)||path.normalize(context.specRoot)!==context.specRoot
    ||value.sourceCommonLease.executionRoot!==path.join(context.specRoot,'execution')
    ||value.sourceCommonLease.lockPath!==path.join(context.temporaryRoot,createHash('sha256').update(value.sourceCommonLease.executionRoot).digest('hex')+'.lock')
    ||!equal(value.sourceCommonLease.parentIdentity,context.leaseParentIdentity)
    ||value.targetIdentity.dev!==value.materialRootIdentity.dev||value.targetIdentity.dev!==context.leaseParentIdentity.dev)fail('terminal retirement roots or devices differ');
  validateLifecycleRetirementManifest(value.roles);
  validateLifecycleRetirementManifest(value.targetRoles);
  if(Buffer.byteLength(JSON.stringify(value))>64*1024)fail('terminal retirement exceeds the bounded record limit');
  return value;
}
export function validateLifecycleCloseBinding(binding){
  closed(binding,['format','sourceIdentity','requirementsAuthority','sourceExecutionDisposition','operationalInventory'],'CLOSE binding');
  const hash=value=>typeof value==='string'&&/^sha256:[0-9a-f]{64}$/u.test(value);
  if(binding.format!=='stnl-lifecycle-close-binding-v1'||!hasPhysicalIdentity(binding.sourceIdentity)||!hash(binding.requirementsAuthority))fail('invalid CLOSE binding authority or source identity');
  const disposition=binding.sourceExecutionDisposition;
  if(disposition?.kind==='absent')closed(disposition,['kind'],'absent CLOSE disposition');
  else if(disposition?.kind==='discard-current-complete'){
    closed(disposition,['kind','requirementsAuthority','executionIdentity','activationId','artifactManifestSha256'],'COMPLETE CLOSE disposition');
    if(disposition.requirementsAuthority!==binding.requirementsAuthority||!hasPhysicalIdentity(disposition.executionIdentity)||!hash(disposition.artifactManifestSha256)
      ||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(disposition.activationId??''))fail('invalid CLOSE current binding');
  }else fail('unknown CLOSE execution disposition');
  validateLifecycleRetirementManifest(binding.operationalInventory);return binding;
}
function terminalLeasePayload(lease,intent,predecessor=intent.sourceCommonLease){
  return {format:'stnl-execution-lock-v2',token:lease.token,executionRoot:lease.executionRoot,pid:process.pid,
    terminalRetirement:validateLifecycleTerminalRetirement(intent),transitionFrom:validateLifecycleCommonLeaseBinding(predecessor)};
}
function terminalControlBinding(location,record,payload,hostname){
  return validateLifecycleCommonLeaseBinding({format:'stnl-lifecycle-common-lease-v1',executionRoot:location.executionRoot,lockPath:location.lockPath,
    parentIdentity:location.parentIdentity,identity:record.identity,sha256:digest(record.bytes),token:payload.token,pid:payload.pid,hostname});
}
function validateTerminalHeader(payload,location){
  closed(payload,['format','token','executionRoot','pid','terminalRetirement','transitionFrom'],'terminal common lease');
  const witness=validateLifecycleTerminalRetirement(payload.terminalRetirement),prior=validateLifecycleCommonLeaseBinding(payload.transitionFrom);
  if(payload.format!=='stnl-execution-lock-v2'||payload.token!==witness.sourceCommonLease.token||payload.executionRoot!==location.executionRoot
    ||!Number.isSafeInteger(payload.pid)||payload.pid<1||prior.token!==payload.token||prior.executionRoot!==location.executionRoot
    ||prior.lockPath!==location.lockPath||!isDeepStrictEqual(prior.parentIdentity,location.parentIdentity))fail('terminal common header or predecessor differs');
  return payload;
}
// Inspect only the existing canonical/retired/recovery roles. A normal or
// orphan v1 retired record cannot select the terminal recovery route.
export async function inspectLifecycleTerminalRetirement(workspace){
  const location=await executionLockIdentity(workspace);
  if(!await stat(location.parent))return null;
  const basename=path.basename(location.lockPath),prefixes=[basename+'.retired-',basename+'.recovery-'];
  const allNames=await fs.readdir(location.parent);
  if(allNames.some(name=>unicodeCaseFold(name)===unicodeCaseFold(basename)&&name!==basename))fail('terminal canonical lease has a foreign casefold alias');
  const names=allNames.filter(name=>prefixes.some(prefix=>unicodeCaseFold(name).startsWith(unicodeCaseFold(prefix))));
  if(names.length>2)fail('ambiguous terminal retirement claims; preserve and diagnose');
  if(names.some(name=>!prefixes.some(prefix=>name.startsWith(prefix))))fail('terminal retirement claim alias differs');
  const files=[...(await stat(location.lockPath)?[location.lockPath]:[]),...names.sort().map(name=>path.join(location.parent,name))];
  const records=[];
  for(const file of files){const observed=await readFileWithLinks(file,[1,2],64*1024);const text=new TextDecoder('utf-8',{fatal:true}).decode(observed.bytes),payload=parseStrictJson(text);
    if(payload.format==='stnl-execution-lock-v2')validateTerminalHeader(payload,location);
    else if(payload.format==='stnl-execution-lock-v1'){
      closed(payload,['format','token','executionRoot','pid'],'normal common lease');
    }else fail('unbound retirement/recovery claim cannot authorize terminal cleanup');
    if(file!==location.lockPath&&!prefixes.some(prefix=>path.basename(file)===prefix+payload.token))fail('terminal claim token differs from its exact role');
    records.push({file,observed,payload});
  }
  const terminal=records.filter(item=>item.payload.format==='stnl-execution-lock-v2');
  if(!terminal.length){if(names.length)fail('common lease recovery is incomplete: unbound retired/recovery v1 record requires diagnosis');return null;}
  const intent=terminal[0].payload.terminalRetirement;
  if(terminal.some(item=>!isDeepStrictEqual(item.payload.terminalRetirement,intent)))fail('terminal claims describe different intentions');
  const groups=[];
  for(const record of records){let group=groups.find(item=>equal(item.observed.identity,record.observed.identity));
    if(group){if(!group.observed.bytes.equals(record.observed.bytes))fail('terminal hardlink bytes differ');group.files.push(record.file);}
    else groups.push({...record,files:[record.file]});
  }
  for(const group of groups){if(group.observed.links!==group.files.length||group.files.length>2)fail('terminal role has an unbound extra link');
    group.binding=terminalControlBinding(location,group.observed,group.payload,intent.sourceCommonLease.hostname);
  }
  const priorGroups=new Set();
  for(const group of groups.filter(item=>item.payload.format==='stnl-execution-lock-v2'))for(const previous of groups){
    if(group!==previous&&isDeepStrictEqual(group.payload.transitionFrom,previous.binding))priorGroups.add(previous);
  }
  const tips=groups.filter(group=>!priorGroups.has(group));
  if(tips.length!==1||tips[0].payload.format!=='stnl-execution-lock-v2')fail('terminal retirement chain is ambiguous or unrelated');
  const tip=tips[0],chain=new Set([tip]);let cursor=tip;
  for(;;){const previous=groups.find(group=>group!==cursor&&isDeepStrictEqual(cursor.payload.transitionFrom,group.binding));if(!previous)break;if(chain.has(previous))fail('terminal predecessor cycle');chain.add(previous);cursor=previous;}
  if(chain.size!==groups.length)fail('terminal retirement has an unbound canonical or claim');
  return {location,records,groups,tip,intent};
}
async function assertTerminalFilesystem(location,witness){
  const context=witness.filesystemContext,roots=await resolveExecutionFilesystemRoots({executionRoot:location.executionRoot,specRoot:context.specRoot,
    filesystemContext:{productRoot:context.productRoot,temporaryRoot:context.temporaryRoot,excludedRoots:context.excludedRoots}});
  if(roots.lockPath!==location.lockPath||!isDeepStrictEqual(roots.leaseParentIdentity,context.leaseParentIdentity)
    ||!isDeepStrictEqual(roots.targetParentIdentity,context.targetParentIdentity)
    ||roots.materialRootIdentity!==null&&!isDeepStrictEqual(roots.materialRootIdentity,witness.materialRootIdentity)
    ||!isDeepStrictEqual(roots.specRoot===context.specRoot?identity(await fs.lstat(roots.specRoot)):null,witness.targetIdentity))fail('terminal retirement physical context changed');
  const target=await captureLifecycleRetirementRoles(roots.specRoot);
  if(!isDeepStrictEqual(target,witness.targetRoles))fail('terminal closed target bytes, modes or topology changed');
  if(roots.materialRootIdentity!==null){const actual=await captureLifecycleRetirementRoles(roots.materialRoot),expected=new Map(witness.roles.map(row=>[row.path,row]));
    if(actual.some(row=>!isDeepStrictEqual(row,expected.get(row.path))))fail('terminal material has foreign, changed or unbound remaining roles');
  }
  return roots;
}
export async function assertLifecycleTerminalRetirementState(lease){
  await assertExecutionPublicationLock(lease);const record=validateTerminalHeader(parseStrictJson(lease.owned.bytes.toString('utf8')),lease);
  return assertTerminalFilesystem(lease,record.terminalRetirement);
}
// Same typed recovery boundary as lifecycle recovery, with the durable terminal
// witness taking precedence when its internal journal no longer exists.
export async function acquireLifecycleTerminalRetirementLock(workspace,expected){
  const current=await inspectLifecycleTerminalRetirement(workspace);
  if(current===null||!isDeepStrictEqual(current.records,expected.records))fail('terminal retirement changed before recovery claim');
  await assertTerminalFilesystem(current.location,current.intent);
  for(const group of current.groups)assertDeadLifecycleOwner(group.binding);
  const token=current.tip.payload.token,roles=[current.location.lockPath+'.recovery-'+token,current.location.lockPath+'.retired-'+token];
  const role=roles.find(file=>!current.records.some(record=>record.file===file));
  if(!role)fail('terminal claims are occupied without a safe recovery transition; preserve and diagnose');
  const value=terminalLeasePayload({...current.location,token},current.intent,current.tip.binding),bytes=Buffer.from(JSON.stringify(value)+'\n');
  if(bytes.length>64*1024)fail('terminal common record exceeds the bounded record limit');
  const owned=await writeNew(role,bytes);await syncLockParent(current.location.parent);
  try{
    for(const record of current.records){const observed=await readFileWithLinks(record.file,[record.observed.links],64*1024);if(!equal(observed.identity,record.observed.identity)||!observed.bytes.equals(record.observed.bytes))fail('terminal predecessor changed during recovery claim');}
    await assertTerminalFilesystem(current.location,current.intent);
    const canonical=current.records.find(record=>record.file===current.location.lockPath);
    for(const previous of current.records.filter(record=>record.file!==current.location.lockPath)){
      const observed=await readFileWithLinks(previous.file,[previous.observed.links],64*1024);if(!equal(observed.identity,previous.observed.identity)||!observed.bytes.equals(previous.observed.bytes))fail('terminal predecessor role changed before cleanup');
      await fs.unlink(previous.file);await syncLockParent(current.location.parent);
    }
    const quarantine=roles.find(file=>file!==role);
    if(await stat(quarantine))fail('terminal canonical quarantine unexpectedly exists');
    if(canonical){
      const before=await readOwnedFile(current.location.lockPath);if(!equal(before.identity,canonical.observed.identity)||!before.bytes.equals(canonical.observed.bytes))fail('terminal canonical changed before retirement');
      await fs.rename(current.location.lockPath,quarantine);await syncLockParent(current.location.parent);
      const moved=await readOwnedFile(quarantine);if(!equal(moved.identity,canonical.observed.identity)||!moved.bytes.equals(canonical.observed.bytes))fail('terminal canonical changed during retirement; preserving quarantine');
    }else if(await stat(current.location.lockPath))fail('foreign canonical appeared during terminal recovery');
    await fs.link(role,current.location.lockPath);await syncLockParent(current.location.parent);
    const installed=await readFileWithLinks(current.location.lockPath,[2],64*1024),claimed=await readFileWithLinks(role,[2],64*1024);
    if(!equal(installed.identity,owned.identity)||!equal(claimed.identity,owned.identity)||!installed.bytes.equals(bytes)||!claimed.bytes.equals(bytes))fail('terminal recovery claim changed at promotion');
    if(canonical){const moved=await readOwnedFile(quarantine);if(!equal(moved.identity,canonical.observed.identity)||!moved.bytes.equals(canonical.observed.bytes))fail('terminal quarantine changed before retirement');await fs.unlink(quarantine);await syncLockParent(current.location.parent);}
    await fs.unlink(role);await syncLockParent(current.location.parent);
    const lease={...current.location,token,owned:await readOwnedFile(current.location.lockPath),retainExecutionLock:true};
    await assertLifecycleTerminalRetirementState(lease);return lease;
  }catch(error){error.retainExecutionLock=true;throw error;}
}
// The existing retired role excludes writers across the unlink/link window.
// No rename overwrites a replacement canonical lease. Uncertain transitions
// preserve the typed role for read-only diagnosis and terminal recovery.
export async function beginLifecycleTerminalRetirement(lease,intent) {
  await assertExecutionPublicationLock(lease);
  const prior=await lifecycleCommonLeaseBinding(lease);
  if(!equal(prior,intent.sourceCommonLease))fail('terminal source lease differs from acquired ownership');
  const roots=await resolveExecutionFilesystemRoots({executionRoot:lease.executionRoot,specRoot:lease.specRoot,filesystemContext:lease.filesystemContext});
  const bound=intent.filesystemContext;
  if(bound.specRoot!==roots.specRoot||bound.productRoot!==roots.productRoot||bound.temporaryRoot!==roots.temporaryRoot||!equal(bound.excludedRoots,roots.excludedRoots)
    ||!equal(bound.targetParentIdentity,roots.targetParentIdentity)||!equal(bound.leaseParentIdentity,roots.leaseParentIdentity)||!equal(intent.materialRootIdentity,roots.materialRootIdentity))fail('terminal retirement physical context differs');
  await assertNoRecoveryClaim(lease);
  const value=terminalLeasePayload(lease,intent),bytes=Buffer.from(JSON.stringify(value)+'\n');
  if(bytes.length>64*1024)fail('terminal common record exceeds the bounded record limit');
  const role=`${lease.lockPath}.retired-${lease.token}`;
  const previousRole=`${lease.lockPath}.recovery-${lease.token}`;
  const staged=await writeNew(role,bytes);
  lease.retainExecutionLock=true;
  try{
    await syncLockParent(lease.parent);await assertExecutionPublicationLock(lease);
    const check=await readOwnedFile(role);if(!equal(check.identity,staged.identity)||!check.bytes.equals(bytes))fail('terminal witness changed before CAS');
    if(await stat(previousRole))fail('terminal predecessor quarantine unexpectedly exists');
    await fs.rename(lease.lockPath,previousRole);await syncLockParent(lease.parent);
    const previous=await readOwnedFile(previousRole);if(!equal(previous.identity,lease.owned.identity)||!previous.bytes.equals(lease.owned.bytes))fail('terminal source lease changed during quarantine; preserving evidence');
    await fs.link(role,lease.lockPath);await syncLockParent(lease.parent);
    const moved=await readFileWithLinks(lease.lockPath,[2],64*1024);
    const linked=await readFileWithLinks(role,[2],64*1024);
    if(!equal(moved.identity,staged.identity)||!equal(linked.identity,staged.identity)||!moved.bytes.equals(bytes)||!linked.bytes.equals(bytes))fail('terminal witness changed during CAS');
    const priorRecord=await readOwnedFile(previousRole);if(!equal(priorRecord.identity,lease.owned.identity)||!priorRecord.bytes.equals(lease.owned.bytes))fail('terminal source quarantine changed before cleanup');
    await fs.unlink(previousRole);await syncLockParent(lease.parent);
    await fs.unlink(role);await syncLockParent(lease.parent);
    lease.owned=await readOwnedFile(lease.lockPath);await assertExecutionPublicationLock(lease);
    return value.terminalRetirement;
  }catch(error){error.retainExecutionLock=true;throw error;}
}

async function terminalRoleLocation(lease,name){
  await assertExecutionPublicationLock(lease);
  const header=validateTerminalHeader(parseStrictJson(lease.owned.bytes.toString('utf8')),lease),witness=header.terminalRetirement;
  const roots=await resolveExecutionFilesystemRoots({executionRoot:lease.executionRoot,specRoot:witness.filesystemContext.specRoot,filesystemContext:lease.filesystemContext});
  const row=witness.roles.find(row=>row.path===name);if(!row)fail('terminal cleanup did not seal this role');
  const file=path.resolve(roots.materialRoot,...name.split('/'));
  if(file===roots.materialRoot||!inside(file,roots.materialRoot))fail('terminal role escapes its sealed material root');
  const root=await stat(roots.materialRoot);if(!root)return {row,file,roots,present:false};
  if(!root.isDirectory()||root.isSymbolicLink()||!equal(identity(root),witness.materialRootIdentity))fail('terminal namespace identity changed');
  const parts=name.split('/');let parent=roots.materialRoot;
  for(let index=0;index<parts.length-1;index++){
    parent=path.join(parent,parts[index]);const observed=await stat(parent),expected=witness.roles.find(row=>row.path===parts.slice(0,index+1).join('/'));
    if(!observed)return {row,file,roots,present:false};
    if(!observed.isDirectory()||observed.isSymbolicLink()||!expected||!equal(identity(observed),expected.identity))fail('terminal role ancestor changed');
  }
  return {row,file,roots,present:await stat(file)};
}
export async function removeLifecycleTerminalRetirementRole(lease,name){
  const {row,file,roots,present}=await terminalRoleLocation(lease,name);if(!present)return false;
  if(!equal(identity(present),row.identity)||(present.mode&0o777)!==row.mode)fail('terminal role identity or mode changed before removal');
  if(row.kind==='directory'){
    if(!present.isDirectory()||present.isSymbolicLink()||(await fs.readdir(file)).length)fail('terminal directory is changed or not empty');
  }else if(row.kind==='symlink'){
    if(!present.isSymbolicLink()||await fs.readlink(file)!==row.linkTarget)fail('terminal symlink changed');
  }else{
    if(!present.isFile()||present.isSymbolicLink())fail('terminal file type changed');
    const captured=await readFileWithLinks(file,[present.nlink]);if(!equal(captured.identity,row.identity)||digest(captured.bytes)!==row.sha256)fail('terminal file bytes changed');
  }
  const barrier=await terminalRoleLocation(lease,name),final=barrier.present;
  if(!final||!equal(identity(final),row.identity)||(final.mode&0o777)!==row.mode)fail('terminal role changed at removal barrier');
  if(row.kind==='directory')await fs.rmdir(file);else await fs.unlink(file);
  await syncLockParent(path.dirname(file));
  const namespace=await fs.lstat(roots.materialRoot);if(!equal(identity(namespace),(parseStrictJson(lease.owned.bytes.toString('utf8'))).terminalRetirement.materialRootIdentity))fail('terminal namespace changed during own cleanup');
  return true;
}
export async function removeLifecycleTerminalRetirementNamespace(lease){
  const roots=await assertLifecycleTerminalRetirementState(lease);if(roots.materialRootIdentity===null)return false;
  if((await fs.readdir(roots.materialRoot)).length)fail('terminal namespace still has material');
  const barrier=await assertLifecycleTerminalRetirementState(lease);if(barrier.materialRootIdentity===null)fail('terminal namespace disappeared at removal barrier');
  await fs.rmdir(roots.materialRoot);await syncLockParent(roots.leaseParent);return true;
}
export async function retireLifecycleTerminalRetirementLease(lease){
  const roots=await assertLifecycleTerminalRetirementState(lease);if(roots.materialRootIdentity!==null)fail('terminal namespace is not yet removed');
  await assertNoRecoveryClaim(lease);
  const retired=lease.lockPath+'.retired-'+lease.token;
  if(await stat(retired))fail('terminal release role already exists');
  await fs.rename(lease.lockPath,retired);await syncLockParent(lease.parent);
  const moved=await readOwnedFile(retired);if(!equal(moved.identity,lease.owned.identity)||!moved.bytes.equals(lease.owned.bytes))fail('terminal release ownership changed; preserving retired role');
  return retired;
}
export async function finishLifecycleTerminalRetirementSettlement(lease,retired){
  if(retired!==lease.lockPath+'.retired-'+lease.token)fail('terminal settlement role differs');
  const header=validateTerminalHeader(parseStrictJson(lease.owned.bytes.toString('utf8')),lease);
  const roots=await assertTerminalFilesystem(lease,header.terminalRetirement);
  if(roots.materialRootIdentity!==null||await stat(lease.lockPath))fail('terminal settlement has an occupied namespace or canonical lease');
  const names=await fs.readdir(lease.parent),prefix=path.basename(lease.lockPath);
  if(names.some(name=>(unicodeCaseFold(name).startsWith(unicodeCaseFold(prefix+'.recovery-'))||unicodeCaseFold(name).startsWith(unicodeCaseFold(prefix+'.retired-')))&&name!==path.basename(retired)))fail('terminal settlement has an unbound claim');
  const current=await readOwnedFile(retired);if(!equal(current.identity,lease.owned.identity)||!current.bytes.equals(lease.owned.bytes))fail('terminal settlement witness changed before final unlink');
  await fs.unlink(retired);
  // Only this confirmed final unlink can bypass generic release. A later fsync
  // failure must not recreate history or claim that an absent lock is retained.
  lease[TERMINAL_SETTLED]={durable:false};
  try{await syncLockParent(lease.parent);lease[TERMINAL_SETTLED].durable=true;return {cleanup:'complete'};}
  catch(error){return {cleanup:'pending',cleanupDiagnostics:[`FINAL_SETTLEMENT_DURABILITY_UNCONFIRMED: ${error.message}`]};}
}

export async function releaseExecutionPublicationLock(lease) {
  await assertExecutionPublicationLock(lease);
  const payload=parseStrictJson(lease.owned.bytes.toString('utf8'));
  if(payload.format==='stnl-execution-lock-v2')fail('terminal retirement requires its own settlement; generic release is forbidden');
  await assertNoRecoveryClaim(lease);
  const retired = `${lease.lockPath}.retired-${lease.token}`;
  await fs.rename(lease.lockPath, retired);await syncLockParent(lease.parent);
  const captured = await readOwnedFile(retired);
  if (!equal(captured.identity, lease.owned.identity) || !captured.bytes.equals(lease.owned.bytes)) {
    fail(`lock changed at release; foreign lease preserved at ${retired}`);
  }
  await fs.unlink(retired);await syncLockParent(lease.parent);
}

export async function withExecutionPublicationLock(workspace, action) {
  const lease = await acquireExecutionPublicationLock(workspace);
  return withPublicationLease(lease, action);
}

// EC-1 writers share the coordinated locator lease; old controls only block. The operation-specific
// controller supplies the validated current-image callbacks and an immutable
// binding; this boundary owns the activation CAS and physical tree exchange.
export async function assertNoPendingExecutionPublication(workspace) {
  const roots=await resolveExecutionFilesystemRoots(workspace);
  if(roots.materialRootIdentity!==null&&(await fs.readdir(roots.materialRoot))
    .some(name=>unicodeCaseFold(name).startsWith('.stnl-execution-publication-')))
    fail('prior preparation publication or cleanup remains pending');
}

export async function reserveCurrentExecutionOperation({workspace,expectedActivationId,expectedBaseActivation,owner,binding,
  marker,registryReservation,readQuiet,readActive,bindingSha256}) {
  return withExecutionPublicationLock(workspace,async lease=>{
    const assertBinding=async()=>{
      const current=await resolveExecutionFilesystemRoots(workspace);
      if(!equal(binding.filesystemBinding,preparationFilesystemBinding(current))
        ||!equal(binding.filesystemContext,{productRoot:current.productRoot,temporaryRoot:current.temporaryRoot,excludedRoots:current.excludedRoots}))
        fail('operation filesystem binding changed before reservation');
      return current;
    };
    const roots=await assertBinding();
    await assertNoPendingExecutionPublication(workspace);
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
    await assertBinding();
    await registryReservation(allocation);
    await assertBinding();
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


// Close only an unstarted native verification on the current reservation.
// The controller supplies producer/scope evidence; this boundary owns the
// forward-only activation CAS, durable intent, readback and registry retirement.
export async function abortCurrentExecutionOperation({workspace,marker,binding,readActive,readQuiet,
  prepareDisposition,registryCompletion,checkpoint=null}) {
  return withExecutionPublicationLock(workspace,async lease=>{
    const allocated=parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
    if(allocated.format!=='stnl-execution-publication-owner-v2'||!equal(allocated.binding,binding)
      ||!['working','aborted'].includes(allocated.phase)||allocated.candidate||allocated.previous
      ||allocated.preparation?.candidateComposition)
      fail('EC-1 abort allocation binding/phase differs');
    const disposition=await prepareDisposition(allocated);
    if(!allocated.expectedInstalledActivation) {
      const current=await readActive(disposition.owner);
      const terminalId=randomUUID();
      const terminal={...current.activation,activationId:terminalId,sequence:current.activation.sequence+1,
        previousActivationId:current.activation.activationId,activeAttempt:null,
        lastAttempt:{operationAttemptId:disposition.owner.operationAttemptId,deliveryId:disposition.owner.deliveryId,
          slice:disposition.owner.slice,operation:disposition.owner.operation,terminalActivationId:terminalId,
          outcome:'aborted',operationRef:disposition.owner.operationRef,abort:disposition.proof}};
      validateCurrentActivation(terminal);
      allocated.preparation={...(allocated.preparation??{}),abortSourceActivation:current.activation};
      allocated.expectedInstalledActivation=terminal;
      allocated.terminalTransition={operationAttemptId:disposition.owner.operationAttemptId,outcome:'aborted'};
      allocated.commonLease=await lifecycleCommonLeaseBinding(lease);
      await persistAllocation(marker,allocated);
      if(checkpoint)await checkpoint('after-abort-intent');
    }
    if(!equal((await prepareDisposition(allocated)).proof,disposition.proof))fail('EC-1 abort producer evidence changed');
    const expected=allocated.expectedInstalledActivation,source=allocated.preparation?.abortSourceActivation;
    validateCurrentActivation(expected);
    if(!source||!equal(expected.lastAttempt?.abort,disposition.proof)
      ||allocated.terminalTransition?.outcome!=='aborted')fail('EC-1 abort disposition changed');
    const actual=parseStrictJson((await readOwnedFile(path.join(workspace.executionRoot,'activation.json'))).bytes.toString('utf8'));
    if(equal(actual,source)) {
      const current=await readActive(disposition.owner);
      if(!equal(current.activation,source))fail('EC-1 abort source changed');
      await assertExecutionPublicationLock(lease);
      await replaceActivation(workspace.executionRoot,expected);
      if(checkpoint)await checkpoint('after-abort-activation');
    }else if(!equal(actual,expected))fail('EC-1 abort activation outcome is uncertain');
    await syncLockParent(workspace.executionRoot);
    const confirmed=await readQuiet();
    if(!equal(confirmed.activation,expected))fail('EC-1 abort readback differs');
    if(checkpoint)await checkpoint('after-abort-readback');
    allocated.phase='aborted';allocated.runner={...allocated.runner,status:'aborted'};
    allocated.confirmation={activationId:expected.activationId,artifactManifestSha256:digest(JSON.stringify(expected.artifacts))};
    allocated.cleanup={status:'pending',ownedPaths:[],diagnostics:[]};
    await persistAllocation(marker,allocated);
    try {
      if(checkpoint)await checkpoint('before-abort-registry-completion');
      await registryCompletion(allocated);
      if(checkpoint)await checkpoint('after-abort-registry-completion');
      allocated.cleanup={status:'complete',ownedPaths:[],diagnostics:[]};
      await persistAllocation(marker,allocated);
    }catch(error) {
      allocated.cleanup.diagnostics=[error.message];await persistAllocation(marker,allocated);
      return {publication:'aborted',cleanup:'pending',activation:expected,allocation:marker,cleanupDiagnostics:[error.message]};
    }
    return {publication:'aborted',cleanup:'complete',activation:expected,allocation:marker};
  });
}

export async function withLifecycleRecoveryPublicationLock(workspace, proof, action) {
  const lease = await acquireLifecycleRecoveryLease(workspace, proof);
  return withPublicationLease(lease, action);
}

async function withPublicationLease(lease, action) {
  let result; let failure;
  try { result = await action(lease); } catch (error) { failure = error; }
  if(lease[TERMINAL_SETTLED]){if(failure)throw failure;return result;}
  if(!failure&&lease.retainExecutionLock===true)return result;
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

const validateActivation=validateCurrentActivation;

export async function assertOwnedPreparationCandidate({ candidateExecutionRoot, specPath = null, resolveWorkspace }) {
  await ancestry(candidateExecutionRoot);
  const root = await fs.realpath(candidateExecutionRoot);
  const marker = parseStrictJson((await readOwnedFile(`${root}.owner.json`)).bytes.toString('utf8'));
  if(marker.format!=='stnl-preparation-allocation-v2' || !hasOwnedAllocationEnvelope(marker,`${root}.owner.json`)) fail('preparation allocation envelope differs');
  await assertPreparationAllocationRoot(marker);
  if (!['PLAN', 'REPLAN', 'REVIEW_PLAN'].includes(marker.operation)) fail('candidate preparation identity differs');
  const workspace = await resolveWorkspace(marker.specPath);
  if(specPath) {
    const selected=await resolveWorkspace(specPath);
    if(selected.executionRoot!==workspace.executionRoot||selected.authorityPath!==workspace.authorityPath
      ||selected.specRoot!==workspace.specRoot)fail('candidate preparation identity differs');
  }
  await assertRegisteredPreparationAllocation(workspace, marker);
  if (!equal(marker.source, await captureExecutionTree(workspace.executionRoot))) fail('preparation source/CAS is stale');
  if (marker.executionRoot !== workspace.executionRoot || inside(root, workspace.executionRoot)
    || inside(workspace.executionRoot, root) || (workspace.specRoot && inside(root, workspace.specRoot))) fail('preparation requires an isolated owned candidate');
  await captureExecutionTree(root);
  return { root, marker, workspace };
}

// Both checklist and evidence writers use the same isolated-candidate/owner boundary.
async function replaceActivation(root, activation) {
  const file = path.join(root, 'activation.json'); const temporary = `${file}.${randomUUID()}.tmp`;
  await writeNew(temporary, Buffer.from(JSON.stringify(activation, null, 2) + '\n'));
  await fs.rename(temporary, file);
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
  prepareRetention = null, currentInitial = false, currentReplacement = false,
  recheckRequirements = null, preparationRecord = null }) {
  if(!currentInitial&&!currentReplacement)fail('Only current Initial installation or local review publication is supported');
  if(owner!==null||terminal||draft||prepareRetention!==null)fail('Operational publication uses the current operation controller');
  const location = await executionLockIdentity(workspace);
  const roots = await resolveExecutionFilesystemRoots(workspace);
  if (roots.materialRootIdentity === null) fail('publication requires its proved operational material root');
  const allocationParent = roots.materialRoot;
  if(currentReplacement && typeof recheckRequirements!=='function')
    fail('EC-1 local review requires a documentary authority recheck');
  await ancestry(candidateExecutionRoot);
  const candidate = await fs.realpath(candidateExecutionRoot);
  if (inside(candidate, workspace.specRoot ?? workspace.executionRoot) || inside(workspace.executionRoot, candidate)) fail('candidate overlaps official execution');
  const candidateTree = await captureExecutionTree(candidate);
  if(currentInitial && (preparationRecord===null || preparationRecord.operation!=='PLAN'
    ||preparationRecord.candidate!==candidate||preparationRecord.source!==null||preparationRecord.expectedActivationId!==null
    ||!equal(preparationRecord.candidateIdentity,candidateTree.identity))) fail('Initial requires its own registered PLAN candidate');
  if(currentInitial)await assertRegisteredPreparationAllocation(workspace,preparationRecord);
  if(currentReplacement && candidateTree.identity.dev!==location.parentIdentity.dev)
    fail('EC-1 local review candidate is not on the official filesystem');
  const allocationId = randomUUID();
  const stage = candidate;
  const retentionRoot = path.join(allocationParent, `.stnl-execution-backup-${allocationId}`);
  const backup = path.join(retentionRoot, 'previous');
  const marker = path.join(allocationParent, `.stnl-execution-publication-${allocationId}.json`);
  const allocation = { format: 'stnl-execution-publication-owner-v1', allocationId, executionRoot: workspace.executionRoot,
    filesystemContext:{productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots},
    filesystemBinding:preparationFilesystemBinding(roots),
    candidate, stage, backup, retentionRoot, expectedActivationId, expectedTree, owner,
    ...(currentReplacement ? {currentReplacement:true,candidateTree} : {currentInitial:true,candidateTree}) };
  const syncReplacement=async(...parents)=>{
    try{for(const parent of new Set(parents))await syncLockParent(parent);}
    catch(error){error.retainExecutionLock=true;throw error;}
  };
  const move=async(from,to)=>{
    try{await fs.rename(from,to);}catch(error){if(currentReplacement)error.retainExecutionLock=true;throw error;}
  };
  let result,markerCreated=false;
  let confirmed = false; let markerWritten = false;
  try {
  result = await withExecutionPublicationLock(workspace, async lease => {
    await assertNoPendingExecutionPublication(workspace);
    await assertPublicationFilesystemBinding(workspace,allocation);
    try {await writeNew(marker, Buffer.from(JSON.stringify(allocation) + '\n'));markerCreated=true;}
    catch(error) {if(currentReplacement){error.candidateRoot=candidate;error.markerCreationFailed=true;}throw error;}
    await fs.mkdir(retentionRoot, { mode: 0o700 });
    if (!equal((await captureExecutionTree(stage)).files, candidateTree.files) || !equal(await captureExecutionTree(candidate), candidateTree)) fail(`candidate changed while staging; retained allocation: ${marker}`);
    await syncReplacement(allocationParent);
    const before = await captureExecutionTree(workspace.executionRoot);
    if (!equal(before, expectedTree)) fail(`publication base changed; retained candidate/allocation: ${marker}`);
    if (currentInitial && (before !== null || expectedActivationId !== null || owner !== null || terminal || draft || prepareRetention))
      fail('EC-1 Initial ingress requires an absent official execution and no predecessor');
    if (currentReplacement && (before === null || expectedActivationId === null || owner !== null
      || terminal || draft || prepareRetention || currentInitial))
      fail('EC-1 local review requires one quiet current predecessor');
    let previous = null;
    if (expectedActivationId !== null) {
      previous = (await readActivated()).activation;
      if (previous.activationId !== expectedActivationId) fail('publication activation CAS conflict');
    }
    if (previous?.activeAttempt) fail('active/uncertain owner blocks replacement');
    await authorizeDiff(stage, before);
    const authority = await validateCandidate(stage);
    if(preparationRecord!==null) {
      if(!currentReplacement&&!currentInitial)fail('registered preparation requires current publication');
      const association=await replacementPreparation(workspace,allocation,{targetRevision:authority.preparationRevision});
      if(!association.binding || !equal(association.binding,preparationBinding(preparationRecord)))
        fail('registered preparation differs from publication source');
      await assertRegisteredPreparationAllocation(workspace,preparationRecord);
    }
    if (currentInitial && authority.preparationRevision !== 1) fail('EC-1 Initial ingress requires preparation revision 1');
    if (!equal((await captureExecutionTree(stage)).files, candidateTree.files)) fail('staged candidate changed during validation');
    await assertExecutionPublicationLock(lease);
    let moved = false; let installed = false;
    try {
      if (checkpoint) await checkpoint('before-backup', { stage, backup, marker });
      if(currentReplacement) await recheckRequirements();
      await assertPublicationFilesystemBinding(workspace,allocation);
      if(preparationRecord!==null)await assertRegisteredPreparationAllocation(workspace,preparationRecord);
      if(!equal(await captureExecutionTree(stage),candidateTree))fail('reviewed candidate changed before backup');
      if (!equal(await captureExecutionTree(workspace.executionRoot),before)) fail('publication base changed immediately before swap');
      await assertExecutionPublicationLock(lease);
      if (before) { await move(workspace.executionRoot, backup); moved = true;
        if(currentReplacement)await syncReplacement(path.dirname(workspace.executionRoot),path.dirname(backup)); }
      if (checkpoint) await checkpoint('after-backup', { stage, backup, marker });
      if(currentReplacement) await recheckRequirements();
      await assertPublicationFilesystemBinding(workspace,allocation);
      if(preparationRecord!==null)await assertRegisteredPreparationAllocation(workspace,preparationRecord);
      if(!equal(await captureExecutionTree(stage),candidateTree))fail('reviewed candidate changed before promotion');
      if (await stat(workspace.executionRoot)) fail('official target unexpectedly occupied');
      if (currentInitial) {
        // The reviewed source is outside the publication lock. Recheck it after
        // every pre-swap checkpoint, while this lock still protects the target.
        await authorizeDiff(stage, before);
        if (!equal(await captureExecutionTree(workspace.executionRoot), before)) fail('publication base changed immediately before Initial swap');
        await assertExecutionPublicationLock(lease);
      }
      await move(stage, workspace.executionRoot); installed = true;
      await syncReplacement(path.dirname(stage),path.dirname(workspace.executionRoot));
      if (checkpoint) await checkpoint('after-install', { stage, backup, marker });
      if (!equal(await captureExecutionTree(workspace.executionRoot),candidateTree)) fail('installed identity or bytes changed');
      let activation = null;
      if (!draft) {
        const snapshotBytes = (await readOwnedFile(path.join(workspace.executionRoot, 'approved-preparation.json'))).bytes;
        activation = { format: 'stnl-execution-activation-v2', activationId: randomUUID(), sequence: (previous?.sequence ?? 0) + 1,
          previousActivationId: previous?.activationId ?? null, preparationRevision: authority.preparationRevision,
          requirementsAuthority: authority.requirementsAuthority, normativeSha256: authority.normativeSha256,
          approvedSnapshotSha256: digest(snapshotBytes), artifacts: currentReplacement
            ? candidateTree.files.filter(item=>item.type==='file' && item.path!=='activation.json')
              .map(item=>({path:item.path,sha256:item.sha256})).sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0)
            : (await officialManifest(workspace.executionRoot)).sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0),
          activeAttempt: previous?.activeAttempt ?? null,
          lastAttempt: currentReplacement ? null : previous?.lastAttempt ?? null };
        if (checkpoint) await checkpoint('before-activation', { stage, backup, marker });
        // Any error after entering this call may have installed the marker. Never compensate blindly.
        allocation.expectedInstalledActivation=activation;
        await persistAllocation(marker,allocation);
        markerWritten = true;
        await syncReplacement(path.dirname(marker));
        if(checkpoint) await checkpoint('after-activation-intent',{stage,backup,marker});
        try{await replaceActivation(workspace.executionRoot, activation);}
        catch(error){if(currentReplacement)error.retainExecutionLock=true;throw error;}
        await syncReplacement(workspace.executionRoot);
        if (checkpoint) await checkpoint('after-activation', { stage, backup, marker });
        try{const readback = await readActivated();
          if (!equal(readback.activation, activation)) fail('activation readback uncertain');}
        catch(error){if(currentReplacement)error.retainExecutionLock=true;throw error;}

      }
      confirmed = true;
      allocation.confirmation = { activationId: activation?.activationId ?? null,
        artifactManifestSha256: digest(JSON.stringify(activation?.artifacts ?? await officialManifest(workspace.executionRoot))),
        terminalOperationAttemptId: null };
      allocation.cleanup = {status:'pending',paths:[backup,retentionRoot,marker],diagnostics:[]};
      try {if(checkpoint) await checkpoint('before-confirmation-persistence',{stage,backup,marker});await persistAllocation(marker, allocation);
        await syncReplacement(path.dirname(marker));} catch(error) {
        if(error.retainExecutionLock)throw error;
        return {publication:'confirmed',cleanup:'pending',cleanupDiagnostics:[`confirmation persistence pending: ${error.message}`],allocation:marker,
          retainedBackup:moved ? backup : null,activation,expectedActivationId:activation?.activationId ?? null};
      }
      if (checkpoint) {
        try { await checkpoint('cleanup', { stage, backup, marker }); } catch (error) {
          if(error.retainExecutionLock)throw error;
          allocation.cleanup = { status: 'pending', paths: [backup,retentionRoot,marker], diagnostics: [error.message] };
          try {await persistAllocation(marker, allocation);} catch(persistenceError) {allocation.cleanup.diagnostics.push(`cleanup persistence pending: ${persistenceError.message}`);}
          return { publication: 'confirmed', cleanup: 'pending', cleanupDiagnostics: [error.message], retainedBackup: moved ? backup : null, allocation: marker, activation, expectedActivationId: activation?.activationId ?? null };
        }
      }
      let retired=null;
      if(preparationRecord!==null) {
        try{retired=await cleanupCurrentReplacement({workspace,marker,record:allocation,lease,readActivated,
          publication:'confirmed',registeredPreparation:true,checkpoint});}
        catch(error) {
          if(error.retainExecutionLock)throw error;
          allocation.cleanup.diagnostics=[error.message];
          try{await persistAllocation(marker,allocation);}
          catch(failure){failure.retainExecutionLock=true;throw failure;}
          return {publication:'confirmed',cleanup:'pending',cleanupDiagnostics:[error.message],allocation:marker,
            retainedBackup:await stat(backup)?backup:null,activation,expectedActivationId:activation.activationId};
        }
      }
      // Retain previous approved snapshots/evidence with their ownership marker until U2 retention policy.
      return { publication: 'confirmed', cleanup: retired?'complete':currentReplacement?'pending':'complete', retainedBackup: retired?null:moved ? backup : null, allocation: marker,
        activation, expectedActivationId: activation?.activationId ?? null };
    } catch (error) {
      if (!confirmed && !markerWritten && !error.retainExecutionLock) {
        try {
          if (installed) {
            if (!equal((await captureExecutionTree(workspace.executionRoot)).files, candidateTree.files)) fail('cannot prove ownership of installed image; preserve backup');
            await move(workspace.executionRoot, stage);
            await syncReplacement(path.dirname(workspace.executionRoot),path.dirname(stage));
          }
          if (moved) {
            if (!equal(await captureExecutionTree(backup), before) || await stat(workspace.executionRoot)) fail('cannot prove restoration ownership');
            if (checkpoint) await checkpoint('before-restore', { stage, backup, marker });
            await move(backup, workspace.executionRoot);
            if(currentReplacement)await syncReplacement(path.dirname(backup),path.dirname(workspace.executionRoot));
          }
        } catch (restoreError) { if(currentReplacement)error.retainExecutionLock=true;error.message += `; restore failed: ${restoreError.message}; retained backup ${backup}, stage ${stage}`; }
      } else error.message += '; activation outcome uncertain; preserve owner and inspect marker before any retry';
      error.allocation = marker;
      if(currentReplacement) error.candidateRoot=candidate;
      throw error;
    }
  });
  } catch(error) {
    if(currentReplacement) {if(markerCreated)error.allocation=marker;error.candidateRoot=candidate;}
    throw error;
  }
  if (result.publication === 'confirmed' && result.cleanup === 'pending') {
    allocation.cleanup = { status: 'pending', paths: allocation.cleanup.paths,
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
export async function persistAllocation(marker, allocation) {
  const previous = await readOwnedFile(marker);
  const temporary = `${marker}.${randomUUID()}.tmp`;
  await writeNew(temporary, Buffer.from(JSON.stringify(allocation, null, 2) + '\n'));
  const current = await readOwnedFile(marker);
  if (!current.bytes.equals(previous.bytes) || !equal(current.identity, previous.identity)) fail('allocation changed before update');
  await fs.rename(temporary, marker);
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
  return (await resolveExecutionFilesystemRoots(workspace)).preparationRegistry;
}
const preparationBinding = record => Object.fromEntries(['allocationId', 'executionRoot', 'specPath', 'candidate',
  'candidateIdentity', 'operation', 'source', 'expectedActivationId', 'preparationRevision', 'filesystemContext', 'filesystemBinding'].map(key => [key, record[key]]));
const preparationFilesystemBinding = roots => ({targetParentIdentity:roots.targetParentIdentity,
  leaseParentIdentity:roots.leaseParentIdentity, materialRootIdentity:roots.materialRootIdentity});
async function assertPublicationFilesystemBinding(workspace, record) {
  const roots=await resolveExecutionFilesystemRoots(workspace);
  if(!equal(record.filesystemContext,{productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots})
    ||!equal(record.filesystemBinding,preparationFilesystemBinding(roots))
    ||path.dirname(record.retentionRoot)!==roots.materialRoot)
    fail('publication physical filesystem binding differs');
  return roots;
}
export function validatePreparationRegistry(record, workspace) {
  closed(record, ['format', 'executionRoot', 'allocations'], 'preparation registry');
  if (record.format !== 'stnl-preparation-registry-v2' || record.executionRoot !== workspace.executionRoot
    || !Array.isArray(record.allocations)) fail('preparation registry execution differs');
  const ids = new Set(), roots = new Set();
  for (const binding of record.allocations) {
    closed(binding, ['allocationId', 'executionRoot', 'specPath', 'candidate', 'candidateIdentity', 'operation',
      'source', 'expectedActivationId', 'preparationRevision', 'filesystemContext', 'filesystemBinding'], 'preparation association');
    const envelope = { ...binding, format: 'stnl-preparation-allocation-v2', producer: 'preparation', retentionRoot: binding.candidate };
    if (binding.executionRoot !== workspace.executionRoot || !hasOwnedAllocationEnvelope(envelope, `${binding.candidate}.owner.json`)
      || ids.has(binding.allocationId) || roots.has(binding.candidate)) fail('invalid/duplicate preparation association');
    ids.add(binding.allocationId); roots.add(binding.candidate);
  }
  return record;
}
export async function assertRegisteredPreparationAllocation(workspace, record) {
  if (record.executionRoot !== workspace.executionRoot) fail('preparation belongs to another official execution');
  const roots = await resolveExecutionFilesystemRoots(workspace);
  if (!equal(record.filesystemContext, {productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots})
    || !equal(record.filesystemBinding, preparationFilesystemBinding(roots))
    || path.dirname(record.candidate) !== roots.materialRoot) fail('preparation filesystem policy or material role differs');
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

// The producer registry remains the preparation authority after promotion. Only
// terminal retirement may accept its already removed root/owner. Authorship
// continues to use assertOwnedPreparationCandidate with the live owned root.
async function replacementPreparation(workspace,record,{targetRevision,registeredPreparation=false,
  terminal=false,materialGone=false}={}) {
  const file=await preparationRegistryPath(workspace);
  let captured=null;
  try{captured=await readOwnedFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  const registry=captured?validatePreparationRegistry(parseStrictJson(captured.bytes.toString('utf8')),workspace):null;
  const binding=registry?.allocations.find(item=>item.candidate===record.candidate)??null;
  const ownerFile=`${record.candidate}.owner.json`;
  let owner=null;
  try{owner=await readOwnedFile(ownerFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(binding) {
    const roots=await resolveExecutionFilesystemRoots(workspace);
    if(!equal(binding.filesystemContext,{productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots})
      ||!equal(binding.filesystemBinding,preparationFilesystemBinding(roots))||path.dirname(binding.candidate)!==roots.materialRoot)
      fail('preparation physical filesystem binding differs during publication or retirement');
    if(binding.operation!==(record.currentInitial===true?'PLAN':'REPLAN')||record.stage!==record.candidate
      ||binding.executionRoot!==record.executionRoot
      ||!equal(binding.candidateIdentity,record.candidateTree.identity)
      ||!equal(binding.source,record.expectedTree)
      ||binding.expectedActivationId!==record.expectedActivationId
      ||binding.preparationRevision!==targetRevision
      ||workspace.authorityPath&&binding.specPath!==workspace.authorityPath)
      fail('preparation and publisher compound binding differs');
    if(owner) {
      const value=parseStrictJson(owner.bytes.toString('utf8'));
      if(!hasOwnedAllocationEnvelope(value,ownerFile)||!equal(preparationBinding(value),binding))
        fail('preparation owner differs from its registry and publisher');
    } else if(!terminal||!materialGone)fail('preparation owner disappeared before terminal retirement');
  } else if(owner||registeredPreparation&&(!terminal||!materialGone))
    fail('registered preparation association is absent before terminal retirement');
  return {file,captured,registry,binding,ownerFile,owner};
}

async function cleanupCurrentReplacement({workspace,marker,record,lease,readActivated,
  publication,registeredPreparation=false,checkpoint=null}) {
  const confirmed=publication==='confirmed';
  const roles=[confirmed?record.backup:record.candidate,record.retentionRoot,marker];
  const persisted=equal(record.cleanup?.paths,roles);
  const paths={marker,stage:record.stage,backup:record.backup,candidate:record.candidate};
  const check=async name=>{if(checkpoint)await checkpoint(name,paths);};
  const sync=async parent=>{
    try{await syncLockParent(parent);}catch(error){error.retainExecutionLock=true;throw error;}
  };
  async function terminal() {
    try {
    await assertExecutionPublicationLock(lease);
    await assertPublicationFilesystemBinding(workspace,record);
    const live=await captureExecutionTree(workspace.executionRoot),candidate=await captureExecutionTree(record.candidate),backup=await captureExecutionTree(record.backup);
    const current=record.currentInitial===true&&!confirmed&&live===null?null:await readActivated();
    if(current!==null&&current.activation.activeAttempt!==null)fail('replacement cleanup has an active owner');
    if(confirmed) {
      if(!equal(current.activation,record.expectedInstalledActivation)||candidate!==null
        ||!live||!equal(live.identity,record.candidateTree.identity)
        ||!equal(live.files.filter(item=>item.path!=='activation.json'),record.candidateTree.files))
        fail('replacement confirmed terminal differs');
      if(backup!==null&&!equal(backup,record.expectedTree))fail('replacement backup contains foreign material');
      if(backup===null&&record.expectedTree!==null&&!equal(record.cleanup?.paths,roles))fail('replacement backup disappeared before owned cleanup');
    } else {
      if(!equal(live,record.expectedTree)||(current?.activation.activationId??null)!==record.expectedActivationId
        ||backup!==null||candidate!==null&&!equal(candidate,record.candidateTree))
        fail('replacement aborted terminal differs');
      if(candidate===null&&!equal(record.cleanup?.paths,roles))fail('replacement candidate disappeared before owned cleanup');
    }
    const retention=await stat(record.retentionRoot);
    if(retention&&(!retention.isDirectory()||retention.isSymbolicLink()))fail('replacement retention role differs');
    return {current,candidate,backup,retention,materialGone:candidate===null&&backup===null&&retention===null,
      targetRevision:record.currentInitial===true?1:confirmed?current.activation.preparationRevision:current.activation.preparationRevision+1};
    }catch(error){error.retainExecutionLock=true;throw error;}
  }
  const before=await terminal();
  if(record.cleanup?.paths?.length&&!persisted)fail('replacement cleanup has foreign roles');
  const association=await replacementPreparation(workspace,record,{targetRevision:before.targetRevision,
    registeredPreparation,terminal:true,materialGone:persisted&&before.materialGone});
  record.cleanup={status:'pending',paths:roles,diagnostics:record.cleanup?.diagnostics??[]};
  await persistAllocation(marker,record);await sync(path.dirname(marker));
  const publisher=await readOwnedFile(marker);
  let removedBinding=null;
  async function criticalAssociation(materialGone=true) {
    try{return await replacementPreparation(workspace,record,{targetRevision:before.targetRevision,
      registeredPreparation,terminal:true,materialGone});}
    catch(error){error.retainExecutionLock=true;throw error;}
  }
  async function samePublisher() {
    let held;
    try{held=await readOwnedFile(marker);}catch(error){if(error.code==='ENOENT')return null;error.retainExecutionLock=true;throw error;}
    if(!held.bytes.equals(publisher.bytes)||!equal(held.identity,publisher.identity)) {
      const error=new Error('replacement publisher identity or bytes changed');error.retainExecutionLock=true;throw error;
    }
    return held;
  }
  async function verifyRegistry(expected,file) {
    try {
      const held=await readOwnedFile(file);
      if(!equal(validatePreparationRegistry(parseStrictJson(held.bytes.toString('utf8')),workspace),expected))
        fail('replacement registry readback differs');
    }catch(error){error.retainExecutionLock=true;throw error;}
  }
  try {
    if(confirmed&&before.backup!==null) {
      if(!equal(await captureExecutionTree(record.backup),record.expectedTree))fail('replacement backup changed before removal');
      await fs.rm(record.backup,{recursive:true});await sync(record.retentionRoot);await check('after-backup-removal');
    }
    if(!confirmed&&before.candidate!==null) {
      if(!equal(await captureExecutionTree(record.candidate),record.candidateTree))fail('replacement candidate changed before removal');
      await fs.rm(record.candidate,{recursive:true});await sync(path.dirname(record.candidate));await check('after-candidate-removal');
    }
    if(await stat(record.retentionRoot)) {
      await fs.rmdir(record.retentionRoot);await sync(path.dirname(record.retentionRoot));await check('after-retention-removal');
    }
    if(!(await terminal()).materialGone)fail('replacement material remains before retirement');
    const tail=await criticalAssociation();
    if(association.binding&&!equal(tail.binding,association.binding))fail('preparation association changed during cleanup');
    if(tail.owner) {
      const held=await readOwnedFile(tail.ownerFile);
      if(!held.bytes.equals(tail.owner.bytes)||!equal(held.identity,tail.owner.identity))fail('preparation owner changed before retirement');
      await fs.unlink(tail.ownerFile);await sync(path.dirname(tail.ownerFile));await check('after-preparation-owner-removal');
    }
    const remaining=await criticalAssociation();
    if(remaining.binding) {
      if(!equal(remaining.binding,tail.binding))fail('preparation entry changed before retirement');
      const next={...remaining.registry,allocations:remaining.registry.allocations.filter(item=>item.allocationId!==remaining.binding.allocationId)};
      removedBinding=structuredClone(remaining.binding);
      await persistAllocation(remaining.file,next);await sync(path.dirname(remaining.file));await verifyRegistry(next,remaining.file);
      await check('after-preparation-entry-removal');
    }
    const retired=await criticalAssociation();
    if(retired.binding||retired.owner||!(await terminal()).materialGone)fail('preparation retirement incomplete');
    if(!await samePublisher())fail('replacement publisher disappeared before final unlink');
    await check('before-publisher-removal');
    await fs.unlink(marker);await sync(path.dirname(marker));await check('after-publisher-removal');
    if(await samePublisher())fail('replacement publisher remains after unlink');
    if(!(await terminal()).materialGone)fail('replacement terminal changed after unlink');
    const absent=await criticalAssociation();
    if(absent.binding||absent.owner)fail('preparation controls reappeared after final unlink');
  } catch(error) {
    error.allocation=marker;error.candidateRoot=record.candidate;
    if(error.retainExecutionLock)throw error;
    const held=await samePublisher();
    if(held) {
      // Compensation is legal only while these exact publisher bytes and root
      // identity still prove the terminal operation. No resurrection on loss
      // of acknowledgment after unlink, and no inference from unlink errors.
      if(removedBinding) {
        const pending=await criticalAssociation();
        if(pending.binding&&!equal(pending.binding,removedBinding)) {error.retainExecutionLock=true;throw error;}
        if(!pending.binding) {
          if(!pending.registry) {error.retainExecutionLock=true;throw error;}
          const restored={...pending.registry,allocations:[...pending.registry.allocations,removedBinding]};
          try{validatePreparationRegistry(restored,workspace);await persistAllocation(pending.file,restored);
            await sync(path.dirname(pending.file));await verifyRegistry(restored,pending.file);}
          catch(failure){failure.retainExecutionLock=true;failure.allocation=marker;throw failure;}
        }
      }
      throw error;
    }
    // A completed unlink with a lost acknowledgment must not restore the old
    // association. Prove every remaining absence and the current terminal.
    try {
      await sync(path.dirname(marker));
      const absent=await criticalAssociation();
      if(absent.binding||absent.owner||!(await terminal()).materialGone)fail('publisher absent with pending replacement controls');
    }catch(failure){failure.retainExecutionLock=true;failure.allocation=marker;throw failure;}
  }
  return {publication,cleanup:'complete',classification:'disposable',
    expectedActivationId:confirmed?record.expectedInstalledActivation.activationId:record.expectedActivationId};
}
// Creates its own destination. There is no API to adopt/register an existing root.
export async function allocatePreparationCandidate({ workspace, lease, captureParent, metadata }) {
  await assertExecutionPublicationLock(lease);
  if (lease.executionRoot !== workspace.executionRoot) fail('preparation lease differs');
  await assertNoPendingExecutionPublication(workspace);
  const roots = await resolveExecutionFilesystemRoots(workspace);
  if (captureParent !== roots.materialRoot || roots.materialRootIdentity === null) fail('preparation parent is not the resolved material root');
  const source = await captureExecutionTree(workspace.executionRoot);
  const root = await fs.realpath(await fs.mkdtemp(path.join(captureParent, 'stnl-preparation-')));
  if (source) await fs.cp(workspace.executionRoot, root, { recursive: true });
  const tree = await captureExecutionTree(root);
  if (source && !equal(tree.files, source.files)) fail('preparation source changed during copy');
  const record = { ...metadata, format: 'stnl-preparation-allocation-v2', producer: 'preparation', allocationId: randomUUID(),
    filesystemContext:{productRoot:roots.productRoot,temporaryRoot:roots.temporaryRoot,excludedRoots:roots.excludedRoots},
    filesystemBinding:preparationFilesystemBinding(roots),
    candidate: root, retentionRoot: root, candidateIdentity: tree.identity, executionRoot: workspace.executionRoot, source };
  if (!hasOwnedAllocationEnvelope(record, `${root}.owner.json`)) fail('invalid preparation producer metadata');
  await writeNew(`${root}.owner.json`, Buffer.from(JSON.stringify(record) + '\n'));
  const file = await preparationRegistryPath(workspace);
  const existing = await stat(file);
  const registry = existing ? validatePreparationRegistry(parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8')), workspace)
    : { format: 'stnl-preparation-registry-v2', executionRoot: workspace.executionRoot, allocations: [] };
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
    const localReviewStage=(record.currentReplacement===true||record.currentInitial===true) && record.owner===null
      && record.stage===record.candidate && record.candidateTree?.files;
    const publicationOrigin=publisher && Object.hasOwn(record,'expectedActivationId') && Object.hasOwn(record,'expectedTree')
      && path.isAbsolute(record.candidate ?? '') && (localReviewStage
        || record.currentReplacement===undefined && record.stage===path.join(parent,`.stnl-execution-stage-${record.allocationId}`))
      && record.backup===path.join(record.retentionRoot,'previous');
    if(record.retention) return ['preparation-publication','operational-publication','operation-admission','pass-reopening'].includes(record.retention.producer)
      && Object.hasOwn(record,'owner') && equal(record.retention.owner,owner)
      && (record.retention.producer==='operation-admission' ? !!owner : publicationOrigin);
    const firstInitial = record.owner===null && record.expectedActivationId===null && record.expectedTree===null;
    const quietReplacement=record.owner===null && uuid(record.expectedActivationId) && record.expectedTree?.files;
    return publicationOrigin && ((owned && uuid(record.expectedActivationId) && record.expectedTree?.files)
      || firstInitial || quietReplacement);
  }
  if(record.retentionRoot!==record.candidate) return false;
  // v1 is recognized only so an old marked allocation cannot become SPEC_PATH.
  // Operational admission/registry/classification above require v2 explicitly.
  if(['stnl-preparation-allocation-v1','stnl-preparation-allocation-v2'].includes(record.format)) {
    if(record.format==='stnl-preparation-allocation-v2') {
    let policy;
    try{policy=normalizeExecutionFilesystemPolicy(record.filesystemContext);}catch{return false;}
    if(policy===null || !record.filesystemBinding
      || Object.keys(record.filesystemBinding).sort().join(',')!=='leaseParentIdentity,materialRootIdentity,targetParentIdentity'
      || !Object.values(record.filesystemBinding).every(hasPhysicalIdentity)
      || path.dirname(record.candidate)!==path.join(policy.temporaryRoot,createHash('sha256').update(record.executionRoot,'utf8').digest('hex')))
      return false;
    }
    return record.producer==='preparation' && marker===`${record.candidate}.owner.json`
    && ['PLAN','REPLAN','REVIEW_PLAN'].includes(record.operation) && path.isAbsolute(record.specPath ?? '')
    && hasPhysicalIdentity(record.candidateIdentity) && hasCapturedSource(record.source)
    && Number.isSafeInteger(record.preparationRevision) && record.preparationRevision>0
    && (record.expectedActivationId===null || uuid(record.expectedActivationId))
    && (record.source?.files.some(entry=>entry.path==='activation.json') ?? false)===(record.expectedActivationId!==null);
  }
  if(!owned) return false;
  if(record.format==='stnl-runner-allocation-v1') return record.producer==='native-runner'
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
  if(record.format==='stnl-preparation-allocation-v2') await assertRegisteredPreparationAllocation(workspace,record);
  if (record.executionRoot !== workspace.executionRoot) fail('allocation belongs to another execution');
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(record.allocationId) || !path.isAbsolute(record.retentionRoot)
    || !['stnl-execution-publication-owner-v1','stnl-runner-allocation-v1','stnl-preparation-allocation-v2'].includes(record.format)
      && !['execution-copy','validation-copy'].includes(record.producer)) fail('allocation identity/producer is not positively established');
  await ancestry(record.retentionRoot);
  if(record.retention || !['stnl-execution-publication-owner-v1','stnl-preparation-allocation-v2'].includes(record.format))fail('Unsupported allocation producer; preserve it');
  for(const root of [record.candidate,record.stage,record.backup,record.retentionRoot].filter(Boolean)) {await ancestry(root);if(inside(root,workspace.executionRoot)||inside(workspace.executionRoot,root)) fail('allocation overlaps official execution');}
  const active = activation?.activeAttempt;
  if (active && record.owner && ['operationAttemptId','ownershipToken','deliveryId','slice','operation','originActivationId'].every(k=>record.owner[k]===active[k])) return { classification: 'active', record };
  if(record.producer==='preparation' && !active && !record.confirmation
    && record.expectedActivationId===(activation?.activationId ?? null)
    && equal(record.source,await captureExecutionTree(workspace.executionRoot))) return {classification:'active',record};
  if (!record.confirmation) return { classification: 'diagnostic', record };
  if (record.confirmation.activationId !== activation?.activationId) return { classification: 'diagnostic', record };
  const soleCopy = (record.retention?.retainedPaths.length ?? 0) > 0 || (record.backup && await stat(record.backup));
  return { classification: soleCopy ? 'diagnostic' : 'disposable', record };
}

// The local review promotes its one approved candidate directly. The v1 owner
// marker already binds the old tree, candidate identity, and activation intent.
export async function recoverCurrentReplacementPublication({workspace,marker,readActivated,
  validateInstalledActivation,registeredPreparation=false,checkpoint=null}) {
  const roots=await resolveExecutionFilesystemRoots(workspace);
  if(path.dirname(marker)!==roots.materialRoot)fail('recovery allocation belongs to another execution or physical namespace');
  return withExecutionPublicationLock(workspace,async lease=>{
    const record=parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8'));
    await assertPublicationFilesystemBinding(workspace,record);
    if(!hasOwnedAllocationEnvelope(record,marker) || record.currentReplacement!==true&&record.currentInitial!==true
      || record.executionRoot!==workspace.executionRoot || record.owner!==null
      || record.stage!==record.candidate || (record.currentInitial===true?record.expectedTree!==null:!record.expectedTree?.files)
      || !record.candidateTree?.files || record.backup!==path.join(record.retentionRoot,'previous'))
      fail('local review recovery owner differs');
    const old=record.expectedTree,proposed=record.candidateTree;
    const live=await captureExecutionTree(workspace.executionRoot);
    const candidate=await captureExecutionTree(record.candidate);
    const backup=await captureExecutionTree(record.backup);
    const exact=(a,b)=>equal(a,b);
    const proposedInstalled=live!==null&&equal(live.identity,proposed.identity)
      &&equal(live.files.filter(item=>item.path!=='activation.json'),proposed.files);
    if(backup!==null&&!exact(backup,old))fail('local review prior backup differs');
    if(candidate!==null&&!exact(candidate,proposed))fail('local review candidate differs');
    // Verify the registry/publisher relation before restoration as well as
    // retirement; an unrelated association grants no recovery authority.
    const authorityRoot=candidate!==null?record.candidate:workspace.executionRoot;
    const snapshot=record.currentInitial===true?null:parseStrictJson((await readOwnedFile(path.join(authorityRoot,'approved-preparation.json'))).bytes.toString('utf8'));
    const targetRevision=record.currentInitial===true?1:exact(live,old)&&candidate===null?snapshot.preparationRevision+1:snapshot.preparationRevision;
    const materialGone=candidate===null&&backup===null&&await stat(record.retentionRoot)===null;
    const retiredRoles=equal(record.cleanup?.paths,[record.backup,record.retentionRoot,marker])
      ||equal(record.cleanup?.paths,[record.candidate,record.retentionRoot,marker]);
    await replacementPreparation(workspace,record,{targetRevision,registeredPreparation,
      terminal:true,materialGone:materialGone&&retiredRoles});
    if(record.expectedInstalledActivation&&proposedInstalled&&live.files.some(item=>item.path==='activation.json')) {
      validateInstalledActivation(record.expectedInstalledActivation);
      const activation=parseStrictJson((await readOwnedFile(path.join(workspace.executionRoot,'activation.json'))).bytes.toString('utf8'));
      if(!equal(activation,record.expectedInstalledActivation))fail('local review activation outcome is uncertain');
      const current=await readActivated();
      if(!equal(current.activation,activation)||current.activation.activeAttempt!==null||candidate!==null)
        fail('local review confirmed readback or roles differ');
      const confirmation={activationId:activation.activationId,
        artifactManifestSha256:digest(JSON.stringify(activation.artifacts)),terminalOperationAttemptId:null};
      if(record.confirmation&&!equal(record.confirmation,confirmation))fail('local review confirmation differs');
      record.confirmation=confirmation;
      return cleanupCurrentReplacement({workspace,marker,record,lease,readActivated,
        publication:'confirmed',registeredPreparation,checkpoint});
    }
    if(record.currentInitial===true&&proposedInstalled&&candidate===null&&!live.files.some(item=>item.path==='activation.json')) {
      await assertExecutionPublicationLock(lease);
      try{await fs.rename(workspace.executionRoot,record.candidate);
        await syncLockParent(path.dirname(workspace.executionRoot));await syncLockParent(path.dirname(record.candidate));}
      catch(error){error.retainExecutionLock=true;throw error;}
    } else if(backup===null) {
      if(!exact(live,old)||candidate!==null&&!exact(candidate,proposed))fail('local review unswapped roles differ');
    } else if(live===null) {
      if(!exact(candidate,proposed))fail('local review preinstall candidate differs');
    } else if(proposedInstalled&&candidate===null&&!live.files.some(item=>item.path==='activation.json')) {
      await assertExecutionPublicationLock(lease);
      try{await fs.rename(workspace.executionRoot,record.candidate);await syncLockParent(path.dirname(workspace.executionRoot));await syncLockParent(path.dirname(record.candidate));}
      catch(error){error.retainExecutionLock=true;throw error;}
    } else fail('local review unconfirmed roles differ');
    if(backup!==null) {
      if(await stat(workspace.executionRoot)||!exact(await captureExecutionTree(record.backup),old))
        fail('local review previous image changed before restoration');
      await assertExecutionPublicationLock(lease);
      try{await fs.rename(record.backup,workspace.executionRoot);await syncLockParent(path.dirname(workspace.executionRoot));await syncLockParent(record.retentionRoot);}
      catch(error){error.retainExecutionLock=true;throw error;}
    }
    return cleanupCurrentReplacement({workspace,marker,record,lease,readActivated,
      publication:'aborted',registeredPreparation,checkpoint});
  });
}

export async function cleanupOwnedExecutionAllocation({ workspace, marker, readActivated, checkpoint = null,
  validateInstalledActivation = validateActivation, currentReplacement = false, registeredPreparation = false }) {
  if(currentReplacement)return recoverCurrentReplacementPublication({workspace,marker,readActivated,
    validateInstalledActivation,registeredPreparation,checkpoint});
  async function acknowledge(record, result) {
    try {
      if(checkpoint) await checkpoint('before-cleanup-acknowledgment', {marker});
      await persistAllocation(marker, record);
      return result;
    } catch(error) {
      if(error.retainExecutionLock)throw error;
      return {...result,publication:'confirmed',cleanup:'pending',cleanupDiagnostics:[`cleanup acknowledgment pending: ${error.message}`]};
    }
  }
  return withExecutionPublicationLock(workspace, async lease => {
    const current = await readActivated();
    const original=(await readOwnedFile(marker)).bytes;
    await assertPublicationFilesystemBinding(workspace,parseStrictJson(original.toString('utf8')));
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
