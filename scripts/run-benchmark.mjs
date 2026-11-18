#!/usr/bin/env node
import fs from'node:fs';import path from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';import{createHash,randomUUID}from'node:crypto';import{spawn}from'node:child_process';
const hash=b=>createHash('sha256').update(b).digest('hex'),digest=x=>hash(JSON.stringify(x));
export const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function safePath(root,target){const absolute=path.resolve(root,target);if(absolute!==root&&!absolute.startsWith(root+path.sep))throw Error('PATH_ESCAPE');let p=path.parse(absolute).root;for(const part of absolute.slice(p.length).split(path.sep)){p=path.join(p,part);try{if(fs.lstatSync(p).isSymbolicLink())throw Error('SYMLINK_REFUSED');}catch(e){if(e.code!=='ENOENT')throw e;}}return absolute;}
export function treeManifest(root){safePath(root,'.');const out={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,e.name),rel=path.relative(root,p);if(e.isSymbolicLink()||(!e.isDirectory()&&!e.isFile()))throw Error('UNSAFE_SOURCE_ENTRY:'+rel);if(['auth.json','credentials.json','.env','id_rsa','id_ed25519'].includes(e.name))throw Error('CREDENTIAL_SOURCE_REFUSED');if(e.isDirectory())walk(p);else out[rel]={sha256:hash(fs.readFileSync(p)),mode:fs.statSync(p).mode&0o777};}}walk(root);return out;}
function snapshot(root){return{bench:treeManifest(path.join(root,'bench')),fixture:treeManifest(path.join(root,'fixtures/todo'))};}
function blockers(base){const hits=[];function walk(dir){if(!fs.existsSync(dir))return;safePath(base,dir);for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('LOCK_SCAN_SYMLINK');if(e.name==='.lock'||e.name.endsWith('.lease'))hits.push(p);else if(e.isDirectory())walk(p);}}walk(path.join(base,'evidence/campaigns'));walk(path.join(base,'launcher-leases'));return hits;}
function jsonOnce(file,x){fs.writeFileSync(file,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600});}
export function prepareLaunch({repo=repositoryRoot,argv=[]}={}){
 repo=path.resolve(repo);safePath(repo,'.');const [command,...args]=argv,allowed=new Set(['run','status','report','resume','validate-profile','compare','qualify','test']);if(!allowed.has(command))throw Error('Usage: run | status | report | resume | validate-profile | compare | qualify | test');if(command==='test'&&args.length)throw Error('test takes no arguments');
 const base=safePath(repo,'benchmark-temp/benchmark-v2'),source=safePath(repo,'benchmarks/sentinel');fs.mkdirSync(base,{recursive:true});for(const n of ['temp','evidence','launcher-logs','launcher-leases'])fs.mkdirSync(safePath(base,n),{recursive:true});
 const lock=safePath(base,'.launcher-install.lock');jsonOnce(lock,{pid:process.pid,at:new Date().toISOString()});let lease=null;
 try{
  const record=safePath(base,'launcher-install.json'),exists=fs.existsSync(record),stored=exists?JSON.parse(fs.readFileSync(record)):null;
  if(exists&&digest(snapshot(base))!==stored.contentDigest)throw Error('INSTALLED_IDENTITY_UNCERTAIN');
  const existingOnly=['status','report','resume'].includes(command);if(existingOnly&&!exists)throw Error('EXISTING_RUNTIME_REQUIRED');
  let desired=stored?.content,sourceBefore=null;
  if(!existingOnly){sourceBefore=snapshot(source);desired=sourceBefore;}
  let action='unchanged';
  if(!exists||digest(desired)!==stored.contentDigest){
   if(blockers(base).length)throw Error('RUNTIME_UPGRADE_BLOCKED_BY_LOCK_OR_LEASE');
   if(!exists&&(fs.existsSync(path.join(base,'bench'))||fs.existsSync(path.join(base,'fixtures'))))throw Error('UNMANAGED_RUNTIME_REFUSED');
   const stage=fs.mkdtempSync(path.join(base,'temp/install-'));fs.mkdirSync(path.join(stage,'fixtures'));fs.cpSync(path.join(source,'bench'),path.join(stage,'bench'),{recursive:true});fs.cpSync(path.join(source,'fixtures/todo'),path.join(stage,'fixtures/todo'),{recursive:true});
   if(digest(snapshot(stage))!==digest(desired)||digest(snapshot(source))!==digest(sourceBefore))throw Error('SOURCE_CHANGED_DURING_COPY');
   // Fail-closed installer lock remains if a process crashes during publication.
   if(exists){const backup=path.join(base,'temp','previous-'+randomUUID());fs.mkdirSync(backup);fs.renameSync(path.join(base,'bench'),path.join(backup,'bench'));fs.renameSync(path.join(base,'fixtures'),path.join(backup,'fixtures'));fs.copyFileSync(record,path.join(backup,'launcher-install.json'));}
   fs.renameSync(path.join(stage,'bench'),path.join(base,'bench'));fs.renameSync(path.join(stage,'fixtures'),path.join(base,'fixtures'));fs.rmdirSync(stage);
   const next={schemaVersion:1,sourceRoot:source,content:desired,contentDigest:digest(desired),installedAt:new Date().toISOString()};const tmp=record+'.'+randomUUID();jsonOnce(tmp,next);fs.renameSync(tmp,record);action=exists?'upgraded':'installed';
  }
  if(sourceBefore&&digest(snapshot(source))!==digest(sourceBefore))throw Error('SOURCE_CHANGED');
  const mapped=[...args];for(let i=0;i<mapped.length;i++)if(['--profile','--input','--qualification'].includes(mapped[i])){if(!mapped[i+1])throw Error('MISSING_FILE_ARGUMENT');const input=safePath(mapped[i]==='--profile'?repo:base,mapped[i+1]);if(!fs.statSync(input).isFile())throw Error('FILE_REQUIRED');mapped[++i]=input;}
  if(['run','validate-profile'].includes(command)&&!mapped.includes('--profile'))mapped.push('--profile',path.join(base,'bench/profiles/reference-sol-high.json'));
  if(command==='run'&&!mapped.includes('--id')){const id='run-'+new Date().toISOString().replace(/[^0-9]/g,'')+'-'+randomUUID().slice(0,8);mapped.push('--id',id);console.log('Benchmark ID: '+id);}
  const cliArgs=command==='test'?['--test',...fs.readdirSync(path.join(base,'bench/test')).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>path.join(base,'bench/test',n))]:[path.join(base,'bench/cli.mjs'),command,...mapped];
  if(allowed.has(command)){lease=path.join(base,'launcher-leases',randomUUID()+'.lease');jsonOnce(lease,{pid:process.pid,command,contentDigest:digest(desired)});}
  const log=path.join(base,'launcher-logs',Date.now()+'-'+randomUUID()+'.json');jsonOnce(log,{schemaVersion:1,command,action,contentDigest:digest(desired),content:desired,sourceCompared:!!sourceBefore,sourceRoot:source,runtimeBase:base,argv:cliArgs});
  return{base,args:cliArgs,log,env:{...process.env,TMPDIR:path.join(base,'temp'),TMPPREFIX:path.join(base,'temp/zsh')},release(){if(lease){fs.unlinkSync(lease);lease=null;}}};
 }catch(error){if(lease&&fs.existsSync(lease))fs.unlinkSync(lease);throw error;}finally{fs.unlinkSync(lock);}
}
export async function executeLaunch(launch,{platform=process.platform,spawnChild=spawn,killGroup=(id,signal)=>process.kill(id,signal),graceMs=2000,pollMs=50,stdio='inherit'}={}){
 if(!['darwin','linux'].includes(platform))throw Error('PROCESS_GROUP_PLATFORM_UNSUPPORTED');
 let child,group=null,exited=false,exitResult=null,spawnError=null,shutdownPromise=null,shutdownFinished=false,requestedShutdown=null,uncertainty=null;
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const state=()=>{if(!group)return 'unknown';try{killGroup(-group,0);return 'active';}catch(e){if(e.code==='ESRCH')return 'quiet';uncertainty=e.code??e.message;return 'unknown';}};
 const send=signal=>{try{killGroup(-group,signal);}catch(e){if(e.code!=='ESRCH')uncertainty=e.code??e.message;}};
 async function untilQuiet(ms){const end=Date.now()+ms;do{const s=state();if(s!=='active')return s;await wait(pollMs);}while(Date.now()<end);return state();}
 function shutdown(initial='SIGTERM'){return shutdownPromise??=(async()=>{if(!group)return 'unknown';send(initial);let s=await untilQuiet(graceMs);if(s!=='active')return s;if(initial!=='SIGTERM'){send('SIGTERM');s=await untilQuiet(graceMs);if(s!=='active')return s;}send('SIGKILL');return untilQuiet(graceMs);})().finally(()=>{shutdownFinished=true;});}
 const handlers=new Map(['SIGINT','SIGTERM'].map(signal=>[signal,()=>{if(group)void shutdown(signal);else requestedShutdown??=signal;}]));
 for(const[s,h]of handlers)process.on(s,h);
 try{
  child=spawnChild(process.execPath,launch.args,{cwd:launch.base,env:launch.env,stdio,detached:true});
  await new Promise(resolve=>{child.once('spawn',()=>{group=child.pid;resolve();});child.once('error',e=>{spawnError=e;resolve();});child.once('exit',(code,signal)=>{exited=true;exitResult={code,signal};resolve();});});
  // Only this newly spawned detached leader's PGID can be signalled.
  if(group&&(!Number.isSafeInteger(group)||group<=1||group===process.pid))throw Error('INVALID_OWNED_PROCESS_GROUP');
  if(spawnError&&!group){launch.release();const result={code:null,signal:null,error:spawnError.message,groupStatus:'not-created',leaseReleased:true};jsonOnce(launch.log+'.result.json',result);return result;}
  if(requestedShutdown&&group)void shutdown(requestedShutdown);
  while(!exited&&!spawnError&&!uncertainty&&!shutdownFinished)await wait(pollMs);
  let groupStatus=state();if(shutdownPromise)groupStatus=await shutdownPromise;else if(groupStatus==='active')groupStatus=await shutdown();
  const end=Date.now()+graceMs;while(!exited&&Date.now()<end)await wait(pollMs);
  const safe=exited&&groupStatus==='quiet'&&!uncertainty;
  const result={...(exitResult??{code:null,signal:null}),ownedProcessGroup:group,groupStatus,cliExited:exited,uncertainty,leaseReleased:safe};
  jsonOnce(launch.log+'.result.json',result);if(safe)launch.release();return result;
 }catch(error){jsonOnce(launch.log+'.result.json',{code:null,error:error.message,ownedProcessGroup:group,groupStatus:state(),leaseReleased:false,uncertain:true});throw error;}
 finally{for(const[s,h]of handlers)process.off(s,h);}
}
export async function main(argv=process.argv.slice(2)){
 if(!['darwin','linux'].includes(process.platform))throw Error('PROCESS_GROUP_PLATFORM_UNSUPPORTED');
 const launch=prepareLaunch({argv}),result=await executeLaunch(launch);process.exitCode=result.leaseReleased?(result.code??(result.signal==='SIGINT'?130:143)):1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
