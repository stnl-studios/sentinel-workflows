import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {publishCandidate, recoverIncompletePublication, journalPath, lockPath} from
  '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {resolveExecutionFilesystemRoots, executionLockIdentity} from
  '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs';
import {temporaryDirectory, removeTemporaryDirectory, buildResumeFixture, snapshot} from
  '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';

async function fixture(t) {
  const root=await fs.realpath(await temporaryDirectory('lifecycle-filesystem-roles-'));
  t.after(()=>removeTemporaryDirectory(root));
  const f=await buildResumeFixture(root,{candidateWhitespaceChange:true});
  const workspace={specRoot:f.target,executionRoot:path.join(f.target,'execution')};
  return {...f,root,workspace,roots:await resolveExecutionFilesystemRoots(workspace)};
}
const identity=meta=>({dev:String(meta.dev),ino:String(meta.ino)});

test('lifecycle uses material roles and persists exact parents while synchronizing both rename parents',async t=>{
  const f=await fixture(t),before=snapshot(f.target),input=snapshot(f.candidate);
  const probe=await fs.open(f.root,'r'),prototype=Object.getPrototypeOf(probe),originalSync=prototype.sync;
  await probe.close();
  const synchronized=[];let track=false,journal;
  prototype.sync=async function(){const meta=await this.stat();if(track&&meta.isDirectory())synchronized.push(identity(meta));return originalSync.call(this);};
  try {
    await publishCandidate('RESUME',f.target,f.candidate,{manifestPath:f.manifest,
      beforePublish:async paths=>{
        assert.equal(paths.target,f.target);
        assert.equal(path.dirname(paths.stage),f.roots.materialRoot);
        assert.equal(path.dirname(paths.backup),f.roots.materialRoot);
        assert.equal(paths.lock,await lockPath(f.target));track=true;
      },afterJournalPrepared:async()=>{
        journal=JSON.parse(await fs.readFile(await journalPath(f.target)));
        assert.equal(journal.filesystem_context.targetParent.path,f.roots.targetParent);
        assert.equal(journal.filesystem_context.materialParent.path,f.roots.materialRoot);
        for(const [role,file] of [['targetParent',f.roots.targetParent],['leaseParent',f.roots.leaseParent],['materialParent',f.roots.materialRoot]])
          assert.deepEqual(journal.filesystem_context[role].identity,identity(await fs.lstat(file)));
      }});
  }finally{prototype.sync=originalSync;}
  assert.ok(journal);
  for(const file of [f.roots.targetParent,f.roots.materialRoot]) {
    const expected=identity(await fs.lstat(file));
    assert.ok(synchronized.some(value=>JSON.stringify(value)===JSON.stringify(expected)));
  }
  assert.notEqual(snapshot(f.target),before);
  assert.equal(snapshot(f.candidate),input,'external candidate is input, never the owned stage');
  assert.equal(await fs.stat(path.join(path.dirname(f.target),`.${path.basename(f.target)}.lifecycle.lock`)).catch(()=>null),null);
  assert.equal(await recoverIncompletePublication(f.target),false);
});

for(const role of ['materialRoot','leaseParent','targetParent'])test(`lifecycle refuses a replaced ${role} with identical child inodes before the official rename`,async t=>{
  const f=await fixture(t),official=snapshot(f.target),input=snapshot(f.candidate);let changed=false,caught;
  try {
    await publishCandidate('RESUME',f.target,f.candidate,{manifestPath:f.manifest,beforePublish:async()=>{
      const roots=await resolveExecutionFilesystemRoots(f.workspace),directory=roots[role],saved=directory+'.original';
      t.after(()=>fs.rmdir(saved).catch(error=>{if(error.code!=='ENOENT')throw error;}));
      await fs.rename(directory,saved);await fs.mkdir(directory);
      for(const name of await fs.readdir(saved))await fs.rename(path.join(saved,name),path.join(directory,name));
      changed=true;
    }});
  }catch(error){caught=error;}
  assert.equal(changed,true);assert.match(caught?.message??'',/physical role changed|physical context|physical role|filesystem/i);
  assert.equal(caught?.retainExecutionLock,true);
  assert.equal(snapshot(f.target),official);assert.equal(snapshot(f.candidate),input);
  await fs.access((await executionLockIdentity(f.workspace)).lockPath);
});

test('lifecycle refuses a changed persisted parent proof without rewriting pending controls',async t=>{
  const f=await fixture(t);let journal;
  await assert.rejects(publishCandidate('RESUME',f.target,f.candidate,{manifestPath:f.manifest,
    afterJournalPrepared:async()=>{
      journal=await journalPath(f.target);const record=JSON.parse(await fs.readFile(journal));
      record.filesystem_context.materialParent.identity.ino='0';await fs.writeFile(journal,JSON.stringify(record));
      throw new Error('controlled changed context');
    }}));
  const bytes=await fs.readFile(journal);
  await assert.rejects(recoverIncompletePublication(f.target),/physical context|ownership identity|payload/i);
  assert.deepEqual(await fs.readFile(journal),bytes);
});
