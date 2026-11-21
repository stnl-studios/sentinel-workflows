import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{fileURLToPath}from'node:url';import{environmentPreflight}from'../environment-preflight.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../temp/environment-preflight-tests');
function setup(t,mode='ok'){
 fs.mkdirSync(root,{recursive:true});const base=fs.mkdtempSync(path.join(root,'test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const m={profile:{cli:'/unused'}};for(const key of ['workspace','tmpDir','codexHome','evidence']){m[key]=path.join(base,key);fs.mkdirSync(m[key]);}
 const calls=[];const services={createServer:o=>({start:async()=>{calls.push('start');if(mode==='startfail')throw Error('initialize failed');},stop:async()=>calls.push('stop'),request:async(method,p,opt)=>{
 calls.push(method);assert.equal(method,'command/exec');assert.deepEqual(p.command.slice(0,2),['/bin/zsh','-lc']);assert.ok(p.command[2].includes('cat > "$TMPDIR/environment-preflight/heredoc.txt"'));assert.ok(p.timeoutMs>0&&p.timeoutMs<=10000);assert.ok(opt.timeoutMs<=10000);
 assert.deepEqual(p.sandboxPolicy,{type:'workspaceWrite',writableRoots:[m.workspace],excludeSlashTmp:true,excludeTmpdirEnvVar:false,networkAccess:false});
 assert.equal(o.home,m.codexHome);assert.equal(o.tmpDir,m.tmpDir);
 if(mode==='rpcfail')throw Error('command failed');
 fs.writeFileSync(path.join(m.tmpDir,'environment-preflight/heredoc.txt'),mode==='badfile'?'bad':'sentinel-environment-heredoc-proof\n');
 return{exitCode:mode==='exit'?1:0,stdout:mode==='env'?'TMPDIR=/tmp\n':'TMPDIR='+m.tmpDir+'\nTMPPREFIX='+m.tmpDir+'/zsh\n',stderr:mode==='stderr'?'untrusted output':''};
 }})};return{manifest:m,deadline:Date.now()+20000,services,calls};
}
test('zero-model simulated probe proves actual response and file, with restricted sandbox',async t=>{
 const f=setup(t),r=await environmentPreflight(f);assert.equal(r.status,'PASS');assert.equal(r.scope,'SIMULATED');assert.equal(r.modelTurnsStarted,0);assert.deepEqual(f.calls,['start','command/exec','stop']);assert.equal(r.proof.contentMatches,true);
});
test('failure persists once and never retries same cell',async t=>{
 for(const mode of ['startfail','rpcfail','badfile','exit','env','stderr']){
 const f=setup(t,mode);await assert.rejects(environmentPreflight(f));const saved=JSON.parse(fs.readFileSync(path.join(f.manifest.evidence,'environment-preflight.json')));assert.equal(saved.status,'BLOCKED');assert.equal(f.calls.at(-1),'stop');const before=f.calls.length;await assert.rejects(environmentPreflight(f),/ALREADY_ATTEMPTED/);assert.equal(f.calls.length,before);
 }
});
test('expired deadline blocks before server and records diagnostic',async t=>{
 const f=setup(t);f.deadline=Date.now()-1;await assert.rejects(environmentPreflight(f),/DEADLINE/);assert.deepEqual(f.calls,[]);assert.ok(fs.existsSync(path.join(f.manifest.evidence,'environment-preflight.json')));
});
test('partial prior probe cannot be adopted or overwritten',async t=>{
 const f=setup(t);const dir=path.join(f.manifest.tmpDir,'environment-preflight');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'heredoc.txt'),'preserve');await assert.rejects(environmentPreflight(f));assert.deepEqual(f.calls,[]);assert.equal(fs.readFileSync(path.join(dir,'heredoc.txt'),'utf8'),'preserve');
});

test('probe leaves workspace bytes and directory metadata untouched',async t=>{
 const f=setup(t),root=f.manifest.workspace;
 fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/product.txt'),'unchanged');
 const snapshot=()=>[root,path.join(root,'src'),path.join(root,'src/product.txt')].map(file=>{
  const stat=fs.statSync(file);return{file,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino,bytes:stat.isFile()?fs.readFileSync(file,'utf8'):null,entries:stat.isDirectory()?fs.readdirSync(file):null};
 });
 const before=snapshot(),result=await environmentPreflight(f);
 assert.deepEqual(snapshot(),before);
 assert.equal(result.proof.rootIdentifier,'TMPDIR');
 assert.equal(result.proof.file,'environment-preflight/heredoc.txt');
 assert.equal(fs.existsSync(path.join(root,'.benchmark-temp')),false);
});

test('uncertain process exit outranks an unwriteable preflight receipt and drains the pool before rejection',async t=>{
 const {runPool}=await import('../pool.mjs');
 const f=setup(t),make=f.services.createServer,receipt=path.join(f.manifest.evidence,'environment-preflight.json');
 f.services.createServer=o=>({...make(o),stop:async()=>{fs.mkdirSync(receipt);throw Object.assign(Error('unconfirmed child exit'),{code:'APP_SERVER_EXIT_UNCONFIRMED'});}});
 const started=[],recorded=[];let settle,terminal=false;
 const run=runPool(['preflight','existing','not-started'],2,async id=>{started.push(id);if(id==='preflight')return environmentPreflight(f);await new Promise(r=>{settle=r;});return{id};},{isFatal:error=>error.code==='APP_SERVER_EXIT_UNCONFIRMED',onResult:r=>recorded.push(r)});
 const failure=run.catch(error=>{terminal=true;return error;});
 while(recorded.length===0)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(terminal,false);assert.deepEqual(started,['preflight','existing']);assert.equal(fs.lstatSync(receipt).isDirectory(),true);
 settle();
 const error=await failure;assert.equal(error.code,'APP_SERVER_EXIT_UNCONFIRMED');assert.equal(error.report.stopCode,error.code);
 assert.ok(error.report.persistenceError.code);assert.equal(error.report.status,'BLOCKED');assert.equal(recorded.length,2);
});
