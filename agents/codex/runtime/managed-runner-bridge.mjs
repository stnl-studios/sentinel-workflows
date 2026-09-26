#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readManagedSliceContext, assertManagedRuntimeIdentity } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs';
import { assertManagedSliceFreshness } from './managed-slice-preflight.mjs';

export async function runManagedRunnerBridge({
  environment = process.env,
  cwd = process.cwd(),
  payload,
  verifyFreshness = assertManagedSliceFreshness,
  loadAdapter = async (adapter) => import(pathToFileURL(adapter).href),
}) {
  const context = readManagedSliceContext(environment); if (!context) throw new Error('managed slice context is absent');
  await assertManagedRuntimeIdentity(context, environment);
  if (typeof payload !== 'string' || payload.trim() === '') throw new Error('semantic runner payload is empty');
  await verifyFreshness(environment);
  const workspace = await fs.realpath(cwd);
  if (workspace !== context.workspace) throw new Error('managed runner bridge workspace disagrees');
  const adapter = await fs.realpath(context.identity.adapter.path);
  if (adapter !== context.identity.adapter.path) throw new Error('managed adapter is not canonical');
  const module = await loadAdapter(adapter);
  if (typeof module.submitRunnerPayload !== 'function') throw new Error('managed adapter export is invalid');
  return module.submitRunnerPayload({ environment, cwd: workspace, operation: context.operation,
    slice: context.slice, prompt: payload });
}

export async function main(argv, environment = process.env) {
  if (argv.length !== 0) throw new Error('managed runner bridge takes no path or operation arguments');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const result = await runManagedRunnerBridge({ environment, payload: Buffer.concat(chunks).toString('utf8') });
  process.stdout.write(`SENTINEL_RUNNER_RECEIPT ${JSON.stringify(result)}\n`); return result.exitCode;
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
