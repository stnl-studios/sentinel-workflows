import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appServerRpc, initializeAppServer, describeAppServerBundle, assertAppServerBundle,
  selectAppServerBundle, startAppServerTurn, bindAppServerChild, readAppServerChild,
  writeNativeToolResult, captureAppServerChild } from '../agents/codex/runtime/app-server-transport.mjs';
import { reservedOperation } from './fixtures/current-native-operation.mjs';
import { bindNative, verifyNative, captureNative, resume } from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const blocked = error => error.code === 'NATIVE_TRANSPORT_UNPROVEN';
const parent = '019a0000-0000-7000-8000-000000000001';
const child = '019a0000-0000-7000-8000-000000000002';
const identity = { parentThreadId: parent, parentTurnId: 'parent-turn', agentPath: '/root/check-one' };

async function fixture(t) {
  await fs.mkdir(path.join(repo, 'tmp'), { recursive: true });
  const root = await fs.mkdtemp(path.join(repo, 'tmp/app-server-offline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'skills'), runnerFile = path.join(root,
    'agents/codex/.codex/agents/stnl_validation_runner.toml');
  for (const skill of ['stnl-slice-executor', 'stnl-slice-quality-manager']) {
    await fs.mkdir(path.join(skillsRoot, skill, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, skill, 'SKILL.md'), `---\nname: ${skill}\n---\nOffline fixture only\n`);
    await fs.writeFile(path.join(skillsRoot, skill, 'runtime/helper.mjs'), '// frozen sibling fixture\n');
  }
  await fs.mkdir(path.dirname(runnerFile), { recursive: true });
  await fs.copyFile(path.join(repo, 'agents/codex/.codex/agents/stnl_validation_runner.toml'), runnerFile);
  return { root, bundle: await describeAppServerBundle({ skillsRoot, runnerFile }) };
}

function server({ bundle, cwd, response = '  resultado íntegro\r\n𝛑\n', mutate = () => {} }) {
  const calls = [];
  const final = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response };
  const activity = { id: 'spawn', type: 'subAgentActivity', kind: 'started', agentPath: identity.agentPath,
    agentThreadId: child, model: 'gpt-6-luna', reasoningEffort: 'medium' };
  const state = {
    parentItems: [activity, { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
      senderThreadId: parent, receiverThreadIds: [], agentsStates: {} }],
    thread: { id: child, parentThreadId: parent, forkedFromId: null, cliVersion: '0.163.0',
      cwd, agentRole: 'stnl_validation_runner' },
    turns: [{ id: 'child-turn', rootTurnId: 'parent-turn', items: [structuredClone(final)],
      itemsView: 'full', status: 'completed', error: null }],
    items: [final],
    listing: { data: [{ cwd, errors: [], skills: [
      ...bundle.files.filter(file => path.basename(file.path) === 'SKILL.md').map(file => ({
        path: file.path, name: path.basename(path.dirname(file.path)), enabled: true })),
      { path: '/normal-home/.agents/skills/stnl-slice-executor/SKILL.md', name: 'stnl-slice-executor', enabled: true },
    ] }] },
  };
  mutate(state);
  return { calls, state, rpc: {
    notify(method, params) { calls.push({ method, params }); },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'initialize') return { userAgent: 'codex-cli/0.163.0' };
      if (method === 'skills/extraRoots/set') return {};
      if (method === 'skills/list') return structuredClone(state.listing);
      if (method === 'thread/start') return { thread: { id: parent, cwd, cliVersion: '0.163.0' } };
      if (method === 'turn/start') return { turn: { id: 'parent-turn' } };
      if (method === 'thread/read') { assert.equal(params.threadId, child); return { thread: structuredClone(state.thread) }; }
      if (method === 'thread/turns/list') { assert.equal(params.threadId, child); return { data: structuredClone(state.turns), nextCursor: null }; }
      if (method === 'thread/items/list') {
        if (params.threadId === parent) {
          assert.equal(params.turnId, 'parent-turn'); return { data: structuredClone(state.parentItems), nextCursor: null };
        }
        assert.equal(params.threadId, child); assert.equal(params.turnId, 'child-turn');
        return { data: structuredClone(state.items), nextCursor: null };
      }
      assert.fail(`unexpected method ${method}`);
    },
  } };
}

test('S2 frozen paths select the intended skill despite homonyms; all siblings/runner are pinned', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  await initializeAppServer(s.rpc);
  const selected = await selectAppServerBundle(s.rpc, { bundle: f.bundle, cwd: f.root, skillName: 'stnl-slice-executor' });
  assert.deepEqual(selected.input, { type: 'skill', name: 'stnl-slice-executor',
    path: path.join(f.bundle.skillsRoot, 'stnl-slice-executor/SKILL.md') });
  assert.equal(selected.config['agents.stnl_validation_runner.config_file'], f.bundle.runner.path);
  assert.deepEqual(selected.config['skills.config'].map(value => value.enabled), [true, true, false]);
  assert.deepEqual(s.calls.find(value => value.method === 'skills/extraRoots/set').params, { extraRoots: [f.bundle.skillsRoot] });
  assert.deepEqual(s.calls.find(value => value.method === 'skills/list').params, { cwds: [f.root], forceReload: true });
});

for (const [name, change] of Object.entries({
  absent: s => s.listing.data[0].skills.shift(),
  disabled: s => { s.listing.data[0].skills[0].enabled = false; },
  homonymOnly: s => { s.listing.data[0].skills = s.listing.data[0].skills.slice(2); },
  wrongName: s => { s.listing.data[0].skills[0].name = 'stnl-other'; },
  duplicate: s => s.listing.data[0].skills.push(s.listing.data[0].skills[0]),
  discoveryError: s => s.listing.data[0].errors.push({ message: 'incomplete' }),
  wrongCwd: s => { s.listing.data[0].cwd = '/foreign'; },
})) test(`S2 discovery blocks ${name} before thread creation`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, mutate: change });
  await assert.rejects(() => startAppServerTurn(s.rpc, { bundle: f.bundle, cwd: f.root,
    skillName: 'stnl-slice-executor', prompt: 'normal input', model: 'gpt-6.1-sol', effort: 'high',
    approvalPolicy: 'never', sandbox: 'workspace-write' }), blocked);
  assert.equal(s.calls.some(call => /^(?:thread|turn)\/start$/u.test(call.method)), false);
});

for (const kind of ['skill', 'sibling', 'runner', 'extra-file', 'symlink', 'mode']) {
  test(`S2 refuses frozen ${kind} drift before any public request`, async t => {
    const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
    const file = f.bundle.files.find(file => file.path.endsWith(kind === 'skill' ? 'SKILL.md' : 'helper.mjs')).path;
    if (kind === 'runner') await fs.appendFile(f.bundle.runner.path, '\n# changed\n');
    else if (kind === 'extra-file') await fs.writeFile(path.join(f.bundle.skillsRoot, 'extra'), 'changed');
    else if (kind === 'symlink') { await fs.unlink(file); await fs.symlink(f.bundle.runner.path, file); }
    else if (kind === 'mode') await fs.chmod(file, 0o700);
    else await fs.appendFile(file, '\nchanged');
    await assert.rejects(() => selectAppServerBundle(s.rpc, { bundle: f.bundle, cwd: f.root,
      skillName: 'stnl-slice-executor' }), blocked);
    assert.equal(s.calls.length, 0);
  });
}

test('S2 explicit fresh turn settings do not copy auth or disable collaboration', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const result = await startAppServerTurn(s.rpc, { bundle: f.bundle, cwd: f.root,
    skillName: 'stnl-slice-executor', prompt: 'normal payload', model: 'gpt-6.1-sol', effort: 'high',
    approvalPolicy: 'never', sandbox: 'workspace-write' });
  assert.deepEqual(result, { threadId: parent, turnId: 'parent-turn' });
  const start = s.calls.find(call => call.method === 'thread/start');
  assert.equal(start.params.config['features.multi_agent'], undefined);
  assert.equal(start.params.config['agents.stnl_validation_runner.config_file'], f.bundle.runner.path);
  assert.deepEqual(s.calls.at(-1).params.input, [{ type: 'skill', name: 'stnl-slice-executor',
    path: path.join(f.bundle.skillsRoot, 'stnl-slice-executor/SKILL.md') }, { type: 'text', text: 'normal payload' }]);
});

test('S2 unsupported context/policy is rejected before configuration or turn effects', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const args = { bundle: f.bundle, cwd: f.root, skillName: 'stnl-slice-executor', prompt: 'payload',
    model: 'gpt-6.1-sol', effort: 'high', approvalPolicy: 'never', sandbox: 'workspace-write' };
  for (const extra of [{ threadId: parent }, { sandbox: 'typo' }, { approvalPolicy: 'accept-all' },
    { approvalPolicy: 'on-failure' }]) {
    await assert.rejects(() => startAppServerTurn(s.rpc, { ...args, ...extra }), blocked);
  }
  assert.equal(s.calls.length, 0);
});

test('S2 server handshake version drift blocks initialization completion', async () => {
  let initialized = false;
  await assert.rejects(() => initializeAppServer({ async request() { return { userAgent: 'codex-cli/0.160.0' }; },
    notify() { initialized = true; } }), blocked);
  assert.equal(initialized, false);
});

test('S2 official child mapping and completed full text survive observer restart without turns', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const binding = await bindAppServerChild(s.rpc, identity);
  const envelope = await readAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root });
  assert.deepEqual(envelope, { agentId: identity.agentPath, status: 'completed', finalResponse: s.state.items[0].text });
  const restored = server({ bundle: f.bundle, cwd: f.root });
  // Property order is incidental to the persisted binding.
  const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(binding))).reverse());
  assert.deepEqual(await readAppServerChild(restored.rpc, { binding: reordered, bundle: f.bundle, cwd: f.root }), envelope);
  for (const call of [...s.calls, ...restored.calls]) assert.match(call.method, /^thread\/(?:read|items\/list|turns\/list)$/u);
  const file = path.join(f.root, 'tool-result.json');
  const first = await writeNativeToolResult(file, envelope), bytes = await fs.readFile(file);
  assert.equal(first.finalResponseSha256, sha(Buffer.from(envelope.finalResponse)));
  await writeNativeToolResult(file, envelope);
  assert.ok(bytes.equals(await fs.readFile(file)));
  await assert.rejects(() => writeNativeToolResult(file, { ...envelope, finalResponse: envelope.finalResponse + ' ' }), blocked);
  assert.ok(bytes.equals(await fs.readFile(file)));
});

for (const [name, change] of Object.entries({
  absent: s => { s.parentItems = []; },
  onlyCompletedWait: s => { s.parentItems.shift(); },
  otherPath: s => { s.parentItems[0].agentPath = '/root/foreign'; },
  ambiguous: s => s.parentItems.push({ ...s.parentItems[0], id: 'spawn-two', agentThreadId: 'foreign' }),
  ambiguousThreadPath: s => s.parentItems.push({ ...s.parentItems[0], id: 'spawn-two', agentPath: '/root/other-path' }),
  foreignMetadata: s => { s.thread.id = 'foreign'; },
  foreignParent: s => { s.thread.parentThreadId = 'foreign'; },
  forkedHistory: s => { s.thread.forkedFromId = parent; },
  oldCli: s => { s.thread.cliVersion = '0.160.0'; },
  wrongRole: s => { s.thread.agentRole = 'default'; },
  wrongModel: s => { s.parentItems[0].model = 'other'; },
  missingModel: s => { s.parentItems[0].model = null; },
  wrongEffort: s => { s.parentItems[0].reasoningEffort = 'low'; },
  running: s => { s.turns[0].status = 'inProgress'; },
  error: s => { s.turns[0].error = { message: 'failed' }; },
  noTurns: s => { s.turns = []; },
  extraTurn: s => s.turns.push({ ...s.turns[0], id: 'extra' }),
  missingText: s => { s.items = []; },
  commentary: s => { s.items[0].phase = 'commentary'; },
  partial: s => { s.items[0].phase = 'partial_answer'; },
  divergent: s => { s.turns[0].items[0].text += 'changed'; },
  divergentParentReport: s => { s.parentItems[1].agentsStates[child] = { status: 'completed', message: 'other bytes' }; },
  duplicateItems: s => s.items.push({ ...s.items[0] }),
  invalidUtf8: s => { s.items[0].text = '\ud800'; s.turns[0].items[0].text = '\ud800'; },
})) test(`S2 no envelope for ${name}; no new turn/retry`, async t => {
  const f = await fixture(t), good = server({ bundle: f.bundle, cwd: f.root });
  const binding = await bindAppServerChild(good.rpc, identity);
  const bad = server({ bundle: f.bundle, cwd: f.root, mutate: change });
  await assert.rejects(() => readAppServerChild(bad.rpc, { binding, bundle: f.bundle, cwd: f.root }), blocked);
  assert.ok(bad.calls.every(call => ['thread/read', 'thread/items/list', 'thread/turns/list'].includes(call.method)));
});

test('S2 another completed child is not substituted for the scoped child', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, mutate(state) {
    state.parentItems.unshift({ ...state.parentItems[0], id: 'other-spawn',
      agentPath: '/root/foreign', agentThreadId: 'other-child' });
    state.parentItems.at(-1).agentsStates['other-child'] = { status: 'completed', message: 'foreign bytes' };
    state.parentItems.at(-1).agentsStates[child] = { status: 'completed', message: state.items[0].text };
  } });
  const binding = await bindAppServerChild(s.rpc, identity);
  assert.equal(binding.agentThreadId, child);
  const result = await readAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root });
  assert.equal(result.finalResponse, s.state.items[0].text);
  assert.ok(s.calls.filter(call => call.method === 'thread/read').every(call => call.params.threadId === child));
});

test('S2 consumes every history page and blocks a repeated/incomplete cursor', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const request = s.rpc.request.bind(s.rpc), seen = [];
  s.rpc.request = async (method, params) => {
    if (method === 'thread/items/list' && params.threadId === parent) {
      seen.push(params.cursor);
      return params.cursor === null ? { data: [], nextCursor: 'page2' } : request(method, params);
    }
    return request(method, params);
  };
  const binding = await bindAppServerChild(s.rpc, identity);
  assert.equal(binding.agentThreadId, child); assert.deepEqual(seen, [null, 'page2']);
  s.rpc.request = async () => ({ data: [], nextCursor: 'same' });
  await assert.rejects(() => bindAppServerChild(s.rpc, identity), blocked);
});

test('S2 nullable optional history fields retain public 0.163 compatibility', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root,
    mutate(state) { delete state.turns[0].error; delete state.turns[0].itemsView;
      delete state.thread.forkedFromId; delete state.items[0].phase; delete state.turns[0].items[0].phase; } });
  const request = s.rpc.request.bind(s.rpc);
  s.rpc.request = async (method, params) => {
    const result = await request(method, params);
    if (Object.hasOwn(result, 'nextCursor')) delete result.nextCursor;
    return result;
  };
  const binding = await bindAppServerChild(s.rpc, identity);
  assert.equal((await readAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root })).finalResponse,
    s.state.items[0].text);
});

function wire(t, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const rpc = appServerRpc({ input, output, diagnostics, timeoutMs: 1000, ...options });
  const sent = []; output.on('data', bytes => sent.push(JSON.parse(bytes.toString('utf8'))));
  t.after(() => { rpc.close(); input.destroy(); output.destroy(); diagnostics.destroy(); });
  return { input, output, diagnostics, rpc, sent };
}

for (const kind of ['early-denial-in-long-chunk', 'split-denial', 'diagnostic-overflow']) {
  test(`S2 diagnostics ${kind} block without disclosing text or dispatching again`, async t => {
    const w = wire(t), pending = w.rpc.request('thread/read', { threadId: child });
    const rejected = assert.rejects(pending, error => {
      assert.ok(['PERMISSION_REQUIRED', 'NATIVE_TRANSPORT_UNPROVEN'].includes(error.code));
      assert.equal(error.message.includes('private diagnostic example'), false); return true;
    });
    if (kind === 'early-denial-in-long-chunk') w.diagnostics.write('permission denied ' + 'x'.repeat(600));
    if (kind === 'split-denial') { w.diagnostics.write('private diagnostic example: operation not '); w.diagnostics.write('permitted'); }
    if (kind === 'diagnostic-overflow') w.diagnostics.write('x'.repeat(64 * 1024 + 1));
    await rejected;
    await assert.rejects(() => w.rpc.request('thread/read', {}));
    assert.equal(w.sent.length, 1);
  });
}

test('S2 JSONL correlates out-of-order replies, ignores completion notifications and preserves UTF-8', async t => {
  const w = wire(t), a = w.rpc.request('thread/read', { threadId: child }), b = w.rpc.request('skills/list', {});
  w.input.write(JSON.stringify({ method: 'turn/completed', params: { threadId: child } }) + '\n');
  w.input.write(JSON.stringify({ id: w.sent[1].id, result: { data: [] } }) + '\n');
  const bytes = Buffer.from(JSON.stringify({ id: w.sent[0].id, result: { text: '𝛑 ç' } }) + '\n');
  for (const byte of bytes) w.input.write(Buffer.from([byte]));
  assert.deepEqual(await a, { text: '𝛑 ç' }); assert.deepEqual(await b, { data: [] });
  await assert.rejects(() => w.rpc.request('account/login/start', {}), blocked);
  assert.equal(w.sent.length, 2);
});

for (const kind of ['malformed', 'invalid-wire-utf8', 'oversize', 'foreign-response', 'approval', 'end', 'timeout']) {
  test(`S2 RPC ${kind} stops without acceptance/reconnect/retry`, async t => {
    const w = wire(t, { timeoutMs: 25, maxLineBytes: 250 });
    const request = w.rpc.request('thread/read', { threadId: child });
    const rejection = assert.rejects(request, error => ['NATIVE_TRANSPORT_UNPROVEN', 'INTERACTION_REQUIRED'].includes(error.code));
    if (kind === 'malformed') w.input.write('{bad}\n');
    if (kind === 'invalid-wire-utf8') w.input.write(Buffer.concat([
      Buffer.from(`{"id":${w.sent[0].id},"result":{"text":"`), Buffer.from([0xff]), Buffer.from('"}}\n'),
    ]));
    if (kind === 'oversize') w.input.write('x'.repeat(251));
    if (kind === 'foreign-response') w.input.write('{"id":999,"result":{}}\n');
    if (kind === 'approval') w.input.write('{"id":"approve","method":"item/commandExecution/requestApproval","params":{}}\n');
    if (kind === 'end') w.input.end('partial');
    await rejection;
    await assert.rejects(() => w.rpc.request('thread/read', {}));
    assert.equal(w.sent.length, 1);
  });
}

test('S2 offline public child envelope crosses normal capture-native; persistence replay uses identical bytes', async t => {
  const operation = await reservedOperation(t), f = await fixture(t), { handle } = operation.start;
  await bindNative(handle, identity.agentPath);
  const measured = await verifyNative(operation.dispatch.originFile);
  const request = await fs.readFile(operation.dispatch.requestFile);
  const text = JSON.stringify({ format: 'stnl-current-validation-response-v1', requestSha256: sha(request),
    result: { status: 'PASS', head: operation.head, commands: measured.commands,
      evidence: 'OFFLINE mechanical transport fixture, not a real native response.', findingReferences: 'none',
      findingDispositions: 'none', blockers: 'none', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'none' },
    newFindings: [] }) + '\n';
  const s = server({ bundle: f.bundle, cwd: f.root, response: text });
  const binding = await bindAppServerChild(s.rpc, identity);
  const file = path.join(f.root, 'restored-owned-output/native-tool-result.json');
  // A persistence failure is not permission to spawn or rerun the recipe.
  await assert.rejects(() => captureAppServerChild(s.rpc, { binding, bundle: f.bundle, cwd: f.root,
    toolResultFile: file }), error => error.code === 'ENOENT');
  await fs.mkdir(path.dirname(file));
  const restoredBeforeCapture = server({ bundle: f.bundle, cwd: f.root, response: text });
  const captured = await captureAppServerChild(restoredBeforeCapture.rpc, { binding, bundle: f.bundle,
    cwd: f.root, toolResultFile: file });
  assert.equal(captured.finalResponseSha256, sha(Buffer.from(text)));
  assert.equal((await captureNative(handle, file)).status, 'PASS');
  const responseFile = path.join(path.dirname(operation.dispatch.originFile), 'round-1.response.json');
  const before = await fs.readFile(responseFile), observation = await fs.readFile(measured.observationFile);
  assert.ok(before.equals(Buffer.from(text)));
  const newObserver = server({ bundle: f.bundle, cwd: f.root, response: text });
  await captureAppServerChild(newObserver.rpc, { binding: JSON.parse(JSON.stringify(binding)),
    bundle: f.bundle, cwd: f.root, toolResultFile: file });
  assert.equal((await captureNative(handle, file)).replayed, true);
  assert.equal((await resume(handle)).phase, 'captured');
  assert.ok(before.equals(await fs.readFile(responseFile)));
  assert.ok(observation.equals(await fs.readFile(measured.observationFile)));
  assert.ok(newObserver.calls.every(call => /^thread\/(?:read|items\/list|turns\/list)$/u.test(call.method)));
  assert.ok(restoredBeforeCapture.calls.every(call => /^thread\/(?:read|items\/list|turns\/list)$/u.test(call.method)));
});
