import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {verifyCapturedInvocation} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-proof.mjs';
import {executeRunnerVerification} from '../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';
import {nativeOperationCase} from './fixtures/current-native-operation.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,validateNativeResponse,captureNative,publish,prepareNativeContinuation,normalizeSuccessor} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
async function local(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'same-operation-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const exe=path.join(root,'check.sh'),count=path.join(root,'count');
 await fs.writeFile(exe,`#!/bin/sh\nprintf x >> '${count}'\nprintf ok\n`,{mode:0o700});
 const verification={checks:[{id:'verification-01',cwd:root,executable:exe,args:[]}]};
 let work={input:'unchanged'};const options={verification,outputFile:path.join(root,'verification.json'),observeState:async()=>work,invocationBinding:{owner:'synthetic-owner',round:1}};
 return {root,exe,count,options,setWork:value=>{work=value;},runs:async()=>(await fs.readFile(count,'utf8')).length};
}
for(const mutation of ['environment','executable','mode','arguments','cwd','work','output','context','pending','destination','binding'])test(`same-operation replay rejects ${mutation} without a second command`,async t=>{
 const f=await local(t);await executeRunnerVerification(f.options);const original=await fs.readFile(f.options.outputFile);
 const savedEnv=process.env.SENTINEL_REPLAY_TEST_SECRET;
 t.after(()=>{if(savedEnv===undefined)delete process.env.SENTINEL_REPLAY_TEST_SECRET;else process.env.SENTINEL_REPLAY_TEST_SECRET=savedEnv;});
 if(mutation==='environment')process.env.SENTINEL_REPLAY_TEST_SECRET='synthetic-secret-value-must-not-persist';
 if(mutation==='executable')await fs.appendFile(f.exe,'# changed bytes\n');
 if(mutation==='mode')await fs.chmod(f.exe,0o755);
 if(mutation==='arguments')f.options.verification.checks[0].args=['changed'];
 if(mutation==='cwd')f.options.verification.checks[0].cwd=os.tmpdir();
 if(mutation==='work')f.setWork({input:'changed'});
 if(mutation==='binding')f.options.invocationBinding={owner:'foreign-owner',round:1};
 if(mutation==='destination'){const moved=path.join(f.root,'foreign-operation.json');await fs.copyFile(f.options.outputFile,moved);f.options.outputFile=moved;}
 if(['output','context','pending','legacy'].includes(mutation)) {const v=JSON.parse(original);if(mutation==='output')v.checks[0].stdout='tampered';else if(mutation==='context')v.executionContext.environmentSha256='sha256:'+'a'.repeat(64);else if(mutation==='pending')v.status='started';else{v.format='stnl-runner-verification-v1';delete v.executionContext;}await fs.writeFile(f.options.outputFile,JSON.stringify(v));}
 await assert.rejects(()=>executeRunnerVerification(f.options),/runner verification:/);
 assert.equal(await f.runs(),1);
 assert.doesNotMatch(await fs.readFile(f.options.outputFile,'utf8'),/synthetic-secret-value-must-not-persist/);
 if(!['output','context','pending','legacy'].includes(mutation))assert.deepEqual(await fs.readFile(f.options.outputFile),original);
});
test('same-operation completed proof replays byte-identically without repeating command',async t=>{
 const f=await local(t),first=await executeRunnerVerification(f.options),bytes=await fs.readFile(f.options.outputFile);
 assert.deepEqual(await executeRunnerVerification(f.options),first);
 assert.deepEqual(await fs.readFile(f.options.outputFile),bytes);assert.equal(await f.runs(),1);
});

test('native draft envelope corrections and exact capture retry execute only one verification',async t=>{
 const f=await nativeOperationCase(t);
 const start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:f.activationId});
 const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
 await bindNative(start.handle,'independent-formal-reviewer');
 const original=cp.execFile;let commands=0;
 cp.execFile=function(command,args,...rest){if(path.basename(String(command))==='node'&&args.some(arg=>String(arg)==='src/greeting.test.mjs'))commands++;return original.call(this,command,args,...rest);};
 syncBuiltinESMExports();t.after(()=>{cp.execFile=original;syncBuiltinESMExports();});
 const raw={format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:[],evidence:'Mechanical fixture review of AC-001.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Read-only review.'},newFindings:[]};
 await assert.rejects(()=>validateNativeResponse(dispatch.originFile,JSON.stringify(raw)),{code:'EVIDENCE_INCOMPLETE'});
 assert.equal(commands,0,'draft checking cannot start verification');
 const measured=await verifyNative(dispatch.originFile);assert.equal(commands,1);
 raw.result.commands=measured.commands;
 const observedBytes=await fs.readFile(measured.observationFile);
 const verificationFile=dispatch.originFile.replace('.origin.json','.verification.json');
 const verificationBytes=await fs.readFile(verificationFile);
 for(const bad of [r=>{r.result.head=f.head;},r=>{r.requestSha256='sha256:'+'a'.repeat(64);},r=>{r.result.evidence='<semantic value>';}]) {
   const draft=structuredClone(raw);bad(draft);
   await assert.rejects(()=>validateNativeResponse(dispatch.originFile,JSON.stringify(draft)));
   assert.equal(commands,1);await assert.rejects(fs.lstat(dispatch.originFile.replace('.origin.json','.response.json')),{code:'ENOENT'});
 }
 const oldEnvironment=process.env.SENTINEL_NATIVE_REPLAY_CHANGE;
 process.env.SENTINEL_NATIVE_REPLAY_CHANGE='synthetic changed environment';
 try {await assert.rejects(()=>validateNativeResponse(dispatch.originFile,JSON.stringify(raw)),/context is stale/);} finally {if(oldEnvironment===undefined)delete process.env.SENTINEL_NATIVE_REPLAY_CHANGE;else process.env.SENTINEL_NATIVE_REPLAY_CHANGE=oldEnvironment;}
 const sourceFile=path.join(f.root,'src/greeting.mjs'),sourceBytes=await fs.readFile(sourceFile);
 await fs.appendFile(sourceFile,'// later author edit\n');
 try {await assert.rejects(()=>validateNativeResponse(dispatch.originFile,JSON.stringify(raw)));} finally {await fs.writeFile(sourceFile,sourceBytes);}
 assert.equal(commands,1,'changed context must never rerun checks');
 raw.result.evidence='Mechanical fixture review: literal <3 -> remains evidence text.';
 const finalResponse=JSON.stringify(raw);
 assert.equal((await validateNativeResponse(dispatch.originFile,finalResponse)).status,'valid-envelope');
 assert.equal((await validateNativeResponse(dispatch.originFile,finalResponse)).captured,false);
 const cli=await new Promise((resolve,reject)=>cp.execFile(process.execPath,[dispatch.verificationHelper,'validate-native-response','--origin-file',dispatch.originFile,'--response-json',finalResponse],{encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout))));
 assert.equal(cli.status,'valid-envelope');assert.equal(cli.captured,false);
 assert.deepEqual(await fs.readFile(measured.observationFile),observedBytes);
 assert.deepEqual(await fs.readFile(verificationFile),verificationBytes);assert.equal(commands,1);
 const tool=path.join(f.root,'same-proof-tool.json');await fs.writeFile(tool,JSON.stringify({agentId:'independent-formal-reviewer',status:'completed',finalResponse}));
 await captureNative(start.handle,tool);assert.equal((await captureNative(start.handle,tool)).replayed,true);assert.equal(commands,1);
 await assert.rejects(()=>validateNativeResponse(dispatch.originFile,finalResponse),{code:'OWNER_MISMATCH'});
 const changed=path.join(f.root,'different-final-tool.json');await fs.writeFile(changed,JSON.stringify({agentId:'independent-formal-reviewer',status:'completed',finalResponse:finalResponse+' '}));
 await assert.rejects(()=>captureNative(start.handle,changed),{code:'OWNER_MISMATCH'});
 assert.equal(await prepareNativeContinuation(start.handle,{toolResultFile:tool,binding:{},firstTurnId:'late'}),null);
 await publish(start.handle);
 const image=await captureCurrentExecution(f.specPath);assert.equal(image.inspection.deliveries[0].formalStatus,'PASS');assert.equal(commands,1);
 const get=async name=>fs.readFile(dispatch.originFile.replace('.origin.json','.'+name+'.json'));
 const request=JSON.parse(await get('request')),origin=JSON.parse(await get('origin')),receipt=JSON.parse(await get('receipt'));
 const cap={transport:'native',rawResponse:await get('response'),receipt:await get('receipt'),baselineCapture:await get('baseline'),removalProofs:[],origin:await get('origin'),dispatch:await get('origin'),agentBinding:await get('agent'),agentClaim:await get('claim'),concludedToolResult:await get('tool-result'),verificationObservation:await get('observation'),validationRequest:await get('request')};
 assert.doesNotThrow(()=>verifyCapturedInvocation('current-validation',cap,receipt,finalResponse,{context:image.context,authority:request.authority,owner:request.owner},1,origin.verification));
 const observed=JSON.parse(cap.verificationObservation);observed.executionContext.invocation.binding.agentId='foreign-rehashed-reviewer';
 const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
 observed.executionContext.invocationSha256='sha256:'+createHash('sha256').update(canonical(observed.executionContext.invocation)).digest('hex');cap.verificationObservation=Buffer.from(JSON.stringify(observed));
 assert.throws(()=>verifyCapturedInvocation('current-validation',cap,receipt,finalResponse,{context:image.context,authority:request.authority,owner:request.owner},1,origin.verification),{code:'OWNER_MISMATCH'});

});


test('legacy v1 before observation publication resumes original flow without retroactive context',async t=>{
 const f=await nativeOperationCase(t);
 const start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:f.activationId});
 const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
 await bindNative(start.handle,'legacy-original-reviewer');
 const measured=await verifyNative(dispatch.originFile);
 const verificationFile=dispatch.originFile.replace('.origin.json','.verification.json');
 const legacy=JSON.parse(await fs.readFile(verificationFile));legacy.format='stnl-runner-verification-v1';delete legacy.executionContext;
 const original=Buffer.from(JSON.stringify(legacy)+'\n');await fs.writeFile(verificationFile,original);await fs.unlink(measured.observationFile);
 const originalExec=cp.execFile;let checks=0;cp.execFile=function(command,args,...rest){if(path.basename(String(command))==='node'&&args.some(arg=>String(arg)==='src/greeting.test.mjs'))checks++;return originalExec.call(this,command,args,...rest);};syncBuiltinESMExports();t.after(()=>{cp.execFile=originalExec;syncBuiltinESMExports();});
 const replay=await verifyNative(dispatch.originFile);assert.equal(replay.replayContext,'legacy-unbound');assert.match(replay.diagnostic,/no environment\/executable fingerprint/);assert.equal(checks,0);
 assert.deepEqual(await fs.readFile(verificationFile),original);assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(measured.observationFile)),'executionContext'),false);
 const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:measured.commands,evidence:'Original mechanical review remains separately captured.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Read-only.'},newFindings:[]});
 await assert.rejects(()=>validateNativeResponse(dispatch.originFile,finalResponse),{code:'LEGACY_VERIFICATION_CONTEXT_UNAVAILABLE'});
 const tool=path.join(f.root,'legacy-original-tool.json');await fs.writeFile(tool,JSON.stringify({agentId:'legacy-original-reviewer',status:'completed',finalResponse}));
 await captureNative(start.handle,tool);await publish(start.handle);assert.equal(checks,0);
 assert.equal((await captureCurrentExecution(f.specPath)).inspection.deliveries[0].formalStatus,'PASS');
});


test('completed private proof copied between two real native operations is refused before execution',async t=>{
 const f=await nativeOperationCase(t),source=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:f.activationId});
 const first=await reserveDispatch(source.handle,{responseVariant:'stnl-current-native-judgment-v1'});await bindNative(source.handle,'source-reviewer');
 const measured=await verifyNative(first.originFile),sourceFile=first.originFile.replace('.origin.json','.verification.json'),bytes=await fs.readFile(sourceFile);
 const finalResponse='Malformed source envelope; completed checks remain preserved.';
 const tool=path.join(f.root,'transplant-source.json');await fs.writeFile(tool,JSON.stringify({agentId:'source-reviewer',status:'completed',finalResponse}));await captureNative(source.handle,tool);await publish(source.handle);
 const current=await captureCurrentExecution(f.specPath),target=await normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:current.inspection.activationId});
 const second=await reserveDispatch(target.handle,{responseVariant:'stnl-current-native-judgment-v1'});await bindNative(target.handle,'target-reviewer');
 const targetFile=second.originFile.replace('.origin.json','.verification.json');await fs.writeFile(targetFile,bytes);
 const original=cp.execFile;let checks=0;cp.execFile=function(command,args,...rest){if(path.basename(String(command))==='node'&&args.some(arg=>String(arg)==='src/greeting.test.mjs'))checks++;return original.call(this,command,args,...rest);};syncBuiltinESMExports();t.after(()=>{cp.execFile=original;syncBuiltinESMExports();});
 await assert.rejects(()=>verifyNative(second.originFile),/context is stale/);assert.equal(checks,0);
 assert.deepEqual(await fs.readFile(targetFile),bytes);await assert.rejects(fs.lstat(second.originFile.replace('.origin.json','.observation.json')),{code:'ENOENT'});
});

// A real native runner used a cwd-relative origin while its dispatch persisted
// the absolute path. Both spellings must retain exactly the same admission.
test('native origin accepts relative paths and replays absolute proof without another check',async t=>{
 const f=await nativeOperationCase(t);
 const start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:f.activationId});
 const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
 await bindNative(start.handle,'relative-origin-reviewer');
 const relative=path.relative(process.cwd(),dispatch.originFile);
 const raw={format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:[],evidence:'Mechanical relative-origin admission regression.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Read-only review.'},newFindings:[]};
 await assert.rejects(()=>validateNativeResponse(relative,JSON.stringify(raw)),{code:'EVIDENCE_INCOMPLETE'});
 const measured=await verifyNative(relative);
 const verificationFile=dispatch.originFile.replace('.origin.json','.verification.json');
 const proof=await fs.readFile(verificationFile),observation=await fs.readFile(measured.observationFile);
 raw.result.commands=measured.commands;
 assert.equal((await validateNativeResponse(relative,JSON.stringify(raw))).status,'valid-envelope');
 assert.deepEqual(await verifyNative(dispatch.originFile),measured);
 assert.deepEqual(await fs.readFile(verificationFile),proof);
 assert.deepEqual(await fs.readFile(measured.observationFile),observation);
});
for(const fault of ['symlink','tamper'])test(`native relative origin rejects ${fault} before verification`,async t=>{
 const f=await nativeOperationCase(t);
 const start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:f.activationId});
 const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
 await bindNative(start.handle,'relative-origin-reviewer');
 let supplied=dispatch.originFile;
 if(fault==='symlink'){
   const alias=path.join(f.root,'origin-alias');await fs.symlink(path.dirname(dispatch.originFile),alias);
   supplied=path.join(alias,path.basename(dispatch.originFile));
 }else{
   const origin=JSON.parse(await fs.readFile(supplied,'utf8'));origin.dispatchId='foreign-dispatch';
   await fs.writeFile(supplied,JSON.stringify(origin));
 }
 const relative=path.relative(process.cwd(),supplied);
 await assert.rejects(()=>verifyNative(relative));
 await assert.rejects(()=>validateNativeResponse(relative,'{}'));
 await assert.rejects(()=>fs.stat(dispatch.originFile.replace('.origin.json','.verification.json')),{code:'ENOENT'});
 await assert.rejects(()=>fs.stat(dispatch.originFile.replace('.origin.json','.observation.json')),{code:'ENOENT'});
});
