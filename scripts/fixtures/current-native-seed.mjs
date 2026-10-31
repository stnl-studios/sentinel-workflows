// Mechanical EC-1 seed for state tests. It never creates or converts an older
// execution. Counters/diagnostics below are authored setup, not native proof or
// an official replacement-set producer. Live acceptance needs official agents.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initialArtifacts,REQUIREMENTS} from './current-initial-preparation.mjs';
import {projectCurrentPreparation,approveCurrentPreparation,validateCurrentPreparation} from '../../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs';
import {resolveCurrentExecutionContext} from '../../skills/workflows/stnl-execution-planner/runtime/execution-workspace.mjs';
import {inspectCurrentExecution,observeCurrentDeliveryWork} from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

const run=promisify(execFile),json=x=>Buffer.from(JSON.stringify(x)+'\n');
const raw=x=>`sha256:${createHash('sha256').update(x).digest('hex')}`;
const section=(text,name,body)=>text.replace(new RegExp(`(^## ${name}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu'),(_,head)=>head+body+'\n\n');

export async function currentImage(test,{kind='native-s1',sharedInput=false,sharedInputAll=false,behaviorCheck=false,spaces=false,independent=false,documentarySource=null}={}) {
  if(!['native-s1','managed-s1','managed-s2','two-s2','three-s2','s0','disjoint-s0'].includes(kind))throw new Error('unknown current seed profile');
  if(independent&&kind!=='two-s2')throw new Error('independent source setup requires the two-s2 fixture');
  const parent=path.resolve(spaces?'tmp/current seeds with spaces':'tmp/current-seeds');await fs.mkdir(parent,{recursive:true});
  const root=await fs.realpath(await fs.mkdtemp(path.join(parent,'ec1-')));
  test?.after(()=>fs.rm(root,{recursive:true,force:true}));
  const specPath=path.join(root,documentarySource?'spec/feature_spec.md':spaces?'docs/área Ω/requirements.md':'requirements.md');
  await fs.mkdir(path.dirname(specPath),{recursive:true});
  if(documentarySource)await fs.cp(documentarySource,path.dirname(specPath),{recursive:true});
  else await fs.writeFile(specPath,independent
    ?'# Current greeting\n\nAC-001: Export the src greeting and verify it by its prepared node test.\nAC-002: Export the independent other greeting and verify it by its prepared node test.\n'
    :'# Current greeting\n\nAC-001: Export a deterministic greeting and verify it by node --test.\n');
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  await run('git',['-C',root,'init','-q']);
  await run('git',['-C',root,'-c','user.name=Current Seed','-c','user.email=current-seed@example.invalid','commit','--allow-empty','-qm','mechanical current fixture Git identity']);
  const before=await inspectCurrentExecution(specPath),{context}=await resolveCurrentExecutionContext(specPath);
  const execution=context.logicalExecutionRoot,three=kind==='three-s2',two=kind.startsWith('two-')||three||kind==='disjoint-s0';
  const secondTest=spaces?'greeting test.mjs':'greeting.test.mjs',secondProduct=spaces?'greeting output.mjs':'greeting.mjs';
  for(const dir of two?['src','other']:['src']) {
    await fs.mkdir(path.join(root,dir));
    const product=dir==='other'?secondProduct:'greeting.mjs',testName=dir==='other'?secondTest:'greeting.test.mjs';
    await fs.writeFile(path.join(root,dir,product),'export const greeting="hello";\n');
    await fs.writeFile(path.join(root,dir,testName),`import assert from 'node:assert/strict';import {greeting} from ${JSON.stringify('./'+product)};assert.equal(greeting,'hello');\n`);
  }
  if(sharedInput)await fs.writeFile(path.join(root,'shared-config.json'),'{"greeting":"shared"}\n');
  const artifacts=new Map();
  for(const [name,bytes] of initialArtifacts({form:documentarySource?'lifecycle':'standalone'})) {
    if(!two&&/slice-02/.test(name))continue;
    let text=bytes.toString().replaceAll(REQUIREMENTS,before.requirementsAuthority).replaceAll('Pay','Greeting').replaceAll('pay','greeting').replaceAll('- Plan revision: 1','- Plan revision: 2');
    const second=name.includes('slice-02'),directory=second?'other':'src',base=path.dirname(path.join(execution,name));
    const relative=x=>path.relative(base,path.join(root,x)).split(path.sep).join('/');
    text=text.replaceAll('../../../../src',relative('src')).replaceAll('../../../src',relative('src'));
    if(/^(plans|tasks)\//.test(name)) {
      const product=second?secondProduct:'greeting.mjs',testName=second?secondTest:'greeting.test.mjs';
      const deliveryInput=sharedInput&&(!two||second||sharedInputAll);
      const input=deliveryInput?[{kind:'input',path:relative('shared-config.json')}]:[];
      const recipe={format:'stnl-verification-recipe-v1',base:'workspace',cwd:'.',checks:[{id:'verification-01',executable:{literal:'node'},args:[{literal:'--test'},{file:{kind:'product',path:relative(directory+'/'+testName)}}],inputs:input}],dependencyReview:'Reviewed the exact current test, imported product module and any declared shared input.'};
      if(!behaviorCheck){recipe.checks[0].args=[{literal:'-e'},{literal:'if (2 + 2 !== 4) process.exit(1)'}];recipe.dependencyReview='Mechanical current-state fixture: reviewed literal arithmetic check; not a claim of greeting behavior coverage.';}
      for(const [heading,body] of Object.entries({'Authorized Areas':`- directory: \`${relative(directory)}\``,'Expected Files':`- \`${relative(directory+'/'+product)}\``,'Existing Inputs':deliveryInput?`- \`${relative('shared-config.json')}\``:'- none','Verification Recipe':'- Recipe: '+JSON.stringify(recipe),'Expected Tests':behaviorCheck?'- node --test '+JSON.stringify(directory+'/'+testName):'- Reviewed literal arithmetic check (mechanical fixture only)'}))text=section(text,heading,body);
      if(!two&&name.startsWith('tasks/'))text=section(text,'Acceptance Obligations','- obligation-01 | requirement: AC-001 | contribution: complete | full owner: slice-01 | condition: Greeting is observed | proof: Prepared node test');
      text=section(text,'Continuity',`- Current validation: ${kind.endsWith('s0')?'unvalidated':'revalidation-required'}\n- Current evidence: none\n- Current action: ${kind.endsWith('s0')?'implement approved delivery':'validate'}`);
    }
    if(name==='plan.md') {
      if(!two)text=text.split('\n').filter(line=>!line.includes('| 02 - Verification |')).join('\n');
      else text=text.split('\n').map(line=>line.includes('| 02 - Verification |')?line.replace(/directory: `[^`]+`/u,`directory: \`${relative('other')}\``):line).join('\n');
    }
    if(name==='tasks.md'&&!two)text=text.split('\n').filter(line=>!line.includes('| 02 - Verification |')).join('\n');
    if(independent) {
      if(second) {
        text=text.replaceAll('AC-001','AC-002');
        if(name.startsWith('plans/'))text=section(text,'Dependencies','- none');
      } else if(name==='tasks/slice-01.md') {
        text=text.replace('contribution: partial | full owner: slice-02','contribution: complete | full owner: slice-01');
      }
      if(name==='plan.md'||name==='tasks.md')text=text.split('\n').map(line=>line.includes('| 02 - Verification |')
        ?line.replace('| slice-01 |','| - |').replace('AC-001','AC-002'):line).join('\n');
    }
    artifacts.set(name,Buffer.from(text));
  }
  if(three) {
    const thirdId=randomUUID();await fs.mkdir(path.join(root,'third'));await fs.mkdir(path.join(root,'fourth'));await fs.writeFile(path.join(root,'fourth/state.mjs'),'export const state=1;\n');
    for(const group of ['plans','tasks']) {
      const name=`${group}/slice-02.md`,text=artifacts.get(name).toString();
      const third=text.replaceAll('slice-02','slice-03').replaceAll('Slice 02','Slice 03').replace('- Slice: 02','- Slice: 03').replaceAll(' - Verification',' - Additional').replace(/^- Delivery ID: .+$/mu,'- Delivery ID: '+thirdId).replace('contribution: complete | full owner: slice-03','contribution: partial | full owner: slice-02');
      const relative=x=>path.relative(path.join(execution,group),path.join(root,x)).split(path.sep).join('/');
      artifacts.set(`${group}/slice-03.md`,Buffer.from(section(third,'Authorized Areas',`- directory: \`${relative('other')}\`\n- directory: \`${relative('fourth')}\``)));
      let second=section(text,'Authorized Areas',`- directory: \`${relative('other')}\`\n- directory: \`${relative('third')}\``);
      if(group==='plans')second=section(second,'Dependencies','- slice-01\n- slice-03');
      artifacts.set(name,Buffer.from(second));
    }
    for(const name of ['plan.md','tasks.md']) {
      const text=artifacts.get(name).toString(),row=text.split('\n').find(line=>line.includes('02 - Verification'));
      let third=row.replace('02 - Verification','03 - Additional').replaceAll('slice-02.md','slice-03.md');
      let second=row.replace('| slice-01 |','| slice-01, slice-03 |');
      if(name==='plan.md'){
        const relative=x=>path.relative(execution,path.join(root,x)).split(path.sep).join('/');
        third=third.replace(/directory: `[^`]+`/u,x=>x+`; directory: \`${relative('fourth')}\``);
        second=second.replace(/directory: `[^`]+`/u,x=>x+`; directory: \`${relative('third')}\``);
      }
      artifacts.set(name,Buffer.from(text.replace(row,third+'\n'+second)));
    }
  }
  const continuity={format:'stnl-delivery-continuity-v2',nextSliceOrdinal:three?4:two?3:2,deliveries:[],completed:[]};
  const projected=projectCurrentPreparation({context,requirementsAuthority:before.requirementsAuthority,artifacts});
  for(const d of projected.deliveries)continuity.deliveries.push({slice:d.slice,deliveryId:d.deliveryId,localRevision:1,authoritySha256:d.authoritySha256,validation:'unvalidated',evidence:null,counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},baseline:{format:'stnl-current-work-v1',entries:[]},normalization:null,lastDiagnostic:null});
  const hashes=new Map(projected.artifactHashes.map(x=>[x.path,x.sha256]));
  const decision=(scope,digest,names)=>({scope,decision:'approved',authoritySha256:digest,examinedArtifactHashes:names.sort().map(name=>({path:name,sha256:hashes.get(name)})),evidenceDecisions:[],summary:'Mechanical review seed of exact EC-1 artifacts; not independent native acceptance.'});
  const review={globalReview:decision('set',projected.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:projected.deliveries.map(d=>({deliveryId:d.deliveryId,review:decision('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};
  const approved=approveCurrentPreparation({context,requirementsAuthority:before.requirementsAuthority,artifacts:new Map([...artifacts,['continuity.json',json(continuity)]]),review});
  const prepared=validateCurrentPreparation({context,requirementsAuthority:before.requirementsAuthority,snapshotBytes:approved.bytes,artifacts,profile:'converted-current'});
  for(const [i,d] of continuity.deliveries.entries()) {
    d.baseline=(await observeCurrentDeliveryWork({context,delivery:approved.snapshot.normativeProjection.deliveries[i],sections:prepared.currentArtifacts.deliveries[i].sections,current:d,bundle:null})).manifest;
    if(!kind.endsWith('s0')) {
      // Authored high-water marks of the opaque current S2 boundary, not
      // imported receipts or a claim of native implementation proof.
      d.validation='revalidation-required';d.counters.validationAttempts=1;d.counters.implementationChecks=1;
      d.lastDiagnostic={code:'EVIDENCE_INCOMPLETE',reason:'Mechanical current EC-1 boundary requires fresh validation; no older-format receipt imported.',affectedPaths:[],operationAttemptId:randomUUID(),nextAction:'validate'};
    }
  }
  const files=new Map([...artifacts,['approved-preparation.json',Buffer.from(approved.bytes)],['continuity.json',json(continuity)]]);
  const activation={format:'stnl-execution-activation-v2',activationId:randomUUID(),sequence:1,previousActivationId:null,preparationRevision:2,requirementsAuthority:before.requirementsAuthority,normativeSha256:approved.snapshot.normativeSha256,approvedSnapshotSha256:raw(approved.bytes),artifacts:[...files].map(([name,bytes])=>({path:name,sha256:raw(bytes)})).sort((a,b)=>a.path<b.path?-1:1),activeAttempt:null,lastAttempt:null};
  for(const d of continuity.deliveries)if(d.lastDiagnostic){const name=`tasks/${d.slice}.md`;files.set(name,Buffer.from(section(files.get(name).toString(),'Continuity','- Current validation: revalidation-required\n- Current evidence: none\n- Current action: validate')));}
  activation.artifacts=[...files].map(([name,bytes])=>({path:name,sha256:raw(bytes)})).sort((a,b)=>a.path<b.path?-1:1);
  for(const [name,bytes] of [...files,['activation.json',json(activation)]]){const target=path.join(execution,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
  const f={root,specPath,execution},input={context,requirementsAuthority:before.requirementsAuthority};
  return {f,input,candidate:{files},activation,seed:'Authored current EC-1 preparation and boundary only; no conversion, transport or official replacement proof.'};
}
