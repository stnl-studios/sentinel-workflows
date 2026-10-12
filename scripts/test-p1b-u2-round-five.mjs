import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixture,approveFixture,reviewDecision} from './test-p1b-preparation.mjs';
import {setSection,evidence} from './test-p1b-continuity.mjs';
import {ancestorFixture} from './test-p1b-candidate-lifecycle.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {publishPreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {readPreparationArtifacts,parseVerificationRecipe} from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import {resolveExecutionWorkspace,readExecutionActivation,inspectExecutionState,preflightExecutionOperation} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {captureExecutionTree,preparationRegistryPath} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {createManagedSliceContext,managedEnvironment,assertManagedRunnerReceipt} from '../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';
import {invokeIndependentRunner} from '../agents/codex/runtime/validation-runner.mjs';
import {startOfficialRunnerBroker,submitOfficialRunnerRequest} from '../agents/codex/runtime/runner-broker.mjs';
import {assertRunnerVerification} from '../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';

const ROOT=path.resolve(import.meta.dirname,'..');
const carrier=text=>text.match(/^## Verification Recipe\n\n([^\n]+)/mu)[1];
const environment={...process.env};delete environment.NODE_TEST_CONTEXT;

test('U2-R5-F2 publisher rejects divergent or malformed Task recipes before snapshot and preserves the discrepancy',async()=>{
  const cases=[['cwd',r=>{r.cwd='src';}],['command',r=>{r.checks[0].args.unshift({literal:'--trace-warnings'});}],
    ['dependencies',r=>{r.dependencyReview='Different explicit dependency review';}],['unknown',r=>{r.unapproved=true;}],['malformed',()=>null]];
  const results=[];
  for(const operation of ['PLAN','REVIEW_PLAN'])for(const [name,mutate] of cases) {
    const f=await fixture();let candidate=f.candidate;
    if(operation==='REVIEW_PLAN') {
      await publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:candidate});
      candidate=(await preparePreparationCandidate({specPath:f.specPath,operation})).candidateExecutionRoot;
      for(const [file,text] of await readPreparationArtifacts(candidate))await fs.writeFile(path.join(candidate,file),text.replace('status: draft','status: ready').replace('- Review state: pending','- Review state: approved'));
    }
    const task=path.join(candidate,'tasks/slice-01.md'),plan=path.join(candidate,'plans/slice-01.md'),original=await fs.readFile(task,'utf8');
    const recipe=parseVerificationRecipe(carrier(original));mutate(recipe);
    const changed=name==='malformed'?'- Recipe: { invalid JSON':'- Recipe: '+JSON.stringify(recipe);
    await fs.writeFile(task,setSection(original,'Verification Recipe',changed));
    const before=await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:candidate,...(operation==='REVIEW_PLAN'?{reviewDecision}:{})}),/Verification Recipe|invalid JSON|JSON parse/i);
    assert.equal(carrier(await fs.readFile(task,'utf8')),changed,'Reject the Task carrier; never replace it with the Plan');
    assert.notEqual(carrier(await fs.readFile(plan,'utf8')),changed);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
    assert.equal(await fs.stat(path.join(candidate,'approved-preparation.json')).catch(()=>null),null);
    results.push({operation,case:name,taskCarrierPreserved:true,officialUnchanged:true,noSnapshot:true});
  }
  await evidence({root:os.tmpdir()},'R5-recipe-rejection',{results});
});

test('U2-R5-F2 equivalent typed paths canonicalize independently without selecting one semantic recipe',async()=>{
  const f=await fixture(),task=path.join(f.candidate,'tasks/slice-01.md');
  const text=await fs.readFile(task,'utf8'),recipe=parseVerificationRecipe(carrier(text));recipe.checks[0].args[1].file.path='../../src/greeting.test.mjs';
  await fs.writeFile(task,setSection(text,'Verification Recipe','- Recipe: '+JSON.stringify(recipe)));
  const approved=await approveFixture(f),artifacts=await readPreparationArtifacts(f.workspace.executionRoot);
  const planRecipe=parseVerificationRecipe(carrier(artifacts.get('plans/slice-01.md'))),taskRecipe=parseVerificationRecipe(carrier(artifacts.get('tasks/slice-01.md')));
  assert.deepEqual(planRecipe,taskRecipe);assert.equal(taskRecipe.checks[0].args[1].file.path,'../../src/greeting.test.mjs');
  assert.equal(taskRecipe.cwd,'.');assert.equal(approved.snapshot.normativeSha256,approved.authority.normativeSha256);
  await evidence(f,'R5-equivalent-paths',{planRecipe,taskRecipe,approvedSnapshot:approved.snapshot.normativeSha256});
});

test('U2-R5-F2 canonicalization preserves literal JSON bytes and leaves an identical prose example alone',async()=>{
  const f=await fixture(),plan=path.join(f.candidate,'plans/slice-01.md'),task=path.join(f.candidate,'tasks/slice-01.md');
  const recipe=parseVerificationRecipe(carrier(await fs.readFile(plan,'utf8')));
  recipe.dependencyReview="Approved product imports only; literal review tokens $& $` $' remain data.";
  const declared='- Recipe: '+JSON.stringify(recipe);
  for(const file of [plan,task]) {
    let text=await fs.readFile(file,'utf8');
    for(const heading of ['Verification Recipe','Expected Tests'])text=text.replace(
      new RegExp(`^## ${heading}\\n\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu'),()=>`## ${heading}\n\n${declared}\n\n`);
    await fs.writeFile(file,text);
  }
  await approveFixture(f);const artifacts=await readPreparationArtifacts(f.workspace.executionRoot);
  for(const file of ['plans/slice-01.md','tasks/slice-01.md']) {
    const text=artifacts.get(file);assert.equal(parseVerificationRecipe(carrier(text)).dependencyReview,recipe.dependencyReview);
    assert.equal(text.match(/^## Expected Tests\n\n([^\n]+)/mu)[1],declared);
    assert.equal(parseVerificationRecipe(carrier(text)).checks[0].args[1].file.path,'../../src/greeting.test.mjs');
  }
  await evidence(f,'R5-carrier-literal-preservation',{literalDataPreserved:true,proseExampleUnchanged:true,onlyActualRecipePathsCanonicalized:true});
});

test('U2-R5-F1 all seven publication kernels bind genuine creation and reject copied updated witnesses in an isolated consumer',async()=>{
  const paths=consumers.map(skill=>path.join(ROOT,'skills/workflows',skill,'runtime/execution-publication.mjs'));
  paths.push(path.join(ROOT,'skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs'));
  const bytes=await fs.readFile(paths[0]);for(const file of paths)assert.deepEqual(await fs.readFile(file),bytes,file);
  const f=await fixture();await approveFixture(f);const donor=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN'});
  const sibling=path.join(f.root,'legitimate-spec');await fs.mkdir(sibling);const spec=path.join(sibling,'feature_spec.md');await fs.writeFile(spec,'# Legitimate sibling\n');
  const kernel=path.join(f.root,'shipped-kernel.mjs');await fs.writeFile(kernel,bytes);
  const consumer=await import(pathToFileURL(kernel).href),genuine=JSON.parse(await fs.readFile(donor.candidateExecutionRoot+'.owner.json','utf8'));
  await consumer.assertOwnedPreparationCandidate({candidateExecutionRoot:donor.candidateExecutionRoot,resolveWorkspace:resolveExecutionWorkspace});
  assert.equal((await consumer.classifyOwnedAllocation({workspace:f.workspace,marker:donor.candidateExecutionRoot+'.owner.json',activation:(await readExecutionActivation(f.specPath)).activation})).classification,'active');
  const registry=await preparationRegistryPath(f.workspace),registryBytes=await fs.readFile(registry),specBytes=await fs.readFile(spec);
  const rebound={...genuine,candidate:sibling,retentionRoot:sibling,candidateIdentity:(await captureExecutionTree(sibling)).identity};await fs.writeFile(sibling+'.owner.json',JSON.stringify(rebound));
  await assert.rejects(consumer.classifyOwnedAllocation({workspace:f.workspace,marker:sibling+'.owner.json'}),/producer association/);
  await assert.rejects(consumer.assertOwnedPreparationCandidate({candidateExecutionRoot:sibling,resolveWorkspace:resolveExecutionWorkspace}),/producer association/);
  assert.equal((await resolveExecutionWorkspace(sibling)).specRoot,sibling);assert.deepEqual(await fs.readFile(registry),registryBytes);assert.deepEqual(await fs.readFile(spec),specBytes);
  await evidence(f,'R5-seventh-kernel',{kernelPaths:paths,isolatedConsumer:kernel,genuineAccepted:true,copiedWitnessRejected:true,registryAndSpecPreserved:true});
});
const consumers=['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor','stnl-slice-quality-manager','stnl-spec-roadmap','stnl-spec-test-runbook'];

async function managedContract(kind) {
  const lifecycle=kind==='lifecycle',f=lifecycle?await ancestorFixture():await fixture();if(!lifecycle)await approveFixture(f);
  const directory=lifecycle?'specs':'src',pf=await preflightExecutionOperation(f.specPath,'EXECUTE_SLICE','1');
  const officialPreflight={exitCode:0,operation:'EXECUTE_SLICE',slice:'slice-01',inputSlice:'1',specPath:f.specPath,state:pf.state,authority:'sha256:'+pf.currentFingerprint,activationId:pf.activation.activationId,legalOperations:pf.legalOperations,mandatoryRecovery:null};
  const snapshot=await fs.realpath(ROOT),context=await createManagedSliceContext({officialPreflight,workspace:f.root,snapshot,adapterPath:path.join(snapshot,'agents/codex/runtime/validation-runner.mjs'),bridgePath:path.join(snapshot,'agents/codex/runtime/managed-runner-bridge.mjs'),preflightPath:path.join(snapshot,'agents/codex/runtime/managed-slice-preflight.mjs')});officialPreflight.owner=context.owner;
  const tmpdir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'r5-managed-'))),env=managedEnvironment({...environment,TMPDIR:tmpdir},context);env.STNL_MANAGED_FINALIZER=path.join(snapshot,'agents/codex/runtime/managed-slice-finalize.mjs');
  const schema=JSON.parse(await fs.readFile(path.join(ROOT,'skills/workflows/stnl-slice-executor/runtime/runner-semantic-response.schema.json')));let calls=0;
  const broker=await startOfficialRunnerBroker({workspace:f.root,tmpdir,operation:'EXECUTE_SLICE',sequence:1,slice:'slice-01',officialPreflight,pollIntervalMs:1,invoke:request=>invokeIndependentRunner({...request,snapshot,env,runTurn:async({prompt,eventsPath,operationId})=>{
    calls++;const observation=JSON.parse(prompt.match(/REVIEWED_VERIFICATION=(.*)/u)[1]);assert.equal(observation.checks[0].exit,0);assert.match(observation.checks[0].stdout,/# pass 1/);
    const response=Object.fromEntries(schema.oneOf.find(b=>b.title==='EXECUTE_SLICE').required.map(key=>[key,'Controlled offline judgment of actual prepared greeting checks.']));Object.assign(response,{status:'TESTS_PASS',commands:assertRunnerVerification(observation,observation.verification),failures:'none',priorRoundFailure:'none',correctionApplied:'none',inSliceRationale:'none',blockers:'none',unexpectedWorkspaceEffects:'none'});
    await fs.writeFile(eventsPath,[{type:'thread.started',thread_id:'r5-managed-'+kind},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(response)}},{type:'turn.completed'}].map(event=>JSON.stringify({...event,operationId})).join('\n')+'\n');
    return {completed:true,threadId:'r5-managed-'+kind,error:null,processError:null,errorEvent:null};
  }})});
  const cli=mode=>{const result=spawnSync(process.execPath,[env.STNL_MANAGED_FINALIZER,mode],{cwd:f.root,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr+result.stdout);return JSON.parse(result.stdout);};
  try {
    const copy=cli('--prepare');await fs.writeFile(path.join(f.root,directory,'unpredicted.mjs'),'export const greeting="hello";\n');await fs.writeFile(path.join(f.root,directory,'greeting.test.mjs'),'import test from "node:test";import assert from "node:assert/strict";import {greeting} from "./unpredicted.mjs";test("actual greeting",()=>assert.equal(greeting,"hello"));\n');
    const changedAreas=['greeting.test.mjs','unpredicted.mjs'].map(file=>path.relative(path.join(f.workspace.executionRoot,'tasks'),path.join(f.root,directory,file)).split(path.sep).join('/'));
    let text=await fs.readFile(copy.candidateTaskArtifact,'utf8');text=setSection(text.replace('- [ ] 1.1','- [x] 1.1'),'Changed Areas',changedAreas.map(p=>'- `'+p+'`').join('\n'));await fs.writeFile(copy.candidateTaskArtifact,setSection(text,'Diff Summary','- Actual greeting and prepared test within approved area.'));
    const payload={automaticCheckRound:'1/3',changedAreas,relevantEvidence:'Run reviewed recipe over the prepared files.'};
    const receipt=await submitOfficialRunnerRequest({workspace:f.root,tmpdir,operation:'EXECUTE_SLICE',sequence:1,slice:'slice-01',prompt:JSON.stringify(payload),managedPayload:payload,pollIntervalMs:1,timeoutMs:30000});assert.equal(receipt.status,'RUNNER_RESPONSE_CAPTURED');
    await assertManagedRunnerReceipt({operation:'EXECUTE_SLICE',slice:'slice-01',workspace:f.root,receiptFile:receipt.receiptFile,semanticResponseFile:receipt.semanticResponseFile,environment:env});
    assert.equal(receipt.testedState.sourceTaskPath,path.join(f.workspace.executionRoot,'tasks/slice-01.md'));
    // Copy only directly shipped runtime files. Deny all module imports from the
    // source repo so the receipt consumer cannot work through a source fallback.
    const isolated=path.join(tmpdir,'consumer-runtime');await fs.mkdir(isolated);
    for(const file of await fs.readdir(path.join(ROOT,'skills/workflows/stnl-slice-executor/runtime')))if(/\.(?:mjs|json)$/u.test(file))await fs.copyFile(path.join(ROOT,'skills/workflows/stnl-slice-executor/runtime',file),path.join(isolated,file));
    const loader=path.join(tmpdir,'deny-source.mjs');await fs.writeFile(loader,`export async function resolve(s,c,next){const r=await next(s,c);if(r.url.startsWith(${JSON.stringify(pathToFileURL(ROOT+'/').href)})&&!r.url.startsWith(${JSON.stringify(pathToFileURL(isolated+path.sep).href)}))throw new Error('source fallback forbidden');return r;}`);
    const denied=spawnSync(process.execPath,['--experimental-loader',loader,'--input-type=module','-e',`import ${JSON.stringify(pathToFileURL(path.join(ROOT,'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs')).href)};`],{cwd:f.root,env,encoding:'utf8'});
    assert.notEqual(denied.status,0);assert.match(denied.stderr,/source fallback forbidden/u);
    const code=`import fs from 'node:fs/promises';import {serializeRunnerExecutionBundleFromResponse} from ${JSON.stringify(pathToFileURL(path.join(isolated,'serialize-runner-evidence.mjs')).href)};const options=${JSON.stringify({operation:'EXECUTE_SLICE',workspace:f.root,taskArtifact:copy.candidateTaskArtifact,receiptFile:receipt.receiptFile,semanticResponseFile:receipt.semanticResponseFile,automaticCheckRound:'1/3'})};const bundle=await serializeRunnerExecutionBundleFromResponse({...options,response:await fs.readFile(options.semanticResponseFile,'utf8')});console.log(JSON.stringify({valid:bundle.startsWith('### implementation-check-01')}));`;
    const consume=()=>spawnSync(process.execPath,['--experimental-loader',loader,'--input-type=module','-e',code],{cwd:f.root,env,encoding:'utf8'});
    const copied=consume();assert.equal(copied.status,0,copied.stderr);assert.equal(JSON.parse(copied.stdout).valid,true);
    const candidates=[copy.candidateExecutionRoot,path.dirname(copy.candidateExecutionRoot)];
    let marker=null;
    for(const candidate of candidates)if(await fs.stat(candidate+'.copy.json').catch(()=>null)){marker=candidate+'.copy.json';break;}
    assert.ok(marker,'the prepared binding must expose a genuine existing copy marker');await fs.rename(marker,marker+'.retained');
    const refused=consume();assert.notEqual(refused.status,0);assert.match(refused.stderr,/owned|candidate|marker|ENOENT/);await fs.rename(marker+'.retained',marker);
    const receiptBytes=await fs.readFile(receipt.receiptFile),finalized=cli('--finalize'),repeated=cli('--finalize');assert.deepEqual(await fs.readFile(receipt.receiptFile),receiptBytes);assert.equal(calls,1);assert.equal((await inspectExecutionState(f.specPath)).state,'IMPLEMENTED_AWAITING_VALIDATION');
    await assert.rejects(submitOfficialRunnerRequest({workspace:f.root,tmpdir,operation:'EXECUTE_SLICE',sequence:1,slice:'slice-01',prompt:JSON.stringify(payload),managedPayload:payload,pollIntervalMs:1,timeoutMs:1000}),/already captured|already settled|cannot|one valid|BROKER_RESULT/);assert.equal(calls,1);
    await evidence(f,'R5-managed-'+kind,{kind,context,copy,receipt,finalized,repeated,calls,externalCalls:0,copiedConsumer:{exit:copied.status,stdout:copied.stdout,sourceImportsDenied:true},missingMarkerRefused:true,afterState:'IMPLEMENTED_AWAITING_VALIDATION'});
  } finally {await broker.close();}
}
for(const kind of ['standalone','lifecycle'])test('U2-R5 managed '+kind+' finalizes its genuine receipt and isolated consumer preserves copy guards',async()=>managedContract(kind));
