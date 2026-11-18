import fs from 'node:fs';import path from 'node:path';import {pathToFileURL}from'node:url';
import {AppServer}from'./app-server.mjs';
import {assertEffectiveProbe}from'./probes.mjs';import {confined,safeId,writeOnce,validateProfile}from'./core.mjs';
export async function runProbeWorker(p,{serverFactory=o=>new AppServer(o)}={}){
 safeId(p.label);validateProfile(p.profile);const base=fs.realpathSync.native(p.base);
 if(confined(base,`work/probes/${p.label}/workspace`)!==p.workspace||confined(base,`evidence/probes/${p.label}`)!==p.evidence||confined(base,`work/probes/${p.label}/home/.codex`)!==p.codexHome||confined(base,`work/probes/${p.label}/temp`)!==p.tmpDir)throw Error('worker path binding mismatch');
 if(!Number.isFinite(p.deadline)||p.deadline<=Date.now()||p.deadline>Date.now()+180000)throw Error('worker deadline invalid');
 const events=path.join(p.evidence,'worker-events.jsonl');fs.writeFileSync(events,'',{flag:'wx'});
 const server=serverFactory({cli:p.profile.cli,cwd:p.workspace,home:p.codexHome,tmpDir:p.tmpDir,onEvent:payload=>fs.appendFileSync(events,JSON.stringify({at:new Date().toISOString(),context:{caseId:p.label,role:'coordinator',stage:'interrupted-worker'},payload})+'\n')});
 let result;try{
  await server.start();const r=p.profile.roles.coordinator;const started=await server.startThread({model:r.model,sandbox:'workspace-write',config:{model_reasoning_effort:r.effort}});assertEffectiveProbe(started,p.profile,'workspaceWrite',p);const threadId=started.thread.id;writeOnce(path.join(p.evidence,'thread.json'),{threadId,effective:started});
  const command=`const fs=require('node:fs');const fd=fs.openSync('.poc-temp/effect.txt','a');fs.writeSync(fd,'effect-1\\n');fs.fsyncSync(fd);fs.closeSync(fd);const claim=fs.openSync('.poc-temp/claim.next','w');fs.writeSync(claim,JSON.stringify({attemptId:${JSON.stringify(p.label)},claimedLines:1,status:'effect-written'}));fs.fsyncSync(claim);fs.closeSync(claim);fs.renameSync('.poc-temp/claim.next','.poc-temp/claim.json');const dir=fs.openSync('.poc-temp','r');fs.fsyncSync(dir);fs.closeSync(dir);`;
  const shell="node -e '"+command.replaceAll("'","'\\''")+"' && sleep 60";
  const prompt='Controlled interruption probe. Run exactly this ONE shell command now. Never repeat it, retry it, delegate or make other edits. It writes a durable effect and your claim before waiting. After it ends report completion.\n'+shell;writeOnce(path.join(p.evidence,'worker-intent.json'),{threadId,prompt,deadline:p.deadline});
  result=await server.runTurn({threadId,input:[{type:'text',text:prompt}],...r,deadline:p.deadline,onAccepted:a=>writeOnce(path.join(p.evidence,'accepted.json'),a)});
 }catch(e){result={status:'BLOCKED',error:e.message};}finally{await server.stop();}
 writeOnce(path.join(p.evidence,'worker-result.json'),result);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const p=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const r=await runProbeWorker(p);process.exitCode=r.status==='completed'?0:1;}
