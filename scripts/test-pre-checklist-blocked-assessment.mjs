import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { computeRequirementsAuthority, inspectExecutionState, preflightExecutionOperation,
  validateExecutionCandidate } from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { prepareExecutionCopy, publishExecutionCopy } from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import { serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate }
  from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';

// Standalone synthetic artifacts: no benchmark imports, processes, provider or consumer project.
const ROOT = path.resolve(import.meta.dirname, '..');
const CLAIM = '../../../../src/screen.txt';
const OLD = 'previous screen behavior\n';
const CURRENT = 'approved recovery screen behavior\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const section = (text, heading, value) => text.replace(
  new RegExp(`(## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, 'u'), `$1${value}\n`);
const replace = (text, pairs) => pairs.reduce((value, [before, after]) => value.replaceAll(before, after), text);
const template = (skill, file) => fs.readFile(path.join(ROOT, 'skills/workflows', skill, 'templates', file), 'utf8');

function response(status = 'BLOCKED', round = '1/3') {
  const commands = ['BLOCKED', 'TESTS_NOT_APPLICABLE'].includes(status) ? []
    : [{ command: 'STNL_VERIFICATION_COMMAND=1 node --test test/screen.test.mjs', exit: status === 'TESTS_FAIL' ? 1 : 0 }];
  return JSON.stringify({ status, automaticCheckRound: round, head: 'synthetic-fixture',
    discoverySources: 'approved task, existing screen checks and language contract',
    discoveryActions: 'read verification strategy and exposed language contract',
    verificationTypesConsidered: 'screen regression and real language UI smoke',
    nonApplicabilityRationale: status === 'TESTS_NOT_APPLICABLE' ? 'synthetic non-applicability rejection probe' : 'none',
    noVerificationCommandConfirmation: commands.length ? 'synthetic terminal rejection probe' : 'no verification command executed',
    commands, resultOfEachCommandAndExitCode: commands.length ? 'synthetic terminal rejection probe' : 'none',
    selectedChecks: 'screen regression and real language UI smoke',
    selectionRationale: 'approved smoke needs UI locale which current contract does not expose',
    coverage: 'AC-001 screen recovery; real English smoke remains unverified',
    failures: status === 'TESTS_FAIL' ? 'synthetic failure rejection probe' : 'none',
    priorRoundFailure: round === '1/3' ? 'none' : 'synthetic failure rejection probe',
    correctionApplied: round === '1/3' ? 'none' : 'synthetic authorized correction probe',
    inSliceRationale: round === '1/3' ? 'none' : 'same approved screen path',
    evidenceOrFailureSummary: 'approved smoke requires English UI; contract exposes Portuguese UI with English key parity',
    affectedFilesOrBehaviors: 'screen implementation in approved replacement slice',
    blockers: status === 'BLOCKED' ? 'verification strategy requires REPLAN; do not introduce a language feature' : 'none',
    unexpectedWorkspaceEffects: 'none', persistenceSummary: 'synthetic independent assessment response; no runner writes' });
}

const DIVERGENCE = `### divergence-01

- Severity: blocking
- State: active
- Origin: EXECUTE_SLICE
- Problem: Approved real English UI smoke conflicts with the existing exposed-language contract.
- Evidence: UI exposes Portuguese only; English key parity does not satisfy real UI smoke.
- Required authority operation: REPLAN`;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-blocked-assessment-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const specPath = path.join(root, 'specs', 'screen-recovery');
  const execution = path.join(specPath, 'execution');
  await fs.mkdir(path.join(root, '.git'));
  await fs.cp(path.join(ROOT, 'skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready'), specPath, { recursive: true });
  // Reuse only the canonical documentary scaffold; give this fixture its own authority.
  const featureFile = path.join(specPath, 'feature_spec.md');
  let feature = await fs.readFile(featureFile, 'utf8');
  feature = section(feature, 'Objective', 'Recover screen behavior under the existing exposed-language contract.');
  feature = section(feature, 'Context', '### Facts\n\n- UI exposes pt-BR; en-US has key parity only.');
  feature = section(feature, 'Scope', '- Preserve approved screen behavior and language key parity.');
  feature = section(feature, 'Out of Scope', '- Exposing a new UI locale.');
  feature = section(feature, 'Business Rules', '- Use the existing exposed-language contract.');
  feature = section(feature, 'Relevant Contracts', '- Existing UI contract exposes pt-BR only and maintains en-US key parity.');
  await fs.writeFile(featureFile, feature);
  for (const [file, heading, body] of [
    ['requirements.md', 'R-001', '- status: in_scope\n\nRecover screen behavior without exposing a new UI locale.'],
    ['acceptance-criteria.md', 'AC-001', '- status: active\n- verifies: [R-001]\n- references: [D-001, C-001, RK-001]\n\nApproved screen recovery preserves Portuguese UI and English key parity.'],
  ]) {
    const filePath = path.join(specPath, 'shared', file);
    await fs.writeFile(filePath, (await fs.readFile(filePath, 'utf8')).replace(
      /^### (?:R|AC)-001[\s\S]*$/mu, `### ${heading} — Screen recovery\n\n${body}\n`));
  }
  const authority = await computeRequirementsAuthority(specPath);
  await fs.mkdir(path.join(execution, 'plans'), { recursive: true });
  await fs.mkdir(path.join(execution, 'tasks'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/screen.txt'), OLD);
  await fs.writeFile(path.join(root, 'src/prior.txt'), 'unrelated completed delivery\n');
  const common = [['sha256:<64hex>', `sha256:${authority}`], ['`<relative path>`', '`../../feature_spec.md`'],
    ['<test, command, suite, or observable check>', 'Existing screen regression and real pt-BR/en-US UI smoke']];
  const planRows = [], taskRows = [];
  for (let n = 1; n <= 3; n++) {
    const id = String(n).padStart(2, '0'), name = `Delivery${id}`, revision = n === 3 ? '2' : '1';
    const claim = n === 1 ? '../../../../src/prior.txt' : CLAIM;
    const dependency = n === 1 ? '-' : String(n - 1).padStart(2, '0');
    let plan = replace(await template('stnl-execution-planner', 'slice-plan.template.md'), [...common,
      ['Slice 01', `Slice ${id}`], ['- Slice: 01', `- Slice: ${id}`], ['<Name>', name],
      ['<positive integer>', revision], ['status: draft', 'status: ready'], ['Review state: pending', 'Review state: approved'],
      ['<One coherent delivery and how it is observed.>', 'Recover approved observable screen behavior.'],
      ['<included work>', 'Approved screen recovery.'], ['<excluded work and boundary with later slices>', 'No new language feature.'],
      ['<artifact-relative path>', claim], ['<earlier slice or none>', dependency === '-' ? 'none' : `slice-${dependency}`],
      ['<risk and mitigation>', 'Preserve prior behavior.'], ['<bounded approach>', 'One screen change.'],
      ['<objective result and preserved boundary>', 'Screen behavior verified under existing contracts.']]);
    await fs.writeFile(path.join(execution, 'plans', `slice-${id}.md`), plan);
    let task = replace(await template('stnl-task-materializer', 'slice-tasks.template.md'), [...common,
      ['Slice 01', `Slice ${id}`], ['- Slice: 01', `- Slice: ${id}`], ['plans/slice-01.md', `plans/slice-${id}.md`],
      ['<Name>', name], ['<positive integer>', revision], ['1.1', `${n}.1`], ['<task>', 'Recover screen behavior'],
      ['<result>', 'Required UI smoke verified'], ['<artifact-relative path>', claim], ['<optional conceptual area>', 'screen behavior']]);
    if (n === 1) {
      task = task.replace('- [ ] 1.1', '- [x] 1.1');
      task = section(task, 'Changed Areas', `- \`${claim}\``);
      task = section(task, 'Validation Attempts', `### attempt-01\n\n- Type: initial\n- Status: PASS\n- HEAD: synthetic-fixture\n- Verified scope: ${claim}\n- Commands:\n  - \`node --test test/prior.test.mjs\` | exit:0\n- Evidence: prior delivery verified\n- Finding references: none\n- Finding dispositions: none\n- Blockers: none\n- Unexpected workspace effects: none\n- Persistence summary: prior PASS persisted`);
      task = section(task, 'Effective Validation Base', `- Origin attempt: attempt-01\n- Attempt type: initial\n- HEAD: synthetic-fixture\n- Result: PASS\n- Files:\n  - \`${claim}\` | sha256:${hash('unrelated completed delivery\n')}\n- Authoritative commands:\n  - \`node --test test/prior.test.mjs\` | exit:0\n- Evidence summary: prior delivery verified`);
      task = section(section(task, 'Final Result', '- PASS'), 'Diff Summary', '- Prior delivery verified.');
    }
    if (n === 2) {
      task = section(task, 'Changed Areas', `- \`${CLAIM}\``);
      // Generate all nine historical records through the official native producer.
      for (let check = 1; check <= 9; check++) {
        const file = path.join(execution, 'tasks', `slice-${id}.md`);
        await fs.writeFile(file, task);
        const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE',
          response: response(), workspace: root, taskArtifact: file });
        task = section(task, 'Implementation Test Evidence', check === 1 ? bundle
          : `${task.match(/## Implementation Test Evidence\n\n([\s\S]*?)\n## Findings Test Evidence/u)[1].trim()}\n\n${bundle}`);
      }
      task = section(task, 'Final Result', '- SUPERSEDED\n- Superseded by: slice-03\n- Plan revision: 2');
    }
    await fs.writeFile(path.join(execution, 'tasks', `slice-${id}.md`), task);
    planRows.push(`| ${id} - ${name} | observable result | ${dependency} | AC-001 | \`${claim.slice(3)}\` | plans/slice-${id}.md |`);
    const final = n === 1 ? 'PASS' : n === 2 ? 'SUPERSEDED' : 'pending';
    taskRows.push(`| [${n === 3 ? ' ' : 'x'}] | ${id} - ${name} | observable result | ${dependency} | tasks/slice-${id}.md | ${final} | ${final} |`);
  }
  let global = replace(await template('stnl-execution-planner', 'plan.template.md'), [
    ['`<relative path>`', '`../feature_spec.md`'], ['sha256:<64hex>', `sha256:${authority}`], ['<positive integer>', '2'],
    ['status: draft', 'status: ready'], ['Review state: pending', 'Review state: approved'],
    ['<compact objective>', 'Recover observable screen behavior'], ['<compact strategy>', 'Serial recovery']]);
  global = global.replace(/For revision 1,[\s\S]*?\n## Serial Slice Order/u,
    '- Replan reason: approved recovery\n- Revision mode: append-only-extension\n- Supersedes open slices: slice-02 -> slice-03\n\n## Serial Slice Order');
  global = global.replace(/^\| 01 - <name>.*$/mu, planRows.join('\n'));
  await fs.writeFile(path.join(execution, 'plan.md'), global);
  const index = (await template('stnl-task-materializer', 'tasks.template.md')).replace(/^\| \[ \] \| 01 - <name>.*$/mu, taskRows.join('\n'));
  await fs.writeFile(path.join(execution, 'tasks.md'), index);
  await fs.writeFile(path.join(root, 'src/screen.txt'), CURRENT);
  return { root, specPath, execution };
}

async function candidate(f, { status = 'BLOCKED', divergence = true, round = '1/3' } = {}) {
  const copy = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-03' });
  let task = section(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), 'Changed Areas', `- \`${CLAIM}\``);
  task = section(task, 'Diff Summary', '- Approved screen recovery exists; real English UI smoke is blocked.');
  await fs.writeFile(copy.candidateTaskArtifact, task);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', response: response(status, round),
    workspace: f.root, taskArtifact: copy.candidateTaskArtifact });
  // Insertion validates the complete prospective candidate before any evidence append.
  await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', bundle,
    validateProspectiveTask: ({ slice, text }) => validateExecutionCandidate(f.specPath, copy.candidateExecutionRoot,
      [{ slice, text }]) });
  if (divergence) await fs.writeFile(copy.candidateTaskArtifact,
    section(await fs.readFile(copy.candidateTaskArtifact, 'utf8'), 'Divergences', DIVERGENCE));
  return copy;
}

async function stageStrategyReplan(copy) {
  const planFile = path.join(copy.candidateExecutionRoot, 'plan.md');
  let plan = await fs.readFile(planFile, 'utf8');
  plan = plan.replace('status: ready', 'status: draft').replace('Review state: approved', 'Review state: pending')
    .replace('Plan revision: 2', 'Plan revision: 3').replace('slice-02 -> slice-03', 'slice-03 -> slice-04')
    .replace('| 03 - Delivery03 | observable result | 02 | AC-001 | `../../../src/screen.txt` | plans/slice-03.md |',
      '| 03 - Delivery03 | observable result | 02 | AC-001 | `../../../src/screen.txt` | plans/slice-03.md |\n| 04 - StrategyRecovery | observable result | 03 | AC-001 | `../../../src/screen.txt` | plans/slice-04.md |');
  await fs.writeFile(planFile, plan);
  const detail = (await fs.readFile(path.join(copy.candidateExecutionRoot, 'plans/slice-03.md'), 'utf8'))
    .replaceAll('Slice 03', 'Slice 04').replace('- Slice: 03', '- Slice: 04').replace('Delivery03', 'StrategyRecovery')
    .replace('Plan revision: 2', 'Plan revision: 3').replace('status: ready', 'status: draft')
    .replace('Review state: approved', 'Review state: pending').replace('- slice-02', '- slice-03')
    .replace('Existing screen regression and real pt-BR/en-US UI smoke', 'Existing screen regression, real pt-BR UI smoke, and en-US key parity');
  await fs.writeFile(path.join(copy.candidateExecutionRoot, 'plans/slice-04.md'), detail);
}

test('skill permits only the bounded independent objective-blocker assessment before checklist completion', async () => {
  const skill = await fs.readFile(path.join(ROOT, 'skills/workflows/stnl-slice-executor/SKILL.md'), 'utf8');
  assert.match(skill, /Except for the objective-blocker assessment above, verify every mandatory checklist item complete/u);
  assert.match(skill, /With an incomplete checklist, only a valid `BLOCKED` assessment may be published/u);
  assert.match(skill, /does not bypass a failed preflight, an already active divergence/u);
  assert.match(skill, /never convert `TESTS_PASS` to `BLOCKED`/u);
});

test('fresh BLOCKED owns current bytes without rewriting superseded check09 and routes to REPLAN', async t => {
  const f = await fixture(t);
  const historicalFile = path.join(f.execution, 'tasks/slice-02.md');
  const historical = await fs.readFile(historicalFile);
  assert.match(historical.toString(), /### implementation-check-09/u);
  assert.match(historical.toString(), new RegExp(`sha256:${hash(OLD)}`, 'u'));
  assert.equal((await preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '3')).state, 'EXECUTION_STARTED');
  const drift = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-03' });
  await fs.writeFile(drift.candidateTaskArtifact,
    section(section(await fs.readFile(drift.candidateTaskArtifact, 'utf8'), 'Changed Areas', `- \`${CLAIM}\``), 'Divergences', DIVERGENCE));
  await stageStrategyReplan(drift);
  await assert.rejects(validateExecutionCandidate(f.specPath, drift.candidateExecutionRoot), /implementation-check-09 Tested state.*file-backed candidate evidence expected/u);
  const copy = await candidate(f);
  const text = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  assert.match(text, /- \[ \] 3.1/u);
  assert.match(text, new RegExp(`sha256:${hash(CURRENT)}`, 'u'));
  assert.equal((await validateExecutionCandidate(f.specPath, copy.candidateExecutionRoot)).state, 'DIVERGENCE_BLOCKED');
  await publishExecutionCopy({ specPath: f.specPath, slice: 'slice-03', candidateRoot: copy.candidateRoot });
  assert.deepEqual(await fs.readFile(historicalFile), historical);
  const state = await inspectExecutionState(f.specPath);
  assert.equal(state.state, 'DIVERGENCE_BLOCKED');
  assert.deepEqual(state.legalOperations, [{ operation: 'REPLAN', slice: null }]);
  assert.equal((await preflightExecutionOperation(f.specPath, 'REPLAN')).state, 'DIVERGENCE_BLOCKED');
  // The same documentary-only append which failed on historic check09 now passes.
  const replan = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-03' });
  await stageStrategyReplan(replan);
  assert.equal((await validateExecutionCandidate(f.specPath, replan.candidateExecutionRoot)).state, 'PENDING_REPLAN_DRAFT');
  assert.deepEqual(await fs.readFile(path.join(replan.candidateExecutionRoot, 'tasks/slice-02.md')), historical);
  await assert.rejects(preflightExecutionOperation(f.specPath, 'VALIDATE_SLICE', '3'), /not legal/u);
  await assert.rejects(preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '3'), /not legal/u);
});

test('BLOCKED without documentary conflict retains auxiliary recovery and still rejects current drift', async t => {
  const f = await fixture(t);
  const copy = await candidate(f, { divergence: false });
  const blocked = await validateExecutionCandidate(f.specPath, copy.candidateExecutionRoot);
  assert.equal(blocked.state, 'AUXILIARY_BLOCKED');
  assert.equal(blocked.mandatoryRecovery.operation, 'EXECUTE_SLICE');
  assert.equal(blocked.mandatoryRecovery.slice, 'slice-03');
  assert.equal(blocked.mandatoryRecovery.sameOperationResumeRequired, true);
  await fs.writeFile(path.join(f.root, 'src/screen.txt'), 'unjustified later drift\n');
  await assert.rejects(validateExecutionCandidate(f.specPath, copy.candidateExecutionRoot), /implementation-check-01 Tested state.*file-backed candidate evidence expected/u);
});

test('incomplete success, forged hashes, wrong path basis and out-of-scope claims remain rejected', async t => {
  const f = await fixture(t);
  for (const status of ['TESTS_PASS', 'TESTS_NOT_APPLICABLE']) {
    await assert.rejects(candidate(f, { status }), /mandatory checklist is incomplete/u);
  }
  const copy = await candidate(f);
  const original = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  for (const [label, mutate, diagnostic] of [
    ['forged current hash', text => text.replaceAll(`sha256:${hash(CURRENT)}`, `sha256:${'0'.repeat(64)}`), /file-backed candidate evidence expected/u],
    ['repository-relative path', text => text.replaceAll(CLAIM, 'src/screen.txt'), /path.*(?:outside|execution|not match|not own|does not exist)|invalid artifact-relative implementation path/u],
    ['scope expansion', text => section(text, 'Changed Areas', `- \`../../../../src/prior.txt\`\n- \`${CLAIM}\``), /does not own every Changed Areas\/Corrections Applied path/u],
  ]) {
    const rejected = await prepareExecutionCopy({ specPath: f.specPath, slice: 'slice-03' });
    await fs.writeFile(rejected.candidateTaskArtifact, mutate(original));
    await assert.rejects(validateExecutionCandidate(f.specPath, rejected.candidateExecutionRoot), diagnostic, label);
  }
  // A third failure cannot be used to publish a pending checklist either.
  let task = original.replace(DIVERGENCE, '- none');
  const blocked = task.match(/## Implementation Test Evidence\n\n([\s\S]*?)\n## Findings Test Evidence/u)[1].trim();
  const failures = [1, 2, 3].map(n => blocked.replace('implementation-check-01', `implementation-check-0${n}`)
    .replace('Automatic check round: 1/3', `Automatic check round: ${n}/3`)
    .replace('Status: BLOCKED', 'Status: TESTS_FAIL').replace('- Commands: none', '- Commands:\n  - `node --test test/screen.test.mjs` | exit:1')
    .replace('- Failures: none', '- Failures: synthetic failure rejection probe')
    + (n > 1 ? `\n- Prior-round failure: synthetic failure rejection probe\n- Correction applied: same approved path\n- Correction paths: ${CLAIM}\n- Updated scope: ${CLAIM}\n- In-slice rationale: bounded correction` : ''));
  task = section(section(task, 'Implementation Test Evidence', failures.join('\n\n')), 'Corrections Applied', `- \`${CLAIM}\``);
  await fs.writeFile(copy.candidateTaskArtifact, task);
  await assert.rejects(validateExecutionCandidate(f.specPath, copy.candidateExecutionRoot), /mandatory checklist is incomplete/u);
});
