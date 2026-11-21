import { spawn } from 'node:child_process';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = (thread, turn) => JSON.stringify([thread, turn]);
function clean(value) {
  if (Array.isArray(value)) return value.map(clean).filter(v => v !== undefined);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'reasoning') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !/encrypted|authorization|accessToken|refreshToken|apiKey|password|reasoningText|reasoningContent/i.test(k)).map(([k, v]) => [k, clean(v)]));
}
export function sanitizeEvent(event) {
  if (typeof event?.method !== 'string') return null;
  const { method, params = {} } = event;
  if (/reasoning|auth|account\//i.test(method)) return null;
  if (method.startsWith('rawResponse/')) {
    if (method !== 'rawResponse/completed') return null;
    return { method, params: clean(Object.fromEntries(['threadId', 'turnId', 'responseId', 'model', 'usage', 'status'].filter(k => params[k] !== undefined).map(k => [k, params[k]]))) };
  }
  if (params.item?.type === 'reasoning') return null;
  if (!/^(thread\/|turn\/|item\/|error$|model\/)/.test(method)) return null;
  return { method, params: clean(params) };
}

/** JSON-RPC transport only. No persistence, approval authority or Sentinel decisions. */
export class AppServer {
  constructor({ cli, cwd, home, tmpDir, onEvent = () => {}, spawnImpl = spawn }) {
    Object.assign(this, { cli, cwd, home, tmpDir, onEvent, spawnImpl });
    this.pending = new Map(); this.completed = new Map(); this.nextId = 0;
    this.child = null; this.active = null; this.closed = false; this.started = false;
  }
  emit(event) {
    const safe = sanitizeEvent(event);
    if (safe) this.onEvent(safe);
  }
  fail(error) {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.active?.terminal.resolve({ status: 'transport_error', error: { message: error.message } });
  }
  write(message) {
    if (!this.child || this.closed || this.child.stdin.destroyed) throw Error('App Server unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  receive(message) {
    // Requests and responses have independent ID spaces. Never resolve a pending
    // request merely because an inbound approval request uses the same ID.
    if (message.method) {
      if (message.id != null) {
        this.write({ id: message.id, error: { code: -32000, message: 'Benchmark cannot authorize provider requests' } });
        this.emit({ method: 'error', params: { category: 'provider_request_denied', method: message.method } });
        return;
      }
      this.emit(message);
      if (message.method === 'turn/completed') {
        const { threadId, turn } = message.params ?? {};
        if (threadId && turn?.id) {
          this.completed.set(key(threadId, turn.id), turn);
          if (this.completed.size > 256) this.completed.delete(this.completed.keys().next().value);
          if (this.active?.threadId === threadId && this.active.turnId === turn.id) {
            if (turn.status === 'interrupted') this.active.timing.providerInterruptedAt ??= Date.now();
            this.active.terminal.resolve(turn);
          }
        }
      }
      return;
    }
    if (message.id != null && this.pending.has(message.id)) {
      const p = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) { const error = Error(message.error.message ?? 'JSON-RPC error'); error.code = message.error.code; p.reject(error); }
      else p.resolve(message.result);
    }
  }
  async start() {
    if (this.started && !this.closed) return this;
    if (this.child || this.closed) throw Error('App Server instance cannot be restarted');
    this.exit = deferred();
    this.child = this.spawnImpl(this.cli, ['-c', 'web_search="disabled"', '-c', 'features.multi_agent=true', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'shell_environment_policy.set.TMPDIR='+JSON.stringify(this.tmpDir), '-c', 'shell_environment_policy.set.TMPPREFIX='+JSON.stringify(this.tmpDir+'/zsh'), 'app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, env: { ...process.env, CODEX_HOME: this.home, TMPDIR: this.tmpDir, TMPPREFIX: this.tmpDir+'/zsh', TMP: this.tmpDir, TEMP: this.tmpDir }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { this.fail(Error('Protocol line exceeds limit')); void this.stop(); return; }
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line) continue;
        try { this.receive(JSON.parse(line)); } catch (e) { this.fail(e); void this.stop(); return; }
      }
    });
    // Deliberately discard stderr text: it may contain private diagnostics.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', e => this.fail(e));
    this.child.on('error', e => { this.fail(e); this.exit.resolve(); });
    this.child.on('exit', (code, signal) => { this.fail(Error(`App Server exit (${code ?? signal})`)); this.exit.resolve(); });
    try {
      this.initialize = await this.request('initialize', { clientInfo: { name: 'sentinel-benchmark', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} }); this.started = true; return this;
    } catch (e) { await this.stop(); throw e; }
  }
  request(method, params, { timeoutMs = 30000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(Error('Invalid request timeout'));
    const id = `benchmark-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`JSON-RPC timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  startThread(params) { return this.request('thread/start', { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'workspace-write', experimentalRawEvents: true, ...params }); }
  resumeThread(params) { return this.request('thread/resume', { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'workspace-write', ...params }); }
  async readThread(threadId) { return clean(await this.request('thread/read', { threadId, includeTurns: true })); }
  modelList() { return this.request('model/list', {}); }
  async runTurn({ threadId, input, model, effort, deadline = Date.now() + 900000, onAccepted = () => {}, signal, timing = {} }) {
    if (this.active) throw Error('Only one active turn per adapter');
    const remaining = Number(new Date(deadline)) - Date.now();
    if (!Number.isFinite(remaining)) throw Error('Invalid turn deadline');
    if (signal?.aborted || remaining <= 0) {
      timing.interruptRpcOutcome = 'not-dispatched';
      return { threadId, turnId: null, status: 'interrupted', turn: null };
    }
    const active = { threadId, turnId: null, terminal: deferred(), interrupted: false, timing };
    this.active = active;
    const interruption = deferred();
    const abort = source => {
      timing.adapterAbortAt ??= Date.now(); timing.adapterAbortSource ??= source;
      active.interrupted = true; interruption.resolve({ status: 'interrupted' });
    };
    const onSignal = () => abort('signal');
    const timer = setTimeout(() => abort('adapter-deadline'), remaining);
    signal?.addEventListener('abort', onSignal, { once: true });
    try {
      const ack = await Promise.race([
        this.request('turn/start', { threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, { timeoutMs: Math.max(1, Math.min(30000, remaining)) }),
        interruption.promise,
      ]);
      if (ack.status === 'interrupted') return { threadId, turnId: null, status: 'interrupted', turn: null };
      if (!ack.turn?.id) throw Error('turn/start missing turn identity');
      active.turnId = ack.turn.id;
      onAccepted({ threadId, turnId: active.turnId });
      const buffered = this.completed.get(key(threadId, active.turnId));
      if (buffered) active.terminal.resolve(buffered);
      const turn = await Promise.race([active.terminal.promise, interruption.promise]);
      return { threadId, turnId: active.turnId, status: active.interrupted ? 'interrupted' : turn.status, turn: clean(turn) };
    } catch (error) {
      // A lost acknowledgement is an uncertain dispatch, not permission to retry.
      active.interrupted = true;
      return { threadId, turnId: active.turnId, status: 'interrupted', turn: null, error: error.message };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onSignal);
      if (active.interrupted) {
        if (active.turnId && !this.closed) {
          timing.interruptRpcAttemptedAt = Date.now();
          try {
            await this.request('turn/interrupt', { threadId, turnId: active.turnId }, { timeoutMs: 500 });
            timing.interruptRpcOutcome = 'acknowledged';
          } catch (error) {
            timing.interruptRpcOutcome = error.message === 'JSON-RPC timeout: turn/interrupt' ? 'timeout' : 'failed';
          }
          timing.interruptRpcSettledAt = Date.now();
        } else timing.interruptRpcOutcome = active.turnId ? 'transport-closed' : 'turn-identity-unknown';
        await this.stop();
        timing.adapterStoppedAt = Date.now();
      }
      this.active = null;
    }
  }
  async stop() {
    if (this.stopping) return this.stopping;
    if (this.active) this.active.interrupted = true;
    this.stopping = (async () => {
      if (!this.child) { this.closed = true; return; }
      if (!this.closed) this.child.kill('SIGTERM');
      await Promise.race([this.exit.promise, delay(1000)]);
      if (this.child.exitCode == null && this.child.signalCode == null) { this.child.kill('SIGKILL'); await Promise.race([this.exit.promise, delay(500)]); }
      this.fail(Error('App Server stopped'));
    })();
    return this.stopping;
  }
}
