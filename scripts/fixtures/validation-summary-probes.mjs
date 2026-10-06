// TEST-ONLY semantic proposals; real finalizer, receipt and publication gates.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { offlineProviderContext } from '../../agents/codex/runtime/offline-provider-context.mjs';
import { readManagedSliceContext } from '../../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs';
import { computeRequirementsAuthority, inspectExecutionState } from '../../skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs';

const snapshot = path.resolve(process.env.STNL_CODEX_ADAPTER, '../../..');
const offline = await offlineProviderContext(process.env, snapshot);
assert.equal(offline?.scenario, 'finalize-revalidation-rejection');
const context = readManagedSliceContext(process.env);
assert.equal(context.operation, 'VALIDATE_SLICE');
const directory = path.join(process.env.TMPDIR, 'stnl-runner-broker');
const read = async file => JSON.parse(await fs.readFile(file));
const active = await read(path.join(directory, 'active.json'));
const stem = String(active.sequence).padStart(3, '0');
const latest = await read(path.join(directory, stem + '.latest.json'));
const receipt = latest.receipt;
assert.equal(receipt.semanticResponseStatus, 'PASS');
const state = await inspectExecutionState(context.specPath);
const selected = state.tasks.get(context.slice);
assert.equal(state.state, 'FINDINGS_CORRECTED');
assert.equal(selected.attempts.length, 1);
assert.equal(selected.attempts[0].status, 'NEEDS_FIX');
const attempt = 'attempt-02';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function tree(root, relative = '', output = {}) {
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = path.join(relative, entry.name), file = path.join(root, key);
    const mode = (await fs.lstat(file)).mode & 0o777;
    if (entry.isDirectory()) { output[key] = { mode, directory: true }; await tree(root, key, output); }
    else { assert.equal(entry.isFile(), true); output[key] = { mode, sha256: hash(await fs.readFile(file)) }; }
  }
  return output;
}
const evidenceFiles = [receipt.receiptFile, receipt.semanticResponseFile, receipt.eventsPath,
  receipt.receiptFile.replace(/\.receipt\.json$/u, '.started.json'), path.join(directory, stem + '.latest.json'),
  path.join(directory, 'sealed-' + latest.requestId + '.json')];
const evidence = async () => Object.fromEntries(await Promise.all(evidenceFiles.map(async file => [file, hash(await fs.readFile(file))])));
const inputs = async () => ({ authority: await computeRequirementsAuthority(context.specPath),
  source: await tree(path.join(context.workspace, 'src')), tests: await tree(path.join(context.workspace, 'test')) });
const liveRoot = path.join(context.specPath, 'execution');
const before = { live: await tree(liveRoot), inputs: await inputs(), evidence: await evidence() };
const invoke = (file, args = []) => {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: context.workspace, env: process.env,
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  return { exit: result.status, diagnostic: result.stderr, output: result.stdout };
};
const finalize = () => invoke(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
const finalizationFile = path.join(directory, stem + '.finalization.json');
const replaceSection = (text, heading, body) => {
  const expression = new RegExp(`(## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, 'u');
  assert.equal(expression.test(text), true);
  return text.replace(expression, (_, marker) => marker + body + '\n');
};
const summary = 'The prepared high-priority variant and unchanged CLI behavior were independently checked.';
const resolveFinding = text => replaceSection(text, 'Validation Findings',
  selected.sections.get('Validation Findings').replace('- State: active', '- State: resolved')
    + '\n- Resolution: ' + attempt + ' verified the corrected prepared variant and CLI regressions.');
const rejected = [];
let binding = await read(path.join(directory, stem + '.candidate.json'));
for (const [name, resolved, diffSummary] of [['disposition', false, summary], ['summary-format', true, summary]]) {
  let text = await fs.readFile(binding.candidateTaskArtifact, 'utf8');
  if (resolved) text = resolveFinding(text);
  await fs.writeFile(binding.candidateTaskArtifact, replaceSection(text, 'Diff Summary', diffSummary));
  const inputTree = await tree(binding.candidateExecutionRoot);
  const result = finalize();
  assert.equal(result.exit, 1, result.output);
  const checkpoint = await read(path.join(directory, `${stem}.preparation-${binding.nonce}-attempt-${receipt.attempt}.json`));
  assert.equal(checkpoint.status, 'REJECTED');
  assert.equal(checkpoint.association.receiptFile, receipt.receiptFile);
  assert.deepEqual(await tree(binding.candidateExecutionRoot), inputTree);
  assert.deepEqual(await tree(liveRoot), before.live);
  assert.deepEqual(await inputs(), before.inputs);
  assert.deepEqual(await evidence(), before.evidence);
  assert.equal(await fs.access(finalizationFile).then(() => true, () => false), false);
  rejected.push({ name, result, binding, inputTree, checkpoint, stageTree: await tree(checkpoint.stage.candidateExecutionRoot) });
  const preflight = invoke(process.env.STNL_MANAGED_PREFLIGHT);
  assert.equal(preflight.exit, 0, preflight.diagnostic);
  const prepared = invoke(process.env.STNL_MANAGED_FINALIZER, ['--prepare']);
  assert.equal(prepared.exit, 0, prepared.diagnostic);
  binding = await read(path.join(directory, stem + '.candidate.json'));
}
const fresh = await fs.readFile(binding.candidateTaskArtifact, 'utf8');
const corrected = replaceSection(resolveFinding(fresh), 'Diff Summary', '- ' + summary);
await fs.writeFile(binding.candidateTaskArtifact, corrected);
const final = finalize();
assert.equal(final.exit, 0, final.diagnostic);
const duplicate = finalize();
assert.equal(duplicate.exit, 0, duplicate.diagnostic);
const finalState = await inspectExecutionState(context.specPath);
const task = finalState.tasks.get(context.slice);
assert.equal(finalState.state, 'COMPLETE');
assert.equal(task.attempts.length, 2);
assert.equal(task.attempts[0].body, selected.attempts[0].body);
assert.equal(task.attempts[1].status, 'PASS');
assert.equal(task.findings[0].state, 'resolved');
assert.deepEqual(await inputs(), before.inputs);
assert.deepEqual(await evidence(), before.evidence);
for (const prior of rejected) {
  assert.deepEqual(await tree(prior.binding.candidateExecutionRoot), prior.inputTree);
  assert.deepEqual(await tree(prior.checkpoint.stage.candidateExecutionRoot), prior.stageTree);
}
await fs.writeFile(path.join(offline.root, '.offline-revalidation-summary.json'), JSON.stringify({
  receipt, rejected, before, final, duplicate, binding, fresh, corrected,
  after: { inputs: await inputs(), evidence: await evidence(), live: await tree(liveRoot) },
  publishedTask: await fs.readFile(path.join(liveRoot, 'tasks', context.slice + '.md'), 'utf8'),
  finalization: await read(finalizationFile), finalState: finalState.state,
}, null, 2) + '\n');
