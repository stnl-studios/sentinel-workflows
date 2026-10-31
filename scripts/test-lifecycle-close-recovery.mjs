import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {publishCandidate,recoverIncompletePublication,TEST_ONLY_ACK,TEST_ONLY_ACK_ENV,TEST_ONLY_CRASH_ENV} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {resolveExecutionFilesystemRoots} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs';
import {temporaryDirectory,READY_FIXTURE,copyTree,snapshot,PUBLISHER_CLI} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
const run=promisify(execFile),module=pathToFileURL(path.resolve('skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs')).href;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const root=await fs.realpath(await temporaryDirectory('lifecycle-close-binding-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const target=path.join(root,'target');await copyTree(READY_FIXTURE,target);const workspace={specRoot:target,executionRoot:path.join(target,'execution')};return {root,target,workspace,roots:await resolveExecutionFilesystemRoots(workspace)};}
const cli=async f=>JSON.parse((await run(process.execPath,['--input-type=module','-e',`import {publishCandidate} from ${JSON.stringify(module)};console.log(JSON.stringify(await publishCandidate('CLOSE',process.argv[1],null,{beforeCommittedCleanup:async()=>{throw new Error('controlled pending before terminal cleanup');}})));`,f.target],{timeout:30000})).stdout);
const recover=async f=>JSON.parse((await run(process.execPath,['--input-type=module','-e',`import {recoverIncompletePublication} from ${JSON.stringify(module)};console.log(JSON.stringify(await recoverIncompletePublication(process.argv[1])));`,f.target],{timeout:30000})).stdout);
async function controls(f){const rows=[];for(const dir of [f.roots.materialRoot,f.roots.leaseParent])for(const name of (await fs.readdir(dir).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).sort()){const file=path.join(dir,name),meta=await fs.lstat(file);if(meta.isFile())rows.push([file,String(meta.dev),String(meta.ino),meta.nlink,sha(await fs.readFile(file))]);}return rows;}

test('CLOSE returns honest pending JSON, retains original backup until cleanup resumes the same binding in fresh processes',async t=>{
 const f=await fixture(t),before=snapshot(f.target),source=await fs.lstat(f.target),result=await cli(f);
 assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'pending');assert.equal(result.sourceExecutionDisposition.kind,'absent');assert.match(result.closedSnapshotSha256,/^sha256:[0-9a-f]{64}$/u);
 const journal=JSON.parse(await fs.readFile(f.roots.lifecycleJournal)),ownershipFile=path.join(f.roots.materialRoot,`.target.lifecycle-ownership-${result.transactionId}.json`),ownership=JSON.parse(await fs.readFile(ownershipFile));
 assert.equal(journal.phase,'committed');assert.equal(journal.transaction_id,result.transactionId);assert.deepEqual(journal.close_binding,ownership.close_binding);assert.equal(journal.close_binding.requirementsAuthority,result.requirementsAuthority);assert.equal(journal.close_binding.sourceIdentity.ino,String(source.ino));
 const backup=path.join(f.roots.materialRoot,journal.backup);assert.equal((await fs.lstat(backup)).ino,source.ino);assert.equal(snapshot(backup),before);
 const published=snapshot(f.target),bytes=await fs.readFile(f.roots.lifecycleJournal);
 const recovered=await recover(f);assert.equal(recovered.cleanup,'complete');assert.equal(recovered.transactionId,result.transactionId);assert.equal(recovered.closedSnapshotSha256,result.closedSnapshotSha256);assert.equal(snapshot(f.target),published);assert.equal(await fs.lstat(backup).catch(()=>null),null);assert.equal(await recover(f),false);assert.equal(snapshot(f.target),published);
});

for(const mutation of ['missing','unknown','authority','source-inode','disposition'])test(`CLOSE binding ${mutation} blocks recovery without adopting or cleaning anything`,async t=>{
 const f=await fixture(t);await cli(f);const journal=JSON.parse(await fs.readFile(f.roots.lifecycleJournal));
 if(mutation==='missing')delete journal.close_binding;
 if(mutation==='unknown')journal.close_binding.extra='foreign';
 if(mutation==='authority')journal.close_binding.requirementsAuthority='sha256:'+'f'.repeat(64);
 if(mutation==='source-inode')journal.close_binding.sourceIdentity.ino='0';
 if(mutation==='disposition')journal.close_binding.sourceExecutionDisposition={kind:'trust-me'};
 await fs.writeFile(f.roots.lifecycleJournal,JSON.stringify(journal)+'\n');const before=await controls(f),published=snapshot(f.target);
 await assert.rejects(recoverIncompletePublication(f.target),/CLOSE|binding|ownership|journal/u);assert.deepEqual(await controls(f),before);assert.equal(snapshot(f.target),published);
});

for(const mutation of ['absent','replacement','bytes'])test(`pending CLOSE refuses ${mutation} retained backup without destroying controls`,async t=>{
 const f=await fixture(t);await cli(f);const journal=JSON.parse(await fs.readFile(f.roots.lifecycleJournal)),backup=path.join(f.roots.materialRoot,journal.backup);
 if(mutation==='absent')await fs.rename(backup,path.join(f.root,'retained-source'));
 if(mutation==='replacement'){const retained=path.join(f.root,'retained-source');await fs.rename(backup,retained);await copyTree(retained,backup);}
 if(mutation==='bytes'){const existing=path.join(backup,'feature_spec.md');assert.equal((await fs.lstat(existing)).isFile(),true);await fs.appendFile(existing,'\nforeign mutation\n');}
 const before=await controls(f),published=snapshot(f.target);await assert.rejects(recover(f),/source|backup|identity|snapshot/u);assert.deepEqual(await controls(f),before);assert.equal(snapshot(f.target),published);
});

test('a typed pending result from a live owner keeps both leases and cannot be recovered by a second process',async t=>{
 const f=await fixture(t),code=`import {publishCandidate} from ${JSON.stringify(module)};process.send(await publishCandidate('CLOSE',process.argv[1],null,{beforeCommittedCleanup:async()=>{throw new Error('controlled live pending owner');}}));await new Promise(resolve=>process.once('message',resolve));process.disconnect();`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,f.target],{stdio:['ignore','pipe','pipe','ipc']});t.after(()=>child.kill('SIGTERM'));let stderr='';child.stderr.on('data',b=>stderr+=b);
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('pending owner timeout: '+stderr)),10000);child.once('message',v=>{clearTimeout(timer);resolve(v);});child.once('error',reject);});
 assert.equal(result.cleanup,'pending');const before=await controls(f);await assert.rejects(recoverIncompletePublication(f.target),/proven-dead local owner/u);assert.deepEqual(await controls(f),before);
 const exited=new Promise(resolve=>child.once('exit',resolve));child.send('exit');assert.equal(await exited,0);const recovered=await recover(f);assert.equal(recovered.transactionId,result.transactionId);assert.equal(recovered.cleanup,'complete');
});

test('an API error after durable CLOSE commit reports confirmation and preserves cleanup authority',async t=>{
 const f=await fixture(t),code=`import {publishCandidate} from ${JSON.stringify(module)};console.log(JSON.stringify(await publishCandidate('CLOSE',process.argv[1],null,{beforeCommittedCleanup:async()=>{throw new Error('controlled postcommit cleanup failure');}})));`;
 const result=JSON.parse((await run(process.execPath,['--input-type=module','-e',code,f.target],{timeout:30000})).stdout);assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'pending');assert.match(result.cleanupDiagnostics[0],/controlled postcommit/u);
 const recovered=await recover(f);assert.equal(recovered.transactionId,result.transactionId);assert.deepEqual(recovered.sourceExecutionDisposition,result.sourceExecutionDisposition);assert.equal(recovered.closedSnapshotSha256,result.closedSnapshotSha256);assert.equal(recovered.cleanup,'complete');
});

for(const checkpoint of ['JOURNAL_PREPARED','TARGET_TO_BACKUP_RENAMED','STAGE_TO_TARGET_RENAMED','AFTER_TARGET_VALIDATION'])test(`CLOSE crash ${checkpoint} recovers the existing transaction without a new render`,async t=>{
 const f=await fixture(t),source=snapshot(f.target),sourceIdentity=await fs.lstat(f.target);
 await assert.rejects(run(process.execPath,[PUBLISHER_CLI,'CLOSE',f.target],{timeout:30000,env:{...process.env,[TEST_ONLY_ACK_ENV]:TEST_ONLY_ACK,[TEST_ONLY_CRASH_ENV]:checkpoint}}),error=>error.signal==='SIGKILL');
 const journal=JSON.parse(await fs.readFile(f.roots.lifecycleJournal)),binding=structuredClone(journal.close_binding),result=await recover(f);
 if(checkpoint==='AFTER_TARGET_VALIDATION'){
   assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');assert.equal(result.transactionId,journal.transaction_id);assert.deepEqual(result.sourceExecutionDisposition,binding.sourceExecutionDisposition);
   assert.equal(await fs.lstat(path.join(f.roots.materialRoot,journal.backup)).catch(()=>null),null);assert.equal(await recover(f),false);
 }else{
   assert.equal(result,true);assert.equal(snapshot(f.target),source);assert.equal((await fs.lstat(f.target)).ino,sourceIdentity.ino);assert.equal(await recover(f),false);
 }
});
