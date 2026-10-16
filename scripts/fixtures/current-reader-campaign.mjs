import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {authoredCompletedWithActiveProof,authoredCompletedImage,authoredCyclesImage,canonical,raw,editSection,reseal,writeImage,
  storeRetainedActiveBundle} from './current-quiet-reader.mjs';
import * as source from './current-initial-evidence.mjs';
import * as formal from './current-validation-evidence.mjs';
import * as oracle from './current-findings-evidence.mjs';
import {composeInitialImplementationEvidence} from '../../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs';
import {composeCurrentValidationEvidence,composeCurrentFindingsEvidence} from '../../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';

const json=value=>Buffer.from(canonical(value)+'\n');
const projected=(tag,value)=>raw(Buffer.concat([Buffer.from(`stnl-ec1/${tag}/v1\0`),Buffer.from(canonical(value))]));
const uuid=n=>`${String(n).padStart(8,'0')}-7777-4777-8777-${String(n).padStart(12,'0')}`;
const proofRecords=b=>[...b.implementation,...b.findingsChecks,...b.support,...(b.validation?[b.validation]:[])];

export async function campaignImage({kind='PASS',rounds=1,historicalMismatch=false}={}) {
  const f=await authoredCompletedWithActiveProof({formal:false,
    historicalShaOverride:historicalMismatch?'sha256:'+sourceDigest(Buffer.from('different original set')):null});
  const {authority,adapt}=f.activeProof,current=f.continuity.deliveries[0];
  const context={logicalSpecRoot:f.spec,logicalAuthorityPath:f.source,logicalExecutionRoot:f.execution,
    physicalExecutionRoot:f.execution,productRoot:f.project};
  const owner=(operation,n)=>({...source.OWNER,operation,operationAttemptId:uuid(n),ownershipToken:uuid(n+1000),
    deliveryId:current.deliveryId,slice:current.slice,normativeSha256:authority.normativeSha256});
  const scope=['verify/check.mjs'];
  let baseline=oracle.decode(f.activeProof.initial.baselineCapture).manifest;
  let work=oracle.decode(f.activeProof.initial.verificationObservation).after;
  const initialRounds=[];
  const initialCount=kind.startsWith('APPLY')?1:rounds;
  for(let n=1;n<=initialCount;n++) {
    const status=kind==='FAIL3'||n<initialCount?'TESTS_FAIL':'TESTS_PASS';
    const cap=adapt(source.nativeRound(n,status,status==='TESTS_FAIL'?1:0));
    if(kind==='INITIAL_REFUSAL' && n===rounds) {
      const response=oracle.decode(cap.rawResponse);response.status='TESTS_NOT_APPLICABLE';
      formal.rebindRaw(cap,response);const receipt=oracle.decode(cap.receipt);
      receipt.semanticResponseStatus=response.status;cap.receipt=json(receipt);
    }
    initialRounds.push(cap);
  }
  let base=composeInitialImplementationEvidence({context,authority,
    owner:oracle.decode(initialRounds[0].origin).owner,currentEvidence:null,
    counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},rounds:initialRounds});
  work=oracle.decode(initialRounds.at(-1).verificationObservation).after;
  let captures=initialRounds,normalization=null,diagnostic=null;
  const validate=({status='PASS',rejected=false,afterApply=false,number=1}={})=>{
    const validationOwner=owner('VALIDATE_SLICE',800+number);
    const request=formal.request({baseBytes:base.bytes,counters:base.counters,authority,owner:validationOwner,
      openFindings:base.bundle.openFindings,scopePaths:scope,priorScopePaths:scope});
    if(afterApply) {
      request.format='stnl-current-validation-request-v2';const checks=base.bundle.findingsChecks;
      request.base.auxiliary={kind:'findings',operationAttemptId:checks[0].origin.operationAttemptId,
        cycle:'attempt-01',firstCheckId:checks[0].id,lastCheckId:checks.at(-1).id,recordsSha256:raw(json(checks))};
    }
    const created=status==='NEEDS_FIX'?[formal.finding(1,1)]:[];
    const cap=adapt(formal.capture({request,approvedAuthority:authority,work,status,newFindings:created,
      findingReferences:created.length||afterApply?'finding-01':'none',
      findingDispositions:created.length?'finding-01=active':afterApply?'finding-01=resolved':'none',
      command:'node verify/check.mjs',resolved:oracle.decode(initialRounds[0].verificationObservation).resolved}).cap);
    if(rejected) {
      const response=oracle.decode(cap.rawResponse);response.result.status='TESTS_NOT_APPLICABLE';
      formal.rebindRaw(cap,response);const receipt=oracle.decode(cap.receipt);
      receipt.semanticResponseStatus=response.result.status;cap.receipt=json(receipt);
    }
    base=composeCurrentValidationEvidence({context,authority,owner:validationOwner,
      previous:{bundleBytes:base.bytes,counters:base.counters},capture:cap});captures.push(cap);
  };
  if(!['AUXILIARY','FAIL3','INITIAL_REFUSAL'].includes(kind)) {
    validate({status:kind.startsWith('APPLY')||kind==='NEEDS_FIX'?'NEEDS_FIX':kind==='BLOCKED'?'BLOCKED':'PASS',
      rejected:kind==='FORMAL_REFUSAL'});
  }
  if(kind.startsWith('APPLY')) {
    const previous=base,applyOwner=owner('APPLY_FINDINGS',900),caps=[];
    for(let n=1;n<=rounds;n++) {
      const status=kind==='APPLY_FAIL3'||n<rounds?'TESTS_FAIL':kind==='APPLY_BLOCKED'?'BLOCKED':'TESTS_PASS';
      let cap=adapt(oracle.applyCapture({base:previous,owner:applyOwner,round:n,previousCheck:caps.length?
        {id:`findings-check-${String(n-1).padStart(2,'0')}`,roundCaptureSha256:oracle.roundLink(caps.at(-1))}:null,
        status,exit:status==='TESTS_FAIL'?1:0,before:source.manifest(n===1?1:2),after:source.manifest(2)}).cap);
      const request=oracle.decode(cap.applyRequest);request.authority=structuredClone(authority);
      cap.applyRequest=json(request);const response=oracle.decode(cap.rawResponse);response.requestSha256=raw(cap.applyRequest);
      if(kind==='APPLY_REFUSAL' && n===rounds) response.result.status='TESTS_NOT_APPLICABLE';
      formal.rebindRaw(cap,response);const receipt=oracle.decode(cap.receipt);receipt.semanticResponseStatus=response.result.status;
      cap.receipt=json(receipt);caps.push(cap);
    }
    base=composeCurrentFindingsEvidence({context,authority,owner:applyOwner,
      previous:{bundleBytes:previous.bytes,counters:previous.counters},rounds:caps});captures.push(...caps);
    baseline=oracle.decode(caps[0].baselineCapture).manifest;
    work=oracle.decode(caps.at(-1).verificationObservation).after;
    if(kind==='APPLY_REFUSAL'&&rounds===1) {
      const rejection=base.bundle.support.at(-1);
      normalization={episodeId:applyOwner.operationAttemptId,operation:'APPLY_FINDINGS',causeSha256:raw(base.bytes),
        sourceOperationAttemptId:applyOwner.operationAttemptId,used:1,consumedInvocations:1,round:1,status:'exhausted'};
      diagnostic={code:'RUNNER_RESULT_REJECTED',operationAttemptId:applyOwner.operationAttemptId,
        reason:rejection.diagnostic,affectedPaths:scope,nextAction:'stop'};
    }
    if(kind==='APPLY_PASS') validate({afterApply:true,number:2});
  }
  const bundle=base.bundle,rejection=bundle.support.findLast(item=>item.kind==='rejection');
  const status=bundle.validation?oracle.decode(captures.findLast(cap=>cap.validationRequest)?.rawResponse).result.status:null;
  const isPass=status==='PASS'&&!rejection;
  current.validation=rejection?'uncertain':isPass?'current':bundle.validation?'revalidation-required':'unvalidated';
  current.baseline=baseline;current.counters=base.counters;
  if(kind==='INITIAL_REFUSAL') {
    normalization={episodeId:rejection.origin.operationAttemptId,operation:'EXECUTE_SLICE',causeSha256:raw(base.bytes),
      sourceOperationAttemptId:rejection.origin.operationAttemptId,used:1,consumedInvocations:rounds,round:1,status:'exhausted'};
    diagnostic={code:'RUNNER_RESULT_REJECTED',operationAttemptId:rejection.origin.operationAttemptId,
      reason:rejection.diagnostic,affectedPaths:[],nextAction:'stop'};
  }
  current.normalization=normalization;current.lastDiagnostic=diagnostic;
  const body=records=>records.map(item=>item.recordUtf8).join('\n\n')||'- none';
  editSection(f,current.slice,'Implementation Test Evidence',body(bundle.implementation));
  editSection(f,current.slice,'Findings Test Evidence',body(bundle.findingsChecks));
  editSection(f,current.slice,'Validation Attempts',body([...bundle.support.filter(item=>item.kind==='validation'),...(bundle.validation?[bundle.validation]:[])]));
  editSection(f,current.slice,'Changed Areas',kind==='INITIAL_REFUSAL'&&rounds===1?'- pending'
    :kind==='APPLY_REFUSAL'&&rounds===1?'- none':'- `../../../../verify/check.mjs`');
  editSection(f,current.slice,'Corrections Applied',kind.startsWith('APPLY')&&!(kind==='APPLY_REFUSAL'&&rounds===1)||rounds>1?'- `../../../../verify/check.mjs`':'- none');
  if(bundle.validation&&bundle.openFindings.length||kind==='APPLY_PASS') {
    editSection(f,current.slice,'Validation Findings','### finding-01\n- Severity: blocking\n- State: '+(isPass?'resolved':'active')
      +'\n- Origin: attempt-01\n- Problem: finding-01 pay behavior differs from AC-001\n- Evidence: finding-01 observed command output\n- Impact: finding-01 acceptance is affected\n- Related authority: AC-001\n- Expected correction: finding-01 correct pay behavior'
      +(isPass?'\n- Resolution: attempt-02 confirmed correction':''));
  }
  editSection(f,current.slice,'Final Result',isPass?'- PASS':'- pending');
  editSection(f,current.slice,'Continuity',`- Current validation: ${current.validation}\n- Current evidence: ${current.evidence.path}\n- Current action: Read the retained local decision.`);
  if(rejection) editSection(f,current.slice,'Delegation Blocker',`- Operation: ${rejection.origin.operation}\n- State: active`);
  if(isPass) editSection(f,current.slice,'Effective Validation Base',`- Origin attempt: ${bundle.validation.id}\n- Attempt type: ${bundle.validation.id==='attempt-01'?'initial':'revalidation'}\n- HEAD: 0123456789abcdef\n- Result: PASS\n- Files:\n  - \`../../../../verify/check.mjs\` | ${work.entries.find(item=>item.path==='verify/check.mjs').sha256}\n- Authoritative commands:\n  - \`node verify/check.mjs\` | exit:0\n- Evidence summary: Direct recipe observation and file hash.`);
  const rows=f.files.get('tasks.md').toString('utf8').replace(/(\| )\[ \]( \| 02 - Verification.*\| )pending \| pending \|/u,
    `$1${isPass?'[x]':'[ ]'}$2${status??'pending'} | ${isPass?'PASS':'pending'} |`);
  f.files.set('tasks.md',Buffer.from(rows));
  await fs.writeFile(path.join(f.project,'verify/check.mjs'),`pay-v${kind.startsWith('APPLY')?2:rounds}\n`);
  await storeRetainedActiveBundle(f,bundle);
  f.campaign={base,captures,records:proofRecords(bundle).map(item=>JSON.stringify(item))};return f;
}

export async function refreshCampaign(f) {
  const snapshot=f.snapshot,p=snapshot.normativeProjection;
  const all=[...f.continuity.deliveries,...f.continuity.completed];
  for(const current of all) {
    const leaf=[...p.deliveries,...p.completed].find(item=>item.deliveryId===current.deliveryId);
    current.authoritySha256=projected('delivery',leaf);
    if(current.evidence) {
      const bundle=JSON.parse(f.files.get(current.evidence.path));bundle.currentAuthoritySha256=current.authoritySha256;
      const bytes=json(bundle);f.files.set(current.evidence.path,bytes);current.evidence.sha256=raw(bytes);
    }
  }
  snapshot.completed=f.continuity.completed.map(item=>({slice:item.slice,deliveryId:item.deliveryId,localRevision:item.localRevision,evidenceSha256:item.evidence.sha256}));
  snapshot.reviewedArtifacts=[...f.artifacts].map(([name,bytes])=>({path:name,sha256:raw(bytes),utf8:bytes.toString('utf8')})).sort((a,b)=>a.path<b.path?-1:1);
  snapshot.globalReview.examinedArtifactHashes=['plan.md','tasks.md'].map(name=>({path:name,sha256:raw(f.artifacts.get(name))}));
  snapshot.globalReview.authoritySha256=projected('global-review',{requirementsAuthority:f.authority,global:p.global,deliveryIds:p.global.order,completed:p.completed});
  snapshot.globalReview.evidenceDecisions=all.filter(item=>item.evidence&&!snapshot.deliveries.find(value=>value.deliveryId===item.deliveryId)
    ?.review.evidenceDecisions.some(value=>value.deliveryId===item.deliveryId&&value.evidenceSha256===item.evidence.sha256)).map(item=>({deliveryId:item.deliveryId,evidenceSha256:item.evidence.sha256,
    disposition:'retain-current',reason:'Reviewed literal proof and ownership equivalence.'})).sort((a,b)=>a.deliveryId<b.deliveryId?-1:1);
  for(const item of snapshot.deliveries) {
    item.review.authoritySha256=all.find(value=>value.deliveryId===item.deliveryId).authoritySha256;
    item.review.examinedArtifactHashes=[`plans/${item.slice}.md`,`tasks/${item.slice}.md`].map(name=>({path:name,sha256:raw(f.artifacts.get(name))}));
  }
  snapshot.normativeSha256=projected('preparation',p);f.activation.normativeSha256=snapshot.normativeSha256;
  f.files.set('approved-preparation.json',json(snapshot));reseal(f);await writeImage(f);
}

export async function retireActive(f,selectors=null) {
  const retired=f.continuity.deliveries.filter(item=>selectors===null||selectors.includes(item.slice)),p=f.snapshot.normativeProjection;
  const ids=new Map([...f.continuity.deliveries,...f.continuity.completed].map(item=>[item.slice,item.deliveryId]));
  f.continuity.completed.push(...retired);f.continuity.completed.sort((a,b)=>a.deliveryId<b.deliveryId?-1:1);
  f.continuity.deliveries=f.continuity.deliveries.filter(item=>!retired.includes(item));
  p.completed.push(...p.deliveries.filter(item=>retired.some(value=>value.deliveryId===item.deliveryId)));
  p.completed.sort((a,b)=>a.deliveryId<b.deliveryId?-1:1);
  p.deliveries=p.deliveries.filter(item=>!retired.some(value=>value.deliveryId===item.deliveryId));
  p.global.order=p.deliveries.map(item=>item.deliveryId);
  f.snapshot.deliveries=f.snapshot.deliveries.filter(item=>!retired.some(value=>value.deliveryId===item.deliveryId));
  f.snapshot.preparationRevision+=1;f.activation.preparationRevision=f.snapshot.preparationRevision;
  f.activation.previousActivationId=f.activation.activationId;f.activation.activationId='fafafafa-fafa-4afa-8afa-fafafafafafa';
  f.activation.sequence+=1;f.activation.lastAttempt=null;
  const completedSelectors=new Set(f.continuity.completed.map(item=>item.slice));
  for(const leaf of [...p.completed,...p.deliveries]) for(const obligation of leaf.obligations)
    if(completedSelectors.has(obligation.fullOwner)) obligation.fullOwner='delivery:'+ids.get(obligation.fullOwner);
  for(const current of retired) for(const group of ['plans','tasks']) {
    const name=`${group}/${current.slice}.md`;f.files.delete(name);f.artifacts.delete(name);await fs.rm(path.join(f.execution,name));
  }
  for(const name of ['plan.md','tasks.md']) {
    const remove=bytes=>Buffer.from(bytes.toString('utf8').split('\n')
      .filter(line=>!retired.some(item=>line.includes(`| ${item.slice.slice(6)} - `))).join('\n'));
    f.artifacts.set(name,remove(f.artifacts.get(name)));f.files.set(name,remove(f.files.get(name)));
  }
  await refreshCampaign(f);return f;
}

export const sourceDigest=bytes=>createHash('sha256').update(bytes).digest('hex');

// All three identities and the shared owner exist before A's first capture.
// A uses src; earlier active C and later active B both change verify/check.mjs.
export async function overlappingActiveImage({status='PASS'}={}) {
  const f=await authoredCyclesImage({retainSecond:true,secondIndependent:true,thirdActive:true});
  const p=f.snapshot.normativeProjection,context={logicalSpecRoot:f.spec,logicalAuthorityPath:f.source,
    logicalExecutionRoot:f.execution,physicalExecutionRoot:f.execution,productRoot:f.project};
  const recipe=JSON.parse(JSON.stringify(source.RECIPE).replaceAll('src/pay.mjs','verify/check.mjs'));
  const toVerify=text=>text.replaceAll('src/pay.mjs','verify/check.mjs').replaceAll('../../../../src','../../../../verify')
    .replaceAll('"path":"src"','"path":"verify"').replaceAll('"pay.mjs"','"check.mjs"');
  f.overlapProofs=[];
  for(const [index,current] of f.continuity.deliveries.slice(1).entries()) {
    const leaf=p.deliveries.find(item=>item.deliveryId===current.deliveryId),version=index+1;
    const authority={preparationRevision:1,localRevision:1,normativeSha256:f.snapshot.normativeSha256,
      delivery:structuredClone(leaf),context:{requirementsAuthority:f.authority,
        objective:p.global.objective,strategy:p.global.strategy,risks:p.global.risks}};
    const owner={...source.OWNER,operationAttemptId:uuid(300+index),ownershipToken:uuid(1300+index),
      deliveryId:current.deliveryId,slice:current.slice,normativeSha256:authority.normativeSha256};
    const adapt=cap=>{
      const text=bytes=>Buffer.from(toVerify(Buffer.from(bytes).toString('utf8'))
        .replaceAll('/workspace',f.project).replaceAll('/tmp/pay-candidate',f.execution)
        .replaceAll('slice-01',current.slice).replaceAll(source.OWNER.deliveryId,current.deliveryId)
        .replaceAll(source.OWNER.operationAttemptId,owner.operationAttemptId)
        .replaceAll(source.OWNER.ownershipToken,owner.ownershipToken)
        .replaceAll(source.OWNER.normativeSha256,authority.normativeSha256)
        .replaceAll(source.AUTHORITY.context.requirementsAuthority,f.authority));
      const out=Object.fromEntries(Object.entries(cap).map(([name,value])=>[name,
        value instanceof Uint8Array?text(value):Array.isArray(value)?value.map(item=>item instanceof Uint8Array?text(item):item):value]));
      const observed=oracle.decode(out.verificationObservation);observed.resolved.recipeSha256=raw(Buffer.from(canonical(recipe)));
      out.verificationObservation=json(observed);
      const origin=oracle.decode(out.origin);origin.verification=observed.resolved;out.origin=json(origin);out.dispatch=json(origin);
      const receipt=oracle.decode(out.receipt);receipt.verification=observed;out.receipt=json(receipt);
      formal.rebindRaw(out,oracle.decode(out.rawResponse));return out;
    };
    const initial=adapt(source.nativeRound());
    const before=JSON.parse(toVerify(JSON.stringify(index?source.manifest(index):source.MANIFEST_0))),work=JSON.parse(toVerify(JSON.stringify(source.manifest(version))));
    const baseline=oracle.decode(initial.baselineCapture);baseline.manifest=before;initial.baselineCapture=json(baseline);
    const observed=oracle.decode(initial.verificationObservation);observed.before=work;observed.after=work;
    initial.verificationObservation=json(observed);
    const receipt=oracle.decode(initial.receipt);receipt.verification=observed;
    receipt.testedState.entries[0].value=raw(Buffer.from(`pay-v${version}\n`));initial.receipt=json(receipt);
    let base=composeInitialImplementationEvidence({context,authority,owner,currentEvidence:null,
      counters:current.counters,rounds:[initial]});
    const validationOwner={...owner,operation:'VALIDATE_SLICE',operationAttemptId:uuid(400+index),ownershipToken:uuid(1400+index)};
    const request=formal.request({baseBytes:base.bytes,counters:base.counters,authority,owner:validationOwner,
      scopePaths:['verify/check.mjs'],priorScopePaths:['verify/check.mjs']});
    const result=index===1?status:'PASS';
    const captured=adapt(formal.capture({request,approvedAuthority:authority,work,status:result,
      command:'node verify/check.mjs',resolved:observed.resolved}).cap);
    base=composeCurrentValidationEvidence({context,authority,owner:validationOwner,
      previous:{bundleBytes:base.bytes,counters:base.counters},capture:captured});
    current.validation=result==='PASS'?'current':'revalidation-required';current.counters=base.counters;current.baseline=before;
    current.evidence={path:`evidence/${current.deliveryId}.json`,sha256:raw(base.bytes)};
    f.files.set(current.evidence.path,Buffer.from(base.bytes));
    editSection(f,current.slice,'Implementation Test Evidence',base.bundle.implementation[0].recordUtf8);
    editSection(f,current.slice,'Validation Attempts',base.bundle.validation.recordUtf8);
    editSection(f,current.slice,'Changed Areas','- `../../../../verify/check.mjs`');
    editSection(f,current.slice,'Prior Validation Overlap',index===1
      ?'- Slice 03 overlap: `../../../../verify/check.mjs`; Prepared verification observes the same output.':'- none');
    editSection(f,current.slice,'Continuity',`- Current validation: ${current.validation}\n- Current evidence: ${current.evidence.path}\n- Current action: Read the retained decision.`);
    editSection(f,current.slice,'Final Result',result==='PASS'?'- PASS':'- pending');
    if(result==='PASS')editSection(f,current.slice,'Effective Validation Base',`- Origin attempt: attempt-01\n- Attempt type: initial\n- HEAD: 0123456789abcdef\n- Result: PASS\n- Files:\n  - \`../../../../verify/check.mjs\` | ${raw(Buffer.from(`pay-v${version}\n`))}\n- Authoritative commands:\n  - \`node verify/check.mjs\` | exit:0\n- Evidence summary: Direct recipe observation and file hash.`);
    f.files.set('tasks.md',Buffer.from(f.files.get('tasks.md').toString('utf8').split('\n').map(line=>line.includes(`| ${current.slice.slice(6)} - `)
      ?line.replace('| [ ] |',result==='PASS'?'| [x] |':'| [ ] |').replace(/\| pending \| pending \|$/u,`| ${result} | ${result==='PASS'?'PASS':'pending'} |`):line).join('\n')));
    f.overlapProofs.push({authority,initial,captured,base});
  }
  await fs.mkdir(path.join(f.project,'verify'),{recursive:true});await fs.writeFile(path.join(f.project,'verify/check.mjs'),'pay-v2\n');
  await retireActive(f,['slice-01']);return f;
}

export async function overlappingPostImage(test,{status='PASS'}={}) {
  const {convertedImage,installSuccessor}=await import('./current-operational-consumption.mjs');
  const {createCurrentNativeValidationCapture}=await import('../../skills/workflows/stnl-slice-executor/runtime/current-native-validation-capture.mjs');
  const {composePostConversionValidation}=await import('../../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs');
  const {normalizedFormal}=await import('./current-native-normalization.mjs');
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const run=promisify(execFile),image=await convertedImage(test,{kind:'three-s2'}),root=image.f.root;
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  await run('git',['-C',root,'init','-q']);await run('git',['-C',root,'add','.gitignore','requirements.md']);
  await run('git',['-C',root,'-c','user.name=Reader Fixture','-c','user.email=reader@example.invalid','commit','-qm','reader overlap fixture']);
  const head=(await run('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
  await fs.writeFile(path.join(root,'src/greeting.mjs'),'export const greeting="reader A";\n');
  const deliveries=JSON.parse(image.candidate.files.get('continuity.json')).deliveries;
  for(const [index,delivery]of deliveries.entries()) {
    // C measures the shared change before B's legal serial validation. A private
    // output drifts only after both proofs have been captured and published.
    if(index===1)await fs.writeFile(path.join(root,'other/greeting.mjs'),'export const greeting="post";\n');
    if(index<2)await normalizedFormal({image,root,head,specPath:image.f.specPath,delivery});
    else {
      // The reader fixture authors the final carrier; this does not certify a
      // publisher that currently leaves Prior Validation Overlap unfilled.
      const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,
        deliveryId:delivery.deliveryId,captureParent:root});
      const agentId='reader-offline-post-overlap';await session.bindAgent({agentId});
      const measured=await session.runVerification();
      if(measured.status!=='completed'||measured.commands.some(item=>item.exit!==0))throw new Error('overlap recipe failed');
      const finalResponse=JSON.stringify({format:'stnl-current-validation-response-v1',requestSha256:raw(session.validationRequest),
        result:{status,head,commands:measured.commands,evidence:'Prepared recipe measured the shared output.',
          findingReferences:'none',findingDispositions:'none',blockers:status==='BLOCKED'?'Explicit offline blocked judgment.':'none',
          unexpectedWorkspaceEffects:'none',persistenceSummary:'Retain exact fixture capture.'},newFindings:[]});
      const capture=await session.finish({agentId,status,finalResponse});
      const composed=await composePostConversionValidation({context:session.context,requirementsAuthority:session.requirementsAuthority,
        previous:session.previous,deliveryId:delivery.deliveryId,capture});
      await installSuccessor(image,JSON.parse(Buffer.from(session.previous.activationBytes)),composed);
    }
  }
  await fs.writeFile(path.join(root,'fourth/state.mjs'),'export const state=2;\n');
  const activation=JSON.parse(await fs.readFile(path.join(image.f.execution,'activation.json')));
  const files=new Map(await Promise.all(activation.artifacts.map(async item=>[item.path,await fs.readFile(path.join(image.f.execution,item.path))])));
  const snapshot=JSON.parse(files.get('approved-preparation.json'));
  const f={project:image.f.root,execution:image.f.execution,specPath:image.f.specPath,source:image.f.specPath,spec:path.dirname(image.f.specPath),
    authority:snapshot.requirementsAuthority,activation,snapshot,files,
    artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8)])),continuity:JSON.parse(files.get('continuity.json'))};
  const overlapPath=path.relative(path.join(f.execution,'tasks'),path.join(f.project,'other/greeting.mjs')).split(path.sep).join('/');
  editSection(f,'slice-02','Prior Validation Overlap',`- Slice 03 overlap: \`${overlapPath}\`; Prepared assertion covers the shared output.`);
  await retireActive(f,['slice-01']);return f;
}

export async function multipleActiveImage() {
  const f=await authoredCompletedImage(),snapshot=f.snapshot,p=snapshot.normativeProjection;
  const b=f.continuity.deliveries[0],c={...structuredClone(b),slice:'slice-03',deliveryId:uuid(303)};
  const leaf=structuredClone(p.deliveries[0]);leaf.deliveryId=c.deliveryId;
  leaf.obligations[0].contribution='partial';leaf.obligations[0].fullOwner='slice-02';
  for(const group of ['plans','tasks']) {
    const sourceName=`${group}/slice-02.md`,name=`${group}/slice-03.md`;
    const text=f.artifacts.get(sourceName).toString('utf8').replaceAll('slice-02','slice-03').replaceAll('Slice 02','Slice 03')
      .replaceAll(' - Verification',' - Additional').replaceAll(b.deliveryId,c.deliveryId).replace('- Slice: 02','- Slice: 03')
      .replace('contribution: complete | full owner: slice-03','contribution: partial | full owner: slice-02');
    f.artifacts.set(name,Buffer.from(text));f.files.set(name,Buffer.from(text));
  }
  const bPlan=f.artifacts.get('plans/slice-02.md').toString('utf8').replace('## Dependencies\n\n- slice-01','## Dependencies\n\n- slice-01\n- slice-03');
  f.artifacts.set('plans/slice-02.md',Buffer.from(bPlan));f.files.set('plans/slice-02.md',Buffer.from(bPlan));
  const beforePlan=f.artifacts.get('plan.md').toString('utf8'),row=beforePlan.split('\n').find(line=>line.startsWith('| 02 -'));
  const cRow=row.replace('02 - Verification','03 - Additional').replace('plans/slice-02.md','plans/slice-03.md');
  const bRow=row.replace('| slice-01 |','| slice-01, slice-03 |');
  const plan=beforePlan.replace(row,cRow+'\n'+bRow);f.artifacts.set('plan.md',Buffer.from(plan));f.files.set('plan.md',Buffer.from(plan));
  const beforeIndex=f.artifacts.get('tasks.md').toString('utf8'),index=beforeIndex.split('\n').find(line=>line.includes('02 - Verification'));
  const cIndex=index.replace('02 - Verification','03 - Additional').replace('tasks/slice-02.md','tasks/slice-03.md');
  const bIndex=index.replace('| slice-01 |','| slice-01, slice-03 |');
  const tasks=beforeIndex.replace(index,cIndex+'\n'+bIndex);f.artifacts.set('tasks.md',Buffer.from(tasks));f.files.set('tasks.md',Buffer.from(tasks));
  p.deliveries[0].dependencies.push(c.deliveryId);p.deliveries.unshift(leaf);p.global.order=p.deliveries.map(item=>item.deliveryId);
  snapshot.deliveries.unshift({slice:c.slice,deliveryId:c.deliveryId,localRevision:1,review:structuredClone(snapshot.deliveries[0].review)});
  f.continuity.deliveries.unshift(c);f.continuity.nextSliceOrdinal=4;
  await refreshCampaign(f);return f;
}
