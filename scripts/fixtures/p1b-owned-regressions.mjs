import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fixture,approveFixture,verificationBody} from '../test-p1b-preparation.mjs';
import {implementOffline,runFirstRemoval} from '../test-p1b-publication.mjs';
import {implementedFixture,formal,native,capture,setSection,evidence} from '../test-p1b-continuity.mjs';
import {ancestorFixture} from '../test-p1b-candidate-lifecycle.mjs';
import {inspectExecutionState,readExecutionActivation,beginPreparedExecutionOperation,validateExecutionCandidate,resolvePhysicalImplementationTarget} from '../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {captureExecutionTree} from '../../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {prepareExecutionCopy,publishExecutionCopy} from '../../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import {serializeRunnerExecutionBundleFromResponse,insertExecutionEvidenceInCandidate} from '../../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import {publishValidationCandidate} from '../../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';

const dirs=['src','second','third'];
const claims=dir=>[`../../${dir}/greeting.test.mjs`,`../../${dir}/unpredicted.mjs`];
const relation=(number,paths)=>`- Slice ${String(number).padStart(2,'0')} overlap: ${paths.map(p=>'`'+p+'`').join(', ')}; re-run the actual earlier greeting assertions and preserve their exports.`;
const finding=`### finding-01\n\n- Severity: blocking\n- State: active\n- Origin: attempt-01\n- Problem: Prepared proof needs its explicit preservation assertion.\n- Evidence: Controlled semantic fixture identifies the missing assertion.\n- Impact: Acceptance proof is incomplete.\n- Related authority: AC-002\n- Expected correction: Strengthen the approved second-module proof while preserving the first export.`;

// Independent source directories plus explicitly authorized earlier files make
// overlap real without granting ownership from directory membership alone.
async function overlapFixture(count=2) {
  const f=await fixture();const basePlan=await fs.readFile(path.join(f.candidate,'plans/slice-01.md'),'utf8');
  const baseTask=await fs.readFile(path.join(f.candidate,'tasks/slice-01.md'),'utf8');
  let global=await fs.readFile(path.join(f.candidate,'plan.md'),'utf8');const row=global.split('\n').find(l=>l.startsWith('| 01 -'));
  let index=await fs.readFile(path.join(f.candidate,'tasks.md'),'utf8');const indexRow=index.split('\n').find(l=>l.startsWith('| [ ] | 01'));
  for(let i=1;i<count;i++) {
    const n=String(i+1).padStart(2,'0'),dir=dirs[i];await fs.mkdir(path.join(f.root,dir));
    await fs.appendFile(f.specPath,`AC-00${i+1}: Export the independently named ${dir} greeting; preserve prior exports through their actual assertions.\n`);
    const areas=[`directory: \`${dir}\``,...dirs.slice(0,i).flatMap(d=>[`file: \`${d}/greeting.test.mjs\``,`file: \`${d}/unpredicted.mjs\``])];
    const newRow=row.replace('01 - Greeting',`${n} - ${dir} greeting`).replace('AC-001',`AC-00${i+1}`).replace('directory: `src`',areas.join('; ')).replace('slice-01',`slice-${n}`);
    global=global.replace(row,row+'\n'+newRow);
    index=index.replace(indexRow,indexRow+'\n'+indexRow.replace('01 - Greeting',`${n} - ${dir} greeting`).replace('slice-01',`slice-${n}`));
    for(const [folder,base] of [['plans',basePlan],['tasks',baseTask]]) {
      let text=base.replaceAll('Slice 01',`Slice ${n}`).replaceAll('- Slice: 01',`- Slice: ${n}`).replaceAll('slice-01',`slice-${n}`).replaceAll('AC-001',`AC-00${i+1}`).replaceAll('src/',dir+'/').replaceAll('`src`','`'+dir+'`').replaceAll('1.1',`${i+1}.1`);
      text=setSection(text,'Authorized Areas',areas.map(a=>'- '+a).join('\n'));
      text=setSection(text,'Verification Recipe',verificationBody({files:[dir+'/greeting.test.mjs',...dirs.slice(0,i).map(d=>d+'/greeting.test.mjs')]}));
      await fs.writeFile(path.join(f.candidate,folder,`slice-${n}.md`),text);
    }
  }
  // New rows were inserted before their predecessors; order must remain serial.
  global=setSection(global,'Serial Slice Order',global.match(/## Serial Slice Order\n\n([\s\S]*?)(?=\n## )/u)[1].trim().split('\n').slice(0,2).join('\n')+'\n'+global.split('\n').filter(l=>/^\| [0-9]{2} -/.test(l)).sort().join('\n'));
  const lines=index.split('\n');const start=lines.findIndex(l=>l.startsWith('| [ ] | 01'));
  const rows=lines.filter(l=>/^\| \[ \] \| [0-9]{2} -/.test(l)).sort();index=lines.slice(0,start).join('\n')+'\n'+rows.join('\n')+'\n';
  await fs.writeFile(path.join(f.candidate,'plan.md'),global);await fs.writeFile(path.join(f.candidate,'tasks.md'),index);
  await approveFixture(f);return f;
}
async function execute(f,number,{publish=true,overlap=null,beforeChecks=null}={}) {
  const slice='slice-'+String(number).padStart(2,'0');const image=await readExecutionActivation(f.specPath);
  const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE',String(number),image.activation.activationId);
  const prior=dirs.slice(0,number-1);const additional=prior.flatMap(claims);
  const carrier=overlap ?? (prior.map((d,i)=>relation(i+1,dirs.slice(0,i+1).flatMap(claims))).join('\n') || '- none');
  const impl=await implementOffline(f,admitted,{slice,directory:dirs[number-1],priorOverlap:carrier,additionalClaims:additional,regressionFiles:prior.map(d=>d+'/greeting.test.mjs'),beforeChecks});
  f.invocations=(f.invocations ?? 0)+1;
  if(publish) await publishExecutionCopy({specPath:f.specPath,slice,candidateRoot:impl.copy.candidateRoot});
  return {admitted,impl,slice};
}
async function predecessors(f,count) {
  for(let n=1;n<=count;n++){await execute(f,n);await formal(f,{slice:'slice-'+String(n).padStart(2,'0'),directory:dirs[n-1]});}
}
export async function runOwnedContract(kind) {
  if(['overlap-sets','directory-owner','required-overlap'].includes(kind)) {
    const f=await overlapFixture(kind==='directory-owner'?2:3);const n=kind==='directory-owner'?2:3;await predecessors(f,n-1);
    const run=await execute(f,n,{publish:false});const file=run.impl.copy.candidateTaskArtifact;const original=await fs.readFile(file,'utf8');const live=await captureExecutionTree(f.workspace.executionRoot);
    assert.equal((await validateExecutionCandidate(f.specPath,run.impl.copy.candidateExecutionRoot)).state,'IMPLEMENTED_AWAITING_VALIDATION');
    const parsed=await inspectExecutionState(f.specPath);assert.ok(parsed.tasks.get('slice-01').base.present);
    if(kind==='overlap-sets') {
      // src paths occur in both genuine predecessor records; physical scope has no duplicate.
      const own=original.match(/## Implementation Test Evidence\n\n([\s\S]*?)(?=\n## )/u)[1];
      assert.equal([...own.matchAll(/^  - `([^`]+)` \| sha256:/gmu)].filter(m=>m[1]==='../../src/unpredicted.mjs').length,1);
      const duplicate=relation(1,[...claims('src'),claims('src')[0]])+'\n'+relation(2,dirs.slice(0,2).flatMap(claims));
      await fs.writeFile(file,setSection(original,'Prior Validation Overlap',duplicate));
      await assert.rejects(validateExecutionCandidate(f.specPath,run.impl.copy.candidateExecutionRoot),/duplicate path claim/);
    } else if(kind==='directory-owner') {
      await fs.appendFile(path.join(f.root,'src/unpredicted.mjs'),'// changed after the observed owned check\n');
      await assert.rejects(validateExecutionCandidate(f.specPath,run.impl.copy.candidateExecutionRoot),/file-backed candidate evidence expected/);
      assert.ok((await inspectExecutionState(f.specPath)).tasks.get('slice-01').base.present,'directory scope did not replace the historical base');
    } else {
      await fs.writeFile(file,setSection(original,'Prior Validation Overlap','- none'));
      await assert.rejects(publishExecutionCopy({specPath:f.specPath,slice:run.slice,candidateRoot:run.impl.copy.candidateRoot}),/Prior Validation Overlap is missing/);
      assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),live);
      await fs.writeFile(file,setSection(original,'Prior Validation Overlap',relation(1,claims('src'))));
      await assert.rejects(validateExecutionCandidate(f.specPath,run.impl.copy.candidateExecutionRoot),/slice-02/);
      await fs.writeFile(file,original);await publishExecutionCopy({specPath:f.specPath,slice:run.slice,candidateRoot:run.impl.copy.candidateRoot});
    }
    assert.ok(await fs.stat(run.impl.copy.candidateRoot));await evidence(f,'contract-'+kind,{slot:run.slice});return;
  }
  if(kind==='findings-overlap') {
    const f=await overlapFixture(2);await predecessors(f,1);const run=await execute(f,2);
    const needsFix={status:'NEEDS_FIX',findingReferences:'finding-01',findingDispositions:'finding-01=active',evidence:'Controlled independent semantic fixture: strengthen the explicit preservation proof; actual greeting checks pass.'};
    await formal(f,{slice:'slice-02',directory:'second',responseOverride:needsFix,editCandidate:async c=>{const p=path.join(c.candidateExecutionRoot,'tasks/slice-02.md');await fs.writeFile(p,setSection(await fs.readFile(p,'utf8'),'Validation Findings',finding));}});
    const current=await readExecutionActivation(f.specPath);const admitted=await beginPreparedExecutionOperation(f.specPath,'APPLY_FINDINGS','2',current.activation.activationId);
    const start=await native(f,admitted.owner);const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-02',owner:admitted.owner});
    const task=copy.candidateTaskArtifact;let text=await fs.readFile(task,'utf8');text=setSection(text,'Corrections Applied','- `../../second/greeting.test.mjs`');await fs.writeFile(task,text);
    await fs.appendFile(path.join(f.root,'second/greeting.test.mjs'),'import {greeting as priorGreeting} from "../src/unpredicted.mjs";test("AC-002 preserved prior export",()=>assert.equal(priorGreeting,"hello"));\n');
    // The correction adds a real earlier-export assertion within the approved proof.
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const observed=spawnSync(process.execPath,['--test','second/greeting.test.mjs','src/greeting.test.mjs'],{cwd:f.root,env,encoding:'utf8'});
    assert.equal(observed.status,0,observed.stdout+observed.stderr);assert.match(observed.stdout,/^# tests 3$/mu);
    const response={...run.impl.response,commands:[{command:'node --test second/greeting.test.mjs src/greeting.test.mjs',exit:observed.status}],findingsCycle:'attempt-01',findingsVerified:'finding-01',correctionsCovered:'Added a real prior-export preservation assertion; independent semantic review controls formal disposition.',regressionsSelected:'Both actual greeting assertions were executed and exports preserved.',unsupportedActiveFindings:'none'};
    for(const k of ['priorRoundFailure','correctionApplied','inSliceRationale']) delete response[k];
    const captured=await capture(start,response,[...claims('src'),...claims('second')]);
    const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'APPLY_FINDINGS',response:JSON.stringify(response),workspace:f.root,taskArtifact:task,...captured});
    await insertExecutionEvidenceInCandidate({taskArtifact:task,operation:'APPLY_FINDINGS',bundle,validateProspectiveTask:t=>validateExecutionCandidate(f.specPath,copy.candidateExecutionRoot,[t])});
    await publishExecutionCopy({specPath:f.specPath,slice:'slice-02',candidateRoot:copy.candidateRoot});
    const before=(await inspectExecutionState(f.specPath)).tasks.get('slice-02').currentAuxiliaryCheck;
    await formal(f,{slice:'slice-02',directory:'second',responseOverride:needsFix,testCount:2});
    const selected=(await inspectExecutionState(f.specPath)).tasks.get('slice-02');assert.equal(selected.attempts.at(-1).id,'attempt-02');assert.equal(selected.currentAuxiliaryCheck.id,'findings-check-01');assert.deepEqual(selected.currentAuxiliaryCheck.testedState,before.testedState);
    assert.ok(selected.currentAuxiliaryCheck.testedState.some(e=>e.path==='../../src/unpredicted.mjs'));
    await evidence(f,'contract-findings-overlap',{check:before.id,attempt:selected.attempts.at(-1).id});return;
  }
  if(kind==='nested-root') {
    const f=await ancestorFixture();const image=await readExecutionActivation(f.specPath);const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',image.activation.activationId);
    const impl=await implementOffline(f,admitted,{directory:'specs'});await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:impl.copy.candidateRoot});
    const result=await formal(f,{directory:'specs'});assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');
    const target=path.join(f.root,'specs/unpredicted.mjs'),artifact=path.join(f.workspace.executionRoot,'tasks/slice-01.md');
    assert.equal((await resolvePhysicalImplementationTarget(f.specPath,{artifact,raw:path.relative(path.dirname(artifact),target).split(path.sep).join('/')})).physicalTarget,target);
    const escaped=path.join(path.dirname(f.root),'escaped-'+randomUUID()+'.mjs');await fs.writeFile(escaped,'export const greeting="hello";');
    await assert.rejects(resolvePhysicalImplementationTarget(f.specPath,{artifact,raw:path.relative(path.dirname(artifact),escaped).split(path.sep).join('/')}),/outside|escape|unsafe/);
    assert.equal(result.publication.publication,'confirmed');await evidence(f,'contract-nested-root',{escaped});return;
  }
  const f=await implementedFixture();const proposal=await formal(f,{publish:false});const file=path.join(proposal.copy.candidateExecutionRoot,'tasks/slice-01.md');const original=await fs.readFile(file,'utf8');const before=await captureExecutionTree(f.workspace.executionRoot);
  assert.equal((await validateExecutionCandidate(f.specPath,proposal.copy.candidateExecutionRoot)).state,'COMPLETE');
  if(kind==='base-provenance'||kind==='terminal-candidate') {
    const base=original.match(/## Effective Validation Base\n\n([\s\S]*?)(?=\n## )/u)[1].trim();
    for(const changed of [base.replace('`../../src/unpredicted.mjs`','`src/unpredicted.mjs`'),base.replace(/sha256:[a-f0-9]{64}/u,'sha256:'+'0'.repeat(64))]) {
      await fs.writeFile(file,setSection(original,'Effective Validation Base',changed));
      await assert.rejects(validateExecutionCandidate(f.specPath,proposal.copy.candidateExecutionRoot),/provenance|validation owner|expected|outside|origin|state|scope|match/);
      assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
    }
    await fs.writeFile(file,original);
  }
  await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:proposal.copy.candidateExecutionRoot,owner:proposal.admitted.owner});
  if(kind!=='terminal-candidate') {
    const image=(await readExecutionActivation(f.specPath)).activation;const raw=await fs.readFile(path.join(f.workspace.executionRoot,'tasks/slice-01.md'));
    await fs.appendFile(path.join(f.root,'src/unpredicted.mjs'),'// actual post-PASS byte drift\n');const drift=await inspectExecutionState(f.specPath);
    assert.equal(drift.tasks.get('slice-01').validation.validity,'revalidation-required');assert.equal(drift.tasks.get('slice-01').validation.historicalPass,'attempt-01');
    assert.deepEqual((await readExecutionActivation(f.specPath)).activation,image);assert.deepEqual(await fs.readFile(path.join(f.workspace.executionRoot,'tasks/slice-01.md')),raw);
  }
  if(kind==='terminal-drift') await runFirstRemoval({afterFormal:async({f:removed,after})=>{
    const activation=(await readExecutionActivation(removed.specPath)).activation;
    const artifact=path.join(removed.workspace.executionRoot,'tasks/slice-01.md');const raw=await fs.readFile(artifact);
    await fs.writeFile(path.join(removed.root,'src/obsolete.mjs'),'export const obsolete=true;\n');
    const drift=await inspectExecutionState(removed.specPath);assert.equal(drift.tasks.get('slice-01').validation.validity,'revalidation-required');assert.equal(drift.tasks.get('slice-01').validation.historicalPass,'attempt-01');
    assert.deepEqual((await readExecutionActivation(removed.specPath)).activation,activation);assert.deepEqual(await fs.readFile(artifact),raw);
    await evidence(removed,'contract-removed-reappearance',{after,activation});
  }});
  await evidence(f,'contract-'+kind,{proposal:proposal.copy.candidateExecutionRoot});
}
