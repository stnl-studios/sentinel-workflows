// Public native-operation regression with newly authored Python/SQLite scripts.
// This proves same-operation replay, NOT reuse between phases or SQL Server QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
import {initialArtifacts,REQUIREMENTS} from './fixtures/current-initial-preparation.mjs';
import {payload} from './fixtures/current-initial-evidence.mjs';
import {installCurrentInitial} from './fixtures/synthetic-preparation-approval.mjs';
import {projectInitialPreparation} from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs';
import {inspectCurrentExecution,captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {resolveCurrentExecutionContext} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,validateNativeResponse,captureNative,publish} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
const run=promisify(cp.execFile);
const PYTHON_CHECK_FLAGS=Object.freeze(['-E','-B']);
async function fixture(t,python) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-native-python-sql-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'specs/pay'),{recursive:true});await fs.cp('scripts/fixtures/python-sql-campaign',path.join(root,'src'),{recursive:true});
 const specPath=path.join(root,'specs/pay/requirements.md');await fs.writeFile(specPath,'# Synthetic local SQL checks\n\nAC-001: Schema, import/history/summary and rebuild preservation are verified against new SQLite memory databases.\n');
 await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');await run('git',['init','-q',root]);await run('git',['-C',root,'add','.gitignore','specs/pay/requirements.md','src']);await run('git',['-C',root,'-c','user.name=Synthetic fixture','-c','user.email=fixture@example.invalid','commit','-qm','synthetic SQL baseline']);
 const initial=await inspectCurrentExecution(specPath),{context}=await resolveCurrentExecutionContext(specPath);
 const recipe={format:'stnl-verification-recipe-v1',base:'workspace',cwd:'.',dependencyReview:'Synthetic recipe: real Python stdlib and isolated SQLite memory checks; schema/project Pre/Post and seed are inside the observed source domain. No cross-phase cache claim.',
  checks:['schema','import','rebuild'].map((name,index)=>({id:'verification-0'+(index+1),executable:{literal:python},args:[...PYTHON_CHECK_FLAGS.map(literal=>({literal})),{file:{kind:'product',path:'../../../../src/checks/check_'+name+'.py'}}],inputs:[]}))};
 const artifacts=new Map([...initialArtifacts({form:'standalone'})].filter(([name])=>!name.includes('slice-02')).map(([name,bytes])=>{
  const text=bytes.toString().replaceAll(REQUIREMENTS,initial.requirementsAuthority).split('\n').filter(line=>!line.includes('| 02 - Verification |')).map(line=>line.startsWith('- Recipe: ')?'- Recipe: '+JSON.stringify(recipe):line).join('\n').replaceAll('contribution: partial | full owner: slice-02','contribution: complete | full owner: slice-01').replaceAll('../../../../src/pay.mjs','../../../../src/checks/check_schema.py').replaceAll('node --test src/pay.test.mjs','Python/SQLite synthetic schema, import and rebuild checks');return [name,Buffer.from(text)];
 }));
 const projected=projectInitialPreparation({context,requirementsAuthority:initial.requirementsAuthority,artifacts}),hashes=new Map(projected.artifactHashes.map(item=>[item.path,item.sha256]));
 const decision=(scope,authoritySha256,names)=>({scope,decision:'approved',authoritySha256,examinedArtifactHashes:names.sort().map(name=>({path:name,sha256:hashes.get(name)})),evidenceDecisions:[],summary:'Reviewed exact synthetic Python/SQLite recipe bytes.'});
 const review={globalReview:decision('set',projected.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:projected.deliveries.map(d=>({deliveryId:d.deliveryId,review:decision('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};
 const preparationRoot=path.join(root,'reviewed');for(const [name,bytes] of artifacts){const file=path.join(preparationRoot,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
 await installCurrentInitial({specPath,preparationRoot,review});return {root,specPath};
}
async function open(f,operation,agentId) {
 const image=await inspectCurrentExecution(f.specPath),operationState=await begin({specPath:f.specPath,slice:'slice-01',operation,expectedActivationId:image.activationId});
 const dispatch=await reserveDispatch(operationState.handle,{responseVariant:'stnl-current-native-judgment-v1'});await bindNative(operationState.handle,agentId);
 return {...operationState,dispatch,agentId};
}
async function finish(f,operation,response) {
 const tool=path.join(f.root,operation.agentId+'.json');await fs.writeFile(tool,JSON.stringify({agentId:operation.agentId,status:'completed',finalResponse:JSON.stringify(response)}));
 await captureNative(operation.handle,tool);assert.equal((await captureNative(operation.handle,tool)).replayed,true);await publish(operation.handle);
}
test('synthetic Python checks refuse optimized assertions and the native flags preserve functional failure',async t=>{
 const python=await fs.realpath((await run('python3',['-I','-S','-c','import sys;print(sys.executable)'])).stdout.trim());
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'stnl-python-assertions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.cp('scripts/fixtures/python-sql-campaign',root,{recursive:true});
 const script=path.join(root,'checks/check_schema.py');
 for(const optimize of ['1','2']) {
  const env={...process.env,PYTHONOPTIMIZE:optimize};
  for(const name of ['schema','import','rebuild'])await assert.rejects(run(python,['-B',path.join(root,'checks/check_'+name+'.py')],{env}),error=>{
   assert.equal(error.code,1);assert.match(error.stderr,/synthetic SQL checks require enabled assertions/);assert.doesNotMatch(error.stdout,/PASS/);return true;
  });
  assert.match((await run(python,[...PYTHON_CHECK_FLAGS,script],{env})).stdout,/schema.*PASS/);
 }
 await fs.appendFile(script,'\nassert False, "synthetic functional assertion must execute"\n');
 for(const optimize of ['1','2'])await assert.rejects(run(python,[...PYTHON_CHECK_FLAGS,script],{env:{...process.env,PYTHONOPTIMIZE:optimize}}),error=>{
  assert.equal(error.code,1);assert.match(error.stderr,/AssertionError: synthetic functional assertion must execute/);return true;
 });
});

test('real Python/SQLite recipes execute once during envelope repairs in each operation; VALIDATE still reruns independently',async t=>{
 const inheritedOptimization=process.env.PYTHONOPTIMIZE;process.env.PYTHONOPTIMIZE='1';t.after(()=>{if(inheritedOptimization===undefined)delete process.env.PYTHONOPTIMIZE;else process.env.PYTHONOPTIMIZE=inheritedOptimization;});
 const python=await fs.realpath((await run('python3',['-I','-S','-c','import sys;print(sys.executable)'])).stdout.trim()),f=await fixture(t,python);
 const original=cp.execFile;let executions=0;
 cp.execFile=function(executable,args,...rest){if(executable===python&&args.some(arg=>/^src\/checks\/check_(schema|import|rebuild)\.py$/u.test(String(arg))))executions++;return original.call(this,executable,args,...rest);};syncBuiltinESMExports();t.after(()=>{cp.execFile=original;syncBuiltinESMExports();});
 const execution=await open(f,'EXECUTE_SLICE','synthetic-python-author');await fs.writeFile(path.join(f.root,'src/implemented.txt'),'Synthetic source delivery verified.\n');
 const measured=await verifyNative(execution.dispatch.originFile);assert.equal(executions,3);assert.ok(measured.commands.every(item=>item.exit===0));
 const verificationFile=execution.dispatch.originFile.replace('.origin.json','.verification.json'),sourceBytes=await fs.readFile(verificationFile),observationBytes=await fs.readFile(measured.observationFile);
 const originalChecks=JSON.parse(sourceBytes).checks;assert.match(originalChecks[0].stdout,/schema.*PASS/);assert.match(originalChecks[1].stdout,/real SQL insertion.*PASS/);assert.match(originalChecks[2].stdout,/exact data preservation/);
 const {head,...implementation}=payload(1);Object.assign(implementation,{automaticCheckRound:'1/5',commands:measured.commands,verificationTypesConsidered:'Actual Python/SQLite schema, import/history/summary and rebuild checks.',coverage:'Synthetic SQL paths and nonempty rebuild preservation.',affectedFilesOrBehaviors:'src/checks; src/database; src/fixtures',resultOfEachCommandAndExitCode:measured.commands.map(item=>item.command+' exit '+item.exit).join('; ')});
 const response={format:'stnl-current-native-judgment-v1',result:implementation};
 for(const corrupt of [value=>{value.result.head='forbidden-model-metadata';},value=>{value.result.evidenceOrFailureSummary='<template placeholder>';}]) {const draft=structuredClone(response);corrupt(draft);await assert.rejects(validateNativeResponse(execution.dispatch.originFile,JSON.stringify(draft)));assert.equal(executions,3);}
 assert.equal((await validateNativeResponse(execution.dispatch.originFile,JSON.stringify(response))).status,'valid-envelope');await verifyNative(execution.dispatch.originFile);assert.equal(executions,3);
 assert.deepEqual(await fs.readFile(verificationFile),sourceBytes);assert.deepEqual(await fs.readFile(measured.observationFile),observationBytes);await finish(f,execution,response);assert.equal(executions,3);
 const validation=await open(f,'VALIDATE_SLICE','synthetic-python-independent-reviewer'),formal=await verifyNative(validation.dispatch.originFile);assert.equal(executions,6,'new formal operation must execute the Python recipe, not silently cache it');
 const formalFile=validation.dispatch.originFile.replace('.origin.json','.verification.json'),formalBytes=await fs.readFile(formalFile);
 const judgment={format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:formal.commands,evidence:'Independent formal review of the synthetic SQL results and requirements.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Read-only independent formal review.'},newFindings:[]};
 const bad=structuredClone(judgment);bad.result.head='forbidden-model-metadata';await assert.rejects(validateNativeResponse(validation.dispatch.originFile,JSON.stringify(bad)));assert.equal(executions,6);
 assert.equal((await validateNativeResponse(validation.dispatch.originFile,JSON.stringify(judgment))).status,'valid-envelope');assert.deepEqual(await fs.readFile(formalFile),formalBytes);await finish(f,validation,judgment);assert.equal(executions,6);
 assert.equal((await captureCurrentExecution(f.specPath)).inspection.deliveries[0].formalStatus,'PASS');
 console.log('[native-python-sql-invocations] '+JSON.stringify({execute:3,executeEnvelopeRepairs:0,validate:3,validateEnvelopeRepairs:0,total:executions,crossPhaseReuse:false,sqlServerCertified:false}));
});
