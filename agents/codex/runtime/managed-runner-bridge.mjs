#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
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

export async function readManagedPayloadFile(file, environment = process.env) {
  const context = readManagedSliceContext(environment);
  if (context === null) throw new Error('managed slice context is absent');
  const tmpdir = await fs.realpath(environment.TMPDIR);
  const activeFile = path.join(tmpdir, 'stnl-runner-broker/active.json');
  const activeMetadata = await fs.lstat(activeFile);
  if (!activeMetadata.isFile() || activeMetadata.isSymbolicLink() || activeMetadata.nlink !== 1
    || await fs.realpath(activeFile) !== activeFile) throw new Error('managed broker identity file is unsafe');
  const active = JSON.parse(await fs.readFile(activeFile, 'utf8'));
  if (file !== environment.STNL_MANAGED_RUNNER_PAYLOAD || file !== active.payloadFile
    || active.protocol !== 3 || path.dirname(file) !== tmpdir || active.workspace !== context.workspace
    || active.operation !== context.operation || active.slice !== context.slice
    || active.officialPreflight.specPath !== context.specPath || !Number.isSafeInteger(active.sequence) || active.sequence < 1
    || active.officialPreflight.authority !== context.authority || await fs.realpath(file) !== file) {
    throw new Error('managed payload-file identity disagrees');
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size === 0 || metadata.size > 256 * 1024) {
      throw new Error('managed payload-file must be a nonempty regular single-link file of at most 256 KiB');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size || bytes.length > 256 * 1024) throw new Error('managed payload-file changed while reading');
    const payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(payload);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('managed payload-file must contain one JSON object');
    return payload;
  } finally { await handle.close(); }
}

export async function main(argv, environment = process.env) {
  // Reject missing arguments before touching stdin, including a pipe left open
  // by the caller. Native stdin remains owned by validation-runner.mjs.
  if (argv.length !== 2 || argv[0] !== '--payload-file') throw new Error('usage: managed-runner-bridge.mjs --payload-file "$STNL_MANAGED_RUNNER_PAYLOAD"');
  const payload = await readManagedPayloadFile(argv[1], environment);
  const result = await runManagedRunnerBridge({ environment, payload });
  process.stdout.write(`SENTINEL_RUNNER_RECEIPT ${JSON.stringify(result)}\n`); return result.exitCode;
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
