import {createHash} from 'node:crypto';

const encode = value => Uint8Array.from(Buffer.from(JSON.stringify(value) + '\n', 'utf8'));
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const rawHex = value => createHash('sha256').update(value).digest('hex');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const PRODUCT = '/workspace';
export const TASK = '/workspace/specs/pay/execution/tasks/slice-01.md';
export const TARGET = '../../../../src/pay.mjs';
export const INPUT = '../../../../config/settings.json';
export const CONTEXT = {
  logicalSpecRoot:'/workspace/specs/pay', logicalAuthorityPath:'/workspace/specs/pay/feature_spec.md',
  logicalExecutionRoot:'/workspace/specs/pay/execution', physicalExecutionRoot:'/tmp/pay-candidate', productRoot:PRODUCT,
};
export const OWNER = {
  operationAttemptId:A, ownershipToken:B, deliveryId:C, slice:'slice-01', operation:'EXECUTE_SLICE',
  preparationRevision:1, localRevision:1, normativeSha256:`sha256:${'1'.repeat(64)}`, originActivationId:D,
};
export const RECIPE = {
  format:'stnl-verification-recipe-v1', base:'workspace', cwd:'.', dependencyReview:'Reviewed the source and settings input.',
  checks:[{id:'verification-01', executable:{literal:'node'}, args:[{file:{kind:'product',path:TARGET}}], inputs:[{kind:'input',path:INPUT}]}],
};
export const DELIVERY = {
  deliveryId:C, objectiveAndObservableResult:'Pay command runs.', requirements:'- AC-001: pay command is observable.',
  includedScope:'- Build pay command.', outOfScopeAndBoundaries:'- No payment network calls.',
  authorizedAreas:`- directory: \`${'../../../../src'}\``, existingInputs:`- \`${INPUT}\``,
  protectedResponsibilities:'- Preserve settings.', dependencies:[], risksAndStrategy:'- Keep test local.',
  expectedTests:'- node src/pay.mjs', verificationRecipe:RECIPE,
  completionCriterion:'- Pay command exits zero.', taskResult:'Pay command executes.',
  obligations:[{id:'obligation-01', requirement:'AC-001', contribution:'complete', fullOwner:'slice-01',
    condition:'Command exits zero', proof:'Direct recipe observation'}],
};
// Authored EC-1 C(delivery) preimage. This is intentionally independent of the compositor.
export const DELIVERY_PREIMAGE = '{"authorizedAreas":"- directory: `../../../../src`","completionCriterion":"- Pay command exits zero.","deliveryId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","dependencies":[],"existingInputs":"- `../../../../config/settings.json`","expectedTests":"- node src/pay.mjs","includedScope":"- Build pay command.","objectiveAndObservableResult":"Pay command runs.","obligations":[{"condition":"Command exits zero","contribution":"complete","fullOwner":"slice-01","id":"obligation-01","proof":"Direct recipe observation","requirement":"AC-001"}],"outOfScopeAndBoundaries":"- No payment network calls.","protectedResponsibilities":"- Preserve settings.","requirements":"- AC-001: pay command is observable.","risksAndStrategy":"- Keep test local.","taskResult":"Pay command executes.","verificationRecipe":{"base":"workspace","checks":[{"args":[{"file":{"kind":"product","path":"../../../../src/pay.mjs"}}],"executable":{"literal":"node"},"id":"verification-01","inputs":[{"kind":"input","path":"../../../../config/settings.json"}]}],"cwd":".","dependencyReview":"Reviewed the source and settings input.","format":"stnl-verification-recipe-v1"}}';
export const AUTHORITY = {
  preparationRevision:1, localRevision:1, normativeSha256:OWNER.normativeSha256, delivery:DELIVERY,
  context:{requirementsAuthority:`sha256:${'2'.repeat(64)}`, objective:'Deliver pay command.', strategy:'One delivery.', risks:'- Local checks only.'},
};
const INPUT_HASH = hash(Buffer.from('settings=local\n'));
const FILES = ['pay-v1\n','pay-v2\n','pay-v3\n'].map(text => hash(Buffer.from(text)));
export const MANIFEST_0 = {format:'stnl-current-work-v1',entries:[
  {path:'config',kind:'directory',children:['settings.json']},
  {path:'config/settings.json',kind:'file',sha256:INPUT_HASH,mode:420},
  {path:'src',kind:'directory',children:[]},
  {path:'src/pay.mjs',kind:'absent'},
]};
export function manifest(version = 1) {
  return {format:'stnl-current-work-v1',entries:[
    {path:'config',kind:'directory',children:['settings.json']},
    {path:'config/settings.json',kind:'file',sha256:INPUT_HASH,mode:420},
    {path:'src',kind:'directory',children:['pay.mjs']},
    {path:'src/pay.mjs',kind:'file',sha256:FILES[version - 1],mode:420},
  ]};
}
export const RESOLVED = {
  format:'stnl-resolved-verification-v2',
  recipeSha256:hash(Buffer.from('{"base":"workspace","checks":[{"args":[{"file":{"kind":"product","path":"../../../../src/pay.mjs"}}],"executable":{"literal":"node"},"id":"verification-01","inputs":[{"kind":"input","path":"../../../../config/settings.json"}]}],"cwd":".","dependencyReview":"Reviewed the source and settings input.","format":"stnl-verification-recipe-v1"}')),
  checks:[{id:'verification-01',cwd:PRODUCT,executable:'node',args:['src/pay.mjs']}],
};
export const COMMAND = 'node src/pay.mjs';
export function payload(round, status = 'TESTS_PASS', exit = 0) {
  return {
    status, automaticCheckRound:`${round}/3`, head:'0123456789abcdef',
    discoverySources:'Read the approved plan and task.', discoveryActions:'Inspected pay source.',
    verificationTypesConsidered:'Direct node check.', nonApplicabilityRationale:'none',
    noVerificationCommandConfirmation:'Confirmed direct recipe only.', commands:[{command:COMMAND,exit}],
    resultOfEachCommandAndExitCode:`${COMMAND} exit ${exit}`, selectedChecks:'verification-01',
    selectionRationale:'Covers the observable delivery.', coverage:'Pay command and settings.',
    failures:status === 'TESTS_FAIL' ? 'Pay check failed.' : 'none',
    priorRoundFailure:round === 1 ? 'none' : 'Pay check failed.',
    correctionApplied:round === 1 ? 'none' : 'Updated pay source.',
    inSliceRationale:round === 1 ? 'none' : 'Correction stays in approved source.',
    evidenceOrFailureSummary:'Captured direct check output.', affectedFilesOrBehaviors:'src/pay.mjs',
    blockers:'none', unexpectedWorkspaceEffects:'none', persistenceSummary:'Retain current evidence.',
  };
}
function commonRound(round, status, exit) {
  const owner = structuredClone(OWNER);
  const before = round === 1 ? structuredClone(MANIFEST_0) : manifest(round - 1);
  const after = manifest(round);
  const observed = {
    format:'stnl-runner-verification-v2',status:'completed',owner,round,recipe:structuredClone(RECIPE),
    resolved:structuredClone(RESOLVED), before:structuredClone(after),after:structuredClone(after),
    checks:[{request:structuredClone(RESOLVED.checks[0]),command:COMMAND,exit,stdout:'pay output\n',stderr:'',
      stdoutSha256:hash(Buffer.from('pay output\n')),stderrSha256:hash(Buffer.from(''))}],
  };
  const rawResponse = encode(payload(round,status,exit));
  const testedState = {workspace:PRODUCT,sourceTaskPath:TASK,entries:[{path:TARGET,value:after.entries.at(-1).sha256}]};
  return {owner,before,after,observed,rawResponse,testedState};
}
export function nativeRound(round = 1, status = 'TESTS_PASS', exit = 0) {
  const part = commonRound(round,status,exit);
  const root = '/tmp/pay-native';
  const originFile = `${root}/round-${round}.origin.json`;
  const agentId = `agent-pay-${round}`;
  const origin = {transport:'native',specPath:CONTEXT.logicalAuthorityPath,workspace:PRODUCT,owner:part.owner,
    verification:structuredClone(RESOLVED),dispatchId:'dispatch-pay',attempt:round};
  const receipt = {transport:'native',originFile,owner:part.owner,operation:'EXECUTE_SLICE',slice:'slice-01',
    workspace:PRODUCT,attempt:round,threadId:agentId,receiptFile:`${root}/round-${round}.receipt.json`,
    semanticResponseFile:`${root}/round-${round}.response.json`,semanticResponseSha256:rawHex(part.rawResponse),
    semanticResponseStatus:status,status:'RUNNER_RESPONSE_CAPTURED',captureFailure:null,error:null,
    testedState:part.testedState,verification:part.observed};
  return {
    transport:'native', rawResponse:part.rawResponse, receipt:encode(receipt),
    baselineCapture:encode({format:'stnl-current-baseline-v1',owner:part.owner,round,context:CONTEXT,manifest:part.before}),
    verificationObservation:encode(part.observed), removalProofs:[],
    origin:encode(origin),dispatch:encode(origin),agentBinding:encode({agentId,originFile}),
    agentClaim:encode({agentId,originFile,owner:part.owner}),
    concludedToolResult:encode({agentId,status:'completed',finalResponse:Buffer.from(part.rawResponse).toString('utf8')}),
  };
}
const RUNTIME_FILES = {
  adapter:['agents/codex/runtime/validation-runner.mjs','adapter\n','755'],
  bridge:['agents/codex/runtime/managed-runner-bridge.mjs','bridge\n','644'],
  preflight:['agents/codex/runtime/managed-slice-preflight.mjs','preflight\n','644'],
  evidenceSerializer:['skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs','serializer\n','644'],
  runnerResultContract:['skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs','contract\n','644'],
};
export function managedRound(round = 1, status = 'TESTS_PASS', exit = 0, count = 1, captured = count) {
  const part = commonRound(round,status,exit);
  const tmpdir='/tmp/pay-managed'; const sequence=7;
  const stem=`007-execute_slice-slice-01-attempt-${round}`;
  const receipt={status:'RUNNER_RESPONSE_CAPTURED',operation:'EXECUTE_SLICE',sequence,slice:'slice-01',attempt:round,
    authority:AUTHORITY.context.requirementsAuthority,owner:part.owner,runnerAgent:'stnl_validation_runner',
    threadId:`thread-pay-${round}`,receiptFile:`${tmpdir}/${stem}.receipt.json`,eventsPath:`${tmpdir}/${stem}.events.jsonl`,
    verification:part.observed,semanticResponseFile:`${tmpdir}/${stem}.response.json`,
    semanticResponseSha256:rawHex(part.rawResponse),semanticResponseStatus:status,captureFailure:null,
    captureFailureCode:null,testedState:part.testedState,formatRepair:null,automaticCheckRound:`${round}/3`,
    providerError:null,error:null,processError:null,exitCode:0};
  const identity={workspace:PRODUCT,tmpdir,operation:'EXECUTE_SLICE',sequence,slice:'slice-01'};
  const context={version:4,owner:part.owner,expectedActivationId:OWNER.originActivationId,operation:'EXECUTE_SLICE',
    slice:'slice-01',specPath:CONTEXT.logicalAuthorityPath,workspace:PRODUCT,state:'ready',
    authority:AUTHORITY.context.requirementsAuthority,legalOperations:[{operation:'EXECUTE_SLICE',slice:'slice-01'}],
    mandatoryRecovery:null,identity:{snapshot:{path:'/tmp/pay-snapshot',mode:'755'}}};
  for (const [role,[name,content,mode]] of Object.entries(RUNTIME_FILES)) {
    context.identity[role]={path:`/tmp/pay-snapshot/${name}`,sha256:hash(Buffer.from(content)),mode};
  }
  const active={...identity,protocol:3,officialPreflight:{specPath:CONTEXT.logicalAuthorityPath,
    authority:AUTHORITY.context.requirementsAuthority,owner:part.owner,operation:'EXECUTE_SLICE',slice:'slice-01',
    exitCode:0,state:'ready'},payloadFile:`${tmpdir}/payload.json`};
  const started={operation:'EXECUTE_SLICE',sequence,slice:'slice-01',attempt:round,
    authority:AUTHORITY.context.requirementsAuthority,owner:part.owner};
  const events=[
    {operationId:`runner-${stem}`,type:'thread.started',thread_id:receipt.threadId},
    {operationId:`runner-${stem}`,type:'turn.started'},
    {operationId:`runner-${stem}`,type:'item.completed',item:{type:'agent_message',text:Buffer.from(part.rawResponse).toString('utf8')}},
    {operationId:`runner-${stem}`,type:'turn.completed'},
  ].map(value => JSON.stringify(value)).join('\n')+'\n';
  const supervisor={...identity,pending:false,requestsHandled:count,capturedReceipts:captured,errors:[],cancelledPending:false,
    closedAt:'2026-10-13T12:00:00.000Z'};
  const latest={...identity,authority:AUTHORITY.context.requirementsAuthority,requestId:`request-${round}`,
    payloadSha256:rawHex(Buffer.from('prompt')),receipt};
  const runtimeIdentity=[...new Set(Object.values(RUNTIME_FILES).map(([,content]) => content))]
    .map(content => Uint8Array.from(Buffer.from(content))).sort((a,b)=>hash(a).localeCompare(hash(b),'en'));
  return {
    transport:'managed',rawResponse:part.rawResponse,receipt:encode(receipt),
    baselineCapture:encode({format:'stnl-current-baseline-v1',owner:part.owner,round,context:CONTEXT,manifest:part.before}),
    verificationObservation:encode(part.observed),removalProofs:[],managedContext:encode(context),active:encode(active),
    started:encode(started),events:Uint8Array.from(Buffer.from(events)),closedSupervisor:encode(supervisor),
    latest:encode(latest),runtimeIdentity,
  };
}
export function initial(rounds) {
  return {context:structuredClone(CONTEXT),authority:structuredClone(AUTHORITY),owner:structuredClone(OWNER),
    currentEvidence:null,counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},rounds};
}
export function rebindRaw(cap, text) {
  cap.rawResponse=Uint8Array.from(Buffer.from(text));
  const receipt=JSON.parse(Buffer.from(cap.receipt).toString('utf8'));
  receipt.semanticResponseSha256=rawHex(cap.rawResponse);
  if (cap.transport==='native') {
    const result=JSON.parse(Buffer.from(cap.concludedToolResult).toString('utf8'));
    result.finalResponse=text; cap.concludedToolResult=encode(result);
  } else {
    const events=Buffer.from(cap.events).toString('utf8').trimEnd().split('\n').map(JSON.parse);
    events[2].item.text=text;
    cap.events=Uint8Array.from(Buffer.from(events.map(JSON.stringify).join('\n')+'\n'));
  }
  cap.receipt=encode(receipt);
  if (cap.transport==='managed') {
    const latest=JSON.parse(Buffer.from(cap.latest).toString('utf8')); latest.receipt=receipt; cap.latest=encode(latest);
  }
}
export const ORACLE = Object.freeze({hash,rawHex,encode});
