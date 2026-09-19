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
  validateExecutionCandidate,
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

function artifactRelativePath(artifact, target) {
  return path.relative(path.dirname(artifact), target).split(path.sep).join('/');
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function inspectHarnessWorkspaceGitGeometry({ session, workspace }) {
  const metadata = await fs.lstat(workspace).catch(() => null);
  const directoryExists = metadata?.isDirectory() === true && metadata.isSymbolicLink() === false;
  const canonicalWorkspace = directoryExists ? await fs.realpath(workspace) : path.resolve(workspace);
  const canonicalWorkspacesRoot = await fs.realpath(session.workspaces);
  const canonicalRepository = await fs.realpath(REPOSITORY_ROOT);
  const canonical = directoryExists && canonicalWorkspace === path.resolve(workspace);
  const managed = canonical && canonicalWorkspace !== canonicalWorkspacesRoot
    && pathIsWithin(canonicalWorkspace, canonicalWorkspacesRoot);
  const outsideRepository = canonical && !pathIsWithin(canonicalWorkspace, canonicalRepository);
  const gitPath = path.join(canonicalWorkspace, '.git');
  const gitExists = directoryExists && await fs.lstat(gitPath).then(() => true).catch(() => false);
  const revParse = directoryExists
    ? spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: canonicalWorkspace, encoding: 'utf8', shell: false,
    })
    : { status: null, stdout: '' };
  const revParseTrue = revParse.status === 0 && revParse.stdout.trim() === 'true';
  const gitDirectory = revParseTrue
    ? spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: canonicalWorkspace, encoding: 'utf8', shell: false,
    }).stdout.trim()
    : null;
  const structuralReady = directoryExists && canonical && managed && outsideRepository;
  const status = structuralReady && gitExists && revParseTrue
    ? 'HARNESS_WORKSPACE_GIT_READY'
    : (structuralReady && !revParseTrue
      ? 'HARNESS_WORKSPACE_GIT_NOT_READY'
      : 'HARNESS_WORKSPACE_GEOMETRY_BLOCKED');
  return Object.freeze({
    status,
    workspace: canonicalWorkspace,
    directoryExists,
    canonical,
    managed,
    outsideRepository,
    gitExists,
    revParseExitCode: revParse.status,
    revParseTrue,
    gitDirectory,
    sessionRoot: session.root,
    runnerTmp: session.runnerTmp,
  });
}

export async function prepareHarnessWorkspace(session, name) {
  const requested = path.join(session.workspaces, name);
  await fs.mkdir(requested, { recursive: true });
  const before = await inspectHarnessWorkspaceGitGeometry({ session, workspace: requested });
  if (before.status !== 'HARNESS_WORKSPACE_GIT_NOT_READY') {
    throw new Error(`rehearsal workspace pre-init geometry=${before.status}`);
  }
  const initialized = spawnSync('git', ['init', '--quiet'], {
    cwd: before.workspace, encoding: 'utf8', shell: false,
  });
  if (initialized.status !== 0) {
    throw new Error(`rehearsal workspace git init failed: ${initialized.stderr.trim()}`);
  }
  const after = await inspectHarnessWorkspaceGitGeometry({ session, workspace: before.workspace });
  if (after.status !== 'HARNESS_WORKSPACE_GIT_READY') {
    throw new Error(`rehearsal workspace post-init geometry=${after.status}`);
  }
  return after.workspace;
}

function replaceSection(text, heading, content) {
  const pattern = new RegExp(`(## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, 'u');
  if (!pattern.test(text)) throw new Error(`fixture section is absent: ${heading}`);
  return text.replace(pattern, `$1${content}\n`);
}

function section(text, heading) {
  const match = new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'u').exec(text);
  if (match === null) throw new Error(`fixture section is absent: ${heading}`);
  return match[1];
}

function fixturePathAuthority(workspace, spec) {
  const implementation = path.join(workspace, 'src/invitation.mjs');
  const globalPlan = path.join(spec, 'execution/plan.md');
  const slicePlan = path.join(spec, 'execution/plans/slice-01.md');
  const sliceTask = path.join(spec, 'execution/tasks/slice-01.md');
  return Object.freeze({
    implementation,
    globalPlan,
    slicePlan,
    sliceTask,
    globalImplementation: artifactRelativePath(globalPlan, implementation),
    detailImplementation: artifactRelativePath(slicePlan, implementation),
    taskImplementation: artifactRelativePath(sliceTask, implementation),
  });
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
  const paths = fixturePathAuthority(path.dirname(spec), spec);
  const globalSource = artifactRelativePath(path.join(execution, 'plan.md'), feature);
  const detailSource = artifactRelativePath(path.join(plans, 'slice-01.md'), feature);
  const taskSource = artifactRelativePath(path.join(tasks, 'slice-01.md'), feature);

  const global = approved(omitInitialRecoveryFields(replaceAll(await fs.readFile(PLAN_TEMPLATE, 'utf8'), [
    ['`<relative path>`', `\`${globalSource}\``],
    ['sha256:<64hex>', `sha256:${authority}`],
    ['<positive integer>', '1'],
    ['<compact objective>', 'Implement deterministic expired-invitation rejection'],
    ['<compact strategy>', 'Complete one bounded acceptance function and validate UTC rejection, the public error envelope, and absence of participation'],
    ['01 - <name>', '01 - Invitation expiration'],
    ['<result>', 'expired invitations are rejected with the stable public envelope and no participation'],
    ['`<artifact-relative path>`; <optional conceptual area>', `\`${paths.globalImplementation}\`; invitation expiration`],
    ['<risk, boundary, or explicit final integration slice>', 'UTC equality, public envelope, and no-participation behavior are covered by the focused test'],
  ])));
  await fs.writeFile(path.join(execution, 'plan.md'), global, 'utf8');

  const slicePlan = approved(replaceAll(await fs.readFile(SLICE_PLAN_TEMPLATE, 'utf8'), [
    ['<Name>', 'Invitation expiration'],
    ['`<relative path>`', `\`${detailSource}\``],
    ['sha256:<64hex>', `sha256:${authority}`],
    ['<positive integer>', '1'],
    ['<One coherent delivery and how it is observed.>', 'Implement expired-invitation rejection and observe the UTC decision, stable HTTP envelope, and participation boundary through the focused Node test.'],
    ['<included work>', 'Implement `acceptInvitation` in `src/invitation.mjs` so an expired invitation returns the existing public error envelope without creating participation.'],
    ['<excluded work and boundary with later slices>', 'No lifecycle, storage-schema, router, or delivery-channel changes.'],
    ['`<artifact-relative path>` — <optional contract, subsystem, test area, or explanation>', `\`${paths.detailImplementation}\` — invitation expiration acceptance boundary`],
    ['<earlier slice or none>', 'none'],
    ['<risk and mitigation>', 'UTC boundary or side-effect drift; cover equality, the exact public envelope, and zero participation for rejection.'],
    ['<bounded approach>', 'Change only the bounded acceptance function implementation.'],
    ['<test, command, suite, or observable check>', 'node --test'],
    ['<objective result and preserved boundary>', 'Focused tests pass and no unrelated path changes.'],
  ]));
  await fs.writeFile(path.join(plans, 'slice-01.md'), slicePlan, 'utf8');

  const tasksIndex = replaceAll(await fs.readFile(TASKS_TEMPLATE, 'utf8'), [
    ['01 - <name>', '01 - Invitation expiration'],
    ['<observable delivery>', 'expired invitations are rejected with the stable envelope and no participation'],
  ]);
  await fs.writeFile(path.join(execution, 'tasks.md'), tasksIndex, 'utf8');

  const task = replaceAll(await fs.readFile(SLICE_TASK_TEMPLATE, 'utf8'), [
    ['<Name>', 'Invitation expiration'],
    ['`<relative path>`', `\`${taskSource}\``],
    ['sha256:<64hex>', `sha256:${authority}`],
    ['<positive integer>', '1'],
    ['<task>', 'Implement `acceptInvitation` using the service UTC boundary, the stable expired-invitation HTTP envelope, and no participation on rejection'],
    ['<result>', 'expired invitations return the stable 410 envelope without participation; active invitations create participation'],
    ['`<artifact-relative path>`; <optional conceptual area>', `\`${paths.taskImplementation}\`; invitation expiration acceptance boundary`],
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
  await fs.mkdir(path.join(workspace, 'docs/core'), { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'docs/core/CONTRACTS.md'),
    '# Contracts\n\n## 5. Expired invitation\n\nAn expired invitation returns HTTP 410 with `{ "error": { "code": "INVITATION_EXPIRED", "message": "Invitation has expired" } }` and creates no participation.\n',
    'utf8',
  );
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(workspace, 'src/invitation.mjs'),
    'export function acceptInvitation(invitation, now, participations) {\n  throw new Error("TODO: implement expired-invitation rejection");\n}\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(workspace, 'test/invitation.test.mjs'),
    `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { acceptInvitation } from '../src/invitation.mjs';\n\ntest('expired invitation returns the stable envelope without participation', () => {\n  const participations = [];\n  const response = acceptInvitation(\n    { id: 'inv-expired', expiresAt: '2030-01-01T00:00:00.000Z' },\n    '2030-01-01T00:00:00.000Z',\n    participations,\n  );\n  assert.deepEqual(response, {\n    status: 410,\n    body: { error: { code: 'INVITATION_EXPIRED', message: 'Invitation has expired' } },\n  });\n  assert.deepEqual(participations, []);\n});\n\ntest('active invitation creates participation', () => {\n  const participations = [];\n  const response = acceptInvitation(\n    { id: 'inv-active', expiresAt: '2030-01-01T00:00:00.000Z' },\n    '2029-12-31T23:59:59.999Z',\n    participations,\n  );\n  assert.deepEqual(response, { status: 204, body: null });\n  assert.deepEqual(participations, [{ invitationId: 'inv-active' }]);\n});\n`,
    'utf8',
  );
  const authority = await writeCanonicalExecution(spec);
  const state = await inspectExecutionState(spec);
  if (state.state !== 'MATERIALIZED_PRISTINE') throw new Error(`fixture state=${state.state}`);
  return { workspace, spec, authority, paths: fixturePathAuthority(workspace, spec) };
}

function extractFixturePathClaims({ globalPlan, slicePlan, sliceTask, taskText, requirePostR06 }) {
  const globalText = globalPlan.text;
  const slicePlanText = slicePlan.text;
  const checklist = section(taskText, 'Checklist');
  const globalStored = globalText.match(/\| Implementation filesystem path \(outside generated execution artifacts\): `([^`]+)`; invitation expiration \(plain-text description\) \| plans\/slice-01\.md \|/u)?.[1];
  const detailStored = section(slicePlanText, 'Likely Areas').match(/^- Implementation filesystem path \(outside generated execution artifacts\): `([^`]+)`/mu)?.[1];
  const checklistStored = checklist.match(/expected areas: `([^`]+)`/u)?.[1];
  if ([globalStored, detailStored, checklistStored].some((value) => value === undefined)) {
    throw new Error('canonical fixture path claims could not be read');
  }
  const claims = [
    { artifact: globalPlan.path, label: 'Global plan expected area', storedPath: globalStored, hash: null },
    { artifact: slicePlan.path, label: 'Slice plan likely area', storedPath: detailStored, hash: null },
    { artifact: sliceTask.path, label: 'Task checklist expected area', storedPath: checklistStored, hash: null },
  ];
  if (!requirePostR06) return claims;
  const changed = section(taskText, 'Changed Areas').match(/^- `([^`]+)`$/mu)?.[1];
  const tested = section(taskText, 'Implementation Test Evidence').match(/^- Tested state:\n  - `([^`]+)` \| sha256:([0-9a-f]{64})$/mu);
  if (changed === undefined || tested === null) throw new Error('POST-R06 file-backed path claims could not be read');
  claims.push(
    { artifact: sliceTask.path, label: 'Changed Areas', storedPath: changed, hash: null },
    { artifact: sliceTask.path, label: 'Implementation tested state', storedPath: tested[1], hash: tested[2] },
  );
  return claims;
}

export async function inspectFixturePathBasis({ workspace, spec, requirePostR06 = true }) {
  const expected = path.join(workspace, 'src/invitation.mjs');
  const globalPlanPath = path.join(spec, 'execution/plan.md');
  const slicePlanPath = path.join(spec, 'execution/plans/slice-01.md');
  const sliceTaskPath = path.join(spec, 'execution/tasks/slice-01.md');
  const [globalText, slicePlanText, taskText] = await Promise.all([
    fs.readFile(globalPlanPath, 'utf8'),
    fs.readFile(slicePlanPath, 'utf8'),
    fs.readFile(sliceTaskPath, 'utf8'),
  ]);
  const claims = extractFixturePathClaims({
    globalPlan: { path: globalPlanPath, text: globalText },
    slicePlan: { path: slicePlanPath, text: slicePlanText },
    sliceTask: { path: sliceTaskPath },
    taskText,
    requirePostR06,
  });
  const expectedCanonical = await fs.realpath(expected).catch(() => path.resolve(expected));
  const rows = await Promise.all(claims.map(async (claim) => {
    const resolved = path.resolve(path.dirname(claim.artifact), claim.storedPath);
    const canonical = await fs.realpath(resolved).catch(() => path.resolve(resolved));
    const exists = await fs.stat(resolved).then((entry) => entry.isFile()).catch(() => false);
    const actualHash = exists ? sha256(await fs.readFile(resolved)) : null;
    const inWorkspace = pathIsWithin(canonical, workspace);
    const outsideSpec = !pathIsWithin(canonical, spec);
    const expectedTarget = canonical === expectedCanonical;
    const hashMatches = claim.hash === null || claim.hash === actualHash;
    return {
      artifact: claim.artifact,
      label: claim.label,
      storedPath: claim.storedPath,
      resolvedPath: canonical,
      expectedTarget: expectedCanonical,
      exists,
      inWorkspace,
      outsideSpec,
      expectedTargetMatches: expectedTarget,
      hash: claim.hash === null ? 'not_applicable' : (hashMatches ? 'PASS' : 'FAIL'),
      result: exists && inWorkspace && outsideSpec && expectedTarget && hashMatches ? 'PASS' : 'FAIL',
    };
  }));
  const passed = rows.every((row) => row.result === 'PASS');
  return Object.freeze({
    status: passed ? 'FIXTURE_PATH_BASIS_PASS' : 'FIXTURE_PATH_BASIS_BLOCKED',
    category: passed ? null : 'FIXTURE_PATH_BASIS',
    rows,
  });
}

export async function preparePostR06Fixture(fixture) {
  const implementation = fixture.paths.implementation;
  await fs.writeFile(
    implementation,
    `export function acceptInvitation(invitation, now, participations) {\n  if (Date.parse(now) >= Date.parse(invitation.expiresAt)) {\n    return {\n      status: 410,\n      body: { error: { code: 'INVITATION_EXPIRED', message: 'Invitation has expired' } },\n    };\n  }\n  participations.push({ invitationId: invitation.id });\n  return { status: 204, body: null };\n}\n`,
    'utf8',
  );
  const tests = spawnSync(process.execPath, ['--test'], {
    cwd: fixture.workspace, encoding: 'utf8', shell: false,
  });
  if (tests.status !== 0) throw new Error(`POST-R06 fixture tests failed: ${(tests.stderr || tests.stdout).trim()}`);
  const implementationHash = sha256(await fs.readFile(implementation));
  const candidateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-post-r06-candidate-')));
  try {
    const candidateExecution = path.join(candidateRoot, 'execution');
    await fs.cp(path.join(fixture.spec, 'execution'), candidateExecution, { recursive: true });
    const candidateTask = path.join(candidateExecution, 'tasks/slice-01.md');
    let task = await fs.readFile(candidateTask, 'utf8');
    const stored = fixture.paths.taskImplementation;
    task = task.replace('- [ ] 1.1', '- [x] 1.1');
    task = replaceSection(task, 'Changed Areas', `- \`${stored}\``);
    task = replaceSection(task, 'Implementation Test Evidence', `### implementation-check-01

- Automatic check round: 1/3
- Status: TESTS_PASS
- HEAD: not_available
- Tested scope: expired-invitation acceptance boundary
- Tested state:
  - \`${stored}\` | sha256:${implementationHash}
- Discovery sources: approved task, package scripts, and focused repository test
- Discovery actions: inspected package.json and test/invitation.test.mjs
- Verification types considered: focused automated Node test
- Commands:
  - \`node --test\` | exit:0
- Selected checks: node --test
- Selection rationale: focused authoritative behavior check
- Coverage: UTC equality rejection, stable HTTP envelope, zero participation on rejection, and active participation creation
- Failures: none
- Blockers: none
- Unexpected workspace effects: none
- Persistence summary: TESTS_PASS persisted for the current implementation bytes.`);
    task = replaceSection(task, 'Diff Summary', '- Implemented deterministic expired-invitation rejection with the stable envelope and no rejected participation.');
    await fs.writeFile(candidateTask, task, 'utf8');
    const candidate = await validateExecutionCandidate(fixture.spec, candidateExecution);
    if (candidate.state !== 'IMPLEMENTED_AWAITING_VALIDATION') {
      throw new Error(`POST-R06 candidate state=${candidate.state}`);
    }
    await fs.copyFile(candidateTask, path.join(fixture.spec, 'execution/tasks/slice-01.md'));
    const readback = await inspectExecutionState(fixture.spec);
    if (readback.state !== 'IMPLEMENTED_AWAITING_VALIDATION') {
      throw new Error(`POST-R06 readback state=${readback.state}`);
    }
    return Object.freeze({ state: readback.state, implementationHash, storedPath: stored });
  } finally {
    await fs.rm(candidateRoot, { recursive: true, force: true });
  }
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

async function runnerContractMutation(from, to) {
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
      await fs.writeFile(file, source.replace(from, to), 'utf8');
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
    const authorityMutation = await runnerContractMutation(
      'Não calcule Requirements authority por SHA direto de `shared/requirements.md`',
      'Calcule o SHA de `shared/requirements.md` como Requirements authority',
    );
    const exactCommandMutation = await runnerContractMutation(
      'Nunca abrevie path ou argumento',
      'Você pode abreviar path ou argumento',
    );
    const testedStateBasisMutation = await runnerContractMutation(
      'Em qualquer operação, todo caminho file-backed de `Estado testado` é task-relative',
      'Somente em VALIDATE_SLICE, o Estado testado tem um caminho relativo',
    );
    const r03 = canonicalContracts.status === 0
      && authorityMutation.status === 1
      && /CONTRACT_ERROR\[R019_REQUIREMENTS_AUTHORITY\]/u.test(authorityMutation.stderr)
      && exactCommandMutation.status === 1
      && /CONTRACT_ERROR\[R020_EXACT_COMMANDS\]/u.test(exactCommandMutation.stderr)
      && testedStateBasisMutation.status === 1
      && /CONTRACT_ERROR\[R008_MANIFEST\]/u.test(testedStateBasisMutation.stderr);
    stages.push(r03
      ? pass('R03', 'RUNNER_SEMANTIC', 'runner v8 accepted; raw-file authority rejected as R019; abbreviated commands rejected as R020; ambiguous auxiliary Tested state basis rejected as R008')
      : fail('R03', 'RUNNER_SEMANTIC', 'runner authority/exact-command anti-regression failed'));
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
    const pristinePathGate = await inspectFixturePathBasis({
      workspace: target,
      spec: fixture.spec,
      requirePostR06: false,
    });
    const r05 = pristine.state === 'MATERIALIZED_PRISTINE'
      && pristine.currentFingerprint === fixture.authority
      && pristinePathGate.status === 'FIXTURE_PATH_BASIS_PASS';
    stages.push(r05
      ? pass('R05', 'EXECUTION', `temporary critical fixture state=${pristine.state}; canonical fixture path gate PASS`)
      : fail('R05', pristinePathGate.category ?? 'EXECUTION', `fixture state=${pristine.state}; pathGate=${pristinePathGate.status}`));
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

export async function runIsolatedR07() {
  const session = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
  try {
    const workspace = path.join(session.workspaces, 'r06-r07-isolated');
    await fs.mkdir(workspace, { recursive: true });
    const fixture = await createCriticalFixture(workspace);
    const preState = await inspectExecutionState(fixture.spec);
    const executeCall = await harnessStage(session, workspace, {
      model: 'GPT-5.6-Luna', effort: 'high', sandbox: 'workspace-write',
      prompt: await launcherPrompt({
        launcher: EXECUTE_LAUNCHER,
        skill: EXECUTOR_SKILL,
        spec: fixture.spec,
        operation: 'EXECUTE_SLICE',
        extra: 'This is the isolated R06-to-R07 causal chain. Persist every file-backed execution-record path relative to the selected final tasks/slice-01.md artifact and stop after the official EXECUTE readback.',
      }),
    });
    const afterExecute = await inspectExecutionState(fixture.spec).catch(() => null);
    const executeTask = afterExecute?.tasks?.get('slice-01');
    const implementationChecks = executeTask?.implementationChecks ?? [];
    const r06 = preState.state === 'MATERIALIZED_PRISTINE'
      && harnessStarted(executeCall)
      && afterExecute?.state === 'IMPLEMENTED_AWAITING_VALIDATION'
      && implementationChecks.length === 1
      && implementationChecks[0].status === 'TESTS_PASS';
    if (!r06) {
      return {
        status: 'PRE_PILOT_REHEARSAL_BLOCKED',
        failure: {
          category: preSessionHarnessFailure(executeCall.result.status) ? 'HARNESS' : 'EXECUTION',
          message: compactMessage(executeCall.result),
        },
        preState: preState.state,
        postExecuteState: afterExecute?.state ?? 'unreadable',
        executeHarness: executeCall.result.status,
        liveCalls: 1,
      };
    }
    const gate = await inspectFixturePathBasis({ workspace, spec: fixture.spec, requirePostR06: true });
    if (gate.status !== 'FIXTURE_PATH_BASIS_PASS') {
      return {
        status: 'PRE_PILOT_REHEARSAL_BLOCKED',
        failure: { category: 'FIXTURE_PATH_BASIS_BLOCKED', message: 'POST-R06 fixture path gate rejected the fresh fixture before live validation' },
        preState: preState.state,
        postExecuteState: afterExecute.state,
        executeHarness: executeCall.result.status,
        pathGate: gate,
        liveCalls: 1,
      };
    }
    const validateCall = await harnessStage(session, workspace, {
      model: 'GPT-5.6-Luna', effort: 'high', sandbox: 'workspace-write',
      prompt: await launcherPrompt({ launcher: VALIDATE_LAUNCHER, skill: QUALITY_SKILL, spec: fixture.spec, operation: 'VALIDATE_SLICE' }),
    });
    const afterValidate = await inspectExecutionState(fixture.spec).catch(() => null);
    const task = afterValidate?.tasks?.get('slice-01');
    const attempts = task?.attempts ?? [];
    const complete = harnessStarted(validateCall)
      && afterValidate?.state === 'COMPLETE'
      && attempts.length === 1
      && attempts[0].status === 'PASS'
      && task?.base !== null;
    return {
      status: complete ? 'ISOLATED_R06_R07_COMPLETE' : 'PRE_PILOT_REHEARSAL_BLOCKED',
      failure: complete ? null : {
        category: afterValidate?.state === 'IMPLEMENTED_AWAITING_VALIDATION'
          && /path|manifest|ownership/iu.test(validateCall.result.finalAssistantMessage ?? '')
          ? 'FIXTURE_PATH_CORRECTION_DID_NOT_ADVANCE'
          : (preSessionHarnessFailure(validateCall.result.status) ? 'HARNESS' : 'RUNNER_SEMANTIC'),
        message: compactMessage(validateCall.result),
      },
      preState: preState.state,
      postExecuteState: afterExecute.state,
      changedAreas: executeTask.changedAreas,
      testedState: implementationChecks[0].testedState,
      pathGate: gate,
      executeHarness: executeCall.result.status,
      validateHarness: validateCall.result.status,
      mainSessionStarted: validateCall.result.sessionStarted === true,
      turnStarted: validateCall.result.turnStarted === true,
      runnerResult: attempts[0]?.status ?? (/(?:runner|validation)[^\n]{0,80}\bPASS\b/iu.test(validateCall.result.finalAssistantMessage ?? '') ? 'PASS' : 'not_persisted'),
      candidatePublication: complete ? 'accepted' : 'not_accepted',
      finalState: afterValidate?.state ?? 'unreadable',
      attemptCount: attempts.length,
      liveCalls: 2,
      finalMessage: compactMessage(validateCall.result),
    };
  } finally {
    await cleanupManagedBenchmarkSession(session);
  }
}

export async function runIsolatedR11() {
  const session = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
  try {
    const workspace = await prepareHarnessWorkspace(session, 'reviewer');
    await fs.writeFile(path.join(workspace, 'review-input.md'), [
      '# Isolated R11 reviewer smoke',
      '',
      '- Purpose: prove the reviewer provider session starts from a Git-backed managed workspace.',
      '- R01-R10: all PASS in the previous published rehearsal evidence.',
      '- Requested changes: none.',
      '',
      'Question: is this input legible with no structural blocker?',
    ].join('\n'), 'utf8');
    const preflight = await inspectHarnessWorkspaceGitGeometry({ session, workspace });
    if (preflight.status !== 'HARNESS_WORKSPACE_GIT_READY') {
      return {
        status: 'PRE_PILOT_REHEARSAL_BLOCKED',
        failure: { category: preflight.status, message: 'reviewer workspace failed rehearsal Git preflight' },
        preflight,
        liveCalls: 0,
      };
    }
    const call = await harnessStage(session, workspace, {
      model: 'GPT-5.6-Sol',
      effort: 'high',
      sandbox: 'read-only',
      prompt: [
        'Read review-input.md in the current workspace.',
        'Do not modify files.',
        'Respond PASS if the input is legible and there is no structural blocker; otherwise respond BLOCKING_FINDING.',
      ].join('\n'),
    });
    const passed = harnessStarted(call)
      && call.result.providerInvocationAccepted === true
      && /^PASS\b/u.test((call.result.finalAssistantMessage ?? '').trim())
      && call.result.retryCount === 0;
    return {
      status: passed ? 'ISOLATED_R11_PASS' : 'PRE_PILOT_REHEARSAL_BLOCKED',
      failure: passed ? null : {
        category: call.result.status,
        message: compactMessage(call.result),
      },
      preflight,
      model: 'GPT-5.6-Sol',
      effort: 'high',
      harness: call.result.status,
      providerInvocationAccepted: call.result.providerInvocationAccepted === true,
      sessionStarted: call.result.sessionStarted === true,
      turnStarted: call.result.turnStarted === true,
      semanticVerdict: compactMessage(call.result),
      providerErrorCategory: call.result.providerErrorCategory ?? null,
      capabilityFingerprint: call.result.capabilityFingerprint ?? null,
      retryCount: call.result.retryCount ?? 0,
      liveCalls: 1,
    };
  } finally {
    await cleanupManagedBenchmarkSession(session);
  }
}

async function runParallelHarnessSmoke() {
  const bSession = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
  const cSession = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
  let report = null;
  try {
    const bWorkspace = await prepareHarnessWorkspace(bSession, 'b-smoke');
    const cWorkspace = await prepareHarnessWorkspace(cSession, 'c-smoke');
    await fs.writeFile(path.join(bWorkspace, 'marker.txt'), 'B_ONLY_71f2\n', 'utf8');
    await fs.writeFile(path.join(cWorkspace, 'marker.txt'), 'C_ONLY_9ac4\n', 'utf8');
    const [bPreflight, cPreflight] = await Promise.all([
      inspectHarnessWorkspaceGitGeometry({ session: bSession, workspace: bWorkspace }),
      inspectHarnessWorkspaceGitGeometry({ session: cSession, workspace: cWorkspace }),
    ]);
    const independentGeometry = bWorkspace !== cWorkspace
      && bPreflight.gitDirectory !== cPreflight.gitDirectory
      && bSession.root !== cSession.root
      && bSession.runnerTmp !== cSession.runnerTmp;
    if (bPreflight.status !== 'HARNESS_WORKSPACE_GIT_READY'
      || cPreflight.status !== 'HARNESS_WORKSPACE_GIT_READY'
      || !independentGeometry) {
      report = {
        status: 'PRE_PILOT_REHEARSAL_BLOCKED',
        failure: { category: 'HARNESS_WORKSPACE_GIT_GEOMETRY', message: 'parallel smoke preflight failed' },
        b: { preflight: bPreflight },
        c: { preflight: cPreflight },
        overlap: false,
        isolation: false,
        liveCalls: 0,
      };
      return report;
    }
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
      cwd: bWorkspace,
      tmpdir: bSession.runnerTmp,
      timeoutMs: 300_000,
      model: 'GPT-5.6-Luna',
      effort: 'medium',
      sandbox: 'workspace-write',
      prompt: smokePrompt('B', 'B_ONLY_71f2'),
    }).finally(() => { bEnd = Date.now(); });
    const cStart = Date.now();
    const cPromise = runHarness({
      cwd: cWorkspace,
      tmpdir: cSession.runnerTmp,
      timeoutMs: 300_000,
      model: 'GPT-5.6-Luna',
      effort: 'medium',
      sandbox: 'workspace-write',
      prompt: smokePrompt('C', 'C_ONLY_9ac4'),
    }).finally(() => { cEnd = Date.now(); });
    const [bResult, cResult] = await Promise.all([bPromise, cPromise]);
    const overlap = Math.max(bStart, cStart) <= Math.min(bEnd, cEnd);
    const bMarker = await fs.readFile(path.join(bWorkspace, 'smoke-result.txt'), 'utf8').catch(() => '');
    const cMarker = await fs.readFile(path.join(cWorkspace, 'smoke-result.txt'), 'utf8').catch(() => '');
    const bMessage = bResult.finalAssistantMessage ?? '';
    const cMessage = cResult.finalAssistantMessage ?? '';
    const outputIsolated = bMarker.trim() === 'B_ONLY_71f2'
      && cMarker.trim() === 'C_ONLY_9ac4'
      && !bMarker.includes('C_ONLY_9ac4')
      && !cMarker.includes('B_ONLY_71f2')
      && !bMessage.includes('C_ONLY_9ac4')
      && !cMessage.includes('B_ONLY_71f2');
    const passed = bResult.status === 'HARNESS_COMPLETED'
      && cResult.status === 'HARNESS_COMPLETED'
      && bResult.sessionStarted === true
      && cResult.sessionStarted === true
      && bResult.turnStarted === true
      && cResult.turnStarted === true
      && overlap
      && independentGeometry
      && outputIsolated;
    report = {
      status: passed ? 'ISOLATED_R12_PASS' : 'PRE_PILOT_REHEARSAL_BLOCKED',
      failure: passed ? null : {
        category: 'PARALLEL_ORCHESTRATION',
        message: `B=${bResult.status}; C=${cResult.status}; overlap=${overlap}; outputIsolated=${outputIsolated}`,
      },
      b: {
        harness: bResult.status,
        sessionStarted: bResult.sessionStarted === true,
        turnStarted: bResult.turnStarted === true,
        preflight: bPreflight,
        marker: bMarker.trim(),
        retryCount: bResult.retryCount ?? 0,
      },
      c: {
        harness: cResult.status,
        sessionStarted: cResult.sessionStarted === true,
        turnStarted: cResult.turnStarted === true,
        preflight: cPreflight,
        marker: cMarker.trim(),
        retryCount: cResult.retryCount ?? 0,
      },
      overlap,
      isolation: independentGeometry && outputIsolated,
      liveCalls: 2,
    };
    return report;
  } finally {
    const cleanup = await Promise.allSettled([
      cleanupManagedBenchmarkSession(bSession),
      cleanupManagedBenchmarkSession(cSession),
    ]);
    const rootsRemoved = await Promise.all([
      fs.stat(bSession.root).then(() => false).catch(() => true),
      fs.stat(cSession.root).then(() => false).catch(() => true),
    ]);
    const cleanupPassed = cleanup.every((item) => item.status === 'fulfilled') && rootsRemoved.every(Boolean);
    if (report !== null) {
      report.cleanup = cleanupPassed ? 'PASS' : 'BLOCKED';
      if (!cleanupPassed) {
        report.status = 'PRE_PILOT_REHEARSAL_BLOCKED';
        report.failure = { category: 'CLEANUP', message: 'parallel managed session cleanup failed' };
      }
    }
  }
}

export async function runIsolatedR12() {
  return runParallelHarnessSmoke();
}

export async function runLiveStages() {
  const stages = [];
  const calls = [];
  const session = await createManagedBenchmarkSession({ repositoryRoot: REPOSITORY_ROOT });
  let reviewerSession = null;
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

    const preLivePathGate = await inspectFixturePathBasis({ workspace, spec, requirePostR06: true });
    if (preLivePathGate.status !== 'FIXTURE_PATH_BASIS_PASS') {
      stages.push(fail('R07', 'FIXTURE_PATH_BASIS', 'pre-live path gate rejected POST-R06 fixture; zero VALIDATE_SLICE calls started'));
      return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls, preLivePathGate };
    }

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
      ? pass('R07', 'EXECUTION', 'pre-live path gate PASS; formal PASS persisted; Effective Validation Base present; state=COMPLETE')
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
    const reviewerWorkspace = await prepareHarnessWorkspace(reviewerSession, 'reviewer');
    const diff = spawnSync('git', ['diff', '--', 'agents', 'skills/workflows', 'templates/prompts', 'scripts', 'benchmarks/sentinel-todo', 'maintenance/p0-evidence'], {
      cwd: REPOSITORY_ROOT, encoding: 'utf8', shell: false,
    });
    await fs.writeFile(path.join(reviewerWorkspace, 'review-input.md'), [
      '# Pre-pilot correction review',
      '',
      '- Base: b1fb9e182c15a2442aba09872cf11f3e6d49dd13',
      '- Initial blocker: EXECUTION_ARTIFACT_PATH_BASIS after live R06.',
      '- Root cause: EXECUTE producers could use workspace/CWD-relative values for task-relative Changed Areas and Tested state, while candidate validation did not verify the physical path/hash identity of current file-backed evidence.',
      '- Correction: make the producer basis explicit at the executor, runner, and launcher boundaries; reject wrong-basis, absent, mismatched-hash, or incompletely owned file-backed candidate evidence before publication.',
      '- Later blocker: delegated R07 did not preserve the concrete canonical SPEC_PATH/registered runner boundary consistently.',
      '- Correction: require byte-identical absolute SPEC_PATH forwarding after official preflight and forbid shell/path substitution for the registered runner identity.',
      '- Later blocker: the critical fixture planned only a UTC predicate while R-001/AC-001 require the stable HTTP envelope and no participation on rejection.',
      '- Correction: align the bounded fixture plan, public contract, implementation target, and focused test with the full expired-invitation behavior.',
      '- Later blocker: live R06 reconstructed a raw requirements hash instead of preserving the canonical preflight authority, creating a false divergence.',
      '- Correction: require executor and EXECUTE/APPLY launchers to copy the exact preflight authority byte-identically and forbid raw or reconstructed hashes.',
      '- Frozen facts: canonical authority algorithm, lifecycle runtime semantics, benchmark Cases, budgets, production-v2, Environment core, and Harness core are unchanged.',
      '',
      '## R01-R10',
      ...stages.map((stage) => `- ${stage.id}: ${stage.result} — ${stage.evidence}`),
      '',
      '## Relevant diff',
      '```diff',
      diff.stdout,
      '```',
    ].join('\n'), 'utf8');
    const reviewerPreflight = await inspectHarnessWorkspaceGitGeometry({
      session: reviewerSession,
      workspace: reviewerWorkspace,
    });
    if (reviewerPreflight.status !== 'HARNESS_WORKSPACE_GIT_READY') {
      stages.push(fail('R11', reviewerPreflight.status, 'reviewer workspace failed rehearsal Git preflight; zero model calls started'));
      return {
        status: 'PRE_PILOT_REHEARSAL_BLOCKED',
        stages,
        calls,
        reviewer: { preflight: reviewerPreflight, liveCalls: 0 },
      };
    }
    const reviewerPrompt = [
      'Read only review-input.md in this reviewer workspace. Do not modify files.',
      'Answer exactly PASS or BLOCKING_FINDING followed by compact evidence.',
      'Check these questions: do producers derive task-relative execution-record paths from the selected final task artifact; does candidate validation reject wrong basis or hash before publication without silent correction; did R01-R10 pass on the stated base; and is there any concrete blocker to a new Production Pilot.',
    ].join('\n');
    const reviewerCall = await harnessStage(reviewerSession, reviewerWorkspace, {
      model: 'GPT-5.6-Sol', effort: 'high', sandbox: 'read-only', prompt: reviewerPrompt,
    });
    calls.push({ stage: 'R11', purpose: 'independent correction reviewer', model: 'GPT-5.6-Sol', effort: 'high', status: reviewerCall.result.status, retryCount: 0 });
    const r11 = harnessStarted(reviewerCall)
      && reviewerCall.result.providerInvocationAccepted === true
      && /^PASS\b/u.test((reviewerCall.result.finalAssistantMessage ?? '').trim())
      && reviewerCall.result.retryCount === 0;
    const reviewer = {
      preflight: reviewerPreflight,
      harness: reviewerCall.result.status,
      providerInvocationAccepted: reviewerCall.result.providerInvocationAccepted === true,
      sessionStarted: reviewerCall.result.sessionStarted === true,
      turnStarted: reviewerCall.result.turnStarted === true,
      semanticVerdict: compactMessage(reviewerCall.result),
      providerErrorCategory: reviewerCall.result.providerErrorCategory ?? null,
      capabilityFingerprint: reviewerCall.result.capabilityFingerprint ?? null,
      retryCount: reviewerCall.result.retryCount ?? 0,
      liveCalls: 1,
    };
    stages.push(r11
      ? pass('R11', 'REVIEWER', 'reviewer session started and returned PASS')
      : fail('R11', reviewerCall.result.status.startsWith('HARNESS_') ? 'HARNESS' : 'REVIEWER', `harness=${reviewerCall.result.status}; verdict=${reviewerCall.result.finalAssistantMessage ?? 'none'}`));
    if (!r11) return { status: 'PRE_PILOT_REHEARSAL_BLOCKED', stages, calls, reviewer };

    const parallelSmoke = await runParallelHarnessSmoke();
    calls.push(
      { stage: 'R12-B', purpose: 'parallel harness B smoke', model: 'GPT-5.6-Luna', effort: 'medium', status: parallelSmoke.b?.harness ?? parallelSmoke.failure?.category, retryCount: parallelSmoke.b?.retryCount ?? 0 },
      { stage: 'R12-C', purpose: 'parallel harness C smoke', model: 'GPT-5.6-Luna', effort: 'medium', status: parallelSmoke.c?.harness ?? parallelSmoke.failure?.category, retryCount: parallelSmoke.c?.retryCount ?? 0 },
    );
    const r12 = parallelSmoke.status === 'ISOLATED_R12_PASS' && parallelSmoke.cleanup === 'PASS';
    stages.push(r12
      ? pass('R12', 'PARALLEL_ORCHESTRATION', 'B/C sessions completed; intervals overlap; CWD/session/TMPDIR/Git/output isolated; cleanup PASS')
      : fail('R12', parallelSmoke.failure?.category ?? 'PARALLEL_ORCHESTRATION', parallelSmoke.failure?.message ?? 'parallel smoke blocked'));
    return {
      status: r12 ? 'PRE_PILOT_REHEARSAL_READY' : 'PRE_PILOT_REHEARSAL_BLOCKED',
      stages,
      calls,
      reviewer,
      parallelSmoke,
    };
  } finally {
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
  if (!new Set(['deterministic', 'isolated', 'isolated-r11', 'isolated-r12', 'live', 'all']).has(command)) {
    process.stderr.write('usage: benchmark-rehearsal.mjs deterministic|isolated|isolated-r11|isolated-r12|live|all\n');
    return 2;
  }
  let report;
  if (command === 'deterministic') report = await runDeterministicStages();
  else if (command === 'isolated') report = await runIsolatedR07();
  else if (command === 'isolated-r11') report = await runIsolatedR11();
  else if (command === 'isolated-r12') report = await runIsolatedR12();
  else if (command === 'live') report = await runLiveStages();
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
  return new Set([
    'PRE_PILOT_REHEARSAL_READY',
    'ISOLATED_R06_R07_COMPLETE',
    'ISOLATED_R11_PASS',
    'ISOLATED_R12_PASS',
  ]).has(report.status) ? 0 : 1;
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
