import assert from 'node:assert/strict';
import test from 'node:test';

import { createReporter } from '../benchmarks/sentinel-todo/runtime/benchmark-ui.mjs';

function stream(isTTY = false) {
  return { isTTY, value: '', write(value) { this.value += value; } };
}

test('UI01 — non-TTY is append-only and puts case, operation, counts, state, and path on one line', () => {
  const out = stream(false);
  const err = stream(false);
  const reporter = createReporter({ stdout: out, stderr: err, isTTY: false });
  reporter.emit({ kind: 'start', caseId: 'A', operation: 'SPEC_INIT', slice: null, mainTurns: 1, runnerTurns: 0, globalTurns: 11, globalSaldo: 89, artifacts: '/tmp/run/case-a' });
  reporter.emit({ kind: 'progress', caseId: 'A', operation: 'PLAN', elapsedMs: 2400, model: 'GPT-5.6-Terra', effort: 'high' });
  assert.match(out.value, /^\[A\].*SPEC_INIT.*main 1 \/ runner 0.*global 11 \/ saldo 89.*\/tmp\/run\/case-a.*\n/m);
  assert.match(out.value, /\[A\].*PLAN.*2s.*GPT-5\.6-Terra\/high/u);
  assert.doesNotMatch(out.value, /ETA|percent|tests=/iu);
  assert.equal(err.value, '');
});

test('UI02 — TTY renders a compact panel, with ANSI disabled by NO_COLOR', () => {
  const out = stream(true);
  const reporter = createReporter({ stdout: out, stderr: stream(true), isTTY: true, width: 120, noColor: false });
  reporter.emit({ kind: 'result', caseId: 'B', operation: 'VALIDATE_SLICE', slice: 'slice-02', result: 'PASS', officialState: 'COMPLETE' });
  assert.match(out.value, /\u001b\[1m/u);
  assert.match(out.value, /\[B\].*VALIDATE_SLICE.*slice-02.*state COMPLETE/u);

  const plain = stream(true);
  createReporter({ stdout: plain, stderr: stream(true), isTTY: true, width: 120, noColor: true })
    .emit({ kind: 'result', caseId: 'C', operation: 'SPEC_CLOSE', status: 'PASS' });
  assert.doesNotMatch(plain.value, /\u001b\[/u);
});

test('UI03 — narrow TTY falls back to ASCII separators', () => {
  const out = stream(true);
  createReporter({ stdout: out, stderr: stream(true), isTTY: true, width: 60, noColor: false })
    .emit({ kind: 'progress', caseId: 'A', operation: 'EXECUTE_SLICE', slice: 'slice-01', model: 'GPT-5.6-Luna', effort: 'medium' });
  assert.match(out.value, /\|/u);
  assert.doesNotMatch(out.value, /\u001b\[/u);
});

test('UI04 — JSON emits parseable stdout lines and routes diagnostics to stderr', () => {
  const out = stream(false);
  const err = stream(false);
  const reporter = createReporter({ format: 'json', stdout: out, stderr: err, isTTY: false });
  reporter.emit({ kind: 'status', runId: 'run-1', status: 'ACTIVE', cases: { A: 'ACTIVE', B: 'NOT_RUN', C: 'NOT_RUN' } });
  reporter.emit({ kind: 'diagnostic', caseId: 'A', error: 'runner unavailable' });
  const lines = out.value.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].runId, 'run-1');
  assert.equal(err.value.trim(), JSON.stringify({ kind: 'diagnostic', caseId: 'A', error: 'runner unavailable' }));
});

test('UI05 — status and inspect events surface summaries, timeline, official state, recovery, and artifacts', () => {
  const out = stream(false);
  createReporter({ stdout: out, stderr: stream(false), isTTY: false }).emit({
    kind: 'inspect', caseId: 'C', status: 'BLOCKED', timeline: ['SPEC_READINESS', 'SPEC_RESUME'],
    officialState: 'SPEC_BLOCKED', recovery: { operation: 'SPEC_RESUME', slice: null }, rawPath: '/tmp/run/case-c/raw.json',
  });
  assert.match(out.value, /\[C\].*BLOCKED.*state SPEC_BLOCKED.*recovery SPEC_RESUME.*raw\.json.*SPEC_READINESS > SPEC_RESUME/u);
});

test('UI06 — global status summarizes recent runs and budget', () => {
  const out = stream(false);
  createReporter({ stdout: out, stderr: stream(false), isTTY: false }).emit({
    kind: 'status', globalTurns: 106, globalSaldo: 74,
    active: { runId: 'run-active' },
    runs: [{ runId: 'run-new', summary: { status: 'PASS' } }, { runId: 'run-old', summary: { status: 'BLOCKED' } }],
  });
  assert.match(out.value, /global 106 \/ saldo 74.*2 runs.*run-new:PASS.*run-old:BLOCKED.*active run-active/u);
});
