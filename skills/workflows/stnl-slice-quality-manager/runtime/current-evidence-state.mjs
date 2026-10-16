import { createHash } from 'node:crypto';
import path from 'node:path';
import { logicalArtifactPath, parseCurrentJson, resolveLogicalProductClaim, validateCurrentEvidence,
  validateCurrentImage,validateCurrentCandidate,validateCurrentActivation,currentOperationBindingSha256,
  currentDeliveryAuthoritySha256 } from './execution-current.mjs';
import { composeInitialImplementationEvidence,validateInitialImplementationEvidence } from './execution-evidence-current.mjs';
import {
  verifyCapturedInvocation, verifyWorkObservation, packCaptureSources,
  restoreCaptureSources, closeEvidenceObjects, verifyAuxiliaryWork, findingsRoundCaptureSha256,
  inspectConvertedDelivery, projectNativeJudgment, NATIVE_JUDGMENT_VARIANT,
} from './execution-evidence-proof.mjs';
import {
  RunnerSemanticResultError, assertRunnerVerdictConsistency, deriveCanonicalRunnerRejection,
  parseSemanticValidationPayload, parseSemanticExecutionPayload, parseCapturedResult,
  assertExecutionResultScope, recoverableRunnerResultDiagnostic, serializeCommand, serializeMarkdownScalar,
  executionFields, isExplanatoryExecutionField,
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
export const currentEvidenceValueSha256 = value => raw(encode(value));
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
  return value;
}
function owner(value,label,operation='VALIDATE_SLICE') {
  closed(value,['operationAttemptId','ownershipToken','deliveryId','slice','operation','preparationRevision','localRevision','normativeSha256','originActivationId'],label);
  for (const key of ['operationAttemptId','ownershipToken','deliveryId','originActivationId']) token(value[key],UUID,`${label}.${key}`);
  token(value.normativeSha256,HASH,`${label}.normativeSha256`);
  token(value.slice,/^slice-(0[1-9]|[1-9][0-9]+)$/u,`${label}.slice`);
  nat(value.preparationRevision,`${label}.preparationRevision`,1);
  nat(value.localRevision,`${label}.localRevision`,1);
  if (value.operation !== operation) invalid(`${label}: ${operation} operation required`);
  return value;
}
function authority(value,context,claimedOwner=null,operation='VALIDATE_SLICE') {
  closed(value,['preparationRevision','localRevision','normativeSha256','delivery','context'],'authority');
  closed(value.context,['requirementsAuthority','objective','strategy','risks'],'authority.context');
  nat(value.preparationRevision,'authority.preparationRevision',1);
  nat(value.localRevision,'authority.localRevision',1);
  token(value.normativeSha256,HASH,'authority.normativeSha256');
  token(value.context.requirementsAuthority,HASH,'authority.context.requirementsAuthority');
  for (const name of ['objective','strategy','risks']) string(value.context[name],`authority.context.${name}`);
  plain(value.delivery,'authority.delivery'); canonical(value.delivery);
  if (claimedOwner) {
    owner(claimedOwner,'owner',operation);
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
function initialBundle(bundle,map,approvedAuthority) {
  return {...bundle,validation:null,openFindings:[],openDivergences:[],support:[],
    // Reconstruct the original Initial index while retaining literal records and
    // source objects; a later approved current index is not part of that origin.
    currentAuthoritySha256:projectedDelivery(approvedAuthority.delivery),
    objects:referencedObjects(bundle.implementation,map)};
}
function verifyInitial(bundle,context,approvedAuthority,map) {
  if (!bundle.implementation.length || bundle.implementation.length>3) invalid('initial check count');
  const originOwner=initialOwner(bundle,map);
  const base={context,authority:approvedAuthority,owner:originOwner,currentEvidence:null,
    counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},bundleBytes:encode(initialBundle(bundle,map,approvedAuthority))};
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
  if (!['stnl-current-validation-request-v1','stnl-current-validation-request-v2',
    'stnl-current-validation-request-v3','stnl-current-validation-request-v4'].includes(value.format)) fail('UNSUPPORTED_FORMAT','validation request format');
  owner(value.owner,'validation request owner');
  const afterFindings=['stnl-current-validation-request-v2','stnl-current-validation-request-v4'].includes(value.format);
  const postConversion=['stnl-current-validation-request-v3','stnl-current-validation-request-v4'].includes(value.format);
  closed(value.base,postConversion
    ?['approvedSnapshotSha256','evidenceSha256','counters','baseline','validation','lastDiagnostic','priorScopePaths','openFindings',...(afterFindings?['auxiliary']:[])]
    :['evidenceSha256','counters','openFindings','priorScopePaths',...(afterFindings?['auxiliary']:[])],'validation request base');
  if(postConversion) {
    token(value.base.approvedSnapshotSha256,HASH,'validation approved snapshot');
    if(value.base.evidenceSha256!==null) token(value.base.evidenceSha256,HASH,'validation predecessor digest');
    verifyWorkObservation('current-validation',{observedWork:value.base.baseline});
    if(!['current','revalidation-required'].includes(value.base.validation)) invalid('post-conversion base validation');
    if(value.base.lastDiagnostic!==null) plain(value.base.lastDiagnostic,'post-conversion base diagnostic');
  } else token(value.base.evidenceSha256,HASH,'validation request base digest');
  counters(value.base.counters,'validation request counters');
  if (!afterFindings && !postConversion && value.base.counters.findingsChecks!==0) invalid('validation request v1 cannot follow findings checks');
  if (afterFindings) {
    const auxiliary=value.base.auxiliary;
    closed(auxiliary,['kind','operationAttemptId','cycle','firstCheckId','lastCheckId','recordsSha256'],'validation request auxiliary');
    if (auxiliary.kind!=='findings') invalid('validation request auxiliary kind');
    token(auxiliary.operationAttemptId,UUID,'validation request auxiliary owner');
    token(auxiliary.cycle,ATTEMPT,'validation request auxiliary cycle');
    token(auxiliary.firstCheckId,/^findings-check-(0[1-9]|[1-9][0-9]+)$/u,'validation request firstCheckId');
    token(auxiliary.lastCheckId,/^findings-check-(0[1-9]|[1-9][0-9]+)$/u,'validation request lastCheckId');
    token(auxiliary.recordsSha256,HASH,'validation request recordsSha256');
  }
  findings(value.base.openFindings,'validation request openFindings');
  if (value.base.counters.validationAttempts === 0 && value.base.counters.findings !== 0) invalid('first formal request cannot inherit findings');
  if (value.base.openFindings.some(item => Number(item.id.slice('finding-'.length)) > value.base.counters.findings)) invalid('validation request finding counter below active ID');
  if (value.base.openFindings.some(item => Number(item.originAttempt.slice('attempt-'.length)) > value.base.counters.validationAttempts)) invalid('validation request origin exceeds base counter');
  orderedUnique(value.base.priorScopePaths,'priorScopePaths',/^[^/].*$/u);
  token(value.attemptId,ATTEMPT,'validation request attemptId');
  if (value.attemptId !== id('attempt',value.base.counters.validationAttempts+1)) invalid('validation request attemptId/counter');
  closed(value.scope,['paths','filelessReason'],'validation request scope');
  orderedUnique(value.scope.paths,'scope.paths',/^[^/].*$/u);
  if (value.scope.filelessReason !== null) nonPlaceholder(value.scope.filelessReason,'scope.filelessReason');
  return value;
}
function applyRequestShape(value) {
  const successor=value?.format==='stnl-current-findings-request-v2';
  closed(value,['format','owner','authority','base','round',...(successor?['invocation']:[]),
    'checkId','previousCheck','scopePaths'],'findings request');
  if (!['stnl-current-findings-request-v1','stnl-current-findings-request-v2'].includes(value.format))
    fail('UNSUPPORTED_FORMAT','findings request format');
  owner(value.owner,'findings request owner','APPLY_FINDINGS');
  closed(value.base,['evidenceSha256','counters','validation','openFindings','priorScopePaths'],'findings request base');
  token(value.base.evidenceSha256,HASH,'findings base digest');
  counters(value.base.counters,'findings base counters');
  closed(value.base.validation,['id','recordSha256'],'findings base validation');
  token(value.base.validation.id,ATTEMPT,'findings base validation id');
  token(value.base.validation.recordSha256,HASH,'findings base validation digest');
  findings(value.base.openFindings,'findings base openFindings');
  if (!value.base.openFindings.some(item=>item.severity==='blocking')) invalid('findings request requires active blocker');
  orderedUnique(value.base.priorScopePaths,'priorScopePaths',/^[^/].*$/u);
  nat(value.round,'findings round',1);
  if (value.round>3) invalid('findings round budget');
  const invocation=successor?value.invocation:value.round;
  if(successor) nat(value.invocation,'findings invocation',1);
  if(invocation>3 || invocation>value.round) invalid('findings invocation budget');
  if (value.checkId!==id('findings-check',value.base.counters.findingsChecks+invocation)) invalid('findings request check ID');
  if (invocation===1) {
    if (value.previousCheck!==null) invalid('first findings request has predecessor');
  } else {
    closed(value.previousCheck,['id','roundCaptureSha256'],'findings predecessor');
    token(value.previousCheck.id,/^findings-check-(0[1-9]|[1-9][0-9]+)$/u,'findings predecessor ID');
    token(value.previousCheck.roundCaptureSha256,HASH,'findings predecessor digest');
  }
  orderedUnique(value.scopePaths,'scopePaths',/^[^/].*$/u);
  return value;
}
function findingIds(value,label) {
  string(value,label);
  if (value==='none') return [];
  return orderedUnique(value.split(', '),label,FINDING);
}
function taskRelative(context,slice,name) {
  const absolute=path.join(context.productRoot,name);
  return path.relative(path.dirname(logicalArtifactPath(context,`tasks/${slice}.md`)),absolute).split(path.sep).join('/');
}
function changedOutputPaths(before,after) {
  const old=new Map(before.entries.map(item=>[item.path,item]));
  const now=new Map(after.entries.map(item=>[item.path,item]));
  return [...new Set([...old.keys(),...now.keys()])].sort(ordinal).filter(name=>
    (old.get(name)?.kind==='file' || now.get(name)?.kind==='file') && !same(old.get(name)??null,now.get(name)??null));
}
function findingsRecord(request,payload,work,context,priorFailure,cycleBaseline) {
  const scalar=(label,value)=>serializeMarkdownScalar(label,value,isExplanatoryExecutionField(label));
  const fields=new Map(executionFields('APPLY_FINDINGS').map(([key,label])=>[label,payload[key]]));
  const scope=work.scopePaths.map(name=>taskRelative(context,request.owner.slice,name));
  const corrected=changedOutputPaths(cycleBaseline,work.observed.after)
    .map(name=>taskRelative(context,request.owner.slice,name));
  const lines=[
    `### ${request.checkId}`,
    `- Automatic check round: ${request.round}/3`,
    `- Status: ${payload.status}`,
    `- HEAD: ${payload.head}`,
    `- Tested scope: ${scope.length ? scope.join(', ') : scalar('Fileless reason',payload.filelessReason)}`,
    `- Delivery ID: ${request.owner.deliveryId}`,
    `- Preparation revision: ${request.owner.preparationRevision}`,
    `- Local revision: ${request.owner.localRevision}`,
    `- Normative sha256: ${request.owner.normativeSha256}`,
    `- Operation attempt ID: ${request.owner.operationAttemptId}`,
    `- Origin activation ID: ${request.owner.originActivationId}`,
    work.entries.length ? `- Tested state:\n${work.entries.map(item=>`  - \`${item.path}\` | ${item.value}`).join('\n')}`
      : scope.length ? '- Tested state: none' : `- Tested state: none\n- Fileless reason: ${scalar('Fileless reason',payload.filelessReason)}`,
    work.commands.length ? `- Commands:\n${work.commands.map((item,index)=>`  - ${serializeCommand(item.command,`command ${index+1}`)} | exit:${item.exit}`).join('\n')}` : '- Commands: none',
    ...['Discovery sources','Discovery actions','Verification types considered','Non-applicability rationale',
      'No verification-command confirmation','Selected checks','Selection rationale','Coverage','Failures',
      'Blockers','Unexpected workspace effects','Persistence summary'].map(label=>`- ${label}: ${scalar(label,fields.get(label))}`),
  ];
  if (request.round>1) lines.push(
    `- Prior-round failure: ${scalar('Prior-round failure',priorFailure)}`,
    `- Correction applied: ${scalar('Correction applied',payload.correctionsCovered)}`,
    `- Correction paths: ${work.correctionPaths.map(name=>taskRelative(context,request.owner.slice,name)).join(', ') || 'none'}`,
    `- Updated scope: ${scope.length ? scope.join(', ') : scalar('Fileless reason',payload.filelessReason)}`,
    `- In-slice rationale: ${scalar('In-slice rationale',payload.selectionRationale)}`,
  );
  lines.push(
    `- Findings cycle: ${request.base.validation.id}`,
    `- Finding IDs: ${request.base.openFindings.map(item=>item.id).join(', ')}`,
    `- Findings verified: ${payload.findingsVerified}`,
    `- Corrections covered: ${scope.length ? corrected.join(', ') || 'none' : scalar('Corrections covered',payload.correctionsCovered)}`,
    `- Regressions: ${scalar('Regressions selected',payload.regressionsSelected)}`,
    `- Unsupported active findings: ${payload.unsupportedActiveFindings}`,
  );
  return lines.join('\n');
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
export function parseCurrentValidationResponse(rawText) {
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
    if(expectedBase.postConversion) {
      if(request.format!==(expectedBase.auxiliary?'stnl-current-validation-request-v4':'stnl-current-validation-request-v3'))
        invalid('post-conversion validation request version differs from auxiliary state');
      if(request.base.approvedSnapshotSha256!==expectedBase.approvedSnapshotSha256
        || request.base.validation!==expectedBase.validation)
        stale('post-conversion snapshot or validation differs');
      equal(request.base.baseline,expectedBase.baseline,'EVIDENCE_STALE','post-conversion baseline');
      equal(request.base.lastDiagnostic,expectedBase.lastDiagnostic,'EVIDENCE_STALE','post-conversion diagnostic');
      if(expectedBase.auxiliary) equal(request.base.auxiliary,expectedBase.auxiliary,
        'EVIDENCE_STALE','post-conversion auxiliary');
    } else {
      if (expectedBase.auxiliary === null ? request.format !== 'stnl-current-validation-request-v1'
        : request.format !== 'stnl-current-validation-request-v2') invalid('validation request version does not match current auxiliary');
      if (expectedBase.auxiliary !== null) equal(request.base.auxiliary,expectedBase.auxiliary,'EVIDENCE_STALE','validation request auxiliary');
    }
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
  const nativeOrigin=capture.transport==='native'?jsonBytes(capture.origin,'validation origin').value:null;
  const semanticText=nativeOrigin?.responseVariant===NATIVE_JUDGMENT_VARIANT
    ?projectNativeJudgment({origin:nativeOrigin,observation:observed.observed,
      requestBytes:capture.validationRequest,agentId:info.runnerId,rawText,operation:'VALIDATE_SLICE'})
    :rawText;
  const parsed=parseCurrentValidationResponse(semanticText);
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
  const envelope=parsed.response??parsed.loose;
  if (envelope && typeof envelope.requestSha256==='string' && HASH.test(envelope.requestSha256)
    && envelope.requestSha256!==raw(copyBytes(capture.validationRequest,'validation request'))) stale('response requestSha256 differs from captured request');
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
  const recordDraft={kind:'validation',recordFormat:'stnl-task-record-v2',id:request.attemptId,origin,
    contract:{delivery:approvedAuthority.delivery,context:approvedAuthority.context,terminal:null,recipe:approvedAuthority.delivery.verificationRecipe},
    recordUtf8:renderRecord(rootRequest,payload,observed.commands),testedWork:observed.observed.after};
  return {request,origin,receipt,observed,response,payload,recordDraft,open,all,dispositions};
  } catch (error) {
    if (error.code !== 'INVALID_CURRENT_IMAGE' && !(error instanceof RunnerSemanticResultError)) throw error;
    const diagnostic=recoverableRunnerResultDiagnostic(error instanceof RunnerSemanticResultError ? error : semanticError(error.message));
    return {request,origin,receipt,observed,rejection:diagnostic,parsed};
  }
}

const postFilelessReason='No approved product output paths were present in the captured domain.';
const postAuthority=(snapshot,current)=>({preparationRevision:snapshot.preparationRevision,
  localRevision:current.localRevision,normativeSha256:current.authoritySha256,
  delivery:[...snapshot.normativeProjection.deliveries,...snapshot.normativeProjection.completed].find(item=>item.deliveryId===current.deliveryId),
  context:{requirementsAuthority:snapshot.requirementsAuthority,
    objective:snapshot.normativeProjection.global.objective,
    strategy:snapshot.normativeProjection.global.strategy,
    risks:snapshot.normativeProjection.global.risks}});
function postBase(snapshotBytes,current,scopePaths,openFindings=[],auxiliary=null,snapshotDigest=null) {
  return {postConversion:true,sha256:current.evidence?.sha256??null,
    approvedSnapshotSha256:snapshotDigest??raw(snapshotBytes),counters:current.counters,
    baseline:current.baseline,validation:current.validation,lastDiagnostic:current.lastDiagnostic,
    priorScopePaths:scopePaths,openFindings,auxiliary};
}
function postOutput(context,delivery,slice) {
  const domain=verifyWorkObservation('initial-implementation',{context,delivery,slice});
  return name=>domain.areas.some(item=>item.path===name || item.kind==='directory' && name.startsWith(`${item.path}/`));
}
function postChangedPaths(context,delivery,slice,before,after) {
  return changedOutputPaths(before,after).filter(postOutput(context,delivery,slice));
}
function verifyPostAdmission({context,snapshotBytes,owner:expectedOwner,capture,admissionRef=null,
  snapshotDigest=null}) {
  const snapshot=jsonBytes(snapshotBytes,'approved-preparation.json').value;
  if(capture.transport==='native') {
    const source=jsonBytes(capture.origin,'post-conversion native origin').value;
    if(admissionRef!==null && source.admission===undefined)
      mismatch('native EC-1 admission witness is absent');
    if(source.admission!==undefined) {
      closed(source.admission,['binding','baseActivation','reservedActivation'],'native admission witness');
      const {binding,baseActivation,reservedActivation}=source.admission;
      validateCurrentActivation(baseActivation);validateCurrentActivation(reservedActivation);
      if(baseActivation.activeAttempt!==null || reservedActivation.previousActivationId!==baseActivation.activationId
        || reservedActivation.sequence!==baseActivation.sequence+1
        || !same(baseActivation.artifacts,reservedActivation.artifacts)
        || reservedActivation.approvedSnapshotSha256!==baseActivation.approvedSnapshotSha256
        || reservedActivation.requirementsAuthority!==baseActivation.requirementsAuthority
        || reservedActivation.normativeSha256!==baseActivation.normativeSha256
        || !same(reservedActivation.lastAttempt,baseActivation.lastAttempt)
        || !same(reservedActivation.activeAttempt,{
          ...expectedOwner,operationRef:reservedActivation.activeAttempt?.operationRef})
        || !same(binding.owner,expectedOwner)
        || binding.baseActivationId!==baseActivation.activationId
        || binding.logicalExecutionRoot!==context.logicalExecutionRoot
        || reservedActivation.activeAttempt.operationRef.operationId!==binding.operationId
        || reservedActivation.activeAttempt.operationRef.allocationSha256!==currentOperationBindingSha256(binding)
        || baseActivation.approvedSnapshotSha256!==(snapshotDigest??raw(snapshotBytes))
        || baseActivation.requirementsAuthority!==snapshot.requirementsAuthority)
        mismatch('native admission witness does not bind A0/A1, owner and approved snapshot');
      if(admissionRef!==null && !same(admissionRef,{operationId:binding.operationId,
        allocationSha256:currentOperationBindingSha256(binding)}))
        mismatch('terminal operationRef differs from native admission witness');
    }
  }
}
function postCaptureProof({context,snapshotBytes,current,capture,expectedBase,admissionRef=null,
  allowRejection=false,historicalProof=null}) {
  const snapshot=jsonBytes(snapshotBytes,'approved-preparation.json').value;
  const auth=historicalProof?.authority??postAuthority(snapshot,current);
  const request=jsonBytes(capture.validationRequest,'post-conversion request').value;
  requestShape(request);
  if(!['stnl-current-validation-request-v3','stnl-current-validation-request-v4'].includes(request.format))
    invalid('post-conversion v3/v4 request required');
  verifyPostAdmission({context,snapshotBytes,owner:request.owner,capture,admissionRef,
    snapshotDigest:historicalProof?.snapshotDigest??null});
  const output=postOutput(context,auth.delivery,current.slice);
  if(request.base.priorScopePaths.some(name=>!output(name)))
    fail('UNSAFE_PATH','prior formal scope contains an input-only path');
  const reason=request.scope.paths.length?null:postFilelessReason;
  const derived=deriveCapture({context,authority:auth,capture,expectedOwner:request.owner,
    expectedBase,priorFiles:new Set(),filelessReason:reason});
  if(derived.rejection && !allowRejection) fail('RUNNER_RESULT_REJECTED',
    `offline semantic rejection cannot produce a successor: ${JSON.stringify(derived.rejection)}`);
  return derived;
}

// retainedRead selects literal historical proof authority for read-only source
// verification. It does not authorize retention: the reader must subsequently
// prove current contract/ownership equivalence before exposing current validity.
export async function inspectPostConversionEvidence({context,snapshotBytes,current,bundleBytes,observedWork,
  admissionRef=null,lastAttempt=null,preparationProfile='converted-current',retainedEvidence=null,retainedRead=null}) {
  const {validateCurrentPreparation}=await import('./execution-preparation-current.mjs');
  const snapshot=jsonBytes(snapshotBytes,'approved-preparation.json').value;
  if(snapshot.completed?.length) {
    preparationProfile='completed-current';
    retainedEvidence??=completedReviewReferences(snapshot);
  }
  const reviewed=new Map(snapshot.reviewedArtifacts.map(item=>[item.path,utf8(item.utf8)]));
  validateCurrentPreparation({context,requirementsAuthority:snapshot.requirementsAuthority,
    snapshotBytes,artifacts:reviewed,profile:preparationProfile,retainedEvidence});
  if(![...snapshot.deliveries,...snapshot.completed].some(item=>item.deliveryId===current.deliveryId && item.slice===current.slice))
    fail('UNSUPPORTED_FORMAT','post-conversion local review is not supported');
  if(retainedRead!==null) {
    closed(retainedRead,['authority','snapshotDigest'],'retained native read');
    authority(retainedRead.authority,context);
    if(!HASH.test(retainedRead.snapshotDigest))invalid('retained snapshot digest');
  }
  const baseFor=(predecessor,scope,findings=[],auxiliary=null,digest=null)=>
    postBase(snapshotBytes,predecessor,scope,findings,auxiliary,digest??retainedRead?.snapshotDigest??null);
  const verifyCapture=options=>postCaptureProof({...options,historicalProof:options.historicalProof??retainedRead});
  const recurse=options=>inspectPostConversionEvidence({preparationProfile,retainedEvidence,retainedRead,...options});
  if(current.localRevision===2 && bundleBytes!==null
    && jsonBytes(bundleBytes,'reviewed evidence').value.validation?.origin?.localRevision===1) {
    const bundle=jsonBytes(bundleBytes,'historical local review evidence').value;
    validateCurrentEvidence(bundle);
    const old=bundle.validation;
    const approved=snapshot.deliveries.find(item=>item.deliveryId===current.deliveryId);
    const leaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===current.deliveryId);
    const oldLeaf=old?.contract?.delivery;
    const privateFields=new Set(['existingInputs','risksAndStrategy','expectedTests','verificationRecipe']);
    const historical=old?.recordFormat==='stnl-task-record-v2'
      && old.origin?.operation==='VALIDATE_SLICE'
      && old.origin?.deliveryId===current.deliveryId && old.origin?.slice===current.slice
      && old.origin?.preparationRevision<snapshot.preparationRevision
      && old.origin?.localRevision===1
      && old.origin?.normativeSha256===currentDeliveryAuthoritySha256(oldLeaf)
      && old.contract?.recipe && same(old.contract.recipe,oldLeaf.verificationRecipe)
      && old.contract?.context?.requirementsAuthority===snapshot.requirementsAuthority
      && Object.keys(leaf).every(key=>privateFields.has(key)||same(leaf[key],oldLeaf[key]))
      && bundle.deliveryId===current.deliveryId && bundle.slice===current.slice
      && bundle.currentAuthoritySha256===current.authoritySha256
      && raw(bundleBytes)===current.evidence?.sha256
      && bundle.support.length===0 && bundle.findingsChecks.length===0
      && bundle.openFindings.length===0 && bundle.openDivergences.length===0
      && current.validation==='revalidation-required' && current.normalization===null
      && approved.review.evidenceDecisions.length===1
      && approved.review.evidenceDecisions[0].deliveryId===current.deliveryId
      && approved.review.evidenceDecisions[0].evidenceSha256===current.evidence.sha256
      && approved.review.evidenceDecisions[0].disposition==='revalidate'
      && lastAttempt===null;
    if(!historical) invalid('local review historical formal binding differs');
    const captured=restoreCaptureSources('current-validation',old,sourceMap(bundle));
    const request=jsonBytes(captured.validationRequest,'historical local review request').value;
    const origin=jsonBytes(captured.origin,'historical local review origin').value;
    const oldDigest=request.base?.approvedSnapshotSha256;
    if(!oldDigest || oldDigest!==origin.admission?.baseActivation?.approvedSnapshotSha256
      || bundle.implementation.length!==0 || old.sources.legacyPreparation!==null
      || old.contract.terminal!==null
      || !same(old.contract.context,{requirementsAuthority:snapshot.requirementsAuthority,
        objective:snapshot.normativeProjection.global.objective,
        strategy:snapshot.normativeProjection.global.strategy,
        risks:snapshot.normativeProjection.global.risks}))
      invalid('local review historical native source differs');
    const predecessor={evidence:{sha256:request.base.evidenceSha256},counters:request.base.counters,
      baseline:request.base.baseline,validation:request.base.validation,
      lastDiagnostic:request.base.lastDiagnostic};
    const expected=baseFor(predecessor,request.base.priorScopePaths,
      request.base.openFindings,request.base.auxiliary,oldDigest);
    const historicalProof={snapshotDigest:oldDigest,authority:{
      preparationRevision:old.origin.preparationRevision,localRevision:1,
      normativeSha256:old.origin.normativeSha256,delivery:oldLeaf,context:old.contract.context}};
    const derived=verifyCapture({context,snapshotBytes,current,capture:captured,
      expectedBase:expected,historicalProof});
    if(!same(old,{...derived.recordDraft,sources:old.sources})
      || derived.payload.status!=='PASS'
      || !same(current.counters,{...request.base.counters,
        validationAttempts:request.base.counters.validationAttempts+1,
        findings:request.base.counters.findings+derived.response.newFindings.length})
      || !same(current.baseline,derived.observed.observed.after))
      invalid('local review historical formal does not match its native capture');
    const matches=same(observedWork,current.baseline);
    return {context,authority:postAuthority(snapshot,current),bundle,
      records:{implementation:[],findings:[],validation:[old]},latest:null,
      verifiedChanges:[],verifiedCorrections:[],rejection:null,auxiliaryStatus:null,formalStatus:null,
      slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
      counterAuthority:'persisted-continuity',persistedValidation:current.validation,
      observedValidation:matches?current.validation:'revalidation-required',
      evidenceSha256:current.evidence.sha256,baseline:current.baseline,observationMatches:matches,
      openFindings:[],openDivergences:[],cycle:null,
      consumption:{kind:'historical-local-review',lastOperationAttemptId:old.origin.operationAttemptId,
        operation:'VALIDATE_SLICE',consumedInvocations:1,remainingInvocations:null,resumable:false},
      diagnostics:[],requiresFormalRevalidation:true};
  }
  if(current.localRevision!==1 && current.localRevision!==2)
    fail('UNSUPPORTED_FORMAT','post-conversion local revision exceeds one review');
  if(bundleBytes===null || jsonBytes(bundleBytes,'evidence').value.validation?.recordFormat==='stnl-task-record-v1-imported'
    && current.normalization===null)
    return inspectConvertedDelivery({context,snapshot,current,bundleBytes,observedWork});
  const bundle=jsonBytes(bundleBytes,'post-conversion evidence').value;
  validateCurrentEvidence(bundle);
  const formalRejections=bundle.support.filter(item=>item.kind==='rejection'
    && item.origin.operation==='VALIDATE_SLICE');
  const auxiliaryRejections=bundle.support.filter(item=>item.kind==='rejection'
    && item.origin.operation==='APPLY_FINDINGS');
  if(formalRejections.length && current.normalization!==null) {
    if(formalRejections.length>2 || bundle.implementation.length
      && bundle.validation?.recordFormat!=='stnl-task-record-v1-imported'
      || bundle.openDivergences.length
      || bundle.deliveryId!==current.deliveryId || bundle.slice!==current.slice
      || bundle.currentAuthoritySha256!==current.authoritySha256
      || raw(bundleBytes)!==current.evidence?.sha256)
      invalid('post-conversion rejection bundle identity differs');
    const latest=formalRejections.at(-1);
    const map=sourceMap(bundle);
    const capture=restoreCaptureSources('current-validation',latest,map);
    const request=jsonBytes(capture.validationRequest,'retained rejection request').value;
    const before={...current,evidence:request.base.evidenceSha256===null?null:
      {sha256:request.base.evidenceSha256},
      counters:request.base.counters,baseline:request.base.baseline,
      validation:request.base.validation,lastDiagnostic:request.base.lastDiagnostic,
      normalization:null};
    const expected=baseFor(before,request.base.priorScopePaths,
      request.base.openFindings,request.base.auxiliary??null);
    const derived=verifyCapture({context,snapshotBytes,current:before,capture,
      expectedBase:expected,admissionRef,allowRejection:true});
    if(!derived.rejection || latest.operationAttemptId!==derived.origin.operationAttemptId
      || latest.diagnostic!==derived.rejection || !same(latest.origin,derived.origin)
      || latest.round!==1 || latest.consumedInvocations!==1
      || !same(current.counters,request.base.counters)
      || !same(current.baseline,derived.observed.observed.after))
      invalid('post-conversion rejection proof differs');
    const inherited=jsonBytes(capture.origin,'rejection origin').value.admission?.binding?.normalization??null;
    const causeSha256=inherited?.causeSha256??raw(encode({class:'formal-rejection',
      operationAttemptId:request.owner.operationAttemptId,
      requestSha256:raw(capture.validationRequest),responseSha256:raw(capture.rawResponse),
      scopePaths:request.scope.paths}));
    const normalization={episodeId:inherited?.episodeId??request.owner.operationAttemptId,
      operation:'VALIDATE_SLICE',causeSha256,
      sourceOperationAttemptId:inherited?.sourceOperationAttemptId??request.owner.operationAttemptId,
      used:1,consumedInvocations:inherited?2:1,round:inherited?2:1,
      status:inherited?'exhausted':'settled'};
    if(!same(current.normalization,normalization)
      || !same(current.lastDiagnostic,{code:'RUNNER_RESULT_REJECTED',
        operationAttemptId:request.owner.operationAttemptId,reason:derived.rejection,
        affectedPaths:request.scope.paths,nextAction:inherited?'stop':'normalize'}))
      invalid('post-conversion normalization/diagnostic differs');
    let priorFacts;
    if(request.base.evidenceSha256===null) {
      if(bundle.validation!==null || bundle.findingsChecks.length || formalRejections.length!==1
        || bundle.support.length!==1 || bundle.openFindings.length)
        invalid('first converted rejection contains foreign history');
      priorFacts=await inspectConvertedDelivery({context,snapshot,current:before,bundleBytes:null,
        observedWork:request.base.baseline});
    } else {
      const priorSupport=bundle.support.slice(0,-1);
      const retained=[...bundle.implementation,...priorSupport,...bundle.findingsChecks,
        ...(bundle.validation?[bundle.validation]:[])];
      const priorBundle={...bundle,support:priorSupport,
        objects:referencedObjects(retained,map)};
      const priorBytes=encode(priorBundle);
      if(raw(priorBytes)!==request.base.evidenceSha256)
        stale('rejection predecessor retained bytes differ');
      const baseActivation=jsonBytes(capture.origin,'rejection origin').value.admission.baseActivation;
      priorFacts=await recurse({context,snapshotBytes,current:{...before,
        evidence:{path:current.evidence.path,sha256:raw(priorBytes)},
        normalization:inherited?{episodeId:inherited.episodeId,operation:inherited.operation,
          causeSha256:inherited.causeSha256,sourceOperationAttemptId:inherited.sourceOperationAttemptId,
          used:inherited.used,consumedInvocations:inherited.consumedInvocations,
          round:inherited.round,status:inherited.status}:null},
        bundleBytes:priorBytes,observedWork:request.base.baseline,
        lastAttempt:baseActivation.lastAttempt,
        admissionRef:baseActivation.lastAttempt?.operationRef??null});
    }
    const approved=postAuthority(snapshot,current);
    const matches=same(observedWork,current.baseline);
    return {context,authority:approved,bundle,
      records:bundle.validation?.recordFormat==='stnl-task-record-v1-imported'
        ?{implementation:bundle.implementation,findings:bundle.findingsChecks,
          validation:[...bundle.support.filter(item=>item.kind==='validation'),bundle.validation]}
        :priorFacts.records??{implementation:[],findings:[],validation:[]},
      latest:priorFacts.latest??null,verifiedChanges:priorFacts.verifiedChanges??[],
      verifiedCorrections:priorFacts.verifiedCorrections??[],rejection:derived,
      auxiliaryStatus:null,formalStatus:null,slice:current.slice,deliveryId:current.deliveryId,
      counters:current.counters,counterAuthority:'persisted-continuity',
      persistedValidation:current.validation,observedValidation:matches?current.validation:'revalidation-required',
      evidenceSha256:current.evidence.sha256,baseline:current.baseline,observationMatches:matches,
      openFindings:bundle.openFindings,openDivergences:[],cycle:priorFacts.cycle,
      origins:priorFacts.origins??null,
      consumption:{kind:'bounded-formal-rejection',lastOperationAttemptId:request.owner.operationAttemptId,
        operation:'VALIDATE_SLICE',consumedInvocations:normalization.consumedInvocations,
        remainingInvocations:inherited?0:1,resumable:!inherited},diagnostics:[],
      requiresFormalRevalidation:!inherited && matches};
  }
  if(auxiliaryRejections.length && current.normalization===null
    && bundle.validation?.recordFormat==='stnl-task-record-v2'
    && bundle.findingsChecks.length) {
    const objects=sourceMap(bundle);
    const formalCap=restoreCaptureSources('current-validation',bundle.validation,objects);
    const formalRequest=jsonBytes(formalCap.validationRequest,'formal after findings refusal request').value;
    if(formalRequest.format==='stnl-current-validation-request-v4'
      && formalRequest.base.auxiliary?.operationAttemptId
        ===bundle.findingsChecks.at(-1).origin.operationAttemptId) {
      const priorRecord=bundle.support.filter(item=>item.kind==='validation').at(-1);
      if(!priorRecord || formalRequest.base.counters.validationAttempts+1
        !==current.counters.validationAttempts)
        invalid('formal after findings refusal predecessor is absent');
      const priorSupport=bundle.support.filter(item=>item!==priorRecord);
      const priorBundle={...bundle,validation:priorRecord,support:priorSupport,
        openFindings:formalRequest.base.openFindings,
        objects:referencedObjects([...priorSupport,...bundle.findingsChecks,priorRecord],objects)};
      const priorBytes=encode(priorBundle);
      if(raw(priorBytes)!==formalRequest.base.evidenceSha256)
        stale('formal after findings refusal predecessor bytes differ');
      const origin=jsonBytes(formalCap.origin,'formal after findings refusal origin').value;
      const baseActivation=origin.admission?.baseActivation;
      const priorCurrent={...current,evidence:{path:current.evidence.path,sha256:raw(priorBytes)},
        counters:formalRequest.base.counters,baseline:formalRequest.base.baseline,
        validation:formalRequest.base.validation,lastDiagnostic:formalRequest.base.lastDiagnostic,
        normalization:null};
      const predecessor=await recurse({context,snapshotBytes,current:priorCurrent,
        bundleBytes:priorBytes,observedWork:priorCurrent.baseline,
        lastAttempt:baseActivation?.lastAttempt??null,
        admissionRef:baseActivation?.lastAttempt?.operationRef??null});
      if(predecessor.cycle?.owner.operationAttemptId!==formalRequest.base.auxiliary.operationAttemptId
        || predecessor.rejection) invalid('formal predecessor is not a concluded successor APPLY');
      const expected=baseFor(priorCurrent,formalRequest.base.priorScopePaths,
        formalRequest.base.openFindings,formalRequest.base.auxiliary);
      const derived=verifyCapture({context,snapshotBytes,current:priorCurrent,capture:formalCap,
        expectedBase:expected,admissionRef});
      const record={...derived.recordDraft,sources:bundle.validation.sources};
      if(!same(bundle.validation,record) || !same(bundle.openFindings,derived.open)
        || !same(current.counters,{...priorCurrent.counters,
          validationAttempts:priorCurrent.counters.validationAttempts+1,
          findings:priorCurrent.counters.findings+derived.response.newFindings.length})
        || !same(current.baseline,derived.observed.observed.after)
        || current.lastDiagnostic!==null)
        invalid('formal after findings refusal proof differs');
      const status=derived.payload.status;
      const expectedValidation=status==='PASS'?'current':status==='BLOCKED'?'uncertain':'revalidation-required';
      if(current.validation!==expectedValidation)
        invalid('formal after findings refusal validation differs');
      const matches=same(observedWork,current.baseline);
      const approved=postAuthority(snapshot,current);
      const verifiedCorrections=predecessor.verifiedCorrections;
      const verifiedChanges=[...new Set([...postChangedPaths(context,approved.delivery,current.slice,
        predecessor.latest.request.base.baseline,current.baseline),...verifiedCorrections])].sort(ordinal);
      return {context,authority:approved,bundle,records:{implementation:[],
        findings:[...priorBundle.support.filter(item=>item.kind==='findings-check'),...bundle.findingsChecks],
        validation:[...bundle.support.filter(item=>item.kind==='validation'),bundle.validation]},
        latest:{record,request:formalRequest,all:derived.all,dispositions:derived.dispositions},
        verifiedChanges,verifiedCorrections,rejection:null,auxiliaryStatus:predecessor.auxiliaryStatus,
        formalStatus:status,slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
        counterAuthority:'persisted-continuity',persistedValidation:current.validation,
        observedValidation:matches?current.validation:'revalidation-required',
        evidenceSha256:current.evidence.sha256,baseline:current.baseline,observationMatches:matches,
        openFindings:bundle.openFindings,openDivergences:[],cycle:predecessor.cycle,
        consumption:{kind:'closed-formal-boundary',lastOperationAttemptId:formalRequest.owner.operationAttemptId,
          operation:'VALIDATE_SLICE',consumedInvocations:1,remainingInvocations:null,resumable:false},
        diagnostics:[],requiresFormalRevalidation:status!=='PASS'||!matches};
    }
  }
  const successorRecord=auxiliaryRejections.length?bundle.findingsChecks.find(item=>
    item.origin.operationAttemptId!==auxiliaryRejections[0].origin.operationAttemptId)
    ??auxiliaryRejections[1]??null:null;
  if(successorRecord) {
    if(auxiliaryRejections.length>2 || formalRejections.length || bundle.implementation.length
      || bundle.deliveryId!==current.deliveryId || bundle.slice!==current.slice
      || bundle.currentAuthoritySha256!==current.authoritySha256
      || raw(bundleBytes)!==current.evidence?.sha256)
      invalid('findings successor image identity differs');
    const approved=postAuthority(snapshot,current),objects=sourceMap(bundle);
    const cap=restoreCaptureSources('current-findings',successorRecord,objects);
    const request=jsonBytes(cap.applyRequest,'findings successor request').value;
    applyRequestShape(request);
    const inherited=jsonBytes(cap.origin,'findings successor origin').value.admission?.binding?.normalization;
    if(request.format!=='stnl-current-findings-request-v2' || !inherited
      || inherited.operation!=='APPLY_FINDINGS' || inherited.status!=='settled'
      || inherited.round!==1 || inherited.consumedInvocations>=3
      || inherited.sourceEvidenceSha256!==request.base.evidenceSha256
      || inherited.sourceActivationId!==request.owner.originActivationId)
      mismatch('findings successor has no bounded predecessor');
    const priorChecks=bundle.support.filter(item=>item.kind==='findings-check');
    const priorSupport=bundle.support.filter(item=>item.kind!=='findings-check'
      && item!==auxiliaryRejections[1]);
    const priorBundle={...bundle,findingsChecks:priorChecks,support:priorSupport,
      objects:referencedObjects([...priorChecks,...priorSupport,bundle.validation],objects)};
    const priorBytes=encode(priorBundle);
    if(raw(priorBytes)!==request.base.evidenceSha256)
      stale('findings successor predecessor bytes differ');
    const priorBaseline=jsonBytes(cap.baselineCapture,'findings successor baseline').value.manifest;
    const priorChecked=inspectFindings(priorBytes,priorBundle,context,approved,request.base.counters,
      priorBaseline,{snapshotBytes,current,admissionRef:jsonBytes(cap.origin,'successor origin').value
        .admission.baseActivation.lastAttempt?.operationRef??null});
    if(!priorChecked.cycle.rejection || !same(priorChecked.cycle.lastWork,priorBaseline))
      invalid('findings successor predecessor refusal differs');
    const {sourceEvidenceSha256,sourceActivationId,...priorNormalization}=inherited;
    const priorCurrent={...current,evidence:{path:current.evidence.path,sha256:raw(priorBytes)},
      counters:request.base.counters,baseline:priorBaseline,validation:'revalidation-required',
      normalization:priorNormalization,lastDiagnostic:{code:'RUNNER_RESULT_REJECTED',
        operationAttemptId:priorChecked.cycle.owner.operationAttemptId,
        reason:priorChecked.cycle.rejection.diagnostic,affectedPaths:priorChecked.cycle.lastScope,
        nextAction:'normalize'}};
    const baseActivation=jsonBytes(cap.origin,'successor origin').value.admission.baseActivation;
    const predecessor=await recurse({context,snapshotBytes,current:priorCurrent,
      bundleBytes:priorBytes,observedWork:priorBaseline,lastAttempt:baseActivation.lastAttempt,
      admissionRef:baseActivation.lastAttempt?.operationRef??null});
    if(predecessor.consumption.kind!=='bounded-findings-rejection'
      || predecessor.consumption.remainingInvocations<1)
      invalid('findings successor predecessor budget differs');
    const currentRecords=[...bundle.findingsChecks,
      ...(auxiliaryRejections[1]?[auxiliaryRejections[1]]:[])];
    const rounds=applyRoundsFromRecords(currentRecords,objects);
    const facts={sha256:raw(priorBytes),counters:request.base.counters,
      validation:{id:priorBundle.validation.id,recordSha256:raw(encode(priorBundle.validation))},
      openFindings:priorBundle.openFindings,priorScopePaths:predecessor.cycle.lastScope,
      testedWork:priorBaseline,removalPaths:[],priorFailure:predecessor.rejection.diagnostic};
    const cycle=deriveApplyCycle({context,authority:approved,owner:request.owner,rounds,
      baseFacts:facts,store:closeEvidenceObjects(),post:{snapshotBytes,current,admissionRef},
      offset:inherited.consumedInvocations});
    cycle.admissionId=priorBundle.validation.id;
    cycle.selectedFindings=predecessor.cycle.selectedFindings;
    equal(bundle.findingsChecks,cycle.checks,'EVIDENCE_STALE','successor findings checks');
    equal(auxiliaryRejections[1]??null,cycle.rejection,'EVIDENCE_STALE','successor findings refusal');
    const expectedCounters={...request.base.counters,
      findingsChecks:request.base.counters.findingsChecks+cycle.checks.length};
    equal(current.counters,expectedCounters,'INVALID_CURRENT_IMAGE','successor findings counters');
    equal(current.baseline,cycle.lastWork,'INVALID_CURRENT_IMAGE','successor findings baseline');
    const normalization=cycle.rejection?{...priorNormalization,
      consumedInvocations:cycle.consumedInvocations,round:2,status:'exhausted'}:null;
    if(!same(current.normalization,normalization) || current.validation!=='revalidation-required'
      || !same(current.lastDiagnostic,cycle.rejection?{code:'RUNNER_RESULT_REJECTED',
        operationAttemptId:request.owner.operationAttemptId,reason:cycle.rejection.diagnostic,
        affectedPaths:cycle.lastScope,nextAction:'stop'}:null))
      invalid('successor findings terminal state differs');
    const matches=same(observedWork,current.baseline);
    const verifiedCorrections=postChangedPaths(context,approved.delivery,current.slice,
      predecessor.latest.record.testedWork,cycle.lastWork);
    const verifiedChanges=[...new Set([...postChangedPaths(context,approved.delivery,current.slice,
      predecessor.latest.request.base.baseline,cycle.lastWork),...verifiedCorrections])].sort(ordinal);
    return {context,authority:approved,bundle,records:{implementation:[],
      findings:[...priorChecks,...bundle.findingsChecks],validation:[...priorBundle.support.filter(item=>item.kind==='validation'),bundle.validation]},
      latest:predecessor.latest,origins:predecessor.origins,verifiedChanges,verifiedCorrections,
      rejection:cycle.rejection?{...cycle.rejection,request}:null,
      auxiliaryStatus:cycle.rejection?null:cycle.status,formalStatus:'NEEDS_FIX',slice:current.slice,
      deliveryId:current.deliveryId,counters:current.counters,counterAuthority:'persisted-continuity',
      persistedValidation:current.validation,observedValidation:matches?current.validation:'revalidation-required',
      evidenceSha256:current.evidence.sha256,baseline:current.baseline,observationMatches:matches,
      openFindings:bundle.openFindings,openDivergences:[],cycle,
      consumption:{kind:cycle.rejection?'bounded-findings-rejection':'closed-findings-boundary',
        lastOperationAttemptId:request.owner.operationAttemptId,operation:'APPLY_FINDINGS',
        consumedInvocations:cycle.consumedInvocations,remainingInvocations:0,resumable:false},
      diagnostics:[],requiresFormalRevalidation:!cycle.rejection && matches};
  }
  if(auxiliaryRejections.length===1 && current.normalization?.operation==='APPLY_FINDINGS') {
    if(formalRejections.length || bundle.implementation.length || bundle.deliveryId!==current.deliveryId
      || bundle.slice!==current.slice || bundle.currentAuthoritySha256!==current.authoritySha256
      || raw(bundleBytes)!==current.evidence?.sha256)
      invalid('post-conversion auxiliary rejection identity differs');
    const approved=postAuthority(snapshot,current);
    const verified=inspectFindings(bundleBytes,bundle,context,approved,current.counters,observedWork,
      {snapshotBytes,current,admissionRef});
    const refusal=verified.cycle.rejection;
    if(!refusal) invalid('auxiliary rejection support lacks derived refusal');
    const retained=restoreCaptureSources('current-findings',refusal,sourceMap(bundle));
    const request=jsonBytes(retained.applyRequest,
      'retained findings refusal request').value;
    const inherited=jsonBytes(retained.origin,
      'retained findings refusal origin').value.admission?.binding?.normalization??null;
    const consumed=(inherited?.consumedInvocations??0)+verified.cycle.consumedInvocations;
    const normalization={episodeId:inherited?.episodeId??request.owner.operationAttemptId,
      operation:'APPLY_FINDINGS',causeSha256:inherited?.causeSha256??raw(encode({class:'findings-rejection',
        operationAttemptId:request.owner.operationAttemptId,
        requestSha256:raw(retained.applyRequest),responseSha256:raw(retained.rawResponse),
        scopePaths:verified.cycle.lastScope})),
      sourceOperationAttemptId:inherited?.sourceOperationAttemptId??request.owner.operationAttemptId,
      used:1,consumedInvocations:consumed,round:inherited?2:1,
      status:inherited||consumed>=3?'exhausted':'settled'};
    if(!same(current.normalization,normalization) || !same(current.baseline,verified.cycle.lastWork)
      || current.validation!=='revalidation-required' || !same(current.lastDiagnostic,
        {code:'RUNNER_RESULT_REJECTED',operationAttemptId:request.owner.operationAttemptId,
          reason:refusal.diagnostic,affectedPaths:verified.cycle.lastScope,
          nextAction:normalization.status==='settled'?'normalize':'stop'}))
      invalid('post-conversion auxiliary refusal state differs');
    const matches=same(observedWork,current.baseline);
    const admission=verified.origins.get(verified.cycle.admissionId);
    const verifiedCorrections=postChangedPaths(context,approved.delivery,current.slice,
      admission.record.testedWork,verified.cycle.lastWork);
    const verifiedChanges=[...new Set([...postChangedPaths(context,approved.delivery,current.slice,
      admission.request.base.baseline,verified.cycle.lastWork),...verifiedCorrections])].sort(ordinal);
    return {context,authority:approved,bundle,records:{implementation:[],findings:bundle.findingsChecks,
      validation:[...bundle.support.filter(item=>item.kind==='validation'),bundle.validation]},
      latest:verified.latest,origins:verified.origins,verifiedChanges,verifiedCorrections,
      rejection:{...refusal,request},auxiliaryStatus:null,formalStatus:'NEEDS_FIX',slice:current.slice,
      deliveryId:current.deliveryId,counters:current.counters,counterAuthority:'persisted-continuity',
      persistedValidation:current.validation,observedValidation:matches?current.validation:'revalidation-required',
      evidenceSha256:current.evidence.sha256,baseline:current.baseline,observationMatches:matches,
      openFindings:bundle.openFindings,openDivergences:[],cycle:verified.cycle,
      consumption:{kind:'bounded-findings-rejection',lastOperationAttemptId:request.owner.operationAttemptId,
        operation:'APPLY_FINDINGS',consumedInvocations:consumed,
        remainingInvocations:normalization.status==='settled'?3-consumed:0,
        resumable:normalization.status==='settled'},diagnostics:[],
      requiresFormalRevalidation:normalization.status==='settled' && matches};
  }
  if(bundle.findingsChecks.length) {
    if(bundle.implementation.length || bundle.deliveryId!==current.deliveryId || bundle.slice!==current.slice
      || bundle.currentAuthoritySha256!==current.authoritySha256
      || raw(bundleBytes)!==current.evidence?.sha256 || current.lastDiagnostic!==null)
      invalid('post-conversion findings bundle identity differs');
    const approved=postAuthority(snapshot,current);
    const post={snapshotBytes,current,admissionRef:lastAttempt?.operation==='APPLY_FINDINGS'
      ?lastAttempt.operationRef:null};
    let verifiedBundle=bundle,verifiedBytes=copyBytes(bundleBytes,'post-conversion findings');
    if(formalRejections.length) {
      if(formalRejections.length!==1 || current.normalization!==null)
        invalid('closed findings successor has invalid rejection history');
      const sourceMapCurrent=sourceMap(bundle);
      const latestCapture=restoreCaptureSources('current-validation',bundle.validation,sourceMapCurrent);
      const latestRequest=jsonBytes(latestCapture.validationRequest,'findings successor request').value;
      const inherited=jsonBytes(latestCapture.origin,'findings successor origin').value.admission?.binding?.normalization;
      const priorRecord=bundle.support.filter(item=>item.kind==='validation').at(-1);
      if(!inherited || !priorRecord || inherited.sourceEvidenceSha256!==latestRequest.base.evidenceSha256
        || inherited.sourceActivationId!==latestRequest.owner.originActivationId
        || inherited.round!==1 || inherited.status!=='settled')
        mismatch('findings successor rejection lineage differs');
      const priorSupport=bundle.support.filter(item=>item!==priorRecord);
      const priorBundle={...bundle,validation:priorRecord,support:priorSupport,
        openFindings:latestRequest.base.openFindings,
        objects:referencedObjects([...priorSupport,...bundle.findingsChecks,priorRecord],sourceMapCurrent)};
      const priorBytes=encode(priorBundle);
      if(raw(priorBytes)!==latestRequest.base.evidenceSha256)
        stale('findings successor retained predecessor bytes differ');
      const {sourceEvidenceSha256,sourceActivationId,...normalization}=inherited;
      const baseActivation=jsonBytes(latestCapture.origin,'findings successor origin').value.admission.baseActivation;
      const predecessor=await recurse({context,snapshotBytes,
        current:{...current,evidence:{path:current.evidence.path,sha256:raw(priorBytes)},
          counters:latestRequest.base.counters,baseline:latestRequest.base.baseline,
          validation:latestRequest.base.validation,lastDiagnostic:latestRequest.base.lastDiagnostic,
          normalization},bundleBytes:priorBytes,observedWork:latestRequest.base.baseline,
        lastAttempt:baseActivation.lastAttempt,
        admissionRef:baseActivation.lastAttempt?.operationRef??null});
      if(!predecessor.rejection || predecessor.consumption.remainingInvocations!==1)
        invalid('findings successor predecessor is not settled');
      verifiedBundle={...bundle,support:bundle.support.filter(item=>item.kind!=='rejection'),
        objects:referencedObjects([...bundle.support.filter(item=>item.kind!=='rejection'),
          ...bundle.findingsChecks,bundle.validation],sourceMapCurrent)};
      verifiedBytes=encode(verifiedBundle);
    }
    const verified=inspectFindings(verifiedBytes,verifiedBundle,context,
      approved,current.counters,observedWork,post);
    if(lastAttempt?.operation==='VALIDATE_SLICE' && admissionRef!==null
      && verified.latest.request.owner.operationAttemptId===lastAttempt.operationAttemptId)
      verifyPostAdmission({context,snapshotBytes,owner:verified.latest.request.owner,
        capture:verified.latest.cap,admissionRef});
    const sealed=verified.latest.record.id===verified.cycle.admissionId
      ?verified.cycle.lastWork:verified.latest.record.testedWork;
    if(!same(current.baseline,sealed)) invalid('post-conversion findings baseline differs');
    const expectedValidation=verified.rejected?'uncertain'
      :verified.formalStatus==='PASS' && !bundle.openFindings.some(item=>item.severity==='blocking')
        ?'current':'revalidation-required';
    if(current.validation!==expectedValidation) invalid('post-conversion findings validation state differs');
    const observationMatches=same(observedWork,sealed);
    const admission=verified.origins.get(verified.cycle.admissionId);
    const verifiedChanges=postChangedPaths(context,approved.delivery,current.slice,
      admission.request.base.baseline,sealed);
    const verifiedCorrections=postChangedPaths(context,approved.delivery,current.slice,
      admission.record.testedWork,verified.cycle.lastWork);
    const changed=[...new Set([...verifiedChanges,...verifiedCorrections])].sort(ordinal);
    return {context,authority:approved,bundle,
      records:{implementation:[],findings:bundle.findingsChecks,
        validation:[...bundle.support.filter(item=>item.kind==='validation'),bundle.validation]},
      latest:verified.latest,origins:verified.origins,verifiedChanges:changed,verifiedCorrections,rejection:verified.rejected,
      auxiliaryStatus:verified.cycle.status,formalStatus:verified.formalStatus,
      slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
      counterAuthority:'persisted-continuity',persistedValidation:current.validation,
      observedValidation:observationMatches?current.validation:'revalidation-required',
      evidenceSha256:current.evidence.sha256,baseline:current.baseline,observationMatches,
      openFindings:bundle.openFindings,openDivergences:[],cycle:verified.cycle,
      consumption:{kind:'closed-findings-boundary',lastOperationAttemptId:lastAttempt?.operationAttemptId??verified.cycle.owner.operationAttemptId,
        operation:lastAttempt?.operation??'APPLY_FINDINGS',consumedInvocations:verified.cycle.consumedInvocations,
        remainingInvocations:0,resumable:false},diagnostics:[],
      requiresFormalRevalidation:expectedValidation!=='current'||!observationMatches};
  }
  const record=bundle.validation;
  const importedPrior=bundle.support.filter(item=>item.kind==='validation'
    && item.recordFormat==='stnl-task-record-v1-imported');
  const historicalPrior=current.localRevision===2?bundle.support.filter(item=>item.kind==='validation'
    && item.recordFormat==='stnl-task-record-v2' && item.origin.localRevision===1):[];
  if(!record || record.recordFormat!=='stnl-task-record-v2'
    || bundle.implementation.length && importedPrior.length!==1
    || bundle.findingsChecks.length || bundle.support.some(item=>item.kind!=='rejection'
      && !importedPrior.includes(item) && !historicalPrior.includes(item))
    || importedPrior.length>1 || historicalPrior.length>1 || importedPrior.length && historicalPrior.length
    || formalRejections.length>1 || bundle.openDivergences.length
    || record.sources.legacyPreparation!==null || bundle.deliveryId!==current.deliveryId
    || bundle.slice!==current.slice || bundle.currentAuthoritySha256!==current.authoritySha256
    || raw(bundleBytes)!==current.evidence?.sha256)
    invalid('post-conversion formal bundle is not a closed replacement');
  const objects=new Map(bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')]));
  const capture=restoreCaptureSources('current-validation',record,objects);
  const request=jsonBytes(capture.validationRequest,'post-conversion request').value;
  const admission=jsonBytes(capture.origin,'post-conversion native origin').value.admission;
  const siblingLeaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===current.deliveryId);
  const historicalSibling=retainedRead??(current.localRevision===1 && snapshot.deliveries.length===2
    && snapshot.deliveries.filter(item=>item.localRevision===2).length===1
    && snapshot.deliveries.some(item=>item.deliveryId===current.deliveryId && item.localRevision===1)
    && record.origin.preparationRevision===snapshot.preparationRevision-1
    && record.origin.localRevision===1 && record.origin.normativeSha256===current.authoritySha256
    && same(record.contract.delivery,siblingLeaf)
    && same(record.contract.context,{requirementsAuthority:snapshot.requirementsAuthority,
      objective:snapshot.normativeProjection.global.objective,
      strategy:snapshot.normativeProjection.global.strategy,
      risks:snapshot.normativeProjection.global.risks})
    && admission?.baseActivation?.approvedSnapshotSha256===request.base.approvedSnapshotSha256
    && admission.baseActivation.preparationRevision===snapshot.preparationRevision-1
    && bundle.support.length===0 && bundle.implementation.length===0
    && bundle.openFindings.length===0 && formalRejections.length===0
    ?{authority:{...postAuthority(snapshot,current),
      preparationRevision:record.origin.preparationRevision},
      snapshotDigest:request.base.approvedSnapshotSha256}:null);
  if(historicalPrior.length) {
    const old=historicalPrior[0];
    const priorBundle={...bundle,validation:old,support:[],openFindings:[],
      objects:referencedObjects([old],sourceMap(bundle))};
    const priorBytes=encode(priorBundle);
    if(raw(priorBytes)!==request.base.evidenceSha256)
      stale('local review retained historical predecessor bytes differ');
    const origin=jsonBytes(capture.origin,'local review formal origin').value;
    const priorCurrent={...current,evidence:{path:current.evidence.path,sha256:raw(priorBytes)},
      counters:request.base.counters,baseline:request.base.baseline,
      validation:request.base.validation,lastDiagnostic:request.base.lastDiagnostic};
    const predecessor=await recurse({context,snapshotBytes,current:priorCurrent,
      bundleBytes:priorBytes,observedWork:priorCurrent.baseline,
      lastAttempt:origin.admission?.baseActivation?.lastAttempt??null});
    if(!predecessor.requiresFormalRevalidation || predecessor.formalStatus!==null)
      invalid('local review formal predecessor is not historical');
  }
  if(formalRejections.length) {
    const origin=jsonBytes(capture.origin,'formal successor origin').value;
    const inherited=origin.admission?.binding?.normalization;
    if(!inherited || inherited.sourceEvidenceSha256!==request.base.evidenceSha256
      || inherited.sourceActivationId!==request.owner.originActivationId
      || inherited.status!=='settled' || inherited.round!==1
      || inherited.consumedInvocations!==1)
      mismatch('formal successor rejection lineage differs');
    const priorBundle={...bundle,validation:importedPrior[0]??null,support:formalRejections,
      openFindings:request.base.openFindings,
      objects:referencedObjects([...bundle.implementation,...formalRejections,...importedPrior],sourceMap(bundle))};
    const priorBytes=encode(priorBundle);
    if(raw(priorBytes)!==request.base.evidenceSha256)
      stale('formal successor retained predecessor bytes differ');
    const {sourceEvidenceSha256,sourceActivationId,...normalization}=inherited;
    const priorCurrent={...current,evidence:{path:current.evidence.path,sha256:raw(priorBytes)},
      counters:request.base.counters,baseline:request.base.baseline,
      validation:request.base.validation,lastDiagnostic:request.base.lastDiagnostic,
      normalization};
    const predecessor=await recurse({context,snapshotBytes,current:priorCurrent,
      bundleBytes:priorBytes,observedWork:priorCurrent.baseline,
      lastAttempt:origin.admission.baseActivation.lastAttempt,
      admissionRef:origin.admission.baseActivation.lastAttempt?.operationRef??null});
    if(!predecessor.rejection || predecessor.consumption.remainingInvocations!==1)
      invalid('formal successor predecessor is not settled');
  }
  const predecessor={evidence:{sha256:request.base.evidenceSha256},counters:request.base.counters,
    baseline:request.base.baseline,validation:request.base.validation,lastDiagnostic:request.base.lastDiagnostic};
  const expected=baseFor(predecessor,request.base.priorScopePaths,[],null,
    historicalSibling?.snapshotDigest??null);
  const derived=verifyCapture({context,snapshotBytes,current,capture,expectedBase:expected,admissionRef,
    historicalProof:historicalSibling});
  if(!same(record,{...derived.recordDraft,sources:record.sources})
    || !same(bundle.openFindings,derived.open)
    || !same(current.counters,{...request.base.counters,
      validationAttempts:request.base.counters.validationAttempts+1,
      findings:request.base.counters.findings+derived.response.newFindings.length})
    || !same(current.baseline,derived.observed.observed.after)
    || current.lastDiagnostic!==null
    || request.owner.originActivationId!==record.origin.originActivationId)
    invalid('post-conversion record, counters or baseline differ from captured proof');
  const status=derived.payload.status;
  const expectedValidation=status==='PASS'?'current':status==='BLOCKED'?'uncertain':'revalidation-required';
  if(current.validation!==expectedValidation) invalid('post-conversion sealed validation differs');
  const observationMatches=same(observedWork,record.testedWork);
  const approved=postAuthority(snapshot,current);
  const verifiedChanges=postChangedPaths(context,approved.delivery,current.slice,
    request.base.baseline,record.testedWork);
  return {context,authority:approved,bundle,
    records:{implementation:[],findings:[],validation:[...historicalPrior,record]},
    latest:{record,request,all:derived.all,dispositions:derived.dispositions},
    verifiedChanges,verifiedCorrections:[],rejection:null,auxiliaryStatus:null,
    slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
    counterAuthority:'persisted-continuity',persistedValidation:current.validation,
    observedValidation:observationMatches?current.validation:'revalidation-required',
    evidenceSha256:current.evidence.sha256,baseline:current.baseline,observationMatches,
    openFindings:bundle.openFindings,openDivergences:[],
    cycle:{implementation:[],findings:[],validation:record.id,state:'closed'},
    consumption:{kind:'closed-formal-boundary',lastOperationAttemptId:record.origin.operationAttemptId,
      operation:'VALIDATE_SLICE',consumedInvocations:1,remainingInvocations:null,resumable:false},
    diagnostics:[],requiresFormalRevalidation:status!=='PASS' || !observationMatches,
    formalStatus:status,record,request};
}

function postSection(document,name,body) {
  const lines=document.split('\n');
  const start=lines.findIndex(line=>line===`## ${name}`);
  if(start<0) invalid(`Task lacks ${name}`);
  let end=start+1;
  while(end<lines.length && !lines[end].startsWith('## ')) end+=1;
  return [...lines.slice(0,start+1),'',body,'',...lines.slice(end)].join('\n');
}
function priorValidationOverlap(changed,priorDeliveries) {
  return priorDeliveries.filter(item=>item.facts.formalStatus==='PASS').flatMap(item=>
    changed.filter(name=>item.facts.latest.request.scope.paths.includes(name)).map(name=>[item.slice,name]))
    .sort((a,b)=>ordinal(a[0],b[0])||ordinal(a[1],b[1]));
}
// Approval decisions describe the frozen review. A replacement is operational
// evidence only after its complete native admission and sources verify against
// this snapshot and current local authority; a digest or lastAttempt is insufficient.
function completedReviewReferences(snapshot) {
  const decisions=new Map(snapshot.globalReview.evidenceDecisions.map(item=>[item.deliveryId,item.evidenceSha256]));
  for(const delivery of snapshot.deliveries)for(const item of delivery.review.evidenceDecisions)
    if(!decisions.has(item.deliveryId))decisions.set(item.deliveryId,item.evidenceSha256);
  for(const item of snapshot.completed)if(!decisions.has(item.deliveryId))decisions.set(item.deliveryId,item.evidenceSha256);
  return [...decisions].map(([deliveryId,evidenceSha256])=>({deliveryId,evidenceSha256}))
    .sort((a,b)=>ordinal(a.deliveryId,b.deliveryId));
}
export async function completedEvidenceContext({context,snapshotBytes,continuity,files}) {
  if(!continuity.completed.length)return {retainedEvidence:null,fresh:new Set()};
  const snapshot=jsonBytes(snapshotBytes,'approved preparation').value;
  const fresh=new Set(),members=[...continuity.completed,...continuity.deliveries];
  const retainedEvidence=members.filter(item=>item.evidence).map(item=>{
    const decision=snapshot.globalReview.evidenceDecisions.find(value=>value.deliveryId===item.deliveryId)
      ??snapshot.deliveries.find(value=>value.deliveryId===item.deliveryId)?.review.evidenceDecisions
        .find(value=>value.deliveryId===item.deliveryId);
    if(decision && decision.evidenceSha256!==item.evidence.sha256) {
      if(continuity.completed.includes(item))stale('completed evidence differs from frozen approval');
      fresh.add(item.deliveryId);
    }
    return {deliveryId:item.deliveryId,evidenceSha256:decision?.evidenceSha256??item.evidence.sha256};
  }).sort((a,b)=>ordinal(a.deliveryId,b.deliveryId));
  for(const id of fresh) {
    const current=continuity.deliveries.find(item=>item.deliveryId===id);
    const bundleBytes=files.get(current.evidence.path),bundle=jsonBytes(bundleBytes,'operational replacement').value;
    validateCurrentEvidence(bundle);
    if(current.localRevision!==1 || bundle.validation?.recordFormat!=='stnl-task-record-v2'
      || bundle.implementation.length)
      mismatch('completed profile requires native operational evidence');
    for(const record of [bundle.validation,...bundle.findingsChecks,...bundle.support]) {
      const formal=record.origin.operation==='VALIDATE_SLICE';
      if(record.origin.transport!=='native'
        || !['VALIDATE_SLICE','APPLY_FINDINGS'].includes(record.origin.operation)
        || record.kind!=='rejection'&&record.recordFormat!=='stnl-task-record-v2')
        mismatch('operational replacement contains a foreign evidence family');
      const capture=restoreCaptureSources(formal?'current-validation':'current-findings',record,sourceMap(bundle));
      const request=jsonBytes(formal?capture.validationRequest:capture.applyRequest,'operational replacement request').value;
      const origin=jsonBytes(capture.origin,'operational replacement admission').value;
      if(!origin.admission
        || formal&&!['stnl-current-validation-request-v3','stnl-current-validation-request-v4'].includes(request.format)
        || !formal&&!['stnl-current-findings-request-v1','stnl-current-findings-request-v2'].includes(request.format)
        || formal&&request.base.approvedSnapshotSha256!==raw(snapshotBytes)
        || origin.admission.baseActivation.approvedSnapshotSha256!==raw(snapshotBytes)
        || origin.admission.baseActivation.preparationRevision!==snapshot.preparationRevision)
        mismatch('operational replacement lacks current native A0/A1 admission');
    }
    await inspectPostConversionEvidence({context,snapshotBytes,current,bundleBytes,
      observedWork:current.baseline,preparationProfile:'completed-current',retainedEvidence});
  }
  return {retainedEvidence,fresh};
}
async function postPriorDeliveries({context,snapshotBytes,continuity,files,current,activation}) {
  const prior=[...continuity.completed,...continuity.deliveries.slice(0,continuity.deliveries.indexOf(current))];
  const {retainedEvidence,fresh}=await completedEvidenceContext({context,snapshotBytes,continuity,files});
  const verified=[];
  for(const previous of prior) {
    if(!previous.evidence)continue;
    const bundleBytes=files.get(previous.evidence.path),bundle=jsonBytes(bundleBytes,'prior validation evidence').value;
    if(bundle.validation?.recordFormat!=='stnl-task-record-v2')continue;
    const request=requestForRecord(bundle.validation,sourceMap(bundle));
    const post=['stnl-current-validation-request-v3','stnl-current-validation-request-v4'].includes(request.format);
    const lastAttempt=activation.lastAttempt?.deliveryId===previous.deliveryId?activation.lastAttempt:null;
    const facts=post?await inspectPostConversionEvidence({context,snapshotBytes,current:previous,bundleBytes,
      observedWork:previous.baseline,lastAttempt,admissionRef:lastAttempt?.operationRef??null,
      preparationProfile:continuity.completed.length?'completed-current':'converted-current',retainedEvidence,
      retainedRead:continuity.completed.length&&!fresh.has(previous.deliveryId)
        ?{authority:request.authority,snapshotDigest:request.base.approvedSnapshotSha256}:null})
      :inspectCurrentEvidence({context,authority:request.authority,bundleBytes,counters:previous.counters,
        baseline:previous.baseline,observedWork:previous.baseline,currentAuthoritySha256:previous.authoritySha256});
    verified.push({slice:previous.slice,facts});
  }
  return verified;
}
function postTask(document,derived,digest,context,{cycle=null,admission=null,checks=[],validations=[],priorDeliveries=[]}={}) {
  const {request,payload,recordDraft,observed}=derived;
  const scope=request.scope.paths;
  const evidence=serializeMarkdownScalar('Evidence summary',payload.evidence,true);
  const commands=observed.commands.map((item,index)=>
    `  - ${serializeCommand(item.command,`command ${index+1}`)} | exit:${item.exit}`);
  const tested=new Map(recordDraft.testedWork.entries.map(item=>[item.path,item]));
  const files=scope.map(name=>{
    const relative=taskRelative(context,request.owner.slice,name);
    const entry=tested.get(name);
    if(!entry || entry.kind==='absent') incomplete('post-conversion formal lacks file state or removal proof');
    return `  - \`${relative}\` | ${entry.sha256}`;
  });
  const base=[`- Origin attempt: ${request.attemptId}`,
    '- Attempt type: revalidation',`- HEAD: ${payload.head}`,`- Result: ${payload.status}`,
    scope.length?'- Files:':'- Files: none',...files,
    ...(!scope.length?[`- Fileless reason: ${request.scope.filelessReason}`]:[]),
    '- Authoritative commands:',...commands,`- Evidence summary: ${evidence}`].join('\n');
  const status=payload.status;
  const validation=status==='PASS'?'current':status==='BLOCKED'?'uncertain':'revalidation-required';
  const corrections=cycle?postChangedPaths(context,request.authority.delivery,request.owner.slice,
    admission.record.testedWork,cycle.lastWork):[];
  const changed=[...new Set([...postChangedPaths(context,request.authority.delivery,request.owner.slice,
    admission?.request.base.baseline??request.base.baseline,recordDraft.testedWork),...corrections])].sort(ordinal);
  const findingBody=derived.all.length?derived.all.map(item=>[
    `### ${item.id}`,`- Severity: ${item.severity}`,`- Origin: ${item.originAttempt}`,
    `- Problem: ${serializeMarkdownScalar('Problem',item.problem,true)}`,
    `- Evidence: ${serializeMarkdownScalar('Evidence',item.evidence,true)}`,
    `- Impact: ${serializeMarkdownScalar('Impact',item.impact,true)}`,
    `- Related authority: ${serializeMarkdownScalar('Related authority',item.relatedAuthority,true)}`,
    `- Expected correction: ${serializeMarkdownScalar('Expected correction',item.expectedCorrection,true)}`,
    `- State: ${derived.dispositions.get(item.id)}`,
    ...(derived.dispositions.get(item.id)==='resolved'?[`- Resolution: ${request.attemptId}`]:[]),
    ...(derived.dispositions.get(item.id)==='superseded'?[`- Superseded by: ${request.attemptId}`]:[])].join('\n')).join('\n\n'):'- none';
  let value=document;
  for(const [section,body] of [
    ['Continuity',`- Current validation: ${validation}\n- Current evidence: ${digest}\n- Current action: ${status==='PASS'?'none':status==='NEEDS_FIX'?'APPLY_FINDINGS':'blocked'}`],
    ['Changed Areas',changed.length?changed.map(name=>`- \`${taskRelative(context,request.owner.slice,name)}\``).join('\n'):'- none'],
    ['Corrections Applied',corrections.length?corrections.map(name=>`- \`${taskRelative(context,request.owner.slice,name)}\``).join('\n'):'- none'],
    ['Prior Validation Overlap',priorValidationOverlap(changed,priorDeliveries).map(([slice,name])=>
      `- Slice ${slice.slice(6)} overlap: \`${taskRelative(context,request.owner.slice,name)}\`; Accepted delta overlaps verified prior formal PASS.`).join('\n')||'- none'],
    ['Implementation Test Evidence','- none'],['Findings Test Evidence',checks.length?checks.map(item=>item.recordUtf8).join('\n\n'):'- none'],
    ['Validation Attempts',[...validations.map(item=>item.recordUtf8),recordDraft.recordUtf8].join('\n\n')],['Validation Findings',findingBody],
    ['Delegation Blocker','- none'],
    ['Effective Validation Base',status==='PASS'?base:'- none'],
    ['Diff Summary',changed.length
      ?`- Formal validation measured ${changed.length} approved product path${changed.length===1?'':'s'} after the converted boundary.`
      :'- Formal validation measured the approved recipe without a product change.'],
    ['Final Result',status==='PASS'?'- PASS':'- pending'],
  ]) value=postSection(value,section,body);
  return utf8(value);
}
function postApplyTask(document,cycle,admission,digest,context,bundle) {
  const slice=cycle.owner.slice,delivery=admission.request.authority.delivery;
  const corrections=postChangedPaths(context,delivery,slice,admission.record.testedWork,cycle.lastWork);
  const changed=[...new Set([...postChangedPaths(context,delivery,slice,
    admission.request.base.baseline,cycle.lastWork),...corrections])].sort(ordinal);
  const paths=items=>items.length?items.map(name=>`- \`${taskRelative(context,slice,name)}\``).join('\n'):'- none';
  const findings=bundle.openFindings.length?bundle.openFindings.map(item=>[
    `### ${item.id}`,`- Severity: ${item.severity}`,`- Origin: ${item.originAttempt}`,
    `- Problem: ${serializeMarkdownScalar('Problem',item.problem,true)}`,
    `- Evidence: ${serializeMarkdownScalar('Evidence',item.evidence,true)}`,
    `- Impact: ${serializeMarkdownScalar('Impact',item.impact,true)}`,
    `- Related authority: ${serializeMarkdownScalar('Related authority',item.relatedAuthority,true)}`,
    `- Expected correction: ${serializeMarkdownScalar('Expected correction',item.expectedCorrection,true)}`,
    '- State: active'].join('\n')).join('\n\n'):'- none';
  let value=document;
  for(const [section,body] of [
    ['Continuity',`- Current validation: revalidation-required\n- Current evidence: ${digest}\n- Current action: ${cycle.status==='BLOCKED'?'blocked':'VALIDATE_SLICE'}`],
    ['Changed Areas',paths(changed)],['Corrections Applied',paths(corrections)],
    ['Findings Test Evidence',cycle.checks.length?cycle.checks.map(item=>item.recordUtf8).join('\n\n'):'- none'],
    ['Validation Attempts',[...bundle.support.filter(item=>item.kind==='validation'),bundle.validation]
      .map(item=>item.recordUtf8).join('\n\n')],
    ['Validation Findings',findings],
    ['Delegation Blocker','- none'],
    ['Diff Summary',`- Auxiliary findings cycle verified ${corrections.length} corrected approved product path${corrections.length===1?'':'s'}; formal findings remain active.`],
  ]) value=postSection(value,section,body);
  return utf8(value);
}
function postIndex(document,slice,status) {
  let found=false;
  const lines=document.split('\n').map(line=>{
    if(!/^\| \[[ x]\] \|/u.test(line)) return line;
    const cols=line.slice(1,-1).split('|').map(item=>item.trim());
    if(!cols[1].startsWith(`${slice.slice(6)} - `)) return line;
    found=true;
    cols[0]=status==='PASS'?'[x]':'[ ]';cols[5]=status;cols[6]=status==='PASS'?'PASS':'pending';
    return `| ${cols.join(' | ')} |`;
  });
  if(!found) invalid(`${slice}: index row absent`);
  return utf8(lines.join('\n'));
}

export async function composePostConversionValidation({context,requirementsAuthority,previous,admission=null,deliveryId,capture}) {
  closed(previous,['activationBytes','files'],'post-conversion predecessor');
  const activation=jsonBytes(previous.activationBytes,'predecessor activation').value;
  const files=new Map([...previous.files].map(([name,bytes])=>[name,copyBytes(bytes,name)]));
  const checked=validateCurrentImage({activationBytes:previous.activationBytes,files});
  if(activation.activeAttempt!==null) uncertain('predecessor has an active owner');
  const snapshotBytes=files.get('approved-preparation.json');
  const snapshot=jsonBytes(snapshotBytes,'approved-preparation.json').value;
  if(snapshot.requirementsAuthority!==requirementsAuthority || activation.requirementsAuthority!==requirementsAuthority)
    stale('post-conversion requirements authority differs');
  const current=checked.continuity.deliveries.find(item=>item.deliveryId===deliveryId);
  const completedProfile=checked.continuity.completed.length>0;
  if(!current || ![1,2].includes(current.localRevision)
    || completedProfile && (current.localRevision!==1 || admission===null || capture.transport!=='native'))
    fail('UNSUPPORTED_FORMAT','post-conversion delivery is not an open converted local revision');
  if(current.evidence===null && current.counters.validationAttempts===0)
    fail('UNSUPPORTED_FORMAT','S0 is read-only in offline post-conversion validation');
  const bundleBytes=current.evidence?files.get(current.evidence.path):null;
  const request=jsonBytes(capture.validationRequest,'post-conversion request').value;
  requestShape(request);
  if(!['stnl-current-validation-request-v3','stnl-current-validation-request-v4'].includes(request.format)
    || request.owner.deliveryId!==deliveryId
    || request.owner.slice!==current.slice)
    mismatch('post-conversion owner does not address predecessor');
  const previousBundle=bundleBytes?jsonBytes(bundleBytes,'predecessor bundle').value:null;
  const previousRecord=previousBundle?.validation;
  const previousV3=previousRecord?.recordFormat==='stnl-task-record-v2';
  const evidenceContext=await completedEvidenceContext({context,snapshotBytes,continuity:checked.continuity,files});
  const inspectionOptions={preparationProfile:completedProfile?'completed-current':'converted-current',
    retainedEvidence:evidenceContext.retainedEvidence};
  const retainedBase=completedProfile&&!evidenceContext.fresh.has(deliveryId);
  const priorRequest=retainedBase&&previousV3?requestForRecord(previousRecord,sourceMap(previousBundle)):null;
  const priorOptions={...inspectionOptions,...(priorRequest?{retainedRead:{authority:priorRequest.authority,
    snapshotDigest:priorRequest.base.approvedSnapshotSha256}}:{})};
  if(completedProfile && (!previousV3 || current.localRevision!==1
    || previousBundle.implementation.length || previousBundle.openDivergences.length))
    fail('UNSUPPORTED_FORMAT','completed native validation requires a verified native formal or findings base');
  const historicalPrior=current.localRevision===2 && previousV3
    && previousRecord.origin.localRevision===1;
  const previousRejected=previousBundle?.support?.some(item=>item.kind==='rejection'
    && item.origin.operation==='VALIDATE_SLICE')??false;
  if(previousV3 && !completedProfile && !historicalPrior && !previousRejected && (!previousBundle.findingsChecks.length
      && activation.lastAttempt?.operationAttemptId!==previousRecord.origin.operationAttemptId
    || activation.lastAttempt?.outcome!=='recorded'
    || activation.lastAttempt?.terminalActivationId!==activation.activationId))
    incomplete('predecessor formal is not incorporated by activation');
  if(admission!==null) {
    closed(admission,['activationBytes','files'],'post-conversion reservation');
    const admitted=validateCurrentImage(admission).activation;
    if(admitted.previousActivationId!==activation.activationId
      || admitted.sequence!==activation.sequence+1
      || !same(admitted.artifacts,activation.artifacts)
      || !same(admitted.activeAttempt,{
        ...request.owner,operationRef:admitted.activeAttempt?.operationRef})
      || admitted.activeAttempt?.originActivationId!==activation.activationId
      || files.size!==admission.files.size
      || [...files].some(([name,bytes])=>!Buffer.from(admission.files.get(name)??[]).equals(bytes)))
      mismatch('post-conversion reservation is not the admitted owner over unchanged artifacts');
    const origin=jsonBytes(capture.origin,'native admission origin').value;
    if(capture.transport!=='native' || !origin.admission
      || !same(origin.admission.baseActivation,activation)
      || !same(origin.admission.reservedActivation,admitted))
      mismatch('captured native admission witness differs from A0/A1');
  }
  const replay=previousV3 && previousRecord.origin.operationAttemptId===request.owner.operationAttemptId;
  if(replay) {
    const retained=restoreCaptureSources('current-validation',previousRecord,
      sourceMap(jsonBytes(bundleBytes,'predecessor bundle').value));
    if(!exactCapture(retained,capture)) mismatch('same owner has different captured bytes');
    await inspectPostConversionEvidence({context,snapshotBytes,current,bundleBytes,observedWork:current.baseline,
      lastAttempt:activation.lastAttempt,admissionRef:activation.lastAttempt?.operationRef??null});
    return {files,transition:{deliveryId,slice:current.slice,
      operationAttemptId:request.owner.operationAttemptId,originActivationId:request.owner.originActivationId,
      outcome:'recorded',counters:structuredClone(current.counters)},consumedInvocations:1,replayed:true};
  }
  if(request.owner.originActivationId!==activation.activationId)
    mismatch('post-conversion owner origin activation differs');
  let previousFacts=null;
  if(previousRejected) {
    if(current.normalization?.status!=='settled' || current.normalization.round!==1
      || activation.lastAttempt?.outcome!=='rejected'
      || !same(jsonBytes(capture.origin,'successor origin').value.admission?.binding?.normalization,
        {...current.normalization,sourceEvidenceSha256:current.evidence.sha256,
          sourceActivationId:activation.activationId}))
      mismatch('formal successor is not bound to settled predecessor');
    previousFacts=await inspectPostConversionEvidence({context,snapshotBytes,current,bundleBytes,
      observedWork:current.baseline,lastAttempt:activation.lastAttempt,
      admissionRef:activation.lastAttempt.operationRef});
    if(!previousFacts.rejection || previousFacts.consumption.remainingInvocations!==1)
      fail('NORMALIZATION_EXHAUSTED','formal successor budget is exhausted');
  } else if(historicalPrior) {
    previousFacts=await inspectPostConversionEvidence({context,snapshotBytes,current,bundleBytes,
      observedWork:current.baseline,lastAttempt:activation.lastAttempt});
    if(previousFacts.formalStatus!==null || !previousFacts.requiresFormalRevalidation)
      invalid('local review predecessor is not a historical formal');
  } else if(previousV3) {
    previousFacts=await inspectPostConversionEvidence({context,snapshotBytes,current,bundleBytes,
      observedWork:current.baseline,lastAttempt:activation.lastAttempt,
      admissionRef:activation.lastAttempt?.operationRef??null,...priorOptions});
    const readyCycle=previousBundle.findingsChecks.length
      && previousFacts.cycle?.admissionId===previousRecord.id
      && ['TESTS_PASS','TESTS_FAIL'].includes(previousFacts.cycle.status);
    const readyPass=previousFacts.formalStatus==='PASS' && !previousFacts.openFindings.length
      && current.validation==='current';
    if(!readyCycle && !readyPass)
      fail('UNSUPPORTED_FORMAT','another formal requires concluded findings or a closed PASS');
  } else {
    const facts=await inspectConvertedDelivery({context,snapshot,current,bundleBytes,observedWork:current.baseline});
    if(!['closed-formal-boundary','closed-boundary-not-resumable'].includes(facts.consumption.kind))
      fail('UNSUPPORTED_FORMAT','S0 cannot compose a post-conversion formal');
  }
  const output=postOutput(context,postAuthority(snapshot,current).delivery,current.slice);
  const findingsCycle=previousFacts?.cycle?.admissionId?previousFacts.cycle:null;
  const priorScopePaths=findingsCycle && findingsCycle.admissionId===previousRecord?.id
    ?findingsCycle.lastScope
    :previousRejected?previousFacts.rejection.request.scope.paths
    :[...new Set([
      ...current.baseline.entries.filter(item=>['file','absent'].includes(item.kind)).map(item=>item.path).filter(output),
      ...(previousV3 && !historicalPrior?previousFacts.latest.request.scope.paths:[]),
    ])].sort(ordinal);
  const auxiliary=findingsCycle ? {kind:'findings',
    operationAttemptId:findingsCycle.owner.operationAttemptId,
    cycle:findingsCycle.admissionId,firstCheckId:findingsCycle.checks[0].id,
    lastCheckId:findingsCycle.checks.at(-1).id,
    recordsSha256:raw(encode(findingsCycle.checks))}:null;
  if(request.format!==(auxiliary?'stnl-current-validation-request-v4':'stnl-current-validation-request-v3'))
    invalid('converted formal request does not match findings state');
  const base=postBase(snapshotBytes,current,priorScopePaths,previousBundle?.openFindings??[],auxiliary);
  const derived=postCaptureProof({context,snapshotBytes,current,capture,expectedBase:base,
    allowRejection:true});
  if(completedProfile && derived.rejection)
    fail('RUNNER_RESULT_REJECTED',`completed native judgment rejected: ${derived.rejection}`);
  if(request.owner.preparationRevision!==snapshot.preparationRevision
    || request.owner.localRevision!==current.localRevision
    || request.owner.normativeSha256!==current.authoritySha256)
    mismatch('post-conversion owner authority differs');
  const store=closeEvidenceObjects();
  const sources=packCaptureSources('current-validation',capture,store);
  if(derived.rejection) {
    const origin=jsonBytes(capture.origin,'native rejection origin').value;
    const inherited=origin.admission?.binding?.normalization??null;
    if(inherited && (inherited.operation!=='VALIDATE_SLICE' || inherited.status!=='settled'
      || inherited.round!==1 || inherited.consumedInvocations!==1
      || inherited.sourceOperationAttemptId===request.owner.operationAttemptId))
      mismatch('formal successor has invalid inherited normalization');
    const causeSha256=inherited?.causeSha256??raw(encode({class:'formal-rejection',
      operationAttemptId:request.owner.operationAttemptId,
      requestSha256:raw(capture.validationRequest),responseSha256:raw(capture.rawResponse),
      scopePaths:request.scope.paths}));
    const normalization={episodeId:inherited?.episodeId??request.owner.operationAttemptId,
      operation:'VALIDATE_SLICE',causeSha256,
      sourceOperationAttemptId:inherited?.sourceOperationAttemptId??request.owner.operationAttemptId,
      used:1,consumedInvocations:inherited?2:1,round:inherited?2:1,
      status:inherited?'exhausted':'settled'};
    const rejection={kind:'rejection',operationAttemptId:request.owner.operationAttemptId,
      origin:derived.origin,diagnostic:derived.rejection,consumedInvocations:1,round:1,sources};
    const retained=previousBundle?.support??[];
    if(retained.some(item=>item.kind==='rejection' && item.origin.operation==='VALIDATE_SLICE')
      && !inherited) mismatch('prior formal rejection requires inherited episode');
    const support=[...retained,rejection];
    const bundle={format:'stnl-current-evidence-v1',deliveryId,
      currentAuthoritySha256:current.authoritySha256,slice:current.slice,
      logicalTaskPath:`tasks/${current.slice}.md`,implementation:previousBundle?.implementation??[],
      findingsChecks:previousBundle?.findingsChecks??[],validation:previousBundle?.validation??null,
      openFindings:previousBundle?.openFindings??[],openDivergences:[],support,
      objects:referencedObjects([...(previousBundle?.implementation??[]),...support,...(previousBundle?.findingsChecks??[]),
        ...(previousBundle?.validation?[previousBundle.validation]:[])],
        mergeObjects(previousBundle?sourceMap(previousBundle):new Map(),store))};
    validateCurrentEvidence(bundle);
    const nextBytes=encode(bundle),nextDigest=raw(nextBytes);
    const next={...current,evidence:{path:`evidence/${deliveryId}.json`,sha256:nextDigest},
      baseline:derived.observed.observed.after,validation:'revalidation-required',normalization,
      lastDiagnostic:{code:'RUNNER_RESULT_REJECTED',operationAttemptId:request.owner.operationAttemptId,
        reason:derived.rejection,affectedPaths:request.scope.paths,nextAction:inherited?'stop':'normalize'}};
    const continuity={...checked.continuity,deliveries:checked.continuity.deliveries.map(item=>
      item.deliveryId===deliveryId?next:item)};
    files.set(next.evidence.path,nextBytes);
    files.set('continuity.json',encode(continuity));
    let task=Buffer.from(files.get(`tasks/${current.slice}.md`)).toString('utf8');
    task=postSection(task,'Continuity',`- Current validation: revalidation-required\n- Current evidence: ${nextDigest}\n- Current action: ${inherited?'blocked':'normalize'}`);
    task=postSection(task,'Delegation Blocker','- Operation: VALIDATE_SLICE\n- State: active');
    task=postSection(task,'Effective Validation Base','- none');
    task=postSection(task,'Final Result','- pending');
    files.set(`tasks/${current.slice}.md`,utf8(task));
    files.set('tasks.md',postIndex(Buffer.from(files.get('tasks.md')).toString('utf8'),current.slice,'pending'));
    validateCurrentCandidate({files});
    return {files,transition:{deliveryId,slice:current.slice,
      operationAttemptId:request.owner.operationAttemptId,originActivationId:activation.activationId,
      outcome:'rejected',normalization,counters:structuredClone(current.counters)},
      consumedInvocations:1,replayed:false};
  }
  const record={...derived.recordDraft,sources};
  const importedPrior=previousRejected && previousRecord?.recordFormat==='stnl-task-record-v1-imported';
  const auxiliaryHistory=previousBundle?.support?.filter(item=>item.kind==='findings-check'
    || item.kind==='rejection' && item.origin.operation==='APPLY_FINDINGS')??[];
  const support=findingsCycle ? [...auxiliaryHistory.filter(item=>item.kind==='findings-check'),...formalOrigins(
    [...previousBundle.support.filter(item=>item.kind==='validation'),previousRecord],
    [...derived.all,...findingsCycle.selectedFindings],record.id,[findingsCycle.admissionId]),
    ...auxiliaryHistory.filter(item=>item.kind==='rejection'),
    ...(previousRejected?previousBundle.support.filter(item=>item.kind==='rejection'):[])]
    :previousRejected?[...previousBundle.support.filter(item=>item.kind==='rejection'),
      ...(importedPrior?[previousRecord]:[])]:historicalPrior?[previousRecord]:[];
  const implementation=importedPrior?previousBundle.implementation:[];
  const objects=referencedObjects([...implementation,...support,...(findingsCycle?previousBundle.findingsChecks:[]),record],
    mergeObjects(previousBundle?sourceMap(previousBundle):new Map(),store));
  const bundle={format:'stnl-current-evidence-v1',deliveryId,currentAuthoritySha256:current.authoritySha256,
    slice:current.slice,logicalTaskPath:`tasks/${current.slice}.md`,implementation,
    findingsChecks:findingsCycle?previousBundle.findingsChecks:[],
    validation:record,openFindings:derived.open,openDivergences:[],support,objects};
  validateCurrentEvidence(bundle);
  const nextBytes=encode(bundle),nextDigest=raw(nextBytes);
  const status=derived.payload.status;
  const nextCounters={...current.counters,validationAttempts:current.counters.validationAttempts+1,
    findings:current.counters.findings+derived.response.newFindings.length};
  const next={...current,evidence:{path:`evidence/${deliveryId}.json`,sha256:nextDigest},
    counters:nextCounters,baseline:derived.observed.observed.after,
    validation:status==='PASS'?'current':status==='BLOCKED'?'uncertain':'revalidation-required',
    normalization:null,lastDiagnostic:null};
  const continuity={...checked.continuity,deliveries:checked.continuity.deliveries.map(item=>item.deliveryId===deliveryId?next:item)};
  files.set(next.evidence.path,nextBytes);
  files.set('continuity.json',encode(continuity));
  const taskName=`tasks/${current.slice}.md`;
  const priorDeliveries=await postPriorDeliveries({context,snapshotBytes,continuity:checked.continuity,
    files:previous.files,current,activation});
  files.set(taskName,postTask(Buffer.from(files.get(taskName)).toString('utf8'),derived,nextDigest,context,
    {priorDeliveries,...(findingsCycle?{cycle:findingsCycle,
      admission:previousFacts.origins.get(findingsCycle.admissionId),
      checks:bundle.findingsChecks,validations:support.filter(item=>item.kind==='validation')}
      :historicalPrior?{validations:[previousRecord]}:{})}));
  files.set('tasks.md',postIndex(Buffer.from(files.get('tasks.md')).toString('utf8'),current.slice,status));
  validateCurrentCandidate({files});
  const {validateCurrentPreparation}=await import('./execution-preparation-current.mjs');
  const finalContext=await completedEvidenceContext({context,snapshotBytes,continuity,files});
  const prepared=validateCurrentPreparation({context,requirementsAuthority,snapshotBytes,
    artifacts:new Map([...files].filter(([name])=>name.endsWith('.md'))),
    profile:inspectionOptions.preparationProfile,retainedEvidence:finalContext.retainedEvidence});
  const carrier=prepared.currentArtifacts.deliveries.find(item=>item.deliveryId===deliveryId);
  const facts=await inspectPostConversionEvidence({context,snapshotBytes,current:next,bundleBytes:nextBytes,
    observedWork:next.baseline,preparationProfile:inspectionOptions.preparationProfile,
    retainedEvidence:finalContext.retainedEvidence});
  if(carrier.continuity.evidence!==nextDigest)invalid('composed formal carrier evidence digest differs');
  validateCurrentEvidenceCarriers({facts,sections:carrier.sections,
    continuity:{...carrier.continuity,evidence:next.evidence.path},
    index:carrier.index,slice:current.slice,priorDeliveries});
  return {files,transition:{deliveryId,slice:current.slice,
    operationAttemptId:request.owner.operationAttemptId,originActivationId:activation.activationId,
    outcome:'recorded',counters:nextCounters},consumedInvocations:1,replayed:false};
}
async function convertedFindingsCycle({context,snapshotBytes,current,bundleBytes,owner:expectedOwner,rounds,
  allowPrefix=false}) {
  const prior=jsonBytes(bundleBytes,'converted findings predecessor').value;
  validateCurrentEvidence(prior);
  if(prior.implementation.length || prior.validation?.recordFormat!=='stnl-task-record-v2'
    || prior.openDivergences.length || !prior.openFindings.some(item=>item.severity==='blocking'))
    fail('UNSUPPORTED_FORMAT','converted findings require a concluded blocking formal');
  const base=await inspectPostConversionEvidence({context,snapshotBytes,current,bundleBytes,
    observedWork:current.baseline});
  const successor=base.rejection?.origin.operation==='APPLY_FINDINGS'
    && current.normalization?.status==='settled' && current.normalization.round===1;
  if(base.formalStatus!=='NEEDS_FIX' || (prior.validation.id===base.cycle?.admissionId && !successor))
    fail('UNSUPPORTED_FORMAT','NEEDS_FIX already has a findings cycle');
  const first=jsonBytes(rounds[0].applyRequest,'first converted findings request').value;
  applyRequestShape(first);
  equal(first.owner,expectedOwner,'OWNER_MISMATCH','converted findings owner');
  if(successor) {
    const origin=jsonBytes(rounds[0].origin,'findings successor origin').value;
    const inherited=origin.admission?.binding?.normalization;
    if(first.format!=='stnl-current-findings-request-v2'
      || !same(inherited,{...current.normalization,sourceEvidenceSha256:current.evidence.sha256,
        sourceActivationId:first.owner.originActivationId})
      || base.consumption.remainingInvocations<1
      || first.owner.operationAttemptId===current.normalization.sourceOperationAttemptId)
      mismatch('findings successor does not inherit a settled bounded refusal');
  }
  const facts={sha256:raw(bundleBytes),counters:current.counters,
    validation:{id:prior.validation.id,recordSha256:raw(encode(prior.validation))},
    openFindings:prior.openFindings,priorScopePaths:successor?base.cycle.lastScope:base.latest.request.scope.paths,
    testedWork:successor?current.baseline:prior.validation.testedWork,removalPaths:[],
    ...(successor?{priorFailure:base.rejection.diagnostic}:{})};
  const store=closeEvidenceObjects();
  const cycle=deriveApplyCycle({context,authority:base.authority,owner:expectedOwner,
    rounds,baseFacts:facts,store,post:{snapshotBytes,current},allowPrefix,
    offset:successor?current.normalization.consumedInvocations:0});
  cycle.admissionId=prior.validation.id;
  return {base,cycle,store,prior,successor};
}
export async function inspectPostConversionFindingsPrefix({context,snapshotBytes,current,bundleBytes,owner,rounds}) {
  const {cycle}=await convertedFindingsCycle({context,snapshotBytes,current,bundleBytes,
    owner,rounds,allowPrefix:true});
  if(cycle.rejection) fail('RUNNER_RESULT_REJECTED',
    `captured findings response is rejected: ${cycle.rejection.diagnostic}`);
  return {status:cycle.status,rounds:cycle.consumedInvocations,checks:cycle.checks,
    lastWork:cycle.lastWork,lastScope:cycle.lastScope};
}
export async function composePostConversionFindings({context,requirementsAuthority,previous,admission=null,
  deliveryId,rounds}) {
  closed(previous,['activationBytes','files'],'converted findings predecessor');
  dense(rounds,'converted findings rounds',1,3);
  const activation=jsonBytes(previous.activationBytes,'converted findings activation').value;
  if(activation.activeAttempt!==null) uncertain('converted findings predecessor has active owner');
  const files=new Map([...previous.files].map(([name,bytes])=>[name,copyBytes(bytes,name)]));
  const checked=validateCurrentImage({activationBytes:previous.activationBytes,files});
  const snapshotBytes=files.get('approved-preparation.json');
  const snapshot=jsonBytes(snapshotBytes,'approved-preparation.json').value;
  if(snapshot.preparationRevision<=1 || snapshot.requirementsAuthority!==requirementsAuthority
    || activation.requirementsAuthority!==requirementsAuthority) stale('converted findings authority differs');
  const current=checked.continuity.deliveries.find(item=>item.deliveryId===deliveryId);
  const completedProfile=checked.continuity.completed.length>0;
  if(!current || current.localRevision!==1 || !current.evidence || completedProfile&&admission===null)
    fail('UNSUPPORTED_FORMAT','converted findings delivery is not open');
  const owner=jsonBytes(rounds[0].applyRequest,'converted findings request').value.owner;
  if(owner.deliveryId!==deliveryId || owner.slice!==current.slice
    || owner.originActivationId!==activation.activationId) mismatch('converted findings owner/predecessor');
  if(admission!==null) {
    closed(admission,['activationBytes','files'],'converted findings reservation');
    const admitted=validateCurrentImage(admission).activation;
    if(admitted.previousActivationId!==activation.activationId || admitted.sequence!==activation.sequence+1
      || !same(admitted.artifacts,activation.artifacts)
      || !same(admitted.activeAttempt,{...owner,operationRef:admitted.activeAttempt?.operationRef})
      || files.size!==admission.files.size
      || [...files].some(([name,bytes])=>!Buffer.from(admission.files.get(name)??[]).equals(bytes)))
      mismatch('converted findings reservation changed the admitted base');
    if(completedProfile)for(const capture of rounds) {
      const origin=jsonBytes(capture.origin,'completed findings origin').value;
      if(capture.transport!=='native' || !same(origin.admission?.baseActivation,activation)
        || !same(origin.admission?.reservedActivation,admitted))
        mismatch('completed findings capture differs from actual A0/A1 reservation');
    }
  }
  const bundleBytes=files.get(current.evidence.path);
  const {base,cycle,store,prior,successor}=await convertedFindingsCycle({context,snapshotBytes,current,bundleBytes,
    owner,rounds});
  const formalSupport=formalOrigins([...prior.support.filter(item=>item.kind==='validation'),prior.validation],
    prior.openFindings,prior.validation.id);
  const support=[...(successor?prior.findingsChecks:[]),...formalSupport,
    ...(successor?prior.support.filter(item=>item.kind==='rejection'):[])];
  if(cycle.rejection) support.push(cycle.rejection);
  const joined=mergeObjects(sourceMap(prior),store);
  const bundle={...prior,implementation:[],findingsChecks:cycle.checks,validation:prior.validation,
    openFindings:prior.openFindings,openDivergences:[],support};
  bundle.objects=referencedObjects([...bundle.findingsChecks,bundle.validation,...bundle.support],joined);
  validateCurrentEvidence(bundle);
  const outputBytes=encode(bundle),nextDigest=raw(outputBytes);
  const nextCounters={...current.counters,findingsChecks:current.counters.findingsChecks+cycle.checks.length};
  const rejection=cycle.rejection;
  const inherited=successor?current.normalization:null;
  const normalization=rejection?{episodeId:inherited?.episodeId??owner.operationAttemptId,
    operation:'APPLY_FINDINGS',
    causeSha256:inherited?.causeSha256??raw(encode({class:'findings-rejection',operationAttemptId:owner.operationAttemptId,
      requestSha256:raw(rounds.at(-1).applyRequest),responseSha256:raw(rounds.at(-1).rawResponse),
      scopePaths:cycle.lastScope})),sourceOperationAttemptId:owner.operationAttemptId,
    used:1,consumedInvocations:cycle.consumedInvocations,round:inherited?2:1,
    status:inherited||cycle.consumedInvocations>=3?'exhausted':'settled'}:null;
  if(normalization && inherited) normalization.sourceOperationAttemptId=inherited.sourceOperationAttemptId;
  const next={...current,evidence:{path:current.evidence.path,sha256:nextDigest},
    counters:nextCounters,baseline:cycle.lastWork,validation:'revalidation-required',normalization,
    lastDiagnostic:rejection?{code:'RUNNER_RESULT_REJECTED',operationAttemptId:owner.operationAttemptId,
      reason:rejection.diagnostic,affectedPaths:cycle.lastScope,
      nextAction:normalization.status==='settled'?'normalize':'stop'}:null};
  const continuity={...checked.continuity,deliveries:checked.continuity.deliveries.map(item=>item.deliveryId===deliveryId?next:item)};
  files.set(next.evidence.path,outputBytes);
  files.set('continuity.json',encode(continuity));
  const taskName=`tasks/${current.slice}.md`;
  const taskCycle=successor?{...cycle,checks:[...prior.findingsChecks,...cycle.checks]}:cycle;
  let task=postApplyTask(Buffer.from(files.get(taskName)).toString('utf8'),taskCycle,base.latest,nextDigest,context,bundle);
  if(rejection) {
    const action=normalization.status==='settled'?'normalize':'blocked';
    task=postSection(Buffer.from(task).toString('utf8'),'Continuity',
      `- Current validation: revalidation-required\n- Current evidence: ${nextDigest}\n- Current action: ${action}`);
    task=postSection(task,'Delegation Blocker','- Operation: APPLY_FINDINGS\n- State: active');
    task=postSection(task,'Effective Validation Base','- none');
    task=postSection(task,'Final Result','- pending');
    task=utf8(task);
  }
  files.set(taskName,task);
  validateCurrentCandidate({files});
  await inspectPostConversionEvidence({context,snapshotBytes,current:next,bundleBytes:outputBytes,
    observedWork:cycle.lastWork});
  if(completedProfile) {
    const {retainedEvidence}=await completedEvidenceContext({context,snapshotBytes,continuity,files});
    const {validateCurrentPreparation}=await import('./execution-preparation-current.mjs');
    const prepared=validateCurrentPreparation({context,requirementsAuthority,snapshotBytes,
      artifacts:new Map([...files].filter(([name])=>name.endsWith('.md'))),profile:'completed-current',retainedEvidence});
    const carrier=prepared.currentArtifacts.deliveries.find(item=>item.deliveryId===deliveryId);
    const facts=await inspectPostConversionEvidence({context,snapshotBytes,current:next,bundleBytes:outputBytes,
      observedWork:cycle.lastWork,retainedEvidence});
    const priorDeliveries=await postPriorDeliveries({context,snapshotBytes,continuity:checked.continuity,
      files:previous.files,current,activation});
    if(carrier.continuity.evidence!==nextDigest)invalid('composed findings carrier evidence digest differs');
    validateCurrentEvidenceCarriers({facts,sections:carrier.sections,
      continuity:{...carrier.continuity,evidence:next.evidence.path},index:carrier.index,slice:current.slice,priorDeliveries});
  }
  return {files,transition:{deliveryId,slice:current.slice,
    operationAttemptId:owner.operationAttemptId,originActivationId:activation.activationId,
    outcome:rejection?'rejected':'recorded',normalization,counters:nextCounters},
    consumedInvocations:rounds.length,replayed:false};
}
function applySemanticError(message) { return new RunnerSemanticResultError('APPLY_FINDINGS',new Error(message)); }
function applyEnvelope(rawText,requestBytes,receipt,transport,round) {
  let external=null; let defect=null;
  try { external=parseCurrentJson(rawText); }
  catch { defect=applySemanticError('captured response is not strict JSON'); }
  if (external && typeof external==='object' && !Array.isArray(external)
    && typeof external.requestSha256==='string' && HASH.test(external.requestSha256)
    && external.requestSha256!==raw(requestBytes)) stale(`round ${round}: response requestSha256 differs`);
  if (receipt.status==='RUNNER_RESPONSE_CAPTURED') {
    if (receipt.captureFailure!==null || (transport==='managed' && (receipt.exitCode!==0 || receipt.captureFailureCode!==null))) uncertain(`round ${round}: accepted findings receipt not concluded`);
    if (!external || typeof external!=='object' || Array.isArray(external)
      || typeof external.result?.status!=='string' || receipt.semanticResponseStatus!==external.result.status) uncertain(`round ${round}: accepted findings receipt cannot bind result status`);
    if (receipt.testedState===null) incomplete(`round ${round}: accepted findings receipt lacks testedState`);
  } else if (receipt.status==='RUNNER_RESULT_BLOCKED') {
    if (receipt.semanticResponseStatus!==null || receipt.testedState!==null
      || typeof receipt.captureFailure!=='string' || !receipt.captureFailure.trim()
      || (transport==='managed' && (receipt.exitCode!==1 || receipt.captureFailureCode!=='RUNNER_RESPONSE_SCHEMA_INVALID'))) uncertain(`round ${round}: schema rejection is not concluded`);
  } else uncertain(`round ${round}: findings result not concluded`);
  if (!defect) try {
    closed(external,['format','requestSha256','result'],'findings response');
    if (external.format!=='stnl-current-findings-response-v1') throw new Error('findings response envelope format');
    token(external.requestSha256,HASH,'findings response requestSha256');
    if (external.requestSha256!==raw(requestBytes)) stale(`round ${round}: response requestSha256 differs`);
    return {payload:parseCapturedResult('APPLY_FINDINGS',
      (text,operation)=>parseSemanticExecutionPayload(text,operation,{
        automaticCheckRound:transport==='managed' ? `${round}/3` : undefined,
      }),JSON.stringify(external.result))};
  } catch (error) {
    if (error.code==='EVIDENCE_STALE') throw error;
    defect=error instanceof RunnerSemanticResultError ? error : applySemanticError(error.message);
  }
  if (receipt.status==='RUNNER_RESULT_BLOCKED' || receipt.status==='RUNNER_RESPONSE_CAPTURED') return {error:defect};
  uncertain(`round ${round}: findings envelope has no concluded receipt`);
}
function applySemanticGate(payload,work,request,transport) {
  try {
    for (const [key,label] of executionFields('APPLY_FINDINGS')) {
      if (['automaticCheckRound','findingsCycle','commands'].includes(key)) continue;
      presentRendered(payload[key],label);
    }
  } catch (error) { return applySemanticError(error.message); }
  if (transport==='native' && payload.automaticCheckRound!==`${request.round}/3`) return applySemanticError('native round differs from request');
  if (!same(payload.commands,work.commands)) return applySemanticError('response commands differ from observed checks');
  if (payload.status==='TESTS_NOT_APPLICABLE') return applySemanticError('TESTS_NOT_APPLICABLE contradicts reviewed recipe');
  if (payload.status==='TESTS_FAIL' && !work.commands.some(item=>item.exit!==0)) return applySemanticError('TESTS_FAIL lacks observed failure');
  if (payload.status==='TESTS_FAIL' && !nonPlaceholderValue(payload.failures)) return applySemanticError('TESTS_FAIL lacks objective Failures');
  if (payload.status==='BLOCKED' && !nonPlaceholderValue(payload.blockers)) return applySemanticError('BLOCKED lacks objective Blockers');
  const expected=request.base.openFindings.map(item=>item.id);
  let verified,unsupported;
  try { verified=findingIds(payload.findingsVerified,'Findings verified'); unsupported=findingIds(payload.unsupportedActiveFindings,'Unsupported active findings'); }
  catch (error) { return applySemanticError(error.message); }
  if (verified.some(item=>!expected.includes(item)) || !same(unsupported,expected.filter(item=>!verified.includes(item))))
    return applySemanticError('finding selection/unsupported complement differs');
  for (const label of ['head','discoverySources','discoveryActions','verificationTypesConsidered','selectedChecks',
    'selectionRationale','coverage','evidenceOrFailureSummary','affectedFilesOrBehaviors','persistenceSummary']) {
    if (!nonPlaceholderValue(payload[label])) return applySemanticError(`${label} lacks persisted objective value`);
  }
  if (request.round>1 && (!nonPlaceholderValue(payload.correctionsCovered) || !nonPlaceholderValue(payload.selectionRationale)))
    return applySemanticError('later findings round lacks correction rationale');
  if (work.scopePaths.length===0 && (!nonPlaceholderValue(payload.filelessReason)
    || !nonPlaceholderValue(payload.correctionsCovered)))
    return applySemanticError('fileless findings require objective raw reason and correction');
  try {
    assertRunnerVerdictConsistency('APPLY_FINDINGS',payload.status,work.commands);
    assertExecutionResultScope('APPLY_FINDINGS',payload,work.scopePaths.length);
  } catch (error) { return error instanceof RunnerSemanticResultError || recoverableRunnerResultDiagnostic(error)!==null
    ? error : applySemanticError(error.message); }
  return null;
}
function nonPlaceholderValue(value) {
  if (typeof value!=='string' || !value.trim() || /^(?:none|n\/a|pending|not_available)$/iu.test(value.trim())) return false;
  try {
    const rendered=serializeMarkdownScalar('value',value,true).trim();
    return rendered.length>0 && !/<[^>\n]+>/u.test(rendered.replace(/json:"(?:\\.|[^"\\])*"/gu,'json:""'));
  } catch { return false; }
}
function applyOrigin(owner,transport,info) {
  const {ownershipToken,...identity}=owner;
  return {...identity,transport,dispatchId:info.dispatchId,runnerId:info.runnerId};
}
function deriveApplyCycle({context,authority:approvedAuthority,owner:expectedOwner,rounds,baseFacts,store,post=null,
  allowPrefix=false,offset=0}) {
  dense(rounds,'findings rounds',1,3);
  rounds.forEach((cap,index)=>plain(cap,`round ${index+1} capture`));
  const transport=rounds[0].transport;
  if (!['native','managed'].includes(transport)) fail('UNSUPPORTED_FORMAT','findings transport');
  const checks=[]; let rejection=null; let lastStatus=null; let previousCap=null; let previousWork=null;
  let lastObserved=null,lastScope=null;
  let previousScope=[]; let firstWork=null; let dispatchId=null; const runners=new Set();
  let productDrift=null;
  const receipts=[]; const managed=[]; const witnesses=new Set(baseFacts.removalPaths??[]);
  for (const [index,cap] of rounds.entries()) {
    const round=index+1;
    verifyCapturedInvocation('current-findings',cap,undefined,undefined,undefined,round,transport);
    const request=jsonBytes(cap.applyRequest,`round ${round} findings request`).value;
    applyRequestShape(request);
    const globalRound=offset+round;
    if(request.round!==globalRound || (offset>0?request.format!=='stnl-current-findings-request-v2'
      || request.invocation!==round:request.format!=='stnl-current-findings-request-v1'))
      mismatch(`round ${round}: global/local invocation differs`);
    if(post) verifyPostAdmission({context,snapshotBytes:post.snapshotBytes,owner:request.owner,
      capture:cap,admissionRef:index===rounds.length-1?post.admissionRef??null:null});
    authority(request.authority,context,request.owner,'APPLY_FINDINGS');
    equal(request.authority,approvedAuthority,'EVIDENCE_STALE',`round ${round} authority`);
    if (expectedOwner) equal(request.owner,expectedOwner,'OWNER_MISMATCH',`round ${round} owner`);
    const origin=transport==='native'?jsonBytes(cap.origin,`round ${round} origin`).value:null;
    const witness=origin?.productDrift??null;
    if(witness!==null) {
      closed(witness,['class','episodeId','sourceOperationAttemptId','sourceRound',
        'sourceCaptureSha256','expectedWorkSha256','used'],'product drift witness');
      if(offset || witness.class!=='product-drift' || witness.used!==1
        || witness.sourceOperationAttemptId!==request.owner.operationAttemptId
        || !Number.isSafeInteger(witness.sourceRound) || witness.sourceRound<1
        || witness.sourceRound>=round || witness.sourceRound>=3)
        mismatch(`round ${round}: product drift owner or source`);
      token(witness.episodeId,HASH,'product drift episode');
      token(witness.sourceCaptureSha256,HASH,'product drift source capture');
      token(witness.expectedWorkSha256,HASH,'product drift expected work');
      if(witness.sourceCaptureSha256!==findingsRoundCaptureSha256(rounds[witness.sourceRound-1])
        || witness.episodeId!==raw(utf8(JSON.stringify({class:'product-drift',
          owner:request.owner.operationAttemptId,sourceRound:witness.sourceRound,
          sourceCaptureSha256:witness.sourceCaptureSha256,
          expectedWorkSha256:witness.expectedWorkSha256})+'\n')))
        stale(`round ${round}: product drift source differs`);
      if(!productDrift && witness.sourceRound!==round-1)
        mismatch(`round ${round}: product drift witness did not begin at its recheck`);
      if(productDrift && !same(productDrift,witness)) mismatch('product drift witness changed');
      productDrift=witness;
    } else if(productDrift) mismatch('product drift witness disappeared');
    if(round>1 && lastStatus!=='TESTS_FAIL'
      && !(lastStatus==='TESTS_PASS' && witness!==null
        && witness.sourceRound===round-1 && productDrift===witness))
      invalid(`round ${round}: prior round did not fail`);
    if (cap.transport!==transport) mismatch(`round ${round}: request/transport differs`);
    const expectedBase={evidenceSha256:baseFacts.sha256,counters:baseFacts.counters,
      validation:baseFacts.validation,openFindings:baseFacts.openFindings,priorScopePaths:baseFacts.priorScopePaths};
    equal(request.base,expectedBase,'EVIDENCE_STALE',`round ${round} findings base`);
    if (round>1) {
      equal(request.owner,jsonBytes(rounds[0].applyRequest,'first findings request').value.owner,'OWNER_MISMATCH',`round ${round} owner continuity`);
      equal(request.previousCheck,{id:jsonBytes(previousCap.applyRequest,'previous findings request').value.checkId,
        roundCaptureSha256:findingsRoundCaptureSha256(previousCap)},'EVIDENCE_STALE',`round ${round} previous check link`);
    }
    const rawText=textBytes(cap.rawResponse,`round ${round} rawResponse`).text;
    const receipt=jsonBytes(cap.receipt,`round ${round} receipt`).value;
    plain(receipt,`round ${round} receipt`);
    if (receipt.attempt!==round) mismatch(`round ${round}: receipt attempt`);
    const info=verifyWorkObservation('initial-implementation',{context,delivery:approvedAuthority.delivery,slice:request.owner.slice});
    const transportInfo=verifyCapturedInvocation('current-findings',cap,receipt,rawText,
      {context,authority:approvedAuthority,owner:request.owner},round,info.resolved);
    if (dispatchId!==null && dispatchId!==transportInfo.dispatchId) mismatch(`round ${round}: dispatch changed`);
    dispatchId=transportInfo.dispatchId;
    if (runners.has(transportInfo.runnerId)) mismatch(`round ${round}: runner replay`);
    runners.add(transportInfo.runnerId);
    if (transport==='managed') managed.push(transportInfo);
    receipts.push(receipt);
    const nativeJudgment=origin?.responseVariant===NATIVE_JUDGMENT_VARIANT;
    const workInput={context,authority:approvedAuthority,owner:request.owner,round,
      capture:cap,receipt,priorScopePaths:baseFacts.priorScopePaths,previousScopePaths:previousScope,
      previousAfter:previousWork?.observed?.after??null,witnessedRemovals:[...witnesses].sort(ordinal),
      status:receipt.semanticResponseStatus};
    const preverifiedWork=nativeJudgment?verifyAuxiliaryWork('current-findings',workInput):null;
    const semanticText=nativeJudgment?projectNativeJudgment({origin,observation:preverifiedWork.observed,
      requestBytes:cap.applyRequest,agentId:transportInfo.runnerId,rawText,operation:'APPLY_FINDINGS'}):rawText;
    const envelope=applyEnvelope(semanticText,cap.applyRequest,receipt,transport,globalRound);
    const work=preverifiedWork??verifyAuxiliaryWork('current-findings',{...workInput,
      status:envelope.payload?.status??receipt.semanticResponseStatus});
    if(witness?.sourceRound===round-1) {
      if(!previousWork || previousWork.payload.status!=='TESTS_PASS'
        || !request.previousCheck
        || request.previousCheck.roundCaptureSha256!==witness.sourceCaptureSha256
        || !work.observed
        || currentEvidenceValueSha256(work.observed.before)!==witness.expectedWorkSha256
        || same(previousWork.observed.after,work.observed.before))
        stale(`round ${round}: product drift does not bind the new observation`);
      const info=work.info;
      const old=new Map(previousWork.observed.after.entries.map(item=>[item.path,item]));
      const next=new Map(work.observed.before.entries.map(item=>[item.path,item]));
      let changed=false;
      for(const name of new Set([...old.keys(),...next.keys()])) {
        const prior=old.get(name),current=next.get(name);
        if(same(prior??null,current??null)) continue;
        if(prior?.kind==='directory' || current?.kind==='directory') {
          if(prior?.kind!=='directory' || current?.kind!=='directory'
            || !same(prior.children,current.children)) stale(`round ${round}: product drift structure`);
        } else if(prior?.kind!=='file' || current?.kind!=='file'
          || [...info.inputs,...info.refs].some(item=>item.path===name)
          || !info.areas.some(area=>area.path===name
            || area.kind==='directory' && name.startsWith(`${area.path}/`)))
          stale(`round ${round}: product drift is not an existing private output`);
        else changed=true;
      }
      if(!changed) stale(`round ${round}: product drift has no private leaf`);
      if(post) {
        const snapshot=jsonBytes(post.snapshotBytes,'approved-preparation.json').value;
        for(const delivery of snapshot.normativeProjection.deliveries.filter(item=>
          item.deliveryId!==request.owner.deliveryId)) {
          const other=verifyWorkObservation('initial-implementation',{
            context,delivery,slice:delivery.slice});
          for(const name of new Set([...old.keys(),...next.keys()])) {
            if(same(old.get(name)??null,next.get(name)??null)) continue;
            if([...other.areas,...other.inputs,...other.refs].some(claim=>claim.path===name
              || claim.kind==='directory' && name.startsWith(`${claim.path}/`)))
              stale(`round ${round}: product drift intersects another delivery`);
          }
        }
      }
    }
    if(work.observed) {lastObserved=work.observed.after;lastScope=work.scopePaths;}
    if (round===1) {
      equal(work.before,baseFacts.testedWork,'EVIDENCE_STALE','findings baseline differs from formal product');
      firstWork=work.before;
    }
    if (work.scopePaths) equal(request.scopePaths,work.scopePaths,'EVIDENCE_STALE',`round ${round} derived scope`);
    if (receipt.status==='RUNNER_RESPONSE_CAPTURED' && (!work.observed || !work.entries)) incomplete(`round ${round}: accepted findings lack observation/testedState`);
    if (receipt.status==='RUNNER_RESULT_BLOCKED' && !envelope.error) uncertain(`round ${round}: schema rejection has valid envelope/payload`);
    let semanticError=envelope.error??null;
    if (!semanticError && work.observed && work.entries) semanticError=applySemanticGate(envelope.payload,work,request,transport);
    if (semanticError) {
      if (index!==rounds.length-1) invalid(`round ${round}: rejected result cannot precede a round`);
      const diagnostic=recoverableRunnerResultDiagnostic(semanticError);
      if (diagnostic===null) invalid(`round ${round}: semantic rejection diagnostic unavailable`);
      rejection={kind:'rejection',operationAttemptId:request.owner.operationAttemptId,
        origin:applyOrigin(request.owner,transport,transportInfo),diagnostic,
        consumedInvocations:globalRound,round:globalRound,sources:packCaptureSources('current-findings',cap,store)};
      lastStatus='rejected';
    } else {
      const payload=envelope.payload;
      for (const name of [...witnesses]) if (work.observed.after.entries.some(entry=>entry.path===name && entry.kind!=='absent')) witnesses.delete(name);
      for (const name of work.removed) witnesses.add(name);
      const record={kind:'findings-check',recordFormat:'stnl-task-record-v2',id:request.checkId,
        origin:applyOrigin(request.owner,transport,transportInfo),
        contract:{delivery:approvedAuthority.delivery,context:approvedAuthority.context,terminal:null,recipe:approvedAuthority.delivery.verificationRecipe},
        recordUtf8:findingsRecord(request,payload,work,context,
          previousWork?.payload?.failures??(offset>0?baseFacts.priorFailure:null),firstWork),
        testedWork:work.observed.after,sources:packCaptureSources('current-findings',cap,store)};
      checks.push(record);
      previousWork={...work,payload}; previousScope=work.scopePaths;
      lastStatus=payload.status;
    }
    previousCap=cap;
  }
  if (transport==='managed') {
    const {supervisor,latest,active}=managed.at(-1);
    if (supervisor.requestsHandled!==rounds.length
      || supervisor.capturedReceipts!==receipts.filter(item=>item.status==='RUNNER_RESPONSE_CAPTURED' && item.exitCode===0).length
      || !same(latest.receipt,receipts.at(-1)) || latest.sequence!==active.sequence
      || managed.some(item=>!same(item.supervisor,supervisor) || !same(item.latest,latest))) uncertain('managed findings close does not cover cycle');
  }
  if (!allowPrefix && !rejection && !['TESTS_PASS','BLOCKED'].includes(lastStatus)
    && !(lastStatus==='TESTS_FAIL' && offset+rounds.length===3)) incomplete('findings cycle is an incomplete FAIL prefix');
  const owner=jsonBytes(rounds[0].applyRequest,'first findings request').value.owner;
  return {checks,rejection,owner,transport,status:lastStatus,auxiliaryStatus:previousWork?.payload.status??null,
    lastWork:lastObserved,lastScope:lastScope??previousScope,witnesses:[...witnesses].sort(ordinal),
    filelessReason:previousWork?.payload.filelessReason??null,
    consumedInvocations:offset+rounds.length};
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
  equal(record,{...derived.recordDraft,sources:record.sources},'EVIDENCE_STALE',`formal record ${record.id}`);
  if (record.id!==derived.request.attemptId) invalid('formal record/request ID');
  const {recordDraft,...verified}=derived;
  return {...verified,record,cap};
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
function baseCounters(initialCount,request,newCount,findingsCount=request.base.counters.findingsChecks) {
  if (request.base.counters.implementationChecks!==initialCount || request.base.counters.findingsChecks!==findingsCount) invalid('formal request check counters');
  const expected={...request.base.counters,validationAttempts:request.base.counters.validationAttempts+1,
    findings:request.base.counters.findings+newCount};
  counters(expected,'derived counters');
  return expected;
}
function historicalFormal(record,map,context,approvedAuthority,post=null) {
  const request=requestForRecord(record,map);
  requestShape(request);
  if(post) {
    if(!['stnl-current-validation-request-v3','stnl-current-validation-request-v4'].includes(request.format))
      invalid('converted formal requires v3/v4 request');
    const predecessor={evidence:{sha256:request.base.evidenceSha256},counters:request.base.counters,
      baseline:request.base.baseline,validation:request.base.validation,lastDiagnostic:request.base.lastDiagnostic};
    const expected=postBase(post.snapshotBytes,predecessor,request.base.priorScopePaths,
      request.base.openFindings,request.base.auxiliary??null);
    const cap=restoreCaptureSources('current-validation',record,map);
    const derived=postCaptureProof({context,snapshotBytes:post.snapshotBytes,current:post.current,
      capture:cap,expectedBase:expected});
    equal(record,{...derived.recordDraft,sources:record.sources},'EVIDENCE_STALE',`formal record ${record.id}`);
    return {...derived,record,cap};
  }
  const literalAbsent=new Set(record.testedWork.entries.filter(item=>item.kind==='absent').map(item=>item.path));
  return verifyRecord(record,map,context,approvedAuthority,literalAbsent,request.scope.filelessReason);
}
function recordRefs(bundle,map,records) { return referencedObjects(records,map); }
function applyRoundsFromRecords(records,map) {
  return records.map(record=>restoreCaptureSources('current-findings',record,map));
}
function literalRemovalPaths(rounds,manifest,context) {
  const claimed=new Set(rounds.flatMap(cap=>{
    const receipt=jsonBytes(cap.receipt,'historical removal receipt').value;
    plain(receipt,'historical removal receipt');
    if (receipt.testedState!==null) {
      closed(receipt.testedState,['workspace','sourceTaskPath','entries'],'historical testedState');
      dense(receipt.testedState.entries,'historical testedState entries');
      for (const entry of receipt.testedState.entries) closed(entry,['path','value'],'historical testedState entry');
    }
    return (receipt.testedState?.entries??[]).filter(item=>item.value==='REMOVED').map(item=>
      path.relative(context.productRoot,resolveLogicalProductClaim(context,`tasks/${receipt.slice}.md`,item.path)).split(path.sep).join('/'));
  }));
  return absentPaths(manifest).filter(name=>claimed.has(name));
}
function cycleBaseFromLiteral(rounds,context,approvedAuthority) {
  const request=jsonBytes(rounds[0].applyRequest,'retained findings request').value;
  applyRequestShape(request);
  const baseline=jsonBytes(rounds[0].baselineCapture,'retained findings baseline').value;
  plain(baseline,'retained findings baseline');
  verifyWorkObservation('current-validation',{observedWork:baseline.manifest});
  return {sha256:request.base.evidenceSha256,counters:request.base.counters,
    validation:request.base.validation,openFindings:request.base.openFindings,
    priorScopePaths:request.base.priorScopePaths,testedWork:baseline.manifest,
    removalPaths:literalRemovalPaths(rounds,baseline.manifest,context)};
}
function boundedCounters(witness, ceiling, label) {
  counters(witness,label);
  for (const key of Object.keys(ceiling)) if (witness[key]>ceiling[key]) invalid(`${label}: ${key} exceeds current high-water mark`);
}
function formalCounters(derived) {
  return baseCounters(derived.request.base.counters.implementationChecks,derived.request,derived.response.newFindings.length);
}
function absentPaths(manifest) { return manifest.entries.filter(item=>item.kind==='absent').map(item=>item.path); }
function liveRemovalProofs(records,map) {
  const proofs=new Map();
  for (const record of records) {
    const profile=record.kind==='implementation-check'?'initial-implementation':'current-findings';
    const cap=restoreCaptureSources(profile,record,map);
    const before=jsonBytes(cap.baselineCapture,'removal baseline').value.manifest;
    for (const [name] of proofs) if (![before,record.testedWork].every(work=>
      work.entries.some(entry=>entry.path===name && entry.kind==='absent'))) proofs.delete(name);
    for (const blob of cap.removalProofs) proofs.set(jsonBytes(blob,'verified removal').value.path,records);
  }
  return proofs;
}
function removalCycleOrder(left,right) {
  return (left[0].kind==='implementation-check'?0:1)-(right[0].kind==='implementation-check'?0:1)
    || Number(left.at(-1).id.split('-').at(-1))-Number(right.at(-1).id.split('-').at(-1));
}
function removalProofIndex(groups,map) {
  const proofs=new Map();
  for (const records of [...groups].sort(removalCycleOrder))
    for (const [name] of liveRemovalProofs(records,map)) proofs.set(name,records);
  return proofs;
}
function removedTuples(record,map,context) {
  if (!record) return [];
  const receipt=jsonBytes(map.get(record.sources.receipt),'removal demand receipt').value;
  return (receipt.testedState?.entries??[]).filter(item=>item.value==='REMOVED').map(item=>
    path.relative(context.productRoot,resolveLogicalProductClaim(context,`tasks/${record.origin.slice}.md`,item.path)).split(path.sep).join('/'));
}
function inspectRetainedRemovalCycles(bundle,map,context,approvedAuthority,ceiling) {
  const supports=bundle.support.filter(item=>['implementation-check','findings-check'].includes(item.kind));
  const groups=new Map();
  for (const item of supports) {
    const key=`${item.kind}:${item.origin.operationAttemptId}`;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(item);
  }
  let previousCounters=null;
  for (const records of [...groups.values()].sort(removalCycleOrder)) {
    if (records[0].kind==='implementation-check') {
      const originOwner=initialOwner({...bundle,implementation:records},map);
      const isolated={...bundle,implementation:records,findingsChecks:[],validation:null,openFindings:[],openDivergences:[],support:[],objects:recordRefs(bundle,map,records)};
      const verified=validateInitialImplementationEvidence({context,authority:approvedAuthority,owner:originOwner,currentEvidence:null,
        counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},bundleBytes:encode(isolated)});
      boundedCounters(verified.counters,ceiling,'retained Initial counters');
      previousCounters=verified.counters;
    } else {
      const rounds=applyRoundsFromRecords(records,map);
      const base=cycleBaseFromLiteral(rounds,context,approvedAuthority);
      const derived=deriveApplyCycle({context,authority:approvedAuthority,rounds,baseFacts:base,store:closeEvidenceObjects()});
      if (derived.rejection || !same(derived.checks,records)) stale('retained findings removal cycle differs');
      if (previousCounters) boundedCounters(previousCounters,base.counters,'retained cycle monotonic counters');
      previousCounters={...base.counters,findingsChecks:base.counters.findingsChecks+records.length};
      boundedCounters(previousCounters,ceiling,'retained APPLY counters');
      if (base.counters.validationAttempts>=ceiling.validationAttempts) invalid('retained APPLY must precede current admission');
    }
  }
  return {groups,proofs:removalProofIndex(groups.values(),map)};
}
// Only the latest operational state demands removal bytes. Earlier captured
// absent tuples are checked as historical literals, then any current demand is
// discharged against live proofs whose path never reappeared in retained states.
function currentRemovalSupport(bundle,map,context,cycle,admission,latest,retained) {
  const currentRecords=bundle.findingsChecks;
  const latestRecord=latest.record.id===admission.record.id ? currentRecords.at(-1)??admission.record : latest.record;
  const demand=removedTuples(latestRecord,map,context);
  const own=liveRemovalProofs(currentRecords,map);
  const demandedGroups=new Set(),proven=new Set();
  const keptFormals=[admission,latest,...bundle.support.filter(item=>item.kind==='validation')
    .map(record=>({record,request:requestForRecord(record,map)}))];
  for (const name of demand) {
    if (own.has(name)) {
      // A later formal may recreate a path, invalidating the earlier proof.
      const recreated=keptFormals.some(item=>Number(item.record.id.slice(8))>Number(admission.record.id.slice(8))
        && item.record.testedWork.entries.some(entry=>entry.path===name && entry.kind!=='absent'));
      if (!recreated) {proven.add(name);continue;}
    }
    const records=retained.proofs.get(name);
    if (!records) incomplete(`current REMOVED lacks witness ${name}`);
    const witnessCheck=records[0].kind==='implementation-check' ? 0 : Number(records.at(-1).id.split('-').at(-1));
    const laterCycles=[...retained.groups.values()].filter(group=>removalCycleOrder(group,records)>0);
    const states=[admission.record.testedWork,...currentRecords.map(record=>record.testedWork),
      ...laterCycles.flatMap(group=>group.flatMap(record=>[record.testedWork,
        jsonBytes(restoreCaptureSources(record.kind==='implementation-check'?'initial-implementation':'current-findings',record,map).baselineCapture,'later witness baseline').value.manifest])),
      ...keptFormals.filter(item=>item.request.base.counters.findingsChecks>=witnessCheck).map(item=>item.record.testedWork)];
    if (states.some(work=>work.entries.some(entry=>entry.path===name && entry.kind!=='absent')))
      incomplete(`current REMOVED has recreated witness ${name}`);
    demandedGroups.add(records);proven.add(name);
  }
  for (const [key,records] of retained.groups) if (!demandedGroups.has(records)) invalid(`undemanded removal cycle retained ${key}`);
  return proven;
}
function inspectFindings(original,bundle,context,approvedAuthority,declaredCounters,observedWork,post=null,currentAuthoritySha256=null) {
  if (bundle.openDivergences.length || bundle.currentAuthoritySha256!==(currentAuthoritySha256??projectedDelivery(approvedAuthority.delivery))) invalid('findings bundle authority/divergence');
  if (bundle.objects.reduce((total,item)=>total+Buffer.from(item.bytesBase64,'base64').length,0)>128*1024*1024)
    incomplete('findings retained capture exceeds 128 MiB');
  const map=sourceMap(bundle);
  const rank={'implementation-check':0,'findings-check':1,validation:2,rejection:3};
  let previousRank=-1,previousId=0;
  for (const item of bundle.support) {
    if (!Object.hasOwn(rank,item.kind)) invalid('unsupported findings support kind');
    const currentRank=rank[item.kind],number=item.kind==='rejection'?0:Number(item.id.split('-').at(-1));
    if (currentRank<previousRank || (currentRank===previousRank && (item.kind==='rejection' || number<=previousId))) invalid('findings support order');
    previousRank=currentRank;previousId=number;
  }
  const rejections=bundle.support.filter(item=>item.kind==='rejection');
  if (rejections.length>1 || rejections.some(item=>!['APPLY_FINDINGS','VALIDATE_SLICE'].includes(item.origin.operation))) invalid('findings rejection count/operation');
  const applyRejection=rejections.find(item=>item.origin.operation==='APPLY_FINDINGS');
  const formalRejection=rejections.find(item=>item.origin.operation==='VALIDATE_SLICE');
  const current=[...bundle.findingsChecks,...(applyRejection?[applyRejection]:[])];
  if (!current.length) invalid('findings cycle required');
  if (!bundle.validation || bundle.implementation.length) invalid('findings unsupported records');
  const rounds=applyRoundsFromRecords(current,map);
  const first=jsonBytes(rounds[0].applyRequest,'current findings request').value;
  applyRequestShape(first);
  const formalRecords=[...bundle.support.filter(item=>item.kind==='validation'),bundle.validation]
    .sort((a,b)=>formalRecordNumber(a)-formalRecordNumber(b));
  const formals=new Map(formalRecords.map(record=>[record.id,historicalFormal(record,map,context,approvedAuthority,post)]));
  const admission=formals.get(first.base.validation.id);
  if (!admission) incomplete('findings admission formal absent');
  if (admission.payload.status!=='NEEDS_FIX') invalid('findings admission formal is not NEEDS_FIX');
  const admissionCounters=formalCounters(admission);
  const retained=inspectRetainedRemovalCycles(bundle,map,context,approvedAuthority,admissionCounters);
  const facts={sha256:first.base.evidenceSha256,counters:admissionCounters,
    validation:{id:admission.record.id,recordSha256:raw(encode(formalRecords.find(item=>item.id===admission.record.id)))},
    openFindings:admission.open,priorScopePaths:admission.request.scope.paths,
    testedWork:admission.record.testedWork,removalPaths:literalRemovalPaths(rounds,admission.record.testedWork,context)};
  const cycle=deriveApplyCycle({context,authority:approvedAuthority,rounds,baseFacts:facts,store:closeEvidenceObjects(),post});
  cycle.admissionId=admission.record.id;cycle.selectedFindings=admission.open;
  equal(bundle.findingsChecks,cycle.checks,'EVIDENCE_STALE','current findings records');
  equal(applyRejection??null,cycle.rejection,'EVIDENCE_STALE','current findings rejection');
  const afterCounters={...admissionCounters,findingsChecks:admissionCounters.findingsChecks+cycle.checks.length};
  counters(afterCounters,'findings counters');
  const auxiliary={kind:'findings',operationAttemptId:cycle.owner.operationAttemptId,
    cycle:admission.record.id,firstCheckId:cycle.checks[0]?.id,lastCheckId:cycle.checks.at(-1)?.id,
    recordsSha256:raw(encode(cycle.checks))};
  let latest=formals.get(bundle.validation.id);
  if (formalRecordNumber(latest.record)<formalRecordNumber(admission.record)) invalid('formal precedes findings admission');
  const later=latest!==admission;
  const checkFormalLink=(derived,predecessor=null)=>{
    const request=derived.request;
    if (cycle.rejection || !['TESTS_PASS','TESTS_FAIL'].includes(cycle.status) || !cycle.checks.length) invalid('formal cannot follow blocked/rejected findings');
    if (request.format!==(post?'stnl-current-validation-request-v4':'stnl-current-validation-request-v2'))
      invalid(post?'formal after findings requires request v4':'formal after findings requires request v2');
    equal(request.base.auxiliary,auxiliary,'EVIDENCE_STALE','later formal auxiliary');
    boundedCounters(afterCounters,request.base.counters,'later formal counters');
    for (const key of ['implementationChecks','findingsChecks']) if (request.base.counters[key]!==afterCounters[key]) invalid('later formal check counters');
    if (request.base.counters.validationAttempts<admissionCounters.validationAttempts) invalid('formal precedes findings cycle');
    if (predecessor) {
      equal(request.base.counters,predecessor.counters,'INVALID_CURRENT_IMAGE','consecutive formal counters');
      equal(request.base.openFindings,predecessor.open,'INVALID_CURRENT_IMAGE','consecutive formal findings');
      equal(request.base.priorScopePaths,predecessor.scope,'EVIDENCE_STALE','consecutive formal scope');
    }
    if (!request.scope.paths.length && request.scope.filelessReason!==cycle.filelessReason) stale('formal fileless reason differs from current findings');
  };
  // Gaps are valid. Check exact succession only where both sides of the
  // operational transition remain available, never demand a pruned predecessor.
  let preceding=null;
  for (const record of formalRecords) {
    const derived=formals.get(record.id),out=formalCounters(derived);
    boundedCounters(out,declaredCounters,'retained formal counters');
    if (preceding) boundedCounters(formalCounters(preceding),derived.request.base.counters,'retained formal monotonic counters');
    if (formalRecordNumber(record)>formalRecordNumber(admission.record)) {
      let predecessor=null;
      if (derived.request.base.counters.validationAttempts===admissionCounters.validationAttempts)
        predecessor={counters:afterCounters,open:admission.open,scope:cycle.lastScope};
      else if (preceding && formalRecordNumber(preceding.record)>formalRecordNumber(admission.record)
        && formalRecordNumber(preceding.record)+1===formalRecordNumber(record))
        predecessor={counters:formalCounters(preceding),open:preceding.open,scope:preceding.request.scope.paths};
      checkFormalLink(derived,predecessor);
    }
    preceding=derived;
  }
  const priorFiles=currentRemovalSupport(bundle,map,context,cycle,admission,latest,retained);
  let rejected=cycle.rejection ? {...cycle.rejection,
    request:jsonBytes(rounds.at(-1).applyRequest,'rejected findings request').value,cap:rounds.at(-1)} : null;
  let expectedCounters=later?formalCounters(latest):afterCounters;
  if (formalRejection) {
    const cap=restoreCaptureSources('current-validation',formalRejection,map);
    const request=jsonBytes(cap.validationRequest,'rejected formal request').value;
    const derived=deriveCapture({context,authority:approvedAuthority,capture:cap,priorFiles,filelessReason:cycle.filelessReason});
    checkFormalLink(derived,{counters:expectedCounters,open:latest.open,
      scope:later?latest.request.scope.paths:cycle.lastScope});
    if (!derived.rejection) invalid('later formal rejection has accepted response');
    equal(formalRejection.origin,derived.origin,'EVIDENCE_STALE','later formal rejection origin');
    if (formalRejection.operationAttemptId!==request.owner.operationAttemptId || formalRejection.diagnostic!==derived.rejection
      || formalRejection.round!==1 || formalRejection.consumedInvocations!==1) stale('later formal rejection detail');
    rejected={...derived,cap};
  }
  const demandedFindings=[...admission.open,...(later?latest.all:[])];
  const demandedIds=new Set([admission.record.id,bundle.validation.id,...demandedFindings.map(item=>item.originAttempt)]);
  for (const item of demandedFindings) {
    const origin=formals.get(item.originAttempt);
    if (!origin) incomplete(`finding ${item.id} origin absent`);
    if (formalRecordNumber(origin.record)>formalRecordNumber(latest.record)) invalid(`finding ${item.id} has future origin`);
    sourceFinding(origin,item);
  }
  equal(formalRecords.map(item=>item.id).sort(ordinal),[...demandedIds].sort(ordinal),'INVALID_CURRENT_IMAGE','retained formal roots');
  equal(bundle.openFindings,latest.open,'INVALID_CURRENT_IMAGE','current findings index');
  equal(declaredCounters,expectedCounters,'INVALID_CURRENT_IMAGE','findings current counters');
  const status=latest.payload.status;
  const state=rejected?'uncertain':!later?'revalidation-required'
    :status==='PASS' && !bundle.openFindings.some(item=>item.severity==='blocking') && same(latest.record.testedWork,observedWork)
      ? 'current':'revalidation-required';
  return {bundle,original,map,initial:null,latest,rejected,origins:formals,priorFiles,cycle,
    counters:structuredClone(declaredCounters),outcome:rejected?'rejected':'recorded',formalStatus:status,validation:state};
}
function inspect(bundleBytes,context,approvedAuthority,declaredCounters,observedWork,allowInitial=false,currentAuthoritySha256=null) {
  const original=copyBytes(bundleBytes,'bundleBytes');
  const bundle=jsonBytes(original,'bundleBytes').value;
  validateCurrentEvidence(bundle);
  if ([...bundle.implementation,...bundle.findingsChecks,...bundle.support,...(bundle.validation?[bundle.validation]:[])]
    .some(record=>record.recordFormat==='stnl-task-record-v1-imported')) fail('MIGRATION_REQUIRED','imported evidence requires conversion');
  verifyWorkObservation('current-validation',{observedWork});
  if (bundle.findingsChecks.length || bundle.support.some(item=>item.kind==='rejection' && item.origin.operation==='APPLY_FINDINGS'))
    return inspectFindings(original,bundle,context,approvedAuthority,declaredCounters,observedWork,null,currentAuthoritySha256);
  if (bundle.findingsChecks.length || bundle.openDivergences.length || bundle.currentAuthoritySha256!==(currentAuthoritySha256??projectedDelivery(approvedAuthority.delivery))) invalid('bundle formal authority/unsupported records');
  if (bundle.implementation.some(item => item.recordFormat==='stnl-task-record-v1-imported')) fail('MIGRATION_REQUIRED','imported implementation record');
  if (bundle.implementation.some(item => item.recordFormat!=='stnl-task-record-v2' || item.contract.terminal!==null)) invalid('implementation record format/terminal');
  const map=sourceMap(bundle);
  const initial=verifyInitial(bundle,context,approvedAuthority,map);
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
    const derived=verifyRecord(item,map,context,approvedAuthority,priorFiles,initial.filelessReason);
    if (derived.request.format!=='stnl-current-validation-request-v1') invalid('formal v2 requires findings cycle');
    origins.set(item.id,derived);
  }
  let latest=null;
  if (bundle.validation!==null) {
    if (formalRecordNumber(bundle.validation)<=previousNumber) invalid('latest formal attempt order');
    latest=verifyRecord(bundle.validation,map,context,approvedAuthority,priorFiles,initial.filelessReason);
    if (latest.request.format!=='stnl-current-validation-request-v1') invalid('formal v2 requires findings cycle');
    origins.set(bundle.validation.id,latest);
  }
  let rejected=null;
  if (rejects.length) rejected=verifyRejection(rejects[0],map,context,approvedAuthority,priorFiles,initial.filelessReason);
  if (rejected?.request.format!=='stnl-current-validation-request-v1' && rejected) invalid('formal v2 rejection requires findings cycle');
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
function formalOrigins(records,all,latestId,requiredIds=[]) {
  const ids=new Set([...all.map(item => item.originAttempt),...requiredIds].filter(item => item!==latestId));
  return records.filter(record => ids.has(record.id)).sort((a,b)=>formalRecordNumber(a)-formalRecordNumber(b));
}
export function composeCurrentValidationEvidence(input) {
  if (input && typeof input==='object' && Object.getOwnPropertyDescriptor(input,'imported')?.value===true) fail('MIGRATION_REQUIRED','imported formal evidence requires conversion');
  closed(input,['context','authority','owner','previous','capture'],'formal composition input');
  plain(input.capture,'capture');
  verifyCapturedInvocation('current-validation',input.capture);
  authority(input.authority,input.context,input.owner);
  closed(input.previous,['bundleBytes','counters'],'previous');
  counters(input.previous.counters,'previous.counters');
  const previousBytes=copyBytes(input.previous.bundleBytes,'previous.bundleBytes');
  const request=jsonBytes(input.capture?.validationRequest,'capture.validationRequest').value;
  if(request?.format==='stnl-current-validation-request-v3')
    fail('UNSUPPORTED_FORMAT','post-conversion request is outside Initial composition');
  requestShape(request);
  equal(request.owner,input.owner,'OWNER_MISMATCH','request owner');
  const parsedPrevious=jsonBytes(previousBytes,'previous.bundleBytes').value;
  const passiveWork=parsedPrevious.validation?.testedWork
    ?? parsedPrevious.findingsChecks?.at(-1)?.testedWork ?? parsedPrevious.implementation?.at(-1)?.testedWork;
  const base=inspect(previousBytes,input.context,input.authority,input.previous.counters,passiveWork,true);
  const last=base.rejected ?? (base.cycle && base.bundle.validation.id===base.cycle.admissionId ? null : base.latest);
  if (last?.request.owner.operationAttemptId===input.owner.operationAttemptId) {
    equal(last.request.owner,input.owner,'OWNER_MISMATCH','replay owner');
    if (!exactCapture(last.cap,input.capture)) mismatch('same owner has different captured sources');
    const result=validateCurrentValidationEvidence({context:input.context,authority:input.authority,
      bundleBytes:previousBytes,counters:input.previous.counters,observedWork:passiveWork});
    return {...result,replayed:true,consumedInvocations:1};
  }
  if ([...base.origins.values()].some(item => item.request.owner.operationAttemptId===input.owner.operationAttemptId)
    || request.base.counters.validationAttempts!==input.previous.counters.validationAttempts
    || request.base.evidenceSha256!==raw(previousBytes)) fail('STALE_BASE','validation request does not address latest base');
  if (base.rejected) fail('RUNNER_RESULT_REJECTED','previous rejected result needs normalization before another dispatch');
  const admittedCycleId=base.cycle?.checks[0]
    ? jsonBytes(restoreCaptureSources('current-findings',base.cycle.checks[0],base.map).applyRequest,'findings request').value.base.validation.id
    : null;
  if (base.cycle && (base.cycle.rejection || base.cycle.status==='BLOCKED'
    || (base.cycle.status==='TESTS_FAIL' && base.cycle.consumedInvocations!==3))) invalid('findings cycle cannot admit formal');
  const priorScopePaths=base.cycle && base.bundle.validation.id===admittedCycleId
    ? base.cycle.lastScope : base.latest?.request.scope.paths ?? base.initial.paths;
  const auxiliary=base.cycle ? {kind:'findings',operationAttemptId:base.cycle.owner.operationAttemptId,
    cycle:admittedCycleId,
    firstCheckId:base.cycle.checks[0]?.id,lastCheckId:base.cycle.checks.at(-1)?.id,
    recordsSha256:raw(encode(base.cycle.checks))} : null;
  const expectedBase={sha256:raw(previousBytes),counters:input.previous.counters,openFindings:base.bundle.openFindings,priorScopePaths,auxiliary};
  const derived=deriveCapture({context:input.context,authority:input.authority,capture:input.capture,
    expectedOwner:input.owner,expectedBase,priorFiles:base.priorFiles,
    filelessReason:base.cycle ? base.cycle.filelessReason : base.initial.filelessReason});
  const store=closeEvidenceObjects();
  const sources=packCaptureSources('current-validation',input.capture,store);
  const map=mergeObjects(base.map,store);
  const bundle={...base.bundle};
  const supporting=[...base.bundle.support.filter(item => item.kind==='validation'),...(base.bundle.validation ? [base.bundle.validation] : [])];
  const supportCycles=derived.rejection
    ? base.bundle.support.filter(item=>['implementation-check','findings-check'].includes(item.kind))
    : base.cycle ? selectRemovalSupport(base,{lastWork:derived.recordDraft.testedWork,lastScope:derived.request.scope.paths,
      checks:base.bundle.findingsChecks},applyRoundsFromRecords(base.bundle.findingsChecks,base.map),input.context,derived.receipt) : [];
  const keepFormalOrigins=(records,all,latestId)=>{
    const chosen=formalOrigins(records,[...all,...(base.cycle?.selectedFindings??[])],latestId);
    if (base.cycle) {
      const admitted=auxiliary.cycle;
      const origin=records.find(item=>item.id===admitted);
      if (origin && admitted!==latestId && !chosen.some(item=>item.id===admitted)) chosen.push(origin);
      chosen.sort((a,b)=>formalRecordNumber(a)-formalRecordNumber(b));
    }
    return chosen;
  };
  if (derived.rejection) {
    const priorDispositions=base.cycle && base.bundle.validation.id===base.cycle.admissionId
      ? base.bundle.openFindings : base.latest?.all??[];
    bundle.support=[...supportCycles,...keepFormalOrigins(supporting,priorDispositions,base.bundle.validation?.id),
      {kind:'rejection',operationAttemptId:input.owner.operationAttemptId,origin:derived.origin,
        diagnostic:derived.rejection,consumedInvocations:1,round:1,sources}];
    bundle.openFindings=base.bundle.openFindings;
  } else {
    const record={...derived.recordDraft,sources};
    bundle.validation=record;
    bundle.openFindings=derived.open;
    bundle.support=[...supportCycles,...keepFormalOrigins(supporting,derived.all,record.id)];
  }
  bundle.objects=referencedObjects([...bundle.implementation,...bundle.findingsChecks,...bundle.support,...(bundle.validation ? [bundle.validation] : [])],map);
  validateCurrentEvidence(bundle);
  const outputBytes=encode(bundle);
  const outputCounters=derived.rejection ? input.previous.counters
    : baseCounters(input.previous.counters.implementationChecks,derived.request,derived.response.newFindings.length,
      input.previous.counters.findingsChecks);
  const result=validateCurrentValidationEvidence({context:input.context,authority:input.authority,
    bundleBytes:outputBytes,counters:outputCounters,observedWork:derived.observed.observed?.after ?? passiveWork});
  return {...result,replayed:false,consumedInvocations:1};
}
function selectRemovalSupport(base,cycle,currentRounds,context,demandReceipt=null) {
  const manifest=cycle.lastWork??base.latest.record.testedWork;
  const accepted=currentRounds.slice(0,cycle.checks.length);
  const receipt=demandReceipt??(accepted.length ? jsonBytes(accepted.at(-1).receipt,'current demand').value
    : jsonBytes(base.map.get(base.bundle.validation.sources.receipt),'admission demand').value);
  const needed=new Set((receipt.testedState?.entries??[]).filter(item=>item.value==='REMOVED').map(item=>
    path.relative(receipt.testedState.workspace,resolveLogicalProductClaim(
      context,
      `tasks/${base.bundle.slice}.md`,item.path)).split(path.sep).join('/'))
    .filter(name=>manifest.entries.some(item=>item.path===name && item.kind==='absent')));
  const currentProofs=new Set();
  for (const cap of accepted) {
    const before=jsonBytes(cap.baselineCapture,'current removal baseline').value.manifest;
    const after=jsonBytes(cap.verificationObservation,'current removal observation').value.after;
    for (const name of currentProofs) if (![before,after].every(work=>work.entries.some(item=>item.path===name && item.kind==='absent')))
      currentProofs.delete(name);
    for (const blob of cap.removalProofs) currentProofs.add(jsonBytes(blob,'current removal').value.path);
  }
  const prior=[...base.bundle.implementation,...base.bundle.findingsChecks,
    ...base.bundle.support.filter(item=>['implementation-check','findings-check'].includes(item.kind))];
  const groups=new Map();
  for (const record of prior) {
    const key=`${record.kind}:${record.origin.operationAttemptId}`;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(record);
  }
  const selected=new Set();
  for (const [name,records] of removalProofIndex(groups.values(),base.map)) {
    if (!needed.has(name) || currentProofs.has(name) || !base.priorFiles.has(name)) continue;
    if (cycle.checks.some(record=>record.origin.operationAttemptId===records[0].origin.operationAttemptId)) continue;
    selected.add(`${records[0].kind}:${records[0].origin.operationAttemptId}`);
  }
  return [...selected].flatMap(key=>groups.get(key)).sort((a,b)=>
    (a.kind==='implementation-check'?0:1)-(b.kind==='implementation-check'?0:1)
    || Number(a.id.split('-').at(-1))-Number(b.id.split('-').at(-1)));
}
export function composeCurrentFindingsEvidence(input) {
  if (input && typeof input==='object' && Object.getOwnPropertyDescriptor(input,'imported')?.value===true)
    fail('MIGRATION_REQUIRED','imported findings evidence requires conversion');
  closed(input,['context','authority','owner','previous','rounds'],'findings composition input');
  authority(input.authority,input.context,input.owner,'APPLY_FINDINGS');
  closed(input.previous,['bundleBytes','counters'],'findings previous');
  counters(input.previous.counters,'findings previous counters');
  dense(input.rounds,'findings rounds',1,3);
  input.rounds.forEach((cap,index)=>{
    plain(cap,`round ${index+1} capture`);
    verifyCapturedInvocation('current-findings',cap,undefined,undefined,undefined,index+1,cap.transport);
  });
  const previousBytes=copyBytes(input.previous.bundleBytes,'findings previous bundleBytes');
  const prior=jsonBytes(previousBytes,'findings previous bundle').value;
  const observed=prior.validation?.testedWork??prior.findingsChecks?.at(-1)?.testedWork??prior.implementation?.at(-1)?.testedWork;
  const base=inspect(previousBytes,input.context,input.authority,input.previous.counters,observed,true);
  const requested=jsonBytes(input.rounds[0]?.applyRequest,'first findings request').value;
  applyRequestShape(requested);
  equal(requested.owner,input.owner,'OWNER_MISMATCH','findings input owner');
  if (base.cycle) {
    const current=base.bundle.findingsChecks.length
      ? [...base.bundle.findingsChecks,...base.bundle.support.filter(item=>item.kind==='rejection' && item.origin.operation==='APPLY_FINDINGS')]
      : base.bundle.support.filter(item=>item.kind==='rejection' && item.origin.operation==='APPLY_FINDINGS');
    const previousRounds=applyRoundsFromRecords(current,base.map);
    const admitted=jsonBytes(previousRounds[0].applyRequest,'current findings request').value.base.validation.id;
    if (base.bundle.validation.id===admitted && (!base.rejected || base.cycle.rejection)) {
      if (base.cycle.owner.operationAttemptId===input.owner.operationAttemptId) {
        equal(base.cycle.owner,input.owner,'OWNER_MISMATCH','findings replay owner');
        if (previousRounds.length!==input.rounds.length || previousRounds.some((cap,index)=>!exactCapture(cap,input.rounds[index])))
          mismatch('same findings owner has different captured sources');
        const result=validateCurrentFindingsEvidence({context:input.context,authority:input.authority,
          bundleBytes:previousBytes,counters:input.previous.counters,observedWork:observed});
        return {...result,replayed:true,consumedInvocations:input.rounds.length};
      }
      fail(base.cycle.rejection?'RUNNER_RESULT_REJECTED':'STALE_BASE','NEEDS_FIX already has a findings cycle');
    }
    if (base.cycle.owner.operationAttemptId===input.owner.operationAttemptId)
      fail('STALE_BASE','findings replay after formal is stale');
  }
  if (base.rejected) fail('RUNNER_RESULT_REJECTED','previous rejected result needs normalization');
  if (!base.latest || base.latest.payload.status!=='NEEDS_FIX'
    || !base.bundle.openFindings.some(item=>item.severity==='blocking')) invalid('findings require concluded NEEDS_FIX with active blocker');
  if (requested.base.evidenceSha256!==raw(previousBytes)) fail('STALE_BASE','findings request base digest');
  const priorRemoval=[...base.priorFiles].filter(name=>base.latest.record.testedWork.entries.some(item=>item.path===name && item.kind==='absent'));
  const facts={sha256:raw(previousBytes),counters:input.previous.counters,
    validation:{id:base.bundle.validation.id,recordSha256:raw(encode(base.bundle.validation))},
    openFindings:base.bundle.openFindings,priorScopePaths:base.latest.request.scope.paths,
    testedWork:base.bundle.validation.testedWork,removalPaths:priorRemoval};
  const store=closeEvidenceObjects();
  const cycle=deriveApplyCycle({context:input.context,authority:input.authority,owner:input.owner,
    rounds:input.rounds,baseFacts:facts,store});
  const oldOrigins=base.bundle.support.filter(item=>item.kind==='validation'
    && base.bundle.openFindings.some(finding=>finding.originAttempt===item.id));
  const support=[...selectRemovalSupport(base,cycle,input.rounds,input.context),...oldOrigins];
  if (cycle.rejection) support.push(cycle.rejection);
  const joined=new Map([...base.map,...store.finish().map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')])]);
  const bundle={...base.bundle,implementation:[],findingsChecks:cycle.checks,
    validation:base.bundle.validation,openFindings:base.bundle.openFindings,support};
  bundle.objects=referencedObjects([...bundle.findingsChecks,bundle.validation,...bundle.support],joined);
  validateCurrentEvidence(bundle);
  const outputBytes=encode(bundle);
  const outputCounters={...input.previous.counters,findingsChecks:input.previous.counters.findingsChecks+cycle.checks.length};
  counters(outputCounters,'findings output counters');
  const result=validateCurrentFindingsEvidence({context:input.context,authority:input.authority,
    bundleBytes:outputBytes,counters:outputCounters,observedWork:cycle.lastWork??observed});
  return {...result,replayed:false,consumedInvocations:input.rounds.length};
}
export function validateCurrentFindingsEvidence(input) {
  if (input && typeof input==='object' && Object.getOwnPropertyDescriptor(input,'imported')?.value===true)
    fail('MIGRATION_REQUIRED','imported findings evidence requires conversion');
  closed(input,['context','authority','bundleBytes','counters','observedWork'],'findings validator input');
  authority(input.authority,input.context);
  counters(input.counters,'findings validator counters');
  const result=inspect(input.bundleBytes,input.context,input.authority,input.counters,input.observedWork);
  if (!result.cycle) invalid('findings validator requires current cycle');
  return {bundle:parseCurrentJson(result.original.toString('utf8')),bytes:Uint8Array.from(result.original),
    sha256:raw(result.original),counters:structuredClone(result.counters),outcome:result.outcome,
    auxiliaryStatus:result.cycle.auxiliaryStatus,formalStatus:result.formalStatus,validation:result.validation};
}

// Internal read-only bridge for the official EC-1 reader.  It uses the same
// capture reconstruction as the formal and APPLY validators, but reports the
// sealed verdict separately from the observation made on current product bytes.
// A supplied currentAuthoritySha256 binds the current index independently of the
// literal source authority. Publication validators retain their strict default;
// the read-only caller still owns the subsequent retention-equivalence gate.
export function inspectCurrentEvidence({context,authority,bundleBytes,counters:declaredCounters,baseline:declaredBaseline,observedWork,currentAuthoritySha256=null}) {
  counters(declaredCounters,'current counters');
  if(currentAuthoritySha256!==null&&!HASH.test(currentAuthoritySha256))invalid('current authority index digest');
  verifyWorkObservation('current-validation',{observedWork});
  if (bundleBytes === null) {
    equal(declaredCounters,{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},'INVALID_CURRENT_IMAGE','empty evidence counters');
    return {context,authority,bundle:null,evidenceSha256:null,counters:structuredClone(declaredCounters),
      baseline:declaredBaseline,persistedValidation:'unvalidated',observationMatches:same(declaredBaseline,observedWork),
      observedValidation:same(declaredBaseline,observedWork)?'unvalidated':'revalidation-required',
      auxiliaryStatus:null,formalStatus:null,verifiedChanges:[],verifiedCorrections:[],openFindings:[],records:{implementation:[],findings:[],validation:[]},
      rejection:null,latest:null,cycle:null};
  }
  const original=copyBytes(bundleBytes,'bundleBytes');
  const bundle=jsonBytes(original,'bundleBytes').value;
  validateCurrentEvidence(bundle);
  const map=sourceMap(bundle);
  const initialRejection=bundle.validation===null && bundle.findingsChecks.length===0
    && bundle.support.some(item=>item.kind==='rejection' && item.origin.operation==='EXECUTE_SLICE');
  let result;
  if (initialRejection) {
    const record=bundle.implementation[0]??bundle.support.find(item=>item.kind==='rejection');
    if (!record) invalid('Initial rejection lacks capture');
    const cap=restoreCaptureSources('initial-implementation',record,map);
    const initialOwner=jsonBytes(cap.transport==='native'?cap.origin:cap.managedContext,'Initial owner').value.owner;
    if(bundle.currentAuthoritySha256!==(currentAuthoritySha256??projectedDelivery(authority.delivery)))invalid('rejection current authority index');
    const isolated={...bundle,currentAuthoritySha256:projectedDelivery(authority.delivery),
      objects:referencedObjects([...bundle.implementation,...bundle.support],map)};
    const validated=validateInitialImplementationEvidence({context,authority,owner:initialOwner,currentEvidence:null,
      counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},bundleBytes:encode(isolated)});
    equal(declaredCounters,validated.counters,'INVALID_CURRENT_IMAGE','Initial rejection counters');
    result={bundle,initial:null,latest:null,rejected:bundle.support.find(item=>item.kind==='rejection'),
      cycle:null,formalStatus:null,validation:'uncertain',counters:declaredCounters};
  } else result=inspect(original,context,authority,declaredCounters,observedWork,true,currentAuthoritySha256);
  const firstInitial=bundle.implementation[0]??bundle.support.find(item=>item.kind==='rejection' && item.origin.operation==='EXECUTE_SLICE');
  const firstApply=bundle.findingsChecks[0]??bundle.support.find(item=>item.kind==='rejection' && item.origin.operation==='APPLY_FINDINGS');
  const first=firstApply??firstInitial;
  if (!first) incomplete('evidence lacks a verified cycle baseline');
  const cap=restoreCaptureSources(firstApply?'current-findings':'initial-implementation',first,map);
  const base=jsonBytes(cap.baselineCapture,'current cycle baseline').value;
  if (!base || !Object.hasOwn(base,'manifest')) incomplete('current cycle baseline capture is absent');
  equal(declaredBaseline,base.manifest,'INVALID_CURRENT_IMAGE','current cycle baseline');
  const rejected=Boolean(result.rejected);
  const latest=result.latest??null;
  const formalStatus=result.formalStatus??null;
  const persistedValidation=rejected?'uncertain':formalStatus==='PASS' && !bundle.openFindings.some(item=>item.severity==='blocking')
    ?'current':formalStatus===null?'unvalidated':'revalidation-required';
  const initialTested=bundle.implementation.at(-1)?.testedWork;
  const sealedWork=result.cycle && bundle.validation?.id===result.cycle.admissionId
    ?result.cycle.lastWork??latest?.record.testedWork:latest?.record.testedWork??initialTested??base.manifest;
  const observationMatches=same(sealedWork,observedWork);
  const observedValidation=rejected?'uncertain':!observationMatches?'revalidation-required':result.validation;
  const auxiliaryStatus=result.cycle?.status
    ?? (bundle.implementation.length ? (()=>{const response=jsonBytes(restoreCaptureSources('initial-implementation',bundle.implementation.at(-1),map).rawResponse,'Initial response').value;
      return response.status??response.result?.status??null;})() : null);
  if (!rejected && auxiliaryStatus==='TESTS_FAIL' && !result.cycle && bundle.implementation.length<3)
    fail('UNSUPPORTED_FORMAT','Initial FAIL prefix is not a completed quiet cycle');
  if (!rejected && auxiliaryStatus==='BLOCKED' && !result.cycle)
    fail('UNSUPPORTED_FORMAT','Initial BLOCKED requires operational recovery outside quiet profile');
  const info=verifyWorkObservation('initial-implementation',{context,delivery:authority.delivery,slice:bundle.slice});
  const output=name=>info.areas.some(item=>item.path===name || item.kind==='directory' && name.startsWith(`${item.path}/`));
  const cycleDeltas=[];
  for(const record of [...bundle.implementation,...bundle.findingsChecks]) {
    const profile=record.kind==='implementation-check'?'initial-implementation':'current-findings';
    const before=jsonBytes(restoreCaptureSources(profile,record,map).baselineCapture,'verified round baseline').value.manifest;
    cycleDeltas.push(...changedOutputPaths(before,record.testedWork).filter(output));
  }
  // A rejected APPLY has no accepted current-round tested work. Its last formal
  // work belongs to the preceding attempt and cannot substantiate new areas.
  const verifiedChanges=[...new Set([...cycleDeltas,...(rejected && firstApply
    ?[]:changedOutputPaths(base.manifest,sealedWork).filter(output))])].sort(ordinal);
  const verifiedCorrections=result.cycle?[...new Set(cycleDeltas)].sort(ordinal):[...new Set(bundle.implementation.slice(1).flatMap(record=>{
    const before=jsonBytes(restoreCaptureSources('initial-implementation',record,map).baselineCapture,'verified correction baseline').value.manifest;
    return changedOutputPaths(before,record.testedWork).filter(output);
  }))].sort(ordinal);
  return {context,authority,bundle,evidenceSha256:raw(original),counters:structuredClone(declaredCounters),verifiedChanges,verifiedCorrections,
    baseline:base.manifest,sealedWork,observationMatches,persistedValidation,observedValidation,auxiliaryStatus,formalStatus,
    openFindings:bundle.openFindings,records:{implementation:bundle.implementation,
      findings:bundle.findingsChecks,validation:[...bundle.support.filter(item=>item.kind==='validation'),...(bundle.validation?[bundle.validation]:[])]},
    rejection:rejected?result.rejected:null,latest,cycle:result.cycle??null};
}

function carrierMismatch(artifact,field,reason) {
  const error=new Error(`${artifact} ${field}: ${reason}`);
  error.code='INVALID_CURRENT_IMAGE';
  error.diagnostics=[{kind:'carrier-mismatch',artifact,field,reason}];
  throw error;
}

function carrierSyntax(artifact,field,reason) {
  const error=new Error(`${artifact} ${field}: ${reason}`);
  error.code='INVALID_CURRENT_IMAGE';
  error.diagnostics=[{kind:'carrier-syntax',artifact,field,reason}];
  throw error;
}

function operationalScalar(value) {
  const trimmed=value.trim();
  if (/^`[^`]*`$/u.test(trimmed)) return trimmed.slice(1,-1);
  if (trimmed.startsWith('json:')) {
    try {return canonical(parseCurrentJson(trimmed.slice(5)));}
    catch {return trimmed;}
  }
  return trimmed;
}

const PROSE_FIELDS=new Set(['Evidence','Evidence summary','Discovery sources','Discovery actions',
  'Verification types considered','Non-applicability rationale','No verification-command confirmation',
  'Selection rationale','Coverage','Failures','Blockers','Unexpected workspace effects','Persistence summary',
  'Prior-round failure','Correction applied','In-slice rationale','Regressions','Fileless reason',
  'Problem','Impact','Related authority','Expected correction','Resolution','Affected behavior']);
function operationalProse(value) {
  let text=value.trim();
  if (text.startsWith('json:')) {
    try {const decoded=parseCurrentJson(text.slice(5));if(typeof decoded==='string') text=decoded;}
    catch { /* The field comparison still rejects malformed encoded prose. */ }
  }
  return text.split(/\n[ \t]*\n+/u).map(paragraph=>paragraph.split(/(`[^`]*`)/u)
    .map((part,index)=>index%2?part:part.replace(/\s+/gu,' ')).join('').trim()).join('\n\n');
}
function operationalFields(body,artifact,field) {
  const rows=[];
  let blank=false;
  for (const line of body.replaceAll('\r\n','\n').trim().split('\n')) {
    if (!line.trim()) {blank=true;continue;}
    const entry=/^[ \t]*[-*+][ \t]+([^:]+?)[ \t]*:[ \t]*(.*?)[ \t]*$/u.exec(line);
    const bullet=/^[ \t]*[-*+][ \t]+(.+?)[ \t]*$/u.exec(line);
    const parts=bullet && /^(.*?)\s*\|\s*(exit:[-]?[0-9]+|sha256:[a-f0-9]{64}|REMOVED)\s*$/u.exec(bullet[1]);
    // A nested typed item is distinguished by its complete value grammar,
    // not the field's left margin. Commands keep their exact inner contents.
    if (parts && !(entry && PROSE_FIELDS.has(entry[1].trim()))
      && rows.length && ['Commands','Tested state','Files','Authoritative commands'].includes(rows.at(-1)[0])) {
      if (rows.at(-1)[1]==='') rows.at(-1)[1]=[];
      if (!Array.isArray(rows.at(-1)[1])) carrierSyntax(artifact,field,'nested list conflicts with scalar');
      rows.at(-1)[1].push([operationalScalar(parts[1]),parts[2]]);
    } else if (entry) rows.push([entry[1].trim(),entry[2]]);
    else if (rows.length && PROSE_FIELDS.has(rows.at(-1)[0]) && !/^\s*[-*+#]/u.test(line)) {
      rows.at(-1)[1]+=(blank?'\n\n':' ')+line.trim();
    } else carrierSyntax(artifact,field,'unrecognized operational field');
    blank=false;
  }
  const names=rows.map(row=>row[0]);
  if (new Set(names).size!==names.length) carrierSyntax(artifact,field,'duplicate operational field');
  const sets=new Set(['Finding references','Finding IDs','Findings verified','Unsupported active findings','Selected checks']);
  const paths=new Set(['Tested scope','Verified scope','Updated scope','Correction paths','Corrections covered']);
  return Object.fromEntries(rows.map(([name,value])=>[name,Array.isArray(value)?value:PROSE_FIELDS.has(name)
    ?operationalProse(value):sets.has(name)?operationalScalar(value).split(/\s*,\s*/u).map(operationalScalar).sort(ordinal).join(', ')
      :paths.has(name)?operationalScalar(value).split(/\s*,\s*/u).map(operationalScalar).join(', '):operationalScalar(value)]));
}

function operationalRecords(body,artifact,field) {
  if (/^\s*[-*+]\s+none\s*$/u.test(body)) return [];
  const headings=[...body.matchAll(/^###\s+((?:implementation-check|findings-check|attempt)-[0-9]{2,})\s*$/gmu)];
  if (!headings.length || headings[0].index!==0) carrierSyntax(artifact,field,'record headings are missing');
  return headings.map((heading,index)=>{
    const text=body.slice(heading.index+heading[0].length,headings[index+1]?.index).trim();
    return {id:heading[1],fields:operationalFields(text,artifact,`${field}.${heading[1]}`)};
  });
}

function operationalPaths(body,facts,artifact,field,{pending=false}={}) {
  if (/^\s*[-*+]\s+none\s*$/u.test(body) || pending && /^\s*[-*+]\s+pending\s*$/u.test(body)) return [];
  const values=[];
  for (const line of body.replaceAll('\r\n','\n').trim().split('\n')) {
    const match=/^[ \t]*[-*+][ \t]+(.+?)[ \t]*$/u.exec(line);
    if (!match || match[1].includes('`') && !/^`[^`]+`$/u.test(match[1]))
      carrierSyntax(artifact,field,'invalid path claim');
    const claim=operationalScalar(match[1]);
    let absolute;
    try {absolute=resolveLogicalProductClaim(facts.context,artifact,claim);}
    catch {carrierSyntax(artifact,field,'path escapes product authority');}
    values.push(path.relative(facts.context.productRoot,absolute).split(path.sep).join('/'));
  }
  if (new Set(values).size!==values.length) carrierSyntax(artifact,field,'duplicate path claim');
  return values.sort(ordinal);
}

function findingCarrier(body,artifact) {
  if (/^\s*[-*+]\s+none\s*$/u.test(body)) return [];
  const headings=[...body.matchAll(/^###\s+(finding-[0-9]{2,})\s*$/gmu)];
  if (!headings.length || headings[0].index!==0) carrierSyntax(artifact,'Validation Findings','finding headings are missing');
  return headings.map((heading,index)=>({id:heading[1],fields:operationalFields(
    body.slice(heading.index+heading[0].length,headings[index+1]?.index).trim(),artifact,`Validation Findings.${heading[1]}`)}));
}

function compareFindings(facts,sections,artifact) {
  const actual=findingCarrier(sections['Validation Findings'],artifact);
  const expected=facts.latest?.all??[];
  if (!same(actual.map(item=>item.id),expected.map(item=>item.id)))
    carrierMismatch(artifact,'Validation Findings','finding membership differs from verified formal history');
  const names=['Severity','Origin','Problem','Evidence','Impact','Related authority','Expected correction'];
  const keys=['severity','originAttempt','problem','evidence','impact','relatedAuthority','expectedCorrection'];
  for (let i=0;i<expected.length;i+=1) {
    const {fields}=actual[i],source=expected[i],state=facts.latest.dispositions.get(source.id);
    for (let j=0;j<names.length;j+=1) if (fields[names[j]]!==(PROSE_FIELDS.has(names[j])?operationalProse(source[keys[j]]):source[keys[j]]))
      carrierMismatch(artifact,`Validation Findings.${source.id}.${names[j]}`,'finding detail differs from verified origin');
    if (fields.State!==state) carrierMismatch(artifact,`Validation Findings.${source.id}.State`,'finding disposition differs');
    const allowed=[...names,'State',...(state==='resolved'?['Resolution']:state==='superseded'?['Superseded by']:[])];
    if (!same(Object.keys(fields).sort(ordinal),allowed.sort(ordinal)))
      carrierSyntax(artifact,`Validation Findings.${source.id}`,'missing or unknown finding field');
    if (state==='active' && (fields.Resolution!==undefined || fields['Superseded by']!==undefined))
      carrierMismatch(artifact,`Validation Findings.${source.id}`,'active finding has resolution');
    if (state==='resolved' && !String(fields.Resolution??'').split(/[^a-zA-Z0-9-]+/u).includes(facts.latest.record.id))
      carrierMismatch(artifact,`Validation Findings.${source.id}.Resolution`,'resolution lacks verified formal attempt');
  }
}

function compareEffectiveBase(facts,sections,artifact) {
  const body=sections['Effective Validation Base'];
  if (facts.formalStatus!=='PASS') {
    if (!/^\s*[-*+]\s+none\s*$/u.test(body)) carrierMismatch(artifact,'Effective Validation Base','no sealed PASS owns a base');
    return;
  }
  if (/^\s*[-*+]\s+none\s*$/u.test(body)) carrierMismatch(artifact,'Effective Validation Base','sealed PASS base is absent');
  const base=operationalFields(body,artifact,'Effective Validation Base');
  const record=operationalRecords(facts.latest.record.recordUtf8,artifact,'Validation Attempts')[0].fields;
  for (const [name,expected] of [['Origin attempt',facts.latest.record.id],['Attempt type',record.Type],
    ['HEAD',record.HEAD],['Result','PASS'],['Evidence summary',record.Evidence]])
    if (base[name]!==expected) carrierMismatch(artifact,`Effective Validation Base.${name}`,'base differs from verified PASS');
  if (!same(base['Authoritative commands'],record.Commands))
    carrierMismatch(artifact,'Effective Validation Base.Authoritative commands','commands differ from verified PASS');
  const expectedKeys=['Origin attempt','Attempt type','HEAD','Result','Files','Authoritative commands','Evidence summary',
    ...(facts.latest.request.scope.paths.length?[]:['Fileless reason'])];
  if (!same(Object.keys(base).sort(ordinal),expectedKeys.sort(ordinal)))
    carrierSyntax(artifact,'Effective Validation Base','missing or unknown base field');
  const scope=facts.latest.request.scope.paths;
  if (!scope.length) {
    if (base.Files!=='none' || base['Fileless reason']!==facts.latest.request.scope.filelessReason)
      carrierMismatch(artifact,'Effective Validation Base.Files','fileless base differs from verified scope');
  } else {
    const observed=new Map(facts.latest.record.testedWork.entries.map(item=>[item.path,item]));
    const expected=scope.map(name=>{
      const relative=path.relative(path.dirname(logicalArtifactPath(facts.context,artifact)),path.join(facts.context.productRoot,name)).split(path.sep).join('/');
      const item=observed.get(name);
      if (!item) carrierMismatch(artifact,'Effective Validation Base.Files','verified scope lacks product entry');
      return [relative,item.kind==='absent'?'REMOVED':item.sha256];
    });
    if (!same(base.Files,expected) || base['Fileless reason']!==undefined)
      carrierMismatch(artifact,'Effective Validation Base.Files','file state differs from verified PASS');
  }
}

export function validateCurrentEvidenceCarriers({facts,sections,continuity,index,slice,priorDeliveries=[]}) {
  const artifact=`tasks/${slice}.md`;
  const parsed=(field,records)=>operationalRecords(sections[field],artifact,field);
  for (const [field,records] of [
    ['Implementation Test Evidence',facts.records.implementation],
    ['Findings Test Evidence',facts.records.findings],
    ['Validation Attempts',facts.records.validation],
  ]) {
    const actual=parsed(field,records);
    const expected=records.map(record=>operationalRecords(record.recordUtf8,artifact,field)[0]);
    for (let i=0;i<actual.length;i+=1) if (expected[i] && !same(Object.keys(actual[i].fields).sort(ordinal),Object.keys(expected[i].fields).sort(ordinal)))
      carrierSyntax(artifact,field,'missing or unknown record field');
    if (!same(actual,expected)) carrierMismatch(artifact,field,'record fields differ from verified capture');
  }
  compareFindings(facts,sections,artifact);
  compareEffectiveBase(facts,sections,artifact);
  for (const field of ['Divergences','Scope Expansion']) if (!/^\s*[-*+]\s+none\s*$/u.test(sections[field]))
    carrierMismatch(artifact,field,'active divergence or scope expansion exceeds quiet profile');
  const changed=operationalPaths(sections['Changed Areas'],facts,artifact,'Changed Areas',{pending:true});
  const corrections=operationalPaths(sections['Corrections Applied'],facts,artifact,'Corrections Applied');
  if (!same(changed,facts.verifiedChanges)) carrierMismatch(artifact,'Changed Areas','paths differ from verified cycle deltas');
  if (!same(corrections,facts.verifiedCorrections)) carrierMismatch(artifact,'Corrections Applied','paths differ from verified corrections');
  // Cross-delivery overlap is presentation of already verified path facts.
  const overlapOrder=(a,b)=>ordinal(a[0],b[0]) || ordinal(a[1],b[1]);
  const required=priorValidationOverlap(changed,priorDeliveries);
  const overlap=[];
  const overlapBody=sections['Prior Validation Overlap'];
  if (!/^\s*[-*+]\s+none\s*$/u.test(overlapBody)) {
    const add=(slice,claims)=>{
      if(!/^slice-[0-9]{2,}$/u.test(slice)) carrierSyntax(artifact,'Prior Validation Overlap','invalid prior slice');
      const paths=operationalPaths(claims.split(/\s*,\s*/u).map(item=>`- ${item}`).join('\n'),facts,artifact,'Prior Validation Overlap');
      overlap.push(...paths.map(name=>[slice,name]));
    };
    if(overlapBody.startsWith('###')) {
      const headings=[...overlapBody.matchAll(/^###[ \t]+overlap-[0-9]+[ \t]*$/gmu)];
      if(!headings.length || headings[0].index!==0) carrierSyntax(artifact,'Prior Validation Overlap','invalid overlap heading');
      for(const [i,heading] of headings.entries()) {
        const fields=operationalFields(overlapBody.slice(heading.index+heading[0].length,headings[i+1]?.index).trim(),artifact,'Prior Validation Overlap');
        if(!same(Object.keys(fields).sort(ordinal),['Affected behavior','Paths','Prior slice','Regressions'])
          || !fields['Affected behavior'] || !fields.Regressions) carrierSyntax(artifact,'Prior Validation Overlap','invalid overlap fields');
        add(fields['Prior slice'],fields.Paths);
      }
    } else for(const line of overlapBody.trim().split('\n')) {
      const match=/^\s*[-*+]\s+Slice ([0-9]{2,}) overlap:\s*(.+);\s*(\S.*)$/u.exec(line);
      if(!match) carrierSyntax(artifact,'Prior Validation Overlap','invalid overlap record');
      add(`slice-${match[1]}`,match[2]);
    }
  }
  if(!same(overlap.sort(overlapOrder),required)) carrierMismatch(artifact,'Prior Validation Overlap','overlap differs from verified prior PASS paths');
  if (corrections.some(name=>!changed.includes(name)))
    carrierMismatch(artifact,'Corrections Applied','correction path is absent from Changed Areas');
  const proofPaths=new Set([...(facts.bundle?.implementation??[]),...(facts.bundle?.findingsChecks??[]),
    ...(facts.bundle?.validation?[facts.bundle.validation]:[])].flatMap(record=>record.testedWork.entries
    .filter(item=>item.kind==='file' || item.kind==='absent').map(item=>item.path)));
  if (changed.some(name=>!proofPaths.has(name)) && facts.bundle!==null)
    carrierMismatch(artifact,'Changed Areas','path has no verified product proof');
  if (!facts.rejection && !/^\s*[-*+]\s+none\s*$/u.test(sections['Delegation Blocker']))
    carrierMismatch(artifact,'Delegation Blocker','no verified rejection owns a blocker');
  if (facts.rejection) {
    const blocker=operationalFields(sections['Delegation Blocker'],artifact,'Delegation Blocker');
    if (!same(Object.keys(blocker).sort(ordinal),['Operation','State']))
      carrierSyntax(artifact,'Delegation Blocker','missing or unknown blocker field');
    if (blocker.Operation!==facts.rejection.origin?.operation || blocker.State!=='active')
      carrierMismatch(artifact,'Delegation Blocker','blocker does not name verified rejection');
  }
  if (!sections['Diff Summary']?.trim()) carrierSyntax(artifact,'Diff Summary','description is empty');
  const final=operationalScalar(sections['Final Result'].replace(/^\s*[-*+]\s*/u,''));
  if (final!==(facts.formalStatus==='PASS'?'PASS':'pending'))
    carrierMismatch(artifact,'Final Result','result differs from sealed formal status');
  if (continuity.validation!==facts.persistedValidation) carrierMismatch(artifact,'Continuity.Current validation','sealed validation differs');
  const evidence=facts.evidenceSha256===null?'none':`evidence/${facts.bundle.deliveryId}.json`;
  if (continuity.evidence!==evidence) carrierMismatch(artifact,'Continuity.Current evidence','evidence path differs');
  if (!continuity.action?.trim()) carrierSyntax(artifact,'Continuity.Current action','action is empty');
  const action=operationalScalar(continuity.action);
  if (['PLAN','REVIEW_PLAN','REPLAN','EXECUTE_SLICE','APPLY_FINDINGS','VALIDATE_SLICE',
    'INIT','RESUME','READINESS','CLOSE','COMPLETE'].includes(action)) {
    const expectedAction=facts.rejection || facts.auxiliaryStatus==='BLOCKED' || facts.formalStatus==='BLOCKED' || facts.persistedValidation==='current'?null
      :facts.formalStatus==='NEEDS_FIX' && (!facts.cycle || facts.bundle.validation.id!==facts.cycle.admissionId)?'APPLY_FINDINGS'
        :facts.bundle===null?'EXECUTE_SLICE':'VALIDATE_SLICE';
    if (action!==expectedAction) carrierMismatch(artifact,'Continuity.Current action','operation token contradicts verified facts');
  }
  if (index.validation!==(facts.formalStatus??'pending')) carrierMismatch('tasks.md',slice,'formal row differs');
  if (index.result!==(facts.formalStatus==='PASS'?'PASS':'pending')) carrierMismatch('tasks.md',slice,'result row differs');
  if (facts.formalStatus==='PASS' && index.done?.toLowerCase()!=='[x]') carrierMismatch('tasks.md',slice,'PASS row is not marked done');
  if (facts.formalStatus!== 'PASS' && index.done!=='[ ]') carrierMismatch('tasks.md',slice,'row done mark lacks formal PASS');
  return {evidence,validation:facts.persistedValidation,formalStatus:facts.formalStatus};
}

// Thin Initial adapter: the existing producers decide evidence and verdicts;
// this projects only their verified facts into the official image carriers.
export function composeInitialCurrentOperation({context,requirementsAuthority,previous,admission,
  deliveryId,owner,rounds,observedByDelivery}) {
  closed(previous,['activationBytes','files'],'Initial predecessor');
  closed(admission,['activationBytes','files'],'Initial admission');
  const prior=validateCurrentImage(previous);
  const active=validateCurrentImage(admission);
  const a0=prior.activation,a1=active.activation;
  if(a0.preparationRevision!==1 || a0.activeAttempt!==null
    || a1.previousActivationId!==a0.activationId || a1.sequence!==a0.sequence+1
    || !same(a1.activeAttempt,{...owner,operationRef:a1.activeAttempt?.operationRef})
    || owner.originActivationId!==a0.activationId
    || previous.files.size!==admission.files.size
    || [...previous.files].some(([name,bytes])=>!Buffer.from(admission.files.get(name)??[]).equals(Buffer.from(bytes))))
    mismatch('Initial A0/A1 owner or artifact binding differs');
  dense(rounds,'Initial captured rounds',1,3);
  for(const cap of rounds) {
    const origin=jsonBytes(cap.origin,'Initial native origin').value;
    if(cap.transport!=='native' || !same(origin.admission?.baseActivation,a0)
      || !same(origin.admission?.reservedActivation,a1)
      || !same(origin.owner,owner)) mismatch('Initial native capture is not bound to A0/A1');
  }
  const files=new Map([...previous.files].map(([name,bytes])=>[name,copyBytes(bytes,name)]));
  const snapshot=jsonBytes(files.get('approved-preparation.json'),'Initial approved snapshot').value;
  const current=prior.continuity.deliveries.find(item=>item.deliveryId===deliveryId);
  const leaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===deliveryId);
  if(!current || !leaf || owner.deliveryId!==deliveryId || owner.slice!==current.slice
    || current.localRevision!==1 || snapshot.normativeSha256!==owner.normativeSha256
    || requirementsAuthority!==snapshot.requirementsAuthority)
    stale('Initial selected authority differs');
  const authority={preparationRevision:1,localRevision:1,normativeSha256:snapshot.normativeSha256,
    delivery:leaf,context:{requirementsAuthority,
      objective:snapshot.normativeProjection.global.objective,
      strategy:snapshot.normativeProjection.global.strategy,
      risks:snapshot.normativeProjection.global.risks}};
  const observed=observedByDelivery.get(deliveryId)?.manifest;
  if(!observed) incomplete('Initial selected product observation is absent');
  let product;
  if(owner.operation==='EXECUTE_SLICE') {
    if(current.evidence!==null || Object.values(current.counters).some(value=>value!==0))
      fail('UNSUPPORTED_FORMAT','Initial implementation predecessor is not pristine');
    product=composeInitialImplementationEvidence({context,authority,owner,currentEvidence:null,
      counters:current.counters,rounds});
  } else if(owner.operation==='VALIDATE_SLICE') {
    if(rounds.length!==1 || !current.evidence) incomplete('Initial formal needs one captured response and predecessor');
    product=composeCurrentValidationEvidence({context,authority,owner,
      previous:{bundleBytes:files.get(current.evidence.path),counters:current.counters},capture:rounds[0]});
  } else if(owner.operation==='APPLY_FINDINGS') {
    if(!current.evidence) incomplete('Initial findings need a captured formal predecessor');
    product=composeCurrentFindingsEvidence({context,authority,owner,
      previous:{bundleBytes:files.get(current.evidence.path),counters:current.counters},rounds});
  } else fail('UNSUPPORTED_FORMAT','Initial operation is outside EXECUTE/VALIDATE/APPLY');
  const rejected=['EXECUTE_SLICE','APPLY_FINDINGS'].includes(owner.operation) && product.outcome==='rejected';
  if(product.outcome==='rejected' && !rejected)
    fail('RUNNER_RESULT_REJECTED','Initial refusal normalization is outside this EXECUTE/APPLY profile');
  if(!rejected && product.outcome!=='recorded') invalid('Initial outcome is not concluded');
  const refusal=rejected?product.bundle.support.at(-1):null;
  if(rejected && owner.operation==='APPLY_FINDINGS'
    && (rounds.length!==1 || product.consumedInvocations!==1 || current.counters.findingsChecks!==0))
    fail('RUNNER_RESULT_REJECTED','Initial APPLY refusal is outside the first-invocation profile');
  if(rejected && (refusal?.kind!=='rejection' || refusal.origin.operation!==owner.operation
    || refusal.operationAttemptId!==owner.operationAttemptId
    || refusal.consumedInvocations!==product.consumedInvocations))
    invalid('Initial refusal does not belong to this concluded owner');
  if(rejected && jsonBytes(rounds.at(-1).receipt,'Initial refusal receipt').value.status
    !=='RUNNER_RESPONSE_CAPTURED')
    fail('RUNNER_RESULT_REJECTED','Initial schema refusal is outside the concluded semantic profile');
  const normalization=rejected?{episodeId:owner.operationAttemptId,operation:owner.operation,
    causeSha256:product.sha256,sourceOperationAttemptId:owner.operationAttemptId,
    used:1,consumedInvocations:product.consumedInvocations,round:1,status:'exhausted'}:null;
  const nextBaseline=owner.operation==='APPLY_FINDINGS'
    ?jsonBytes(rounds[0].baselineCapture,'Initial findings baseline').value.manifest
    :current.baseline;
  const next={...current,baseline:nextBaseline,
    evidence:{path:`evidence/${deliveryId}.json`,sha256:raw(product.bytes)},
    counters:product.counters,validation:rejected?'uncertain'
      :product.validation??(owner.operation==='EXECUTE_SLICE'?'unvalidated':'revalidation-required'),
    normalization,lastDiagnostic:rejected?{code:'RUNNER_RESULT_REJECTED',
      operationAttemptId:owner.operationAttemptId,reason:refusal.diagnostic,
      affectedPaths:owner.operation==='APPLY_FINDINGS'
        ?jsonBytes(rounds[0].applyRequest,'Initial refusal request').value.scopePaths:[],nextAction:'stop'}:null};
  const facts=inspectCurrentEvidence({context,authority,bundleBytes:product.bytes,
    counters:next.counters,baseline:next.baseline,observedWork:observed});
  if(!facts.observationMatches && !rejected) stale('Initial composed evidence does not match current product');
  const changed=new Set(facts.verifiedChanges);
  const updated=prior.continuity.deliveries.map(item=>{
    if(item.deliveryId===deliveryId) return next;
    if(owner.operation!=='VALIDATE_SLICE' || facts.formalStatus!=='PASS'
      || item.evidence!==null || Object.values(item.counters).some(value=>value!==0)) return item;
    const work=observedByDelivery.get(item.deliveryId)?.manifest;
    if(!work) incomplete('pristine dependent delivery observation is absent');
    const before=new Map(item.baseline.entries.map(entry=>[entry.path,entry]));
    const after=new Map(work.entries.map(entry=>[entry.path,entry]));
    for(const name of new Set([...before.keys(),...after.keys()])) {
      if(same(before.get(name)??null,after.get(name)??null)) continue;
      if(before.get(name)?.kind==='directory' || after.get(name)?.kind==='directory') continue;
      if(!changed.has(name)) stale('pristine delivery changed outside proved Initial output');
    }
    return {...item,baseline:work};
  });
  files.set(next.evidence.path,Buffer.from(product.bytes));
  files.set('continuity.json',encode({...prior.continuity,deliveries:updated}));
  const taskName=`tasks/${current.slice}.md`;
  const relative=name=>taskRelative(context,current.slice,name);
  const paths=names=>names.length?names.map(name=>`- \`${relative(name)}\``).join('\n'):'- none';
  const records=items=>items.length?items.map(item=>item.recordUtf8).join('\n\n'):'- none';
  const findings=facts.latest?.all??[];
  const disposition=facts.latest?.dispositions??new Map();
  const findingBody=findings.length?findings.map(item=>[
    `### ${item.id}`,`- Severity: ${item.severity}`,`- Origin: ${item.originAttempt}`,
    `- Problem: ${serializeMarkdownScalar('Problem',item.problem,true)}`,
    `- Evidence: ${serializeMarkdownScalar('Evidence',item.evidence,true)}`,
    `- Impact: ${serializeMarkdownScalar('Impact',item.impact,true)}`,
    `- Related authority: ${serializeMarkdownScalar('Related authority',item.relatedAuthority,true)}`,
    `- Expected correction: ${serializeMarkdownScalar('Expected correction',item.expectedCorrection,true)}`,
    `- State: ${disposition.get(item.id)}`,
    ...(disposition.get(item.id)==='resolved'?[`- Resolution: ${facts.latest.record.id}`]:[]),
  ].join('\n')).join('\n\n'):'- none';
  let base='- none';
  if(facts.formalStatus==='PASS') {
    const record=facts.latest.record;
    const fields=operationalRecords(record.recordUtf8,taskName,'Validation Attempts')[0].fields;
    const scope=facts.latest.request.scope.paths;
    const state=new Map(record.testedWork.entries.map(item=>[item.path,item]));
    base=[`- Origin attempt: ${record.id}`,`- Attempt type: ${fields.Type}`,
      `- HEAD: ${fields.HEAD}`,'- Result: PASS',scope.length?'- Files:':'- Files: none',
      ...scope.map(name=>`  - \`${relative(name)}\` | ${state.get(name)?.kind==='absent'?'REMOVED':state.get(name)?.sha256}`),
      ...(!scope.length?[`- Fileless reason: ${facts.latest.request.scope.filelessReason}`]:[]),
      '- Authoritative commands:',...fields.Commands.map(([command,exit])=>
        `  - ${serializeCommand(command,'authoritative command')} | ${exit}`),
      `- Evidence summary: ${serializeMarkdownScalar('Evidence summary',fields.Evidence,true)}`].join('\n');
  }
  const status=facts.formalStatus??'pending';
  const action=rejected?'blocked':status==='PASS'?'none':status==='NEEDS_FIX' && owner.operation==='VALIDATE_SLICE'
    ?'APPLY_FINDINGS':'VALIDATE_SLICE';
  let task=Buffer.from(files.get(taskName)).toString('utf8');
  for(const [section,body] of [
    ['Continuity',`- Current validation: ${facts.persistedValidation}\n- Current evidence: ${next.evidence.path}\n- Current action: ${action}`],
    ['Changed Areas',paths(facts.verifiedChanges)],['Corrections Applied',paths(facts.verifiedCorrections)],
    ['Implementation Test Evidence',records(facts.records.implementation)],
    ['Findings Test Evidence',records(facts.records.findings)],
    ['Validation Attempts',records(facts.records.validation)],['Validation Findings',findingBody],
    ['Delegation Blocker',rejected?`- Operation: ${owner.operation}\n- State: active`:'- none'],['Effective Validation Base',base],
    ['Diff Summary',rejected?`- Initial ${owner.operation} retained a concluded rejection without incorporating an unverified check.`
      :`- Initial ${owner.operation} verified ${facts.verifiedChanges.length} approved product path(s).`],
    ['Final Result',status==='PASS'?'- PASS':'- pending'],
  ]) task=postSection(task,section,body);
  files.set(taskName,utf8(task));
  files.set('tasks.md',postIndex(Buffer.from(files.get('tasks.md')).toString('utf8'),current.slice,status));
  validateCurrentCandidate({files});
  return {files,transition:{deliveryId,slice:current.slice,operationAttemptId:owner.operationAttemptId,
    originActivationId:a0.activationId,outcome:product.outcome,normalization,
    counters:next.counters},
    consumedInvocations:rounds.length,replayed:false};
}
