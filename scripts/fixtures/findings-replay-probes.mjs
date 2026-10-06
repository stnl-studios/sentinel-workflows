// TEST-ONLY fault and replay probes within one owned APPLY operation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { captureManagedTree } from '../../agents/codex/runtime/managed-slice-finalize.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file));
const context = JSON.parse(process.env.STNL_MANAGED_CONTEXT);
const offline = await read(process.env.STNL_OFFLINE_PROVIDER_CONTEXT);
const boundary = process.argv[2];
assert.ok(['private', 'published'].includes(boundary));
const directory = path.join(process.env.TMPDIR, 'stnl-runner-broker');
const active = await read(path.join(directory, 'active.json')), stem = String(active.sequence).padStart(3, '0');
const binding = await read(path.join(directory, stem + '.candidate.json'));
const latest = await read(path.join(directory, stem + '.latest.json')), receipt = latest.receipt;
const finalizedFile = path.join(directory, stem + '.finalization.json');
const sealedFile = path.join(directory, 'sealed-' + latest.requestId + '.json');
const preparationFile = path.join(directory, `${stem}.preparation-${binding.nonce}-attempt-${receipt.attempt}.json`);
const liveTask = binding.liveTaskArtifact;
const evidence = [receipt.receiptFile, receipt.eventsPath, receipt.semanticResponseFile, receipt.receiptFile.replace(/\.receipt\.json$/u, '.started.json')];
const digest = async file => hash(await fs.readFile(file));
const images = async () => ({ live: await captureManagedTree(path.dirname(path.dirname(liveTask))), candidate: await captureManagedTree(binding.candidateExecutionRoot), evidence: Object.fromEntries(await Promise.all(evidence.map(async file => [file, await digest(file)]))) });
const invoke = (injection = null, env = {}) => spawnSync(process.execPath, [...(injection === null ? [] : ['--import', injection]), process.env.STNL_MANAGED_FINALIZER, '--finalize'], { cwd: context.workspace, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
const before = await images();
const injection = path.join(offline.root, `.offline-owned-${boundary}-finalization-fault.mjs`);
await fs.writeFile(injection, `import fs from 'node:fs/promises';\nconst original = fs.rename.bind(fs);\nconst destination = ${JSON.stringify(finalizedFile)};\nfs.rename = async (from, to) => { if (to === destination) throw Object.assign(new Error('TEST-ONLY finalization write after ${boundary} effects'), { code: 'EIO' }); return original(from, to); };\n`);
const first = invoke(injection);
assert.equal(first.status, 1);
assert.match(first.stderr, /TEST-ONLY finalization write after/);
const prepared = await read(preparationFile);
assert.equal(prepared.status, 'PREPARED');
assert.equal(prepared.privateFailure, boundary === 'private');
const afterFault = await images();
assert.deepEqual(afterFault.evidence, before.evidence);
if (boundary === 'private') { assert.deepEqual(afterFault.live, before.live); assert.deepEqual(afterFault.candidate, prepared.stageTree); }
else { assert.deepEqual(afterFault.live, prepared.liveAfter); assert.deepEqual(afterFault.candidate, before.candidate); }
const probes = [];
async function divergent(name, file, modify = bytes => Buffer.concat([bytes, Buffer.from('\n<!-- TEST-ONLY foreign edit -->\n')])) {
  const original = await fs.readFile(file), altered = modify(original);
  try {
    await fs.writeFile(file, altered);
    const result = invoke();
    assert.equal(result.status, 1, name);
    assert.deepEqual(await fs.readFile(file), altered, 'rejected replay preserves foreign bytes');
    probes.push({ name, diagnostic: result.stderr });
  } finally { await fs.writeFile(file, original); }
}
await divergent('candidate image', binding.candidateTaskArtifact);
await divergent('live image', liveTask);
await divergent('source hash', path.join(context.workspace, 'src/cli.mjs'));
await divergent('test hash', path.join(context.workspace, 'test/offline-case.json'));
await divergent('sealed ownership', sealedFile, bytes => { const value = JSON.parse(bytes); value.findingsOwnership.canonicalCycle = 'attempt-99'; return Buffer.from(JSON.stringify(value)); });
await divergent('prepared association', preparationFile, bytes => { const value = JSON.parse(bytes); value.association.bindingSha256 = 'foreign'; return Buffer.from(JSON.stringify(value)); });
if (await fs.access(prepared.stage.candidateTaskArtifact).then(() => true, () => false)) await divergent('stage image', prepared.stage.candidateTaskArtifact);
const badAuthority = invoke(null, { STNL_MANAGED_CONTEXT: JSON.stringify({ ...context, authority: 'sha256:' + 'b'.repeat(64) }) });
assert.equal(badAuthority.status, 1); probes.push({ name: 'authority', diagnostic: badAuthority.stderr });
const replay = invoke();
const afterReplay = await images();
await fs.writeFile(path.join(offline.root, `.offline-findings-replay-${boundary}.json`), JSON.stringify({ boundary, first: { exit: first.status, diagnostic: first.stderr }, replay: { exit: replay.status, diagnostic: replay.stderr }, before, afterFault, afterReplay, probes, receiptFile: receipt.receiptFile, preparationStatus: prepared.status }));
assert.equal(replay.status, 0, replay.stderr);
assert.deepEqual(afterReplay, afterFault, 'replay preserves already installed private/public images and raw evidence');
const again = invoke();
assert.equal(again.status, 0, again.stderr);
assert.deepEqual(await images(), afterReplay);
assert.equal(JSON.parse(again.stdout).receiptFile, receipt.receiptFile);
console.log(JSON.stringify({ boundary, replayExit: replay.status, probes: probes.length, receiptFile: receipt.receiptFile }));
