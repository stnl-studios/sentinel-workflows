import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createOfflineCheckout } from './fixtures/offline-checkout.mjs';
const ROOT=path.resolve(import.meta.dirname,'..');
for (const [scenario,operation,caseId] of [['validate','VALIDATE_SLICE','A'],['execute','EXECUTE_SLICE','B'],['apply','APPLY_FINDINGS','B']]) test(`recovery real offline manager ${operation} rejection to successor execution publication and counted budgets`, {timeout:120000}, async t=>{
  const f=await createOfflineCheckout(t,ROOT,'runner-recovery-'+scenario);
  const result=spawnSync(process.execPath,['benchmarks/sentinel-todo/runtime/benchmark-manager.mjs','run','--case',caseId],{cwd:f.root,env:f.env,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
  await fs.writeFile(path.join(f.root,'.offline-recovery-manager.log'),result.stdout+'\n'+result.stderr);
  console.log('TEST-ONLY recovery manager evidence: '+f.root);
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  const run=(await fs.readdir(path.join(f.root,'benchmark-temp'))).find(name=>name.startsWith('run-'));
  const runRoot=path.join(f.root,'benchmark-temp',run),caseRoot=path.join(runRoot,'case-'+caseId.toLowerCase());
  const state=JSON.parse(await fs.readFile(path.join(caseRoot,'case-state.json')));
  const ledger=JSON.parse(await fs.readFile(path.join(runRoot,'.turn-ledger.json')));
  const calls=(await fs.readFile(path.join(f.root,'.offline-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(state.status,'PASS');assert.equal(ledger.total,calls.length);assert.equal(ledger.reservations.length,0);
  assert.equal(ledger.total,state.mainTurns+state.runnerTurns);assert.ok(calls.every(c=>c.externalCalls===0));
  const validations=state.operations.filter(op=>op.operation===operation);assert.equal(validations.length,2);
  assert.equal(validations[0].outcome.blocker,'OFFICIAL_RUNNER_RESULT_BLOCKED');assert.equal(validations[1].outcome.result,'PASS');
  assert.ok(validations[1].recovery.admission);assert.equal(validations[1].validationReassessment,null);
  const active=JSON.parse(await fs.readFile(path.join(caseRoot,'tmp/stnl-runner-broker/active.json')));
  assert.equal(active.officialPreflight.owner.operationAttemptId,validations[1].recovery.admission.rejectedOperationAttemptId);
  const recoveryProof=JSON.parse(await fs.readFile(validations[1].recovery.admission.rejection.path));
  const oldReceipt=JSON.parse(await fs.readFile(recoveryProof.receiptFile));
  const acceptedFiles=(await fs.readdir(state.runnerTmpdir)).filter(name=>name.includes('-'+operation.toLowerCase()+'-')&&name.endsWith('.receipt.json'));
  const accepted=JSON.parse(await fs.readFile(path.join(state.runnerTmpdir,acceptedFiles[0])));
  assert.notEqual(accepted.owner.operationAttemptId,oldReceipt.owner.operationAttemptId);assert.notEqual(accepted.threadId,oldReceipt.threadId);
  assert.equal(accepted.attempt,scenario==='validate'?2:3);assert.equal(accepted.status,'RUNNER_RESPONSE_CAPTURED');
  if(scenario!=='validate') {
    const {recoverySection}=await import('../skills/workflows/stnl-slice-executor/runtime/runner-result-recovery.mjs');
    const heading=scenario==='execute'?'Implementation Test Evidence':'Findings Test Evidence';
    const privateCheck=recoverySection(await fs.readFile(path.join(f.root,'.offline-recovery-private.md'),'utf8'),heading);
    const finalTask=await fs.readFile(path.join(state.specPath,'execution/tasks/slice-01.md'),'utf8');
    assert.ok(recoverySection(finalTask,heading).startsWith(privateCheck));
    assert.equal(accepted.automaticCheckRound,'2/3');
  }
  const activeFile=path.join(caseRoot,'tmp/stnl-runner-broker/active.json');
  f.expectedRecoveredRunner={activeFile,activeSha256:createHash('sha256').update(await fs.readFile(activeFile)).digest('hex'),successor:accepted.owner,receiptFile:oldReceipt.receiptFile,supervisorFile:path.join(path.dirname(activeFile),`${String(active.sequence).padStart(3,'0')}.supervisor.json`)};
  const evidence={operation,root:f.root,caseRoot,status:state.status,mainTurns:state.mainTurns,runnerTurns:state.runnerTurns,ledger:ledger.total,externalCalls:0,
    predecessor:active.officialPreflight.owner.operationAttemptId,successor:accepted.owner.operationAttemptId,receipt:accepted.receiptFile};
  if(process.env.STNL_RECOVERY_EVIDENCE)await fs.writeFile(path.join(process.env.STNL_RECOVERY_EVIDENCE,`manager-${scenario}-${path.basename(f.root)}.json`),JSON.stringify(evidence,null,2)+'\n');
});
