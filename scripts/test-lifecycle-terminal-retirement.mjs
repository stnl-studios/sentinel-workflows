import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {syncBuiltinESMExports} from 'node:module';
import {publishCandidate,TEST_ONLY_ACK,TEST_ONLY_ACK_ENV,TEST_ONLY_CRASH_ENV} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {readOwnedFile,executionLockIdentity,resolveExecutionFilesystemRoots,releaseExecutionPublicationLock,withExecutionPublicationLock,acquireLifecycleTerminalRetirementLock,inspectLifecycleTerminalRetirement,removeLifecycleTerminalRetirementRole,validateLifecycleTerminalRetirement,validateCurrentOperationRetirementRecord,validateLifecycleRetirementManifest,beginLifecycleTerminalRetirement,lifecycleCommonLeaseBinding} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs';
import {temporaryDirectory,READY_FIXTURE,copyTree,snapshot,PUBLISHER_CLI} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
const run=promisify(execFile);
async function fixture(t){const root=await fs.realpath(await temporaryDirectory('u314-terminal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const target=path.join(root,'target');await copyTree(READY_FIXTURE,target);const workspace={specRoot:target,executionRoot:path.join(target,'execution')};return {root,target,workspace,roots:await resolveExecutionFilesystemRoots(workspace)};}
async function closed(t){const f=await fixture(t);
 await assert.rejects(run(process.execPath,[PUBLISHER_CLI,'CLOSE',f.target],{timeout:30000,env:{...process.env,[TEST_ONLY_ACK_ENV]:TEST_ONLY_ACK,[TEST_ONLY_CRASH_ENV]:'TERMINAL_WITNESS_DURABLE'}}),error=>error.signal==='SIGKILL');
 const owned=await readOwnedFile(f.roots.lockPath),record=JSON.parse(owned.bytes);return {...f,owned,record};}

test('confirmed CLOSE durably seals the existing common lease before any source or last control is removed',async t=>{
 const f=await closed(t);assert.equal(f.record.format,'stnl-execution-lock-v2');
 const witness=validateLifecycleTerminalRetirement(f.record.terminalRetirement),journal=JSON.parse(await fs.readFile(f.roots.lifecycleJournal)),lock=JSON.parse(await fs.readFile(f.roots.lifecycleLock));
 assert.equal(witness.transactionId,journal.transaction_id);assert.deepEqual(witness.closeBinding,journal.close_binding);assert.equal(witness.sourceCommonLease.sha256,lock.common_lease.sha256);assert.match(witness.closedSnapshotSha256,/^sha256:[a-f0-9]{64}$/u);assert.equal(witness.roles.some(row=>row.path===journal.backup),true);
 for(const row of witness.roles)assert.equal(String((await fs.lstat(path.join(f.roots.materialRoot,...row.path.split('/')))).ino),row.identity.ino);
 const before=await fs.readFile(f.roots.lockPath);await assert.rejects(releaseExecutionPublicationLock({...await executionLockIdentity(f.workspace),token:f.record.token,owned:f.owned}),/generic release is forbidden/u);assert.deepEqual(await fs.readFile(f.roots.lockPath),before);
 await assert.rejects(withExecutionPublicationLock(f.workspace,()=>assert.fail('writer entered before settlement')),/lock already exists/u);
});

test('SIGKILL after the terminal witness leaves source and controls intact and excludes ordinary writers',async t=>{
 const f=await fixture(t),before=snapshot(f.target);
 await assert.rejects(run(process.execPath,[PUBLISHER_CLI,'CLOSE',f.target],{timeout:30000,env:{...process.env,[TEST_ONLY_ACK_ENV]:TEST_ONLY_ACK,[TEST_ONLY_CRASH_ENV]:'TERMINAL_WITNESS_DURABLE'}}),error=>error.signal==='SIGKILL');
 const record=JSON.parse(await fs.readFile(f.roots.lockPath)),journal=JSON.parse(await fs.readFile(f.roots.lifecycleJournal));assert.equal(record.format,'stnl-execution-lock-v2');assert.equal(snapshot(path.join(f.roots.materialRoot,journal.backup)),before);
 await assert.rejects(withExecutionPublicationLock(f.workspace,()=>assert.fail('writer entered after crash')),/lock already exists/u);
});

for(const fault of ['before-quarantine','canonical-replacement','parent-fsync'])test(`terminal CAS ${fault} preserves confirmation, witness and source`,async t=>{
 const f=await fixture(t),before=snapshot(f.target),rename=fs.rename,open=fs.open;let fired=false;
 fs.rename=async function(file,destination,...rest){if(file===f.roots.lockPath&&!fired){fired=true;if(fault==='before-quarantine')throw Object.assign(new Error('controlled common quarantine failure'),{code:'EIO'});if(fault==='canonical-replacement'){await rename.call(this,file,destination,...rest);await fs.writeFile(file,'foreign canonical bytes\n',{flag:'wx'});return;}}return rename.call(this,file,destination,...rest);};
 fs.open=async function(file,...rest){const handle=await open.call(this,file,...rest);if(fault==='parent-fsync'&&file===f.roots.leaseParent){const sync=handle.sync.bind(handle);handle.sync=async()=>{if(!fired&&(await fs.readdir(f.roots.leaseParent)).some(name=>name.startsWith(f.roots.specKey+'.lock.retired-'))){fired=true;throw Object.assign(new Error('controlled witness parent fsync uncertainty'),{code:'EIO'});}return sync();};}return handle;};syncBuiltinESMExports();
 let result;try{result=await publishCandidate('CLOSE',f.target,null);}finally{fs.rename=rename;fs.open=open;syncBuiltinESMExports();}
 assert.equal(fired,true);assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'pending');assert.ok(result.cleanupDiagnostics.length);const journal=JSON.parse(await fs.readFile(f.roots.lifecycleJournal));assert.equal(snapshot(path.join(f.roots.materialRoot,journal.backup)),before);
 const roles=(await fs.readdir(f.roots.leaseParent)).filter(name=>name.startsWith(f.roots.specKey+'.lock.retired-'));assert.equal(roles.length,1);assert.equal(JSON.parse(await fs.readFile(path.join(f.roots.leaseParent,roles[0]))).format,'stnl-execution-lock-v2');
 if(fault==='canonical-replacement')assert.equal(await fs.readFile(f.roots.lockPath,'utf8'),'foreign canonical bytes\n');
 await assert.rejects(withExecutionPublicationLock(f.workspace,()=>assert.fail('writer entered during uncertain terminal transition')),/recovery is incomplete|lock already exists/u);
});

for(const kind of ['foreign-file','foreign-directory','registry-active','preparation-active'])test(`CLOSE retirement preserves ${kind} and source before discard`,async t=>{
 const f=await fixture(t);await fs.mkdir(f.roots.materialRoot,{recursive:true});const file=path.join(f.roots.materialRoot,kind);
 if(kind==='foreign-directory')await fs.mkdir(file);
 else if(kind==='registry-active')await fs.writeFile(f.roots.operationRegistry,JSON.stringify({format:'stnl-current-operation-registry-v1',executionRoot:f.workspace.executionRoot,operations:[{operationId:'foreign',marker:'foreign'}]}));
 else if(kind==='preparation-active')await fs.writeFile(f.roots.preparationRegistry,JSON.stringify({format:'stnl-preparation-registry-v2',executionRoot:f.workspace.executionRoot,allocations:[{}]}));
 else await fs.writeFile(file,'sole foreign source\n');
 const before=snapshot(f.target),name=kind==='registry-active'?f.roots.operationRegistry:kind==='preparation-active'?f.roots.preparationRegistry:file,meta=await fs.lstat(name),bytes=meta.isFile()?await fs.readFile(name):null;
 await assert.rejects(publishCandidate('CLOSE',f.target,null),/retirement|association|registry/u);assert.equal(snapshot(f.target),before);assert.equal((await fs.lstat(name)).ino,meta.ino);if(bytes)assert.deepEqual(await fs.readFile(name),bytes);
});

test('a COMPLETE image alone cannot discard a superseded operation whose raw sources have no verified official replica',async t=>{
 const f=await completedNativeCase(t,{documentarySource:READY_FIXTURE,drift:true});await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
 const target=path.dirname(f.specPath),roots=await resolveExecutionFilesystemRoots({specRoot:target,executionRoot:path.join(target,'execution')}),before=snapshot(target),names=await fs.readdir(roots.materialRoot);
 await assert.rejects(publishCandidate('CLOSE',target,null),/faithful replica|private verification|captured bytes/u);assert.equal(snapshot(target),before);
 for(const name of names)assert.equal((await fs.stat(path.join(roots.materialRoot,name))).isDirectory()||name==='registry.json',true);
});

async function archivedCompleteFixture(t){
 const f=await completedNativeCase(t,{documentarySource:READY_FIXTURE,drift:true});await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
 const target=path.dirname(f.specPath),workspace={specRoot:target,executionRoot:path.join(target,'execution')},roots=await resolveExecutionFilesystemRoots(workspace),image=await captureCurrentExecution(f.specPath);
 const officialOwners=new Set();for(const [name,bytes] of image.files)if(name.startsWith('evidence/')){const bundle=JSON.parse(Buffer.from(bytes));for(const record of [...bundle.implementation,bundle.validation,...bundle.findingsChecks,...bundle.support].filter(Boolean))officialOwners.add(record.origin.operationAttemptId);}
 // Explicit fixture precondition: unique historical sources have already been
 // archived outside this namespace. Product never performs this move for CLOSE.
 const archive=path.join(f.root,'tmp','fixture-historical-archive');await fs.mkdir(archive);
 for(const name of await fs.readdir(roots.materialRoot)){const file=path.join(roots.materialRoot,name);if(!(await fs.lstat(file)).isDirectory())continue;const record=JSON.parse(await fs.readFile(path.join(file,'owner.json')));if(!officialOwners.has(record.binding.owner.operationAttemptId))await fs.rename(file,path.join(archive,name));}
 return {f,target,workspace,roots,image,archive};
}

test('terminal owners with faithful official copies are dispensable even when their confirmations precede the final activation',async t=>{
 const {target,workspace,roots,archive,image}=await archivedCompleteFixture(t),source=snapshot(target),execution=await fs.lstat(workspace.executionRoot);
 await assert.rejects(run(process.execPath,[PUBLISHER_CLI,'CLOSE',target],{timeout:30000,env:{...process.env,[TEST_ONLY_ACK_ENV]:TEST_ONLY_ACK,[TEST_ONLY_CRASH_ENV]:'TERMINAL_WITNESS_DURABLE'}}),error=>error.signal==='SIGKILL');
 const witness=JSON.parse(await fs.readFile(roots.lockPath)).terminalRetirement,backup=witness.roles.find(row=>row.kind==='directory'&&row.identity.ino===witness.closeBinding.sourceIdentity.ino);
 assert.equal(snapshot(path.join(roots.materialRoot,backup.path)),source);assert.equal((await fs.lstat(path.join(roots.materialRoot,backup.path,'execution'))).ino,execution.ino);assert.ok(witness.closeBinding.operationalInventory.some(row=>row.path.endsWith('/owner.json')));
 const result=await recoverFresh({target,roots});assert.equal(result.cleanupDiagnostics,undefined);assert.equal(result.cleanup,'complete');assert.equal(result.sourceExecutionDisposition.kind,'discard-current-complete');assert.equal(result.sourceExecutionDisposition.activationId,image.inspection.activationId);assert.equal(await fs.lstat(roots.materialRoot).catch(()=>null),null);assert.equal(await fs.lstat(roots.lockPath).catch(()=>null),null);assert.ok((await fs.readdir(archive)).length>0,'archived unique source remains intact');
});

for(const change of ['extra','digest','root','intent','role-parent','role-extra','role-backslash','role-nul'])test(`terminal witness closed contract refuses ${change}`,async t=>{
 const f=await closed(t),witness=structuredClone(f.record.terminalRetirement);
 if(change==='extra')witness.extra=true;if(change==='digest')witness.closedSnapshotSha256='fake';if(change==='root')witness.filesystemContext.specRoot=f.root;if(change==='intent')witness.intent='publish';if(change==='role-parent')witness.roles[0].path='../foreign';if(change==='role-extra')witness.roles[0].extra=true;if(change==='role-backslash')witness.roles[0].path='x\\..\\..\\foreign';if(change==='role-nul')witness.roles[0].path='x\0foreign';
 assert.throws(()=>validateLifecycleTerminalRetirement(witness),/terminal|retirement|unknown|CLOSE/u);
});

test('terminal operation subobjects do not admit unknown diagnostic or sole-source payloads',async t=>{
 const f=await completedNativeCase(t,{documentarySource:READY_FIXTURE,drift:true});await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
 const target=path.dirname(f.specPath),roots=await resolveExecutionFilesystemRoots({specRoot:target,executionRoot:path.join(target,'execution')}),name=(await fs.readdir(roots.materialRoot)).find(name=>name!=='registry.json'),owner=JSON.parse(await fs.readFile(path.join(roots.materialRoot,name,'owner.json')));
 assert.doesNotThrow(()=>validateCurrentOperationRetirementRecord(owner));
 for(const field of ['confirmation','runner','expectedInstalledActivation','preparation','cleanup','terminalTransition','candidate']){
   const mutated=structuredClone(owner);mutated[field].extra='sole diagnostic source';assert.throws(()=>validateCurrentOperationRetirementRecord(mutated),/unknown|fields|format/u,field);
 }
 for(const relative of ['a/../foreign','a//foreign','a/./foreign','C:\\foreign','../foreign','/foreign'])assert.throws(()=>validateLifecycleRetirementManifest([{path:relative,kind:'directory',identity:{dev:'1',ino:'1'},mode:0o700,sha256:null,linkTarget:null}]),/retirement role/u);
});

test('the complete common record size is checked before writing a terminal role or unlinking v1',async t=>{
 const source=await closed(t),f=await fixture(t);await fs.mkdir(f.roots.materialRoot,{recursive:true});f.roots=await resolveExecutionFilesystemRoots(f.workspace);
 await withExecutionPublicationLock(f.workspace,async lease=>{
   const intent=structuredClone(source.record.terminalRetirement);intent.sourceCommonLease=await lifecycleCommonLeaseBinding(lease);intent.filesystemContext={specRoot:f.target,productRoot:f.roots.productRoot,temporaryRoot:f.roots.temporaryRoot,excludedRoots:f.roots.excludedRoots,targetParentIdentity:f.roots.targetParentIdentity,leaseParentIdentity:f.roots.leaseParentIdentity};intent.materialRootIdentity=f.roots.materialRootIdentity;const meta=await fs.lstat(f.target);intent.targetIdentity={dev:String(meta.dev),ino:String(meta.ino)};
   intent.roles=[{path:'a',kind:'file',identity:{dev:'1',ino:'1'},mode:0o600,sha256:'sha256:'+'0'.repeat(64),linkTarget:null}];
   const gap=64*1024-16-Buffer.byteLength(JSON.stringify(intent));intent.roles[0].path+='a'.repeat(gap);assert.doesNotThrow(()=>validateLifecycleTerminalRetirement(intent));
   const before=await fs.readFile(f.roots.lockPath);await assert.rejects(beginLifecycleTerminalRetirement(lease,intent),/common record exceeds/u);assert.deepEqual(await fs.readFile(f.roots.lockPath),before);assert.deepEqual((await fs.readdir(f.roots.leaseParent)).filter(name=>name.includes('.retired-')),[]);
 });
});

 test('public CLOSE refuses unique fields inside otherwise terminal owners and preserves their source bytes',async t=>{
 const {target,roots}=await archivedCompleteFixture(t);const name=(await fs.readdir(roots.materialRoot)).find(name=>name!=='registry.json'),file=path.join(roots.materialRoot,name,'owner.json'),original=await fs.readFile(file),owner=JSON.parse(original),source=snapshot(target);
 for(const field of ['confirmation','runner','expectedInstalledActivation','preparation','cleanup','terminalTransition','candidate']){
   const mutated=structuredClone(owner);mutated[field].extra='unique source that must survive';const bytes=Buffer.from(JSON.stringify(mutated)+'\n');await fs.writeFile(file,bytes);const meta=await fs.lstat(file);
   await assert.rejects(publishCandidate('CLOSE',target,null),/unknown|fields|format/u,field);assert.equal(snapshot(target),source);assert.equal((await fs.lstat(file)).ino,meta.ino);assert.deepEqual(await fs.readFile(file),bytes);await fs.writeFile(file,original);
 }
 for(const variant of ['candidate-inode','previous-inode','intermediate-id','intermediate-predecessor','terminal-sequence']){
   const mutated=structuredClone(owner);
   if(variant==='candidate-inode')mutated.candidate.identity.ino='1';
   if(variant==='previous-inode')mutated.previous.identity.ino='1';
   if(variant==='intermediate-id')mutated.preparation.intermediateActivation.activationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
   if(variant==='intermediate-predecessor')mutated.preparation.intermediateActivation.previousActivationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
   if(variant==='terminal-sequence')mutated.expectedInstalledActivation.sequence+=2;
   const bytes=Buffer.from(JSON.stringify(mutated)+'\n');await fs.writeFile(file,bytes);const meta=await fs.lstat(file);
   await assert.rejects(publishCandidate('CLOSE',target,null),/association|transition|official reservation/u,variant);assert.equal(snapshot(target),source);assert.equal((await fs.lstat(file)).ino,meta.ino);assert.deepEqual(await fs.readFile(file),bytes);await fs.writeFile(file,original);
 }
});


const publisherModule=pathToFileURL(path.resolve('skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs')).href;
async function recoverFresh(f,{noAllocation=false}={}){const code=`import fs from 'node:fs/promises';import {recoverIncompletePublication} from ${JSON.stringify(publisherModule)};${noAllocation?"fs.mkdir=async()=>{throw new Error('unexpected mkdir after terminal absence');};":''}console.log(JSON.stringify(await recoverIncompletePublication(process.argv[1])));`;return JSON.parse((await run(process.execPath,['--input-type=module','-e',code,f.target],{timeout:30000})).stdout);}
async function assertSettled(f){assert.equal(await fs.lstat(f.roots.materialRoot).catch(()=>null),null);assert.equal(await fs.lstat(f.roots.lockPath).catch(()=>null),null);assert.deepEqual((await fs.readdir(f.roots.leaseParent)).filter(name=>name.startsWith(f.roots.specKey+'.lock.')),[]);}
test('normal CLOSE confirms publication, removes only dispensable material and returns complete',async t=>{
 const f=await fixture(t),result=await publishCandidate('CLOSE',f.target,null);assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');assert.equal(result.cleanupDiagnostics,undefined);await assertSettled(f);
 const closed=snapshot(f.target);assert.equal(await recoverFresh(f,{noAllocation:true}),false);assert.equal(snapshot(f.target),closed);await assertSettled(f);
});
for(const checkpoint of ['TERMINAL_WITNESS_DURABLE','TERMINAL_LAST_CONTROL_REMOVED','TERMINAL_NAMESPACE_REMOVED','TERMINAL_LEASE_RETIRED'])test(`terminal crash ${checkpoint} resumes the same bytes and intent without recreating material`,async t=>{
 const f=await fixture(t);await assert.rejects(run(process.execPath,[PUBLISHER_CLI,'CLOSE',f.target],{timeout:30000,env:{...process.env,[TEST_ONLY_ACK_ENV]:TEST_ONLY_ACK,[TEST_ONLY_CRASH_ENV]:checkpoint}}),error=>error.signal==='SIGKILL');
 const inspection=await inspectLifecycleTerminalRetirement(f.workspace),before=snapshot(f.target),intent=inspection.intent;
 const result=await recoverFresh(f);assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');assert.equal(result.transactionId,intent.transactionId);assert.equal(result.closedSnapshotSha256,intent.closedSnapshotSha256);assert.equal(snapshot(f.target),before);await assertSettled(f);assert.equal(await recoverFresh(f,{noAllocation:true}),false);
});
test('pending terminal CLOSE rejects external candidate and invalid options before any cleanup',async t=>{
 const f=await closed(t),before=snapshot(f.root);
 for(const [candidate,options,pattern] of [[f.target,{},/external candidate/u],[null,{manifestPath:f.target},/manifest/u],[null,{readinessAttestation:'auto'},/auto/u]]){
  await assert.rejects(publishCandidate('CLOSE',f.target,candidate,options),pattern);assert.equal(snapshot(f.root),before);
 }
});
async function faultedTerminalPublication(target,roots,fault){
 const f={target,roots},unlink=fs.unlink,open=fs.open;let fired=false,lastUnlinked=false;
 fs.unlink=async function(file,...rest){if(String(file).startsWith(f.roots.lockPath+'.retired-')&&await fs.lstat(f.roots.materialRoot).catch(()=>null)===null){if(fault==='last-unlink'&&!fired){fired=true;throw Object.assign(new Error('controlled last unlink failure'),{code:'EIO'});}const result=await unlink.call(this,file,...rest);lastUnlinked=true;return result;}return unlink.call(this,file,...rest);};
 fs.open=async function(file,...rest){const handle=await open.call(this,file,...rest);if(file===f.roots.leaseParent){const sync=handle.sync.bind(handle);handle.sync=async()=>{if(fault==='last-parent-fsync'&&lastUnlinked&&!fired){fired=true;throw Object.assign(new Error('controlled final parent fsync failure'),{code:'EIO'});}return sync();};}return handle;};syncBuiltinESMExports();
 let result;try{result=await publishCandidate('CLOSE',f.target,null);}finally{fs.unlink=unlink;fs.open=open;syncBuiltinESMExports();}
 return {result,fired};
}
for(const fault of ['last-unlink','last-parent-fsync'])test(`terminal ${fault} has honest confirmation and no reconstruction or false completion`,async t=>{
 const f=await fixture(t);
 const code=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {publishCandidate} from ${JSON.stringify(publisherModule)};${faultedTerminalPublication.toString()};console.log(JSON.stringify(await faultedTerminalPublication(process.argv[1],JSON.parse(process.argv[2]),process.argv[3])));`;
 const {result,fired}=JSON.parse((await run(process.execPath,['--input-type=module','-e',code,f.target,JSON.stringify(f.roots),fault],{timeout:30000})).stdout);
 assert.equal(fired,true);assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'pending');assert.equal(result.retainedLock,undefined);const before=snapshot(f.target);
 if(fault==='last-parent-fsync'){assert.match(result.cleanupDiagnostics.join(' '),/FINAL_SETTLEMENT_DURABILITY_UNCONFIRMED/u);await assertSettled(f);assert.equal(await recoverFresh(f,{noAllocation:true}),false);}
 else{const recovered=await recoverFresh(f);assert.equal(recovered.cleanup,'complete');assert.equal(recovered.transactionId,result.transactionId);await assertSettled(f);}
 assert.equal(snapshot(f.target),before);
});
test('final removal barrier rejects an ancestor replaced by a symlink to the same moved inode',async t=>{
 const f=await closed(t),inspection=await inspectLifecycleTerminalRetirement(f.workspace),lease=await acquireLifecycleTerminalRetirementLock(f.workspace,inspection);
 const row=inspection.intent.roles.find(row=>row.kind==='file'&&row.path.includes('/')),file=path.join(f.roots.materialRoot,...row.path.split('/')),parent=path.dirname(file),outside=path.join(f.root,'outside-sealed-parent'),originalOpen=fs.open;let swapped=false;
 fs.open=async function(name,...rest){const handle=await originalOpen.call(this,name,...rest);if(name===file){const readFile=handle.readFile.bind(handle);handle.readFile=async(...args)=>{const bytes=await readFile(...args);if(!swapped){swapped=true;await fs.rename(parent,outside);await fs.symlink(outside,parent);}return bytes;};}return handle;};syncBuiltinESMExports();
 try{await assert.rejects(removeLifecycleTerminalRetirementRole(lease,row.path),/ancestor|symlink|physical|canonical/u);}finally{fs.open=originalOpen;syncBuiltinESMExports();}
 assert.equal(swapped,true);assert.equal((await fs.lstat(path.join(outside,path.basename(file)))).ino,Number(row.identity.ino));assert.equal((await fs.readFile(path.join(outside,path.basename(file)))).length>0,true);
});

for(const mutation of ['extra-material','changed-source','changed-target'])test(`terminal recovery preserves ${mutation} without new claims or cleanup`,async t=>{
 const f=await closed(t);
 if(mutation==='extra-material')await fs.writeFile(path.join(f.roots.materialRoot,'unique-foreign'),'only source');
 if(mutation==='changed-source'){const journal=JSON.parse(await fs.readFile(f.roots.lifecycleJournal));await fs.appendFile(path.join(f.roots.materialRoot,journal.backup,'feature_spec.md'),'\nchanged source\n');}
 if(mutation==='changed-target')await fs.appendFile(path.join(f.target,'feature_spec.md'),'\nchanged target\n');
 if(mutation==='missing-witness')await fs.unlink(f.roots.lockPath);
 const before=snapshot(f.root);await assert.rejects(recoverFresh(f),/terminal|unbound|closed|changed|snapshot|digest/u);assert.equal(snapshot(f.root),before);
});
test('a live terminal recoverer excludes both a second recoverer and a normal writer',async t=>{
 const f=await closed(t),code=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {recoverIncompletePublication} from ${JSON.stringify(publisherModule)};const unlink=fs.unlink;let held=false;fs.unlink=async function(file,...rest){if(!held&&String(file).startsWith(process.argv[2]+'/')){held=true;process.send({state:'held'});await new Promise(resolve=>process.once('message',resolve));}return unlink.call(this,file,...rest);};syncBuiltinESMExports();const result=await recoverIncompletePublication(process.argv[1]);process.send({state:'done',result});process.disconnect();`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,f.target,f.roots.materialRoot],{stdio:['ignore','pipe','pipe','ipc']});t.after(()=>child.kill('SIGTERM'));let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
 const message=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('recoverer IPC timeout '+stderr)),10000);child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('error',reject);});
 assert.equal((await message()).state,'held');const before=snapshot(f.root);await assert.rejects(recoverFresh(f),/owner is alive/u);await assert.rejects(withExecutionPublicationLock(f.workspace,()=>assert.fail('writer entered')),/lock already exists/u);assert.equal(snapshot(f.root),before);
 const done=message(),exit=new Promise(resolve=>child.once('exit',resolve));child.send('continue');const response=await done;assert.equal(response.state,'done');assert.equal(response.result.cleanup,'complete');assert.equal(await exit,0);await assertSettled(f);
});

test('a deleted terminal witness uses intact journal binding and source proof instead of republishing',async t=>{
 const f=await closed(t),before=snapshot(f.target);await fs.unlink(f.roots.lockPath);const result=await recoverFresh(f);assert.equal(result.cleanup,'complete');assert.equal(result.transactionId,f.record.terminalRetirement.transactionId);assert.equal(snapshot(f.target),before);await assertSettled(f);
});
test('closed material without any remaining transaction authority is preserved rather than adopted',async t=>{
 const f=await fixture(t);assert.equal((await publishCandidate('CLOSE',f.target,null)).cleanup,'complete');await fs.mkdir(f.roots.materialRoot);await fs.writeFile(path.join(f.roots.materialRoot,'unique-source'),'preserve me');const before=snapshot(f.root);await assert.rejects(recoverFresh(f),/unbound operational controls/u);assert.equal(snapshot(f.root),before);
});

for(const change of ['not-ignored','git-selector'])test(`terminal recovery revalidates exclusion ${change} before any claim or cleanup`,async t=>{
 const f=await closed(t);if(change==='not-ignored')await fs.writeFile(path.join(f.root,'.gitignore'),'');const before=snapshot(f.root);
 const code=`import {recoverIncompletePublication} from ${JSON.stringify(publisherModule)};await recoverIncompletePublication(process.argv[1]);`;
 await assert.rejects(run(process.execPath,['--input-type=module','-e',code,f.target],{timeout:30000,env:{...process.env,...(change==='git-selector'?{GIT_WORK_TREE:f.root}:{})}}),/TEMP_ROOT_UNPROVEN/u);assert.equal(snapshot(f.root),before);
});
