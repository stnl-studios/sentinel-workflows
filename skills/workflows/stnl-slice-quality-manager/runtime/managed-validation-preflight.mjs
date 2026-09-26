#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { preflightExecutionOperation } from './execution-state.mjs';
import { readManagedValidationContext } from './managed-validation-context.mjs';

export async function main(argv, environment = process.env) {
  if (argv.length !== 0) throw new Error('managed validation preflight takes no path or slice arguments');
  const context = readManagedValidationContext(environment);
  if (context === null) throw new Error('managed validation context is absent');
  const inputSlice = BigInt(context.slice.slice('slice-'.length)).toString(10);
  const current = await preflightExecutionOperation(context.specPath, context.operation, inputSlice);
  if (current.operation !== context.operation || current.slice !== context.slice
    || current.state !== context.state
    || `sha256:${current.currentFingerprint}` !== context.authority
    || JSON.stringify(current.legalOperations) !== JSON.stringify(context.legalOperations)
    || JSON.stringify(current.mandatoryRecovery) !== JSON.stringify(context.mandatoryRecovery)) {
    throw new Error('managed validation preflight identity is stale');
  }
  process.stdout.write(`PASS: ${current.operation} managed preflight state=${current.state} slice=${current.slice} authority=${context.authority}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
