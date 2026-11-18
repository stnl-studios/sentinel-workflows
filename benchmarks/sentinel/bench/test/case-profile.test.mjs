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
 for(const key of ['limits','source','sentinelRevision','contextPolicy','concurrency','cli','sandbox','unknown']){const p=base();p.caseOverrides={rename:{[key]:{}}};assert.throws(()=>validateProfile(p),/only roles/);}
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
