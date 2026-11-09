import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readOwnedFile} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
const source=await fs.readFile(new URL('../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs',import.meta.url),'utf8');
const start=source.indexOf('function literalAbsence('),end=source.indexOf('function assertOtherInitialWork(',start);
assert.ok(start>=0&&end>start);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),order=(a,b)=>a<b?-1:a>b?1:0;
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const meta=m=>({dev:String(m.dev),ino:String(m.ino),mode:m.mode&0o777,size:m.size,mtimeMs:m.mtimeMs,ctimeMs:m.ctimeMs});
const realDirectory=async name=>{const m=await fs.lstat(name);if(!m.isDirectory()||m.isSymbolicLink()||await fs.realpath(name)!==name)throw Object.assign(new Error('unsafe directory'),{code:'UNSAFE_PATH'});return m;};
const check=Function('fs','path','readOwnedFile','realDirectory','sha','same','order','parseCurrentJson','MAX_NATIVE_PRODUCER_TURNS','verifyWorkObservation','fail',
  source.slice(start,end)+'\nreturn assertInitialStructuralInventory;')(fs,path,readOwnedFile,realDirectory,sha,same,order,JSON.parse,5,
    ()=>({areas:[{kind:'file',path:'docs/missing/report.md'}],inputs:[]}),
    (code,message)=>{throw Object.assign(new Error(message),{code});});
const bytes=value=>Buffer.from(JSON.stringify(value));
async function fixture(t,temporaryParent=os.tmpdir()) {
  // Official product contexts use physical roots. macOS temporary parents can
  // contain a system symlink (/var -> /private/var), unlike typical Linux /tmp.
  const root=await fs.realpath(await fs.mkdtemp(path.join(temporaryParent,'sentinel-structural-proof-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'docs/missing'),{recursive:true});
  await fs.writeFile(path.join(root,'docs/missing/report.md'),'Approved output.\n');
  const before={format:'stnl-current-work-v1',entries:[{path:'docs',kind:'directory',children:[]},{path:'docs/missing',kind:'absent'}]};
  const after={format:'stnl-current-work-v1',entries:[{path:'docs',kind:'directory',children:['missing']},{path:'docs/missing',kind:'directory',children:['report.md']},
    {path:'docs/missing/report.md',kind:'file',sha256:sha(Buffer.from('Approved output.\n')),mode:420}]};
  const current={deliveryId:'current',slice:'slice-02',evidence:{},baseline:structuredClone(before),normalization:{operation:'EXECUTE_SLICE',status:'settled',consumedInvocations:1,sourceOperationAttemptId:'attempt'},lastDiagnostic:{operationAttemptId:'attempt'}};
  const prior={deliveryId:'prior',slice:'slice-01',evidence:{path:'prior.json'}},continuity={deliveries:[prior,current]};
  const observation={manifest:after,identities:new Map(),rootIdentity:null};
  const image={context:{productRoot:root},activation:{lastAttempt:{outcome:'rejected',operation:'EXECUTE_SLICE',deliveryId:'current',operationAttemptId:'attempt'}},
    files:new Map([['approved-preparation.json',bytes({normativeProjection:{deliveries:[{deliveryId:'current'}]}})],['prior.json',bytes({validation:{testedWork:before}})]]),
    inspection:{deliveries:[{deliveryId:'prior',observedValidation:'revalidation-required',formalStatus:'PASS'}]},
    observedByDelivery:new Map([['prior',{manifest:after}],['current',observation]])};
  const refresh=async()=>{
    observation.rootIdentity=meta(await fs.lstat(root));
    for(const entry of after.entries){const m=await fs.lstat(path.join(root,entry.path));observation.identities.set(entry.path,entry.kind==='directory'?meta(m):{dev:String(m.dev),ino:String(m.ino)});}
  };
  await refresh();return {root,image,current,before,after,observation,refresh,check:()=>check(image,{...current,operation:'EXECUTE_SLICE'},current.baseline)};
}
test('first output creation proves the entire physical structural chain',async t=>assert.doesNotReject((await fixture(t)).check));
test('temporary parent aliases produce a physical fixture root',async t=>{
  const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-temp-alias-')));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  await fs.mkdir(path.join(parent,'physical'));
  const alias=path.join(parent,'alias');await fs.symlink('physical',alias);
  const f=await fixture(t,alias);
  assert.equal(f.root,await fs.realpath(f.root));
  assert.equal(path.dirname(f.root),path.join(parent,'physical'));
  await assert.doesNotReject(f.check);
  // Canonicalize fixture setup only: a nonphysical product root must still fail.
  f.image.context.productRoot=path.join(alias,path.basename(f.root));
  await assert.rejects(f.check,error=>error.code==='UNSAFE_PATH');
});
for(const name of ['extra.txt','package.json','report.js','sibling.test.mjs'])test(`projection cannot hide new ${name}`,async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'docs/missing',name),'{}\n');await f.refresh();await assert.rejects(f.check);
});
for(const field of ['sha256','mode'])test(`physical ${field} must equal the sealed current observation`,async t=>{
  const f=await fixture(t);f.after.entries.at(-1)[field]=field==='mode'?493:'sha256:'+'f'.repeat(64);await assert.rejects(f.check);
});
for(const name of ['docs/missing/report.md','docs/missing','docs'])test(`physical identity mismatch at ${name} rejects`,async t=>{
  const f=await fixture(t);f.observation.identities.get(name).ino='0';await assert.rejects(f.check);
});
test('existing ancestor mode changed after official observation rejects',async t=>{
  const f=await fixture(t);const dir=path.join(f.root,'docs');const original=(await fs.lstat(dir)).mode&0o777;
  await fs.chmod(dir,original===448?493:448);await assert.rejects(f.check);
});
test('hidden symlink is not accepted through file-claim projection',async t=>{
  const f=await fixture(t);await fs.symlink('report.md',path.join(f.root,'docs/missing/hidden-link'));await f.refresh();await assert.rejects(f.check);
});
test('file symlink cannot satisfy an otherwise identical output',async t=>{
  const f=await fixture(t),target=path.join(f.root,'docs/missing/report.md');await fs.rename(target,path.join(f.root,'original'));await fs.symlink('../../original',target);await f.refresh();await assert.rejects(f.check);
});
test('existing ancestor symlink cannot satisfy the chain',async t=>{
  const f=await fixture(t);await fs.rename(path.join(f.root,'docs'),path.join(f.root,'renamed'));await fs.symlink('renamed',path.join(f.root,'docs'));
  f.observation.rootIdentity=meta(await fs.lstat(f.root));
  await assert.rejects(()=>f.check(),error=>error.code==='UNSAFE_PATH');
});

test('new hidden child racing the physical inventory is rejected',async t=>{
  const f=await fixture(t),readdir=fs.readdir;let changed=false;
  fs.readdir=async(...args)=>{
    const names=await readdir(...args);
    if(args[0]===path.join(f.root,'docs/missing')&&!changed) {
      changed=true;await fs.writeFile(path.join(f.root,'docs/missing/package.json'),'{}\n');
    }
    return names;
  };
  try {await assert.rejects(f.check);assert.equal(changed,true);}finally {fs.readdir=readdir;}
});
test('a regular file cannot stand in for the observed new directory',async t=>{
  const f=await fixture(t);await fs.rm(path.join(f.root,'docs/missing'),{recursive:true});
  await fs.writeFile(path.join(f.root,'docs/missing'),'not a directory\n');
  await assert.rejects(f.check);
});
