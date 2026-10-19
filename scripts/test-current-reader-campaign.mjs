import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {inspectCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {authoredCyclesImage,cleanup,canonical,reseal,writeImage,editSection} from './fixtures/current-quiet-reader.mjs';
import {campaignImage,retireActive,refreshCampaign,multipleActiveImage,overlappingActiveImage,overlappingPostImage} from './fixtures/current-reader-campaign.mjs';
import {currentImage} from './fixtures/current-operational-consumption.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {prepareCurrentLocalReview,finalizeCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const run=promisify(execFile);
async function using(builder,action) {const f=await builder();try{return await action(f)}finally{await cleanup(f)}}
async function rejected(action,codes,relation=null) {
  await assert.rejects(action,error=>{
    assert.ok([].concat(codes).includes(error.code),`${error.code}: ${error.message}`);
    if(relation) assert.match(error.message,new RegExp(relation));return true;
  });
}
async function tree(root) {
  const rows=[];async function visit(p,relative='') {
    const m=await fs.lstat(p),row={path:relative,mode:m.mode&511,ino:m.ino,kind:m.isFile()?'file':m.isDirectory()?'directory':'other'};
    if(m.isFile())row.sha256=hash(await fs.readFile(p));rows.push(row);
    if(m.isDirectory())for(const name of (await fs.readdir(p)).sort())await visit(path.join(p,name),relative+'/'+name);
  }await visit(root);return rows;
}
function literals(f) {
  return [...f.files].filter(([name])=>name.startsWith('evidence/')).map(([name,bytes])=>{
    const b=JSON.parse(bytes);return [name,hash(Buffer.from(JSON.stringify({records:[...b.implementation,...b.findingsChecks,...b.support,b.validation],objects:b.objects})))];
  });
}

test('C01 ownership aliases preserve literal old proofs and normal current digests',async t=>{
  await t.test('own integral owner, one completed and zero active',async()=>using(
    ()=>authoredCyclesImage(),async f=>{
      const before=literals(f);await retireActive(f);assert.deepEqual(literals(f),before);
      const observed=await tree(f.project),result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.completed.length,1);assert.equal(result.completed[0].observedValidation,'current');
      assert.deepEqual(result.deliveries,[]);assert.notEqual(result.state,'COMPLETE');assert.equal(result.normalHandoff,null);
      assert.deepEqual(await tree(f.project),observed);
    }));
  await t.test('shared integral owner, two completed and zero active',async()=>using(campaignImage,async f=>{
    const before=literals(f);await retireActive(f);assert.deepEqual(literals(f),before);
    const observed=await tree(f.project),result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.completed.length,2);assert.ok(result.completed.every(item=>item.observedValidation==='current'));
    assert.notEqual(result.state,'COMPLETE');assert.equal(result.normalHandoff,null);
    assert.deepEqual(await tree(f.project),observed);
  }));
  await t.test('ownership equivalence compares JSON meaning without rewriting literal source bytes',async()=>using(campaignImage,async f=>{
    await retireActive(f);const current=f.continuity.completed[1],bundle=JSON.parse(f.files.get(current.evidence.path));
    bundle.validation.contract.delivery=Object.fromEntries(Object.entries(bundle.validation.contract.delivery).reverse());
    const bytes=Buffer.from(JSON.stringify(bundle)+'\n');f.files.set(current.evidence.path,bytes);current.evidence.sha256='sha256:'+hash(bytes);
    f.snapshot.completed.find(item=>item.deliveryId===current.deliveryId).evidenceSha256=current.evidence.sha256;
    f.snapshot.globalReview.evidenceDecisions.find(item=>item.deliveryId===current.deliveryId).evidenceSha256=current.evidence.sha256;
    f.files.set('approved-preparation.json',Buffer.from(canonical(f.snapshot)+'\n'));reseal(f);await writeImage(f);
    const result=await inspectCurrentExecution(f.specPath);assert.ok(result.completed.every(item=>item.observedValidation==='current'));
    assert.ok(bytes.equals(await fs.readFile(path.join(f.execution,current.evidence.path))));
  }));
  await t.test('current selector map cannot fill missing historical shared ownership',async()=>using(
    ()=>campaignImage({historicalMismatch:true}),async f=>{
      await retireActive(f);await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE');
    }));
  await t.test('equal selector text cannot hide unproved historical identity',async()=>using(
    ()=>campaignImage({historicalMismatch:true}),async f=>{
      await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE','historical owner');
    }));
  await t.test('foreign owner UUID is not a member',async()=>using(campaignImage,async f=>{
    await retireActive(f);f.snapshot.normativeProjection.completed[0].obligations[0].fullOwner='delivery:ffffffff-ffff-4fff-8fff-ffffffffffff';
    await refreshCampaign(f);await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
  await t.test('reassociated selector cannot replace its proven UUID',async()=>using(campaignImage,async f=>{
    await retireActive(f);const p=f.snapshot.normativeProjection;
    p.completed[0].obligations[0].fullOwner='delivery:'+p.completed[0].deliveryId;
    await refreshCampaign(f);await rejected(()=>inspectCurrentExecution(f.specPath),['INVALID_CURRENT_IMAGE','EVIDENCE_STALE']);
  }));
  await t.test('two integral owners for the same requirement are inconsistent',async()=>using(campaignImage,async f=>{
    await retireActive(f);const p=f.snapshot.normativeProjection;
    p.completed[0].obligations[0].contribution='complete';p.completed[0].obligations[0].fullOwner='delivery:'+p.completed[0].deliveryId;
    await refreshCampaign(f);await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
  await t.test('completed cannot depend on pending active delivery',async()=>using(campaignImage,async f=>{
    const p=f.snapshot.normativeProjection;p.completed[0].dependencies=[p.deliveries[0].deliveryId];
    p.deliveries[0].dependencies=[];await refreshCampaign(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),['INVALID_CURRENT_IMAGE','EVIDENCE_INCOMPLETE']);
  }));
  await t.test('cycle among completed deliveries is inconsistent',async()=>using(campaignImage,async f=>{
    await retireActive(f);const p=f.snapshot.normativeProjection.completed;
    p[0].dependencies=[p[1].deliveryId];await refreshCampaign(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
  for(const field of ['completionCriterion','obligation','recipe'])await t.test(`owner equivalence cannot excuse changed ${field}`,async()=>using(campaignImage,async f=>{
    await retireActive(f);const leaf=f.snapshot.normativeProjection.completed[1];
    if(field==='obligation')leaf.obligations[0].condition+=' changed';
    else if(field==='recipe')leaf.verificationRecipe.dependencyReview+=' changed';else leaf[field]+=' changed';
    await refreshCampaign(f);await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE');
  }));
  await t.test('zero contributions cannot manufacture global completion',async()=>using(campaignImage,async f=>{
    await retireActive(f);for(const current of f.continuity.completed){f.files.delete(current.evidence.path);await fs.rm(path.join(f.execution,current.evidence.path));}
    f.continuity.completed=[];f.snapshot.normativeProjection.completed=[];await refreshCampaign(f);
    // An empty evidence directory is not part of the official layout.
    await fs.rmdir(path.join(f.execution,'evidence'));
    const result=await inspectCurrentExecution(f.specPath);assert.deepEqual(result.deliveries,[]);assert.deepEqual(result.completed,[]);
    assert.notEqual(result.state,'COMPLETE');assert.equal(result.normalHandoff,null);
  }));
  await t.test('several active deliveries cannot supply missing historical ownership from their current map',async()=>using(multipleActiveImage,async f=>{
    const before=await tree(f.project);
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE','historical owner');
    assert.deepEqual(await tree(f.project),before);
  }));
  await t.test('a changed global context is not excused by ownership alias equivalence',async()=>using(campaignImage,async f=>{
    await retireActive(f);const p=f.snapshot.normativeProjection;p.global.strategy+=' changed';
    for(const map of [f.artifacts,f.files])map.set('plan.md',Buffer.from(map.get('plan.md').toString('utf8')
      .replace('- Strategy: One delivery.','- Strategy: One delivery. changed')));
    await refreshCampaign(f);await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE','context');
  }));
});

test('C02 existing native proof families compose with completed independently',async t=>{
  for(const [kind,rounds,formalStatus,auxiliaryStatus] of [
    ['AUXILIARY',1,null,'TESTS_PASS'],['AUXILIARY',3,null,'TESTS_PASS'],['FAIL3',3,null,'TESTS_FAIL'],
    ['NEEDS_FIX',1,'NEEDS_FIX','TESTS_PASS'],['BLOCKED',1,'BLOCKED','TESTS_PASS'],
    ['APPLY_CORRECTED',1,'NEEDS_FIX','TESTS_PASS'],['APPLY_FAIL3',3,'NEEDS_FIX','TESTS_FAIL'],
    ['APPLY_BLOCKED',1,'NEEDS_FIX','BLOCKED'],['APPLY_PASS',1,'PASS','TESTS_PASS'],
    ['INITIAL_REFUSAL',1,null,null],['FORMAL_REFUSAL',1,null,'TESTS_PASS'],['APPLY_REFUSAL',1,'NEEDS_FIX',null],
  ]) await t.test(`${kind} ${rounds}`,async()=>using(()=>campaignImage({kind,rounds}),async f=>{
    const before=await tree(f.project),result=await inspectCurrentExecution(f.specPath),b=result.deliveries[0];
    assert.equal(result.completed[0].observedValidation,'current');
    assert.equal(b.formalStatus,formalStatus);if(auxiliaryStatus!==null)assert.equal(b.auxiliaryStatus,auxiliaryStatus);
    assert.notEqual(result.state,'COMPLETE');
    if(['BLOCKED','APPLY_BLOCKED','INITIAL_REFUSAL','FORMAL_REFUSAL','APPLY_REFUSAL'].includes(kind))
      assert.equal(result.state,'VALIDATION_BLOCKED');
    if(kind==='NEEDS_FIX')assert.equal(result.normalHandoff.operation,'APPLY_FINDINGS');
    if(kind==='APPLY_CORRECTED')assert.equal(result.normalHandoff.operation,'VALIDATE_SLICE');
    assert.deepEqual(await tree(f.project),before);
  }));
  await t.test('independent B drift preserves A and shared input drift does not',async()=>using(
    ()=>campaignImage({kind:'APPLY_PASS'}),async f=>{
      await fs.writeFile(path.join(f.project,'verify/check.mjs'),'drift\n');
      const r=await inspectCurrentExecution(f.specPath);assert.equal(r.completed[0].observedValidation,'current');
      assert.equal(r.deliveries[0].observedValidation,'revalidation-required');assert.equal(r.state,'EVIDENCE_STALE');
      await fs.writeFile(path.join(f.project,'config/settings.json'),'shared drift\n');
      await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE','slice-01');
    }));
});

test('C03 existing post-conversion normalization and local review compose with completed',async t=>{
  for(const mode of ['settled','exhausted','review','s2-gap']) await t.test(mode,async t=>{
    const exhausted=mode==='exhausted';
    const image=await currentImage(t,{kind:'two-s2'}),root=image.f.root;
    await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
    await run('git',['-C',root,'init','-q']);await run('git',['-C',root,'add','.gitignore','requirements.md']);
    await run('git',['-C',root,'-c','user.name=Reader Fixture','-c','user.email=reader@example.invalid','commit','-qm','reader fixture']);
    const head=(await run('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
    const fixture={image,root,head,specPath:image.f.specPath};
    let continuity=JSON.parse(await fs.readFile(path.join(image.f.execution,'continuity.json')));
    fixture.delivery=continuity.deliveries[0];
    await fs.writeFile(path.join(root,'src/greeting.mjs'),'export const greeting="reader";\n');
    await normalizedFormal(fixture);
    continuity=JSON.parse(await fs.readFile(path.join(image.f.execution,'continuity.json')));
    fixture.delivery=continuity.deliveries[1];
    if(mode!=='s2-gap') {
      await fs.writeFile(path.join(root,'other/greeting.mjs'),'export const greeting="reader B";\n');
      await normalizedFormal(fixture,{invalid:mode!=='review'});
    }
    if(exhausted)await normalizedFormal(fixture,{successor:true,invalid:true});
    if(mode==='review') {
      const old=await captureCurrentExecution(fixture.specPath),slice=fixture.delivery.slice;
      const snapshot=JSON.parse(Buffer.from(old.files.get('approved-preparation.json')));
      const revise=bytes=>Buffer.from(bytes).toString('utf8').replace('- Local revision: 1','- Local revision: 2');
      const plan=revise(old.files.get(`plans/${slice}.md`)).replace(/(## Risks and Strategy\n\n)/u,'$1- A private reviewed strategy.\n');
      const input={context:old.context,requirementsAuthority:old.requirementsAuthority,
        previous:{activationBytes:old.activationBytes,files:old.files},slice,planBytes:Buffer.from(plan),
        reviewedTaskBytes:Buffer.from(revise(snapshot.reviewedArtifacts.find(item=>item.path===`tasks/${slice}.md`).utf8)),
        currentTaskBytes:Buffer.from(revise(old.files.get(`tasks/${slice}.md`)))};
      const proposal=prepareCurrentLocalReview(input),review={...proposal.reviewRequest,decision:'approved',
        evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Private strategy changed; revalidate this exact historical proof.'})),
        summary:'Independent private reader fixture review.'};
      const next=finalizeCurrentLocalReview({proposal,review});
      for(const [name,bytes]of next.files)await fs.writeFile(path.join(image.f.execution,name),bytes);
      const prior=JSON.parse(Buffer.from(old.activationBytes)),approved=JSON.parse(Buffer.from(next.files.get('approved-preparation.json')));
      const activation={...prior,previousActivationId:prior.activationId,activationId:'abababab-ffff-4fff-8fff-abababababab',
        sequence:prior.sequence+1,preparationRevision:approved.preparationRevision,normativeSha256:approved.normativeSha256,
        approvedSnapshotSha256:'sha256:'+hash(next.files.get('approved-preparation.json')),
        artifacts:[...next.files].map(([name,bytes])=>({path:name,sha256:'sha256:'+hash(bytes)})).sort((a,b)=>a.path<b.path?-1:1),lastAttempt:null};
      await fs.writeFile(path.join(image.f.execution,'activation.json'),JSON.stringify(activation)+'\n');
    }
    const activation=JSON.parse(await fs.readFile(path.join(image.f.execution,'activation.json')));
    const files=new Map(await Promise.all(activation.artifacts.map(async item=>[item.path,await fs.readFile(path.join(image.f.execution,item.path))])));
    const snapshot=JSON.parse(files.get('approved-preparation.json'));
    const f={project:root,execution:image.f.execution,specPath:image.f.specPath,source:image.f.specPath,spec:path.dirname(image.f.specPath),
      authority:snapshot.requirementsAuthority,activation,snapshot,files,
      artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8)])),
      continuity:JSON.parse(files.get('continuity.json'))};
    await retireActive(f,[f.continuity.deliveries[0].slice]);
    const before=await tree(root),result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.completed.length,1);assert.equal(result.completed[0].observedValidation,'current');
    assert.equal(result.deliveries[0].observedValidation,'revalidation-required');
    if(exhausted) {assert.equal(result.state,'VALIDATION_BLOCKED');assert.equal(result.normalHandoff,null);}
    else assert.equal(result.normalHandoff.operation,'VALIDATE_SLICE');
    if(mode==='review') {assert.equal(result.deliveries[0].formalStatus,null);assert.equal(f.continuity.deliveries[0].normalization,null);}
    else if(mode==='s2-gap') {assert.equal(result.deliveries[0].formalStatus,null);assert.equal(f.continuity.deliveries[0].normalization,null);}
    else assert.equal(f.continuity.deliveries[0].normalization.status,exhausted?'exhausted':'settled');
    assert.deepEqual(await tree(root),before);
  });
});

test('C05 completed plus two historically bound active deliveries check real prior overlap',async t=>{
  await t.test('correct declaration preserves completed and both active proofs',async()=>using(overlappingActiveImage,async f=>{
    const before=literals(f),disk=await tree(f.project),result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.completed.length,1);assert.equal(result.completed[0].observedValidation,'current');
    assert.deepEqual(result.deliveries.map(item=>[item.slice,item.formalStatus,item.observedValidation]),
      [['slice-03','PASS','revalidation-required'],['slice-02','PASS','current']]);
    assert.equal(result.normalHandoff.slice,'slice-03');assert.equal(result.normalHandoff.operation,'VALIDATE_SLICE');
    assert.deepEqual(literals(f),before);assert.deepEqual(await tree(f.project),disk);
  }));
  for(const [name,declaration] of [['omitted','- none'],['false reference','- Slice 01 overlap: `../../../../verify/check.mjs`; False prior reference.']])
    await t.test(name,async()=>using(overlappingActiveImage,async f=>{
      editSection(f,'slice-02','Prior Validation Overlap',declaration);reseal(f);await writeImage(f);
      await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Prior Validation Overlap');
    }));
  await t.test('later BLOCKED outranks earlier drift and pending validation',async()=>using(
    ()=>overlappingActiveImage({status:'BLOCKED'}),async f=>{
      const result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.completed[0].observedValidation,'current');
      assert.equal(result.deliveries[0].observedValidation,'revalidation-required');
      assert.equal(result.deliveries[1].formalStatus,'BLOCKED');
      assert.equal(result.state,'VALIDATION_BLOCKED');assert.equal(result.normalHandoff,null);
    }));
});

test('C06 post-conversion sources also require overlap with earlier active PASS',async t=>{
  const f=await overlappingPostImage(t),before=literals(f),disk=await tree(f.project);
  const taskName='tasks/slice-02.md',original=Buffer.from(f.files.get(taskName));
  await t.test('correct declaration preserves all three original identities',async()=>{
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.completed.length,1);assert.equal(result.completed[0].observedValidation,'current');
    assert.deepEqual(result.deliveries.map(item=>[item.slice,item.formalStatus,item.observedValidation]),
      [['slice-03','PASS','revalidation-required'],['slice-02','PASS','current']]);
    assert.equal(result.normalHandoff.slice,'slice-03');assert.notEqual(result.state,'COMPLETE');
    assert.deepEqual(literals(f),before);assert.deepEqual(await tree(f.project),disk);
  });
  const relative=path.relative(path.join(f.execution,'tasks'),path.join(f.project,'other/greeting.mjs')).split(path.sep).join('/');
  for(const [name,declaration]of [['omitted','- none'],['false reference',`- Slice 01 overlap: \`${relative}\`; False prior reference.`]])
    await t.test(name,async()=>{
      try {
        editSection(f,'slice-02','Prior Validation Overlap',declaration);reseal(f);await writeImage(f);
        await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Prior Validation Overlap');
      } finally {f.files.set(taskName,original);reseal(f);await writeImage(f);}
    });
  await t.test('later post-conversion BLOCKED dominates earlier drift',async t=>{
    const blocked=await overlappingPostImage(t,{status:'BLOCKED'}),result=await inspectCurrentExecution(blocked.specPath);
    assert.equal(result.completed[0].observedValidation,'current');assert.equal(result.deliveries[0].observedValidation,'revalidation-required');
    assert.equal(result.deliveries[1].formalStatus,'BLOCKED');assert.equal(result.state,'VALIDATION_BLOCKED');assert.equal(result.normalHandoff,null);
  });
});

test('C04 distributed fresh processes have no writes, dispatch or historical-source access',async t=>{
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const worker=path.join(repo,'scripts/fixtures/current-quiet-reader.mjs');
  for(const kind of ['APPLY_PASS','INITIAL_REFUSAL','all-completed'])await t.test(kind,async()=>using(
    ()=>campaignImage({kind:kind==='all-completed'?'PASS':kind}),async f=>{
      if(kind==='all-completed')await retireActive(f);
      const expected=await inspectCurrentExecution(f.specPath),before=await tree(f.project);
      for(const skill of ['stnl-slice-executor','stnl-slice-quality-manager']) {
        const selected=path.join(repo,'skills/workflows',skill,'runtime/execution-current-reader.mjs');
        const log=path.join(f.temporary,'campaign-worker-'+skill+'.json');
        const result=spawnSync(process.execPath,[worker,'--worker','api',selected,f.specPath,log,f.project],
          {encoding:'utf8',timeout:20000,env:{...process.env,STNL_QUIET_PROFILE:'evidence',STNL_QUIET_ACTIVE_PROOF:'1'}});
        assert.equal(result.status,0,result.stderr);const observed=JSON.parse(await fs.readFile(log));
        assert.deepEqual(observed.attempts,[]);assert.deepEqual(observed.result,expected);
        const cliLog=log+'.cli';
        const cli=spawnSync(process.execPath,['--import',worker,selected,f.specPath],{encoding:'utf8',timeout:20000,
          env:{...process.env,STNL_QUIET_PROFILE:'evidence',STNL_QUIET_ACTIVE_PROOF:'1',STNL_QUIET_PRELOAD:'1',
            STNL_QUIET_LOG:cliLog,STNL_QUIET_PROJECT:f.project}});
        assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),expected);
        assert.deepEqual(JSON.parse(await fs.readFile(cliLog)).attempts,[]);
      }
      assert.deepEqual(await tree(f.project),before);
    }));
});
