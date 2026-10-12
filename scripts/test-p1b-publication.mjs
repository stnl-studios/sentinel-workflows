import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startNativeRunnerCapture, bindNativeRunnerIdentity, captureNativeRunnerResult, runNativeRunnerVerification } from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { spawnSync, fork, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fixture, approveFixture, verificationBody, retainPreparation, prepareFixtureCandidate, publishFixtureCandidate,
  reviewFixtureCandidate, normalizePreparation, editPreparation, setPreparationSection } from './test-p1b-preparation.mjs';
import { readExecutionActivation, beginPreparedExecutionOperation, preflightExecutionOperation, inspectExecutionState, validateExecutionCandidate } from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { prepareExecutionCopy, publishExecutionCopy } from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import { updateOperationalChecklist, parseStrictJson } from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import { captureRunnerTestedState, serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate } from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { acquireExecutionPublicationLock, releaseExecutionPublicationLock, executionLockIdentity, captureExecutionTree,
  readActivatedExecution, publishExecutionUpdate } from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import { prepareValidationCopy } from '../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import { prepareValidationCandidate } from '../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import { publishValidationCandidate } from '../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import { preparationAuthorityAt } from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { parsePreparationTableRow } from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import { readPreparationArtifacts } from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import { publishPreparationCandidate } from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';

// The predecessor comes from official publications. Only the new paired
// delivery is authored; identities, history retention and supersession are
// still produced by the runtime.
async function appendFixtureCandidate(f, { source = 'slice-01', target = 'slice-02', supersedes = true } = {}) {
  const old = await readPreparationArtifacts(f.workspace.executionRoot);
  const candidate = await prepareFixtureCandidate(f, 'REPLAN', { revisionMode: 'append-only-extension' });
  const number = target.slice(6), sourceNumber = source.slice(6);
  for (const type of ['plans', 'tasks']) {
    let text = type === 'plans' ? old.get(`plans/${source}.md`) : await fs.readFile(path.join(f.candidate, 'tasks/slice-01.md'), 'utf8');
    text = text.replace(/^- Delivery ID: .*\n/mu, '').replace(/- Slice: [0-9]+/u, '- Slice: ' + number)
      .replace(/Slice [0-9]+/u, 'Slice ' + number).replace(/full owner: slice-[0-9]+/gu, 'full owner: ' + target)
      .replace(/\.\.\/plans\/slice-[0-9]+\.md/u, '../plans/' + target + '.md')
      .replace(/^- \[ \] [0-9]+\./gmu, '- [ ] ' + BigInt(number).toString() + '.')
      .replace(/- History source: .+/u, '- History source: runtime');
    await fs.writeFile(path.join(candidate, type, target + '.md'), text);
  }
  let global = old.get('plan.md');
  const setField = (text, field, value) => text.includes('- ' + field + ':')
    ? text.replace(new RegExp(`^- ${field}: .+$`, 'mu'), '- ' + field + ': ' + value)
    : text.replace('- Review state: approved', '- Review state: approved\n- ' + field + ': ' + value);
  global = setField(global, 'Replan reason', 'Add a reviewed recovery delivery without rewriting predecessor records.');
  global = setField(global, 'Revision mode', 'append-only-extension');
  global = setField(global, 'Supersedes open slices', supersedes ? `${source} -> ${target}` : 'none');
  const priorRow = global.split('\n').find(line => line.startsWith(`| ${sourceNumber} -`));
  const cells = parsePreparationTableRow(priorRow, 6, 'fixture serial predecessor');
  cells[0] = number + ' - Recovery'; cells[2] = sourceNumber; cells[5] = `plans/${target}.md`;
  global = global.replace(priorRow, priorRow + '\n| ' + cells.join(' | ') + ' |');
  global = setPreparationSection(global, 'Delivery Continuity', '- runtime');
  await fs.writeFile(path.join(candidate, 'plan.md'), global);
  const index = old.get('tasks.md'), row = index.split('\n').find(line => line.includes(`| tasks/${source}.md |`));
  const taskCells = parsePreparationTableRow(row, 7, 'fixture task predecessor');
  taskCells[0] = '[ ]'; taskCells[1] = number + ' - Recovery'; taskCells[3] = sourceNumber;
  taskCells[4] = `tasks/${target}.md`; taskCells[5] = 'pending'; taskCells[6] = 'pending';
  await fs.writeFile(path.join(candidate, 'tasks.md'), index.replace(row, row + '\n| ' + taskCells.join(' | ') + ' |'));
  await normalizePreparation(f, candidate);
  return candidate;
}

async function unpublishedImplementationFixture(t) {
  const f = await fixture({ test: t });
  const approved = await approveFixture(f);
  const admission = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
  const implementation = await implementOffline(f, admission);
  retainPreparation(f, implementation.copy.candidateRoot);
  return { f, implementation, admission };
}
async function implementedAppendFixture(t) {
  const { f, implementation } = await unpublishedImplementationFixture(t);
  await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot });
  return { f, implementation, candidate: await appendFixtureCandidate(f) };
}

const commandEnvironment = { ...process.env };
delete commandEnvironment.NODE_TEST_CONTEXT;

const setSection = (text, heading, body) => text.replace(new RegExp(`(^## ${heading}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'mu'), `$1${body}\n\n`);
const ownerEnvironment = async (f, owner) => {
  const ownerFile = path.join(f.root, 'operation-owner.json');
  await fs.writeFile(ownerFile, JSON.stringify({ specPath: f.specPath, owner }));
  return ownerFile;
};

import {verificationCommand} from '../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';

// Native tool identities/results are simulated here; the product origin and
// capture boundaries are real and no agent/model or external call is made.
async function startOfflineNative(f, owner) {
  const origin = await startNativeRunnerCapture({specPath:f.specPath,owner,workspace:f.root,captureParent:f.root});
  const agentId = 'offline-native-' + randomUUID();
  await bindNativeRunnerIdentity({...origin,agentId});
  return { ...origin, agentId };
}
async function captureOfflineNative(started, response, changedAreas = null) {
  await runNativeRunnerVerification({originFile:started.originFile});
  return captureNativeRunnerResult({ originFile:started.originFile,
    result:{agentId:started.agentId,status:'completed',finalResponse:JSON.stringify(response)}, changedAreas });
}

async function preserveFocalProof(f, label, details, runnerRoot = null) {
  if (!process.env.STNL_U1_FOCAL_EVIDENCE_PARENT) return;
  const parent=await fs.realpath(process.env.STNL_U1_FOCAL_EVIDENCE_PARENT);
  const destination=await fs.mkdtemp(path.join(parent,label+'-'));
  await fs.cp(f.root,path.join(destination,'workspace'),{recursive:true,filter:source=>path.basename(source)!=='.git'});
  if(runnerRoot)await fs.cp(runnerRoot,path.join(destination,'captured-runner'),{recursive:true});
  await fs.writeFile(path.join(destination,'proof.json'),JSON.stringify({...details,originalWorkspace:f.root,originalRunnerRoot:runnerRoot},null,2)+'\n',{flag:'wx'});
  console.log('TEST-ONLY preserved focal proof: '+destination);
}

const formalResponse = (command, status = 'PASS') => ({ status, head:'offline-working-tree', commands:[{command,exit:0}],
  evidence:'Actual prepared greeting assertion with simulated independent semantic judgment.', findingReferences:'none',
  findingDispositions:'none', blockers:status === 'BLOCKED' ? 'Required review premise unavailable.' : 'none',
  unexpectedWorkspaceEffects:'none', persistenceSummary:'Preserve concluded offline result.' });

export async function implementOffline(f, admitted, { forceFail = false, slice = 'slice-01', directory = 'src', priorOverlap = '- none', additionalClaims = [], regressionFiles = [], beforeChecks = null } = {}) {
  const native = await startOfflineNative(f, admitted.owner);
  const copy = await prepareExecutionCopy({ specPath: f.specPath, slice, owner: admitted.owner });
  // New actual file was intentionally absent from Expected Files.
  await fs.writeFile(path.join(f.root, `${directory}/unpredicted.mjs`), 'export const greeting = '+JSON.stringify(forceFail ? 'wrong' : 'hello')+';\n');
  await fs.writeFile(path.join(f.root, `${directory}/greeting.test.mjs`), 'import test from "node:test"; import assert from "node:assert/strict"; import {greeting} from "./unpredicted.mjs"; test("AC-001 greeting",()=>assert.equal(greeting,"hello"));\n');
  if(beforeChecks) await beforeChecks();
  const checkedFiles=[`${directory}/greeting.test.mjs`,...regressionFiles];
  const command = verificationCommand(native.verification.checks[0]);
  const observed = spawnSync(process.execPath, ['--test', ...checkedFiles], { cwd: f.root, env: commandEnvironment, encoding: 'utf8' });
  assert.equal(observed.status, forceFail ? 1 : 0, observed.stderr);
  assert.match(observed.stdout,new RegExp(`^# tests ${checkedFiles.length}$`,'mu'));
  const claims = [`${directory}/greeting.test.mjs`, `${directory}/unpredicted.mjs`].map(p=>path.relative(path.join(f.workspace.executionRoot,'tasks'),path.join(f.root,p)).split(path.sep).join('/')).concat(additionalClaims).sort();
  let task = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  task = task.replace(`- [ ] ${BigInt(slice.slice(6))}.1`, `- [x] ${BigInt(slice.slice(6))}.1`);
  task = setSection(task, 'Changed Areas', claims.map(claim => `- \`${claim}\``).join('\n'));
  task = setSection(task,'Prior Validation Overlap',priorOverlap);
  task = setSection(task, 'Diff Summary', '- Implemented observable greeting and prepared assertion.');
  await fs.writeFile(copy.candidateTaskArtifact, task);
  const response = { status: 'TESTS_PASS', automaticCheckRound: '1/3', head: 'offline-working-tree', discoverySources: 'task Expected Tests and source test', discoveryActions: 'read declared prepared test', verificationTypesConsidered: 'behavior assertion', nonApplicabilityRationale: 'none', noVerificationCommandConfirmation: 'none', commands: [{ command, exit: observed.status }], resultOfEachCommandAndExitCode: 'Greeting assertion exit 0', selectedChecks: 'node test greeting', selectionRationale: 'Observe AC-001 value', coverage: 'Greeting export equals hello', failures: 'none', priorRoundFailure: 'none', correctionApplied: 'none', inSliceRationale: 'none', evidenceOrFailureSummary: 'Observed greeting equals hello', affectedFilesOrBehaviors: 'Greeting module and prepared test', blockers: 'none', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'Compact auxiliary evidence' };
  if (forceFail) Object.assign(response,{status:'TESTS_FAIL',failures:'Actual greeting assertion failed; expected hello and observed wrong.',evidenceOrFailureSummary:observed.stdout});
  const capture = await captureRunnerTestedState({ workspace: f.root, taskArtifact: path.join(f.workspace.executionRoot, `tasks/${slice}.md`), changedAreas: claims });
  assert.equal(capture.entries.length,claims.length);
  const captured = await captureOfflineNative(native, response, claims);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', response: JSON.stringify(response), workspace: f.root, taskArtifact: copy.candidateTaskArtifact, ...captured });
  await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', bundle,
    validateProspectiveTask: task => validateExecutionCandidate(f.specPath, copy.candidateExecutionRoot, [task], forceFail ? {privateAutomaticCheck:{operation:'EXECUTE_SLICE',slice,round:1}} : {}) });
  return { copy, capture, command, native, captured, response };
}

export async function runFirstRemoval({afterFormal=null}={}) {
  const f=await fixture();const previous=process.env.STNL_OPERATION_OWNER_FILE;
  try {
    const {computeRequirementsAuthority}=await import('../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs');
    await fs.writeFile(path.join(f.root,'src/obsolete.mjs'),'export const obsolete=true;\n');
    const old='sha256:'+await computeRequirementsAuthority(f.specPath);
    await fs.writeFile(f.specPath,'# Requirements\n\nAC-001: Remove src/obsolete.mjs. Verify file absence with node --test. Preserve authentication and persistence.\n');
    const authority='sha256:'+await computeRequirementsAuthority(f.specPath);
    for(const name of ['plan.md','tasks.md','plans/slice-01.md','tasks/slice-01.md']) {
      let text=(await fs.readFile(path.join(f.candidate,name),'utf8')).replaceAll(old,authority).replaceAll('Greeting','Removal').replaceAll('greeting','obsolete module removal').replaceAll('Export observed by a prepared node test.','Obsolete module absent, observed by prepared absence assertion.');
      if(name.startsWith('plans/')||name.startsWith('tasks/')) {
        text=setSection(text,'Expected Files','- `src/obsolete.mjs`\n- `src/removal.test.mjs`');
        text=setSection(text,'Existing Inputs','- `src/obsolete.mjs`');
        text=setSection(text,'Expected Tests','- node --test src/removal.test.mjs');
        text=setSection(text,'Verification Recipe',verificationBody({file:'src/removal.test.mjs'}));
      }
      if(name.startsWith('plans/')) {
        text=setSection(text,'Objective and Observable Result','Remove the obsolete module and observe file absence.');
        text=setSection(text,'Included Scope','Remove src/obsolete.mjs and add its absence assertion.');
        text=setSection(text,'Completion Criterion','AC-001 obsolete module absent and prepared test succeeds.');
      }
      if(name.startsWith('tasks/')) {
        text=setSection(text,'Result','Obsolete module absent, observed by prepared absence assertion.');
        text=setSection(text,'Acceptance Obligations','- obligation-01 | requirement: AC-001 | contribution: complete | full owner: slice-01 | condition: src/obsolete.mjs absent | proof: node --test src/removal.test.mjs asserts file absence');
        text=setSection(text,'Checklist','- [ ] 1.1 Remove inspected obsolete module and implement absence assertion | obligations: obligation-01');
      }
      await fs.writeFile(path.join(f.candidate,name),text);
    }
    const approved=await approveFixture(f);
    const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const native=await startOfflineNative(f,admitted.owner);
    const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
    const task=path.join(f.workspace.executionRoot,'tasks/slice-01.md');
    assert.match(await fs.readFile(task,'utf8'),/## Implementation Test Evidence\n\n- none/);
    const before=await captureRunnerTestedState({workspace:f.root,taskArtifact:task,changedAreas:['../../src/obsolete.mjs']});
    await fs.unlink(path.join(f.root,'src/obsolete.mjs'));
    await fs.writeFile(path.join(f.root,'src/removal.test.mjs'),'import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";test("AC-001 absence",()=>assert.equal(fs.existsSync("src/obsolete.mjs"),false));\n');
    const observed=spawnSync(process.execPath,['--test','src/removal.test.mjs'],{cwd:f.root,env:commandEnvironment,encoding:'utf8'});assert.equal(observed.status,0,observed.stderr);assert.match(observed.stdout,/^# tests 1$/mu);
    const claims=['../../src/obsolete.mjs','../../src/removal.test.mjs'];
    await assert.rejects(captureRunnerTestedState({workspace:f.root,taskArtifact:task,changedAreas:claims,removedProofs:[{path:before.entries[0].path,previousSha256:'sha256:'+'0'.repeat(64)}]}),/not proved removal/);
    const after=await captureRunnerTestedState({workspace:f.root,taskArtifact:task,changedAreas:claims,removedProofs:[{path:before.entries[0].path,previousSha256:before.entries[0].value}]});
    assert.equal(after.entries.find(entry=>entry.path.endsWith('/obsolete.mjs')).value,'REMOVED');
    await assert.rejects(captureRunnerTestedState({workspace:f.root,taskArtifact:task,changedAreas:['../../src/future.mjs']}),/not proved removal/);
    let text=await fs.readFile(copy.candidateTaskArtifact,'utf8');
    text=setSection(text.replace('- [ ] 1.1','- [x] 1.1'),'Changed Areas',claims.map(claim=>'- `'+claim+'`').join('\n'));
    text=setSection(text,'Diff Summary','- Removed actual inspected obsolete module and prepared passing absence assertion.');await fs.writeFile(copy.candidateTaskArtifact,text);
    // Reuse the fully shaped semantic execution fixture; only its semantic
    // values/command are replaced, while no historical check is synthesized.
    const schema=JSON.parse(await fs.readFile(new URL('../skills/workflows/stnl-slice-executor/runtime/runner-semantic-response.schema.json',import.meta.url)));
    const response=Object.fromEntries(schema.oneOf.find(branch=>branch.title==='EXECUTE_SLICE').required.map(key=>[key,'Real obsolete module removal with passing absence assertion']));
    Object.assign(response,{status:'TESTS_PASS',automaticCheckRound:'1/3',head:'offline-working-tree',commands:[{command:'node --test src/removal.test.mjs',exit:observed.status}],failures:'none',priorRoundFailure:'none',correctionApplied:'none',inSliceRationale:'none',blockers:'none',unexpectedWorkspaceEffects:'none'});
    const captured=await captureOfflineNative(native,response,claims);
    const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'EXECUTE_SLICE',response:JSON.stringify(response),workspace:f.root,taskArtifact:copy.candidateTaskArtifact,...captured});
    assert.match(bundle,/`\.\.\/\.\.\/src\/obsolete\.mjs` \| REMOVED/);
    await insertExecutionEvidenceInCandidate({taskArtifact:copy.candidateTaskArtifact,operation:'EXECUTE_SLICE',bundle,validateProspectiveTask:t=>validateExecutionCandidate(f.specPath,copy.candidateExecutionRoot,[t])});
    await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:copy.candidateRoot});
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt,null);
    assert.equal((await inspectExecutionState(f.specPath)).state,'IMPLEMENTED_AWAITING_VALIDATION');
    const completed=await readExecutionActivation(f.specPath);
    const validation=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',completed.activation.activationId);
    process.env.STNL_OPERATION_OWNER_FILE=await ownerEnvironment(f,validation.owner);
    const formal=await startOfflineNative(f,validation.owner);
    const testedAgain=spawnSync(process.execPath,['--test','src/removal.test.mjs'],{cwd:f.root,env:commandEnvironment,encoding:'utf8'});
    assert.equal(testedAgain.status,0,testedAgain.stderr);assert.match(testedAgain.stdout,/^# tests 1$/mu);
    const formalPayload=formalResponse('node --test src/removal.test.mjs');
    formalPayload.evidence='Actual absence assertion observed after terminal implementation; independent semantic review is simulated.';
    const formalCapture=await captureOfflineNative(formal,formalPayload);
    const parent=path.join(f.root,'removal-formal');await fs.mkdir(parent);
    const formalCopy=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:validation.owner});
    await prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,candidateExecutionRoot:formalCopy.candidateExecutionRoot,...formalCapture});
    await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:formalCopy.candidateExecutionRoot,owner:validation.owner});
    assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt,null);
    if(afterFormal) await afterFormal({f,before,after,formalCopy,formalCapture});
    await preserveFocalProof(f,'first-removal',{before,after,commandExit:observed.status,formalCommandExit:testedAgain.status,implementationCapture:captured,formalCapture,state:'COMPLETE'});

  } finally {if(previous===undefined)delete process.env.STNL_OPERATION_OWNER_FILE;else process.env.STNL_OPERATION_OWNER_FILE=previous;if(process.env.STNL_OFFLINE_KEEP_FIXTURES!=='1')await fs.rm(f.root,{recursive:true,force:true});}
}

// Current producer + real common-publisher barriers replace historical fs.watch
// windows. The independent writer remains alive during publication; IPC only
// acknowledges a completed mutation, never substitutes a runtime decision.
export async function runRepairDispute(kind) {
  assert.ok(['final-source-window', 'critical-section-entry', 'strict-readback', 'foreign-lock'].includes(kind));
  const f = await fixture();
  let writer;
  let settled;
  let retainedCandidate;
  const phases = [];
  let allocation;
  let fired = false;
  try {
    const { repairExecutionContract } = await import('../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs');
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const implementation = await implementOffline(f, admitted);
    await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot });
    const task = path.join(f.workspace.executionRoot, 'tasks/slice-01.md');
    const index = path.join(f.workspace.executionRoot, 'tasks.md');
    const clean = await fs.readFile(task, 'utf8');
    const corrupt = clean.replace('- Discovery sources:', '- Check discovery sources:').replace('- Discovery actions:', '- Check discovery actions:');
    assert.notEqual(corrupt, clean);
    await fs.writeFile(task, corrupt);
    // Every negative starts from the identical, actually exercised valid repair.
    const control = await repairExecutionContract(f.specPath);
    assert.equal(control.status, 'REPAIRED');
    assert.equal(control.publication, 'confirmed');
    assert.equal(control.cleanup, 'complete');
    assert.equal(await fs.readFile(task, 'utf8'), clean);
    assert.equal((await inspectExecutionState(f.specPath)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
    const activationBefore = (await readExecutionActivation(f.specPath)).activation;
    const receiptBefore = await fs.readFile(implementation.captured.receiptFile);
    await fs.writeFile(task, corrupt);
    const markerBefore = await fs.readFile(path.join(f.workspace.executionRoot, 'activation.json'));
    const originalIndex = await fs.readFile(index);
    const foreign = Buffer.from('CONCURRENT ' + kind + ' WRITER WON\n');
    const location = await executionLockIdentity(f.workspace);
    const writerFile = path.join(f.root, 'repair-dispute-writer.mjs');
    await fs.writeFile(writerFile, `import fs from 'node:fs/promises';
process.on('message', async message => {
  try {
    if(message.action==='stop') { process.disconnect(); return; }
    if(message.action==='replace-lock') await fs.rename(message.file,message.displaced);
    await fs.writeFile(message.file,Buffer.from(message.bytes,'base64'),message.action==='replace-lock'?{flag:'wx'}:{});
    process.send({phase:'mutated',pid:process.pid});
  } catch(error) { process.send({phase:'error',error:error.message}); }
});
process.send({phase:'ready',pid:process.pid});
`);
    writer = fork(writerFile, [], { env: commandEnvironment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    settled = new Promise(resolve => writer.once('exit', (code, signal) => resolve({ code, signal })));
    const message = expected => new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); writer.off('message', receive); writer.off('error', fail); writer.off('exit', exit);
        if (error) reject(error); else resolve(value);
      };
      const receive = value => value.phase === expected ? finish(null, value) : finish(new Error('unexpected writer message: ' + JSON.stringify(value)));
      const fail = error => finish(error);
      const exit = (code, signal) => finish(new Error('writer exited before barrier: ' + code + '/' + signal));
      const timer = setTimeout(() => finish(new Error('writer IPC barrier timed out')), 5_000);
      writer.on('message', receive); writer.once('error', fail); writer.once('exit', exit);
    });
    const ready = await message('ready');
    assert.notEqual(ready.pid, process.pid);
    const point = kind === 'strict-readback' ? 'after-activation' : 'before-backup';
    let failure;
    try {
      await repairExecutionContract(f.specPath, { checkpoint: async (phase, paths) => {
        phases.push(phase);
        if (phase !== point) return;
        assert.equal(fired, false);
        allocation = paths;
        const lease = JSON.parse(await fs.readFile(location.lockPath, 'utf8'));
        assert.equal(lease.executionRoot, f.workspace.executionRoot);
        assert.equal(lease.pid, process.pid);
        const mutated = message('mutated');
        const file = kind === 'critical-section-entry' ? f.specPath : kind === 'strict-readback' ? index : kind === 'foreign-lock' ? location.lockPath : task;
        const bytes = kind === 'critical-section-entry' ? Buffer.concat([await fs.readFile(f.specPath), foreign]) : kind === 'final-source-window' ? Buffer.concat([Buffer.from(corrupt), foreign]) : foreign;
        writer.send({ action: kind === 'foreign-lock' ? 'replace-lock' : 'write', file, displaced: location.lockPath + '.displaced-by-test', bytes: bytes.toString('base64') });
        const observation = await mutated;
        assert.equal(observation.pid, ready.pid);
        assert.deepEqual(await fs.readFile(file), bytes);
        fired = true;
      } });
      assert.fail('concurrent repair must reject: ' + kind);
    } catch (error) {
      failure = error;
      retainedCandidate = error.repairCandidate;
    }
    assert.equal(fired, true, 'negative must reach and fire its current publisher barrier');
    assert.ok(retainedCandidate, failure.message);
    assert.ok((await fs.stat(retainedCandidate)).isDirectory());
    if (kind === 'strict-readback') {
      assert.match(failure.message, /preparation contract: tasks\.md contains hidden or unknown carriers; activation outcome uncertain/u);
      assert.ok(phases.includes('after-activation'));
      assert.equal(await fs.readFile(task, 'utf8'), clean, 'unconfirmed installed repair is retained');
      assert.deepEqual(await fs.readFile(index), foreign, 'foreign readback bytes are never compensated over');
      assert.equal(await fs.readFile(path.join(allocation.backup, 'tasks/slice-01.md'), 'utf8'), corrupt);
      assert.deepEqual(await fs.readFile(path.join(allocation.backup, 'tasks.md')), originalIndex);
      assert.notDeepEqual(await fs.readFile(path.join(f.workspace.executionRoot, 'activation.json')), markerBefore);
      await assert.rejects(readExecutionActivation(f.specPath), /preparation contract: tasks\.md contains hidden or unknown carriers/u);
    } else {
      assert.deepEqual(phases, ['before-backup'], 'no swap or activation follows the disputed prepublication recheck');
      assert.deepEqual(await fs.readFile(path.join(f.workspace.executionRoot, 'activation.json')), markerBefore);
      assert.deepEqual(await fs.readFile(index), originalIndex);
      if (kind === 'final-source-window') {
        assert.match(failure.message, /source\/base changed/u);
        assert.equal(await fs.readFile(task, 'utf8'), corrupt + foreign.toString('utf8'));
      } else if (kind === 'critical-section-entry') {
        assert.match(failure.message, /requirements\/base changed/u);
        assert.equal(await fs.readFile(task, 'utf8'), corrupt);
        assert.ok((await fs.readFile(f.specPath)).subarray(-foreign.length).equals(foreign));
      } else {
        assert.match(failure.message, /lock ownership.*changed/u);
        assert.equal(await fs.readFile(task, 'utf8'), corrupt);
        assert.deepEqual(await fs.readFile(location.lockPath), foreign);
        const displaced = await fs.stat(location.lockPath + '.displaced-by-test');
        const replacement = await fs.stat(location.lockPath);
        assert.notDeepEqual([replacement.dev, replacement.ino], [displaced.dev, displaced.ino]);
        await assert.rejects(acquireExecutionPublicationLock(f.workspace), /lock already exists/);
        assert.deepEqual(await fs.readFile(location.lockPath), foreign, 'no takeover of the replaced physical lease');
      }
    }
    assert.deepEqual(await fs.readFile(implementation.captured.receiptFile), receiptBefore, 'repair never repeats or rewrites the concluded runner receipt');
    assert.equal((await fs.stat(implementation.captured.receiptFile)).isFile(), true);
    await preserveFocalProof(f, 'repair-dispute-' + kind, {
      kind, control, phases, fired, writerPid: ready.pid, ownerPid: process.pid,
      failure: { message: failure.message, code: failure.code, repairCandidate: retainedCandidate },
      allocation, activationBefore, retainedCandidateTree: await captureExecutionTree(retainedCandidate),
      officialTree: await captureExecutionTree(f.workspace.executionRoot),
      receiptPath: implementation.captured.receiptFile, receiptBytes: receiptBefore.toString('base64'),
      watchCount: 0, payloadBytes: foreign.length,
    });
  } finally {
    if (writer) {
      if (writer.connected) writer.send({ action: 'stop' });
      const timer = setTimeout(() => writer.kill('SIGTERM'), 1_000);
      const result = await settled;
      clearTimeout(timer);
      assert.equal(result.code, 0, 'writer must settle normally');
    }
    if (retainedCandidate) await fs.rm(path.dirname(retainedCandidate), { recursive: true, force: true });
    await fs.rm(f.root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
test('same owner operational delta -> evidence -> confirmed terminal -> next begin and formal PASS', async () => {
  const f = await fixture(); const previousOwnerFile = process.env.STNL_OPERATION_OWNER_FILE;
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const intermediate = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-01', owner: admitted.owner });
    await updateOperationalChecklist({ candidateExecutionRoot: intermediate.candidateExecutionRoot, slice: 'slice-01', reason: 'Use a prepared export assertion as the concrete technical step.', checklist: '- [ ] 1.1 Implement greeting with its prepared assertion | obligations: obligation-01' });
    const update = await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: intermediate.candidateRoot, terminal: false });
    assert.notEqual(update.expectedActivationId, admitted.expectedActivationId);
    const advanced = await readExecutionActivation(f.specPath);
    assert.equal(advanced.activation.activeAttempt.operationAttemptId, admitted.owner.operationAttemptId);
    assert.equal(advanced.activation.activeAttempt.originActivationId, approved.activation.activationId);
    assert.equal(advanced.activation.normativeSha256, approved.activation.normativeSha256);
    assert.equal(advanced.activation.approvedSnapshotSha256, approved.activation.approvedSnapshotSha256);
    const implementation = await implementOffline(f, admitted);
    const completed = await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot });
    assert.equal(completed.publication, 'confirmed');
    const after = await readExecutionActivation(f.specPath);
    assert.equal(after.activation.activeAttempt, null);
    assert.equal(after.activation.lastAttempt.operationAttemptId, admitted.owner.operationAttemptId);
    assert.equal((await inspectExecutionState(f.specPath)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
    const validation = await beginPreparedExecutionOperation(f.specPath, 'VALIDATE_SLICE', '1', after.activation.activationId);
    process.env.STNL_OPERATION_OWNER_FILE = await ownerEnvironment(f, validation.owner);
    const native = await startOfflineNative(f, validation.owner);
    const candidateParent = path.join(f.root, 'validation-candidates'); await fs.mkdir(candidateParent);
    const candidate = await prepareValidationCopy({ specPath: f.specPath, slice: 'slice-01', candidateParent, owner: validation.owner });
    const response = { status: 'PASS', head: 'offline-working-tree', commands: [{ command: implementation.command, exit: 0 }], evidence: 'Offline formal fixture observes greeting export, scope and preserved responsibilities.', findingReferences: 'none', findingDispositions: 'none', blockers: 'none', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'Formal offline assertion evidence' };
    const captured = await captureOfflineNative(native, response);
    await prepareValidationCandidate({ specPath: f.specPath, slice: 'slice-01', workspace: f.root, candidateExecutionRoot: candidate.candidateExecutionRoot, ...captured });
    const published = await publishValidationCandidate({ specPath: f.specPath, slice: 'slice-01', candidateExecutionRoot: candidate.candidateExecutionRoot, owner: validation.owner });
    assert.equal(published.publication, 'confirmed');
    assert.equal((await inspectExecutionState(f.specPath)).state, 'COMPLETE');
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt, null);
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', after.activation.activationId));
    await fs.writeFile(path.join(f.root, 'src/unpredicted.mjs'), 'export const greeting="changed";\n');
    const drifted=await inspectExecutionState(f.specPath);
    assert.equal(drifted.state,'IMPLEMENTED_AWAITING_VALIDATION');
    assert.equal(drifted.tasks.get('slice-01').validation.validity,'revalidation-required');
    assert.equal(drifted.tasks.get('slice-01').attempts.at(-1).status,'PASS');
  } finally {
    if (previousOwnerFile === undefined) delete process.env.STNL_OPERATION_OWNER_FILE; else process.env.STNL_OPERATION_OWNER_FILE = previousOwnerFile;
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('writer CAS rejects same-base second proposal and wrong owner without altering live', async () => {
  const f = await fixture();
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const left = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-01', owner: admitted.owner });
    const right = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-01', owner: admitted.owner });
    for (const copy of [left, right]) await updateOperationalChecklist({ candidateExecutionRoot: copy.candidateExecutionRoot, slice: 'slice-01', reason: 'Use the prepared check in this technical step.', checklist: '- [ ] 1.1 Implement and inspect prepared assertion | obligations: obligation-01' });
    await assert.rejects(publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: left.candidateRoot, owner: { ...admitted.owner, ownershipToken: 'foreign' }, terminal: false }), /owner differs/);
    await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: left.candidateRoot, terminal: false });
    const image = await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: right.candidateRoot, terminal: false }), /changed|CAS/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), image);
    assert.ok(await fs.stat(right.candidateRoot));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('before activation failures restore exact base; failed restore retains owned backup', async () => {
  for (const point of ['before-backup', 'after-backup', 'after-install', 'before-activation']) {
    const f = await fixture();
    try {
      const approved = await approveFixture(f);
      const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
      const implementation = await implementOffline(f, admitted);
      const base = await captureExecutionTree(f.workspace.executionRoot);
      await assert.rejects(publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot,
        checkpoint: async phase => { if (phase === point) throw new Error('injected ' + phase); } }), /injected/);
      assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), base, point);
      assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt.operationAttemptId, admitted.owner.operationAttemptId);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
  const f = await fixture();
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const implementation = await implementOffline(f, admitted);
    let failure;
    try { await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot,
      checkpoint: async phase => { if (['after-backup', 'before-restore'].includes(phase)) throw new Error('injected ' + phase); } }); }
    catch (error) { failure = error; }
    assert.match(failure.message, /restore failed/);
    const allocation = parseStrictJson(await fs.readFile(failure.allocation, 'utf8'));
    assert.ok(await fs.stat(allocation.backup));
    assert.ok(await fs.stat(allocation.stage));
    await assert.rejects(readExecutionActivation(f.specPath), /absent|unavailable|ENOENT/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('after activation interruption preserves owner; confirmed cleanup failure does not rollback/reopen', async () => {
  const f = await fixture();
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const implementation = await implementOffline(f, admitted);
    await assert.rejects(publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot,
      checkpoint: async phase => { if (phase === 'after-activation') throw new Error('readback interrupted'); } }), /uncertain/);
    const uncertain = await readExecutionActivation(f.specPath);
    assert.equal(uncertain.activation.activeAttempt.operationAttemptId, admitted.owner.operationAttemptId);
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'VALIDATE_SLICE', '1', uncertain.activation.activationId), /owns|active/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  const g = await fixture();
  try {
    const approved = await approveFixture(g);
    const admitted = await beginPreparedExecutionOperation(g.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const implementation = await implementOffline(g, admitted);
    const result = await publishExecutionCopy({ specPath: g.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot,
      checkpoint: async phase => { if (phase === 'cleanup') throw new Error('cleanup denied'); } });
    assert.equal(result.publication, 'confirmed'); assert.equal(result.cleanup, 'pending');
    assert.ok(await fs.stat(result.retainedBackup));
    assert.equal((await readExecutionActivation(g.specPath)).activation.activeAttempt, null);
    assert.equal((await inspectExecutionState(g.specPath)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  } finally { await fs.rm(g.root, { recursive: true, force: true }); }
});

test('exclusive lock in separate processes/barrier; no age stealing or foreign release', async () => {
  const f = await fixture();
  try {
    const moduleUrl = pathToFileURL(path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs')).href;
    const childFile = path.join(f.root, 'lock-child.mjs');
    await fs.writeFile(childFile, `import { acquireExecutionPublicationLock, releaseExecutionPublicationLock } from ${JSON.stringify(moduleUrl)};
const lease = await acquireExecutionPublicationLock(JSON.parse(process.argv[2])); process.send({ locked: true });
process.on('message', async message => { if (message === 'release') { await releaseExecutionPublicationLock(lease); process.send({ released: true }); process.exit(0); } });`);
    const child = fork(childFile, [JSON.stringify(f.workspace)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const message = () => new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    assert.deepEqual(await message(), { locked: true });
    const location = await executionLockIdentity(f.workspace);
    const before = await fs.readFile(location.lockPath);
    await assert.rejects(acquireExecutionPublicationLock(f.workspace), /already exists/);
    assert.ok((await fs.readFile(location.lockPath)).equals(before));
    const released = message(); child.send('release'); assert.deepEqual(await released, { released: true });
    const lease = await acquireExecutionPublicationLock(f.workspace);
    await fs.writeFile(lease.lockPath, 'foreign old malformed lock');
    await assert.rejects(releaseExecutionPublicationLock(lease), /ownership/);
    await assert.rejects(acquireExecutionPublicationLock(f.workspace), /already exists/);
    assert.equal(await fs.readFile(location.lockPath, 'utf8'), 'foreign old malformed lock');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('resolver A/artifacts/B rejects a genuine concurrent admission; stale begin has no write', async () => {
  const f = await fixture();
  try {
    const approved = await approveFixture(f);
    const { readActivatedExecution } = await import('../skills/workflows/stnl-execution-planner/runtime/execution-publication.mjs');
    const { preparationAuthorityAt, computeRequirementsAuthority } = await import('../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs');
    const { validateApprovedPreparation, parseStrictJson } = await import('../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs');
    let began;
    await assert.rejects(readActivatedExecution({ executionRoot: f.workspace.executionRoot,
      requirementsAuthority: `sha256:${await computeRequirementsAuthority(f.specPath)}`, projectAuthority: preparationAuthorityAt,
      validateSnapshot: validateApprovedPreparation, parseJson: parseStrictJson,
      readCheckpoint: async phase => { if (phase === 'artifacts') began = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId); } }), /changed during resolution/);
    const tree = await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId), /activation|CAS/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), tree);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt.operationAttemptId, began.owner.operationAttemptId);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('normative changes, fake input/removal and live serializer writes fail closed', async () => {
  const f = await fixture();
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const copy = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-01', owner: admitted.owner });
    const tree = await captureExecutionTree(f.workspace.executionRoot);
    let task = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
    await fs.writeFile(copy.candidateTaskArtifact, task.replace('Greeting equals hello', 'Greeting equals another value'));
    await assert.rejects(publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: copy.candidateRoot, terminal: false }), /authority|preparation/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), tree);
    await fs.writeFile(copy.candidateTaskArtifact, task);
    await assert.rejects(captureRunnerTestedState({ workspace: f.root, taskArtifact: path.join(f.workspace.executionRoot, 'tasks/slice-01.md'), changedAreas: ['../../src/future.mjs'] }), /not proved removal/);
    await assert.rejects(updateOperationalChecklist({ candidateExecutionRoot: f.workspace.executionRoot, slice: 'slice-01', reason: 'Unsafe live attempt', checklist: '- [ ] 1.1 Change direct live checklist | obligations: obligation-01' }), /isolated|live/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), tree);
    const { serializeExecutionScopeClaims } = await import('../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs');
    await assert.rejects(serializeExecutionScopeClaims({ workspace: f.root, taskArtifact: path.join(f.workspace.executionRoot, 'tasks/slice-01.md') }), /isolated candidate/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), tree);
    await fs.mkdir(path.join(copy.candidateExecutionRoot, 'unknown-empty'));
    await assert.rejects(publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: copy.candidateRoot, terminal: false }));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('first PLAN and real lifecycle writer serialize while execution is absent, and stale lifecycle cannot erase PLAN', async () => {
  const { buildResumeFixture } = await import('../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs');
  const { renderOfflineArtifacts } = await import('./fixtures/offline-workflow-artifacts.mjs');
  const { preparePreparationCandidate } = await import('../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs');
  const { publishPreparationCandidate } = await import('../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs');
  const publisherUrl = new URL('../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs', import.meta.url).href;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-u1-lifecycle-')));
  let child;
  try {
    await fs.mkdir(path.join(root, '.git')); await fs.mkdir(path.join(root, 'src'));
    const {target, candidate, manifest} = await buildResumeFixture(root);
    const prepared = await preparePreparationCandidate({specPath: target, operation: 'PLAN'});
    await renderOfflineArtifacts({snapshot: fileURLToPath(new URL('../', import.meta.url)), workspace: root, specPath: target,
      candidateExecutionRoot: prepared.candidateExecutionRoot, targetPaths: ['src/greeting.mjs']});
    const code = `import {publishCandidate} from ${JSON.stringify(publisherUrl)};
      try { await publishCandidate('RESUME', ${JSON.stringify(target)}, ${JSON.stringify(candidate)}, {manifestPath:${JSON.stringify(manifest)},
        beforePublish: async () => { process.send('locked'); await new Promise(resolve => process.once('message', resolve)); }});
        process.send('published'); } catch(error) { process.send({error:error.message}); process.exitCode=1; } process.disconnect();`;
    child = spawn(process.execPath, ['--input-type=module','-e',code], {stdio:['ignore','pipe','pipe','ipc']});
    let errors=''; child.stderr.on('data', bytes => errors += bytes);
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    assert.equal(await new Promise(resolve => child.once('message', resolve)), 'locked');
    await assert.rejects(publishPreparationCandidate({specPath:target,candidateExecutionRoot:prepared.candidateExecutionRoot}), /lock|owned/);
    assert.equal(await fs.stat(path.join(target,'execution')).catch(()=>null), null);
    const publication = new Promise(resolve => child.once('message',resolve)); child.send('release');
    assert.equal(await publication, 'published'); assert.equal(await exited, 0, errors);
    await publishPreparationCandidate({specPath:target,candidateExecutionRoot:prepared.candidateExecutionRoot});
    const image = await captureExecutionTree(path.join(target,'execution'));
    const { publishCandidate } = await import(publisherUrl);
    // A second source snapshot is current, but the old candidate has no execution tree.
    const { writeResumeManifest } = await import('../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs');
    await writeResumeManifest(manifest,target);
    await assert.rejects(publishCandidate('RESUME',target,candidate,{manifestPath:manifest}), /does not preserve execution/);
    assert.deepEqual(await captureExecutionTree(path.join(target,'execution')), image);
    const review = await preparePreparationCandidate({specPath:target,operation:'REVIEW_PLAN'});
    const {readPreparationArtifacts} = await import('../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs');
    const {reviewDecision} = await import('./test-p1b-preparation.mjs');
    for (const [name,text] of await readPreparationArtifacts(review.candidateExecutionRoot)) await fs.writeFile(path.join(review.candidateExecutionRoot,name),text.replace('status: draft','status: ready').replace('Review state: pending','Review state: approved'));
    const approved = await publishPreparationCandidate({specPath:target,candidateExecutionRoot:review.candidateExecutionRoot,reviewDecision:{...reviewDecision,summary:'Offline lifecycle fixture checks the declared serial preparation and preserves current documentary requirements; this simulated review is not independent model judgment.'}});
    const active = await beginPreparedExecutionOperation(target,'EXECUTE_SLICE','1',approved.expectedActivationId);
    let lifecycleEffects=0;
    await assert.rejects(publishCandidate('RESUME',target,candidate,{manifestPath:manifest,beforePublish:async()=>{lifecycleEffects+=1;}}),/active|uncertain/);
    const {recoverIncompletePublication} = await import(publisherUrl);
    await assert.rejects(recoverIncompletePublication(target),/active|uncertain/);
    assert.equal(lifecycleEffects,0);
    assert.equal((await readExecutionActivation(target)).activation.activeAttempt.operationAttemptId,active.owner.operationAttemptId);
  } finally { if(child?.exitCode===null) {child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve));} await fs.rm(root,{recursive:true,force:true}); }
});

test('joint approved execution candidate rejects changes to protected authority with its valid owner intact', async (t) => {
  for (const [name, artifact, mutate, diagnostic] of [
    ['approved global objective', 'plan.md', text => text.replace('Deliver a deterministic greeting.', 'Approve a different objective.'), /outside selected operational delivery/],
    ['approved detailed scope', 'plans/slice-01.md', text => text.replace('Create the greeting and its prepared check.', 'Change authentication instead.'), /execution changed protected detailed Plan/],
    ['approved task responsibility', 'tasks/slice-01.md', text => text.replace('No authentication or persistence changes.', 'Authentication writes authorized.'), /operational update changed preparation authority/],
    ['approved task revision', 'tasks/slice-01.md', text => text.replace('Plan revision: 1', 'Plan revision: 2'), /authority pair differs/],
    ['approved task authority', 'tasks/slice-01.md', text => text.replace(/sha256:[a-f0-9]{64}/u, 'sha256:' + 'f'.repeat(64)), /authority pair differs/],
  ]) await t.test(name, async child => {
    const positive = await unpublishedImplementationFixture(child);
    assert.equal((await publishExecutionCopy({ specPath: positive.f.specPath, slice: 'slice-01', candidateRoot: positive.implementation.copy.candidateRoot })).state, 'IMPLEMENTED_AWAITING_VALIDATION', 'positive in the same publisher with real observed check and receipt');
    const { f, implementation, admission } = await unpublishedImplementationFixture(child), copy = implementation.copy;
    const consume = () => publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: copy.candidateRoot });
    await editPreparation(copy.candidateExecutionRoot, artifact, mutate);
    const live = await captureExecutionTree(f.workspace.executionRoot), candidate = await captureExecutionTree(copy.candidateExecutionRoot);
    const receipt = await fs.readFile(implementation.captured.receiptFile);
    await assert.rejects(consume(), diagnostic);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
    assert.deepEqual(await captureExecutionTree(copy.candidateExecutionRoot), candidate);
    assert.deepEqual(await fs.readFile(implementation.captured.receiptFile), receipt);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt.operationAttemptId, admission.owner.operationAttemptId);
  });
});

test('joint preparation publisher cannot turn officially implemented history into a pristine replacement', async (t) => {
  const positive = await implementedAppendFixture(t);
  await publishFixtureCandidate(positive.f, positive.candidate);
  assert.equal((await inspectExecutionState(positive.f.specPath)).state, 'PENDING_REPLAN_DRAFT');
  const { f, implementation } = await implementedAppendFixture(t);
  const candidate = await prepareFixtureCandidate(f, 'REPLAN', { revisionMode: 'pristine-replacement' });
  await editPreparation(candidate, 'plan.md', text => text.replace('- Review state: approved', '- Review state: approved\n- Replan reason: Attempt to erase actually implemented delivery history.'));
  await editPreparation(candidate, 'plan.md', text => setPreparationSection(text, 'Delivery Continuity', '- runtime'));
  await normalizePreparation(f, candidate);
  const live = await captureExecutionTree(f.workspace.executionRoot), image = await captureExecutionTree(candidate);
  const receipt = await fs.readFile(implementation.captured.receiptFile);
  await assert.rejects(publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: candidate }), /historical REPLAN requires next append-only revision/);
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
  assert.deepEqual(await captureExecutionTree(candidate), image);
  assert.deepEqual(await fs.readFile(implementation.captured.receiptFile), receipt);
});

test('joint append draft validator reaches mapping, revision, owner and continuity guards with preserved bytes', async (t) => {
  const cases = [
    ['missing replan reason', 'plan.md', text => text.replace(/^- Replan reason: .*\n/mu, ''), /Replan reason/],
    ['placeholder replan reason', 'plan.md', text => text.replace(/^- Replan reason: .+$/mu, '- Replan reason: pending'), /Replan reason must be objective/],
    ['revision skips predecessor', 'plan.md', text => text.replace('Plan revision: 2', 'Plan revision: 3'), /joint append-only draft lacks preserved history/],
    ['nonlater supersession target', 'plan.md', text => text.replace('slice-01 -> slice-02', 'slice-01 -> slice-01'), /invalid joint supersession mapping/],
    ['missing open delivery mapping', 'plan.md', text => text.replace('slice-01 -> slice-02', 'none'), /map every prior open delivery/],
    ['unknown mapping source', 'plan.md', text => text.replace('slice-01 -> slice-02', 'slice-99 -> slice-02'), /invalid joint supersession mapping/],
    ['wrong integral owner', 'tasks/slice-02.md', text => text.replace('full owner: slice-02', 'full owner: slice-01'), /claims another full owner/],
    ['wrong replacement authority', 'tasks/slice-02.md', text => text.replace(/sha256:[a-f0-9]{64}/u, 'sha256:' + 'f'.repeat(64)), /authority pair differs/],
    ['task index dependency differs', 'tasks.md', text => text.replace('| 01 | tasks/slice-02.md', '| - | tasks/slice-02.md'), /Tasks index differs from Plan delivery\/dependency\/order/],
  ];
  for (const [name, artifact, mutate, diagnostic] of cases) await t.test(name, async child => {
    const { f, candidate, implementation } = await implementedAppendFixture(child);
    await publishFixtureCandidate(f, candidate);
    const review = await prepareFixtureCandidate(f, 'REVIEW_PLAN');
    const consume = () => validateExecutionCandidate(f.specPath, review);
    assert.equal((await consume()).state, 'PENDING_REPLAN_DRAFT', 'valid draft in the same candidate validator');
    await editPreparation(review, artifact, mutate);
    if (name === 'revision skips predecessor') for (const file of ['plans/slice-02.md', 'tasks/slice-02.md']) await editPreparation(review, file, text => text.replace('Plan revision: 2', 'Plan revision: 3'));
    const live = await captureExecutionTree(f.workspace.executionRoot), image = await captureExecutionTree(review);
    const receipt = await fs.readFile(implementation.captured.receiptFile);
    await assert.rejects(consume(), diagnostic);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
    assert.deepEqual(await captureExecutionTree(review), image);
    assert.deepEqual(await fs.readFile(implementation.captured.receiptFile), receipt);
  });
});

test('joint append publisher rejects historical rewrites after an equivalent official positive publication', async (t) => {
  for (const [name, artifact, mutate, diagnostic] of [
    ['changed historical checklist', 'tasks/slice-01.md', text => text.replace('Implement greeting and prepared test', 'Replace historical action'), /historical artifact changed: tasks\/slice-01.md/],
    ['changed historical path', 'tasks/slice-01.md', text => text.replaceAll('../../src/unpredicted.mjs', '../../src/other.mjs'), /historical artifact changed: tasks\/slice-01.md/],
    ['changed historical check evidence', 'tasks/slice-01.md', text => text.replace('- Coverage: Greeting export equals hello', '- Coverage: Different historical coverage'), /historical artifact changed: tasks\/slice-01.md/],
    ['changed historical detailed plan', 'plans/slice-01.md', text => text.replace('Export observed by node --test.', 'Different historical scope.'), /historical artifact changed: plans\/slice-01.md/],
    ['removed historical task', 'tasks/slice-01.md', null, /ENOENT/],
  ]) await t.test(name, async child => {
    const positive = await implementedAppendFixture(child);
    const old = await readPreparationArtifacts(positive.f.workspace.executionRoot);
    const positiveReceipt = await fs.readFile(positive.implementation.captured.receiptFile);
    await publishFixtureCandidate(positive.f, positive.candidate);
    assert.equal((await inspectExecutionState(positive.f.specPath)).state, 'PENDING_REPLAN_DRAFT');
    assert.equal(await fs.readFile(path.join(positive.f.workspace.executionRoot, 'plans/slice-01.md'), 'utf8'), old.get('plans/slice-01.md'));
    const retained = parseStrictJson(await fs.readFile(path.join(positive.f.workspace.executionRoot, 'continuity.json'), 'utf8')).deliveries[0].history.at(-1);
    assert.equal(await fs.readFile(path.resolve(positive.f.workspace.executionRoot, retained.taskRef.path), 'utf8'), old.get('tasks/slice-01.md'), 'archived predecessor is byte-exact, including its old derived continuity summary');
    const taskNow = (await inspectExecutionState(positive.f.specPath)).tasks.get('slice-01');
    assert.equal(taskNow.sections.get('Implementation Test Evidence'), old.get('tasks/slice-01.md').split('## Implementation Test Evidence\n\n')[1].split('## Findings Test Evidence')[0].trim(), 'the current consumer expands the retained check without rewriting its bytes');
    assert.deepEqual(await fs.readFile(positive.implementation.captured.receiptFile), positiveReceipt);
    const { f, candidate, implementation } = await implementedAppendFixture(child);
    if (mutate) await editPreparation(candidate, artifact, mutate);
    else await fs.unlink(path.join(candidate, artifact));
    const live = await captureExecutionTree(f.workspace.executionRoot), image = await captureExecutionTree(candidate);
    const receipt = await fs.readFile(implementation.captured.receiptFile);
    await assert.rejects(publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: candidate }), diagnostic);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
    assert.deepEqual(await captureExecutionTree(candidate), image);
    assert.deepEqual(await fs.readFile(implementation.captured.receiptFile), receipt);
  });
});

test('joint repeated append preserves prior committing revisions, receipts and exact current supersession mappings', async (t) => {
  const { f, implementation: first, candidate } = await implementedAppendFixture(t);
  const firstReceipt = await fs.readFile(first.captured.receiptFile);
  await publishFixtureCandidate(f, candidate);
  const reviewed = await reviewFixtureCandidate(f, await prepareFixtureCandidate(f, 'REVIEW_PLAN'));
  const secondOwner = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '2', reviewed.expectedActivationId);
  const second = await implementOffline(f, secondOwner, { slice: 'slice-02' });
  retainPreparation(f, second.copy.candidateRoot);
  await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-02', candidateRoot: second.copy.candidateRoot });
  const secondReceipt = await fs.readFile(second.captured.receiptFile);
  const older = (await inspectExecutionState(f.specPath)).tasks.get('slice-01');
  assert.equal(older.final.planRevision, 2);
  const oldSnapshot = await fs.readFile(path.join(f.workspace.executionRoot, 'approved-preparation.json'));
  const third = await appendFixtureCandidate(f, { source: 'slice-02', target: 'slice-03' });
  const draft = await publishFixtureCandidate(f, third);
  assert.deepEqual(await fs.readFile(path.join(draft.retainedBackup, 'approved-preparation.json')), oldSnapshot);
  const approved = await reviewFixtureCandidate(f, await prepareFixtureCandidate(f, 'REVIEW_PLAN'));
  const current = await inspectExecutionState(f.specPath);
  assert.equal(current.tasks.get('slice-01').final.planRevision, 2);
  assert.equal(current.tasks.get('slice-02').final.planRevision, 3);
  assert.equal(current.tasks.get('slice-01').sections.get('Implementation Test Evidence'), older.sections.get('Implementation Test Evidence'));
  assert.equal(current.normalHandoff.operation, 'EXECUTE_SLICE');
  assert.equal(current.normalHandoff.slice, 'slice-03');
  assert.equal((await preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '3')).state, current.state);
  const owner = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '3', approved.expectedActivationId);
  const copy = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-03', owner: owner.owner });
  retainPreparation(f, copy.candidateRoot);
  const consume = () => validateExecutionCandidate(f.specPath, copy.candidateExecutionRoot);
  assert.equal((await consume()).state, (await inspectExecutionState(f.specPath)).state, 'positive committed mapping in the same candidate validator');
  await editPreparation(copy.candidateExecutionRoot, 'plan.md', text => text.replace('slice-02 -> slice-03', 'none'));
  const live = await captureExecutionTree(f.workspace.executionRoot), image = await captureExecutionTree(copy.candidateExecutionRoot);
  await assert.rejects(consume(), /current-revision committed supersessions do not exactly match the global mappings/);
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
  assert.deepEqual(await captureExecutionTree(copy.candidateExecutionRoot), image);
  assert.deepEqual(await fs.readFile(first.captured.receiptFile), firstReceipt);
  assert.deepEqual(await fs.readFile(second.captured.receiptFile), secondReceipt);
});

test('joint historical REPLAN preserves evidence and snapshot backups, then reviewed supersession admits only the appended delivery', async () => {
  const f = await fixture();
  const { preparePreparationCandidate } = await import('../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs');
  const { publishPreparationCandidate } = await import('../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs');
  const { readPreparationArtifacts } = await import('../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs');
  const { reviewDecision } = await import('./test-p1b-preparation.mjs');
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const implementation = await implementOffline(f, admitted);
    await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot});
    const old = await readPreparationArtifacts(f.workspace.executionRoot);
    const priorSnapshot = await fs.readFile(path.join(f.workspace.executionRoot,'approved-preparation.json'));
    const replanned = await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN'});
    const root = replanned.candidateExecutionRoot;
    for (const type of ['plans','tasks']) {
      let text = old.get(`${type}/slice-01.md`);
      text = text.replace(/^- Delivery ID: .*\n/mu,'').replace('- Slice: 01','- Slice: 02').replace('Slice 01','Slice 02').replace('Plan revision: 1','Plan revision: 2').replace('status: ready','status: draft').replace('Review state: approved','Review state: pending');
      if (type==='tasks') {
        const pristine = await fs.readFile(path.join(f.candidate,'tasks/slice-01.md'),'utf8');
        text = pristine.replace(/^- Delivery ID: .*\n/mu,'').replace('- Slice: 01','- Slice: 02').replace('Slice 01','Slice 02').replace('../plans/slice-01.md','../plans/slice-02.md').replace('full owner: slice-01','full owner: slice-02').replace('Plan revision: 1','Plan revision: 2').replace(/- History source: .+/, '- History source: runtime');
      }
      await fs.writeFile(path.join(root,type,'slice-02.md'),text);
    }
    let global = old.get('plan.md').replace('Plan revision: 1','Plan revision: 2').replace('status: ready','status: draft').replace('Review state: approved','Review state: pending');
    global = global.replace('- Review state: pending', '- Review state: pending\n- Replan reason: Recovery delivery for the same acceptance after implementation.\n- Revision mode: append-only-extension\n- Supersedes open slices: slice-01 -> slice-02');
    const globalRow = global.split('\n').find(line=>line.startsWith('| 01 -'));
    global = global.replace(globalRow, globalRow + '\n' + globalRow.replace('01 - Greeting','02 - Recovery').replace('plans/slice-01.md','plans/slice-02.md').replace('| - | AC-001','| 01 | AC-001'));
    global=setSection(global,'Delivery Continuity',old.get('plan.md').match(/## Delivery Continuity\n\n([\s\S]*?)(?=\n## )/u)[1].trim().split('\n').slice(0,2).join('\n')+`\n| slice-01 | ${admitted.owner.deliveryId} | same | 1 | Retain same prior result | unchanged |`+'\n| slice-02 | none | new | none | Reviewed independent recovery delivery | all |');
    await fs.writeFile(path.join(root,'plan.md'),global);
    let index = old.get('tasks.md'); const indexRow=index.split('\n').find(line=>line.startsWith('| [ ] 01') || line.includes('| 01 - Greeting |'));
    index=index.replace(indexRow,indexRow+'\n'+indexRow.replace('01 - Greeting','02 - Recovery').replace('tasks/slice-01.md','tasks/slice-02.md').replace('| - | tasks/','| 01 | tasks/'));
    await fs.writeFile(path.join(root,'tasks.md'),index);
    const draft = await publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:root});
    assert.equal((await inspectExecutionState(f.specPath)).state,'PENDING_REPLAN_DRAFT');
    await assert.rejects(readExecutionActivation(f.specPath), /activation unavailable/);
    const history=JSON.parse(await fs.readFile(path.join(f.workspace.executionRoot,'continuity.json'),'utf8')).deliveries[0].history;
    assert.equal(await fs.readFile(path.resolve(f.workspace.executionRoot,history.at(-1).taskRef.path),'utf8'),old.get('tasks/slice-01.md'));
    assert.equal((await inspectExecutionState(f.specPath)).tasks.get('slice-01').implementationChecks.at(-1).id,'implementation-check-01');
    assert.deepEqual(await fs.readFile(path.join(draft.retainedBackup,'approved-preparation.json')),priorSnapshot);
    const review=await preparePreparationCandidate({specPath:f.specPath,operation:'REVIEW_PLAN'});
    for (const [name,text] of await readPreparationArtifacts(review.candidateExecutionRoot)) await fs.writeFile(path.join(review.candidateExecutionRoot,name),text.replace('status: draft','status: ready').replace('Review state: pending','Review state: approved'));
    // Runtime derives supersession result/progress from the reviewed semantic mapping.
    const current=await publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:review.candidateExecutionRoot,reviewDecision});
    const next=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','2',current.expectedActivationId);
    assert.equal(next.owner.slice,'slice-02');
    const now=await fs.readFile(path.join(f.workspace.executionRoot,'tasks/slice-01.md'),'utf8');
    assert.equal((await inspectExecutionState(f.specPath)).tasks.get('slice-01').sections.get('Implementation Test Evidence'),old.get('tasks/slice-01.md').split('## Implementation Test Evidence\n\n')[1].split('## Findings Test Evidence')[0].trim());
    assert.notEqual(next.owner.deliveryId,admitted.owner.deliveryId);
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

test('confirmed NEEDS_FIX closes validation ownership and admits the next legal APPLY_FINDINGS', async () => {
  const f=await fixture(); const previous=process.env.STNL_OPERATION_OWNER_FILE;
  try {
    const approved=await approveFixture(f);
    const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const implementation=await implementOffline(f,admitted);
    const complete=await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot});
    const validation=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',complete.expectedActivationId);
    process.env.STNL_OPERATION_OWNER_FILE=await ownerEnvironment(f,validation.owner);
    const native=await startOfflineNative(f,validation.owner);
    const parent=path.join(f.root,'validation-candidates');await fs.mkdir(parent);
    const candidate=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:validation.owner});
    const task=path.join(candidate.candidateExecutionRoot,'tasks/slice-01.md');
    await fs.writeFile(task,setSection(await fs.readFile(task,'utf8'),'Validation Findings',`### finding-01\n\n- Severity: blocking\n- State: active\n- Origin: attempt-01\n- Problem: Prepared proof omits a required condition.\n- Evidence: Review observes only the greeting value assertion.\n- Impact: Acceptance coverage remains incomplete.\n- Related authority: AC-001\n- Expected correction: Complete prepared proof in the authorized source subtree.`));
    const captured=await captureOfflineNative(native,{status:'NEEDS_FIX',head:'offline-working-tree',commands:[{command:implementation.command,exit:0}],evidence:'Simulated independent judgment of missing proof condition; existing checks executed.',findingReferences:'finding-01',findingDispositions:'finding-01=active',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'One formal needs-fix attempt.'});
    await prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,candidateExecutionRoot:candidate.candidateExecutionRoot,...captured});
    const published=await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:candidate.candidateExecutionRoot,owner:validation.owner});
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt,null);
    const next=await beginPreparedExecutionOperation(f.specPath,'APPLY_FINDINGS','1',published.expectedActivationId);
    assert.notEqual(next.owner.operationAttemptId,validation.owner.operationAttemptId);
    assert.equal(next.owner.operation,'APPLY_FINDINGS');
  } finally {if(previous===undefined)delete process.env.STNL_OPERATION_OWNER_FILE;else process.env.STNL_OPERATION_OWNER_FILE=previous;await fs.rm(f.root,{recursive:true,force:true});}
});

test('real broker binding prevents another broker across private directories without any invoke', async () => {
  const f=await fixture(); const {startOfficialRunnerBroker}=await import('../agents/codex/runtime/runner-broker.mjs');let broker,calls=0;
  try {
    const approved=await approveFixture(f);
    const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const officialPreflight={exitCode:0,operation:'EXECUTE_SLICE',slice:'slice-01',inputSlice:'1',specPath:f.specPath,state:'MATERIALIZED_PRISTINE',authority:approved.activation.requirementsAuthority,legalOperations:[{operation:'EXECUTE_SLICE',slice:'slice-01'}],mandatoryRecovery:null,owner:admitted.owner};
    const [left,right]=['left-broker','right-broker'].map(name=>path.join(f.root,name));await fs.mkdir(left);await fs.mkdir(right);
    broker=await startOfficialRunnerBroker({workspace:f.root,tmpdir:left,operation:'EXECUTE_SLICE',sequence:1,slice:'slice-01',officialPreflight,invoke:async()=>{calls+=1;throw new Error('no dispatch authorized in this fixture');},pollIntervalMs:1});
    const tree=await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(startOfficialRunnerBroker({workspace:f.root,tmpdir:right,operation:'EXECUTE_SLICE',sequence:2,slice:'slice-01',officialPreflight,invoke:async()=>{calls+=1;},pollIntervalMs:1}),/already has a runner/);
    assert.equal(calls,0);assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),tree);
    await broker.close();broker=null;
    assert.ok(await fs.stat(path.join(left,'stnl-runner-broker/active.json')));
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt.operationAttemptId,admitted.owner.operationAttemptId);
  } finally {if(broker)await broker.close();await fs.rm(f.root,{recursive:true,force:true});}
});


test('uncertain terminal acknowledgment holds the owner and final image', async () => {
  const f = await fixture();
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const implementation = await implementOffline(f, admitted);
    await assert.rejects(publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot,
      checkpoint: async phase => { if (phase === 'after-terminal-activation') throw new Error('terminal acknowledgment unavailable'); } }), /owner preserved/);
    const held = await readExecutionActivation(f.specPath);
    assert.equal(held.activation.activeAttempt.operationAttemptId, admitted.owner.operationAttemptId);
    assert.equal(held.activation.lastAttempt, null);
    assert.match(await fs.readFile(path.join(f.workspace.executionRoot, 'tasks/slice-01.md'), 'utf8'), /Status: TESTS_PASS/);
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'VALIDATE_SLICE', '1', held.activation.activationId), /owns|active/);
    assert.ok(await fs.stat(implementation.copy.candidateRoot));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('release failure after confirmation reports pending cleanup and preserves foreign lock', async () => {
  const f = await fixture();
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const implementation = await implementOffline(f, admitted);
    const {lockPath} = await executionLockIdentity(f.workspace);
    const foreign = Buffer.from('foreign lock must remain');
    const result = await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot,
      checkpoint: async phase => { if (phase === 'cleanup') await fs.writeFile(lockPath, foreign); } });
    assert.equal(result.publication, 'confirmed'); assert.equal(result.cleanup, 'pending');
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt, null);
    assert.deepEqual(await fs.readFile(lockPath), foreign);
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'VALIDATE_SLICE', '1', result.expectedActivationId), /lock already exists/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('real formerly-tested file can be captured as removed; absent prediction cannot', async () => {
  const f = await fixture();
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const implementation = await implementOffline(f, admitted);
    await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-01', candidateRoot: implementation.copy.candidateRoot });
    await fs.unlink(path.join(f.root, 'src/unpredicted.mjs'));
    const capture = await captureRunnerTestedState({ workspace: f.root, taskArtifact: path.join(f.workspace.executionRoot, 'tasks/slice-01.md'), changedAreas: ['../../src/unpredicted.mjs'] });
    assert.deepEqual(capture.entries, [{ path: '../../src/unpredicted.mjs', value: 'REMOVED' }]);
    await assert.rejects(captureRunnerTestedState({ workspace: f.root, taskArtifact: path.join(f.workspace.executionRoot, 'tasks/slice-01.md'), changedAreas: ['../../src/greeting.mjs'], removedProofs: [{path:'../../src/greeting.mjs',previousSha256:'sha256:'+'0'.repeat(64)}] }), /not proved removal/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('real execution publishers in separate processes serialize the same-base proposals', async () => {
  const f = await fixture(); let child;
  try {
    const approved = await approveFixture(f);
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', approved.activation.activationId);
    const left = await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
    const right = await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
    for (const copy of [left,right]) await updateOperationalChecklist({candidateExecutionRoot:copy.candidateExecutionRoot,slice:'slice-01',reason:'Bounded technical clarification',checklist:'- [ ] 1.1 Implement prepared greeting assertion | obligations: obligation-01'});
    const moduleUrl = new URL('../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs',import.meta.url).href;
    const code = `import {publishExecutionCopy} from ${JSON.stringify(moduleUrl)};
      try { const result=await publishExecutionCopy({...${JSON.stringify({specPath:f.specPath,slice:'slice-01',candidateRoot:left.candidateRoot,terminal:false})},checkpoint:async phase=>{if(phase==='before-backup'){process.send('locked');await new Promise(resolve=>process.once('message',resolve));}}});
      process.send({publication:result.publication}); } catch(error){process.send({error:error.message});process.exitCode=1;} process.disconnect();`;
    child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe','ipc']});
    let diagnostic='';child.stderr.on('data',bytes=>diagnostic+=bytes);
    const exited=new Promise(resolve=>child.once('exit',resolve));
    assert.equal(await Promise.race([new Promise(resolve=>child.once('message',resolve)),exited.then(code=>{throw new Error(`publisher exited before barrier: ${code} ${diagnostic}`);})]),'locked');
    const image=await captureExecutionTree(f.workspace.executionRoot); let effects=0;
    await assert.rejects(publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:right.candidateRoot,terminal:false,checkpoint:async()=>{effects+=1;}}),/lock already exists/);
    assert.equal(effects,0);assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),image);
    const completed=new Promise(resolve=>child.once('message',resolve));child.send('continue');
    assert.deepEqual(await completed,{publication:'confirmed'});assert.equal(await exited,0,diagnostic);
    const after=await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:right.candidateRoot,terminal:false}),/changed|CAS/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),after);assert.ok(await fs.stat(right.candidateRoot));
  } finally {if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await fs.rm(f.root,{recursive:true,force:true});}
});

test('native provenance rejects replay, wrong agent and duplicate dispatch; fresh same bytes and idempotency remain legal', async () => {
  const f=await fixture(); const previous=process.env.STNL_OPERATION_OWNER_FILE;
  try {
    const approved=await approveFixture(f);
    const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const implementation=await implementOffline(f,admitted);
    let token=(await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot})).expectedActivationId;
    const parent=path.join(f.root,'validation-candidates');await fs.mkdir(parent);
    const first=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',token);
    process.env.STNL_OPERATION_OWNER_FILE=await ownerEnvironment(f,first.owner);
    const invocation=await startOfflineNative(f,first.owner);
    let invocations=1;
    const response=formalResponse(implementation.command,'BLOCKED');
    const result={agentId:invocation.agentId,status:'completed',finalResponse:JSON.stringify(response)};
    await runNativeRunnerVerification({originFile:invocation.originFile});
    const captured=await captureNativeRunnerResult({originFile:invocation.originFile,result});
    assert.deepEqual(await captureNativeRunnerResult({originFile:invocation.originFile,result}),captured);
    assert.equal(invocations,1);
    const copy=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:first.owner});
    await prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,candidateExecutionRoot:copy.candidateExecutionRoot,...captured});
    token=(await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:copy.candidateExecutionRoot,owner:first.owner})).expectedActivationId;
    const second=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',token);
    process.env.STNL_OPERATION_OWNER_FILE=await ownerEnvironment(f,second.owner);
    const candidate=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:second.owner});
    const unchanged=await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,candidateExecutionRoot:candidate.candidateExecutionRoot,semanticResponseFile:captured.semanticResponseFile}),/origin-bound/);
    await assert.rejects(prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,candidateExecutionRoot:candidate.candidateExecutionRoot,...captured}),/owner|attempt/);
    assert.equal(invocations,1,'replay performs no new native invocation');
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),unchanged);
    const reserved=await startNativeRunnerCapture({specPath:f.specPath,owner:second.owner,workspace:f.root,captureParent:f.root});
    await assert.rejects(bindNativeRunnerIdentity({...reserved,agentId:invocation.agentId}),/EEXIST/);
    const fresh={...reserved,agentId:'offline-native-'+randomUUID()};
    await bindNativeRunnerIdentity(fresh);invocations+=1;
    await assert.rejects(startNativeRunnerCapture({specPath:f.specPath,owner:second.owner,workspace:f.root,captureParent:f.root}));
    await assert.rejects(captureNativeRunnerResult({originFile:fresh.originFile,result}),/bound concluded agent/);
    const freshCapture=await captureOfflineNative(fresh,response);
    assert.equal(await fs.readFile(freshCapture.semanticResponseFile,'utf8'),await fs.readFile(captured.semanticResponseFile,'utf8'),'identical semantic bytes from a real new invocation are allowed');
    const freshCopy=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:second.owner});
    await prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,candidateExecutionRoot:freshCopy.candidateExecutionRoot,...freshCapture});
    await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:freshCopy.candidateExecutionRoot,owner:second.owner});
    assert.equal(invocations,2);
    assert.equal((await inspectExecutionState(f.specPath)).state,'VALIDATION_BLOCKED');
    const task=await fs.readFile(path.join(f.workspace.executionRoot,'tasks/slice-01.md'),'utf8');
    assert.ok(task.includes('- Operation attempt ID: '+first.owner.operationAttemptId));
    assert.ok(task.includes('- Operation attempt ID: '+second.owner.operationAttemptId));
    await preserveFocalProof(f,'native-replay',{firstOwner:first.owner,secondOwner:second.owner,invocations,originalCapture:captured,freshCapture,state:'VALIDATION_BLOCKED'});
  } finally { if(previous===undefined)delete process.env.STNL_OPERATION_OWNER_FILE;else process.env.STNL_OPERATION_OWNER_FILE=previous;await fs.rm(f.root,{recursive:true,force:true}); }
});

test('table suffix cannot acquire authority or pass formal publication, approved snapshot is preserved', async () => {
  for (const row of ['| a | b | obligation outside','prefix | a | b |','| a | b | ']) assert.throws(()=>parsePreparationTableRow(row,2,'carrier'),/outside/);
  const f=await fixture();const previous=process.env.STNL_OPERATION_OWNER_FILE;
  try {
    const approved=await approveFixture(f);
    const begin=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const implementation=await implementOffline(f,begin);
    const complete=await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot});
    const validation=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',complete.expectedActivationId);
    process.env.STNL_OPERATION_OWNER_FILE=await ownerEnvironment(f,validation.owner);
    const native=await startOfflineNative(f,validation.owner);
    const captured=await captureOfflineNative(native,formalResponse(implementation.command));
    const parent=path.join(f.root,'formal');await fs.mkdir(parent);
    const candidate=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:validation.owner});
    await prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,candidateExecutionRoot:candidate.candidateExecutionRoot,...captured});
    const before=await captureExecutionTree(f.workspace.executionRoot);
    const index=path.join(candidate.candidateExecutionRoot,'tasks.md');
    const text=await fs.readFile(index,'utf8');
    await fs.writeFile(index,text.replace(/^(\| \[x\].+)$/mu,'$1 AC-001 also requires caller-state preservation; proof must observe writes.'));
    await assert.rejects(publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:candidate.candidateExecutionRoot,owner:validation.owner}),/carrier|outside/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
    assert.equal((await readExecutionActivation(f.specPath)).activation.approvedSnapshotSha256,approved.activation.approvedSnapshotSha256);
    await fs.writeFile(index,text);
    await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:candidate.candidateExecutionRoot,owner:validation.owner});
    assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');
  } finally {if(previous===undefined)delete process.env.STNL_OPERATION_OWNER_FILE;else process.env.STNL_OPERATION_OWNER_FILE=previous;await fs.rm(f.root,{recursive:true,force:true});}
});

test('first authorized removal uses real owned before capture and absence test, never fabricated history', async () => {await runFirstRemoval();});

test('rejected formal candidate recovery uses the same concluded managed receipt, preserves candidate and owner, with real failed command', async () => {
  const f=await fixture();const environment={...process.env};let broker,tmpdir,calls=0;
  try {
    const approved=await approveFixture(f);
    const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const implementation=await implementOffline(f,admitted);
    await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot});
    const ROOT=await fs.realpath(path.resolve(import.meta.dirname,'..'));
    const cli=path.join(ROOT,'skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs');
    const observedPreflight=spawnSync(process.execPath,[cli,f.specPath,'VALIDATE_SLICE','1'],{encoding:'utf8'});assert.equal(observedPreflight.status,0,observedPreflight.stderr);
    const {preflightExecutionOperation}=await import('../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs');
    const preflight=await preflightExecutionOperation(f.specPath,'VALIDATE_SLICE','1');
    const officialPreflight={exitCode:0,operation:'VALIDATE_SLICE',slice:'slice-01',inputSlice:'1',specPath:f.specPath,
      state:preflight.state,authority:'sha256:'+preflight.currentFingerprint,legalOperations:preflight.legalOperations,
      mandatoryRecovery:preflight.mandatoryRecovery,activationId:preflight.activation.activationId};
    const {createManagedSliceContext,managedEnvironment}=await import('../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs');
    const context=await createManagedSliceContext({officialPreflight,workspace:f.root,snapshot:ROOT,
      adapterPath:path.join(ROOT,'agents/codex/runtime/validation-runner.mjs'),bridgePath:path.join(ROOT,'agents/codex/runtime/managed-runner-bridge.mjs'),preflightPath:path.join(ROOT,'agents/codex/runtime/managed-slice-preflight.mjs')});
    tmpdir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-p1b-managed-recovery-')));
    const env=managedEnvironment({...process.env,TMPDIR:tmpdir},context);Object.assign(process.env,env);
    Object.assign(officialPreflight,{owner:context.owner,expectedActivationId:context.expectedActivationId});
    const {startOfficialRunnerBroker,submitOfficialRunnerRequest}=await import('../agents/codex/runtime/runner-broker.mjs');
    const {invokeIndependentRunner}=await import('../agents/codex/runtime/validation-runner.mjs');
    const command='node --test src/greeting.test.mjs';
    // A real failure of the reviewed recipe, with no undeclared ad-hoc proof.
    process.env.NODE_OPTIONS='--stnl-intentionally-invalid-option';
    const response=formalResponse('semantic command claim');
    broker=await startOfficialRunnerBroker({workspace:f.root,tmpdir,operation:'VALIDATE_SLICE',sequence:1,slice:'slice-01',officialPreflight,pollIntervalMs:1,
      invoke:request=>invokeIndependentRunner({...request,snapshot:ROOT,env,runTurn:async args=>{
        calls+=1; const result=spawnSync(process.execPath,['--test','src/greeting.test.mjs'],{cwd:f.root,encoding:'utf8'});assert.equal(result.status,9);
        const threadId='offline-sdk-'+randomUUID();
        const events=[{type:'thread.started',thread_id:threadId},{type:'turn.started'},
          {type:'item.completed',item:{id:'final',type:'agent_message',text:JSON.stringify(response)}},{type:'turn.completed'}];
        await fs.writeFile(args.eventsPath,events.map(event=>JSON.stringify({...event,operationId:args.operationId})).join('\n')+'\n',{flag:'wx'});
        return {completed:true,turnStarted:true,threadId,error:null,processError:null,errorEvent:null,requestedModel:args.model,requestedEffort:args.effort,reportedModel:args.model,usage:null};
      }})});
    const receipt=await submitOfficialRunnerRequest({workspace:f.root,tmpdir,operation:'VALIDATE_SLICE',sequence:1,slice:'slice-01',prompt:'Independently validate AC-001 with prepared checks.',pollIntervalMs:1,timeoutMs:10000});
    assert.equal(receipt.status,'RUNNER_RESPONSE_CAPTURED');assert.equal(calls,1);
    const parent=path.join(f.root,'rejected-formal');await fs.mkdir(parent);
    const rejected=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:context.owner});
    const rejectedTask=path.join(rejected.candidateExecutionRoot,'tasks/slice-01.md');
    // Inject a late bad serialization at the strict candidate boundary. The
    // normal preparer refuses this conflict earlier; recovery still accepts
    // only its bounded structured cause and the original concluded SDK event.
    const binding=['deliveryId','preparationRevision','normativeSha256','operationAttemptId','originActivationId'];
    const labels=['Delivery ID','Preparation revision','Normative sha256','Operation attempt ID','Origin activation ID'];
    const attempt=['### attempt-01','',...binding.map((key,i)=>'- '+labels[i]+': '+context.owner[key]),'- Type: initial','- Status: PASS','- HEAD: offline-working-tree','- Verified scope: ../../src/greeting.test.mjs, ../../src/unpredicted.mjs','- Commands:','  - `'+command+'` | exit:9','- Evidence: Real failed verification event contradicts claimed PASS.','- Finding references: none','- Finding dispositions: none','- Blockers: none','- Unexpected workspace effects: none','- Persistence summary: Preserve rejected proposal.'].join('\n');
    await fs.writeFile(rejectedTask,setSection(await fs.readFile(rejectedTask,'utf8'),'Validation Attempts',attempt));
    await assert.rejects(validateExecutionCandidate(f.specPath,rejected.candidateExecutionRoot),error=>{if(error.contractViolation?.code!=='PASS_COMMAND_EXIT_NONZERO')console.error(error.stack);return error.contractViolation?.code==='PASS_COMMAND_EXIT_NONZERO';});
    const before=await fs.readFile(rejectedTask);const snapshot=(await readExecutionActivation(f.specPath)).activation.approvedSnapshotSha256;
    const {recoverRejectedValidationCandidate}=await import('../skills/workflows/stnl-slice-quality-manager/runtime/recover-rejected-validation-candidate.mjs');
    const recoveryArgs={specPath:f.specPath,slice:'slice-01',workspace:f.root,rejectedCandidateRoot:rejected.candidateExecutionRoot,candidateParent:parent,semanticResponseFile:receipt.semanticResponseFile,receiptFile:receipt.receiptFile};
    const markerFile=rejected.candidateExecutionRoot+'.publication.json';
    const markerBytes=await fs.readFile(markerFile);const marker=JSON.parse(markerBytes);
    await fs.writeFile(markerFile,JSON.stringify({...marker,owner:{...marker.owner,operationAttemptId:randomUUID()}}));
    const officialBefore=await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(recoverRejectedValidationCandidate(recoveryArgs),/owner|attempt/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),officialBefore);
    await fs.writeFile(markerFile,markerBytes);
    const recovered=await recoverRejectedValidationCandidate(recoveryArgs);
    assert.equal(recovered.status,'RUNNER_RESULT_BLOCKED');assert.equal(recovered.publishedState,'RUNNER_RESULT_BLOCKED');
    assert.equal(recovered.mandatoryRecovery.operation,'VALIDATE_SLICE');assert.equal(calls,1);
    assert.deepEqual(await fs.readFile(rejectedTask),before);
    const current=await readExecutionActivation(f.specPath);assert.equal(current.activation.approvedSnapshotSha256,snapshot);
    assert.equal(current.activation.activeAttempt.operationAttemptId,context.owner.operationAttemptId);
    assert.equal((await inspectExecutionState(f.specPath)).tasks.get('slice-01').attempts.length,0);
    await assert.rejects(beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',current.activation.activationId),/active|owns/);
    await preserveFocalProof(f,'rejected-recovery',{receipt,recovered,runnerInvocations:calls,realCommandExit:7,state:'RUNNER_RESULT_BLOCKED',ownerRetained:current.activation.activeAttempt},tmpdir);
  } finally {
    if(broker)await broker.close();
    if(tmpdir)await fs.rm(tmpdir,{recursive:true,force:true});
    for(const key of Object.keys(process.env))if(!(key in environment))delete process.env[key];Object.assign(process.env,environment);
    await fs.rm(f.root,{recursive:true,force:true});
  }
});

test('repair restores only the exact approved Task bytes through producer/review/activation and common lock', async () => {
  const f=await fixture();
  const {repairExecutionContract}=await import('../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs');
  const retained=[];
  try {
    const approved=await approveFixture(f);
    assert.equal((await repairExecutionContract(f.specPath)).status,'UNCHANGED');
    const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const implementation=await implementOffline(f,admitted);
    await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot});
    const task=path.join(f.workspace.executionRoot,'tasks/slice-01.md');
    const markerFile=path.join(f.workspace.executionRoot,'activation.json');
    const clean=await fs.readFile(task,'utf8');
    const original=await readExecutionActivation(f.specPath);
    assert.equal(original.activation.activeAttempt,null);
    const corrupt=clean.replace('- Discovery sources:','- Check discovery sources:').replace('- Discovery actions:','- Check discovery actions:');
    assert.notEqual(corrupt,clean);await fs.writeFile(task,corrupt);
    await assert.rejects(readExecutionActivation(f.specPath),/manifest/);
    const phases=[];
    const repaired=await repairExecutionContract(f.specPath,{checkpoint:async phase=>{
      phases.push(phase);
      const location=await executionLockIdentity(f.workspace);
      assert.equal(JSON.parse(await fs.readFile(location.lockPath,'utf8')).executionRoot,f.workspace.executionRoot);
    }});
    assert.equal(repaired.status,'REPAIRED');assert.equal(repaired.publication,'confirmed');
    assert.equal(repaired.cleanup,'complete');assert.equal(repaired.repairs.length,1);
    assert.equal(repaired.state,'IMPLEMENTED_AWAITING_VALIDATION');
    assert.equal(await fs.readFile(task,'utf8'),clean);
    const current=await readExecutionActivation(f.specPath);
    assert.notEqual(current.activation.activationId,original.activation.activationId);
    assert.equal(current.activation.previousActivationId,original.activation.activationId);
    assert.equal(current.activation.sequence,original.activation.sequence+1);
    for(const key of ['artifacts','approvedSnapshotSha256','normativeSha256','requirementsAuthority','activeAttempt','lastAttempt']) {
      assert.deepEqual(current.activation[key],original.activation[key]);
    }
    assert.equal(await fs.readFile(path.join(repaired.retainedBackup,'tasks/slice-01.md'),'utf8'),corrupt);
    assert.ok(phases.includes('before-backup')&&phases.includes('after-backup')&&phases.includes('after-activation'));
    await preserveFocalProof(f,'repair-positive',{repaired,originalActivation:original.activation,restoredActivation:current.activation,phases});
    // Exercise the shipped CLI, including its explicit confirmed/cleanup report.
    await fs.writeFile(task,corrupt);
    const cli=spawnSync(process.execPath,[path.join(import.meta.dirname,'../skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs'),f.specPath,'--repair-known-contract'],{env:commandEnvironment,encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);assert.match(cli.stdout,/status=REPAIRED/);
    const cliResult=JSON.parse(cli.stdout.match(/^REPAIR_PUBLICATION: (.+)$/mu)[1]);
    assert.equal(cliResult.publication,'confirmed');assert.equal(cliResult.cleanup,'complete');
    assert.equal(await fs.readFile(task,'utf8'),clean);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activationId,cliResult.expectedActivationId);
    await preserveFocalProof(f,'repair-cli',{stdout:cli.stdout,result:cliResult});

    // Each rejection observes the actual resulting official bytes and immutable marker.
    const rejectPreserving=async (label,change,pattern,checkpoint=null)=>{
      await fs.writeFile(task,corrupt);
      const undo=await change();
      const before=await captureExecutionTree(f.workspace.executionRoot);
      const metadata=async()=>Promise.all(['',...before.files.map(entry=>entry.path)].map(async relative=>{
        const item=await fs.lstat(path.join(f.workspace.executionRoot,relative));
        return {path:relative,dev:item.dev,ino:item.ino,mode:item.mode,size:item.size,mtime:item.mtimeMs,ctime:item.ctimeMs};
      }));
      const beforeMetadata=await metadata();const phases=[];
      const marker=await fs.readFile(markerFile);
      let failure;
      try {await repairExecutionContract(f.specPath,{checkpoint:async(phase,allocation)=>{
        phases.push(phase);if(checkpoint)await checkpoint(phase,allocation);
      }});assert.fail('repair must reject '+label);}
      catch(error){failure=error;if(error.repairCandidate)retained.push(path.dirname(error.repairCandidate));assert.match(error.message,pattern);}
      if(checkpoint===null){
        assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
        assert.deepEqual(await metadata(),beforeMetadata);assert.deepEqual(phases,[]);
      }else assert.deepEqual(phases,['before-backup']);
      assert.deepEqual(await fs.readFile(markerFile),marker);
      if(failure.repairCandidate){
        assert.ok((await fs.stat(failure.repairCandidate)).isDirectory());
        await fs.cp(path.dirname(failure.repairCandidate),path.join(f.root,'retained-'+label),{recursive:true});
      }
      await preserveFocalProof(f,'repair-'+label,{diagnostic:failure.message,repairCandidate:failure.repairCandidate,allocation:failure.allocation,phases,officialWriteObserved:checkpoint!==null});
      if(undo)await undo();
      await fs.writeFile(task,clean);
      return failure;
    };
    await rejectPreserving('additional-task-edit',async()=>{await fs.appendFile(task,'\n');},/byte-identical/);
    const index=path.join(f.workspace.executionRoot,'tasks.md');
    await rejectPreserving('other-artifact-edit',async()=>{
      const bytes=await fs.readFile(index);await fs.appendFile(index,'\n');return()=>fs.writeFile(index,bytes);
    },/byte-identical|manifest/);
    await rejectPreserving('unsupported-alias',async()=>{await fs.writeFile(task,clean.replace('- Discovery sources:','- Unsupported discovery sources:'));},/unknown field/);
    await rejectPreserving('base-changed-before-commit',async()=>{},/source\/base changed/,async phase=>{
      if(phase==='before-backup')await fs.appendFile(task,'foreign before commit\n');
    });
    // Snapshot corruption cannot be legalized by restoring an otherwise exact Task.
    const snapshot=path.join(f.workspace.executionRoot,'approved-preparation.json');
    await rejectPreserving('snapshot-edit',async()=>{
      const bytes=await fs.readFile(snapshot);await fs.appendFile(snapshot,' ');return()=>fs.writeFile(snapshot,bytes);
    },/byte-identical|snapshot/);
    await rejectPreserving('requirements-changed-before-commit',async()=>{
      const bytes=await fs.readFile(f.specPath);return()=>fs.writeFile(f.specPath,bytes);
    },/requirements\/base changed/,async phase=>{
      if(phase==='before-backup')await fs.appendFile(f.specPath,'\n');
    });
    // Close this fixture after the active/uncertain owner negative; never clear it to obtain a PASS.
    const next=await readExecutionActivation(f.specPath);
    const validating=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',next.activation.activationId);
    await rejectPreserving('active-owner',async()=>{},/active\/uncertain/);
    await startNativeRunnerCapture({specPath:f.specPath,owner:validating.owner,workspace:f.root,captureParent:f.root});
    await rejectPreserving('pending-owner',async()=>{},/active\/uncertain/);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt.operationAttemptId,validating.owner.operationAttemptId);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt.runner.status,'pending');
  } finally {
    for(const root of retained)await fs.rm(root,{recursive:true,force:true});
    await fs.rm(f.root,{recursive:true,force:true});
  }
});

test('repair retains candidate and foreign backup when an open writer changes the moved source', async () => {
  const f=await fixture();let handle;let retained;
  try {
    const {repairExecutionContract}=await import('../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs');
    const approved=await approveFixture(f);
    const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const implementation=await implementOffline(f,admitted);
    await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot});
    const task=path.join(f.workspace.executionRoot,'tasks/slice-01.md');const clean=await fs.readFile(task,'utf8');
    const corrupt=clean.replace('- Discovery sources:','- Check discovery sources:').replace('- Discovery actions:','- Check discovery actions:');
    await fs.writeFile(task,corrupt);handle=await fs.open(task,'a');
    let allocation;let failure;
    try {
      await repairExecutionContract(f.specPath,{checkpoint:async (phase,paths)=>{
        if(phase==='after-backup'){allocation=paths;await handle.write('foreign open-writer bytes\n');}
      }});
      assert.fail('changed backup must block restoration');
    }catch(error){assert.match(error.message,/source\/base changed.*restore failed.*retained backup/);failure=error;}
    retained=path.dirname(failure.repairCandidate);
    assert.ok((await fs.stat(failure.repairCandidate)).isDirectory());
    assert.equal(await fs.readFile(path.join(allocation.backup,'tasks/slice-01.md'),'utf8'),corrupt+'foreign open-writer bytes\n');
    assert.ok((await fs.stat(allocation.stage)).isDirectory());
    await assert.rejects(fs.lstat(f.workspace.executionRoot),{code:'ENOENT'});
    await fs.cp(retained,path.join(f.root,'retained-candidate'),{recursive:true});
    await preserveFocalProof(f,'repair-uncertain-backup',{diagnostic:failure.message,allocation,repairCandidate:failure.repairCandidate});
  } finally {if(handle)await handle.close();if(retained)await fs.rm(retained,{recursive:true,force:true});await fs.rm(f.root,{recursive:true,force:true});}
});

test('native retry admission requires the finalized same-owner failed private check', async () => {
  const f=await fixture();
  try {
    const approved=await approveFixture(f);
    const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
    const implementation=await implementOffline(f,admitted,{forceFail:true});
    const args={specPath:f.specPath,owner:admitted.owner,workspace:f.root,captureParent:f.root};
    await assert.rejects(startNativeRunnerCapture(args),/finalized private check/);
    const saved=await fs.readFile(implementation.copy.candidateTaskArtifact);
    await fs.writeFile(implementation.copy.candidateTaskArtifact,setSection(saved.toString(),'Implementation Test Evidence','- none'));
    await assert.rejects(startNativeRunnerCapture({...args,candidateTaskArtifact:implementation.copy.candidateTaskArtifact}),/finalized failed check/);
    await fs.writeFile(implementation.copy.candidateTaskArtifact,saved);
    const next=await startNativeRunnerCapture({...args,candidateTaskArtifact:implementation.copy.candidateTaskArtifact});
    assert.equal(next.attempt,2);
    await assert.rejects(startNativeRunnerCapture({...args,candidateTaskArtifact:implementation.copy.candidateTaskArtifact}));
    assert.equal((await readExecutionActivation(f.specPath)).activation.activeAttempt.operationAttemptId,admitted.owner.operationAttemptId);
  } finally {await fs.rm(f.root,{recursive:true,force:true});}
});

}
