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
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';import{Ledger,confined,atomicJson,writeOnce,acquireLock,budgetDecision,classifyMeasurement,resumeDecision}from'../core.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../temp/core-tests');fs.mkdirSync(base,{recursive:true});
function dir(){return ownTestRoot(fs.mkdtempSync(path.join(base,'case-')));}
test('canonical path rejects traversal and symlink',()=>{const d=dir();assert.throws(()=>confined(d,'../outside'));fs.symlinkSync(base,path.join(d,'link'));assert.throws(()=>confined(d,'link/file'));assert.equal(confined(d,'new/file'),path.join(d,'new/file'));});
test('atomic checkpoint, write-once, exclusive lock',()=>{const d=dir(),f=path.join(d,'s');atomicJson(f,{a:1});atomicJson(f,{a:2});assert.equal(JSON.parse(fs.readFileSync(f)).a,2);assert.throws(()=>writeOnce(f,{}));const release=acquireLock(d);assert.throws(()=>acquireLock(d));release();acquireLock(d)();});
test('ledger detects edits and incomplete writes',()=>{const f=path.join(dir(),'ledger');const l=new Ledger(f);l.append('intent',{turn:1});l.append('accepted',{id:'x'});assert.equal(new Ledger(f).rows.length,2);fs.appendFileSync(f,'{');assert.throws(()=>new Ledger(f));});
test('all stop budgets stay absolute',()=>{const limits={maxTurns:12,maxNoProgress:2,maxReportedTokens:100};const s={now:5,campaignDeadline:10,caseDeadline:9,turns:0,unchanged:0,reportedTokens:0};assert.equal(budgetDecision(s,limits),'ALLOW');assert.equal(budgetDecision({...s,now:9},limits),'DEADLINE');assert.equal(budgetDecision({...s,unchanged:2},limits),'NO_PROGRESS');assert.equal(budgetDecision({...s,reportedTokens:100},limits),'OBSERVED_TOKEN_LIMIT');});
test('failed valid run stays official and uncertain effects never replay',()=>{assert.deepEqual(classifyMeasurement({mode:'official',qualificationMatches:true,harnessValid:true,outcome:'FAIL'}),{measurement:'official',taskPassed:false});assert.equal(resumeDecision({pending:true,providerStatus:'completed',authoritySettled:false,identityMatches:true,proofMatches:true}),'BLOCKED');assert.equal(resumeDecision({pending:true,providerStatus:'completed',authoritySettled:true,identityMatches:true,proofMatches:true}),'SETTLE_NO_REPLAY');});
