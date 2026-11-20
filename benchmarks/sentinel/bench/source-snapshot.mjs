import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {confined,acquireLock} from './core.mjs';
import {verifySourceSnapshot} from './prepare.mjs';
function git(repository,args,{binary=false}={}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
 Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'});
 const r=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',repository,...args],{env,encoding:binary?undefined:'utf8',timeout:60000,maxBuffer:64*1024*1024});
 if(r.error||r.status!==0)throw Error('Snapshot git failed: '+(r.error?.message??String(r.stderr).slice(0,2000)));
 return r.stdout;
}
function parseTree(bytes){
 const decoder=new TextDecoder('utf-8',{fatal:true});const records=[];let start=0;const names=new Set();
 for(let i=0;i<bytes.length;i++){if(bytes[i]!==0)continue;const raw=bytes.subarray(start,i);start=i+1;const sep=raw.indexOf(9);if(sep<0)throw Error('Invalid Git tree record');const header=raw.subarray(0,sep).toString('ascii'),m=/^(100644|100755) blob ([a-f0-9]{40})$/.exec(header);if(!m)throw Error('Unsupported tree entry: '+header);const name=decoder.decode(raw.subarray(sep+1));const parts=name.split('/');if(!name||path.isAbsolute(name)||name.includes('\\')||parts.some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git')||/[\x00-\x1f\x7f]/.test(name))throw Error('Unsafe snapshot path');const key=name.normalize('NFC').toLowerCase();if(names.has(key))throw Error('Snapshot path collision');names.add(key);records.push({mode:m[1],oid:m[2],name});}
 if(start!==bytes.length)throw Error('Truncated Git tree listing');return records;
}
/** Materialize immutable commit content locally, never checkout or mutate repository refs.
 * Existing destinations must pass Git-object verification; no incomplete adoption. */
export async function materializeSourceSnapshot({base,repository,revision}={}){
 if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Full lowercase commit SHA required');
 base=fs.realpathSync.native(base);repository=fs.realpathSync.native(repository);
 if(git(repository,['rev-parse','--verify',revision+'^{commit}']).trim()!==revision)throw Error('Commit identity mismatch');
 // Validate every path and kind BEFORE allocating files or consuming blob contents.
 const entries=parseTree(git(repository,['ls-tree','-rz','--full-tree',revision],{binary:true}));
 const parent=confined(base,'source-snapshots'),temp=confined(base,'temp');fs.mkdirSync(parent,{recursive:true});fs.mkdirSync(temp,{recursive:true});
 const locks=confined(temp,'source-snapshot-locks');fs.mkdirSync(locks,{recursive:true});const lock=confined(locks,revision);const release=acquireLock(lock);let stage=null;
 try{
  const sourceRoot=confined(parent,revision);
  if(fs.existsSync(sourceRoot)){if(!fs.lstatSync(sourceRoot).isDirectory())throw Error('Existing snapshot is not directory');return{sourceRoot,proof:verifySourceSnapshot({source:sourceRoot,repository,revision})};}
  stage=confined(temp,'source-snapshot-'+revision+'-'+randomUUID());fs.mkdirSync(stage,{mode:0o700});
  for(const entry of entries){const file=confined(stage,entry.name);fs.mkdirSync(path.dirname(file),{recursive:true});const bytes=git(repository,['cat-file','blob',entry.oid],{binary:true});const actual=createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');if(actual!==entry.oid)throw Error('Blob identity mismatch');const fd=fs.openSync(file,'wx',entry.mode==='100755'?0o755:0o644);try{fs.writeFileSync(fd,bytes);fs.fchmodSync(fd,entry.mode==='100755'?0o755:0o644);fs.fsyncSync(fd);}finally{fs.closeSync(fd)}}
  const proof=verifySourceSnapshot({source:stage,repository,revision});
  // Lock serializes this producer; refuse any foreign destination rather than merge.
  if(fs.existsSync(sourceRoot))throw Error('Snapshot destination appeared during materialization');
  fs.renameSync(stage,sourceRoot);stage=null;const dir=fs.openSync(parent,'r');try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
  return{sourceRoot,proof};
 }finally{
  // Failed stages remain identifiable for diagnosis; never adopt/overwrite later.
  release();
 }
}
