import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {BASE} from '../campaign.mjs';import{effectiveRunProfile,prepareOfficialAdmission,qualifyFromInput,requirePublicCampaignProfile}from'../admission.mjs';import{parseCli,main}from'../cli.mjs';
const profile=()=>JSON.parse(fs.readFileSync(path.join(BASE,'bench/profiles/default.json')));
function temporary(t){const base=fs.mkdtempSync(path.join(BASE,'temp','admission-'));fs.mkdirSync(path.join(base,'evidence'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return base;}
test('effective suite/repetitions finalized before identity without changing input',()=>{const p=profile(),before=JSON.stringify(p),r=effectiveRunProfile(p,{caseIds:['query','import'],repetitions:3});assert.deepEqual(r.suiteCases,['query','import']);assert.equal(r.repetitions,3);assert.equal(JSON.stringify(p),before);assert.throws(()=>effectiveRunProfile(p,{caseIds:['rename','rename']}),/cases/);assert.throws(()=>effectiveRunProfile(p,{repetitions:0}),/repetition/);});
test('CLI official explicit proof required, diagnostics cannot accidentally promote',()=>{assert.throws(()=>parseCli(['run','--id','test','--mode','official']),/qualification/);assert.throws(()=>parseCli(['run','--id','test','--qualification','x']),/official/);assert.equal(parseCli(['run','--id','test','--mode','official','--qualification','evidence/q.json']).options['--mode'],'official');assert.equal(parseCli(['run','--id','test']).options['--mode'],undefined);assert.throws(()=>parseCli(['qualify','--id','test']),/input/);assert.equal(parseCli(['qualify','--id','test','--input','evidence/input.json']).command,'qualify');});
test('missing qualification fails before source/provider and writes diagnostic refusal',async t=>{const base=temporary(t);await assert.rejects(()=>prepareOfficialAdmission({base,id:'missing',profile:effectiveRunProfile(profile())}),e=>e.code==='OFFICIAL_ADMISSION_BLOCKED');const r=JSON.parse(fs.readFileSync(path.join(base,'evidence/admissions/missing/admission.json')));assert.equal(r.mode,'diagnostic');assert.equal(r.modelCampaignStarted,false);assert.equal(fs.existsSync(path.join(base,'source-snapshots')),false);});
test('tampered or unproven qualification bytes fail before any provider access',async t=>{const base=temporary(t);fs.writeFileSync(path.join(base,'evidence/q.json'),JSON.stringify({status:'QUALIFIED',proof:{ref:'evidence/nonexistent.json',sha256:'0'.repeat(64)}}));await assert.rejects(()=>prepareOfficialAdmission({base,id:'tampered',profile:effectiveRunProfile(profile()),qualificationFile:'evidence/q.json'}),/QUALIFICATION_EVIDENCE_BLOCKED/);assert.equal(fs.existsSync(path.join(base,'evidence/admissions/tampered/target-preflight')),false);});
test('qualification cannot accept traversal/symlinks or manufacture missing campaign evidence',async t=>{const base=temporary(t);fs.writeFileSync(path.join(base,'evidence/input.json'),JSON.stringify({identity:{},harnessIdentity:{},campaigns:[],checks:[]}));const r=await qualifyFromInput({base,id:'blocked',inputFile:'evidence/input.json'});assert.equal(r.status,'BLOCKED');assert.equal(fs.existsSync(path.join(base,'evidence/qualifications/blocked/qualification.json')),false);assert.ok(fs.existsSync(path.join(base,'evidence/qualifications/blocked/refusal.json')));fs.symlinkSync(path.join(base,'evidence/input.json'),path.join(base,'evidence/link.json'));await assert.rejects(()=>qualifyFromInput({base,id:'link',inputFile:'evidence/link.json'}),/symlink/);await assert.rejects(()=>qualifyFromInput({base,id:'escape',inputFile:'../outside.json'}),/escapes/);});


test('public launch accepts only C3 full matrix and has no concurrency switch',()=>{
 const p=JSON.parse(fs.readFileSync(path.join(BASE,'bench/profiles/reference-v5-observe.json'))),full=effectiveRunProfile(p);
 assert.equal(requirePublicCampaignProfile(full).concurrency,3);
 for(const concurrency of [1,2])assert.throws(()=>requirePublicCampaignProfile({...full,concurrency}),/REQUIRES_THREE_SLOTS/);
 for(const cases of [['rename'],['query','rename','import']])assert.throws(()=>requirePublicCampaignProfile(effectiveRunProfile(p,{caseIds:cases})),/FULL_MATRIX/);
 assert.throws(()=>requirePublicCampaignProfile(effectiveRunProfile(p,{repetitions:1})),/FULL_MATRIX/);
 for(const n of [1,2,3])assert.throws(()=>parseCli(['run','--id','x','--concurrency',String(n)]),/REMOVED_CONCURRENCY_OPTION/);
 assert.equal(effectiveRunProfile(p,{caseIds:['rename'],repetitions:1}).suiteCases.length,1); // Internal probe stays supported.
});

test('public CLI refuses legacy and partial live runs before any campaign output',async()=>{
 const base=path.join(BASE,'bench/profiles');
 await assert.rejects(()=>main(['run','--id','old-serial-must-not-start','--profile',path.join(base,'default.json')]),/REQUIRES_THREE_SLOTS/);
 await assert.rejects(()=>main(['run','--id','partial-must-not-start','--profile',path.join(base,'reference-v5-observe.json'),'--cases','rename','--repetitions','1']),/REQUIRES_FULL_MATRIX/);
 for(const id of ['old-serial-must-not-start','partial-must-not-start'])assert.equal(fs.existsSync(path.join(BASE,'evidence/campaigns',id)),false);
});

test('public resume is refused before reading evidence or starting a process',async()=>{
 assert.throws(()=>parseCli(['resume','--id','c3','--case','rename-1']),/PUBLIC_BENCHMARK_RESUME_DISABLED/);
 await assert.rejects(()=>main(['resume','--id','c3','--case','rename-1']),/PUBLIC_BENCHMARK_RESUME_DISABLED/);
});
