// Synthetic semantic judgments; real recipe processes, official reader/runner.
// No live model acceptance and no SQL isolation claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChildProcess,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initialArtifacts,REQUIREMENTS} from './current-initial-preparation.mjs';
import {installCurrentInitial} from './synthetic-preparation-approval.mjs';
import {projectInitialPreparation} from '../../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {resolveCurrentExecutionContext} from '../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {payload} from './current-initial-evidence.mjs';
import {normalizedFormal} from './current-native-normalization.mjs';
import {captureCurrentExecution,inspectCurrentExecution} from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

const run=promisify(execFile);
export async function fixture(t,exact,{single=false,unknown=false,membership=false,third=false}={}) {
  const root=await fs.mkdtemp(path.resolve('tmp/compact-plan-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await run('git',['-C',root,'init','-q']);
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  const specPath=path.join(root,'specs/pay/requirements.md');
  await fs.mkdir(path.dirname(specPath),{recursive:true});await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(specPath,'# Synthetic pay\n\nAC-001: Both pay exports return paid.\n');
  await fs.writeFile(path.join(root,'shared.mjs'),'export const expected="paid";\n');
  for(const suffix of ['','-02']) {
    await fs.writeFile(path.join(root,`src/pay${suffix}.mjs`),'export const pay=()=>"paid";\n');
    await fs.writeFile(path.join(root,`src/pay${suffix}.test.mjs`),`import assert from 'node:assert/strict';import {pay} from './pay${suffix}.mjs';import {expected} from '../shared.mjs';assert.equal(pay(),expected);${unknown?'assert.equal(process.env.STNL_COMPACT_UNDECLARED ?? \"good\",\"good\");':membership?'const {readdirSync}=await import(\"node:fs\");assert.equal(readdirSync(new URL(\".\",import.meta.url)).length,4);':''}\n`);
  }
  const before=await inspectCurrentExecution(specPath),{context}=await resolveCurrentExecutionContext(specPath);
  const artifacts=new Map();
  const templates=initialArtifacts({form:'standalone'});
  if(third)for(const group of ['plans','tasks'])templates.set(`${group}/slice-03.md`,Buffer.from(templates.get(`${group}/slice-02.md`).toString()
    .replaceAll('slice-02','slice-03').replaceAll('Slice 02','Slice 03').replace('- Slice: 02','- Slice: 03')
    .replaceAll('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333')));
  for(const [name,bytes] of templates) {
    if(single&&name.includes('slice-02'))continue;
    let text=bytes.toString().replaceAll(REQUIREMENTS,before.requirementsAuthority);
    if(single)text=text.split('\n').filter(line=>!line.includes('| 02 - Verification |')).join('\n').replaceAll('contribution: partial | full owner: slice-02','contribution: complete | full owner: slice-01');
    if(third){
      if(name.includes('slice-03'))text=text.replace('## Dependencies\n\n- slice-01','## Dependencies\n\n- slice-02');
      else text=text.replaceAll('full owner: slice-02','full owner: slice-03').replace('contribution: complete','contribution: partial');
      if(name==='plan.md'||name==='tasks.md'){
        const row=text.split('\n').find(line=>line.includes('| 02 - Verification |'));
        text=text.replace(row,row+'\n'+row.replace('02 - Verification','03 - Verification').replaceAll('slice-02.md','slice-03.md').replace('| slice-01 |','| slice-02 |'));
      }
    }
    const suffix=name.includes('slice-03')?'-03':name.includes('slice-02')?'-02':'';
    if(suffix)text=text.replaceAll('src/pay.','src/pay'+suffix+'.');
    if(/^(plans|tasks)\//.test(name)) {
      text=text.replace('## Existing Inputs\n\n- none','## Existing Inputs\n\n- `../../../../shared.mjs`');
      text=text.replace(/^- Recipe: (.+)$/mu,(_,json)=>{const r=JSON.parse(json);r.checks[0].inputs=[{kind:'input',path:'../../../../shared.mjs'}];r.dependencyReview=unknown?'ADVERSARIAL FIXTURE: deliberately incomplete review omits a runtime environment read; not a valid independence claim.':membership?'Inspected imports and actual directory enumeration; directory membership must remain observed.':'Inspected static test imports: its exact pay module, shared.mjs and Node built-in assert only. No directory enumeration, glob, mutable database or dynamic input in this synthetic fixture.';return '- Recipe: '+JSON.stringify(r);});
      if(exact){text=text.replace('- directory: `../../../../src`',`- file: \`../../../../src/pay${suffix}.mjs\`\n- file: \`../../../../src/pay${suffix}.test.mjs\``);}
    }
    if(exact&&name==='plan.md')text=text.split('\n').map(line=>{
      if(!line.includes('directory:'))return line;const suffix=line.includes('| 03 -')?'-03':line.includes('| 02 -')?'-02':'';
      return line.replace('directory: `../../../src`',`file: \`../../../src/pay${suffix}.mjs\`; file: \`../../../src/pay${suffix}.test.mjs\``);
    }).join('\n');
    artifacts.set(name,Buffer.from(text));
  }
  const authority=projectInitialPreparation({context,requirementsAuthority:before.requirementsAuthority,artifacts});
  const hashes=new Map(authority.artifactHashes.map(x=>[x.path,x.sha256]));
  const decision=(scope,authoritySha256,names)=>({scope,decision:'approved',authoritySha256,examinedArtifactHashes:names.sort().map(path=>({path,sha256:hashes.get(path)})),evidenceDecisions:[],summary:'Synthetic exact-byte review; not live agent acceptance.'});
  const review={globalReview:decision('set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:authority.deliveries.map(d=>({deliveryId:d.deliveryId,review:decision('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};
  const preparationRoot=path.join(root,'reviewed');
  for(const [name,bytes] of artifacts){const target=path.join(preparationRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
  await run('git',['-C',root,'add','specs','src','shared.mjs']);
  await run('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','synthetic initial']);
  await installCurrentInitial({root,specPath,preparationRoot,review});
  return {root,specPath,image:{f:{execution:context.logicalExecutionRoot}}};
}
export async function implement(f,delivery,{create=false,beginOptions={},afterBegin=null,status="TESTS_PASS"}={}) {
  const before=await captureCurrentExecution(f.specPath);
  const start=await begin({specPath:f.specPath,slice:delivery.slice,operation:'EXECUTE_SLICE',expectedActivationId:before.inspection.activationId,...beginOptions});
  if(afterBegin)await afterBegin(start);
  if(create){
    await fs.writeFile(path.join(f.root,'src/pay-03.mjs'),'export const pay=()=>"paid";\n');
    await fs.writeFile(path.join(f.root,'src/pay-03.test.mjs'),"import assert from 'node:assert/strict';import {pay} from './pay-03.mjs';import {expected} from '../shared.mjs';assert.equal(pay(),expected);\n");
  }
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'}),agentId='synthetic-'+delivery.slice;
  await bindNative(start.handle,agentId);const measured=await verifyNative(dispatch.originFile);
  const {head,...result}=payload(1,status,status==="TESTS_FAIL"?1:0);result.commands=measured.commands;result.automaticCheckRound='1/5';
  const tool=path.join(f.root,'execute-'+delivery.slice+'.json');
  await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result})}));
  await captureNative(start.handle,tool);const published=await publish(start.handle);return {start,published};
}

