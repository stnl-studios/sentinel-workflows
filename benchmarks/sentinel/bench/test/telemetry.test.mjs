import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {collectUsage} from '../telemetry.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../temp/bench-telemetry-tests');
async function fixture(t,records,events=[]){await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'sessions'));await fs.writeFile(path.join(dir,'sessions/a.jsonl'),records.map(JSON.stringify).join('\n')+'\n');const file=path.join(dir,'events.jsonl');await fs.writeFile(file,events.map(JSON.stringify).join('\n')+'\n');return{sessionRoot:path.join(dir,'sessions'),eventFiles:events.length?[file]:[],rootThreads:[{threadId:'p',caseId:'case',role:'coordinator'}],...{dir}}}
const u=(input=10,output=2)=>({input_tokens:input,cached_input_tokens:4,output_tokens:output,reasoning_output_tokens:1,total_tokens:input+output});
const rec=(response='r',usage=u(),extra={})=>({type:'token_usage_record',timestamp:'2026-01-01T00:00:01Z',payload:{thread_id:'p',turn_id:'t',root_turn_id:'t',response_id:response,usage,...extra}});
const meta=(id,parent=null,agentPath=null)=>({type:'session_meta',payload:{id,parent_thread_id:parent,agent_path:agentPath,base_instructions:{text:'SECRET'},creator_user_id:'SECRET'}});
const ctx=(turn='t',model='m')=>({type:'turn_context',payload:{turn_id:turn,model,effort:'high',approval_policy:'never',sandbox_policy:{type:'workspace-write',network_access:false},instructions:'SECRET'}});
const profile={roles:{coordinator:{model:'m',effort:'high',approval:'never',sandbox:'workspace-write',network:false}}};
test('dedup local and raw: alternatives never sum; safe selected fields',async t=>{const f=await fixture(t,[meta('p'),ctx(),rec(),rec(),{type:'response_item',payload:{reasoning:'SECRET'}}],[{at:'2026-01-01T00:00:02Z',context:{caseId:'case',stage:'execute',role:'coordinator'},payload:{method:'rawResponse/completed',params:{threadId:'p',turnId:'t',responseId:'r',usage:u()}}}]);const r=await collectUsage({...f,expectedProfile:profile});assert.equal(r.responses.length,1);assert.equal(r.observedTotals.inputTokens.value,10);assert.equal(r.configuration[0].status,'MATCH');assert.equal(r.cycles[0].stage,'execute');assert.equal(JSON.stringify(r).includes('SECRET'),false);assert.equal(r.responses[0].sources.length,3)});
test('conflicting field becomes unknown without discarding known metrics',async t=>{const f=await fixture(t,[rec(),rec('r',u(11))]);const r=await collectUsage(f);assert.equal(r.observedTotals.inputTokens.value,null);assert.equal(r.observedTotals.outputTokens.value,2);assert.ok(r.gaps.some(g=>g.code==='CONFLICTING_USAGE'));assert.equal(r.observedTotals.cacheWriteInputTokens.value,null)});
test('partial fields preserve known lower bound and report missing responses',async t=>{const r=await collectUsage(await fixture(t,[rec(),rec('r2',{output_tokens:3})]));assert.deepEqual(r.observedTotals.inputTokens,{value:10,knownResponses:1,missingResponses:1,complete:false});assert.equal(r.observedTotals.outputTokens.value,5)});
test('SDK resumed cumulative is not counted twice',async t=>{const f=await fixture(t,[rec('r1',u()),rec('r2',u(20),{turn_id:'t2',root_turn_id:'t2'})],[{payload:{type:'thread.started',thread_id:'p'}},{at:'2026-01-01T00:00:03Z',payload:{type:'turn.completed',usage:u(30,4)}}]);const r=await collectUsage(f);assert.equal(r.observedTotals.inputTokens.value,30);assert.equal(r.sourceComparisons[0].fields.inputTokens,'MATCH');assert.equal(r.sourceComparisons[0].kind,'sdk-terminal-cumulative')});
test('child role mapping explicit; unknown not PASS or usage failure',async t=>{const f=await fixture(t,[meta('c','p','/root/formal_validate'),rec('r',u(),{thread_id:'c'}),ctx()]);const r=await collectUsage({...f,roleRules:[{prefix:'/root/formal',role:'bad'}],expectedProfile:profile});assert.equal(r.threadTree.find(x=>x.threadId==='c').role,'unknown');assert.equal(r.observedTotals.inputTokens.value,10);assert.equal(r.configuration.find(x=>x.threadId==='c').equivalenceClaimAllowed,false);const mapped=await collectUsage({...f,roleRules:[{agentPath:'/root/formal_validate',role:'formal_validate'}]});assert.equal(mapped.roles[0].role,'formal_validate');assert.equal(mapped.roles[0].caseId,'case')});
test('inherited context copies do not create a child or duplicate usage',async t=>{const r=await collectUsage({...await fixture(t,[meta('p'),ctx(),meta('c','p','/root/review'),ctx(),rec()]),expectedProfile:profile});assert.equal(r.responses.length,1);assert.equal(r.configuration.find(x=>x.threadId==='p').status,'MATCH');assert.equal(r.configuration.find(x=>x.threadId==='c').status,'MISSING')});
test('configuration mismatch and missing fields not equivalence',async t=>{const f=await fixture(t,[ctx('t','other'),rec()]);const r=await collectUsage({...f,expectedProfile:profile});assert.equal(r.configuration[0].status,'MISMATCH');assert.equal(r.observedTotals.inputTokens.value,10)});
test('trailing partial record and malformed accepted record yield gaps',async t=>{const f=await fixture(t,[rec()]);await fs.appendFile(path.join(f.sessionRoot,'a.jsonl'),'{"type":"token_usage_record",bad}\n{"type":"token_usage_record"');const r=await collectUsage(f);assert.equal(r.responses.length,1);assert.ok(r.gaps.some(g=>g.code==='PARTIAL_TRAILING_LINE'));assert.ok(r.gaps.some(g=>g.code==='INVALID_JSON'))});
test('no usage means null; unknown numeric data not coerced',async t=>{const r=await collectUsage(await fixture(t,[rec('r',{input_tokens:'10',output_tokens:-1,reasoning_output_tokens:NaN})]));assert.equal(r.observedTotals.inputTokens.value,null);assert.equal(r.observedTotals.outputTokens.value,null)});
test('ambiguous exact role rules never guess',async t=>{const f=await fixture(t,[meta('c','p','/root/review'),rec('r',u(),{thread_id:'c'})]);const r=await collectUsage({...f,roleRules:[{agentPath:'/root/review',role:'a'},{agentPath:'/root/review',role:'b'}]});assert.equal(r.roles[0].role,'unknown')});
test('local-only response gets event cycle context without raw usage',async t=>{const f=await fixture(t,[rec()],[{context:{caseId:'case',stage:'validate',role:'coordinator'},payload:{method:'turn/started',params:{threadId:'p',turn:{id:'t'}}}}]);const r=await collectUsage(f);assert.equal(r.cycles[0].stage,'validate')});
test('unrelated session usage excluded from budget totals',async t=>{const r=await collectUsage(await fixture(t,[rec(),rec('r2',u(500),{thread_id:'unrelated'})]));assert.equal(r.observedTotals.inputTokens.value,10);assert.equal(r.excludedResponses.length,1)});
test('agentNamePrefix numeric boundary supports actual native names, not arbitrary suffix',async t=>{for(const name of ['execute_check','execute_check_01','execute_check-2','execute_checker','execute_check_bad','execute_check_01_extra']){const f=await fixture(t,[meta('c','p','/root/'+name),rec('r',u(),{thread_id:'c'})]);const r=await collectUsage({...f,roleRules:[{agentNamePrefix:'execute_check',role:'execute_check'}]});assert.equal(r.roles[0].role,['execute_check','execute_check_01','execute_check-2'].includes(name)?'execute_check':'unknown')}});
test('exact path beats name prefix and ambiguous prefixes remain unknown',async t=>{const f=await fixture(t,[meta('c','p','/root/execute_check_01'),rec('r',u(),{thread_id:'c'})]);let r=await collectUsage({...f,roleRules:[{agentPath:'/root/execute_check_01',role:'exact'},{agentNamePrefix:'execute_check',role:'general'}]});assert.equal(r.roles[0].role,'exact');r=await collectUsage({...f,roleRules:[{agentNamePrefix:'execute_check',role:'a'},{agentNamePrefix:'execute_check',role:'b'}]});assert.equal(r.roles[0].role,'unknown')});
test('delayed explicit dispatch maps earlier raw events by identity, not file order',async t=>{const f=await fixture(t,[rec()],[{at:'2026-01-01T00:00:02Z',context:{caseId:'case',stage:'stale'},payload:{method:'rawResponse/completed',params:{threadId:'p',turnId:'t',responseId:'r',usage:u()}}},{at:'2026-01-01T00:00:03Z',context:{caseId:'case',stage:'execute',role:'coordinator'},payload:{method:'benchmark/dispatch',params:{threadId:'p',turnId:'t'}}}]);const r=await collectUsage(f);assert.equal(r.cycles[0].stage,'execute');assert.equal(r.observedTotals.inputTokens.value,10)});
test('dispatch params context supported and conflicts never choose winning stage',async t=>{const f=await fixture(t,[rec()],[{payload:{method:'benchmark/dispatch',params:{threadId:'p',turnId:'t',context:{caseId:'case',stage:'a'}}}},{payload:{method:'benchmark/dispatch',params:{threadId:'p',turnId:'t',context:{caseId:'case',stage:'b'}}}}]);const r=await collectUsage(f);assert.equal(r.cycles[0].stage,null);assert.ok(r.gaps.some(g=>g.code==='CONFLICTING_CYCLE_CONTEXT'))});
test('observed thread ack fills only missing config with provenance',async t=>{const c=ctx();c.payload.sandbox_policy={type:'read-only'};const f=await fixture(t,[c,rec()]);const r=await collectUsage({...f,expectedProfile:{roles:{coordinator:{model:'m',effort:'high',sandbox:'read-only',network:false,approval:'never'}}},threadConfigurations:[{threadId:'p',model:'m',reasoningEffort:'high',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false},source:{file:'observed-ack.json',sha256:'a'.repeat(64)}}]});assert.equal(r.configuration[0].status,'MATCH');const check=r.configuration[0].turns[0];assert.equal(check.actual.network,false);assert.equal(check.fallbacks[0].field,'network');assert.equal(check.fallbacks[0].sources[0].file,'observed-ack.json')});
test('ack never overrides known mismatch and wrong thread is ignored',async t=>{const f=await fixture(t,[ctx('t','different'),rec()]);const r=await collectUsage({...f,expectedProfile:profile,threadConfigurations:[{threadId:'p',model:'m',source:{file:'ack',sha256:'a'}},{threadId:'other',sandbox:{networkAccess:false},source:{file:'other',sha256:'b'}}]});assert.equal(r.configuration[0].status,'MISMATCH');assert.equal(r.configuration[0].turns[0].actual.model,'different');assert.equal(r.configuration[0].turns[0].fallbacks.length,0)});
test('conflicting observed fallback is unknown, never selected',async t=>{const c=ctx();c.payload.sandbox_policy={type:'workspace-write'};const f=await fixture(t,[c,rec()]);const r=await collectUsage({...f,expectedProfile:profile,threadConfigurations:[false,true].map((networkAccess,i)=>({threadId:'p',sandbox:{type:'workspaceWrite',networkAccess},source:{file:'ack'+i,sha256:String(i)}}))});assert.equal(r.configuration[0].equivalenceClaimAllowed,false);assert.equal(r.configuration[0].turns[0].actual.network,null);assert.ok(r.gaps.some(g=>g.code==='CONFLICTING_THREAD_CONFIGURATION_FALLBACK'))});
test('missing turn context not replaced entirely with thread ack',async t=>{const r=await collectUsage({...await fixture(t,[rec()]),expectedProfile:profile,threadConfigurations:[{threadId:'p',model:'m',reasoningEffort:'high',source:{file:'ack',sha256:'a'}}]});assert.equal(r.configuration[0].turns[0].status,'MISSING')});

test('native slice and round suffixes are anchored, not broad prefix guessing',async t=>{
 const valid=['execute_check_slice_01','execute_check_slice_01_round_1','formal_validate_slice_01'];
 const invalid=['execute_check_slice_01_extra','execute_check_slice_x','execute_check_round_1','execute_check_slice_01_round_1_bad','execute_check-slice-01','formal_validate_anything'];
 for(const name of [...valid,...invalid]){
  const f=await fixture(t,[meta('c','p','/root/'+name),rec('r',u(),{thread_id:'c'})]);
  const r=await collectUsage({...f,roleRules:[{agentNamePrefix:'execute_check',role:'execute_check'},{agentNamePrefix:'formal_validate',role:'formal_validate'}]});
  assert.equal(r.roles[0].role,valid.includes(name)?(name.startsWith('formal_validate')?'formal_validate':'execute_check'):'unknown');
 }
});
async function nativeFixture(t,name='/root/arbitrary_check'){
 const f=await fixture(t,[meta('p'),meta('c','p',name),ctx('ct'),rec('r',u(),{thread_id:'c',turn_id:'ct',root_turn_id:'pt'})]);
 const runtime=path.join(f.dir,'skills/stnl-slice-executor/runtime/execution-current-operation.mjs'),origin=path.join(f.dir,'workspace/tmp/sentinel/op/round-1.origin.json');
 const parentMeta=meta('p');parentMeta.payload.cwd=path.join(f.dir,'workspace');
 await fs.appendFile(path.join(f.sessionRoot,'a.jsonl'),JSON.stringify(parentMeta)+'\n');
 const event=(operation,data,id)=>({payload:{method:'item/completed',params:{threadId:'p',turnId:'pt',item:{id,type:'commandExecution',cwd:path.join(f.dir,'workspace'),command:'node '+runtime+' '+operation+' --handle handle.json'+(operation==='bind-native'?' --agent-id '+name:''),exitCode:0,aggregatedOutput:JSON.stringify(data)}}}});
 const reserve=event('reserve-dispatch',{phase:'dispatch-reserved',originFile:origin,dispatchId:'dispatch',requestSha256:'sha256:'+'a'.repeat(64),owner:{operation:'EXECUTE_SLICE',operationAttemptId:'attempt',slice:'slice-02'}},'reserve');
 const bind=event('bind-native',{phase:'running',originFile:origin,agentId:name},'bind');
 f.eventFiles=[path.join(f.dir,'events.jsonl')];
 f.write=events=>fs.writeFile(f.eventFiles[0],events.map(JSON.stringify).join('\n')+'\n');
 return{f,reserve,bind};
}
test('public native dispatch binds arbitrary name and slice02 without model guessing',async t=>{
 for(const name of ['/root/arbitrary_check','/root/execute_check_slice02']){
  const {f,reserve,bind}=await nativeFixture(t,name);await f.write([reserve,bind]);
  const r=await collectUsage({...f,expectedProfile:{roles:{execute_check:profile.roles.coordinator}}});
  const child=r.threadTree.find(x=>x.threadId==='c');assert.equal(child.role,'execute_check');assert.equal(child.roleEvidence.length,1);assert.equal(child.roleProvenance,'observed-public-native-reservation-and-binding');
  assert.equal(r.configuration.find(x=>x.threadId==='c').status,'MATCH');
 }
});
test('missing or unsafe native links never assign arbitrary child',async t=>{
 for(const kind of ['missing','badexit','parent','digest','agent','scratch','turn']){
  const {f,reserve,bind}=await nativeFixture(t);
  if(kind==='badexit')bind.payload.params.item.exitCode=1;
  if(kind==='parent')bind.payload.params.threadId='other';
  if(kind==='turn')bind.payload.params.turnId='other';
  if(kind==='agent')bind.payload.params.item.aggregatedOutput=JSON.stringify({...JSON.parse(bind.payload.params.item.aggregatedOutput),agentId:'/root/wrong'});
  if(kind==='digest')reserve.payload.params.item.aggregatedOutput=JSON.stringify({...JSON.parse(reserve.payload.params.item.aggregatedOutput),requestSha256:'invented'});
  if(kind==='scratch')reserve.payload.params.item.command='cat scratch.json';
  await f.write(kind==='missing'?[bind]:[reserve,bind]);const r=await collectUsage(f);
  assert.equal(r.threadTree.find(x=>x.threadId==='c').role,'unknown');
 }
});
test('conflicting official digest or operations fail closed, name rules cannot override',async t=>{
 for(const key of ['requestSha256','operation']){
 const {f,reserve,bind}=await nativeFixture(t,'/root/execute_check'),other=structuredClone(reserve),data=JSON.parse(other.payload.params.item.aggregatedOutput);
 if(key==='requestSha256')data.requestSha256='sha256:'+'b'.repeat(64);else data.owner.operation='VALIDATE_SLICE';
 other.payload.params.item.aggregatedOutput=JSON.stringify(data);other.payload.params.item.id='other';
 await f.write([reserve,other,bind]);const r=await collectUsage({...f,roleRules:[{agentName:'execute_check',role:'execute_check'}]});
 assert.equal(r.threadTree.find(x=>x.threadId==='c').role,'unknown');assert.ok(r.gaps.some(g=>g.code==='CONFLICTING_NATIVE_ROLE_BINDING'));
 }
});
test('reused agent path across child threads is ambiguous; correct binding does not hide model mismatch',async t=>{
 const {f,reserve,bind}=await nativeFixture(t);await f.write([reserve,bind]);
 let r=await collectUsage({...f,expectedProfile:{roles:{execute_check:{...profile.roles.coordinator,model:'different'}}}});
 assert.equal(r.configuration.find(x=>x.threadId==='c').status,'MISMATCH');
 await fs.appendFile(path.join(f.sessionRoot,'a.jsonl'),JSON.stringify(meta('c2','p','/root/arbitrary_check'))+'\n');
 r=await collectUsage(f);assert.equal(r.threadTree.find(x=>x.threadId==='c').role,'unknown');
});

test('native mode rejects role names without official proof and supports events-only without sessionRoot',async t=>{
 const f=await fixture(t,[meta('c','p','/root/execute_check'),rec('r',u(),{thread_id:'c'})]);
 const r=await collectUsage({...f,roleAuthority:'native',roleRules:[{agentName:'execute_check',role:'execute_check'}]});
 assert.equal(r.threadTree.find(t=>t.threadId==='c').role,'unknown');
 const eventsOnly=await collectUsage({eventFiles:f.eventFiles});assert.ok(eventsOnly);
});
test('native provenance refuses origin and handle outside observed workspace',async t=>{
 for(const field of ['origin','handle']){
  const {f,reserve,bind}=await nativeFixture(t);
  if(field==='origin'){for(const e of [reserve,bind]){const data=JSON.parse(e.payload.params.item.aggregatedOutput);data.originFile='/outside/round-1.origin.json';e.payload.params.item.aggregatedOutput=JSON.stringify(data);}}
  else for(const e of [reserve,bind])e.payload.params.item.command=e.payload.params.item.command.replace('handle.json','../handle.json');
  await f.write([reserve,bind]);const r=await collectUsage(f);assert.equal(r.threadTree.find(t=>t.threadId==='c').role,'unknown');
 }
});

test('native command grammar accepts terminal flag but rejects unknown flags and false CLOSE operation',async t=>{
 for(const kind of ['terminal','unknown','close']){
 const {f,reserve,bind}=await nativeFixture(t);
 reserve.payload.params.item.command+=kind==='terminal'?' --terminal --response-variant stnl-current-native-judgment-v1':kind==='unknown'?' --invented yes':'';
 if(kind==='close'){const d=JSON.parse(reserve.payload.params.item.aggregatedOutput);d.owner.operation='CLOSE';reserve.payload.params.item.aggregatedOutput=JSON.stringify(d);}
 await f.write([reserve,bind]);const r=await collectUsage({...f,roleAuthority:'native'});assert.equal(r.threadTree.find(x=>x.threadId==='c').role,kind==='terminal'?'execute_check':'unknown');
 }
});
test('every applicable native binding must have unique recognized reservation, exact repeats are safe',async t=>{
 for(const kind of ['missing','unknown','duplicate']){
 const {f,reserve,bind}=await nativeFixture(t,'/root/execute_check'),second=structuredClone(bind),extra=structuredClone(reserve);
 if(kind!=='duplicate')for(const e of [second,extra]){const d=JSON.parse(e.payload.params.item.aggregatedOutput);d.originFile=d.originFile.replace('round-1','round-2');if(e===extra)d.owner.operation='UNKNOWN';e.payload.params.item.aggregatedOutput=JSON.stringify(d);}
 await f.write([reserve,bind,second,...(kind==='missing'?[]:[extra])]);const r=await collectUsage({...f,roleRules:[{agentName:'execute_check',role:'execute_check'}]});assert.equal(r.threadTree.find(x=>x.threadId==='c').role,kind==='duplicate'?'execute_check':'unknown');
 }
});

test('native review role uses dedicated parent stage and unique direct child, not actor name',async t=>{
 const f=await fixture(t,[meta('p'),meta('c','p','/root/arbitrary'),ctx(),rec('r',u(),{thread_id:'c'})]);
 const r=await collectUsage({...f,roleAuthority:'native',rootThreads:[{threadId:'p',role:'coordinator',stage:'REVIEW_PLAN'}]});
 const c=r.threadTree.find(x=>x.threadId==='c');assert.equal(c.role,'plan_review');assert.equal(c.roleProvenance,'observed-parent-stage-and-unique-child');assert.match(c.roleEvidence[0].limitation,/separate gate/);
});
test('native review refuses ambiguous siblings, wrong stage, wrong parent and conflicting declarations',async t=>{
 for(const kind of ['siblings','stage','parent','declarations','dispatch']){
 const records=[meta('p'),meta('c',kind==='parent'?'other':'p','/root/plan_review'),rec('r',u(),{thread_id:'c'})];
 if(kind==='siblings')records.push(meta('c2','p','/root/other'));
 const events=kind==='dispatch'?[{payload:{method:'benchmark/dispatch',params:{threadId:'p',turnId:'t',context:{stage:'EXECUTE_SLICE'}}}}]:[];
 const f=await fixture(t,records,events),rootThreads=[{threadId:'p',role:'coordinator',stage:kind==='stage'?'PLAN':'REVIEW_PLAN'}];
 if(kind==='declarations')rootThreads.push({threadId:'p',role:'coordinator',stage:'PLAN'});
 const r=await collectUsage({...f,roleAuthority:'native',rootThreads,roleRules:[{agentName:'plan_review',role:'plan_review'}]});assert.equal(r.threadTree.find(x=>x.threadId==='c').role,'unknown',kind);
 }
});

test('conflicting child paths prevent review attribution despite unique parent and child ID',async t=>{
 const f=await fixture(t,[meta('p'),meta('c','p','/root/reviewer_a'),meta('c','p','/root/reviewer_b'),ctx(),rec('r',u(),{thread_id:'c'})]);
 const r=await collectUsage({...f,roleAuthority:'native',rootThreads:[{threadId:'p',role:'coordinator',stage:'REVIEW_PLAN'}],expectedProfile:{roles:{plan_review:profile.roles.coordinator}}});
 const c=r.threadTree.find(x=>x.threadId==='c');assert.equal(c.role,'unknown');assert.equal(c.relationStatus,'CONFLICT');assert.equal(c.roleProvenance,'conflicting-evidence');assert.equal(r.configuration.find(x=>x.threadId==='c').equivalenceClaimAllowed,false);
});

test('literal quoted native commands and explicitly authorized isolated temp handles',async t=>{
 for(const kind of ['quoted-workspace','quoted-temp','unauthorized-temp','crosscell','traversal','symlink','operator','expansion','unmatched']){
 const {f,reserve,bind}=await nativeFixture(t),temp=path.join(f.dir,'temp'),workspace=path.join(f.dir,'workspace');await fs.mkdir(temp);await fs.mkdir(workspace);await fs.symlink(temp,path.join(workspace,'link'));
 let handle=kind==='quoted-workspace'?'handle.json':kind==='crosscell'?temp+'-other/handle.json':kind==='traversal'?'../temp/handle.json':kind==='symlink'?'link/handle.json':temp+'/handle.json';
 for(const e of [reserve,bind]){let command=e.payload.params.item.command;const parts=command.split(' ');parts[1]="'"+parts[1]+"'";command=parts.join(' ').replace('handle.json',"'"+handle+"'");if(kind==='operator')command+=' ; echo bad';if(kind==='expansion')command+=' $HOME';if(kind==='unmatched')command+=" '";e.payload.params.item.command='/bin/zsh -lc "'+command+'"';}
 await f.write([reserve,bind]);const r=await collectUsage({...f,roleAuthority:'native',authorizedTempRoots:kind==='unauthorized-temp'?[]:[temp]});assert.equal(r.threadTree.find(x=>x.threadId==='c').role,['quoted-workspace','quoted-temp'].includes(kind)?'execute_check':'unknown',kind);
 }
});
