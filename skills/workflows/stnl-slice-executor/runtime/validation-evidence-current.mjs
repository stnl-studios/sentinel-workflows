import { createHash } from 'node:crypto';
import path from 'node:path';
import { logicalArtifactPath, parseCurrentJson, resolveLogicalProductClaim, validateCurrentEvidence } from './execution-current.mjs';
import { validateInitialImplementationEvidence } from './execution-evidence-current.mjs';
import {
  verifyCapturedInvocation, verifyWorkObservation, packCaptureSources,
  restoreCaptureSources, closeEvidenceObjects,
} from './execution-evidence-proof.mjs';
import {
  RunnerSemanticResultError, assertRunnerVerdictConsistency, deriveCanonicalRunnerRejection,
  parseSemanticValidationPayload, recoverableRunnerResultDiagnostic, serializeCommand, serializeMarkdownScalar,
} from './runner-result-contract.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const FINDING = /^finding-(0[1-9]|[1-9][0-9]+)$/u;
const ATTEMPT = /^attempt-(0[1-9]|[1-9][0-9]+)$/u;
const FIELDS = ['id','severity','originAttempt','problem','evidence','impact','relatedAuthority','expectedCorrection'];
const ordinal = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const utf8 = value => Buffer.from(value,'utf8');
const raw = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const hex = value => createHash('sha256').update(value).digest('hex');
const encode = value => utf8(`${canonical(value)}\n`);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const invalid = message => fail('INVALID_CURRENT_IMAGE',message);
const incomplete = message => fail('EVIDENCE_INCOMPLETE',message);
const stale = message => fail('EVIDENCE_STALE',message);
const uncertain = message => fail('OWNER_UNCERTAIN',message);
const mismatch = message => fail('OWNER_MISMATCH',message);
function plain(value,label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(`${label}: plain object required`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(item => !Object.hasOwn(item,'value') || !item.enumerable)) invalid(`${label}: non-data property`);
  return value;
}
function closed(value,keys,label) {
  plain(value,label);
  if (Object.keys(value).sort(ordinal).join('\0') !== [...keys].sort(ordinal).join('\0')) invalid(`${label}: fields differ`);
  return value;
}
function dense(value,label,min=0,max=Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max
    || Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length+1
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key,item]) => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || !Object.hasOwn(item,'value') || !item.enumerable))) invalid(`${label}: dense array required`);
  return value;
}
function string(value,label,required=true) {
  if (typeof value !== 'string' || value.includes('\0') || (required && value.trim() === '')) invalid(`${label}: invalid string`);
  for (let i=0;i<value.length;i+=1) {
    const code=value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { if (!(value.charCodeAt(++i) >= 0xdc00 && value.charCodeAt(i) <= 0xdfff)) invalid(`${label}: malformed Unicode`); }
    else if (code >= 0xdc00 && code <= 0xdfff) invalid(`${label}: malformed Unicode`);
  }
  return value;
}
function token(value,pattern,label) { string(value,label); if (!pattern.test(value)) invalid(`${label}: invalid token`); return value; }
function nat(value,label,min=0) { if (!Number.isSafeInteger(value) || Object.is(value,-0) || value < min) invalid(`${label}: invalid integer`); return value; }
function copyBytes(value,label) {
  if (!(value instanceof Uint8Array) || (Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value))
    || Reflect.ownKeys(value).length !== value.length) invalid(`${label}: Uint8Array required`);
  return Buffer.from(value);
}
function textBytes(value,label) {
  const data=copyBytes(value,label); let text;
  try { text=new TextDecoder('utf-8',{fatal:true}).decode(data); } catch { invalid(`${label}: invalid UTF-8`); }
  if (text.startsWith('\ufeff') || text.includes('\0') || !utf8(text).equals(data)) invalid(`${label}: noncanonical UTF-8`);
  return {data,text};
}
function jsonBytes(value,label) {
  const decoded=textBytes(value,label);
  try { return {...decoded,value:parseCurrentJson(decoded.text)}; }
  catch (error) { fail(error.code ?? 'INVALID_CURRENT_IMAGE',`${label}: ${error.message}`); }
}
function canonical(value,signed=false) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(string(value,'canonical',false));
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value,-0) || (!signed && value<0)) invalid('canonical number'); return String(value); }
  if (Array.isArray(value)) return `[${dense(value,'canonical').map(item => canonical(item,signed)).join(',')}]`;
  plain(value,'canonical');
  return `{${Object.keys(value).sort(ordinal).map(key => `${canonical(key)}:${canonical(value[key],signed)}`).join(',')}}`;
}
const same=(left,right) => canonical(left,true) === canonical(right,true);
function equal(left,right,code,label) { if (!same(left,right)) fail(code,`${label}: binding differs`); }
function id(prefix,number) { nat(number,`${prefix} number`,1); return `${prefix}-${String(number).padStart(2,'0')}`; }
function orderedUnique(values,label,pattern) {
  dense(values,label);
  for (const [index,value] of values.entries()) {
    token(value,pattern,label);
    if (label.includes('Scope') || label.includes('scope')) {
      if (value.includes('\\') || value.startsWith('/') || value.endsWith('/') || value.split('/').some(part => !part || part==='.' || part==='..')
        || path.posix.normalize(value)!==value || /^[A-Za-z]:/u.test(value)) fail('UNSAFE_PATH',`${label}: unsafe product path ${value}`);
    }
    if (index && ordinal(values[index-1],value)>=0) invalid(`${label}: noncanonical order/duplicate`);
  }
  return values;
}
function nonPlaceholder(value,label) {
  presentRendered(value,label);
  const rendered=serializeMarkdownScalar(label,value,true).trim();
  if (/^(?:none|not_available)$/iu.test(rendered)) invalid(`${label}: placeholder`);
  return value;
}
function presentRendered(value,label) {
  string(value,label);
  const rendered=serializeMarkdownScalar(label,value,true).trim();
  const outside=rendered.replace(/json:"(?:\\.|[^"\\])*"/gu,'json:""');
  if (/^(?:n\/a|pending)$/iu.test(rendered) || /<[^>\n]+>/u.test(outside)) invalid(`${label}: missing persisted value`);
  return value;
}
function counters(value,label) {
  closed(value,['implementationChecks','findingsChecks','validationAttempts','findings'],label);
  for (const key of Object.keys(value)) nat(value[key],`${label}.${key}`);
  if (value.findingsChecks !== 0) invalid(`${label}: findingsChecks not supported`);
  return value;
}
function owner(value,label) {
  closed(value,['operationAttemptId','ownershipToken','deliveryId','slice','operation','preparationRevision','localRevision','normativeSha256','originActivationId'],label);
  for (const key of ['operationAttemptId','ownershipToken','deliveryId','originActivationId']) token(value[key],UUID,`${label}.${key}`);
  token(value.normativeSha256,HASH,`${label}.normativeSha256`);
  token(value.slice,/^slice-(0[1-9]|[1-9][0-9]+)$/u,`${label}.slice`);
  nat(value.preparationRevision,`${label}.preparationRevision`,1);
  nat(value.localRevision,`${label}.localRevision`,1);
  if (value.operation !== 'VALIDATE_SLICE') invalid(`${label}: formal operation required`);
  return value;
}
function authority(value,context,claimedOwner=null) {
  closed(value,['preparationRevision','localRevision','normativeSha256','delivery','context'],'authority');
  closed(value.context,['requirementsAuthority','objective','strategy','risks'],'authority.context');
  nat(value.preparationRevision,'authority.preparationRevision',1);
  nat(value.localRevision,'authority.localRevision',1);
  token(value.normativeSha256,HASH,'authority.normativeSha256');
  token(value.context.requirementsAuthority,HASH,'authority.context.requirementsAuthority');
  for (const name of ['objective','strategy','risks']) string(value.context[name],`authority.context.${name}`);
  plain(value.delivery,'authority.delivery'); canonical(value.delivery);
  if (claimedOwner) {
    owner(claimedOwner,'owner');
    if (claimedOwner.deliveryId !== value.delivery.deliveryId || claimedOwner.preparationRevision !== value.preparationRevision
      || claimedOwner.localRevision !== value.localRevision || claimedOwner.normativeSha256 !== value.normativeSha256) mismatch('owner/authority');
    logicalArtifactPath(context,`tasks/${claimedOwner.slice}.md`);
  }
  return value;
}
function finding(value,label) {
  closed(value,FIELDS,label);
  token(value.id,FINDING,`${label}.id`);
  token(value.originAttempt,ATTEMPT,`${label}.originAttempt`);
  if (!['blocking','advisory'].includes(value.severity)) invalid(`${label}.severity`);
  for (const key of FIELDS.filter(key => !['id','severity','originAttempt'].includes(key))) nonPlaceholder(value[key],`${label}.${key}`);
  return value;
}
function findings(values,label) {
  dense(values,label);
  values.forEach((item,index) => { finding(item,`${label}[${index}]`); if (index && ordinal(values[index-1].id,item.id)>=0) invalid(`${label}: noncanonical order`); });
  return values;
}
function sourceMap(bundle) { return new Map(bundle.objects.map(item => [item.id,Buffer.from(item.bytesBase64,'base64')])); }
function referencedObjects(records,map) {
  const refs=new Set();
  for (const record of records) for (const [name,ref] of Object.entries(record.sources)) {
    if (name === 'transport' || ref === null) continue;
    if (Array.isArray(ref)) ref.forEach(id => refs.add(id)); else refs.add(ref);
  }
  return [...refs].sort(ordinal).map(id => {
    const data=map.get(id); if (!data) incomplete(`missing source object ${id}`);
    return {id,bytesBase64:data.toString('base64')};
  });
}
function initialOwner(bundle,map) {
  const first=bundle.implementation[0];
  if (!first) invalid('initial checks required');
  const cap=restoreCaptureSources('initial-implementation',first,map);
  return jsonBytes(cap.transport==='native' ? cap.origin : cap.managedContext,'initial owner source').value.owner;
}
function initialBundle(bundle,map) {
  return {...bundle,validation:null,openFindings:[],openDivergences:[],support:[],
    objects:referencedObjects(bundle.implementation,map)};
}
function verifyInitial(bundle,context,approvedAuthority,map) {
  if (!bundle.implementation.length || bundle.implementation.length>3) invalid('initial check count');
  const originOwner=initialOwner(bundle,map);
  const base={context,authority:approvedAuthority,owner:originOwner,currentEvidence:null,
    counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},bundleBytes:encode(initialBundle(bundle,map))};
  validateInitialImplementationEvidence(base);
  const last=bundle.implementation.at(-1);
  const cap=restoreCaptureSources('initial-implementation',last,map);
  const receipt=jsonBytes(cap.receipt,'initial receipt').value;
  const entries=receipt.testedState.entries;
  const paths=entries.map(item => {
    const absolute=resolveLogicalProductClaim(context,`tasks/${originOwner.slice}.md`,item.path);
    return path.relative(context.productRoot,absolute).split(path.sep).join('/');
  }).sort(ordinal);
  orderedUnique(paths,'initial scope paths',/^[^/].*$/u);
  const response=jsonBytes(cap.rawResponse,'initial response').value;
  return {paths,filelessReason:paths.length ? null : response.filelessReason ?? null,owner:originOwner};
}
function requestShape(value) {
  closed(value,['format','owner','authority','base','attemptId','scope'],'validation request');
  if (typeof value.format !== 'string') invalid('validation request format: string required');
  if (value.format === 'stnl-current-validation-request-v0') fail('MIGRATION_REQUIRED','validation request legacy format');
  if (value.format !== 'stnl-current-validation-request-v1') fail('UNSUPPORTED_FORMAT','validation request format');
  owner(value.owner,'validation request owner');
  closed(value.base,['evidenceSha256','counters','openFindings','priorScopePaths'],'validation request base');
  token(value.base.evidenceSha256,HASH,'validation request base digest');
  counters(value.base.counters,'validation request counters');
  findings(value.base.openFindings,'validation request openFindings');
  if (value.base.counters.validationAttempts === 0 && value.base.counters.findings !== 0) invalid('first formal request cannot inherit findings');
  if (value.base.openFindings.some(item => Number(item.id.slice('finding-'.length)) > value.base.counters.findings)) invalid('validation request finding counter below active ID');
  orderedUnique(value.base.priorScopePaths,'priorScopePaths',/^[^/].*$/u);
  token(value.attemptId,ATTEMPT,'validation request attemptId');
  if (value.attemptId !== id('attempt',value.base.counters.validationAttempts+1)) invalid('validation request attemptId/counter');
  closed(value.scope,['paths','filelessReason'],'validation request scope');
  orderedUnique(value.scope.paths,'scope.paths',/^[^/].*$/u);
  if (value.scope.filelessReason !== null) nonPlaceholder(value.scope.filelessReason,'scope.filelessReason');
  return value;
}
function parseReferences(value,label) {
  string(value,label);
  if (value === 'none') return [];
  return orderedUnique(value.split(', '),label,FINDING);
}
function parseDispositions(value,label) {
  string(value,label);
  if (value === 'none') return new Map();
  const pairs=value.split(', ').map(item => item.split('='));
  if (pairs.some(pair => pair.length !== 2 || !['active','resolved'].includes(pair[1]))) invalid(`${label}: invalid disposition`);
  orderedUnique(pairs.map(pair => pair[0]),label,FINDING);
  return new Map(pairs);
}
function effectiveAuthorityTokens(delivery) {
  const names=new Set(delivery.obligations.map(item => item.id));
  for (const match of delivery.requirements.matchAll(/\b[A-Z][A-Z0-9]*-[0-9]+\b/gu)) names.add(match[0]);
  return names;
}
function findRelatedAuthority(value,delivery) {
  const tokens=effectiveAuthorityTokens(delivery);
  if (![...tokens].some(item => new RegExp(`(^|[^A-Za-z0-9_-])${item.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}(?=$|[^A-Za-z0-9_-])`,'u').test(value))) invalid('finding.relatedAuthority: no effective requirement or obligation');
}
function semanticError(message) { return new RunnerSemanticResultError('VALIDATE_SLICE',new Error(message)); }
function parseResponse(rawText) {
  let parsed;
  try { parsed=parseCurrentJson(rawText); } catch { return {error:semanticError('captured response is not strict JSON'),loose:null}; }
  try {
    closed(parsed,['format','requestSha256','result','newFindings'],'validation response');
    if (parsed.format !== 'stnl-current-validation-response-v1') throw new Error('versioned validation response envelope required');
    token(parsed.requestSha256,HASH,'response.requestSha256');
    dense(parsed.newFindings,'response.newFindings');
    const payload=parseSemanticValidationPayload(JSON.stringify(parsed.result));
    findings(parsed.newFindings,'response.newFindings');
    return {response:parsed,payload};
  } catch (error) { return {error:semanticError(error.message),loose:parsed}; }
}
function priorFromRequest(request,context) {
  return request.base.priorScopePaths;
}
function verifyReceiptState(receipt,scopePaths,manifest,status,context,slice,priorFiles) {
  closed(receipt.testedState,['workspace','sourceTaskPath','entries'],'formal testedState');
  if (receipt.testedState.workspace !== context.productRoot || receipt.testedState.sourceTaskPath !== logicalArtifactPath(context,`tasks/${slice}.md`)) stale('formal testedState context');
  dense(receipt.testedState.entries,'formal testedState.entries');
  const byPath=new Map(manifest.entries.map(item => [item.path,item]));
  const seen=new Set(); let previous=null;
  for (const entry of receipt.testedState.entries) {
    closed(entry,['path','value'],'formal testedState entry');
    string(entry.path,'formal testedState path');
    const absolute=resolveLogicalProductClaim(context,`tasks/${slice}.md`,entry.path);
    const name=path.relative(context.productRoot,absolute).split(path.sep).join('/');
    if (previous !== null && ordinal(previous,entry.path)>=0) invalid('formal testedState order');
    previous=entry.path;
    if (!scopePaths.includes(name) || seen.has(name)) stale(`formal testedState outside scope ${name}`);
    const state=byPath.get(name);
    if (!state || state.kind==='directory') stale(`formal testedState unknown output ${name}`);
    if (state.kind==='file' && entry.value !== state.sha256) stale(`formal testedState file hash ${name}`);
    if (state.kind==='absent') {
      if (entry.value !== 'REMOVED') stale(`formal testedState absent value ${name}`);
      if (!priorFiles.has(name)) incomplete(`formal REMOVED lacks prior bytes ${name}`);
    }
    seen.add(name);
  }
  const files=scopePaths.filter(name => byPath.get(name)?.kind==='file');
  if (files.some(name => !seen.has(name))) incomplete('formal testedState misses file output');
  if (status==='PASS' && scopePaths.some(name => !seen.has(name))) incomplete('PASS misses exact scope output');
  return receipt.testedState.entries;
}
function priorFileProofs(bundle,map,context) {
  const found=new Set();
  for (const record of bundle.implementation) {
    const cap=restoreCaptureSources('initial-implementation',record,map);
    for (const blob of cap.removalProofs) {
      const proof=jsonBytes(blob,'initial removal proof').value;
      // The Initial verifier has already checked bytes, hash, mode and owner.
      found.add(proof.path);
    }
  }
  const finalWork=new Map(bundle.implementation.at(-1).testedWork.entries.map(entry=>[entry.path,entry]));
  return new Set([...found].filter(name=>finalWork.get(name)?.kind==='absent'));
}
function renderRecord(request,payload,commands) {
  const scope=request.scope.paths.length
    ? request.scope.paths.map(name => {
      const absolute=path.join(request.__productRoot,name);
      return path.relative(path.dirname(request.__taskPath),absolute).split(path.sep).join('/');
    }).join(', ')
    : 'fileless task state';
  const scalar=(name,value) => serializeMarkdownScalar(name,value,true);
  const commandLines=commands.map((item,index) => `  - ${serializeCommand(item.command,`command ${index+1}`)} | exit:${item.exit}`);
  const owner=request.owner;
  return [
    `### ${request.attemptId}`,
    `- Delivery ID: ${owner.deliveryId}`,
    `- Preparation revision: ${owner.preparationRevision}`,
    `- Local revision: ${owner.localRevision}`,
    `- Normative sha256: ${owner.normativeSha256}`,
    `- Operation attempt ID: ${owner.operationAttemptId}`,
    `- Origin activation ID: ${owner.originActivationId}`,
    `- Type: ${request.base.counters.validationAttempts===0 ? 'initial' : 'revalidation'}`,
    `- Status: ${payload.status}`,
    `- HEAD: ${payload.head}`,
    `- Verified scope: ${scope}`,
    '- Commands:',...commandLines,
    `- Evidence: ${scalar('Evidence',payload.evidence)}`,
    `- Finding references: ${payload.findingReferences}`,
    `- Finding dispositions: ${payload.findingDispositions}`,
    `- Blockers: ${scalar('Blockers',payload.blockers)}`,
    `- Unexpected workspace effects: ${scalar('Unexpected workspace effects',payload.unexpectedWorkspaceEffects)}`,
    `- Persistence summary: ${scalar('Persistence summary',payload.persistenceSummary)}`,
  ].join('\n');
}
function requestForRecord(record,map) {
  const cap=restoreCaptureSources('current-validation',record,map);
  return jsonBytes(cap.validationRequest,'retained validation request').value;
}
function deriveCapture({context,authority:approvedAuthority,capture,expectedOwner=null,expectedBase=null,priorFiles=new Set(),filelessReason=null}) {
  const request=jsonBytes(capture.validationRequest,'validation request').value;
  requestShape(request);
  authority(request.authority,context,request.owner);
  equal(request.authority,approvedAuthority,'EVIDENCE_STALE','validation request authority');
  if (expectedOwner) equal(request.owner,expectedOwner,'OWNER_MISMATCH','validation request owner');
  if (expectedBase) {
    if (request.base.evidenceSha256 !== expectedBase.sha256) stale('validation request base.evidenceSha256 CAS');
    equal(request.base.counters,expectedBase.counters,'INVALID_CURRENT_IMAGE','validation request base counters');
    equal(request.base.openFindings,expectedBase.openFindings,'INVALID_CURRENT_IMAGE','validation request base openFindings');
    equal(request.base.priorScopePaths,expectedBase.priorScopePaths,'EVIDENCE_STALE','validation request priorScopePaths');
  }
  const rawText=textBytes(capture.rawResponse,'validation rawResponse').text;
  const receipt=jsonBytes(capture.receipt,'validation receipt').value;
  plain(receipt,'validation receipt');
  if (receipt.attempt!==1) mismatch('validation receipt attempt');
  const info=verifyCapturedInvocation('current-validation',capture,receipt,rawText,
    {context,authority:approvedAuthority,owner:request.owner},1,null);
  const observed=verifyWorkObservation('current-validation',{
    capture,receipt,expectation:{context,authority:approvedAuthority,owner:request.owner},
    priorScopePaths:priorFromRequest(request,context),removalScopePaths:[...priorFiles].sort(ordinal),
  });
  equal(request.scope.paths,observed.scopePaths,'EVIDENCE_STALE','derived validation scope');
  if (request.scope.paths.length) {
    if (request.scope.filelessReason!==null) invalid('file-backed scope has fileless reason');
  } else {
    if (!filelessReason) incomplete('fileless validation has no auxiliary proof reason');
    if (request.scope.filelessReason!==filelessReason) stale('fileless reason differs from initial proof');
  }
  if (capture.transport==='managed' && (info.supervisor.requestsHandled!==1
    || info.supervisor.capturedReceipts!==(receipt.status==='RUNNER_RESPONSE_CAPTURED' && receipt.exitCode===0 ? 1 : 0)
    || info.latest.sequence!==info.active.sequence || !same(info.latest.receipt,receipt))) uncertain('managed validation close/latest does not cover one invocation');
  const origin={operationAttemptId:request.owner.operationAttemptId,deliveryId:request.owner.deliveryId,
    slice:request.owner.slice,operation:'VALIDATE_SLICE',preparationRevision:request.owner.preparationRevision,
    localRevision:request.owner.localRevision,normativeSha256:request.owner.normativeSha256,
    originActivationId:request.owner.originActivationId,transport:capture.transport,
    dispatchId:info.dispatchId,runnerId:info.runnerId};
  const parsed=parseResponse(rawText);
  if (receipt.status==='RUNNER_RESULT_BLOCKED') {
    if (parsed.response) uncertain('schema-rejected receipt has valid formal response');
    if (receipt.semanticResponseStatus!==null || receipt.testedState!==null || typeof receipt.captureFailure!=='string' || !receipt.captureFailure.trim()
      || (capture.transport==='managed' && (receipt.exitCode!==1 || receipt.captureFailureCode!=='RUNNER_RESPONSE_SCHEMA_INVALID'))) uncertain('schema-rejected receipt not concluded');
  } else if (receipt.status==='RUNNER_RESPONSE_CAPTURED') {
    if (receipt.captureFailure!==null || (capture.transport==='managed' && (receipt.exitCode!==0 || receipt.captureFailureCode!==null))) uncertain('accepted validation receipt not concluded');
    const loose=parsed.response ?? parsed.loose;
    if (!loose || receipt.semanticResponseStatus!==loose.result?.status) uncertain('accepted validation receipt semantic status differs');
    if (!observed.observed) incomplete('accepted validation lacks observation');
  } else uncertain('validation result not concluded');
  let rejection=parsed.error ?? null;
  if (!rejection && parsed.response.requestSha256!==raw(copyBytes(capture.validationRequest,'validation request'))) stale('response requestSha256 differs from captured request');
  if (!rejection) {
    const payload=parsed.payload;
    if (!same(payload.commands,observed.commands)) rejection=semanticError('response commands differ from observed recipe checks');
    if (!rejection) {
      try { assertRunnerVerdictConsistency('VALIDATE_SLICE',payload.status,observed.commands); }
      catch (error) { rejection=error; }
    }
    if (!rejection) {
      try { const diagnostic=deriveCanonicalRunnerRejection({receipt,response:JSON.stringify(payload)}); if (diagnostic!==null) rejection=diagnostic; }
      catch (error) { if (recoverableRunnerResultDiagnostic(error)!==null) rejection=error; else incomplete(`semantic result consistency: ${error.message}`); }
    }
  }
  if (receipt.status==='RUNNER_RESPONSE_CAPTURED') {
    if (receipt.testedState === null) incomplete('accepted validation lacks testedState carrier');
    verifyReceiptState(receipt,request.scope.paths,observed.observed.after,
      parsed.payload?.status ?? 'NEEDS_FIX',context,request.owner.slice,priorFiles);
  }
  if (rejection) {
    const diagnostic=recoverableRunnerResultDiagnostic(rejection);
    if (!diagnostic) incomplete('validation rejection diagnostic');
    return {request,origin,receipt,observed,rejection:diagnostic,parsed};
  }
  try {
  const {payload,response}=parsed;
  nonPlaceholder(payload.head,'HEAD'); nonPlaceholder(payload.evidence,'Evidence');
  presentRendered(payload.blockers,'Blockers');
  presentRendered(payload.unexpectedWorkspaceEffects,'Unexpected workspace effects');
  presentRendered(payload.persistenceSummary,'Persistence summary');
  if (payload.status==='BLOCKED') nonPlaceholder(payload.blockers,'Blockers');
  if (payload.status==='PASS' && payload.evidence.trim()==='none') invalid('PASS requires objective evidence');
  for (const item of response.newFindings) findRelatedAuthority(item.relatedAuthority,approvedAuthority.delivery);
  const baseFindings=request.base.openFindings;
  const newly=response.newFindings;
  if (payload.status!=='NEEDS_FIX' && newly.length) invalid('new findings require NEEDS_FIX');
  const expectedNewIds=Array.from({length:newly.length},(_,index)=>id('finding',request.base.counters.findings+index+1)).sort(ordinal);
  equal(newly.map(item=>item.id),expectedNewIds,'INVALID_CURRENT_IMAGE','new finding ID sequence');
  for (const item of newly) {
    if (item.originAttempt!==request.attemptId) invalid('new finding origin attempt');
    if (baseFindings.some(old => old.id===item.id)) invalid('new finding reused an active ID');
  }
  const all=[...baseFindings,...newly].sort((a,b)=>ordinal(a.id,b.id));
  const references=parseReferences(payload.findingReferences,'finding references');
  const dispositions=parseDispositions(payload.findingDispositions,'finding dispositions');
  equal(references,all.map(item => item.id),'INVALID_CURRENT_IMAGE','finding references');
  equal([...dispositions.keys()],references,'INVALID_CURRENT_IMAGE','finding dispositions');
  for (const item of newly) if (dispositions.get(item.id)!=='active') invalid('new finding disposition must be active');
  if (payload.status==='BLOCKED' && (newly.length || baseFindings.some(item => dispositions.get(item.id)!=='active'))) invalid('BLOCKED cannot create/resolve findings');
  if (payload.status==='PASS' && all.some(item => item.severity==='blocking' && dispositions.get(item.id)==='active')) invalid('PASS retains blocking finding');
  if (payload.status==='NEEDS_FIX' && !all.some(item => item.severity==='blocking' && dispositions.get(item.id)==='active')) invalid('NEEDS_FIX requires active blocker');
  const open=all.filter(item => dispositions.get(item.id)==='active');
  const rootRequest={...request,__productRoot:context.productRoot,__taskPath:logicalArtifactPath(context,`tasks/${request.owner.slice}.md`)};
  const record={kind:'validation',recordFormat:'stnl-task-record-v2',id:request.attemptId,origin,
    contract:{delivery:approvedAuthority.delivery,context:approvedAuthority.context,terminal:null,recipe:approvedAuthority.delivery.verificationRecipe},
    recordUtf8:renderRecord(rootRequest,payload,observed.commands),testedWork:observed.observed.after};
  return {request,origin,receipt,observed,response,payload,record,open,all,dispositions};
  } catch (error) {
    if (error.code !== 'INVALID_CURRENT_IMAGE' && !(error instanceof RunnerSemanticResultError)) throw error;
    const diagnostic=recoverableRunnerResultDiagnostic(error instanceof RunnerSemanticResultError ? error : semanticError(error.message));
    return {request,origin,receipt,observed,rejection:diagnostic,parsed};
  }
}
function projectedDelivery(value) {
  return raw(Buffer.concat([utf8('stnl-ec1/delivery/v1'),Buffer.from([0]),utf8(canonical(value))]));
}
function formalRecordNumber(record) { return Number(record.id.slice('attempt-'.length)); }
function verifyRecord(record,map,context,approvedAuthority,priorFiles,filelessReason) {
  if (record.recordFormat==='stnl-task-record-v1-imported') fail('MIGRATION_REQUIRED','imported formal record');
  if (record.kind!=='validation' || record.recordFormat!=='stnl-task-record-v2' || record.contract.terminal!==null) invalid('formal record format/terminal');
  const cap=restoreCaptureSources('current-validation',record,map);
  const derived=deriveCapture({context,authority:approvedAuthority,capture:cap,priorFiles,filelessReason});
  if (derived.rejection) invalid(`retained formal record is rejected: ${derived.rejection}`);
  equal(record,{...derived.record,sources:record.sources},'EVIDENCE_STALE',`formal record ${record.id}`);
  if (record.id!==derived.request.attemptId) invalid('formal record/request ID');
  return {...derived,cap};
}
function verifyRejection(support,map,context,approvedAuthority,priorFiles,filelessReason) {
  if (support.kind!=='rejection' || support.origin.operation!=='VALIDATE_SLICE' || support.round!==1 || support.consumedInvocations!==1) invalid('formal rejection shape');
  const cap=restoreCaptureSources('current-validation',support,map);
  const derived=deriveCapture({context,authority:approvedAuthority,capture:cap,priorFiles,filelessReason});
  if (!derived.rejection) invalid('formal rejection contains accepted response');
  if (support.operationAttemptId!==derived.origin.operationAttemptId || support.diagnostic!==derived.rejection) stale('formal rejection diagnostic/origin');
  equal(support.origin,derived.origin,'EVIDENCE_STALE','formal rejection origin');
  return {...derived,cap};
}
function sourceFinding(origin,item) {
  if (origin.payload.status!=='NEEDS_FIX') invalid(`finding ${item.id} origin is not NEEDS_FIX`);
  const declared=origin.response.newFindings.find(candidate => candidate.id===item.id);
  if (!declared) incomplete(`finding ${item.id} has no authored origin`);
  equal(item,declared,'EVIDENCE_STALE',`finding ${item.id} origin detail`);
}
function baseCounters(initialCount,request,newCount) {
  if (request.base.counters.implementationChecks!==initialCount || request.base.counters.findingsChecks!==0) invalid('formal request check counters');
  const expected={...request.base.counters,validationAttempts:request.base.counters.validationAttempts+1,
    findings:request.base.counters.findings+newCount};
  counters(expected,'derived counters');
  return expected;
}
function inspect(bundleBytes,context,approvedAuthority,declaredCounters,observedWork,allowInitial=false) {
  const original=copyBytes(bundleBytes,'bundleBytes');
  const bundle=jsonBytes(original,'bundleBytes').value;
  validateCurrentEvidence(bundle);
  if (bundle.findingsChecks.length || bundle.openDivergences.length || bundle.currentAuthoritySha256!==projectedDelivery(approvedAuthority.delivery)) invalid('bundle formal authority/unsupported records');
  if (bundle.implementation.some(item => item.recordFormat==='stnl-task-record-v1-imported')) fail('MIGRATION_REQUIRED','imported implementation record');
  if (bundle.implementation.some(item => item.recordFormat!=='stnl-task-record-v2' || item.contract.terminal!==null)) invalid('implementation record format/terminal');
  const map=sourceMap(bundle);
  const initial=verifyInitial(bundle,context,approvedAuthority,map);
  verifyWorkObservation('current-validation',{observedWork});
  const priorFiles=priorFileProofs(bundle,map,context);
  const formalSupports=bundle.support.filter(item => item.kind==='validation');
  const rejects=bundle.support.filter(item => item.kind==='rejection');
  if (rejects.length>1 || (rejects.length && bundle.support.at(-1)!==rejects[0])
    || bundle.support.length!==formalSupports.length+rejects.length) invalid('formal support kind/order');
  let previousNumber=0;
  const origins=new Map();
  for (const item of formalSupports) {
    const number=formalRecordNumber(item);
    if (!Number.isSafeInteger(number) || number<=previousNumber) invalid('formal support attempt order');
    previousNumber=number;
    origins.set(item.id,verifyRecord(item,map,context,approvedAuthority,priorFiles,initial.filelessReason));
  }
  let latest=null;
  if (bundle.validation!==null) {
    if (formalRecordNumber(bundle.validation)<=previousNumber) invalid('latest formal attempt order');
    latest=verifyRecord(bundle.validation,map,context,approvedAuthority,priorFiles,initial.filelessReason);
    origins.set(bundle.validation.id,latest);
  }
  let rejected=null;
  if (rejects.length) rejected=verifyRejection(rejects[0],map,context,approvedAuthority,priorFiles,initial.filelessReason);
  if (!latest && !rejected && !allowInitial) invalid('formal validator requires an incorporation');
  if (!latest && formalSupports.length) invalid('origin support without latest formal');
  const retainedFormals=[...formalSupports.map(item=>origins.get(item.id)),...(latest?[latest]:[])];
  for (let index=1;index<retainedFormals.length;index+=1) {
    const previous=retainedFormals[index-1],current=retainedFormals[index];
    if (formalRecordNumber(current.record)!==formalRecordNumber(previous.record)+1) continue;
    equal(current.request.base.counters,baseCounters(bundle.implementation.length,previous.request,previous.response.newFindings.length),
      'INVALID_CURRENT_IMAGE','consecutive formal counters');
    equal(current.request.base.openFindings,previous.open,'INVALID_CURRENT_IMAGE','consecutive formal findings');
    equal(current.request.base.priorScopePaths,previous.request.scope.paths,'EVIDENCE_STALE','consecutive formal scope');
  }
  let witnessedFindings=0;
  for (const item of formalSupports) {
    const origin=origins.get(item.id);
    const count=origin.request.base.counters;
    if (count.implementationChecks!==bundle.implementation.length || count.findingsChecks!==0) invalid('retained origin check counters');
    if (count.findings<witnessedFindings) invalid('retained origin finding counter regressed');
    witnessedFindings=count.findings+origin.response.newFindings.length;
  }
  if (latest) {
    const {request,response,all,open,dispositions}=latest;
    if (request.base.counters.findings<witnessedFindings) invalid('latest finding counter below retained origins');
    const required=new Set(all.map(item => item.originAttempt).filter(id => id!==request.attemptId));
    equal([...origins.keys()].filter(id => id!==request.attemptId).sort(ordinal),[...required].sort(ordinal),'INVALID_CURRENT_IMAGE','retained formal origins');
    for (const item of all) {
      const origin=origins.get(item.originAttempt);
      if (!origin) incomplete(`finding ${item.id} origin absent`);
      if (item.originAttempt!==request.attemptId && formalRecordNumber(origin.record)<0) invalid('finding origin order');
      sourceFinding(origin,item);
      if (item.originAttempt!==request.attemptId && formalRecordNumber(bundle.validation)<=formalRecordNumber(origin.record)) invalid('finding resolved at/before origin');
      if (item.originAttempt===request.attemptId && dispositions.get(item.id)!=='active') invalid('new finding resolved in origin');
    }
    equal(bundle.openFindings,open,'INVALID_CURRENT_IMAGE','current openFindings index');
    const expected=baseCounters(bundle.implementation.length,request,response.newFindings.length);
    if (!rejected) equal(declaredCounters,expected,'INVALID_CURRENT_IMAGE','current counters');
    if (request.base.counters.validationAttempts!==formalRecordNumber(bundle.validation)-1) invalid('latest attempt/counter mismatch');
    if (formalRecordNumber(bundle.validation)===1) equal(request.base.priorScopePaths,initial.paths,'EVIDENCE_STALE','first formal prior scope');
    if (request.base.counters.findings>declaredCounters.findings) invalid('finding counter regressed');
    // The retained origin's historical disposition text is literal evidence only.
  } else {
    equal(bundle.openFindings,[],'INVALID_CURRENT_IMAGE','openFindings before first formal');
  }
  if (rejected) {
    const request=rejected.request;
    const before=latest ? baseCounters(bundle.implementation.length,latest.request,latest.response.newFindings.length)
      : {implementationChecks:bundle.implementation.length,findingsChecks:0,validationAttempts:0,findings:0};
    equal(request.base.counters,before,'INVALID_CURRENT_IMAGE','rejection base counters');
    equal(request.base.openFindings,bundle.openFindings,'INVALID_CURRENT_IMAGE','rejection base findings');
    equal(request.base.priorScopePaths,latest?.request.scope.paths ?? initial.paths,'EVIDENCE_STALE','rejection prior scope');
    if (request.base.counters.validationAttempts!== (latest ? formalRecordNumber(bundle.validation) : 0)) invalid('rejection attempt/counter mismatch');
    equal(declaredCounters,before,'INVALID_CURRENT_IMAGE','rejection counters');
  }
  if (!latest && !rejected) {
    if (bundle.support.length) invalid('initial base has support');
    equal(declaredCounters,{implementationChecks:bundle.implementation.length,findingsChecks:0,validationAttempts:0,findings:0},'INVALID_CURRENT_IMAGE','initial counters');
  }
  const status=latest?.payload.status ?? null;
  const state=rejected ? 'uncertain' : !latest ? 'unvalidated'
    : status!=='PASS' || bundle.openFindings.some(item => item.severity==='blocking') || !same(latest.record.testedWork,observedWork)
      ? 'revalidation-required' : 'current';
  return {bundle,original,map,initial,latest,rejected,origins,priorFiles,
    counters:structuredClone(declaredCounters),outcome:rejected ? 'rejected' : 'recorded',formalStatus:status,validation:state};
}
function guardValidate(input) {
  if (input && typeof input==='object' && Object.getOwnPropertyDescriptor(input,'imported')?.value===true) fail('MIGRATION_REQUIRED','imported formal evidence requires conversion');
  closed(input,['context','authority','bundleBytes','counters','observedWork'],'formal validator input');
  authority(input.authority,input.context);
  counters(input.counters,'counters');
  copyBytes(input.bundleBytes,'bundleBytes');
  plain(input.observedWork,'observedWork');
}
export function validateCurrentValidationEvidence(input) {
  guardValidate(input);
  const result=inspect(input.bundleBytes,input.context,input.authority,input.counters,input.observedWork);
  return {bundle:parseCurrentJson(result.original.toString('utf8')),bytes:Uint8Array.from(result.original),
    sha256:raw(result.original),counters:structuredClone(result.counters),outcome:result.outcome,
    formalStatus:result.formalStatus,validation:result.validation};
}
function exactCapture(left,right) {
  if (Object.keys(left).sort(ordinal).join('\0')!==Object.keys(right).sort(ordinal).join('\0')) return false;
  for (const key of Object.keys(left)) {
    if (Array.isArray(left[key])) {
      if (!Array.isArray(right[key]) || left[key].length!==right[key].length || left[key].some((item,index)=>!copyBytes(item,key).equals(copyBytes(right[key][index],key)))) return false;
    } else if (left[key]===null) { if (right[key]!==null) return false; }
    else if (typeof left[key]==='string') { if (left[key]!==right[key]) return false; }
    else if (!copyBytes(left[key],key).equals(copyBytes(right[key],key))) return false;
  }
  return true;
}
function mergeObjects(previous,store) {
  return new Map([...previous,...store.finish().map(item => [item.id,Buffer.from(item.bytesBase64,'base64')])]);
}
function formalOrigins(records,all,latestId) {
  const ids=new Set(all.map(item => item.originAttempt).filter(item => item!==latestId));
  return records.filter(record => ids.has(record.id)).sort((a,b)=>formalRecordNumber(a)-formalRecordNumber(b));
}
export function composeCurrentValidationEvidence(input) {
  if (input && typeof input==='object' && Object.getOwnPropertyDescriptor(input,'imported')?.value===true) fail('MIGRATION_REQUIRED','imported formal evidence requires conversion');
  closed(input,['context','authority','owner','previous','capture'],'formal composition input');
  plain(input.capture,'capture');
  authority(input.authority,input.context,input.owner);
  closed(input.previous,['bundleBytes','counters'],'previous');
  counters(input.previous.counters,'previous.counters');
  const previousBytes=copyBytes(input.previous.bundleBytes,'previous.bundleBytes');
  const request=jsonBytes(input.capture?.validationRequest,'capture.validationRequest').value;
  requestShape(request);
  equal(request.owner,input.owner,'OWNER_MISMATCH','request owner');
  const parsedPrevious=jsonBytes(previousBytes,'previous.bundleBytes').value;
  const passiveWork=parsedPrevious.validation?.testedWork ?? parsedPrevious.implementation?.at(-1)?.testedWork;
  const base=inspect(previousBytes,input.context,input.authority,input.previous.counters,passiveWork,true);
  const last=base.rejected ?? base.latest;
  if (last?.request.owner.operationAttemptId===input.owner.operationAttemptId) {
    if (!exactCapture(last.cap,input.capture)) mismatch('same owner has different captured sources');
    const result=validateCurrentValidationEvidence({context:input.context,authority:input.authority,
      bundleBytes:previousBytes,counters:input.previous.counters,observedWork:passiveWork});
    return {...result,replayed:true,consumedInvocations:1};
  }
  if ([...base.origins.values()].some(item => item.request.owner.operationAttemptId===input.owner.operationAttemptId)
    || request.base.counters.validationAttempts!==input.previous.counters.validationAttempts
    || request.base.evidenceSha256!==raw(previousBytes)) fail('STALE_BASE','validation request does not address latest base');
  if (base.rejected) fail('RUNNER_RESULT_REJECTED','previous rejected result needs normalization before another dispatch');
  const priorScopePaths=base.latest?.request.scope.paths ?? base.initial.paths;
  const expectedBase={sha256:raw(previousBytes),counters:input.previous.counters,openFindings:base.bundle.openFindings,priorScopePaths};
  const derived=deriveCapture({context:input.context,authority:input.authority,capture:input.capture,
    expectedOwner:input.owner,expectedBase,priorFiles:base.priorFiles,filelessReason:base.initial.filelessReason});
  const store=closeEvidenceObjects();
  const sources=packCaptureSources('current-validation',input.capture,store);
  const map=mergeObjects(base.map,store);
  const bundle={...base.bundle};
  const supporting=[...base.bundle.support.filter(item => item.kind==='validation'),...(base.bundle.validation ? [base.bundle.validation] : [])];
  if (derived.rejection) {
    bundle.support=[...formalOrigins(supporting,base.latest?.all ?? [],base.bundle.validation?.id),
      {kind:'rejection',operationAttemptId:input.owner.operationAttemptId,origin:derived.origin,
        diagnostic:derived.rejection,consumedInvocations:1,round:1,sources}];
    bundle.openFindings=base.bundle.openFindings;
  } else {
    const record={...derived.record,sources};
    bundle.validation=record;
    bundle.openFindings=derived.open;
    bundle.support=formalOrigins(supporting,derived.all,record.id);
  }
  bundle.objects=referencedObjects([...bundle.implementation,...bundle.support,...(bundle.validation ? [bundle.validation] : [])],map);
  validateCurrentEvidence(bundle);
  const outputBytes=encode(bundle);
  const outputCounters=derived.rejection ? input.previous.counters : baseCounters(bundle.implementation.length,derived.request,derived.response.newFindings.length);
  const result=validateCurrentValidationEvidence({context:input.context,authority:input.authority,
    bundleBytes:outputBytes,counters:outputCounters,observedWork:derived.observed.observed?.after ?? passiveWork});
  return {...result,replayed:false,consumedInvocations:1};
}
