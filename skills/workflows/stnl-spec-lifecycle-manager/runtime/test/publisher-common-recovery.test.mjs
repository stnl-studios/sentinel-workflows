import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { publishCandidate, recoverIncompletePublication, lockPath, journalPath, TEST_ONLY_ACK } from '../lib/publisher.mjs';
import { acquireExecutionPublicationLock, assertExecutionPublicationLock, releaseExecutionPublicationLock, executionLockIdentity,resolveExecutionFilesystemRoots } from '../lib/execution-publication.mjs';
import { workspaceSnapshot, validateWorkspace } from '../lib/lifecycle.mjs';
import { temporaryDirectory, copyTree, READY_FIXTURE, PUBLISHER_CLI, buildResumeFixture } from './publisher-fixtures.mjs';

const PUBLISHER = new URL('../lib/publisher.mjs', import.meta.url).href;
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const environment = () => { const env = {...process.env}; for (const key of Object.keys(env)) if (key.startsWith('STNL_PUBLISHER_TEST_ONLY_')) delete env[key]; delete env.NODE_TEST_CONTEXT; return env; };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value) + '\n');
async function fixture(t, label) {
  const root = await fs.realpath(await temporaryDirectory(`stnl-common-${label}-`));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const target = path.join(root, 'target'), candidate = path.join(root, 'candidate');
  await copyTree(READY_FIXTURE, candidate);
  return {root, target, candidate};
}
function crash(f, checkpoint = 'JOURNAL_PREPARED', cli = PUBLISHER_CLI, args = ['INIT', f.target, f.candidate]) {
  const result = spawnSync(process.execPath, [cli, ...args], {env:{...environment(), STNL_PUBLISHER_TEST_ONLY_CRASH_AT_CHECKPOINT:checkpoint,
    STNL_PUBLISHER_TEST_ONLY_ACKNOWLEDGE_PROCESS_KILL:TEST_ONLY_ACK}, encoding:'utf8', timeout:20000});
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  assert.throws(() => process.kill(result.pid, 0), error => error.code === 'ESRCH');
  return result;
}
async function controls(f) {
  const rows=[],roots=await resolveExecutionFilesystemRoots(workspace(f.target));
  for(const directory of new Set([f.root,roots.leaseParent,roots.materialRoot])) {
    for(const name of (await fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).sort()) {
      const file=path.join(directory,name),meta=await fs.lstat(file);
      if(!meta.isFile())continue;
      rows.push({name:path.relative(f.root,file),identity:{dev:String(meta.dev),ino:String(meta.ino)},links:meta.nlink,sha256:sha(await fs.readFile(file))});
    }
  }
  return rows.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
}

const workspace = target => ({specRoot:target, executionRoot:path.join(target, 'execution')});
async function unchangedBlocked(f, pattern = /binding|recovery|lock|journal|ownership/u, recover = () => recoverIncompletePublication(f.target)) {
  const before = await controls(f);
  await assert.rejects(recover(), pattern);
  assert.deepEqual(await controls(f), before);
  assert.equal(await fs.stat(f.target).catch(() => null), null);
}
async function launch(code, args = []) {
  const child = spawn(process.execPath, ['--input-type=module','-e',code,...args], {env:environment(), stdio:['ignore','pipe','pipe','ipc']});
  let stderr=''; child.stderr.on('data', bytes => stderr += bytes);
  const exited = new Promise(resolve => child.once('exit', (code,signal) => resolve({code,signal,stderr})));
  const message = () => new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(new Error(`child IPC timed out: ${stderr}`)),20000);
    child.once('message', value => {clearTimeout(timeout); resolve(value);});
    child.once('error', error => {clearTimeout(timeout); reject(error);});
  });
  return {child, exited, message};
}

test('SIGKILL INIT explicitly recovers exact staged history and reentry is idempotent', async t => {
  const f = await fixture(t, 'init'); const original = workspaceSnapshot(f.candidate);
  crash(f);
  const common = (await executionLockIdentity(workspace(f.target))).lockPath;
  const locked = await json(await lockPath(f.target)), lease = await json(common);
  assert.equal(locked.version,2); assert.equal(locked.common_lease.token,lease.token);
  assert.equal(locked.common_lease.sha256,sha(await fs.readFile(common)));
  assert.equal(locked.common_lease.pid,locked.pid); assert.equal(locked.common_lease.hostname,locked.hostname);
  // Normal kernel remains closed; only lifecycle recovery has the exception.
  await unchangedBlocked(f, /lock already exists/u, () => acquireExecutionPublicationLock(workspace(f.target)));
  assert.equal(await recoverIncompletePublication(f.target),true);
  validateWorkspace(f.target); assert.deepEqual(workspaceSnapshot(f.target),original);
  const recovered = workspaceSnapshot(f.target);
  assert.equal(await recoverIncompletePublication(f.target),false);
  await assert.rejects(publishCandidate('INIT',f.target,f.candidate), /INIT destination already exists/u);
  assert.deepEqual(workspaceSnapshot(f.target),recovered);
  assert.equal(await fs.stat(await journalPath(f.target)).catch(()=>null),null);
  assert.equal(await fs.stat(common).catch(()=>null),null);
});

test('lifecycle retry completes interrupted INIT before diagnosing existing destination', async t => {
  const f = await fixture(t,'retry'); const original=workspaceSnapshot(f.candidate); crash(f);
  const result=spawnSync(process.execPath,[PUBLISHER_CLI,'INIT',f.target,f.candidate],{env:environment(),encoding:'utf8',timeout:20000});
  assert.equal(result.status,1); assert.match(result.stderr,/INIT destination already exists/u);
  assert.deepEqual(workspaceSnapshot(f.target),original);
});

test('live publisher common lease stays excluded without changing any control', async t => {
  const f=await fixture(t,'live');
  const running=await launch(`import {publishCandidate} from ${JSON.stringify(PUBLISHER)}; await publishCandidate('INIT',process.argv[1],process.argv[2],{afterJournalPrepared:async()=>{process.send('prepared');await new Promise(resolve=>process.once('message',resolve));}});process.disconnect();`,[f.target,f.candidate]);
  t.after(()=>running.child.kill('SIGTERM'));
  assert.equal(await running.message(),'prepared');
  await unchangedBlocked(f,/proven-dead local owner/u);
  running.child.send('release'); assert.equal((await running.exited).code,0);
});

test('foreign, old, missing or tampered linkage and ambiguous controls preserve all bytes/inodes', async t => {
  for (const kind of ['foreign-host','missing-binding','token','inode','digest','root','common-bytes','journal-transaction','ownership','common-hardlink']) {
    await t.test(kind, async t => {
      const f=await fixture(t,kind); crash(f);
      const lock=await lockPath(f.target), record=await json(lock), common=record.common_lease.lockPath;
      if(kind==='foreign-host') {
        record.hostname='other-host.invalid'; record.common_lease.hostname=record.hostname;
      } else if(kind==='missing-binding') {record.version=1;delete record.common_lease;}
      else if(kind==='token') record.common_lease.token=randomUUID();
      else if(kind==='inode') record.common_lease.identity.ino='99999999';
      else if(kind==='digest') record.common_lease.sha256='sha256:'+'0'.repeat(64);
      else if(kind==='root') record.common_lease.executionRoot=path.join(f.root,'foreign','execution');
      else if(kind==='common-bytes') await fs.appendFile(common,' ');
      else if(kind==='journal-transaction') {const journal=await json(await journalPath(f.target));journal.transaction_id='a'.repeat(32);await writeJson(await journalPath(f.target),journal);}
      else if(kind==='ownership') {const file=path.join(path.dirname(await journalPath(f.target)),`.target.lifecycle-ownership-${record.transaction_id}.json`); const owner=await json(file);owner.candidate_snapshot_sha256='0'.repeat(64);await writeJson(file,owner);}
      else if(kind==='common-hardlink') await fs.link(common,path.join(f.root,'foreign-link'));
      await writeJson(lock,record);
      await unchangedBlocked(f);
    });
  }
});

test('uncertain liveness (EPERM) cannot reclaim a bound lease', async t => {
  const f=await fixture(t,'eperm');crash(f);const before=await controls(f);
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {recoverIncompletePublication} from ${JSON.stringify(PUBLISHER)};const original=process.kill;process.kill=()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});};try{await recoverIncompletePublication(process.argv[1]);process.exitCode=2;}catch(error){console.log(error.message);}finally{process.kill=original;}`,f.target],{env:environment(),encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/proven-dead local owner/u);assert.deepEqual(await controls(f),before);
});

function activeMarker(root, status) {
  const id=()=>randomUUID(), hash='sha256:'+'a'.repeat(64), activationId=id();
  return {format:'stnl-execution-activation-v2',activationId,sequence:1,previousActivationId:null,preparationRevision:1,
    requirementsAuthority:hash,normativeSha256:hash,approvedSnapshotSha256:hash,artifacts:[],lastAttempt:null,
    activeAttempt:{operationAttemptId:id(),ownershipToken:id(),deliveryId:id(),slice:'slice-01',operation:'EXECUTE_SLICE',preparationRevision:1,localRevision:1,
      normativeSha256:hash,originActivationId:activationId,operationRef:{operationId:id(),allocationSha256:hash}}};
}
test('absent target cannot bypass active or uncertain execution in retained backup', async t => {
  for(const status of [null,'uncertain']) await t.test(String(status),async t=>{
    const f=await fixture(t,`backup-${status}`);await fs.rm(f.candidate,{recursive:true});
    const r=await buildResumeFixture(f.root); f.target=r.target;f.candidate=r.candidate;
    crash(f,'TARGET_TO_BACKUP_RENAMED',PUBLISHER_CLI,['RESUME',r.target,r.candidate,'--manifest',r.manifest]);
    const journal=await json(await journalPath(f.target)),backup=path.join(path.dirname(await journalPath(f.target)),journal.backup);
    await fs.mkdir(path.join(backup,'execution'),{recursive:true});await writeJson(path.join(backup,'execution','activation.json'),activeMarker(backup,status));
    await unchangedBlocked(f,/active or uncertain execution/u);
  });
});

test('recovery claim excludes a second recoverer and normal writer; one winner retains exact content', async t => {
  const f=await fixture(t,'race'),original=workspaceSnapshot(f.candidate);crash(f);
  const running=await launch(`import fs from 'node:fs/promises';import {recoverIncompletePublication} from ${JSON.stringify(PUBLISHER)};const original=fs.link;fs.link=async(a,b)=>{await original(a,b);if(b.includes('.lock.recovery-')){process.send('claimed');await new Promise(resolve=>process.once('message',resolve));}};try{const result=await recoverIncompletePublication(process.argv[1]);process.send({result});}catch(e){process.send({error:e.message});process.exitCode=1;}process.disconnect();`,[f.target]);
  t.after(()=>running.child.kill('SIGTERM'));assert.equal(await running.message(),'claimed');
  const before=await controls(f);
  await assert.rejects(recoverIncompletePublication(f.target),/recovery is incomplete/u);
  await assert.rejects(acquireExecutionPublicationLock(workspace(f.target)),/recovery is incomplete/u);
  assert.deepEqual(await controls(f),before);
  const completion=running.message();running.child.send('release');assert.deepEqual(await completion,{result:true});assert.equal((await running.exited).code,0);
  assert.deepEqual(workspaceSnapshot(f.target),original);assert.equal(await recoverIncompletePublication(f.target),false);
});

test('a delayed recovery claim never retires or poisons a newly acquired common lease', async t => {
  const f=await fixture(t,'delayed'),original=workspaceSnapshot(f.candidate);crash(f);
  const running=await launch(`import fs from 'node:fs/promises';import {recoverIncompletePublication} from ${JSON.stringify(PUBLISHER)};const link=fs.link;fs.link=async(a,b)=>{if(b.includes('.lock.recovery-')){process.send('before-link');await new Promise(resolve=>process.once('message',resolve));}return link(a,b);};try{await recoverIncompletePublication(process.argv[1]);process.send('unexpected-success');process.exitCode=2;}catch(e){process.send({blocked:e.message});}process.disconnect();`,[f.target]);
  t.after(()=>running.child.kill('SIGTERM'));assert.equal(await running.message(),'before-link');
  assert.equal(await recoverIncompletePublication(f.target),true);
  const lease=await acquireExecutionPublicationLock(workspace(f.target));
  try {
    const before=await controls(f),reply=running.message();running.child.send('continue');
    assert.match((await reply).blocked,/changed before exclusive recovery claim/u);assert.equal((await running.exited).code,0);
    await assertExecutionPublicationLock(lease);assert.deepEqual(await controls(f),before);
    assert.deepEqual(workspaceSnapshot(f.target),original);
  } finally {await releaseExecutionPublicationLock(lease);}
});

test('controls changed after retirement claim block before removing the canonical common lease', async t => {
  const f=await fixture(t,'claim-drift');crash(f);
  const running=await launch(`import fs from 'node:fs/promises';import {recoverIncompletePublication} from ${JSON.stringify(PUBLISHER)};const link=fs.link;fs.link=async(a,b)=>{await link(a,b);if(b.includes('.lock.recovery-')){process.send('claimed');await new Promise(resolve=>process.once('message',resolve));}};try{await recoverIncompletePublication(process.argv[1]);process.send('unexpected-success');process.exitCode=2;}catch(e){process.send({blocked:e.message});}process.disconnect();`,[f.target]);
  t.after(()=>running.child.kill('SIGTERM'));assert.equal(await running.message(),'claimed');
  await fs.appendFile(await journalPath(f.target),' ');const before=await controls(f),reply=running.message();running.child.send('continue');
  assert.match((await reply).blocked,/recovery control changed/u);assert.equal((await running.exited).code,0);
  assert.deepEqual(await controls(f),before);assert.equal(await fs.stat(f.target).catch(()=>null),null);
  await assert.rejects(recoverIncompletePublication(f.target),/recovery is incomplete/u);
});

test('SIGKILL during handoff preserves diagnostic claim and blocks subsequent work', async t => {
  for(const point of ['claimed','retired','installed']) await t.test(point,async t=>{
    const f=await fixture(t,point);crash(f);
    const code=`import fs from 'node:fs/promises';import {recoverIncompletePublication} from ${JSON.stringify(PUBLISHER)};const point=process.argv[2];const pause=async()=>{process.send('paused');await new Promise(()=>{});};const link=fs.link,unlink=fs.unlink;fs.link=async(a,b)=>{const r=await link(a,b);if(point==='claimed'&&b.includes('.lock.recovery-'))await pause();return r;};fs.unlink=async(a)=>{const r=await unlink(a);if(point==='retired'&&a===process.argv[3])await pause();if(point==='installed'&&a.includes('.lock.recovery-'))await pause();return r;};await recoverIncompletePublication(process.argv[1]);`;
    const running=await launch(code,[f.target,point,(await executionLockIdentity(workspace(f.target))).lockPath]);t.after(()=>running.child.kill('SIGTERM'));assert.equal(await running.message(),'paused');running.child.kill('SIGKILL');assert.equal((await running.exited).signal,'SIGKILL');
    const before=await controls(f);await assert.rejects(recoverIncompletePublication(f.target),/recovery is incomplete|differs from lifecycle binding/u);
    assert.deepEqual(await controls(f),before);assert.equal(await fs.stat(f.target).catch(()=>null),null);
    assert.ok(await fs.stat(await journalPath(f.target)));assert.ok((await fs.readdir(path.dirname(await journalPath(f.target)))).some(name=>name.includes('lifecycle-stage-')));
  });
});

test('copied lifecycle runtime recovers through its own complete common kernel', async t => {
  const f=await fixture(t,'copied'),runtime=path.join(f.root,'runtime');
  await fs.cp(path.resolve(import.meta.dirname,'..'),runtime,{recursive:true,filter:source=>!source.includes(`${path.sep}test`)});
  const cli=path.join(runtime,'publish-spec-lifecycle.mjs');crash(f,'JOURNAL_PREPARED',cli);
  const module=pathToFileURL(path.join(runtime,'lib/publisher.mjs')).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {recoverIncompletePublication} from ${JSON.stringify(module)};console.log(await recoverIncompletePublication(process.argv[1]));`,f.target],{env:environment(),encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'true');validateWorkspace(f.target);
  assert.deepEqual(workspaceSnapshot(f.target),workspaceSnapshot(f.candidate));
});
