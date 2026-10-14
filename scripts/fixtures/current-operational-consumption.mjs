import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fixture,approveFixture,normalizePreparation,captureLegacy,disjointDomainS0,nativeFilePass,managedFilePass,managedFilelessPass,reviewProposal} from './current-conversion.mjs';
import {prepareCurrentConversion,finalizeCurrentConversion} from '../../skills/workflows/stnl-execution-planner/runtime/execution-conversion-current.mjs';
import {readExecutionActivation} from '../../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import {beginPreparedExecutionOperation,readRunnerVerification,validateExecutionCandidate} from '../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {startNativeRunnerCapture,bindNativeRunnerIdentity,runNativeRunnerVerification,captureNativeRunnerResult} from '../../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import {prepareExecutionCopy,publishExecutionCopy} from '../../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import {serializeRunnerExecutionBundleFromResponse,insertExecutionEvidenceInCandidate} from '../../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import {prepareValidationCopy} from '../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import {prepareValidationCandidate} from '../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import {publishValidationCandidate} from '../../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import {verificationCommand} from '../../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';

const raw=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const section=(text,name,body)=>{
  const marker=new RegExp(`(^## ${name}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu');
  if(!marker.test(text)) throw new Error(`fixture Task lacks ${name}`);
  return text.replace(marker,(_,head)=>`${head}${body}\n\n`);
};
async function nativeRound(f,owner,response,changedAreas=null,started=null) {
  const start=started?.start??await startNativeRunnerCapture({specPath:f.specPath,owner,workspace:f.root,
    captureParent:f.root});
  const agentId=started?.agentId??`e2-native-${randomUUID()}`;
  if(!started) await bindNativeRunnerIdentity({...start,agentId});
  const measured=await runNativeRunnerVerification({originFile:start.originFile});
  if(measured.status!=='completed') throw new Error('fixture native verification did not finish');
  const captured=await captureNativeRunnerResult({originFile:start.originFile,
    result:{agentId,status:'completed',finalResponse:JSON.stringify(response)},changedAreas});
  return {start,agentId,captured};
}
async function withOwner(f,owner,action) {
  const ownerFile=path.join(f.root,`e2-owner-${owner.operationAttemptId}.json`);
  await fs.writeFile(ownerFile,JSON.stringify({specPath:f.specPath,owner}));
  const former=process.env.STNL_OPERATION_OWNER_FILE;
  process.env.STNL_OPERATION_OWNER_FILE=ownerFile;
  try {return await action();}
  finally {if(former===undefined) delete process.env.STNL_OPERATION_OWNER_FILE;
    else process.env.STNL_OPERATION_OWNER_FILE=former;}
}
async function secondBoundary(f,round,publication) {
  const controls=new Map();
  const add=async name=>{controls.set(name,await fs.readFile(name));return name;};
  const originPath=await add(round.start.originFile),root=path.dirname(originPath);
  const receiptPath=await add(round.captured.receiptFile);
  const responsePath=await add(round.captured.semanticResponseFile);
  const observationPath=await add(path.join(root,`round-${round.start.attempt}.verification.json`));
  const publicationPath=await add(publication.allocation);
  const marker=JSON.parse(controls.get(publicationPath));
  const manifests=[];
  for(const row of marker.retention.retainedPaths) {
    if(!row.path.endsWith('.json')) continue;
    const bytes=await fs.readFile(row.path);
    let value;try {value=JSON.parse(bytes);}catch {continue;}
    if(value.format==='stnl-work-continuation-v1'
      && value.operationAttemptId===round.start.owner.operationAttemptId)
      manifests.push({path:row.path,bytes,value});
  }
  if(manifests.length!==1) throw new Error('fixture formal requires one retained work manifest');
  const manifestPath=manifests[0].path;
  controls.set(manifestPath,manifests[0].bytes);
  for(const entry of manifests[0].value.entries) if(entry.kind==='file') await add(entry.storedPath);
  const dispatchPath=await add(path.join(root,'owner.json'));
  const agentPath=await add(path.join(root,`round-${round.start.attempt}.agent.json`));
  const resultPath=await add(path.join(root,`round-${round.start.attempt}.tool-result.json`));
  const runnerMarker=JSON.parse(await fs.readFile(`${root}.publication.json`));
  const agentHash=createHash('sha256').update(round.agentId).digest('hex');
  const claims=(runnerMarker.controlFiles??[]).filter(name=>name.endsWith(`.native-agent-${agentHash}.json`));
  if(claims.length!==1) throw new Error('fixture native claim missing');
  const claimPath=await add(claims[0]);
  const continuity=JSON.parse(await fs.readFile(path.join(f.execution,'continuity.json')));
  for(const delivery of continuity.deliveries) {
    const refs=[delivery.baseline?.allocationRef?.path,delivery.baseline?.manifestRef?.path,
      ...delivery.history.flatMap(item=>[item.allocationRef.path,item.taskRef.path,item.snapshotRef.path])].filter(Boolean);
    for(const ref of refs) await add(path.resolve(f.execution,ref));
  }
  return {controls,boundary:{transport:'native',receiptPath,responsePath,observationPath,manifestPath,
    publicationPath,originPath,closure:{dispatchPath,agentPath,claimPath,resultPath}}};
}
async function twoDeliveryS2(test) {
  const f=await fixture({test,retiredSelector:true});
  await fs.mkdir(path.join(f.root,'other'));
  f.observedRoots=['src','other'];
  const target=path.join(f.root,'other/greeting.mjs');
  const relative=path.relative(path.join(f.execution,'tasks'),target).split(path.sep).join('/');
  const area=path.relative(path.join(f.execution,'tasks'),path.join(f.root,'other')).split(path.sep).join('/');
  const secondRecipe={format:'stnl-verification-recipe-v1',base:'workspace',cwd:'.',checks:[{
    id:'verification-01',executable:{literal:'node'},args:[{literal:'-e'},
      {literal:'if (2 + 2 !== 4) process.exit(1)'}],inputs:[]}],
    dependencyReview:'The second delivery uses a literal check with no inputs from the first delivery.'};
  const global=path.join(f.candidate,'plan.md');
  await fs.writeFile(global,(await fs.readFile(global,'utf8')).split('\n').map(line=>
    line.includes('| plans/slice-02.md |')
      ?line.replace(/directory: `[^`]+`/u,
        `directory: \`${path.relative(f.execution,path.join(f.root,'other')).split(path.sep).join('/')}\``)
      :line).join('\n'));
  for(const directory of ['plans','tasks']) {
    const name=path.join(f.candidate,directory,'slice-02.md');
    let content=await fs.readFile(name,'utf8');
    for(const [heading,body] of Object.entries({
      'Authorized Areas':`- directory: \`${area}\``,
      'Expected Files':`- \`${relative}\``,
      'Existing Inputs':'- none',
      'Verification Recipe':`- Recipe: ${JSON.stringify(secondRecipe)}`,
    })) content=section(content,heading,body);
    await fs.writeFile(name,content);
  }
  await normalizePreparation(f,f.candidate);
  await approveFixture(f);
  const first=await nativeFilePass(test,{existing:f});
  const installed=await readExecutionActivation(f.specPath);
  const implemented=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','2',installed.activation.activationId);
  const firstStart=await startNativeRunnerCapture({specPath:f.specPath,owner:implemented.owner,
    workspace:f.root,captureParent:f.root});
  const firstAgentId=`e2-native-${randomUUID()}`;
  await bindNativeRunnerIdentity({...firstStart,agentId:firstAgentId});
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-02',owner:implemented.owner});
  test.after(()=>fs.rm(copy.candidateRoot,{recursive:true,force:true}));
  await fs.writeFile(target,'export const greeting="hello";\n');
  let task=await fs.readFile(copy.candidateTaskArtifact,'utf8');
  task=section(task.replace('- [ ] 1.1','- [x] 1.1'),'Changed Areas',`- \`${relative}\``);
  task=section(task,'Diff Summary','- Added the second approved output and ran the prepared check.');
  await fs.writeFile(copy.candidateTaskArtifact,task);
  const recipe=await readRunnerVerification(f.specPath,'slice-02');
  const command=verificationCommand(recipe.checks[0]);
  const response={status:'TESTS_PASS',automaticCheckRound:'1/3',head:'offline-working-tree',
    discoverySources:'approved Task and prepared assertion',discoveryActions:'checked the greeting result',
    verificationTypesConsidered:'prepared Node assertion',nonApplicabilityRationale:'none',
    noVerificationCommandConfirmation:'none',commands:[{command,exit:0}],
    resultOfEachCommandAndExitCode:'Prepared assertion exited 0',selectedChecks:command,
    selectionRationale:'Observe AC-001 export',coverage:'AC-001 export value',failures:'none',
    priorRoundFailure:'none',correctionApplied:'none',inSliceRationale:'none',
    evidenceOrFailureSummary:'Prepared check exited zero',affectedFilesOrBehaviors:'second approved output',
    blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve concluded native check'};
  const round=await nativeRound(f,implemented.owner,response,[relative],{start:firstStart,agentId:firstAgentId});
  const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'EXECUTE_SLICE',
    response:JSON.stringify(response),workspace:f.root,taskArtifact:copy.candidateTaskArtifact,...round.captured});
  await insertExecutionEvidenceInCandidate({taskArtifact:copy.candidateTaskArtifact,operation:'EXECUTE_SLICE',bundle,
    validateProspectiveTask:text=>validateExecutionCandidate(f.specPath,copy.candidateExecutionRoot,[text])});
  const implementation=await publishExecutionCopy({specPath:f.specPath,slice:'slice-02',candidateRoot:copy.candidateRoot});
  if(implementation.publication!=='confirmed') throw new Error('second implementation not published in fixture');
  const afterImplementation=await readExecutionActivation(f.specPath);
  const formal=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','2',afterImplementation.activation.activationId);
  const formalResult=await withOwner(f,formal.owner,async()=>{
    const formalStart=await startNativeRunnerCapture({specPath:f.specPath,owner:formal.owner,
      workspace:f.root,captureParent:f.root});
    const formalAgentId=`e2-native-${randomUUID()}`;
    await bindNativeRunnerIdentity({...formalStart,agentId:formalAgentId});
    const parent=await fs.mkdtemp(path.join(f.root,'e2-formal-'));
    test.after(()=>fs.rm(parent,{recursive:true,force:true}));
    const candidate=await prepareValidationCopy({specPath:f.specPath,slice:'slice-02',candidateParent:parent,owner:formal.owner});
    const formalResponse={status:'PASS',head:'offline-working-tree',commands:[{command,exit:0}],
      evidence:'Prepared assertion executed; the independent semantic judgment is an offline stimulus.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',
      persistenceSummary:'Preserve concluded formal PASS'};
    const formalRound=await nativeRound(f,formal.owner,formalResponse,null,
      {start:formalStart,agentId:formalAgentId});
    const prepared=await prepareValidationCandidate({specPath:f.specPath,slice:'slice-02',workspace:f.root,
      candidateExecutionRoot:candidate.candidateExecutionRoot,...formalRound.captured});
    if(prepared.formalStatus!=='PASS') throw new Error('second formal did not pass in fixture');
    const publication=await publishValidationCandidate({specPath:f.specPath,slice:'slice-02',
      candidateExecutionRoot:candidate.candidateExecutionRoot,owner:formal.owner});
    if(publication.publication!=='confirmed') throw new Error('second formal not published in fixture');
    return {formalRound,publication};
  });
  const second=await secondBoundary(f,formalResult.formalRound,formalResult.publication);
  const imports=[...first.input.source.imports,{slice:'slice-02',implementation:[],validation:null,
    objects:new Map(),boundary:second.boundary}];
  const controls=new Map([...first.input.source.controls,...second.controls]);
  return {f,input:await captureLegacy(f,{controls,imports})};
}

export async function convertedImage(test,{kind='native-s1'}={}) {
  const produced=kind==='native-s1'
    ?await nativeFilePass(test,{fileless:true})
    :kind==='managed-s2'?await managedFilePass(test)
      :kind==='managed-s1'?await managedFilelessPass(test)
      :kind==='disjoint-s0'?await disjointDomainS0(test)
      :kind==='two-s2'?await twoDeliveryS2(test)
      :kind==='s0'?await (async()=>{
        const f=await fixture({test});await approveFixture(f);
        return {f,input:await captureLegacy(f)};
      })():null;
  if(!produced) throw new Error('unknown real conversion fixture');
  const {f,input}=produced;
  const proposal=await prepareCurrentConversion(input);
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  const snapshot=JSON.parse(candidate.files.get('approved-preparation.json'));
  const activation={format:'stnl-execution-activation-v2',activationId:randomUUID(),sequence:1,
    previousActivationId:null,preparationRevision:snapshot.preparationRevision,
    requirementsAuthority:input.requirementsAuthority,normativeSha256:snapshot.normativeSha256,
    approvedSnapshotSha256:raw(candidate.files.get('approved-preparation.json')),
    artifacts:[...candidate.files].map(([name,bytes])=>({path:name,sha256:raw(bytes)}))
      .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),activeAttempt:null,lastAttempt:null};
  await fs.rm(f.execution,{recursive:true,force:true});
  await fs.mkdir(f.execution,{recursive:true});
  for(const [name,bytes] of candidate.files) {
    const destination=path.join(f.execution,name);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.writeFile(destination,bytes);
  }
  await fs.writeFile(path.join(f.execution,'activation.json'),JSON.stringify(activation)+'\n');
  return {f,input,candidate,activation,produced};
}

export async function installSuccessor(image,previousActivation,composed) {
  const snapshot=JSON.parse(composed.files.get('approved-preparation.json'));
  const activationId=randomUUID();
  const activation={format:'stnl-execution-activation-v2',activationId,
    sequence:previousActivation.sequence+1,previousActivationId:previousActivation.activationId,
    preparationRevision:snapshot.preparationRevision,
    requirementsAuthority:previousActivation.requirementsAuthority,
    normativeSha256:snapshot.normativeSha256,
    approvedSnapshotSha256:raw(composed.files.get('approved-preparation.json')),
    artifacts:[...composed.files].map(([name,bytes])=>({path:name,sha256:raw(bytes)}))
      .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),activeAttempt:null,
    lastAttempt:{operationAttemptId:composed.transition.operationAttemptId,
      deliveryId:composed.transition.deliveryId,slice:composed.transition.slice,
      operation:'VALIDATE_SLICE',terminalActivationId:activationId,outcome:'recorded'}};
  await fs.rm(image.f.execution,{recursive:true,force:true});
  await fs.mkdir(image.f.execution,{recursive:true});
  for(const [name,bytes] of composed.files) {
    const destination=path.join(image.f.execution,name);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    await fs.writeFile(destination,bytes);
  }
  await fs.writeFile(path.join(image.f.execution,'activation.json'),JSON.stringify(activation)+'\n');
  return activation;
}
