import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {convertedImage} from './current-operational-consumption.mjs';
import {begin,normalize,normalizeSuccessor,reserveDispatch,bindNative,verifyNative,captureNative,publish,resume} from
  '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let next=0;
const run=promisify(execFile);

export async function reviewedDecisionCase(test) {
  const image=await convertedImage(test,{kind:'native-s1'});
  const root=image.f.root;
  const snapshot=JSON.parse(await fs.readFile(path.join(image.f.execution,'approved-preparation.json'),'utf8'));
  const continuity=JSON.parse(await fs.readFile(path.join(image.f.execution,'continuity.json'),'utf8'));
  const delivery=continuity.deliveries[0];
  if(snapshot.deliveries[0].review.evidenceDecisions.length!==1 || !delivery.evidence)
    throw new Error('converted fixture lacks reviewed imported evidence');
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  await run('git',['-C',root,'init','-q']);
  await run('git',['-C',root,'add','.gitignore','requirements.md']);
  await run('git',['-C',root,'-c','user.name=EC1 Fixture','-c','user.email=ec1-fixture@example.invalid',
    'commit','-qm','reviewed conversion']);
  const head=(await run('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
  await fs.writeFile(path.join(root,'src/greeting.mjs'),'export const greeting="hello";\n');
  return {image,root,head,delivery,specPath:image.f.specPath,
    activationId:image.activation.activationId};
}

// Mechanical fault carrier for bounded cases. Live acceptance uses independent
// agents and exact tool finalResponse bytes in the ignored native smoke package.
export async function normalizedFormal(fixture,{successor=false,invalid=false,partial=false,
  candidateMutation=null,beforeCapture=null,beforePublish=null,captureOnly=false,
  invalidText='INVALID_FORMAL_RESPONSE',headOverride=null,terminalFault=false,
  references='none',dispositions='none'}={}) {
  const number=++next;
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json'),'utf8'));
  const options={specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId};
  const start=successor?await normalizeSuccessor(options):await begin(options);
  const dispatch=await reserveDispatch(start.handle);
  const agentId=`mechanical-normalization-${number}`;
  await bindNative(start.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const request=await fs.readFile(dispatch.requestFile);
  const finalResponse=invalid?invalidText:JSON.stringify({
    format:'stnl-current-validation-response-v1',requestSha256:sha(request),
    result:{status:'PASS',head:headOverride??fixture.head,commands:measured.commands,
      evidence:'The prepared AC-001 test passed under the official native verification helper.',
      findingReferences:references,findingDispositions:dispositions,blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'No product or task file changed.'},
    newFindings:[]});
  const tool=path.join(fixture.root,`mechanical-normalization-${number}.json`);
  await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
  if(beforeCapture) await beforeCapture({start,dispatch,tool,finalResponse});
  let captured;
  try {captured=await captureNative(start.handle,tool);}
  catch(error) {
    if(captureOnly) return {start,dispatch,captureError:error,finalResponse};
    throw error;
  }
  if(captureOnly) return {start,dispatch,captured,finalResponse};
  if(beforePublish) await beforePublish({start,dispatch,captured,tool,finalResponse});
  let repaired=null;
  if(partial) {
    try {await publish(start.handle,{checkpoint:async phase=>{
      if(phase==='after-candidate-file')
        throw Object.assign(new Error('controlled partial candidate'),{code:'CONTROLLED_CANDIDATE_FAILURE'});
    }});throw new Error('controlled candidate failure did not occur');}
    catch(error) {if(error.code!=='CONTROLLED_CANDIDATE_FAILURE') throw error;}
    const status=await resume(start.handle);
    if(status.nextAction!=='normalize') throw new Error('identified partial candidate was not classified');
    try {await publish(start.handle);throw new Error('direct publish bypassed partial normalization');}
    catch(error) {if(error.code!=='NORMALIZATION_NOT_ELIGIBLE') throw error;}
    if(candidateMutation) {
      const namespaceRoot=path.join(fixture.root,'tmp','sentinel');
      const namespaces=await fs.readdir(namespaceRoot);
      if(namespaces.length!==1) throw new Error('mechanical fixture namespace differs');
      await candidateMutation(path.join(namespaceRoot,namespaces[0],start.handle.operationId,'candidate'));
    }
    repaired=await normalize(start.handle);
  }
  if(terminalFault) {
    try {await publish(start.handle,{checkpoint:async phase=>{
      if(phase==='after-terminal-activation')
        throw Object.assign(new Error('controlled terminal fault'),{code:'CONTROLLED_TERMINAL_FAILURE'});
    }});throw new Error('controlled terminal failure did not occur');}
    catch(error) {if(error.code!=='CONTROLLED_TERMINAL_FAILURE') throw error;}
    if((await resume(start.handle)).phase!=='activation_written')
      throw new Error('terminal activation was not retained');
  }
  return {start,dispatch,captured,finalResponse,repaired,published:await publish(start.handle)};
}
