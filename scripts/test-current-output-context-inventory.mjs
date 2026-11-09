import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readOwnedFile} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
const source=await fs.readFile(new URL('../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function externalOutputContext('),end=source.indexOf('async function observeProduct(',start);
assert.ok(start>=0&&end>start);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),ordinal=(a,b)=>a<b?-1:a>b?1:0;
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const identity=m=>({dev:String(m.dev),ino:String(m.ino),mode:m.mode&0o777,size:m.size,mtimeMs:m.mtimeMs,ctimeMs:m.ctimeMs});
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const statOrNull=async file=>fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const realDirectory=async file=>{const s=await fs.lstat(file);if(!s.isDirectory()||s.isSymbolicLink())fail('UNSAFE_PATH','real directory required');return identity(s);};
const directoryNames=async file=>{const before=await realDirectory(file),names=(await fs.readdir(file)).sort(ordinal);if(!equal(before,await realDirectory(file)))fail('EVIDENCE_STALE','directory changed');return names;};
const observe=Function('fs','path','statOrNull','identity','directoryNames','realDirectory','equal','fail','ordinal','digest','safeRead',
  source.slice(start,end)+'\nreturn externalOutputContext;')(fs,path,statOrNull,identity,directoryNames,realDirectory,equal,fail,ordinal,digest,readOwnedFile);
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-output-context-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'docs/missing');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'own.md'),'Own output.\n');
  const context={productRoot:root,logicalExecutionRoot:path.join(root,'spec/execution'),logicalAuthorityPath:path.join(root,'spec/requirements.md')};
  return {root,dir,context,read:(limits={entries:0,bytes:0})=>observe(context,'docs/missing',['docs/missing/own.md'],limits)};
}
test('only own exact output and its structural chain produce canonical empty context',async t=>{
  const f=await fixture(t);assert.equal(await f.read(),digest(Buffer.from('stnl-output-external-context-v1\0[]')));
  await fs.writeFile(path.join(f.dir,'own.md'),'Own corrected bytes.\n');assert.equal(await f.read(),digest(Buffer.from('stnl-output-external-context-v1\0[]')));
});
for(const name of ['package.json','shadow.mjs','discovered.test.mjs','.hidden'])test(`external fingerprint includes ${name} and later byte changes`,async t=>{
  const f=await fixture(t),empty=await f.read();await fs.writeFile(path.join(f.dir,name),'first\n');const present=await f.read();assert.notEqual(present,empty);
  await fs.writeFile(path.join(f.dir,name),'second\n');assert.notEqual(await f.read(),present);
});
test('external fingerprint includes empty and nested directories',async t=>{
  const f=await fixture(t),empty=await f.read();await fs.mkdir(path.join(f.dir,'empty'));const shallow=await f.read();assert.notEqual(shallow,empty);
  await fs.mkdir(path.join(f.dir,'empty/deep'));assert.notEqual(await f.read(),shallow);
});
test('external file mode is part of the fingerprint',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'external');await fs.writeFile(file,'data');const before=await f.read();await fs.chmod(file,0o700);assert.notEqual(await f.read(),before);
});
for(const name of ['symlink','hardlink'])test(`external ${name} is not hashed as safe content`,async t=>{
  const f=await fixture(t),extra=path.join(f.dir,name);if(name==='symlink')await fs.symlink('own.md',extra);else await fs.link(path.join(f.dir,'own.md'),extra);
  await assert.rejects(f.read);
});
test('external scan entry and byte bounds fail closed',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.read({entries:10000,bytes:0}),error=>error.code==='UNSUPPORTED_FORMAT');
  await assert.rejects(()=>f.read({entries:0,bytes:128*1024*1024}),error=>error.code==='UNSUPPORTED_FORMAT');
});
test('external context cannot overlap an execution control',async t=>{
  const f=await fixture(t);f.context.logicalAuthorityPath=path.join(f.dir,'own.md');await assert.rejects(f.read,error=>error.code==='UNSAFE_PATH');
});
