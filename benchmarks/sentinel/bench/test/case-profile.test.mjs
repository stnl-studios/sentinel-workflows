import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolveCaseProfile,validateCaseOverrides,PROFILE_CASE_IDS} from '../case-profile.mjs';
import {validateProfile,digest} from '../core.mjs';
import {CASES} from '../scenarios.mjs';
const base=()=>JSON.parse(fs.readFileSync(new URL('../profiles/default.json',import.meta.url)));
const pair={model:'gpt-6.1-sol',effort:'medium'};
test('case IDs track scenario registry',()=>assert.deepEqual(PROFILE_CASE_IDS,CASES.map(x=>x.id)));
test('all cases inherit complete global defaults and isolated deep copies',()=>{
 const p=base(), before=structuredClone(p),a=resolveCaseProfile(p,'rename'),b=resolveCaseProfile(p,'import');
 assert.deepEqual(a,p);assert.deepEqual(b,p);a.roles.coordinator.effort='low';a.limits.maxTurns=1;
 assert.deepEqual(p,before);assert.deepEqual(b,p);assert.equal('caseOverrides' in a,false);
});
test('three case customizations independent, effective valid, global controls preserved',()=>{
 const p=JSON.parse(fs.readFileSync(new URL('../profiles/case-stage-example.json',import.meta.url))),before=structuredClone(p);
 validateProfile(p);
 for(const id of PROFILE_CASE_IDS){const r=resolveCaseProfile(p,id);validateProfile(r);assert.equal('caseOverrides' in r,false);for(const key of ['cli','cliVersion','sentinelRevision','contextPolicy','limits','concurrency','repetitions'])assert.deepEqual(r[key],p[key]);}
 assert.equal(resolveCaseProfile(p,'rename').stageRoles.EXECUTE_SLICE,'execute_coordinator');
 assert.equal(resolveCaseProfile(p,'query').roles.execute_check.effort,'medium');
 assert.equal(resolveCaseProfile(p,'import').roles.formal_validate.model,'gpt-6.1-sol');assert.deepEqual(p,before);
});
test('stage overrides merge and role replacement does not affect children',()=>{
 const p=base();p.stageRoles={PLAN:'coordinator'};p.caseOverrides={rename:{roles:{executor:pair},stageRoles:{EXECUTE_SLICE:'executor'}}};
 const r=resolveCaseProfile(p,'rename');assert.deepEqual(r.stageRoles,{PLAN:'coordinator',EXECUTE_SLICE:'executor'});assert.deepEqual(r.roles.formal_validate,p.roles.formal_validate);
 assert.deepEqual(resolveCaseProfile(p,'query').stageRoles,p.stageRoles);
});
test('reject unknown cases, override keys and changed global controls',()=>{
 for(const key of ['source','sentinelRevision','contextPolicy','concurrency','cli','sandbox','unknown']){const p=base();p.caseOverrides={rename:{[key]:{}}};assert.throws(()=>validateProfile(p),/only roles/);}
 const p=base();p.caseOverrides={other:{}};assert.throws(()=>validateCaseOverrides(p),/unknown case/);assert.throws(()=>resolveCaseProfile(base(),'other'),/unknown case/);
});
test('override roles require complete exact pairs and valid shapes',()=>{
 for(const config of [{model:'gpt-x'},{effort:'high'},null,[],{...pair,sandbox:'read-only'},{model:'',effort:'high'},{model:'gpt-x',effort:'bogus'}]){const p=base();p.caseOverrides={rename:{roles:{coordinator:config}}};assert.throws(()=>validateProfile(p));}
 for(const value of [null,[],false]){const p=base();p.caseOverrides=value;assert.throws(()=>validateProfile(p));}
});
test('merged stage references validated, approver and persistent switching rejected',()=>{
 for(const stageRoles of [{BAD:'coordinator'},{PLAN:'missing'},{PLAN:'plan_approver'},null,[]]){const p=base();p.caseOverrides={rename:{stageRoles}};assert.throws(()=>validateProfile(p));}
 const p=base();p.contextPolicy='persistent';p.caseOverrides={rename:{roles:{executor:pair},stageRoles:{EXECUTE_SLICE:'executor'}}};assert.throws(()=>validateProfile(p),/persistent/);
});
test('invalid sibling override rejected even when resolving another case',()=>{const p=base();p.caseOverrides={import:{roles:{coordinator:{model:'gpt-x'}}}};assert.throws(()=>resolveCaseProfile(p,'rename'));});
test('effective digest detects model and effort changes, ignores other case override changes',()=>{
 const p=base();p.caseOverrides={rename:{roles:{coordinator:pair}}};const initial=digest(resolveCaseProfile(p,'rename'));
 p.caseOverrides.rename.roles.coordinator={...pair,effort:'low'};assert.notEqual(digest(resolveCaseProfile(p,'rename')),initial);
 p.caseOverrides.rename.roles.coordinator={...pair,model:'gpt-6-luna'};assert.notEqual(digest(resolveCaseProfile(p,'rename')),initial);
 p.caseOverrides.rename.roles.coordinator=pair;p.caseOverrides.import={roles:{coordinator:{...pair,effort:'low'}}};assert.equal(digest(resolveCaseProfile(p,'rename')),initial);
});
test('effective bindings preserve global shape or qualify selected case roles',async()=>{
 const {effectiveRoleBindings}=await import('../case-profile.mjs');const p=base();
 assert.deepEqual(effectiveRoleBindings(p),Object.entries(p.roles).map(([role,c])=>({role,...c})));
 p.caseOverrides={rename:{roles:{coordinator:pair,executor:pair}}};p.suiteCases=['rename'];
 const rows=effectiveRoleBindings(p);assert.equal(rows.length,6);assert(rows.every(r=>r.caseId==='rename'&&r.role==='rename__'+r.logicalRole));
 assert.equal(rows.find(r=>r.logicalRole==='coordinator').effort,'medium');assert.equal(rows.some(r=>r.role==='coordinator'),false);
 for(const suite of [[],['rename','rename'],['other'],null,'rename']){p.suiteCases=suite;if(suite===null)continue;assert.throws(()=>effectiveRoleBindings(p),/suiteCases/);}
});

test('case token limit overrides only selected case, preserves controls and deep-copy isolation',()=>{
 const p=base();p.limits.maxReportedTokens=12000000;p.limits.maxCampaignReportedTokens=60000000;
 p.caseOverrides={import:{limits:{maxReportedTokens:14000000}}};const before=structuredClone(p);
 validateProfile(p);const r=resolveCaseProfile(p,'import');validateProfile(r);
 assert.equal(r.limits.maxReportedTokens,14000000);
 for(const id of ['rename','query'])assert.equal(resolveCaseProfile(p,id).limits.maxReportedTokens,12000000);
 assert.deepEqual(r.limits,{...p.limits,maxReportedTokens:14000000});assert.deepEqual(r.roles,p.roles);
 r.limits.caseMs=1;r.limits.maxReportedTokens=1;assert.deepEqual(p,before);
 assert.equal(resolveCaseProfile(p,'import').limits.maxReportedTokens,14000000);
});
test('case limit rejects unknown controls, malformed values and values above campaign cap',()=>{
 for(const limits of [{},null,[],{maxTurns:1},{maxReportedTokens:1,caseMs:1},...[-1,0,1.5,Infinity,NaN,'14000000',Number.MAX_SAFE_INTEGER+1,60000001].map(maxReportedTokens=>({maxReportedTokens}))]){
  const p=base();p.limits.maxCampaignReportedTokens=60000000;p.caseOverrides={import:{limits}};
  assert.throws(()=>validateProfile(p));assert.throws(()=>resolveCaseProfile(p,'rename'));
 }
 const p=base();p.limits.maxCampaignReportedTokens=60000000;p.caseOverrides={import:{limits:{maxReportedTokens:60000000}}};validateProfile(p);
 delete p.limits.maxCampaignReportedTokens;validateProfile(p);
});
test('case limit participates in effective identity without changing siblings or models',()=>{
 const p=base();p.caseOverrides={import:{limits:{maxReportedTokens:12000000}}};
 const original=digest(resolveCaseProfile(p,'import')),sibling=digest(resolveCaseProfile(p,'rename'));
 p.caseOverrides.import.limits.maxReportedTokens=14000000;
 assert.notEqual(digest(resolveCaseProfile(p,'import')),original);assert.equal(digest(resolveCaseProfile(p,'rename')),sibling);
 assert.deepEqual(resolveCaseProfile(p,'import').roles,p.roles);
});
test('resolved case limits govern real budget decision and in-turn monitor without extending deadline',async()=>{
 const {budgetDecision}=await import('../core.mjs');const {UsageBudgetMonitor}=await import('../budget-monitor.mjs');
 const p=base();p.limits.maxReportedTokens=12000000;p.limits.maxCampaignReportedTokens=60000000;p.caseOverrides={import:{limits:{maxReportedTokens:14000000}}};
 for(const id of PROFILE_CASE_IDS){
  const profile=resolveCaseProfile(p,id),limit=id==='import'?14000000:12000000;
  const budget={now:1,campaignDeadline:14400000,caseDeadline:2400000,turns:1,unchanged:0,reportedTokens:12000000};
  assert.equal(budgetDecision(budget,profile.limits),id==='import'?'ALLOW':'OBSERVED_TOKEN_LIMIT');
  assert.equal(budgetDecision({...budget,reportedTokens:limit},profile.limits),'OBSERVED_TOKEN_LIMIT');
  assert.equal(budgetDecision({...budget,now:2400000,reportedTokens:0},profile.limits),'DEADLINE');
  const monitor=new UsageBudgetMonitor({limit:profile.limits.maxReportedTokens});
  monitor.observe({method:'thread/tokenUsage/updated',params:{threadId:'simulated',tokenUsage:{total:{totalTokens:12000000}}}});
  assert.equal(monitor.triggered,id!=='import');
  monitor.observe({method:'thread/tokenUsage/updated',params:{threadId:'simulated',tokenUsage:{total:{totalTokens:limit}}}});assert.equal(monitor.triggered,true);
 }
});
