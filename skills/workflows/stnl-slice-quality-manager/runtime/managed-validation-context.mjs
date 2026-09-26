import path from 'node:path';
import fs from 'node:fs/promises';

const CONTEXT_ENV = 'STNL_MANAGED_CONTEXT';
const SPEC_ENV = 'STNL_MANAGED_SPEC_PATH';
const WORKSPACE_ENV = 'STNL_MANAGED_WORKSPACE';
const SLICE_ENV = 'STNL_MANAGED_SLICE';

function fail(message) {
  const error = new Error(`managed validation context: ${message}`);
  error.code = 'MANAGED_CONTEXT_INVALID';
  throw error;
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/u.test(value)) {
    fail(`${label} must be an absolute canonical path`);
  }
  return value;
}

function slice(value) {
  if (typeof value !== 'string' || !/^slice-[0-9]{2,}$/u.test(value)) fail('slice is invalid');
  return value;
}

export async function createManagedValidationContext({ officialPreflight, workspace }) {
  if (officialPreflight?.operation !== 'VALIDATE_SLICE' || officialPreflight?.exitCode !== 0) {
    fail('official VALIDATE_SLICE preflight is required');
  }
  const canonicalWorkspace = await fs.realpath(workspace).catch(() => null);
  const canonicalSpec = await fs.realpath(officialPreflight.specPath).catch(() => null);
  if (canonicalWorkspace !== workspace || canonicalSpec !== officialPreflight.specPath) fail('managed paths must be real canonical entries');
  const relative = path.relative(canonicalWorkspace, canonicalSpec);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('SPEC_PATH is outside managed workspace');
  const context = {
    version: 1,
    operation: 'VALIDATE_SLICE',
    slice: slice(officialPreflight.slice),
    specPath: absolute(canonicalSpec, 'SPEC_PATH'),
    workspace: absolute(canonicalWorkspace, 'workspace'),
    state: officialPreflight.state,
    authority: officialPreflight.authority,
    legalOperations: officialPreflight.legalOperations,
    mandatoryRecovery: officialPreflight.mandatoryRecovery ?? null,
  };
  if (typeof context.state !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(context.authority)
    || !Array.isArray(context.legalOperations)) fail('preflight state is incomplete');
  return Object.freeze(context);
}

export function managedEnvironment(environment, context) {
  const value = JSON.stringify(context);
  return { ...environment, [CONTEXT_ENV]: value, [SPEC_ENV]: context.specPath,
    [WORKSPACE_ENV]: context.workspace, [SLICE_ENV]: context.slice };
}

export function readManagedValidationContext(environment = process.env) {
  const raw = environment[CONTEXT_ENV];
  const derived = [environment[SPEC_ENV], environment[WORKSPACE_ENV], environment[SLICE_ENV]];
  if (raw === undefined && derived.every((value) => value === undefined)) return null;
  if (typeof raw !== 'string' || raw.trim() === '' || derived.some((value) => typeof value !== 'string')) {
    fail('context and derived environment values must all be present');
  }
  let context;
  try { context = JSON.parse(raw); } catch { fail('context JSON is invalid'); }
  if (context?.version !== 1 || context.operation !== 'VALIDATE_SLICE') fail('context identity is invalid');
  absolute(context.specPath, 'context SPEC_PATH');
  absolute(context.workspace, 'context workspace');
  slice(context.slice);
  if (context.specPath !== environment[SPEC_ENV] || context.workspace !== environment[WORKSPACE_ENV]
    || context.slice !== environment[SLICE_ENV]) fail('derived environment values disagree with JSON context');
  if (context.state === undefined || !/^sha256:[a-f0-9]{64}$/u.test(context.authority)
    || !Array.isArray(context.legalOperations)) fail('context preflight is incomplete');
  return context;
}

export function assertManagedAgreement({ specPath, workspace, slice: value, environment = process.env }) {
  const context = readManagedValidationContext(environment);
  if (context === null) return null;
  if (specPath !== undefined && path.resolve(specPath) !== context.specPath) fail('explicit SPEC_PATH disagrees with managed context');
  if (workspace !== undefined && path.resolve(workspace) !== context.workspace) fail('explicit workspace disagrees with managed context');
  if (value !== undefined) {
    const normalized = /^slice-/.test(String(value)) ? String(value) : `slice-${BigInt(value).toString(10).padStart(2, '0')}`;
    if (normalized !== context.slice) fail('explicit slice disagrees with managed context');
  }
  return context;
}

export { CONTEXT_ENV, SPEC_ENV, WORKSPACE_ENV, SLICE_ENV };
