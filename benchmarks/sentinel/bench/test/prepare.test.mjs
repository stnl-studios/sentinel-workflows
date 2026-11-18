import {after as cleanupAfterSuite} from 'node:test';
// Only fresh roots allocated by THIS test-file execution are disposable.
// Never glob temp, adopt a preexisting path, or delete a replaced root.
const ownedTestRoots = new Map();
function ownTestRoot(root) {
 const stat=fs.lstatSync(root);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('test root must be a new real directory');
 ownedTestRoots.set(root,{dev:stat.dev,ino:stat.ino});
 return root;
}
cleanupAfterSuite(()=>{
 for(const [root,identity]of ownedTestRoots){
  let stat;try{stat=fs.lstatSync(root);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(stat.isSymbolicLink()||stat.dev!==identity.dev||stat.ino!==identity.ino)throw Error('refusing cleanup of replaced test root: '+root);
  fs.rmSync(root,{recursive:true,force:false});
 }
});
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';import {spawnSync}from'node:child_process';
import {materializeSourceSnapshot}from'../source-snapshot.mjs';
import {confined,acquireLock}from'../core.mjs';import {verifySourceSnapshot,prepareCase}from'../prepare.mjs';
const base=fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'));const scratch=path.join(base,'temp/prepare-tests');fs.mkdirSync(scratch,{recursive:true});const fresh=()=>ownTestRoot(fs.mkdtempSync(path.join(scratch,'case-')));
let pinnedSnapshot;
async function installedPinnedSource(){
 const profile=JSON.parse(fs.readFileSync(path.join(base,'bench/profiles/default.json'))),repository=path.resolve(base,'../..');
 pinnedSnapshot??=materializeSourceSnapshot({base,repository,revision:profile.sentinelRevision});
 const snapshot=await pinnedSnapshot;verifySourceSnapshot({source:snapshot.sourceRoot,repository,revision:profile.sentinelRevision});return snapshot.sourceRoot;
}
function git(cwd,...args){const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
test('dangling symlink and nested dangling target cannot escape confinement',()=>{const root=fresh();fs.symlinkSync(path.join(root,'not-created'),path.join(root,'dangling'));assert.throws(()=>confined(root,'dangling/file'),/symlink/);assert.throws(()=>confined(root,'dangling'),/symlink/);assert.equal(confined(root,'new/nested'),path.join(root,'new/nested'));});
test('replaced lock symlink cannot cause deletion of another owner',()=>{const root=fresh(),release=acquireLock(root),file=path.join(root,'.lock'),other=path.join(root,'other');fs.copyFileSync(file,other);fs.unlinkSync(file);fs.symlinkSync(other,file);assert.throws(release,/identity/);assert.ok(fs.existsSync(other));assert.ok(fs.lstatSync(file).isSymbolicLink());});
test('source proof binds Git object bytes, file set and full revision',()=>{const root=fresh(),repo=path.join(root,'repo'),source=path.join(root,'source');fs.mkdirSync(repo);fs.mkdirSync(source);git(repo,'init','-q');fs.writeFileSync(path.join(repo,'a'),'original');git(repo,'add','.');git(repo,'-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','source');const revision=git(repo,'rev-parse','HEAD');fs.copyFileSync(path.join(repo,'a'),path.join(source,'a'));assert.equal(verifySourceSnapshot({source,repository:repo,revision}).revision,revision);fs.writeFileSync(path.join(source,'a'),'changed');assert.throws(()=>verifySourceSnapshot({source,repository:repo,revision}),/blob mismatch/);fs.writeFileSync(path.join(source,'a'),'original');fs.writeFileSync(path.join(source,'extra'),'x');assert.throws(()=>verifySourceSnapshot({source,repository:repo,revision}),/file-set/);});
test('real isolated installer, baseline tests and preserved partial diagnostic; fake CLI/auth, no models',async()=>{
 const root=fresh(),pinnedSource=await installedPinnedSource();fs.cpSync(pinnedSource,path.join(root,'source'),{recursive:true});fs.mkdirSync(path.join(root,'fixtures'));fs.cpSync(path.join(base,'fixtures/todo'),path.join(root,'fixtures/todo'),{recursive:true});
 const cli=path.join(root,'fake-cli');fs.writeFileSync(cli,'#!/bin/sh\nprintf "codex-cli 0.163.0\\n"\n',{mode:0o755});const auth=path.join(root,'fake-auth.json');fs.writeFileSync(auth,'FAKE_TEST_AUTH_NOT_A_CREDENTIAL');
 const profile=JSON.parse(fs.readFileSync(path.join(base,'bench/profiles/default.json')));profile.cli=cli;const input={base:root,campaignId:'test',caseId:'small',repetition:1,profile,requirements:'Test preparation only.',authFile:auth,sourceRepository:path.resolve(base,'../..')};
 const selectedEngine=path.join(root,'selected-engine');fs.mkdirSync(selectedEngine);input.engineRoot=selectedEngine;
 const m=await prepareCase(input);assert.equal(m.engineRoot,selectedEngine);assert.equal(m.sourceProof.revision,profile.sentinelRevision);assert.equal(m.sourceProof.files,586);assert.ok(fs.readFileSync(path.join(m.evidence,'baseline-tests.txt'),'utf8').includes('# fail 0'));assert.equal(fs.readlinkSync(path.join(m.codexHome,'auth.json')),auth);assert.ok(!JSON.stringify(m).includes('FAKE_TEST_AUTH_NOT_A_CREDENTIAL'));assert.ok(!fs.existsSync(path.join(root,'temp/preparation-locks/test-small-1/.lock')));
 await assert.rejects(prepareCase(input),/identity already used/);
 const bad={...input,repetition:2,authFile:path.join(root,'missing-auth')};await assert.rejects(prepareCase(bad),/authentication unavailable/);const evidence=path.join(root,'evidence/campaigns/test/small-2');const d=JSON.parse(fs.readFileSync(path.join(evidence,'preparation-diagnostic.json')));assert.equal(d.measurement,'diagnostic');assert.equal(d.stage,'authentication-link');assert.ok(fs.existsSync(path.join(root,'work/campaigns/test/small-2/home/.codex/skills')));assert.ok(!fs.existsSync(path.join(root,'temp/preparation-locks/test-small-2/.lock')));
});

test('selected Git revision supplies installer module, not historical base/source installer',async()=>{
 const root=fresh(),repo=path.join(root,'repo'),selected=path.join(root,'selected-source');
 const pinnedSource=await installedPinnedSource();fs.cpSync(pinnedSource,path.join(root,'source'),{recursive:true});fs.cpSync(pinnedSource,repo,{recursive:true});
 fs.appendFileSync(path.join(repo,'scripts/sentinel-install.mjs'),'\nthrow new Error("SELECTED_REVISION_INSTALLER_EXECUTED");\n');
 git(repo,'init','-q');git(repo,'add','.');git(repo,'-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','Different selected installer');
 const revision=git(repo,'rev-parse','HEAD');fs.cpSync(repo,selected,{recursive:true,filter:p=>path.basename(p)!=='.git'});
 fs.mkdirSync(path.join(root,'fixtures'));fs.cpSync(path.join(base,'fixtures/todo'),path.join(root,'fixtures/todo'),{recursive:true});
 const profile=JSON.parse(fs.readFileSync(path.join(base,'bench/profiles/default.json')));profile.sentinelRevision=revision;
 await assert.rejects(prepareCase({base:root,campaignId:'selected',caseId:'rename',repetition:1,profile,requirements:'Synthetic installer binding regression.',sourceRoot:selected,sourceRepository:repo,authFile:path.join(root,'not-read')}),/SELECTED_REVISION_INSTALLER_EXECUTED/);
 const diagnostic=JSON.parse(fs.readFileSync(path.join(root,'evidence/campaigns/selected/rename-1/preparation-diagnostic.json')));assert.equal(diagnostic.stage,'install');assert.equal(diagnostic.status,'PREPARATION_FAILED');
});
