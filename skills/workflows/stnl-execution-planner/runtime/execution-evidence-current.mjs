import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCurrentJson, logicalArtifactPath, validateCurrentEvidence } from './execution-current.mjs';
import {
  RunnerSemanticResultError, assertRunnerVerdictConsistency, assertExecutionResultScope,
  deriveCanonicalRunnerRejection, recoverableRunnerResultDiagnostic,
  parseSemanticExecutionPayload, serializeMarkdownScalar, serializeCommand,
  executionFields, isExplanatoryExecutionField, MAX_NATIVE_PRODUCER_TURNS, nativeCheckRoundMatches, validateReviewTriage,
} from './runner-result-contract.mjs';
import { verifyCapturedInvocation, verifyWorkObservation, packCaptureSources, restoreCaptureSources,
  closeEvidenceObjects, projectNativeJudgment, NATIVE_JUDGMENT_VARIANT, findingsRoundCaptureSha256 } from './execution-evidence-proof.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const raw = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const utf8 = text => Buffer.from(text, 'utf8');
const hex = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const invalid = message => fail('INVALID_CURRENT_IMAGE', message);
const incomplete = message => fail('EVIDENCE_INCOMPLETE', message);
const stale = message => fail('EVIDENCE_STALE', message);
const uncertain = message => fail('OWNER_UNCERTAIN', message);
const mismatch = message => fail('OWNER_MISMATCH', message);
const unsafe = message => fail('UNSAFE_PATH', message);
function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(`${label}: plain object required`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(item => !Object.hasOwn(item, 'value') || !item.enumerable)) invalid(`${label}: non-data property`);
  return value;
}
function closed(value, keys, label) {
  plain(value, label);
  if (Object.keys(value).sort(ordinal).join('\0') !== [...keys].sort(ordinal).join('\0')) invalid(`${label}: fields differ`);
  return value;
}
function dense(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < min || value.length > max || Object.keys(value).length !== value.length
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable))) invalid(`${label}: dense array required`);
  return value;
}
function str(value, label, nonempty = true) {
  if (typeof value !== 'string' || value.includes('\0') || (nonempty && value.trim() === '') || !isWellFormed(value)) invalid(`${label}: invalid string`);
  return value;
}
function isWellFormed(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { if (!(value.charCodeAt(++i) >= 0xdc00 && value.charCodeAt(i) <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function token(value, pattern, label) { str(value, label); if (!pattern.test(value)) invalid(`${label}: invalid token`); return value; }
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) invalid(`${label}: invalid integer`);
  return value;
}
function bytes(value, label) {
  if (!(value instanceof Uint8Array) || (Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value))
    || Reflect.ownKeys(value).length !== value.length) invalid(`${label}: bytes required`);
  return Buffer.from(value);
}
function textBytes(value, label) {
  const copy = bytes(value, label);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(copy); } catch { invalid(`${label}: invalid UTF-8`); }
  if (text.startsWith('\ufeff') || text.includes('\0') || !isWellFormed(text) || !utf8(text).equals(copy)) invalid(`${label}: noncanonical UTF-8`);
  return { bytes: copy, text };
}
function jsonBytes(value, label) {
  const decoded = textBytes(value, label);
  try { return { ...decoded, value: parseCurrentJson(decoded.text) }; }
  catch (error) { fail(error.code ?? 'INVALID_CURRENT_IMAGE', `${label}: ${error.message}`); }
}
function canonical(value, signedNumbers = false) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') { str(value, 'canonical', false); return JSON.stringify(value); }
  if (typeof value === 'number') { integer(value, 'canonical', signedNumbers ? Number.MIN_SAFE_INTEGER : 0); return String(value); }
  if (Array.isArray(value)) return `[${dense(value, 'canonical').map(item => canonical(item, signedNumbers)).join(',')}]`;
  plain(value, 'canonical');
  return `{${Object.keys(value).sort(ordinal).map(key => `${canonical(key)}:${canonical(value[key], signedNumbers)}`).join(',')}}`;
}
const same = (a, b) => canonical(a, true) === canonical(b, true);
const serialized = value => utf8(`${canonical(value)}\n`);
function projected(tag, value) { return raw(Buffer.concat([utf8(`stnl-ec1/${tag}/v1`), Buffer.from([0]), utf8(canonical(value))])); }
function expectEqual(actual, expected, code, label) { if (!same(actual, expected)) fail(code, `${label}: binding differs`); }
function ownerShape(value, label) {
  closed(value, ['operationAttemptId', 'ownershipToken', 'deliveryId', 'slice', 'operation', 'preparationRevision', 'localRevision', 'normativeSha256', 'originActivationId'], label);
  for (const key of ['operationAttemptId', 'ownershipToken', 'deliveryId', 'originActivationId']) token(value[key], UUID, `${label}.${key}`);
  canonicalSlice(value.slice, `${label}.slice`);
  token(value.normativeSha256, HASH, `${label}.normativeSha256`);
  str(value.operation, `${label}.operation`);
  integer(value.preparationRevision, `${label}.preparationRevision`, 1);
  integer(value.localRevision, `${label}.localRevision`, 1);
}
function canonicalSlice(value, label) {
  token(value, /^slice-([0-9]{2,})$/u, label);
  const digits = value.slice('slice-'.length);
  const ordinalNumber = Number(digits);
  if (!Number.isSafeInteger(ordinalNumber) || ordinalNumber < 1 || String(ordinalNumber).padStart(2, '0') !== digits) invalid(`${label}: noncanonical slice`);
  return value;
}
function ownerMatches(value, expected, label) {
  if (value && typeof value === 'object' && !Object.hasOwn(value, 'localRevision') && (value.imported === true || value.operationAttemptId)) fail('UNSUPPORTED_FORMAT', `${label}: old owner lacks local revision`);
  ownerShape(value, label);
  expectEqual(value, expected, 'OWNER_MISMATCH', label);
}
function relative(value, label) {
  str(value, label);
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
    || value.endsWith('/') || value.split('/').some(part => !part || part === '.') || path.posix.normalize(value) !== value) unsafe(`${label}: unsafe relative path`);
  return value;
}
function artifactRelative(value, label) {
  str(value, label);
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
    || value.endsWith('/') || value.split('/').some(part => !part || part === '.')
    || path.posix.normalize(value) !== value) unsafe(`${label}: unsafe artifact-relative path`);
  return value;
}
function productRelative(context, target, label) {
  const rel = path.relative(context.productRoot, target).split(path.sep).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) unsafe(`${label}: outside product`);
  return relative(rel, label);
}
function work(value, label) {
  closed(value, ['format', 'entries'], label);
  if (value.format !== 'stnl-current-work-v1') fail('CURRENT_FORMAT_REQUIRED', `${label}: current WorkManifest required`);
  dense(value.entries, `${label}.entries`, 0, 10000);
  const byPath = new Map();
  for (const entry of value.entries) {
    plain(entry, `${label}.entry`);
    if (entry.kind === 'file') {
      closed(entry, ['path', 'kind', 'sha256', 'mode'], `${label}.entry`);
      token(entry.sha256, HASH, `${label}.hash`); integer(entry.mode, `${label}.mode`, 0, 511);
    } else if (entry.kind === 'directory') {
      closed(entry, ['path', 'kind', 'children'], `${label}.entry`);
      dense(entry.children, `${label}.children`);
      let prev = null;
      for (const child of entry.children) {
        relative(child, `${label}.child`);
        if (child.includes('/') || (prev !== null && ordinal(prev, child) >= 0)) invalid(`${label}: children unordered`);
        prev = child;
      }
    } else if (entry.kind === 'absent') closed(entry, ['path', 'kind'], `${label}.entry`);
    else invalid(`${label}: unknown entry kind`);
    relative(entry.path, `${label}.path`);
    if (byPath.has(entry.path)) invalid(`${label}: duplicate path`);
    byPath.set(entry.path, entry);
  }
  if (value.entries.some((entry, index) => index && ordinal(value.entries[index - 1].path, entry.path) >= 0)) invalid(`${label}: entries unordered`);
  for (const entry of value.entries) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = byPath.get(parts.slice(0, i).join('/'));
      if (!parent || parent.kind !== 'directory'
        || (i < parts.length - 1 && !parent.children.includes(parts[i]))
        || (i === parts.length - 1 && parent.children.includes(parts[i]) === (entry.kind === 'absent'))) incomplete(`${label}: missing parent/child closure ${entry.path}`);
    }
    if (entry.kind === 'directory') for (const child of entry.children) {
      const present = byPath.get(`${entry.path}/${child}`);
      if (!present || present.kind === 'absent') incomplete(`${label}: missing present child ${child}`);
    }
  }
  return byPath;
}
function coverage(manifest, claims, label) {
  const byPath = work(manifest, label);
  for (const item of claims) {
    const entry = byPath.get(item.path);
    if (!entry) incomplete(`${label}: missing declared ${item.path}`);
    if (item.kind === 'input' && entry.kind !== 'file') stale(`${label}: Existing Input is not a file ${item.path}`);
    if (item.kind === 'directory' && entry.kind === 'file') stale(`${label}: declared directory is a file ${item.path}`);
    if (['file','product'].includes(item.kind) && entry.kind === 'directory') stale(`${label}: declared file is a directory ${item.path}`);
  }
  for (const [name, entry] of byPath) {
    if (!claims.some(item => item.path === name || item.path.startsWith(`${name}/`)
      || (item.kind === 'directory' && name.startsWith(`${item.path}/`)))) incomplete(`${label}: unexpected domain member ${name}`);
    if (entry.kind === 'file' && !HASH.test(entry.sha256)) invalid(`${label}: invalid file hash`);
  }
  return byPath;
}
function baseline(value, owner, round, context, claims, label) {
  closed(value, ['format', 'owner', 'round', 'context', 'manifest'], label);
  if (value.format !== 'stnl-current-baseline-v1') fail('CURRENT_FORMAT_REQUIRED', `${label}: baseline format`);
  ownerMatches(value.owner, owner, `${label}.owner`);
  if (value.round !== round) mismatch(`${label}: round differs`);
  expectEqual(value.context, context, 'EVIDENCE_STALE', `${label}.context`);
  coverage(value.manifest, claims, `${label}.manifest`);
  return value.manifest;
}

function guard(input, validating = false) {
  plain(input, 'initial evidence input');
  if (Object.hasOwn(input, 'imported') && input.imported === true) fail('UNSUPPORTED_FORMAT', 'evidence format is not supported');
  closed(input, ['context', 'authority', 'owner', 'currentEvidence', 'counters', validating ? 'bundleBytes' : 'rounds'], 'initial evidence input');
  closed(input.authority, ['preparationRevision', 'localRevision', 'normativeSha256', 'delivery', 'context'], 'authority');
  closed(input.authority.context, ['requirementsAuthority', 'objective', 'strategy', 'risks'], 'authority.context');
  closed(input.counters, ['implementationChecks', 'findingsChecks', 'validationAttempts', 'findings'], 'counters');
  plain(input.owner, 'owner');
  if (!Object.hasOwn(input.owner, 'localRevision') && Object.hasOwn(input.owner, 'operationAttemptId')) fail('UNSUPPORTED_FORMAT', 'old owner lacks local revision');
  ownerShape(input.owner, 'owner');
  if (!Number.isSafeInteger(input.authority.preparationRevision) || input.authority.preparationRevision<1
    || !Number.isSafeInteger(input.authority.localRevision) || input.authority.localRevision<1
    || input.authority.preparationRevision!==input.owner.preparationRevision
    || input.authority.localRevision!==input.owner.localRevision || input.owner.operation !== 'EXECUTE_SLICE'
    || input.currentEvidence===null && Object.values(input.counters).some(item=>!Object.is(item,0))
    || input.currentEvidence!==null && !(input.currentEvidence instanceof Uint8Array)) invalid('initial EXECUTE_SLICE authority required');
  if(validating&&(input.currentEvidence!==null||Object.values(input.counters).some(item=>!Object.is(item,0))))
    invalid('initial validator requires the complete original zero-counter boundary');
  const delivery = input.authority.delivery;
  closed(delivery, ['deliveryId', 'objectiveAndObservableResult', 'requirements', 'includedScope', 'outOfScopeAndBoundaries', 'authorizedAreas', 'existingInputs', 'protectedResponsibilities', 'dependencies', 'risksAndStrategy', 'expectedTests', 'verificationRecipe', 'completionCriterion', 'taskResult', 'obligations'], 'delivery');
  token(delivery.deliveryId, UUID, 'delivery.deliveryId');
  if (input.authority.normativeSha256 !== input.owner.normativeSha256
    || delivery.deliveryId !== input.owner.deliveryId
    || input.authority.preparationRevision>1&&input.authority.normativeSha256!==projected('delivery',delivery)) mismatch('owner authority differs');
  token(input.authority.normativeSha256, HASH, 'authority.normativeSha256');
  token(input.authority.context.requirementsAuthority, HASH, 'authority.requirementsAuthority');
  for (const field of ['objective', 'strategy', 'risks']) str(input.authority.context[field], `authority.${field}`);
  // The L1 logical path helper validates the complete EC-1 ImageContext.
  logicalArtifactPath(input.context, `tasks/${input.owner.slice}.md`);
  for (const field of ['objectiveAndObservableResult', 'requirements', 'includedScope', 'outOfScopeAndBoundaries', 'authorizedAreas', 'existingInputs', 'protectedResponsibilities', 'risksAndStrategy', 'expectedTests', 'completionCriterion', 'taskResult']) str(delivery[field], `delivery.${field}`);
  dense(delivery.dependencies, 'delivery.dependencies');
  for (const dependency of delivery.dependencies) token(dependency, UUID, 'delivery.dependency');
  if (new Set(delivery.dependencies).size !== delivery.dependencies.length || delivery.dependencies.includes(delivery.deliveryId)) invalid('delivery: invalid dependencies');
  dense(delivery.obligations, 'delivery.obligations', 1);
  const obligationIds = new Set();
  for (const obligation of delivery.obligations) {
    closed(obligation, ['id','requirement','contribution','fullOwner','condition','proof'], 'delivery.obligation');
    token(obligation.id, /^obligation-[0-9]{2,}$/u, 'delivery.obligation.id');
    token(obligation.requirement, /^[A-Z][A-Z0-9]*-[0-9]+$/u, 'delivery.obligation.requirement');
    if (!['complete','partial'].includes(obligation.contribution)) invalid('delivery.obligation.contribution');
    if (typeof obligation.fullOwner !== 'string') invalid('delivery.obligation.fullOwner');
    if (obligation.fullOwner.startsWith('delivery:')) token(obligation.fullOwner.slice(9), UUID, 'delivery.obligation.fullOwner');
    else canonicalSlice(obligation.fullOwner, 'delivery.obligation.fullOwner');
    str(obligation.condition, 'delivery.obligation.condition'); str(obligation.proof, 'delivery.obligation.proof');
    if (obligationIds.has(obligation.id)) invalid('delivery: duplicate obligation');
    obligationIds.add(obligation.id);
  }
  // Canonical serialization also rejects descriptors, malformed strings and non-JSON nested values.
  canonical(input.context); canonical(input.authority); canonical(input.owner);
  if (validating) bytes(input.bundleBytes, 'bundleBytes');
  else dense(input.rounds, 'rounds', 1, MAX_NATIVE_PRODUCER_TURNS);
  return verifyWorkObservation('initial-implementation',{context:input.context,delivery,slice:input.owner.slice});
}
function relativeTask(context, absolutePath, slice) {
  const rel = path.relative(path.dirname(logicalArtifactPath(context, `tasks/${slice}.md`)), absolutePath).split(path.sep).join('/');
  if (!rel || rel === '.') unsafe('tested state path aliases task');
  return rel;
}
function changedLeaves(before, after) {
  const prior = new Map(before.entries.map(item => [item.path, item]));
  const current = new Map(after.entries.map(item => [item.path, item]));
  return [...new Set([...prior.keys(), ...current.keys()])].sort(ordinal).filter(name => {
    const left = prior.get(name), right = current.get(name);
    return (left?.kind === 'file' || right?.kind === 'file') && !same(left ?? null, right ?? null);
  });
}
function areaContains(areas, name) {
  return areas.some(item => item.path === name || (item.kind === 'directory' && name.startsWith(`${item.path}/`)));
}
function verifyRemoval(proofs, owner, round, before, after) {
  const prior = new Map(before.entries.map(entry => [entry.path, entry]));
  const current = new Map(after.entries.map(entry => [entry.path, entry]));
  const required = changedLeaves(before, after).filter(name => prior.get(name)?.kind === 'file' && current.get(name)?.kind === 'absent');
  if (proofs.length !== required.length) incomplete(`round ${round}: removal proof count`);
  const names = [];
  for (const [index, blob] of proofs.entries()) {
    const proof = jsonBytes(blob, `round ${round} removalProof ${index + 1}`).value;
    closed(proof, ['format','owner','round','path','sha256','mode','bytesBase64'], `round ${round} removalProof`);
    if (proof.format !== 'stnl-current-removal-proof-v1') fail('CURRENT_FORMAT_REQUIRED', `round ${round}: removal proof format`);
    ownerMatches(proof.owner, owner, `round ${round} removal owner`);
    if (proof.round !== round) mismatch(`round ${round}: removal round`);
    relative(proof.path, `round ${round} removal path`);
    const old = prior.get(proof.path);
    if (!old || old.kind !== 'file' || current.get(proof.path)?.kind !== 'absent'
      || proof.sha256 !== old.sha256 || proof.mode !== old.mode) incomplete(`round ${round}: removal has no real baseline file`);
    if (typeof proof.bytesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(proof.bytesBase64)) incomplete(`round ${round}: invalid removal base64`);
    const product = Buffer.from(proof.bytesBase64, 'base64');
    if (product.toString('base64') !== proof.bytesBase64 || raw(product) !== old.sha256) incomplete(`round ${round}: removal bytes/hash`);
    names.push(proof.path);
  }
  if (!same(names.sort(ordinal), required)) incomplete(`round ${round}: removal proof path set`);
}
function domainChanges(before, after, info, round) {
  const priorMap = new Map(before.entries.map(entry => [entry.path, entry]));
  const afterMap = new Map(after.entries.map(entry => [entry.path, entry]));
  const deltas = changedLeaves(before, after);
  for (const prior of before.entries) if (!afterMap.has(prior.path)) stale(`round ${round}: prior domain member omitted ${prior.path}`);
  const priorDirectories = new Map(before.entries.filter(entry => entry.kind === 'directory').map(entry => [entry.path,entry]));
  const afterDirectories = new Map(after.entries.filter(entry => entry.kind === 'directory').map(entry => [entry.path,entry]));
  for (const name of new Set([...priorDirectories.keys(),...afterDirectories.keys()])) {
    const left=priorDirectories.get(name), right=afterDirectories.get(name);
    if (!left || !right) {
      if (!areaContains(info.areas,name) || !deltas.some(delta => delta.startsWith(`${name}/`))) stale(`round ${round}: unexplained directory domain change ${name}`);
      continue;
    }
    for (const child of new Set([...left.children,...right.children])) {
      if (left.children.includes(child) !== right.children.includes(child)
        && !deltas.some(delta => delta === `${name}/${child}` || delta.startsWith(`${name}/${child}/`))) stale(`round ${round}: unexplained directory child ${name}/${child}`);
    }
  }
  for (const name of deltas) if (!areaContains(info.areas, name)) stale(`round ${round}: out-of-area delta ${name}`);
  for (const item of info.inputs) if (!areaContains(info.areas, item.path)) {
    if (!same(priorMap.get(item.path), afterMap.get(item.path))) stale(`round ${round}: exclusive input changed`);
  }
  return deltas;
}
function testedState(value, context, owner, before, after, info, round, retainedRemovals=new Set()) {
  closed(value, ['workspace','sourceTaskPath','entries'], `round ${round} testedState`);
  if (value.workspace !== context.productRoot || value.sourceTaskPath !== logicalArtifactPath(context, `tasks/${owner.slice}.md`)) stale(`round ${round}: tested state context`);
  dense(value.entries, `round ${round} testedState.entries`);
  const afterMap = new Map(after.entries.map(entry => [entry.path, entry]));
  const priorMap = new Map(before.entries.map(entry => [entry.path, entry]));
  let previous = null;
  const selected = new Map();
  for (const entry of value.entries) {
    closed(entry, ['path','value'], `round ${round} tested entry`);
    artifactRelative(entry.path, `round ${round} tested path`);
    if (previous !== null && ordinal(previous, entry.path) >= 0) invalid(`round ${round}: tested entries unordered`);
    previous = entry.path;
    const target = path.resolve(path.dirname(value.sourceTaskPath), entry.path);
    const productPath = productRelative(context, target, `round ${round} tested path`);
    const state = afterMap.get(productPath);
    if (!areaContains(info.areas, productPath) || !state || state.kind === 'directory') stale(`round ${round}: tested target outside areas/domain`);
    if (entry.value !== (state.kind === 'file' ? state.sha256 : 'REMOVED')) stale(`round ${round}: tested state hash/removal`);
    if (state.kind === 'absent' && priorMap.get(productPath)?.kind !== 'file' && !retainedRemovals.has(productPath)) incomplete(`round ${round}: absent was not removed`);
    selected.set(productPath, entry);
  }
  const deltas = domainChanges(before, after, info, round);
  for (const name of deltas) if (!selected.has(name)) stale(`round ${round}: unrecorded delta ${name}`);
  return value.entries;
}
function renderRecord(id, owner, payload, entries, commands, correctionPaths) {
  const scalar = (label, value) => serializeMarkdownScalar(label, value, isExplanatoryExecutionField(label));
  const fields = Object.fromEntries(executionFields('EXECUTE_SLICE').map(([key, label]) => [label, payload[key]]));
  const tested = entries.length ? `- Tested state:\n${entries.map(entry => `  - \`${entry.path}\` | ${entry.value}`).join('\n')}`
    : `- Tested state: none\n- Fileless reason: ${serializeMarkdownScalar('Fileless reason', payload.filelessReason, true)}`;
  const commandText = commands.length ? `- Commands:\n${commands.map((entry, index) => `  - ${serializeCommand(entry.command, `command ${index + 1}`)} | exit:${entry.exit}`).join('\n')}` : '- Commands: none';
  const lines = [
    `### ${id}`, `- Automatic check round: ${payload.automaticCheckRound}`, `- Status: ${payload.status}`,
    `- HEAD: ${payload.head}`, `- Tested scope: ${entries.length ? entries.map(entry => entry.path).join(', ') : scalar('Fileless reason', payload.filelessReason)}`,
    `- Delivery ID: ${owner.deliveryId}`, `- Preparation revision: ${owner.preparationRevision}`,
    `- Local revision: ${owner.localRevision}`, `- Normative sha256: ${owner.normativeSha256}`,
    `- Operation attempt ID: ${owner.operationAttemptId}`, `- Origin activation ID: ${owner.originActivationId}`,
    tested, commandText,
    ...['Discovery sources','Discovery actions','Verification types considered','Non-applicability rationale','No verification-command confirmation','Selected checks','Selection rationale','Coverage','Failures','Blockers','Unexpected workspace effects','Persistence summary']
      .map(label => `- ${label}: ${scalar(label, fields[label])}`),
  ];
  if (!['1/3','1/5'].includes(payload.automaticCheckRound)) lines.push(
    `- Prior-round failure: ${scalar('Prior-round failure', fields['Prior-round failure'])}`,
    `- Correction applied: ${scalar('Correction applied', fields['Correction applied'])}`,
    `- Correction paths: ${correctionPaths.length ? correctionPaths.join(', ') : 'none'}`,
    `- Updated scope: ${entries.length ? entries.map(entry => entry.path).join(', ') : scalar('Fileless reason', payload.filelessReason)}`,
    `- In-slice rationale: ${scalar('In-slice rationale', fields['In-slice rationale'])}`,
  );
  return lines.join('\n');
}
function originRecord(owner, transport, transportInfo) {
  const {ownershipToken, ...origin} = owner;
  return {...origin, transport, dispatchId:transportInfo.dispatchId, runnerId:transportInfo.runnerId};
}
function semanticError(cause) { return new RunnerSemanticResultError('EXECUTE_SLICE', new Error(cause)); }
function presentRendered(value) {
  if (typeof value !== 'string' || value.length === 0 || /^(?:pending|n\/a)$/iu.test(value)) return false;
  const outsideEncodedScalars = value.replace(/json:"(?:\\.|[^"\\])*"/gu, 'json:""');
  return !/<[^>\n]+>/u.test(outsideEncodedScalars);
}
function nonPlaceholder(value) {
  return presentRendered(value) && !/^(?:none|not_available)$/iu.test(value);
}
// The independent judgment attests the omission. This producer authenticates
// its approved obligation, recipe-selected writable test and observed bytes;
// it does not infer recoverability from prose or claim semantic determinism.
function testCoverageCorrection(payload, authority, info, context, observed) {
  if (payload.status !== 'BLOCKED' || !payload.testCoverageOmissions || !nonPlaceholder(payload.blockers)) return null;
  const tests = new Set(info.recipe.checks.flatMap((check,index) => check.args.flatMap((arg,argIndex) =>
    arg.file?.kind === 'product' ? [path.relative(context.productRoot,
      path.resolve(info.resolved.checks[index].cwd,info.resolved.checks[index].args[argIndex])).split(path.sep).join('/')] : [])));
  const files = new Map(observed.entries.map(item => [item.path,item]));
  for (const omission of payload.testCoverageOmissions) {
    const file = files.get(omission.testPath);
    if (!authority.delivery.obligations.some(item => item.id === omission.obligationId)
      || !tests.has(omission.testPath) || info.inputs.some(item => item.path === omission.testPath)
      || !areaContains(info.areas,omission.testPath) || file?.kind !== 'file'
      || file.sha256 !== omission.testedFileSha256) return null;
  }
  return {paths:[...new Set(payload.testCoverageOmissions.map(item => item.testPath))].sort(ordinal)};
}
export function assertTestCoverageCorrectionWork(correction, before, after) {
  const changes = changedLeaves(before,after), prior = new Map(before.entries.map(item => [item.path,item]));
  if (!changes.length || changes.some(name => !correction.paths.includes(name))
    || correction.paths.some(name => {
      const old = prior.get(name), current = after.entries.find(item => item.path === name);
      return old?.kind !== 'file' || current?.kind !== 'file' || old.mode !== current.mode;
    })) stale('test coverage correction must change only its existing approved test files');
}
function recordGrammarRejection(payload, entries, round, {priorStale=false}={}) {
  const values = new Map(executionFields('EXECUTE_SLICE').map(([key, label]) => [label, payload[key]]));
  const rendered = label => {
    const value = values.get(label);
    return typeof value === 'string' ? serializeMarkdownScalar(label, value, isExplanatoryExecutionField(label)).trim() : '';
  };
  const scope = entries.length ? entries.map(entry => entry.path).join(', ').trim()
    : typeof payload.filelessReason === 'string'
      ? serializeMarkdownScalar('Fileless reason', payload.filelessReason, true).trim() : '';
  for (const label of ['HEAD','Tested scope','Discovery sources','Discovery actions','Verification types considered',
    'Selected checks','Selection rationale','Coverage','Failures','Blockers','Unexpected workspace effects','Persistence summary']) {
    const value = label === 'Tested scope' ? scope : rendered(label);
    if (!presentRendered(value)) return semanticError(`${label} must contain a persisted value`);
  }
  if (entries.length === 0 && !nonPlaceholder(scope)) return semanticError('Fileless reason must be objective non-placeholder content');
  if (payload.status === 'TESTS_PASS') for (const label of ['Tested scope','Verification types considered','Selected checks','Coverage']) {
    const value = label === 'Tested scope' ? scope : rendered(label);
    if (!nonPlaceholder(value)) return semanticError(`${label} must be objective non-placeholder content`);
  }
  if (round > 1 && !priorStale) {
    for (const label of ['Prior-round failure','Correction applied','In-slice rationale']) {
      if (!nonPlaceholder(rendered(label))) return semanticError(`${label} must be objective non-placeholder content`);
    }
    if (!nonPlaceholder(scope)) return semanticError('Updated scope must be objective non-placeholder content');
  }
  return null;
}
function semantic(rawText, receipt, round) {
  try {
    parseCurrentJson(rawText);
  } catch { return {error:semanticError('captured response is not strict JSON')}; }
  try {
    return {payload:parseSemanticExecutionPayload(rawText,'EXECUTE_SLICE')};
  } catch (error) { return {error:new RunnerSemanticResultError('EXECUTE_SLICE', error)}; }
}

function captureOwner(cap) {
  return jsonBytes(cap.origin,'implementation owner').value.owner;
}
function implementationObjects(bundle,records) {
  const refs=new Set(records.flatMap(item=>Object.entries(item.sources)
    .filter(([key])=>key!=='transport').flatMap(([,value])=>Array.isArray(value)?value:[value])
    .filter(value=>typeof value==='string')));
  return bundle.objects.filter(item=>refs.has(item.id));
}
function implementationRounds(bundle) {
  const objects=new Map(bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')]));
  return [...bundle.implementation,...bundle.support].map(record=>{
    const cap=restoreCaptureSources('initial-implementation',record,objects);
    const origin=cap.transport==='native'?jsonBytes(cap.origin,'implementation origin').value:null;
    const offset=origin?.admission?.binding?.normalization?.consumedInvocations??0;
    return {record,cap,owner:captureOwner(cap),globalRound:jsonBytes(cap.receipt,'implementation receipt').value.attempt+offset};
  }).sort((a,b)=>a.globalRound-b.globalRound);
}
function implementationPredecessor(input) {
  if(input.currentEvidence===null)return null;
  const prior=jsonBytes(input.currentEvidence,'rejected implementation predecessor').value;
  validateCurrentEvidence(prior);
  const rounds=implementationRounds(prior),owner=rounds.at(-1)?.owner;
  if(!owner || owner.operationAttemptId===input.owner.operationAttemptId)
    mismatch('implementation successor needs a new owner');
  const verified=validateInitialImplementationEvidence({context:input.context,authority:input.authority,owner,currentEvidence:null,
    counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},bundleBytes:input.currentEvidence});
  if(verified.outcome!=='rejected' || (!prior.support.length||prior.support.length>=MAX_NATIVE_PRODUCER_TURNS) || verified.consumedInvocations>=MAX_NATIVE_PRODUCER_TURNS)
    invalid('implementation predecessor has no legal successor budget');
  expectEqual(input.counters,verified.counters,'INVALID_CURRENT_IMAGE','implementation successor counters');
  return {...verified,owner};
}
function compose(input, info) {
  plain(input.rounds[0], 'round 1');
  const transport = input.rounds[0].transport;
  if (transport!=='native') fail('UNSUPPORTED_FORMAT', 'round 1: unknown transport');
  const store = closeEvidenceObjects();
  const predecessor=implementationPredecessor(input),offset=predecessor?.consumedInvocations??0;
  if(offset+input.rounds.length>MAX_NATIVE_PRODUCER_TURNS)invalid('implementation total invocation budget exceeds five');
  const implementation = [...(predecessor?.bundle.implementation??[])]; const support = [...(predecessor?.bundle.support??[])];
  for(const item of predecessor?.bundle.objects??[])store.add(Buffer.from(item.bytesBase64,'base64'));
  const priorNormalization=predecessor?jsonBytes(implementationRounds(predecessor.bundle).at(-1).cap.origin,'predecessor normalization').value.admission?.binding?.normalization:null;
  const inherited=predecessor?{episodeId:priorNormalization?.episodeId??predecessor.owner.operationAttemptId,operation:'EXECUTE_SLICE',
    causeSha256:priorNormalization?.causeSha256??predecessor.sha256,sourceOperationAttemptId:predecessor.owner.operationAttemptId,
    used:1,consumedInvocations:offset,round:(priorNormalization?.round??0)+1,status:'settled',sourceEvidenceSha256:predecessor.sha256,
    sourceActivationId:input.owner.originActivationId}:null;
  let previousAfter = predecessor?jsonBytes(implementationRounds(predecessor.bundle).at(-1).cap.verificationObservation,'rejected predecessor observation').value.after:null, previousStatus = null, dispatchId = null;
  const retainedRemovals=new Set(predecessor?implementationRounds(predecessor.bundle).flatMap(({cap})=>
    cap.removalProofs.map(blob=>jsonBytes(blob,'verified predecessor removal').value.path))
    .filter(name=>previousAfter.entries.some(entry=>entry.path===name&&entry.kind==='absent')):[]);
  const runners = new Set(predecessor?implementationRounds(predecessor.bundle).map(({record})=>record.origin.runnerId):[]);
  const receipts = [];
  let productBytes = 0, productDrift=null, previousCoverageCorrection=null,previousClarification=null;
  for (const [index, cap] of input.rounds.entries()) {
    const round = index + 1,globalRound=offset+round;
    verifyCapturedInvocation('initial-implementation', cap, undefined, undefined, undefined, round, transport);
    if (cap.transport !== transport) invalid(`round ${round}: mixed transports`);
    const nativeOrigin=cap.transport==='native'?jsonBytes(cap.origin,`round ${round} drift origin`).value:null;
    if(!same(nativeOrigin?.admission?.binding?.normalization??null,inherited))
      mismatch(`round ${round}: implementation inherited normalization differs`);
    if(predecessor) {
      const priorCapture=implementationRounds(predecessor.bundle).at(-1).cap;
      const priorOrigin=jsonBytes(priorCapture.origin,'implementation predecessor origin').value;
      const before=nativeOrigin.admission?.baseActivation,last=before?.lastAttempt;
      if(!priorOrigin.admission||before?.activationId!==input.owner.originActivationId
        ||last?.operationAttemptId!==predecessor.owner.operationAttemptId
        ||['operation','deliveryId','slice'].some(key=>last[key]!==predecessor.owner[key])||last.outcome!=='rejected'
        ||last.terminalActivationId!==before.activationId
        ||!same(last.operationRef,priorOrigin.admission.reservedActivation.activeAttempt.operationRef))
        mismatch('implementation predecessor closure differs from its captured native operation');
    }
    const witness=nativeOrigin?.productDrift??null;
    if(witness!==null) {
      closed(witness,['class','episodeId','sourceOperationAttemptId','sourceRound','sourceCaptureSha256','expectedWorkSha256','used'],'implementation product drift');
      if(witness.class!=='product-drift'||witness.used!==1||witness.sourceOperationAttemptId!==input.owner.operationAttemptId
        ||!Number.isSafeInteger(witness.sourceRound)||witness.sourceRound<1||witness.sourceRound>=round
        ||!productDrift&&witness.sourceRound!==round-1||productDrift&&!same(productDrift,witness)
        ||witness.sourceCaptureSha256!==findingsRoundCaptureSha256(input.rounds[witness.sourceRound-1])
        ||witness.episodeId!==raw(utf8(JSON.stringify({class:'product-drift',owner:input.owner.operationAttemptId,
          sourceRound:witness.sourceRound,sourceCaptureSha256:witness.sourceCaptureSha256,expectedWorkSha256:witness.expectedWorkSha256})+'\n')))
        mismatch(`round ${round}: implementation drift witness differs`);
      productDrift=witness;
    }else if(productDrift)mismatch('implementation drift witness disappeared');
    if (round > 1 && previousStatus !== 'stale' && previousStatus !== 'TESTS_FAIL' && !(previousStatus === 'BLOCKED' && (previousCoverageCorrection||previousClarification))
      && !(previousStatus==='TESTS_PASS'&&witness?.sourceRound===round-1))invalid(`round ${round}: previous round did not fail`);
    const rawText = textBytes(cap.rawResponse, `round ${round} rawResponse`).text;
    const receipt = jsonBytes(cap.receipt, `round ${round} receipt`).value;
    plain(receipt, `round ${round} receipt`);
    if (receipt.attempt !== round) invalid(`round ${round}: invocation sequence differs`);
    const base = jsonBytes(cap.baselineCapture, `round ${round} baselineCapture`).value;
    const claims = [...info.areas, ...info.inputs, ...info.refs];
    const before = baseline(base, input.owner, round, input.context, claims, `round ${round} baseline`);
    if (previousAfter !== null && !same(previousAfter, before)) stale(`round ${round}: baseline differs from previous tested product`);
    const transportInfo = verifyCapturedInvocation('initial-implementation', cap, receipt, rawText, input, round, info.resolved);
    for (const proof of cap.removalProofs) {
      const parsed=jsonBytes(proof, `round ${round} removalProof`).value;
      plain(parsed, `round ${round} removalProof`);
      if (typeof parsed.bytesBase64 === 'string') productBytes += Buffer.from(parsed.bytesBase64,'base64').length;
      if (productBytes > 128 * 1024 * 1024) incomplete(`round ${round}: product capture exceeds 128 MiB`);
    }
    if (dispatchId !== null && dispatchId !== transportInfo.dispatchId) mismatch(`round ${round}: dispatch changed`);
    dispatchId = transportInfo.dispatchId;
    if(previousClarification && transportInfo.runnerId!==previousClarification.agentId)
      mismatch(`round ${round}: coverage clarification requires the same producer`);
    if (runners.has(transportInfo.runnerId) && !previousClarification) mismatch(`round ${round}: runner identity replay`);
    runners.add(transportInfo.runnerId);
    receipts.push(receipt);
    const origin = originRecord(input.owner, transport, transportInfo);
    if(receipt.status==='RUNNER_RESULT_BLOCKED'&&receipt.captureFailure==='EVIDENCE_STALE') {
      if(receipt.semanticResponseStatus!==null||receipt.testedState!==null||receipt.error!==null
        ||receipt.reviewTriage!==undefined||cap.removalProofs.length
        ||!same(receipt.verification,jsonBytes(cap.verificationObservation,`round ${round} stale divergence`).value))
        uncertain(`round ${round}: stale verification receipt is not an unaccepted result`);
      const divergence=jsonBytes(cap.verificationObservation,`round ${round} stale divergence`).value;
      const required=['format','status','owner','round','dispatchId','originSha256','verificationSha256',
        'diagnostic','before','after','observation','diff','checks'];
      if(!divergence||Object.keys(divergence).sort(ordinal).join('\0')!==required.sort(ordinal).join('\0')
        ||divergence.format!=='stnl-native-verification-divergence-v1'||divergence.status!=='stale'
        ||divergence.diagnostic!=='EVIDENCE_STALE'||!same(divergence.owner,input.owner)
        ||divergence.round!==round||divergence.dispatchId!==transportInfo.dispatchId
        ||divergence.originSha256!==raw(cap.origin)
        ||divergence.verificationSha256!==info.resolved.recipeSha256
        ||!same(divergence.before.manifest,before)
        ||!same(divergence.observation.before,divergence.before.manifest)
        ||!same(divergence.observation.after,divergence.after.manifest)
        ||!same(divergence.observation.checks,divergence.checks))stale(`round ${round}: stale divergence binding differs`);
      const {format,status,owner,round:observedRound,recipe,resolved,before:observedBefore,after:observedAfter,checks}=divergence.observation;
      const staleObservation={format,status,owner,round:observedRound,recipe,resolved,
        before:observedBefore,after:observedAfter,checks};
      verifyWorkObservation('initial-implementation',staleObservation,input.owner,round,info,before,input.context,
        `round ${round} stale observation`);
      const computedDiff=[];
      const beforeMap=new Map(divergence.before.manifest.entries.map(item=>[item.path,item]));
      const afterMap=new Map(divergence.after.manifest.entries.map(item=>[item.path,item]));
      for(const name of [...new Set([...beforeMap.keys(),...afterMap.keys()])].sort(ordinal))
        if(!same(beforeMap.get(name)??null,afterMap.get(name)??null))
          computedDiff.push({path:name,before:beforeMap.get(name)??{kind:'absent'},after:afterMap.get(name)??{kind:'absent'}});
      if(!same(divergence.diff,computedDiff))stale(`round ${round}: stale divergence diff differs`);
      domainChanges(before,divergence.after.manifest,info,round);
      verifyRemoval(cap.removalProofs,input.owner,round,before,divergence.after.manifest);
      if(index===input.rounds.length-1)incomplete(`round ${round}: stale verification has no later admitted result`);
      support.push({kind:'rejection',operationAttemptId:input.owner.operationAttemptId,origin,
        diagnostic:'EVIDENCE_STALE',consumedInvocations:round,round,
        sources:packCaptureSources('initial-implementation',cap,store)});
      previousAfter=divergence.after.manifest;
      previousStatus='stale';
      continue;
    }
    let semanticText=rawText,projectionError=null;
    if(transport==='native') {
      const nativeOrigin=jsonBytes(cap.origin,`round ${round} origin`).value;
      if(nativeOrigin.responseVariant===NATIVE_JUDGMENT_VARIANT) {
        const nativeObserved=jsonBytes(cap.verificationObservation,`round ${round} verificationObservation`).value;
        verifyWorkObservation('initial-implementation',nativeObserved,input.owner,round,info,before,input.context,
          `round ${round} observation`);
        try {semanticText=projectNativeJudgment({origin:nativeOrigin,observation:nativeObserved,
          agentId:transportInfo.runnerId,rawText,operation:'EXECUTE_SLICE'});}
        catch(error) {
          if(recoverableRunnerResultDiagnostic(error)===null)throw error;
          projectionError=error;
        }
      }
    }
    const result = projectionError?{error:projectionError}:semantic(semanticText, receipt, round);
    const schemaRejected = result.error !== undefined;
    if (schemaRejected) {
      if(receipt.reviewTriage!==undefined||previousClarification)
        fail('FORMAL_RECOVERY_NOT_ELIGIBLE','coverage clarification requires a schema-valid concluded response');
      if (index !== input.rounds.length - 1) invalid(`round ${round}: rejected round cannot precede another`);
      if (receipt.status === 'RUNNER_RESULT_BLOCKED') {
        if (transport === 'native') {
          if (receipt.semanticResponseStatus !== null || receipt.testedState !== null
            || typeof receipt.captureFailure !== 'string' || !receipt.captureFailure.trim()) uncertain(`round ${round}: native rejection has no concluded schema receipt`);
        }
        if (cap.verificationObservation === null) {
          if (receipt.verification !== null || cap.removalProofs.length !== 0) incomplete(`round ${round}: blocked receipt hides observation or removal proof`);
        } else {
          const observed=jsonBytes(cap.verificationObservation, `round ${round} verificationObservation`).value;
          verifyWorkObservation('initial-implementation',observed,input.owner,round,info,before,input.context,`round ${round} observation`);
          expectEqual(receipt.verification,observed,'EVIDENCE_STALE',`round ${round}: receipt observation`);
          domainChanges(before,observed.after,info,round);
          verifyRemoval(cap.removalProofs,input.owner,round,before,observed.after);
        }
      } else if (receipt.status === 'RUNNER_RESPONSE_CAPTURED') {
        if (receipt.captureFailure !== null) uncertain(`round ${round}: captured schema result is not concluded`);
        let loose;
        // Bind the receipt to the same projected operation payload parsed above.
        try { loose=JSON.parse(semanticText); } catch { uncertain(`round ${round}: accepted receipt cannot bind non-JSON raw`); }
        if (receipt.semanticResponseStatus !== loose?.status) uncertain(`round ${round}: accepted receipt semantic status differs`);
        if (cap.verificationObservation === null) incomplete(`round ${round}: accepted schema result lacks observation`);
        const observed=jsonBytes(cap.verificationObservation, `round ${round} verificationObservation`).value;
        verifyWorkObservation('initial-implementation',observed,input.owner,round,info,before,input.context,`round ${round} observation`);
        expectEqual(receipt.verification,observed,'EVIDENCE_STALE',`round ${round}: receipt observation`);
        testedState(receipt.testedState,input.context,input.owner,before,observed.after,info,round,retainedRemovals);
        verifyRemoval(cap.removalProofs,input.owner,round,before,observed.after);
      } else uncertain(`round ${round}: schema result has no concluded capture`);
      const diagnostic = recoverableRunnerResultDiagnostic(result.error);
      if (diagnostic === null) invalid(`round ${round}: rejection diagnostic unavailable`);
      support.push({kind:'rejection', operationAttemptId:input.owner.operationAttemptId, origin, diagnostic,
        consumedInvocations:round, round, sources:packCaptureSources('initial-implementation',cap,store)});
      previousStatus = 'rejected';
      continue;
    }
    const payload = result.payload;
    if (receipt.status !== 'RUNNER_RESPONSE_CAPTURED' || receipt.semanticResponseStatus !== payload.status
      || receipt.captureFailure !== null) uncertain(`round ${round}: accepted result lacks capture receipt`);
    if (cap.verificationObservation === null) incomplete(`round ${round}: completed response lacks observation`);
    const observed = jsonBytes(cap.verificationObservation, `round ${round} verificationObservation`).value;
    const commands = verifyWorkObservation('initial-implementation', observed, input.owner, round, info, before, input.context, `round ${round} observation`);
    expectEqual(receipt.verification, observed, 'EVIDENCE_STALE', `round ${round}: receipt observation`);
    const entries = testedState(receipt.testedState, input.context, input.owner, before, observed.after, info, round,retainedRemovals);
    if (previousCoverageCorrection) assertTestCoverageCorrectionWork(previousCoverageCorrection,before,observed.after);
    if(previousClarification && (!same(before,observed.after)||payload.status!=='BLOCKED'
      ||!same(payload.commands,previousClarification.commands)))
      fail('FORMAL_RECOVERY_NOT_ELIGIBLE','coverage clarification must preserve the tested product, commands and BLOCKED verdict');
    verifyRemoval(cap.removalProofs, input.owner, round, before, observed.after);
    for(const name of retainedRemovals)if(!observed.after.entries.some(entry=>entry.path===name&&entry.kind==='absent'))retainedRemovals.delete(name);
    for(const blob of cap.removalProofs)retainedRemovals.add(jsonBytes(blob,'verified current removal').value.path);
    if(witness?.sourceRound===round-1) {
      if(same(previousAfter,observed.before)||raw(utf8(canonical(observed.before)+'\n'))!==witness.expectedWorkSha256)
        stale(`round ${round}: implementation drift observation differs`);
      const prior=new Map(previousAfter.entries.map(item=>[item.path,item]));
      for(const item of observed.before.entries) {
        if(same(prior.get(item.path),item))continue;
        if(item.kind!=='file'||prior.get(item.path)?.kind!=='file'||!areaContains(info.areas,item.path)
          ||[...info.inputs,...info.refs].some(ref=>ref.path===item.path))
          stale(`round ${round}: implementation drift is not private existing output`);
      }
    }
    previousAfter = observed.after;
    let rejection = null;
    if (transport === 'native' && (!nativeCheckRoundMatches(payload.automaticCheckRound,globalRound) || !same(payload.commands, commands))) rejection = semanticError('native response round/commands contradict observed execution');
    if (!rejection) rejection = recordGrammarRejection(payload, entries, globalRound,{priorStale:previousStatus==='stale'});
    if (!rejection && payload.status === 'TESTS_FAIL' && !commands.some(command => command.exit !== 0)) rejection = semanticError('TESTS_FAIL requires an observed nonzero exit');
    if (!rejection && payload.status === 'TESTS_NOT_APPLICABLE') rejection = semanticError('TESTS_NOT_APPLICABLE contradicts the reviewed nonempty recipe');
    if (!rejection) {
      try {
        // The receipt keeps its owner-local invocation. The inherited global
        // round was checked above; never relabel a predecessor receipt.
        const helperResult = offset ? null : deriveCanonicalRunnerRejection({receipt, response:semanticText});
        if (helperResult !== null) rejection = helperResult;
        else {
          assertRunnerVerdictConsistency('EXECUTE_SLICE', payload.status, commands);
          assertExecutionResultScope('EXECUTE_SLICE', payload, entries.length);
        }
      } catch (error) {
        if (recoverableRunnerResultDiagnostic(error) === null) incomplete(`round ${round}: semantic helper disagrees: ${error.message}`);
        rejection = error;
      }
    }
    if (rejection !== null) {
      if(receipt.reviewTriage!==undefined||previousClarification)
        fail('FORMAL_RECOVERY_NOT_ELIGIBLE','coverage clarification requires a valid concluded BLOCKED check');
      if (index !== input.rounds.length - 1) invalid(`round ${round}: rejected round cannot precede another`);
      const diagnostic = recoverableRunnerResultDiagnostic(rejection);
      if (diagnostic === null) invalid(`round ${round}: rejection diagnostic unavailable`);
      support.push({kind:'rejection', operationAttemptId:input.owner.operationAttemptId, origin, diagnostic,
        consumedInvocations:round, round, sources:packCaptureSources('initial-implementation',cap,store)});
      previousStatus = 'rejected';
      continue;
    }
    const coverageCorrection=testCoverageCorrection(payload,input.authority,info,input.context,observed.after);
    if(previousClarification && (!coverageCorrection
      ||payload.testCoverageOmissions.some(item=>!previousClarification.missingWork.some(work=>work.obligationId===item.obligationId))))
      fail('FORMAL_RECOVERY_NOT_ELIGIBLE','coverage clarification requires authenticated proof limited to the triaged obligations');
    previousClarification=null;
    if(receipt.reviewTriage!==undefined) {
      if(payload.testCoverageOmissions!==undefined || commands.length===0)
        fail('FORMAL_RECOVERY_NOT_ELIGIBLE','coverage clarification requires absent proof and completed checks');
      const triage=validateReviewTriage(receipt.reviewTriage,{owner:input.owner,
        requestSha256:nativeOrigin.requestSha256,responseSha256:raw(utf8(rawText)),status:payload.status,
        commands,obligations:input.authority.delivery.obligations});
      previousClarification={agentId:transportInfo.runnerId,round,responseSha256:raw(utf8(rawText)),commands,missingWork:triage.missingWork};
    }
    const correction = globalRound === 1 ? [] : changedLeaves(implementation.at(-1)?.testedWork??before, observed.after)
      .map(name => relativeTask(input.context, path.join(input.context.productRoot, name), input.owner.slice));
    const id = `implementation-check-${String(implementation.length + 1).padStart(2,'0')}`;
    const recordUtf8 = renderRecord(id, input.owner, payload, entries, commands, correction);
    implementation.push({kind:'implementation-check', recordFormat:'stnl-task-record-v2', id, origin,
      contract:{delivery:input.authority.delivery, context:input.authority.context, terminal:null, recipe:info.recipe},
      recordUtf8, testedWork:observed.after, sources:packCaptureSources('initial-implementation',cap,store)});
    previousStatus = payload.status;
    previousCoverageCorrection = coverageCorrection;
  }
  if(previousStatus==='stale')incomplete('terminal implementation result cannot be only a stale verification');
  const bundle = {
    format:'stnl-current-evidence-v1', deliveryId:input.owner.deliveryId, slice:input.owner.slice,
    logicalTaskPath:`tasks/${input.owner.slice}.md`, currentAuthoritySha256:projected('delivery', input.authority.delivery),
    implementation, findingsChecks:[], validation:null, openFindings:[], openDivergences:[], support,
    objects:store.finish(),
  };
  validateCurrentEvidence(bundle);
  const resultBytes = serialized(bundle);
  return {bundle:parseCurrentJson(resultBytes.toString('utf8')), bytes:Uint8Array.from(resultBytes), sha256:raw(resultBytes),
    counters:{implementationChecks:implementation.length,findingsChecks:0,validationAttempts:0,findings:0},
    consumedInvocations:offset+input.rounds.length, outcome:previousStatus==='rejected' ? 'rejected' : 'recorded',
    ...(previousStatus==='BLOCKED' && previousCoverageCorrection && offset+input.rounds.length<MAX_NATIVE_PRODUCER_TURNS ? {testCoverageCorrection:previousCoverageCorrection} : {}),
    ...(previousStatus==='BLOCKED' && previousClarification && offset+input.rounds.length<MAX_NATIVE_PRODUCER_TURNS ? {testCoverageClarification:previousClarification} : {})};
}

export function composeInitialImplementationEvidence(input) {
  const info = guard(input);
  return compose(input, info);
}

export function validateInitialImplementationEvidence(input) {
  const info = guard(input, true);
  const original = bytes(input.bundleBytes, 'bundleBytes');
  const parsed = jsonBytes(original, 'bundleBytes').value;
  validateCurrentEvidence(parsed);
  if (parsed.deliveryId !== input.owner.deliveryId || parsed.slice !== input.owner.slice
    || parsed.currentAuthoritySha256 !== projected('delivery', input.authority.delivery)
    || parsed.findingsChecks.length || parsed.validation !== null || parsed.openFindings.length || parsed.openDivergences.length
    || parsed.support.length > MAX_NATIVE_PRODUCER_TURNS || parsed.support.some(item => item.kind !== 'rejection')) invalid('bundle outside initial implementation scope');
  const objects = new Map(parsed.objects.map(item => [item.id,Buffer.from(item.bytesBase64,'base64')]));
  const records = [...parsed.implementation,...parsed.support];
  if (!records.length || records.length > MAX_NATIVE_PRODUCER_TURNS) invalid('bundle initial round count');
  for (const [index, record] of parsed.implementation.entries()) {
    if (record.id !== `implementation-check-${String(index + 1).padStart(2,'0')}`) invalid('bundle implementation ID sequence');
  }
  if (new Set(records.map(record => record.sources.receipt)).size !== records.length) invalid('bundle source replay');
  const sequence=implementationRounds(parsed);
  if(sequence.some((item,index)=>item.globalRound!==index+1))invalid('implementation global invocation sequence');
  const owners=[...new Set(sequence.map(item=>item.owner.operationAttemptId))];
  if(owners.length>MAX_NATIVE_PRODUCER_TURNS || sequence.at(-1).owner.operationAttemptId!==input.owner.operationAttemptId)
    mismatch('implementation successor owner order');
  let currentEvidence=null,currentCounters={implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0};
  let selected=sequence;
  if(owners.length>1) {
    const split=sequence.findIndex(item=>item.owner.operationAttemptId===owners.at(-1));
    if(sequence.slice(split).some(item=>item.owner.operationAttemptId!==owners.at(-1)))mismatch('implementation owner interleaving');
    const priorRecords=sequence.slice(0,split).map(item=>item.record);
    const prior={...parsed,implementation:parsed.implementation.filter(item=>priorRecords.includes(item)),
      support:parsed.support.filter(item=>priorRecords.includes(item)),objects:implementationObjects(parsed,priorRecords)};
    currentEvidence=serialized(prior);currentCounters.implementationChecks=prior.implementation.length;
    selected=sequence.slice(split);
  }
  const rounds=selected.map(item=>item.cap);
  const candidate = compose({...input,currentEvidence,counters:currentCounters,rounds}, info);
  if (!same(parsed,candidate.bundle)) stale('bundle semantic reconstruction differs');
  return {...candidate, bundle:parseCurrentJson(original.toString('utf8')), bytes:Uint8Array.from(original), sha256:raw(original)};
}
