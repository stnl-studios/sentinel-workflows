import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTEXT_ENV = 'STNL_MANAGED_CONTEXT';
const SPEC_ENV = 'STNL_MANAGED_SPEC_PATH';
const WORKSPACE_ENV = 'STNL_MANAGED_WORKSPACE';
const OPERATION_ENV = 'STNL_MANAGED_OPERATION';
const SLICE_ENV = 'STNL_MANAGED_SLICE';
const ADAPTER_ENV = 'STNL_RUNNER_ADAPTER';
const BRIDGE_ENV = 'STNL_MANAGED_RUNNER_BRIDGE';
const PREFLIGHT_ENV = 'STNL_MANAGED_PREFLIGHT';
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
  for (const [value, label] of [[adapterPath, 'adapter'], [bridgePath, 'bridge'], [preflightPath, 'preflight']]) {
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
    version: 2,
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
    },
  });
}

export function managedEnvironment(environment, context) {
  if (context?.version !== 2 || !OPERATIONS.has(context.operation)) fail('context is invalid');
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
  };
}

export function readManagedSliceContext(environment = process.env) {
  const raw = environment[CONTEXT_ENV];
  const managedKeys = [SPEC_ENV, WORKSPACE_ENV, OPERATION_ENV, SLICE_ENV, BRIDGE_ENV, PREFLIGHT_ENV];
  if (raw === undefined && managedKeys.every((key) => environment[key] === undefined)) return null;
  if (typeof raw !== 'string' || raw.trim() === '') fail('context is absent or invalid');
  let context;
  try { context = JSON.parse(raw); } catch { fail('context JSON is invalid'); }
  if (context?.version !== 2 || !OPERATIONS.has(context.operation)) fail('context identity is invalid');
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

export async function assertManagedRuntimeIdentity(context, environment = process.env) {
  const current = readManagedSliceContext(environment);
  if (current === null || JSON.stringify(current) !== JSON.stringify(context)) fail('runtime context disagrees');
  const actual = {
    snapshot: await directoryIdentity(context.identity.snapshot.path, 'snapshot'),
    adapter: await fileIdentity(context.identity.adapter.path, 'adapter', { executable: true }),
    bridge: await fileIdentity(context.identity.bridge.path, 'bridge'),
    preflight: await fileIdentity(context.identity.preflight.path, 'preflight'),
  };
  for (const key of Object.keys(actual)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(context.identity[key])) fail(`${key} identity changed`);
  }
  const expected = expectedRuntimePaths(context.identity.snapshot.path);
  if (context.identity.adapter.path !== expected.adapter || context.identity.bridge.path !== expected.bridge
    || context.identity.preflight.path !== expected.preflight) fail('managed runtimes are not snapshot-owned');
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
};
