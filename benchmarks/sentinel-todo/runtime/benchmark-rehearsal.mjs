#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  computeRequirementsAuthority,
  inspectExecutionState,
  preflightExecutionOperation,
} from '../../../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import {
  cleanupManagedBenchmarkSession,
  createManagedBenchmarkSession,
} from './benchmark-environment.mjs';
import { runHarness } from './benchmark-agent-harness.mjs';

const RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(RUNTIME_ROOT, '../../..');
const READY_LIFECYCLE_FIXTURE = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready',
);
const PLAN_TEMPLATE = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-execution-planner/templates/plan.template.md',
);
const SLICE_PLAN_TEMPLATE = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-execution-planner/templates/slice-plan.template.md',
);
const TASKS_TEMPLATE = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-task-materializer/templates/tasks.template.md',
);
const SLICE_TASK_TEMPLATE = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md',
);
const EXECUTION_CHECKER = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs',
);
const EXECUTOR_SKILL = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-slice-executor/SKILL.md',
);
const QUALITY_SKILL = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-slice-quality-manager/SKILL.md',
);
const LIFECYCLE_SKILL = path.join(
  REPOSITORY_ROOT,
  'skills/workflows/stnl-spec-lifecycle-manager/SKILL.md',
);
const EXECUTE_LAUNCHER = path.join(REPOSITORY_ROOT, 'templates/prompts/slice-execute-codex.md');
const VALIDATE_LAUNCHER = path.join(REPOSITORY_ROOT, 'templates/prompts/slice-validate-codex.md');
const READINESS_LAUNCHER = path.join(REPOSITORY_ROOT, 'templates/prompts/spec-readiness.md');
const CLOSE_LAUNCHER = path.join(REPOSITORY_ROOT, 'templates/prompts/spec-close.md');

const IGNORED = new Set(['.DS_Store', '__MACOSX']);

function ignored(name) {
  return IGNORED.has(name) || name.startsWith('._');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pass(id, category, evidence) {
  return { id, result: `${id}_PASS`, category, evidence };
}

function fail(id, category, evidence) {
  return { id, result: `${id}_FAIL`, category, evidence };
}

function replaceAll(source, replacements) {
  let value = source;
  for (const [from, to] of replacements) value = value.replaceAll(from, to);
  return value;
}

function approved(text) {
  return text.replace('status: draft', 'status: ready').replaceAll('Review state: pending', 'Review state: approved');
}

function omitInitialRecoveryFields(text) {
  return text.replace(/\nFor revision 1,[\s\S]*?\n## Serial Slice Order/u, '\n## Serial Slice Order');
}

async function treeHash(root) {
  const hash = createHash('sha256');
  async function visit(directory, prefix = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => !ignored(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(absolute);
        hash.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes);
      } else hash.update(`UNSAFE:${relative}`);
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function writeCanonicalExecution(spec) {
  const execution = path.join(spec, 'execution');
  const plans = path.join(execution, 'plans');
  const tasks = path.join(execution, 'tasks');
  await fs.mkdir(plans, { recursive: true });
  await fs.mkdir(tasks, { recursive: true });
  const authority = await computeRequirementsAuthority(spec);
  const feature = path.join(spec, 'feature_spec.md');
  const implementation = path.join(path.dirname(spec), 'src/invitation.mjs');
  const globalSource = path.relative(execution, feature).split(path.sep).join('/');
  const detailSource = path.relative(plans, feature).split(path.sep).join('/');
  const taskSource = path.relative(tasks, feature).split(path.sep).join('/');
  const globalImplementation = path.relative(execution, implementation).split(path.sep).join('/');
  const detailImplementation = path.relative(plans, implementation).split(path.sep).join('/');
  const taskImplementation = path.relative(tasks, implementation).split(path.sep).join('/');

  const global = approved(omitInitialRecoveryFields(replaceAll(await fs.readFile(PLAN_TEMPLATE, 'utf8'), [
    ['`<relative path>`', `\`${globalSource}\``],
    ['sha256:<64hex>', `sha256:${authority}`],
    ['<positive integer>', '1'],
    ['<compact objective>', 'Implement deterministic invitation expiration'],
    ['<compact strategy>', 'Complete one bounded function and validate its focused test'],
    ['01 - <name>', '01 - Invitation expiration'],
    ['<result>', 'expired invitations are detected at the UTC boundary'],
    ['`<artifact-relative path>`; <optional conceptual area>', `\`${globalImplementation}\`; invitation expiration`],
    ['<risk, boundary, or explicit final integration slice>', 'UTC boundary behavior is covered by the focused test'],
  ])));
  await fs.writeFile(path.join(execution, 'plan.md'), global, 'utf8');

  const slicePlan = approved(replaceAll(await fs.readFile(SLICE_PLAN_TEMPLATE, 'utf8'), [
    ['<Name>', 'Invitation expiration'],
    ['`<relative path>`', `\`${detailSource}\``],
    ['sha256:<64hex>', `sha256:${authority}`],
    ['<positive integer>', '1'],
    ['<One coherent delivery and how it is observed.>', 'Implement the expiration predicate and observe it through the focused Node test.'],
    ['<included work>', 'Implement `isInvitationExpired` in `src/invitation.mjs`.'],
    ['<excluded work and boundary with later slices>', 'No lifecycle, storage, HTTP, or delivery-channel changes.'],
    ['`<artifact-relative path>` — <optional contract, subsystem, test area, or explanation>', `\`${detailImplementation}\` — invitation expiration predicate`],
    ['<earlier slice or none>', 'none'],
    ['<risk and mitigation>', 'UTC boundary errors; cover equality and before/after cases.'],
    ['<bounded approach>', 'Change only the predicate implementation.'],
    ['<test, command, suite, or observable check>', 'node --test'],
    ['<objective result and preserved boundary>', 'Focused tests pass and no unrelated path changes.'],
  ]));
  await fs.writeFile(path.join(plans, 'slice-01.md'), slicePlan, 'utf8');

  const tasksIndex = replaceAll(await fs.readFile(TASKS_TEMPLATE, 'utf8'), [
    ['01 - <name>', '01 - Invitation expiration'],
    ['<observable delivery>', 'expired invitations are detected at the UTC boundary'],
  ]);
  await fs.writeFile(path.join(execution, 'tasks.md'), tasksIndex, 'utf8');

  const task = replaceAll(await fs.readFile(SLICE_TASK_TEMPLATE, 'utf8'), [
    ['<Name>', 'Invitation expiration'],
    ['`<relative path>`', `\`${taskSource}\``],
    ['sha256:<64hex>', `sha256:${authority}`],
    ['<positive integer>', '1'],
    ['<task>', 'Implement `isInvitationExpired` using the UTC timestamp boundary'],
    ['<result>', 'expired at equality or after, active before expiration'],
    ['`<artifact-relative path>`; <optional conceptual area>', `\`${taskImplementation}\`; invitation expiration predicate`],
    ['<test, command, suite, or observable check>', 'node --test'],
  ]);
  await fs.writeFile(path.join(tasks, 'slice-01.md'), task, 'utf8');
  return authority;
}

export async function createCriticalFixture(workspace) {
  const gitInit = spawnSync('git', ['init', '--quiet', workspace], {
    cwd: path.dirname(workspace), encoding: 'utf8', shell: false,
  });
  if (gitInit.status !== 0) throw new Error(`temporary fixture git init failed: ${gitInit.stderr.trim()}`);
  const projectAgents = path.join(workspace, '.codex/agents');
  await fs.mkdir(projectAgents, { recursive: true });
  await fs.copyFile(
    path.join(REPOSITORY_ROOT, 'agents/codex/.codex/agents/stnl_validation_runner.toml'),
    path.join(projectAgents, 'stnl_validation_runner.toml'),
  );
  const spec = path.join(workspace, 'spec');
  await fs.cp(READY_LIFECYCLE_FIXTURE, spec, { recursive: true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(workspace, 'src/invitation.mjs'),
    'export function isInvitationExpired(expiresAt, now) {\n  throw new Error("TODO: implement UTC expiration boundary");\n}\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(workspace, 'test/invitation.test.mjs'),
    `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { isInvitationExpired } from '../src/invitation.mjs';\n\ntest('expiration uses the UTC equality boundary', () => {\n  assert.equal(isInvitationExpired('2030-01-01T00:00:00.000Z', '2029-12-31T23:59:59.999Z'), false);\n  assert.equal(isInvitationExpired('2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'), true);\n  assert.equal(isInvitationExpired('2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.001Z'), true);\n});\n`,
    'utf8',
  );
  const authority = await writeCanonicalExecution(spec);
  const state = await inspectExecutionState(spec);
  if (state.state !== 'MATERIALIZED_PRISTINE') throw new Error(`fixture state=${state.state}`);
  return { spec, authority };
}

export function applyBlockedStopPolicy(current, runnerResult) {
  const next = {
    logicalExecuteEvents: current.logicalExecuteEvents + 1,
    implementationChecks: current.implementationChecks + 1,
    state: runnerResult.status === 'BLOCKED' ? 'AUXILIARY_BLOCKED' : current.state,
    caseTerminal: runnerResult.status === 'BLOCKED',
    automaticRounds: current.automaticRounds,
    automaticReentry: false,
  };
  if (runnerResult.status === 'TESTS_FAIL' && runnerResult.round < 3) {
    next.automaticRounds += 1;
    next.automaticReentry = true;
  }
  return Object.freeze(next);
}

async function runnerContractMutation() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-rehearsal-runner-')));
  try {
    const agents = path.join(root, 'agents');
    await fs.cp(path.join(REPOSITORY_ROOT, 'agents'), agents, { recursive: true });
    const files = [
      path.join(agents, 'codex/.codex/agents/stnl_validation_runner.toml'),
      path.join(agents, 'claude-code/.claude/agents/stnl-validation-runner.md'),
    ];
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, source.replace(
        'Não calcule Requirements authority por SHA direto de `shared/requirements.md`',
        'Calcule o SHA de `shared/requirements.md` como Requirements authority',
      ), 'utf8');
    }
    return spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/check-contracts.mjs'), 'validation-runner', '--root', agents], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      shell: false,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function runDeterministicStages({ keepFixture = false, workspace = null } = {}) {
  const ownedRoot = workspace === null
    ? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-pre-pilot-rehearsal-')))
    : null;
  const target = workspace ?? path.join(ownedRoot, 'workspace');
  await fs.mkdir(target, { recursive: true });
  const stages = [];
  let fixture;
  try {
    fixture = await createCriticalFixture(target);
    const requirements = path.join(fixture.spec, 'shared/requirements.md');
    const raw = sha256(await fs.readFile(requirements));
    const canonical = await computeRequirementsAuthority(fixture.spec);
    const state = await inspectExecutionState(fixture.spec);
    const preflight = await preflightExecutionOperation(fixture.spec, 'EXECUTE_SLICE', '1');
    const plan = await fs.readFile(path.join(fixture.spec, 'execution/plan.md'), 'utf8');
    const task = await fs.readFile(path.join(fixture.spec, 'execution/tasks/slice-01.md'), 'utf8');
    const r01 = raw !== canonical
      && canonical === state.currentFingerprint
      && canonical === preflight.currentFingerprint
      && state.stale === false
      && plan.includes(`Requirements authority: sha256:${canonical}`)
      && task.includes(`Requirements authority: sha256:${canonical}`);
    stages.push(r01
      ? pass('R01', 'EXECUTION', `raw=sha256:${raw}; canonical=sha256:${canonical}; preflight=${preflight.state}; stale=false`)
      : fail('R01', 'EXECUTION', 'canonical authority integration failed'));
    if (!r01) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, fixture };

    const beforeMutation = canonical;
    await fs.writeFile(requirements, (await fs.readFile(requirements, 'utf8')).replace(
      'without creating participation.',
      'without creating participation or emitting a success result.',
    ), 'utf8');
    const afterMutation = await computeRequirementsAuthority(fixture.spec);
    const changed = await inspectExecutionState(fixture.spec);
    const replan = await preflightExecutionOperation(fixture.spec, 'REPLAN');
    const r02 = beforeMutation !== afterMutation
      && changed.state === 'REQUIREMENTS_CHANGED'
      && changed.stale === true
      && replan.state === 'REQUIREMENTS_CHANGED';
    stages.push(r02
      ? pass('R02', 'EXECUTION', `canonical changed; state=${changed.state}; recovery=REPLAN`)
      : fail('R02', 'EXECUTION', 'canonical drift was not detected'));
    if (!r02) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, fixture };

    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    fixture = await createCriticalFixture(target);
    const canonicalContracts = spawnSync(process.execPath, [
      path.join(REPOSITORY_ROOT, 'scripts/check-contracts.mjs'), 'validation-runner', '--root', path.join(REPOSITORY_ROOT, 'agents'),
    ], { cwd: REPOSITORY_ROOT, encoding: 'utf8', shell: false });
    const mutation = await runnerContractMutation();
    const r03 = canonicalContracts.status === 0
      && mutation.status === 1
      && /CONTRACT_ERROR\[R019_REQUIREMENTS_AUTHORITY\]/u.test(mutation.stderr);
    stages.push(r03
      ? pass('R03', 'RUNNER_SEMANTIC', 'canonical adapters accepted; raw shared-hash mutation rejected as R019')
      : fail('R03', 'RUNNER_SEMANTIC', 'runner authority anti-regression failed'));
    if (!r03) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, fixture };

    const stopped = applyBlockedStopPolicy({
      logicalExecuteEvents: 0,
      implementationChecks: 0,
      state: 'MATERIALIZED_PRISTINE',
      caseTerminal: false,
      automaticRounds: 0,
      automaticReentry: false,
    }, { status: 'BLOCKED', round: 1 });
    const r04 = stopped.logicalExecuteEvents === 1
      && stopped.implementationChecks === 1
      && stopped.state === 'AUXILIARY_BLOCKED'
      && stopped.caseTerminal === true
      && stopped.automaticRounds === 0
      && stopped.automaticReentry === false;
    stages.push(r04
      ? pass('R04', 'SENTINEL_CONTRACT', '1 EXECUTE; 1 implementation-check; AUXILIARY_BLOCKED; terminal; 0 re-entry')
      : fail('R04', 'SENTINEL_CONTRACT', 'valid BLOCKED did not stop the Case'));
    if (!r04) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, fixture };

    const pristine = await inspectExecutionState(fixture.spec);
    const r05 = pristine.state === 'MATERIALIZED_PRISTINE'
      && pristine.currentFingerprint === fixture.authority;
    stages.push(r05
      ? pass('R05', 'EXECUTION', `temporary critical fixture state=${pristine.state}`)
      : fail('R05', 'EXECUTION', `fixture state=${pristine.state}`));
    return {
      status: r05 ? 'PRE_PILOT_REHEARSAL_READY' : 'PRE_PILOT_REHEARSAL_BLOCKED',
      stages,
      fixture,
      ownedRoot: keepFixture ? ownedRoot : null,
    };
  } finally {
    if (ownedRoot !== null && !keepFixture) await fs.rm(ownedRoot, { recursive: true, force: true });
  }
}

async function launcherPrompt({ launcher, skill, spec, operation, extra = '' }) {
  const template = (await fs.readFile(launcher, 'utf8'))
    .replaceAll('{{SPEC_PATH}}', spec)
    .replaceAll('{{SLICE}}', '1')
    .replaceAll('{{READINESS_SCOPE}}', 'GLOBAL')
    .replaceAll('{{READINESS_FOCUS}}', 'not-applicable');
  return [
    'Execute exactly one Sentinel operation in this temporary rehearsal workspace.',
    `Read the complete skill at ${skill} and obey it.`,
    `Use this exact real launcher contract:\n${template}`,
    `The official execution checker is ${EXECUTION_CHECKER}.`,
    `Target operation: ${operation}.`,
    'Do not start a later operation, do not retry a valid BLOCKED result, and do not edit the sentinel-workflows source checkout.',
    extra,
    'Return a compact terminal result only after the official readback.',
  ].filter(Boolean).join('\n\n');
}

async function harnessStage(session, workspace, request) {
  const start = Date.now();
  const result = await runHarness({
    cwd: workspace,
    tmpdir: session.runnerTmp,
    timeoutMs: 900_000,
    ...request,
  });
  return { result, start, end: Date.now() };
}

function harnessStarted(call) {
  return call.result.status === 'HARNESS_COMPLETED'
    && call.result.sessionStarted === true
    && call.result.turnStarted === true;
}

function compactMessage(result) {
  return String(result.finalAssistantMessage ?? 'none').replace(/\s+/gu, ' ').slice(0, 500);
}

function preSessionHarnessFailure(status) {
  return new Set(['HARNESS_INIT_FAILED', 'HARNESS_TIMEOUT', 'HARNESS_PROTOCOL_ERROR', 'HARNESS_CAPABILITY_MISSING']).has(status);
}

export async function runLiveStages() {
  const stages = [];
  const calls = [];
  const session = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
  let reviewerSession = null;
  let bSession = null;
  let cSession = null;
  try {
    const workspace = path.join(session.workspaces, 'critical-fixture');
    await fs.mkdir(workspace, { recursive: true });
    const deterministic = await runDeterministicStages({ workspace });
    stages.push(...deterministic.stages);
    if (deterministic.status !== 'PRE_PILOT_REHEARSAL_READY') {
      return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls };
    }
    const { spec } = deterministic.fixture;

    const executeCall = await harnessStage(session, workspace, {
      model: 'GPT-5.6-Luna', effort: 'high', sandbox: 'workspace-write',
      prompt: await launcherPrompt({
        launcher: EXECUTE_LAUNCHER,
        skill: EXECUTOR_SKILL,
        spec,
        operation: 'EXECUTE_SLICE',
        extra: 'The approved implementation is intentionally tiny. A valid runner BLOCKED result is terminal for this rehearsal stage: persist it truthfully and stop with no second EXECUTE.',
      }),
    });
    calls.push({ stage: 'R06', purpose: 'live EXECUTE_SLICE', model: 'GPT-5.6-Luna', effort: 'high', status: executeCall.result.status, retryCount: 0 });
    const afterExecute = await inspectExecutionState(spec).catch(() => null);
    const implementationChecks = afterExecute?.tasks?.get('slice-01')?.implementationChecks ?? [];
    const r06 = harnessStarted(executeCall)
      && afterExecute?.state === 'IMPLEMENTED_AWAITING_VALIDATION'
      && implementationChecks.length === 1
      && implementationChecks[0].status === 'TESTS_PASS';
    stages.push(r06
      ? pass('R06', 'EXECUTION', 'HARNESS_COMPLETED; TESTS_PASS; 1 implementation-check; IMPLEMENTED_AWAITING_VALIDATION')
      : fail('R06', preSessionHarnessFailure(executeCall.result.status) ? 'HARNESS' : 'EXECUTION', `harness=${executeCall.result.status}; state=${afterExecute?.state ?? 'unreadable'}; result=${compactMessage(executeCall.result)}`));
    if (!r06) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls };

    const validateCall = await harnessStage(session, workspace, {
      model: 'GPT-5.6-Luna', effort: 'high', sandbox: 'workspace-write',
      prompt: await launcherPrompt({ launcher: VALIDATE_LAUNCHER, skill: QUALITY_SKILL, spec, operation: 'VALIDATE_SLICE' }),
    });
    calls.push({ stage: 'R07', purpose: 'live VALIDATE_SLICE', model: 'GPT-5.6-Luna', effort: 'high', status: validateCall.result.status, retryCount: 0 });
    const afterValidate = await inspectExecutionState(spec).catch(() => null);
    const attempts = afterValidate?.tasks?.get('slice-01')?.attempts ?? [];
    const r07 = harnessStarted(validateCall)
      && afterValidate?.state === 'COMPLETE'
      && attempts.length === 1
      && attempts[0].status === 'PASS';
    stages.push(r07
      ? pass('R07', 'EXECUTION', 'formal PASS persisted; Effective Validation Base present; state=COMPLETE')
      : fail('R07', preSessionHarnessFailure(validateCall.result.status) ? 'HARNESS' : 'RUNNER_SEMANTIC', `harness=${validateCall.result.status}; state=${afterValidate?.state ?? 'unreadable'}; result=${compactMessage(validateCall.result)}`));
    if (!r07) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls };

    const terminal = await inspectExecutionState(spec);
    const task = terminal.tasks.get('slice-01');
    const r08 = terminal.state === 'COMPLETE'
      && terminal.stale === false
      && terminal.activeFindings.length === 0
      && terminal.activeDivergences.length === 0
      && terminal.activeDelegationBlockers.length === 0
      && task.base !== null;
    stages.push(r08
      ? pass('R08', 'EXECUTION', 'COMPLETE; authority intact; no active finding/divergence/delegation blocker; final ownership valid')
      : fail('R08', 'EXECUTION', 'terminal deterministic readback failed'));
    if (!r08) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls };

    const executionBeforeReadiness = await treeHash(path.join(spec, 'execution'));
    const readinessCall = await harnessStage(session, workspace, {
      model: 'GPT-5.6-Luna', effort: 'high', sandbox: 'workspace-write',
      prompt: await launcherPrompt({
        launcher: READINESS_LAUNCHER,
        skill: LIFECYCLE_SKILL,
        spec,
        operation: 'SPEC_READINESS GLOBAL',
        extra: 'After a semantic GLOBAL READY verdict, create the canonical ephemeral attestation at the exact shell path "$TMPDIR/rehearsal-readiness-attestation.json" for the next fresh session. Do not modify execution artifacts.',
      }),
    });
    calls.push({ stage: 'R09', purpose: 'GLOBAL READINESS', model: 'GPT-5.6-Luna', effort: 'high', status: readinessCall.result.status, retryCount: 0 });
    const executionAfterReadiness = await treeHash(path.join(spec, 'execution'));
    const attestation = path.join(session.runnerTmp, 'rehearsal-readiness-attestation.json');
    const r09 = harnessStarted(readinessCall)
      && /\bREADY\b/u.test(readinessCall.result.finalAssistantMessage ?? '')
      && executionBeforeReadiness === executionAfterReadiness
      && await fs.stat(attestation).then((entry) => entry.isFile()).catch(() => false);
    stages.push(r09
      ? pass('R09', 'LIFECYCLE', 'GLOBAL READY; execution byte-identical; canonical attestation created')
      : fail('R09', readinessCall.result.status.startsWith('HARNESS_') ? 'HARNESS' : 'LIFECYCLE', `harness=${readinessCall.result.status}; executionPreserved=${executionBeforeReadiness === executionAfterReadiness}`));
    if (!r09) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls };

    const closeCall = await harnessStage(session, workspace, {
      model: 'GPT-5.6-Sol', effort: 'high', sandbox: 'workspace-write',
      prompt: await launcherPrompt({
        launcher: CLOSE_LAUNCHER,
        skill: LIFECYCLE_SKILL,
        spec,
        operation: 'SPEC_CLOSE',
        extra: 'Use the canonical attestation at "$TMPDIR/rehearsal-readiness-attestation.json". Close lifecycle only and preserve the execution tree byte-identically.',
      }),
    });
    calls.push({ stage: 'R10', purpose: 'SPEC CLOSE', model: 'GPT-5.6-Sol', effort: 'high', status: closeCall.result.status, retryCount: 0 });
    const executionAfterClose = await treeHash(path.join(spec, 'execution'));
    const afterClose = await inspectExecutionState(spec).catch(() => null);
    const closedFeature = await fs.readFile(path.join(spec, 'feature_spec.md'), 'utf8');
    const r10 = harnessStarted(closeCall)
      && /SPEC_CLOSED/u.test(closeCall.result.finalAssistantMessage ?? '')
      && executionAfterClose === executionAfterReadiness
      && afterClose?.state === 'COMPLETE'
      && /status: closed/u.test(closedFeature);
    stages.push(r10
      ? pass('R10', 'LIFECYCLE', 'SPEC_CLOSED; execution byte-identical; execution remains COMPLETE')
      : fail('R10', closeCall.result.status.startsWith('HARNESS_') ? 'HARNESS' : 'LIFECYCLE', `harness=${closeCall.result.status}; state=${afterClose?.state ?? 'unreadable'}`));
    if (!r10) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls };

    reviewerSession = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
    const reviewerWorkspace = path.join(reviewerSession.workspaces, 'reviewer');
    await fs.mkdir(reviewerWorkspace, { recursive: true });
    const diff = spawnSync('git', ['diff', '--', 'agents', 'templates/prompts', 'scripts', 'benchmarks/sentinel-todo', 'maintenance/p0-evidence'], {
      cwd: REPOSITORY_ROOT, encoding: 'utf8', shell: false,
    });
    await fs.writeFile(path.join(reviewerWorkspace, 'review-input.md'), [
      '# Pre-pilot correction review',
      '',
      '- Base: 29b4d6f1979d8d2590260b4888cf15b696631961',
      '- Pilot blocker: runner compared canonical authority with raw shared/requirements.md SHA.',
      '- Canonical rule: runner must use official execution preflight; raw lifecycle file hashes are forbidden.',
      '- BLOCKED rule: valid runner BLOCKED terminates the current benchmark Case with zero automatic re-entry.',
      '',
      '## R01-R10',
      ...stages.map((stage) => `- ${stage.id}: ${stage.result} — ${stage.evidence}`),
      '',
      '## Relevant diff',
      '```diff',
      diff.stdout,
      '```',
    ].join('\n'), 'utf8');
    const reviewerPrompt = [
      'Read only review-input.md in this reviewer workspace. Do not modify files.',
      'Answer exactly PASS or BLOCKING_FINDING followed by compact evidence.',
      'Check: runtime-owned canonical authority; no raw shared or feature hash authority; drift detection retained; Codex/Claude equivalence; valid BLOCKED stops benchmark re-entry; R06 TESTS_PASS; R07 COMPLETE; R09/R10 preserve execution; and any concrete blocker to a new Production Pilot.',
    ].join('\n');
    const reviewerCall = await harnessStage(reviewerSession, reviewerWorkspace, {
      model: 'GPT-5.6-Sol', effort: 'high', sandbox: 'read-only', prompt: reviewerPrompt,
    });
    calls.push({ stage: 'R11', purpose: 'independent correction reviewer', model: 'GPT-5.6-Sol', effort: 'high', status: reviewerCall.result.status, retryCount: 0 });
    const r11 = harnessStarted(reviewerCall)
      && /^PASS\b/u.test((reviewerCall.result.finalAssistantMessage ?? '').trim());
    stages.push(r11
      ? pass('R11', 'REVIEWER', 'reviewer session started and returned PASS')
      : fail('R11', reviewerCall.result.status.startsWith('HARNESS_') ? 'HARNESS' : 'REVIEWER', `harness=${reviewerCall.result.status}; verdict=${reviewerCall.result.finalAssistantMessage ?? 'none'}`));
    if (!r11) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls };

    bSession = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
    cSession = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
    const bWorkspace = path.join(bSession.workspaces, 'b-smoke');
    const cWorkspace = path.join(cSession.workspaces, 'c-smoke');
    await fs.mkdir(bWorkspace, { recursive: true });
    await fs.mkdir(cWorkspace, { recursive: true });
    await fs.writeFile(path.join(bWorkspace, 'marker.txt'), 'B_ONLY_71f2\n', 'utf8');
    await fs.writeFile(path.join(cWorkspace, 'marker.txt'), 'C_ONLY_9ac4\n', 'utf8');
    const smokePrompt = (name, token) => [
      `This is isolated smoke ${name}.`,
      'Read marker.txt in your current working directory.',
      'Using Node, create a temporary directory under inherited TMPDIR, write/read a marker with the same token, then remove that temporary directory.',
      `Write smoke-result.txt in the current working directory containing exactly ${token} and report cwd identity plus os.tmpdir() identity.`,
      'Do not inspect parent directories or any sibling workspace.',
    ].join('\n');
    let bEnd;
    let cEnd;
    const bStart = Date.now();
    const bPromise = runHarness({
      cwd: bWorkspace, tmpdir: bSession.runnerTmp, timeoutMs: 300_000,
      model: 'GPT-5.6-Luna', effort: 'medium', sandbox: 'workspace-write', prompt: smokePrompt('B', 'B_ONLY_71f2'),
    }).finally(() => { bEnd = Date.now(); });
    const cStart = Date.now();
    const cPromise = runHarness({
      cwd: cWorkspace, tmpdir: cSession.runnerTmp, timeoutMs: 300_000,
      model: 'GPT-5.6-Luna', effort: 'medium', sandbox: 'workspace-write', prompt: smokePrompt('C', 'C_ONLY_9ac4'),
    }).finally(() => { cEnd = Date.now(); });
    const [bResult, cResult] = await Promise.all([bPromise, cPromise]);
    calls.push(
      { stage: 'R12-B', purpose: 'parallel harness B smoke', model: 'GPT-5.6-Luna', effort: 'medium', status: bResult.status, retryCount: 0 },
      { stage: 'R12-C', purpose: 'parallel harness C smoke', model: 'GPT-5.6-Luna', effort: 'medium', status: cResult.status, retryCount: 0 },
    );
    const overlap = Math.max(bStart, cStart) <= Math.min(bEnd, cEnd);
    const bMarker = await fs.readFile(path.join(bWorkspace, 'smoke-result.txt'), 'utf8').catch(() => '');
    const cMarker = await fs.readFile(path.join(cWorkspace, 'smoke-result.txt'), 'utf8').catch(() => '');
    const r12 = bResult.status === 'HARNESS_COMPLETED'
      && cResult.status === 'HARNESS_COMPLETED'
      && bResult.sessionStarted === true
      && cResult.sessionStarted === true
      && overlap
      && bWorkspace !== cWorkspace
      && bSession.runnerTmp !== cSession.runnerTmp
      && bMarker.trim() === 'B_ONLY_71f2'
      && cMarker.trim() === 'C_ONLY_9ac4';
    stages.push(r12
      ? pass('R12', 'PARALLEL_ORCHESTRATION', 'B/C sessions completed; intervals overlap; CWD/TMPDIR/output isolated')
      : fail('R12', 'PARALLEL_ORCHESTRATION', `B=${bResult.status}; C=${cResult.status}; overlap=${overlap}`));
    return { status: r12 ? 'PRE_PILOT_REHEARSAL_READY' : 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls };
  } finally {
    if (cSession !== null) await cleanupManagedBenchmarkSession(cSession);
    if (bSession !== null) await cleanupManagedBenchmarkSession(bSession);
    if (reviewerSession !== null) await cleanupManagedBenchmarkSession(reviewerSession);
    await cleanupManagedBenchmarkSession(session);
  }
}

const FINAL_COMMANDS = Object.freeze([
  ['git diff --check', 'git', ['diff', '--check'], REPOSITORY_ROOT],
  ['benchmark verify', process.execPath, [path.join(REPOSITORY_ROOT, 'benchmarks/sentinel-todo/runtime/benchmark.mjs'), 'verify'], REPOSITORY_ROOT],
  ['seed tests', process.execPath, ['--test'], path.join(REPOSITORY_ROOT, 'benchmarks/sentinel-todo/seed')],
  ['benchmark contracts', process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/test-benchmark-contract.mjs')], REPOSITORY_ROOT],
  ['environment deterministic tests', process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/test-benchmark-environment.mjs')], REPOSITORY_ROOT],
  ['Agent Harness deterministic tests', process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/test-benchmark-agent-harness.mjs')], REPOSITORY_ROOT],
  ['execution contracts', process.execPath, ['--test', path.join(REPOSITORY_ROOT, 'scripts/test-execution-contract.mjs')], REPOSITORY_ROOT],
  ['validation-runner contracts', process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/test-validation-runner-contract.mjs')], REPOSITORY_ROOT],
  ['launcher contracts', process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/test-launcher-contract.mjs')], REPOSITORY_ROOT],
  ['repository contracts', process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/test-repository-contract.mjs')], REPOSITORY_ROOT],
  ['rehearsal deterministic contracts', process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/test-benchmark-rehearsal.mjs')], REPOSITORY_ROOT],
  ['validate.sh --no-smoke', 'bash', [path.join(REPOSITORY_ROOT, 'scripts/validate.sh'), '--no-smoke'], REPOSITORY_ROOT],
]);

export function runFinalSuite() {
  const checks = FINAL_COMMANDS.map(([name, command, args, cwd]) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, timeout: 900_000 });
    return { name, result: result.status === 0 ? 'PASS' : 'FAIL', exitCode: result.status, summary: (result.stderr || result.stdout).trim().split('\n').at(-1) ?? '' };
  });
  return {
    status: checks.every((check) => check.result === 'PASS') ? 'R13_PASS' : 'R13_FAIL',
    checks,
  };
}

export async function main(argv) {
  const [command] = argv;
  if (!new Set(['deterministic', 'live', 'all']).has(command)) {
    process.stderr.write('usage: benchmark-rehearsal.mjs deterministic|live|all\n');
    return 2;
  }
  let report;
  if (command === 'deterministic') report = await runDeterministicStages();
  else report = await runLiveStages();
  if (command === 'all' && report.status === 'PRE_PILOT_REHEARSAL_READY') {
    const final = runFinalSuite();
    report.stages.push(final.status === 'R13_PASS'
      ? pass('R13', 'TEST_REGRESSION', `${final.checks.length}/${final.checks.length} final checks PASS`)
      : fail('R13', 'TEST_REGRESSION', final.checks.filter((check) => check.result === 'FAIL').map((check) => check.name).join(', ')));
    report.finalChecks = final.checks;
    report.status = final.status === 'R13_PASS' ? 'PRE_PILOT_REHEARSAL_READY' : 'PRE_PILOT_REHEARSAL_BLOCKED';
  }
  process.stdout.write(`${JSON.stringify(report, (key, value) => ['fixture', 'ownedRoot'].includes(key) ? undefined : value, 2)}\n`);
  return report.status === 'PRE_PILOT_REHEARSAL_READY' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: 'PRE_PILOT_REHEARSAL_BLOCKED',
      stages: [],
      failure: { category: 'ENVIRONMENT', message: error.message },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
