import { createHash } from 'node:crypto';
import path from 'node:path';
import { logicalArtifactPath, parseCurrentJson, resolveLogicalProductClaim, validateCurrentEvidence } from './execution-current.mjs';
import { validateInitialImplementationEvidence } from './execution-evidence-current.mjs';
import {
  verifyCapturedInvocation, verifyWorkObservation, packCaptureSources,
  restoreCaptureSources, closeEvidenceObjects, verifyAuxiliaryWork, findingsRoundCaptureSha256,
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
  if (!['stnl-current-validation-request-v1','stnl-current-validation-request-v2'].includes(value.format)) fail('UNSUPPORTED_FORMAT','validation request format');
  owner(value.owner,'validation request owner');
  const afterFindings=value.format==='stnl-current-validation-request-v2';
  closed(value.base,['evidenceSha256','counters','openFindings','priorScopePaths',...(afterFindings?['auxiliary']:[])],'validation request base');
  token(value.base.evidenceSha256,HASH,'validation request base digest');
  counters(value.base.counters,'validation request counters');
  if (!afterFindings && value.base.counters.findingsChecks!==0) invalid('validation request v1 cannot follow findings checks');
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
  closed(value,['format','owner','authority','base','round','checkId','previousCheck','scopePaths'],'findings request');
  if (value.format !== 'stnl-current-findings-request-v1') fail('UNSUPPORTED_FORMAT','findings request format');
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
  if (value.checkId!==id('findings-check',value.base.counters.findingsChecks+value.round)) invalid('findings request check ID');
  if (value.round===1) {
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
    if (expectedBase.auxiliary === null ? request.format !== 'stnl-current-validation-request-v1'
      : request.format !== 'stnl-current-validation-request-v2') invalid('validation request version does not match current auxiliary');
    if (expectedBase.auxiliary !== null) equal(request.base.auxiliary,expectedBase.auxiliary,'EVIDENCE_STALE','validation request auxiliary');
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
function deriveApplyCycle({context,authority:approvedAuthority,owner:expectedOwner,rounds,baseFacts,store}) {
  dense(rounds,'findings rounds',1,3);
  rounds.forEach((cap,index)=>plain(cap,`round ${index+1} capture`));
  const transport=rounds[0].transport;
  if (!['native','managed'].includes(transport)) fail('UNSUPPORTED_FORMAT','findings transport');
  const checks=[]; let rejection=null; let lastStatus=null; let previousCap=null; let previousWork=null;
  let previousScope=[]; let firstWork=null; let dispatchId=null; const runners=new Set();
  const receipts=[]; const managed=[]; const witnesses=new Set(baseFacts.removalPaths??[]);
  for (const [index,cap] of rounds.entries()) {
    const round=index+1;
    verifyCapturedInvocation('current-findings',cap,undefined,undefined,undefined,round,transport);
    const request=jsonBytes(cap.applyRequest,`round ${round} findings request`).value;
    applyRequestShape(request);
    authority(request.authority,context,request.owner,'APPLY_FINDINGS');
    equal(request.authority,approvedAuthority,'EVIDENCE_STALE',`round ${round} authority`);
    if (expectedOwner) equal(request.owner,expectedOwner,'OWNER_MISMATCH',`round ${round} owner`);
    if (round>1 && lastStatus!=='TESTS_FAIL') invalid(`round ${round}: prior round did not fail`);
    if (request.round!==round || cap.transport!==transport) mismatch(`round ${round}: request/transport differs`);
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
    const envelope=applyEnvelope(rawText,cap.applyRequest,receipt,transport,round);
    const work=verifyAuxiliaryWork('current-findings',{context,authority:approvedAuthority,owner:request.owner,round,
      capture:cap,receipt,priorScopePaths:baseFacts.priorScopePaths,previousScopePaths:previousScope,
      previousAfter:previousWork?.observed?.after??null,witnessedRemovals:[...witnesses].sort(ordinal),
      status:envelope.payload?.status??receipt.semanticResponseStatus});
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
        consumedInvocations:round,round,sources:packCaptureSources('current-findings',cap,store)};
      lastStatus='rejected';
    } else {
      const payload=envelope.payload;
      for (const name of [...witnesses]) if (work.observed.after.entries.some(entry=>entry.path===name && entry.kind!=='absent')) witnesses.delete(name);
      for (const name of work.removed) witnesses.add(name);
      const record={kind:'findings-check',recordFormat:'stnl-task-record-v2',id:request.checkId,
        origin:applyOrigin(request.owner,transport,transportInfo),
        contract:{delivery:approvedAuthority.delivery,context:approvedAuthority.context,terminal:null,recipe:approvedAuthority.delivery.verificationRecipe},
        recordUtf8:findingsRecord(request,payload,work,context,previousWork?.payload?.failures??null,firstWork),
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
  if (!rejection && !['TESTS_PASS','BLOCKED'].includes(lastStatus)
    && !(lastStatus==='TESTS_FAIL' && rounds.length===3)) incomplete('findings cycle is an incomplete FAIL prefix');
  const owner=jsonBytes(rounds[0].applyRequest,'first findings request').value.owner;
  return {checks,rejection,owner,transport,status:lastStatus,auxiliaryStatus:previousWork?.payload.status??null,
    lastWork:previousWork?.observed?.after??null,lastScope:previousScope,witnesses:[...witnesses].sort(ordinal),
    filelessReason:previousWork?.payload.filelessReason??null,
    consumedInvocations:rounds.length};
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
function historicalFormal(record,map,context,approvedAuthority) {
  const request=requestForRecord(record,map);
  requestShape(request);
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
function inspectFindings(original,bundle,context,approvedAuthority,declaredCounters,observedWork) {
  if (bundle.openDivergences.length || bundle.currentAuthoritySha256!==projectedDelivery(approvedAuthority.delivery)) invalid('findings bundle authority/divergence');
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
  const formals=new Map(formalRecords.map(record=>[record.id,historicalFormal(record,map,context,approvedAuthority)]));
  const admission=formals.get(first.base.validation.id);
  if (!admission) incomplete('findings admission formal absent');
  if (admission.payload.status!=='NEEDS_FIX') invalid('findings admission formal is not NEEDS_FIX');
  const admissionCounters=formalCounters(admission);
  const retained=inspectRetainedRemovalCycles(bundle,map,context,approvedAuthority,admissionCounters);
  const facts={sha256:first.base.evidenceSha256,counters:admissionCounters,
    validation:{id:admission.record.id,recordSha256:raw(encode(formalRecords.find(item=>item.id===admission.record.id)))},
    openFindings:admission.open,priorScopePaths:admission.request.scope.paths,
    testedWork:admission.record.testedWork,removalPaths:literalRemovalPaths(rounds,admission.record.testedWork,context)};
  const cycle=deriveApplyCycle({context,authority:approvedAuthority,rounds,baseFacts:facts,store:closeEvidenceObjects()});
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
    if (request.format!=='stnl-current-validation-request-v2') invalid('formal after findings requires request v2');
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
function inspect(bundleBytes,context,approvedAuthority,declaredCounters,observedWork,allowInitial=false) {
  const original=copyBytes(bundleBytes,'bundleBytes');
  const bundle=jsonBytes(original,'bundleBytes').value;
  validateCurrentEvidence(bundle);
  if ([...bundle.implementation,...bundle.findingsChecks,...bundle.support,...(bundle.validation?[bundle.validation]:[])]
    .some(record=>record.recordFormat==='stnl-task-record-v1-imported')) fail('MIGRATION_REQUIRED','imported evidence requires conversion');
  verifyWorkObservation('current-validation',{observedWork});
  if (bundle.findingsChecks.length || bundle.support.some(item=>item.kind==='rejection' && item.origin.operation==='APPLY_FINDINGS'))
    return inspectFindings(original,bundle,context,approvedAuthority,declaredCounters,observedWork);
  if (bundle.findingsChecks.length || bundle.openDivergences.length || bundle.currentAuthoritySha256!==projectedDelivery(approvedAuthority.delivery)) invalid('bundle formal authority/unsupported records');
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
function formalOrigins(records,all,latestId) {
  const ids=new Set(all.map(item => item.originAttempt).filter(item => item!==latestId));
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
