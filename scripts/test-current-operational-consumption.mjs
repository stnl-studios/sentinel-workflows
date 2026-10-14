import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {convertedImage,installSuccessor} from './fixtures/current-operational-consumption.mjs';
import {createCurrentNativeValidationCapture} from '../skills/workflows/stnl-slice-executor/runtime/current-native-validation-capture.mjs';
import {composePostConversionValidation} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const readers=['stnl-slice-executor','stnl-slice-quality-manager'].map(name=>
  path.join(repo,'skills/workflows',name,'runtime/execution-current-reader.mjs'));
const guardedWorker=path.join(repo,'scripts/fixtures/current-quiet-reader.mjs');
async function guardedRead(image,reader,label) {
  const log=path.join(image.f.root,`e2-guard-${label}.json`);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,[guardedWorker,'--worker','read',reader,
    image.f.specPath,log,image.f.root],{env,encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,`${label}: ${run.stderr}`);
  const guarded=JSON.parse(await fs.readFile(log,'utf8'));
  assert.deepEqual(guarded.attempts,[],`${label}: legacy or forbidden I/O attempt`);
  assert.equal(guarded.result.error,undefined,`${label}: ${guarded.result.error?.message}`);
  return guarded.result;
}

test('O01 smoke real S1 importado: reader E2 em novo processo',async t=>{
  const image=await convertedImage(t);
  for(const reader of readers) {
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
    assert.equal(run.status,0,`${reader}: ${run.stderr} ${run.stdout}`);
    const result=JSON.parse(run.stdout);
    assert.equal(result.preparationRevision,JSON.parse(image.candidate.files.get('approved-preparation.json')).preparationRevision);
    assert.equal(result.deliveries.length,1);
    assert.equal(result.deliveries[0].persistedValidation,'current');
    assert.equal(result.deliveries[0].observedValidation,'current');
    assert.equal(result.deliveries[0].evidenceSha256,JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].evidence.sha256);
    assert.equal(result.normalHandoff,null);
  }
});

test('O02 smoke S1: nova sessão native mede a recipe aprovada',async t=>{
  const image=await convertedImage(t);
  const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
  const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,
    captureParent:image.f.root});
  await session.bindAgent({agentId:'offline-current-validation-smoke'});
  const measured=await session.runVerification();
  assert.equal(measured.status,'completed');
  assert.equal(measured.commands.length,1);
  assert.equal(measured.commands[0].exit,0);
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
    result:{status:'PASS',head:'offline-working-tree',commands:measured.commands,
      evidence:'The prepared Node expression exited zero in this offline measurement.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'Keep the current formal record.'},newFindings:[]});
  const capture=await session.finish({agentId:'offline-current-validation-smoke',status:'PASS',finalResponse:response});
  assert.equal(JSON.parse(Buffer.from(capture.receipt).toString()).semanticResponseStatus,'PASS');
});

test('O03 smoke S1: formal v3 substitui importado e leitores novos relêem',async t=>{
  const image=await convertedImage(t);
  const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
  const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,captureParent:image.f.root});
  await session.bindAgent({agentId:'offline-current-validation-smoke'});
  const measured=await session.runVerification();
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
    result:{status:'PASS',head:'offline-working-tree',commands:measured.commands,
      evidence:'The prepared Node expression exited zero in this offline measurement.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'Keep the current formal record.'},newFindings:[]});
  const capture=await session.finish({agentId:'offline-current-validation-smoke',status:'PASS',finalResponse:response});
  const composed=await composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,previous:session.previous,deliveryId:id,capture});
  assert.equal(composed.consumedInvocations,1);
  assert.equal(composed.replayed,false);
  assert.ok(Buffer.from(composed.files.get('approved-preparation.json')).equals(Buffer.from(session.previous.files.get('approved-preparation.json'))));
  assert.equal(JSON.parse(composed.files.get(`evidence/${id}.json`)).implementation.length,0);
  await installSuccessor(image,image.activation,composed);
  const successor=await captureCurrentExecution(image.f.specPath);
  const replay=await composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,
    previous:{activationBytes:successor.activationBytes,files:successor.files},deliveryId:id,capture});
  assert.equal(replay.replayed,true);
  assert.equal(replay.transition.counters.validationAttempts,
    JSON.parse(composed.files.get('continuity.json')).deliveries[0].counters.validationAttempts);
  for(const reader of readers) {
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
    assert.equal(run.status,0,`${reader}: ${run.stderr} ${run.stdout}`);
    const result=JSON.parse(run.stdout);
    assert.equal(result.deliveries[0].formalStatus,'PASS');
    assert.equal(result.deliveries[0].persistedValidation,'current');
  }
});

test('O04 smoke S2: formal v3 sobre arquivo e high-water histórico',async t=>{
  const image=await convertedImage(t,{kind:'managed-s2'});
  await fs.writeFile(path.join(image.f.root,'src/greeting.mjs'),'export const greeting = "hello";\n');
  const before=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0];
  assert.equal(before.evidence,null);
  assert.ok(before.counters.validationAttempts>0);
  const id=before.deliveryId;
  const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,captureParent:image.f.root});
  await session.bindAgent({agentId:'offline-s2-validation-smoke'});
  const measured=await session.runVerification();
  assert.equal(measured.status,'completed');
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
    result:{status:'PASS',head:'offline-working-tree',commands:measured.commands,
      evidence:'The prepared file verification recipe completed in this offline measurement.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'Keep the current formal record.'},newFindings:[]});
  const capture=await session.finish({agentId:'offline-s2-validation-smoke',status:'PASS',finalResponse:response});
  const composed=await composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,previous:session.previous,deliveryId:id,capture});
  const next=JSON.parse(composed.files.get('continuity.json')).deliveries[0];
  assert.equal(next.counters.validationAttempts,before.counters.validationAttempts+1);
  assert.equal(next.counters.findingsChecks,before.counters.findingsChecks);
  assert.ok(Buffer.from(composed.files.get('approved-preparation.json')).equals(Buffer.from(session.previous.files.get('approved-preparation.json'))));
  await installSuccessor(image,image.activation,composed);
  for(const reader of readers) {
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
    assert.equal(run.status,0,`${reader}: ${run.stderr} ${run.stdout}`);
    assert.equal(JSON.parse(run.stdout).deliveries[0].formalStatus,'PASS');
  }
});

test('O05 smoke: segunda formal v3 substitui primeira em S1 e S2',async t=>{
  for(const kind of ['native-s1','managed-s2']) {
    const image=await convertedImage(t,{kind});
    if(kind==='managed-s2') await fs.writeFile(path.join(image.f.root,'src/greeting.mjs'),'export const greeting = "hello";\n');
    const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
    let activation=image.activation,firstDigest=null;
    for(const [index,reader] of readers.entries())
      await guardedRead(image,reader,`${kind}-before-${index}`);
    for(let round=1;round<=2;round+=1) {
      const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,captureParent:image.f.root});
      const agentId=`offline-${kind}-round-${round}`;
      await session.bindAgent({agentId});
      const measured=await session.runVerification();
      const response=JSON.stringify({format:'stnl-current-validation-response-v1',
        requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
        result:{status:'PASS',head:'offline-working-tree',commands:measured.commands,
          evidence:`The approved recipe exited zero in offline round ${round}.`,
          findingReferences:'none',findingDispositions:'none',blockers:'none',
          unexpectedWorkspaceEffects:'none',persistenceSummary:'Keep this formal record.'},newFindings:[]});
      const capture=await session.finish({agentId,status:'PASS',finalResponse:response});
      const composed=await composePostConversionValidation({context:session.context,
        requirementsAuthority:session.requirementsAuthority,previous:session.previous,deliveryId:id,capture});
      const bundle=JSON.parse(composed.files.get(`evidence/${id}.json`));
      assert.equal(bundle.validation.id,`attempt-${String(JSON.parse(Buffer.from(session.validationRequest).toString()).base.counters.validationAttempts+1).padStart(2,'0')}`);
      if(round===1) firstDigest=JSON.parse(composed.files.get('continuity.json')).deliveries[0].evidence.sha256;
      else assert.notEqual(JSON.parse(composed.files.get('continuity.json')).deliveries[0].evidence.sha256,firstDigest);
      activation=await installSuccessor(image,activation,composed);
      for(const reader of readers) {
        const env={...process.env};delete env.NODE_TEST_CONTEXT;
        const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
        assert.equal(run.status,0,`${kind} round ${round}: ${reader}: ${run.stderr} ${run.stdout}`);
        assert.equal(JSON.parse(run.stdout).deliveries[0].formalStatus,'PASS');
      }
      for(const [index,reader] of readers.entries())
        await guardedRead(image,reader,`${kind}-after-${round}-${index}`);
    }
  }
});

test('O06 resultados v3 NEEDS_FIX e BLOCKED são legíveis, sem nova composição',async t=>{
  for(const status of ['NEEDS_FIX','BLOCKED']) {
    const image=await convertedImage(t);
    const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
    const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,captureParent:image.f.root});
    const agentId=`offline-${status}`;
    await session.bindAgent({agentId});
    const measured=await session.runVerification();
    const finding={id:'finding-01',severity:'blocking',originAttempt:'attempt-02',
      problem:'The offline acceptance proof is incomplete.',evidence:'The reviewer requested an additional check.',
      impact:'The approved condition is not yet established.',relatedAuthority:'AC-001',
      expectedCorrection:'Add objective validation evidence for AC-001.'};
    const response=JSON.stringify({format:'stnl-current-validation-response-v1',
      requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
      result:{status,head:'offline-working-tree',commands:measured.commands,
        evidence:'The prepared recipe exited zero; the offline semantic judgment remains open.',
        findingReferences:status==='NEEDS_FIX'?'finding-01':'none',
        findingDispositions:status==='NEEDS_FIX'?'finding-01=active':'none',
        blockers:status==='BLOCKED'?'The offline reviewer cannot conclude this validation.':'none',
        unexpectedWorkspaceEffects:'none',persistenceSummary:'Keep the captured formal record.'},
      newFindings:status==='NEEDS_FIX'?[finding]:[]});
    const capture=await session.finish({agentId,status,finalResponse:response});
    const composed=await composePostConversionValidation({context:session.context,
      requirementsAuthority:session.requirementsAuthority,previous:session.previous,deliveryId:id,capture});
    await installSuccessor(image,image.activation,composed);
    for(const reader of readers) {
      const env={...process.env};delete env.NODE_TEST_CONTEXT;
      const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
      assert.equal(run.status,0,`${status}: ${reader}: ${run.stderr} ${run.stdout}`);
      const result=JSON.parse(run.stdout);
      assert.equal(result.deliveries[0].formalStatus,status);
      assert.equal(result.normalHandoff?.operation??null,status==='NEEDS_FIX'?'APPLY_FINDINGS':null);
    }
    await assert.rejects(()=>createCurrentNativeValidationCapture({specPath:image.f.specPath,
      deliveryId:id,captureParent:image.f.root}),error=>error.code==='UNSUPPORTED_FORMAT');
  }
});

test('O07 vínculo v3, ordem da sessão e replay divergente falham fechados',async t=>{
  const image=await convertedImage(t);
  const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
  const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,captureParent:image.f.root});
  await assert.rejects(()=>session.runVerification(),error=>error.code==='OWNER_UNCERTAIN');
  await assert.rejects(()=>session.finish({agentId:'agent',status:'PASS',finalResponse:'{}'}),
    error=>error.code==='OWNER_MISMATCH');
  await session.bindAgent({agentId:'agent'});
  await assert.rejects(()=>session.bindAgent({agentId:'other'}),error=>error.code==='OWNER_MISMATCH');
  const measured=await session.runVerification();
  await assert.rejects(()=>session.runVerification(),error=>error.code==='OWNER_UNCERTAIN');
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
    result:{status:'PASS',head:'offline-working-tree',commands:measured.commands,
      evidence:'The prepared recipe exited zero in this offline measurement.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'Keep this formal record.'},newFindings:[]});
  const capture=await session.finish({agentId:'agent',status:'PASS',finalResponse:response});
  const repeated=await session.finish({agentId:'agent',status:'PASS',finalResponse:response});
  assert.notEqual(repeated,capture);
  assert.ok(Buffer.from(repeated.rawResponse).equals(Buffer.from(capture.rawResponse)));
  await assert.rejects(()=>session.finish({agentId:'agent',status:'PASS',finalResponse:response+' '}),
    error=>error.code==='OWNER_MISMATCH');
  const compose=changed=>composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,previous:session.previous,deliveryId:id,capture:changed});
  for(const [name,mutate] of [
    ['response hash',copy=>{const body=JSON.parse(Buffer.from(copy.rawResponse).toString());body.requestSha256='sha256:'+'0'.repeat(64);copy.rawResponse=Buffer.from(JSON.stringify(body));}],
    ['owner',copy=>{const body=JSON.parse(Buffer.from(copy.validationRequest).toString());body.owner.operationAttemptId='00000000-0000-4000-8000-000000000001';copy.validationRequest=Buffer.from(JSON.stringify(body)+'\n');}],
    ['snapshot',copy=>{const body=JSON.parse(Buffer.from(copy.validationRequest).toString());body.base.approvedSnapshotSha256='sha256:'+'0'.repeat(64);copy.validationRequest=Buffer.from(JSON.stringify(body)+'\n');}],
    ['observation',copy=>{const body=JSON.parse(Buffer.from(copy.verificationObservation).toString());body.after.entries=[];copy.verificationObservation=Buffer.from(JSON.stringify(body)+'\n');}],
  ]) {
    const changed={...capture};mutate(changed);
    await assert.rejects(()=>compose(changed),error=>Boolean(error.code),name);
  }
  const composed=await compose(capture);
  await installSuccessor(image,image.activation,composed);
  const successor=await captureCurrentExecution(image.f.specPath);
  const changed={...capture,rawResponse:Buffer.from(response+' ')};
  await assert.rejects(()=>composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,
    previous:{activationBytes:successor.activationBytes,files:successor.files},deliveryId:id,capture:changed}),
    error=>error.code==='OWNER_MISMATCH');
});

test('O08 mudanças de produto ou imagem entre medição e conclusão bloqueiam capture',async t=>{
  for(const change of ['product','image']) {
    const image=await convertedImage(t);
    const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
    const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,captureParent:image.f.root});
    await session.bindAgent({agentId:'offline-drift'});
    const measured=await session.runVerification();
    if(change==='product') await fs.writeFile(path.join(image.f.root,'src/new-output.mjs'),'export const value = 1;\n');
    else await fs.appendFile(path.join(image.f.execution,'tasks/slice-01.md'),'\n');
    const response=JSON.stringify({format:'stnl-current-validation-response-v1',
      requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
      result:{status:'PASS',head:'offline-working-tree',commands:measured.commands,
        evidence:'The prepared recipe exited zero before the subsequent change.',
        findingReferences:'none',findingDispositions:'none',blockers:'none',
        unexpectedWorkspaceEffects:'none',persistenceSummary:'No successor is composed.'},newFindings:[]});
    await assert.rejects(()=>session.finish({agentId:'offline-drift',status:'PASS',finalResponse:response}),
      error=>['EVIDENCE_STALE','INVALID_CURRENT_IMAGE'].includes(error.code),change);
  }
});

test('O09 E0 adulterado ou renomeado v2 não ganha aprovação por reseal externo',async t=>{
  for(const mutation of ['tampered','renamed']) {
    const image=await convertedImage(t);
    const files=new Map(image.candidate.files);
    const current=JSON.parse(files.get('continuity.json')).deliveries[0];
    const evidencePath=current.evidence.path;
    const bundle=JSON.parse(files.get(evidencePath));
    if(mutation==='tampered') bundle.validation.recordUtf8+='\n- Forged note: changed';
    else bundle.validation.recordFormat='stnl-task-record-v2';
    const evidenceBytes=Buffer.from(JSON.stringify(bundle)+'\n');
    files.set(evidencePath,evidenceBytes);
    const digest=`sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
    const oldDigest=current.evidence.sha256;
    current.evidence.sha256=digest;
    const continuity=JSON.parse(files.get('continuity.json'));
    continuity.deliveries[0]=current;
    files.set('continuity.json',Buffer.from(JSON.stringify(continuity)+'\n'));
    files.set('tasks/slice-01.md',Buffer.from(Buffer.from(files.get('tasks/slice-01.md')).toString().replace(oldDigest,digest)));
    const activation={...image.activation,artifacts:[...files].map(([name,bytes])=>({path:name,
      sha256:`sha256:${createHash('sha256').update(bytes).digest('hex')}`}))
      .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
    for(const [name,bytes] of files) await fs.writeFile(path.join(image.f.execution,name),bytes);
    await fs.writeFile(path.join(image.f.execution,'activation.json'),JSON.stringify(activation)+'\n');
    for(const reader of readers) {
      const env={...process.env};delete env.NODE_TEST_CONTEXT;
      const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
      assert.equal(run.status,1,`${mutation}: ${reader}`);
      assert.equal(JSON.parse(run.stdout).code,'INVALID_CURRENT_IMAGE');
    }
  }
});

test('O10 S0 é legível e recusa captura e composição formal',async t=>{
  const image=await convertedImage(t,{kind:'s0'});
  const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
  for(const reader of readers) {
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
    assert.equal(run.status,0,`${reader}: ${run.stderr} ${run.stdout}`);
    const result=JSON.parse(run.stdout);
    assert.equal(result.deliveries[0].persistedValidation,'unvalidated');
    assert.equal(result.deliveries[0].evidenceSha256,null);
  }
  await assert.rejects(()=>createCurrentNativeValidationCapture({specPath:image.f.specPath,
    deliveryId:id,captureParent:image.f.root}),error=>error.code==='UNSUPPORTED_FORMAT');
  const previous=await captureCurrentExecution(image.f.specPath);
  await assert.rejects(()=>composePostConversionValidation({context:previous.context,
    requirementsAuthority:previous.requirementsAuthority,
    previous:{activationBytes:previous.activationBytes,files:previous.files},deliveryId:id,capture:{}}),
    error=>error.code==='UNSUPPORTED_FORMAT');
});

test('O11 sucessor v3 rejeita counters, record, objetos e norma adulterados após reseal',async t=>{
  const image=await convertedImage(t);
  const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
  const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,captureParent:image.f.root});
  await session.bindAgent({agentId:'offline-reseal'});
  const measured=await session.runVerification();
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
    result:{status:'PASS',head:'offline-working-tree',commands:measured.commands,
      evidence:'The prepared recipe exited zero before mutation.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'Keep the genuine formal record.'},newFindings:[]});
  const capture=await session.finish({agentId:'offline-reseal',status:'PASS',finalResponse:response});
  const composed=await composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,previous:session.previous,deliveryId:id,capture});
  const activation=await installSuccessor(image,image.activation,composed);
  const genuine=new Map([...composed.files].map(([name,bytes])=>[name,Buffer.from(bytes)]));
  for(const [label,mutate] of [
    ['counter',files=>{const body=JSON.parse(files.get('continuity.json'));body.deliveries[0].counters.validationAttempts-=1;files.set('continuity.json',Buffer.from(JSON.stringify(body)+'\n'));}],
    ['record',files=>{const name=`evidence/${id}.json`,body=JSON.parse(files.get(name));body.validation.recordUtf8+='\n- Forged: yes';files.set(name,Buffer.from(JSON.stringify(body)+'\n'));}],
    ['orphan',files=>{const name=`evidence/${id}.json`,body=JSON.parse(files.get(name));body.objects.pop();files.set(name,Buffer.from(JSON.stringify(body)+'\n'));}],
    ['normative',files=>{const name='tasks/slice-01.md';files.set(name,Buffer.from(files.get(name).toString().replace('Arithmetic command exits zero without product files.','Arithmetic command exits one without product files.')));}],
  ]) {
    const files=new Map([...genuine].map(([name,bytes])=>[name,Buffer.from(bytes)]));
    mutate(files);
    if(['record','orphan'].includes(label)) {
      const nextDigest=`sha256:${createHash('sha256').update(files.get(`evidence/${id}.json`)).digest('hex')}`;
      const continuity=JSON.parse(files.get('continuity.json'));
      const former=continuity.deliveries[0].evidence.sha256;
      continuity.deliveries[0].evidence.sha256=nextDigest;
      files.set('continuity.json',Buffer.from(JSON.stringify(continuity)+'\n'));
      files.set('tasks/slice-01.md',Buffer.from(files.get('tasks/slice-01.md').toString().replace(former,nextDigest)));
    }
    const resealed={...activation,artifacts:[...files].map(([name,bytes])=>({path:name,
      sha256:`sha256:${createHash('sha256').update(bytes).digest('hex')}`}))
      .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
    for(const [name,bytes] of files) await fs.writeFile(path.join(image.f.execution,name),bytes);
    await fs.writeFile(path.join(image.f.execution,'activation.json'),JSON.stringify(resealed)+'\n');
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    for(const reader of readers) {
      const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
      assert.equal(run.status,1,`${label}: ${reader}: ${run.stdout}`);
    }
  }
});

test('O12 duas deliveries S0 projetam input compartilhado e deriva em ambas',async t=>{
  const image=await convertedImage(t,{kind:'disjoint-s0'});
  for(const [changed,expected] of [[false,'unvalidated'],[true,'revalidation-required']]) {
    if(changed) await fs.writeFile(path.join(image.f.root,'shared/config.json'),'{"changed":true}\n');
    for(const reader of readers) {
      const env={...process.env};delete env.NODE_TEST_CONTEXT;
      const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
      assert.equal(run.status,0,`${reader}: ${run.stdout} ${run.stderr}`);
      const result=JSON.parse(run.stdout);
      assert.equal(result.deliveries.length,2);
      assert.deepEqual(result.deliveries.map(item=>item.observedValidation),[expected,expected]);
      assert.equal(result.normalHandoff,null);
    }
  }
});

test('O13 S1 managed convertido é legível sem fonte histórica',async t=>{
  const image=await convertedImage(t,{kind:'managed-s1'});
  for(const reader of readers) {
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
    assert.equal(run.status,0,`${reader}: ${run.stdout} ${run.stderr}`);
    const result=JSON.parse(run.stdout);
    assert.equal(result.deliveries[0].persistedValidation,'current');
    assert.equal(result.deliveries[0].observedValidation,'current');
    assert.equal(result.deliveries[0].formalStatus,'PASS');
  }
});

test('O14 S1 managed recebe nova formal native offline',async t=>{
  const image=await convertedImage(t,{kind:'managed-s1'});
  const id=JSON.parse(image.candidate.files.get('continuity.json')).deliveries[0].deliveryId;
  const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,deliveryId:id,captureParent:image.f.root});
  await session.bindAgent({agentId:'offline-after-managed'});
  const measured=await session.runVerification();
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
    result:{status:'PASS',head:'offline-working-tree',commands:measured.commands,
      evidence:'The approved recipe exited zero after the managed imported cycle.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'Keep this native formal record.'},newFindings:[]});
  const capture=await session.finish({agentId:'offline-after-managed',status:'PASS',finalResponse:response});
  const composed=await composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,previous:session.previous,deliveryId:id,capture});
  const bundle=JSON.parse(composed.files.get(`evidence/${id}.json`));
  assert.equal(bundle.validation.recordFormat,'stnl-task-record-v2');
  assert.equal(bundle.implementation.length,0);
  await installSuccessor(image,image.activation,composed);
  for(const reader of readers) {
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
    assert.equal(run.status,0,`${reader}: ${run.stdout} ${run.stderr}`);
    assert.equal(JSON.parse(run.stdout).deliveries[0].formalStatus,'PASS');
  }
});

test('O15 BLOCKED posterior prevalece sobre deriva de produto da primeira delivery',async t=>{
  const image=await convertedImage(t,{kind:'two-s2'});
  const initial=JSON.parse(image.candidate.files.get('continuity.json')).deliveries;
  assert.deepEqual(initial.map(item=>item.slice),['slice-01','slice-02']);
  assert.deepEqual(initial.map(item=>item.validation),['revalidation-required','revalidation-required']);
  const second=initial[1];
  const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,
    deliveryId:second.deliveryId,captureParent:image.f.root});
  const agentId='offline-second-blocked';
  await session.bindAgent({agentId});
  const measured=await session.runVerification();
  assert.equal(measured.status,'completed');
  assert.equal(measured.commands[0].exit,0);
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(session.validationRequest).digest('hex')}`,
    result:{status:'BLOCKED',head:'offline-working-tree',commands:measured.commands,
      evidence:'The approved second recipe ran, but the offline semantic judgment cannot be completed.',
      findingReferences:'none',findingDispositions:'none',
      blockers:'The second delivery requires an independent acceptance decision.',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'Retain the concluded BLOCKED formal.'},newFindings:[]});
  const capture=await session.finish({agentId,status:'BLOCKED',finalResponse:response});
  const composed=await composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,previous:session.previous,
    deliveryId:second.deliveryId,capture});
  await installSuccessor(image,image.activation,composed);
  await fs.appendFile(path.join(image.f.root,'src/unpredicted.mjs'),'// product changed after conversion\n');
  for(const reader of readers) {
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const run=spawnSync(process.execPath,[reader,image.f.specPath],{env,encoding:'utf8',timeout:30000});
    assert.equal(run.status,0,`${reader}: ${run.stderr} ${run.stdout}`);
    const result=JSON.parse(run.stdout);
    assert.equal(result.deliveries.length,2);
    assert.equal(result.deliveries[0].observedValidation,'revalidation-required');
    assert.equal(result.deliveries[1].formalStatus,'BLOCKED');
    assert.equal(result.deliveries[1].observedValidation,'uncertain');
    assert.equal(result.state,'VALIDATION_BLOCKED');
    assert.equal(result.normalHandoff,null);
    assert.ok(result.diagnostics.some(item=>item.artifact==='slice-02'
      && item.field==='status' && item.reason==='blocked incorporation'));
  }
});
