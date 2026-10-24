// Public Codex App Server 0.163 adapter. No product admission, judging or retries.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readRunnerConfiguration } from './validation-runner.mjs';

export const APP_SERVER_VERSION = '0.163.0';
// A caller's INFO/TRACE filter can emit large span payloads before any turn.
// Scope logging to this owned process; warnings/errors and the 64 KiB guard stay.
export const appServerEnvironment = environment => ({ ...environment, RUST_LOG: 'warn' });
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (message, code = 'NATIVE_TRANSPORT_UNPROVEN') => Object.assign(new Error(message), { code });
const requireThat = (condition, message) => { if (!condition) throw fail(message); };
const id = value => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value);
const inside = (root, file) => file.startsWith(`${root}${path.sep}`);
// A default-deny projection, not a general-purpose secret scrubber. Persist
// only these fixed phrases; unknown text/paths/values never leave memory.
const STDERR_PHRASES = ['operation not permitted', 'permission denied', 'no such file or directory',
  'too many open files', 'resource temporarily unavailable', 'address already in use',
  'connection refused', 'connection reset by peer', 'broken pipe',
  'failed to load skill', 'failed to read skill', 'failed to parse skill',
  'invalid frontmatter', 'invalid yaml', 'failed to load config', 'failed to parse config',
  'failed to initialize', 'invalid configuration'];

// Fixed causal labels only: never reconstruct a sequence of server words.
// These are diagnostic hints, not proof of cause or permission to retry.
function historyErrorShape(prefix) {
  const labels = [
    ['SESSION_METADATA', /failed to read session metadata/u],
    ['EMPTY_ROLLOUT', /rollout at [^\n]+ is empty/u],
    ['RESPONSE_BEFORE_METADATA', /does not start with session metadata/u],
    ['JSON_EOF', /(?:unexpected end of input|eof while parsing)/u],
    ['JSON_EXPECTED_VALUE', /expected value at line/u],
    ['JSON_MISSING_FIELD', /missing field/u],
    ['JSON_INVALID_TYPE', /invalid type/u],
    ['JSON_UNKNOWN_VARIANT', /unknown variant/u],
    ['THREAD_ID_MISMATCH', /belongs to thread/u],
    ['DATABASE_LOCKED', /database (?:is )?locked/u],
    ['DATABASE_BUSY', /database (?:is )?busy/u],
    ['DATABASE_CORRUPT', /database (?:disk image is malformed|is corrupt)/u],
  ].filter(([, pattern]) => pattern.test(prefix)).map(([label]) => label);
  return labels.length ? `history cause: ${labels.join('; ')}`.slice(0, 256) : 'failed to read thread; cause omitted';
}

// Official 0.163 metadata reader can observe a newly materialized rollout
// before SessionMeta is available. Match the complete causal chain and the
// same scoped rollout path; never use the diagnostic label as authorization.
function initialRolloutMetadataPending(prefix, threadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(threadId)) return false;
  const head = 'failed to read thread: thread-store internal error: failed to read session metadata ';
  if (!prefix.startsWith(head)) return false;
  const match = /^(\/[^\r\n\0]+?\.jsonl): (?:thread-store internal error: failed to read session metadata \1: )?rollout at \1 is empty$/u.exec(prefix.slice(head.length));
  return match !== null && path.posix.normalize(match[1]) === match[1]
    && path.posix.basename(match[1]).endsWith(`-${threadId}.jsonl`);
}

// Only a numeric protocol code and fixed categories may escape a rejection.
// Unknown messages, data, paths and identifiers are never retained verbatim.
function rpcRejection(method, value, threadId) {
  const code = Number.isSafeInteger(value?.code) ? value.code : null;
  const rawPrefix = typeof value?.message === 'string' ? value.message.slice(0, 2048) : '';
  const prefix = rawPrefix.toLowerCase();
  const categories = ['method not found', 'invalid params', 'invalid request',
    'not materialized', 'unavailable before first user message', 'no rollout found',
    'missing source rollout', 'experimental', 'not supported', 'paginated',
    'failed to read thread', 'failed to load thread history', 'failed to list thread history', 'failed to list thread items',
    'thread not loaded', 'no such file or directory', 'os error 2',
    'permission denied', 'operation not permitted'].filter(text => prefix.includes(text));
  let description = categories.join('; ').slice(0, 256) || 'omitted';
  // Make an unknown history cause distinguishable without retaining dynamic
  // text. This diagnostic shape never grants a retry or alters the marker below.
  if (method === 'thread/turns/list' && code === -32603 && prefix.startsWith('failed to read thread: ')
    && categories.every(text => text === 'failed to read thread')) description = historyErrorShape(prefix);
  const detail = code === null && description === 'omitted' ? '' : ` (RPC ${code ?? 'unknown'}: ${description})`;
  // This marker is stricter than the diagnostic categories: exact server
  // prefix, scoped request and ENOENT only. Never defer a permission failure.
  const scoped = method === 'thread/turns/list' && typeof threadId === 'string' && threadId.length <= 256;
  const initialHistoryUnavailable = scoped && !/permission denied|operation not permitted/iu.test(value?.message ?? '')
    && ((code === -32600 && prefix === `thread ${threadId.toLowerCase()} is not materialized yet; thread/turns/list is unavailable before first user message`)
      || (code === -32603 && initialRolloutMetadataPending(rawPrefix, threadId.toLowerCase()))
      || (code === -32603 && /no such file or directory \(os error 2\)/u.test(prefix)
        && (prefix.startsWith('failed to read thread: ')
          || prefix.startsWith('failed to list thread history: ')
          || prefix.startsWith(`failed to load thread history for thread ${threadId.toLowerCase()}: `))));
  return Object.assign(fail(`App Server rejected ${method}${detail}`), { rpcError: { code, description }, initialHistoryUnavailable });
}

async function physical(file, directory = false) {
  requireThat(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file,
    'noncanonical path');
  const stat = await fs.lstat(file);
  requireThat(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
    && await fs.realpath(file) === file, 'path is not physical/canonical');
  return stat;
}

// The caller freezes this descriptor with its existing snapshot identity. It is
// not proof that the client loaded these bytes; that remains a runtime gate.
export async function describeAppServerBundle({ skillsRoot, runnerFile }) {
  await physical(skillsRoot, true);
  await physical(runnerFile);
  requireThat(path.basename(runnerFile) === 'stnl_validation_runner.toml', 'wrong runner contract path');
  const files = [];
  async function visit(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), stat = await fs.lstat(file);
      requireThat(!stat.isSymbolicLink() && await fs.realpath(file) === file, 'bundle symlink');
      if (stat.isDirectory()) await visit(file);
      else {
        requireThat(stat.isFile(), 'unsupported bundle entry');
        files.push({ path: file, mode: stat.mode & 0o777, sha256: sha(await fs.readFile(file)) });
      }
    }
  }
  await visit(skillsRoot);
  const snapshot = path.resolve(path.dirname(runnerFile), '../../../..');
  requireThat(runnerFile === path.join(snapshot, 'agents/codex/.codex/agents/stnl_validation_runner.toml'),
    'runner is not from the candidate distribution');
  const { model, effort } = await readRunnerConfiguration(snapshot);
  const runner = { path: runnerFile, sha256: sha(await fs.readFile(runnerFile)), model, effort };
  requireThat(files.some(file => path.basename(file.path) === 'SKILL.md'), 'empty skill bundle');
  return { skillsRoot, files, runner };
}

export async function assertAppServerBundle(bundle) {
  requireThat(bundle && Array.isArray(bundle.files) && bundle.runner, 'missing frozen bundle');
  const actual = await describeAppServerBundle({ skillsRoot: bundle.skillsRoot, runnerFile: bundle.runner.path });
  requireThat(JSON.stringify(actual) === JSON.stringify(bundle), 'bundle/sibling/runner hash or mode drift');
  return actual;
}

// JSONL only. This codec is bounded and stops on uncertainty; it cannot accept
// approval requests, reconnect, retry a mutation, or silently start another turn.
export function appServerRpc({ input, output, diagnostics = null, timeoutMs = 30_000, maxLineBytes = 8 * 1024 * 1024 }) {
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    && Number.isSafeInteger(maxLineBytes) && maxLineBytes > 0, 'invalid RPC bounds');
  const pending = new Map();
  const methods = new Set(['initialize', 'skills/extraRoots/set', 'skills/list', 'thread/start',
    'thread/resume', 'turn/start', 'thread/read', 'thread/turns/list', 'thread/items/list']);
  let nextId = 1, buffer = '', closed = null;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  function stop(error) {
    if (closed) return;
    closed = error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function send(value) {
    if (closed) throw closed;
    const line = `${JSON.stringify(value)}\n`;
    requireThat(Buffer.byteLength(line) <= maxLineBytes, 'outgoing RPC line limit exceeded');
    output.write(line, error => { if (error) stop(fail('RPC write uncertain')); });
  }
  input.on('data', bytes => {
    if (closed) return;
    try { buffer += decoder.decode(bytes, { stream: true }); }
    catch { stop(fail('invalid UTF-8 in public RPC stream')); return; }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxLineBytes) { stop(fail('RPC line limit exceeded')); return; }
      try {
        const message = JSON.parse(line);
        requireThat(message && typeof message === 'object', 'invalid RPC message');
        if (message.method && Object.hasOwn(message, 'id')) {
          // Includes command/file approvals, auth and persistent-access requests.
          stop(fail('App Server requires explicit user interaction', 'INTERACTION_REQUIRED')); return;
        }
        if (Object.hasOwn(message, 'id')) {
          const entry = pending.get(message.id);
          requireThat(entry && (Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error')),
            'unexpected RPC response');
          clearTimeout(entry.timer); pending.delete(message.id);
          if (message.error) entry.reject(rpcRejection(entry.method, message.error, entry.threadId));
          else entry.resolve(message.result);
        }
        // Notifications are hints, never completion evidence. Read scoped public
        // history to recover exact identities/items even after a client restart.
        else requireThat(typeof message.method === 'string', 'invalid RPC notification');
      } catch (error) { stop(error.code ? error : fail('malformed public RPC message')); return; }
    }
    if (Buffer.byteLength(buffer) > maxLineBytes) stop(fail('RPC line limit exceeded'));
  });
  input.on('end', () => stop(fail('RPC ended; any dispatched turn has uncertain effect')));
  input.on('error', () => stop(fail('RPC input failed')));
  output.on('error', () => stop(fail('RPC output failed; effect uncertain')));
  // The guard remains 65536 bytes. Keep at most a 4096-byte raw prefix and a
  // 512-character detection tail; decode in small blocks even for huge chunks.
  // The prefix is never persisted verbatim, including on truncation/failure.
  const diagnosticHead = Buffer.alloc(4096);
  let diagnosticHeadSize = 0;
  let diagnosticBytes = 0, diagnosticTail = '';
  diagnostics?.on('data', bytes => {
    if (closed) return;
    const copied = Math.min(bytes.length, diagnosticHead.length - diagnosticHeadSize);
    bytes.copy(diagnosticHead, diagnosticHeadSize, 0, copied); diagnosticHeadSize += copied;
    diagnosticBytes += bytes.length;
    if (diagnosticBytes > 64 * 1024) { stop(fail('App Server diagnostic limit exceeded')); return; }
    for (let offset = 0; offset < bytes.length; offset += 512) {
      const text = diagnosticTail + bytes.subarray(offset, offset + 512).toString('utf8');
      if (/operation not permitted|permission denied/iu.test(text)) {
        stop(fail('App Server process reported a permission denial', 'PERMISSION_REQUIRED')); return;
      }
      diagnosticTail = text.slice(-512);
    }
  });
  diagnostics?.on('error', () => stop(fail('App Server diagnostic channel failed')));
  return {
    request(method, params) {
      if (closed) return Promise.reject(closed);
      if (!methods.has(method)) return Promise.reject(fail('RPC method outside adapter scope'));
      const requestId = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(fail(`RPC timeout for ${method}; effect uncertain`)), timeoutMs);
        pending.set(requestId, { resolve, reject, timer, method,
          threadId: typeof params?.threadId === 'string' && params.threadId.length <= 256 ? params.threadId : null });
        try { send({ id: requestId, method, params }); } catch (error) { stop(error); }
      });
    },
    notify(method, params = {}) {
      requireThat(method === 'initialized', 'notification outside adapter scope');
      send({ method, params });
    },
    close(error = fail('RPC closed by owner')) { stop(error); },
    stderrSample() {
      if (diagnosticHeadSize === 0) return null;
      const text = diagnosticHead.subarray(0, diagnosticHeadSize).toString('utf8').toLowerCase();
      // Output is ASCII constants only, independent of chunk/UTF-8 boundaries.
      return ['App Server stderr: allowlisted phrases from first 4096 bytes only.',
        ...STDERR_PHRASES.filter(phrase => text.includes(phrase)),
        '[All other stderr omitted; this sample does not establish the cause.]', ''].join('\n').slice(0, 1024);
    },
  };
}

// Fixed name within this execution's evidence tmp directory, exclusive create,
// 0600 and <=1024 bytes. Failure to retain must never replace the transport error.
export async function persistAppServerStderrSample(rpc, evidenceRoot) {
  try {
    const sample = rpc.stderrSample?.();
    if (sample == null) return null;
    requireThat(typeof sample === 'string' && Buffer.byteLength(sample) <= 1024, 'invalid stderr sample');
    await physical(evidenceRoot, true);
    const directory = path.join(evidenceRoot, 'tmp');
    await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await physical(directory, true);
    const file = path.join(directory, 'app-server-stderr-sample.txt');
    await fs.writeFile(file, sample, { flag: 'wx', mode: 0o600 });
    return { status: 'retained', file };
  } catch { return { status: 'unavailable' }; }
}

// Explicit opt-in only. Importing this module and all offline tests spawn zero
// authenticated clients. No HOME/config/auth copy and no desktop socket.
export async function connectAppServer({ cliLauncher, cliSha256, cwd, timeoutMs }) {
  await physical(cliLauncher); await physical(cwd, true);
  const metadata = JSON.parse(await fs.readFile(path.resolve(cliLauncher, '../../package.json'), 'utf8'));
  requireThat(metadata.name === '@openai/codex' && metadata.version === APP_SERVER_VERSION
    && cliSha256 === sha(await fs.readFile(cliLauncher)), 'CLI pin/hash differs');
  const child = spawn(process.execPath, [cliLauncher, 'app-server', '--listen', 'stdio://'],
    { cwd, env: appServerEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const rpc = appServerRpc({ input: child.stdout, output: child.stdin, diagnostics: child.stderr, timeoutMs });
  // Drain without printing potentially sensitive diagnostics or retaining an
  // unbounded buffer. Exit/permission errors stay blocking, not alias bypasses.
  child.on('error', () => rpc.close(fail('owned App Server process failed to start')));
  child.on('exit', () => rpc.close(fail('owned App Server exited; dispatched effect may be uncertain')));
  return { rpc, close() { rpc.close(); child.stdin.end(); child.kill(); } };
}

export async function initializeAppServer(rpc) {
  const result = await rpc.request('initialize', {
    clientInfo: { name: 'sentinel-benchmark', version: '0.1.0' }, capabilities: null,
  });
  requireThat(typeof result?.userAgent === 'string'
    && /(?:^|[^0-9.])0\.163\.0(?:[^0-9.]|$)/u.test(result.userAgent), 'server handshake version differs');
  rpc.notify('initialized');
  return result;
}

export async function selectAppServerBundle(rpc, { bundle, cwd, skillName }) {
  await assertAppServerBundle(bundle); await physical(cwd, true);
  requireThat(/^stnl-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillName), 'invalid skill name');
  const selectedPath = path.join(bundle.skillsRoot, skillName, 'SKILL.md');
  requireThat(bundle.files.some(file => file.path === selectedPath), 'selected skill absent from bundle');
  await rpc.request('skills/extraRoots/set', { extraRoots: [bundle.skillsRoot] });
  const listing = await rpc.request('skills/list', { cwds: [cwd], forceReload: true });
  requireThat(Array.isArray(listing?.data) && listing.data.length === 1, 'ambiguous skill listing');
  const entry = listing.data[0];
  requireThat(entry.cwd === cwd && Array.isArray(entry.errors) && entry.errors.length === 0
    && Array.isArray(entry.skills), 'skill discovery incomplete');
  const frozenSkills = bundle.files.filter(file => path.basename(file.path) === 'SKILL.md');
  const frozenNames = new Set(frozenSkills.map(file => path.basename(path.dirname(file.path))));
  const seen = new Set(), config = [];
  for (const skill of entry.skills) {
    requireThat(id(skill.path) && id(skill.name) && typeof skill.enabled === 'boolean'
      && !seen.has(skill.path), 'missing/duplicate skill identity');
    seen.add(skill.path);
    const inBundle = inside(bundle.skillsRoot, skill.path);
    // Preserve discovered availability for distinct skills (including domain
    // guards and legacy names), even when skills.config replaces an array.
    // Only external homonyms of this frozen workflow set are disabled.
    if (inBundle) {
      requireThat(skill.enabled === true && bundle.files.some(file => file.path === skill.path)
        && skill.path === path.join(bundle.skillsRoot, skill.name, 'SKILL.md'), 'frozen skill identity differs');
      await physical(skill.path);
    }
    config.push({ path: skill.path, enabled: inBundle || (!frozenNames.has(skill.name) && skill.enabled) });
  }
  for (const file of frozenSkills) {
    requireThat(seen.has(file.path), 'frozen sibling absent from discovery');
  }
  const selected = entry.skills.filter(skill => skill.path === selectedPath && skill.name === skillName);
  requireThat(selected.length === 1 && selected[0].enabled === true, 'selected skill not enabled by exact path');
  await assertAppServerBundle(bundle);
  return {
    input: { type: 'skill', name: skillName, path: selectedPath },
    config: { 'skills.config': config,
      'agents.stnl_validation_runner.config_file': bundle.runner.path },
  };
}

// Starting a turn is deliberately separate from observation/restore. The caller
// owns admission, context regime, budgets and recording any uncertain dispatch.
export async function startAppServerTurn(rpc, { bundle, cwd, skillName, prompt, model, effort,
  threadId = null, admittedAuthorThread = null, approvalPolicy, sandbox, outputSchema }) {
  requireThat(typeof prompt === 'string' && prompt.trim() && id(model) && id(effort)
    && (approvalPolicy === null || ['never', 'untrusted', 'on-request'].includes(approvalPolicy))
    && (sandbox === null || ['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)), 'explicit turn settings required');
  requireThat(threadId === null || (id(threadId) && admittedAuthorThread?.threadId === threadId
    && admittedAuthorThread.cwd === cwd && admittedAuthorThread.bundleSha256 === sha(Buffer.from(JSON.stringify(bundle)))
    && admittedAuthorThread.role === 'author'), 'continuity requires separately admitted existing author thread');
  const selection = await selectAppServerBundle(rpc, { bundle, cwd, skillName });
  if (threadId !== null) {
    const previous = await rpc.request('thread/read', { threadId, includeTurns: false });
    requireThat(previous?.thread?.id === threadId && previous.thread.cwd === cwd
      && previous.thread.parentThreadId == null && previous.thread.cliVersion === APP_SERVER_VERSION,
    'continuity thread is foreign or a child/reviewer');
  }
  const started = await rpc.request(threadId === null ? 'thread/start' : 'thread/resume', {
    ...(threadId === null ? {} : { threadId }), cwd, model, approvalPolicy, sandbox, config: selection.config });
  requireThat(id(started?.thread?.id) && started.thread.cliVersion === APP_SERVER_VERSION
    && started.thread.cwd === cwd && (threadId === null || started.thread.id === threadId), 'thread creation identity/version differs');
  await assertAppServerBundle(bundle);
  const response = await rpc.request('turn/start', { threadId: started.thread.id, effort,
    input: [selection.input, { type: 'text', text: prompt }], ...(outputSchema === undefined ? {} : { outputSchema }) });
  requireThat(id(response?.turn?.id), 'turn dispatch response incomplete; effect uncertain');
  return { threadId: started.thread.id, turnId: response.turn.id };
}

async function pages(rpc, method, params) {
  const items = [], seen = new Set(), itemIds = new Set(); let cursor = null;
  for (let page = 0; page < 32; page++) {
    const result = await rpc.request(method, { ...params, cursor, limit: 100, sortDirection: 'asc' });
    requireThat(Array.isArray(result?.data), 'public history page absent');
    for (const entry of result.data) {
      if (method !== 'thread/items/list') { items.push(entry); continue; }
      // 0.163 returns ThreadItemEntry, not a bare ThreadItem. Enforce its
      // scope before exposing an item to parent/child consumers.
      requireThat(id(params.turnId) && entry?.turnId === params.turnId
        && entry.item && typeof entry.item === 'object' && !Array.isArray(entry.item)
        && id(entry.item.id) && id(entry.item.type), 'public item entry absent or foreign');
      requireThat(!itemIds.has(entry.item.id), 'duplicate public history item');
      itemIds.add(entry.item.id); items.push(entry.item);
    }
    // Optional nullable cursor: omitted and null both mean None in 0.163.
    if (result.nextCursor == null) return items;
    requireThat(id(result.nextCursor) && !seen.has(result.nextCursor), 'history cursor missing/repeated');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw fail('public history page limit reached; result incomplete');
}

function hasShellTemporaryRedirection(command, kind) {
  // Inspect recorded shell syntax, not quoted/escaped output data. Decode only
  // a shell's explicit -c argument; arbitrary program arguments are not shell.
  const words = String(command ?? '').match(/#[^\n]*|(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s'"\\<>;&|()])+|<<<|<<-?|[<>;&|()]/gu) ?? [];
  const operator = kind === 'string' ? /^<<<$/u : /^<<-?$/u;
  if (words.some((word) => operator.test(word))) return true;
  if (!/^(?:\/[^\s]+\/)?(?:zsh|bash|sh)$/u.test(words[0] ?? '')) return false;
  const option = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/u.test(word));
  if (option < 0 || words[option + 1] === undefined) return false;
  const script = words[option + 1].replace(/'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/gu,
    (_, single, double, escaped) => single ?? double?.replace(/\\([$`"\\\n])/gu, '$1') ?? escaped);
  return hasShellTemporaryRedirection(script, kind);
}

export function deniedShellTemporaryFile(item) {
  if (item?.type !== 'commandExecution') return false;
  const denials = String(item.aggregatedOutput ?? '').matchAll(
    /^zsh:[0-9]+: can't create temp file for here (document|string): operation not permitted\s*$/gmu);
  return [...denials].some((denial) => hasShellTemporaryRedirection(item.command, denial[1]));
}

export async function readAppServerTurn(rpc, { threadId, turnId }) {
  requireThat(id(threadId) && id(turnId), 'missing scoped turn identity');
  const turns = await pages(rpc, 'thread/turns/list', { threadId, itemsView: 'full' });
  const selected = turns.filter(turn => turn.id === turnId);
  if (turns.length === 0) throw Object.assign(fail('public history has no turn yet'), { initialHistoryUnavailable: true });
  requireThat(selected.length === 1, 'scoped turn absent/ambiguous in public history');
  return { turn: selected[0], items: await pages(rpc, 'thread/items/list', { threadId, turnId }) };
}

async function parentBinding(rpc, { parentThreadId, parentTurnId, agentPath }) {
  requireThat(id(parentThreadId) && id(parentTurnId) && id(agentPath), 'missing parent/agent identity');
  const items = await pages(rpc, 'thread/items/list', { threadId: parentThreadId, turnId: parentTurnId });
  const starts = items.filter(item => item.type === 'subAgentActivity' && item.kind === 'started'
    && item.agentPath === agentPath);
  requireThat(starts.length === 1 && id(starts[0].agentThreadId), 'child missing or ambiguous in parent turn');
  requireThat(items.filter(item => item.type === 'subAgentActivity' && item.kind === 'started'
    && item.agentThreadId === starts[0].agentThreadId).length === 1, 'child thread has multiple official paths');
  return { binding: { parentThreadId, parentTurnId, agentPath, agentThreadId: starts[0].agentThreadId,
    model: starts[0].model, effort: starts[0].reasoningEffort }, items };
}

export async function bindAppServerChild(rpc, identity) { return (await parentBinding(rpc, identity)).binding; }

// Only scoped read APIs. A completed wait/mailbox or parent agent message never
// certifies the child. No resume/start/followup, recipe, private path or synthesis.
export async function readAppServerChild(rpc, { binding, bundle, cwd }) {
  await assertAppServerBundle(bundle); await physical(cwd, true);
  const { binding: current, items: parentItems } = await parentBinding(rpc, binding);
  requireThat(Object.keys(current).every(key => current[key] === binding[key]), 'child binding changed');
  requireThat(current.model === bundle.runner.model && current.effort === bundle.runner.effort,
    'runner model/effort not proven by official spawn activity');
  const { thread } = await rpc.request('thread/read', { threadId: binding.agentThreadId, includeTurns: false });
  requireThat(thread?.id === binding.agentThreadId && thread.parentThreadId === binding.parentThreadId
    && thread.forkedFromId == null && thread.cliVersion === APP_SERVER_VERSION && thread.cwd === cwd
    && thread.agentRole === 'stnl_validation_runner',
  'child metadata foreign, forked or version differs');
  const turns = await pages(rpc, 'thread/turns/list', { threadId: binding.agentThreadId, itemsView: 'full' });
  requireThat(turns.length === 1 && id(turns[0].id) && turns[0].status === 'completed'
    && turns[0].error == null, 'fresh child has no single completed successful turn');
  const turn = turns[0];
  const items = await pages(rpc, 'thread/items/list', { threadId: binding.agentThreadId, turnId: turn.id });
  if (items.some(deniedShellTemporaryFile)) throw fail('SANDBOX_COMMAND_DENIED: runner implicit temporary file denial');
  const descendants = items.filter(item => item.type === 'subAgentActivity' && item.kind === 'started');
  if (descendants.length) throw Object.assign(fail('runner delegated outside the admitted operation'), { descendants });
  requireThat(new Set(items.map(item => item.id)).size === items.length, 'duplicate child history items');
  const messages = items.filter(item => item.type === 'agentMessage');
  const final = messages.at(-1);
  requireThat(final && (final.phase === 'final_answer' || final.phase == null)
    && id(final.id) && typeof final.text === 'string' && final.text.length > 0,
    'child final response missing/incomplete');
  // When full turn items are supplied, independently require the same complete
  // item; summary views are not used as a source of text.
  if ((turn.itemsView ?? 'full') === 'full') {
    const copy = turn.items?.filter(item => item.type === 'agentMessage').at(-1);
    requireThat(copy?.id === final.id && copy.text === final.text && copy.phase === final.phase,
      'public child surfaces disagree');
  }
  for (const item of parentItems) {
    const state = item.type === 'collabAgentToolCall' ? item.agentsStates?.[binding.agentThreadId] : null;
    if (state?.status === 'completed' && state.message != null) {
      requireThat(state.message === final.text, 'completed parent tool report disagrees with child text');
    }
  }
  requireThat(Buffer.from(final.text, 'utf8').toString('utf8') === final.text, 'invalid UTF-8 response');
  await assertAppServerBundle(bundle);
  return { agentId: binding.agentPath, status: 'completed', finalResponse: final.text };
}

// Existing capture-native accepts this envelope. Never overwrite an earlier
// result: exact replay is allowed, differing bytes preserve the first capture.
export async function writeNativeToolResult(file, envelope) {
  await physical(path.dirname(file), true);
  requireThat(path.isAbsolute(file) && path.resolve(file) === file && id(envelope?.agentId)
    && envelope.status === 'completed' && typeof envelope.finalResponse === 'string'
    && envelope.finalResponse.length > 0
    && Buffer.from(envelope.finalResponse, 'utf8').toString('utf8') === envelope.finalResponse, 'invalid tool result');
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
  try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await physical(file);
    requireThat(bytes.equals(await fs.readFile(file)), 'existing tool result differs');
  }
  return { file, finalResponseSha256: sha(Buffer.from(envelope.finalResponse, 'utf8')) };
}

export async function captureAppServerChild(rpc, { toolResultFile, ...observation }) {
  const envelope = await readAppServerChild(rpc, observation);
  return writeNativeToolResult(toolResultFile, envelope);
}
