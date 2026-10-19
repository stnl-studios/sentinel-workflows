// Authored disk image and process probes for the quiet EC-1 reader. This module
// has no product imports; the worker imports the selected distributed reader
// only after installing its filesystem guard.
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const modulePath=fileURLToPath(import.meta.url);
const repo=path.resolve(path.dirname(modulePath),'../..');
const encoded=text=>Buffer.from(text,'utf8');
export const raw=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const canonical=value=>value===null || typeof value!=='object' ? JSON.stringify(value)
  :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
    :`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const json=value=>encoded(`${canonical(value)}\n`);
const projected=(tag,preimage)=>raw(Buffer.concat([encoded(`stnl-ec1/${tag}/v1\0`),encoded(preimage)]));
const requirements=bytes=>raw(Buffer.concat([encoded('stnl-requirements-authority-v1\0'),bytes]));
const sort=(a,b)=>a<b?-1:a>b?1:0;
const DELIVERY_IDS=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];

export async function authoredImage({kind='standalone',withExecution=true}={}) {
  const prior=await import('./current-initial-preparation.mjs');
  const scratch=path.join(repo,'tmp','u3-reconstruction','l25-test-runs');
  await fsp.mkdir(scratch,{recursive:true});
  const temporary=await fsp.mkdtemp(path.join(scratch,'stnl-quiet-reader-'));
  const project=path.join(temporary,'repo with spaces');
  const spec=path.join(project,'specs','pay');
  const source=path.join(spec,kind==='standalone'?'requirements.md':'feature_spec.md');
  const execution=path.join(spec,kind==='standalone'?'requirements-execution':'execution');
  await fsp.mkdir(path.join(project,'.git'),{recursive:true});
  await fsp.mkdir(path.join(project,'src'),{recursive:true});
  await fsp.mkdir(spec,{recursive:true});
  const lifecycleBody='# Feature: Pay\n\n'+[
    ['Objective','Pay export is observable.'],['Context','Pay module.'],['Scope','Pay export.'],
    ['Out of Scope','Authentication.'],['Business Rules','The test observes pay.'],
    ['Relevant Contracts','AC-001: Pay export.'],
  ].map(([name,body])=>`## ${name}\n\n${body}\n\n`).join('');
  const lifecycleHeader='# File Purpose Header\n\n```yaml\n'
    +'purpose: Pay feature.\nstatus: ready\nread_when: Reviewing pay.\n'
    +'do_not_read_when: Another feature is selected.\ncontains: Pay requirements.\n'
    +'owner: stnl-spec-lifecycle-manager\nupdate_policy: Author writes.\n```\n\n';
  const sourceBytes=encoded(kind==='standalone'?'Pay export must remain observable.\n':lifecycleHeader+lifecycleBody);
  await fsp.writeFile(source,sourceBytes);
  const closed=['Objective','Context','Final Scope','Out of Scope','Business Rules','Important Contracts'];
  const contents=['Pay export is observable.','Pay module.','Pay export.','Authentication.',
    'The test observes pay.','AC-001: Pay export.'];
  const authority=kind==='standalone'?requirements(sourceBytes)
    :requirements(encoded(JSON.stringify({h1:'Feature: Pay',core:closed.map((name,i)=>[name,contents[i]]),records:[]})));
  const old=prior.REQUIREMENTS;
  const replace=text=>text.replaceAll(old,authority);
  const artifacts=new Map([...prior.initialArtifacts({form:kind})].map(([name,bytes])=>[name,encoded(replace(bytes.toString('utf8')))]));
  const preimages=[prior.LEAF_1_PREIMAGE,prior.LEAF_2_PREIMAGE].map(replace);
  const projectionPreimage=replace(prior.PREPARATION_PREIMAGE), globalPreimage=replace(prior.GLOBAL_REVIEW_PREIMAGE);
  const reviews=prior.initialReview(artifacts);
  const examined=names=>names.sort(sort).map(name=>({path:name,sha256:raw(artifacts.get(name))}));
  reviews.globalReview.authoritySha256=projected('global-review',globalPreimage);
  reviews.globalReview.examinedArtifactHashes=examined(['plan.md','tasks.md']);
  for (let i=0;i<2;i+=1) {
    reviews.deliveries[i].review.authoritySha256=projected('delivery',preimages[i]);
    reviews.deliveries[i].review.examinedArtifactHashes=examined([`plans/slice-0${i+1}.md`,`tasks/slice-0${i+1}.md`]);
  }
  const snapshot={format:'stnl-preparation-v3',preparationRevision:1,requirementsAuthority:authority,
    normativeSha256:projected('preparation',projectionPreimage),normativeProjection:JSON.parse(projectionPreimage),
    globalReview:reviews.globalReview,
    deliveries:reviews.deliveries.map((item,i)=>({slice:`slice-0${i+1}`,deliveryId:item.deliveryId,localRevision:1,review:item.review})),
    completed:[],reviewedArtifacts:[...artifacts].sort(([a],[b])=>sort(a,b)).map(([name,bytes])=>({path:name,sha256:raw(bytes),utf8:bytes.toString('utf8')}))};
  const snapshotBytes=json(snapshot);
  const product=new Map([['src/pay.mjs',encoded('export const pay = true;\n')],['src/pay.test.mjs',encoded('import {pay} from "./pay.mjs";\n')]]);
  for (const [name,bytes] of product) {
    await fsp.writeFile(path.join(project,name),bytes);
    await fsp.chmod(path.join(project,name),0o644);
  }
  const work={format:'stnl-current-work-v1',entries:[{path:'src',kind:'directory',children:['pay.mjs','pay.test.mjs']},
    ...[...product].map(([name,bytes])=>({path:name,kind:'file',sha256:raw(bytes),mode:0o644}))]};
  const continuity={format:'stnl-delivery-continuity-v2',nextSliceOrdinal:3,
    deliveries:DELIVERY_IDS.map((deliveryId,i)=>({slice:`slice-0${i+1}`,deliveryId,localRevision:1,
      authoritySha256:projected('delivery',preimages[i]),validation:'unvalidated',evidence:null,
      counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},baseline:structuredClone(work),
      normalization:null,lastDiagnostic:null})),completed:[]};
  const files=new Map([...artifacts,['approved-preparation.json',snapshotBytes],['continuity.json',json(continuity)]]);
  const activation={format:'stnl-execution-activation-v2',activationId:'33333333-3333-4333-8333-333333333333',
    sequence:1,previousActivationId:null,preparationRevision:1,requirementsAuthority:authority,
    normativeSha256:snapshot.normativeSha256,approvedSnapshotSha256:raw(snapshotBytes),
    artifacts:[...files].map(([name,bytes])=>({path:name,sha256:raw(bytes)})).sort((a,b)=>sort(a.path,b.path)),
    activeAttempt:null,lastAttempt:null};
  const fixture={temporary,project,spec,source,execution,authority,artifacts,snapshot,files,activation,continuity,work,product,
    specPath:kind==='standalone'?source:spec};
  if (withExecution) await writeImage(fixture);
  return fixture;
}

export async function writeImage(fixture) {
  await fsp.mkdir(fixture.execution,{recursive:true});
  for (const [name,bytes] of fixture.files) {
    const destination=path.join(fixture.execution,...name.split('/'));
    await fsp.mkdir(path.dirname(destination),{recursive:true});
    await fsp.writeFile(destination,bytes);
  }
  await fsp.writeFile(path.join(fixture.execution,'activation.json'),json(fixture.activation));
}

export function reseal(fixture) {
  fixture.files.set('continuity.json',json(fixture.continuity));
  fixture.activation.approvedSnapshotSha256=raw(fixture.files.get('approved-preparation.json'));
  fixture.activation.artifacts=[...fixture.files].map(([name,bytes])=>({path:name,sha256:raw(bytes)}))
    .sort((a,b)=>sort(a.path,b.path));
}

export function editSection(fixture,slice,heading,body) {
  const name=`tasks/${slice}.md`,before=fixture.files.get(name).toString('utf8');
  const marker=`## ${heading}\n\n`,start=before.indexOf(marker);
  if (start<0) throw new Error(`missing ${heading}`);
  const at=start+marker.length,following=before.indexOf('\n## ',at);
  fixture.files.set(name,encoded(before.slice(0,at)+body+'\n\n'+before.slice(following<0?before.length:following+1)));
}

function section(text,heading,body) {
  const marker=`## ${heading}\n\n`,start=text.indexOf(marker);
  if (start<0) throw new Error(`missing ${heading}`);
  const at=start+marker.length,following=text.indexOf('\n## ',at);
  return text.slice(0,at)+body+'\n\n'+text.slice(following<0?text.length:following+1);
}

// Integration image: the approved Markdown is authored here, while the actual
// Initial bundle is produced by the published L2.2 composer from adapted,
// concluded capture bytes. The assertions in the focal test use independent
// literal IDs/statuses and physical bytes, never a producer result as expected.
export async function producerInitialImage({transport='native',status='TESTS_PASS',statuses=[status],retainSecond=false,
  retainedRemoval=false,historicalCanary=false,semanticRejection=false,authored=false,extraOutput=false,secondIndependent=false,thirdActive=false}={}) {
  if(extraOutput && (authored || retainSecond || retainedRemoval || semanticRejection || statuses.length!==1))
    throw new Error('spaced-output fixture declares one accepted Initial round');
  if (semanticRejection) {
    if (transport!=='native') throw new Error('Initial rejection fixture uses native capture');
    statuses=[...statuses.slice(0,-1),'TESTS_NOT_APPLICABLE'];
  }
  if (!Array.isArray(statuses) || !statuses.length || statuses.length>3)
    throw new Error('Initial fixture requires one to three concluded rounds');
  if (retainedRemoval && transport!=='native') throw new Error('retained removal fixture uses native captures');
  const fixture=await authoredImage({kind:'lifecycle',withExecution:false});
  const source=await import('./current-initial-evidence.mjs');
  const secondRecipe=secondIndependent?JSON.parse(JSON.stringify(source.RECIPE).replaceAll('src/pay.mjs','verify/check.mjs')):source.RECIPE;
  const preparation=authored?null:await import('../../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs');
  const evidence=authored?null:await import('../../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs');
  const put=(name,text)=>fixture.artifacts.set(name,encoded(text));
  const edit=(name,heading,body)=>put(name,section(fixture.artifacts.get(name).toString('utf8'),heading,body));
  const plan='plan.md',task='tasks/slice-01.md',detail='plans/slice-01.md';
  edit(plan,'Global Context',`- Requirements source: \`../feature_spec.md\`\n- Requirements authority: ${fixture.authority}\n- Plan revision: 1\n- Objective: Deliver pay command.\n- Strategy: One delivery.\n- Review state: approved`);
  edit(plan,'Serial Slice Order','| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |\n'
    +'|---|---|---|---|---|---|\n| 01 - Foundation | Pay command executes. | - | AC-001 | directory: `../../../src` | plans/slice-01.md |'
    +(retainSecond?`\n| 02 - Verification | Pay export verified. | slice-01 | AC-001 | directory: \`../../../${secondIndependent?'verify':'src'}\` | plans/slice-02.md |`:''));
  edit(plan,'Global Risks and Integration','- Local checks only.');
  put('tasks.md',(retainSecond?fixture.artifacts.get('tasks.md').toString('utf8')
    :fixture.artifacts.get('tasks.md').toString('utf8').replace(/^\| \[ \] \| 02 - Verification.*\n/mu,''))
    .replace('Pay export prepared.','Pay command executes.'));
  for (const [heading,body] of [
    ['Objective and Observable Result',source.DELIVERY.objectiveAndObservableResult],['Requirements',source.DELIVERY.requirements],
    ['Included Scope',source.DELIVERY.includedScope],['Out of Scope and Boundaries',source.DELIVERY.outOfScopeAndBoundaries],
    ['Authorized Areas',source.DELIVERY.authorizedAreas],['Existing Inputs',source.DELIVERY.existingInputs],
    ['Protected Responsibilities',source.DELIVERY.protectedResponsibilities],['Risks and Strategy',source.DELIVERY.risksAndStrategy],
    ['Expected Tests',source.DELIVERY.expectedTests],['Verification Recipe',`- Recipe: ${JSON.stringify(source.RECIPE)}`],
    ['Completion Criterion',source.DELIVERY.completionCriterion],
  ]) edit(detail,heading,body);
  for (const [heading,body] of [
    ['Result',source.DELIVERY.taskResult],['Acceptance Obligations',retainSecond
      ?'- obligation-01 | requirement: AC-001 | contribution: partial | full owner: slice-02 | condition: Command exits zero | proof: Direct recipe observation'
      :'- obligation-01 | requirement: AC-001 | contribution: complete | full owner: slice-01 | condition: Command exits zero | proof: Direct recipe observation'],
    ['Authorized Areas',source.DELIVERY.authorizedAreas],['Existing Inputs',source.DELIVERY.existingInputs],
    ['Protected Responsibilities',source.DELIVERY.protectedResponsibilities],['Expected Tests',source.DELIVERY.expectedTests],
    ['Verification Recipe',`- Recipe: ${JSON.stringify(source.RECIPE)}`],
  ]) edit(task,heading,body);
  if (retainSecond) for (const name of ['plans/slice-02.md','tasks/slice-02.md']) for (const [heading,body] of [
    ['Existing Inputs',source.DELIVERY.existingInputs],
    ['Expected Tests',secondIndependent?'- node verify/check.mjs':source.DELIVERY.expectedTests],
    ['Verification Recipe',`- Recipe: ${JSON.stringify(secondRecipe)}`],
    ...(secondIndependent?[['Authorized Areas','- directory: `../../../../verify`'],
      ['Expected Files','- `../../../../verify/check.mjs`']]:[]),
  ]) edit(name,heading,body);
  if (!retainSecond) {fixture.artifacts.delete('plans/slice-02.md');fixture.artifacts.delete('tasks/slice-02.md');}
  const context={logicalSpecRoot:fixture.spec,logicalAuthorityPath:fixture.source,
    logicalExecutionRoot:fixture.execution,physicalExecutionRoot:fixture.execution,productRoot:fixture.project};
  // Independently declared projection: no projector/serializer/validator feeds
  // the authored branch, including its approval hashes and examined bytes.
  const leaf={...structuredClone(source.DELIVERY),deliveryId:DELIVERY_IDS[0]};
  if(retainSecond) leaf.obligations[0]={...leaf.obligations[0],contribution:'partial',fullOwner:'slice-02'};
  const second=structuredClone(fixture.snapshot.normativeProjection.deliveries[1]);
  Object.assign(second,{existingInputs:source.DELIVERY.existingInputs,expectedTests:source.DELIVERY.expectedTests,
    verificationRecipe:structuredClone(source.RECIPE)});
  if(secondIndependent) Object.assign(second,{authorizedAreas:'- directory: `../../../../verify`',
    expectedTests:'- node verify/check.mjs',verificationRecipe:structuredClone(secondRecipe)});
  const projection={format:'stnl-preparation-projection-v3',requirementsAuthority:fixture.authority,
    global:{objective:'Deliver pay command.',strategy:'One delivery.',risks:'- Local checks only.',
      order:retainSecond?DELIVERY_IDS:[DELIVERY_IDS[0]]},deliveries:[leaf,...(retainSecond?[second]:[])],completed:[]};
  const thirdId='33333333-7777-4777-8777-333333333333';
  if(thirdActive) {
    if(!retainSecond||!secondIndependent) throw new Error('three-delivery fixture requires independent verification domain');
    const third={...structuredClone(second),deliveryId:thirdId};
    third.obligations[0].contribution='partial';third.obligations[0].fullOwner='slice-02';
    second.dependencies.push(thirdId);projection.deliveries.splice(1,0,third);
    projection.global.order=[DELIVERY_IDS[0],thirdId,DELIVERY_IDS[1]];
    for(const group of ['plans','tasks']) {
      const text=fixture.artifacts.get(`${group}/slice-02.md`).toString('utf8')
        .replaceAll('slice-02','slice-03').replaceAll('Slice 02','Slice 03').replace('- Slice: 02','- Slice: 03')
        .replaceAll(DELIVERY_IDS[1],thirdId).replace(' - Verification',' - Earlier verification')
        .replace('contribution: complete | full owner: slice-03','contribution: partial | full owner: slice-02');
      put(`${group}/slice-03.md`,text);
    }
    edit('plans/slice-02.md','Dependencies','- slice-01\n- slice-03');
    for(const name of ['plan.md','tasks.md']) {
      const text=fixture.artifacts.get(name).toString('utf8'),row=text.split('\n').find(line=>line.includes('02 - Verification'));
      const thirdRow=row.replace('02 - Verification','03 - Earlier verification').replaceAll('slice-02.md','slice-03.md');
      put(name,text.replace(row,thirdRow+'\n'+row.replace('| slice-01 |','| slice-01, slice-03 |')));
    }
  }
  const selector=item=>item.deliveryId===thirdId?'slice-03':`slice-0${DELIVERY_IDS.indexOf(item.deliveryId)+1}`;
  const declared={normativeProjection:projection,normativeSha256:projected('preparation',canonical(projection)),
    globalReviewAuthoritySha256:projected('global-review',canonical({requirementsAuthority:fixture.authority,
      global:projection.global,deliveryIds:projection.global.order,completed:[]})),
    artifactHashes:[...fixture.artifacts].map(([name,bytes])=>({path:name,sha256:raw(bytes)})).sort((a,b)=>sort(a.path,b.path)),
    deliveries:projection.deliveries.map(item=>({slice:selector(item),deliveryId:item.deliveryId,
      authoritySha256:projected('delivery',canonical(item))}))};
  const approved=authored?declared:preparation.projectInitialPreparation({context,requirementsAuthority:fixture.authority,artifacts:fixture.artifacts});
  if (!retainSecond && canonical(approved.normativeProjection.deliveries[0])
    !==source.DELIVERY_PREIMAGE.replaceAll(source.OWNER.deliveryId,DELIVERY_IDS[0]))
    throw new Error('authored Initial delivery differs from the independent L2.2 preimage');
  const review={globalReview:{scope:'set',decision:'approved',authoritySha256:approved.globalReviewAuthoritySha256,
    examinedArtifactHashes:approved.artifactHashes.filter(item=>['plan.md','tasks.md'].includes(item.path)),
    evidenceDecisions:[],summary:'The reviewed bytes are approved.'},
  deliveries:approved.deliveries.map(delivery=>({deliveryId:delivery.deliveryId,
    review:{scope:'slice',decision:'approved',authoritySha256:delivery.authoritySha256,
      examinedArtifactHashes:approved.artifactHashes.filter(item=>[
        `plans/${delivery.slice}.md`,`tasks/${delivery.slice}.md`].includes(item.path)),
      evidenceDecisions:[],summary:'The delivery bytes are approved.'}}))};
  let sealed;
  if(authored) {
    const snapshot={format:'stnl-preparation-v3',preparationRevision:1,requirementsAuthority:fixture.authority,
      normativeSha256:declared.normativeSha256,normativeProjection:projection,globalReview:review.globalReview,
      deliveries:review.deliveries.map(item=>({slice:selector(item),deliveryId:item.deliveryId,localRevision:1,review:item.review})),
      completed:[],reviewedArtifacts:[...fixture.artifacts].map(([name,bytes])=>({path:name,sha256:raw(bytes),utf8:bytes.toString('utf8')})).sort((a,b)=>sort(a.path,b.path))};
    sealed={snapshot,bytes:json(snapshot),authority:declared};
  } else sealed=preparation.approveInitialPreparation({context,requirementsAuthority:fixture.authority,
    artifacts:fixture.artifacts,review});
  fixture.snapshot=sealed.snapshot;
  fixture.files=new Map([...fixture.artifacts,['approved-preparation.json',sealed.bytes]]);
  const canary=path.join(fixture.project,'tmp','historic','round-1.origin.json');
  const replaceRaw=bytes=>{
    const original=Buffer.from(bytes).toString('utf8');
    return encoded(original.replaceAll('/workspace',fixture.project)
      .replaceAll('/tmp/pay-candidate',fixture.execution)
      .replaceAll('/tmp/pay-native',historicalCanary?path.dirname(canary):'/tmp/pay-native')
      .replaceAll(source.OWNER.deliveryId,DELIVERY_IDS[0])
      .replaceAll(source.OWNER.normativeSha256,sealed.authority.normativeSha256)
      .replaceAll(source.AUTHORITY.context.requirementsAuthority,fixture.authority)
      .replaceAll(source.OWNER.originActivationId,fixture.activation.activationId));
  };
  const removed=retainedRemoval?(await import('./current-validation-evidence.mjs')).retainedRemovalInitial():null;
  const originals=removed?.rounds??statuses.map((roundStatus,index)=>{
    const round=index+1,exit=roundStatus==='TESTS_FAIL'?1:0;
    return transport==='managed'?source.managedRound(round,roundStatus,exit,statuses.length,statuses.length)
      :source.nativeRound(round,roundStatus,exit);
  });
  const captures=originals.map(old=>{
    return Object.fromEntries(Object.entries(old).map(([name,value])=>[name,
      value instanceof Uint8Array?replaceRaw(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?replaceRaw(item):item):value]));
  });
  if(extraOutput) for(const cap of captures) {
    const observed=JSON.parse(Buffer.from(cap.verificationObservation).toString('utf8'));
    for(const manifest of [observed.before,observed.after]) {
      manifest.entries.find(item=>item.path==='src').children=['pay report.mjs','pay.mjs'];
      manifest.entries.splice(3,0,{path:'src/pay report.mjs',kind:'file',sha256:raw(encoded('pay report\n')),mode:420});
    }
    cap.verificationObservation=json(observed);
    const receipt=JSON.parse(Buffer.from(cap.receipt).toString('utf8'));
    receipt.verification=observed;receipt.testedState.entries.unshift({path:'../../../../src/pay report.mjs',value:raw(encoded('pay report\n'))});
    cap.receipt=json(receipt);
    if(transport==='managed') {
      const latest=JSON.parse(Buffer.from(cap.latest).toString('utf8'));latest.receipt=receipt;cap.latest=json(latest);
    }
  }
  if (transport==='managed') for (const cap of captures) {
    cap.latest=Uint8Array.from(captures.at(-1).latest);
    cap.closedSupervisor=Uint8Array.from(captures.at(-1).closedSupervisor);
  }
  const owner={...source.OWNER,deliveryId:DELIVERY_IDS[0],normativeSha256:sealed.authority.normativeSha256,
    originActivationId:fixture.activation.activationId};
  const authority={preparationRevision:1,localRevision:1,normativeSha256:sealed.authority.normativeSha256,
    delivery:sealed.authority.normativeProjection.deliveries[0],context:{requirementsAuthority:fixture.authority,
      objective:'Deliver pay command.',strategy:'One delivery.',risks:'- Local checks only.'}};
  let composed;
  if(authored) {
    if(semanticRejection) throw new Error('authored Initial branch declares accepted records only');
    const oracle=await import('./current-findings-evidence.mjs');
    composed=authoredBundleFor(oracle,{implementation:captures.map((cap,i)=>oracle.authoredCheck(cap,`implementation-check-0${i+1}`,
      oracle.initialGolden(cap,i?['../../../../src/pay.mjs']:[]),authority)),captures,
      counters:{implementationChecks:captures.length,findingsChecks:0,validationAttempts:0,findings:0},authority});
  } else composed=evidence.composeInitialImplementationEvidence({context,authority,owner,currentEvidence:null,
    counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},rounds:captures});
  const product=path.join(fixture.project,'src','pay.mjs');
  await fsp.writeFile(product,encoded(`pay-v${captures.length}\n`));
  if(extraOutput) {await fsp.writeFile(path.join(fixture.project,'src/pay report.mjs'),'pay report\n');
    await fsp.chmod(path.join(fixture.project,'src/pay report.mjs'),0o644);}
  await fsp.mkdir(path.join(fixture.project,'config'),{recursive:true});
  await fsp.writeFile(path.join(fixture.project,'config','settings.json'),encoded('settings=local\n'));
  await fsp.chmod(path.join(fixture.project,'config','settings.json'),0o644);
  await fsp.rm(path.join(fixture.project,'src','pay.test.mjs'));
  const firstBaseline=retainedRemoval
    ?JSON.parse(Buffer.from(captures[0].baselineCapture).toString('utf8')).manifest
    :structuredClone(source.MANIFEST_0);
  const refusal=semanticRejection?composed.bundle.support.at(-1):null;
  const refusalNormalization=refusal?{episodeId:owner.operationAttemptId,operation:'EXECUTE_SLICE',
    causeSha256:raw(composed.bytes),sourceOperationAttemptId:owner.operationAttemptId,
    used:1,consumedInvocations:refusal.consumedInvocations,round:1,status:'exhausted'}:null;
  const refusalDiagnostic=refusal?{code:'RUNNER_RESULT_REJECTED',operationAttemptId:owner.operationAttemptId,
    reason:refusal.diagnostic,affectedPaths:[],nextAction:'stop'}:null;
  fixture.continuity.deliveries=[{slice:'slice-01',deliveryId:DELIVERY_IDS[0],localRevision:1,
      authoritySha256:approved.deliveries[0].authoritySha256,validation:semanticRejection?'uncertain':'unvalidated',
    evidence:{path:`evidence/${DELIVERY_IDS[0]}.json`,sha256:raw(composed.bytes)},
    counters:composed.counters,baseline:firstBaseline,normalization:refusalNormalization,
    lastDiagnostic:refusalDiagnostic},
    ...(retainSecond?[{slice:'slice-02',deliveryId:DELIVERY_IDS[1],localRevision:1,
      authoritySha256:approved.deliveries.find(item=>item.deliveryId===DELIVERY_IDS[1]).authoritySha256,validation:'unvalidated',evidence:null,
      counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},
      baseline:source.manifest(captures.length),normalization:null,lastDiagnostic:null}]:[])];
  if(thirdActive) {
    const third={...structuredClone(fixture.continuity.deliveries[1]),slice:'slice-03',deliveryId:thirdId,
      authoritySha256:approved.deliveries.find(item=>item.deliveryId===thirdId).authoritySha256};
    fixture.continuity.deliveries.splice(1,0,third);
  }
  fixture.continuity.nextSliceOrdinal=thirdActive?4:retainSecond?3:2;
  fixture.files.set(`evidence/${DELIVERY_IDS[0]}.json`,Buffer.from(composed.bytes));
  editSection(fixture,'slice-01','Implementation Test Evidence',composed.bundle.implementation.map(item=>item.recordUtf8).join('\n\n')||'- none');
  editSection(fixture,'slice-01','Continuity',`- Current validation: ${semanticRejection?'uncertain':'unvalidated'}\n- Current evidence: evidence/${DELIVERY_IDS[0]}.json\n- Current action: ${semanticRejection?'Resolve the retained diagnostic':'VALIDATE_SLICE'}`);
  editSection(fixture,'slice-01','Changed Areas',semanticRejection && captures.length===1?'- pending':retainedRemoval
    ?'- `../../../../src/old.mjs`\n- `../../../../src/pay.mjs`':'- `../../../../src/pay.mjs`');
  if(extraOutput) editSection(fixture,'slice-01','Changed Areas','- `../../../../src/pay report.mjs`\n- `../../../../src/pay.mjs`');
  if(captures.length-(semanticRejection?1:0)>1) editSection(fixture,'slice-01','Corrections Applied','- `../../../../src/pay.mjs`');
  if (semanticRejection) editSection(fixture,'slice-01','Delegation Blocker',
    '- Operation: EXECUTE_SLICE\n- State: active');
  fixture.activation={format:'stnl-execution-activation-v2',activationId:'44444444-4444-4444-8444-444444444444',
    sequence:2,previousActivationId:owner.originActivationId,preparationRevision:1,requirementsAuthority:fixture.authority,
    normativeSha256:sealed.authority.normativeSha256,approvedSnapshotSha256:raw(sealed.bytes),artifacts:[],activeAttempt:null,
    lastAttempt:{operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,slice:'slice-01',
      operation:'EXECUTE_SLICE',terminalActivationId:'44444444-4444-4444-8444-444444444444',
      outcome:semanticRejection?'rejected':'recorded'}};
  fixture.work=extraOutput?JSON.parse(Buffer.from(captures[0].verificationObservation).toString('utf8')).after
    :removed?.work??source.manifest(captures.length);fixture.capture=captures.at(-1);
  fixture.captures=captures;fixture.sealed=sealed;fixture.composed=composed;
  fixture.retainedRemoval=retainedRemoval;
  if (historicalCanary) {
    await fsp.mkdir(path.dirname(canary),{recursive:true});await fsp.writeFile(canary,'historical canary\n');
    fixture.historicalCanary=canary;
  }
  reseal(fixture);await writeImage(fixture);
  return fixture;
}

export async function producerFormalPass({transport='native',status='PASS',retainSecond=false,retainedRemoval=false,
  semanticRejection=false,extraOutput=false}={}) {
  if (semanticRejection && transport!=='native') throw new Error('semantic rejection fixture uses native capture');
  const fixture=await producerInitialImage({transport,retainSecond,retainedRemoval,extraOutput});
  const templates=await import('./current-validation-evidence.mjs');
  const evidence=await import('../../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs');
  const source=await import('./current-initial-evidence.mjs');
  const owner={...templates.validationOwner(),deliveryId:DELIVERY_IDS[0],
    normativeSha256:fixture.sealed.authority.normativeSha256,
    originActivationId:fixture.activation.activationId};
  const context={logicalSpecRoot:fixture.spec,logicalAuthorityPath:fixture.source,
    logicalExecutionRoot:fixture.execution,physicalExecutionRoot:fixture.execution,productRoot:fixture.project};
  const authority={preparationRevision:1,localRevision:1,normativeSha256:fixture.sealed.authority.normativeSha256,
    delivery:fixture.sealed.authority.normativeProjection.deliveries[0],
    context:{requirementsAuthority:fixture.authority,objective:'Deliver pay command.',strategy:'One delivery.',risks:'- Local checks only.'}};
  const request=templates.request({baseBytes:fixture.composed.bytes,counters:fixture.composed.counters,
    owner,authority,scopePaths:retainedRemoval?['src/old.mjs','src/pay.mjs']:extraOutput?['src/pay report.mjs','src/pay.mjs']:['src/pay.mjs'],
    priorScopePaths:extraOutput?['src/pay report.mjs','src/pay.mjs']:['src/pay.mjs']});
  const created=status==='NEEDS_FIX'?[templates.finding(1,1)]:[];
  const original=templates.capture({transport,request,approvedAuthority:authority,work:fixture.work,status,
    newFindings:created,findingReferences:created.length?'finding-01':'none',
    findingDispositions:created.length?'finding-01=active':'none'}).cap;
  const adapt=bytes=>encoded(Buffer.from(bytes).toString('utf8').replaceAll('/workspace',fixture.project)
    .replaceAll('/tmp/pay-candidate',fixture.execution)
    .replaceAll(source.OWNER.deliveryId,DELIVERY_IDS[0])
    .replaceAll(source.OWNER.normativeSha256,fixture.sealed.authority.normativeSha256)
    .replaceAll(source.AUTHORITY.context.requirementsAuthority,fixture.authority));
  const capture=Object.fromEntries(Object.entries(original).map(([name,value])=>[name,
    value instanceof Uint8Array?adapt(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?adapt(item):item):value]));
  if (retainedRemoval) {
    const receipt=JSON.parse(Buffer.from(capture.receipt).toString('utf8'));
    receipt.testedState.entries.unshift({path:'../../../../src/old.mjs',value:'REMOVED'});
    capture.receipt=json(receipt);
  }
  if (semanticRejection) {
    const response=JSON.parse(Buffer.from(capture.rawResponse).toString('utf8'));
    response.result.status='TESTS_NOT_APPLICABLE';
    templates.rebindRaw(capture,response);
    const receipt=JSON.parse(Buffer.from(capture.receipt).toString('utf8'));
    receipt.semanticResponseStatus='TESTS_NOT_APPLICABLE';
    capture.receipt=json(receipt);
  }
  const formal=evidence.composeCurrentValidationEvidence({context,authority,owner,
    previous:{bundleBytes:fixture.composed.bytes,counters:fixture.composed.counters},capture});
  fixture.files.set(`evidence/${DELIVERY_IDS[0]}.json`,Buffer.from(formal.bytes));
  const current=fixture.continuity.deliveries[0];
  current.validation=semanticRejection?'uncertain':status==='PASS'?'current':'revalidation-required';
  current.evidence.sha256=raw(formal.bytes);current.counters=formal.counters;
  editSection(fixture,'slice-01','Validation Attempts',semanticRejection?'- none':formal.bundle.validation.recordUtf8);
  editSection(fixture,'slice-01','Continuity',`- Current validation: ${current.validation}\n- Current evidence: evidence/${DELIVERY_IDS[0]}.json\n- Current action: ${semanticRejection?'Resolve the retained diagnostic':status==='PASS'?'validation complete':status==='BLOCKED'?'Await operational recovery':'APPLY_FINDINGS'}`);
  if (semanticRejection) editSection(fixture,'slice-01','Delegation Blocker',
    '- Operation: VALIDATE_SLICE\n- State: active');
  if (status==='PASS' && !semanticRejection) {
    editSection(fixture,'slice-01','Effective Validation Base',
      `- Origin attempt: attempt-01\n- Attempt type: initial\n- HEAD: 0123456789abcdef\n- Result: PASS\n- Files:\n${retainedRemoval?'  - `../../../../src/old.mjs` | REMOVED\n':''}${extraOutput?'  - `../../../../src/pay report.mjs` | '+raw(encoded('pay report\n'))+'\n':''}  - \`../../../../src/pay.mjs\` | ${raw(encoded(`pay-v${fixture.captures.length}\n`))}\n- Authoritative commands:\n  - \`node src/pay.mjs\` | exit:0\n- Evidence summary: Direct recipe observation and file hash.`);
    editSection(fixture,'slice-01','Final Result','- PASS');
  } else if (status==='NEEDS_FIX') {
    const finding=created[0];
    editSection(fixture,'slice-01','Validation Findings',`### ${finding.id}\n- Severity: ${finding.severity}\n- State: active\n- Origin: ${finding.originAttempt}\n- Problem: ${finding.problem}\n- Evidence: ${finding.evidence}\n- Impact: ${finding.impact}\n- Related authority: ${finding.relatedAuthority}\n- Expected correction: ${finding.expectedCorrection}`);
  }
  if (!semanticRejection) fixture.files.set('tasks.md',encoded(fixture.files.get('tasks.md').toString('utf8')
    .replace('| [ ] | 01 - Foundation | Pay command executes. | - | tasks/slice-01.md | pending | pending |',
      `| ${status==='PASS'?'[x]':'[ ]'} | 01 - Foundation | Pay command executes. | - | tasks/slice-01.md | ${status} | ${status==='PASS'?'PASS':'pending'} |`)));
  const oldActivation=fixture.activation.activationId;
  fixture.activation.activationId='55555555-5555-4555-8555-555555555555';
  fixture.activation.sequence=3;fixture.activation.previousActivationId=oldActivation;
  fixture.activation.lastAttempt={operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,slice:'slice-01',
    operation:'VALIDATE_SLICE',terminalActivationId:fixture.activation.activationId,
    outcome:semanticRejection?'rejected':'recorded'};
  fixture.formal=formal;fixture.formalCapture=capture;
  reseal(fixture);await writeImage(fixture);
  return fixture;
}

export async function producerTwoFormalPass({changeSecond=false,secondStatus='PASS',secondSemanticRejection=false}={}) {
  const fixture=await producerFormalPass({retainSecond:true});
  const source=await import('./current-initial-evidence.mjs');
  const validation=await import('./current-validation-evidence.mjs');
  const initial=await import('../../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs');
  const formalKernel=await import('../../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs');
  const context={logicalSpecRoot:fixture.spec,logicalAuthorityPath:fixture.source,
    logicalExecutionRoot:fixture.execution,physicalExecutionRoot:fixture.execution,productRoot:fixture.project};
  const authority={preparationRevision:1,localRevision:1,normativeSha256:fixture.sealed.authority.normativeSha256,
    delivery:fixture.sealed.authority.normativeProjection.deliveries[1],
    context:{requirementsAuthority:fixture.authority,objective:'Deliver pay command.',
      strategy:'One delivery.',risks:'- Local checks only.'}};
  const owner={...structuredClone(source.OWNER),
    operationAttemptId:'abababab-abab-4bab-8bab-abababababab',
    ownershipToken:'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc',deliveryId:DELIVERY_IDS[1],
    normativeSha256:fixture.sealed.authority.normativeSha256,
    slice:'slice-02',originActivationId:fixture.activation.activationId};
  const adapt=bytes=>encoded(Buffer.from(bytes).toString('utf8')
    .replaceAll('/workspace',fixture.project).replaceAll('/tmp/pay-candidate',fixture.execution)
    .replaceAll(source.OWNER.deliveryId,DELIVERY_IDS[1])
    .replaceAll(source.OWNER.operationAttemptId,owner.operationAttemptId)
    .replaceAll(source.OWNER.ownershipToken,owner.ownershipToken)
    .replaceAll(source.OWNER.normativeSha256,owner.normativeSha256)
    .replaceAll(source.OWNER.originActivationId,owner.originActivationId)
    .replaceAll(source.AUTHORITY.context.requirementsAuthority,fixture.authority)
    .replaceAll('slice-01','slice-02'));
  const original=source.nativeRound();
  const cap=Object.fromEntries(Object.entries(original).map(([name,value])=>[name,
    value instanceof Uint8Array?adapt(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?adapt(item):item):value]));
  const baseline=JSON.parse(Buffer.from(cap.baselineCapture).toString('utf8'));
  baseline.manifest=source.manifest(1);cap.baselineCapture=json(baseline);
  const secondWork=source.manifest(changeSecond?2:1);
  if(changeSecond) {
    const observation=JSON.parse(Buffer.from(cap.verificationObservation).toString('utf8'));
    observation.before=secondWork;observation.after=secondWork;cap.verificationObservation=json(observation);
    const receipt=JSON.parse(Buffer.from(cap.receipt).toString('utf8'));
    receipt.verification=observation;receipt.testedState.entries[0].value=raw(encoded('pay-v2\n'));cap.receipt=json(receipt);
    await fsp.writeFile(path.join(fixture.project,'src/pay.mjs'),'pay-v2\n');
  }
  const second=initial.composeInitialImplementationEvidence({context,authority,owner,currentEvidence:null,
    counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},rounds:[cap]});
  const current=fixture.continuity.deliveries[1],name=`evidence/${DELIVERY_IDS[1]}.json`;
  current.evidence={path:name,sha256:raw(second.bytes)};current.counters=second.counters;
  fixture.files.set(name,Buffer.from(second.bytes));
  editSection(fixture,'slice-02','Implementation Test Evidence',second.bundle.implementation[0].recordUtf8);
  editSection(fixture,'slice-02','Changed Areas',changeSecond?'- `../../../../src/pay.mjs`':'- none');
  if(changeSecond) editSection(fixture,'slice-02','Prior Validation Overlap','- Slice 01 overlap: `../../../../src/pay.mjs`; Direct pay regression covers the overlapping export.');
  editSection(fixture,'slice-02','Continuity',`- Current validation: unvalidated\n- Current evidence: ${name}\n- Current action: VALIDATE_SLICE`);
  const beforeSecond=fixture.activation.activationId;
  fixture.activation.activationId='88888888-8888-4888-8888-888888888888';
  fixture.activation.sequence=4;fixture.activation.previousActivationId=beforeSecond;
  fixture.activation.lastAttempt={operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,
    slice:'slice-02',operation:'EXECUTE_SLICE',terminalActivationId:fixture.activation.activationId,outcome:'recorded'};
  reseal(fixture);await writeImage(fixture);

  const formalOwner={...validation.validationOwner(3),deliveryId:DELIVERY_IDS[1],slice:'slice-02',
    normativeSha256:fixture.sealed.authority.normativeSha256,
    originActivationId:fixture.activation.activationId};
  const request=validation.request({baseBytes:second.bytes,counters:second.counters,
    owner:formalOwner,authority,scopePaths:['src/pay.mjs'],priorScopePaths:['src/pay.mjs']});
  const sourceCapture=validation.capture({transport:'native',request,approvedAuthority:authority,
    work:secondWork,status:secondStatus}).cap;
  const formalCapture=Object.fromEntries(Object.entries(sourceCapture).map(([key,value])=>[key,
    value instanceof Uint8Array?adapt(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?adapt(item):item):value]));
  if(secondSemanticRejection) {
    const response=JSON.parse(Buffer.from(formalCapture.rawResponse).toString('utf8'));
    response.result.status='TESTS_NOT_APPLICABLE';validation.rebindRaw(formalCapture,response);
    const receipt=JSON.parse(Buffer.from(formalCapture.receipt).toString('utf8'));
    receipt.semanticResponseStatus='TESTS_NOT_APPLICABLE';formalCapture.receipt=json(receipt);
  }
  const accepted=formalKernel.composeCurrentValidationEvidence({context,authority,owner:formalOwner,
    previous:{bundleBytes:second.bytes,counters:second.counters},capture:formalCapture});
  const secondPassed=secondStatus==='PASS' && !secondSemanticRejection;
  current.validation=secondSemanticRejection?'uncertain':secondPassed?'current':'revalidation-required';
  current.evidence.sha256=raw(accepted.bytes);current.counters=accepted.counters;
  fixture.files.set(name,Buffer.from(accepted.bytes));
  editSection(fixture,'slice-02','Validation Attempts',accepted.bundle.validation?.recordUtf8??'- none');
  if(secondPassed) editSection(fixture,'slice-02','Effective Validation Base',
    `- Origin attempt: attempt-01\n- Attempt type: initial\n- HEAD: 0123456789abcdef\n- Result: PASS\n- Files:\n  - \`../../../../src/pay.mjs\` | ${raw(encoded(changeSecond?'pay-v2\n':'pay-v1\n'))}\n- Authoritative commands:\n  - \`node src/pay.mjs\` | exit:0\n- Evidence summary: Direct recipe observation and file hash.`);
  editSection(fixture,'slice-02','Final Result',secondPassed?'- PASS':'- pending');
  editSection(fixture,'slice-02','Continuity',`- Current validation: ${current.validation}\n- Current evidence: ${name}\n- Current action: ${secondPassed?'Validation complete.':'Await the retained recovery decision.'}`);
  if(secondSemanticRejection) editSection(fixture,'slice-02','Delegation Blocker','- Operation: VALIDATE_SLICE\n- State: active');
  fixture.files.set('tasks.md',encoded(fixture.files.get('tasks.md').toString('utf8')
    .replace('| [ ] | 02 - Verification | Pay export verified. | slice-01 | tasks/slice-02.md | pending | pending |',
      `| ${secondPassed?'[x]':'[ ]'} | 02 - Verification | Pay export verified. | slice-01 | tasks/slice-02.md | ${secondSemanticRejection?'pending':secondStatus} | ${secondPassed?'PASS':'pending'} |`)));
  fixture.activation.activationId='99999999-9999-4999-8999-999999999999';
  fixture.activation.sequence=5;fixture.activation.previousActivationId=formalOwner.originActivationId;
  fixture.activation.lastAttempt={operationAttemptId:formalOwner.operationAttemptId,deliveryId:formalOwner.deliveryId,
    slice:'slice-02',operation:'VALIDATE_SLICE',terminalActivationId:fixture.activation.activationId,outcome:secondSemanticRejection?'rejected':'recorded'};
  fixture.secondInitial=second;fixture.secondFormal=accepted;
  reseal(fixture);await writeImage(fixture);
  return fixture;
}

export async function producerAppliedImage({transport='native',semanticRejection=false,status='TESTS_PASS',statuses=[status]}={}) {
  if (semanticRejection && transport!=='native') throw new Error('APPLY rejection fixture uses native capture');
  const fixture=await producerFormalPass({transport,status:'NEEDS_FIX'});
  const source=await import('./current-initial-evidence.mjs');
  const templates=await import('./current-findings-evidence.mjs');
  const evidence=await import('../../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs');
  const owner={...templates.applyOwner(),deliveryId:DELIVERY_IDS[0],
    normativeSha256:fixture.sealed.authority.normativeSha256,
    originActivationId:fixture.activation.activationId};
  const context={logicalSpecRoot:fixture.spec,logicalAuthorityPath:fixture.source,
    logicalExecutionRoot:fixture.execution,physicalExecutionRoot:fixture.execution,productRoot:fixture.project};
  const authority={preparationRevision:1,localRevision:1,normativeSha256:fixture.sealed.authority.normativeSha256,
    delivery:fixture.sealed.authority.normativeProjection.deliveries[0],
    context:{requirementsAuthority:fixture.authority,objective:'Deliver pay command.',strategy:'One delivery.',risks:'- Local checks only.'}};
  const adapt=bytes=>encoded(Buffer.from(bytes).toString('utf8').replaceAll('/workspace',fixture.project)
    .replaceAll('/tmp/pay-candidate',fixture.execution)
    .replaceAll(source.OWNER.deliveryId,DELIVERY_IDS[0])
    .replaceAll(source.OWNER.normativeSha256,fixture.sealed.authority.normativeSha256)
    .replaceAll(source.AUTHORITY.context.requirementsAuthority,fixture.authority));
  const rounds=[];
  for(const [i,status] of statuses.entries()) {
    const round=i+1;
    const original=templates.applyCapture({base:fixture.formal,owner,transport,round,status,exit:status==='TESTS_FAIL'?1:0,
      previousCheck:i?{id:`findings-check-0${i}`,roundCaptureSha256:templates.roundLink(rounds.at(-1))}:null,
      before:source.manifest(i?2:1),after:source.manifest(2)}).cap;
    const cap=Object.fromEntries(Object.entries(original).map(([name,value])=>[name,
      value instanceof Uint8Array?adapt(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?adapt(item):item):value]));
    const response=templates.decode(cap.rawResponse);
    response.requestSha256=raw(cap.applyRequest);
    if (semanticRejection && round===statuses.length) response.result.status='TESTS_NOT_APPLICABLE';
    templates.rebindRaw(cap,response);
    if (semanticRejection && round===statuses.length) {
      const receipt=templates.decode(cap.receipt);
      receipt.semanticResponseStatus='TESTS_NOT_APPLICABLE';cap.receipt=json(receipt);
    }
    rounds.push(cap);
  }
  if (transport==='managed') {
    templates.closeManaged(rounds);
    for(const cap of rounds) {cap.latest=adapt(cap.latest);cap.closedSupervisor=adapt(cap.closedSupervisor);}
  }
  const applied=evidence.composeCurrentFindingsEvidence({context,authority,owner,
    previous:{bundleBytes:fixture.formal.bytes,counters:fixture.formal.counters},rounds});
  const cap=rounds.at(-1);
  await fsp.writeFile(path.join(fixture.project,'src','pay.mjs'),encoded('pay-v2\n'));
  fixture.files.set(`evidence/${DELIVERY_IDS[0]}.json`,Buffer.from(applied.bytes));
  const current=fixture.continuity.deliveries[0];
  current.validation=semanticRejection?'uncertain':'revalidation-required';current.evidence.sha256=raw(applied.bytes);
  current.counters=applied.counters;current.baseline=structuredClone(source.manifest(1));
  if(semanticRejection && statuses.length===1) {
    const refusal=applied.bundle.support.at(-1);
    current.normalization={episodeId:owner.operationAttemptId,operation:'APPLY_FINDINGS',
      causeSha256:raw(applied.bytes),sourceOperationAttemptId:owner.operationAttemptId,
      used:1,consumedInvocations:1,round:1,status:'exhausted'};
    current.lastDiagnostic={code:'RUNNER_RESULT_REJECTED',operationAttemptId:owner.operationAttemptId,
      reason:refusal.diagnostic,affectedPaths:templates.decode(cap.applyRequest).scopePaths,nextAction:'stop'};
  }
  editSection(fixture,'slice-01','Implementation Test Evidence','- none');
  editSection(fixture,'slice-01','Findings Test Evidence',applied.bundle.findingsChecks.map(item=>item.recordUtf8).join('\n\n')||'- none');
  editSection(fixture,'slice-01','Corrections Applied',semanticRejection && statuses.length===1?'- none':'- `../../../../src/pay.mjs`');
  if (semanticRejection && statuses.length===1) editSection(fixture,'slice-01','Changed Areas','- none');
  if (semanticRejection) editSection(fixture,'slice-01','Delegation Blocker',
    '- Operation: APPLY_FINDINGS\n- State: active');
  editSection(fixture,'slice-01','Continuity',`- Current validation: ${current.validation}\n- Current evidence: evidence/${DELIVERY_IDS[0]}.json\n- Current action: ${semanticRejection?'Resolve the retained diagnostic':statuses.at(-1)==='BLOCKED'?'Await operational recovery':'VALIDATE_SLICE'}`);
  const oldActivation=fixture.activation.activationId;
  fixture.activation.activationId='66666666-6666-4666-8666-666666666666';
  fixture.activation.sequence=4;fixture.activation.previousActivationId=oldActivation;
  fixture.activation.lastAttempt={operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,slice:'slice-01',
    operation:'APPLY_FINDINGS',terminalActivationId:fixture.activation.activationId,
    outcome:semanticRejection?'rejected':'recorded'};
  fixture.applied=applied;fixture.applyCapture=cap;fixture.applyCaptures=rounds;
  reseal(fixture);await writeImage(fixture);
  return fixture;
}

export async function producerPostApplyPass({transport='native'}={}) {
  const fixture=await producerAppliedImage({transport});
  const templates=await import('./current-validation-evidence.mjs');
  const source=await import('./current-initial-evidence.mjs');
  const evidence=await import('../../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs');
  const owner={...templates.validationOwner(2),deliveryId:DELIVERY_IDS[0],
    normativeSha256:fixture.sealed.authority.normativeSha256,
    originActivationId:fixture.activation.activationId};
  const context={logicalSpecRoot:fixture.spec,logicalAuthorityPath:fixture.source,
    logicalExecutionRoot:fixture.execution,physicalExecutionRoot:fixture.execution,productRoot:fixture.project};
  const authority={preparationRevision:1,localRevision:1,normativeSha256:fixture.sealed.authority.normativeSha256,
    delivery:fixture.sealed.authority.normativeProjection.deliveries[0],
    context:{requirementsAuthority:fixture.authority,objective:'Deliver pay command.',strategy:'One delivery.',risks:'- Local checks only.'}};
  const request=templates.request({baseBytes:fixture.applied.bytes,counters:fixture.applied.counters,
    openFindings:fixture.applied.bundle.openFindings,priorScopePaths:['src/pay.mjs'],scopePaths:['src/pay.mjs'],owner,authority});
  request.format='stnl-current-validation-request-v2';
  const checks=fixture.applied.bundle.findingsChecks;
  request.base.auxiliary={kind:'findings',operationAttemptId:checks[0].origin.operationAttemptId,
    cycle:'attempt-01',firstCheckId:checks[0].id,lastCheckId:checks.at(-1).id,
    recordsSha256:raw(json(checks))};
  const original=templates.capture({transport,request,status:'PASS',
    findingReferences:'finding-01',findingDispositions:'finding-01=resolved',
    approvedAuthority:authority,work:source.manifest(2)}).cap;
  const adapt=bytes=>encoded(Buffer.from(bytes).toString('utf8').replaceAll('/workspace',fixture.project)
    .replaceAll('/tmp/pay-candidate',fixture.execution)
    .replaceAll(source.OWNER.deliveryId,DELIVERY_IDS[0])
    .replaceAll(source.OWNER.normativeSha256,fixture.sealed.authority.normativeSha256)
    .replaceAll(source.AUTHORITY.context.requirementsAuthority,fixture.authority));
  const capture=Object.fromEntries(Object.entries(original).map(([name,value])=>[name,
    value instanceof Uint8Array?adapt(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?adapt(item):item):value]));
  const formal=evidence.composeCurrentValidationEvidence({context,authority,owner,
    previous:{bundleBytes:fixture.applied.bytes,counters:fixture.applied.counters},capture});
  fixture.files.set(`evidence/${DELIVERY_IDS[0]}.json`,Buffer.from(formal.bytes));
  const current=fixture.continuity.deliveries[0];
  current.validation='current';current.evidence.sha256=raw(formal.bytes);current.counters=formal.counters;
  editSection(fixture,'slice-01','Validation Attempts',
    [...formal.bundle.support.filter(item=>item.kind==='validation'),formal.bundle.validation]
      .map(item=>item.recordUtf8).join('\n\n'));
  editSection(fixture,'slice-01','Validation Findings',
    '### finding-01\n- Severity: blocking\n- State: resolved\n- Origin: attempt-01\n'
    +'- Problem: finding-01 pay behavior differs from AC-001\n- Evidence: finding-01 observed command output\n'
    +'- Impact: finding-01 acceptance is affected\n- Related authority: AC-001\n'
    +'- Expected correction: finding-01 correct pay behavior\n- Resolution: attempt-02 confirmed correction');
  editSection(fixture,'slice-01','Effective Validation Base',
    `- Origin attempt: attempt-02\n- Attempt type: revalidation\n- HEAD: 0123456789abcdef\n- Result: PASS\n- Files:\n  - \`../../../../src/pay.mjs\` | ${raw(encoded('pay-v2\n'))}\n- Authoritative commands:\n  - \`node src/pay.mjs\` | exit:0\n- Evidence summary: Direct recipe observation and file hash.`);
  editSection(fixture,'slice-01','Final Result','- PASS');
  editSection(fixture,'slice-01','Continuity',`- Current validation: current\n- Current evidence: evidence/${DELIVERY_IDS[0]}.json\n- Current action: validation complete`);
  fixture.files.set('tasks.md',encoded(fixture.files.get('tasks.md').toString('utf8')
    .replace('| [ ] | 01 - Foundation | Pay command executes. | - | tasks/slice-01.md | NEEDS_FIX | pending |',
      '| [x] | 01 - Foundation | Pay command executes. | - | tasks/slice-01.md | PASS | PASS |')));
  const previous=fixture.activation.activationId;
  fixture.activation.activationId='77777777-7777-4777-8777-777777777777';
  fixture.activation.sequence=5;fixture.activation.previousActivationId=previous;
  fixture.activation.lastAttempt={operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,slice:'slice-01',
    operation:'VALIDATE_SLICE',terminalActivationId:fixture.activation.activationId,outcome:'recorded'};
  fixture.postApply=formal;fixture.postApplyCapture=capture;
  reseal(fixture);await writeImage(fixture);
  return fixture;
}

// Every authored root is selected by the scenario below, not by production
// retention code. Capsules/records use the builtin-only independent L2 fixture.
function authoredBundleFor(oracle,input) {
  const result=oracle.authoredBundle(input);
  result.bundle.deliveryId=input.authority.delivery.deliveryId;
  result.bytes=json(result.bundle);result.sha256=raw(result.bytes);
  return result;
}
function adaptCapture(fixture,source,capture) {
  const adapt=bytes=>encoded(Buffer.from(bytes).toString('utf8').replaceAll('/workspace',fixture.project)
    .replaceAll('/tmp/pay-candidate',fixture.execution)
    .replaceAll(source.OWNER.deliveryId,DELIVERY_IDS[0])
    .replaceAll(source.OWNER.normativeSha256,fixture.sealed.authority.normativeSha256)
    .replaceAll(source.AUTHORITY.context.requirementsAuthority,fixture.authority));
  return Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,
    value instanceof Uint8Array?adapt(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?adapt(item):item):value]));
}
export async function authoredCyclesImage({transport='native',cycles=1,removal=false,pass=true,retainSecond=false,producer=false,secondIndependent=false,thirdActive=false}={}) {
  if(!Number.isSafeInteger(cycles) || cycles<1 || cycles>8) throw new Error('bounded authored cycle count');
  const fixture=await producerInitialImage({transport,authored:true,retainSecond,secondIndependent,thirdActive});
  const source=await import('./current-initial-evidence.mjs');
  const formal=await import('./current-validation-evidence.mjs');
  const oracle=await import('./current-findings-evidence.mjs');
  const kernel=producer?await import('../../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs'):null;
  const context={logicalSpecRoot:fixture.spec,logicalAuthorityPath:fixture.source,logicalExecutionRoot:fixture.execution,
    physicalExecutionRoot:fixture.execution,productRoot:fixture.project};
  const authority={preparationRevision:1,localRevision:1,normativeSha256:fixture.sealed.authority.normativeSha256,
    delivery:fixture.snapshot.normativeProjection.deliveries[0],context:{requirementsAuthority:fixture.authority,
      objective:'Deliver pay command.',strategy:'One delivery.',risks:'- Local checks only.'}};
  const counters=(checks,attempts)=>({implementationChecks:1,findingsChecks:checks,validationAttempts:attempts,findings:1});
  const uuid=n=>`${String(n).padStart(8,'0')}-1234-4234-8234-${String(n).padStart(12,'0')}`;
  const owner=(operation,n)=>({operationAttemptId:uuid(n),ownershipToken:uuid(n+1000),deliveryId:DELIVERY_IDS[0],slice:'slice-01',
    operation,preparationRevision:1,localRevision:1,normativeSha256:authority.normativeSha256,originActivationId:fixture.activation.activationId});
  const scope=removal?['src/old.mjs','src/pay.mjs']:['src/pay.mjs'];
  const work=(version,old='absent')=>{
    const value=source.manifest(version);
    if(removal) {
      value.entries.splice(3,0,old==='file'?{path:'src/old.mjs',kind:'file',sha256:raw(encoded('old source\n')),mode:420}
        :{path:'src/old.mjs',kind:'absent'});
      if(old==='file') value.entries[2].children=['old.mjs','pay.mjs'];
    }
    return value;
  };
  const receiptScope=(cap,manifest)=>{
    const receipt=oracle.decode(cap.receipt);
    receipt.testedState.entries=scope.map(name=>{
      const entry=manifest.entries.find(item=>item.path===name);
      return {path:'../../../../'+name,value:entry.kind==='absent'?'REMOVED':entry.sha256};
    });
    cap.receipt=json(receipt);
    if(cap.transport==='managed') {
      const latest=oracle.decode(cap.latest);latest.receipt=receipt;cap.latest=json(latest);
    }
  };
  const advance=(operation,incorporatedOwner)=>{
    fixture.activation.previousActivationId=incorporatedOwner.originActivationId;
    fixture.activation.activationId=uuid(2000+fixture.activation.sequence);
    fixture.activation.sequence+=1;
    fixture.activation.lastAttempt={operationAttemptId:incorporatedOwner.operationAttemptId,deliveryId:DELIVERY_IDS[0],
      slice:'slice-01',operation,terminalActivationId:fixture.activation.activationId,outcome:'recorded'};
  };
  const accept=(expected,produced,label)=>{
    if(produced && (canonical(produced.bundle)!==canonical(expected.bundle) || canonical(produced.counters)!==canonical(expected.counters)))
      throw new Error(`${label}: producer differs from declared records, roots, capsules or counters`);
    fixture.chain.push({label,roots:{implementation:expected.bundle.implementation.map(item=>item.id),
      findings:expected.bundle.findingsChecks.map(item=>item.id),validation:expected.bundle.validation?.id,
      support:expected.bundle.support.map(item=>item.id)},counters:structuredClone(expected.counters)});
    return produced??expected;
  };
  fixture.chain=[];fixture.initialOracle=fixture.composed;
  if(removal) await fsp.writeFile(path.join(fixture.project,'src/old.mjs'),'old source\n');
  let base=fixture.composed,origin=null,admission=null,witness=null,lastApply=null,lastWork=work(1,'file');
  let baseline=source.MANIFEST_0;
  for(let n=1;n<=cycles+1;n+=1) {
    const final=n===cycles+1,status=final && pass?'PASS':'NEEDS_FIX';
    const formalOwner=owner('VALIDATE_SLICE',100+n);
    const asked=formal.request({baseBytes:base.bytes,counters:base.counters,owner:formalOwner,authority,
      openFindings:n===1?[]:[formal.finding(1,1)],priorScopePaths:n===1?['src/pay.mjs']:scope,scopePaths:scope});
    if(n>1) {
      asked.format='stnl-current-validation-request-v2';
      asked.base.auxiliary={kind:'findings',operationAttemptId:lastApply.origin.operationAttemptId,
        cycle:`attempt-${String(n-1).padStart(2,'0')}`,firstCheckId:lastApply.id,lastCheckId:lastApply.id,
        recordsSha256:raw(json([lastApply]))};
    }
    const cap=adaptCapture(fixture,source,formal.capture({transport,request:asked,approvedAuthority:authority,work:lastWork,
      status,newFindings:n===1?[formal.finding(1,1)]:[],findingReferences:'finding-01',
      findingDispositions:`finding-01=${status==='PASS'?'resolved':'active'}`}).cap);
    receiptScope(cap,lastWork);
    const record=oracle.authoredFormal(cap,authority);
    const support=[...(witness && n>2?[witness]:[]),...(origin?[origin]:[]),...(admission && admission!==origin?[admission]:[])];
    const expected=authoredBundleFor(oracle,{implementation:n===1?base.bundle.implementation:[],
      findingsChecks:n===1?[]:[lastApply],validation:record,openFindings:status==='PASS'?[]:[formal.finding(1,1)],
      support,objects:base.bundle.objects,captures:[cap],authority,counters:counters(n-1,n)});
    const produced=kernel?.composeCurrentValidationEvidence({context,authority,owner:formalOwner,
      previous:{bundleBytes:base.bytes,counters:base.counters},capture:cap});
    base=accept(expected,produced,`formal-${n}`);advance('VALIDATE_SLICE',formalOwner);
    if(n===1) {origin=record;fixture.firstFormal=base;}
    fixture.finalCapture=cap;
    if(final) break;
    admission=record;
    const applyOwner=owner('APPLY_FINDINGS',300+n),after=work(2);
    let apply=adaptCapture(fixture,source,oracle.applyCapture({base,owner:applyOwner,transport,before:lastWork,after}).cap);
    const request=oracle.decode(apply.applyRequest);
    request.authority=structuredClone(authority);request.base.priorScopePaths=scope;request.scopePaths=scope;
    apply.applyRequest=json(request);
    const response=oracle.decode(apply.rawResponse);response.requestSha256=raw(apply.applyRequest);
    oracle.rebindRaw(apply,response);
    if(removal && n===1) apply.removalProofs=[json({format:'stnl-current-removal-proof-v1',owner:applyOwner,round:1,
      path:'src/old.mjs',sha256:raw(encoded('old source\n')),mode:420,bytesBase64:encoded('old source\n').toString('base64')})];
    if(transport==='managed') {
      oracle.closeManaged([apply]);apply=adaptCapture(fixture,source,apply);
    }
    receiptScope(apply,after);
    lastApply=oracle.authoredCheck(apply,`findings-check-${String(n).padStart(2,'0')}`,
      oracle.findingsGolden(apply,{corrections:n===1?(removal?['../../../../src/old.mjs','../../../../src/pay.mjs']:['../../../../src/pay.mjs']):[]}),authority);
    const applySupport=[...(witness?[witness]:[]),...(n>1?[origin]:[])];
    const expectedApply=authoredBundleFor(oracle,{findingsChecks:[lastApply],validation:admission,openFindings:[formal.finding(1,1)],
      support:applySupport,objects:base.bundle.objects,captures:[apply],authority,counters:counters(n,n)});
    const producedApply=kernel?.composeCurrentFindingsEvidence({context,authority,owner:applyOwner,
      previous:{bundleBytes:base.bytes,counters:base.counters},rounds:[apply]});
    base=accept(expectedApply,producedApply,`apply-${n}`);
    if(removal && n===1) witness=lastApply;
    baseline=lastWork;lastWork=after;advance('APPLY_FINDINGS',applyOwner);
  }
  await fsp.writeFile(path.join(fixture.project,'src/pay.mjs'),'pay-v2\n');
  if(removal) await fsp.rm(path.join(fixture.project,'src/old.mjs'));
  const current=fixture.continuity.deliveries[0],bundle=base.bundle;
  current.baseline=baseline;current.counters=base.counters;current.validation=pass?'current':'revalidation-required';
  current.evidence={path:`evidence/${DELIVERY_IDS[0]}.json`,sha256:raw(base.bytes)};
  fixture.files.set(current.evidence.path,Buffer.from(base.bytes));
  editSection(fixture,'slice-01','Implementation Test Evidence','- none');
  editSection(fixture,'slice-01','Findings Test Evidence',lastApply.recordUtf8);
  editSection(fixture,'slice-01','Validation Attempts',[...bundle.support.filter(item=>item.kind==='validation'),bundle.validation].map(item=>item.recordUtf8).join('\n\n'));
  editSection(fixture,'slice-01','Validation Findings','### finding-01\n- Severity: blocking\n- State: '+(pass?'resolved':'active')
    +'\n- Origin: attempt-01\n- Problem: finding-01 pay behavior differs from AC-001\n- Evidence: finding-01 observed command output\n'
    +'- Impact: finding-01 acceptance is affected\n- Related authority: AC-001\n- Expected correction: finding-01 correct pay behavior'
    +(pass?`\n- Resolution: attempt-${String(cycles+1).padStart(2,'0')} confirmed correction`:''));
  const delta=cycles===1?(removal?'- `../../../../src/old.mjs`\n- `../../../../src/pay.mjs`':'- `../../../../src/pay.mjs`'):'- none';
  editSection(fixture,'slice-01','Changed Areas',delta);editSection(fixture,'slice-01','Corrections Applied',delta);
  editSection(fixture,'slice-01','Continuity',`- Current validation: ${current.validation}\n- Current evidence: ${current.evidence.path}\n- Current action: Read the retained formal decision.`);
  if(pass) {
    editSection(fixture,'slice-01','Effective Validation Base',`- Origin attempt: attempt-${String(cycles+1).padStart(2,'0')}\n- Attempt type: revalidation\n- HEAD: 0123456789abcdef\n- Result: PASS\n- Files:\n${removal?'  - `../../../../src/old.mjs` | REMOVED\n':''}  - \`../../../../src/pay.mjs\` | ${raw(encoded('pay-v2\n'))}\n- Authoritative commands:\n  - \`node src/pay.mjs\` | exit:0\n- Evidence summary: Direct recipe observation and file hash.`);
    editSection(fixture,'slice-01','Final Result','- PASS');
  }
  fixture.files.set('tasks.md',encoded(fixture.files.get('tasks.md').toString('utf8').replace(
    '| [ ] | 01 - Foundation | Pay command executes. | - | tasks/slice-01.md | pending | pending |',
    `| ${pass?'[x]':'[ ]'} | 01 - Foundation | Pay command executes. | - | tasks/slice-01.md | ${pass?'PASS':'NEEDS_FIX'} | ${pass?'PASS':'pending'} |`)));
  if(retainSecond) fixture.continuity.deliveries[1].baseline=structuredClone(lastWork);
  fixture.authored=base;fixture.work=lastWork;
  reseal(fixture);await writeImage(fixture);return fixture;
}

// Repack only retained roots after a deliberate semantic mutation. No runtime
// packer, restorer or parser is used to manufacture a mutant's expected result.
export function repackBundle(bundle) {
  const roots=[...bundle.implementation,...bundle.findingsChecks,...bundle.support,...(bundle.validation?[bundle.validation]:[])];
  const required=new Set(roots.flatMap(item=>Object.entries(item.sources).flatMap(([name,value])=>
    name==='transport' || value===null?[]:Array.isArray(value)?value:[value])));
  bundle.objects=bundle.objects.filter(item=>required.has(item.id)).sort((a,b)=>sort(a.id,b.id));
  return bundle;
}
export function replaceRecordCapture(bundle,record,cap,oracle) {
  const packed=oracle.authoredSources(cap);
  record.sources=packed.sources;
  const pool=new Map([...bundle.objects,...packed.objects].map(item=>[item.id,item]));
  bundle.objects=[...pool.values()];repackBundle(bundle);
}
export async function storeBundle(fixture,bundle) {
  const bytes=json(bundle),name=`evidence/${DELIVERY_IDS[0]}.json`;
  fixture.files.set(name,bytes);fixture.continuity.deliveries[0].evidence.sha256=raw(bytes);
  reseal(fixture);await writeImage(fixture);
}

export async function authoredCompletedImage({pass=true,secondIndependent=false}={}) {
  const f=await authoredCyclesImage({retainSecond:true,pass,secondIndependent});
  const done=f.continuity.deliveries.shift();
  if(!pass) done.validation='current';
  f.continuity.completed=[done];
  const snapshot=f.snapshot,projection=snapshot.normativeProjection;
  snapshot.preparationRevision=2;f.activation.preparationRevision=2;
  f.activation.previousActivationId=f.activation.activationId;
  f.activation.activationId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  f.activation.sequence+=1;f.activation.lastAttempt=null;
  const leaf=projection.deliveries.shift();
  projection.completed=[leaf];projection.global.order=projection.deliveries.map(item=>item.deliveryId);
  snapshot.deliveries.shift();snapshot.completed=[{slice:done.slice,deliveryId:done.deliveryId,
    localRevision:1,evidenceSha256:done.evidence.sha256}];
  for(const name of ['plans/slice-01.md','tasks/slice-01.md']) {
    f.files.delete(name);f.artifacts.delete(name);await fsp.rm(path.join(f.execution,name));
  }
  for(const name of ['plan.md','tasks.md']) {
    const text=f.artifacts.get(name).toString('utf8').replace(/^\|.*01 - Foundation.*\n/gmu,'');
    f.artifacts.set(name,encoded(text));f.files.set(name,encoded(text));
  }
  snapshot.reviewedArtifacts=[...f.artifacts].map(([name,bytes])=>({path:name,sha256:raw(bytes),utf8:bytes.toString('utf8')}))
    .sort((a,b)=>sort(a.path,b.path));
  snapshot.globalReview.examinedArtifactHashes=['plan.md','tasks.md'].map(name=>({path:name,sha256:raw(f.artifacts.get(name))}));
  snapshot.globalReview.authoritySha256=projected('global-review',canonical({requirementsAuthority:f.authority,
    global:projection.global,deliveryIds:projection.global.order,completed:projection.completed}));
  snapshot.globalReview.evidenceDecisions=[{deliveryId:done.deliveryId,
    evidenceSha256:done.evidence.sha256,disposition:'retain-current',
    reason:'Reviewed unchanged local delivery and current formal proof.'}];
  snapshot.normativeSha256=projected('preparation',canonical(projection));
  f.activation.normativeSha256=snapshot.normativeSha256;
  f.files.set('approved-preparation.json',json(snapshot));
  reseal(f);await writeImage(f);return f;
}

// A and B have independent product directories and share only an approved input.
// Captures and records are authored with the builtin-only oracle, not the reader.
export async function authoredCompletedWithActiveProof({formal=true,historicalShaOverride=null}={}) {
  const f=await authoredCompletedImage({secondIndependent:true});
  const source=await import('./current-initial-evidence.mjs');
  const templates=await import('./current-validation-evidence.mjs');
  const oracle=await import('./current-findings-evidence.mjs');
  const leaf=f.snapshot.normativeProjection.deliveries[0];
  const replace=value=>value.replaceAll('src/pay.mjs','verify/check.mjs').replaceAll('../../../../src','../../../../verify')
    .replaceAll('"path":"src"','"path":"verify"').replaceAll('"pay.mjs"','"check.mjs"');
  const recipe=JSON.parse(replace(JSON.stringify(source.RECIPE)));
  Object.assign(leaf,{authorizedAreas:'- directory: `../../../../verify`',
    existingInputs:source.DELIVERY.existingInputs,expectedTests:'- node verify/check.mjs',verificationRecipe:recipe});
  for(const name of ['plans/slice-02.md','tasks/slice-02.md']) {
    let text=f.artifacts.get(name).toString('utf8');
    for(const [heading,body] of [['Authorized Areas',leaf.authorizedAreas],['Existing Inputs',leaf.existingInputs],
      ['Expected Tests',leaf.expectedTests],['Verification Recipe',`- Recipe: ${JSON.stringify(recipe)}`],
      ['Expected Files','- `../../../../verify/check.mjs`']]) text=section(text,heading,body);
    f.artifacts.set(name,encoded(text));f.files.set(name,encoded(text));
  }
  const plan=f.artifacts.get('plan.md').toString('utf8').replace('directory: `../../../src`','directory: `../../../verify`');
  f.artifacts.set('plan.md',encoded(plan));f.files.set('plan.md',encoded(plan));
  const projection=f.snapshot.normativeProjection;
  const historical={...structuredClone(projection),global:{...projection.global,order:DELIVERY_IDS},
    deliveries:[projection.completed[0],leaf],completed:[]};
  const historicalSha=historicalShaOverride??projected('preparation',canonical(historical));
  const authority={preparationRevision:1,localRevision:1,normativeSha256:historicalSha,
    delivery:structuredClone(leaf),context:{requirementsAuthority:f.authority,
      objective:projection.global.objective,strategy:projection.global.strategy,risks:projection.global.risks}};
  const adapt=cap=>{
    const text=bytes=>encoded(replace(Buffer.from(bytes).toString('utf8'))
      .replaceAll('/workspace',f.project).replaceAll('/tmp/pay-candidate',f.execution)
      .replaceAll('slice-01','slice-02').replaceAll(source.OWNER.deliveryId,DELIVERY_IDS[1])
      .replaceAll(source.OWNER.normativeSha256,historicalSha)
      .replaceAll(source.AUTHORITY.context.requirementsAuthority,f.authority)
      .replaceAll(source.OWNER.operationAttemptId,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      .replaceAll(source.OWNER.ownershipToken,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
    const out=Object.fromEntries(Object.entries(cap).map(([name,value])=>[name,
      value instanceof Uint8Array?text(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?text(item):item):value]));
    const observed=oracle.decode(out.verificationObservation);
    observed.resolved.recipeSha256=raw(encoded(canonical(recipe)));
    out.verificationObservation=json(observed);
    const origin=oracle.decode(out.origin);origin.verification=observed.resolved;
    out.origin=json(origin);out.dispatch=json(origin);
    const receipt=oracle.decode(out.receipt);receipt.verification=observed;
    out.receipt=json(receipt);
    templates.rebindRaw(out,oracle.decode(out.rawResponse));
    return out;
  };
  const initial=adapt(source.nativeRound());
  const check=oracle.authoredCheck(initial,'implementation-check-01',oracle.initialGolden(initial),authority);
  const first=authoredBundleFor(oracle,{implementation:[check],captures:[initial],authority,
    counters:{implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0}});
  first.bundle.slice='slice-02';first.bundle.logicalTaskPath='tasks/slice-02.md';first.bytes=json(first.bundle);
  const owner={...templates.validationOwner(701),deliveryId:DELIVERY_IDS[1],slice:'slice-02',
    normativeSha256:historicalSha};
  const work=oracle.decode(initial.verificationObservation).after;
  const request=templates.request({baseBytes:first.bytes,counters:first.counters,owner,authority,
    scopePaths:['verify/check.mjs'],priorScopePaths:['verify/check.mjs']});
  const capture=adapt(templates.capture({request,approvedAuthority:authority,work,
    command:'node verify/check.mjs',resolved:oracle.decode(initial.verificationObservation).resolved}).cap);
  const validation=oracle.authoredFormal(capture,authority);
  const result=authoredBundleFor(oracle,{implementation:[check],validation:formal?validation:null,
    captures:formal?[initial,capture]:[initial],authority,
    counters:{implementationChecks:1,findingsChecks:0,validationAttempts:formal?1:0,findings:0}});
  result.bundle.slice='slice-02';result.bundle.logicalTaskPath='tasks/slice-02.md';result.bytes=json(result.bundle);
  const current=f.continuity.deliveries[0];
  current.authoritySha256=projected('delivery',canonical(leaf));
  current.validation=formal?'current':'unvalidated';current.counters=result.counters;
  current.baseline=oracle.decode(initial.baselineCapture).manifest;
  current.evidence={path:`evidence/${DELIVERY_IDS[1]}.json`,sha256:raw(result.bytes)};
  f.files.set(current.evidence.path,result.bytes);
  editSection(f,'slice-02','Implementation Test Evidence',check.recordUtf8);
  editSection(f,'slice-02','Validation Attempts',formal?validation.recordUtf8:'- none');
  editSection(f,'slice-02','Changed Areas','- `../../../../verify/check.mjs`');
  editSection(f,'slice-02','Continuity',`- Current validation: ${current.validation}\n- Current evidence: ${current.evidence.path}\n- Current action: ${formal?'validation complete':'VALIDATE_SLICE'}`);
  if(formal) {
    editSection(f,'slice-02','Effective Validation Base',`- Origin attempt: attempt-01\n- Attempt type: initial\n- HEAD: 0123456789abcdef\n- Result: PASS\n- Files:\n  - \`../../../../verify/check.mjs\` | ${raw(encoded('pay-v1\n'))}\n- Authoritative commands:\n  - \`node verify/check.mjs\` | exit:0\n- Evidence summary: Direct recipe observation and file hash.`);
    editSection(f,'slice-02','Final Result','- PASS');
    f.files.set('tasks.md',encoded(f.files.get('tasks.md').toString('utf8')
      .replace('| [ ] | 02 - Verification |','| [x] | 02 - Verification |').replace('| pending | pending |','| PASS | PASS |')));
  }
  await fsp.mkdir(path.join(f.project,'verify'));
  await fsp.writeFile(path.join(f.project,'verify/check.mjs'),'pay-v1\n');
  const snapshot=f.snapshot;
  snapshot.reviewedArtifacts=[...f.artifacts].map(([name,bytes])=>({path:name,sha256:raw(bytes),utf8:bytes.toString('utf8')}))
    .sort((a,b)=>sort(a.path,b.path));
  snapshot.globalReview.examinedArtifactHashes=['plan.md','tasks.md'].map(name=>({path:name,sha256:raw(f.artifacts.get(name))}));
  snapshot.globalReview.authoritySha256=projected('global-review',canonical({requirementsAuthority:f.authority,
    global:projection.global,deliveryIds:projection.global.order,completed:projection.completed}));
  snapshot.globalReview.evidenceDecisions.push({deliveryId:current.deliveryId,evidenceSha256:current.evidence.sha256,
    disposition:'retain-current',reason:'Reviewed unchanged active local proof independently of A.'});
  const review=snapshot.deliveries[0].review;
  review.authoritySha256=current.authoritySha256;
  review.examinedArtifactHashes=['plans/slice-02.md','tasks/slice-02.md'].map(name=>({path:name,sha256:raw(f.artifacts.get(name))}));
  snapshot.normativeSha256=projected('preparation',canonical(projection));
  f.activation.normativeSha256=snapshot.normativeSha256;
  f.files.set('approved-preparation.json',json(snapshot));
  f.activeProof={initial,capture,authority,adapt,first,work};
  reseal(f);await writeImage(f);return f;
}

export async function storeRetainedActiveBundle(f,bundle) {
  const current=f.continuity.deliveries[0],bytes=json(bundle);
  f.files.set(current.evidence.path,bytes);current.evidence.sha256=raw(bytes);
  f.snapshot.globalReview.evidenceDecisions.find(item=>item.deliveryId===current.deliveryId).evidenceSha256=raw(bytes);
  f.files.set('approved-preparation.json',json(f.snapshot));
  reseal(f);await writeImage(f);
}

export async function cleanup(fixture) {await fsp.rm(fixture.temporary,{recursive:true,force:true});}

// Worker protocol is intentionally separate from the authored builder. It is
// entered only by a child process, before dynamically loading product code.
function installGuard(specPath,logPath,allowedRoot,mode='reader') {
  const projectRoot=path.resolve(allowedRoot);
  const lifecycle=path.extname(specPath)!=='.md' || path.basename(specPath)==='feature_spec.md';
  const specRoot=lifecycle && path.extname(specPath)!=='.md'?specPath:path.dirname(specPath);
  const officialExecution=lifecycle?path.join(specRoot,'execution')
    :path.join(specRoot,`${path.basename(specPath,'.md')}-execution`);
  const exact=new Set();
  for (const root of [projectRoot,specRoot,officialExecution,path.join(projectRoot,'src'),repo]) {
    let current=root;
    while (!exact.has(current)) {exact.add(current);const parent=path.dirname(current);if(parent===current) break;current=parent;}
  }
  const runtimeNames=['execution-current-reader.mjs','execution-workspace.mjs','execution-state.mjs',
    'execution-publication.mjs','runner-result-contract.mjs','execution-current.mjs',
    'execution-preparation-current.mjs','current-evidence-state.mjs','execution-evidence-current.mjs','execution-evidence-proof.mjs'];
  const runtimeFiles=new Set(['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor','stnl-slice-quality-manager','stnl-spec-roadmap','stnl-spec-test-runbook'].flatMap(skill=>runtimeNames
    .map(name=>path.join(repo,'skills/workflows',skill,'runtime',name))));
  if(process.env.STNL_QUIET_IMPORT_WRAPPER==='1') runtimeFiles.add(path.resolve(process.argv[1]));
  const subtrees=[path.join(projectRoot,'src'),path.join(specRoot,'shared')];
  if(process.env.STNL_QUIET_ACTIVE_PROOF==='1') subtrees.push(path.join(projectRoot,'verify'));
  // Independent fixture profiles declare the input itself, never its subtree.
  const config=path.join(projectRoot,'config');
  const inputFiles=new Set(process.env.STNL_QUIET_PROFILE==='evidence'?[path.join(config,'settings.json')]:[]);
  const directoryQueries=new Set(['promises.lstat','promises.readdir']);
  const documents=new Set([specPath,path.join(specRoot,'feature_spec.md'),path.join(specRoot,'requirements.md')]);
  const officialFiles=new Set(['activation.json','approved-preparation.json','continuity.json','plan.md','tasks.md']
    .map(name=>path.join(officialExecution,name)));
  const officialDirs=new Set(['plans','tasks','evidence'].map(name=>path.join(officialExecution,name)));
  if(process.env.STNL_CANDIDATE) {
    const candidate=path.resolve(process.env.STNL_CANDIDATE);
    let ancestor=candidate;
    while(!exact.has(ancestor)) {exact.add(ancestor);const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
    for(const name of ['activation.json','approved-preparation.json','continuity.json']) officialFiles.add(path.join(candidate,name));
  }
  const gitMarkers=new Set([...exact].map(name=>path.join(name,'.git')));
  const identityMarkers=new Set([...exact].flatMap(name=>['.copy.json','.publication.json','.owner.json'].map(suffix=>name+suffix)));
  const descriptors=new Map();
  const attempts=[],opens=new Map(),openAttempts=new Map(),barrierEvents=[];
  const originalOpen=fs.openSync,originalWrite=fs.writeSync,originalClose=fs.closeSync;
  const controlWrite=(file,bytes)=>{const fd=originalOpen(file,'w');try {originalWrite(fd,bytes);}finally {originalClose(fd);}};
  let barrierCount=0;
  const barrierTarget=process.env.STNL_BARRIER_TARGET;
  const barrierOrdinal=Number(process.env.STNL_BARRIER_OCCURRENCE??'2');
  const barrierToken=process.env.STNL_BARRIER_TOKEN;
  const pauseBeforeOpen=async(name,ordinal)=>{
    if(!barrierTarget || name!==barrierTarget || ordinal!==barrierOrdinal) return;
    if(!barrierToken || !process.connected || typeof process.send!=='function') throw new Error('barrier IPC unavailable');
    barrierEvents.push({phase:'READY',path:name,ordinal});
    await new Promise((resolve,reject)=>{
      const detach=()=>{process.off('message',receive);process.off('disconnect',disconnect);};
      const receive=message=>{
        if(!['GO','ABORT'].includes(message?.type) || message.token!==barrierToken
          || message.path!==name || message.ordinal!==ordinal) {
          detach();reject(new Error('barrier GO binding mismatch'));return;
        }
        detach();barrierEvents.push({phase:message.type,path:name,ordinal});
        if(message.type==='ABORT') reject(new Error('barrier ABORT before GO'));
        else resolve();
      };
      const disconnect=()=>{detach();reject(new Error('barrier IPC disconnected before GO'));};
      process.on('message',receive);process.once('disconnect',disconnect);
      process.send({type:'READY',token:barrierToken,path:name,ordinal},error=>{if(error){detach();reject(error);}});
    });
  };
  const check=(method,target,mutation=false)=>{
    if(Buffer.isBuffer(target)) target=target.toString('utf8');
    if(typeof target==='number') target=descriptors.get(target)??`unknown-descriptor-${target}`;
    if (typeof target!=='string' && !(target instanceof URL)) {
      attempts.push({method,path:'unrecognized target'});throw Object.assign(new Error('guard target is not a path'),{code:'GUARD_DENIED'});
    }
    const name=path.resolve(target instanceof URL?fileURLToPath(target):target);
    const relative=path.relative(officialExecution,name).split(path.sep).join('/');
    const officialArtifact=/^(?:(?:plans|tasks)\/slice-[0-9]{2,}\.md|evidence\/[a-f0-9-]{36}\.json)$/u.test(relative);
    const metadataOnly=method==='promises.lstat' && (gitMarkers.has(name) || identityMarkers.has(name));
    const inputParent=inputFiles.size>0 && name===config && directoryQueries.has(method);
    const permitted=!mutation && (runtimeFiles.has(name) || (exact.has(name) || documents.has(name)
      || inputFiles.has(name) || inputParent
      || officialFiles.has(name) || officialDirs.has(name) || officialArtifact || metadataOnly
      || subtrees.some(root=>name===root || name.startsWith(root+path.sep))));
    if (!permitted) {attempts.push({method,path:name});throw Object.assign(new Error(`guard denied ${method}: ${name}`),{code:'GUARD_DENIED'});}
  };
  const originals=[];
  for (const method of ['access','lstat','stat','realpath','readdir','readFile','open','opendir','readlink','writeFile','appendFile','mkdir','rm','rmdir','unlink','rename','copyFile','cp','chmod','chown','link','symlink','truncate','utimes','createReadStream','createWriteStream','exists']) {
    if (typeof fsp[method]==='function') {
      const original=fsp[method];originals.push([fsp,method,original]);
      fsp[method]=function(...args) {check(`promises.${method}`,args[0],/^(?:write|append|mkdir|rm|rmdir|unlink|rename|copy|cp|chmod|chown|link|symlink|truncate|utimes|createWriteStream)/u.test(method));
        if (method==='open' && (typeof args[1]==='string' && /[wax+]/u.test(args[1])
          || typeof args[1]==='number' && (args[1] & (fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC))))
          check('promises.open.write',args[0],true);
        if(method==='readFile' && args[1]?.flag && /[wax+]/u.test(String(args[1].flag))) check('promises.readFile.write',args[0],true);
        if (method!=='open') return original.apply(this,args);
        const name=path.resolve(args[0] instanceof URL?fileURLToPath(args[0]):args[0]);
        const ordinal=(openAttempts.get(name)??0)+1;openAttempts.set(name,ordinal);
        return (async()=>{
          if(name===barrierTarget) await pauseBeforeOpen(name,++barrierCount);
          if(name===barrierTarget && ordinal===barrierOrdinal) barrierEvents.push({phase:'OPEN_START',path:name,ordinal});
          let handle;
          try {handle=await original.apply(this,args);}
          catch(error) {
            if(name===barrierTarget && ordinal===barrierOrdinal)
              barrierEvents.push({phase:'OPEN_ERROR',path:name,ordinal,code:error?.code??null});
            throw error;
          }
          opens.set(name,(opens.get(name)??0)+1);
          if(name===barrierTarget && ordinal===barrierOrdinal) barrierEvents.push({phase:'OPEN_COMPLETE',path:name,ordinal});
          descriptors.set(handle.fd,args[0]);
          for (const action of ['write','writev','writeFile','appendFile','truncate','chmod','chown','sync','datasync','utimes','createWriteStream']) {
            if (typeof handle[action]!=='function') continue;
            const wrapped=handle[action].bind(handle);
            handle[action]=function(...inner) {check(`FileHandle.${action}`,args[0],true);return wrapped(...inner);};
          }
          return handle;
        })();};
    }
    for (const suffix of ['Sync','']) {
      const name=method+suffix;
      if (typeof fs[name]!=='function') continue;
      const original=fs[name];originals.push([fs,name,original]);
      fs[name]=function(...args) {check(`fs.${name}`,args[0],/^(?:write|append|mkdir|rm|rmdir|unlink|rename|copy|cp|chmod|chown|link|symlink|truncate|utimes|createWriteStream)/u.test(method));
        const optionFlag=method==='readFile'?args[1]?.flag:method==='createReadStream'?args[1]?.flags:null;
        if(optionFlag && (typeof optionFlag==='string' && /[wax+]/u.test(optionFlag)
          || typeof optionFlag==='number' && optionFlag & (fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC)))
          check(`fs.${name}.write`,args[0],true);
        if(method==='open') {
          if(typeof args[1]==='string' && /[wax+]/u.test(args[1]) || typeof args[1]==='number'
            && (args[1] & (fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC)))
            check(`fs.${name}.write`,args[0],true);
          if(suffix==='Sync') {const fd=original.apply(this,args);descriptors.set(fd,args[0]);return fd;}
          const callback=args.at(-1);
          args[args.length-1]=(error,fd)=>{if(!error) descriptors.set(fd,args[0]);callback(error,fd);};
        }
        return original.apply(this,args);};
    }
  }
  for(const method of ['read','readv','fstat','write','writev','ftruncate','fchmod','fchown','futimes','fsync','fdatasync'])
    for(const suffix of ['','Sync']) {
      const name=method+suffix,original=fs[name];if(typeof original!=='function') continue;
      originals.push([fs,name,original]);fs[name]=function(...args) {
        check(`fs.${name}`,args[0],!['read','readv','fstat'].includes(method));return original.apply(this,args);
      };
    }
  for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
    const original=childProcess[method];originals.push([childProcess,method,original]);
    childProcess[method]=function(...args) {attempts.push({method:`child_process.${method}`,path:String(args[0])});
      throw Object.assign(new Error(`guard denied child_process.${method}`),{code:'GUARD_DENIED'});};
  }
  syncBuiltinESMExports();
  const save=(result=null)=>controlWrite(logPath,json({attempts,opens:Object.fromEntries(opens),
    openAttempts:Object.fromEntries(openAttempts),barrierEvents,result}));
  const restore=()=>{for (const [target,name,original] of originals) target[name]=original;syncBuiltinESMExports();};
  return {attempts,save,restore};
}

if (process.env.STNL_QUIET_PRELOAD==='1') {
  const guard=installGuard(process.argv[2],process.env.STNL_QUIET_LOG,process.env.STNL_QUIET_PROJECT);
  process.on('exit',()=>guard.save());
}

if (process.argv[1] && path.resolve(process.argv[1])===modulePath && process.argv[2]==='--worker') {
  const [,,,mode,reader,specPath,logPath,allowedRoot]=process.argv;
  const guard=installGuard(specPath,logPath,allowedRoot,mode);
  let result;
  try {
    if (mode==='selftest') {
      const officialPath=path.extname(specPath)==='.md'?specPath:path.join(specPath,'feature_spec.md');
      const canary=path.join(allowedRoot,'tmp','historic','receipt.json');
      const promiseNamespace=await import('node:fs/promises');
      for (const action of [()=>fs.existsSync(canary),()=>fs.readFileSync(canary),()=>fs.statSync(canary),
        ()=>fs.realpathSync(canary),()=>fs.readdirSync(path.dirname(canary)),
        ()=>fs.stat(canary,()=>{}),()=>fsp.lstat(canary),()=>fsp.access(canary),
        ()=>fsp.realpath(canary),()=>fsp.readdir(path.dirname(canary)),()=>fsp.opendir(path.dirname(canary)),
        ()=>fsp.open(canary,'r'),()=>fs.openSync(canary,'r'),()=>fs.createReadStream(canary),
        ()=>fs.createWriteStream(canary),()=>fsp.writeFile(canary,'bad'),
        ()=>childProcess.spawnSync(process.execPath,['--version'])]) {
        try {await action();} catch {}
      }
      try {await promiseNamespace.stat(canary);} catch {}
      for(const name of ['receipt.json','absent.json']) {
        const outsideInput=path.join(allowedRoot,'config/history',name);
        for(const action of [()=>fs.readFileSync(outsideInput),()=>fsp.lstat(outsideInput),
          ()=>promiseNamespace.stat(outsideInput),()=>fsp.open(outsideInput,'r')]) {
          try {const handle=await action();if(handle?.close)await handle.close();} catch {}
        }
      }
      try {await fsp.readFile(path.join(allowedRoot,'config'));} catch {}
      const input=await fsp.readFile(path.join(allowedRoot,'config/settings.json'),'utf8');
      if(input!=='settings=local\n') throw new Error('approved input control differs');
      await fsp.lstat(path.join(allowedRoot,'config'));
      if(!(await fsp.readdir(path.join(allowedRoot,'config'))).includes('settings.json')) throw new Error('input inventory control differs');
      try {fs.openSync(officialPath,'w');} catch {}
      const descriptor=fs.openSync(officialPath,'r');
      try {try {fs.writeSync(descriptor,Buffer.from('bad'));} catch {}} finally {fs.closeSync(descriptor);}
      const official=await fsp.readFile(officialPath);
      if (!official.length) throw new Error('official document control was empty');
      try {const handle=await fsp.open(officialPath,'r');try {await handle.writeFile('bad');}catch {}finally {await handle.close();}}catch {}
      result={selftest:true};
    } else if(mode==='canary-caught') {
      try {await fsp.lstat(path.join(allowedRoot,'tmp/historic/receipt.json'));} catch {}
      result={caught:true};
    } else {
      const api=await import(pathToFileURL(reader).href);
      result=await api.inspectCurrentExecution(specPath);
    }
  } catch(error) {result={error:{code:error?.code??null,message:error?.message??String(error)}};}
  guard.restore();guard.save(result);
  if(process.connected) process.disconnect();
}
