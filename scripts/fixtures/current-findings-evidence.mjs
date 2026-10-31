import {createHash} from 'node:crypto';
import {AUTHORITY,CONTEXT,OWNER,PRODUCT,TASK,TARGET,COMMAND,RECIPE,RESOLVED,manifest,nativeRound} from './current-initial-evidence.mjs';
import {validationOwner,finding,request as formalRequest,capture as formalCapture} from './current-validation-evidence.mjs';

const ordinal=(a,b)=>a<b?-1:a>b?1:0;
const canonical=value=>value===null || typeof value==='boolean' || typeof value==='number' ? String(value)
  : typeof value==='string' ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value).sort(ordinal).map(key=>`${canonical(key)}:${canonical(value[key])}`).join(',')}}`;
export const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
export const encode=value=>Uint8Array.from(Buffer.from(JSON.stringify(value)+'\n'));
export const decode=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
export const canonicalBytes=value=>Buffer.from(canonical(value)+'\n');
export const APPLY_OWNER={...structuredClone(OWNER),operation:'APPLY_FINDINGS',
  operationAttemptId:'00000010-0000-4000-8000-000000000010',
  ownershipToken:'00001010-0000-4000-8000-000000001010'};
export function needsFixBase({transport='native',extraFindings=[]}={}) {
  const capInitial=nativeRound();
  const initialRecord=authoredCheck(capInitial,'implementation-check-01',initialGolden(capInitial));
  const initialBase=authoredBundle({implementation:[initialRecord],captures:[capInitial],
    counters:{implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0}});
  const owner=validationOwner(1);
  const asked=formalRequest({baseBytes:initialBase.bytes,counters:initialBase.counters,owner});
  const created=[finding(1,1),...extraFindings];
  const references=created.map(item=>item.id).join(', ');
  const {cap}=formalCapture({transport,request:asked,status:'NEEDS_FIX',newFindings:created,
    findingReferences:references,findingDispositions:created.map(item=>`${item.id}=active`).join(', ')});
  const record=authoredFormal(cap);
  return authoredBundle({implementation:[initialRecord],validation:record,openFindings:created,
    captures:[capInitial,cap],counters:{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:created.length}});
}
export function applyOwner(number=10) {
  return {...structuredClone(APPLY_OWNER),operationAttemptId:`${String(number).padStart(8,'0')}-0000-4000-8000-${String(number).padStart(12,'0')}`,
    ownershipToken:`${String(number+1000).padStart(8,'0')}-0000-4000-8000-${String(number+1000).padStart(12,'0')}`};
}
export function applyPayload(round,status='TESTS_PASS',exit=0,active=['finding-01']) {
  return {status,automaticCheckRound:`${round}/3`,head:'0123456789abcdef',
    discoverySources:'Read current finding and reviewed recipe.',discoveryActions:'Inspected pay source and captured command.',
    verificationTypesConsidered:'Direct node check.',nonApplicabilityRationale:'none',
    noVerificationCommandConfirmation:'Recipe command was executed.',commands:[{command:COMMAND,exit}],
    resultOfEachCommandAndExitCode:`${COMMAND} exit ${exit}`,selectedChecks:'verification-01',
    selectionRationale:'Checks the reported pay behavior.',coverage:'Pay output and settings input.',
    findingsVerified:active[0]??'none',correctionsCovered:'Corrected pay source in approved area.',
    regressionsSelected:'Selected direct pay regression.',
    unsupportedActiveFindings:active.slice(1).join(', ')||'none',
    failures:status==='TESTS_FAIL'?'Pay check failed.':'none',
    evidenceOrFailureSummary:'Captured direct recipe check output.',affectedFilesOrBehaviors:'src/pay.mjs',
    blockers:status==='BLOCKED'?'Verification dependency unavailable.':'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'Retain current findings check.'};
}
export function applyRequest(base,owner,round,previousCheck=null,scopePaths=['src/pay.mjs']) {
  return {format:'stnl-current-findings-request-v1',owner:structuredClone(owner),authority:structuredClone(AUTHORITY),
    base:{evidenceSha256:hash(base.bytes),counters:structuredClone(base.counters),
      validation:{id:base.bundle.validation.id,recordSha256:hash(canonicalBytes(base.bundle.validation))},
      openFindings:structuredClone(base.bundle.openFindings),priorScopePaths:['src/pay.mjs']},
    round,checkId:`findings-check-${String(base.counters.findingsChecks+round).padStart(2,'0')}`,
    previousCheck,scopePaths:[...scopePaths]};
}
function updateTransport(cap,owner,round,rawResponse,status,transport) {
  if (transport==='native') {
    const origin=decode(cap.origin);
    Object.assign(origin,{owner:structuredClone(owner),dispatchId:'dispatch-findings',attempt:round,verification:structuredClone(RESOLVED)});
    cap.origin=encode(origin);cap.dispatch=encode(origin);
    const agentId=`agent-findings-${round}`;
    const agent=decode(cap.agentBinding);agent.agentId=agentId;cap.agentBinding=encode(agent);
    const claim=decode(cap.agentClaim);claim.agentId=agentId;claim.owner=structuredClone(owner);cap.agentClaim=encode(claim);
    cap.concludedToolResult=encode({agentId,status:'completed',finalResponse:Buffer.from(rawResponse).toString('utf8')});
    const receipt=decode(cap.receipt);
    Object.assign(receipt,{owner:structuredClone(owner),operation:'APPLY_FINDINGS',threadId:agentId,
      semanticResponseSha256:hex(rawResponse),semanticResponseStatus:status});
    cap.receipt=encode(receipt);
  } else {
    const context=decode(cap.managedContext);
    Object.assign(context,{owner:structuredClone(owner),operation:'APPLY_FINDINGS',
      legalOperations:[{operation:'APPLY_FINDINGS',slice:owner.slice}]});
    cap.managedContext=encode(context);
    const active=decode(cap.active);active.operation='APPLY_FINDINGS';
    active.officialPreflight.owner=structuredClone(owner);active.officialPreflight.operation='APPLY_FINDINGS';
    cap.active=encode(active);
    const started=decode(cap.started);Object.assign(started,{owner:structuredClone(owner),operation:'APPLY_FINDINGS'});
    cap.started=encode(started);
    const receipt=decode(cap.receipt);
    const stem=`007-apply_findings-${owner.slice}-attempt-${round}`;
    Object.assign(receipt,{owner:structuredClone(owner),operation:'APPLY_FINDINGS',
      receiptFile:`/tmp/pay-managed/${stem}.receipt.json`,eventsPath:`/tmp/pay-managed/${stem}.events.jsonl`,
      semanticResponseFile:`/tmp/pay-managed/${stem}.response.json`,
      semanticResponseSha256:hex(rawResponse),semanticResponseStatus:status});
    cap.receipt=encode(receipt);
    cap.events=Uint8Array.from(Buffer.from([
      {operationId:`runner-${stem}`,type:'thread.started',thread_id:receipt.threadId},
      {operationId:`runner-${stem}`,type:'turn.started'},
      {operationId:`runner-${stem}`,type:'item.completed',item:{type:'agent_message',text:Buffer.from(rawResponse).toString('utf8')}},
      {operationId:`runner-${stem}`,type:'turn.completed'},
    ].map(JSON.stringify).join('\n')+'\n'));

  }
}
export function applyCapture({base,owner=applyOwner(),round=1,previousCheck=null,transport='native',
  status='TESTS_PASS',exit=0,before=manifest(round),after=manifest(round+1),result=null}={}) {
  const cap=transport==='native' ? nativeRound(round,status,exit) : managedPrefix(round,status,exit);
  const request=applyRequest(base,owner,round,previousCheck);
  cap.applyRequest=encode(request);
  const payload=result??applyPayload(round,status,exit,base.bundle.openFindings.map(item=>item.id));
  const response={format:'stnl-current-findings-response-v1',requestSha256:hash(cap.applyRequest),result:payload};
  cap.rawResponse=encode(response);
  const baseline=decode(cap.baselineCapture);baseline.owner=structuredClone(owner);baseline.manifest=structuredClone(before);
  cap.baselineCapture=encode(baseline);
  const observed=decode(cap.verificationObservation);
  Object.assign(observed,{owner:structuredClone(owner),before:structuredClone(after),after:structuredClone(after),
    recipe:structuredClone(RECIPE),resolved:structuredClone(RESOLVED)});
  observed.checks[0].request=structuredClone(RESOLVED.checks[0]);observed.checks[0].command=COMMAND;observed.checks[0].exit=exit;
  cap.verificationObservation=encode(observed);
  const receipt=decode(cap.receipt);
  receipt.verification=observed;receipt.testedState={workspace:PRODUCT,sourceTaskPath:TASK,
    entries:[{path:TARGET,value:after.entries.find(item=>item.path==='src/pay.mjs').sha256}]};
  cap.receipt=encode(receipt);
  updateTransport(cap,owner,round,cap.rawResponse,status,transport);
  return {cap,request,response};
}
export function roundLink(cap) {
  const sha=key=>hash(cap[key]);
  const ordered=key=>cap[key].map(hash).sort(ordinal);
  const link={format:'stnl-current-findings-round-link-v1',transport:cap.transport,
    applyRequest:sha('applyRequest'),rawResponse:sha('rawResponse'),receipt:sha('receipt'),
    baselineCapture:sha('baselineCapture'),verificationObservation:sha('verificationObservation'),
    removalProofs:ordered('removalProofs'),
    ...(cap.transport==='native' ? {origin:sha('origin'),dispatch:sha('dispatch'),agentBinding:sha('agentBinding'),
      agentClaim:sha('agentClaim'),concludedToolResult:sha('concludedToolResult')}
      : {managedContext:sha('managedContext'),active:sha('active'),started:sha('started'),
        events:sha('events'),runtimeIdentity:ordered('runtimeIdentity')}),
  };
  return hash(canonicalBytes(link));
}
export function closeManaged(rounds,closedAt='2026-10-14T12:00:00.000Z') {
  const last=rounds.at(-1),receipt=decode(last.receipt),active=decode(last.active);
  const identity={workspace:active.workspace,tmpdir:active.tmpdir,operation:active.operation,
    sequence:active.sequence,slice:active.slice};
  const supervisor={...identity,pending:false,requestsHandled:rounds.length,
    capturedReceipts:rounds.filter(cap=>decode(cap.receipt).status==='RUNNER_RESPONSE_CAPTURED').length,
    errors:[],cancelledPending:false,closedAt};
  const latest={...identity,authority:AUTHORITY.context.requirementsAuthority,
    requestId:`request-${receipt.attempt}`,payloadSha256:hex(Buffer.from('prompt')),receipt};
  for (const cap of rounds) {cap.closedSupervisor=encode(supervisor);cap.latest=encode(latest);}
}
export function rebindRaw(cap,rawResponse) {
  cap.rawResponse=typeof rawResponse==='string' ? Uint8Array.from(Buffer.from(rawResponse)) : encode(rawResponse);
  const receipt=decode(cap.receipt);receipt.semanticResponseSha256=hex(cap.rawResponse);cap.receipt=encode(receipt);
  if (cap.transport==='native') {
    const tool=decode(cap.concludedToolResult);tool.finalResponse=Buffer.from(cap.rawResponse).toString('utf8');cap.concludedToolResult=encode(tool);
  } else {
    const lines=Buffer.from(cap.events).toString('utf8').trimEnd().split('\n').map(JSON.parse);
    lines.find(item=>item.item?.type==='agent_message').item.text=Buffer.from(cap.rawResponse).toString('utf8');
    cap.events=Uint8Array.from(Buffer.from(lines.map(JSON.stringify).join('\n')+'\n'));
    if (cap.latest) {const latest=decode(cap.latest);latest.receipt=receipt;cap.latest=encode(latest);}
  }
}
export const INPUT={context:CONTEXT,authority:AUTHORITY};

// Temporal fixture: no supervisor or latest object is constructed here. Those
// future bytes are first created by closeManaged after successor requests exist.
function managedPrefix(round,status,exit) {
  const native=nativeRound(round,status,exit),receiptNative=decode(native.receipt);
  const tmpdir='/tmp/pay-managed',sequence=7;
  const identity={workspace:PRODUCT,tmpdir,operation:'EXECUTE_SLICE',sequence,slice:'slice-01'};
  const roles={adapter:['agents/codex/runtime/validation-runner.mjs','adapter\n','755'],
    bridge:['agents/codex/runtime/managed-runner-bridge.mjs','bridge\n','644'],
    preflight:['agents/codex/runtime/managed-slice-preflight.mjs','preflight\n','644'],
    evidenceSerializer:['skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs','serializer\n','644'],
    runnerResultContract:['skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs','contract\n','644']};
  const context={version:4,owner:OWNER,expectedActivationId:OWNER.originActivationId,
    operation:'EXECUTE_SLICE',slice:'slice-01',specPath:CONTEXT.logicalAuthorityPath,workspace:PRODUCT,state:'ready',
    authority:AUTHORITY.context.requirementsAuthority,legalOperations:[{operation:'EXECUTE_SLICE',slice:'slice-01'}],
    mandatoryRecovery:null,identity:{snapshot:{path:'/tmp/pay-snapshot',mode:'755'}}};
  for (const [role,[name,content,mode]] of Object.entries(roles))
    context.identity[role]={path:`/tmp/pay-snapshot/${name}`,sha256:hash(Buffer.from(content)),mode};
  const active={...identity,protocol:3,officialPreflight:{specPath:CONTEXT.logicalAuthorityPath,
    authority:AUTHORITY.context.requirementsAuthority,owner:OWNER,operation:'EXECUTE_SLICE',slice:'slice-01',
    exitCode:0,state:'ready'},payloadFile:`${tmpdir}/payload.json`};
  const receipt={status:'RUNNER_RESPONSE_CAPTURED',operation:'EXECUTE_SLICE',sequence,slice:'slice-01',attempt:round,
    authority:AUTHORITY.context.requirementsAuthority,owner:OWNER,runnerAgent:'stnl_validation_runner',
    threadId:`thread-pay-${round}`,receiptFile:'replaced',eventsPath:'replaced',
    verification:receiptNative.verification,semanticResponseFile:'replaced',
    semanticResponseSha256:hex(native.rawResponse),semanticResponseStatus:status,captureFailure:null,
    captureFailureCode:null,testedState:receiptNative.testedState,formatRepair:null,automaticCheckRound:`${round}/3`,
    providerError:null,error:null,processError:null,exitCode:0};
  return {transport:'managed',rawResponse:native.rawResponse,receipt:encode(receipt),
    baselineCapture:native.baselineCapture,verificationObservation:native.verificationObservation,removalProofs:[],
    managedContext:encode(context),active:encode(active),started:encode({operation:'EXECUTE_SLICE',sequence,
      slice:'slice-01',attempt:round,authority:AUTHORITY.context.requirementsAuthority,owner:OWNER}),
    events:Buffer.from(''),runtimeIdentity:Object.values(roles).map(([,content])=>Buffer.from(content))
      .sort((a,b)=>ordinal(hash(a),hash(b)))};
}

// Independent assembly: caller declares records/roots/counters explicitly.
// No producer, validator, runtime serializer or runtime retention algorithm is
// imported by this fixture. Capsule hashes use only crypto and literal schemas.
export function authoredSources(cap) {
  const objects=new Map(),text=bytes=>Buffer.from(bytes).toString('utf8');
  const add=bytes=>{const id=hash(bytes);objects.set(id,{id,bytesBase64:Buffer.from(bytes).toString('base64')});return id;};
  const formal=!!cap.validationRequest,apply=!!cap.applyRequest;
  const sources={transport:cap.transport,rawResponse:add(cap.rawResponse),receipt:add(cap.receipt),
    verificationObservation:cap.verificationObservation===null?null:add(cap.verificationObservation),
    removalProofs:cap.removalProofs.map(add).sort(ordinal),legacyPreparation:null};
  if (cap.transport==='native') Object.assign(sources,{
    origin:add(canonicalBytes({format:formal?'stnl-native-validation-origin-bundle-v1'
      :apply?'stnl-native-findings-origin-bundle-v1':'stnl-native-origin-bundle-v1',
      originUtf8:text(cap.origin),dispatchUtf8:text(cap.dispatch),baselineUtf8:text(cap.baselineCapture),
      ...(formal?{validationRequestUtf8:text(cap.validationRequest)}:apply?{applyRequestUtf8:text(cap.applyRequest)}:{})})),
    agentBinding:add(canonicalBytes({format:'stnl-native-agent-bundle-v1',agentUtf8:text(cap.agentBinding),claimUtf8:text(cap.agentClaim)})),
    concludedToolResult:add(cap.concludedToolResult)});
  else Object.assign(sources,{
    started:add(canonicalBytes({format:formal?'stnl-managed-validation-start-bundle-v1'
      :apply?'stnl-managed-findings-start-bundle-v1':'stnl-managed-start-bundle-v1',
      contextUtf8:text(cap.managedContext),activeUtf8:text(cap.active),startedUtf8:text(cap.started),baselineUtf8:text(cap.baselineCapture),
      ...(formal?{validationRequestUtf8:text(cap.validationRequest)}:apply?{applyRequestUtf8:text(cap.applyRequest)}:{})})),
    events:add(cap.events),closedSupervisor:add(canonicalBytes({format:'stnl-managed-close-bundle-v1',
      supervisorUtf8:text(cap.closedSupervisor),latestUtf8:text(cap.latest)})),
    runtimeIdentity:cap.runtimeIdentity.map(add).sort(ordinal)});
  return {sources,objects:[...objects.values()]};
}
export function authoredCheck(cap,id,recordUtf8,authority=AUTHORITY) {
  const {ownershipToken,...identity}=decode(cap.baselineCapture).owner;
  const receipt=decode(cap.receipt);
  const dispatchId=cap.transport==='native'?decode(cap.origin).dispatchId
    :`${identity.operationAttemptId}:${receipt.sequence}`;
  return {kind:id.startsWith('attempt-')?'validation':id.startsWith('findings-')?'findings-check':'implementation-check',
    recordFormat:'stnl-task-record-v2',id,origin:{...identity,transport:cap.transport,dispatchId,runnerId:receipt.threadId},
    contract:{delivery:structuredClone(authority.delivery),context:structuredClone(authority.context),terminal:null,
      recipe:structuredClone(authority.delivery.verificationRecipe)},recordUtf8,
    testedWork:decode(cap.verificationObservation).after,sources:authoredSources(cap).sources};
}
export function authoredBundle({implementation=[],findingsChecks=[],validation=null,openFindings=[],support=[],captures=[],counters,
  authority=AUTHORITY,objects=[]}) {
  const pool=new Map([...objects,...captures.flatMap(cap=>authoredSources(cap).objects)].map(item=>[item.id,item]));
  const roots=[...implementation,...findingsChecks,...support,...(validation?[validation]:[])];
  const ids=new Set(roots.flatMap(record=>Object.entries(record.sources).flatMap(([name,value])=>
    name==='transport'||value===null?[]:Array.isArray(value)?value:[value])));
  const bundle={format:'stnl-current-evidence-v1',deliveryId:OWNER.deliveryId,slice:OWNER.slice,
    logicalTaskPath:'tasks/slice-01.md',currentAuthoritySha256:hash(Buffer.concat([
      Buffer.from('stnl-ec1/delivery/v1'),Buffer.from([0]),canonicalBytes(authority.delivery).subarray(0,-1)])),
    implementation,findingsChecks,validation,openFindings,openDivergences:[],support,
    objects:[...ids].sort(ordinal).map(id=>{if(!pool.has(id))throw new Error(`oracle missing ${id}`);return pool.get(id);})};
  const bytes=canonicalBytes(bundle);return {bundle,bytes,counters:structuredClone(counters),sha256:hash(bytes)};
}
export function formalGolden(cap) {
  const request=decode(cap.validationRequest),result=decode(cap.rawResponse).result,owner=request.owner;
  return [`### ${request.attemptId}`,`- Delivery ID: ${owner.deliveryId}`,
    `- Preparation revision: ${owner.preparationRevision}`,`- Local revision: ${owner.localRevision}`,
    `- Normative sha256: ${owner.normativeSha256}`,`- Operation attempt ID: ${owner.operationAttemptId}`,
    `- Origin activation ID: ${owner.originActivationId}`,
    `- Type: ${request.attemptId==='attempt-01'?'initial':'revalidation'}`,`- Status: ${result.status}`,
    `- HEAD: ${result.head}`,`- Verified scope: ${request.scope.paths.map(name=>'../../../../'+name).join(', ')||'fileless task state'}`,
    '- Commands:',...result.commands.map(item=>`  - \`${item.command}\` | exit:${item.exit}`),
    `- Evidence: ${result.evidence}`,`- Finding references: ${result.findingReferences}`,
    `- Finding dispositions: ${result.findingDispositions}`,`- Blockers: ${result.blockers}`,
    `- Unexpected workspace effects: ${result.unexpectedWorkspaceEffects}`,`- Persistence summary: ${result.persistenceSummary}`].join('\n');
}
export const authoredFormal=(cap,authority=AUTHORITY)=>authoredCheck(cap,decode(cap.validationRequest).attemptId,formalGolden(cap),authority);
export function initialGolden(cap,correctionPaths=[]) {
  const result=decode(cap.rawResponse),owner=decode(cap.baselineCapture).owner;
  const receipt=decode(cap.receipt),round=receipt.attempt;
  const scope=receipt.testedState.entries.map(item=>item.path).join(', ')||result.filelessReason;
  const lines=[`### implementation-check-${String(round).padStart(2,'0')}`,`- Automatic check round: ${round}/3`,
    `- Status: ${result.status}`,`- HEAD: ${result.head}`,`- Tested scope: ${scope}`,
    `- Delivery ID: ${owner.deliveryId}`,`- Preparation revision: ${owner.preparationRevision}`,
    `- Local revision: ${owner.localRevision}`,`- Normative sha256: ${owner.normativeSha256}`,
    `- Operation attempt ID: ${owner.operationAttemptId}`,`- Origin activation ID: ${owner.originActivationId}`,
    ...(receipt.testedState.entries.length?['- Tested state:',...receipt.testedState.entries.map(item=>`  - \`${item.path}\` | ${item.value}`)]
      :['- Tested state: none',`- Fileless reason: ${result.filelessReason}`]),
    '- Commands:',...result.commands.map(item=>`  - \`${item.command}\` | exit:${item.exit}`),
    `- Discovery sources: ${result.discoverySources}`,`- Discovery actions: ${result.discoveryActions}`,
    `- Verification types considered: ${result.verificationTypesConsidered}`,`- Non-applicability rationale: ${result.nonApplicabilityRationale}`,
    `- No verification-command confirmation: ${result.noVerificationCommandConfirmation}`,
    `- Selected checks: ${result.selectedChecks}`,`- Selection rationale: ${result.selectionRationale}`,
    `- Coverage: ${result.coverage}`,`- Failures: ${result.failures}`,`- Blockers: ${result.blockers}`,
    `- Unexpected workspace effects: ${result.unexpectedWorkspaceEffects}`,`- Persistence summary: ${result.persistenceSummary}`];
  if(round>1)lines.push(`- Prior-round failure: ${result.priorRoundFailure}`,`- Correction applied: ${result.correctionApplied}`,
    `- Correction paths: ${correctionPaths.join(', ')||'none'}`,`- Updated scope: ${scope}`,`- In-slice rationale: ${result.inSliceRationale}`);
  return lines.join('\n');
}
export function findingsGolden(cap,{corrections=[TARGET],roundCorrections=[],priorFailure=null}={}) {
  const request=decode(cap.applyRequest),result=decode(cap.rawResponse).result,owner=request.owner;
  const receipt=decode(cap.receipt),entries=receipt.testedState.entries;
  const scope=request.scopePaths.map(name=>'../../../../'+name).join(', ')||result.filelessReason;
  const lines=[`### ${request.checkId}`,`- Automatic check round: ${request.round}/3`,`- Status: ${result.status}`,
    `- HEAD: ${result.head}`,`- Tested scope: ${scope}`,`- Delivery ID: ${owner.deliveryId}`,
    `- Preparation revision: ${owner.preparationRevision}`,`- Local revision: ${owner.localRevision}`,
    `- Normative sha256: ${owner.normativeSha256}`,`- Operation attempt ID: ${owner.operationAttemptId}`,
    `- Origin activation ID: ${owner.originActivationId}`,
    ...(entries.length?['- Tested state:',...entries.map(item=>`  - \`${item.path}\` | ${item.value}`)]
      :['- Tested state: none',...(request.scopePaths.length?[]:[`- Fileless reason: ${result.filelessReason}`])]),
    '- Commands:',...result.commands.map(item=>`  - \`${item.command}\` | exit:${item.exit}`),
    `- Discovery sources: ${result.discoverySources}`,`- Discovery actions: ${result.discoveryActions}`,
    `- Verification types considered: ${result.verificationTypesConsidered}`,`- Non-applicability rationale: ${result.nonApplicabilityRationale}`,
    `- No verification-command confirmation: ${result.noVerificationCommandConfirmation}`,
    `- Selected checks: ${result.selectedChecks}`,`- Selection rationale: ${result.selectionRationale}`,
    `- Coverage: ${result.coverage}`,`- Failures: ${result.failures}`,`- Blockers: ${result.blockers}`,
    `- Unexpected workspace effects: ${result.unexpectedWorkspaceEffects}`,`- Persistence summary: ${result.persistenceSummary}`];
  if(request.round>1)lines.push(`- Prior-round failure: ${priorFailure}`,`- Correction applied: ${result.correctionsCovered}`,
    `- Correction paths: ${roundCorrections.join(', ')||'none'}`,`- Updated scope: ${scope}`,`- In-slice rationale: ${result.selectionRationale}`);
  lines.push(`- Findings cycle: ${request.base.validation.id}`,`- Finding IDs: ${request.base.openFindings.map(item=>item.id).join(', ')}`,
    `- Findings verified: ${result.findingsVerified}`,
    `- Corrections covered: ${request.scopePaths.length?corrections.join(', ')||'none':result.correctionsCovered}`,
    `- Regressions: ${result.regressionsSelected}`,`- Unsupported active findings: ${result.unsupportedActiveFindings}`);
  return lines.join('\n');
}
