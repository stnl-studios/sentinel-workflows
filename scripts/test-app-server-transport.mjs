import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appServerEnvironment, appServerRpc, initializeAppServer, describeAppServerBundle, assertAppServerBundle,
  selectAppServerBundle, startAppServerTurn, bindAppServerChild, readAppServerChild,
  writeNativeToolResult, captureAppServerChild, persistAppServerStderrSample } from '../agents/codex/runtime/app-server-transport.mjs';
import { createNativeProvider } from '../agents/codex/runtime/native-provider.mjs';
import { reservedOperation } from './fixtures/current-native-operation.mjs';
import { bindNative, verifyNative, captureNative, resume } from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const blocked = error => error.code === 'NATIVE_TRANSPORT_UNPROVEN';
const parent = '019a0000-0000-7000-8000-000000000001';
const child = '019a0000-0000-7000-8000-000000000002';
const identity = { parentThreadId: parent, parentTurnId: 'parent-turn', agentPath: '/root/check-one' };

test('owned App Server excludes inherited informational span logging without changing HOME/config or its caller', () => {
  const environment = Object.freeze({ HOME: '/normal-home', CODEX_HOME: '/existing-codex-home',
    PATH: '/existing-path', RUST_LOG: 'info,codex_exec_server::remote=info', LOG_FORMAT: 'json',
    UNRELATED_SETTING: 'preserved' });
  assert.deepEqual(appServerEnvironment(environment), { ...environment, RUST_LOG: 'warn' });
  assert.equal(environment.RUST_LOG, 'info,codex_exec_server::remote=info');
  assert.deepEqual(appServerEnvironment({ HOME: '/normal-home' }), { HOME: '/normal-home', RUST_LOG: 'warn' });
});

async function fixture(t) {
  await fs.mkdir(path.join(repo, 'tmp'), { recursive: true });
  const root = await fs.mkdtemp(path.join(repo, 'tmp/app-server-offline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'skills/workflows'), runnerFile = path.join(root,
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

function server({ bundle, cwd, response = '  resultado íntegro\r\n𝛑\n', mutate = () => {}, provider = false }) {
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
      if (method === 'thread/read') {
        if (provider && params.threadId === parent) return { thread: { id: parent, cwd, cliVersion: '0.163.0', parentThreadId: null } };
        assert.equal(params.threadId, child); return { thread: structuredClone(state.thread) };
      }
      if (method === 'thread/resume') return { thread: { id: parent, cwd, cliVersion: '0.163.0' } };
      if (method === 'thread/turns/list') {
        if (provider && params.threadId === parent) return { data: [{ id: 'parent-turn', status: 'completed', error: null }], nextCursor: null };
        assert.equal(params.threadId, child); return { data: structuredClone(state.turns), nextCursor: null };
      }
      if (method === 'thread/items/list') {
        if (params.threadId === parent) {
          assert.equal(params.turnId, 'parent-turn'); return { data: [...structuredClone(state.parentItems),
            ...(provider ? [{ id: 'parent-answer', type: 'agentMessage', phase: 'final_answer', text: 'OFFLINE principal result' }] : [])], nextCursor: null };
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

test('S2 excludes only frozen workflow homonyms and preserves distinct domain/legacy availability', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root });
  const distinct = [
    ['stnl-backend-dotnet', true], ['stnl-backend-node-typescript', true],
    ['stnl-database-persistence', true], ['stnl-frontend-react-next-angular', true],
    ['stnl-mobile-ios-swift', true], ['stnl-testing', true],
    ['stnl-security-auth', false], ['stnl-task-materializer', true],
    ['stnl-task-reviewer', false], ['unrelated-skill', true],
  ].map(([name, enabled]) => ({ name, enabled, path: `/normal-home/.agents/skills/${name}/SKILL.md` }));
  const siblingHomonym = { name: 'stnl-slice-quality-manager', enabled: true,
    path: '/normal-home/.agents/skills/stnl-slice-quality-manager/SKILL.md' };
  s.state.listing.data[0].skills.push(...distinct, siblingHomonym);
  const selected = await selectAppServerBundle(s.rpc, { bundle: f.bundle, cwd: f.root, skillName: 'stnl-slice-executor' });
  const overrides = selected.config['skills.config'];
  for (const skill of distinct) {
    assert.deepEqual(overrides.find(value => value.path === skill.path), { path: skill.path, enabled: skill.enabled },
      `${skill.name} must keep the client's setting even when the config array replaces inherited overrides`);
  }
  assert.deepEqual(overrides.filter(value => value.enabled === false && !distinct.some(skill => skill.path === value.path)).map(value => value.path), [
    '/normal-home/.agents/skills/stnl-slice-executor/SKILL.md', siblingHomonym.path,
  ]);
});

for (const [name, change] of Object.entries({
  absent: s => s.listing.data[0].skills.shift(),
  disabled: s => { s.listing.data[0].skills[0].enabled = false; },
  homonymOnly: s => { s.listing.data[0].skills = s.listing.data[0].skills.slice(2); },
  wrongName: s => { s.listing.data[0].skills[0].name = 'stnl-other'; },
  nonSentinelNameInBundle: s => { s.listing.data[0].skills[0].name = 'unrelated-skill'; },
  wrongPathInBundle: s => { s.listing.data[0].skills[0].path = path.join(path.dirname(s.listing.data[0].skills[0].path), 'runtime/SKILL.md'); },
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

for (const [name, value, expected] of [
  ['method', { code: -32601, message: 'Method not found: private-method' }, { code: -32601, description: 'method not found' }],
  ['params', { code: -32602, message: 'Invalid params at /Users/private/config' }, { code: -32602, description: 'invalid params' }],
  ['state', { code: -32600, message: 'thread private-id is not materialized; unavailable before first user message' },
    { code: -32600, description: 'not materialized; unavailable before first user message' }],
  ['capability', { code: -32600, message: 'requires experimental API; private data omitted' }, { code: -32600, description: 'experimental' }],
  ['unknown', { code: -32001, message: 'Bearer secret-value /Users/private/session', data: { token: 'secret-value' } }, { code: -32001, description: 'omitted' }],
  ['invalid-code', { code: 'secret-value', message: 'private server detail' }, { code: null, description: 'omitted' }],
  ['oversized-code', { code: 1e100, message: 'private server detail' }, { code: null, description: 'omitted' }],
]) test(`RPC rejection retains bounded code/category only: ${name}`, async t => {
  const w = wire(t), pending = w.rpc.request('thread/turns/list', { threadId: parent });
  const rejection = assert.rejects(pending, error => {
    assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
    assert.deepEqual(error.rpcError, expected);
    const serialized = JSON.stringify({ message: error.message, rpcError: error.rpcError });
    for (const secret of ['secret-value', '/Users/', 'private-id', 'private-method', 'private data', 'private server']) assert.equal(serialized.includes(secret), false);
    assert.ok(Buffer.byteLength(error.rpcError.description) <= 256);
    return true;
  });
  const line = Buffer.from(JSON.stringify({ id: w.sent[0].id, error: value })+'\n');
  // The projection sees the decoded frame, so secrets split across chunks cannot escape.
  for (let offset=0; offset<line.length; offset+=7) w.input.write(line.subarray(offset, offset+7));
  await rejection;
  assert.equal(w.sent.length, 1);
});

test('RPC rejection omits text after its 2048-character diagnostic prefix', async t => {
  const w = wire(t), pending = w.rpc.request('thread/read', { threadId: child });
  const rejected = assert.rejects(pending, error => {
    assert.deepEqual(error.rpcError, { code: -32600, description: 'omitted' }); return true;
  });
  w.input.write(JSON.stringify({ id: w.sent[0].id, error: { code: -32600,
    message: 'x'.repeat(2048)+'permission denied private-value', data: 'secret-value' } })+'\n');
  await rejected; assert.equal(w.sent.length, 1);
});

test('provider result and event retain safe RPC rejection detail without another turn', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true }), w = wire(t);
  const request = s.rpc.request;
  s.rpc.request = (method, params) => {
    if (method !== 'thread/turns/list') return request(method, params);
    const pending = w.rpc.request(method, params);
    w.input.write(JSON.stringify({ id: w.sent.at(-1).id, error: { code: -32600,
      message: 'thread private-id is not materialized; Bearer private-secret', data: { secret: 'private-secret' } } })+'\n');
    return pending;
  };
  const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc });
  const result = await provider.runTurn({ prompt: 'offline only', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6-luna', effort: 'high', operationId: 'rpc-rejection', role: 'author' });
  assert.equal(result.completed, false); assert.equal(result.turnStarted, null);
  assert.equal(result.error, 'App Server rejected thread/turns/list (RPC -32600: not materialized)');
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(w.sent.length, 1); assert.deepEqual(result.captures, []);
  const events = await fs.readFile(result.eventsPath, 'utf8');
  assert.ok(events.includes(result.error));
  for (const secret of ['private-id','private-secret','Bearer']) assert.equal(JSON.stringify(result).includes(secret) || events.includes(secret), false);
});

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

test('stderr guard still accepts 65536 bytes and blocks byte 65537 without another request', async t => {
  const f = await fixture(t), w = wire(t);
  const accepted = w.rpc.request('thread/read', { threadId: child });
  w.diagnostics.write(Buffer.alloc(65536, 120));
  await assert.rejects(fs.lstat(path.join(f.root, 'tmp/app-server-stderr-sample.txt')), { code: 'ENOENT' }, 'healthy diagnostics are not persisted');
  w.input.write(JSON.stringify({ id: w.sent[0].id, result: { ok: true } }) + '\n');
  assert.deepEqual(await accepted, { ok: true });
  const rejected = assert.rejects(w.rpc.request('thread/read', { threadId: child }),
    { code: 'NATIVE_TRANSPORT_UNPROVEN', message: 'App Server diagnostic limit exceeded' });
  w.diagnostics.write('x'); await rejected;
  const result = await persistAppServerStderrSample(w.rpc, f.root);
  assert.equal(result.status, 'retained');
  const bytes = await fs.readFile(result.file);
  assert.ok(bytes.length <= 1024); assert.ok(!bytes.includes(Buffer.from('xxxx')));
  assert.equal((await fs.stat(result.file)).mode & 0o777, 0o600);
  await assert.rejects(w.rpc.request('thread/read', {}), blocked);
  assert.equal(w.sent.length, 2);
});

for (const chunkSize of [1, 7, 511]) test(`stderr sample omits unknown/private content fragmented every ${chunkSize} bytes`, async t => {
  const f = await fixture(t), w = wire(t);
  const rejected = assert.rejects(w.rpc.request('thread/read', {}), blocked);
  const secret = 'sk-private-secret-value-123456789';
  const prefix = Buffer.from(`failed to load skill\nAuthorization: Bearer ${secret}\npassword=hunter-private\n/Users/private-user/secret.env\n{"prompt":"private prompt","env":"private environment"}\n𝛑\n`);
  for (let offset = 0; offset < prefix.length; offset += chunkSize) w.diagnostics.write(prefix.subarray(offset, offset + chunkSize));
  w.diagnostics.write(Buffer.alloc(65537, 120)); await rejected;
  const result = await persistAppServerStderrSample(w.rpc, f.root), sample = await fs.readFile(result.file, 'utf8');
  assert.ok(sample.includes('failed to load skill'));
  for (const privateText of [secret, 'Authorization', 'Bearer', 'hunter-private', '/Users/', 'secret.env', 'private prompt', 'private environment', '𝛑']) {
    assert.equal(sample.includes(privateText), false, privateText);
  }
  assert.ok(Buffer.byteLength(sample) <= 1024);
  const original = await fs.readFile(result.file);
  w.diagnostics.write('failed to parse config');
  assert.ok(original.equals(await fs.readFile(result.file)), 'later chunks cannot rewrite the first sample');
  assert.deepEqual(await persistAppServerStderrSample(w.rpc, f.root), { status: 'unavailable' }, 'never overwrite a retained sample');
  assert.ok(original.equals(await fs.readFile(result.file)));
  assert.equal(w.sent.length, 1);
});

test('stderr prefix truncation and unknown-only text cannot escape via the retained sample', async t => {
  const f = await fixture(t), w = wire(t);
  const rejected = assert.rejects(w.rpc.request('thread/read', {}), blocked);
  w.diagnostics.write(Buffer.concat([Buffer.alloc(4096, 120), Buffer.from('failed to parse config\nprivate-value'), Buffer.alloc(65537, 120)]));
  await rejected;
  const result = await persistAppServerStderrSample(w.rpc, f.root), sample = await fs.readFile(result.file, 'utf8');
  assert.equal(sample.includes('failed to parse config'), false, 'only the bounded prefix is sampled');
  assert.equal(sample.includes('private-value'), false);
  assert.ok(sample.includes('All other stderr omitted'));
});

for (const failure of ['occupied-file', 'symlink-directory', 'noncanonical-root']) test(`stderr persistence ${failure} preserves prior bytes and original RPC error`, async t => {
  const f = await fixture(t), w = wire(t);
  const rejected = assert.rejects(w.rpc.request('thread/read', {}), { message: 'App Server diagnostic limit exceeded' });
  w.diagnostics.write(Buffer.alloc(65537)); await rejected;
  let evidenceRoot = f.root;
  const prior = path.join(f.root, 'prior'); await fs.mkdir(prior);
  const priorFile = path.join(prior, 'app-server-stderr-sample.txt'); await fs.writeFile(priorFile, 'prior bytes');
  if (failure === 'occupied-file') { await fs.mkdir(path.join(f.root, 'tmp')); await fs.copyFile(priorFile, path.join(f.root, 'tmp/app-server-stderr-sample.txt')); }
  if (failure === 'symlink-directory') await fs.symlink(prior, path.join(f.root, 'tmp'));
  if (failure === 'noncanonical-root') evidenceRoot += '/.';
  assert.deepEqual(await persistAppServerStderrSample(w.rpc, evidenceRoot), { status: 'unavailable' });
  assert.equal(await fs.readFile(priorFile, 'utf8'), 'prior bytes');
  if (failure === 'occupied-file') assert.equal(await fs.readFile(path.join(f.root, 'tmp/app-server-stderr-sample.txt'), 'utf8'), 'prior bytes');
  await assert.rejects(w.rpc.request('thread/read', {}), { code: 'NATIVE_TRANSPORT_UNPROVEN', message: 'App Server diagnostic limit exceeded' });
  assert.equal(w.sent.length, 1);
});

for (const phase of ['initialize', 'turn', 'turn-write-failure']) test(`provider exposes limited stderr evidence for ${phase} without replacing the failure`, async t => {
  const f = await fixture(t), w = wire(t);
  const request = w.rpc.request;
  w.rpc.request = (method, params) => {
    if (method === 'initialize' && phase !== 'initialize') return Promise.resolve({ userAgent: 'codex-cli/0.163.0' });
    const pending = request(method, params);
    w.diagnostics.write(Buffer.concat([Buffer.from('failed to load skill\nsecret-value'), Buffer.alloc(65537)]));
    return pending;
  };
  if (phase === 'turn-write-failure') await fs.writeFile(path.join(f.root, 'tmp'), 'occupied parent');
  if (phase === 'initialize') {
    await assert.rejects(createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: w.rpc }), error => {
      assert.equal(error.message, 'App Server diagnostic limit exceeded'); assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
      assert.equal(error.stderrSample.status, 'retained'); return true;
    });
  } else {
    const provider = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: w.rpc });
    const result = await provider.runTurn({ prompt: 'normal input', workflowSkill: 'stnl-slice-executor', model: 'gpt-6.1-sol', effort: 'medium', role: 'author', operationId: 'failure' });
    assert.equal(result.completed, false); assert.equal(result.turnStarted, null);
    assert.equal(result.error, 'App Server diagnostic limit exceeded'); assert.equal(result.errorCode, 'NATIVE_TRANSPORT_UNPROVEN');
    assert.equal(result.stderrSample.status, phase === 'turn' ? 'retained' : 'unavailable');
    const event = JSON.parse((await fs.readFile(result.eventsPath, 'utf8')).trim());
    assert.deepEqual(event.stderrSample, result.stderrSample);
  }
  if (phase !== 'turn-write-failure') {
    const sample = await fs.readFile(path.join(f.root, 'tmp/app-server-stderr-sample.txt'), 'utf8');
    assert.ok(sample.includes('failed to load skill')); assert.equal(sample.includes('secret-value'), false);
  }
  assert.equal(w.sent.filter(call => Object.hasOwn(call, 'id')).length, 1);
});

test('initialization rejection retains available stderr even while the codec remains open', async t => {
  const f = await fixture(t), w = wire(t), request = w.rpc.request;
  w.rpc.request = (method, params) => {
    const pending = request(method, params);
    w.diagnostics.write('failed to parse config: private-value');
    w.input.write(JSON.stringify({ id: w.sent.at(-1).id, error: { message: 'private server detail' } }) + '\n');
    return pending;
  };
  await assert.rejects(createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: w.rpc }), error => {
    assert.equal(error.message, 'App Server rejected initialize'); assert.equal(error.code, 'NATIVE_TRANSPORT_UNPROVEN');
    assert.equal(error.stderrSample.status, 'retained'); return true;
  });
  const sample = await fs.readFile(path.join(f.root, 'tmp/app-server-stderr-sample.txt'), 'utf8');
  assert.ok(sample.includes('failed to parse config')); assert.equal(sample.includes('private'), false);
  assert.equal(w.sent.length, 1);
});

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

test('normal provider inherits client permissions and scoped observation resumes without another turn', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true });
  let stopped = false;
  const request = s.rpc.request;
  s.rpc.request = async (method, params) => {
    if (!stopped && method === 'thread/turns/list' && params.threadId === parent) { stopped = true; throw new Error('OFFLINE observation interruption'); }
    return request(method, params);
  };
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc, pollMs: 1 });
  const input = { prompt: 'Normal author input', workflowSkill: 'stnl-slice-executor', model: 'gpt-6.1-sol', effort: 'high',
    operationId: 'read-only-resume', role: 'author' };
  const first = await p.runTurn(input);
  assert.equal(first.completed, false); assert.equal(first.turnStarted, null);
  assert.equal(first.observation.threadId, parent);
  const second = await p.runTurn({ ...input, observation: first.observation });
  assert.equal(second.completed, true); assert.equal(second.captures[0].toolResult.finalResponse, '  resultado íntegro\r\n𝛑\n');
  const bytes = await fs.readFile(second.captures[0].file);
  const third = await p.runTurn({ ...input, observation: first.observation });
  assert.ok(bytes.equals(await fs.readFile(third.captures[0].file)));
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(s.calls.filter(call => call.method === 'thread/start').length, 1);
  const settings = s.calls.find(call => call.method === 'thread/start').params;
  assert.equal(settings.approvalPolicy, null); assert.equal(settings.sandbox, null);
});

test('runner descendants are all observed before rejecting the result', async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true, mutate(state) {
    state.items.push(...['grandchild-one','grandchild-two'].map(agentThreadId => ({ id: agentThreadId,
      type: 'subAgentActivity', kind: 'started', agentThreadId, agentPath: '/root/'+agentThreadId })));
  } });
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc });
  const unadmitted = [];
  const result = await p.runTurn({ prompt: 'Normal input', workflowSkill: 'stnl-slice-executor', model: 'gpt-6.1-sol', effort: 'high',
    operationId: 'descendants', role: 'author', onUnadmittedChildren: async bindings => unadmitted.push(...bindings) });
  assert.equal(result.completed, false); assert.equal(unadmitted.length, 2);
  assert.equal(s.calls.filter(call => call.method === 'turn/start').length, 1);
});

for (const mode of ['author', 'review', 'foreign-resume']) test(`normal continuity rejects ${mode} mismatch without a new turn`, async t => {
  const f = await fixture(t), s = server({ bundle: f.bundle, cwd: f.root, provider: true });
  const p = await createNativeProvider({ snapshot: f.root, workspace: f.root, evidenceRoot: f.root, rpc: s.rpc });
  const prior = { threadId: parent, cwd: f.root, bundleSha256: sha(Buffer.from(JSON.stringify(p.bundle))), role: 'author' };
  if (mode === 'author') prior.cwd = '/another-case';
  if (mode === 'foreign-resume') {
    const request = s.rpc.request;
    s.rpc.request = async (method, params) => method === 'thread/resume'
      ? { thread: { id: child, cwd: f.root, cliVersion: '0.163.0' } } : request(method, params);
  }
  const result = await p.runTurn({ prompt: 'Normal continuation', workflowSkill: 'stnl-slice-executor',
    model: 'gpt-6.1-sol', effort: 'high', operationId: mode, role: mode === 'review' ? 'review' : 'author', priorAuthorThread: prior });
  assert.equal(result.completed, false);
  assert.equal(s.calls.some(call => call.method === 'turn/start'), false);
});
