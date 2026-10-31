// Public Codex App Server 0.163 adapter. No product admission, judging or retries.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readRunnerConfiguration } from './validation-runner.mjs';
import { projectAppServerMeasurement } from './usage-accounting.mjs';

export const APP_SERVER_VERSION = '0.163.0';
// A caller's INFO/TRACE filter can emit large span payloads before any turn.
// Scope logging to this owned process; warnings/errors and the 64 KiB guard stay.
export const appServerEnvironment = environment => ({ ...environment, RUST_LOG: 'warn' });
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// Origin marks only messages constructed/projection-redacted in this adapter.
// It grants no authority, recovery or permission.
const nativeDiagnostics = new WeakSet();
export function nativeTransportError(message, code='NATIVE_TRANSPORT_UNPROVEN') {
  const error=Object.assign(new Error(message),{code});nativeDiagnostics.add(error);return error;
}
const fail=nativeTransportError;
const ioCodes=new Set(['ENOENT','EACCES','EPERM','EEXIST','ENOTDIR','EISDIR','ELOOP','EIO','ENOSPC','EMFILE','ENFILE','EPIPE','ECONNRESET','ECONNREFUSED','ETIMEDOUT']);
const failureStages=new Set(['physical','bundle','process','contract','capture','setup','prepare','operation','evidence',
  'onDispatched','onChildStarted','onChildTurns','onFormalObserved','onAuxiliaryCompleted','onChildCompleted',
  'onPrepareContinuation','observeFormalBinding','validateRetainedCaptures','onUnadmittedChildren']);
export function nativeFailure(error,stage='operation') {
  if(nativeDiagnostics.has(error))return error;
  if(error?.code==='STAGE_CORRECTIONS_EXHAUSTED'&&['onFormalObserved','onChildTurns'].includes(stage))
    return fail('operational stage correction limit exhausted','STAGE_CORRECTIONS_EXHAUSTED');
  stage=failureStages.has(stage)?stage:'operation';
  const code=ioCodes.has(error?.code)?error.code:'other';
  const kind=code!=='other'?'IO':error instanceof SyntaxError?'PARSE'
    :stage.startsWith('on')||['observeFormalBinding','validateRetainedCaptures'].includes(stage)?'PRODUCT_CALLBACK':'UNKNOWN';
  const safe=fail(`native adapter dependency failed (stage=${stage}; kind=${kind}; code=${code})`,'DRIVER_FAILURE');
  if(Array.isArray(error?.descendants))safe.descendants=error.descendants;
  return safe;
}
const requireThat = (condition, message) => { if (!condition) throw fail(message); };
const id = value => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value);
const inside = (root, file) => file.startsWith(`${root}${path.sep}`);
export const publicTurnStatus = status => ['completed','interrupted','failed','inProgress'].includes(status)
  ? status : status == null ? 'absent' : 'other';
// App Server 0.163 public error tags only. Diagnostic projection never grants a
// retry and never retains message/additionalDetails, IDs, paths or HTTP payloads.
const turnErrorCodes = new Set(['contextWindowExceeded','sessionBudgetExceeded','usageLimitExceeded',
  'rateLimitExceeded','flexUnavailable','serverOverloaded','cyberPolicy','misalignmentPolicyViolation',
  'tooManyDenials','internalServerError','unauthorized','badRequest','threadRollbackFailed','sandboxError','other']);
const taggedTurnErrors = new Set(['httpConnectionFailed','responseStreamConnectionFailed',
  'responseStreamDisconnected','responseTooManyFailedAttempts','activeTurnNotSteerable']);
export function publicTurnDiagnostic(turn) {
  turn=turn??{};
  const error=turn.error==null?'absent':typeof turn.error==='object'&&!Array.isArray(turn.error)?'present':'invalid';
  const info=error==='present'?turn.error.codexErrorInfo:null;
  const tag=info&&typeof info==='object'&&!Array.isArray(info)&&Object.keys(info).length===1?Object.keys(info)[0]:null;
  const cause=error==='invalid'?'unrecognized':info==null?'absent':turnErrorCodes.has(info)?info
    :taggedTurnErrors.has(tag)?tag:'unrecognized';
  return `status=${publicTurnStatus(turn.status)}; error=${error}; cause=${cause}`;
}

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
  if(!value||typeof value!=='object'||Array.isArray(value)||code===null||typeof value.message!=='string')
    return Object.assign(fail(`App Server rejected ${method} (RPC ${code??'unknown'}: invalid error envelope)`),{
      rpcError:{code,description:'invalid error envelope'},initialHistoryUnavailable:false,paginatedIndexUnavailable:false});
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
  // Local paginated reads also report Unsupported while the metadata index
  // has no row. This exact operation is only a candidate for contextual
  // observation below; method absence, other operations and permissions stay
  // fatal. Never infer this condition from a diagnostic category.
  const paginatedIndexUnavailable = scoped && code === -32601
    && rawPrefix === 'list_turns is not supported yet';
  return Object.assign(fail(`App Server rejected ${method}${detail}`), {
    rpcError: { code, description }, initialHistoryUnavailable, paginatedIndexUnavailable });
}

async function physical(file, directory = false) {
  try {
  requireThat(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file,
    'noncanonical path');
  const stat = await fs.lstat(file);
  requireThat(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
    && await fs.realpath(file) === file, 'path is not physical/canonical');
  return stat;
  } catch(error) { throw nativeFailure(error,'physical'); }
}

// The caller freezes this descriptor with its existing snapshot identity. It is
// not proof that the client loaded these bytes; that remains a runtime gate.
export async function describeAppServerBundle({ skillsRoot, runnerFile }) {
  try {
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
  const runner = { path: runnerFile, sha256: sha(await fs.readFile(runnerFile)), model, effort,
    readCommand:canonicalContractReadCommand(runnerFile) };
  requireThat(files.some(file => path.basename(file.path) === 'SKILL.md'), 'empty skill bundle');
  return { skillsRoot, files, runner };
  } catch(error) { throw nativeFailure(error,'bundle'); }
}

export async function assertAppServerBundle(bundle) {
  try {
  requireThat(bundle && Array.isArray(bundle.files) && bundle.runner, 'missing frozen bundle');
  const actual = await describeAppServerBundle({ skillsRoot: bundle.skillsRoot, runnerFile: bundle.runner.path });
  requireThat(JSON.stringify(actual) === JSON.stringify(bundle), 'bundle/sibling/runner hash or mode drift');
  return actual;
  } catch(error) { throw nativeFailure(error,'bundle'); }
}

// JSONL only. This codec is bounded and stops on uncertainty; it cannot accept
// approval requests, reconnect, retry a mutation, or silently start another turn.
export function appServerRpc({ input, output, diagnostics = null, timeoutMs = 30_000, maxLineBytes = 8 * 1024 * 1024 }) {
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    && Number.isSafeInteger(maxLineBytes) && maxLineBytes > 0, 'invalid RPC bounds');
  const pending = new Map();
  const methods = new Set(['initialize', 'skills/extraRoots/set', 'skills/list', 'thread/start',
    'thread/resume', 'turn/start', 'thread/read', 'thread/turns/list', 'thread/items/list', 'experimentalFeature/list']);
  let nextId = 1, buffer = '', closed = null;
  let measurementObserver = null;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  function stop(error) {
    if (closed) return;
    closed = error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function send(value) {
    if (closed) throw closed;
    let line;
    try { line=`${JSON.stringify(value)}\n`; } catch(error) { throw nativeFailure(error,'process'); }
    requireThat(Buffer.byteLength(line) <= maxLineBytes, 'outgoing RPC line limit exceeded');
    const uncertain=error=>fail(`RPC write uncertain (code=${ioCodes.has(error?.code)?error.code:'other'})`);
    try { output.write(line, error => { if (error) stop(uncertain(error)); }); }
    catch(error) { stop(uncertain(error)); }
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
          if (Object.hasOwn(message,'error')) entry.reject(rpcRejection(entry.method, message.error, entry.threadId));
          else entry.resolve(message.result);
        }
        // Notifications are hints, never completion evidence. Read scoped public
        // history to recover exact identities/items even after a client restart.
        else {
          requireThat(typeof message.method === 'string', 'invalid RPC notification');
          if (measurementObserver) {
            const projected = projectAppServerMeasurement(message);
            if (projected) try { measurementObserver.callback(projected); }
            catch { measurementObserver.failed = true; } // Metrics never certify or interrupt a turn.
          }
        }
      } catch (error) { stop(nativeDiagnostics.has(error) ? error : fail('malformed public RPC message')); return; }
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
    observeMeasurements(callback) {
      requireThat(typeof callback === 'function' && measurementObserver === null, 'measurement observer already owned or invalid');
      const observer = { callback, failed: false }; measurementObserver = observer;
      return { get failed() { return observer.failed; },
        close() { if (measurementObserver === observer) measurementObserver = null; } };
    },
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
    close(error = fail('RPC closed by owner')) { stop(nativeFailure(error,'process')); },
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
  let child=null;
  try {
  await physical(cliLauncher); await physical(cwd, true);
  const metadata = JSON.parse(await fs.readFile(path.resolve(cliLauncher, '../../package.json'), 'utf8'));
  requireThat(metadata.name === '@openai/codex' && metadata.version === APP_SERVER_VERSION
    && cliSha256 === sha(await fs.readFile(cliLauncher)), 'CLI pin/hash differs');
  child = spawn(process.execPath, [cliLauncher, 'app-server', '--listen', 'stdio://'],
    { cwd, env: appServerEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const rpc = appServerRpc({ input: child.stdout, output: child.stdin, diagnostics: child.stderr, timeoutMs });
  // Drain without printing potentially sensitive diagnostics or retaining an
  // unbounded buffer. Exit/permission errors stay blocking, not alias bypasses.
  child.on('error', () => rpc.close(fail('owned App Server process failed to start')));
  child.on('exit', () => rpc.close(fail('owned App Server exited; dispatched effect may be uncertain')));
  return { rpc, close() { rpc.close(); child.stdin.end(); child.kill(); } };
  } catch(error) {
    const primary=nativeFailure(error,'process');
    try { child?.kill(); } catch(secondary) { const safe=nativeFailure(secondary,'process');primary.cleanupFailure={code:safe.code,message:safe.message}; }
    throw primary;
  }
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

// Typed feature metadata only. Never request the full config/layers, auth or
// experimentalFeature/enablement/set; missing flags remain unknown, not false.
export async function readAppServerAgentFeatures(rpc, threadId) {
  requireThat(id(threadId), 'feature read requires the exact loaded thread');
  const features = await pages(rpc, 'experimentalFeature/list', { threadId });
  const selected = {};
  for (const name of ['multi_agent', 'multi_agent_v2']) {
    const found = features.filter(feature => feature?.name === name);
    requireThat(found.length <= 1 && found.every(feature => typeof feature.enabled === 'boolean'), 'ambiguous agent feature metadata');
    selected[name] = found[0]?.enabled ?? null;
  }
  return selected;
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
    config: { 'skills.config': config },
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
    && started.thread.cwd === cwd && started.thread.historyMode === 'paginated'
    && (threadId === null || started.thread.id === threadId), 'thread creation identity/version/history mode differs');
  await assertAppServerBundle(bundle);
  const agentFeatures = await readAppServerAgentFeatures(rpc, started.thread.id);
  const response = await rpc.request('turn/start', { threadId: started.thread.id, effort,
    input: [selection.input, { type: 'text', text: prompt }], ...(outputSchema === undefined ? {} : { outputSchema }) });
  requireThat(id(response?.turn?.id), 'turn dispatch response incomplete; effect uncertain');
  return { threadId: started.thread.id, turnId: response.turn.id, agentFeatures,
    startedFreshThread: threadId === null,
    // These are thread-start/resume acknowledgements, not per-response billing
    // or proof that every subsequent model response used identical settings.
    runtimeConfiguration: {
      model: typeof started.model === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(started.model) ? started.model : null,
      serviceTier: started.serviceTier === null ? 'unspecified' : ['default', 'fast', 'flex', 'priority'].includes(started.serviceTier) ? started.serviceTier : null,
      approvalPolicy: ['never','untrusted','on-request'].includes(started.approvalPolicy) ? started.approvalPolicy : null,
      legacySandboxType: ['readOnly','workspaceWrite','dangerFullAccess','externalSandbox'].includes(started.sandbox?.type) ? started.sandbox.type : null,
      requestedEffort: effort,
    } };
}

async function pages(rpc, method, params, onPage = null) {
  const items = [], seen = new Set(), itemIds = new Set(), observedChildren = []; let cursor = null;
  try {
  for (let page = 0; page < 32; page++) {
    const result = await rpc.request(method, { ...params, cursor, limit: 100,
      ...(method === 'experimentalFeature/list' ? {} : { sortDirection: 'asc' }) });
    requireThat(Array.isArray(result?.data), 'public history page absent');
    await onPage?.(result.data);
    for (const entry of result.data) {
      if (method !== 'thread/items/list') { items.push(entry); continue; }
      // 0.163 returns ThreadItemEntry, not a bare ThreadItem. Enforce its
      // scope before exposing an item to parent/child consumers.
      requireThat(id(params.turnId) && entry?.turnId === params.turnId
        && entry.item && typeof entry.item === 'object' && !Array.isArray(entry.item)
        && id(entry.item.id) && id(entry.item.type), 'public item entry absent or foreign');
      requireThat(!itemIds.has(entry.item.id), 'duplicate public history item');
      itemIds.add(entry.item.id); items.push(entry.item);
      if (entry.item.type === 'subAgentActivity' && entry.item.kind === 'started'
        && id(entry.item.agentThreadId) && id(entry.item.agentPath)) observedChildren.push({
        parentThreadId: params.threadId, parentTurnId: params.turnId, agentPath: entry.item.agentPath,
        agentThreadId: entry.item.agentThreadId, unadmitted: true });
    }
    // Optional nullable cursor: omitted and null both mean None in 0.163.
    if (result.nextCursor == null) return items;
    requireThat(id(result.nextCursor) && !seen.has(result.nextCursor), 'history cursor missing/repeated');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw fail('public history page limit reached; result incomplete');
  } catch (error) {
    error=nativeFailure(error);
    if (observedChildren.length) error.descendants = [...(error.descendants ?? []), ...observedChildren];
    throw error;
  }
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

export async function readAppServerTurn(rpc, { threadId, turnId, cwd }) {
  requireThat(id(threadId) && id(turnId), 'missing scoped turn identity');
  let turns;
  try { turns = await pages(rpc, 'thread/turns/list', { threadId, itemsView: 'full' }); }
  catch (error) {
    error=nativeFailure(error);
    if (error.paginatedIndexUnavailable !== true) throw error;
    const { thread } = await rpc.request('thread/read', { threadId, includeTurns: false });
    requireThat(id(cwd) && thread?.id === threadId && thread.cliVersion === APP_SERVER_VERSION
      && thread.cwd === cwd && thread.parentThreadId == null
      && thread.historyMode === 'paginated', 'initial history index metadata differs');
    // The provider alone may defer this within its existing fresh-dispatch
    // deadline, before any valid observation. No fallback or new turn.
    throw Object.assign(error, { initialHistoryUnavailable: true });
  }
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

// Observes cost/lifecycle only. This view does not certify a validation runner,
// interpret a verdict, or emit a capture-native ready envelope.
export async function observeAppServerChild(rpc, { binding, cwd, onTurns, onChild }) {
  const { binding: current } = await parentBinding(rpc, binding);
  requireThat(Object.keys(current).every(key => current[key] === binding[key]), 'observed child binding changed');
  const { thread } = await rpc.request('thread/read', { threadId: binding.agentThreadId, includeTurns: false });
  requireThat(thread?.id === binding.agentThreadId && thread.parentThreadId === binding.parentThreadId
    && thread.cliVersion === APP_SERVER_VERSION && thread.cwd === cwd, 'auxiliary child metadata differs');
  const observedTurns = new Map();
  const turns = await pages(rpc, 'thread/turns/list', { threadId: binding.agentThreadId, itemsView: 'full' }, async page => {
    for (const turn of page) if (id(turn?.id)) observedTurns.set(turn.id, { id: turn.id, status: turn.status });
    await onTurns?.([...observedTurns.values()]);
  });
  requireThat(new Set(turns.map(turn => turn?.id)).size === turns.length, 'duplicate auxiliary turns');
  requireThat(turns.every(turn => id(turn?.id)), 'invalid auxiliary turn identity');
  // Cost counts unique observed IDs; the malformed full view still fails.
  const children = [], observedChildren = [];
  try {
  for (const turn of turns) {
    requireThat(id(turn.id) && !['absent','other'].includes(publicTurnStatus(turn.status))
      && (turn.status !== 'completed' || turn.error == null), `invalid auxiliary turn (${publicTurnDiagnostic(turn)})`);
    const items = await pages(rpc, 'thread/items/list', { threadId: binding.agentThreadId, turnId: turn.id });
    const starts = items.filter(item => item.type === 'subAgentActivity' && item.kind === 'started');
    observedChildren.push(...starts.filter(item => id(item.agentThreadId) && id(item.agentPath))
      .map(item => ({ parentThreadId: binding.agentThreadId, parentTurnId: turn.id,
        agentPath: item.agentPath, agentThreadId: item.agentThreadId, unadmitted: true })));
    if (items.some(deniedShellTemporaryFile)) throw fail('SANDBOX_COMMAND_DENIED: auxiliary command denial');
    const paths = new Set();
    for (const item of starts) {
      requireThat(!paths.has(item.agentPath), 'duplicate auxiliary child edge'); paths.add(item.agentPath);
      const child = await bindAppServerChild(rpc, { parentThreadId: binding.agentThreadId,
        parentTurnId: turn.id, agentPath: item.agentPath });
      await onChild?.(child); children.push(child);
    }
  }
  } catch (error) {
    const safe=nativeFailure(error);throw Object.assign(safe,{descendants:[...(safe.descendants??[]),...observedChildren]});
  }
  const forkState = !Object.hasOwn(thread,'forkedFromId') ? 'absent' : thread.forkedFromId === null ? 'none'
    : id(thread.forkedFromId) ? 'present' : 'invalid';
  return { provenance: { forkedFromId: ['none','present'].includes(forkState) ? thread.forkedFromId : 'unknown',
    forkState, forkSourceMatchesParent: forkState === 'present' ? thread.forkedFromId === binding.parentThreadId : null },
    turns: turns.map(turn => ({ id: turn.id, status: turn.status,
    ...(['failed','interrupted'].includes(turn.status)?{failure:publicTurnDiagnostic(turn)}:{}) })), children };
}

// Observe the contract-loaded generic profile approved by the product. A
// completed read with exact bytes is evidence of loading, not developer priority
// or proof of semantic obedience. Accept bounded cat/hash+cat/cat+hash forms;
// never execute parsed shell text or accept a claim/echo as a read.
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const shellDoubleQuote = value => `"${value.replace(/[\\$`"]/gu, '\\$&')}"`;
export function canonicalContractReadCommand(file) {
  requireThat(typeof file==='string'&&path.isAbsolute(file)&&path.resolve(file)===file,
    'noncanonical contract read path');
  return `cat -- ${shellQuote(file)}`;
}
function contractReadForms(file) {
  const operands = [shellQuote(file), shellDoubleQuote(file), ...(/^[a-zA-Z0-9_./-]+$/u.test(file) ? [file] : [])];
  const plain = new Set(), hashFirst = new Set(), readFirst = new Set(), hashOnly = new Set();
  for (const operand of operands) for (const cat of ['cat', '/bin/cat']) for (const flags of ['', '-- ']) {
    const read = `${cat} ${flags}${operand}`; plain.add(read);
    for (const hash of ['sha256sum', 'shasum -a 256']) {
      hashOnly.add(`${hash} ${operand}`);
      hashFirst.add(`${hash} ${operand} && ${read}`);
      readFirst.add(`${read} && ${hash} ${operand}`);
    }
  }
  const wrap = forms => new Set([...forms].flatMap(form => [form,
    ...['/bin/zsh -lc', '/bin/sh -c', '/bin/bash -lc'].flatMap(shell =>
      [shellQuote(form), shellDoubleQuote(form)].map(script => `${shell} ${script}`))]));
  return { plain: wrap(plain), hashFirst: wrap(hashFirst), readFirst: wrap(readFirst), hashOnly: wrap(hashOnly) };
}
// Bound completion metadata remains informational. In rust-v0.163.0,
// multi_agents_v2/message_tool.rs emits Interacted in the caller's history
// with the recipient's identity, for both send_message and followup_task.
// Self-addressing cannot turn outgoing communication into harmless metadata.
// The containing thread/turn and its parent binding are checked independently.
function runnerMetadataFailures(item,binding) {
  // rust-v0.163.0: list_agents only inventories; multi_agents/wait.rs returns
  // empty receivers/states on timeout, not an empty requested-target list.
  // Admit only that result-free observation, with no payload or turn effect.
  if(item.type==='collabAgentToolCall' && ['listAgents','wait'].includes(item.tool)) {
    const inventory=item.tool==='listAgents';
    const statesObject=item.agentsStates!==null&&typeof item.agentsStates==='object'&&!Array.isArray(item.agentsStates);
    return [['STATUS',item.status==='completed'],['SENDER',item.senderThreadId===binding.agentThreadId],
      ['RECEIVERS',Array.isArray(item.receiverThreadIds)&&item.receiverThreadIds.length===0],
      ['PROMPT',item.prompt==null],['MODEL',item.model==null||inventory&&item.model===binding.model],
      ['EFFORT',item.reasoningEffort==null||inventory&&item.reasoningEffort===binding.effort],
      ['AGENTS_STATES_OBJECT',statesObject],['AGENTS_STATES_EMPTY',statesObject&&Object.keys(item.agentsStates).length===0]]
      .filter(([,valid])=>!valid).map(([label])=>label);
  }
  if(item.type!=='subAgentActivity')return ['ITEM_TYPE'];
  if(item.kind==='interacted')return ['OUTGOING_COMMUNICATION'];
  return [['KIND',item.kind==='completed'],
    ['AGENT_PATH',item.agentPath===binding.agentPath],['AGENT_THREAD',item.agentThreadId===binding.agentThreadId],
    ['MODEL',item.model==null||item.model===binding.model],
    ['EFFORT',item.reasoningEffort==null||item.reasoningEffort===binding.effort]]
    .filter(([,valid])=>!valid).map(([label])=>label);
}
function isBoundRunnerMetadata(item,binding) {
  return runnerMetadataFailures(item,binding).length===0;
}
function runnerActivityDiagnostic(item,itemIndex,binding) {
  // Fixed enums/relations only, in the existing refusal. Never retain item IDs,
  // agent paths, commands, output or unknown server values to explain a denial.
  // runnerHistory is the read surface, not evidence of the request's issuer.
  const relation=(value,expected)=>value==null?'absent':!id(value)?'invalid':value===expected?'matches':'differs';
  const prefix=`itemIndex=${itemIndex}; failed=${runnerMetadataFailures(item,binding).join(',')}; itemType=${item.type}; origin=runnerHistory; `;
  if(item.type==='collabAgentToolCall') {
    const value=(input,known)=>input==null?'absent':typeof input!=='string'?'invalid':known.includes(input)?input:'other';
    const tool=value(item.tool,['spawnAgent','sendInput','resumeAgent','wait','closeAgent','sendMessage','followupTask','interruptAgent','listAgents']);
    const status=value(item.status,['inProgress','completed','failed','interrupted']);
    const sender=item.senderThreadId==null?'absent':!id(item.senderThreadId)?'invalid'
      :item.senderThreadId===binding.agentThreadId?'runner':item.senderThreadId===binding.parentThreadId?'parent':'other';
    const valid=Array.isArray(item.receiverThreadIds)&&item.receiverThreadIds.every(id);
    const receivers=item.receiverThreadIds==null?'absent':!valid?'invalid'
      :item.receiverThreadIds.length===0?'empty':item.receiverThreadIds.length===1?'one':'many';
    const target=predicate=>!valid?'unknown':item.receiverThreadIds.some(predicate)?'yes':'no';
    const prompt=item.prompt==null?'absent':typeof item.prompt==='string'?'present':'invalid';
    const states=item.agentsStates==null?'absent':typeof item.agentsStates!=='object'||Array.isArray(item.agentsStates)?'invalid'
      :Object.keys(item.agentsStates).length===0?'empty':'nonempty';
    return prefix+`variant=v1; tool=${tool}; status=${status}; sender=${sender}; receivers=${receivers}; `
      +`receiverRunner=${target(id=>id===binding.agentThreadId)}; receiverParent=${target(id=>id===binding.parentThreadId)}; `
      +`receiverOther=${target(id=>id!==binding.agentThreadId&&id!==binding.parentThreadId)}; `
      +`model=${relation(item.model,binding.model)}; effort=${relation(item.reasoningEffort,binding.effort)}; prompt=${prompt}; states=${states}`;
  }
  const kind=['started','interacted','interrupted','completed'].includes(item.kind)?item.kind:item.kind==null?'absent':'other';
  const [pathLabel,threadLabel]=item.type==='subAgentActivity'&&item.kind==='interacted'
    ?['recipientPath','recipientThreadId']:['agentPath','agentThreadId'];
  return prefix+`variant=v2; tool=unknown; status=unknown; sender=unknown; kind=${kind}; `
    + `${pathLabel}=${relation(item.agentPath,binding.agentPath)}; ${threadLabel}=${relation(item.agentThreadId,binding.agentThreadId)}; `
    + `model=${relation(item.model,binding.model)}; effort=${relation(item.reasoningEffort,binding.effort)}`;
}
function assertRunnerActivities(items,binding) {
  const descendants=items.filter(item=>item.type==='subAgentActivity'&&item.kind==='started');
  if(descendants.length)throw Object.assign(fail(`runner delegated outside the admitted operation (${runnerActivityDiagnostic(descendants[0],items.indexOf(descendants[0]),binding)})`),{descendants});
  for(const [index,item] of items.entries())if(['subAgentActivity','collabAgentToolCall'].includes(item.type)
    &&!isBoundRunnerMetadata(item,binding)) {
    const reason=item.type==='collabAgentToolCall'?'runner collaboration tool is not authorized'
      :item.kind==='interacted'?'runner outgoing communication is forbidden':'runner activity is foreign, effectful or ambiguous';
    throw fail(`${reason} (${runnerActivityDiagnostic(item,index,binding)})`);
  }
}
function assertConcludedInitialization(items,cwd,binding) {
  const commandFailures=[];
  if(items.some(deniedShellTemporaryFile))throw fail('SANDBOX_COMMAND_DENIED: runner implicit temporary file denial');
  for(const [itemIndex,item] of items.entries()) {
    if(['userMessage','agentMessage','reasoning'].includes(item.type)||isBoundRunnerMetadata(item,binding))continue;
    // Fixed labels and protocol scalars only. This existing refusal must say
    // which guard failed without retaining commands, output, paths or IDs.
    const diagnostic = failed => {
      const itemType = ['commandExecution','subAgentActivity','collabAgentToolCall','mcpToolCall','fileChange']
        .includes(item.type) ? item.type : 'other';
      const status = ['completed','inProgress','failed','declined','interrupted'].includes(item.status)
        ? item.status : item.status == null ? 'absent' : 'other';
      const exitCode = Number.isSafeInteger(item.exitCode) ? item.exitCode : item.exitCode == null ? 'absent' : 'other';
      return `itemIndex=${itemIndex}; failed=${failed}; itemType=${itemType}; cwd=${item.cwd===cwd?'matches':'differs'}; status=${status}; exitCode=${exitCode}`;
    };
    const concluded=['completed','failed'].includes(item.status);
    const knownExit=concluded&&Number.isSafeInteger(item.exitCode)&&item.exitCode>=0
      &&(item.status!=='failed'||item.exitCode>0);
    const failed = [['ITEM_TYPE',item.type==='commandExecution'],['CWD',item.cwd===cwd],
      ['STATUS',concluded],['EXIT_CODE',knownExit]].filter(([,valid])=>!valid).map(([label])=>label);
    requireThat(failed.length===0,
      `continuation initialization has denied, uncertain or unexpected effects (${diagnostic(failed.join(','))})`);
    if(item.exitCode!==0)commandFailures.push({itemIndex,status:item.status,exitCode:item.exitCode});
    // This is a known command result, not permission to retry. The controller
    // still proves bound work/controls and no started recipe before its grant;
    // those proofs do not certify arbitrary effects outside the bound scope.
  }
  return commandFailures;
}
async function assertGenericContractLoad(items, bundle, cwd, binding) {
  const firstAction = items.find(item => !['userMessage', 'agentMessage', 'reasoning'].includes(item.type)
    && !isBoundRunnerMetadata(item,binding));
  requireThat(firstAction?.type === 'commandExecution' && firstAction.status === 'completed'
    && firstAction.exitCode === 0 && firstAction.cwd === cwd, 'generic runner contract read not observed before scope actions');
  const bytes = await fs.readFile(bundle.runner.path).catch(error=>{throw nativeFailure(error,'contract');}), text = bytes.toString('utf8');
  requireThat(Buffer.from(text, 'utf8').equals(bytes) && sha(bytes) === bundle.runner.sha256,
    'generic runner contract bytes differ');
  const forms = contractReadForms(bundle.runner.path), command = firstAction.command;
  const hashLine = `${bundle.runner.sha256.slice(7)}  ${bundle.runner.path}\n`;
  const expected = forms.plain.has(command) ? text : forms.hashFirst.has(command)
    ? hashLine + text : forms.readFirst.has(command) ? text + hashLine : null;
  requireThat(expected !== null && firstAction.aggregatedOutput === expected,
    'generic runner complete contract output absent, truncated or foreign');
}

// Only scoped read APIs. A completed wait/mailbox or parent agent message never
// certifies the child. No resume/start/followup, recipe, private path or synthesis.
function concludedChildMessage(turn,items) {
  requireThat(new Set(items.map(item=>item.id)).size===items.length,'duplicate child history items');
  const final=items.filter(item=>item.type==='agentMessage').at(-1);
  requireThat(final&&(final.phase==='final_answer'||final.phase==null)
    &&id(final.id)&&typeof final.text==='string'&&final.text.length>0,'child final response missing/incomplete');
  if((turn.itemsView??'full')==='full') {
    const copy=turn.items?.filter(item=>item.type==='agentMessage').at(-1);
    requireThat(copy?.id===final.id&&copy.text===final.text&&copy.phase===final.phase,'public child surfaces disagree');
  }
  return final;
}
export async function readAppServerChild(rpc, { binding, bundle, cwd, continuation = null, initialization = false, priorCaptures = [], onInitializationObserved = null }) {
  await assertAppServerBundle(bundle); await physical(cwd, true);
  const { binding: current, items: parentItems } = await parentBinding(rpc, binding);
  requireThat(Object.keys(current).every(key => current[key] === binding[key]), 'child binding changed');
  requireThat(current.model === bundle.runner.model && current.effort === bundle.runner.effort,
    'runner model/effort not proven by official spawn activity');
  const { thread } = await rpc.request('thread/read', { threadId: binding.agentThreadId, includeTurns: false });
  // 0.163 exposes agentRole as optional string|null metadata. Its absence is
  // not a role assignment; the origin binding and checks below prove the runner.
  requireThat(thread?.id === binding.agentThreadId && thread.parentThreadId === binding.parentThreadId
    && thread.forkedFromId == null && thread.cliVersion === APP_SERVER_VERSION && thread.cwd === cwd
    && (thread.agentRole == null || thread.agentRole === 'default') && thread.model === bundle.runner.model
    && thread.reasoningEffort === bundle.runner.effort,
  'child metadata foreign, forked or version differs');
  const turns = await pages(rpc, 'thread/turns/list', { threadId: binding.agentThreadId, itemsView: 'full' });
  requireThat(priorCaptures.length<=1 && turns.length === (continuation === null ? 1 : 2)+priorCaptures.length,
    'fresh child has no admitted completed successful turn sequence (failed=COUNT)');
  const invalidTurn=turns.findIndex(turn=>!id(turn?.id)||turn.status!=='completed'||turn.error!=null);
  requireThat(invalidTurn===-1,`fresh child has no admitted completed successful turn sequence (failed=TURN; ${publicTurnDiagnostic(turns[invalidTurn])})`);
  requireThat(turns.every(turn=>turn.itemsView===undefined||['full','summary','notLoaded'].includes(turn.itemsView)),
    'child turn items view unproven');
  let original = null,initializationCommandFailures=null;
  if (continuation !== null) {
    requireThat(continuation.format === 'stnl-native-pre-verification-continuation-v1'
      && Object.keys(binding).every(key => continuation.binding?.[key] === binding[key])
      && turns[0].id === continuation.firstTurnId
      && typeof continuation.firstToolResultUtf8==='string'
      && sha(Buffer.from(continuation.firstToolResultUtf8, 'utf8')) === continuation.firstToolResultSha256,
    'continuation public identity/source differs');
    try { original=JSON.parse(continuation.firstToolResultUtf8); }
    catch(error) { throw nativeFailure(error,'contract'); }
    requireThat(original&&typeof original==='object'&&!Array.isArray(original),'continuation saved envelope malformed');
    const firstItems = await pages(rpc, 'thread/items/list', { threadId: binding.agentThreadId, turnId: turns[0].id });
    const firstFinal = firstItems.filter(item => item.type === 'agentMessage').at(-1);
    requireThat(original.agentId === binding.agentPath && original.status === 'completed'
      && firstFinal?.text === original.finalResponse
      && firstFinal?.phase === 'final_answer'
      && turns[0].items?.filter(item => item.type === 'agentMessage').at(-1)?.text === firstFinal.text,
    'continuation first public response changed');
    assertRunnerActivities(firstItems,binding);
    initializationCommandFailures=assertConcludedInitialization(firstItems,cwd,binding);
    await assertGenericContractLoad(firstItems, bundle, cwd, binding);
  }
  for(const [index,prior] of priorCaptures.entries()) {
    const previousTurn=turns[index+(continuation===null?0:1)];
    requireThat(prior.turnId===previousTurn.id&&prior.binding.agentPath===binding.agentPath
      &&prior.binding.agentThreadId===binding.agentThreadId,'clarification public prefix identity differs');
    const previousItems=await pages(rpc,'thread/items/list',{threadId:binding.agentThreadId,turnId:previousTurn.id});
    assertRunnerActivities(previousItems,binding);
    if(continuation===null)await assertGenericContractLoad(previousItems,bundle,cwd,binding);
    const previousFinal=concludedChildMessage(previousTurn,previousItems);
    requireThat(previousFinal.text===prior.toolResult.finalResponse,'clarification first public response changed');
    await physical(prior.file);
    const metadata=await fs.lstat(prior.file);
    requireThat(metadata.nlink===1&&Buffer.from(JSON.stringify(prior.toolResult)+'\n').equals(await fs.readFile(prior.file)),
      'saved first child envelope absent/aliased/divergent');
  }
  const turn = turns.at(-1);
  const items = await pages(rpc, 'thread/items/list', { threadId: binding.agentThreadId, turnId: turn.id });
  assertRunnerActivities(items,binding);
  if(initialization)initializationCommandFailures=assertConcludedInitialization(items,cwd,binding);
  if (items.some(deniedShellTemporaryFile)) throw fail('SANDBOX_COMMAND_DENIED: runner implicit temporary file denial');
  if (continuation === null) await assertGenericContractLoad(items, bundle, cwd, binding);
  const final=concludedChildMessage(turn,items);
  for (const item of parentItems) {
    const state = item.type === 'collabAgentToolCall' ? item.agentsStates?.[binding.agentThreadId] : null;
    if (state?.status === 'completed' && state.message != null) {
      requireThat(state.message === final.text || original !== null
        && state.message === original.finalResponse || priorCaptures.some(prior=>state.message===prior.toolResult.finalResponse),
        'completed parent tool report disagrees with child text');
    }
  }
  requireThat(Buffer.from(final.text, 'utf8').toString('utf8') === final.text, 'invalid UTF-8 response');
  await assertAppServerBundle(bundle);
  // A separate observation callback never changes the canonical tool envelope.
  // In the caller it runs only after the product's eligibility probe.
  if(initializationCommandFailures!==null)await onInitializationObserved?.(initializationCommandFailures);
  return { agentId: binding.agentPath, status: 'completed', finalResponse: final.text,
    ...(continuation === null || priorCaptures.length ? {} : { preVerificationContinuation: continuation }) };
}

// Existing capture-native accepts this envelope. Never overwrite an earlier
// result: exact replay is allowed, differing bytes preserve the first capture.
export async function writeNativeToolResult(file, envelope) {
  try {
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
  } catch(error) { throw nativeFailure(error,'capture'); }
}

export async function captureAppServerChild(rpc, { toolResultFile, ...observation }) {
  const envelope = await readAppServerChild(rpc, observation);
  return writeNativeToolResult(toolResultFile, envelope);
}
