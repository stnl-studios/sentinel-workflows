#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { preflightExecutionOperation, readExecutionActivation } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs';
import { readManagedSliceContext, assertManagedRuntimeIdentity } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs';

import { assertExecutionAttempt } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/execution-publication.mjs';

export async function assertManagedSliceFreshness(environment = process.env) {
  const context = readManagedSliceContext(environment); if (context === null) throw new Error('managed slice context is absent');
  await assertManagedRuntimeIdentity(context, environment);
  const numericSlice = BigInt(context.slice.slice('slice-'.length)).toString(10);
  const current = await preflightExecutionOperation(context.specPath, context.operation, numericSlice, { owner: context.owner });
  const activated = await readExecutionActivation(context.specPath);
  assertExecutionAttempt(activated.activation, context.owner);
  // Operational publication by this owner can advance CAS/state. It does not create a new runner attempt.
  if (current.operation !== context.operation || current.slice !== context.slice
    || `sha256:${current.currentFingerprint}` !== context.authority) {
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
