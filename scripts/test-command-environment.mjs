import assert from 'node:assert/strict';
import test from 'node:test';
import { deniedShellTemporaryFile } from '../agents/codex/runtime/app-server-transport.mjs';
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
