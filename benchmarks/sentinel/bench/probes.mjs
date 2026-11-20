import fs from 'node:fs';import path from 'node:path';import {spawn,spawnSync}from'node:child_process';import {fileURLToPath}from'node:url';
import {AppServer}from'./app-server.mjs';import {atomicJson,writeOnce,confined,safeId,treeHashes,digest,sha256,budgetDecision,validateProfile}from'./core.mjs';import {collectUsage}from'./telemetry.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const role=p=>p.roles.coordinator;
export function assertEffectiveProbe(response,profile,sandbox,{workspace,tmpDir}={}){
 if(response.model!==role(profile).model||response.reasoningEffort!==role(profile).effort||response.approvalPolicy!=='never'||response.sandbox?.type!==sandbox||response.sandbox?.networkAccess!==false||typeof response.thread?.id!=='string'||!response.thread.id||typeof workspace!=='string'||response.cwd!==workspace)throw Error('probe effective configuration mismatch');
 const writable=response.sandbox.writableRoots;
 if(sandbox==='workspaceWrite'){
  const allowed=[workspace,...(tmpDir?[tmpDir]:[])];
  if(response.sandbox.excludeSlashTmp!==true||!Array.isArray(writable)||writable.some(root=>typeof root!=='string'||!path.isAbsolute(root)||!allowed.some(base=>{try{return confined(base,root)===path.resolve(root);}catch{return false;}})))throw Error('probe effective configuration mismatch: writable roots');
 }else if(sandbox==='readOnly'&&writable!==undefined&&(!Array.isArray(writable)||writable.length))throw Error('probe effective configuration mismatch: writable roots');
}
function log(file,context,payload){fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),context,payload})+'\n');}
export function prepareProbe({base,label,profile,kind,authFile=path.join(process.env.HOME,'.codex/auth.json')}){
 validateProfile(profile);safeId(label);base=fs.realpathSync.native(base);
 const work=confined(base,`work/probes/${label}`),evidence=confined(base,`evidence/probes/${label}`);
 if(fs.existsSync(work)||fs.existsSync(evidence))throw Error('probe label already exists');
 fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync(work,{recursive:true});
 try{
  const workspace=path.join(work,'workspace'),home=path.join(work,'home'),tmpDir=path.join(work,'temp');for(const d of[workspace,home,tmpDir])fs.mkdirSync(d);
  fs.cpSync(confined(base,'fixtures/todo'),workspace,{recursive:true});treeHashes(workspace);
  fs.mkdirSync(path.join(workspace,'.poc-temp'));fs.writeFileSync(path.join(workspace,'.gitignore'),'/.poc-temp/\n');fs.writeFileSync(path.join(workspace,'AGENTS.md'),'Synthetic transport probe only. No Sentinel lifecycle or delegation. Use only requested .poc-temp files; no network, push, global modifications or additional actions.\n');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));Object.assign(env,{TMPDIR:tmpDir,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Probe','-c','user.email=probe@localhost','commit','-qm','Isolated synthetic probe']]){const r=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:workspace,env,encoding:'utf8',timeout:10000});if(r.status!==0||r.error)throw Error('probe Git preparation failed');}
  const codexHome=path.join(home,'.codex');fs.mkdirSync(codexHome);if(!fs.statSync(authFile).isFile())throw Error('authentication file unavailable');fs.symlinkSync(path.resolve(authFile),path.join(codexHome,'auth.json'));
  fs.writeFileSync(path.join(codexHome,'config.toml'),'cli_auth_credentials_store = "file"\n');
  const cliCheck=spawnSync(profile.cli,['--version'],{cwd:workspace,env:{...process.env,CODEX_HOME:codexHome,TMPDIR:tmpDir},encoding:'utf8',timeout:10000,maxBuffer:1024*1024});if(cliCheck.error||cliCheck.status!==0||cliCheck.stdout.trim()!==`codex-cli ${profile.cliVersion}`)throw Error('probe CLI version mismatch');
  const options={base,label,kind,workspace,codexHome,tmpDir,evidence,profile,cliVersionObserved:cliCheck.stdout.trim(),deadline:Date.now()+180000};writeOnce(path.join(evidence,'manifest.json'),options);return options;
 }catch(e){writeOnce(path.join(evidence,'preparation-diagnostic.json'),{status:'BLOCKED',reason:e.message,preserved:true});throw e;}
}
const serverOptions=(p,onEvent)=>({cli:p.profile.cli,cwd:p.workspace,home:p.codexHome,tmpDir:p.tmpDir,onEvent});
async function usageFor(p,threadId,eventFiles,collector){try{return await collector({sessionRoot:path.join(p.codexHome,'sessions'),eventFiles,rootThreads:[{threadId,role:'coordinator',caseId:p.label}],roleRules:[],expectedProfile:{roles:{coordinator:role(p.profile)}}});}catch(e){return{status:'MISSING',error:e.message,observedTotals:null};}}
export async function runNoProgressProbe({base,label,profile,authFile,services={}}){
 const p=prepareProbe({base,label,profile,authFile,kind:'no-progress'}),events=path.join(p.evidence,'events.jsonl');fs.writeFileSync(events,'',{flag:'wx'});
 const scope=Object.keys(services).length?'simulated':'live',make=services.serverFactory??(o=>new AppServer(o)),collector=services.collectUsage??collectUsage;let threadId=null,result;
 const server=make(serverOptions(p,payload=>log(events,{caseId:label,role:'coordinator',stage:'no-progress'},payload)));
 const fingerprint=()=>digest(treeHashes(p.workspace,{exclude:['.git']})),before=fingerprint(),turns=[];let unchanged=0;
 try{
  await server.start();const started=await server.startThread({model:role(profile).model,sandbox:'read-only',config:{model_reasoning_effort:role(profile).effort}});assertEffectiveProbe(started,profile,'readOnly',p);threadId=started.thread.id;writeOnce(path.join(p.evidence,'thread.json'),{threadId,effective:started});
  for(let i=0;i<2;i++){
   const decision=budgetDecision({now:Date.now(),campaignDeadline:p.deadline,caseDeadline:p.deadline,turns:i,unchanged,reportedTokens:0},{...profile.limits,maxTurns:3,maxNoProgress:2});if(decision!=='ALLOW')throw Error('probe admission '+decision);
   const r=await server.runTurn({threadId,input:[{type:'text',text:'Synthetic no-progress probe. Do not use tools, delegate or write files. Reply exactly SEM_PROGRESSO.'}],...role(profile),deadline:p.deadline,onAccepted:a=>writeOnce(path.join(p.evidence,`accepted-${i}.json`),a)});turns.push(r);writeOnce(path.join(p.evidence,`turn-${i}.json`),r);if(r.status!=='completed')throw Error('probe turn not completed');if(fingerprint()===before)unchanged++;else throw Error('read-only probe mutated workspace');
  }
  const third=budgetDecision({campaignDeadline:p.deadline,caseDeadline:p.deadline,turns:turns.length,unchanged,reportedTokens:0},{...profile.limits,maxTurns:3,maxNoProgress:2});
  result={status:turns.length===2&&unchanged===2&&third==='NO_PROGRESS'?'PASS':'FAIL',scope,threadId,turns,thirdDispatch:third,providerDispatches:turns.length,beforeFingerprint:before,afterFingerprint:fingerprint()};
 }catch(e){result={status:'BLOCKED',scope,threadId,error:e.message,turns};}finally{try{await server.stop();}catch{result={...result,status:'BLOCKED',cleanup:'unconfirmed'};}}
 result.usage=await usageFor(p,threadId,[events],collector);result.limitations=['Synthetic no-op probe; two turns do not prove general semantic progress detection.','Missing token observations remain missing, never billing estimates.'];writeOnce(path.join(p.evidence,'result.json'),result);return result;
}
function waitExit(p,ms){if(p.exitCode!==null||p.signalCode!==null)return Promise.resolve(true);return new Promise(resolve=>{const done=()=>{clearTimeout(t);resolve(true);};const t=setTimeout(()=>{p.off('close',done);resolve(false);},ms);p.once('close',done);});}
function killGroup(p,signal){if(!Number.isSafeInteger(p.pid)||p.pid<=1)throw Error('invalid owned worker PID');try{process.kill(-p.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}}
export function verifyProbeEffect(p){
 const script=`const fs=require('node:fs'),crypto=require('node:crypto');const w=process.argv[1],id=process.argv[2],claimBytes=fs.readFileSync(w+'/.poc-temp/claim.json'),claim=JSON.parse(claimBytes),effect=fs.readFileSync(w+'/.poc-temp/effect.txt');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');console.log(JSON.stringify({verifier:'separate-deterministic-process',receivedClaim:claim,observedEffect:effect.toString(),effectHash:hash(effect),claimHash:hash(claimBytes),pass:claim.attemptId===id&&claim.claimedLines===1&&claim.status==='effect-written'&&effect.toString()==='effect-1\\n'}));`;
 const r=spawnSync(process.execPath,['-e',script,p.workspace,p.label],{cwd:p.workspace,env:{...process.env,TMPDIR:p.tmpDir},encoding:'utf8',timeout:5000,maxBuffer:1024*1024});if(r.error||r.status!==0)throw Error('independent probe verifier failed');return JSON.parse(r.stdout);
}
export async function runInterruptionProbe({base,label,profile,authFile,services={}}){
 const p=prepareProbe({base,label,profile,authFile,kind:'interruption'}),scope=Object.keys(services).length?'simulated':'live';const optionsFile=path.join(p.evidence,'worker-options.json');writeOnce(optionsFile,p);
 const fd=fs.openSync(path.join(p.evidence,'worker-console.txt'),'wx');const launcher=services.workerLauncher??(({optionsFile})=>spawn(process.execPath,[path.join(HERE,'probe-worker.mjs'),optionsFile],{cwd:p.workspace,env:{...process.env,TMPDIR:p.tmpDir},detached:true,stdio:['ignore',fd,fd]}));let worker,server,result,threadId=null,workerError=null;
 try{
  worker=launcher({optionsFile,options:p});worker.on('error',e=>{workerError=e;});let ready=false;
  while(Date.now()<p.deadline){if(fs.existsSync(path.join(p.workspace,'.poc-temp/claim.json'))){ready=true;break;}if(workerError||worker.exitCode!==null||worker.signalCode!==null)break;await pause(50);}
  if(!ready)throw Error('no durable effect/claim before deadline or worker exit');
  if(fs.existsSync(path.join(p.evidence,'worker-result.json')))throw Error('worker terminal preceded interruption; fault not proven');
  killGroup(worker,'SIGKILL');const exited=await waitExit(worker,1500);if(!exited)throw Error('worker exit unconfirmed');
  const before=verifyProbeEffect(p);if(!before.pass)throw Error('independent effect/claim mismatch');
  const accepted=JSON.parse(fs.readFileSync(path.join(p.evidence,'accepted.json'))),saved=JSON.parse(fs.readFileSync(path.join(p.evidence,'thread.json')));threadId=saved.threadId;
  if(accepted.threadId!==threadId||!accepted.turnId)throw Error('accepted turn/thread mismatch');
  const workerEvents=path.join(p.evidence,'worker-events.jsonl');const priorRows=fs.readFileSync(workerEvents,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));if(priorRows.some(r=>r.payload?.method==='turn/completed'&&r.payload.params?.threadId===threadId&&r.payload.params?.turn?.id===accepted.turnId))throw Error('turn completed before fault injection; interruption not proven');const binding={threadId,turnId:accepted.turnId,eventsHash:sha256(fs.readFileSync(workerEvents)),before};writeOnce(path.join(p.evidence,'before-resume.json'),binding);
  const events=path.join(p.evidence,'resume-events.jsonl');fs.writeFileSync(events,'',{flag:'wx'});server=(services.serverFactory??(o=>new AppServer(o)))(serverOptions(p,payload=>log(events,{caseId:label,role:'coordinator',stage:'observation-only'},payload)));await server.start();
  const resumed=await server.resumeThread({threadId,model:role(profile).model,sandbox:'read-only',config:{model_reasoning_effort:role(profile).effort}});assertEffectiveProbe(resumed,profile,'readOnly',p);if(resumed.thread.id!==threadId)throw Error('resume changed thread identity');writeOnce(path.join(p.evidence,'resume-effective.json'),resumed);
  const observed=await server.runTurn({threadId,input:[{type:'text',text:'The coordinator was killed after a durable effect. Independent verifier observed one effect-1 line and your claim. Do not repeat the command or modify files. Read .poc-temp/effect.txt and .poc-temp/claim.json only and report that the effect already exists. Observation-only.'}],...role(profile),deadline:p.deadline,onAccepted:a=>writeOnce(path.join(p.evidence,'resume-accepted.json'),a)});
  const after=verifyProbeEffect(p);result={status:observed.status==='completed'&&after.pass&&before.effectHash===after.effectHash&&before.claimHash===after.claimHash?'PASS':'FAIL',scope,threadId,binding,after,observation:observed,coordinatorInterruption:'SIGKILL-owned-process-group',workerExitObserved:exited};
 }catch(e){result={status:'BLOCKED',scope,threadId,error:e.message};}finally{if(worker?.pid&&worker.exitCode===null&&worker.signalCode===null){killGroup(worker,'SIGKILL');await waitExit(worker,1500);}if(server)try{await server.stop();}catch{result={...result,status:'BLOCKED',cleanup:'unconfirmed'};}fs.closeSync(fd);}
 result.usage=await usageFor(p,threadId,['worker-events.jsonl','resume-events.jsonl'].map(f=>path.join(p.evidence,f)).filter(f=>fs.existsSync(f)),services.collectUsage??collectUsage);
 result.limitations=['Synthetic transport interruption, not exactly-once for arbitrary effects.','Claim originates from worker model; separate verifier is deterministic, not another model.','Killed turn usage may be unflushed and incomplete; no zero substitution.','Same thread ID alone is not recovery proof: effect/claim bytes are independently compared.'];writeOnce(path.join(p.evidence,'result.json'),result);return result;
}
