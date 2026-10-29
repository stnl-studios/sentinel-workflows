import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appServerEnvironment, appServerRpc, initializeAppServer, describeAppServerBundle, assertAppServerBundle,
  selectAppServerBundle, startAppServerTurn, bindAppServerChild, readAppServerChild, observeAppServerChild,
  writeNativeToolResult, captureAppServerChild, persistAppServerStderrSample, readAppServerAgentFeatures,
  canonicalContractReadCommand, connectAppServer,nativeTransportError } from '../agents/codex/runtime/app-server-transport.mjs';
import { createNativeProvider } from '../agents/codex/runtime/native-provider.mjs';
import { reservedOperation } from './fixtures/current-native-operation.mjs';
import { bindNative, verifyNative, captureNative, resume } from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const blocked = error => error.code === 'NATIVE_TRANSPORT_UNPROVEN';
const parent = '019a0000-0000-7000-8000-000000000001';
const child = '019a0000-0000-7000-8000-000000000002';
const identity = { parentThreadId: parent, parentTurnId: 'parent-turn', agentPath: '/root/check-one' };
const refuses = (message, code='NATIVE_TRANSPORT_UNPROVEN') => error => {
  assert.equal(error.code,code); assert.equal(error.message,message); return true;
};

for (const [tool, label] of [['listAgents', 'its scoped agent inventory'], ['wait', 'a completed wait timeout without returned agent state']])
test(`formal runner may observe ${label} without a message or turn effect`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  const activity={id:'inventory',type:'collabAgentToolCall',tool,status:'completed',senderThreadId:child,receiverThreadIds:[],agentsStates:{}};
  s.state.items.splice(1,0,activity);s.state.turns[0].items=structuredClone(s.state.items);
  const binding=await bindAppServerChild(s.rpc,identity),before=JSON.stringify(s.state);
  for(const initialization of [false,true]) {
    const result=await readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root,initialization});
    assert.equal(result.finalResponse,s.state.items.at(-1).text);
  }
  assert.equal(JSON.stringify(s.state),before);assert.ok(s.calls.every(call=>call.method.startsWith('thread/')));
  if (tool==='wait') for (const position of [0,1]) {
    const replay=await continuedHistory(t);
    replay.s.state.turns[position].items.splice(1,0,activity);
    const options={binding:replay.binding,bundle:replay.bundle,cwd:replay.root,continuation:replay.continuation};
    const first=await readAppServerChild(replay.rpc,options),again=await readAppServerChild(replay.rpc,options);
    assert.deepEqual(first,again);assert.equal(first.finalResponse,'First and only formal response\r\n');
    assert.equal(replay.s.calls.filter(call=>call.method==='turn/start').length,0);
  }
});

for(const tool of ['listAgents','wait'])
for(const [name,change,reason] of [['sender absent',{senderThreadId:undefined},'SENDER'],['foreign sender',{senderThreadId:parent},'SENDER'],
  ['target foreign',{receiverThreadIds:[parent]},'RECEIVERS'],['receivers absent',{receiverThreadIds:undefined},'RECEIVERS'],
  ['status unknown',{status:'unknown'},'STATUS'],['not concluded',{status:'inProgress'},'STATUS'],
  ['message payload',{prompt:'untrusted-text-secret'},'PROMPT'],['state foreign',{agentsStates:{foreign:{status:'completed'}}},'AGENTS_STATES_EMPTY'],
  ['state absent',{agentsStates:undefined},'AGENTS_STATES_OBJECT'],['state array',{agentsStates:[]},'AGENTS_STATES_OBJECT'],
  ['model foreign',{model:'foreign'},'MODEL'],['effort foreign',{reasoningEffort:'foreign'},'EFFORT'],
  ['unknown tool',{tool:'unknown'},'ITEM_TYPE'],['send action',{tool:'sendMessage'},'ITEM_TYPE']])
test(`observational collaboration ${tool} is not permission for ${name}`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  s.state.items.splice(1,0,{id:'inventory',type:'collabAgentToolCall',tool,status:'completed',senderThreadId:child,receiverThreadIds:[],agentsStates:{},...change});
  s.state.turns[0].items=structuredClone(s.state.items);
  const binding=await bindAppServerChild(s.rpc,identity);
  await assert.rejects(readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root}),error=>{
    assert.ok(blocked(error));assert.ok(error.message.includes(reason));assert.doesNotMatch(error.message,/untrusted-text-secret/);return true;
  });
  assert.ok(s.calls.every(call=>call.method.startsWith('thread/')));
});

for (const [field,value,reason] of [['model','gpt-6-luna','MODEL'],['reasoningEffort','medium','EFFORT']])
test(`wait timeout rejects unexplained matching ${field} metadata`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  s.state.items.splice(1,0,{id:'wait-timeout',type:'collabAgentToolCall',tool:'wait',status:'completed',
    senderThreadId:child,receiverThreadIds:[],agentsStates:{},[field]:value});
  s.state.turns[0].items=structuredClone(s.state.items);
  const binding=await bindAppServerChild(s.rpc,identity);
  assert.equal(value,field==='model'?binding.model:binding.effort);
  await assert.rejects(readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root}),error=>{
    assert.ok(blocked(error));assert.ok(error.message.includes(reason));assert.match(error.message,/prompt=absent; states=empty/u);return true;
  });
});

for(const operation of ['bundle','capture','process-metadata'])test(`direct adapter I/O has safe stage and code (${operation})`,async t=>{
  const f=await fixture(t);let run;
  if(operation==='bundle')run=()=>describeAppServerBundle({skillsRoot:path.join(f.root,'private-path-secret'),runnerFile:f.bundle.runner.path});
  if(operation==='capture')run=()=>writeNativeToolResult(path.join(f.root,'private-path-secret/result.json'),{agentId:identity.agentPath,status:'completed',finalResponse:'literal'});
  if(operation==='process-metadata'){
    const launcher=path.join(f.root,'pkg/bin/codex.js');await fs.mkdir(path.dirname(launcher),{recursive:true});
    await fs.writeFile(launcher,'// Never executed\n');await fs.writeFile(path.join(f.root,'pkg/package.json'),'private-json-secret');
    run=()=>connectAppServer({cliLauncher:launcher,cliSha256:sha('// Never executed\n'),cwd:f.root});
  }
  await assert.rejects(run,error=>{
    assert.equal(error.code,'DRIVER_FAILURE');assert.match(error.message,operation==='process-metadata'?/stage=process; kind=PARSE/:/stage=physical; kind=IO; code=ENOENT/);
    assert.doesNotMatch(error.message,/private-|\/Users\//u);return true;
  });
});

for(const value of [null,false,0,''])test(`RPC falsy error is never a successful result (${JSON.stringify(value)})`,async t=>{
  const w=wire(t),pending=w.rpc.request('thread/read',{threadId:child});
  const rejected=assert.rejects(pending,refuses('App Server rejected thread/read (RPC unknown: invalid error envelope)'));
  w.input.write(JSON.stringify({id:w.sent[0].id,error:value})+'\n');await rejected;assert.equal(w.sent.length,1);
});

for(const [channel,message] of [
  ['input','RPC input failed'],['output','RPC output failed; effect uncertain'],
  ['diagnostics','App Server diagnostic channel failed'],['write-sync','RPC write uncertain (code=EPIPE)'],
  ['write-callback','RPC write uncertain (code=EPIPE)'],['close','RPC closed by owner'],
])test(`RPC channel failure retains its distinct safe refusal (${channel})`,async t=>{
  const w=wire(t);const privateError=Object.assign(new Error('/private/channel-secret'),{code:'EPIPE'});
  if(channel==='write-sync')w.output.write=()=>{throw privateError;};
  if(channel==='write-callback')w.output.write=(line,callback)=>{callback(privateError);return false;};
  const pending=w.rpc.request('thread/read',{threadId:child});
  const rejected=assert.rejects(pending,refuses(message));
  if(channel==='close')w.rpc.close();else if(!channel.startsWith('write'))w[channel].emit('error',privateError);
  await rejected;await assert.rejects(w.rpc.request('thread/read',{}),refuses(message));
});

for(const [name,frame,message] of [
  ['null',null,'invalid RPC message'],['notification',{},'invalid RPC notification'],
  ['both result and error',{id:1,result:{},error:{}},'unexpected RPC response'],
  ['missing result/error',{id:1},'unexpected RPC response'],
])test(`RPC invalid frame preserves a concrete protocol refusal (${name})`,async t=>{
  const w=wire(t),pending=w.rpc.request('thread/read',{threadId:child});
  const rejected=assert.rejects(pending,refuses(message));w.input.write(JSON.stringify(frame)+'\n');await rejected;
});

test('RPC bounds, method and notification refusals are distinct before writes',async t=>{
  assert.throws(()=>appServerRpc({input:new PassThrough(),output:new PassThrough(),timeoutMs:0}),refuses('invalid RPC bounds'));
  const w=wire(t,{maxLineBytes:32});
  await assert.rejects(w.rpc.request('private-method-secret',{}),refuses('RPC method outside adapter scope'));
  assert.throws(()=>w.rpc.notify('private-method-secret'),refuses('notification outside adapter scope'));
  await assert.rejects(w.rpc.request('thread/read',{threadId:child}),refuses('outgoing RPC line limit exceeded'));
  assert.equal(w.sent.length,0);
});

test('bounded public history distinguishes cursor invalidity from page exhaustion',async()=>{
  const params={parentThreadId:parent,parentTurnId:'turn',agentPath:'/root/check'};let count=0;
  const rpc={request:async()=>({data:[],nextCursor:'page-'+(++count)})};
  await assert.rejects(bindAppServerChild(rpc,params),refuses('public history page limit reached; result incomplete'));assert.equal(count,32);
  await assert.rejects(bindAppServerChild({request:async()=>({data:[],nextCursor:17})},params),refuses('history cursor missing/repeated'));
});

for(const view of ['private-view-secret',null,17,[],{}])test(`unknown child itemsView cannot bypass surface comparison (${JSON.stringify(view)})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  s.state.turns[0].itemsView=view;s.state.turns[0].items.at(-1).text+='drift';
  const binding=await bindAppServerChild(s.rpc,identity);
  await assert.rejects(readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root}),
    refuses('child turn items view unproven'));assert.ok(s.calls.every(c=>c.method.startsWith('thread/')));
});

for(const view of [undefined,'full','summary','notLoaded'])test(`known child itemsView retains literal item authority (${view??'omitted'})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  if(view===undefined)delete s.state.turns[0].itemsView;else s.state.turns[0].itemsView=view;
  if(view==='summary'||view==='notLoaded')s.state.turns[0].items=[];
  const binding=await bindAppServerChild(s.rpc,identity),before=JSON.stringify(s.state);
  const result=await readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root});
  assert.equal(result.finalResponse,s.state.items.at(-1).text);assert.equal(JSON.stringify(s.state),before);
});

for(const status of [undefined,null,'private-status-secret',17])for(const formal of [false,true])
test(`unknown child status cannot certify capture or terminal (${JSON.stringify(status)}, formal=${formal})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});s.state.turns[0].status=status;
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const result=await p.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'unknown-child',role:'author',observeFormalBinding:()=>formal?{agentPath:identity.agentPath}:null});
  assert.equal(result.completed,false);assert.equal(result.terminalObserved,false);assert.deepEqual(result.captures,[]);
  assert.ok(result.error.includes(`status=${status==null?'absent':'other'}`),result.error);
  assert.doesNotMatch(result.error,/private-/u);assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
});

for(const status of ['failed','interrupted'])for(const formal of [false,true])
test(`public child failure retains category and role (${status}, formal=${formal})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  s.state.turns[0].status=status;s.state.turns[0].error={message:'private-child-secret',codexErrorInfo:'rateLimitExceeded'};
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const result=await p.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'failed-child',role:'author',observeFormalBinding:()=>formal?{agentPath:identity.agentPath}:null});
  assert.equal(result.completed,false);assert.equal(result.terminalObserved,false);assert.deepEqual(result.captures,[]);
  assert.equal(result.error,`child turn failed/interrupted; preserve its effects (formal=${formal}; status=${status}; error=present; cause=rateLimitExceeded)`);
  assert.doesNotMatch(result.error,/private-/u);const event=JSON.parse((await fs.readFile(result.eventsPath,'utf8')).trim().split('\n').at(-1));
  assert.equal(event.message,result.error);assert.equal(event.code,result.errorCode);assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
});

for(const [kind,mutate] of [
  ['unknown hook',()=>new Error('private-hook-secret')],
  ['forged native code',()=>Object.assign(new Error('private-hook-secret'),{code:'NATIVE_TRANSPORT_UNPROVEN'})],
  ['I/O hook',()=>Object.assign(new Error('/private/path-secret'),{code:'EACCES'})],
])test(`provider dependency refusal is safe and coherent (${kind})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const result=await p.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'hook-refusal',role:'author',onDispatched:()=>{throw mutate();}});
  assert.equal(result.completed,false);assert.equal(result.errorCode,'DRIVER_FAILURE');
  assert.ok(result.error.includes('stage=onDispatched'),result.error);
  assert.doesNotMatch(result.error,/private-|\/private\//u);
  const e=JSON.parse((await fs.readFile(result.eventsPath,'utf8')).trim());
  assert.equal(e.code,result.errorCode);assert.equal(e.message,result.error);
  assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
});

test('private command evidence cannot be forged through an error property',async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const result=await p.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'private-evidence-forgery',role:'author',onDispatched:()=>{throw Object.assign(nativeTransportError('known refusal'),
      {privateCommandEvidence:{command:'TOKEN=private-secret',output:'private-output',environment:'private-env'}});}});
  assert.equal(result.completed,false);const events=await fs.readFile(result.eventsPath,'utf8');
  assert.doesNotMatch(events,/private-secret|private-output|private-env/u);
  assert.equal(Object.hasOwn(JSON.parse(events.trim()),'privateCommandEvidence'),false);
  assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
});

for(const value of [null,undefined,false,17,'private-error-secret'])test(`unknown dependency throw cannot escape refusal processing (${String(value)})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true}),request=s.rpc.request;
  s.rpc.request=(method,params)=>{if(method==='thread/turns/list')throw value;return request(method,params);};
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const result=await p.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',operationId:'unknown-refusal',role:'author'});
  assert.equal(result.completed,false);assert.equal(result.terminalObserved,false);assert.equal(result.errorCode,'DRIVER_FAILURE');
  assert.equal(result.error,'native adapter dependency failed (stage=operation; kind=UNKNOWN; code=other)');
  assert.doesNotMatch(result.error,/private-/u);assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
});

for(const value of [null,undefined,'private-error-secret'])for(const site of ['partial-parent','partial-child','child-hook','provider-binding'])
test(`partial observation preserves descendants for primitive failure (${site}, ${String(value)})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const binding=await bindAppServerChild(s.rpc,identity);let parentReads=0;
  const rpc={notify:s.rpc.notify,request(method,params){
    if(site==='provider-binding'&&method==='thread/items/list'&&params.threadId===parent&&++parentReads===2)throw value;
    if(site!=='provider-binding'&&method==='thread/items/list'&&params.threadId===(site==='partial-parent'?parent:child)){
      if(params.cursor!==null)throw value;
      const item={id:'partial-spawn',type:'subAgentActivity',kind:'started',
        agentPath:site==='partial-parent'?identity.agentPath:'/root/nested',agentThreadId:site==='partial-parent'?child:'nested'};
      return {data:[{turnId:params.turnId,item}],nextCursor:site==='child-hook'?null:'next'};
    }
    if(site==='child-hook'&&method==='thread/read'&&params.threadId==='nested')return {thread:{id:'nested',parentThreadId:child}};
    return s.rpc.request(method,params);
  }};
  if(site==='partial-parent'||site==='provider-binding'){
    const provider=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc}),charged=[];
    const result=await provider.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
      operationId:'partial-primitive',role:'author',onUnadmittedChildren:items=>charged.push(...items)});
    assert.equal(result.completed,false);assert.equal(result.terminalObserved,false);assert.deepEqual(result.captures,[]);
    assert.equal(result.error,'native adapter dependency failed (stage=operation; kind=UNKNOWN; code=other)');
    assert.deepEqual(charged.map(item=>item.agentThreadId),[child]);
  }else await assert.rejects(observeAppServerChild(rpc,{binding,cwd:f.root,onChild:()=>{throw value;}}),error=>{
    assert.equal(error.code,'DRIVER_FAILURE');assert.equal(error.message,'native adapter dependency failed (stage=operation; kind=UNKNOWN; code=other)');
    assert.deepEqual(error.descendants.map(item=>item.agentThreadId),['nested']);return true;
  });
});

test('foreign close errors remain redacted and keep the RPC closed',async t=>{
  const w=wire(t),pending=w.rpc.request('thread/read',{threadId:child});
  const rejection=assert.rejects(pending,refuses('native adapter dependency failed (stage=process; kind=UNKNOWN; code=other)','DRIVER_FAILURE'));
  w.rpc.close(null);await rejection;
  await assert.rejects(w.rpc.request('thread/read',{}),refuses('native adapter dependency failed (stage=process; kind=UNKNOWN; code=other)','DRIVER_FAILURE'));
  assert.equal(w.sent.length,1);
});

for(const mode of ['existing-evidence','malformed-evidence','invalid-identity','offline-client'])
test(`pre-dispatch refusal preserves safe preparation category (${mode})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  if(mode==='offline-client'){
    await assert.rejects(createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root}),
      refuses('an explicit offline App Server provider is required for this fixture'));return;
  }
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const args={prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',operationId:'prepare-refusal',role:'author'};
  if(mode==='existing-evidence')await fs.writeFile(path.join(f.root,'prepare-refusal.events.jsonl'),'prior');
  if(mode==='malformed-evidence'){
    await fs.writeFile(path.join(f.root,'prepare-refusal.events.jsonl'),'private-json-secret');
    args.observation={threadId:parent,turnId:'parent-turn',deadlineAt:Date.now()+1000};
  }
  if(mode==='invalid-identity')args.operationId='../private-identity-secret';
  const message=mode==='invalid-identity'?'invalid operation evidence identity':mode==='existing-evidence'
    ?'native adapter dependency failed (stage=prepare; kind=IO; code=EEXIST)':'native adapter dependency failed (stage=prepare; kind=PARSE; code=other)';
  await assert.rejects(p.runTurn(args),refuses(message,mode==='invalid-identity'?'NATIVE_TRANSPORT_UNPROVEN':'DRIVER_FAILURE'));
  assert.equal(s.calls.filter(c=>c.method==='turn/start').length,0);
});

test('failure accounting cannot replace the primary refusal',async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  s.state.parentItems.push({id:'',type:'agentMessage',text:'private-source-secret'});
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});let charged=0;
  const result=await p.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'account-refusal',role:'author',onUnadmittedChildren:children=>{charged+=children.length;throw new Error('private-accounting-secret');}});
  assert.equal(result.completed,false);assert.equal(result.error,'public item entry absent or foreign');
  assert.equal(result.errorCode,'NATIVE_TRANSPORT_UNPROVEN');assert.equal(charged,1);
  assert.equal(result.secondaryFailures[0].stage,'onUnadmittedChildren');
  assert.doesNotMatch(JSON.stringify(result.secondaryFailures),/private-/u);
  const e=JSON.parse((await fs.readFile(result.eventsPath,'utf8')).trim().split('\n').at(-1));
  assert.equal(e.message,result.error);assert.deepEqual(e.secondaryFailures,result.secondaryFailures);
});

test('failure recording cannot replace or retry the primary refusal',async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  s.state.parentItems.push({id:'',type:'agentMessage',text:'private-source-secret'});
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const append=fs.appendFile;let attempts=0;fs.appendFile=async(file,data,...rest)=>{
    if(String(data).includes('native.transport.blocked')){attempts++;throw Object.assign(new Error('/private/evidence-secret'),{code:'ENOSPC'});}
    return append(file,data,...rest);
  };
  try{
    const result=await p.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',operationId:'record-refusal',role:'author'});
    assert.equal(result.completed,false);assert.equal(result.error,'public item entry absent or foreign');
    assert.equal(result.evidenceStatus,'unavailable');assert.equal(attempts,1);
    assert.equal(result.secondaryFailures.at(-1).stage,'evidence');
    assert.doesNotMatch(JSON.stringify(result.secondaryFailures),/private-|\/private\//u);
  }finally{fs.appendFile=append;}
});

for(const late of ['capture-cancel','auxiliary-cancel','capture-deadline','completed-record-cancel'])
test(`late observation boundary cannot return success (${late})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true}),controller=new AbortController();
  s.state.parentItems.push({...s.state.parentItems[0],id:'completed',kind:'completed'});
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});let deadline;
  const interrupt=()=>late==='capture-deadline'?t.mock.method(Date,'now',()=>deadline+1):controller.abort();
  const append=fs.appendFile;
  if(late==='completed-record-cancel')fs.appendFile=async(file,data,...rest)=>{
    const value=await append(file,data,...rest);if(String(data).includes('native.turn.completed'))controller.abort();return value;
  };
  try{
    const result=await p.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
      operationId:'late-refusal',role:'author',timeoutMs:1000,signal:controller.signal,
      ...(late==='auxiliary-cancel'?{observeFormalBinding:()=>null,onAuxiliaryCompleted:interrupt}:
        late==='completed-record-cancel'?{}:{onChildCompleted:interrupt}),onDispatched:d=>{deadline=d.deadlineAt;}});
    assert.equal(result.completed,false);assert.match(result.error,late==='capture-deadline'?/deadline/:/cancel/);
    assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
    if(late.startsWith('capture'))assert.equal(result.captures.length,1,'first immutable capture remains retained');
  }finally{fs.appendFile=append;}
});

test('owned App Server excludes inherited informational span logging without changing HOME/config or its caller', () => {
  const environment = Object.freeze({ HOME: '/normal-home', CODEX_HOME: '/existing-codex-home',
    PATH: '/existing-path', RUST_LOG: 'info,codex_exec_server::remote=info', LOG_FORMAT: 'json',
    UNRELATED_SETTING: 'preserved' });
  assert.deepEqual(appServerEnvironment(environment), { ...environment, RUST_LOG: 'warn' });
  assert.equal(environment.RUST_LOG, 'info,codex_exec_server::remote=info');
  assert.deepEqual(appServerEnvironment({ HOME: '/normal-home' }), { HOME: '/normal-home', RUST_LOG: 'warn' });
});

async function fixture(t) {
  await fs.mkdir(path.join(repo, 'tmp'), { recursive: true });
  const root = await fs.mkdtemp(path.join(repo, 'tmp/app-server-offline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'skills/workflows'), runnerFile = path.join(root,
    'agents/codex/.codex/agents/stnl_validation_runner.toml');
  for (const skill of ['stnl-slice-executor', 'stnl-slice-quality-manager']) {
    await fs.mkdir(path.join(skillsRoot, skill, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, skill, 'SKILL.md'), `---\nname: ${skill}\n---\nOffline fixture only\n`);
    await fs.writeFile(path.join(skillsRoot, skill, 'runtime/helper.mjs'), '// frozen sibling fixture\n');
  }
  await fs.mkdir(path.dirname(runnerFile), { recursive: true });
  await fs.copyFile(path.join(repo, 'agents/codex/.codex/agents/stnl_validation_runner.toml'), runnerFile);
  return { root, bundle: await describeAppServerBundle({ skillsRoot, runnerFile }) };
}

function server({ bundle, cwd, response = '  resultado íntegro\r\n𝛑\n', mutate = () => {}, provider = false }) {
  const calls = [];
  const final = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response };
  const contract = { id: 'contract-read', type: 'commandExecution', command: `cat -- '${bundle.runner.path.replaceAll("'", "'\\''")}'`,
    cwd, status: 'completed', exitCode: 0, aggregatedOutput: readFileSync(bundle.runner.path, 'utf8') };
  const activity = { id: 'spawn', type: 'subAgentActivity', kind: 'started', agentPath: identity.agentPath,
    agentThreadId: child, model: 'gpt-6-luna', reasoningEffort: 'medium' };
  const state = {
    parentItems: [activity, { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
      senderThreadId: parent, receiverThreadIds: [], agentsStates: {} }],
    thread: { id: child, parentThreadId: parent, forkedFromId: null, cliVersion: '0.163.0',
      cwd, agentRole: 'default', model: bundle.runner.model, reasoningEffort: bundle.runner.effort },
    turns: [{ id: 'child-turn', rootTurnId: 'parent-turn', items: [structuredClone(contract), structuredClone(final)],
      itemsView: 'full', status: 'completed', error: null }],
    items: [contract, final],
    listing: { data: [{ cwd, errors: [], skills: [
      ...bundle.files.filter(file => path.basename(file.path) === 'SKILL.md').map(file => ({
        path: file.path, name: path.basename(path.dirname(file.path)), enabled: true })),
      { path: '/normal-home/.agents/skills/stnl-slice-executor/SKILL.md', name: 'stnl-slice-executor', enabled: true },
    ] }] },
  };
  mutate(state);
  return { calls, state, rpc: {
    notify(method, params) { calls.push({ method, params }); },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'initialize') return { userAgent: 'codex-cli/0.163.0' };
      if (method === 'skills/extraRoots/set') return {};
      if (method === 'experimentalFeature/list') return {data:[{name:'multi_agent',enabled:true},{name:'multi_agent_v2',enabled:true}],nextCursor:null};
      if (method === 'skills/list') return structuredClone(state.listing);
      if (method === 'thread/start') return { thread: { id: parent, cwd, cliVersion: '0.163.0', historyMode: 'paginated' } };
      if (method === 'turn/start') return { turn: { id: 'parent-turn' } };
      if (method === 'thread/read') {
        if (provider && params.threadId === parent) return { thread: { id: parent, cwd, cliVersion: '0.163.0', historyMode: 'paginated', parentThreadId: null } };
        assert.equal(params.threadId, child); return { thread: structuredClone(state.thread) };
      }
      if (method === 'thread/resume') return { thread: { id: parent, cwd, cliVersion: '0.163.0', historyMode: 'paginated' } };
      if (method === 'thread/turns/list') {
        if (provider && params.threadId === parent) return { data: [{ id: 'parent-turn', status: 'completed', error: null }], nextCursor: null };
        assert.equal(params.threadId, child); return { data: structuredClone(state.turns), nextCursor: null };
      }
      if (method === 'thread/items/list') {
        if (params.threadId === parent) {
          assert.equal(params.turnId, 'parent-turn'); return { data: [...structuredClone(state.parentItems),
            ...(provider ? [{ id: 'parent-answer', type: 'agentMessage', phase: 'final_answer', text: 'OFFLINE principal result' }] : [])].map(item => ({ turnId: params.turnId, item })), nextCursor: null };
        }
        assert.equal(params.threadId, child); assert.equal(params.turnId, 'child-turn');
        return { data: structuredClone(state.items).map(item => ({ turnId: params.turnId, item })), nextCursor: null };
      }
      assert.fail(`unexpected method ${method}`);
    },
  } };
}

// Public history only: these fixtures certify transport behavior, not controller eligibility.
async function continuedHistory(t) {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root,
    response: 'Arbitrary initialization text; no ACK classifier.\n𝛑' });
  const binding = await bindAppServerChild(s.rpc, identity);
  const first = await readAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root, initialization: true });
  const firstToolResultUtf8 = JSON.stringify(first) + '\n';
  const continuation = { format: 'stnl-native-pre-verification-continuation-v1', binding,
    firstTurnId: 'child-turn', firstToolResultUtf8, firstToolResultSha256: sha(firstToolResultUtf8) };
  s.state.turns.push({ id: 'continued-turn', rootTurnId: 'parent-turn', itemsView: 'full',
    status: 'completed', error: null, items: [{ id: 'formal-answer', type: 'agentMessage',
      phase: 'final_answer', text: 'First and only formal response\r\n' }] });
  const rpc = { request(method, params) {
    if (method === 'thread/items/list' && params.threadId === child) {
      const turn = s.state.turns.find(value => value.id === params.turnId);
      return { data: structuredClone(turn.items).map(item => ({ turnId: turn.id, item })), nextCursor: null };
    }
    return s.rpc.request(method, params);
  } };
  return { ...f, s, rpc, binding, continuation };
}

for(const source of ['{private-envelope-secret', 'null'])test(`malformed saved continuation has safe direct refusal (${source==='null'?'null':'parse'})`,async t=>{
  const f=await continuedHistory(t);f.continuation.firstToolResultUtf8=source;f.continuation.firstToolResultSha256=sha(source);
  await assert.rejects(readAppServerChild(f.rpc,{binding:f.binding,bundle:f.bundle,cwd:f.root,continuation:f.continuation}),
    source==='null'?refuses('continuation saved envelope malformed')
      :refuses('native adapter dependency failed (stage=contract; kind=PARSE; code=other)','DRIVER_FAILURE'));
  assert.ok(f.s.calls.every(call=>call.method.startsWith('thread/')));
});

test('one admitted continuation preserves initialization and reads the first formal response without a new turn', async t => {
  const f = await continuedHistory(t);
  const options = { binding: f.binding, bundle: f.bundle, cwd: f.root, continuation: f.continuation };
  const before = JSON.stringify(f.s.state);
  const first = await readAppServerChild(f.rpc, options), replay = await readAppServerChild(f.rpc, options);
  assert.deepEqual(first, replay);
  assert.equal(first.finalResponse, 'First and only formal response\r\n');
  assert.equal(first.preVerificationContinuation.firstToolResultUtf8, f.continuation.firstToolResultUtf8);
  assert.equal(JSON.stringify(f.s.state), before, 'reobservation cannot alter either turn');
  assert.ok(f.s.calls.every(call => call.method.startsWith('thread/')), 'no verification, new turn or recipe during replay');
  await assert.rejects(readAppServerChild(f.rpc, { ...options, continuation: null }), blocked,
    'a second turn without controller admission cannot become a formal response');
});

for (const [name, mutate] of [
  ['third judgment', f => { f.s.state.turns.push({ ...f.s.state.turns[1], id: 'third-turn' }); }],
  ['uncertain continuation', f => { f.s.state.turns[1].status = 'interrupted'; }],
  ['foreign binding', f => { f.continuation.binding = { ...f.binding, parentTurnId: 'foreign' }; }],
  ['first bytes changed', f => { f.continuation.firstToolResultUtf8 += ' '; }],
  ['first API response changed', f => { f.s.state.turns[0].items.at(-1).text += 'changed'; }],
  ['first contract truncated', f => { f.s.state.turns[0].items[0].aggregatedOutput = 'partial'; }],
  ['first explicit mutation', f => { f.s.state.turns[0].items.splice(1, 0, { id: 'write', type: 'fileChange',
    status: 'completed', changes: [] }); }],
  ['first command denied', f => { f.s.state.turns[0].items[0].exitCode = 1; }],
  ['profile changed', f => { f.s.state.thread.reasoningEffort = 'high'; }],
  ['formal response projection drift', f => { f.s.state.turns[1].itemsView = 'full'; }],
]) test(`admitted continuation rejects ${name}`, async t => {
  const f = await continuedHistory(t); mutate(f);
  let rpc = f.rpc;
  if (name === 'formal response projection drift') rpc = { request(method, params) {
    if (method === 'thread/items/list' && params.turnId === 'continued-turn') return { data: [{ turnId: params.turnId,
      item: { ...f.s.state.turns[1].items[0], text: 'different public projection' } }], nextCursor: null };
    return f.rpc.request(method, params);
  } };
  await assert.rejects(readAppServerChild(rpc, { binding: f.binding, bundle: f.bundle, cwd: f.root,
    continuation: f.continuation }), error=>{
    const expected={'third judgment':'fresh child has no admitted completed successful turn sequence (failed=COUNT)',
      'uncertain continuation':'fresh child has no admitted completed successful turn sequence (failed=TURN; status=interrupted; error=absent; cause=absent)',
      'foreign binding':'continuation public identity/source differs','first bytes changed':'continuation public identity/source differs',
      'first API response changed':'continuation first public response changed','first contract truncated':'generic runner complete contract output absent, truncated or foreign',
      'first explicit mutation':'continuation initialization has denied, uncertain or unexpected effects (itemIndex=1; failed=ITEM_TYPE,CWD,EXIT_CODE; itemType=fileChange; cwd=differs; status=completed; exitCode=absent)',
      'first command denied':'generic runner contract read not observed before scope actions',
      'profile changed':'child metadata foreign, forked or version differs','formal response projection drift':'public child surfaces disagree'}[name];
    assert.ok(expected,`missing diagnostic contract for ${name}`);return refuses(expected)(error);
  });
});

for (const kind of ['completed']) for(const position of [0,1])
test(`bound self ${kind} metadata at ${position} permits initialization and immutable continuation replay`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  const activity={id:'self-metadata',type:'subAgentActivity',kind,agentPath:identity.agentPath,agentThreadId:child,
    model:'gpt-6-luna',reasoningEffort:'medium'};
  if(kind==='completed'&&position===1){delete activity.model;delete activity.reasoningEffort;}
  s.state.items.splice(position,0,activity);s.state.turns[0].items=structuredClone(s.state.items);
  const binding=await bindAppServerChild(s.rpc,identity),options={binding,bundle:f.bundle,cwd:f.root,initialization:true};
  const before=JSON.stringify(s.state);assert.equal((await readAppServerChild(s.rpc,options)).status,'completed');
  assert.equal(JSON.stringify(s.state),before);assert.ok(s.calls.every(call=>call.method.startsWith('thread/')));
  const replay=await continuedHistory(t);
  replay.s.state.turns[0].items.splice(position,0,activity);
  const args={binding:replay.binding,bundle:replay.bundle,cwd:replay.root,continuation:replay.continuation};
  const first=await readAppServerChild(replay.rpc,args),again=await readAppServerChild(replay.rpc,args);
  assert.deepEqual(first,again);assert.equal(first.finalResponse,'First and only formal response\r\n');
  assert.equal(replay.s.calls.filter(call=>call.method==='turn/start').length,0);
  s.state.items.splice(s.state.items.findIndex(item=>item.id==='contract-read'),0,{id:'early-action',type:'commandExecution',cwd:f.root,
    command:'cat other-scope',status:'completed',exitCode:0,aggregatedOutput:''});
  await assert.rejects(readAppServerChild(s.rpc,{...options,initialization:false}),blocked,
    'metadata cannot conceal a real scope action before the contract read');
});

// rust-v0.163.0 message_tool.rs emits Interacted in the caller's history,
// naming the recipient. send_message and followup_task share this item shape;
// no recipient, including self, makes either communication harmless metadata.
for (const [target, agentPath, agentThreadId, relation] of [
  ['principal', '/root', parent, 'differs'],
  ['another agent', '/root/other', 'private-recipient-secret', 'differs'],
  ['self', identity.agentPath, child, 'matches'],
]) test(`formal outgoing Interacted forbids indistinguishable send/followup to ${target}`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true });
  const activity = { id: 'private-item-secret', type: 'subAgentActivity', kind: 'interacted',
    agentPath, agentThreadId, model: null, reasoningEffort: null };
  s.state.items.splice(1, 0, activity); s.state.turns[0].items = structuredClone(s.state.items);
  const binding = await bindAppServerChild(s.rpc, identity);
  const check = error => {
    assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
    assert.match(error.message, /^runner outgoing communication is forbidden /u);
    assert.ok(error.message.includes('failed=OUTGOING_COMMUNICATION;'), error.message);
    assert.ok(error.message.includes(`recipientThreadId=${relation}`), error.message);
    assert.ok(error.message.includes(`recipientPath=${relation}`), error.message);
    assert.match(error.message, /origin=runnerHistory; variant=v2; tool=unknown; status=unknown; sender=unknown;/u);
    assert.doesNotMatch(error.message, /foreign|private-|\/root|019a/u);
    return true;
  };
  for (const initialization of [false, true]) await assert.rejects(readAppServerChild(s.rpc,
    { binding, bundle: f.bundle, cwd: f.root, initialization }), check);
  for (const position of [0, 1]) {
    const replay = await continuedHistory(t);
    replay.s.state.turns[position].items.splice(1, 0, activity);
    await assert.rejects(readAppServerChild(replay.rpc, { binding: replay.binding, bundle: replay.bundle,
      cwd: replay.root, continuation: replay.continuation }), check);
  }
  s.state.parentItems.push({ ...s.state.parentItems[0], id: 'completed', kind: 'completed' });
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root,
    evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const result = await provider.runTurn({ prompt: 'OFFLINE only', workflowSkill: 'stnl-slice-quality-manager',
    model: 'gpt-6.1-sol', effort: 'medium', role: 'review', operationId: 'outgoing-refusal', timeoutMs: 1000,
    observeFormalBinding: () => ({ agentPath: identity.agentPath }),
    onChildCompleted: () => assert.fail('outgoing communication cannot become capture or continuation') });
  assert.equal(result.completed, false); assert.deepEqual(result.captures, []);
  check({ code: result.errorCode, message: result.error });
  const events = (await fs.readFile(result.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(event => event.type === 'native.transport.blocked').message, result.error);
  assert.ok(!events.some(event => event.type === 'native.child.continuation.admitted'));
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1, 'only original fake principal');
});

for(const [name,changes] of [
  ['spawn',{kind:'started'}],['interruption',{kind:'interrupted'}],
  ['foreign path',{agentPath:'/root/other'}],['foreign thread',{agentThreadId:'other'}],
  ['missing kind',{kind:undefined}],['unknown kind',{kind:'unknown'}],
  ['missing target',{agentThreadId:undefined}],['foreign model',{model:'foreign'}],
  ['foreign effort',{reasoningEffort:'high'}],
  ['collaboration action',{type:'collabAgentToolCall',tool:'wait',senderThreadId:child,receiverThreadIds:['other'],status:'completed',agentsStates:{}}],
]) test(`formal runner activity rejects ${name} in normal and initialization observations`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  const activity={id:'activity',type:'subAgentActivity',kind:'completed',agentPath:identity.agentPath,
    agentThreadId:child,...changes};
  s.state.items.splice(1,0,activity);s.state.turns[0].items=structuredClone(s.state.items);
  const binding=await bindAppServerChild(s.rpc,identity);
  for(const initialization of [false,true])await assert.rejects(readAppServerChild(s.rpc,
    {binding,bundle:f.bundle,cwd:f.root,initialization}),blocked);
  assert.ok(s.calls.every(call=>call.method.startsWith('thread/')),'no new producer, recipe or advancement');
  for(const position of [0,1]){
    const replay=await continuedHistory(t);replay.s.state.turns[position].items.splice(1,0,activity);
    await assert.rejects(readAppServerChild(replay.rpc,{binding:replay.binding,bundle:replay.bundle,
      cwd:replay.root,continuation:replay.continuation}),blocked);
  }
});

for (const [name, changes, failed, detail] of [
  ['spawn', { kind: 'started' }, 'KIND', 'kind=started'],
  ['interruption', { kind: 'interrupted' }, 'KIND', 'kind=interrupted'],
  ['missing kind', { kind: undefined }, 'KIND', 'kind=absent'],
  ['unknown kind', { kind: 'private-kind-secret' }, 'KIND', 'kind=other'],
  ['foreign path', { agentPath: '/private/path-secret' }, 'AGENT_PATH', 'agentPath=differs'],
  ['missing path', { agentPath: undefined }, 'AGENT_PATH', 'agentPath=absent'],
  ['invalid path', { agentPath: 17 }, 'AGENT_PATH', 'agentPath=invalid'],
  ['foreign thread', { agentThreadId: 'private-thread-secret' }, 'AGENT_THREAD', 'agentThreadId=differs'],
  ['missing thread', { agentThreadId: undefined }, 'AGENT_THREAD', 'agentThreadId=absent'],
  ['invalid thread', { agentThreadId: false }, 'AGENT_THREAD', 'agentThreadId=invalid'],
  ['foreign model', { model: 'private-model-secret' }, 'MODEL', 'model=differs'],
  ['invalid model', { model: 17 }, 'MODEL', 'model=invalid'],
  ['foreign effort', { reasoningEffort: 'private-effort-secret' }, 'EFFORT', 'effort=differs'],
  ['invalid effort', { reasoningEffort: {} }, 'EFFORT', 'effort=invalid'],
  ['combined mismatch', { agentPath: null, agentThreadId: 'private-thread-secret', model: 'private-model-secret' },
    'AGENT_PATH,AGENT_THREAD,MODEL', 'agentPath=absent'],
  ['collaboration', { type: 'collabAgentToolCall', tool: 'wait', senderThreadId: child,
    receiverThreadIds: ['private-thread-secret'], agentsStates: {}, status: 'completed' }, 'RECEIVERS', 'itemType=collabAgentToolCall'],
  ['unknown collaboration', { type: 'collabAgentToolCall', tool: 'private-tool-secret' }, 'ITEM_TYPE', 'itemType=collabAgentToolCall'],
]) test(`formal activity diagnostic survives refusal (${name})`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true });
  const activity = { id: 'private-item-secret', type: 'subAgentActivity', kind: 'completed',
    agentPath: identity.agentPath, agentThreadId: child, ...changes };
  s.state.items.splice(1, 0, activity); s.state.turns[0].items = structuredClone(s.state.items);
  const binding = await bindAppServerChild(s.rpc, identity);
  const checkDiagnostic = error => {
    assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
    assert.ok(error.message.includes(`itemIndex=1; failed=${failed};`), error.message);
    assert.ok(error.message.includes(detail), error.message);
    if (changes.type === 'collabAgentToolCall') {
      assert.match(error.message, /origin=runnerHistory; variant=v1;/u);
      assert.ok(error.message.includes('sender=') && error.message.includes('receivers='), error.message);
    } else {
      assert.match(error.message, /origin=runnerHistory; variant=v2; tool=unknown; status=unknown; sender=unknown;/u);
      assert.ok(error.message.includes('agentThreadId=') && error.message.includes('agentPath='), error.message);
    }
    assert.ok(Buffer.byteLength(error.message) < 512, 'bounded fixed diagnostic');
    assert.doesNotMatch(error.message, /private-|\/root\/|019a|\.toml|\/Users\//u, 'no identifiers, paths, commands or unknown values');
    if (name === 'spawn') assert.deepEqual(error.descendants, [activity], 'all descendant evidence remains attached');
    return true;
  };
  for (const initialization of [false, true]) await assert.rejects(readAppServerChild(s.rpc,
    { binding, bundle: f.bundle, cwd: f.root, initialization }), checkDiagnostic);
  // The generic descendant observer can refuse a spawn before formal collection.
  // Test that classifier's own spawn refusal directly, without bypassing observation.
  if (name === 'spawn') return;
  s.state.parentItems.push({ ...s.state.parentItems[0], id: 'completed', kind: 'completed' });
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root,
    evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const result = await provider.runTurn({ prompt: 'OFFLINE only', workflowSkill: 'stnl-slice-quality-manager',
    model: 'gpt-6.1-sol', effort: 'medium', role: 'review', operationId: 'activity-refusal', timeoutMs: 1000,
    observeFormalBinding: () => ({ agentPath: identity.agentPath }),
    onChildCompleted: () => assert.fail('refused activity cannot become capture or continuation') });
  assert.equal(result.completed, false); assert.equal(result.errorCode, 'NATIVE_TRANSPORT_UNPROVEN');
  checkDiagnostic({ code: result.errorCode, message: result.error });
  const events = (await fs.readFile(result.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(event => event.type === 'native.transport.blocked').message, result.error);
  assert.equal(result.captures.length, 0);
  assert.ok(!events.some(event => event.type === 'native.child.continuation.admitted'));
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1, 'only original fake principal');
});

// Official 0.163 CollabAgentTool/CollabAgentToolCallStatus enums. Observation
// origin and explicit sender/receiver fields are distinct facts, never aliases.
for (const [name, changes, expected] of [
  ...['spawnAgent','sendInput','resumeAgent','wait','closeAgent','sendMessage','followupTask','interruptAgent','listAgents']
    .map(tool => [tool, { tool }, [`tool=${tool}; status=completed; sender=runner; receivers=one; receiverRunner=no; receiverParent=yes; receiverOther=no;`]]),
  ['parent sender', { senderThreadId: parent }, ['sender=parent;']],
  ['other sender', { senderThreadId: 'private-sender-secret' }, ['sender=other;']],
  ['absent sender', { senderThreadId: undefined }, ['sender=absent;']],
  ['invalid sender', { senderThreadId: 17 }, ['sender=invalid;']],
  ['mixed receivers', { receiverThreadIds: [child, parent, 'private-receiver-secret'] }, ['receivers=many; receiverRunner=yes; receiverParent=yes; receiverOther=yes;']],
  ['empty receivers', { receiverThreadIds: [] }, ['receivers=empty; receiverRunner=no; receiverParent=no; receiverOther=no;']],
  ['absent receivers', { receiverThreadIds: undefined }, ['receivers=absent; receiverRunner=unknown; receiverParent=unknown; receiverOther=unknown;']],
  ['invalid receivers', { receiverThreadIds: [17] }, ['receivers=invalid; receiverRunner=unknown; receiverParent=unknown; receiverOther=unknown;']],
  ['unknown tool', { tool: 'private-tool-secret' }, ['tool=other;']],
  ['absent tool', { tool: undefined }, ['tool=absent;']],
  ['invalid tool', { tool: {} }, ['tool=invalid;']],
  ...['inProgress','failed','interrupted'].map(status => [status, { status }, [`status=${status};`]]),
  ['unknown status', { status: 'private-status-secret' }, ['status=other;']],
  ['absent status', { status: null }, ['status=absent;']],
  ['invalid status', { status: 17 }, ['status=invalid;']],
]) test(`formal collaboration v1 diagnostic preserves ${name} without authorizing it`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true });
  const activity = { id: 'private-item-secret', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
    senderThreadId: child, receiverThreadIds: [parent], agentsStates: { 'private-state-secret': { message: 'private-output-secret' } },
    prompt: 'private-prompt-secret', ...changes };
  s.state.items.splice(1, 0, activity); s.state.turns[0].items = structuredClone(s.state.items);
  const binding = await bindAppServerChild(s.rpc, identity);
  const check = error => {
    assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
    if (['listAgents','wait'].includes(activity.tool)) {
      assert.match(error.message,/itemIndex=1; failed=[A-Z_,]+; itemType=collabAgentToolCall; origin=runnerHistory; variant=v1;/u);
      const failures=/failed=([^;]+);/u.exec(error.message)[1].split(',');
      assert.ok(failures.includes('PROMPT')); assert.ok(failures.includes('AGENTS_STATES_EMPTY'));
      assert.ok(!failures.includes('ITEM_TYPE'));
      if (Object.hasOwn(changes,'status')) assert.ok(failures.includes('STATUS'));
      assert.match(error.message,/prompt=present; states=nonempty/u);
    } else assert.match(error.message,/itemIndex=1; failed=ITEM_TYPE; itemType=collabAgentToolCall; origin=runnerHistory; variant=v1;/u);
    for (const detail of expected) assert.ok(error.message.includes(detail), error.message);
    assert.ok(Buffer.byteLength(error.message) < 512);
    assert.doesNotMatch(error.message, /private-|019a|\/root|\/Users\//u);
    return true;
  };
  for (const initialization of [false, true]) await assert.rejects(readAppServerChild(s.rpc,
    { binding, bundle: f.bundle, cwd: f.root, initialization }), check);
  if (['wait', 'sendInput'].includes(name)) for (const position of [0, 1]) {
    const replay = await continuedHistory(t); replay.s.state.turns[position].items.splice(1, 0, activity);
    await assert.rejects(readAppServerChild(replay.rpc, { binding: replay.binding, bundle: replay.bundle,
      cwd: replay.root, continuation: replay.continuation }), check);
  }
  s.state.parentItems.push({ ...s.state.parentItems[0], id: 'completed', kind: 'completed' });
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const result = await provider.runTurn({ prompt: 'OFFLINE only', workflowSkill: 'stnl-slice-quality-manager', model: 'gpt-6.1-sol',
    effort: 'medium', role: 'review', operationId: 'v1-diagnostic', timeoutMs: 1000,
    observeFormalBinding: () => ({ agentPath: identity.agentPath }),
    onChildCompleted: () => assert.fail('diagnosis cannot grant a capture or continuation') });
  assert.equal(result.completed, false); assert.deepEqual(result.captures, []); check({ code: result.errorCode, message: result.error });
  const events = (await fs.readFile(result.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(event => event.type === 'native.transport.blocked').message, result.error);
  assert.ok(!events.some(event => event.type === 'native.child.continuation.admitted'));
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1, 'only the existing fake principal, no retry');
});

for (const [name, changes, failed, detail] of [
  ['unexpected item', { type: 'private-unknown-type-secret' }, 'ITEM_TYPE', 'itemType=other'],
  ['foreign cwd', { cwd: '/private/cwd-secret' }, 'CWD', 'cwd=differs'],
  ['uncertain command', { status: 'inProgress', exitCode: null }, 'STATUS,EXIT_CODE', 'status=inProgress'],
  ['denied command', { status: 'declined', exitCode: 1 }, 'STATUS,EXIT_CODE', 'status=declined'],
  ['contradictory failed command', { status: 'failed', exitCode: 0 }, 'EXIT_CODE', 'exitCode=0'],
  ['negative exit', { status:'failed',exitCode:-1 }, 'EXIT_CODE', 'exitCode=-1'],
  ['missing metadata', { status: undefined, exitCode: undefined }, 'STATUS,EXIT_CODE', 'status=absent'],
  ['unknown metadata', { status: 'private-status-secret', exitCode: 'private-exit-secret' }, 'STATUS,EXIT_CODE', 'status=other'],
  ['explicit file mutation', { type: 'fileChange' }, 'ITEM_TYPE', 'itemType=fileChange'],
  ['unproved tool effect', { type: 'mcpToolCall' }, 'ITEM_TYPE', 'itemType=mcpToolCall'],
]) test(`initialization refusal retains bounded concrete diagnostic through provider (${name})`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true,
    response: 'Initialization is not a verdict.\n' });
  const effect = { id: 'private-item-secret', type: 'commandExecution',
    cwd: f.root, command: `cat '${f.bundle.runner.path}'`, status: 'completed', exitCode: 0,
    aggregatedOutput: 'private-output-secret', commandActions: [], ...changes };
  s.state.items.splice(1, 0, effect);
  s.state.turns[0].items = structuredClone(s.state.items);
  s.state.parentItems.push({ ...s.state.parentItems[0], id: 'first-completion', kind: 'completed' });
  const request = s.rpc.request.bind(s.rpc);
  s.rpc.request = async (method, params) => {
    const value = await request(method, params);
    if (method === 'thread/turns/list' && params.threadId === parent) value.data[0].status = 'inProgress';
    return value;
  };
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root,
    evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const result = await provider.runTurn({ prompt: 'OFFLINE only', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6-luna', effort: 'high', role: 'review', operationId: 'initialization-refusal', timeoutMs: 1000,
    observeFormalBinding: () => ({ agentPath: identity.agentPath }),
    onPrepareContinuation: async ({ observeInitialization }) => { await observeInitialization(); assert.fail('must reject'); },
    onChildCompleted: () => assert.fail('refused initialization cannot grant continuation or formal capture') });
  assert.equal(result.completed, false); assert.equal(result.errorCode, 'NATIVE_TRANSPORT_UNPROVEN');
  assert.ok(result.error.includes(`itemIndex=1; failed=${failed};`), result.error);
  assert.ok(result.error.includes(detail), result.error);
  assert.ok(Buffer.byteLength(result.error) <= 320, 'bounded diagnostic');
  assert.doesNotMatch(result.error, /private-|\.toml|\/Users\//u, 'no raw paths, commands, output, IDs or foreign metadata');
  const events = (await fs.readFile(result.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const refusal = events.find(event => event.type === 'native.transport.blocked');
  assert.equal(refusal.message, result.error, 'existing artifact preserves the exact safe diagnostic');
  assert.equal(Object.hasOwn(refusal,'privateCommandEvidence'),false);
  assert.equal(Object.hasOwn(result,'privateCommandEvidence'),false);
  assert.equal((await fs.stat(result.eventsPath)).mode&0o077,0);
  assert.ok(!events.some(event => event.type === 'native.child.continuation.admitted'));
  assert.equal(result.captures.length, 0);
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1, 'only original fake principal');
  assert.equal(s.state.turns.length, 1, 'no second producer turn or recipe');
  const first = JSON.parse(await fs.readFile(path.join(f.root,
    `initialization-refusal.child-${sha(identity.agentPath).slice(7)}.json`), 'utf8'));
  assert.equal(first.finalResponse, 'Initialization is not a verdict.\n', 'first source remains literal');
});

for (const fault of [null, 'first-file-removed', 'first-alias', 'simultaneous-drift', 'duplicate-admission', 'expired',
  'parent-closed-during-admission', 'expired-during-admission','inspection-failure','inspection-failure-history-drift','inspection-failure-feedback-drift'])
test(`continued provider preserves both sources and reobserves without another turn (${fault ?? 'valid'})`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true, response: 'Initialization is not a verdict.\n' });
  const inspectionFailure=fault?.startsWith('inspection-failure');
  if(inspectionFailure) {
    s.state.items.splice(1,0,{id:'inspection-failed',type:'commandExecution',command:'cat private-missing-file private-document',
      cwd:f.root,status:'failed',exitCode:1,aggregatedOutput:'private-output-secret',commandActions:[]});
    s.state.turns[0].items=structuredClone(s.state.items);
  }
  s.state.parentItems.push({ ...s.state.parentItems[0], id: 'first-completion', kind: 'completed' });
  const request = s.rpc.request.bind(s.rpc); let parentDone = false, admissionCount = 0, firstFile;
  const now=Date.now;t.after(()=>{Date.now=now;});
  s.rpc.request = async (method, params) => {
    if (method === 'thread/items/list' && params.threadId === child) {
      const turn = s.state.turns.find(value => value.id === params.turnId);
      return { data: structuredClone(turn.items).map(item => ({ turnId: turn.id, item })), nextCursor: null };
    }
    const value = await request(method, params);
    if (method === 'thread/turns/list' && params.threadId === parent) value.data[0].status = parentDone ? 'completed' : 'inProgress';
    return value;
  };
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const charged = new Set();
  const args = { prompt: 'OFFLINE only', workflowSkill: 'stnl-slice-executor', model: 'gpt-6-luna', effort: 'high',
    operationId: 'continued-provider', role: 'review', timeoutMs: 1000,
    observeFormalBinding: async () => ({ agentPath: identity.agentPath }),
    onChildTurns: (binding, turns) => { for (const turn of turns) charged.add(turn.id); },
    onPrepareContinuation: async ({ binding, toolResultFile, firstTurnId, observeInitialization }) => {
      admissionCount++; await observeInitialization(); firstFile = toolResultFile;
      const firstToolResultUtf8 = await fs.readFile(toolResultFile, 'utf8');
      if(fault==='parent-closed-during-admission')parentDone=true;
      if(fault==='expired-during-admission')Date.now=()=>now()+2000;
      return { format: 'stnl-native-pre-verification-continuation-v1', binding, firstTurnId,
        firstToolResultUtf8, firstToolResultSha256: sha(firstToolResultUtf8) };
    },
    onChildCompleted: async ({ initialization }) => {
      if (initialization) {
        if(inspectionFailure) {
          const events=(await fs.readFile(path.join(f.root,'continued-provider.events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
          const admission=events.find(e=>e.type==='native.child.continuation.admitted');
          assert.deepEqual(admission.initializationCommandFailures,[{itemIndex:1,status:'failed',exitCode:1}],
            'feedback is in the existing event before the caller follows up');
          assert.doesNotMatch(JSON.stringify(admission),/private-missing-file|private-output-secret/);
        }
        s.state.turns.push({ id: 'formal-turn', rootTurnId: 'parent-turn', itemsView: 'full', status: 'completed',
          error: null, items: [{ id: 'judgment', type: 'agentMessage', phase: 'final_answer', text: 'Literal formal judgment\r\n' }] });
        s.state.parentItems.push({ ...s.state.parentItems[0], id: 'second-completion', kind: 'completed' });
      } else parentDone = true;
    } };
  const result = await provider.runTurn(args);
  Date.now=now;
  if(['parent-closed-during-admission','expired-during-admission'].includes(fault)) {
    assert.equal(result.completed,false);assert.match(result.error,fault==='expired-during-admission'?/deadline/:/principal/);
    assert.equal(s.state.turns.length,1);assert.equal(charged.size,1);
    assert.equal((await fs.readFile(result.eventsPath,'utf8')).includes('native.child.continuation.admitted'),false);
    assert.equal(JSON.parse(await fs.readFile(firstFile)).finalResponse,'Initialization is not a verdict.\n');
    return;
  }
  assert.equal(result.completed, true, result.error); assert.equal(admissionCount, 1); assert.equal(charged.size, 2);
  assert.equal(result.captures.length, 1); const saved = await fs.readFile(firstFile);
  const finalBytes = await fs.readFile(result.captures[0].file);
  if (fault === 'first-file-removed') await fs.unlink(firstFile);
  if (fault === 'first-alias') { await fs.rename(firstFile, firstFile + '.original'); await fs.symlink(firstFile + '.original', firstFile); }
  if (fault === 'simultaneous-drift') {
    s.state.turns[0].items.at(-1).text += 'changed';
    const changed = JSON.parse(saved); changed.finalResponse += 'changed'; await fs.writeFile(firstFile, JSON.stringify(changed) + '\n');
  }
  if(fault==='inspection-failure-history-drift')s.state.turns[0].items.find(x=>x.id==='inspection-failed').exitCode=2;
  if(fault==='inspection-failure-feedback-drift') {
    const events=(await fs.readFile(result.eventsPath,'utf8')).trim().split('\n').map(JSON.parse);
    events.find(e=>e.type==='native.child.continuation.admitted').initializationCommandFailures[0].exitCode=2;
    await fs.writeFile(result.eventsPath,events.map(e=>JSON.stringify(e)+'\n').join(''));
  }
  if (fault === 'duplicate-admission') {
    const events = (await fs.readFile(result.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    await fs.appendFile(result.eventsPath, JSON.stringify(events.find(event => event.type === 'native.child.continuation.admitted')) + '\n');
  }
  const replayArgs = { ...args, observation: { ...result, ...(fault === 'expired' ? { deadlineAt: Date.now() - 1 } : {}) },
    observeFormalBinding: async () => null,
    validateRetainedCaptures: async captures => assert.deepEqual(captures[0].toolResult, result.captures[0].toolResult),
    onPrepareContinuation: () => assert.fail('reobservation cannot admit another continuation'),
    onChildCompleted: () => {} };
  if (fault === 'duplicate-admission') await assert.rejects(provider.runTurn(replayArgs), blocked);
  else {
    const replay = await provider.runTurn(replayArgs);
    assert.equal(replay.completed, fault === null||fault==='inspection-failure', replay.error);
    if (fault === null||fault==='inspection-failure') assert.deepEqual(replay.captures[0].toolResult, result.captures[0].toolResult);
  }
  assert.deepEqual(await fs.readFile(result.captures[0].file), finalBytes, 'later observation cannot replace the formal result');
  if (fault === null||inspectionFailure) assert.deepEqual(await fs.readFile(firstFile), saved);
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1, 'only the original principal is dispatched');
});

test('auxiliary observation authenticates lineage and cost without granting formal capture', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root,
    mutate(state) { state.thread.forkedFromId = parent; state.thread.model = 'gpt-6.1-sol'; state.items = []; } });
  const binding = await bindAppServerChild(s.rpc, identity);
  assert.deepEqual(await observeAppServerChild(s.rpc, { binding, cwd: f.root }),
    { turns: [{ id: 'child-turn', status: 'completed' }], children: [] });
  await assert.rejects(readAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root }), blocked,
    'an auxiliary, even completed with a PASS-like answer, is not a formal runner');
  assert.ok(s.calls.every(call => /^thread\//u.test(call.method)), 'observation must not admit any turn');
});
for (const [name, mutate] of [
  ['foreign-parent', state => { state.thread.parentThreadId = 'foreign'; }],
  ['foreign-workspace', state => { state.thread.cwd = '/foreign'; }],
  ['error-with-completed', state => { state.turns[0].error = { message: 'uncertain' }; }],
  ['duplicate-turn', state => { state.turns.push(structuredClone(state.turns[0])); }],
  ['duplicate-edge', state => { state.items = [1, 2].map(index => ({ id: `edge-${index}`, type: 'subAgentActivity',
    kind: 'started', agentPath: '/root/nested', agentThreadId: 'nested' })); }],
]) test(`auxiliary observation blocks ${name}`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, mutate });
  const binding = await bindAppServerChild(s.rpc, identity);
  await assert.rejects(observeAppServerChild(s.rpc, { binding, cwd: f.root }), refuses({'foreign-parent':'auxiliary child metadata differs','foreign-workspace':'auxiliary child metadata differs',
      'error-with-completed':'invalid auxiliary turn (status=completed; error=present; cause=absent)',
      'duplicate-turn':'duplicate auxiliary turns','duplicate-edge':'child missing or ambiguous in parent turn'}[name]));
});

test('auxiliary turn IDs and known descendants remain accountable when later item or binding reads fail', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const binding = await bindAppServerChild(s.rpc, identity), charged = [];
  const rpc = { async request(method, params) {
    if (method === 'thread/turns/list') return { data: [...s.state.turns, { id: 'followup', status: 'completed', error: null }], nextCursor: null };
    if (method === 'thread/items/list' && params.turnId === 'followup') return { data: [
      { turnId: 'followup', item: { id: 'edge', type: 'subAgentActivity', kind: 'started', agentPath: '/root/nested', agentThreadId: 'nested' } },
      { turnId: 'followup', item: { id: 'denied', type: 'commandExecution', command: 'cat <<EOF',
        aggregatedOutput: "zsh:1: can't create temp file for here document: operation not permitted" } },
    ], nextCursor: null };
    return s.rpc.request(method, params);
  } };
  await assert.rejects(observeAppServerChild(rpc, { binding, cwd: f.root,
    onTurns: turns => charged.push(...turns.map(turn => turn.id)) }), error => {
    assert.match(error.message, /SANDBOX_COMMAND_DENIED/u);
    assert.deepEqual(error.descendants.map(value => value.agentThreadId), ['nested']); return true;
  });
  assert.deepEqual(charged, ['child-turn', 'followup'], 'failure cannot refund an already observed follow-up');
});

test('duplicate auxiliary history is rejected after charging its distinct observed turns', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const binding = await bindAppServerChild(s.rpc, identity), charged = [];
  const rpc = { request(method, params) {
    if (method === 'thread/turns/list') return { data: [s.state.turns[0], { id: 't2' }, { id: 't2' }], nextCursor: null };
    return s.rpc.request(method, params);
  } };
  await assert.rejects(observeAppServerChild(rpc, { binding, cwd: f.root,
    onTurns: turns => charged.push(...turns.map(turn => turn.id)) }), /duplicate auxiliary turns/u);
  assert.deepEqual(charged, ['child-turn', 't2']);
});

test('partial auxiliary pagination counts known turns but cannot certify the view', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const binding = await bindAppServerChild(s.rpc, identity), charged = [];
  const rpc = { request(method, params) {
    if (method === 'thread/turns/list') {
      if (params.cursor === null) return { data: [{ id: 't1' }, { id: 't2' }], nextCursor: 'next' };
      throw Error('OFFLINE second page unavailable');
    }
    return s.rpc.request(method, params);
  } };
  await assert.rejects(observeAppServerChild(rpc, { binding, cwd: f.root,
    onTurns: turns => charged.push(...turns.map(turn => turn.id)) }),
    refuses('native adapter dependency failed (stage=operation; kind=UNKNOWN; code=other)','DRIVER_FAILURE'));
  assert.deepEqual(charged, ['t1', 't2']);
});

test('a terminal principal cannot hand off while its auxiliary remains active', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true,
    mutate(state) { state.turns[0].status = 'inProgress'; } });
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const result = await provider.runTurn({ prompt: 'offline', workflowSkill: 'stnl-slice-executor', model: 'gpt-6-luna',
    effort: 'high', operationId: 'active-auxiliary', role: 'author', timeoutMs: 100, observeFormalBinding: async () => null });
  assert.equal(result.completed, false); assert.equal(result.terminalObserved, false);
  assert.deepEqual(result.captures, []);
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('a terminal principal keeps a reserved child pending until that same child is formally bound', async t => {
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});let observations=0,auxiliary=0,formal=0;
  const provider=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc,pollMs:1});
  const result=await provider.runTurn({prompt:'offline',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'reserved-same-child',role:'author',observeFormalBinding:async()=>++observations===1?{state:'pending'}:{agentPath:identity.agentPath},
    onFormalObserved:()=>{formal++;},onAuxiliaryCompleted:()=>{auxiliary++;}});
  assert.equal(result.completed,true,result.error);assert.equal(result.terminalObserved,true);
  assert.equal(observations,2);assert.equal(formal,1);assert.equal(auxiliary,0);assert.equal(result.captures.length,1);
});

test('a pending reservation with multiple completed children binds one exact child and settles the other once', async t => {
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const second={...structuredClone(s.state.parentItems[0]),id:'spawn-two',agentPath:'/root/check-two',agentThreadId:'019a0000-0000-7000-8000-000000000003'};
  const completed={...structuredClone(s.state.parentItems[0]),id:'complete-one',kind:'completed'};
  const completedTwo={...second,id:'complete-two',kind:'completed'};s.state.parentItems.push(second,completed,completedTwo);
  const request=s.rpc.request.bind(s.rpc),rpc={notify:s.rpc.notify,async request(method,params){
    if(params.threadId===second.agentThreadId&&method==='thread/read')return {thread:{...structuredClone(s.state.thread),id:second.agentThreadId}};
    if(params.threadId===second.agentThreadId&&method==='thread/turns/list')return {data:structuredClone(s.state.turns),nextCursor:null};
    if(params.threadId===second.agentThreadId&&method==='thread/items/list')return {data:structuredClone(s.state.items).map(item=>({turnId:params.turnId,item})),nextCursor:null};
    return request(method,params);
  }};
  const provider=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc,pollMs:1});
  let observations=0,auxiliary=[];const result=await provider.runTurn({prompt:'offline',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'reserved-multiple-children',role:'author',observeFormalBinding:async()=>++observations===1?{state:'pending'}:{agentPath:identity.agentPath},
    onAuxiliaryCompleted:binding=>auxiliary.push(binding.agentThreadId)});
  assert.equal(result.completed,true,result.error);assert.equal(observations,2);assert.equal(result.captures.length,1);
  assert.deepEqual(auxiliary,[second.agentThreadId]);
});

test('a later child can still become formal after an earlier child was conclusively auxiliary', async t => {
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const firstDone={...structuredClone(s.state.parentItems[0]),id:'complete-one',kind:'completed'};s.state.parentItems.push(firstDone);
  const second={...structuredClone(s.state.parentItems[0]),id:'spawn-two',agentPath:'/root/check-two',agentThreadId:'019a0000-0000-7000-8000-000000000003'};
  const secondDone={...second,id:'complete-two',kind:'completed'};let parentDone=false;
  const request=s.rpc.request.bind(s.rpc),rpc={notify:s.rpc.notify,async request(method,params){
    if(params.threadId===second.agentThreadId&&method==='thread/read')return {thread:{...structuredClone(s.state.thread),id:second.agentThreadId}};
    if(params.threadId===second.agentThreadId&&method==='thread/turns/list')return {data:structuredClone(s.state.turns),nextCursor:null};
    if(params.threadId===second.agentThreadId&&method==='thread/items/list')return {data:structuredClone(s.state.items).map(item=>({turnId:params.turnId,item})),nextCursor:null};
    const result=await request(method,params);
    if(method==='thread/turns/list'&&params.threadId===parent)result.data[0].status=parentDone?'completed':'inProgress';
    return result;
  }};
  const provider=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc,pollMs:1});
  let observations=0,auxiliary=[],formal=[];const result=await provider.runTurn({prompt:'offline',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'aux-then-formal',role:'author',observeFormalBinding:async()=>++observations===1?null:{agentPath:second.agentPath},
    onAuxiliaryCompleted:binding=>{auxiliary.push(binding.agentThreadId);s.state.parentItems.push(second,secondDone);parentDone=true;},
    onFormalObserved:(binding)=>formal.push(binding.agentThreadId)});
  assert.equal(result.completed,true,result.error);assert.equal(result.captures.length,1);assert.equal(observations,2);
  assert.deepEqual(auxiliary,[child]);assert.deepEqual(formal,[second.agentThreadId]);
});

test('a terminal principal remains blocked at the existing deadline while formal binding stays pending', async t => {
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const provider=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc,pollMs:1});let auxiliary=0;
  const result=await provider.runTurn({prompt:'offline',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'reserved-deadline',role:'author',timeoutMs:35,observeFormalBinding:async()=>({state:'pending'}),
    onAuxiliaryCompleted:()=>{auxiliary++;}});
  assert.equal(result.completed,false);assert.match(result.error,/observation deadline exceeded/u);
  assert.equal(result.terminalObserved,false);assert.equal(auxiliary,0);assert.deepEqual(result.captures,[]);
});

test('a formal designation with no matching official child identity blocks instead of becoming auxiliary success', async t => {
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});let auxiliary=0;
  const provider=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const result=await provider.runTurn({prompt:'offline',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'invalid-formal-identity',role:'author',observeFormalBinding:async()=>({agentPath:'/root/foreign'}),
    onAuxiliaryCompleted:()=>{auxiliary++;}});
  assert.equal(result.completed,false);assert.match(result.error,/formal designation does not match an observed child/u);
  assert.equal(auxiliary,0);assert.deepEqual(result.captures,[]);
});

test('parent denial preserves already observed child identities as uncertain cost, never formal proof', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true,
    mutate(state) { state.parentItems.push({ id: 'denied', type: 'commandExecution', command: 'cat <<EOF',
      aggregatedOutput: "zsh:1: can't create temp file for here document: operation not permitted" }); } });
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc });
  const observed = [];
  const result = await provider.runTurn({ prompt: 'offline', workflowSkill: 'stnl-slice-executor', model: 'gpt-6-luna',
    effort: 'high', operationId: 'denied-cost', role: 'author', observeFormalBinding: async () => null,
    onUnadmittedChildren: children => observed.push(...children) });
  assert.equal(result.completed, false); assert.match(result.error, /SANDBOX_COMMAND_DENIED/u);
  assert.deepEqual(observed.map(value => value.agentThreadId), [child]); assert.deepEqual(result.captures, []);
});

for (const parentItems of [true, false]) test(`partial ${parentItems ? 'parent' : 'auxiliary'} item history retains known child cost without certifying lineage`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true });
  const rpc = { notify: s.rpc.notify, request(method, params) {
    if (method === 'thread/items/list' && params.threadId === (parentItems ? parent : child)) {
      if (params.cursor !== null) throw Error('OFFLINE item page unavailable');
      const item = { id: 'partial-spawn', type: 'subAgentActivity', kind: 'started',
        agentPath: parentItems ? identity.agentPath : '/root/nested', agentThreadId: parentItems ? child : 'nested' };
      return { data: [{ turnId: params.turnId, item }], nextCursor: 'next' };
    }
    return s.rpc.request(method, params);
  } };
  if (parentItems) {
    const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc });
    const charged = [];
    const result = await provider.runTurn({ prompt: 'offline', workflowSkill: 'stnl-slice-executor', model: 'gpt-6-luna',
      effort: 'high', operationId: 'partial-parent', role: 'author', onUnadmittedChildren: values => charged.push(...values) });
    assert.equal(result.completed, false); assert.deepEqual(result.captures, []);
    assert.deepEqual(charged.map(value => value.agentThreadId), [child]);
  } else {
    const binding = await bindAppServerChild(rpc, identity);
    await assert.rejects(observeAppServerChild(rpc, { binding, cwd: f.root }), error => {
      assert.deepEqual(error.descendants.map(value => value.agentThreadId), ['nested']); return true;
    });
  }
});

function auxiliaryFollowupServer(options) {
  const s = server({ ...options, provider: true });
  const followup = structuredClone(s.state.turns[0]); followup.id = 'followup-turn';
  followup.items.at(-1).id = 'followup-answer'; followup.items.at(-1).text = 'Second auxiliary advice.';
  s.state.turns.push(followup);
  s.state.parentItems.push({ ...s.state.parentItems[0], id: 'subagent-completed-child-turn', kind: 'completed' },
    { ...s.state.parentItems[0], id: 'followup-call', kind: 'interacted' },
    { ...s.state.parentItems[0], id: 'subagent-completed-followup-turn', kind: 'completed' });
  const request = s.rpc.request.bind(s.rpc);
  s.rpc.request = async (method, params) => method === 'thread/items/list' && params.threadId === child
    ? { data: structuredClone(s.state.turns.find(turn => turn.id === params.turnId).items)
      .map(item => ({ turnId: params.turnId, item })), nextCursor: null }
    : request(method, params);
  return s;
}

test('auxiliary follow-up has two distinct completion events and two charged turns, never a formal capture', async t => {
  const f = await fixture(t), s = auxiliaryFollowupServer({ bundle: f.bundle, cwd: f.root });
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const charged = new Set(); let started = 0, completed = 0, formalObservations = 0;
  const result = await p.runTurn({ prompt: 'Offline selected operation', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6-luna', effort: 'high', operationId: 'aux-followup', role: 'review',
    observeFormalBinding: async () => { formalObservations++; return null; }, onChildStarted: () => { started++; },
    onChildTurns: (binding, turns) => { for (const turn of turns) charged.add(`${binding.agentThreadId}:${turn.id}`); },
    onAuxiliaryCompleted: () => { completed++; } });
  assert.equal(result.completed, true, result.error); assert.equal(started, 1); assert.equal(completed, 1);
  assert.equal(charged.size, 2); assert.deepEqual(result.captures, []); assert.equal(formalObservations, 1);
  const events = (await fs.readFile(result.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.some(event => event.type === 'native.child.completed'), false);
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('reobserving both auxiliary completions deduplicates advice settlement and charges by public turn ID', async t => {
  const f = await fixture(t), s = auxiliaryFollowupServer({ bundle: f.bundle, cwd: f.root });
  const followup = s.state.turns.pop(), followupEvents = s.state.parentItems.splice(-2);
  const request = s.rpc.request.bind(s.rpc); let parentDone = false, completed = 0, observations = 0, formalObservations = 0;
  s.rpc.request = async (method, params) => {
    const value = await request(method, params);
    if (method === 'thread/turns/list' && params.threadId === parent) value.data[0].status = parentDone ? 'completed' : 'inProgress';
    return value;
  };
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const charged = new Set();
  const result = await p.runTurn({ prompt: 'Offline selected operation', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6-luna', effort: 'high', operationId: 'aux-reobserve', role: 'review',
    observeFormalBinding: async () => { formalObservations++; return null; },
    onChildTurns: (binding, turns) => { observations++; for (const turn of turns) charged.add(`${binding.agentThreadId}:${turn.id}`); },
    onAuxiliaryCompleted: () => {
      completed++;
      if (completed === 1) {
        assert.equal(charged.size, 1, 'the first advice is settled before the follow-up exists');
        s.state.turns.push(followup); s.state.parentItems.push(...followupEvents);
      } else parentDone = true;
    } });
  assert.equal(result.completed, true, result.error); assert.equal(completed, 2);
  assert.ok(observations >= 3); assert.equal(charged.size, 2); assert.deepEqual(result.captures, []);
  assert.equal(formalObservations, 1, 'a conclusively auxiliary child is not reclassified during later observations');
});

for (const fault of ['duplicate-event', 'extra-completion', 'foreign-completion', 'duplicate-turn', 'failed-followup', 'incomplete-followup'])
test(`auxiliary follow-up rejects ${fault} without formal capture or another turn`, async t => {
  const f = await fixture(t), s = auxiliaryFollowupServer({ bundle: f.bundle, cwd: f.root });
  const last = s.state.parentItems.at(-1);
  if (fault === 'duplicate-event') last.id = 'subagent-completed-child-turn';
  if (fault === 'extra-completion') s.state.turns.pop();
  if (fault === 'foreign-completion') last.agentThreadId = 'foreign';
  if (fault === 'duplicate-turn') s.state.turns[1].id = s.state.turns[0].id;
  if (fault === 'failed-followup') s.state.turns[1].status = 'failed';
  if (fault === 'incomplete-followup') s.state.turns[1].status = 'inProgress';
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const result = await p.runTurn({ prompt: 'Offline selected operation', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6-luna', effort: 'high', operationId: `aux-${fault}`, role: 'review', observeFormalBinding: async () => null });
  assert.equal(result.completed, false);
  assert.equal(result.error,{'duplicate-event':'duplicate public history item','extra-completion':'auxiliary completion count exceeds completed public turns',
    'foreign-completion':'unmatched completed child identity','duplicate-turn':'duplicate auxiliary turns',
    'failed-followup':'auxiliary completion count exceeds completed public turns','incomplete-followup':'auxiliary completion count exceeds completed public turns'}[fault]); assert.deepEqual(result.captures, []);
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
});

for (const followup of [true, false]) test(`a designated formal child rejects ${followup ? 'multiple turns' : 'repeated completion for one turn'}`, async t => {
  const f = await fixture(t), s = auxiliaryFollowupServer({ bundle: f.bundle, cwd: f.root });
  if (!followup) s.state.turns.pop();
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc });
  const charged = new Set();
  const result = await p.runTurn({ prompt: 'Offline formal controller', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6-luna', effort: 'high', operationId: 'formal-followup', role: 'review',
    observeFormalBinding: async () => ({ agentPath: identity.agentPath }),
    onChildTurns: (binding, turns) => { for (const turn of turns) charged.add(`${binding.agentThreadId}:${turn.id}`); } });
  assert.equal(result.completed, false); assert.match(result.error, /formal child has repeated completion or follow-up/u);
  assert.equal(charged.size, followup ? 2 : 1); assert.deepEqual(result.captures, []);
});

for (const announce of [true, false]) test(`formal follow-up ${announce ? 'announced' : 'unannounced'} after readiness cannot replace the first bytes`, async t => {
  const f = await fixture(t), firstText = '  first official response\r\n𝛑\n';
  const s = server({ bundle: f.bundle, cwd: f.root, provider: true, response: firstText });
  s.state.parentItems.push({ ...s.state.parentItems[0], id: 'first-done', kind: 'completed' });
  const request = s.rpc.request.bind(s.rpc); let parentDone = false, firstFile, firstBytes, ready = 0;
  s.rpc.request = async (method, params) => {
    if (method === 'thread/items/list' && params.threadId === child) return {
      data: structuredClone(s.state.turns.find(turn => turn.id === params.turnId).items)
        .map(item => ({ turnId: params.turnId, item })), nextCursor: null };
    const value = await request(method, params);
    if (method === 'thread/turns/list' && params.threadId === parent) value.data[0].status = parentDone ? 'completed' : 'inProgress';
    return value;
  };
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const charged = new Set();
  const result = await p.runTurn({ prompt: 'Offline formal controller', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6-luna', effort: 'high', operationId: `formal-first-${announce}`, role: 'review',
    observeFormalBinding: async () => ({ agentPath: identity.agentPath }),
    onChildTurns: (binding, turns) => { for (const turn of turns) charged.add(`${binding.agentThreadId}:${turn.id}`); },
    onChildCompleted: async ({ capture }) => {
      ready++; firstFile = capture.file; firstBytes = await fs.readFile(firstFile);
      const next = structuredClone(s.state.turns[0]); next.id = 'second-formal-turn';
      next.items.at(-1).id = 'second-answer'; next.items.at(-1).text = 'different second response'; s.state.turns.push(next);
      if (announce) s.state.parentItems.push({ ...s.state.parentItems[0], id: 'second-done', kind: 'completed' });
      parentDone = true;
    } });
  assert.equal(result.completed, false); assert.equal(ready, 1); assert.equal(charged.size, 2);
  assert.equal(result.captures.length, 1); assert.equal(result.captures[0].toolResult.finalResponse, firstText);
  assert.deepEqual(await fs.readFile(firstFile), firstBytes);
  assert.equal(JSON.parse(firstBytes).finalResponse, firstText);
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
});

for(const fault of [null,'summary-prefix','null-phase-prefix','missing-first-envelope','full-prefix-disagrees','wrong-proof-hash','changed-first-response','third-turn','wrong-round'])
test(`formal coverage clarification preserves the first public turn (${fault??'admitted'})`,async t=>{
  const f=await fixture(t),firstText='BLOCKED: structured coverage proof missing',secondText='BLOCKED: authenticated coverage proof';
  const s=server({bundle:f.bundle,cwd:f.root,provider:true,response:firstText});
  s.state.parentItems.push({...s.state.parentItems[0],id:'first-completion',kind:'completed'});
  if(fault==='null-phase-prefix')s.state.turns[0].items.at(-1).phase=null;
  const request=s.rpc.request.bind(s.rpc);let parentDone=false,ready=0,firstFile,firstBytes,firstHistory;
  const base={agentPath:identity.agentPath,operationAttemptId:'proved-owner',operationId:'proved-operation',dispatchId:'proved-dispatch',round:1};
  let designation=base;
  s.rpc.request=async(method,params)=>{
    if(method==='thread/items/list'&&params.threadId===child)return{data:structuredClone(params.turnId===s.state.turns[0].id&&firstHistory&&['summary-prefix','full-prefix-disagrees'].includes(fault)?firstHistory:s.state.turns.find(turn=>turn.id===params.turnId).items).map(item=>({turnId:params.turnId,item})),nextCursor:null};
    const value=await request(method,params);
    if(method==='thread/turns/list'&&params.threadId===parent)value.data[0].status=parentDone?'completed':'inProgress';
    return value;
  };
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc,pollMs:1}),charged=new Set();
  const result=await p.runTurn({prompt:'Offline proof clarification',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',operationId:`coverage-${fault??'admitted'}`,role:'review',
    observeFormalBinding:async()=>designation,
    onChildTurns:(binding,turns)=>{for(const turn of turns)charged.add(`${binding.agentThreadId}:${turn.id}`);},
    onChildCompleted:async({capture})=>{
      ready++;
      if(ready===1) {
        firstFile=capture.file;firstBytes=await fs.readFile(firstFile);
        firstHistory=structuredClone(s.state.turns[0].items);
        const next=structuredClone(s.state.turns[0]);next.id='proof-clarification';next.items.at(-1).id='proof-response';next.items.at(-1).text=secondText;
        s.state.turns.push(next);s.state.parentItems.push({...s.state.parentItems[0],id:'proof-completion',kind:'completed'});
        designation={...base,round:fault==='wrong-round'?3:2,clarification:{agentId:identity.agentPath,round:1,responseSha256:fault==='wrong-proof-hash'?sha('foreign'):sha(firstText)}};
        if(fault==='changed-first-response')s.state.turns[0].items.at(-1).text='changed historical response';
        if(fault==='full-prefix-disagrees')s.state.turns[0].items.at(-1).text='divergent full surface';
        if(fault==='summary-prefix'){s.state.turns[0].itemsView='summary';s.state.turns[0].items=[];}
        if(fault==='missing-first-envelope')await fs.unlink(firstFile);
        parentDone=true;
      } else if(fault==='third-turn') {
        const third=structuredClone(s.state.turns[1]);third.id='unadmitted-third';third.items.at(-1).id='third-response';s.state.turns.push(third);
        s.state.parentItems.push({...s.state.parentItems[0],id:'third-completion',kind:'completed'});
      }
    }});
  const admitted=[null,'summary-prefix','null-phase-prefix'].includes(fault);
  assert.equal(result.completed,admitted,result.error);
  if(fault==='missing-first-envelope')await assert.rejects(fs.stat(firstFile),{code:'ENOENT'},'missing first envelope is never recreated');
  else assert.deepEqual(await fs.readFile(firstFile),firstBytes,'the original envelope is never replaced');
  assert.equal(charged.size,fault==='third-turn'?3:2);
  if(admitted) {
    assert.equal(result.captures.length,2);assert.notEqual(result.captures[0].file,result.captures[1].file);
    assert.deepEqual(result.captures.map(x=>x.toolResult.finalResponse),[firstText,secondText]);
    assert.deepEqual(result.captures.map(x=>x.designation.round),[1,2]);
    assert.equal(result.captures[1].turnId,'proof-clarification');
    const replay=await p.runTurn({prompt:'Offline proof clarification',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',operationId:`coverage-${fault??'admitted'}`,role:'review',
      observation:result,observeFormalBinding:async()=>designation,
      onChildTurns:(binding,turns)=>{for(const turn of turns)charged.add(`${binding.agentThreadId}:${turn.id}`);}});
    assert.equal(replay.completed,true,replay.error);assert.equal(replay.captures.length,2);
    assert.deepEqual(replay.captures.map(x=>x.toolResult),result.captures.map(x=>x.toolResult));
    assert.equal(charged.size,2,'reobservation does not add turns or charges');
  }
  assert.equal(s.calls.filter(call=>call.method==='turn/start').length,1,'collector never starts a child turn');
});

test('coverage clarification preserves a separately admitted initialization and both formal turns',async t=>{
  const f=await continuedHistory(t),first=await readAppServerChild(f.rpc,{binding:f.binding,bundle:f.bundle,cwd:f.root,continuation:f.continuation});
  const file=path.join(f.root,'first-formal.json');await writeNativeToolResult(file,first);
  const before=await fs.readFile(file),turn=structuredClone(f.s.state.turns[1]);turn.id='coverage-proof-turn';
  turn.items.at(-1).id='coverage-proof-answer';turn.items.at(-1).text='BLOCKED with structured omission proof';f.s.state.turns.push(turn);
  const options={binding:f.binding,bundle:f.bundle,cwd:f.root,continuation:f.continuation,
    priorCaptures:[{binding:f.binding,turnId:'continued-turn',file,toolResult:first}]};
  const clarified=await readAppServerChild(f.rpc,options),replay=await readAppServerChild(f.rpc,options);
  assert.equal(clarified.finalResponse,turn.items.at(-1).text);assert.deepEqual(replay,clarified);
  assert.equal(clarified.preVerificationContinuation,undefined,'the old initialization is not attributed to the new recipe round');
  assert.deepEqual(await fs.readFile(file),before);assert.ok(f.s.calls.every(call=>call.method.startsWith('thread/')));
});

test('S2 frozen paths select the intended skill despite homonyms; all siblings/runner are pinned', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  await initializeAppServer(s.rpc);
  const selected = await selectAppServerBundle(s.rpc, { bundle: f.bundle, cwd: f.root, skillName: 'stnl-slice-executor' });
  assert.deepEqual(selected.input, { type: 'skill', name: 'stnl-slice-executor',
    path: path.join(f.bundle.skillsRoot, 'stnl-slice-executor/SKILL.md') });
  assert.equal(selected.config['agents.stnl_validation_runner.config_file'], undefined);
  assert.deepEqual(selected.config['skills.config'].map(value => value.enabled), [true, true, false]);
  assert.deepEqual(s.calls.find(value => value.method === 'skills/extraRoots/set').params, { extraRoots: [f.bundle.skillsRoot] });
  assert.deepEqual(s.calls.find(value => value.method === 'skills/list').params, { cwds: [f.root], forceReload: true });
});

test('S2 excludes only frozen workflow homonyms and preserves distinct domain/legacy availability', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const distinct = [
    ['stnl-backend-dotnet', true], ['stnl-backend-node-typescript', true],
    ['stnl-database-persistence', true], ['stnl-frontend-react-next-angular', true],
    ['stnl-mobile-ios-swift', true], ['stnl-testing', true],
    ['stnl-security-auth', false], ['stnl-task-materializer', true],
    ['stnl-task-reviewer', false], ['unrelated-skill', true],
  ].map(([name, enabled]) => ({ name, enabled, path: `/normal-home/.agents/skills/${name}/SKILL.md` }));
  const siblingHomonym = { name: 'stnl-slice-quality-manager', enabled: true,
    path: '/normal-home/.agents/skills/stnl-slice-quality-manager/SKILL.md' };
  s.state.listing.data[0].skills.push(...distinct, siblingHomonym);
  const selected = await selectAppServerBundle(s.rpc, { bundle: f.bundle, cwd: f.root, skillName: 'stnl-slice-executor' });
  const overrides = selected.config['skills.config'];
  for (const skill of distinct) {
    assert.deepEqual(overrides.find(value => value.path === skill.path), { path: skill.path, enabled: skill.enabled },
      `${skill.name} must keep the client's setting even when the config array replaces inherited overrides`);
  }
  assert.deepEqual(overrides.filter(value => value.enabled === false && !distinct.some(skill => skill.path === value.path)).map(value => value.path), [
    '/normal-home/.agents/skills/stnl-slice-executor/SKILL.md', siblingHomonym.path,
  ]);
});

const genericRoleMetadata = {
  default: () => {},
  null: state => { state.thread.agentRole = null; },
  omitted: state => { delete state.thread.agentRole; },
};

for (const [role, mutate] of Object.entries(genericRoleMetadata))
test(`S2 optional generic role ${role} preserves metadata and literal response across reobservation`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, mutate });
  const binding = await bindAppServerChild(s.rpc, identity);
  const metadataBefore = structuredClone(s.state.thread);
  const options = { binding, bundle: f.bundle, cwd: f.root };
  const first = await readAppServerChild(s.rpc, options);
  assert.equal(first.finalResponse, s.state.items.at(-1).text);
  assert.deepEqual(await readAppServerChild(s.rpc, options), first);
  assert.deepEqual(s.state.thread, metadataBefore, 'optional metadata is never filled or normalized');
  assert.equal(Object.hasOwn(s.state.thread, 'agentRole'), role !== 'omitted');
  const file = path.join(f.root, 'literal-result.json');
  await writeNativeToolResult(file, first);
  const bytes = await fs.readFile(file);
  await writeNativeToolResult(file, await readAppServerChild(s.rpc, options));
  assert.ok(bytes.equals(await fs.readFile(file)));
  assert.ok(s.calls.every(call => ['thread/read', 'thread/items/list', 'thread/turns/list'].includes(call.method)));
});

for (const [name, change] of Object.entries({
  absent: s => s.listing.data[0].skills.shift(),
  disabled: s => { s.listing.data[0].skills[0].enabled = false; },
  homonymOnly: s => { s.listing.data[0].skills = s.listing.data[0].skills.slice(2); },
  wrongName: s => { s.listing.data[0].skills[0].name = 'stnl-other'; },
  nonSentinelNameInBundle: s => { s.listing.data[0].skills[0].name = 'unrelated-skill'; },
  wrongPathInBundle: s => { s.listing.data[0].skills[0].path = path.join(path.dirname(s.listing.data[0].skills[0].path), 'runtime/SKILL.md'); },
  duplicate: s => s.listing.data[0].skills.push(s.listing.data[0].skills[0]),
  discoveryError: s => s.listing.data[0].errors.push({ message: 'incomplete' }),
  wrongCwd: s => { s.listing.data[0].cwd = '/foreign'; },
})) test(`S2 discovery blocks ${name} before thread creation`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, mutate: change });
  await assert.rejects(() => startAppServerTurn(s.rpc, { bundle: f.bundle, cwd: f.root,
    skillName: 'stnl-slice-executor', prompt: 'normal input', model: 'gpt-6.1-sol', effort: 'high',
    approvalPolicy: 'never', sandbox: 'workspace-write' }), refuses(({absent:'frozen sibling absent from discovery',homonymOnly:'frozen sibling absent from discovery',
      disabled:'frozen skill identity differs',wrongName:'frozen skill identity differs',nonSentinelNameInBundle:'frozen skill identity differs',wrongPathInBundle:'frozen skill identity differs',
      duplicate:'missing/duplicate skill identity',discoveryError:'skill discovery incomplete',wrongCwd:'skill discovery incomplete'})[name]));
  assert.equal(s.calls.some(call => /^(?:thread|turn)\/start$/u.test(call.method)), false);
});

for (const kind of ['skill', 'sibling', 'runner', 'extra-file', 'symlink', 'mode']) {
  test(`S2 refuses frozen ${kind} drift before any public request`, async t => {
    const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
    const file = f.bundle.files.find(file => file.path.endsWith(kind === 'skill' ? 'SKILL.md' : 'helper.mjs')).path;
    if (kind === 'runner') await fs.appendFile(f.bundle.runner.path, '\n# changed\n');
    else if (kind === 'extra-file') await fs.writeFile(path.join(f.bundle.skillsRoot, 'extra'), 'changed');
    else if (kind === 'symlink') { await fs.unlink(file); await fs.symlink(f.bundle.runner.path, file); }
    else if (kind === 'mode') await fs.chmod(file, 0o700);
    else await fs.appendFile(file, '\nchanged');
    await assert.rejects(() => selectAppServerBundle(s.rpc, { bundle: f.bundle, cwd: f.root,
      skillName: 'stnl-slice-executor' }), refuses(kind==='symlink'?'bundle symlink':'bundle/sibling/runner hash or mode drift'));
    assert.equal(s.calls.length, 0);
  });
}

test('S2 explicit fresh turn settings do not copy auth or disable collaboration', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const result = await startAppServerTurn(s.rpc, { bundle: f.bundle, cwd: f.root,
    skillName: 'stnl-slice-executor', prompt: 'normal payload', model: 'gpt-6.1-sol', effort: 'high',
    approvalPolicy: 'never', sandbox: 'workspace-write' });
  assert.deepEqual(result, { threadId: parent, turnId: 'parent-turn', agentFeatures: {multi_agent:true,multi_agent_v2:true} });
  const start = s.calls.find(call => call.method === 'thread/start');
  assert.equal(start.params.config['features.multi_agent'], undefined);
  assert.equal(start.params.config['agents.stnl_validation_runner.config_file'], undefined);
  assert.deepEqual(s.calls.at(-1).params.input, [{ type: 'skill', name: 'stnl-slice-executor',
    path: path.join(f.bundle.skillsRoot, 'stnl-slice-executor/SKILL.md') }, { type: 'text', text: 'normal payload' }]);
});

for(const [name,data,expected] of [
  ['enabled',[{name:'multi_agent',enabled:true},{name:'multi_agent_v2',enabled:true}],{multi_agent:true,multi_agent_v2:true}],
  ['disabled',[{name:'multi_agent',enabled:false},{name:'multi_agent_v2',enabled:false}],{multi_agent:false,multi_agent_v2:false}],
  ['absent',[],{multi_agent:null,multi_agent_v2:null}],
  ['duplicate',[{name:'multi_agent',enabled:true},{name:'multi_agent',enabled:true}],null],
  ['untyped',[{name:'multi_agent',enabled:'true'}],null],
])test(`agent feature metadata stays readonly and explicit for ${name}`,async()=>{
  const calls=[],rpc={request:async(method,params)=>{calls.push({method,params});return {data,nextCursor:null};}};
  if(expected)assert.deepEqual(await readAppServerAgentFeatures(rpc,parent),expected);
  else await assert.rejects(readAppServerAgentFeatures(rpc,parent),refuses('ambiguous agent feature metadata'));
  assert.deepEqual(calls,[{method:'experimentalFeature/list',params:{threadId:parent,cursor:null,limit:100}}]);
});

test('S2 unsupported context/policy is rejected before configuration or turn effects', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const args = { bundle: f.bundle, cwd: f.root, skillName: 'stnl-slice-executor', prompt: 'payload',
    model: 'gpt-6.1-sol', effort: 'high', approvalPolicy: 'never', sandbox: 'workspace-write' };
  for (const extra of [{ threadId: parent }, { sandbox: 'typo' }, { approvalPolicy: 'accept-all' },
    { approvalPolicy: 'on-failure' }]) {
    await assert.rejects(() => startAppServerTurn(s.rpc, { ...args, ...extra }), refuses(extra.threadId?'continuity requires separately admitted existing author thread':'explicit turn settings required'));
  }
  assert.equal(s.calls.length, 0);
});

for(const operation of ['thread/start','thread/resume'])for(const mode of ['legacy',null,undefined])test(`S2 ${operation} unsupported history mode ${mode} blocks before model dispatch`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true}),request=s.rpc.request;
  s.rpc.request=async(method,params)=>{
    const result=await request(method,params);
    if(method===operation)result.thread.historyMode=mode;
    return result;
  };
  await assert.rejects(()=>startAppServerTurn(s.rpc,{bundle:f.bundle,cwd:f.root,
    skillName:'stnl-slice-executor',prompt:'payload',model:'gpt-6.1-sol',effort:'medium',
    ...(operation==='thread/resume'?{threadId:parent,admittedAuthorThread:{threadId:parent,cwd:f.root,
      bundleSha256:sha(Buffer.from(JSON.stringify(f.bundle))),role:'author'}}:{}),
    approvalPolicy:null,sandbox:null}),refuses('thread creation identity/version/history mode differs'));
  assert.equal(s.calls.filter(c=>c.method==='turn/start').length,0);
});

test('S2 server handshake version drift blocks initialization completion', async () => {
  let initialized = false;
  await assert.rejects(() => initializeAppServer({ async request() { return { userAgent: 'codex-cli/0.160.0' }; },
    notify() { initialized = true; } }), refuses('server handshake version differs'));
  assert.equal(initialized, false);
});

test('S2 official child mapping and completed full text survive observer restart without turns', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const binding = await bindAppServerChild(s.rpc, identity);
  const envelope = await readAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root });
  assert.deepEqual(envelope, { agentId: identity.agentPath, status: 'completed', finalResponse: s.state.items.at(-1).text });
  const restored = server({ bundle: f.bundle, cwd: f.root });
  // Property order is incidental to the persisted binding.
  const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(binding))).reverse());
  assert.deepEqual(await readAppServerChild(restored.rpc, { binding: reordered, bundle: f.bundle, cwd: f.root }), envelope);
  for (const call of [...s.calls, ...restored.calls]) assert.match(call.method, /^thread\/(?:read|items\/list|turns\/list)$/u);
  const file = path.join(f.root, 'tool-result.json');
  const first = await writeNativeToolResult(file, envelope), bytes = await fs.readFile(file);
  assert.equal(first.finalResponseSha256, sha(Buffer.from(envelope.finalResponse)));
  await writeNativeToolResult(file, envelope);
  assert.ok(bytes.equals(await fs.readFile(file)));
  await assert.rejects(() => writeNativeToolResult(file, { ...envelope, finalResponse: envelope.finalResponse + ' ' }), blocked);
  assert.ok(bytes.equals(await fs.readFile(file)));
});

for (const [role, roleMetadata] of Object.entries(genericRoleMetadata))
for (const [name, change] of Object.entries({
  absent: s => { s.parentItems = []; },
  onlyCompletedWait: s => { s.parentItems.shift(); },
  otherPath: s => { s.parentItems[0].agentPath = '/root/foreign'; },
  ambiguous: s => s.parentItems.push({ ...s.parentItems[0], id: 'spawn-two', agentThreadId: 'foreign' }),
  ambiguousThreadPath: s => s.parentItems.push({ ...s.parentItems[0], id: 'spawn-two', agentPath: '/root/other-path' }),
  foreignMetadata: s => { s.thread.id = 'foreign'; },
  foreignParent: s => { s.thread.parentThreadId = 'foreign'; },
  missingParent: s => { s.thread.parentThreadId = null; },
  forkedHistory: s => { s.thread.forkedFromId = parent; },
  foreignWorkspace: s => { s.thread.cwd = '/foreign'; },
  oldCli: s => { s.thread.cliVersion = '0.160.0'; },
  wrongRole: s => { s.thread.agentRole = 'stnl_validation_runner'; },
  otherRole: s => { s.thread.agentRole = 'worker'; },
  emptyRole: s => { s.thread.agentRole = ''; },
  malformedRole: s => { s.thread.agentRole = false; },
  wrongMetadataModel: s => { s.thread.model = 'other'; },
  wrongMetadataEffort: s => { s.thread.reasoningEffort = 'high'; },
  missingMetadataEffort: s => { s.thread.reasoningEffort = null; },
  wrongModel: s => { s.parentItems[0].model = 'other'; },
  missingModel: s => { s.parentItems[0].model = null; },
  wrongEffort: s => { s.parentItems[0].reasoningEffort = 'low'; },
  running: s => { s.turns[0].status = 'inProgress'; },
  error: s => { s.turns[0].error = { message: 'failed' }; },
  noTurns: s => { s.turns = []; },
  extraTurn: s => s.turns.push({ ...s.turns[0], id: 'extra' }),
  missingText: s => { s.items = []; },
  commentary: s => { s.items.at(-1).phase = 'commentary'; },
  partial: s => { s.items.at(-1).phase = 'partial_answer'; },
  divergent: s => { s.turns[0].items.at(-1).text += 'changed'; },
  divergentParentReport: s => { s.parentItems[1].agentsStates[child] = { status: 'completed', message: 'other bytes' }; },
  duplicateItems: s => s.items.push({ ...s.items[0] }),
  invalidUtf8: s => { s.items.at(-1).text = '\ud800'; s.turns[0].items.at(-1).text = '\ud800'; },
  truncatedContract: s => { s.items[0].aggregatedOutput = s.items[0].aggregatedOutput.slice(0, -1); },
})) test(`S2 no envelope for ${name}; no new turn/retry${role === 'default' ? '' : `; role ${role}`}`, async t => {
  const f = await fixture(t), good = server({ bundle: f.bundle, cwd: f.root });
  const binding = await bindAppServerChild(good.rpc, identity);
  const bad = server({ bundle: f.bundle, cwd: f.root, mutate: state => { roleMetadata(state); change(state); } });
  await assert.rejects(() => readAppServerChild(bad.rpc, { binding, bundle: f.bundle, cwd: f.root }), error=>{
    const meta=['foreignMetadata','foreignParent','missingParent','forkedHistory','foreignWorkspace','oldCli','wrongRole','otherRole','emptyRole','malformedRole','wrongMetadataModel','wrongMetadataEffort','missingMetadataEffort'];
    const expected=meta.includes(name)?'child metadata foreign, forked or version differs':({
      absent:'child missing or ambiguous in parent turn',onlyCompletedWait:'child missing or ambiguous in parent turn',otherPath:'child missing or ambiguous in parent turn',ambiguous:'child missing or ambiguous in parent turn',
      ambiguousThreadPath:'child thread has multiple official paths',wrongModel:'child binding changed',missingModel:'child binding changed',wrongEffort:'child binding changed',
      running:'fresh child has no admitted completed successful turn sequence (failed=TURN; status=inProgress; error=absent; cause=absent)',
      error:'fresh child has no admitted completed successful turn sequence (failed=TURN; status=completed; error=present; cause=absent)',
      noTurns:'fresh child has no admitted completed successful turn sequence (failed=COUNT)',extraTurn:'fresh child has no admitted completed successful turn sequence (failed=COUNT)',
      missingText:'generic runner contract read not observed before scope actions',commentary:'child final response missing/incomplete',partial:'child final response missing/incomplete',
      divergent:'public child surfaces disagree',divergentParentReport:'completed parent tool report disagrees with child text',duplicateItems:'duplicate public history item',
      invalidUtf8:'invalid UTF-8 response',truncatedContract:'generic runner complete contract output absent, truncated or foreign'})[name];
    assert.ok(expected,`missing diagnostic contract for ${name}`);return refuses(expected)(error);
  });
  assert.ok(bad.calls.every(call => ['thread/read', 'thread/items/list', 'thread/turns/list'].includes(call.method)));
});

for(const [name,change]of Object.entries({
  missing:s=>{s.items.shift();},
  late:s=>{s.items.unshift({id:'scope-read',type:'commandExecution',cwd:s.thread.cwd,status:'completed',exitCode:0,command:'cat src/cli.mjs',aggregatedOutput:'scope'});},
  claim:s=>{s.items[0]={id:'claim',type:'agentMessage',phase:'commentary',text:'I loaded the whole contract.'};},
  echo:s=>{s.items[0].command='echo fake contract';},
  foreignPath:s=>{s.items[0].command="cat '/other/stnl_validation_runner.toml'";},
  truncated:s=>{s.items[0].aggregatedOutput=s.items[0].aggregatedOutput.slice(0,-1);},
  changedBytes:s=>{s.items[0].aggregatedOutput+='changed';},
  nonzero:s=>{s.items[0].exitCode=1;},
  running:s=>{s.items[0].status='inProgress';},
  foreignCwd:s=>{s.items[0].cwd='/other';},
  extraShellEffect:s=>{s.items[0].command+='; touch src/other';},
}))test(`generic contract loading refuses ${name} without a new turn`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,mutate:change});
  const binding=await bindAppServerChild(s.rpc,identity);
  await assert.rejects(()=>readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root}),refuses(['missing','claim','nonzero','running','foreignCwd'].includes(name)?'generic runner contract read not observed before scope actions':'generic runner complete contract output absent, truncated or foreign'));
  assert.equal(s.calls.some(c=>c.method==='turn/start'),false);
});

for (const order of ['hash-first', 'read-first']) for (const hash of ['sha256sum', 'shasum -a 256'])
test(`generic contract loading accepts exact ${order} ${hash} output, with official identity`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  const read=`cat ${f.bundle.runner.path}`, digest=`${hash} ${f.bundle.runner.path}`;
  const command=order==='hash-first'?`${digest} && ${read}`:`${read} && ${digest}`;
  s.state.items[0].command=`/bin/zsh -lc '${command}'`;
  const text=s.state.items[0].aggregatedOutput,line=`${f.bundle.runner.sha256.slice(7)}  ${f.bundle.runner.path}\n`;
  s.state.items[0].aggregatedOutput=order==='hash-first'?line+text:text+line;
  const binding=await bindAppServerChild(s.rpc,identity);
  assert.equal((await readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root})).finalResponse,s.state.items.at(-1).text);
  assert.ok(s.calls.every(call=>['thread/read','thread/items/list','thread/turns/list'].includes(call.method)));
});

for (const order of ['hash-first', 'read-first']) for (const invalid of
  ['truncated', 'extra-output', 'wrong-hash', 'foreign-hash-path', 'foreign-read-path', 'reversed-output', 'foreign-identity', 'extra-shell-effect'])
test(`generic ${order} contract read rejects ${invalid} without a new turn`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root});
  const text=s.state.items[0].aggregatedOutput,read=`cat ${f.bundle.runner.path}`,digest=`shasum -a 256 ${f.bundle.runner.path}`;
  const line=`${f.bundle.runner.sha256.slice(7)}  ${f.bundle.runner.path}\n`;
  const output=(body,hashLine)=>order==='hash-first'?hashLine+body:body+hashLine;
  const command=order==='hash-first'?`${digest} && ${read}`:`${read} && ${digest}`;
  s.state.items[0].command=`/bin/zsh -lc '${command}'`;
  s.state.items[0].aggregatedOutput=output(text,line);
  if(invalid==='truncated')s.state.items[0].aggregatedOutput=output(text.slice(0,-1),line);
  if(invalid==='extra-output')s.state.items[0].aggregatedOutput+='extra';
  if(invalid==='wrong-hash')s.state.items[0].aggregatedOutput=output(text,'0'.repeat(64)+`  ${f.bundle.runner.path}\n`);
  if(invalid==='foreign-hash-path')s.state.items[0].aggregatedOutput=output(text,`${f.bundle.runner.sha256.slice(7)}  /other/runner.toml\n`);
  if(invalid==='foreign-read-path')s.state.items[0].command=s.state.items[0].command.replace(read,'cat /other/runner.toml');
  if(invalid==='reversed-output')s.state.items[0].aggregatedOutput=order==='hash-first'?text+line:line+text;
  if(invalid==='foreign-identity')s.state.thread.parentThreadId='foreign';
  if(invalid==='extra-shell-effect')s.state.items[0].command=`/bin/zsh -lc '${command}; touch other'`;
  const binding=await bindAppServerChild(s.rpc,identity);
  await assert.rejects(()=>readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root}),refuses(invalid==='foreign-identity'?'child metadata foreign, forked or version differs':'generic runner complete contract output absent, truncated or foreign'));
  assert.ok(s.calls.every(call=>['thread/read','thread/items/list','thread/turns/list'].includes(call.method)));
});

test('generic contract read preserves paths with spaces/quotes and double-quoted shell display',async t=>{
  const f=await fixture(t),root=f.root+" space's";await fs.rename(f.root,root);t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bundle=await describeAppServerBundle({skillsRoot:path.join(root,'skills/workflows'),runnerFile:path.join(root,'agents/codex/.codex/agents/stnl_validation_runner.toml')});
  const s=server({bundle,cwd:root}),script=s.state.items[0].command;
  s.state.items[0].command='/bin/zsh -lc "'+script.replace(/[\\$`"]/gu,'\\$&')+'"';
  const binding=await bindAppServerChild(s.rpc,identity);
  assert.equal((await readAppServerChild(s.rpc,{binding,bundle,cwd:root})).finalResponse,s.state.items.at(-1).text);
});

test('canonical contract read preserves literal special characters and still rejects altered commands/output',async t=>{
  const f=await fixture(t),root=f.root+" space's $() ` ; unicode-𝛑";
  await fs.rename(f.root,root);t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bundle=await describeAppServerBundle({skillsRoot:path.join(root,'skills/workflows'),
    runnerFile:path.join(root,'agents/codex/.codex/agents/stnl_validation_runner.toml')});
  const command=canonicalContractReadCommand(bundle.runner.path);
  assert.equal(bundle.runner.readCommand,command,'producer owns the derived command');
  const read=spawnSync('/bin/zsh',['-c',command],{cwd:root,encoding:'utf8'});
  assert.equal(read.status,0);assert.equal(read.stderr,'');assert.equal(read.stdout,await fs.readFile(bundle.runner.path,'utf8'));
  const s=server({bundle,cwd:root});s.state.items[0].command=command;s.state.items[0].aggregatedOutput=read.stdout;
  const binding=await bindAppServerChild(s.rpc,identity),options={binding,bundle,cwd:root,initialization:true};
  assert.equal((await readAppServerChild(s.rpc,options)).status,'completed');
  // Malicious/unknown commands are represented as fake public history, never executed.
  s.state.items[0].command=command+'; touch forbidden';
  await assert.rejects(readAppServerChild(s.rpc,options),blocked);
  s.state.items[0].command=command;s.state.items[0].aggregatedOutput+='foreign output';
  await assert.rejects(readAppServerChild(s.rpc,options),blocked);
  const tampered=structuredClone(bundle);tampered.runner.readCommand+='; touch forbidden';
  await assert.rejects(assertAppServerBundle(tampered),blocked,'a caller cannot change the producer command');
  assert.throws(()=>canonicalContractReadCommand('/noncanonical/../runner.toml'),blocked);
});

test('S2 another completed child is not substituted for the scoped child', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, mutate(state) {
    state.parentItems.unshift({ ...state.parentItems[0], id: 'other-spawn',
      agentPath: '/root/foreign', agentThreadId: 'other-child' });
    state.parentItems.at(-1).agentsStates['other-child'] = { status: 'completed', message: 'foreign bytes' };
    state.parentItems.at(-1).agentsStates[child] = { status: 'completed', message: state.items.at(-1).text };
  } });
  const binding = await bindAppServerChild(s.rpc, identity);
  assert.equal(binding.agentThreadId, child);
  const result = await readAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root });
  assert.equal(result.finalResponse, s.state.items.at(-1).text);
  assert.ok(s.calls.filter(call => call.method === 'thread/read').every(call => call.params.threadId === child));
});

for(const command of ['sed -n \'1,5p\' source.mjs','rg --files test','/bin/zsh -lc "sed -n \'1,5p\' source.mjs"'])
test(`initialization observation does not own internal command spelling: ${command}`,async t=>{
  const f=await continuedHistory(t);
  f.s.state.turns[0].items.splice(1,0,{id:'discovery',type:'commandExecution',command,
    cwd:f.root,status:'completed',exitCode:0,aggregatedOutput:'synthetic discovery',commandActions:[{type:'unknown',command}]});
  const options={binding:f.binding,bundle:f.bundle,cwd:f.root,continuation:f.continuation};
  const before=JSON.stringify(f.s.state),first=await readAppServerChild(f.rpc,options),replay=await readAppServerChild(f.rpc,options);
  assert.deepEqual(first,replay);assert.equal(first.finalResponse,'First and only formal response\r\n');
  assert.equal(first.preVerificationContinuation.firstToolResultUtf8,f.continuation.firstToolResultUtf8);
  assert.equal(JSON.stringify(f.s.state),before);
  assert.ok(f.s.calls.every(call=>['thread/read','thread/items/list','thread/turns/list'].includes(call.method)));
});

for(const replay of [false,true])
test(`initialization observation preserves actual shell denial with final exit zero (${replay?'replay':'admission'})`,async t=>{
  const f=await continuedHistory(t),first=f.s.state.turns[0];
  first.items.splice(1,0,{id:'denied-initialization',type:'commandExecution',cwd:f.root,status:'completed',exitCode:0,
    command:'cat <<EOF\nsynthetic\nEOF\ntrue',
    aggregatedOutput:"zsh:1: can't create temp file for here document: operation not permitted\n"});
  if(!replay)f.s.state.turns=[first];
  await assert.rejects(readAppServerChild(f.rpc,{binding:f.binding,bundle:f.bundle,cwd:f.root,
    ...(replay?{continuation:f.continuation}:{initialization:true})}),
    refuses('SANDBOX_COMMAND_DENIED: runner implicit temporary file denial'));
  assert.ok(f.s.calls.every(call=>['thread/read','thread/items/list','thread/turns/list'].includes(call.method)));
});

test('S2 consumes every history page and blocks a repeated/incomplete cursor', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const request = s.rpc.request.bind(s.rpc), seen = [];
  s.rpc.request = async (method, params) => {
    if (method === 'thread/items/list' && params.threadId === parent) {
      seen.push(params.cursor);
      return params.cursor === null ? { data: [], nextCursor: 'page2' } : request(method, params);
    }
    return request(method, params);
  };
  const binding = await bindAppServerChild(s.rpc, identity);
  assert.equal(binding.agentThreadId, child); assert.deepEqual(seen, [null, 'page2']);
  s.rpc.request = async () => ({ data: [], nextCursor: 'same' });
  await assert.rejects(() => bindAppServerChild(s.rpc, identity), blocked);
});

test('S2 refuses duplicate child item IDs across public history pages', async t => {
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root}),request=s.rpc.request;
  let pagesRead=0;
  s.rpc.request=async(method,params)=>{
    const result=await request(method,params);
    if(method!=='thread/items/list'||params.threadId!==child)return result;
    pagesRead++;return {...result,data:[result.data[0]],nextCursor:params.cursor===null?'second-page':null};
  };
  const binding=await bindAppServerChild(s.rpc,identity);
  await assert.rejects(()=>readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root}),error=>blocked(error)&&/duplicate public history item/u.test(error.message));
  assert.equal(pagesRead,2);assert.equal(s.calls.some(c=>c.method==='turn/start'),false);
});

test('S2 nullable optional history fields retain public 0.163 compatibility', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root,
    mutate(state) { delete state.turns[0].error; delete state.turns[0].itemsView;
      delete state.thread.forkedFromId; delete state.items.at(-1).phase; delete state.turns[0].items.at(-1).phase; } });
  const request = s.rpc.request.bind(s.rpc);
  s.rpc.request = async (method, params) => {
    const result = await request(method, params);
    if (Object.hasOwn(result, 'nextCursor')) delete result.nextCursor;
    return result;
  };
  const binding = await bindAppServerChild(s.rpc, identity);
  assert.equal((await readAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root })).finalResponse,
    s.state.items.at(-1).text);
});

function wire(t, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const rpc = appServerRpc({ input, output, diagnostics, timeoutMs: 1000, ...options });
  const sent = []; output.on('data', bytes => sent.push(JSON.parse(bytes.toString('utf8'))));
  t.after(() => { rpc.close(); input.destroy(); output.destroy(); diagnostics.destroy(); });
  return { input, output, diagnostics, rpc, sent };
}

for (const [name, value, expected] of [
  ['method', { code: -32601, message: 'Method not found: private-method' }, { code: -32601, description: 'method not found' }],
  ['params', { code: -32602, message: 'Invalid params at /Users/private/config' }, { code: -32602, description: 'invalid params' }],
  ['state', { code: -32600, message: 'thread private-id is not materialized; unavailable before first user message' },
    { code: -32600, description: 'not materialized; unavailable before first user message' }],
  ['capability', { code: -32600, message: 'requires experimental API; private data omitted' }, { code: -32600, description: 'experimental' }],
  ['history-io', { code: -32603, message: 'failed to read thread: /Users/private/session: No such file or directory (os error 2)' },
    { code: -32603, description: 'failed to read thread; no such file or directory; os error 2' }],
  ['unknown', { code: -32001, message: 'Bearer secret-value /Users/private/session', data: { token: 'secret-value' } }, { code: -32001, description: 'omitted' }],
  ['invalid-code', { code: 'secret-value', message: 'private server detail' }, { code: null, description: 'invalid error envelope' }],
  ['oversized-code', { code: 1e100, message: 'private server detail' }, { code: null, description: 'invalid error envelope' }],
]) test(`RPC rejection retains bounded code/category only: ${name}`, async t => {
  const w = wire(t), pending = w.rpc.request('thread/turns/list', { threadId: parent });
  const rejection = assert.rejects(pending, error => {
    assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
    assert.deepEqual(error.rpcError, expected);
    const serialized = JSON.stringify({ message: error.message, rpcError: error.rpcError });
    for (const secret of ['secret-value', '/Users/', 'private-id', 'private-method', 'private data', 'private server']) assert.equal(serialized.includes(secret), false);
    assert.ok(Buffer.byteLength(error.rpcError.description) <= 256);
    return true;
  });
  const line = Buffer.from(JSON.stringify({ id: w.sent[0].id, error: value })+'\n');
  // The projection sees the decoded frame, so secrets split across chunks cannot escape.
  for (let offset=0; offset<line.length; offset+=7) w.input.write(line.subarray(offset, offset+7));
  await rejection;
  assert.equal(w.sent.length, 1);
});

for (const [name, mutateEntry] of [
  ['bare-item', entry => entry.item],
  ['foreign-turn', entry => ({...entry,turnId:'foreign-turn'})],
  ['missing-item', entry => ({turnId:entry.turnId})],
  ['invalid-item-id', entry => ({...entry,item:{...entry.item,id:''}})],
  ['duplicate-item', entry => [entry,entry]],
]) test(`public item envelope rejects ${name} for parent and child without another dispatch`, async t => {
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true}),request=s.rpc.request;
  let scope=parent;
  s.rpc.request=async(method,params)=>{
    const result=await request(method,params);
    if(method!=='thread/items/list'||params.threadId!==scope)return result;
    const transformed=result.data.map(mutateEntry).flat();return {...result,data:transformed};
  };
  const provider=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc});
  const result=await provider.runTurn({prompt:'offline',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',operationId:'invalid-envelope',role:'author'});
  assert.equal(result.completed,false);assert.equal(result.error,name==='duplicate-item'?'duplicate public history item':'public item entry absent or foreign');assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
  scope=child;
  await assert.rejects(()=>readAppServerChild(s.rpc,{binding:{...identity,agentThreadId:child,model:'gpt-6-luna',effort:'medium'},bundle:f.bundle,cwd:f.root}),refuses(name==='duplicate-item'?'duplicate public history item':'public item entry absent or foreign'));
});

test('RPC rejection omits text after its 2048-character diagnostic prefix', async t => {
  const w = wire(t), pending = w.rpc.request('thread/read', { threadId: child });
  const rejected = assert.rejects(pending, error => {
    assert.deepEqual(error.rpcError, { code: -32600, description: 'omitted' }); return true;
  });
  w.input.write(JSON.stringify({ id: w.sent[0].id, error: { code: -32600,
    message: 'x'.repeat(2048)+'permission denied private-value', data: 'secret-value' } })+'\n');
  await rejected; assert.equal(w.sent.length, 1);
});

test('unknown official history cause exposes fixed labels without dynamic word sequences', async t => {
  const w = wire(t), pending = w.rpc.request('thread/turns/list', { threadId: parent });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.rpcError.code, -32603); assert.equal(error.initialHistoryUnavailable, false);
    assert.equal(error.rpcError.description, 'history cause: SESSION_METADATA; JSON_EOF');
    for (const value of ['alice','private','key-value','read file metadata','17','https','secret-host']) assert.equal(error.message.includes(value), false);
    assert.ok(Buffer.byteLength(error.rpcError.description) <= 256); return true;
  });
  const error = { code: -32603, message: 'failed to read thread: thread-store internal error: failed to read session metadata /Users/alice/private: unexpected end of input at line 17; password=read file metadata; https://secret-host/key-value', data: { secret: 'key-value' } };
  const line=Buffer.from(JSON.stringify({id:w.sent[0].id,error})+'\n');
  for(let offset=0;offset<line.length;offset+=3)w.input.write(line.subarray(offset,offset+3));
  await rejected;assert.equal(w.sent.length,1);
});

for (const value of ['client_secret=read file metadata', 'credentials=database locked',
  '/Users/private/secret read file metadata']) test(`history projection never reconstructs values: ${value.split('=')[0]}`, async t => {
  const w = wire(t), pending = w.rpc.request('thread/turns/list', { threadId: parent });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.initialHistoryUnavailable, false);
    assert.ok(['history cause: DATABASE_LOCKED', 'failed to read thread; cause omitted'].includes(error.rpcError.description));
    assert.equal(error.message.includes(value), false);
    assert.equal(error.message.includes('read file metadata'), false); return true;
  });
  w.input.write(JSON.stringify({ id: w.sent[0].id, error: { code: -32603,
    message: `failed to read thread: thread-store internal error: ${value}` } })+'\n');
  await rejected; assert.equal(w.sent.length, 1);
});

for (const [message, label] of [
  ['failed to read session metadata /private/path: rollout at /private/path is empty', 'SESSION_METADATA; EMPTY_ROLLOUT'],
  ['failed to read session metadata /private/path: rollout at /private/path does not start with session metadata', 'SESSION_METADATA; RESPONSE_BEFORE_METADATA'],
]) test(`official metadata cause projects fixed label: ${label}`, async t => {
  const w = wire(t), pending = w.rpc.request('thread/turns/list', { threadId: parent });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.initialHistoryUnavailable, false);
    assert.equal(error.rpcError.description, `history cause: ${label}`); return true;
  });
  w.input.write(JSON.stringify({ id: w.sent[0].id, error: { code: -32603,
    message: `failed to read thread: thread-store internal error: ${message}` } })+'\n');
  await rejected; assert.equal(w.sent.length, 1);
});

test('provider result and event retain safe RPC rejection detail without another turn', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true }), w = wire(t);
  const request = s.rpc.request;
  s.rpc.request = (method, params) => {
    if (method !== 'thread/turns/list') return request(method, params);
    const pending = w.rpc.request(method, params);
    w.input.write(JSON.stringify({ id: w.sent.at(-1).id, error: { code: -32600,
      message: 'thread private-id is not materialized; Bearer private-secret', data: { secret: 'private-secret' } } })+'\n');
    return pending;
  };
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc });
  const result = await provider.runTurn({ prompt: 'offline only', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6-luna', effort: 'high', operationId: 'rpc-rejection', role: 'author' });
  assert.equal(result.completed, false); assert.equal(result.turnStarted, null);
  assert.equal(result.error, 'App Server rejected thread/turns/list (RPC -32600: not materialized)');
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(w.sent.length, 1); assert.deepEqual(result.captures, []);
  const events = await fs.readFile(result.eventsPath, 'utf8');
  assert.ok(events.includes(result.error));
  for (const secret of ['private-id','private-secret','Bearer']) assert.equal(JSON.stringify(result).includes(secret) || events.includes(secret), false);
});

const initialRollout = `/Users/private/.codex/sessions/rollout-2026-10-24-${parent}.jsonl`;
const emptyMetadataError = (file = initialRollout, nested = true) => ({ code: -32603,
  message: `failed to read thread: thread-store internal error: failed to read session metadata ${file}: ${nested ? `thread-store internal error: failed to read session metadata ${file}: ` : ''}rollout at ${file} is empty` });
for (const [name, value, allowed] of [
  ['official-nested', emptyMetadataError(), true],
  ['official-direct', emptyMetadataError(initialRollout, false), true],
  ['foreign-rollout', emptyMetadataError(initialRollout.replace(parent, child)), false],
  ['path-traversal', emptyMetadataError(initialRollout.replace('/sessions/', '/sessions/../sessions/')), false],
  ['different-inner-path', {code:-32603,message:emptyMetadataError().message.replace(`rollout at ${initialRollout}`, `rollout at /other-${parent}.jsonl`)}, false],
  ['case-distinct-inner-path', {code:-32603,message:emptyMetadataError().message.replace(`rollout at ${initialRollout}`, `rollout at ${initialRollout.replace('/private/', '/PRIVATE/')}`)}, false],
  ['quoted-wrapper', {code:-32603,message:'wrapper says '+emptyMetadataError().message}, false],
  ['suffix', {code:-32603,message:emptyMetadataError().message+'; schema mismatch'}, false],
  ['permission', {code:-32603,message:emptyMetadataError().message+'; permission denied'}, false],
  ['metadata-order', {code:-32603,message:emptyMetadataError().message.replace('is empty', 'does not start with session metadata')}, false],
]) test(`initial empty metadata scopes the exact causal chain: ${name}`, async t => {
  const w=wire(t), pending=w.rpc.request('thread/turns/list',{threadId:parent});
  const rejected=assert.rejects(pending,error=>{assert.equal(error.initialHistoryUnavailable,allowed);return true;});
  w.input.write(JSON.stringify({id:w.sent[0].id,error:value})+'\n'); await rejected; assert.equal(w.sent.length,1);
});

async function historyBootstrapFixture(t, history) {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true,
    mutate: state => { state.parentItems = []; } }), w = wire(t), request = s.rpc.request;
  let reads = 0;
  s.rpc.request = (method, params) => {
    if (method !== 'thread/turns/list') return request(method, params);
    reads++;
    const next = history(reads, params);
    if (next === undefined) return request(method, params);
    const pending = w.rpc.request(method, params);
    if (next !== 'stall') w.input.write(JSON.stringify({ id: w.sent.at(-1).id,
      ...(next.error ? { error: next.error } : { result: next }) })+'\n');
    return pending;
  };
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  return { f, s, w, provider, reads: () => reads,
    args: { prompt: 'offline only', workflowSkill: 'stnl-slice-executor', model: 'gpt-6-luna', effort: 'high',
      operationId: 'history-bootstrap', role: 'author', timeoutMs: 200 } };
}

for (const [name, first] of [
  ['not-materialized', { error: { code: -32600, message: `thread ${parent} is not materialized yet; thread/turns/list is unavailable before first user message` } }],
  ['read-enoent', { error: { code: -32603, message: 'failed to read thread: /Users/private/rollout: No such file or directory (os error 2)' } }],
  ['list-enoent', { error: { code: -32603, message: 'failed to list thread history: No such file or directory (os error 2)' } }],
  ['load-enoent', { error: { code: -32603, message: `failed to load thread history for thread ${parent}: No such file or directory (os error 2)` } }],
  ['empty-page', { data: [], nextCursor: null }],
  ['metadata-not-yet-readable', { error: emptyMetadataError() }],
  ['paginated-index-not-yet-readable', { error: { code: -32601, message: 'list_turns is not supported yet' } }],
]) test(`initial public history ${name} is observed on the same dispatch without another turn`, async t => {
  const h = await historyBootstrapFixture(t, n => n === 1 ? first : undefined);
  const result = await h.provider.runTurn(h.args);
  assert.equal(result.completed, true); assert.equal(result.threadId, parent); assert.equal(result.turnId, 'parent-turn');
  assert.equal(h.reads(), 2); assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
  const events = (await fs.readFile(result.eventsPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(e => e.type === 'native.history.pending').length, 1);
});

for (const [name, first] of [
  ['unknown-internal', { error: { code: -32603, message: 'database failure' } }],
  ['known-words-unknown-cause', { error: { code: -32603, message: 'failed to read thread: thread-store internal error: database locked' } }],
  ['quoted-prefix', { error: { code: -32603, message: 'wrapper quotes failed to read thread: No such file or directory (os error 2)' } }],
  ['permission', { error: { code: -32603, message: 'failed to read thread: No such file or directory (os error 2); permission denied' } }],
  ['permission-outside-prefix', { error: { code: -32603, message: 'failed to read thread: No such file or directory (os error 2)'+'x'.repeat(2048)+'operation not permitted' } }],
  ['foreign-error-thread', { error: { code: -32603, message: `failed to load thread history for thread ${child}: No such file or directory (os error 2)` } }],
  ['foreign-turn', { data: [{ id: 'foreign', status: 'completed' }], nextCursor: null }],
  ['duplicate-turn', { data: [{ id: 'parent-turn' }, { id: 'parent-turn' }], nextCursor: null }],
]) test(`initial public history ${name} remains blocking`, async t => {
  const h = await historyBootstrapFixture(t, () => first), result = await h.provider.runTurn(h.args);
  assert.equal(result.completed, false); assert.equal(h.reads(), 1);
  assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('initial metadata absence cannot bypass the deadline or permit a resumed turn', async t => {
  const h=await historyBootstrapFixture(t,()=>({error:emptyMetadataError()}));
  const result=await h.provider.runTurn({...h.args,timeoutMs:25});
  assert.equal(result.completed,false);assert.ok(h.reads()>=1);
  assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,1);
  await fs.writeFile(path.join(h.f.root,'history-bootstrap.events.jsonl'),'');
  const before=h.reads();const resumed=await h.provider.runTurn({...h.args,observation:{threadId:parent,turnId:'parent-turn',deadlineAt:Date.now()+1000}});
  assert.equal(resumed.completed,false);assert.equal(h.reads(),before+1);
  assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,1);
});

for (const [name, value] of [
  ['method-absent', {code:-32601,message:'Method not found'}],
  ['other-operation', {code:-32601,message:'paginated_history is not supported yet'}],
  ['unknown-wrapper', {code:-32601,message:'wrapper: list_turns is not supported yet'}],
  ['permission', {code:-32601,message:'list_turns is not supported yet; permission denied'}],
]) test(`unsupported history ${name} is fatal without metadata fallback`, async t => {
  const h=await historyBootstrapFixture(t,()=>({error:value}));
  const result=await h.provider.runTurn(h.args);
  assert.equal(result.completed,false);assert.equal(h.reads(),1);
  assert.equal(h.s.calls.filter(c=>c.method==='thread/read').length,0);
});

for(const [name,patch] of [
  ['legacy',{historyMode:'legacy'}],['missing-mode',{historyMode:null}],
  ['foreign-id',{id:child}],['foreign-cwd',{cwd:'/other'}],
  ['wrong-version',{cliVersion:'0.162.0'}],['child',{parentThreadId:child}],
]) test(`initial paginated index requires matching public metadata: ${name}`,async t=>{
  const h=await historyBootstrapFixture(t,()=>({error:{code:-32601,message:'list_turns is not supported yet'}}));
  const request=h.s.rpc.request;
  h.s.rpc.request=async(method,params)=>{
    const result=await request(method,params);
    if(method==='thread/read')Object.assign(result.thread,patch);
    return result;
  };
  const result=await h.provider.runTurn(h.args);
  assert.equal(result.completed,false);assert.equal(h.reads(),1);
});

test('initial paginated index observation keeps the existing deadline and stops at terminal',async t=>{
  const h=await historyBootstrapFixture(t,n=>n===1
    ?{error:{code:-32601,message:'list_turns is not supported yet'}}
    :{data:[{id:'parent-turn',status:'interrupted',error:null}],nextCursor:null});
  const result=await h.provider.runTurn(h.args);
  assert.equal(result.completed,false);assert.equal(result.error,'parent turn failed/interrupted (status=interrupted; error=absent; cause=absent)');
  assert.equal(h.reads(),2);assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,1);
});

test('unsupported paginated index is fatal after a valid observation',async t=>{
  const h=await historyBootstrapFixture(t,n=>n===1
    ?{data:[{id:'parent-turn',status:'inProgress',error:null}],nextCursor:null}
    :{error:{code:-32601,message:'list_turns is not supported yet'}});
  const result=await h.provider.runTurn(h.args);
  assert.equal(result.completed,false);assert.equal(h.reads(),2);
});

test('unsupported paginated index cannot refresh resumed observation',async t=>{
  const h=await historyBootstrapFixture(t,()=>({error:{code:-32601,message:'list_turns is not supported yet'}}));
  await fs.writeFile(path.join(h.f.root,'history-bootstrap.events.jsonl'),'');
  const result=await h.provider.runTurn({...h.args,observation:{threadId:parent,turnId:'parent-turn',deadlineAt:Date.now()+1000}});
  assert.equal(result.completed,false);assert.equal(h.reads(),1);
  assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,0);
});

test('a persistently unavailable paginated index cannot certify completion or extend the deadline',async t=>{
  const h=await historyBootstrapFixture(t,()=>({error:{code:-32601,message:'list_turns is not supported yet'}}));
  const before=Date.now(),result=await h.provider.runTurn({...h.args,timeoutMs:25});
  assert.equal(result.completed,false);assert.equal(result.response,null);
  assert.deepEqual(result.captures,[]);assert.ok(Date.now()-before<500);
  assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,1);
});

for(const status of ['interrupted','failed'])test(`initial metadata pending followed by ${status} stops before timeout without a new turn`,async t=>{
  const h=await historyBootstrapFixture(t,n=>n===1?{error:emptyMetadataError()}:{data:[{id:'parent-turn',status,error:null}],nextCursor:null});
  const started=Date.now(),result=await h.provider.runTurn({...h.args,timeoutMs:1000});
  assert.equal(result.completed,false);assert.equal(result.error,`parent turn failed/interrupted (status=${status}; error=absent; cause=absent)`);assert.equal(h.reads(),2);
  assert.ok(Date.now()-started<500);assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,1);
});

const publicParentErrorCases = [
  ...['contextWindowExceeded','sessionBudgetExceeded','usageLimitExceeded','rateLimitExceeded','flexUnavailable',
    'serverOverloaded','cyberPolicy','misalignmentPolicyViolation','tooManyDenials','internalServerError',
    'unauthorized','badRequest','threadRollbackFailed','sandboxError','other'].map(cause => [cause, cause, cause]),
  ...['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts']
    .map(cause => [cause, {[cause]:{httpStatusCode:503}}, cause]),
  ['activeTurnNotSteerable', {activeTurnNotSteerable:{turnKind:'review'}}, 'activeTurnNotSteerable'],
  ['absent cause', null, 'absent'],
  ['unknown cause', 'private-cause-secret', 'unrecognized'],
  ['unknown tagged cause', {'private-cause-secret':{}}, 'unrecognized'],
  ['multiple tags', {httpConnectionFailed:{},'private-cause-secret':{}}, 'unrecognized'],
];
for (const [name, codexErrorInfo, cause] of publicParentErrorCases)
test(`parent failure preserves safe public cause without retry (${name})`, async t => {
  const h=await historyBootstrapFixture(t,n=>n===1?{error:emptyMetadataError()}:
    {data:[{id:'parent-turn',status:'failed',error:{message:'private-message-secret /private/path',
      additionalDetails:'private-details-secret',codexErrorInfo}}],nextCursor:null});
  const result=await h.provider.runTurn({...h.args,observeFormalBinding:()=>null});
  assert.equal(result.completed,false);assert.equal(result.terminalObserved,true);
  assert.equal(result.errorCode,'NATIVE_TRANSPORT_UNPROVEN');
  assert.equal(result.error,`parent turn failed/interrupted (status=failed; error=present; cause=${cause})`);
  assert.doesNotMatch(result.error,/private-|\/private\//u);
  const events=(await fs.readFile(result.eventsPath,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(e=>e.type==='native.transport.blocked').message,result.error);
  assert.equal(h.reads(),2);assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,1);
  assert.deepEqual(result.captures,[]);
});

for (const [name,status,error,detail,terminalObserved] of [
  ['interrupted','interrupted',null,'status=interrupted; error=absent; cause=absent',true],
  ['completed with error','completed',{message:'private-message-secret',codexErrorInfo:'serverOverloaded'},
    'status=completed; error=present; cause=serverOverloaded',true],
  ['invalid error','failed','private-error-secret','status=failed; error=invalid; cause=unrecognized',true],
  ['missing status',undefined,null,'status=absent; error=absent; cause=absent',false],
  ['null status',null,null,'status=absent; error=absent; cause=absent',false],
  ['unknown status','private-status-secret',null,'status=other; error=absent; cause=absent',false],
  ['invalid status',17,null,'status=other; error=absent; cause=absent',false],
]) test(`parent failure proves terminal state only for public enum (${name})`,async t=>{
  const h=await historyBootstrapFixture(t,()=>({data:[{id:'parent-turn',status,error}],nextCursor:null}));
  const result=await h.provider.runTurn({...h.args,observeFormalBinding:()=>null});
  assert.equal(result.completed,false);assert.equal(result.terminalObserved,terminalObserved);
  assert.ok(result.error.includes(detail),result.error);assert.doesNotMatch(result.error,/private-/u);
  assert.equal(h.reads(),1);assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,1);
  assert.deepEqual(result.captures,[]);
});

test('initial public history tolerance ends after the first valid observation', async t => {
  const h = await historyBootstrapFixture(t, n => n === 1
    ? { data: [{ id: 'parent-turn', status: 'inProgress', error: null }], nextCursor: null }
    : { error: { code: -32603, message: 'failed to read thread: No such file or directory (os error 2)' } });
  const result = await h.provider.runTurn(h.args);
  assert.equal(result.completed, false); assert.equal(h.reads(), 2);
  assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('initial public history deadline includes a stalled RPC', async t => {
  const h = await historyBootstrapFixture(t, () => 'stall'), started = Date.now();
  const result = await h.provider.runTurn({ ...h.args, timeoutMs: 25 });
  assert.equal(result.completed, false); assert.ok(Date.now()-started < 500, 'must not await the 1000ms RPC timeout');
  assert.equal(h.reads(), 1); assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('initial public history never refreshes the deadline for persisted observation', async t => {
  const h = await historyBootstrapFixture(t, () => ({ error: { code: -32603,
    message: 'failed to read thread: No such file or directory (os error 2)' } }));
  await fs.writeFile(path.join(h.f.root, 'history-bootstrap.events.jsonl'), '');
  const result = await h.provider.runTurn({ ...h.args, observation: { threadId: parent, turnId: 'parent-turn', deadlineAt: Date.now()+1000 } });
  assert.equal(result.completed, false); assert.equal(h.reads(), 1);
  assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 0);
});

for(const deadlineAt of [undefined,null,'tomorrow',NaN,Infinity,-1])test(`persisted observation rejects unproven deadline ${deadlineAt}`,async t=>{
  const h=await historyBootstrapFixture(t,()=>assert.fail('invalid deadline must block before history RPC'));
  await fs.writeFile(path.join(h.f.root,'history-bootstrap.events.jsonl'),'');
  const result=await h.provider.runTurn({...h.args,observation:{threadId:parent,turnId:'parent-turn',deadlineAt}});
  assert.equal(result.completed,false);assert.match(result.error,/original deadline/);
  assert.equal(h.reads(),0);assert.equal(h.s.calls.filter(c=>c.method==='turn/start').length,0);
});

test('initial public history pending cannot certify completion and respects cancellation', async t => {
  const controller = new AbortController();
  const h = await historyBootstrapFixture(t, () => { controller.abort(); return { data: [], nextCursor: null }; });
  const result = await h.provider.runTurn({ ...h.args, signal: controller.signal });
  assert.equal(result.completed, false); assert.equal(result.response, null); assert.deepEqual(result.captures, []);
  assert.equal(h.reads(), 1); assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('initial public history late checkpoint cannot open a new observation window', async t => {
  const h = await historyBootstrapFixture(t, () => undefined);
  const result = await h.provider.runTurn({ ...h.args, timeoutMs: 20,
    onDispatched: () => new Promise(resolve => setTimeout(resolve, 35)) });
  assert.equal(result.completed, false); assert.equal(result.threadId, parent);
  assert.match(result.error, /initial public history observation deadline exceeded/u);
  assert.equal(h.reads(), 0); assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('initial public history late synchronous reply cannot beat an expired timer', async t => {
  const h = await historyBootstrapFixture(t, () => {
    // Deliberately hold the event loop, making a resolved RPC race a timer that
    // has expired but whose callback has not run. No production sleep is added.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35);
    return undefined;
  });
  const result = await h.provider.runTurn({ ...h.args, timeoutMs: 20 });
  assert.equal(result.completed, false); assert.equal(result.response, null);
  assert.equal(h.reads(), 1); assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('initial public history cancellation during a completed RPC cannot certify completion', async t => {
  const controller = new AbortController();
  const h = await historyBootstrapFixture(t, () => { controller.abort(); return undefined; });
  const result = await h.provider.runTurn({ ...h.args, signal: controller.signal });
  assert.equal(result.completed, false); assert.equal(result.response, null); assert.deepEqual(result.captures, []);
  assert.equal(h.reads(), 1); assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('initial public history pre-aborted dispatch clears its timer before slow diagnostic IO', async t => {
  const h = await historyBootstrapFixture(t, () => undefined), controller = new AbortController();
  h.s.rpc.stderrSample = () => 'bounded diagnostic\n';
  const write = fs.writeFile, sample = path.join(h.f.root, 'tmp/app-server-stderr-sample.txt');
  fs.writeFile = async (file, ...args) => {
    if (file === sample) await new Promise(resolve => setTimeout(resolve, 40));
    return write(file, ...args);
  };
  try {
    const result = await h.provider.runTurn({ ...h.args, timeoutMs: 20, signal: controller.signal,
      onDispatched: () => controller.abort() });
    assert.equal(result.completed, false); assert.equal(result.stderrSample.status, 'retained');
    assert.equal(h.reads(), 0); assert.equal(h.s.calls.filter(c => c.method === 'turn/start').length, 1);
  } finally { fs.writeFile = write; }
});

for (const kind of ['early-denial-in-long-chunk', 'split-denial', 'diagnostic-overflow']) {
  test(`S2 diagnostics ${kind} block without disclosing text or dispatching again`, async t => {
    const w = wire(t), pending = w.rpc.request('thread/read', { threadId: child });
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code,kind==='diagnostic-overflow'?'NATIVE_TRANSPORT_UNPROVEN':'PERMISSION_REQUIRED');
      assert.equal(error.message,kind==='diagnostic-overflow'?'App Server diagnostic limit exceeded':'App Server process reported a permission denial');
      assert.equal(error.message.includes('private diagnostic example'), false); return true;
    });
    if (kind === 'early-denial-in-long-chunk') w.diagnostics.write('permission denied ' + 'x'.repeat(600));
    if (kind === 'split-denial') { w.diagnostics.write('private diagnostic example: operation not '); w.diagnostics.write('permitted'); }
    if (kind === 'diagnostic-overflow') w.diagnostics.write('x'.repeat(64 * 1024 + 1));
    await rejected;
    await assert.rejects(() => w.rpc.request('thread/read', {}));
    assert.equal(w.sent.length, 1);
  });
}

test('stderr guard still accepts 65536 bytes and blocks byte 65537 without another request', async t => {
  const f = await fixture(t), w = wire(t);
  const accepted = w.rpc.request('thread/read', { threadId: child });
  w.diagnostics.write(Buffer.alloc(65536, 120));
  await assert.rejects(fs.lstat(path.join(f.root, 'tmp/app-server-stderr-sample.txt')), { code: 'ENOENT' }, 'healthy diagnostics are not persisted');
  w.input.write(JSON.stringify({ id: w.sent[0].id, result: { ok: true } }) + '\n');
  assert.deepEqual(await accepted, { ok: true });
  const rejected = assert.rejects(w.rpc.request('thread/read', { threadId: child }),
    { code: 'NATIVE_TRANSPORT_UNPROVEN', message: 'App Server diagnostic limit exceeded' });
  w.diagnostics.write('x'); await rejected;
  const result = await persistAppServerStderrSample(w.rpc, f.root);
  assert.equal(result.status, 'retained');
  const bytes = await fs.readFile(result.file);
  assert.ok(bytes.length <= 1024); assert.ok(!bytes.includes(Buffer.from('xxxx')));
  assert.equal((await fs.stat(result.file)).mode & 0o777, 0o600);
  await assert.rejects(w.rpc.request('thread/read', {}), blocked);
  assert.equal(w.sent.length, 2);
});

for (const chunkSize of [1, 7, 511]) test(`stderr sample omits unknown/private content fragmented every ${chunkSize} bytes`, async t => {
  const f = await fixture(t), w = wire(t);
  const rejected = assert.rejects(w.rpc.request('thread/read', {}), blocked);
  const secret = 'sk-private-secret-value-123456789';
  const prefix = Buffer.from(`failed to load skill\nAuthorization: Bearer ${secret}\npassword=hunter-private\n/Users/private-user/secret.env\n{"prompt":"private prompt","env":"private environment"}\n𝛑\n`);
  for (let offset = 0; offset < prefix.length; offset += chunkSize) w.diagnostics.write(prefix.subarray(offset, offset + chunkSize));
  w.diagnostics.write(Buffer.alloc(65537, 120)); await rejected;
  const result = await persistAppServerStderrSample(w.rpc, f.root), sample = await fs.readFile(result.file, 'utf8');
  assert.ok(sample.includes('failed to load skill'));
  for (const privateText of [secret, 'Authorization', 'Bearer', 'hunter-private', '/Users/', 'secret.env', 'private prompt', 'private environment', '𝛑']) {
    assert.equal(sample.includes(privateText), false, privateText);
  }
  assert.ok(Buffer.byteLength(sample) <= 1024);
  const original = await fs.readFile(result.file);
  w.diagnostics.write('failed to parse config');
  assert.ok(original.equals(await fs.readFile(result.file)), 'later chunks cannot rewrite the first sample');
  assert.deepEqual(await persistAppServerStderrSample(w.rpc, f.root), { status: 'unavailable' }, 'never overwrite a retained sample');
  assert.ok(original.equals(await fs.readFile(result.file)));
  assert.equal(w.sent.length, 1);
});

test('stderr prefix truncation and unknown-only text cannot escape via the retained sample', async t => {
  const f = await fixture(t), w = wire(t);
  const rejected = assert.rejects(w.rpc.request('thread/read', {}), blocked);
  w.diagnostics.write(Buffer.concat([Buffer.alloc(4096, 120), Buffer.from('failed to parse config\nprivate-value'), Buffer.alloc(65537, 120)]));
  await rejected;
  const result = await persistAppServerStderrSample(w.rpc, f.root), sample = await fs.readFile(result.file, 'utf8');
  assert.equal(sample.includes('failed to parse config'), false, 'only the bounded prefix is sampled');
  assert.equal(sample.includes('private-value'), false);
  assert.ok(sample.includes('All other stderr omitted'));
});

for (const failure of ['occupied-file', 'symlink-directory', 'noncanonical-root']) test(`stderr persistence ${failure} preserves prior bytes and original RPC error`, async t => {
  const f = await fixture(t), w = wire(t);
  const rejected = assert.rejects(w.rpc.request('thread/read', {}), { message: 'App Server diagnostic limit exceeded' });
  w.diagnostics.write(Buffer.alloc(65537)); await rejected;
  let evidenceRoot = f.root;
  const prior = path.join(f.root, 'prior'); await fs.mkdir(prior);
  const priorFile = path.join(prior, 'app-server-stderr-sample.txt'); await fs.writeFile(priorFile, 'prior bytes');
  if (failure === 'occupied-file') { await fs.mkdir(path.join(f.root, 'tmp')); await fs.copyFile(priorFile, path.join(f.root, 'tmp/app-server-stderr-sample.txt')); }
  if (failure === 'symlink-directory') await fs.symlink(prior, path.join(f.root, 'tmp'));
  if (failure === 'noncanonical-root') evidenceRoot += '/.';
  assert.deepEqual(await persistAppServerStderrSample(w.rpc, evidenceRoot), { status: 'unavailable' });
  assert.equal(await fs.readFile(priorFile, 'utf8'), 'prior bytes');
  if (failure === 'occupied-file') assert.equal(await fs.readFile(path.join(f.root, 'tmp/app-server-stderr-sample.txt'), 'utf8'), 'prior bytes');
  await assert.rejects(w.rpc.request('thread/read', {}), { code: 'NATIVE_TRANSPORT_UNPROVEN', message: 'App Server diagnostic limit exceeded' });
  assert.equal(w.sent.length, 1);
});

for (const phase of ['initialize', 'turn', 'turn-write-failure']) test(`provider exposes limited stderr evidence for ${phase} without replacing the failure`, async t => {
  const f = await fixture(t), w = wire(t);
  const request = w.rpc.request;
  w.rpc.request = (method, params) => {
    if (method === 'initialize' && phase !== 'initialize') return Promise.resolve({ userAgent: 'codex-cli/0.163.0' });
    const pending = request(method, params);
    w.diagnostics.write(Buffer.concat([Buffer.from('failed to load skill\nsecret-value'), Buffer.alloc(65537)]));
    return pending;
  };
  if (phase === 'turn-write-failure') await fs.writeFile(path.join(f.root, 'tmp'), 'occupied parent');
  if (phase === 'initialize') {
    await assert.rejects(createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: w.rpc }), error => {
      assert.equal(error.message, 'App Server diagnostic limit exceeded'); assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
      assert.equal(error.stderrSample.status, 'retained'); return true;
    });
  } else {
    const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: w.rpc });
    const result = await provider.runTurn({ prompt: 'normal input', workflowSkill: 'stnl-slice-executor', model: 'gpt-6.1-sol', effort: 'medium', role: 'author', operationId: 'failure' });
    assert.equal(result.completed, false); assert.equal(result.turnStarted, null);
    assert.equal(result.error, 'App Server diagnostic limit exceeded'); assert.equal(result.errorCode, 'NATIVE_TRANSPORT_UNPROVEN');
    assert.equal(result.stderrSample.status, phase === 'turn' ? 'retained' : 'unavailable');
    const event = JSON.parse((await fs.readFile(result.eventsPath, 'utf8')).trim());
    assert.deepEqual(event.stderrSample, result.stderrSample);
  }
  if (phase !== 'turn-write-failure') {
    const sample = await fs.readFile(path.join(f.root, 'tmp/app-server-stderr-sample.txt'), 'utf8');
    assert.ok(sample.includes('failed to load skill')); assert.equal(sample.includes('secret-value'), false);
  }
  assert.equal(w.sent.filter(call => Object.hasOwn(call, 'id')).length, 1);
});

test('initialization rejection retains available stderr even while the codec remains open', async t => {
  const f = await fixture(t), w = wire(t), request = w.rpc.request;
  w.rpc.request = (method, params) => {
    const pending = request(method, params);
    w.diagnostics.write('failed to parse config: private-value');
    w.input.write(JSON.stringify({ id: w.sent.at(-1).id, error: { code:-32603, message: 'private server detail' } }) + '\n');
    return pending;
  };
  await assert.rejects(createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: w.rpc }), error => {
    assert.equal(error.message, 'App Server rejected initialize (RPC -32603: omitted)'); assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
    assert.equal(error.stderrSample.status, 'retained'); return true;
  });
  const sample = await fs.readFile(path.join(f.root, 'tmp/app-server-stderr-sample.txt'), 'utf8');
  assert.ok(sample.includes('failed to parse config')); assert.equal(sample.includes('private'), false);
  assert.equal(w.sent.length, 1);
});

test('S2 JSONL correlates out-of-order replies, ignores completion notifications and preserves UTF-8', async t => {
  const w = wire(t), a = w.rpc.request('thread/read', { threadId: child }), b = w.rpc.request('skills/list', {});
  w.input.write(JSON.stringify({ method: 'turn/completed', params: { threadId: child } }) + '\n');
  w.input.write(JSON.stringify({ id: w.sent[1].id, result: { data: [] } }) + '\n');
  const bytes = Buffer.from(JSON.stringify({ id: w.sent[0].id, result: { text: '𝛑 ç' } }) + '\n');
  for (const byte of bytes) w.input.write(Buffer.from([byte]));
  assert.deepEqual(await a, { text: '𝛑 ç' }); assert.deepEqual(await b, { data: [] });
  await assert.rejects(() => w.rpc.request('account/login/start', {}), blocked);
  assert.equal(w.sent.length, 2);
});

for (const kind of ['malformed', 'invalid-wire-utf8', 'oversize', 'foreign-response', 'approval', 'end', 'timeout']) {
  test(`S2 RPC ${kind} stops without acceptance/reconnect/retry`, async t => {
    const w = wire(t, { timeoutMs: 25, maxLineBytes: 250 });
    const request = w.rpc.request('thread/read', { threadId: child });
    const messages={malformed:'malformed public RPC message','invalid-wire-utf8':'invalid UTF-8 in public RPC stream',oversize:'RPC line limit exceeded',
      'foreign-response':'unexpected RPC response',approval:'App Server requires explicit user interaction',end:'RPC ended; any dispatched turn has uncertain effect',timeout:'RPC timeout for thread/read; effect uncertain'};
    const rejection=assert.rejects(request,refuses(messages[kind],kind==='approval'?'INTERACTION_REQUIRED':'NATIVE_TRANSPORT_UNPROVEN'));
    if (kind === 'malformed') w.input.write('{bad}\n');
    if (kind === 'invalid-wire-utf8') w.input.write(Buffer.concat([
      Buffer.from(`{"id":${w.sent[0].id},"result":{"text":"`), Buffer.from([0xff]), Buffer.from('"}}\n'),
    ]));
    if (kind === 'oversize') w.input.write('x'.repeat(251));
    if (kind === 'foreign-response') w.input.write('{"id":999,"result":{}}\n');
    if (kind === 'approval') w.input.write('{"id":"approve","method":"item/commandExecution/requestApproval","params":{}}\n');
    if (kind === 'end') w.input.end('partial');
    await rejection;
    await assert.rejects(() => w.rpc.request('thread/read', {}));
    assert.equal(w.sent.length, 1);
  });
}

test('S2 offline public child envelope crosses normal capture-native; persistence replay uses identical bytes', async t => {
  const operation = await reservedOperation(t), f = await fixture(t), { handle } = operation.start;
  await bindNative(handle, identity.agentPath);
  const measured = await verifyNative(operation.dispatch.originFile);
  const request = await fs.readFile(operation.dispatch.requestFile);
  const text = JSON.stringify({ format: 'stnl-current-validation-response-v1', requestSha256: sha(request),
    result: { status: 'PASS', head: operation.head, commands: measured.commands,
      evidence: 'OFFLINE mechanical transport fixture, not a real native response.', findingReferences: 'none',
      findingDispositions: 'none', blockers: 'none', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'none' },
    newFindings: [] }) + '\n';
  const s = server({ bundle: f.bundle, cwd: f.root, response: text });
  const binding = await bindAppServerChild(s.rpc, identity);
  const file = path.join(f.root, 'restored-owned-output/native-tool-result.json');
  // A persistence failure is not permission to spawn or rerun the recipe.
  await assert.rejects(() => captureAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root,
    toolResultFile: file }), refuses('native adapter dependency failed (stage=physical; kind=IO; code=ENOENT)','DRIVER_FAILURE'));
  await fs.mkdir(path.dirname(file));
  const restoredBeforeCapture = server({ bundle: f.bundle, cwd: f.root, response: text });
  const captured = await captureAppServerChild(restoredBeforeCapture.rpc, { binding, bundle: f.bundle,
    cwd: f.root, toolResultFile: file });
  assert.equal(captured.finalResponseSha256, sha(Buffer.from(text)));
  assert.equal((await captureNative(handle, file)).status, 'PASS');
  const responseFile = path.join(path.dirname(operation.dispatch.originFile), 'round-1.response.json');
  const before = await fs.readFile(responseFile), observation = await fs.readFile(measured.observationFile);
  assert.ok(before.equals(Buffer.from(text)));
  const newObserver = server({ bundle: f.bundle, cwd: f.root, response: text });
  await captureAppServerChild(newObserver.rpc, { binding: JSON.parse(JSON.stringify(binding)),
    bundle: f.bundle, cwd: f.root, toolResultFile: file });
  assert.equal((await captureNative(handle, file)).replayed, true);
  assert.equal((await resume(handle)).phase, 'captured');
  assert.ok(before.equals(await fs.readFile(responseFile)));
  assert.ok(observation.equals(await fs.readFile(measured.observationFile)));
  assert.ok(newObserver.calls.every(call => /^thread\/(?:read|items\/list|turns\/list)$/u.test(call.method)));
  assert.ok(restoredBeforeCapture.calls.every(call => /^thread\/(?:read|items\/list|turns\/list)$/u.test(call.method)));
});

for(const terminalStatus of ['completed','interrupted'])test(`provider retains literal ready envelope before principal ${terminalStatus}; suffix remains untouched`, async t => {
  const f=await fixture(t),response='{"format":"invalid-formal","result":{}}\nCanonical task identity: `/root/check-one`';
  const s=server({bundle:f.bundle,cwd:f.root,provider:true,response});
  s.state.parentItems.push({...s.state.parentItems[0],id:'child-done',kind:'completed'});
  const request=s.rpc.request.bind(s.rpc);let parentDone=false,ready=0;
  s.rpc.request=async(method,params)=>{const value=await request(method,params);
    if(method==='thread/turns/list'&&params.threadId===parent)value.data[0].status=parentDone?terminalStatus:'inProgress';return value;};
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc,pollMs:1});
  const result=await p.runTurn({prompt:'Ordinary operation',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'early-child',role:'review',onChildCompleted:async({capture})=>{
      assert.equal(parentDone,false);ready++;
      const lines=(await fs.readFile(path.join(f.root,'early-child.events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      const event=lines.find(item=>item.type==='native.child.completed');assert.equal(event.toolResultFile,capture.file);
      const envelope=JSON.parse(await fs.readFile(event.toolResultFile,'utf8'));
      assert.equal(envelope.finalResponse,response);assert.equal(event.finalResponseSha256,sha(Buffer.from(response)));
      parentDone=true;
    }});
  assert.equal(result.completed,terminalStatus==='completed');assert.equal(ready,1);assert.equal(result.captures.length,1);
  if(terminalStatus==='interrupted')assert.equal(result.errorCode,'NATIVE_TRANSPORT_UNPROVEN');
  assert.equal(result.captures[0].toolResult.finalResponse,response);
  assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
  assert.equal(s.calls.some(c=>['turn/steer','thread/resume'].includes(c.method)),false);
});

test('provider does not invent readiness without completed activity or publish outside its operation',async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const request=s.rpc.request.bind(s.rpc);
  s.rpc.request=async(method,params)=>{const value=await request(method,params);
    if(method==='thread/turns/list'&&params.threadId===parent)value.data[0].status='inProgress';return value;};
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc,pollMs:1});
  const input={prompt:'Ordinary operation',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',role:'review'};
  const before=await fs.readdir(f.root);
  await assert.rejects(p.runTurn({...input,operationId:'../foreign-operation'}),blocked);
  assert.deepEqual(await fs.readdir(f.root),before);
  const result=await p.runTurn({...input,operationId:'no-ready',timeoutMs:25});
  assert.equal(result.completed,false);assert.equal(result.captures.length,0);
  const events=(await fs.readFile(result.eventsPath,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.some(e=>e.type==='native.child.completed'),false);
  assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
});

for(const invalid of ['duplicate-completion','foreign-completion','truncated-public-copy','aliased-file','divergent-file',
  'changed-after-ready','file-and-source-changed','removed-and-source-changed','removed-after-ready','aliased-after-ready'])
test(`provider does not substitute or announce invalid early capture: ${invalid}`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const completed={...s.state.parentItems[0],id:'child-done',kind:'completed'};
  s.state.parentItems.push(completed);
  if(invalid==='duplicate-completion')s.state.parentItems.push({...completed,id:'duplicate'});
  if(invalid==='foreign-completion')completed.agentThreadId='foreign';
  if(invalid==='truncated-public-copy')s.state.items.at(-1).text=s.state.items.at(-1).text.slice(0,-1);
  const file=path.join(f.root,`early-negative.child-${sha(identity.agentPath).slice(7)}.json`);
  const original=Buffer.from('preserved foreign bytes');
  if(invalid==='aliased-file'){await fs.writeFile(path.join(f.root,'original'),original);await fs.symlink(path.join(f.root,'original'),file);}
  if(invalid==='divergent-file')await fs.writeFile(file,original);
  const afterReady=invalid.endsWith('after-ready')||invalid.endsWith('source-changed');
  const request=s.rpc.request.bind(s.rpc);let parentDone=!afterReady;let ready=0;
  s.rpc.request=async(method,params)=>{const value=await request(method,params);
    if(method==='thread/turns/list'&&params.threadId===parent)value.data[0].status=parentDone?'completed':'inProgress';return value;};
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc,pollMs:1});
  const result=await p.runTurn({prompt:'Ordinary operation',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    operationId:'early-negative',role:'review',onChildCompleted:async()=>{ready++;parentDone=true;
      if(['changed-after-ready','file-and-source-changed','removed-and-source-changed'].includes(invalid)){
        s.state.items.at(-1).text+='changed';s.state.turns[0].items.at(-1).text+='changed';}
      if(invalid==='file-and-source-changed')await fs.writeFile(file,JSON.stringify({agentId:identity.agentPath,status:'completed',finalResponse:s.state.items.at(-1).text})+'\n');
      if(['removed-after-ready','removed-and-source-changed'].includes(invalid))await fs.unlink(file);
      if(invalid==='aliased-after-ready'){await fs.rename(file,path.join(f.root,'alias-target'));await fs.symlink(path.join(f.root,'alias-target'),file);}
    }});
  assert.equal(result.completed,false);
  const expected={'duplicate-completion':'duplicate completed child identity','foreign-completion':'unmatched completed child identity',
    'truncated-public-copy':'public child surfaces disagree','aliased-file':'path is not physical/canonical','divergent-file':'existing tool result differs',
    'changed-after-ready':'public child differs from first capture','file-and-source-changed':'public child differs from first capture',
    'removed-and-source-changed':'public child differs from first capture','aliased-after-ready':'saved first child envelope absent/aliased/divergent',
    'removed-after-ready':'native adapter dependency failed (stage=capture; kind=IO; code=ENOENT)'}[invalid];
  assert.equal(result.errorCode,invalid==='removed-after-ready'?'DRIVER_FAILURE':'NATIVE_TRANSPORT_UNPROVEN');assert.equal(result.error,expected);
  assert.equal(ready,afterReady?1:0);
  if(afterReady)assert.equal(result.captures[0].toolResult.finalResponse,'  resultado íntegro\r\n𝛑\n');
  if(invalid==='changed-after-ready')assert.equal(JSON.parse(await fs.readFile(file)).finalResponse,'  resultado íntegro\r\n𝛑\n');
  if(['removed-after-ready','removed-and-source-changed'].includes(invalid))await assert.rejects(fs.lstat(file),{code:'ENOENT'});
  if(invalid==='aliased-file')assert.deepEqual(await fs.readFile(path.join(f.root,'original')),original);
  if(invalid==='divergent-file')assert.deepEqual(await fs.readFile(file),original);
  assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1);
});

for(const fault of ['absent','both-drift','duplicate-ready','orphan-ready'])test(`restored observation cannot replace its first envelope: ${fault}`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true});
  const p=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc,pollMs:1});
  const input={prompt:'Ordinary input',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',operationId:'persisted-first',role:'review'};
  const first=await p.runTurn(input);assert.equal(first.completed,true);
  const file=first.captures[0].file,bytes=await fs.readFile(file),events=await fs.readFile(first.eventsPath,'utf8');
  if(fault==='orphan-ready')s.state.parentItems=s.state.parentItems.filter(item=>item.type!=='subAgentActivity');
  else if(fault==='duplicate-ready')await fs.appendFile(first.eventsPath,events.split('\n').find(line=>line.includes('native.child.completed'))+'\n');
  else{s.state.items.at(-1).text+='changed';s.state.turns[0].items.at(-1).text+='changed';
    if(fault==='absent')await fs.unlink(file);
    else await fs.writeFile(file,JSON.stringify({agentId:identity.agentPath,status:'completed',finalResponse:s.state.items.at(-1).text})+'\n');}
  const next=await p.runTurn({...input,observation:{threadId:parent,turnId:'parent-turn',deadlineAt:first.deadlineAt}});
  assert.equal(next.completed,false);
  assert.equal(next.error,{'absent':'native adapter dependency failed (stage=capture; kind=IO; code=ENOENT)',
    'both-drift':'persisted first child envelope differs','duplicate-ready':'persisted child readiness binding differs',
    'orphan-ready':'persisted child readiness is orphaned or duplicated'}[fault]);
  assert.equal(next.errorCode,fault==='absent'?'DRIVER_FAILURE':'NATIVE_TRANSPORT_UNPROVEN');
  if(fault==='absent')await assert.rejects(fs.lstat(file),{code:'ENOENT'});
  if(['duplicate-ready','orphan-ready'].includes(fault))assert.deepEqual(await fs.readFile(file),bytes);
  assert.equal(s.calls.filter(call=>call.method==='turn/start').length,1);
});

test('normal provider inherits client permissions and scoped observation resumes without another turn', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true });
  let stopped = false;
  const request = s.rpc.request;
  s.rpc.request = async (method, params) => {
    if (!stopped && method === 'thread/turns/list' && params.threadId === parent) { stopped = true; throw new Error('OFFLINE observation interruption'); }
    return request(method, params);
  };
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const input = { prompt: 'Normal author input', workflowSkill: 'stnl-slice-executor', model: 'gpt-6.1-sol', effort: 'high',
    operationId: 'read-only-resume', role: 'author' };
  const first = await p.runTurn(input);
  assert.equal(first.completed, false); assert.equal(first.turnStarted, null);
  assert.equal(first.observation.threadId, parent);
  const second = await p.runTurn({ ...input, observation: first.observation });
  assert.equal(second.completed, true); assert.equal(second.captures[0].toolResult.finalResponse, '  resultado íntegro\r\n𝛑\n');
  const bytes = await fs.readFile(second.captures[0].file);
  const third = await p.runTurn({ ...input, observation: first.observation });
  assert.ok(bytes.equals(await fs.readFile(third.captures[0].file)));
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(s.calls.filter(call => call.method === 'thread/start').length, 1);
  const settings = s.calls.find(call => call.method === 'thread/start').params;
  assert.equal(settings.approvalPolicy, null); assert.equal(settings.sandbox, null);
});

for (const position of ['before-contract', 'after-contract']) test(`runner descendants ${position} are all observed before rejecting the result`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true, mutate(state) {
    const descendants=['grandchild-one','grandchild-two'].map(agentThreadId => ({ id: agentThreadId,
      type: 'subAgentActivity', kind: 'started', agentThreadId, agentPath: '/root/'+agentThreadId }));
    if(position==='before-contract')state.items.unshift(...descendants);else state.items.push(...descendants);
  } });
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc });
  const unadmitted = [];
  const result = await p.runTurn({ prompt: 'Normal input', workflowSkill: 'stnl-slice-executor', model: 'gpt-6.1-sol', effort: 'high',
    operationId: 'descendants', role: 'author', onUnadmittedChildren: async bindings => unadmitted.push(...bindings) });
  assert.equal(result.completed, false); assert.equal(unadmitted.length, 2);
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
});

for (const mode of ['author', 'review', 'foreign-resume']) test(`normal continuity rejects ${mode} mismatch without a new turn`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true });
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc });
  const prior = { threadId: parent, cwd: f.root, bundleSha256: sha(Buffer.from(JSON.stringify(p.bundle))), role: 'author' };
  if (mode === 'author') prior.cwd = '/another-case';
  if (mode === 'foreign-resume') {
    const request = s.rpc.request;
    s.rpc.request = async (method, params) => method === 'thread/resume'
      ? { thread: { id: child, cwd: f.root, cliVersion: '0.163.0' } } : request(method, params);
  }
  const result = await p.runTurn({ prompt: 'Normal continuation', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6.1-sol', effort: 'high', operationId: mode, role: mode === 'review' ? 'review' : 'author', priorAuthorThread: prior });
  assert.equal(result.completed, false);
  assert.equal(s.calls.some(call => call.method === 'turn/start'), false);
});


for(const status of ['failed','completed'])test(`terminal inspection failure is observed without a grant (${status})`,async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,response:'Literal initialization; recipe not started.'});
  const missing=path.join(f.root,'private-missing-inspection.txt'),good=path.join(f.root,'private-inspection.txt');
  await fs.writeFile(good,'private-document-secret');
  const cat=spawnSync('/bin/cat',[missing,good],{cwd:f.root,encoding:'utf8'});
  assert.equal(cat.status,1);assert.match(cat.stderr,/No such file or directory/);assert.equal(cat.stdout,'private-document-secret');
  s.state.items.splice(1,0,{id:'failed-inspection',type:'commandExecution',command:`cat '${missing}' '${good}'`,
    cwd:f.root,status,exitCode:cat.status,aggregatedOutput:cat.stdout+cat.stderr,commandActions:[]});
  s.state.turns[0].items=structuredClone(s.state.items);
  const binding=await bindAppServerChild(s.rpc,identity);let observation;
  const result=await readAppServerChild(s.rpc,{binding,bundle:f.bundle,cwd:f.root,initialization:true,
    onInitializationObserved:failures=>{observation=failures;}});
  assert.deepEqual(observation,[{itemIndex:1,status,exitCode:1}]);
  assert.equal(result.finalResponse,'Literal initialization; recipe not started.');
  assert.deepEqual(Object.keys(result).sort(),['agentId','finalResponse','status'],'observation is not a new canonical envelope');
  assert.equal(result.preVerificationContinuation,undefined,'observed failure grants no permission');
  assert.ok(s.calls.every(x=>x.method.startsWith('thread/')),'observation has no model turn or verification');
  assert.doesNotMatch(JSON.stringify(observation),/private-|document-secret/);
});


test('known initialization failure without flow eligibility grants no continuation or extra producer',async t=>{
  const f=await fixture(t),s=server({bundle:f.bundle,cwd:f.root,provider:true,response:'Literal blocked initialization'});
  s.state.items.splice(1,0,{id:'failed-read',type:'commandExecution',command:'cat missing',cwd:f.root,
    status:'failed',exitCode:1,aggregatedOutput:'not authority',commandActions:[]});
  s.state.turns[0].items=structuredClone(s.state.items);s.state.parentItems.push({...s.state.parentItems[0],id:'first-completion',kind:'completed'});
  const request=s.rpc.request.bind(s.rpc);let done=false,probes=0;
  s.rpc.request=async(method,params)=>{const value=await request(method,params);
    if(method==='thread/turns/list'&&params.threadId===parent)value.data[0].status=done?'completed':'inProgress';return value;};
  const provider=await createNativeProvider({snapshot:f.root,workspace:f.root,evidenceRoot:f.root,rpc:s.rpc,pollMs:1});
  const result=await provider.runTurn({prompt:'OFFLINE',workflowSkill:'stnl-slice-executor',model:'gpt-6-luna',effort:'high',
    role:'review',operationId:'ineligible-initialization',observeFormalBinding:()=>({agentPath:identity.agentPath}),
    onPrepareContinuation:async()=>{probes++;return null;},onChildCompleted:({initialization})=>{assert.notEqual(initialization,true);done=true;}});
  assert.equal(result.completed,true,result.error);assert.equal(probes,1);assert.equal(s.state.turns.length,1);
  const events=await fs.readFile(result.eventsPath,'utf8');assert.equal(events.includes('native.child.continuation.admitted'),false);
  assert.equal(s.calls.filter(x=>x.method==='turn/start').length,1);
});
