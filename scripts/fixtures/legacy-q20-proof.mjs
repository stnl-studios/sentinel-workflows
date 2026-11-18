// Test-only historical producer. Current runtime authenticates the resulting
// evidence; only the isolated producer retains the former terminal ceremony.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
async function legacyTerminalRuntime(t){
 const runtime=await fs.mkdtemp('/tmp/sentinel-legacy-q20-');
 t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 await fs.cp(path.resolve('skills'),path.join(runtime,'skills'),{recursive:true});
 await fs.cp(path.resolve('scripts/fixtures'),path.join(runtime,'scripts/fixtures'),{recursive:true});
 await fs.symlink(path.resolve('node_modules'),path.join(runtime,'node_modules'),'dir');
 const legacy=await fs.readFile(new URL('./legacy-terminal-certification.txt',import.meta.url),'utf8');
 let patched=0;
 const visit=async dir=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const name=path.join(dir,entry.name);
  if(entry.isDirectory())await visit(name);
  else if(entry.name==='execution-current-reader.mjs'){
   const source=await fs.readFile(name,'utf8'),start=source.indexOf('function terminalCertification('),end=source.indexOf('\nasync function readCurrentExecution',start);
   if(start<0)continue;
   if(end<0)throw new Error('legacy producer seam missing');
   patched++;
   await fs.writeFile(name,source.slice(0,start)+legacy+source.slice(end));
  }
 }};
 await visit(path.join(runtime,'skills'));
 if(patched<7)throw new Error('legacy producer distribution incomplete');
 await fs.mkdir(path.join(runtime,'tmp'),{recursive:true});
 return runtime;
}
export async function legacyQ20Proof(t){
 const runtime=await legacyTerminalRuntime(t);
 const script=`import fs from 'node:fs/promises';import path from 'node:path';
 import {completedNativeCase,reopeningInput} from './scripts/fixtures/current-completed-native.mjs';
 import {retireActive} from './scripts/fixtures/current-reader-campaign.mjs';
 import {captureCurrentExecution} from './skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
 import {preparePreparationCandidate} from './skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
 import {preparePlanCandidate} from './skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs';
 import {publishPreparationCandidate} from './scripts/fixtures/synthetic-preparation-approval.mjs';
 import {normalizedFormal} from './scripts/fixtures/current-native-normalization.mjs';
 const decode=bytes=>JSON.parse(Buffer.from(bytes));
 const f=await completedNativeCase({after(){}},{drift:false,independent:true,retire:false});
 const image=await captureCurrentExecution(f.specPath),snapshot=decode(image.files.get('approved-preparation.json'));
 await retireActive({project:f.root,execution:f.image.f.execution,specPath:f.specPath,source:f.specPath,spec:path.dirname(f.specPath),authority:image.requirementsAuthority,activation:decode(image.activationBytes),snapshot,continuity:decode(image.files.get('continuity.json')),files:new Map([...image.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),artifacts:new Map(snapshot.reviewedArtifacts.map(x=>[x.path,Buffer.from(x.utf8)]))});
 const source=await captureCurrentExecution(f.specPath),input=reopeningInput(source,f.delivery.deliveryId,{terminalValidation:true});
 const draft=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:input.completedDeliveryIds,terminalValidation:true});
 const options={specPath:f.specPath,candidateExecutionRoot:draft.candidateExecutionRoot};
 for(const [name,bytes]of input.artifacts){const target=path.join(draft.candidateExecutionRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
 await preparePlanCandidate(options);const proposal=await publishPreparationCandidate(options);
 const approve=request=>({...request,decision:'approved',summary:'Historical controlled Q20 review.',evidenceDecisions:request.evidenceDecisions.map(x=>({...x,reason:'Retain exact local historical proof.'}))});
 await publishPreparationCandidate({...options,reviewDecision:{globalReview:approve(proposal.reviewRequest.globalReview),deliveries:proposal.reviewRequest.deliveries.map(x=>({deliveryId:x.deliveryId,review:approve(x.review)}))}});
 const before=await captureCurrentExecution(f.specPath),current=decode(before.files.get('continuity.json')).deliveries[0],predecessor=decode(before.files.get(current.evidence.path));
 await normalizedFormal({...f,delivery:current},{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
 console.log(JSON.stringify({root:f.root,specPath:f.specPath,predecessor}));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{cwd:runtime,timeout:180000,maxBuffer:8*1024*1024});
 const result=JSON.parse(stdout);t.after(()=>fs.rm(result.root,{recursive:true,force:true}));return result;
}


export async function legacyInitialQ20Proof(t){
 const runtime=await legacyTerminalRuntime(t),resultPath=path.join(runtime,'initial-q20-result.json');
 const testPath='scripts/test-current-initial-native-operation.mjs';
 let source=await fs.readFile(path.resolve(testPath),'utf8');
 const title='Initial EXECUTE proof survives Q18 and the Q20 terminal formal after Q18 moved its normative hash';
 const start=source.indexOf(`test('${title}',async t=>{`),end=source.indexOf("\nfor(const metadata of ['head','requestSha256'])",start);
 if(start<0||end<0)throw new Error('legacy Initial producer seam missing');
 const body=await fs.readFile(new URL('./legacy-initial-q20-body.txt',import.meta.url),'utf8');
 source=source.slice(0,start)+`test('${title}',async t=>{\n${body}\n await fs.writeFile(${JSON.stringify(resultPath)},JSON.stringify({root:f.root,specPath:f.specPath,implementation}));\n});\n`+source.slice(end);
 await fs.writeFile(path.join(runtime,testPath),source);
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const result=await promisify(execFile)(process.execPath,['--test','--test-name-pattern='+title,testPath],{cwd:runtime,env,timeout:180000,maxBuffer:1024*1024})
  .catch(error=>{error.message+='\n'+(error.stdout??'')+'\n'+(error.stderr??'');throw error;});
 if(!await fs.stat(resultPath).catch(()=>null))throw new Error('Historical Initial producer emitted no snapshot: '+result.stdout+' '+result.stderr);
 return JSON.parse(await fs.readFile(resultPath,'utf8'));
}
