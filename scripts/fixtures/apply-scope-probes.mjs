// TEST-ONLY negative probes inside one owned fictitious-provider APPLY operation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { invokeIndependentRunner } from '../../agents/codex/runtime/validation-runner.mjs';
import { runManagedRunnerBridge } from '../../agents/codex/runtime/managed-runner-bridge.mjs';
import { readManagedSliceContext } from '../../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs';

const context = readManagedSliceContext(process.env);
const tmpdir = await fs.realpath(process.env.TMPDIR);
const directory = path.join(tmpdir, 'stnl-runner-broker');
const active = JSON.parse(await fs.readFile(path.join(directory, 'active.json')));
const stem = String(active.sequence).padStart(3, '0');
const latest = JSON.parse(await fs.readFile(path.join(directory, `${stem}.latest.json`)));
const sealed = JSON.parse(await fs.readFile(path.join(directory, `sealed-${latest.requestId}.json`)));
const repairFile = path.join(directory, `${stem}.scope-repair.json`);
const repairBytes = await fs.readFile(repairFile);
const repair = JSON.parse(repairBytes);
assert.equal(repair.originalChangedAreas.length, 1);
assert.equal(repair.canonicalChangedAreas.length, 6);
assert.equal(latest.receipt.testedState.entries.length, 6);
const receiptFile = latest.receipt.receiptFile;
const receiptBefore = await fs.readFile(receiptFile);
let sdkCalls = 0, budgetChecks = 0;
const invoke = overrides => invokeIndependentRunner({
  ...active, snapshot: context.identity.snapshot.path, env: process.env,
  officialPreflight: active.officialPreflight, prompt: sealed.prompt, managedPayload: sealed.managedPayload,
  runTurn: async () => { sdkCalls += 1; throw new Error('TEST-ONLY unexpected provider dispatch'); },
  ...overrides,
});
const changedAuthority = { ...process.env, STNL_MANAGED_CONTEXT: JSON.stringify({ ...context, authority: 'sha256:' + 'b'.repeat(64) }) };
await assert.rejects(invoke({ env: changedAuthority }), /stale|identity|authority|disagrees/u);
for (const target of ['src/cli.mjs', 'test/offline-case.json']) {
  const file = path.join(context.workspace, target), before = await fs.readFile(file);
  try {
    await fs.writeFile(file, Buffer.concat([before, Buffer.from('\n')]));
    await assert.rejects(invoke({}), /changed|stale/u);
  } finally { await fs.writeFile(file, before); }
}
await assert.rejects(invoke({ onBeforeTurn: async () => {
  budgetChecks += 1;
  throw Object.assign(new Error('TEST-ONLY insufficient runner budget'), { code: 'PAUSED_BUDGET_OR_QUOTA' });
} }), { code: 'PAUSED_BUDGET_OR_QUOTA' });
await assert.rejects(runManagedRunnerBridge({ environment: process.env, cwd: context.workspace,
  payload: repair.originalPrompt }), /after runner allocation|captured receipt|already consumed/u);
assert.equal(sdkCalls, 0);
assert.equal(budgetChecks, 1);
assert.deepEqual(await fs.readFile(receiptFile), receiptBefore);
assert.deepEqual(await fs.readFile(repairFile), repairBytes);
assert.equal((await fs.readdir(directory)).filter(name => name === `${stem}.scope-repair.json`).length, 1);
const offline = JSON.parse(await fs.readFile(process.env.STNL_OFFLINE_PROVIDER_CONTEXT));
await fs.writeFile(path.join(offline.root, '.offline-apply-scope-probes.json'), JSON.stringify({
  authorityRejected: true, sourceRejected: true, testsRejected: true, budgetRejected: true,
  capturedReceiptUnchanged: true, repairRecordUnchanged: true, repairRecords: 1, negativeSdkCalls: sdkCalls,
  budgetChecks, receiptSha256: createHash('sha256').update(receiptBefore).digest('hex'),
}));
