#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { preflightExecutionOperation } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs';
import { readManagedSliceContext, assertManagedRuntimeIdentity } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs';

export async function assertManagedSliceFreshness(environment = process.env) {
  const context = readManagedSliceContext(environment); if (context === null) throw new Error('managed slice context is absent');
  await assertManagedRuntimeIdentity(context, environment);
  const numericSlice = BigInt(context.slice.slice('slice-'.length)).toString(10);
  const current = await preflightExecutionOperation(context.specPath, context.operation, numericSlice);
  if (current.operation !== context.operation || current.slice !== context.slice || current.state !== context.state
    || `sha256:${current.currentFingerprint}` !== context.authority
    || JSON.stringify(current.legalOperations) !== JSON.stringify(context.legalOperations)
    || JSON.stringify(current.mandatoryRecovery ?? null) !== JSON.stringify(context.mandatoryRecovery ?? null)) {
    const error = new Error('managed slice preflight identity is stale');
    error.code = 'MANAGED_CONTEXT_STALE';
    throw error;
  }
  return { context, current };
}

export async function main(argv, environment = process.env) {
  if (argv.length !== 0) throw new Error('managed slice preflight takes no path or slice arguments');
  const { context, current } = await assertManagedSliceFreshness(environment);
  process.stdout.write(`PASS: ${current.operation} managed preflight state=${current.state} slice=${current.slice} authority=${context.authority}\n`);
  return 0;
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
