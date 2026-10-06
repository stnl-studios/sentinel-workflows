import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const CAPACITY_RETRY_DELAY_MS = 15_000;
const capacity = message => message === 'Selected model is at capacity. Please try a different model.';
export const modelAtCapacity = turn => turn?.completed === false && capacity(turn.error)
  && turn.processError == null && ['error', 'turn.failed'].includes(turn.errorEvent?.type)
  && capacity(turn.errorEvent.message ?? turn.errorEvent.error?.message);

// Hash the complete managed workspace (including Git) and candidate tree.
// Unsupported links/files or failed reads provide no retry authority.
export async function captureCapacityInputs(workspace, candidates) {
  const digest = createHash('sha256');
  async function visit(root, relative = '') {
    const file = path.join(root, relative), stat = await fs.lstat(file);
    digest.update(JSON.stringify([relative, stat.mode & 0o777]));
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      digest.update('directory');
      for (const name of (await fs.readdir(file)).sort()) await visit(root, path.join(relative, name));
    } else {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('non-regular capacity input');
      const bytes = await fs.readFile(file);
      digest.update(String(bytes.length)).update('\0').update(bytes);
    }
  }
  try {
    for (const root of [workspace, candidates]) { digest.update(root).update('\0'); await visit(root); }
    return { sha256: digest.digest('hex') };
  } catch (error) { return { rejected: true, diagnostic: `${error.code ?? error.name}: ${error.message}` }; }
}

// A matching fingerprint alone cannot prove absence of effects. Admit only a
// complete SDK trace with no tools, or one successful owned read-only preflight.
export function capacityTraceIsSafe(turn, events, operationId, managedPreflight) {
  if (!modelAtCapacity(turn) || turn.turnStarted !== true || typeof turn.threadId !== 'string') return false;
  const trace = events.filter(event => event.operationId === operationId);
  if (trace.filter(event => event.type === 'thread.started').length !== 1
    || trace.find(event => event.type === 'thread.started')?.thread_id !== turn.threadId
    || trace.filter(event => event.type === 'turn.started').length !== 1
    || trace.filter(event => event.type === 'turn.failed').length !== 1
    || trace.at(-1)?.type !== 'turn.failed') return false;
  const starts = [], finishes = [];
  for (const event of trace) {
    if (['error', 'turn.failed'].includes(event.type)) {
      if (!capacity(event.message ?? event.error?.message)) return false;
    } else if (event.type.startsWith('item.')) {
      if (['agent_message', 'reasoning'].includes(event.item?.type)) continue;
      if (event.item?.type !== 'command_execution' || !managedPreflight
        || event.item.command !== '/bin/zsh -lc \'node "$STNL_MANAGED_PREFLIGHT"\'') return false;
      if (event.type === 'item.started') starts.push(event.item);
      else if (event.type === 'item.completed') finishes.push(event.item);
      else return false;
    } else if (!['thread.started', 'turn.started'].includes(event.type)) return false;
  }
  return starts.length === finishes.length && finishes.length <= 1 && turn.toolCalls === finishes.length
    && finishes.every((item, index) => item.id === starts[index].id && item.exit_code === 0 && item.status === 'completed');
}

export function operationBudgetHistory(operations) {
  return operations.flatMap(entry => Array.from({ length: entry.dispatchAttempts ?? 1 }, () => entry));
}

// Exactly one retry, before terminalization. Each dispatch is separately settled
// and persisted by the manager. No fallback, hidden refund or terminal resume.
export async function runCapacityLimitedTurn({ runTurn, onAttempt, authorizeRetry, beforeRetry,
  persistAttempt, signal, attempts = [], onWait = () => {}, wait = () => delay(CAPACITY_RETRY_DELAY_MS, undefined, { signal }) }) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // The caller retains this record even if dispatch, settlement or persistence
    // throws before the helper can return. Missing usage stays explicitly unknown.
    const record = { attempt, usageObservation: { status: 'unavailable', source: 'main',
      reason: 'dispatch usage was not recorded' } };
    attempts.push(record);
    const turn = await runTurn(attempt);
    record.turn = turn;
    Object.assign(record, await onAttempt(turn, attempt, record));
    if (!modelAtCapacity(turn)) {
      if (attempt > 1) await persistAttempt(record);
      return { turn, attempts, stopReason: null };
    }
    // Preserve the provider failure even if eligibility inspection itself fails.
    await persistAttempt(record);
    const decision = attempt === 2 ? { allowed: false, reason: 'RETRY_LIMIT' }
      : await authorizeRetry(turn, attempt);
    record.capacityDecision = decision;
    await persistAttempt(record);
    if (!decision.allowed) return { turn, attempts, stopReason: decision.reason };
    try { onWait(); await wait(); }
    catch (error) {
      if (!signal.aborted) throw error;
      return { turn, attempts, stopReason: 'CANCELLED' };
    }
    // Waiting never authorizes a changed workspace, authority or exhausted budget.
    const fresh = signal.aborted ? { allowed: false, reason: 'CANCELLED' } : await authorizeRetry(turn, attempt);
    record.capacityDecision = fresh;
    await persistAttempt(record);
    if (!fresh.allowed) return { turn, attempts, stopReason: fresh.reason };
    try { await beforeRetry(); }
    catch (error) {
      if (error.code !== 'PAUSED_BUDGET_OR_QUOTA') throw error;
      record.capacityDecision = { allowed: false, reason: 'TURN_BUDGET' };
      await persistAttempt(record);
      return { turn, attempts, stopReason: 'TURN_BUDGET' };
    }
  }
}
