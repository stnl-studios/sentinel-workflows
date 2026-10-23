import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { renderLauncher, assertNativeLauncher } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
import { deniedShellTemporaryFile } from '../agents/codex/runtime/app-server-transport.mjs';
const repo = path.resolve(import.meta.dirname, '..');

test('normal launchers keep exact operation/path/slice without managed injection', async () => {
  const values = { SPEC_PATH: '/fixture/ordinary project/specs/case-a', REQUIREMENTS_SOURCE: '/fixture/ordinary project/requirements.md',
    SLICE: '1', READINESS_SCOPE: 'GLOBAL', READINESS_FOCUS: 'not-applicable', NEW_INFORMATION: 'Legitimate normal input.', REPLAN_REASON: 'Current authority.' };
  for (const name of ['spec-init','spec-readiness','spec-resume','spec-close','execution-plan','execution-plan-review','execution-replan','slice-execute-codex','slice-validate-codex','slice-apply-findings-codex']) {
    const template = await fs.readFile(path.join(repo,'templates/prompts',name+'.md'),'utf8');
    const prompt = renderLauncher(template, values);
    assert.ok(prompt.includes(values.SPEC_PATH));
    assert.doesNotMatch(prompt, /STNL_MANAGED|STNL_RUNNER_ADAPTER|managed slice runner/u);
    if (name.startsWith('slice-')) {
      const operation = { 'slice-execute-codex': 'EXECUTE_SLICE', 'slice-validate-codex': 'VALIDATE_SLICE', 'slice-apply-findings-codex': 'APPLY_FINDINGS' }[name];
      assertNativeLauncher(prompt, { operation, specPath: values.SPEC_PATH }, '1');
      assert.throws(() => assertNativeLauncher(prompt, { operation, specPath: '/foreign' }, '1'));
    }
    assert.throws(() => renderLauncher(template, { ...values, SPEC_PATH: '/injected\nOPERATION=OTHER' }));
  }
});

for (const [kind, syntax] of [['document', '<<EOF'], ['string', '<<<value']]) {
  test(`recorded native ${kind} denial cannot be hidden by final zero; quoted data stays data`, () => {
    const output = `zsh:1: can't create temp file for here ${kind}: operation not permitted\n`;
    for (const exitCode of [0,1]) assert.equal(deniedShellTemporaryFile({ type: 'commandExecution',
      command: 'cat '+syntax, aggregatedOutput: output, exitCode }), true);
    for (const command of ["printf '%s' '"+syntax+"'", 'node prepared-check.mjs']) {
      assert.equal(deniedShellTemporaryFile({ type: 'commandExecution', command, aggregatedOutput: output, exitCode: 0 }), false);
    }
  });
}
