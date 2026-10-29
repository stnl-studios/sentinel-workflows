import { isDeepStrictEqual } from 'node:util';

// Normalize cumulative SDK completion usage without guessing across threads,
// segments, resets, or incomplete observations.

const USAGE_FIELDS = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
]);

const ZERO_USAGE = Object.freeze(Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])));

function fail(message) {
  throw new Error(message);
}

function usageShape(usage) {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return null;
  if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) return null;
  const normalized = {};
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (value === undefined) normalized[field] = 0;
    else if (!Number.isSafeInteger(value) || value < 0) return null;
    else normalized[field] = value;
  }
  return normalized;
}

function usageFingerprint(usage) {
  return JSON.stringify(USAGE_FIELDS.map((field) => usage[field]));
}

function add(left, right) {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, left[field] + right[field]]));
}

function subtract(current, previous) {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [field, current[field] - previous[field]]));
}

function attributableDelta(delta) {
  // cached input, cache writes, and reasoning output are retained as
  // categories, but input/output remain the non-overlapping total buckets.
  return {
    input: delta.input_tokens,
    cachedInput: delta.cached_input_tokens,
    cacheWrite: delta.cache_write_input_tokens,
    output: delta.output_tokens,
    reasoningOutput: delta.reasoning_output_tokens,
    total: delta.input_tokens + delta.output_tokens,
  };
}

function unavailable(reason, extra = {}) {
  return {
    status: "unavailable",
    delta: null,
    usage: null,
    reason,
    ...extra,
  };
}

function partial(reason, extra = {}) {
  return {
    status: "partial",
    delta: null,
    usage: null,
    reason,
    ...extra,
  };
}

/**
 * Create a stateful normalizer for cumulative `turn.completed` observations.
 *
 * Pass a zero usage baseline when the source is known to start at zero. Without
 * a baseline, the first observation is partial and is never treated as spend.
 * Use a separate normalizer (or source value) for an independent runner.
 */
export function createUsageNormalizer({ baseline = null, source = "sdk" } = {}) {
  const states = new Map();
  const seenThreads = new Set();
  const seeded = usageShape(baseline);
  if (baseline !== null && seeded === null) fail("usage baseline must contain nonnegative integer counters");

  function observe({ threadId, segment, usage, eventId = null, parentThreadId = null } = {}) {
    if (typeof threadId !== "string" || threadId.length === 0
      || typeof segment !== "string" || segment.length === 0) {
      return unavailable("unknown identity", { source, threadId: threadId ?? null, segment: segment ?? null });
    }
    if (parentThreadId !== null && parentThreadId !== threadId && seenThreads.has(parentThreadId)) {
      return partial("fork detected", { source, threadId, segment, parentThreadId });
    }
    seenThreads.add(threadId);
    const current = usageShape(usage);
    if (current === null) return unavailable("incomplete usage", { source, threadId, segment });
    const key = `${source}\u0000${threadId}\u0000${segment}`;
    const state = states.get(key);
    const fingerprint = usageFingerprint(current);
    if (state?.fingerprints.has(fingerprint)) {
      return {
        status: "duplicate",
        delta: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoningOutput: 0, total: 0 },
        usage: { ...current },
        source, threadId, segment, duplicate: true,
      };
    }
    if (state === undefined && seeded === null) {
      states.set(key, { previous: current, fingerprints: new Set([fingerprint]), parentThreadId });
      return { status: "partial", delta: null, usage: { ...current }, reason: "unknown baseline", source, threadId, segment };
    }
    const previous = state?.previous ?? seeded;
    const delta = subtract(current, previous);
    const decreased = USAGE_FIELDS.filter((field) => delta[field] < 0);
    if (decreased.length !== 0) {
      states.set(key, { previous: current, fingerprints: new Set([...(state?.fingerprints ?? []), fingerprint]), parentThreadId });
      return partial("decrease/reset/fork detected", {
        source, threadId, segment, usage: { ...current }, fields: decreased,
      });
    }
    const next = state ?? { fingerprints: new Set(), parentThreadId };
    next.previous = current;
    next.parentThreadId = parentThreadId;
    next.fingerprints.add(fingerprint);
    states.set(key, next);
    return {
      status: "attributable",
      delta: attributableDelta(delta),
      usage: { ...current },
      source, threadId, segment, eventId,
    };
  }

  return Object.freeze({
    observe,
    snapshot() {
      return [...states.entries()].map(([key, value]) => ({ key, previous: { ...value.previous } }));
    },
    source,
    baseline: seeded === null ? null : { ...seeded },
  });
}

export { USAGE_FIELDS, ZERO_USAGE };

const APP_FIELDS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
const measurementId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
const counter = value => value && typeof value === 'object' && !Array.isArray(value)
  && APP_FIELDS.every(field => Number.isSafeInteger(value[field]) && value[field] >= 0)
  ? Object.fromEntries(APP_FIELDS.map(field => [field, value[field]])) : null;
const sameCounter = (a, b) => a && b && APP_FIELDS.every(field => a[field] === b[field]);
const coherentCounter = value => value.totalTokens === value.inputTokens + value.outputTokens
  && value.cachedInputTokens <= value.inputTokens && value.reasoningOutputTokens <= value.outputTokens;

// Only allowlisted numeric counters and lifecycle identity leave the RPC codec.
// No items, prompts, error text, credentials, outputs or paths are retained.
export function projectAppServerMeasurement(message) {
  if (!['thread/tokenUsage/updated', 'turn/started', 'turn/completed'].includes(message?.method)) return null;
  const p = message.params, turnId = message.method === 'thread/tokenUsage/updated' ? p?.turnId : p?.turn?.id;
  if (!measurementId(p?.threadId) || !measurementId(turnId)) return { method: 'invalid', reason: 'measurement identity' };
  const value = { method: message.method, threadId: p.threadId, turnId };
  if (message.method === 'thread/tokenUsage/updated') {
    const total = counter(p.tokenUsage?.total), last = counter(p.tokenUsage?.last);
    if (!total || !last) return { ...value, method: 'invalid', reason: 'measurement counters' };
    return { ...value, tokenUsage: { total, last,
      modelContextWindow: Number.isSafeInteger(p.tokenUsage.modelContextWindow) && p.tokenUsage.modelContextWindow >= 0
        ? p.tokenUsage.modelContextWindow : null } };
  }
  return { ...value, status: ['inProgress', 'completed', 'failed', 'interrupted'].includes(p.turn.status) ? p.turn.status : 'unknown',
    ...Object.fromEntries(['startedAt', 'completedAt', 'durationMs'].map(field => [field,
      Number.isSafeInteger(p.turn[field]) && p.turn[field] >= 0 ? p.turn[field] : null])) };
}

// 0.163.0 runtime counters, NOT invoice usage. `last` may be a context estimate;
// use only differences of coherent thread-local `total` with a proven baseline.
// Replay the existing event journal; there is no second persistent registry.
export function appServerUsageObservations(events) {
  if (!Array.isArray(events) || events.length > 16384) return { observations: [], issues: ['measurement event bound exceeded'] };
  const scopes = new Map(), threads = new Map(), records = new Map(), notifications = new Map(), issues = new Set();
  const key = (threadId, turnId) => JSON.stringify([threadId, turnId]);
  const validEvent = event => event && typeof event === 'object' && !Array.isArray(event);
  for (const event of events) if (!validEvent(event)) issues.add('invalid measurement event');
  else if (event.type === 'native.usage.scope') {
    const s = event.scope;
    if (!s || !measurementId(s.threadId) || !measurementId(s.turnId) || !['main', 'runner'].includes(s.source)
      || typeof s.fresh !== 'boolean') { issues.add('invalid usage scope'); continue; }
    const id = key(s.threadId, s.turnId), previous = scopes.get(id);
    if (previous && !isDeepStrictEqual(previous, s)) issues.add('conflicting usage scope');
    else scopes.set(id, s);
  }
  function select(threadId, turnId) {
    const id = key(threadId, turnId), scope = scopes.get(id);
    if (!scope) {
      issues.add([...scopes.values()].some(s => s.threadId === threadId) ? 'unbound turn usage' : 'unbound thread usage');
      return null;
    }
    if (records.has(id)) return records.get(id);
    const prior = threads.get(threadId);
    const fresh = scope.fresh && (scope.source === 'main' && scope.proof === 'thread/start'
      || scope.source === 'runner' && scope.proof === 'public-child-no-fork' && scope.forkedFromId === null);
    let baseline = prior?.usable ? prior.final : fresh && !prior
      ? Object.fromEntries(APP_FIELDS.map(field => [field, 0])) : null;
    const problems = new Set();
    if (prior && !prior.terminal) { prior.problems.add('overlapping turn boundary'); problems.add('overlapping turn boundary'); baseline = null; }
    if (fresh && prior) { problems.add('unexpected baseline reset'); baseline = null; }
    const record = { scope, baseline, final: null, terminal: false, status: null, usable: false, problems, ordinal: records.size };
    threads.set(threadId, record); records.set(id, record); return record;
  }
  for (const event of events) {
    if (!validEvent(event)) continue;
    if (event.type === 'native.usage.unavailable') { issues.add('usage persistence incomplete'); continue; }
    if (event.type !== 'native.usage.notification') continue;
    const n = event.notification;
    // This identifies our persisted observation, not an invoice/response ID.
    // Equal counters in a newly received event are not proof of old replay.
    if (!measurementId(event.observationId)) { issues.add('missing observation identity'); continue; }
    if (notifications.has(event.observationId)) {
      if (!isDeepStrictEqual(notifications.get(event.observationId), n)) issues.add('conflicting observation identity');
      continue;
    }
    notifications.set(event.observationId, n);
    if (!n || n.method === 'invalid') { issues.add('invalid usage notification'); continue; }
    const record = select(n.threadId, n.turnId); if (!record) continue;
    if (n.method === 'thread/tokenUsage/updated') {
      const total = counter(n.tokenUsage?.total);
      if (!total) { record.problems.add('invalid total'); continue; }
      if (sameCounter(record.final, total)) continue; // Repeated current snapshot, no additional usage.
      if (record.terminal) {
        if (!sameCounter(record.final, total)) for (const later of records.values())
          if (later.scope.threadId === record.scope.threadId && later.ordinal >= record.ordinal) {
            later.problems.add('late changed total'); later.usable = false;
          }
        continue;
      }
      if (!coherentCounter(total)) record.problems.add('synthetic or incoherent total');
      const previous = record.final ?? record.baseline;
      if (previous && APP_FIELDS.some(field => total[field] < previous[field])) record.problems.add('counter decrease/reset');
      record.final = total;
    } else if (n.method === 'turn/completed') {
      if (!['completed', 'failed', 'interrupted'].includes(n.status)) record.problems.add('unknown terminal status');
      if (record.terminal && record.status !== n.status) record.problems.add('conflicting terminal status');
      record.terminal = true; record.status = n.status;
      record.usable = record.final !== null && coherentCounter(record.final) && record.problems.size === 0;
    } else if (n.method !== 'turn/started') record.problems.add('unknown measurement event');
  }
  const observations = [];
  for (const [id, scope] of scopes) {
    const r = records.get(id), reasons = new Set(r?.problems ?? []);
    if (!r?.baseline) reasons.add('unknown inherited baseline');
    if (!r?.final) reasons.add('usage snapshot missing');
    if (!r?.terminal) reasons.add('terminal notification missing');
    const difference = r?.baseline && r.final ? Object.fromEntries(APP_FIELDS.map(field => [field, r.final[field] - r.baseline[field]])) : null;
    if (difference && (!coherentCounter(difference) || APP_FIELDS.some(field => difference[field] < 0))) reasons.add('invalid cumulative delta');
    if (difference?.totalTokens === 0) reasons.add('unchanged counters do not prove zero spending');
    observations.push({ source: scope.source, threadId: scope.threadId, turnId: scope.turnId,
      segment: scope.turnId, eventId: `app-server:${scope.threadId}:${scope.turnId}`, operationId: scope.operationId,
      status: reasons.size ? 'partial' : 'attributable', reason: reasons.size ? [...reasons].join('; ') : null,
      semantics: 'app-server-0.163.0-thread-runtime-delta', billing: false, turnStatus: r?.status ?? null,
      ...(scope.source === 'runner' ? { configuration: {
        model: typeof scope.model === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(scope.model) ? scope.model : null,
        effort: ['none','minimal','low','medium','high','xhigh','max'].includes(scope.effort) ? scope.effort : null,
      } } : {}),
      baseline: r?.baseline ?? null, final: r?.final ?? null,
      delta: reasons.size ? null : { input: difference.inputTokens, cachedInput: difference.cachedInputTokens,
        cacheWrite: difference.cacheWriteInputTokens, output: difference.outputTokens,
        reasoningOutput: difference.reasoningOutputTokens, total: difference.totalTokens } });
  }
  return { observations, issues: [...issues] };
}
