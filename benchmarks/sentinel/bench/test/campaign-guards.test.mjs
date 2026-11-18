import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {BASE,createCampaignBudget,validateModels,eventContextRegistry,semanticFingerprint,observedBudgetTokens,admitDeadline,durableEffect,effectiveThread,assertEffectiveThread,runCampaign} from '../campaign.mjs';
import {parseCli} from '../cli.mjs';
import {Ledger} from '../core.mjs';
function temp(t){const d=fs.mkdtempSync(path.join(BASE,'temp','campaign-guards-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('context bound by accepted turn, including before ack and late events',()=>{const rows=[],r=eventContextRegistry(x=>rows.push(x));r.begin('root',{stage:'PLAN'});r.event({method:'turn/completed',params:{threadId:'root',turn:{id:'one'}}});assert.equal(rows.length,0);r.accept({threadId:'root',turnId:'one'});assert.equal(rows[0].payload.method,'benchmark/dispatch');assert.equal(rows[1].context.stage,'PLAN');r.begin('root',{stage:'EXECUTE'});r.event({method:'item/completed',params:{threadId:'root',turnId:'one'}});assert.equal(rows.at(-1).context.stage,'PLAN');r.event({method:'item/completed',params:{threadId:'unknown-child',turnId:'child'}});assert.deepEqual(rows.at(-1).context,{});r.event({method:'turn/completed',params:{threadId:'root',turn:{id:'two'}}});r.accept({threadId:'root',turnId:'two'});assert.equal(rows.at(-1).context.stage,'EXECUTE');r.finish();});
test('unaccepted events remain unknown, not assigned newest stage',()=>{const rows=[],r=eventContextRegistry(x=>rows.push(x));r.begin('t',{stage:'X'});r.event({method:'turn/completed',params:{threadId:'t',turn:{id:'lost'}}});r.finish();assert.deepEqual(rows[0].context,{});});
test('semantic progress ignores logs and timestamps but notices handoff/product',t=>{const d=temp(t);fs.mkdirSync(path.join(d,'src'));fs.writeFileSync(path.join(d,'src/a.mjs'),'a');fs.writeFileSync(path.join(d,'package.json'),'{}');const a={lifecycle:{exitCode:0,output:{lifecycle_status:'ready',updatedAt:'one'}},current:{exitCode:0,output:{state:'ACTIVE',normalHandoff:{slice:'01',operation:'EXECUTE_SLICE'}}}};const before=semanticFingerprint(d,a);fs.writeFileSync(path.join(d,'log.txt'),'noise');a.lifecycle.output.updatedAt='two';assert.equal(semanticFingerprint(d,a),before);a.current.output.normalHandoff.operation='VALIDATE_SLICE';assert.notEqual(semanticFingerprint(d,a),before);});
test('unknown usage blocks after first completed turn',()=>{assert.equal(observedBudgetTokens(null,0),0);assert.throws(()=>observedBudgetTokens(null,1),/BLOCKED_TELEMETRY/);assert.equal(observedBudgetTokens({observedTotals:{totalTokens:{value:0}}},1),0);});
test('durable effects persist intent before callback and retain uncertainty',async t=>{const evidence=temp(t),state={},ledger=new Ledger(path.join(evidence,'ledger.jsonl'));let saved;const save=()=>{saved=structuredClone(state);};const env={state,ledger,save,evidence,deadline:Date.now()+10000};await assert.rejects(()=>durableEffect(env,'allocate',{},()=>{assert.equal(saved.pendingEffect.name,'allocate');assert.equal(ledger.rows.at(-1).type,'effect-intent');throw Error('partial');}),/partial/);assert.equal(state.pendingEffect.name,'allocate');await assert.rejects(()=>durableEffect(env,'retry',{},()=>{}),/UNSETTLED/);});
test('successful effect saves result before clearing pending; expired admission no effect',async t=>{const evidence=temp(t),state={},ledger=new Ledger(path.join(evidence,'ledger.jsonl')),env={state,ledger,save:()=>{},evidence,deadline:Date.now()+10000};assert.deepEqual(await durableEffect(env,'capture',{},()=>({hash:'x'})),{hash:'x'});assert.equal(state.pendingEffect,null);assert.equal(state.lastEffect.result.hash,'x');assert.ok(fs.existsSync(path.join(evidence,'effect-1-result.json')));let ran=false;await assert.rejects(()=>durableEffect({...env,deadline:0},'bad',{},()=>{ran=true;}),/DEADLINE/);assert.equal(ran,false);assert.throws(()=>admitDeadline(NaN),/DEADLINE/);});
test('CLI refuses unknown flags official mode and invalid override',()=>{for(const args of [['run','--id','x','--oops','1'],['run','--id','x','--mode','official'],...['0','-1','NaN','Infinity','1.5'].map(x=>['run','--id','x','--repetitions',x])])assert.throws(()=>parseCli(args));assert.equal(parseCli(['run','--id','x','--mode','diagnostic','--repetitions','2']).options['--repetitions'],'2');});
test('effective thread evidence omits messages and authentication',()=>{assert.deepEqual(effectiveThread({thread:{id:'t',messages:['secret']},model:'m',auth:'secret'}),{threadId:'t',model:'m',modelProvider:null,reasoningEffort:null,cwd:null,approvalPolicy:null,sandbox:null});});
test('campaign invalid repetitions and duplicate cases rejected before any preparation',async()=>{const profile=JSON.parse(fs.readFileSync(path.join(BASE,'bench/profiles/default.json')));await assert.rejects(()=>runCampaign({id:'guard-invalid',profile,repetitions:0}),/repetitions/);await assert.rejects(()=>runCampaign({id:'guard-invalid',profile,caseIds:['rename','rename']}),/cases/);});

test('model availability checked for every role without fallback',()=>{assert.equal(validateModels({a:{model:'m'}},{data:[{model:'m',id:'id'}]}),true);assert.throws(()=>validateModels({a:{model:'m'},child:{model:'absent'}},{data:[{model:'m'}]}),/MODEL_UNAVAILABLE_child/);});


test('global cumulative budget replaces snapshots, never sums repeated reads',()=>{
 const b=createCampaignBudget(100);b.register('rename-1');
 const usage=(value,complete=true)=>({observedTotals:{totalTokens:{value,complete}}});
 b.observe('rename-1',usage(30));b.observe('rename-1',usage(30));assert.equal(b.snapshot().knownReportedTokens,30);
 b.observe('rename-1',usage(40));b.observe('query-1',usage(35));assert.equal(b.snapshot().knownReportedTokens,75);assert.equal(b.admit(),true);
 b.observe('rename-1',usage(null));assert.equal(b.snapshot().knownReportedTokens,75);assert.deepEqual(b.snapshot().missingReports,['rename-1']);
 b.observe('import-1',usage(25,false));assert.equal(b.admit(),false);assert.equal(b.snapshot().stopReason,'CAMPAIGN_OBSERVED_TOKEN_LIMIT');assert.equal(b.snapshot().hardCap,false);assert.ok(b.snapshot().partialReports.includes('import-1'));
});
test('pool integration admits bounded independent cells and records all started outcomes',async()=>{
 const {runPool}=await import('../pool.mjs');const b=createCampaignBudget(100),cells=['rename','query','import'].flatMap(caseId=>[1,2].map(repetition=>({caseId,repetition})));let active=0,peak=0;const outcomes=[];
 const result=await runPool(cells,3,async cell=>{active++;peak=Math.max(active,peak);const id=cell.caseId+'-'+cell.repetition;b.register(id);await new Promise(r=>setTimeout(r,5));b.observe(id,{observedTotals:{totalTokens:{value:60,complete:true}}});active--;return {...cell,status:cell.caseId==='query'?'PREPARATION_FAILED':'PASS'};},{admit:()=>b.admit(),onResult:r=>outcomes.push(r)});
 assert.equal(peak,3);assert.equal(result.started,4);assert.equal(result.notStarted,2);assert.equal(result.results.length,4);assert.equal(outcomes.length,4);assert.equal(result.stopped,true);assert.ok(outcomes.some(r=>r.status==='PREPARATION_FAILED'));
});
test('optional campaign token cap validates positive safe integers',async()=>{
 const {validateProfile}=await import('../core.mjs');const profile=JSON.parse(fs.readFileSync(path.join(BASE,'bench/profiles/default.json')));
 assert.equal(validateProfile({...profile,limits:{...profile.limits,maxCampaignReportedTokens:18000000}}).limits.maxCampaignReportedTokens,18000000);
 for(const value of [0,-1,NaN,Infinity,1.5])assert.throws(()=>validateProfile({...profile,limits:{...profile.limits,maxCampaignReportedTokens:value}}),/maxCampaignReportedTokens/);
 const without={...profile,limits:{...profile.limits}};delete without.limits.maxCampaignReportedTokens;assert.equal(validateProfile(without),without);
});

test('effective workspace-write roots stay within case workspace or explicitly supplied temp',t=>{
 const base=temp(t),cwd=path.join(base,'workspace'),tmpDir=path.join(base,'case-temp'),outside=path.join(base,'outside');
 for(const root of [cwd,tmpDir,outside])fs.mkdirSync(root);
 fs.symlinkSync(outside,path.join(cwd,'escape'));
 const expected={model:'model',effort:'high',cwd,sandbox:'workspaceWrite',tmpDir};
 const ack=roots=>({thread:{id:'t'},model:'model',reasoningEffort:'high',cwd,approvalPolicy:'never',sandbox:{type:'workspaceWrite',networkAccess:false,excludeSlashTmp:true,writableRoots:roots}});
 for(const roots of [[],[cwd],[tmpDir],[path.join(cwd,'new/nested')],[cwd,tmpDir]])assert.doesNotThrow(()=>assertEffectiveThread(ack(roots),expected));
 for(const roots of [undefined,null,'/',[base],[outside],['relative'],[path.join(cwd,'escape')],[path.join(cwd,'escape/future')]])assert.throws(()=>assertEffectiveThread(ack(roots),expected),/sandbox.writableRoots/);
 assert.throws(()=>assertEffectiveThread(ack([tmpDir]),{...expected,tmpDir:null}),/sandbox.writableRoots/);
});
test('read-only acknowledgment cannot carry writable roots',t=>{
 const cwd=temp(t),expected={model:'model',effort:'high',cwd,sandbox:'readOnly'};
 const ack=roots=>({thread:{id:'t'},model:'model',reasoningEffort:'high',cwd,approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false,...(roots===undefined?{}:{writableRoots:roots})}});
 for(const roots of [undefined,[]])assert.doesNotThrow(()=>assertEffectiveThread(ack(roots),expected));
 for(const roots of [[cwd],null,'/'])assert.throws(()=>assertEffectiveThread(ack(roots),expected),/sandbox.writableRoots/);
});
