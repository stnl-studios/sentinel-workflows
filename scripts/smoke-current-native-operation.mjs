#!/usr/bin/env node

// The launcher runs official collaboration agents between these commands.
// This script creates only the disposable legacy/conversion fixture and records
// mechanical S2 admission/readback evidence; it never simulates a native result.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {convertedImage} from './fixtures/current-operational-consumption.mjs';
import {begin,reserveDispatch,resume,publish} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile);
const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
async function git(root,args) {return run('git',['-C',root,...args],{timeout:30000});}
async function setup({defect=false}={}) {
  const runRoot=await fs.mkdtemp(path.join(repo,'tmp/u3-reconstruction/vertical-native-EC1-'));
  const image=await convertedImage(null,{kind:'managed-s2'});
  const root=image.f.root;
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  const firstDrift=path.join(root,'src/greeting.mjs');
  await fs.writeFile(firstDrift,defect?'export const greeting="broken";\n':'export const greeting="hello";\n');
  await fs.writeFile(path.join(root,'src/greeting.test.mjs'),
    'import test from "node:test";import assert from "node:assert/strict";import {greeting} from "./greeting.mjs";test("AC-001",()=>assert.equal(greeting,"hello"));\n');
  await git(root,['init','-q']);
  await git(root,['add','.gitignore','requirements.md','src']);
  await git(root,['-c','user.name=EC1 Fixture','-c','user.email=ec1-fixture@example.invalid',
    'commit','-qm','fixture baseline']);
  const head=(await git(root,['rev-parse','HEAD'])).stdout.trim();
  if(!/^[a-f0-9]{40}$/u.test(head)) throw new Error('disposable fixture has no verifiable Git HEAD');
  const continuity=JSON.parse(await fs.readFile(path.join(image.f.execution,'continuity.json'),'utf8'));
  const selected=continuity.deliveries.find(item=>item.counters.validationAttempts>0);
  if(!selected) throw new Error('converted fixture lacks S2 delivery');
  const start=await begin({specPath:image.f.specPath,slice:selected.slice,
    expectedActivationId:image.activation.activationId});
  const handleFile=path.join(runRoot,'operation-1.handle.json');
  await fs.writeFile(handleFile,JSON.stringify(start.handle)+'\n',{flag:'wx',mode:0o600});
  const dispatch=await reserveDispatch(start.handle);
  const contract=path.join(repo,'agents/codex/.codex/agents/stnl_validation_runner.toml');
  const evidence={runRoot,fixtureRoot:root,specPath:image.f.specPath,executionRoot:image.f.execution,
    deliveryId:selected.deliveryId,slice:selected.slice,head,handleFile,firstDrift,
    defect,contract,contractSha256:sha(await fs.readFile(contract)),start,dispatch};
  await fs.writeFile(path.join(runRoot,'operation-1.start.json'),JSON.stringify(evidence,null,2)+'\n');
  return evidence;
}
async function applyBegin(runRoot) {
  const first=JSON.parse(await fs.readFile(path.join(runRoot,'operation-1.start.json'),'utf8'));
  if((await resume(first.start.handle)).phase!=='committed') throw new Error('NEEDS_FIX operation is not committed');
  const activation=JSON.parse(await fs.readFile(path.join(first.executionRoot,'activation.json'),'utf8'));
  const continuity=JSON.parse(await fs.readFile(path.join(first.executionRoot,'continuity.json'),'utf8'));
  const current=continuity.deliveries.find(item=>item.deliveryId===first.deliveryId);
  const bundle=JSON.parse(await fs.readFile(path.join(first.executionRoot,current.evidence.path),'utf8'));
  if(!bundle.validation?.recordUtf8.includes('- Status: NEEDS_FIX')
    || !bundle.openFindings.some(item=>item.severity==='blocking'))
    throw new Error('first real verdict is not a blocking NEEDS_FIX');
  const start=await begin({specPath:first.specPath,slice:first.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
  const handleFile=path.join(runRoot,'operation-2.handle.json');
  await fs.writeFile(handleFile,JSON.stringify(start.handle)+'\n',{flag:'wx',mode:0o600});
  const evidence={runRoot,fixtureRoot:first.fixtureRoot,specPath:first.specPath,
    executionRoot:first.executionRoot,deliveryId:first.deliveryId,slice:first.slice,
    handleFile,start,firstCounters:current.counters};
  await fs.writeFile(path.join(runRoot,'operation-2.start.json'),JSON.stringify(evidence,null,2)+'\n');
  return evidence;
}
async function applyDispatch(runRoot) {
  const entry=JSON.parse(await fs.readFile(path.join(runRoot,'operation-2.start.json'),'utf8'));
  const state=await resume(entry.start.handle);
  if(state.nextAction!=='reserve-dispatch') throw new Error('APPLY owner did not survive controller restart');
  await fs.writeFile(path.join(entry.fixtureRoot,'src/greeting.mjs'),'export const greeting="hello";\n');
  const dispatch=await reserveDispatch(entry.start.handle);
  entry.dispatch=dispatch;
  await fs.writeFile(path.join(runRoot,'operation-2.start.json'),JSON.stringify(entry,null,2)+'\n');
  return entry;
}
async function formalBegin(runRoot) {
  const first=JSON.parse(await fs.readFile(path.join(runRoot,'operation-1.start.json'),'utf8'));
  const apply=JSON.parse(await fs.readFile(path.join(runRoot,'operation-2.start.json'),'utf8'));
  if((await resume(apply.start.handle)).phase!=='committed') throw new Error('APPLY operation is not committed');
  const activation=JSON.parse(await fs.readFile(path.join(first.executionRoot,'activation.json'),'utf8'));
  const continuity=JSON.parse(await fs.readFile(path.join(first.executionRoot,'continuity.json'),'utf8'));
  const current=continuity.deliveries.find(item=>item.deliveryId===first.deliveryId);
  const bundle=JSON.parse(await fs.readFile(path.join(first.executionRoot,current.evidence.path),'utf8'));
  if(bundle.findingsChecks.at(-1)?.recordUtf8.includes('- Status: TESTS_PASS')!==true
    || !bundle.openFindings.some(item=>item.severity==='blocking'))
    throw new Error('APPLY did not retain active findings after TESTS_PASS');
  const start=await begin({specPath:first.specPath,slice:first.slice,
    expectedActivationId:activation.activationId});
  const handleFile=path.join(runRoot,'operation-3.handle.json');
  await fs.writeFile(handleFile,JSON.stringify(start.handle)+'\n',{flag:'wx',mode:0o600});
  const dispatch=await reserveDispatch(start.handle);
  const evidence={runRoot,fixtureRoot:first.fixtureRoot,specPath:first.specPath,
    executionRoot:first.executionRoot,deliveryId:first.deliveryId,slice:first.slice,
    handleFile,start,dispatch,applyCounters:current.counters};
  await fs.writeFile(path.join(runRoot,'operation-3.start.json'),JSON.stringify(evidence,null,2)+'\n');
  return evidence;
}
async function afterPassDrift(runRoot) {
  const first=JSON.parse(await fs.readFile(path.join(runRoot,'operation-1.start.json'),'utf8'));
  const formal=JSON.parse(await fs.readFile(path.join(runRoot,'operation-3.start.json'),'utf8'));
  if((await resume(formal.start.handle)).phase!=='committed') throw new Error('later formal is not committed');
  const file=path.join(first.fixtureRoot,'src/greeting.mjs');
  await fs.appendFile(file,'// equivalent approved output drift after formal PASS.\n');
  const state=await readback(runRoot);
  if(state.some(item=>item.normalHandoff?.operation!=='VALIDATE_SLICE'))
    throw new Error('equivalent output drift did not request VALIDATE_SLICE');
  return state;
}
async function second(runRoot) {
  const first=JSON.parse(await fs.readFile(path.join(runRoot,'operation-1.start.json'),'utf8'));
  const result=await resume(first.start.handle);
  if(result.phase!=='committed') throw new Error('first operation is not committed');
  const official=JSON.parse(await fs.readFile(path.join(first.executionRoot,'activation.json'),'utf8'));
  const continuity=JSON.parse(await fs.readFile(path.join(first.executionRoot,'continuity.json'),'utf8'));
  const delivery=continuity.deliveries.find(item=>item.deliveryId===first.deliveryId);
  const bundle=JSON.parse(await fs.readFile(path.join(first.executionRoot,delivery.evidence.path),'utf8'));
  if(bundle.validation?.recordFormat!=='stnl-task-record-v2'
    || !bundle.validation.recordUtf8.includes('- Status: PASS'))
    throw new Error('first native result was not PASS; preserve published outcome');
  const target=path.join(first.fixtureRoot,'src/greeting.mjs');
  await fs.appendFile(target,'// EC-1 equivalent source drift for revalidation.\n');
  const start=await begin({specPath:first.specPath,slice:first.slice,
    expectedActivationId:official.activationId});
  const handleFile=path.join(runRoot,'operation-2.handle.json');
  await fs.writeFile(handleFile,JSON.stringify(start.handle)+'\n',{flag:'wx',mode:0o600});
  const dispatch=await reserveDispatch(start.handle);
  const evidence={runRoot,fixtureRoot:first.fixtureRoot,specPath:first.specPath,
    executionRoot:first.executionRoot,deliveryId:first.deliveryId,slice:first.slice,
    handleFile,start,dispatch,driftPath:target,firstCounters:delivery.counters};
  await fs.writeFile(path.join(runRoot,'operation-2.start.json'),JSON.stringify(evidence,null,2)+'\n');
  return evidence;
}
async function readback(runRoot) {
  const first=JSON.parse(await fs.readFile(path.join(runRoot,'operation-1.start.json'),'utf8'));
  const scripts=['stnl-slice-executor','stnl-slice-quality-manager'].map(name=>
    path.join(repo,'skills/workflows',name,'runtime/execution-current-reader.mjs'));
  const results=[];
  for(const script of scripts) {
    const child=await run(process.execPath,[script,first.specPath],{timeout:60000});
    const response=JSON.parse(child.stdout);
    results.push({script,activationId:response.activationId,state:response.state,
      normalHandoff:response.normalHandoff,
      deliveries:response.deliveries.map(item=>({slice:item.slice,formalStatus:item.formalStatus,
        auxiliaryStatus:item.auxiliaryStatus,counters:item.counters}))});
  }
  await fs.writeFile(path.join(runRoot,'readback.json'),JSON.stringify(results,null,2)+'\n');
  return results;
}
async function packageEvidence(runRoot) {
  const runs=[];
  const firstRun=JSON.parse(await fs.readFile(path.join(runRoot,'operation-1.start.json'),'utf8'));
  for(const ordinal of [1,2]) {
    const entry=JSON.parse(await fs.readFile(path.join(runRoot,`operation-${ordinal}.start.json`),'utf8'));
    const originRoot=path.dirname(entry.dispatch.originFile);
    const target=path.join(runRoot,`operation-${ordinal}`);
    await fs.mkdir(target,{mode:0o700});
    const names=['base.activation.json','round-1.request.json','round-1.baseline.json',
      'round-1.origin.json','round-1.agent.json','round-1.claim.json',
      'round-1.verification.json','round-1.observation.json','round-1.response.json',
      'round-1.tool-result.json','round-1.receipt.json','owner.json'];
    const hashes={};
    for(const name of names) {
      const bytes=await fs.readFile(path.join(originRoot,name));
      await fs.writeFile(path.join(target,name),bytes,{flag:'wx',mode:0o600});
      hashes[name]=sha(bytes);
    }
    const tool=JSON.parse(await fs.readFile(path.join(target,'round-1.tool-result.json')));
    const raw=await fs.readFile(path.join(target,'round-1.response.json'));
    const receipt=JSON.parse(await fs.readFile(path.join(target,'round-1.receipt.json')));
    const observation=JSON.parse(await fs.readFile(path.join(target,'round-1.observation.json')));
    const marker=JSON.parse(await fs.readFile(path.join(target,'owner.json')));
    if(!raw.equals(Buffer.from(tool.finalResponse,'utf8'))
      || receipt.status!=='RUNNER_RESPONSE_CAPTURED'
      || marker.phase!=='committed' || marker.cleanup.status!=='complete'
      || observation.status!=='completed') throw new Error(`operation ${ordinal} evidence does not close`);
    runs.push({ordinal,operationId:entry.start.handle.operationId,agentId:tool.agentId,
      ownerAttemptId:entry.start.owner.operationAttemptId,requestSha256:hashes['round-1.request.json'],
      rawResponseSha256:hashes['round-1.response.json'],
      activationA0:entry.start.activationA0,activationA1:entry.start.activationA1,
      terminalActivationId:marker.confirmation.activationId,
      contractSha256:firstRun.contractSha256,hashes});
  }
  const final=JSON.parse(await fs.readFile(path.join(
    firstRun.executionRoot,
    'activation.json'),'utf8'));
  const readbacks=JSON.parse(await fs.readFile(path.join(runRoot,'readback.json'),'utf8'));
  if(readbacks.some(item=>item.activationId!==final.activationId
    || item.deliveries[0]?.formalStatus!=='PASS'
    || item.deliveries[0]?.counters.validationAttempts!==3))
    throw new Error('final distributed readback differs');
  const packageInfo={format:'ec1-s2-live-evidence-v1',runs,
    finalActivationId:final.activationId,finalSequence:final.sequence,readbacks};
  await fs.writeFile(path.join(runRoot,'evidence-package.json'),JSON.stringify(packageInfo,null,2)+'\n',{flag:'wx',mode:0o600});
  return packageInfo;
}
try {
  const [command,arg]=process.argv.slice(2);
  if(command==='prepare') output(await setup());
  else if(command==='prepare-findings') output(await setup({defect:true}));
  else if(command==='apply-begin') output(await applyBegin(arg));
  else if(command==='apply-dispatch') output(await applyDispatch(arg));
  else if(command==='formal-begin') output(await formalBegin(arg));
  else if(command==='drift-after-pass') output(await afterPassDrift(arg));
  else if(command==='second') output(await second(arg));
  else if(command==='readback') output(await readback(arg));
  else if(command==='package') output(await packageEvidence(arg));
  else if(command==='publish-fault-after-candidate-file') {
    const handle=JSON.parse(await fs.readFile(arg,'utf8'));
    output(await publish(handle,{checkpoint:async phase=>{
      if(phase==='after-candidate-file') throw Object.assign(new Error('EC1_CONTROLLED_CANDIDATE_FILE_FAILURE'),{code:'CONTROLLED_CANDIDATE_FAILURE'});
    }}));
  }
  else if(command==='fault-after-capture') {
    const handle=JSON.parse(await fs.readFile(arg,'utf8'));
    const status=await resume(handle);
    if(status.phase!=='captured') throw new Error('fault injection requires settled capture');
    process.stderr.write('EC1_CONTROLLED_FAILURE_AFTER_CAPTURE\n');process.exitCode=77;
  } else {process.stderr.write('Usage: smoke-current-native-operation.mjs prepare|second RUN_ROOT|readback RUN_ROOT|package RUN_ROOT|fault-after-capture HANDLE_FILE\n');process.exitCode=2;}
} catch(error) {output({code:error.code??'SMOKE_BLOCKED',reason:error.message});process.exitCode=1;}
