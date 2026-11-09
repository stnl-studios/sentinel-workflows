// Explicit external gate. Never runs from npm test and never provisions a service.
// Synthetic protocol judgments, real SQL Server build/publication/checks, no models.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
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
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const initialCredential=process.env.SQLCMDPASSWORD??'';
async function sourceImage() {
 const commit=(await run('git',['rev-parse','HEAD'],{cwd:sourceRoot})).stdout.trim(),tree=(await run('git',['rev-parse','HEAD^{tree}'],{cwd:sourceRoot})).stdout.trim();
 assert.equal((await run('git',['status','--porcelain'],{cwd:sourceRoot})).stdout.trim(),'','exact source must be committed and clean');
 const files=(await run('git',['ls-files','-z'],{cwd:sourceRoot,maxBuffer:8*1024*1024})).stdout.split('\0').filter(Boolean).sort(),manifest=[];
 for(const file of files){const absolute=path.join(sourceRoot,file),metadata=await fs.lstat(absolute);assert.ok(metadata.isFile(),'source manifest requires regular tracked files');manifest.push({path:file,mode:metadata.mode&0o777,sha256:hash(await fs.readFile(absolute))});}
 return {commit,tree,manifestSha256:hash(JSON.stringify(manifest)),manifest};
}
function preflight() {
 for (const key of ['STNL_SQLSERVER_RUN_ID','STNL_SQLSERVER_CONTAINER','STNL_SQLSERVER_CONTAINER_ID','STNL_SQLSERVER_DOCKER_CONTEXT','SQLCMDPASSWORD']) assert.ok(process.env[key],key+' is required');
 assert.ok(initialCredential.length===53&&/^Stnl![0-9a-f]{48}$/u.test(initialCredential),'new credential must use the documented safe generated format');
 assert.equal(process.env.STNL_SQLSERVER_NATIVE,'1','external gate must be explicitly enabled');
 assert.equal(process.env.STNL_SQLSERVER_EULA_ACCEPTED,'yes','approved EULA required');
 assert.ok(['github-actions','local-docker','local-docker-emulated'].includes(process.env.STNL_SQLSERVER_ROUTE),'explicit authorized route required');
}
async function ledgerImage(ledger) {
 const bytes=await fs.readFile(ledger),rows=bytes.toString().trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
 const count=(type,kind)=>rows.filter(x=>x.type===type&&(!kind||x.kind===kind)).length;
 return {bytes,sha256:hash(bytes),checks:count('check-start'),completed:count('check-complete'),builds:count('process','dacpac-build'),publications:count('process','dacpac-publish'),sqlcmd:count('process','sqlcmd'),rows};
}
function assertCounts(image,count) { for(const key of ['checks','completed','builds','publications']) assert.equal(image[key],count,key+' count'); }
async function unchangedLedger(ledger,prior) {const image=await ledgerImage(ledger);assert.deepEqual(image.bytes,prior.bytes,'envelope repair/replay executed an external command');}
function publicError(error) { return String(error?.message??error).replaceAll(initialCredential||'\0','[EPHEMERAL_CREDENTIAL]').replaceAll(process.env.STNL_SQLSERVER_NATIVE_CREDENTIAL_FILE||'\0','[PRIVATE_CREDENTIAL_SUPPORT_REDACTED]').replace(/\/TargetConnectionString:[^\r\n]*/giu,'[LOCAL_CONNECTION_REDACTED]').replace(/(?:Password|Pwd)\s*=\s*[^;\s]*/giu,'[CREDENTIAL_FIELD_REDACTED]'); }
async function fixture(t,python) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-native-python-sql-')));t.privateFixture=root; // Preserve locally for failure diagnosis; never upload its producer keys.
 await fs.mkdir(path.join(root,'specs/pay'),{recursive:true});await fs.cp(path.join(sourceRoot,'scripts/fixtures/python-sqlserver-native'),path.join(root,'src'),{recursive:true});
 const specPath=path.join(root,'specs/pay/requirements.md');await fs.writeFile(specPath,'# Synthetic local SQL checks\n\nAC-001: Schema, import/history/summary and rebuild preservation are verified against new fresh owned SQL Server databases.\n');
 await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');await run('git',['init','-q',root]);await run('git',['-C',root,'add','.gitignore','specs/pay/requirements.md','src']);await run('git',['-C',root,'-c','user.name=Synthetic fixture','-c','user.email=fixture@example.invalid','commit','-qm','synthetic SQL baseline']);
 const initial=await inspectCurrentExecution(specPath),{context}=await resolveCurrentExecutionContext(specPath);
 const recipe={format:'stnl-verification-recipe-v1',base:'workspace',cwd:'.',dependencyReview:'Synthetic recipe: real Python stdlib and isolated SQL Server build, publication and checks; schema/project Pre/Post and seed are inside the observed source domain. No cross-phase cache claim.',
  checks:['schema','import','rebuild'].map((name,index)=>({id:'verification-0'+(index+1),executable:{literal:python},args:[{literal:'-E'},{literal:'-s'},{literal:'-B'},{file:{kind:'product',path:'../../../../src/checks/check_'+name+'.py'}}],inputs:[]}))};
 const artifacts=new Map([...initialArtifacts({form:'standalone'})].filter(([name])=>!name.includes('slice-02')).map(([name,bytes])=>{
  const text=bytes.toString().replaceAll(REQUIREMENTS,initial.requirementsAuthority).split('\n').filter(line=>!line.includes('| 02 - Verification |')).map(line=>line.startsWith('- Recipe: ')?'- Recipe: '+JSON.stringify(recipe):line).join('\n').replaceAll('contribution: partial | full owner: slice-02','contribution: complete | full owner: slice-01').replaceAll('../../../../src/pay.mjs','../../../../src/checks/check_schema.py').replaceAll('node --test src/pay.test.mjs','Python/SQL Server synthetic schema, import and rebuild checks');return [name,Buffer.from(text)];
 }));
 const projected=projectInitialPreparation({context,requirementsAuthority:initial.requirementsAuthority,artifacts}),hashes=new Map(projected.artifactHashes.map(item=>[item.path,item.sha256]));
 const decision=(scope,authoritySha256,names)=>({scope,decision:'approved',authoritySha256,examinedArtifactHashes:names.sort().map(name=>({path:name,sha256:hashes.get(name)})),evidenceDecisions:[],summary:'Reviewed exact synthetic Python/SQL Server recipe bytes.'});
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
async function main() {
 preflight();
 const sourceBefore=await sourceImage(),sourceCommit=sourceBefore.commit,sourceTree=sourceBefore.tree;
 const evidence=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-native-sqlserver-evidence-')));
 await fs.chmod(evidence,0o700);const ledger=path.join(evidence,'commands.jsonl');await fs.writeFile(ledger,'',{flag:'wx',mode:0o600});
 delete process.env.SQLCMDPASSWORD;delete process.env.MSSQL_SA_PASSWORD;
 assert.ok(!Object.values(process.env).some(value=>value.includes(initialCredential)),'credential remains in native process environment');
 const credentialFile=path.join(evidence,'credential-support');
 await fs.writeFile(credentialFile,initialCredential,{flag:'wx',mode:0o600});
 process.env.STNL_SQLSERVER_NATIVE_CREDENTIAL_FILE=credentialFile;
 process.env.STNL_SQLSERVER_NATIVE_EVIDENCE=evidence;
 const cleanups=[],t={after:fn=>cleanups.push(fn)};
 try {
 const python=await fs.realpath((await run('python3',['-I','-S','-c','import sys;print(sys.executable)'])).stdout.trim()),f=await fixture(t,python);
 const original=cp.execFile;let executions=0;
 cp.execFile=function(executable,args,...rest){if(executable===python&&args.some(arg=>/^src\/checks\/check_(schema|import|rebuild)\.py$/u.test(String(arg))))executions++;return original.call(this,executable,args,...rest);};syncBuiltinESMExports();t.after(()=>{cp.execFile=original;syncBuiltinESMExports();});
 const execution=await open(f,'EXECUTE_SLICE','synthetic-python-author');await fs.writeFile(path.join(f.root,'src/implemented.txt'),'Synthetic source delivery verified.\n');
 const measured=await verifyNative(execution.dispatch.originFile);assert.equal(executions,3);assert.ok(measured.commands.every(item=>item.exit===0));
 const executeLedger=await ledgerImage(ledger);assertCounts(executeLedger,3);
 const verificationFile=execution.dispatch.originFile.replace('.origin.json','.verification.json'),sourceBytes=await fs.readFile(verificationFile),observationBytes=await fs.readFile(measured.observationFile);
 const originalChecks=JSON.parse(sourceBytes).checks;assert.match(originalChecks[0].stdout,/schema.*PASS/);assert.match(originalChecks[1].stdout,/real SQL insertion.*PASS/);assert.match(originalChecks[2].stdout,/exact data preservation/);
 const {head,...implementation}=payload(1);Object.assign(implementation,{automaticCheckRound:'1/5',commands:measured.commands,verificationTypesConsidered:'Actual Python/SQL Server schema, import/history/summary and rebuild checks.',coverage:'Synthetic SQL paths and nonempty rebuild preservation.',affectedFilesOrBehaviors:'src/checks; src/database; src/fixtures',resultOfEachCommandAndExitCode:measured.commands.map(item=>item.command+' exit '+item.exit).join('; ')});
 const response={format:'stnl-current-native-judgment-v1',result:implementation};
 for(const corrupt of [value=>{value.result.head='forbidden-model-metadata';},value=>{value.result.evidenceOrFailureSummary='<template placeholder>';}]) {const draft=structuredClone(response);corrupt(draft);await assert.rejects(validateNativeResponse(execution.dispatch.originFile,JSON.stringify(draft)));assert.equal(executions,3);await unchangedLedger(ledger,executeLedger);}
 assert.equal((await validateNativeResponse(execution.dispatch.originFile,JSON.stringify(response))).status,'valid-envelope');await verifyNative(execution.dispatch.originFile);assert.equal(executions,3);
 assert.deepEqual(await fs.readFile(verificationFile),sourceBytes);assert.deepEqual(await fs.readFile(measured.observationFile),observationBytes);await finish(f,execution,response);assert.equal(executions,3);await unchangedLedger(ledger,executeLedger);
 const validation=await open(f,'VALIDATE_SLICE','synthetic-python-independent-reviewer'),formal=await verifyNative(validation.dispatch.originFile);assert.equal(executions,6,'new formal operation must execute the Python recipe, not silently cache it');
 const validateLedger=await ledgerImage(ledger);assertCounts(validateLedger,6);
 const formalFile=validation.dispatch.originFile.replace('.origin.json','.verification.json'),formalBytes=await fs.readFile(formalFile),formalObservationBytes=await fs.readFile(formal.observationFile);
 const judgment={format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:formal.commands,evidence:'Independent formal review of the synthetic SQL results and requirements.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Read-only independent formal review.'},newFindings:[]};
 const bad=structuredClone(judgment);bad.result.head='forbidden-model-metadata';await assert.rejects(validateNativeResponse(validation.dispatch.originFile,JSON.stringify(bad)));assert.equal(executions,6);await unchangedLedger(ledger,validateLedger);
 assert.equal((await validateNativeResponse(validation.dispatch.originFile,JSON.stringify(judgment))).status,'valid-envelope');await verifyNative(validation.dispatch.originFile);assert.deepEqual(await fs.readFile(formalFile),formalBytes);await finish(f,validation,judgment);assert.equal(executions,6);await unchangedLedger(ledger,validateLedger);
 assert.deepEqual(await fs.readFile(verificationFile),sourceBytes);assert.deepEqual(await fs.readFile(measured.observationFile),observationBytes);
 assert.deepEqual(await fs.readFile(formalFile),formalBytes);assert.deepEqual(await fs.readFile(formal.observationFile),formalObservationBytes);
 assert.equal((await captureCurrentExecution(f.specPath)).inspection.deliveries[0].formalStatus,'PASS');
 const completed=validateLedger.rows.filter(x=>x.type==='check-complete');
 assert.equal(new Set(completed.map(x=>x.database)).size,6,'every phase/check must own a fresh database');
 assert.deepEqual(await sourceImage(),sourceBefore,'source commit/tree/status/executed-file manifest changed during external gate');
 const publicResult={format:'stnl-native-sqlserver-gate-v1',status:'passed',sourceCommit,sourceTree,
  sourceManifestSha256:sourceBefore.manifestSha256,sourceUnchangedAfterCampaign:true,
  route:process.env.STNL_SQLSERVER_ROUTE,microsoftSupportedNative:process.env.STNL_SQLSERVER_ROUTE!=='local-docker-emulated',
  emulatedCompatibilityOnly:process.env.STNL_SQLSERVER_ROUTE==='local-docker-emulated',
  execute:3,executeEnvelopeRepairs:0,validate:3,validateEnvelopeRepairs:0,totalPythonChecks:executions,
  physicalDacpacBuilds:validateLedger.builds,physicalDacpacPublications:validateLedger.publications,physicalSqlcmdInvocations:validateLedger.sqlcmd,
  executeLedgerSha256:executeLedger.sha256,finalLedgerSha256:validateLedger.sha256,
  executeReceiptSha256:hash(sourceBytes),executeObservationSha256:hash(observationBytes),validateReceiptSha256:hash(formalBytes),validateObservationSha256:hash(formalObservationBytes),
  checkObservations:completed,crossPhaseReuse:false,modelCalls:0,syntheticProtocolJudgments:true,
  limitations:['Synthetic SQL and protocol scenarios only','No private work-script certification','No general determinism or live-state reuse','No model judgment quality certification']};
 const encoded=JSON.stringify(publicResult)+'\n';assert.ok(!encoded.includes(initialCredential),'credential escaped public output');assert.ok(!encoded.includes(credentialFile),'private credential path escaped public output');
 await fs.writeFile(path.join(evidence,'public-result.json'),encoded,{flag:'wx',mode:0o600});
 console.log('STNL_NATIVE_SQLSERVER_RESULT '+encoded.trim());
 console.log('Private local evidence directory: '+evidence);
 } finally { await fs.rm(credentialFile,{force:true});delete process.env.STNL_SQLSERVER_NATIVE_CREDENTIAL_FILE;for(const cleanup of cleanups.reverse())await cleanup(); }
}
main().catch(error=>{console.error('STNL_NATIVE_SQLSERVER_BLOCKED_OR_FAILED '+publicError(error));process.exitCode=1;});
