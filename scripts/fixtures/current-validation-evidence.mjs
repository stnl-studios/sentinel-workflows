import {createHash} from 'node:crypto';
import path from 'node:path';
import {AUTHORITY, CONTEXT, OWNER, RESOLVED, COMMAND, manifest,
  nativeRound, managedRound, TARGET, PRODUCT, TASK} from './current-initial-evidence.mjs';

const hash=bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hex=bytes => createHash('sha256').update(bytes).digest('hex');
const encode=value => Uint8Array.from(Buffer.from(JSON.stringify(value)+'\n'));
const decode=bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const ordinal=(a,b)=>a<b?-1:a>b?1:0;
export const EXPECTED_INITIAL_COUNTERS=Object.freeze({implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0});
export const EXPECTED_FIRST_COUNTERS=Object.freeze({implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:0});
export const INITIAL_SCOPE=Object.freeze(['src/pay.mjs']);
export const FILENAME='/tmp/l23-path-deliberately-absent';
export function validationOwner(number=1) {
  return {...structuredClone(OWNER),operation:'VALIDATE_SLICE',
    operationAttemptId:`${String(number).padStart(8,'0')}-0000-4000-8000-${String(number).padStart(12,'0')}`,
    ownershipToken:`${String(number+1000).padStart(8,'0')}-0000-4000-8000-${String(number+1000).padStart(12,'0')}`};
}
export function finding(number,attempt=1,severity='blocking') {
  const id=`finding-${String(number).padStart(2,'0')}`;
  return {id,severity,originAttempt:`attempt-${String(attempt).padStart(2,'0')}`,
    problem:`${id} pay behavior differs from AC-001`,evidence:`${id} observed command output`,
    impact:`${id} acceptance is affected`,relatedAuthority:'AC-001',
    expectedCorrection:`${id} correct pay behavior`};
}
export function payload(status='PASS',findingReferences='none',findingDispositions='none',exit=0) {
  return {status,head:'0123456789abcdef',commands:[{command:COMMAND,exit}],
    evidence:'Direct recipe observation and file hash.',findingReferences,findingDispositions,
    blockers:status==='BLOCKED' ? 'Observed verification dependency unavailable.' : 'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'Current record retained.'};
}
export function request({baseBytes,counters=EXPECTED_INITIAL_COUNTERS,openFindings=[],priorScopePaths=INITIAL_SCOPE,
  owner=validationOwner(),scopePaths=INITIAL_SCOPE,filelessReason=null,authority=AUTHORITY}) {
  return {format:'stnl-current-validation-request-v1',owner:structuredClone(owner),authority:structuredClone(authority),
    base:{evidenceSha256:hash(baseBytes),counters:structuredClone(counters),openFindings:structuredClone(openFindings),
      priorScopePaths:[...priorScopePaths]},
    attemptId:`attempt-${String(counters.validationAttempts+1).padStart(2,'0')}`,
    scope:{paths:[...scopePaths],filelessReason}};
}
function setOwner(doc,owner) {
  if (Object.hasOwn(doc,'owner')) doc.owner=structuredClone(owner);
  return doc;
}
function updateNative(cap,owner,rawResponse,semanticStatus,resolved) {
  const origin=setOwner(decode(cap.origin),owner);
  origin.attempt=1; origin.dispatchId=`dispatch-validation-${owner.operationAttemptId}`;
  origin.verification=structuredClone(resolved);
  origin.workspace=PRODUCT; origin.specPath=CONTEXT.logicalAuthorityPath;
  const root=`${FILENAME}-native-${owner.operationAttemptId}`;
  const originFile=`${root}/round-1.origin.json`;
  const agentId=`agent-validation-${owner.operationAttemptId}`;
  cap.origin=encode(origin); cap.dispatch=encode({...origin});
  cap.agentBinding=encode({agentId,originFile});
  cap.agentClaim=encode({agentId,originFile,owner:structuredClone(owner)});
  cap.concludedToolResult=encode({agentId,status:'completed',finalResponse:Buffer.from(rawResponse).toString('utf8')});
  const receipt=setOwner(decode(cap.receipt),owner);
  Object.assign(receipt,{transport:'native',originFile,operation:'VALIDATE_SLICE',attempt:1,threadId:agentId,
    receiptFile:`${root}/round-1.receipt.json`,semanticResponseFile:`${root}/round-1.response.json`,
    semanticResponseSha256:hex(rawResponse),semanticResponseStatus:semanticStatus});
  cap.receipt=encode(receipt);
}
function updateManaged(cap,owner,rawResponse,semanticStatus) {
  const context=setOwner(decode(cap.managedContext),owner);
  context.operation='VALIDATE_SLICE';
  context.legalOperations=[{operation:'VALIDATE_SLICE',slice:owner.slice}];
  cap.managedContext=encode(context);
  const active=decode(cap.active);
  active.operation='VALIDATE_SLICE'; active.tmpdir=`${FILENAME}-managed-${owner.operationAttemptId}`;
  setOwner(active.officialPreflight,owner); active.officialPreflight.operation='VALIDATE_SLICE';
  cap.active=encode(active);
  const started=setOwner(decode(cap.started),owner);
  started.operation='VALIDATE_SLICE'; cap.started=encode(started);
  const receipt=setOwner(decode(cap.receipt),owner);
  const stem=`007-validate_slice-${owner.slice}-attempt-1`;
  Object.assign(receipt,{operation:'VALIDATE_SLICE',receiptFile:`${active.tmpdir}/${stem}.receipt.json`,
    eventsPath:`${active.tmpdir}/${stem}.events.jsonl`,semanticResponseFile:`${active.tmpdir}/${stem}.response.json`,
    semanticResponseSha256:hex(rawResponse),semanticResponseStatus:semanticStatus});
  delete receipt.automaticCheckRound;
  cap.receipt=encode(receipt);
  const events=[
    {operationId:`runner-${stem}`,type:'thread.started',thread_id:receipt.threadId},
    {operationId:`runner-${stem}`,type:'turn.started'},
    {operationId:`runner-${stem}`,type:'item.completed',item:{type:'agent_message',text:Buffer.from(rawResponse).toString('utf8')}},
    {operationId:`runner-${stem}`,type:'turn.completed'},
  ];
  cap.events=Uint8Array.from(Buffer.from(events.map(JSON.stringify).join('\n')+'\n'));
  const supervisor=decode(cap.closedSupervisor);
  supervisor.operation='VALIDATE_SLICE'; supervisor.tmpdir=active.tmpdir;
  supervisor.requestsHandled=1;supervisor.capturedReceipts=1;
  cap.closedSupervisor=encode(supervisor);
  const latest=decode(cap.latest);
  latest.operation='VALIDATE_SLICE';latest.tmpdir=active.tmpdir;latest.receipt=receipt;
  cap.latest=encode(latest);
}
export function capture({transport='native',request:validationRequest,status='PASS',newFindings=[],
  findingReferences='none',findingDispositions='none',exit=0,work=manifest(1),
  resolved=RESOLVED,approvedAuthority=AUTHORITY,command=COMMAND}={}) {
  if (!validationRequest) throw new Error('authored validation request required');
  const owner=validationRequest.owner;
  const cap=transport==='native' ? nativeRound() : managedRound();
  cap.validationRequest=encode(validationRequest);
  const response={format:'stnl-current-validation-response-v1',requestSha256:hash(cap.validationRequest),
    result:payload(status,findingReferences,findingDispositions,exit),newFindings:structuredClone(newFindings)};
  response.result.commands=[{command,exit}];
  const rawResponse=encode(response);
  cap.rawResponse=rawResponse;
  const baseline=setOwner(decode(cap.baselineCapture),owner);
  baseline.manifest=structuredClone(work);
  cap.baselineCapture=encode(baseline);
  const observed=decode(cap.verificationObservation);
  observed.owner=structuredClone(owner); observed.before=structuredClone(work); observed.after=structuredClone(work);
  observed.recipe=structuredClone(approvedAuthority.delivery.verificationRecipe);
  observed.resolved=structuredClone(resolved);
  observed.checks[0].request=structuredClone(resolved.checks[0]);
  observed.checks[0].command=command;observed.checks[0].exit=exit;
  cap.verificationObservation=encode(observed);
  const receipt=decode(cap.receipt);
  receipt.owner=structuredClone(owner);receipt.verification=observed;
  const scopeEntries=validationRequest.scope.paths.filter(name => work.entries.some(item => item.path===name && item.kind==='file'))
    .map(name => ({path:path.relative(path.dirname(TASK),path.join(PRODUCT,name)).split(path.sep).join('/'),
      value:work.entries.find(item=>item.path===name).sha256}))
    .sort((a,b)=>ordinal(a.path,b.path));
  receipt.testedState={workspace:PRODUCT,sourceTaskPath:TASK,entries:scopeEntries};
  cap.receipt=encode(receipt);
  if (transport==='native') updateNative(cap,owner,rawResponse,status,resolved);
  else updateManaged(cap,owner,rawResponse,status);
  return {cap,response,request:validationRequest};
}
export function rebindRaw(cap,response) {
  const rawResponse=typeof response==='string' ? Uint8Array.from(Buffer.from(response)) : encode(response);
  cap.rawResponse=rawResponse;
  const receipt=decode(cap.receipt);receipt.semanticResponseSha256=hex(rawResponse);
  if (cap.transport==='native') {
    const tool=decode(cap.concludedToolResult);tool.finalResponse=Buffer.from(rawResponse).toString('utf8');cap.concludedToolResult=encode(tool);
  } else {
    const lines=Buffer.from(cap.events).toString('utf8').trimEnd().split('\n').map(JSON.parse);
    lines.find(item=>item.item?.type==='agent_message').item.text=Buffer.from(rawResponse).toString('utf8');
    cap.events=Uint8Array.from(Buffer.from(lines.map(JSON.stringify).join('\n')+'\n'));
    const latest=decode(cap.latest);latest.receipt=receipt;cap.latest=encode(latest);
  }
  cap.receipt=encode(receipt);
}
export const ORACLE=Object.freeze({hash,hex,encode,decode});
export function filelessInitial() {
  const cap=nativeRound();
  const claim='../../../../config/settings.json';
  const recipe={format:'stnl-verification-recipe-v1',base:'workspace',cwd:'.',
    dependencyReview:'Reviewed input-only task state.',
    checks:[{id:'verification-01',executable:{literal:'node'},args:[{file:{kind:'input',path:claim}}],inputs:[{kind:'input',path:claim}]}]};
  const command='node config/settings.json';
  const resolved={format:'stnl-resolved-verification-v2',recipeSha256:hash(Buffer.from(
    JSON.stringify({base:'workspace',checks:[{args:[{file:{kind:'input',path:claim}}],executable:{literal:'node'},id:'verification-01',inputs:[{kind:'input',path:claim}]}],cwd:'.',dependencyReview:'Reviewed input-only task state.',format:'stnl-verification-recipe-v1'}))),
    checks:[{id:'verification-01',cwd:PRODUCT,executable:'node',args:['config/settings.json']}]};
  const delivery=structuredClone(AUTHORITY.delivery);delivery.verificationRecipe=recipe;
  const authority={...structuredClone(AUTHORITY),delivery};
  const work={format:'stnl-current-work-v1',entries:[
    {path:'config',kind:'directory',children:['settings.json']},
    {path:'config/settings.json',kind:'file',sha256:manifest(1).entries[1].sha256,mode:420},
    {path:'src',kind:'directory',children:[]},
  ]};
  const baseline=decode(cap.baselineCapture);baseline.manifest=work;cap.baselineCapture=encode(baseline);
  const observed=decode(cap.verificationObservation);observed.before=work;observed.after=work;
  observed.recipe=recipe;observed.resolved=resolved;observed.checks[0].request=resolved.checks[0];
  observed.checks[0].command=command;cap.verificationObservation=encode(observed);
  const origin=decode(cap.origin);origin.verification=resolved;cap.origin=encode(origin);cap.dispatch=encode(origin);
  const response=decode(cap.rawResponse);response.commands=[{command,exit:0}];
  response.resultOfEachCommandAndExitCode=`${command} exit 0`;response.filelessReason='No product output; input-only task state verified.';
  cap.rawResponse=encode(response);
  const receipt=decode(cap.receipt);receipt.testedState.entries=[];receipt.verification=observed;
  receipt.semanticResponseSha256=hex(cap.rawResponse);cap.receipt=encode(receipt);
  const tool=decode(cap.concludedToolResult);tool.finalResponse=Buffer.from(cap.rawResponse).toString('utf8');
  cap.concludedToolResult=encode(tool);
  return {cap,authority,work};
}
export function removedInitial() {
  const cap=nativeRound();
  const bytes=Buffer.from('pay-v1\n');
  const before=manifest(1);
  const after=structuredClone(before);
  after.entries[2].children=[];
  after.entries[3]={path:'src/pay.mjs',kind:'absent'};
  const baseline=decode(cap.baselineCapture);baseline.manifest=before;cap.baselineCapture=encode(baseline);
  const observed=decode(cap.verificationObservation);observed.before=after;observed.after=after;
  cap.verificationObservation=encode(observed);
  const receipt=decode(cap.receipt);receipt.verification=observed;
  receipt.testedState.entries=[{path:TARGET,value:'REMOVED'}];cap.receipt=encode(receipt);
  cap.removalProofs=[encode({format:'stnl-current-removal-proof-v1',owner:structuredClone(OWNER),round:1,
    path:'src/pay.mjs',sha256:hash(bytes),mode:420,bytesBase64:bytes.toString('base64')})];
  return {cap,work:after};
}
export function retainedRemovalInitial(nextOld='absent') {
  if (!['absent','file','directory'].includes(nextOld)) throw new Error('unsupported retained removal fixture state');
  const oldBytes=Buffer.from('old source\n');
  const first=nativeRound(1,'TESTS_FAIL',1);
  const second=nativeRound(2,'TESTS_PASS',0);
  const before=decode(first.baselineCapture).manifest;
  before.entries[2].children=['old.mjs'];
  before.entries.splice(3,0,{path:'src/old.mjs',kind:'file',sha256:hash(oldBytes),mode:420});
  const withOldAbsent=version=>{
    const work=manifest(version);
    work.entries.splice(3,0,{path:'src/old.mjs',kind:'absent'});
    return work;
  };
  const afterFirst=withOldAbsent(1), afterSecond=withOldAbsent(2);
  const replacementBytes=Buffer.from('replacement source\n');
  const childBytes=Buffer.from('nested source\n');
  if (nextOld==='file') {
    afterSecond.entries[2].children=['old.mjs','pay.mjs'];
    afterSecond.entries[3]={path:'src/old.mjs',kind:'file',sha256:hash(replacementBytes),mode:420};
  }
  if (nextOld==='directory') {
    afterSecond.entries[2].children=['old.mjs','pay.mjs'];
    afterSecond.entries[3]={path:'src/old.mjs',kind:'directory',children:['nested.mjs']};
    afterSecond.entries.splice(4,0,{path:'src/old.mjs/nested.mjs',kind:'file',sha256:hash(childBytes),mode:420});
  }
  const baseOne=decode(first.baselineCapture);baseOne.manifest=before;first.baselineCapture=encode(baseOne);
  const observationOne=decode(first.verificationObservation);
  observationOne.before=afterFirst;observationOne.after=afterFirst;first.verificationObservation=encode(observationOne);
  const receiptOne=decode(first.receipt);receiptOne.verification=observationOne;
  receiptOne.testedState.entries=[
    {path:'../../../../src/old.mjs',value:'REMOVED'},
    {path:TARGET,value:afterFirst.entries.at(-1).sha256},
  ];
  first.receipt=encode(receiptOne);
  first.removalProofs=[encode({format:'stnl-current-removal-proof-v1',owner:structuredClone(OWNER),round:1,
    path:'src/old.mjs',sha256:hash(oldBytes),mode:420,bytesBase64:oldBytes.toString('base64')})];
  const baseTwo=decode(second.baselineCapture);baseTwo.manifest=afterFirst;second.baselineCapture=encode(baseTwo);
  const observationTwo=decode(second.verificationObservation);
  observationTwo.before=afterSecond;observationTwo.after=afterSecond;second.verificationObservation=encode(observationTwo);
  const receiptTwo=decode(second.receipt);receiptTwo.verification=observationTwo;
  if (nextOld==='file') receiptTwo.testedState.entries.unshift({path:'../../../../src/old.mjs',value:hash(replacementBytes)});
  if (nextOld==='directory') receiptTwo.testedState.entries.unshift({path:'../../../../src/old.mjs/nested.mjs',value:hash(childBytes)});
  second.receipt=encode(receiptTwo);
  return {rounds:[first,second],work:afterSecond,omittedWork:manifest(2),oldPath:'src/old.mjs'};
}
