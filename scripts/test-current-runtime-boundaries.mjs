import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {acquireExecutionPublicationLock,releaseExecutionPublicationLock,executionLockIdentity} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {checkDistributableSkill,EXECUTION_DISTRIBUTION_POLICY} from './lib/check-distributable-skill.mjs';
const environment=process.env;
const deepRoot=(root,n)=>path.join(root,...Array.from({length:n},(_,i)=>'depth-'+i));
async function fixture(){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-neutral-')));await fs.mkdir(path.join(root,'.git'));return {root,workspace:{executionRoot:path.join(root,'requirements-execution'),specRoot:null}};}
test('exclusive lock in separate processes/barrier; no age stealing or foreign release', async () => {
  const f = await fixture();
  try {
    const moduleUrl = pathToFileURL(path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs')).href;
    const childFile = path.join(f.root, 'lock-child.mjs');
    await fs.writeFile(childFile, `import { acquireExecutionPublicationLock, releaseExecutionPublicationLock } from ${JSON.stringify(moduleUrl)};
const lease = await acquireExecutionPublicationLock(JSON.parse(process.argv[2])); process.send({ locked: true });
process.on('message', async message => { if (message === 'release') { await releaseExecutionPublicationLock(lease); process.send({ released: true }); process.exit(0); } });`);
    const child = fork(childFile, [JSON.stringify(f.workspace)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const message = () => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    assert.deepEqual(await message(), { locked: true });
    const location = await executionLockIdentity(f.workspace);
    const before = await fs.readFile(location.lockPath);
    await assert.rejects(acquireExecutionPublicationLock(f.workspace), /already exists/);
    assert.ok((await fs.readFile(location.lockPath)).equals(before));
    const released = message(); child.send('release'); assert.deepEqual(await released, { released: true });
    const lease = await acquireExecutionPublicationLock(f.workspace);
    await fs.writeFile(lease.lockPath, 'foreign old malformed lock');
    await assert.rejects(releaseExecutionPublicationLock(lease), /ownership/);
    await assert.rejects(acquireExecutionPublicationLock(f.workspace), /already exists/);
    assert.equal(await fs.readFile(location.lockPath, 'utf8'), 'foreign old malformed lock');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('U2-R4-F1 unowned deep standalone authority terminates ancestry traversal in another process',async()=>{
  const f=await fixture(),directory=deepRoot(f.root,40);await fs.mkdir(directory,{recursive:true});
  const authority=path.join(directory,'requirements.md');await fs.writeFile(authority,'# Legitimate deep standalone authority\n');
  const module=pathToFileURL(path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-state.mjs')).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {resolveExecutionWorkspace} from ${JSON.stringify(module)};console.log(JSON.stringify(await resolveExecutionWorkspace(${JSON.stringify(authority)})));`],{env:environment,encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);const resolved=JSON.parse(child.stdout);assert.equal(resolved.authorityPath,authority);assert.equal(resolved.kind,'standalone');
  await fs.rm(f.root,{recursive:true,force:true});
});
test('U2-R3 distribution permits only the named recipe producer to execute external commands',async()=>{
  const f=await fixture(),root=path.join(f.root,'minimal-distribution'),runtime=path.join(root,'runtime');await fs.mkdir(runtime,{recursive:true});
  for(const file of ['runner-verification.mjs','execution-publication.mjs','execution-current.mjs'])await fs.copyFile(path.resolve('skills/workflows/stnl-slice-executor/runtime',file),path.join(runtime,file));
  assert.deepEqual(await checkDistributableSkill(root,EXECUTION_DISTRIBUTION_POLICY),[]);
  assert.ok((await checkDistributableSkill(root)).some(message=>message.includes('operational runtime must not execute external commands')));
  await fs.writeFile(path.join(runtime,'other-operation.mjs'),'import {execFile} from "node:child_process";\n');
  const refused=await checkDistributableSkill(root,EXECUTION_DISTRIBUTION_POLICY);
  assert.ok(refused.some(message=>message.includes('runtime/other-operation.mjs')));
  await fs.rm(f.root,{recursive:true,force:true});
});

test('retired managed entrypoints refuse finitely before consuming stdin or dispatch',async t=>{
 const {spawn}=await import('node:child_process');
 for(const entry of ['validation-runner.mjs','managed-runner-bridge.mjs','managed-slice-preflight.mjs','managed-slice-finalize.mjs'])await t.test(entry,async()=>{
  const child=spawn(process.execPath,[path.resolve('agents/codex/runtime',entry)],{stdio:['pipe','pipe','pipe']});
  let stderr='',stdout='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',chunk=>stdout+=chunk);
  const timer=setTimeout(()=>child.kill('SIGTERM'),2500);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
  assert.deepEqual(result,{code:1,signal:null});assert.equal(stdout,'');assert.match(stderr,/^CURRENT_MANAGED_UNAVAILABLE:/u);
 });
 const {createManagedSliceContext}=await import('../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs');
 const {startOfficialRunnerBroker,submitOfficialRunnerRequest}=await import('../agents/codex/runtime/runner-broker.mjs');
 for(const action of [createManagedSliceContext,startOfficialRunnerBroker,submitOfficialRunnerRequest])assert.throws(()=>action({}),e=>e.code==='CURRENT_MANAGED_UNAVAILABLE');
});


test('benchmark product imports current contracts without the retired serializer or dispatch',async()=>{
 const {loadProduct}=await import('../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs');
 const product=await loadProduct(path.resolve('.'));
 const current=await import('../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs');
 const semantic=await import('../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs');
 assert.equal(product.inspectExecutionState,current.inspectExecutionState);
 assert.equal(product.parseSemanticExecutionPayload,semantic.parseSemanticExecutionPayload);
 assert.equal(product.parseSemanticValidationPayload,semantic.parseSemanticValidationPayload);
 assert.throws(()=>product.createManagedSliceContext({}),error=>error.code==='CURRENT_MANAGED_UNAVAILABLE');
});
