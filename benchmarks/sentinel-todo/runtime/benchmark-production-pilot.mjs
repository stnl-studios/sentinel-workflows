#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  inspectExecutionState,
  preflightExecutionOperation,
} from '../../../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import { validateWorkspace } from '../../../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs';
import { discoverProviderCapabilities, runHarness } from './benchmark-agent-harness.mjs';
import {
  cleanupManagedBenchmarkSession,
  createManagedBenchmarkSession,
  runDoctor,
} from './benchmark-environment.mjs';

export const productionPilotDriverVersion = 2;

const RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = path.resolve(RUNTIME_ROOT, '..');
const REPOSITORY_ROOT = path.resolve(BENCHMARK_ROOT, '../..');
const BENCHMARK_RUNTIME = path.join(RUNTIME_ROOT, 'benchmark.mjs');
const MANIFEST_PATH = path.join(BENCHMARK_ROOT, 'benchmark.json');
const BLOCKED_EXECUTION_STATES = new Set([
  'AUXILIARY_BLOCKED', 'DIVERGENCE_BLOCKED', 'REPLAN_REQUIRED', 'REQUIREMENTS_CHANGED',
  'RUNNER_INITIALIZATION_BLOCKED', 'RUNNER_RESULT_BLOCKED', 'VALIDATION_BLOCKED',
]);
const PHASE_BY_OPERATION = Object.freeze({
  SPEC_INIT: 'SPEC', SPEC_READINESS: 'REVIEW_VALIDATE', SPEC_CLOSE: 'SPEC',
  PLAN: 'PLAN', REPLAN: 'PLAN', MATERIALIZE_TASKS: 'TASKS',
  REVIEW_PLAN: 'REVIEW_VALIDATE', REVIEW_TASKS: 'REVIEW_VALIDATE',
  EXECUTE_SLICE: 'EXECUTE', APPLY_FINDINGS: 'EXECUTE', VALIDATE_SLICE: 'REVIEW_VALIDATE',
});
const TEMPLATE_BY_OPERATION = Object.freeze({
  SPEC_INIT: 'spec-init.md', SPEC_READINESS: 'spec-readiness.md', SPEC_CLOSE: 'spec-close.md',
  PLAN: 'execution-plan.md', REVIEW_PLAN: 'execution-plan-review.md',
  MATERIALIZE_TASKS: 'execution-tasks.md', REVIEW_TASKS: 'execution-tasks-review.md',
  EXECUTE_SLICE: 'slice-execute-codex.md', VALIDATE_SLICE: 'slice-validate-codex.md',
  APPLY_FINDINGS: 'slice-apply-findings-codex.md', REPLAN: 'execution-replan.md',
});
const SKILL_BY_OPERATION = Object.freeze({
  SPEC_INIT: 'stnl-spec-lifecycle-manager', SPEC_READINESS: 'stnl-spec-lifecycle-manager',
  SPEC_CLOSE: 'stnl-spec-lifecycle-manager', PLAN: 'stnl-execution-planner', REPLAN: 'stnl-execution-planner',
  REVIEW_PLAN: 'stnl-plan-reviewer', MATERIALIZE_TASKS: 'stnl-task-materializer',
  REVIEW_TASKS: 'stnl-task-reviewer', EXECUTE_SLICE: 'stnl-slice-executor',
  APPLY_FINDINGS: 'stnl-slice-executor', VALIDATE_SLICE: 'stnl-slice-quality-manager',
});

class PilotError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function localCommand(command, args, cwd = REPOSITORY_ROOT, timeout = 180_000) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, timeout });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? ''),
  };
}

function git(args) {
  const environment = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete environment[name];
  }
  const result = spawnSync('git', args, {
    cwd: REPOSITORY_ROOT, encoding: 'utf8', env: environment, shell: false, timeout: 60_000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, file);
}

function sanitizeText(value, roots = []) {
  let text = String(value ?? '').replaceAll('\r\n', '\n');
  for (const [index, root] of roots.filter(Boolean).entries()) text = text.replaceAll(root, `<path-${index + 1}>`);
  text = text.replace(/\b(?:OPENAI|CODEX)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*\S+/gu, '<redacted>');
  return text.slice(0, 16 * 1024);
}

export function canonicalSliceInput(value) {
  const match = /^slice-([0-9]{2,})$/u.exec(String(value));
  if (match === null) throw new PilotError(`invalid canonical slice label: ${value}`, 2);
  return BigInt(match[1]).toString(10);
}

export function dispatchForOperation(configuration, caseId, operation) {
  if (configuration.productionProfile?.id !== 'production-v2') throw new PilotError('production-v2 is required');
  const phase = PHASE_BY_OPERATION[operation];
  const dispatch = configuration.productionProfile.cases?.[caseId]?.[phase];
  if (phase === undefined || dispatch === undefined) throw new PilotError(`profile dispatch is absent for ${caseId}/${operation}`);
  return Object.freeze({ phase, model: dispatch.model, effort: dispatch.effort });
}

function compactExecution(result) {
  if (result === null || result === undefined) return null;
  if (result.error !== undefined) return { error: result.error };
  return {
    state: result.state,
    currentFingerprint: result.currentFingerprint ?? null,
    legalOperations: result.legalOperations ?? [],
    normalHandoff: result.normalHandoff ?? null,
    requiredRecoveryHandoff: result.requiredRecoveryHandoff ?? null,
    recoveryTargets: result.recoveryTargets ?? [],
    rows: result.rows?.map((row) => ({ slice: row.slice, done: row.done, result: row.result })) ?? [],
  };
}

function compactLifecycle(result) {
  if (result === null || result === undefined) return null;
  if (result.error !== undefined) return { error: result.error };
  return {
    status: result.status,
    closed: result.closed,
    openQuestions: result.openQuestions?.length ?? 0,
    blockingQuestions: result.blockingQuestions?.length ?? 0,
    brokenReferences: result.brokenReferences?.length ?? 0,
    documentaryGaps: result.documentaryGaps?.length ?? 0,
  };
}

export function decideOfficialOutcome({ operation, official, harnessStatus }) {
  const lifecycle = official.lifecycle;
  const execution = official.execution;
  if (operation === 'SPEC_INIT') {
    if (lifecycle?.status === 'blocked' || lifecycle?.error || execution?.error) {
      return { result: 'BLOCKED', blocker: 'OFFICIAL_LIFECYCLE_BLOCKED' };
    }
  } else if (operation === 'SPEC_READINESS') {
    if (lifecycle?.status !== 'ready' || execution?.state !== 'COMPLETE') {
      return { result: 'BLOCKED', blocker: 'OFFICIAL_GLOBAL_READINESS_BLOCKED' };
    }
  } else if (operation === 'SPEC_CLOSE') {
    if (lifecycle?.status !== 'closed' || lifecycle?.closed !== true) {
      return { result: 'BLOCKED', blocker: 'OFFICIAL_CLOSE_BLOCKED' };
    }
  } else if (execution?.error) {
    return { result: 'BLOCKED', blocker: 'OFFICIAL_EXECUTION_READBACK_BLOCKED' };
  } else if (BLOCKED_EXECUTION_STATES.has(execution?.state)) {
    return { result: 'BLOCKED', blocker: `OFFICIAL_${execution.state}` };
  }
  if (harnessStatus !== 'HARNESS_COMPLETED') {
    return { result: 'BLOCKED', blocker: `HARNESS_${harnessStatus}` };
  }
  if (operation === 'SPEC_INIT') {
    if (lifecycle?.status === 'ready' && execution?.state === 'EMPTY') return { result: 'PASS', blocker: null };
  } else if (operation === 'SPEC_READINESS' || operation === 'SPEC_CLOSE') {
    return { result: 'PASS', blocker: null };
  } else {
    const accepted = {
      PLAN: new Set(['PLANNED_DRAFT']),
      REVIEW_PLAN: new Set(['PLANNED_READY']),
      MATERIALIZE_TASKS: new Set(['MATERIALIZED_PRISTINE']),
      REVIEW_TASKS: new Set(['MATERIALIZED_PRISTINE']),
      EXECUTE_SLICE: new Set(['IMPLEMENTED_AWAITING_VALIDATION']),
      APPLY_FINDINGS: new Set(['FINDINGS_CORRECTED']),
      VALIDATE_SLICE: new Set(['EXECUTION_STARTED', 'COMPLETE']),
      REPLAN: new Set(['PENDING_REPLAN_DRAFT']),
    };
    if (operation === 'VALIDATE_SLICE' && execution?.state === 'VALIDATION_NEEDS_FIX') {
      return { result: 'NEEDS_FIX', blocker: null };
    }
    if (accepted[operation]?.has(execution?.state)) return { result: 'PASS', blocker: null };
    if ((operation === 'EXECUTE_SLICE' || operation === 'APPLY_FINDINGS')
      && execution?.requiredRecoveryHandoff?.operation === 'VALIDATE_SLICE') {
      return { result: 'PASS', blocker: null };
    }
  }
  return { result: 'BLOCKED', blocker: 'OFFICIAL_TRANSITION_NOT_OBSERVED' };
}

async function officialReadback(specPath) {
  const lifecycle = await Promise.resolve().then(() => validateWorkspace(specPath)).catch((error) => ({ error: error.message }));
  const execution = await inspectExecutionState(specPath).catch((error) => ({ error: error.message }));
  return { lifecycle: compactLifecycle(lifecycle), execution: compactExecution(execution), executionRaw: execution };
}

async function workspaceSnapshot(workspace, specPath) {
  const status = localCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], workspace);
  const diff = localCommand('git', ['diff', '--binary', 'HEAD', '--'], workspace);
  const specMetadata = await fs.lstat(specPath).catch(() => null);
  return {
    gitStatusExit: status.exitCode,
    changedPaths: status.stdout.trim() === '' ? [] : status.stdout.trimEnd().split('\n'),
    diffSha256: diff.exitCode === 0 ? sha256(diff.stdout) : null,
    specExists: specMetadata?.isDirectory() === true && specMetadata.isSymbolicLink() === false,
  };
}

async function renderPrompt({ operation, specPath, requirementsPath, slice }) {
  const templatePath = path.join(REPOSITORY_ROOT, 'templates', 'prompts', TEMPLATE_BY_OPERATION[operation]);
  const skillPath = path.join(REPOSITORY_ROOT, 'skills', 'workflows', SKILL_BY_OPERATION[operation], 'SKILL.md');
  let prompt = await fs.readFile(templatePath, 'utf8');
  const values = {
    '{{SPEC_PATH}}': specPath,
    '{{REQUIREMENTS_SOURCE}}': requirementsPath,
    '{{SLICE}}': slice === null ? '' : canonicalSliceInput(slice),
    '{{READINESS_SCOPE}}': 'GLOBAL',
    '{{READINESS_FOCUS}}': 'not-applicable',
    '{{REPLAN_REASON}}': 'official readback requires replan',
  };
  for (const [placeholder, value] of Object.entries(values)) prompt = prompt.replaceAll(placeholder, value);
  return [
    'Execute exactly one Sentinel workflow operation for the Production Pilot.',
    `Read the complete workflow skill at ${skillPath} and obey it.`,
    prompt.trim(),
    'The driver will use the official local readback as semantic authority after this turn.',
    'Do not start any later operation, do not retry an official BLOCKED result, and do not edit the sentinel-workflows source checkout.',
  ].join('\n\n');
}

async function canonicalHarnessRequest({ workspace, tmpdir, dispatch, prompt }) {
  return {
    cwd: await fs.realpath(workspace),
    tmpdir: await fs.realpath(tmpdir),
    model: dispatch.model,
    effort: dispatch.effort,
    sandbox: 'workspace-write',
    prompt,
    timeoutMs: 900_000,
  };
}

function benchmarkCommand(args, cwd = REPOSITORY_ROOT) {
  return localCommand(process.execPath, [BENCHMARK_RUNTIME, ...args], cwd);
}

async function recordJournalEvent({ journal, operation, dispatch, result, slice, resultingState, durationMs }) {
  const args = [
    'journal-event', '--journal', journal, '--operation', operation, '--phase', dispatch.phase,
    '--model', dispatch.model, '--effort', dispatch.effort, '--result', result,
    '--duration-ms', String(durationMs), '--retry', 'false',
  ];
  if (slice !== null) args.push('--slice', slice);
  if (resultingState !== null) args.push('--resulting-state', resultingState);
  return benchmarkCommand(args);
}

export function nextHandoff(operation, readback) {
  if (readback.executionRaw?.state === 'COMPLETE') return { operation: 'SPEC_READINESS', slice: null };
  if (operation === 'SPEC_READINESS') return { operation: 'SPEC_CLOSE', slice: null };
  if (operation === 'SPEC_CLOSE') return null;
  const handoff = readback.executionRaw?.requiredRecoveryHandoff
    ?? readback.executionRaw?.normalHandoff
    ?? null;
  return handoff?.operation == null ? null : { operation: handoff.operation, slice: handoff.slice };
}

function blockerArtifactMetadata({ operation, slice, officialBlocker, recoveryTarget }) {
  return {
    slice,
    operation,
    officialBlocker,
    recoveryRecord: recoveryTarget?.record ?? null,
    recoveryRound: recoveryTarget?.round ?? null,
  };
}

export async function preserveAuxiliaryBlockerArtifact({
  specPath, evidenceDirectory, sequence, operation, slice, officialExecution, officialBlocker,
}) {
  const recoveryTarget = officialExecution?.recoveryTargets?.find((target) => (
    target.owner === 'auxiliary-check' && target.operation === operation && target.slice === slice
  ));
  const metadata = blockerArtifactMetadata({ operation, slice, officialBlocker, recoveryTarget });
  if (slice === null || !/^slice-[0-9]{2,}$/u.test(slice)) {
    return { status: 'FAILED', path: null, sha256: null, failure: 'INVALID_SLICE', ...metadata };
  }

  const sourceRelative = path.posix.join('execution', 'tasks', `${slice}.md`);
  const source = path.join(specPath, 'execution', 'tasks', `${slice}.md`);
  const sourceMetadata = await fs.lstat(source).catch(() => null);
  if (sourceMetadata === null) {
    return { status: 'FAILED', path: null, sha256: null, source: sourceRelative, failure: 'SOURCE_MISSING', ...metadata };
  }
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    return { status: 'FAILED', path: null, sha256: null, source: sourceRelative, failure: 'SOURCE_NOT_REGULAR_FILE', ...metadata };
  }

  const canonicalSpec = await fs.realpath(specPath).catch(() => null);
  const canonicalSource = await fs.realpath(source).catch(() => null);
  const relativeSource = canonicalSpec === null || canonicalSource === null
    ? '..'
    : path.relative(canonicalSpec, canonicalSource);
  if (canonicalSpec === null || canonicalSource === null || path.isAbsolute(relativeSource)
    || relativeSource === '..' || relativeSource.startsWith(`..${path.sep}`)) {
    return { status: 'FAILED', path: null, sha256: null, source: sourceRelative, failure: 'SOURCE_OUTSIDE_SPEC', ...metadata };
  }

  const operationDirectory = `${String(sequence).padStart(2, '0')}-${operation.toLowerCase()}`;
  const destinationRelative = path.posix.join('operations', operationDirectory, `task-${slice}.md`);
  const destination = path.join(evidenceDirectory, 'operations', operationDirectory, `task-${slice}.md`);
  try {
    const sourceBytes = await fs.readFile(canonicalSource);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(canonicalSource, destination, fs.constants.COPYFILE_EXCL);
    const destinationBytes = await fs.readFile(destination);
    if (!destinationBytes.equals(sourceBytes)) {
      return { status: 'FAILED', path: destinationRelative, sha256: null, source: sourceRelative, failure: 'COPY_MISMATCH', ...metadata };
    }
    return {
      status: 'PRESERVED',
      path: destinationRelative,
      sha256: sha256(destinationBytes),
      source: sourceRelative,
      failure: null,
      ...metadata,
    };
  } catch {
    return { status: 'FAILED', path: destinationRelative, sha256: null, source: sourceRelative, failure: 'COPY_FAILED', ...metadata };
  }
}

async function runOperation(context, target, sequence) {
  const { operation, slice } = target;
  const dispatch = dispatchForOperation(context.configuration, context.caseId, operation);
  const started = Date.now();
  let preflight = null;
  let harness = { status: 'NOT_RUN', commandExitCodes: [], retryCount: 0 };
  let preflightBlocker = null;

  if (!operation.startsWith('SPEC_')) {
    const sliceInput = slice === null ? null : canonicalSliceInput(slice);
    try {
      preflight = compactExecution(await preflightExecutionOperation(context.specPath, operation, sliceInput));
    } catch (error) {
      preflightBlocker = error.message;
    }
  }

  if (preflightBlocker === null) {
    const prompt = await renderPrompt({
      operation, specPath: context.specPath, requirementsPath: context.requirementsPath, slice,
    });
    const request = await canonicalHarnessRequest({
      workspace: context.workspace, tmpdir: context.session.runnerTmp, dispatch, prompt,
    });
    harness = await context.runHarness(request);
  }

  const official = operation === 'SPEC_INIT' && await fs.lstat(context.specPath).catch(() => null) === null
    ? { lifecycle: { error: 'SPEC path was not created' }, execution: { error: 'SPEC path was not created' }, executionRaw: null }
    : await officialReadback(context.specPath);
  let outcome = preflightBlocker === null
    ? decideOfficialOutcome({ operation, official, harnessStatus: harness.status })
    : { result: 'BLOCKED', blocker: 'OFFICIAL_PREFLIGHT_BLOCKED' };
  const resultingState = operation === 'SPEC_READINESS' && outcome.result === 'PASS'
    ? 'GLOBAL_READY'
    : operation === 'SPEC_CLOSE' && outcome.result === 'PASS'
      ? null
      : official.execution?.state ?? null;
  const durationMs = Date.now() - started;
  const journalResult = await recordJournalEvent({
    journal: context.journal, operation, dispatch, result: outcome.result,
    slice, resultingState, durationMs,
  });
  if (journalResult.exitCode !== 0 && outcome.result !== 'BLOCKED') {
    outcome = { result: 'BLOCKED', blocker: 'JOURNAL_REJECTED' };
  }
  const blockerArtifact = official.execution?.state === 'AUXILIARY_BLOCKED'
    ? await preserveAuxiliaryBlockerArtifact({
      specPath: context.specPath,
      evidenceDirectory: context.evidenceDirectory,
      sequence,
      operation,
      slice,
      officialExecution: official.execution,
      officialBlocker: outcome.blocker,
    })
    : null;
  const evidence = {
    sequence,
    operation,
    slice,
    renderedSlice: slice === null ? null : canonicalSliceInput(slice),
    dispatch,
    harness: {
      status: harness.status,
      requestedModel: harness.requestedModel ?? dispatch.model,
      requestedEffort: harness.requestedEffort ?? dispatch.effort,
      retryCount: harness.retryCount ?? 0,
      sessionStarted: harness.sessionStarted ?? false,
      turnStarted: harness.turnStarted ?? false,
      commandLedger: (harness.commandExitCodes ?? []).map((exitCode, index) => ({
        index: index + 1, source: 'harness-structured-command', command: 'not-exposed-by-harness-v1', exitCode,
      })),
      stdout: sanitizeText(harness.finalAssistantMessage, [context.workspace, context.session.root, REPOSITORY_ROOT]),
      stderr: harness.providerErrorCategory ?? '',
    },
    preflight,
    preflightBlocker,
    official: { lifecycle: official.lifecycle, execution: official.execution },
    blockerArtifact,
    candidateSnapshot: await workspaceSnapshot(context.workspace, context.specPath),
    journal: {
      exitCode: journalResult.exitCode,
      stdout: sanitizeText(journalResult.stdout, [context.workspace, context.session.root]),
      stderr: sanitizeText(journalResult.stderr, [context.workspace, context.session.root]),
    },
    outcome,
    durationMs,
  };
  await writeJson(path.join(context.evidenceDirectory, 'operations', `${String(sequence).padStart(2, '0')}-${operation.toLowerCase()}.json`), evidence);
  return { outcome, readback: official, evidence };
}

export async function runPilotOperationLoop({ maxWorkflowEvents, executeOperation, initialTarget = { operation: 'SPEC_INIT', slice: null } }) {
  let target = initialTarget;
  let terminal = null;
  let sequence = 0;
  let blockerArtifact = null;
  while (target !== null) {
    sequence += 1;
    if (sequence > maxWorkflowEvents) {
      terminal = { result: 'BLOCKED', blocker: 'DRIVER_EVENT_LIMIT' };
      break;
    }
    const completed = await executeOperation(target, sequence);
    terminal = completed.outcome;
    blockerArtifact = completed.evidence?.blockerArtifact ?? blockerArtifact;
    if (completed.outcome.result === 'BLOCKED' || completed.outcome.result === 'FAIL') break;
    target = nextHandoff(target.operation, completed.readback);
  }
  return { terminal, operations: sequence, retryCount: 0, blockerArtifact };
}

export async function finalizeAndPreserve({ finalize, rawPath, destination, expectedCaseId, expectedProfileId }) {
  const finalizer = await finalize();
  const metadata = await fs.lstat(rawPath).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    return { finalizer, preserved: false, blocker: 'FINALIZE_RAW_MISSING' };
  }
  const bytes = await fs.readFile(rawPath);
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { finalizer, preserved: false, blocker: 'FINALIZE_RAW_INVALID_JSON' };
  }
  if (raw.caseId !== expectedCaseId || raw.productionProfileId !== expectedProfileId
    || !new Set(['PASS', 'BLOCKED', 'FAIL', 'ABORTED_BUDGET']).has(raw.status)) {
    return { finalizer, preserved: false, blocker: 'FINALIZE_RAW_IDENTITY_MISMATCH' };
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(rawPath, destination, fs.constants.COPYFILE_EXCL);
  const copied = await fs.readFile(destination);
  if (!copied.equals(bytes)) throw new PilotError('preserved raw differs from canonical finalizer output');
  return { finalizer, preserved: true, raw, rawPath: destination, rawSha256: sha256(bytes), blocker: null };
}

async function runCase(caseId, options, dependencies = {}) {
  const configuration = options.configuration;
  const caseConfiguration = configuration.cases.find((entry) => entry.id === caseId);
  const evidenceDirectory = path.join(options.output, `case-${caseId.toLowerCase()}`);
  await fs.mkdir(evidenceDirectory, { recursive: true });
  let session = null;
  let result = null;
  let cleanup = 'NOT_NEEDED';
  try {
    session = await createManagedBenchmarkSession({
      repositoryRoot: REPOSITORY_ROOT, scratchParent: options.scratchParent,
    });
    cleanup = 'PASS';
    const requestedWorkspace = path.join(session.workspaces, `case-${caseId.toLowerCase()}`);
    const prepared = benchmarkCommand(['prepare', '--case', caseId, '--output', requestedWorkspace]);
    if (prepared.exitCode !== 0) throw new PilotError(`Case ${caseId} prepare failed: ${prepared.stderr || prepared.stdout}`);
    const workspace = await fs.realpath(requestedWorkspace);
    const specPath = path.join(workspace, ...caseConfiguration.specPath.split('/'));
    const requirementsPath = path.join(workspace, 'requirements.md');
    const journal = path.join(session.journals, `case-${caseId.toLowerCase()}.json`);
    const initialized = benchmarkCommand([
      'journal-init', '--output', journal, '--case', caseId, '--sentinel-sha', options.sentinelSha,
      '--run-mode', 'case', '--production-profile', configuration.productionProfile.id,
    ]);
    if (initialized.exitCode !== 0) throw new PilotError(`Case ${caseId} journal init failed: ${initialized.stderr || initialized.stdout}`);

    const context = {
      caseId, configuration, evidenceDirectory, journal, requirementsPath, session, specPath, workspace,
      runHarness: dependencies.runHarness ?? runHarness,
    };
    const operationRun = await runPilotOperationLoop({
      maxWorkflowEvents: caseConfiguration.budgets.maxWorkflowEvents,
      executeOperation: (target, sequence) => runOperation(context, target, sequence),
    });
    const terminal = operationRun.terminal;

    const rawPath = path.join(session.results, `case-${caseId.toLowerCase()}-production-v2.json`);
    const destination = path.join(options.output, path.basename(rawPath));
    const specExists = await fs.lstat(specPath).then((item) => item.isDirectory()).catch(() => false);
    const preserved = specExists
      ? await finalizeAndPreserve({
        finalize: async () => benchmarkCommand([
          'finalize', '--workspace', workspace, '--case', caseId, '--spec', specPath,
          '--journal', journal, '--output', rawPath,
        ]),
        rawPath,
        destination,
        expectedCaseId: caseId,
        expectedProfileId: configuration.productionProfile.id,
      })
      : { preserved: false, blocker: 'SPEC_NOT_CREATED', finalizer: null };
    result = {
      caseId,
      status: preserved.raw?.status ?? 'BLOCKED',
      blocker: preserved.blocker ?? (preserved.raw?.status === 'PASS' ? null : terminal?.blocker ?? 'CASE_NOT_PASS'),
      profileId: configuration.productionProfile.id,
      profileMismatches: preserved.raw?.modelUse?.profileMismatches ?? [],
      rawPath: preserved.rawPath === undefined ? null : path.relative(options.output, preserved.rawPath).split(path.sep).join('/'),
      rawSha256: preserved.rawSha256 ?? null,
      finalizer: preserved.finalizer === null ? null : {
        exitCode: preserved.finalizer.exitCode,
        stdout: sanitizeText(preserved.finalizer.stdout, [workspace, session.root, REPOSITORY_ROOT]),
        stderr: sanitizeText(preserved.finalizer.stderr, [workspace, session.root, REPOSITORY_ROOT]),
      },
      operations: operationRun.operations,
      retryCount: operationRun.retryCount,
      blockerArtifact: operationRun.blockerArtifact,
    };
  } catch (error) {
    result = {
      caseId, status: 'BLOCKED', blocker: 'DRIVER_FAILURE', message: sanitizeText(error.message, [session?.root]),
      profileId: configuration.productionProfile.id, profileMismatches: [], rawPath: null, rawSha256: null,
      operations: 0, retryCount: 0,
    };
  } finally {
    if (session !== null) {
      try {
        await cleanupManagedBenchmarkSession(session);
      } catch (error) {
        cleanup = `BLOCKED: ${error.message}`;
        result = { ...result, status: 'BLOCKED', blocker: 'CLEANUP_FAILED' };
      }
    }
  }
  result.cleanup = cleanup;
  await writeJson(path.join(evidenceDirectory, 'case-summary.json'), result);
  return result;
}

export async function runPilotSchedule(runCaseFunction) {
  const settledCase = (caseId, settled) => settled.status === 'fulfilled'
    ? settled.value
    : { caseId, status: 'BLOCKED', blocker: 'DRIVER_FAILURE', message: String(settled.reason?.message ?? settled.reason) };
  const [aSettled] = await Promise.allSettled([runCaseFunction('A')]);
  const a = settledCase('A', aSettled);
  if (a.status !== 'PASS') return { A: a, B: { status: 'NOT_RUN' }, C: { status: 'NOT_RUN' } };
  const [bSettled, cSettled] = await Promise.allSettled([runCaseFunction('B'), runCaseFunction('C')]);
  const b = settledCase('B', bSettled);
  const c = settledCase('C', cSettled);
  return { A: a, B: b, C: c };
}

async function historicalRawSnapshot() {
  const listed = git(['ls-files', 'maintenance/benchmark-results/**/*.json']);
  if (listed.exitCode !== 0) throw new PilotError(`cannot list historical raws: ${listed.stderr}`);
  const snapshot = {};
  for (const relative of listed.stdout.trim().split('\n').filter(Boolean)) {
    snapshot[relative] = sha256(await fs.readFile(path.join(REPOSITORY_ROOT, relative)));
  }
  return snapshot;
}

async function preconditions(options, configuration) {
  const checks = [];
  const fail = (message) => {
    const error = new PilotError(message);
    error.evidence = { status: 'BLOCKED', profileId: configuration.productionProfile?.id ?? null, checks };
    throw error;
  };
  const run = (name, command, args, cwd = REPOSITORY_ROOT) => {
    const result = localCommand(command, args, cwd);
    checks.push({ name, exitCode: result.exitCode, stdout: sanitizeText(result.stdout, [REPOSITORY_ROOT]), stderr: sanitizeText(result.stderr, [REPOSITORY_ROOT]) });
    if (result.exitCode !== 0) fail(`precondition failed: ${name}`);
  };

  const clean = git(['status', '--porcelain=v1', '--untracked-files=all']);
  checks.push({ name: 'git clean', exitCode: clean.exitCode || (clean.stdout === '' ? 0 : 1), stdout: clean.stdout, stderr: clean.stderr });
  if (clean.exitCode !== 0 || clean.stdout !== '') fail('precondition failed: source checkout is not clean');
  if (configuration.productionProfile.id !== 'production-v2' || configuration.productionPilot?.driverVersion !== productionPilotDriverVersion) {
    fail('precondition failed: production profile or driver version mismatch');
  }

  run('benchmark verify', process.execPath, [BENCHMARK_RUNTIME, 'verify']);
  run('seed tests', process.execPath, ['--test'], path.join(BENCHMARK_ROOT, 'seed'));
  for (const relative of [
    'scripts/test-benchmark-contract.mjs',
    'scripts/test-benchmark-environment.mjs',
    'scripts/test-benchmark-agent-harness.mjs',
    'scripts/test-benchmark-production-pilot.mjs',
    'scripts/test-execution-contract.mjs',
    'scripts/test-validation-runner-contract.mjs',
    'scripts/test-launcher-contract.mjs',
  ]) run(relative, process.execPath, ['--test', path.join(REPOSITORY_ROOT, relative)]);
  run('repository contract', process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/check-contracts.mjs'), 'repository', '--root', REPOSITORY_ROOT]);

  const doctor = await runDoctor({
    repositoryRoot: REPOSITORY_ROOT, benchmarkRoot: BENCHMARK_ROOT, scratchParent: options.scratchParent,
  });
  checks.push({ name: 'environment doctor', exitCode: doctor.exitCode, report: doctor.report });
  if (doctor.exitCode !== 0) fail('precondition failed: environment doctor');

  const capability = await discoverProviderCapabilities();
  checks.push({ name: 'harness readiness', exitCode: capability.status === 'HARNESS_COMPLETED' ? 0 : 1, fingerprint: capability.fingerprint });
  const qualification = configuration.productionPilot.qualification;
  if (capability.status !== 'HARNESS_COMPLETED'
    || capability.fingerprint?.harnessContractVersion !== qualification.harnessContractVersion
    || capability.fingerprint?.providerVersion !== qualification.providerVersion
    || capability.fingerprint?.capabilitiesHash !== qualification.capabilitiesHash) {
    fail('precondition failed: harness qualification fingerprint mismatch');
  }
  const probeEvidence = path.join(REPOSITORY_ROOT, qualification.sandboxProbeEvidence);
  const probeBytes = await fs.readFile(probeEvidence).catch(() => null);
  if (probeBytes === null) fail('precondition failed: reusable sandbox probe evidence is unreadable');
  if (sha256(probeBytes) !== qualification.sandboxProbeEvidenceSha256) {
    fail('precondition failed: reusable sandbox probe evidence hash mismatch');
  }
  checks.push({ name: 'qualified sandbox probe reuse', exitCode: 0, evidence: qualification.sandboxProbeEvidence, liveProbeExecuted: false });
  return {
    status: 'PASS',
    profileId: configuration.productionProfile.id,
    checks,
    functionalEquivalence: { status: 'NOT_APPLICABLE', reason: 'current committed HEAD is the measured candidate' },
    historicalRawsBefore: await historicalRawSnapshot(),
  };
}

async function validateOutput(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new PilotError('--output must be an absolute path', 2);
  const resolved = path.resolve(value);
  if (await fs.lstat(resolved).catch(() => null) !== null) throw new PilotError('--output must not exist', 2);
  const parent = await fs.realpath(path.dirname(resolved)).catch(() => null);
  if (parent === null) throw new PilotError('--output parent must exist', 2);
  return path.join(parent, path.basename(resolved));
}

function parseOptions(tokens) {
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!new Set(['--output', '--scratch-parent']).has(name) || value === undefined || value.startsWith('--')) {
      throw new PilotError(`invalid option near ${name ?? '<end>'}`, 2);
    }
    if (Object.hasOwn(values, name)) throw new PilotError(`duplicate option ${name}`, 2);
    values[name] = value;
  }
  if (values['--output'] === undefined) throw new PilotError('missing --output', 2);
  return values;
}

export async function runProductionPilot({ output, scratchParent } = {}) {
  const canonicalOutput = await validateOutput(output);
  const configuration = await readJson(MANIFEST_PATH);
  const sentinelShaResult = git(['rev-parse', 'HEAD']);
  if (sentinelShaResult.exitCode !== 0 || !/^[0-9a-f]{40}\n?$/u.test(sentinelShaResult.stdout)) {
    throw new PilotError('cannot resolve candidate HEAD');
  }
  const sentinelSha = sentinelShaResult.stdout.trim();
  let preconditionEvidence;
  try {
    preconditionEvidence = await preconditions({ scratchParent }, configuration);
  } catch (error) {
    await fs.mkdir(canonicalOutput);
    await writeJson(path.join(canonicalOutput, 'preconditions.json'), error.evidence ?? {
      status: 'BLOCKED', profileId: configuration.productionProfile?.id ?? null, checks: [],
    });
    const summary = {
      driverVersion: productionPilotDriverVersion,
      status: 'BLOCKED',
      blocker: 'PRECONDITION',
      message: error.message,
      profileId: configuration.productionProfile?.id ?? null,
      sentinelSha,
      cases: { A: { status: 'NOT_RUN' }, B: { status: 'NOT_RUN' }, C: { status: 'NOT_RUN' } },
      baselineEligible: false,
      reviewerExecuted: false,
      forensicReview: { enabled: false, executed: false },
    };
    await writeJson(path.join(canonicalOutput, 'pilot-summary.json'), summary);
    return summary;
  }

  await fs.mkdir(canonicalOutput);
  await writeJson(path.join(canonicalOutput, 'preconditions.json'), preconditionEvidence);
  const schedule = await runPilotSchedule((caseId) => runCase(caseId, {
    configuration, output: canonicalOutput, scratchParent, sentinelSha,
  }));
  const historicalRawsAfter = await historicalRawSnapshot();
  const historicalRawIntegrity = JSON.stringify(preconditionEvidence.historicalRawsBefore) === JSON.stringify(historicalRawsAfter);
  const sourceDiff = git(['diff', '--quiet', 'HEAD', '--']);
  const sourceIndex = git(['diff', '--cached', '--quiet', 'HEAD', '--']);
  const sourceTrackedIntegrity = sourceDiff.exitCode === 0 && sourceIndex.exitCode === 0;
  const casesPass = ['A', 'B', 'C'].every((caseId) => schedule[caseId].status === 'PASS');
  const mismatches = ['A', 'B', 'C'].flatMap((caseId) => schedule[caseId].profileMismatches ?? []);
  const baselineEligible = casesPass && mismatches.length === 0 && historicalRawIntegrity && sourceTrackedIntegrity;
  const summary = {
    driverVersion: productionPilotDriverVersion,
    status: baselineEligible ? 'PASS' : 'BLOCKED',
    blocker: baselineEligible
      ? null
      : !sourceTrackedIntegrity ? 'SOURCE_TRACKED_INTEGRITY'
        : !historicalRawIntegrity ? 'HISTORICAL_RAW_INTEGRITY'
        : mismatches.length !== 0 ? 'PROFILE_MISMATCH'
          : schedule.A.status !== 'PASS' ? schedule.A.blocker
            : 'SIBLING_CASE_BLOCKED',
    profileId: configuration.productionProfile.id,
    sentinelSha,
    cases: schedule,
    profileMismatches: mismatches,
    historicalRawIntegrity,
    sourceTrackedIntegrity,
    baselineEligible,
    reviewerExecuted: false,
    forensicReview: { enabled: false, executed: false },
    evidencePaths: ['preconditions.json', ...['A', 'B', 'C']
      .filter((caseId) => schedule[caseId].status !== 'NOT_RUN')
      .map((caseId) => `case-${caseId.toLowerCase()}/case-summary.json`)],
  };
  await writeJson(path.join(canonicalOutput, 'pilot-summary.json'), summary);
  return summary;
}

export async function main(argv) {
  const [command, ...tokens] = argv;
  if (command !== 'run') throw new PilotError('usage: benchmark-production-pilot.mjs run --output <absolute-absent-path> [--scratch-parent <absolute-existing-path>]', 2);
  const options = parseOptions(tokens);
  const summary = await runProductionPilot({
    output: options['--output'], scratchParent: options['--scratch-parent'],
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.status === 'PASS' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

export { PilotError, canonicalHarnessRequest };
