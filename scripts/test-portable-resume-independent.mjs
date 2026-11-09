// Independent synthetic protocol regression. No live agent or database claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ChildProcess} from 'node:child_process';
import {fixture,implement} from './fixtures/portable-resume-independent.mjs';
import * as controller from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
const controls=['activation.json','approved-preparation.json','continuity.json'];
const sha=b=>createHash('sha256').update(b).digest('hex');
async function snapshot(root){const result={};for(const e of await fs.readdir(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isDirectory()){for(const [n,v] of Object.entries(await snapshot(p)))result[e.name+'/'+n]=v;}else result[e.name]=sha(await fs.readFile(p));}return result;}
async function inspect(f,slice='slice-01',operation='EXECUTE_SLICE'){if(controller.inspectRequestedOperation)return controller.inspectRequestedOperation({specPath:f.specPath,slice,operation});return controller.inspect(f.specPath);}
function reviewOf(a){const h=new Map(a.artifactHashes.map(x=>[x.path,x.sha256]));const r=(scope,authoritySha256,names)=>({scope,decision:'approved',authoritySha256,examinedArtifactHashes:names.sort().map(path=>({path,sha256:h.get(path)})),evidenceDecisions:[],summary:'Synthetic current-byte review, not historical approval.'});return {globalReview:r('set',a.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:a.deliveries.map(d=>({deliveryId:d.deliveryId,review:r('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};}
async function run(f,decision,slice='slice-01',operation='EXECUTE_SLICE',status='TESTS_PASS'){const prepared=await controller.prepareDocumentaryResumption({specPath:f.specPath,slice,operation,expectedDecisionSha256:decision.decisionSha256});const installed=await controller.installDocumentaryResumption({handle:prepared.handle,review:reviewOf(prepared.authority)});const next=installed.inspection.normalHandoff;await implement(f,{slice:next.slice},{status});return {installed,inspection:await controller.inspect(f.specPath)};}
async function remove(f,names=controls){for(const name of names)await fs.rm(path.join(f.image.f.execution,name));}
function count(t){const calls=[],original=ChildProcess.prototype.spawn;ChildProcess.prototype.spawn=function(o){if(o.args?.some(x=>/src\/pay(?:-02)?\.test\.mjs$/.test(String(x))))calls.push(o.args);return original.call(this,o);};t.after(()=>{ChildProcess.prototype.spawn=original;});return calls;}
test('missing controls individually and together still permit selected documentary entry',async t=>{
 const f=await fixture(t,true,{single:true}),saved=new Map(await Promise.all(controls.map(async n=>[n,await fs.readFile(path.join(f.image.f.execution,n))])));
 for(const names of [...controls.map(n=>[n]),controls])await t.test(names.join('+'),async()=>{for(const[n,b]of saved)await fs.writeFile(path.join(f.image.f.execution,n),b);await remove(f,names);const before=await snapshot(f.image.f.execution);const decision=await inspect(f);assert.equal(decision.mode,'documentary-resumption');assert.equal(decision.historicalBudget,'unknown');assert.equal(decision.historicalProof,'unverified');assert.deepEqual(await snapshot(f.image.f.execution),before,'inspection must not rewrite source/proof');});
});
test('new physical root with only documentary execution and code runs fresh real recipe once',async t=>{
 const source=await fixture(t,true,{single:true});const root=await fs.mkdtemp(path.resolve('tmp/portable-other-root-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.cp(source.root,root,{recursive:true,filter:p=>!p.includes('/tmp/')||p.startsWith(source.root)});
 // Preserve git, requirements, code and Markdown. Drop controls, local namespaces and reviewed preparation copies.
 await fs.rm(path.join(root,'tmp'),{recursive:true,force:true});await fs.rm(path.join(root,'reviewed'),{recursive:true,force:true});
 const f={root,specPath:path.join(root,path.relative(source.root,source.specPath)),image:{f:{execution:path.join(root,path.relative(source.root,source.image.f.execution))}}};await remove(f);
 const before=await snapshot(f.image.f.execution),sourceBefore=await snapshot(source.image.f.execution),calls=count(t);const decision=await inspect(f);
 assert.equal(decision.historicalBudget,'unknown');const outcome=await run(f,decision);assert.equal(calls.length,1,'exactly one physical recipe invocation; narrated checks are not proof');
 assert.deepEqual(await snapshot(outcome.installed.retainedBackup),before);assert.deepEqual(await snapshot(source.image.f.execution),sourceBefore);
 await assert.rejects(run(f,decision));assert.equal(calls.length,1,'second invocation must not silently reset unknown historical budget');t.diagnostic(JSON.stringify({physicalRecipeInvocations:calls.length}));
});
test('stale documentary decision must refuse changed approved scope before launching',async t=>{
 const f=await fixture(t,true,{single:true});await remove(f);const decision=await inspect(f),calls=count(t);await fs.appendFile(path.join(f.image.f.execution,'plans/slice-01.md'),'\nUnreviewed scope change.\n');await assert.rejects(run(f,decision));assert.equal(calls.length,0);
});
test('a failed actual recipe is not promoted by Tasks checkmarks or narrated PASS',async t=>{
 const f=await fixture(t,true,{single:true});await remove(f);await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"broken";\n');
 const file=path.join(f.image.f.execution,'tasks/slice-01.md');await fs.writeFile(file,(await fs.readFile(file,'utf8')).replaceAll('[ ]','[x]'));
 const calls=count(t),decision=await inspect(f);const outcome=await run(f,decision,'slice-01','EXECUTE_SLICE','TESTS_FAIL');assert.equal(calls.length,1);assert.equal(outcome.inspection.deliveries[0].auxiliaryStatus,'TESTS_FAIL');assert.notEqual(outcome.inspection.deliveries[0].formalStatus,'PASS');t.diagnostic(JSON.stringify({physicalRecipeInvocations:calls.length,outcome}));
});
test('intact normal image retains original controller contract',async t=>{const f=await fixture(t,true,{single:true});const old=await controller.inspect(f.specPath);const result=await inspect(f);assert.notEqual(result.mode,'documentary-resumption');assert.equal(result.inspection.activationId,old.activationId);});
test('existing local operation owner blocks documentary takeover without altering owner bytes',async t=>{
 const f=await fixture(t,true,{single:true}),old=await controller.inspect(f.specPath);
 const active=await controller.begin({specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE',expectedActivationId:old.activationId});
 await remove(f);const before=await snapshot(path.join(f.root,'tmp')),calls=count(t);
 await assert.rejects(async()=>{const decision=await inspect(f);await run(f,decision);},e=>/owner|active|uncertain|occupied|operation/i.test(e.code+' '+e.message));
 assert.equal(calls.length,0);assert.deepEqual(await snapshot(path.join(f.root,'tmp')),before);assert.ok(active.handle);
});
test('unknown selected slice and lost task source refuse before physical invocation',async t=>{
 const f=await fixture(t,true,{single:true});await remove(f);const calls=count(t);
 await assert.rejects(()=>inspect(f,'slice-99'));await fs.rm(path.join(f.image.f.execution,'tasks/slice-01.md'));
 await assert.rejects(()=>inspect(f),e=>/task|document|missing|source/i.test(e.code+' '+e.message));assert.equal(calls.length,0);
});
test('target plus dependency require fresh real checks, including changed mutable environment',async t=>{
 const prior=process.env.STNL_COMPACT_UNDECLARED;t.after(()=>{if(prior===undefined)delete process.env.STNL_COMPACT_UNDECLARED;else process.env.STNL_COMPACT_UNDECLARED=prior;});
 const f=await fixture(t,true,{unknown:true});await remove(f);const before=await snapshot(f.image.f.execution),calls=count(t);process.env.STNL_COMPACT_UNDECLARED='changed';
 const decision=await inspect(f,'slice-02');assert.equal(decision.historicalProof,'unverified');const outcome=await run(f,decision,'slice-02','EXECUTE_SLICE','TESTS_FAIL');
 assert.ok(calls.length>=1&&calls.length<=2,'stop after failed dependency or check dependency and target once each');assert.equal(outcome.inspection.deliveries[0].auxiliaryStatus,'TESTS_FAIL');assert.notEqual(outcome.inspection.deliveries[0].formalStatus,'PASS');assert.deepEqual(await snapshot(outcome.installed.retainedBackup),before);t.diagnostic(JSON.stringify({physicalRecipeInvocations:calls.length,outcome}));
});
