import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparePreparationCandidate } from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import { publishPreparationCandidate } from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import { computeRequirementsAuthority, resolveExecutionWorkspace, readExecutionActivation, preflightExecutionOperation,
  beginPreparedExecutionOperation } from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import { projectPreparationAuthority, readPreparationArtifacts, parseStrictJson } from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';

export const reviewDecision = { operation: 'REVIEW_PLAN', status: 'approved', examined: ['requirements', 'plans', 'tasks', 'initial checklist', 'proof capability'],
  summary: 'Offline review fixture: AC-001 requires an observable export; serial ownership, protected responsibilities and node --test export behavior checked. This simulated decision does not certify independent model judgment.' };
const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/workflows/stnl-execution-planner/templates');
const replace = (text, values) => values.reduce((result, [a, b]) => result.replaceAll(a, b), text);
export async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-p1b-test-')));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'src'));
  const specPath = path.join(root, 'requirements.md');
  await fs.writeFile(specPath, '# Requirements\n\nAC-001: Export a deterministic greeting. Verify by node --test.\n');
  const workspace = await resolveExecutionWorkspace(specPath);
  const authority = await computeRequirementsAuthority(specPath);
  const prepared = await preparePreparationCandidate({ specPath, operation: 'PLAN' });
  const candidate = prepared.candidateExecutionRoot;
  for (const dir of ['plans', 'tasks']) await fs.mkdir(path.join(candidate, dir));
  const identity = file => [['`<relative path>`', '`' + path.relative(path.dirname(path.join(workspace.executionRoot, file)), specPath).split(path.sep).join('/') + '`'],
    ['sha256:<64hex>', `sha256:${authority}`], ['<positive integer>', '1']];
  const rendering = [
    ['plan.template.md', 'plan.md', [['<compact objective>', 'Deliver a deterministic greeting.'], ['<compact strategy>', 'One serial implementation and test delivery.'], ['01 - <name>', '01 - Greeting'], ['<result>', 'Export observed by a prepared node test.'],
      ['directory: `<repository-relative physical target>`', 'directory: `src`'], ['<risk, boundary, or explicit final integration slice>', 'No auth, persistence or public protocol changes.']]],
    ['slice-plan.template.md', 'plans/slice-01.md', [['<Name>', 'Greeting'], ['<One coherent delivery and how it is observed.>', 'Export observed by node --test.'], ['<included work>', 'Create the greeting and its prepared check.'], ['<excluded work and boundary with later slices>', 'No authentication or persistence changes.'], ['`<artifact-relative authorized subtree or exact file>`', '`src`'], ['`<artifact-relative predicted file>`', '`src/greeting.mjs`'], ['<auth, persistence and public-contract boundaries requiring semantic review>', 'No authentication or persistence changes.'], ['<earlier slice or none>', 'none'], ['<risk and mitigation>', 'Export compatibility: assert value.'], ['<bounded approach>', 'Prepare a bounded module and node test.'], ['<test, command, suite, or observable check>', 'node --test src/greeting.test.mjs'], ['<objective result and preserved boundary>', 'AC-001 observed with protected responsibilities preserved.']]],
    ['tasks.template.md', 'tasks.md', [['01 - <name>', '01 - Greeting'], ['<observable delivery>', 'Export observed by a prepared node test.']]],
    ['slice-tasks.template.md', 'tasks/slice-01.md', [['<Name>', 'Greeting'], ['<Local observable delivery and its practical outcome.>', 'Export observed by node --test.'], ['<observable condition>', 'Greeting equals hello'], ['<required evidence>', 'node --test src/greeting.test.mjs observes export value'], ['`<artifact-relative authorized subtree or exact file>`', '`src`'], ['`<artifact-relative predicted file>`', '`src/greeting.mjs`'], ['<protected semantic responsibility and exclusion>', 'No authentication or persistence changes.'], ['<technical action>', 'Implement greeting and prepared test'], ['<test, command, suite, or observable check>', 'node --test src/greeting.test.mjs']]],
  ];
  for (const [template, file, values] of rendering) await fs.writeFile(path.join(candidate, file), replace(await fs.readFile(path.join(templateRoot, template), 'utf8'), [...identity(file), ...values]));
  return { root, specPath, workspace, candidate };
}
export async function approveFixture(f) {
  await publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: f.candidate });
  const review = await preparePreparationCandidate({ specPath: f.specPath, operation: 'REVIEW_PLAN' });
  const artifacts = await readPreparationArtifacts(review.candidateExecutionRoot);
  for (const [name, text] of artifacts) await fs.writeFile(path.join(review.candidateExecutionRoot, name), text.replace('status: draft', 'status: ready').replace('- Review state: pending', '- Review state: approved'));
  await publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: review.candidateExecutionRoot, reviewDecision });
  return readExecutionActivation(f.specPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
test('joint author -> draft -> review final snapshot -> resolver -> begin returns post-admission CAS', async () => {
  const f = await fixture();
  try {
    const current = await approveFixture(f);
    assert.equal(current.snapshot.reviewedArtifacts.length, 4);
    assert.equal((await preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1')).state, 'MATERIALIZED_PRISTINE');
    const begin = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', current.activation.activationId);
    assert.notEqual(begin.expectedActivationId, current.activation.activationId);
    assert.equal(begin.owner.originActivationId, current.activation.activationId);
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', begin.expectedActivationId), /active|owns/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('duplicate JSON keys, ambiguous Markdown and unknown sections fail closed', async () => {
  assert.throws(() => parseStrictJson('{"x":1,"x":2}'), /duplicate/);
  const f = await fixture();
  try {
    const current = await approveFixture(f);
    const task = path.join(f.workspace.executionRoot, 'tasks/slice-01.md');
    await fs.appendFile(task, '\n## Hidden permission\n\nChange authentication.\n');
    await assert.rejects(readExecutionActivation(f.specPath), /unknown|sections/);
    assert.equal(current.activation.activeAttempt, null);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('draft without Tasks and legacy/unactivated readiness never admit execution', async () => {
  const f = await fixture();
  try {
    await fs.rm(path.join(f.candidate, 'tasks/slice-01.md'));
    await assert.rejects(publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: f.candidate }));
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', 'absent'));
    assert.equal(await fs.stat(f.workspace.executionRoot).catch(() => null), null);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('native begin CLI and standalone consumers use the same activated joint contract', async () => {
  const f = await fixture(); let ownerFile;
  try {
    const approved = await approveFixture(f);
    const { inspectWorkspace } = await import('../skills/workflows/stnl-spec-test-runbook/runtime/lib/core.mjs');
    const before = await readExecutionActivation(f.specPath);
    const inspected = await inspectWorkspace(f.specPath, 'SLICE', {slice:'1'});
    assert.ok(inspected);
    const road = await import('../skills/workflows/stnl-spec-roadmap/runtime/execution-state.mjs');
    assert.equal((await road.readExecutionActivation(f.specPath)).activation.activationId, approved.activation.activationId);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activationId, before.activation.activationId);
    const cli = fileURLToPath(new URL('../skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs', import.meta.url));
    const began = spawnSync(process.execPath, [cli, f.specPath, '--begin', 'EXECUTE_SLICE', '1'], {encoding:'utf8'});
    assert.equal(began.status, 0, began.stderr);
    const admission = JSON.parse(began.stdout); ownerFile = admission.ownerFile;
    assert.notEqual(admission.expectedActivationId, approved.activation.activationId);
    assert.equal((await fs.stat(ownerFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(ownerFile,'utf8')).owner.originActivationId, approved.activation.activationId);
    const env={...process.env,STNL_OPERATION_OWNER_FILE:ownerFile};
    const check = spawnSync(process.execPath, [cli,f.specPath,'EXECUTE_SLICE','1'],{encoding:'utf8',env});
    assert.equal(check.status,0,check.stderr);
    const duplicate=spawnSync(process.execPath,[cli,f.specPath,'--begin','EXECUTE_SLICE','1'],{encoding:'utf8',env});
    assert.notEqual(duplicate.status,0);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activationId,admission.expectedActivationId);
  } finally {if(ownerFile)await fs.unlink(ownerFile);await fs.rm(f.root,{recursive:true,force:true});}
});

}
