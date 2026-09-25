#!/usr/bin/env node

/* A deliberately small presentation boundary. It consumes manager events but
 * never derives state, timing, progress, or test results that were not sent by
 * the producer. */

const ANSI = Object.freeze({ reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m', cyan: '\u001b[36m', green: '\u001b[32m', yellow: '\u001b[33m', red: '\u001b[31m' });

function text(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function first(event, keys) {
  for (const key of keys) {
    const value = text(event?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function caseId(event) {
  const value = first(event, ['caseId', 'case', 'id']);
  return value && /^[ABC]$/u.test(value) ? value : null;
}

function elapsed(event) {
  const value = event?.elapsedMs ?? event?.durationMs;
  return Number.isFinite(value) && value >= 0 ? `${Math.round(value / 1000)}s` : null;
}

function pathValue(event) {
  for (const key of ['artifactPath', 'rawPath', 'path', 'workspace', 'artifacts']) {
    if (typeof event?.[key] === 'string' && event[key] !== '') return event[key];
  }
  return null;
}

function operation(event) {
  return first(event, ['operation', 'stage', 'phase', 'kind']);
}

function counts(event) {
  const main = event?.mainTurns ?? event?.mainCount;
  const runner = event?.runnerTurns ?? event?.runnerCount;
  const global = event?.globalTurns ?? event?.globalConsumed;
  const saldo = event?.globalSaldo ?? event?.globalRemaining ?? event?.saldo;
  const values = [];
  if (Number.isFinite(main) || Number.isFinite(runner)) values.push(`main ${Number.isFinite(main) ? main : '?'} / runner ${Number.isFinite(runner) ? runner : '?'}`);
  if (Number.isFinite(global) || Number.isFinite(saldo)) values.push(`global ${Number.isFinite(global) ? global : '?'} / saldo ${Number.isFinite(saldo) ? saldo : '?'}`);
  return values.join(' · ');
}

function model(event) {
  const value = first(event, ['model', 'label']);
  const effort = first(event, ['effort']);
  return value === null ? null : `${value}${effort === null ? '' : `/${effort}`}`;
}

function timeline(event) {
  const value = event?.timeline;
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join(' > ');
  return text(value);
}

function official(event) {
  const value = event?.officialState ?? event?.official?.state ?? event?.state ?? event?.resultingState;
  return text(value);
}

function recovery(event) {
  const value = event?.recovery ?? event?.requiredRecoveryHandoff;
  if (!value) return null;
  if (typeof value === 'string') return value;
  return [value.operation, value.slice].filter(Boolean).join(' ');
}

function statusLabel(event) {
  return first(event, ['result', 'status', 'outcome', 'message']) ?? 'update';
}

function line(event) {
  const id = caseId(event) ?? '—';
  const parts = [statusLabel(event)];
  const run = first(event, ['runId']);
  if (run) parts.push(`run ${run}`);
  const op = operation(event);
  if (op && !['status', 'inspect', 'result', 'progress', 'start'].includes(op.toLowerCase())) parts.push(op);
  const slice = first(event, ['slice']);
  if (slice) parts.push(slice);
  const stage = first(event, ['stage']);
  if (stage && stage !== op) parts.push(stage);
  const time = elapsed(event);
  if (time) parts.push(time);
  const dispatch = model(event);
  if (dispatch) parts.push(dispatch);
  const count = counts(event);
  if (count) parts.push(count);
  const state = official(event);
  if (state && state !== statusLabel(event)) parts.push(`state ${state}`);
  const handoff = recovery(event);
  if (handoff) parts.push(`recovery ${handoff}`);
  const path = pathValue(event);
  if (path) parts.push(path);
  const trail = timeline(event);
  if (trail) parts.push(trail);
  if (event?.cases && typeof event.cases === 'object' && !Array.isArray(event.cases)) {
    const summary = Object.entries(event.cases).map(([name, value]) => `${name}:${typeof value === 'string' ? value : value?.status ?? '?'}`).join(' ');
    if (summary) parts.push(summary);
  }
  if (Array.isArray(event?.runs)) {
    parts.push(`${event.runs.length} runs`);
    const recent = event.runs.slice(0, 3).map((item) => `${item.runId}:${item.summary?.status ?? '?'}`).join(' ');
    if (recent) parts.push(recent);
  }
  if (event?.active?.runId) parts.push(`active ${event.active.runId}`);
  return `[${id}] ${parts.join(' · ')}`;
}

function diagnostic(event) {
  return event?.kind === 'diagnostic' || event?.level === 'error' || event?.error !== undefined || event?.diagnostic !== undefined;
}

function createReporter({ format = 'human', stdout = process.stdout, stderr = process.stderr, isTTY = Boolean(stdout?.isTTY), width = 100, noColor = false } = {}) {
  if (!['human', 'json'].includes(format)) throw new TypeError('format must be human or json');
  const color = format === 'human' && isTTY && !noColor && width >= 80;
  const compact = format === 'human' && isTTY && width < 80;
  const cases = new Map();

  function write(stream, value) {
    if (stream && typeof stream.write === 'function') stream.write(value);
  }

  function emit(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event must be an object');
    if (format === 'json') {
      write(diagnostic(event) ? stderr : stdout, `${JSON.stringify(event)}\n`);
      return event;
    }
    const expanded = event.cases && typeof event.cases === 'object' && !Array.isArray(event.cases)
      ? Object.entries(event.cases).filter(([id]) => /^[ABC]$/u.test(id)).map(([id, value]) => ({ ...event, caseId: id, ...(typeof value === 'object' && value !== null ? value : { status: value }) }))
      : [event];
    for (const item of expanded) {
      const id = caseId(item);
      if (id) cases.set(id, line(item));
    }
    if (isTTY) {
      const body = [...cases.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => value).join('\n') || line(event);
      const panel = compact ? body.replaceAll(' · ', ' | ') : body;
      const rendered = color ? `${ANSI.bold}${ANSI.cyan}${panel}${ANSI.reset}\n` : `${panel}\n`;
      write(stdout, rendered);
    } else {
      if (expanded.length > 1) for (const item of expanded) write(stdout, `${line(item)}\n`);
      else write(stdout, `${line(event)}\n`);
    }
    if (diagnostic(event)) write(stderr, `${line(event)}\n`);
    return event;
  }

  return Object.freeze({ emit });
}

export { createReporter };
