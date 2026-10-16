import fs from 'node:fs/promises';
import path from 'node:path';
import {payload} from './current-initial-evidence.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {completedNativeCase} from './current-completed-native.mjs';
import {refreshCampaign} from './current-reader-campaign.mjs';
import {captureCurrentExecution} from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

// Controlled preparation setup, not an official producer of completed/R3.
// B has no prior evidence decision or consumption in this approved image.
export async function completedPristineCase(t) {
  const f=await completedNativeCase(t,{drift:false}),view=f.view;
  const b=view.continuity.deliveries[0];
  const oldPath=b.evidence.path;view.files.delete(oldPath);
  await fs.rm(path.join(view.execution,oldPath));
  b.evidence=null;b.validation='unvalidated';b.normalization=null;b.lastDiagnostic=null;
  b.counters={implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0};
  for(const item of view.snapshot.deliveries)item.review.evidenceDecisions=[];
  for(const name of [`tasks/${b.slice}.md`,'tasks.md'])view.files.set(name,Buffer.from(view.artifacts.get(name)));
  await refreshCampaign(view);
  const image=await captureCurrentExecution(f.specPath);
  return {...f,delivery:b,image};
}

async function execute(f,{statuses=['TESTS_PASS'],invalid=false,headOverride=null}={}) {
  const before=await captureCurrentExecution(f.specPath);
  const start=await begin({specPath:f.specPath,slice:f.delivery.slice,operation:'EXECUTE_SLICE',expectedActivationId:before.inspection.activationId});
  const rounds=[];
  for(let i=0;i<statuses.length;i++) {
    await fs.writeFile(path.join(f.root,'other/greeting.mjs'),`export const greeting=${statuses[i]==='TESTS_FAIL'?'"broken"':'"hello"'}; // current implementation ${i+1}\n`);
    const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'}),agentId=`controlled-pristine-${start.owner.operationAttemptId}-${i+1}`;
    await bindNative(start.handle,agentId);const observation=await verifyNative(dispatch.originFile);
    const {head,...result}=payload(i+1,statuses[i],observation.commands[0].exit);result.commands=observation.commands;
    if(invalid)result.coverage='none';
    if(headOverride!==null)result.head=headOverride;
    if(statuses[i]==='BLOCKED')result.blockers='Controlled semantic blocker requires a human acceptance decision before further execution.';
    const raw=JSON.stringify({format:'stnl-current-native-judgment-v1',result});
    const file=path.join(f.root,`controlled-pristine-${i+1}.json`);await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse:raw}));
    await captureNative(start.handle,file);rounds.push({dispatch,observation,raw});
  }
  return {before,start,rounds};
}
async function formal(f,{status='PASS',newFindings=[],references='none',dispositions='none'}={}) {
  const before=await captureCurrentExecution(f.specPath);
  const start=await begin({specPath:f.specPath,slice:f.delivery.slice,operation:'VALIDATE_SLICE',expectedActivationId:before.inspection.activationId});
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'}),agentId=`controlled-pristine-formal-${start.owner.operationAttemptId}`;
  await bindNative(start.handle,agentId);const observation=await verifyNative(dispatch.originFile);
  const result={status,commands:observation.commands,evidence:'Controlled judgment on the approved greeting behavior and actual observation.',findingReferences:references,findingDispositions:dispositions,blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'No runner product edits.'};
  const file=path.join(f.root,'controlled-pristine-formal.json');await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result,newFindings})}));
  await captureNative(start.handle,file);await publish(start.handle);return {start,dispatch,observation};
}


function reviewInput(image,round) {
  const files=new Map([...image.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),snapshot=JSON.parse(files.get('approved-preparation.json'));
  const current=JSON.parse(files.get('continuity.json')).deliveries[0],slice=current.slice,next=current.localRevision+1;
  const update=bytes=>Buffer.from(Buffer.from(bytes).toString('utf8').replace(`- Local revision: ${current.localRevision}`,`- Local revision: ${next}`)
    .replace(/^- Recipe: (.+)$/mu,(_,raw)=>{const recipe=JSON.parse(raw);recipe.checks[0].args.splice(1,0,{literal:round===1?'--test-reporter=tap':'--test-concurrency=1'});return '- Recipe: '+JSON.stringify(recipe);})
    .replace(/(## Expected Tests\n\n)- node[^\n]+/u,(_,heading)=>heading+'- node --test '+(round===1?'--test-reporter=tap':'--test-concurrency=1 --test-reporter=tap')+' other/greeting.test.mjs'));
  return {context:image.context,requirementsAuthority:image.requirementsAuthority,previous:{activationBytes:image.activationBytes,files},slice,
    planBytes:update(files.get(`plans/${slice}.md`)),reviewedTaskBytes:update(snapshot.reviewedArtifacts.find(item=>item.path===`tasks/${slice}.md`).utf8),currentTaskBytes:update(files.get(`tasks/${slice}.md`))};
}



export {execute,formal,reviewInput};
