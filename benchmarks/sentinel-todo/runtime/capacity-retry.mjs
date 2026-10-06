import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const CAPACITY_RETRY_DELAY_MS = 15_000;
const capacity = message => message === 'Selected model is at capacity. Please try a different model.';
export const modelAtCapacity = turn => turn?.completed === false && capacity(turn.error)
  && ['error', 'turn.failed'].includes(turn.errorEvent?.type)
  && capacity(turn.errorEvent.message ?? turn.errorEvent.error?.message);

// Preserve classification and identity without copying SDK stderr (which can
// contain credentials) into manager evidence or capacity sidecars.
export function transportDiagnosticEvidence(turn) {
  const processFailure = turn.processFailure?.kind === 'sdk_exit'
    && Number.isInteger(turn.processFailure.exitCode) && turn.processFailure.exitCode >= 1
    && turn.processFailure.exitCode <= 255 ? { kind: 'sdk_exit', exitCode: turn.processFailure.exitCode,
      stderrClass: ['empty', 'capacity_only'].includes(turn.processFailure.stderrClass) ? turn.processFailure.stderrClass : 'unproven' } : null;
  const processError = turn.processError == null ? null : processFailure
    ? `Codex Exec exited with code ${processFailure.exitCode}; stderr omitted`
    : 'SDK process failure; diagnostic omitted';
  const event = turn.errorEvent;
  const diagnostic = event?.message ?? event?.error?.message;
  const errorEvent = event == null ? null : { type: event.type,
    ...(typeof event.operationId === 'string' ? { operationId: event.operationId } : {}),
    ...(capacity(diagnostic) ? event.type === 'turn.failed' ? { error: { message: diagnostic } } : { message: diagnostic }
      : { diagnosticSha256: createHash('sha256').update(JSON.stringify(event)).digest('hex') }) };
  return { error: turn.processError != null && turn.error === turn.processError ? processError : turn.error,
    processError, processFailure, errorEvent,
    ...(turn.processError == null ? {} : { processErrorSha256: createHash('sha256').update(String(turn.processError)).digest('hex') }) };
}

export function capacityAttemptEvidence(record) {
  return { ...record, ...(record.turn ? { turn: { ...record.turn, ...transportDiagnosticEvidence(record.turn) } } : {}) };
}

// Only the invoked, frozen skill file is a retry-safe read. The command is an
// exact literal using /bin/cat, with no PATH lookup or arbitrary shell syntax.
export async function captureCapacitySkillRead({ snapshot, shellHome, workflowSkill }) {
  try {
    if (typeof snapshot !== 'string' || typeof shellHome !== 'string'
      || !/^stnl-[a-z0-9-]+$/u.test(workflowSkill)) return null;
    // The managed HOME is created empty. User startup programs would make even
    // this literal command ambiguous; never authorize them as a skill read.
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      try { await fs.lstat(path.join(shellHome, name)); return null; }
      catch (error) { if (error.code !== 'ENOENT') return null; }
    }
    const file = path.join(shellHome, '.agents/skills', workflowSkill, 'SKILL.md');
    const source = path.join(snapshot, 'skills/workflows', workflowSkill, 'SKILL.md');
    if (!/^\/[A-Za-z0-9_./-]+$/u.test(file) || await fs.realpath(file) !== file
      || await fs.realpath(source) !== source) return null;
    const metadata = await fs.lstat(file), original = await fs.lstat(source);
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o222)
      || !original.isFile() || original.nlink !== 1) return null;
    const parents = [];
    for (const directory of [path.dirname(file), path.dirname(path.dirname(file))]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || (stat.mode & 0o222)) return null;
      parents.push({ ino: stat.ino, dev: stat.dev, mode: stat.mode });
    }
    const bytes = await fs.readFile(file);
    if (!bytes.equals(await fs.readFile(source))) return null;
    return { path: file, command: `/bin/zsh -lc '/bin/cat "${file}"'`,
      sha256: createHash('sha256').update(bytes).digest('hex'), output: bytes.toString('utf8'),
      identity: { ino: metadata.ino, dev: metadata.dev, mode: metadata.mode, parents } };
  } catch { return null; }
}

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
// complete SDK trace with no tools, or owned preflight and one proven skill read.
export function capacityTraceDecision(turn, events, operationId, managedPreflight, skillRead = null) {
  const reject = reason => ({ allowed: false, reason });
  if (!modelAtCapacity(turn)) return reject('CAPACITY_SIGNAL_UNPROVEN');
  if (turn.processError != null && (turn.processFailure?.kind !== 'sdk_exit'
    || turn.processFailure.exitCode !== 1
    || !['empty', 'capacity_only'].includes(turn.processFailure.stderrClass)
    || !/^Error: Codex Exec exited with code 1: /u.test(turn.processError))
    || turn.processError == null && turn.processFailure != null) return reject('PROCESS_FAILURE_UNPROVEN');
  if (turn.turnStarted !== true || typeof turn.threadId !== 'string') return reject('EFFECTS_OR_AMBIGUITY');
  const trace = events.filter(event => event.operationId === operationId);
  if (trace[0]?.type !== 'thread.started' || trace[1]?.type !== 'turn.started'
    || trace.filter(event => event.type === 'thread.started').length !== 1
    || trace.find(event => event.type === 'thread.started')?.thread_id !== turn.threadId
    || trace.filter(event => event.type === 'turn.started').length !== 1
    || trace.filter(event => event.type === 'turn.failed').length !== 1
    || trace.at(-1)?.type !== 'turn.failed') return reject('EFFECTS_OR_AMBIGUITY');
  let pending = null, preflights = 0, skillReads = 0;
  for (const event of trace) {
    if (['error', 'turn.failed'].includes(event.type)) {
      if (!capacity(event.message ?? event.error?.message)) return reject('EFFECTS_OR_AMBIGUITY');
    } else if (event.type.startsWith('item.')) {
      if (['agent_message', 'reasoning'].includes(event.item?.type)) continue;
      const item = event.item;
      if (item?.type !== 'command_execution' || !managedPreflight) return reject('EFFECTS_OR_AMBIGUITY');
      const preflight = item.command === '/bin/zsh -lc \'node "$STNL_MANAGED_PREFLIGHT"\'';
      const read = skillRead !== null && item.command === skillRead.command;
      if (skillRead && item.command === `/bin/zsh -lc 'cat "${skillRead.path}"'`)
        return reject('SKILL_READ_COMMAND_UNPROVEN');
      if (!preflight && !read) return reject('EFFECTS_OR_AMBIGUITY');
      if (event.type === 'item.started') {
        if (pending !== null || preflight && preflights !== 0 || read && (skillReads !== 0 || preflights !== 1))
          return reject('EFFECTS_OR_AMBIGUITY');
        pending = item;
      } else if (event.type === 'item.completed') {
        if (pending?.id !== item.id || pending.command !== item.command || item.exit_code !== 0 || item.status !== 'completed'
          || read && item.aggregated_output !== skillRead.output) return reject('EFFECTS_OR_AMBIGUITY');
        pending = null;
        if (preflight) preflights += 1; else skillReads += 1;
      } else return reject('EFFECTS_OR_AMBIGUITY');
    } else if (!['thread.started', 'turn.started'].includes(event.type)) return reject('EFFECTS_OR_AMBIGUITY');
  }
  if (pending !== null || turn.toolCalls !== preflights + skillReads) return reject('EFFECTS_OR_AMBIGUITY');
  return { allowed: true, reason: 'NO_EFFECTS_PROVEN', skillRead: skillReads === 1 };
}

export function capacityTraceIsSafe(...args) {
  return capacityTraceDecision(...args).allowed;
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
