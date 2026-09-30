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
