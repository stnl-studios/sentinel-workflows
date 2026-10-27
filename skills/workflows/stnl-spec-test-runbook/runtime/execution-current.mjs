import { createHash } from 'node:crypto';
import path from 'node:path';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const SLICE = /^slice-([0-9]{2,})$/u;
const OPERATIONS = ['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE'];
const FORMAT = {
  activation: 'stnl-execution-activation-v2',
  preparation: 'stnl-preparation-v3',
  projection: 'stnl-preparation-projection-v3',
  continuity: 'stnl-delivery-continuity-v2',
  evidence: 'stnl-current-evidence-v1',
  work: 'stnl-current-work-v1',
};
const ERROR_CODES = [
  'CURRENT_FORMAT_REQUIRED', 'UNSUPPORTED_FORMAT', 'INVALID_CURRENT_IMAGE',
  'STALE_BASE', 'STALE_APPROVAL', 'REQUIREMENTS_CHANGED', 'OWNER_ACTIVE', 'OWNER_UNCERTAIN',
  'OWNER_MISMATCH', 'RUNNER_RESULT_REJECTED', 'NORMALIZATION_EXHAUSTED', 'LOCAL_REVIEW_REQUIRED',
  'REPLAN_REQUIRED', 'EVIDENCE_INCOMPLETE', 'EVIDENCE_STALE', 'TEMP_ROOT_UNPROVEN',
  'CROSS_FILESYSTEM', 'UNSAFE_PATH', 'PUBLICATION_UNCERTAIN', 'CLEANUP_PENDING',
  'FOREIGN_MATERIAL', 'HISTORY_NOT_RETAINED',
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
const invalid = message => fail('INVALID_CURRENT_IMAGE', message);
const evidenceError = message => fail('EVIDENCE_INCOMPLETE', message);
const unsafe = message => fail('UNSAFE_PATH', message);
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const raw = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function wellFormed(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('isolated high surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid('isolated low surrogate');
  }
}

function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(`${label}: expected plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(entry => !Object.hasOwn(entry, 'value') || !entry.enumerable)) invalid(`${label}: non-JSON property`);
  return value;
}
function object(value, names, label) {
  plain(value, label);
  const actual = Object.keys(value).sort(ordinal);
  if (actual.length !== names.length || actual.some((key, i) => key !== [...names].sort(ordinal)[i])) invalid(`${label}: unknown or missing field`);
  return value;
}
function array(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.keys(value).length !== value.length
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).some(key => !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) =>
      key !== 'length' && (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable))) invalid(`${label}: expected dense array`);
  return value;
}
function string(value, label, nonempty = true) {
  if (typeof value !== 'string' || (nonempty && value.trim() === '') || value.includes('\0')) invalid(`${label}: invalid string`);
  wellFormed(value);
  return value;
}
function match(value, regex, label) {
  string(value, label);
  if (!regex.test(value)) invalid(`${label}: invalid value`);
  return value;
}
const hash = (value, label) => match(value, HASH, label);
const uuid = (value, label) => match(value, UUID, label);
function nat(value, label, positive = false) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < (positive ? 1 : 0)) invalid(`${label}: invalid integer`);
  return value;
}
function oneOf(value, options, label) {
  if (!options.includes(value)) invalid(`${label}: invalid value`);
  return value;
}
function optional(value, check, label) {
  if (value !== null) check(value, label);
}
function ordered(values, key, label) {
  let previous = null;
  for (const item of array(values, label)) {
    const current = key(item);
    if (previous !== null && ordinal(previous, current) >= 0) invalid(`${label}: duplicate or unordered entry`);
    previous = current;
  }
}
function canonical(value) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') { wellFormed(value); return JSON.stringify(value); }
  if (typeof value === 'number') { nat(value, 'canonical number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${array(value, 'canonical array').map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid('non-JSON object');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) invalid('non-JSON property');
    return `{${Object.keys(descriptors).sort(ordinal).map(key => {
      if (!Object.hasOwn(descriptors[key], 'value')) invalid('accessor in projection');
      wellFormed(key);
      return `${JSON.stringify(key)}:${canonical(descriptors[key].value)}`;
    }).join(',')}}`;
  }
  invalid('non-JSON value');
}
function projected(tag, value) {
  const preimage = Buffer.concat([Buffer.from(`stnl-ec1/${tag}/v1`, 'utf8'), Buffer.from([0]), Buffer.from(canonical(value), 'utf8')]);
  return raw(preimage);
}
export const currentOperationBindingSha256 = binding => projected('operation-binding', binding);
export const currentDeliveryAuthoritySha256 = delivery => projected('delivery', delivery);
const same = (a, b) => canonical(a) === canonical(b);
function parsedJsonValue(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) invalid('nonfinite or negative-zero JSON number');
  if (Array.isArray(value)) value.forEach(parsedJsonValue);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(parsedJsonValue);
}

// JSON.parse accepts duplicate keys; scan the grammar before parsing.
export function parseCurrentJson(text) {
  if (typeof text !== 'string') invalid('JSON text required');
  let i = 0;
  const ws = () => { while (i < text.length && /[ \t\r\n]/u.test(text[i])) i += 1; };
  const quoted = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') {
        try { const result = JSON.parse(text.slice(start, i)); wellFormed(result); return result; }
        catch { invalid('invalid JSON string'); }
      }
    }
    invalid('unterminated JSON string');
  };
  const value = () => {
    ws();
    if (text[i] === '{') {
      i += 1; ws(); const keys = new Set();
      if (text[i] === '}') { i += 1; return; }
      while (i < text.length) {
        if (text[i] !== '"') invalid('invalid JSON object');
        const key = quoted();
        if (keys.has(key)) invalid(`duplicate JSON key ${key}`);
        keys.add(key); ws();
        if (text[i++] !== ':') invalid('invalid JSON field');
        value(); ws();
        if (text[i] === '}') { i += 1; return; }
        if (text[i++] !== ',') invalid('invalid JSON object delimiter');
        ws();
      }
      invalid('unterminated JSON object');
    }
    if (text[i] === '[') {
      i += 1; ws();
      if (text[i] === ']') { i += 1; return; }
      while (i < text.length) {
        value(); ws();
        if (text[i] === ']') { i += 1; return; }
        if (text[i++] !== ',') invalid('invalid JSON array delimiter');
      }
      invalid('unterminated JSON array');
    }
    if (text[i] === '"') { quoted(); return; }
    const atom = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(i));
    if (!atom) invalid('invalid JSON value');
    i += atom[0].length;
  };
  value(); ws();
  if (i !== text.length) invalid('trailing JSON content');
  try {
    const parsed = JSON.parse(text);
    parsedJsonValue(parsed);
    return parsed;
  } catch (error) {
    if (error?.code === 'INVALID_CURRENT_IMAGE') throw error;
    invalid('invalid JSON');
  }
}

function format(value, expected, label) {
  if (value === expected) return;
  if (value === undefined || value === null) fail('CURRENT_FORMAT_REQUIRED', `${label}: format required`);
  if (Object.values(FORMAT).includes(value)) invalid(`${label}: mixed EC-1 format`);
  fail('UNSUPPORTED_FORMAT', `${label}: unsupported format`);
}
function checkedFormat(value, expected, label) {
  plain(value, label);
  format(Object.hasOwn(value, 'format') ? value.format : undefined, expected, label);
}
function slice(value, label) {
  match(value, SLICE, label);
  const ordinalNumber = Number(SLICE.exec(value)[1]);
  if (!Number.isSafeInteger(ordinalNumber) || ordinalNumber < 1 || String(ordinalNumber).padStart(2, '0') !== SLICE.exec(value)[1]) invalid(`${label}: noncanonical slice`);
  return ordinalNumber;
}
function posixRelative(value, label) {
  string(value, label);
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
    || value.endsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')
    || path.posix.normalize(value) !== value) invalid(`${label}: unsafe relative path`);
  return value;
}
function preparationPath(value, label) {
  string(value, label);
  if (value === 'plan.md' || value === 'tasks.md') return value;
  const matchPath = /^(?:plans|tasks)\/(slice-[0-9]{2,})\.md$/u.exec(value);
  if (!matchPath) invalid(`${label}: unknown preparation path`);
  slice(matchPath[1], label);
  return value;
}
function executionPath(value, label) {
  string(value, label);
  if (['approved-preparation.json', 'continuity.json'].includes(value)) return value;
  if (/^evidence\/[a-f0-9-]+\.json$/u.test(value)) {
    evidencePath(value, label); return value;
  }
  return preparationPath(value, label);
}
function evidencePath(value, label) {
  string(value, label);
  const found = /^evidence\/([a-f0-9-]+)\.json$/u.exec(value);
  if (!found) invalid(`${label}: invalid evidence path`);
  uuid(found[1], label);
  return found[1];
}
const taskPath = (value, label) => {
  string(value, label);
  if (!/^tasks\/slice-[0-9]{2,}\.md$/u.test(value)) invalid(`${label}: invalid task path`);
  preparationPath(value, label);
};
const productPath = (value, label) => posixRelative(value, label);
function recipeReferencePath(value, label) {
  string(value, label);
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
    || value === '.' || value.endsWith('/') || value.split('/').some(part => !part || part === '.')
    || path.posix.normalize(value) !== value) invalid(`${label}: invalid artifact-relative reference`);
  return value;
}

function attemptIdentity(value, label) {
  object(value, ['operationAttemptId', 'ownershipToken', 'deliveryId', 'slice', 'operation', 'preparationRevision', 'localRevision', 'normativeSha256', 'originActivationId'], label);
  uuid(value.operationAttemptId, label); uuid(value.ownershipToken, label); uuid(value.deliveryId, label);
  slice(value.slice, label); oneOf(value.operation, OPERATIONS, label);
  nat(value.preparationRevision, label, true); nat(value.localRevision, label, true);
  hash(value.normativeSha256, label); uuid(value.originActivationId, label);
}
export function validateCurrentActivation(value) {
  checkedFormat(value, FORMAT.activation, 'activation');
  object(value, ['format', 'activationId', 'sequence', 'previousActivationId', 'preparationRevision', 'requirementsAuthority', 'normativeSha256', 'approvedSnapshotSha256', 'artifacts', 'activeAttempt', 'lastAttempt'], 'activation');
  uuid(value.activationId, 'activationId'); nat(value.sequence, 'sequence', true);
  optional(value.previousActivationId, uuid, 'previousActivationId');
  if ((value.sequence === 1) !== (value.previousActivationId === null) || value.previousActivationId === value.activationId) invalid('activation predecessor mismatch');
  nat(value.preparationRevision, 'preparationRevision', true);
  hash(value.requirementsAuthority, 'requirementsAuthority'); hash(value.normativeSha256, 'normativeSha256'); hash(value.approvedSnapshotSha256, 'approvedSnapshotSha256');
  array(value.artifacts, 'artifacts');
  for (const item of value.artifacts) {
    object(item, ['path', 'sha256'], 'artifact'); executionPath(item.path, 'artifact.path'); hash(item.sha256, 'artifact.sha256');
  }
  ordered(value.artifacts, item => item.path, 'artifacts');
  if (value.activeAttempt !== null) {
    const attempt = value.activeAttempt;
    object(attempt, ['operationAttemptId', 'ownershipToken', 'deliveryId', 'slice', 'operation', 'preparationRevision', 'localRevision', 'normativeSha256', 'originActivationId', 'operationRef'], 'activeAttempt');
    attemptIdentity(Object.fromEntries(Object.entries(attempt).filter(([key]) => key !== 'operationRef')), 'activeAttempt');
    object(attempt.operationRef, ['operationId', 'allocationSha256'], 'operationRef');
    uuid(attempt.operationRef.operationId, 'operationRef.operationId'); hash(attempt.operationRef.allocationSha256, 'operationRef.allocationSha256');
    if (attempt.preparationRevision !== value.preparationRevision
      || (value.preparationRevision === 1 && attempt.normativeSha256 !== value.normativeSha256)) invalid('active attempt authority mismatch');
  }
  if (value.lastAttempt !== null) {
    const last = value.lastAttempt;
    const fields=['operationAttemptId', 'deliveryId', 'slice', 'operation', 'terminalActivationId', 'outcome'];
    object(last, [...fields,...(last.operationRef===undefined?[]:['operationRef']),...(last.outcome==='aborted'?['abort']:[])], 'lastAttempt');
    uuid(last.operationAttemptId, 'lastAttempt.operationAttemptId'); uuid(last.deliveryId, 'lastAttempt.deliveryId');
    slice(last.slice, 'lastAttempt.slice'); oneOf(last.operation, OPERATIONS, 'lastAttempt.operation');
    uuid(last.terminalActivationId, 'lastAttempt.terminalActivationId');
    oneOf(last.outcome, ['recorded', 'rejected', 'aborted'], 'lastAttempt.outcome');
    if(last.operationRef!==undefined) {
      object(last.operationRef,['operationId','allocationSha256'],'lastAttempt.operationRef');
      uuid(last.operationRef.operationId,'lastAttempt.operationRef.operationId');
      hash(last.operationRef.allocationSha256,'lastAttempt.operationRef.allocationSha256');
    }
    if(last.outcome==='aborted') {
      const proof=validateCurrentAbortDisposition(last),reserved=proof.origin.admission.reservedActivation;
      const terminalId=value.activeAttempt?.originActivationId??value.activationId;
      if(last.terminalActivationId!==terminalId || value.activeAttempt===null && (value.sequence!==reserved.sequence+1
        ||value.previousActivationId!==reserved.activationId || value.preparationRevision!==reserved.preparationRevision
        ||value.requirementsAuthority!==reserved.requirementsAuthority ||value.normativeSha256!==reserved.normativeSha256
        ||value.approvedSnapshotSha256!==reserved.approvedSnapshotSha256 ||!same(value.artifacts,reserved.artifacts)))
        invalid('aborted activation differs from retained reservation');
    }
  }
  return value;
}


// A concluded invocation without an observation is a disposition, never a
// validation record. Its exact native sources survive without transient paths.
export function validateCurrentAbortDisposition(last) {
  if(last?.outcome!=='aborted'||last.operation!=='VALIDATE_SLICE'||!last.operationRef)
    invalid('unsupported native abort disposition');
  const proof=object(last.abort,['originUtf8','requestUtf8','baselineUtf8','agentUtf8','claimUtf8',
    'toolResultUtf8','consumedInvocations','diagnostic'],'native abort');
  const parsed={};
  for(const key of ['origin','request','baseline','agent','claim','toolResult']) {
    const bytes=string(proof[key+'Utf8'],'native abort '+key);
    if(Buffer.byteLength(bytes,'utf8')>2*1024*1024)invalid('native abort source exceeds bound');
    parsed[key]=plain(parseCurrentJson(bytes),'native abort '+key);
  }
  const {origin,request,baseline,agent,claim,toolResult}=parsed;
  const initial=request.format==='stnl-current-validation-request-v1'
    && origin.owner?.preparationRevision===1 && origin.owner.localRevision===1;
  const localReview=request.format==='stnl-current-validation-request-v3'
    && origin.owner?.preparationRevision>1 && request.base?.validation==='revalidation-required'
    && request.base.lastDiagnostic===null;
  if(!initial&&!localReview)invalid('native abort request exceeds supported profiles');
  object(toolResult,['agentId','status','finalResponse'],'native abort tool result');
  string(toolResult.agentId,'native abort agent');string(toolResult.finalResponse,'native abort final response');
  diagnostic(proof.diagnostic,'native abort diagnostic');
  if(proof.consumedInvocations!==1||toolResult.status!=='completed'
    ||proof.diagnostic.code!=='EVIDENCE_INCOMPLETE'||proof.diagnostic.reason!==toolResult.finalResponse
    ||proof.diagnostic.operationAttemptId!==last.operationAttemptId||proof.diagnostic.nextAction!=='validate'
    ||proof.diagnostic.affectedPaths.length)invalid('native abort conclusion or consumption differs');
  if(origin.transport!=='native'||origin.attempt!==1||origin.responseVariant!=='stnl-current-native-judgment-v1'
    ||origin.requestSha256!==raw(Buffer.from(proof.requestUtf8,'utf8'))
    ||origin.owner?.operation!=='VALIDATE_SLICE'
    ||origin.owner.operationAttemptId!==last.operationAttemptId||origin.owner.deliveryId!==last.deliveryId
    ||origin.owner.slice!==last.slice||!same(request.owner,origin.owner)
    ||!same(baseline.owner,origin.owner)||baseline.round!==1
    ||localReview&&!same(baseline.manifest,request.base.baseline)
    ||agent.agentId!==toolResult.agentId||claim.agentId!==toolResult.agentId
    ||claim.originFile!==agent.originFile||!same(claim.owner,origin.owner))
    invalid('native abort retained sources differ');
  const admission=object(origin.admission,['binding','baseActivation','reservedActivation'],'native abort admission');
  const base=plain(admission.baseActivation,'native abort base'),reserved=plain(admission.reservedActivation,'native abort reservation');
  string(origin.workspace,'native abort workspace');
  if(!path.isAbsolute(origin.workspace))invalid('native abort workspace must be absolute');
  if(request.authority?.preparationRevision!==origin.owner.preparationRevision
    ||request.authority.localRevision!==origin.owner.localRevision
    ||request.authority.normativeSha256!==origin.owner.normativeSha256
    ||request.authority.delivery?.deliveryId!==last.deliveryId
    ||(initial?base.normativeSha256:currentDeliveryAuthoritySha256(request.authority.delivery))!==origin.owner.normativeSha256
    ||request.authority.context?.requirementsAuthority!==base.requirementsAuthority)
    invalid('native abort local request authority differs');
  work(baseline.manifest,'native abort baseline');
  // Initial retains its actual recorded implementation; local review retains
  // its original null predecessor. Neither profile chains aborted invocations.
  const prior=base.lastAttempt;
  if(base.activeAttempt!==null || (initial
    ?base.preparationRevision!==1 || prior?.outcome!=='recorded' || prior.operation!=='EXECUTE_SLICE'
      ||prior.deliveryId!==last.deliveryId || prior.slice!==last.slice || !prior.operationRef
      ||prior.terminalActivationId!==base.activationId || request.attemptId!=='attempt-01'
      ||request.base?.counters?.validationAttempts!==0 || request.base.counters.findings!==0
      ||request.base.counters.findingsChecks!==0 || !(request.base.counters.implementationChecks>0)
      ||!Array.isArray(request.base.openFindings)||request.base.openFindings.length!==0
    :prior!==null))invalid('native abort predecessor exceeds profile');
  if(initial && Object.hasOwn(request,'terminal')) {
    const bytes=string(origin.terminalPreparationUtf8,'native abort terminal preparation');
    const snapshot=parseCurrentJson(bytes);approved(snapshot);
    if(raw(Buffer.from(bytes,'utf8'))!==base.approvedSnapshotSha256
      ||snapshot.normativeSha256!==base.normativeSha256 ||snapshot.preparationRevision!==1
      ||!same(request.terminal,currentTerminalProjection(snapshot))
      ||!same(request.authority.delivery,snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===last.deliveryId)))
      invalid('native abort Initial terminal authority differs');
  } else if(initial && origin.terminalPreparationUtf8!==undefined)
    invalid('native abort terminal preparation without terminal request');
  validateCurrentActivation(base);validateCurrentActivation(reserved);
  const binding=plain(admission.binding,'native abort binding');
  if(binding.operationId!==last.operationRef.operationId
    ||currentOperationBindingSha256(binding)!==last.operationRef.allocationSha256
    ||!same(binding.owner,origin.owner)||binding.baseActivationId!==base.activationId
    ||reserved.previousActivationId!==base.activationId||reserved.sequence!==base.sequence+1
    ||reserved.preparationRevision!==base.preparationRevision||reserved.requirementsAuthority!==base.requirementsAuthority
    ||reserved.normativeSha256!==base.normativeSha256||reserved.approvedSnapshotSha256!==base.approvedSnapshotSha256
    ||!same(reserved.artifacts,base.artifacts)||!same(reserved.lastAttempt,base.lastAttempt)
    ||initial&&binding.normalization!==undefined
    ||!same(reserved.activeAttempt,{...origin.owner,operationRef:last.operationRef})
    ||agent.originFile!==path.join(origin.workspace,'tmp','sentinel',binding.specKey,binding.operationId,'round-1.origin.json'))
    invalid('native abort reservation binding differs');
  return parsed;
}
export function currentEvidenceLastAttempt(last) {
  if(last?.outcome!=='aborted')return last;
  return validateCurrentAbortDisposition(last).origin.admission.baseActivation.lastAttempt;
}

function work(value, label) {
  checkedFormat(value, FORMAT.work, label); object(value, ['format', 'entries'], label);
  array(value.entries, `${label}.entries`);
  if (value.entries.length > 10000) invalid(`${label}: bounded entry inventory exceeded`);
  const paths = new Map();
  for (const entry of value.entries) {
    plain(entry, `${label}.entry`);
    if (entry.kind === 'file') {
      object(entry, ['path', 'kind', 'sha256', 'mode'], label); hash(entry.sha256, label); nat(entry.mode, label);
      if (entry.mode > 511) invalid(`${label}: invalid mode`);
    } else if (entry.kind === 'directory') {
      object(entry, ['path', 'kind', 'children'], label); array(entry.children, label);
      for (const child of entry.children) {
        posixRelative(child, label);
        if (child.includes('/')) invalid(`${label}: child is not a basename`);
      }
      ordered(entry.children, child => child, label);
    } else if (entry.kind === 'absent') object(entry, ['path', 'kind'], label);
    else invalid(`${label}: invalid kind`);
    productPath(entry.path, label); paths.set(entry.path, entry);
  }
  ordered(value.entries, entry => entry.path, label);
  for (const entry of value.entries) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = paths.get(parts.slice(0, i).join('/'));
      if (parent && (parent.kind !== 'directory'
        || (i < parts.length - 1 && !parent.children.includes(parts[i]))
        || (i === parts.length - 1 && parent.children.includes(parts[i]) === (entry.kind === 'absent')))) invalid(`${label}: contradictory parent`);
    }
    if (entry.kind === 'directory') for (const child of entry.children) {
      if (!paths.has(`${entry.path}/${child}`) || paths.get(`${entry.path}/${child}`).kind === 'absent') invalid(`${label}: missing present child`);
    }
  }
}
function diagnostic(value, label) {
  object(value, ['code', 'operationAttemptId', 'reason', 'affectedPaths', 'nextAction'], label);
  oneOf(value.code, ERROR_CODES, label); optional(value.operationAttemptId, uuid, label); string(value.reason, label);
  array(value.affectedPaths, label); value.affectedPaths.forEach(item => productPath(item, label));
  ordered(value.affectedPaths, item => item, label);
  oneOf(value.nextAction, ['resume', 'normalize', 'review-local', 'replan', 'validate', 'cleanup', 'stop'], label);
}
function currentDelivery(value, label) {
  object(value, ['slice', 'deliveryId', 'localRevision', 'authoritySha256', 'validation', 'evidence', 'counters', 'baseline', 'normalization', 'lastDiagnostic'], label);
  slice(value.slice, label); uuid(value.deliveryId, label); nat(value.localRevision, label, true); hash(value.authoritySha256, label);
  oneOf(value.validation, ['unvalidated', 'current', 'revalidation-required', 'uncertain'], label);
  if (value.evidence !== null) {
    object(value.evidence, ['path', 'sha256'], `${label}.evidence`);
    if (evidencePath(value.evidence.path, label) !== value.deliveryId) invalid(`${label}: evidence identity mismatch`);
    hash(value.evidence.sha256, label);
  }
  object(value.counters, ['implementationChecks', 'findingsChecks', 'validationAttempts', 'findings'], `${label}.counters`);
  Object.values(value.counters).forEach(count => nat(count, label));
  work(value.baseline, `${label}.baseline`);
  if (value.normalization !== null) {
    const n = value.normalization;
    object(n, ['episodeId', 'operation', 'causeSha256', 'sourceOperationAttemptId', 'used', 'consumedInvocations', 'round', 'status'], `${label}.normalization`);
    uuid(n.episodeId, label); oneOf(n.operation, OPERATIONS, label); hash(n.causeSha256, label); uuid(n.sourceOperationAttemptId, label);
    if (n.used !== 1) invalid(`${label}: normalization reservation`);
    nat(n.consumedInvocations, label); oneOf(n.round, [1, 2, 3, 4, 5], label);
    oneOf(n.status, ['reserved', 'running', 'settled', 'exhausted'], label);
  }
  optional(value.lastDiagnostic, diagnostic, `${label}.lastDiagnostic`);
}
export function validateCurrentContinuity(value) {
  checkedFormat(value, FORMAT.continuity, 'continuity');
  object(value, ['format', 'nextSliceOrdinal', 'deliveries', 'completed'], 'continuity');
  nat(value.nextSliceOrdinal, 'nextSliceOrdinal', true);
  array(value.deliveries, 'deliveries'); array(value.completed, 'completed');
  const ids = new Set(), slices = new Set();
  for (const entry of [...value.deliveries, ...value.completed]) {
    currentDelivery(entry, 'delivery');
    if (ids.has(entry.deliveryId) || slices.has(entry.slice)) invalid('duplicate active/completed delivery');
    ids.add(entry.deliveryId); slices.add(entry.slice);
    if (slice(entry.slice, 'delivery.slice') >= value.nextSliceOrdinal) invalid('nextSliceOrdinal reuses a selector');
  }
  ordered(value.completed, entry => entry.deliveryId, 'completed');
  return value;
}

function recipe(value, label) {
  checkedFormat(value, 'stnl-verification-recipe-v1', label);
  object(value, ['format', 'base', 'cwd', 'checks', 'dependencyReview'], label);
  if (value.base !== 'workspace') invalid(`${label}: invalid base`);
  if (value.cwd !== '.') productPath(value.cwd, label);
  string(value.dependencyReview, label);
  array(value.checks, label);
  if (value.checks.length < 1 || value.checks.length > 32) invalid(`${label}: invalid check count`);
  const ids = new Set();
  const file = ref => {
    object(ref, ['kind', 'path'], label); oneOf(ref.kind, ['product', 'input'], label); recipeReferencePath(ref.path, label);
  };
  const argument = arg => {
    if (arg && Object.hasOwn(arg, 'literal')) { object(arg, ['literal'], label); string(arg.literal, label, false); }
    else { object(arg, ['file'], label); file(arg.file); }
  };
  for (const check of value.checks) {
    object(check, ['id', 'executable', 'args', 'inputs'], label);
    match(check.id, /^verification-[0-9]{2,}$/u, label);
    if (ids.has(check.id)) invalid(`${label}: duplicate check`);
    ids.add(check.id); argument(check.executable);
    if (check.executable.literal === '' || (typeof check.executable.literal === 'string' && /[\r\n]/u.test(check.executable.literal))) invalid(`${label}: invalid executable`);
    array(check.args, label).forEach(argument); array(check.inputs, label).forEach(file);
  }
}
function projectionDelivery(value, label, terminalOwner = false) {
  object(value, ['deliveryId', 'objectiveAndObservableResult', 'requirements', 'includedScope', 'outOfScopeAndBoundaries', 'authorizedAreas', 'existingInputs', 'protectedResponsibilities', 'dependencies', 'risksAndStrategy', 'expectedTests', 'verificationRecipe', 'completionCriterion', 'taskResult', 'obligations'], label);
  uuid(value.deliveryId, label);
  for (const key of ['objectiveAndObservableResult', 'requirements', 'includedScope', 'outOfScopeAndBoundaries', 'authorizedAreas', 'existingInputs', 'protectedResponsibilities', 'risksAndStrategy', 'expectedTests', 'completionCriterion', 'taskResult']) string(value[key], `${label}.${key}`);
  array(value.dependencies, label); value.dependencies.forEach(item => uuid(item, label));
  if (new Set(value.dependencies).size !== value.dependencies.length || value.dependencies.includes(value.deliveryId)) invalid(`${label}: invalid dependencies`);
  recipe(value.verificationRecipe, `${label}.verificationRecipe`);
  array(value.obligations, label);
  if (value.obligations.length === 0) invalid(`${label}: obligations required`);
  const obligationIds = new Set();
  for (const item of value.obligations) {
    object(item, ['id', 'requirement', 'contribution', 'fullOwner', 'condition', 'proof'], label);
    match(item.id, /^obligation-[0-9]{2,}$/u, label); match(item.requirement, /^[A-Z][A-Z0-9]*-[0-9]+$/u, label);
    oneOf(item.contribution, ['complete', 'partial'], label);
    string(item.fullOwner, `${label}.fullOwner`);
    if (terminalOwner) uuid(item.fullOwner, `${label}.fullOwner`);
    else if (item.fullOwner.startsWith('delivery:')) uuid(item.fullOwner.slice(9), label);
    else slice(item.fullOwner, label);
    string(item.condition, label); string(item.proof, label);
    if (obligationIds.has(item.id)) invalid(`${label}: duplicate obligation`);
    obligationIds.add(item.id);
  }
}
function currentProjection(value) {
  checkedFormat(value, FORMAT.projection, 'normativeProjection');
  object(value, ['format', 'requirementsAuthority', 'global', 'deliveries', 'completed'], 'normativeProjection');
  hash(value.requirementsAuthority, 'normativeProjection.requirementsAuthority');
  object(value.global, ['objective', 'strategy', 'risks', 'order'], 'global');
  ['objective', 'strategy', 'risks'].forEach(key => string(value.global[key], `global.${key}`));
  array(value.global.order, 'global.order').forEach(item => uuid(item, 'global.order'));
  array(value.deliveries, 'projection.deliveries').forEach(item => projectionDelivery(item, 'projection.delivery'));
  array(value.completed, 'projection.completed').forEach(item => projectionDelivery(item, 'projection.completed'));
  ordered(value.completed, item => item.deliveryId, 'projection.completed');
  const all = [...value.deliveries, ...value.completed], ids = all.map(item => item.deliveryId);
  if (new Set(ids).size !== ids.length || !same(value.global.order, value.deliveries.map(item => item.deliveryId))) invalid('projection membership/order mismatch');
  for (const item of all) if (item.dependencies.some(id => !ids.includes(id))) invalid('projection dependency missing');
}
function review(value, scope, projection, expectedPaths) {
  object(value, ['scope', 'decision', 'authoritySha256', 'examinedArtifactHashes', 'evidenceDecisions', 'summary'], 'review');
  if (value.scope !== scope || value.decision !== 'approved') invalid('review scope/decision mismatch');
  hash(value.authoritySha256, 'review.authoritySha256');
  if (value.authoritySha256 !== projected(scope === 'set' ? 'global-review' : 'delivery', projection)) invalid('review authority hash mismatch');
  array(value.examinedArtifactHashes, 'review.examinedArtifactHashes');
  const actualPaths = [];
  for (const item of value.examinedArtifactHashes) {
    object(item, ['path', 'sha256'], 'examined artifact'); preparationPath(item.path, 'examined artifact'); hash(item.sha256, 'examined artifact'); actualPaths.push(item.path);
  }
  ordered(value.examinedArtifactHashes, item => item.path, 'examinedArtifactHashes');
  if (!same(actualPaths, [...expectedPaths].sort(ordinal))) invalid('review examined scope mismatch');
  array(value.evidenceDecisions, 'evidenceDecisions');
  for (const item of value.evidenceDecisions) {
    object(item, ['deliveryId', 'evidenceSha256', 'disposition', 'reason'], 'evidenceDecision');
    uuid(item.deliveryId, 'evidenceDecision.deliveryId'); hash(item.evidenceSha256, 'evidenceDecision.evidenceSha256');
    oneOf(item.disposition, ['retain-current', 'revalidate'], 'evidenceDecision.disposition'); string(item.reason, 'evidenceDecision.reason');
  }
  ordered(value.evidenceDecisions, item => item.deliveryId, 'evidenceDecisions');
  string(value.summary, 'review.summary');
}
function approved(value) {
  checkedFormat(value, FORMAT.preparation, 'approved preparation');
  object(value, ['format', 'preparationRevision', 'requirementsAuthority', 'normativeSha256', 'normativeProjection', 'globalReview', 'deliveries', 'completed', 'reviewedArtifacts'], 'approved preparation');
  nat(value.preparationRevision, 'preparationRevision', true); hash(value.requirementsAuthority, 'requirementsAuthority'); hash(value.normativeSha256, 'normativeSha256');
  currentProjection(value.normativeProjection);
  if (value.requirementsAuthority !== value.normativeProjection.requirementsAuthority || value.normativeSha256 !== projected('preparation', value.normativeProjection)) invalid('preparation authority mismatch');
  const p = value.normativeProjection;
  review(value.globalReview, 'set', {requirementsAuthority: p.requirementsAuthority, global: p.global, deliveryIds: p.deliveries.map(item => item.deliveryId), completed: p.completed}, ['plan.md', 'tasks.md']);
  array(value.deliveries, 'approved deliveries');
  if (value.deliveries.length !== p.deliveries.length) invalid('approved delivery count mismatch');
  for (let i = 0; i < value.deliveries.length; i += 1) {
    const item = value.deliveries[i], leaf = p.deliveries[i];
    object(item, ['slice', 'deliveryId', 'localRevision', 'review'], 'approved delivery');
    slice(item.slice, 'approved slice'); uuid(item.deliveryId, 'approved deliveryId'); nat(item.localRevision, 'localRevision', true);
    if (item.deliveryId !== leaf.deliveryId) invalid('approved delivery identity mismatch');
    review(item.review, 'slice', leaf, [`plans/${item.slice}.md`, `tasks/${item.slice}.md`]);
  }
  array(value.completed, 'approved completed');
  for (const item of value.completed) {
    object(item, ['deliveryId', 'slice', 'localRevision', 'evidenceSha256'], 'approved completed');
    uuid(item.deliveryId, 'completed.deliveryId'); slice(item.slice, 'completed.slice'); nat(item.localRevision, 'completed.localRevision', true); hash(item.evidenceSha256, 'completed.evidenceSha256');
  }
  ordered(value.completed, item => item.deliveryId, 'approved completed');
  if (!same(value.completed.map(item => item.deliveryId), p.completed.map(item => item.deliveryId))) invalid('approved completed membership mismatch');
  const activeSlices = new Set(value.deliveries.map(item => item.slice));
  const completedIds = new Set(value.completed.map(item => item.deliveryId));
  for (const leaf of [...p.deliveries, ...p.completed]) for (const obligation of leaf.obligations) {
    if (obligation.fullOwner.startsWith('delivery:')) {
      if (!completedIds.has(obligation.fullOwner.slice('delivery:'.length))) invalid('obligation full owner is not completed');
    } else if (!activeSlices.has(obligation.fullOwner)) invalid('obligation full owner is not active');
  }
  array(value.reviewedArtifacts, 'reviewedArtifacts');
  const artifactMap = new Map();
  for (const item of value.reviewedArtifacts) {
    object(item, ['path', 'sha256', 'utf8'], 'reviewed artifact'); preparationPath(item.path, 'reviewed artifact'); hash(item.sha256, 'reviewed artifact'); string(item.utf8, 'reviewed artifact utf8', false);
    if (raw(Buffer.from(item.utf8, 'utf8')) !== item.sha256) invalid('reviewed artifact hash mismatch');
    artifactMap.set(item.path, item.sha256);
  }
  ordered(value.reviewedArtifacts, item => item.path, 'reviewedArtifacts');
  const expected = ['plan.md', 'tasks.md', ...value.deliveries.flatMap(item => [`plans/${item.slice}.md`, `tasks/${item.slice}.md`])].sort(ordinal);
  if (!same([...artifactMap.keys()].sort(ordinal), expected)) invalid('reviewed artifact manifest mismatch');
  for (const r of [value.globalReview, ...value.deliveries.map(item => item.review)]) for (const examined of r.examinedArtifactHashes) {
    if (artifactMap.get(examined.path) !== examined.sha256) invalid('examined artifact hash mismatch');
  }
  return value;
}

function origin(value, label) {
  object(value, ['operationAttemptId', 'deliveryId', 'slice', 'operation', 'preparationRevision', 'localRevision', 'normativeSha256', 'originActivationId', 'transport', 'dispatchId', 'runnerId'], label);
  uuid(value.operationAttemptId, label); uuid(value.deliveryId, label); slice(value.slice, label);
  oneOf(value.operation, OPERATIONS, label); nat(value.preparationRevision, label, true);
  optional(value.localRevision, (item, key) => nat(item, key, true), label);
  hash(value.normativeSha256, label); uuid(value.originActivationId, label);
  if(value.transport!=='native')fail('UNSUPPORTED_FORMAT',`${label}: native evidence transport required`); string(value.dispatchId, label); string(value.runnerId, label);
}
function sources(value, transport, label, rejection) {
  const native = ['transport', 'rawResponse', 'receipt', 'verificationObservation', 'origin', 'agentBinding', 'concludedToolResult', 'removalProofs', 'legacyPreparation'];
  if(transport!=='native')fail('UNSUPPORTED_FORMAT',`${label}: native sources required`);
  object(value, native, label);
  if (value.transport !== transport) invalid(`${label}: transport mismatch`);
  for (const field of (native).filter(item => !['transport', 'verificationObservation', 'removalProofs', 'runtimeIdentity', 'legacyPreparation'].includes(item))) hash(value[field], `${label}.${field}`);
  if (rejection) optional(value.verificationObservation, hash, label);
  else hash(value.verificationObservation, label);
  if (value.legacyPreparation !== null) invalid(`${label}: unexpected legacy preparation`);
  for (const field of ['removalProofs']) {
    array(value[field], `${label}.${field}`).forEach(item => hash(item, label));
    ordered(value[field], item => item, `${label}.${field}`);
  }
}
function terminal(value, label) {
  object(value, ['requirementsAuthority', 'objective', 'strategy', 'risks', 'deliveries'], label);
  hash(value.requirementsAuthority, label);
  ['objective', 'strategy', 'risks'].forEach(key => string(value[key], label));
  array(value.deliveries, label).forEach(item => projectionDelivery(item, label, true));
  ordered(value.deliveries, item => item.deliveryId, label);
  const ids = new Set(value.deliveries.map(item => item.deliveryId));
  for (const leaf of value.deliveries) {
    if (leaf.dependencies.some(id => !ids.has(id))) invalid(`${label}: dependency missing`);
    for (const obligation of leaf.obligations) if (!ids.has(obligation.fullOwner)) invalid(`${label}: full owner missing`);
  }
}
export function validateCurrentTerminalProjection(value) {
  terminal(value, 'terminal projection');
  return value;
}
// Presentation membership and selectors are not terminal authority. Clone the
// approved leaves: retained records and their original owner spelling stay literal.
export function currentTerminalProjection(snapshot) {
  approved(snapshot);
  const projection = snapshot.normativeProjection;
  const members = [...snapshot.deliveries, ...snapshot.completed];
  const bySlice = new Map(members.map(item => [item.slice, item.deliveryId]));
  const deliveries = [...projection.deliveries, ...projection.completed].map(leaf => ({
    ...structuredClone(leaf),
    obligations: leaf.obligations.map(item => ({...item,
      fullOwner: item.fullOwner.startsWith('delivery:') ? item.fullOwner.slice(9) : bySlice.get(item.fullOwner)})),
  })).sort((left, right) => ordinal(left.deliveryId, right.deliveryId));
  return validateCurrentTerminalProjection({requirementsAuthority: snapshot.requirementsAuthority,
    objective: projection.global.objective, strategy: projection.global.strategy,
    risks: projection.global.risks, deliveries});
}
function record(value, label, rejection = false) {
  plain(value, label);
  if (rejection) object(value, ['kind', 'operationAttemptId', 'origin', 'diagnostic', 'consumedInvocations', 'round', 'sources'], label);
  else object(value, ['kind', 'recordFormat', 'id', 'origin', 'contract', 'recordUtf8', 'testedWork', 'sources'], label);
  if (rejection) {
    if (value.kind !== 'rejection') invalid(`${label}: invalid support kind`);
    uuid(value.operationAttemptId, label); string(value.diagnostic, label); nat(value.consumedInvocations, label, true); oneOf(value.round, [1, 2, 3, 4, 5], label);
  } else {
    oneOf(value.kind, ['implementation-check', 'findings-check', 'validation'], label);
    oneOf(value.recordFormat, ['stnl-task-record-v2'], label);
    const idPrefix = value.kind === 'validation' ? 'attempt' : value.kind;
    match(value.id, new RegExp(`^${idPrefix}-[0-9]{2,}$`, 'u'), label);
    nat(Number(value.id.slice(idPrefix.length + 1)), `${label}: record identifier`, true);
    string(value.recordUtf8, label); work(value.testedWork, label);
    object(value.contract, ['delivery', 'context', 'terminal', 'recipe'], label);
    projectionDelivery(value.contract.delivery, label);
    object(value.contract.context, ['requirementsAuthority', 'objective', 'strategy', 'risks'], label);
    hash(value.contract.context.requirementsAuthority, label);
    ['objective', 'strategy', 'risks'].forEach(key => string(value.contract.context[key], label));
    optional(value.contract.terminal, terminal, label); recipe(value.contract.recipe, label);
    if (value.kind !== 'validation' && value.contract.terminal !== null) invalid(`${label}: auxiliary terminal judgment`);
    if (!same(value.contract.delivery.verificationRecipe, value.contract.recipe)) invalid(`${label}: recipe differs from delivery`);
  }
  origin(value.origin, label);
  if (rejection) {
    if (value.operationAttemptId !== value.origin.operationAttemptId) invalid(`${label}: origin mismatch`);
  }
  nat(value.origin.localRevision, `${label}: local revision`, true);
  sources(value.sources, value.origin.transport, label, rejection);
  if (!rejection && value.contract.delivery.deliveryId !== value.origin.deliveryId) invalid(`${label}: contract delivery mismatch`);
}
export function validateCurrentEvidence(value) {
  checkedFormat(value, FORMAT.evidence, 'evidence');
  object(value, ['format', 'deliveryId', 'slice', 'logicalTaskPath', 'currentAuthoritySha256', 'implementation', 'findingsChecks', 'validation', 'openFindings', 'openDivergences', 'support', 'objects'], 'evidence');
  uuid(value.deliveryId, 'evidence.deliveryId'); slice(value.slice, 'evidence.slice'); taskPath(value.logicalTaskPath, 'evidence.logicalTaskPath');
  if (value.logicalTaskPath !== `tasks/${value.slice}.md`) invalid('evidence task identity mismatch');
  hash(value.currentAuthoritySha256, 'evidence.currentAuthoritySha256');
  const records = [];
  for (const [field, kind] of [['implementation', 'implementation-check'], ['findingsChecks', 'findings-check']]) {
    array(value[field], field);
    for (const item of value[field]) { record(item, field); if (item.kind !== kind) invalid(`${field}: wrong record kind`); records.push(item); }
  }
  if (value.validation !== null) { record(value.validation, 'validation'); if (value.validation.kind !== 'validation') invalid('validation: wrong kind'); records.push(value.validation); }
  array(value.support, 'support');
  for (const item of value.support) { plain(item, 'support'); record(item, 'support', item.kind === 'rejection'); if (item.kind !== 'rejection') records.push(item); }
  const recordIds = new Set();
  for (const item of records) {
    const ordinalId = `${item.kind}:${Number(item.id.slice(item.id.lastIndexOf('-') + 1))}`;
    if (recordIds.has(ordinalId)) invalid('duplicate evidence record ordinal');
    recordIds.add(ordinalId);
  }
  for (const item of [...records, ...value.support]) {
    if (item.origin.deliveryId !== value.deliveryId || item.origin.slice !== value.slice) invalid('evidence origin identity mismatch');
  }
  for (const [field, names] of [['openFindings', ['id', 'severity', 'originAttempt', 'problem', 'evidence', 'impact', 'relatedAuthority', 'expectedCorrection']], ['openDivergences', ['id', 'severity', 'problem', 'evidence', 'requiredAuthorityOperation']]]) {
    array(value[field], field);
    const ids = new Set();
    for (const item of value[field]) {
      object(item, names, field);
      for (const key of names) string(item[key], `${field}.${key}`);
      oneOf(item.severity, ['blocking', 'advisory'], field);
      match(item.id, new RegExp(`^${field === 'openFindings' ? 'finding' : 'divergence'}-[0-9]{2,}$`, 'u'), `${field}.id`);
      const ordinalId = nat(Number(item.id.slice(item.id.lastIndexOf('-') + 1)), `${field}: identifier`, true);
      if (field === 'openFindings') {
        match(item.originAttempt, /^attempt-[0-9]{2,}$/u, 'finding.originAttempt');
        if (!records.some(record => record.kind === 'validation' && record.id === item.originAttempt)) evidenceError('finding origin is absent from current/support records');
      }
      if (field === 'openDivergences') oneOf(item.requiredAuthorityOperation, ['RESUME', 'REPLAN'], field);
      if (ids.has(ordinalId)) invalid(`${field}: duplicate ordinal`);
      ids.add(ordinalId);
    }
  }
  array(value.objects, 'objects');
  const objects = new Map();
  for (const item of value.objects) {
    object(item, ['id', 'bytesBase64'], 'object'); hash(item.id, 'object.id'); string(item.bytesBase64, 'object.bytesBase64', false);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.bytesBase64)) evidenceError('noncanonical object base64');
    const bytes = Buffer.from(item.bytesBase64, 'base64');
    if (bytes.toString('base64') !== item.bytesBase64 || raw(bytes) !== item.id) evidenceError('object raw hash mismatch');
    objects.set(item.id, bytes);
  }
  ordered(value.objects, item => item.id, 'objects');
  const refs = new Set();
  for (const item of [...records, ...value.support]) {
    for (const [key, target] of Object.entries(item.sources)) {
      if (key === 'transport' || target === null) continue;
      if (Array.isArray(target)) target.forEach(id => refs.add(id));
      else if (key !== 'legacyPreparation' || target !== null) refs.add(target);
    }
  }
  for (const ref of refs) if (!objects.has(ref)) evidenceError(`missing referenced object ${ref}`);
  for (const id of objects.keys()) if (!refs.has(id)) evidenceError(`orphan object ${id}`);
  return value;
}

function decode(bytes, label) {
  if (!(bytes instanceof Uint8Array)) invalid(`${label}: Uint8Array required`);
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { invalid(`${label}: invalid UTF-8`); }
}
function validateCurrentContent(files) {
  if (!(files instanceof Map) || Object.getPrototypeOf(files) !== Map.prototype || Reflect.ownKeys(files).length)
    invalid('files: ordinary ReadonlyMap required');
  const names = [...Map.prototype.keys.call(files)];
  for (const name of names) executionPath(name, 'file path');
  if (names.includes('activation.json')) invalid('candidate cannot include activation.json');
  const parsed = new Map();
  for (const name of names) {
    const bytes = Map.prototype.get.call(files, name);
    const text = decode(bytes, name);
    if (name.endsWith('.json')) parsed.set(name, parseCurrentJson(text));
  }
  const snapshot = approved(parsed.get('approved-preparation.json'));
  const continuity = validateCurrentContinuity(parsed.get('continuity.json'));
  const expected = ['approved-preparation.json', 'continuity.json', 'plan.md', 'tasks.md',
    ...snapshot.deliveries.flatMap(item => [`plans/${item.slice}.md`, `tasks/${item.slice}.md`]),
    ...[...continuity.deliveries, ...continuity.completed].filter(item => item.evidence).map(item => item.evidence.path)].sort(ordinal);
  if (!same(names.sort(ordinal), expected)) invalid('current content layout mismatch');
  if (!same(continuity.deliveries.map(item => [item.slice, item.deliveryId, item.localRevision]), snapshot.deliveries.map(item => [item.slice, item.deliveryId, item.localRevision]))) invalid('active delivery binding mismatch');
  for (const item of continuity.completed) if (item.evidence === null || item.validation !== 'current') evidenceError('completed delivery lacks current evidence');
  if (!same(continuity.completed.map(item => [item.slice, item.deliveryId, item.localRevision, item.evidence?.sha256]), snapshot.completed.map(item => [item.slice, item.deliveryId, item.localRevision, item.evidenceSha256]))) invalid('completed delivery binding mismatch');
  const byDelivery = new Map([...continuity.deliveries, ...continuity.completed].map(item => [item.deliveryId, item]));
  const replacementFor=(current,decision)=>{
    const bundle=current.evidence && parsed.get(current.evidence.path);
    const record=bundle?.validation;
    const approvedDelivery=snapshot.deliveries.find(item=>item.deliveryId===current.deliveryId);
    const leaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===current.deliveryId);
    const global=snapshot.normativeProjection.global;
    const retainedRecords=bundle?.support?.filter(item=>item.kind!=='rejection')??[];
    const convertedRejection=bundle?.support?.some(item=>item.kind==='rejection'
      && ['VALIDATE_SLICE','APPLY_FINDINGS'].includes(item.origin.operation))
      && (current.normalization===null || current.normalization?.operation
        ===bundle.support.filter(item=>item.kind==='rejection').at(-1)?.origin.operation
        && ['settled','exhausted'].includes(current.normalization.status))
      && bundle.support.filter(item=>item.kind==='rejection'&&item.origin.operation==='VALIDATE_SLICE').length<=5
      && bundle.support.filter(item=>item.kind==='rejection'&&item.origin.operation==='APPLY_FINDINGS').length
        <=5
      && bundle.support.filter(item=>item.kind==='rejection'&&item.origin.operation==='EXECUTE_SLICE').length<5;
    if(convertedRejection && approvedDelivery) {
      // A rejected judgment retains the literal reviewed predecessor. Recover
      // only trailing formal refusals; full native proof is checked by readers.
      for(let count=1;count<=5 && count<=bundle.support.length;count+=1) {
        if(bundle.support.slice(-count).some(item=>item.kind!=='rejection'
          || item.origin.operation!=='VALIDATE_SLICE'))break;
        const support=bundle.support.slice(0,-count);
        const records=[...bundle.implementation,...bundle.findingsChecks,...support,
          ...(record?[record]:[])];
        const ids=new Set(records.flatMap(item=>Object.values(item.sources).flat())
          .filter(item=>typeof item==='string' && HASH.test(item)));
        const prior={...bundle,support,objects:bundle.objects.filter(item=>ids.has(item.id))};
        if(raw(Buffer.from(canonical(prior)+'\n','utf8'))===decision.evidenceSha256)return true;
      }
    }
    const validConvertedRecord=record?.kind==='validation'
      && record.recordFormat==='stnl-task-record-v2'
      && record.sources?.legacyPreparation===null
      && record.origin?.deliveryId===current.deliveryId && record.origin?.slice===current.slice
      && record.origin?.operation==='VALIDATE_SLICE'
      && record.origin?.preparationRevision===snapshot.preparationRevision
      && record.origin?.localRevision===approvedDelivery?.localRevision
      && record.origin?.normativeSha256===current.authoritySha256
      && same(record.contract?.delivery,leaf)
      && same(record.contract?.context,{requirementsAuthority:snapshot.requirementsAuthority,
        objective:global.objective,strategy:global.strategy,risks:global.risks})
      && same(record.contract?.recipe,leaf.verificationRecipe);
    if(decision.disposition==='revalidate' && validConvertedRecord
      && bundle.implementation.length>0 && bundle.findingsChecks.length===0
      && bundle.support.length<5&&bundle.support.every(item=>item.kind==='rejection'&&item.origin.operation==='EXECUTE_SLICE')
      && bundle.openDivergences.length===0
      && bundle.implementation.every(item=>item.recordFormat==='stnl-task-record-v2'
        && item.origin.operation==='EXECUTE_SLICE' && item.origin.deliveryId===current.deliveryId
        && item.origin.slice===current.slice && item.origin.localRevision<approvedDelivery.localRevision)) {
      // The first formal after a private review replaces an implementation-only
      // reviewed bundle. Reconstruct its exact bytes; the frozen decision stays
      // bound to that predecessor, never to a hash supplied by the new result.
      const ids=new Set([...bundle.implementation,...bundle.support].flatMap(item=>Object.values(item.sources).flat())
        .filter(item=>typeof item==='string' && HASH.test(item)));
      const prior={...bundle,validation:null,openFindings:[],
        objects:bundle.objects.filter(item=>ids.has(item.id))};
      if(raw(Buffer.from(canonical(prior)+'\n','utf8'))===decision.evidenceSha256)return true;
    }
    const historicalFormals=bundle?.support?.filter(item=>item.kind==='validation')??[];
    const implementationRefusals=bundle?.support?.filter(item=>item.kind==='rejection'&&item.origin.operation==='EXECUTE_SLICE')??[];
    const historicalPrior=approvedDelivery?.localRevision>1
      && decision.disposition==='revalidate'
      && historicalFormals.length>=1&&implementationRefusals.length<5
      && historicalFormals.at(-1)?.recordFormat==='stnl-task-record-v2'
      && historicalFormals.at(-1)?.origin?.localRevision===approvedDelivery.localRevision-1
      && record?.recordFormat==='stnl-task-record-v2'
      && record.origin?.localRevision===approvedDelivery.localRevision
      && bundle.findingsChecks.length===0;
    if(historicalPrior) {
      const old=historicalFormals.at(-1),support=bundle.support.filter(item=>item!==old);
      const ids=new Set([...bundle.implementation,...support,old].flatMap(item=>Object.values(item.sources).flat()).filter(item=>typeof item==='string' && HASH.test(item)));
      const prior={...bundle,validation:old,support,openFindings:[],
        objects:bundle.objects.filter(item=>ids.has(item.id))};
      if(raw(Buffer.from(canonical(prior)+'\n','utf8'))===decision.evidenceSha256)
        return true;
    }
    const convertedFindings=bundle?.findingsChecks?.length>0
      && retainedRecords.every(item=>item.kind==='validation')
      && [...bundle.findingsChecks,...retainedRecords,record].every(item=>item
        && item.recordFormat==='stnl-task-record-v2' && item.sources?.legacyPreparation===null
        && item.origin?.deliveryId===current.deliveryId
        && item.origin?.slice===current.slice
        && item.origin?.preparationRevision===snapshot.preparationRevision
        && item.origin?.localRevision===approvedDelivery?.localRevision
        && item.origin?.normativeSha256===current.authoritySha256
        && item.origin?.operation===(item.kind==='findings-check'?'APPLY_FINDINGS':'VALIDATE_SLICE')
        && same(item.contract?.delivery,leaf)
        && same(item.contract?.context,{requirementsAuthority:snapshot.requirementsAuthority,
          objective:global.objective,strategy:global.strategy,risks:global.risks})
        && same(item.contract?.recipe,leaf.verificationRecipe));
    // Structural admission only; the reader authenticates every historical
    // operational capture independently before exposing current validity.
    const retainedRemoval=bundle?.support?.length>0
      &&implementationRefusals.length<5&&[...bundle.support,...bundle.findingsChecks].every(item=>
        item.kind==='rejection'?(item.origin.operation==='EXECUTE_SLICE'
          &&bundle.support.some(record=>record.kind==='implementation-check')
          ||item.origin.operation==='APPLY_FINDINGS'&&bundle.support.filter(record=>record.kind==='rejection'&&record.origin.operation==='APPLY_FINDINGS').length<=5&&[...bundle.support,...bundle.findingsChecks].some(record=>record.kind==='findings-check')
          ||item.origin.operation==='VALIDATE_SLICE'&&convertedRejection)
          &&item.origin.transport==='native'&&item.origin.deliveryId===current.deliveryId
          &&item.origin.slice===current.slice&&item.origin.localRevision<=current.localRevision
        :['implementation-check','findings-check','validation'].includes(item.kind)
          &&item.recordFormat==='stnl-task-record-v2'&&item.origin.transport==='native'
          &&item.origin.operation===({'implementation-check':'EXECUTE_SLICE','findings-check':'APPLY_FINDINGS',validation:'VALIDATE_SLICE'})[item.kind]
          &&item.origin.deliveryId===current.deliveryId&&item.origin.slice===current.slice
          &&item.origin.localRevision<=current.localRevision);
    return decision.evidenceSha256!==current.evidence?.sha256 && approvedDelivery
      && (bundle?.implementation?.length===0
      && (bundle.findingsChecks?.length===0 || convertedFindings || retainedRemoval)
      && (bundle.support?.length===0 || convertedFindings || convertedRejection || retainedRemoval)
      && bundle.openDivergences?.length===0
      && validConvertedRecord);
  };
  for (const [reviewedId, decision] of [
    ...snapshot.globalReview.evidenceDecisions.map(item => [null, item]),
    ...snapshot.deliveries.flatMap(item => item.review.evidenceDecisions.map(decision => [item.deliveryId, decision])),
  ]) {
    const current = byDelivery.get(decision.deliveryId);
    const local=reviewedId===null&&current?.localRevision>1
      ?snapshot.deliveries.find(item=>item.deliveryId===current.deliveryId)?.review.evidenceDecisions
        .find(item=>item.deliveryId===current.deliveryId&&item.disposition==='revalidate'):null;
    const superseded=local&&(current.evidence?.sha256===local.evidenceSha256||replacementFor(current,local));
    if ((reviewedId !== null && decision.deliveryId !== reviewedId)
      || !current?.evidence || (current.evidence.sha256 !== decision.evidenceSha256
        && !superseded && !replacementFor(current,decision))) invalid('review evidence decision binding mismatch');
  }
  const leaves = new Map([...snapshot.normativeProjection.deliveries, ...snapshot.normativeProjection.completed].map(item => [item.deliveryId, item]));
  const referenced = new Set();
  for (const current of [...continuity.deliveries, ...continuity.completed]) {
    const leaf = leaves.get(current.deliveryId);
    if (!leaf || current.authoritySha256 !== projected('delivery', leaf)) invalid('delivery authority hash mismatch');
    if (continuity.completed.includes(current) && (current.validation !== 'current' || current.evidence === null)) evidenceError('completed delivery lacks current evidence');
    if (current.validation === 'current' && current.evidence === null) evidenceError('current delivery lacks evidence');
    if (current.evidence === null) continue;
    const evidence = validateCurrentEvidence(parsed.get(current.evidence.path));
    if (raw(Map.prototype.get.call(files, current.evidence.path)) !== current.evidence.sha256) invalid('continuity evidence raw hash mismatch');
    if (evidence.deliveryId !== current.deliveryId || evidence.slice !== current.slice || evidence.currentAuthoritySha256 !== current.authoritySha256) invalid('evidence current binding mismatch');
    if (current.validation === 'current' && evidence.validation === null) evidenceError('current delivery lacks formal validation record');
    for (const record of [...evidence.implementation, ...evidence.findingsChecks, ...(evidence.validation ? [evidence.validation] : []),
      ...evidence.support.filter(item => item.kind !== 'rejection')]) {
      const counter = record.kind === 'implementation-check' ? 'implementationChecks'
        : record.kind === 'findings-check' ? 'findingsChecks' : 'validationAttempts';
      if (Number(record.id.slice(record.id.lastIndexOf('-') + 1)) > current.counters[counter]) invalid('record exceeds monotonic counter');
    }
    for (const finding of evidence.openFindings) {
      if (Number(finding.id.slice('finding-'.length)) > current.counters.findings) invalid('finding exceeds monotonic counter');
    }
    for (const object of evidence.objects) referenced.add(object.id);
  }
  return {snapshot, continuity, referencedObjects: [...referenced].sort(ordinal)};
}

export function validateCurrentCandidate(input) {
  object(input, ['files'], 'candidate input');
  return validateCurrentContent(input.files);
}

export function validateCurrentImage(input) {
  object(input, ['activationBytes', 'files'], 'image input');
  const activation = validateCurrentActivation(parseCurrentJson(decode(input.activationBytes, 'activation')));
  const content = validateCurrentContent(input.files);
  const {snapshot, continuity} = content;
  const names = [...Map.prototype.keys.call(input.files)].sort(ordinal);
  if (!same(names, activation.artifacts.map(item => item.path))) invalid('image file manifest mismatch');
  for (const item of activation.artifacts) {
    if (raw(Map.prototype.get.call(input.files, item.path)) !== item.sha256)
      invalid(`raw artifact hash mismatch: ${item.path}`);
  }
  if (raw(Map.prototype.get.call(input.files, 'approved-preparation.json')) !== activation.approvedSnapshotSha256
    || activation.preparationRevision !== snapshot.preparationRevision
    || activation.requirementsAuthority !== snapshot.requirementsAuthority
    || activation.normativeSha256 !== snapshot.normativeSha256) invalid('activation preparation binding mismatch');
  if (activation.activeAttempt) {
    const owner = activation.activeAttempt;
    const current = continuity.deliveries.find(item => item.deliveryId === owner.deliveryId && item.slice === owner.slice);
    if (!current || current.localRevision !== owner.localRevision) invalid('active attempt delivery mismatch');
    if (activation.preparationRevision > 1) {
      const approved = snapshot.deliveries.find(item => item.deliveryId === owner.deliveryId && item.slice === owner.slice);
      if (!approved || owner.normativeSha256 !== current.authoritySha256
        || owner.normativeSha256 !== approved.review.authoritySha256)
        invalid('converted active attempt delivery authority mismatch');
    }
  }
  return {activation, continuity, referencedObjects: content.referencedObjects};
}

function absolute(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)
    || path.normalize(value) !== value || (value.endsWith(path.sep) && value !== path.parse(value).root)
    || value.split(path.sep).some(part => part === '.' || part === '..')) unsafe(`${label}: noncanonical absolute path`);
  return value;
}
function within(parent, child, strict = false) {
  const relative = path.relative(parent, child);
  return (!strict || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function contextRoot(context) {
  try { plain(context, 'ImageContext'); } catch { unsafe('invalid ImageContext'); }
  const names = ['logicalSpecRoot', 'logicalAuthorityPath', 'logicalExecutionRoot', 'physicalExecutionRoot', 'productRoot'];
  if (Object.keys(context).sort(ordinal).join('\0') !== [...names].sort(ordinal).join('\0')) unsafe('invalid ImageContext fields');
  for (const name of names) if (context[name] !== null) absolute(context[name], name);
  const {logicalSpecRoot: spec, logicalAuthorityPath: authority, logicalExecutionRoot: execution, physicalExecutionRoot: physical, productRoot: product} = context;
  if (!authority || !execution || !physical || !product) unsafe('missing ImageContext path');
  const roots = [spec, authority, execution, physical, product].filter(item => item !== null).map(item => path.parse(item).root);
  if (new Set(roots).size !== 1 || !within(product, authority, true) || !within(product, execution, true)) unsafe('ImageContext root/containment mismatch');
  if (spec !== null) {
    if (!within(product, spec) || authority !== path.join(spec, 'feature_spec.md') || execution !== path.join(spec, 'execution')) unsafe('lifecycle ImageContext mismatch');
  } else if (path.basename(authority) === 'feature_spec.md' || !path.parse(authority).name
    || execution !== path.join(path.dirname(authority), `${path.parse(authority).name}-execution`)) unsafe('standalone ImageContext mismatch');
  const anchor = spec ?? execution;
  if (physical !== execution && (within(anchor, physical) || within(physical, anchor))) unsafe('physical candidate overlaps logical image');
  return execution;
}
function artifactPath(context, artifact) {
  const root = contextRoot(context);
  try { preparationPath(artifact, 'artifact'); } catch { unsafe('artifact is not an EC-1 preparation path'); }
  return path.join(root, ...artifact.split('/'));
}
export function logicalArtifactPath(context, relativeArtifact) {
  return artifactPath(context, relativeArtifact);
}
export function resolveLogicalProductClaim(context, artifact, claim) {
  const artifactAbsolute = artifactPath(context, artifact);
  if (typeof claim !== 'string' || !claim || claim.includes('\0') || claim.includes('\\')
    || claim.startsWith('/') || /^[A-Za-z]:/u.test(claim) || claim === '.' || claim.endsWith('/')
    || claim.split('/').some(part => !part || part === '.') || path.posix.normalize(claim) !== claim) unsafe('invalid product claim');
  const target = path.resolve(path.dirname(artifactAbsolute), ...claim.split('/'));
  if (!within(context.productRoot, target)) unsafe('product claim escapes productRoot');
  return target;
}
