import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess, { spawnSync, execFileSync } from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import test from 'node:test';

import { populateOwnedClosedStage, renderClosedFeature, linkOwnedStageSymlink } from '../lib/closed-spec.mjs';
import { validateCloseTransition, validateWorkspace } from '../lib/lifecycle.mjs';
import { closedDocumentFixture, copyFixture, FIXTURES, replace, RUNTIME_ROOT, snapshot, temporary } from './helpers.mjs';

const OPTIONAL_SYMLINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN']);
const OPTIONAL_HARDLINK_ERRORS = new Set([...OPTIONAL_SYMLINK_ERRORS, 'EXDEV']);

test('renderer is byte-identical to the canonical golden and deterministic', () => {
  const source = path.join(FIXTURES, 'ready');
  const expected = fs.readFileSync(path.join(FIXTURES, 'closed', 'feature_spec.md'));
  assert.deepEqual(renderClosedFeature(source), expected);
  assert.deepEqual(renderClosedFeature(source), renderClosedFeature(source));
});

test('renderer preserves UTF-8, exact record bytes, ID gaps, and a final newline', (t) => {
  const root = temporary(t);
  const source = copyFixture(root, 'ready', 'unicode source');
  replace(path.join(source, 'feature_spec.md'), 'Provide deterministic invitation expiration behavior.', 'Preservar café, ação e 東京 deterministically.');
  for (const file of fs.readdirSync(path.join(source, 'shared')).map((name) => path.join(source, 'shared', name))) {
    let data = fs.readFileSync(file);
    for (const [before, after] of [['R-001', 'R-007'], ['AC-001', 'AC-004'], ['D-001', 'D-009'], ['C-001', 'C-003'], ['RK-001', 'RK-008'], ['Q-001', 'Q-006']]) data = Buffer.from(data.toString('utf8').replaceAll(before, after), 'utf8');
    fs.writeFileSync(file, data);
  }
  let feature = fs.readFileSync(path.join(source, 'feature_spec.md'), 'utf8');
  for (const [before, after] of [['R-001', 'R-007'], ['AC-001', 'AC-004'], ['D-001', 'D-009'], ['C-001', 'C-003'], ['RK-001', 'RK-008'], ['Q-001', 'Q-006']]) feature = feature.replaceAll(before, after);
  fs.writeFileSync(path.join(source, 'feature_spec.md'), feature);
  const questions = path.join(source, 'shared', 'questions.md');
  fs.writeFileSync(questions, fs.readFileSync(questions).toString('utf8').replace(/\n+$/u, ''));
  validateWorkspace(source);
  const rendered = renderClosedFeature(source);
  assert.match(rendered.toString('utf8'), /東京/u);
  assert.match(rendered.toString('utf8'), /### R-007/u);
  assert.equal(rendered.at(-1), 0x0a);
});


for(const kind of ['regular','symlink','hardlink'])test(`owned renderer preserves external ${kind} while normal CLOSE omits execution`,async t=>{
 const root=temporary(t),source=copyFixture(root,'ready','source'),assets=path.join(source,'assets');fs.mkdirSync(assets);
 fs.writeFileSync(path.join(assets,'one.bin'),Buffer.from([0,1,255]));
 if(kind==='symlink')try{fs.symlinkSync('one.bin',path.join(assets,'two.bin'));}catch(e){if(OPTIONAL_SYMLINK_ERRORS.has(e.code)){t.skip(e.code);return;}throw e;}
 if(kind==='hardlink')try{fs.linkSync(path.join(assets,'one.bin'),path.join(assets,'two.bin'));}catch(e){if(OPTIONAL_HARDLINK_ERRORS.has(e.code)){t.skip(e.code);return;}throw e;}
 fs.writeFileSync(path.join(source,'.DS_Store'),'ignored');const before=snapshot(source),candidate=closedDocumentFixture(source,path.join(root,'stage'));
 assert.equal((await validateCloseTransition(source,candidate))[1].closed,true);assert.deepEqual(snapshot(source),before);
 assert.deepEqual(fs.readFileSync(path.join(candidate,'assets/one.bin')),Buffer.from([0,1,255]));assert.equal(fs.existsSync(path.join(candidate,'.DS_Store')),false);
 if(kind==='symlink')assert.equal(fs.readlinkSync(path.join(candidate,'assets/two.bin')),'one.bin');
 if(kind==='hardlink')assert.equal(fs.statSync(path.join(candidate,'assets/one.bin')).ino,fs.statSync(path.join(candidate,'assets/two.bin')).ino);
});

test('owned renderer refuses physical stage mismatch or nonempty stage before writing',t=>{
 const root=temporary(t),source=copyFixture(root,'ready','source'),stage=path.join(root,'stage');fs.mkdirSync(stage);
 const meta=fs.lstatSync(stage),identity={dev:String(meta.dev),ino:String(meta.ino)},before=snapshot(source);
 assert.throws(()=>populateOwnedClosedStage(source,stage,{...identity,ino:'0'}),/ownership\/inode changed/u);assert.deepEqual(fs.readdirSync(stage),[]);
 fs.writeFileSync(path.join(stage,'foreign'),'preserve');assert.throws(()=>populateOwnedClosedStage(source,stage,identity),/must be empty/u);
 assert.equal(fs.readFileSync(path.join(stage,'foreign'),'utf8'),'preserve');assert.deepEqual(snapshot(source),before);
});

test('cross-boundary external hardlinks fail without touching source or the outside peer',t=>{
 const root=temporary(t),source=copyFixture(root,'ready','source');fs.mkdirSync(path.join(source,'assets'));const outside=path.join(root,'outside');fs.writeFileSync(outside,'outside');
 try{fs.linkSync(outside,path.join(source,'assets','linked'));}catch(e){if(OPTIONAL_HARDLINK_ERRORS.has(e.code)){t.skip(e.code);return;}throw e;}
 const before=snapshot(source);assert.throws(()=>closedDocumentFixture(source,path.join(root,'stage')),/crosses the CLOSE preservation boundary/u);assert.deepEqual(snapshot(source),before);assert.equal(fs.readFileSync(outside,'utf8'),'outside');
 // The publisher, not this internal renderer, owns cleanup of its existing stage.
});

test('standalone operational builder API and CLI have been removed',async()=>{
 const module=await import('../lib/closed-spec.mjs');assert.equal(Object.hasOwn(module,'buildClosedCandidate'),false);assert.equal(fs.existsSync(path.join(RUNTIME_ROOT,'build-closed-spec.mjs')),false);
});


function stageLinkFixture(t,payload='missing') {
 const root=fs.realpathSync(temporary(t,'stnl owned link ')),stage=path.join(root,'stage');fs.mkdirSync(stage);fs.mkdirSync(path.join(stage,'nested'));
 const first=path.join(stage,'a'),second=path.join(stage,'nested','b');fs.symlinkSync(payload,first);
 const sm=fs.lstatSync(stage),fm=fs.lstatSync(first);
 return {root,stage,first,second,identity:{dev:String(sm.dev),ino:String(sm.ino)},expected:{dev:String(fm.dev),ino:String(fm.ino),nlink:'1',payload}};
}
function withLinkCommand(replacement,action){
 const original=childProcess.execFileSync;childProcess.execFileSync=replacement;syncBuiltinESMExports();
 try{return action(original);}finally{childProcess.execFileSync=original;syncBuiltinESMExports();}
}
function requireDarwin(t){if(process.platform==='darwin')return true;t.skip('fixed Darwin capability is not selected on this platform');return false;}

test('owned symlink hardlink preserves real inode for literal payloads and multiple members',t=>{
 if(!requireDarwin(t))return;
 for(const payload of ['target','missing','../outside','/absolute/untouched','directory']){
  const f=stageLinkFixture(t,payload);fs.writeFileSync(path.join(f.stage,'target'),'untouched');fs.mkdirSync(path.join(f.stage,'directory'));
  const targetBefore=fs.lstatSync(path.join(f.stage,'target')).nlink;
  linkOwnedStageSymlink(f.stage,f.identity,f.first,f.second,f.expected);
  const third=path.join(f.stage,'c');linkOwnedStageSymlink(f.stage,f.identity,f.first,third,{...f.expected,nlink:'2'});
  for(const file of [f.first,f.second,third]){const m=fs.lstatSync(file);assert(m.isSymbolicLink());assert.equal(String(m.ino),f.expected.ino);assert.equal(m.nlink,3);assert.equal(fs.readlinkSync(file),payload);}
  assert.equal(fs.lstatSync(path.join(f.stage,'target')).nlink,targetBefore);
 }
});

test('owned symlink link refuses occupied destinations and invalid bindings before command',async t=>{
 if(!requireDarwin(t))return;
 for(const kind of ['file','symlink','directory','outside','traversal','stage-identity','first-inode','payload','count','parent-symlink'])await t.test(kind,()=>{
  const f=stageLinkFixture(t);let destination=f.second,stageIdentity=f.identity,expected=f.expected;
  if(kind==='file')fs.writeFileSync(destination,'foreign');
  if(kind==='symlink')fs.symlinkSync('missing',destination);
  if(kind==='directory')fs.mkdirSync(destination);
  if(kind==='outside')destination=path.join(f.root,'outside');
  if(kind==='traversal')destination=path.join(f.stage,'nested')+'/../escape';
  if(kind==='stage-identity')stageIdentity={...f.identity,ino:'0'};
  if(kind==='first-inode'){fs.renameSync(f.first,path.join(f.stage,'retained'));fs.symlinkSync('missing',f.first);}
  if(kind==='payload')expected={...expected,payload:'other'};
  if(kind==='count')expected={...expected,nlink:'2'};
  if(kind==='parent-symlink'){fs.renameSync(path.join(f.stage,'nested'),path.join(f.stage,'old'));fs.symlinkSync('old',path.join(f.stage,'nested'));}
  const before=snapshot(f.root);let calls=0;
  withLinkCommand(()=>{calls++;throw new Error('must not execute');},()=>assert.throws(()=>linkOwnedStageSymlink(f.stage,stageIdentity,f.first,destination,expected)));
  assert.equal(calls,0);assert.deepEqual(snapshot(f.root),before);
 });
});

test('owned symlink link propagates bounded command failures and rejects false success',async t=>{
 if(!requireDarwin(t))return;
 for(const code of ['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','NONZERO','FALSE_SUCCESS'])await t.test(code,()=>{
  const f=stageLinkFixture(t),before=snapshot(f.root);let calls=0;
  withLinkCommand((program,args,options)=>{
   calls++;assert.equal(program,'/bin/ln');assert.deepEqual(args,['-P','-h','--',f.first,f.second]);
   assert.deepEqual(options,{shell:false,timeout:2000,maxBuffer:4096,encoding:'utf8',stdio:['ignore','pipe','pipe']});
   if(code==='FALSE_SUCCESS')return '';
   const error=new Error('controlled command failure');error.code=code;throw error;
  },()=>assert.throws(()=>linkOwnedStageSymlink(f.stage,f.identity,f.first,f.second,f.expected)));
  assert.equal(calls,1);assert.deepEqual(snapshot(f.root),before);
 });
});

test('owned symlink link detects post-command stage replacement and preserves the foreign replacement',t=>{
 if(!requireDarwin(t))return;
 const f=stageLinkFixture(t),retained=path.join(f.root,'retained-stage');const original=childProcess.execFileSync;
 withLinkCommand((...args)=>{const result=original(...args);fs.renameSync(f.stage,retained);fs.mkdirSync(f.stage);fs.writeFileSync(path.join(f.stage,'foreign'),'preserve');return result;},
  ()=>assert.throws(()=>linkOwnedStageSymlink(f.stage,f.identity,f.first,f.second,f.expected),/ownership\/inode changed/u));
 assert.equal(fs.readFileSync(path.join(f.stage,'foreign'),'utf8'),'preserve');
 assert.deepEqual(fs.readdirSync(f.stage),['foreign']);assert.equal(fs.lstatSync(path.join(retained,'a')).nlink,2);
});

test('owned renderer preserves independently created hardlinked symlinks across nested paths',t=>{
 if(!requireDarwin(t))return;
 const root=temporary(t),source=copyFixture(root,'ready','source'),assets=path.join(source,'assets');fs.mkdirSync(assets);fs.mkdirSync(path.join(assets,'nested'));
 const first=path.join(assets,'a'),second=path.join(assets,'nested','b'),third=path.join(assets,'c');fs.symlinkSync('/outside/not-read',first);
 execFileSync('/bin/ln',['-P','-h','--',first,second],{shell:false,timeout:2000,maxBuffer:4096});
 execFileSync('/bin/ln',['-P','-h','--',first,third],{shell:false,timeout:2000,maxBuffer:4096});
 assert.equal(fs.lstatSync(first).nlink,3);const before=snapshot(source),candidate=closedDocumentFixture(source,path.join(root,'candidate'));
 const files=['a','nested/b','c'].map(name=>path.join(candidate,'assets',name));
 for(const file of files){assert(fs.lstatSync(file).isSymbolicLink());assert.equal(fs.lstatSync(file).ino,fs.lstatSync(files[0]).ino);assert.equal(fs.lstatSync(file).nlink,3);assert.equal(fs.readlinkSync(file),'/outside/not-read');}
 assert.deepEqual(snapshot(source),before);assert.notEqual(fs.lstatSync(files[0]).ino,fs.lstatSync(first).ino);
});

test('owned symlink link detects a real parent or source replacement at its final barrier',async t=>{
 if(!requireDarwin(t))return;
 for(const kind of ['parent','source'])await t.test(kind,()=>{
  const f=stageLinkFixture(t),readlink=fs.readlinkSync;let changed=false,calls=0,changedSnapshot;
  fs.readlinkSync=(file,...args)=>{
   const payload=readlink(file,...args);
   if(file===f.first&&!changed){
    changed=true;
    if(kind==='parent'){fs.renameSync(path.dirname(f.second),path.join(f.stage,'retained-parent'));fs.mkdirSync(path.dirname(f.second));fs.writeFileSync(path.join(path.dirname(f.second),'foreign'),'preserve');}
    else {fs.renameSync(f.first,path.join(f.stage,'retained-source'));fs.symlinkSync(f.expected.payload,f.first);}
    changedSnapshot=snapshot(f.root);
   }
   return payload;
  };
  try{withLinkCommand(()=>{calls++;},()=>assert.throws(()=>linkOwnedStageSymlink(f.stage,f.identity,f.first,f.second,f.expected),/ancestor changed|source identity or payload changed/u));}
  finally{fs.readlinkSync=readlink;}
  assert(changed);assert.equal(calls,0);assert.deepEqual(snapshot(f.root),changedSnapshot);
 });
});

test('owned symlink link rejects successful commands with wrong physical topology',async t=>{
 if(!requireDarwin(t))return;
 for(const kind of ['regular-file','independent-symlink'])await t.test(kind,()=>{
  const f=stageLinkFixture(t);let calls=0;
  withLinkCommand(()=>{calls++;if(kind==='regular-file')fs.writeFileSync(f.second,'wrong');else fs.symlinkSync(f.expected.payload,f.second);},
   ()=>assert.throws(()=>linkOwnedStageSymlink(f.stage,f.identity,f.first,f.second,f.expected),/exact physical topology/u));
  assert.equal(calls,1);assert.equal(fs.lstatSync(f.first).nlink,1);assert.equal(fs.readlinkSync(f.first),f.expected.payload);
 });
});

test('renderer rejects a symlink hardlink crossing its preservation boundary',t=>{
 if(!requireDarwin(t))return;
 const root=temporary(t),source=copyFixture(root,'ready','source'),assets=path.join(source,'assets');fs.mkdirSync(assets);
 const first=path.join(assets,'a'),outside=path.join(root,'outside');fs.symlinkSync('missing',first);
 execFileSync('/bin/ln',['-P','-h','--',first,outside],{shell:false,timeout:2000,maxBuffer:4096});
 assert(fs.lstatSync(outside).isSymbolicLink());assert.equal(fs.lstatSync(first).nlink,2);const before=snapshot(source);
 assert.throws(()=>closedDocumentFixture(source,path.join(root,'stage')),/crosses the CLOSE preservation boundary/u);
 assert.deepEqual(snapshot(source),before);assert.equal(fs.readlinkSync(outside),'missing');
 // The failed renderer owns no cleanup capability; source and outside peer stay bound.
 assert.equal(fs.lstatSync(first).ino,fs.lstatSync(outside).ino);assert.equal(fs.lstatSync(first).nlink,2);
});
