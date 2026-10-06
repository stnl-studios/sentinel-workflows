import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeRequirementsAuthority, preflightExecutionOperation } from './execution-state.mjs';

const CONTEXT_ENV = 'STNL_MANAGED_CONTEXT';
const SPEC_ENV = 'STNL_MANAGED_SPEC_PATH';
const WORKSPACE_ENV = 'STNL_MANAGED_WORKSPACE';
const OPERATION_ENV = 'STNL_MANAGED_OPERATION';
const SLICE_ENV = 'STNL_MANAGED_SLICE';
const ADAPTER_ENV = 'STNL_RUNNER_ADAPTER';
const BRIDGE_ENV = 'STNL_MANAGED_RUNNER_BRIDGE';
const PREFLIGHT_ENV = 'STNL_MANAGED_PREFLIGHT';
const EVIDENCE_SERIALIZER_ENV = 'STNL_RUNNER_EVIDENCE_SERIALIZER';
const OPERATIONS = new Set(['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']);

function fail(message) {
  const error = new Error(`managed slice context: ${message}`);
  error.code = 'MANAGED_CONTEXT_INVALID';
  throw error;
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonical(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/u.test(value)) {
    fail(`${label} must be an absolute canonical path`);
  }
  return value;
}

function validSlice(value) {
  if (typeof value !== 'string' || !/^slice-[0-9]{2,}$/u.test(value)) fail('slice is invalid');
  return value;
}

function normalizedSlice(value) {
  const text = String(value);
  return /^slice-/u.test(text) ? validSlice(text) : `slice-${BigInt(text).toString(10).padStart(2, '0')}`;
}

function validAuthority(value) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail('authority is invalid');
  return value;
}

async function directoryIdentity(directory, label) {
  canonical(directory, label);
  const metadata = await fs.lstat(directory).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()
    || await fs.realpath(directory) !== directory) fail(`${label} is not a canonical directory`);
  return { path: directory, mode: (metadata.mode & 0o777).toString(8) };
}

async function fileIdentity(file, label, { executable = false } = {}) {
  canonical(file, label);
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()
    || await fs.realpath(file) !== file) fail(`${label} is not a canonical regular file`);
  if (executable && (metadata.mode & 0o111) === 0) fail(`${label} must be executable`);
  return {
    path: file,
    sha256: `sha256:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`,
    mode: (metadata.mode & 0o777).toString(8),
  };
}

function expectedRuntimePaths(snapshot) {
  return {
    adapter: path.join(snapshot, 'agents/codex/runtime/validation-runner.mjs'),
    bridge: path.join(snapshot, 'agents/codex/runtime/managed-runner-bridge.mjs'),
    preflight: path.join(snapshot, 'agents/codex/runtime/managed-slice-preflight.mjs'),
    evidenceSerializer: path.join(snapshot, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs'),
  };
}

export async function createManagedSliceContext({
  officialPreflight,
  workspace,
  snapshot,
  adapterPath,
  bridgePath,
  preflightPath,
}) {
  if (officialPreflight?.exitCode !== 0 || !OPERATIONS.has(officialPreflight?.operation)) {
    fail('official runner preflight is required');
  }
  const canonicalWorkspace = await fs.realpath(workspace).catch(() => null);
  const canonicalSpec = await fs.realpath(officialPreflight.specPath).catch(() => null);
  const canonicalSnapshot = await fs.realpath(snapshot).catch(() => null);
  if (canonicalWorkspace !== workspace || canonicalSpec !== officialPreflight.specPath
    || canonicalSnapshot !== snapshot) fail('managed paths must be real canonical entries');
  if (!inside(canonicalSpec, canonicalWorkspace)) fail('SPEC_PATH is outside managed workspace');

  const expected = expectedRuntimePaths(canonicalSnapshot);
  for (const [value, label] of [[adapterPath, 'adapter'], [bridgePath, 'bridge'], [preflightPath, 'preflight'],
    [expected.evidenceSerializer, 'evidenceSerializer']]) {
    canonical(value, label);
    if (!inside(value, canonicalSnapshot)) fail(`${label} is outside frozen snapshot`);
    if (value !== expected[label]) fail(`${label} is not the snapshot-owned runtime`);
  }

  const operation = officialPreflight.operation;
  const slice = validSlice(officialPreflight.slice);
  if (!Array.isArray(officialPreflight.legalOperations)
    || !officialPreflight.legalOperations.some((entry) => entry?.operation === operation && entry?.slice === slice)) {
    fail('preflight legal operations do not authorize the managed operation');
  }
  if (typeof officialPreflight.state !== 'string' || officialPreflight.state === '') fail('preflight state is incomplete');

  return Object.freeze({
    version: 3,
    operation,
    slice,
    specPath: canonicalSpec,
    workspace: canonicalWorkspace,
    state: officialPreflight.state,
    authority: validAuthority(officialPreflight.authority),
    legalOperations: officialPreflight.legalOperations,
    mandatoryRecovery: officialPreflight.mandatoryRecovery ?? null,
    identity: {
      snapshot: await directoryIdentity(canonicalSnapshot, 'snapshot'),
      adapter: await fileIdentity(adapterPath, 'adapter', { executable: true }),
      bridge: await fileIdentity(bridgePath, 'bridge'),
      preflight: await fileIdentity(preflightPath, 'preflight'),
      evidenceSerializer: await fileIdentity(expected.evidenceSerializer, 'runner evidence serializer'),
    },
  });
}

export function managedEnvironment(environment, context) {
  if (context?.version !== 3 || !OPERATIONS.has(context.operation)) fail('context is invalid');
  if (environment[ADAPTER_ENV] !== undefined && environment[ADAPTER_ENV] !== context.identity.adapter.path) {
    fail('configured adapter disagrees with managed context');
  }
  return {
    ...environment,
    [CONTEXT_ENV]: JSON.stringify(context),
    [SPEC_ENV]: context.specPath,
    [WORKSPACE_ENV]: context.workspace,
    [OPERATION_ENV]: context.operation,
    [SLICE_ENV]: context.slice,
    [ADAPTER_ENV]: context.identity.adapter.path,
    [BRIDGE_ENV]: context.identity.bridge.path,
    [PREFLIGHT_ENV]: context.identity.preflight.path,
    [EVIDENCE_SERIALIZER_ENV]: context.identity.evidenceSerializer.path,
  };
}

export function readManagedSliceContext(environment = process.env) {
  const raw = environment[CONTEXT_ENV];
  const managedKeys = [SPEC_ENV, WORKSPACE_ENV, OPERATION_ENV, SLICE_ENV, BRIDGE_ENV, PREFLIGHT_ENV, EVIDENCE_SERIALIZER_ENV];
  if (raw === undefined && managedKeys.every((key) => environment[key] === undefined)) return null;
  if (typeof raw !== 'string' || raw.trim() === '') fail('context is absent or invalid');
  let context;
  try { context = JSON.parse(raw); } catch { fail('context JSON is invalid'); }
  if (context?.version !== 3 || !OPERATIONS.has(context.operation)) fail('context identity is invalid');
  canonical(context.specPath, 'context SPEC_PATH');
  canonical(context.workspace, 'context workspace');
  validSlice(context.slice);
  validAuthority(context.authority);
  if (!Array.isArray(context.legalOperations) || typeof context.state !== 'string' || context.state === '') {
    fail('context preflight is incomplete');
  }
  const expected = [
    [SPEC_ENV, context.specPath],
    [WORKSPACE_ENV, context.workspace],
    [OPERATION_ENV, context.operation],
    [SLICE_ENV, context.slice],
    [ADAPTER_ENV, context.identity?.adapter?.path],
    [BRIDGE_ENV, context.identity?.bridge?.path],
    [PREFLIGHT_ENV, context.identity?.preflight?.path],
    [EVIDENCE_SERIALIZER_ENV, context.identity?.evidenceSerializer?.path],
  ];
  if (expected.some(([key, value]) => typeof value !== 'string' || environment[key] !== value)) {
    fail('derived environment values disagree with context');
  }
  return context;
}

export function assertManagedAgreement({
  specPath,
  workspace,
  operation,
  slice: value,
  adapterPath,
  environment = process.env,
}) {
  const context = readManagedSliceContext(environment);
  if (context === null) return null;
  if (specPath !== undefined && path.resolve(specPath) !== context.specPath) fail('explicit SPEC_PATH disagrees with managed context');
  if (workspace !== undefined && path.resolve(workspace) !== context.workspace) fail('explicit workspace disagrees with managed context');
  if (operation !== undefined && operation !== context.operation) fail('explicit operation disagrees with managed context');
  if (value !== undefined && normalizedSlice(value) !== context.slice) fail('explicit slice disagrees with managed context');
  if (adapterPath !== undefined && path.resolve(adapterPath) !== context.identity.adapter.path) fail('adapter disagrees with managed context');
  return context;
}

// Identity and conclusion are required even when semantic acceptance failed.
// Rejected diagnostics are opt-in for blocker preparation only; the default
// still accepts only captured results. Manual launches have neither context nor broker.
export async function assertManagedRunnerReceipt({ operation, slice, workspace, receiptFile, semanticResponseFile, allowRejected = false, environment = process.env }) {
  const context = assertManagedAgreement({ operation, slice, workspace, environment });
  const activeFile = typeof environment.TMPDIR === 'string'
    ? path.join(environment.TMPDIR, 'stnl-runner-broker', 'active.json') : null;
  const active = activeFile === null ? null : await fs.readFile(activeFile, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (context === null && active === null) return null;
  if (receiptFile === undefined) fail('managed runner receipt is required; use the configured bridge and supply the receipt returned by the adapter');
  if (context === null || active === null) fail('managed context and active broker invocation are required');
  if (active.operation !== context.operation || active.slice !== context.slice
    || active.workspace !== context.workspace || active.officialPreflight?.specPath !== context.specPath
    || active.officialPreflight?.authority !== context.authority
    || !Number.isSafeInteger(active.sequence) || active.sequence < 1) fail('active broker identity disagrees with managed context');
  const tmpdir = await fs.realpath(environment.TMPDIR);
  if (active.tmpdir !== tmpdir) fail('active broker tmpdir disagrees');
  const receiptPath = await fs.realpath(receiptFile);
  const responsePath = await fs.realpath(semanticResponseFile);
  if (path.dirname(receiptPath) !== tmpdir || path.dirname(responsePath) !== tmpdir) fail('receipt or response is outside active broker tmpdir');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  const stem = `${String(active.sequence).padStart(3, '0')}-${operation.toLowerCase()}-${context.slice}-attempt-${receipt.attempt}`;
  const eventsPath = path.join(tmpdir, `${stem}.events.jsonl`);
  const rejected = allowRejected && receipt.status === 'RUNNER_RESULT_BLOCKED'
    && receipt.exitCode === 1 && receipt.semanticResponseStatus === null
    && receipt.testedState === null && receipt.formatRepair?.accepted !== true
    && receipt.captureFailureCode === 'RUNNER_RESPONSE_SCHEMA_INVALID'
    && typeof receipt.captureFailure === 'string' && receipt.captureFailure.trim() !== '';
  const accepted = receipt.status === 'RUNNER_RESPONSE_CAPTURED' && receipt.exitCode === 0
    && receipt.captureFailure === null && receipt.captureFailureCode == null
    && typeof receipt.semanticResponseStatus === 'string' && receipt.semanticResponseStatus.trim() !== ''
    && (receipt.formatRepair?.attempted !== true || receipt.formatRepair.accepted === true);
  if ((!accepted && !rejected) || receipt.runnerAgent !== 'stnl_validation_runner'
    || receipt.operation !== operation || receipt.slice !== context.slice || receipt.sequence !== active.sequence
    || receipt.authority !== context.authority
    || !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1 || receipt.attempt > 3
    || receiptPath !== path.join(tmpdir, `${stem}.receipt.json`)
    || responsePath !== path.join(tmpdir, `${stem}.response.json`)
    || receipt.receiptFile !== receiptPath || receipt.semanticResponseFile !== responsePath || receipt.eventsPath !== eventsPath
    || receipt.error != null || receipt.processError != null || receipt.providerError != null
    || typeof receipt.threadId !== 'string' || receipt.threadId.trim() === '') {
    fail('receipt does not match the active managed runner invocation');
  }
  const startedPath = path.join(tmpdir, `${stem}.started.json`);
  for (const file of [receiptPath, responsePath, eventsPath, startedPath]) {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail('runner evidence must be regular non-symlink files');
  }
  const started = JSON.parse(await fs.readFile(startedPath, 'utf8'));
  if (started.operation !== operation || started.sequence !== active.sequence
    || started.slice !== context.slice || started.attempt !== receipt.attempt
    || started.authority !== context.authority) fail('runner start identity disagrees');
  const bytes = await fs.readFile(responsePath);
  if (receipt.semanticResponseSha256 !== createHash('sha256').update(bytes).digest('hex')) fail('receipt response hash disagrees');
  if (accepted && JSON.parse(bytes.toString('utf8')).status !== receipt.semanticResponseStatus) fail('receipt semantic status disagrees');
  let finalMessage = null; let completed = 0; let threadId = null; let pending = false; let lastType = null;
  let eventOffset = 0;
  const repaired = receipt.formatRepair?.attempted === true;
  const repairTurn = receipt.formatRepair?.repairTurn;
  if (repaired && (operation !== 'VALIDATE_SLICE' || repairTurn?.completed !== true
    || repairTurn.threadId !== receipt.threadId || repairTurn.error != null
    || repairTurn.processError != null || repairTurn.errorEvent != null
    || receipt.formatRepair.threadId !== receipt.threadId
    || receipt.formatRepair.operationId !== `runner-${stem}`
    || !Number.isSafeInteger(receipt.formatRepair.eventOffset) || receipt.formatRepair.eventOffset < 1)) {
    fail('receipt format repair lacks a concluded original-thread turn');
  }
  let repairBoundary = !repaired;
  for (const line of (await fs.readFile(eventsPath, 'utf8')).split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (repaired && eventOffset === receipt.formatRepair.eventOffset) {
      if (pending || completed !== 1 || lastType !== 'turn.completed') fail('format repair boundary disagrees');
      repairBoundary = true;
    }
    if (event.operationId !== `runner-${stem}`) fail('runner SDK event identity disagrees');
    if (event.item?.type === 'collab_tool_call') fail('unmanaged runner collaboration is not official evidence');
    if (event.type === 'error' || event.type === 'turn.failed') fail('runner event stream reports an error');
    if (repaired && repairBoundary && event.item && !['agent_message', 'reasoning'].includes(event.item.type)) fail('format repair performed work');
    if (event.type === 'thread.started') {
      if (threadId !== null && threadId !== event.thread_id) fail('runner thread identity disagrees');
      threadId = event.thread_id;
    }
    if (event.type === 'turn.started') {
      if (pending) fail('runner SDK turn did not conclude');
      pending = true; finalMessage = null;
    }
    if (event.type === 'turn.completed') {
      if (!pending || typeof finalMessage !== 'string') fail('runner SDK turn lacks a final message');
      pending = false; completed += 1;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (!pending) fail('runner final message is outside a started turn');
      finalMessage = event.item.text;
    }
    lastType = event.type;
    eventOffset += Buffer.byteLength(line + '\n');
  }
  if (pending || completed !== (repaired ? 2 : 1) || !repairBoundary || lastType !== 'turn.completed'
    || threadId !== receipt.threadId || finalMessage !== bytes.toString('utf8')) {
    fail('receipt is not backed by the completed SDK turn and exact response');
  }
  if (`sha256:${await computeRequirementsAuthority(context.specPath)}` !== context.authority) fail('runner receipt authority is stale');
  if (rejected) {
    // A diagnostic can publish only the existing blocker while the original
    // operation and slice still have current official authority.
    await assertManagedRuntimeIdentity(context, environment);
    const current = await preflightExecutionOperation(context.specPath, operation, BigInt(context.slice.slice(6)).toString(10));
    if (`sha256:${current.currentFingerprint}` !== context.authority || current.state !== context.state
      || JSON.stringify(current.legalOperations) !== JSON.stringify(context.legalOperations)
      || JSON.stringify(current.mandatoryRecovery ?? null) !== JSON.stringify(context.mandatoryRecovery ?? null)) fail('rejected response authority is stale');
  }
  return context;
}

export async function assertManagedRuntimeIdentity(context, environment = process.env) {
  const current = readManagedSliceContext(environment);
  if (current === null || JSON.stringify(current) !== JSON.stringify(context)) fail('runtime context disagrees');
  const actual = {
    snapshot: await directoryIdentity(context.identity.snapshot.path, 'snapshot'),
    adapter: await fileIdentity(context.identity.adapter.path, 'adapter', { executable: true }),
    bridge: await fileIdentity(context.identity.bridge.path, 'bridge'),
    preflight: await fileIdentity(context.identity.preflight.path, 'preflight'),
    evidenceSerializer: await fileIdentity(context.identity.evidenceSerializer.path, 'runner evidence serializer'),
  };
  for (const key of Object.keys(actual)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(context.identity[key])) fail(`${key} identity changed`);
  }
  const expected = expectedRuntimePaths(context.identity.snapshot.path);
  if (context.identity.adapter.path !== expected.adapter || context.identity.bridge.path !== expected.bridge
    || context.identity.preflight.path !== expected.preflight
    || context.identity.evidenceSerializer.path !== expected.evidenceSerializer) fail('managed runtimes are not snapshot-owned');
  return true;
}

export {
  CONTEXT_ENV,
  SPEC_ENV,
  WORKSPACE_ENV,
  OPERATION_ENV,
  SLICE_ENV,
  ADAPTER_ENV,
  BRIDGE_ENV,
  PREFLIGHT_ENV,
  EVIDENCE_SERIALIZER_ENV,
};
