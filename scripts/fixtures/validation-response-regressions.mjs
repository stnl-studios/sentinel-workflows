// Sanitized, minimal reproductions of operations 007/008 from
// run-20261003152349-c80b7de0. No private paths, full transcripts or outputs.
export function validationResponse(status = 'BLOCKED') {
  return { status, head: 'a'.repeat(40),
    commands: [{ command: 'STNL_VERIFICATION_COMMAND=1 node --test test/cli.test.mjs', exit: 0 }],
    evidence: 'AC-006 and AC-007 need direct evidence for absent storage.',
    findingReferences: 'none', findingDispositions: 'none',
    blockers: status === 'BLOCKED' ? 'Missing absent-storage evidence.' : 'none',
    unexpectedWorkspaceEffects: 'none', persistenceSummary: 'No workspace writes.' };
}

export const emptyFindingArrays = JSON.stringify({ ...validationResponse(),
  findingReferences: [], findingDispositions: [] });

// Same defects as the real ad hoc scripts: malformed JSON fixture caused the
// child to return 1; a usage regex rejected its required trailing newline.
export const newlineCheck = String.raw`import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const bytes = JSON.stringify({ todos: [] }) + '\\n';
const child = spawnSync(process.execPath, ['-e', 'JSON.parse(process.argv[1])', bytes]);
assert.equal(child.status, 0);`;

export const usageCheck = String.raw`import assert from 'node:assert/strict';
assert.match('usage: cli list\n', /^usage:.*$/);`;

export const correctedCheck = String.raw`import assert from 'node:assert/strict';
const newline = String.fromCharCode(10);
assert.deepEqual(JSON.parse(JSON.stringify({ todos: [] }) + newline), { todos: [] });
const usage = 'usage: cli list' + newline;
assert.ok(usage.startsWith('usage:') && usage.endsWith(newline));`;

export const failedCheckHistory = [
  { command: 'STNL_VERIFICATION_COMMAND=1 node --test test/cli.test.mjs', exit: 0 },
  { command: 'STNL_VERIFICATION_COMMAND=1 node /tmp/newline-check.mjs', exit: 1 },
  { command: 'STNL_VERIFICATION_COMMAND=1 node /tmp/usage-check.mjs', exit: 1 },
  { command: 'STNL_VERIFICATION_COMMAND=1 node /tmp/corrected-check.mjs', exit: 0 },
];
