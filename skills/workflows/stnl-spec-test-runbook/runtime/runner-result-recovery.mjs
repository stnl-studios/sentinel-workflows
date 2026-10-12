import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readOwnedFile, parseStrictJson, assertExecutionAttempt } from './execution-publication.mjs';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(`runner recovery: ${message}`); };
const read = async file => parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
export const recoverySection = (text, heading) => text.split(`## ${heading}\n\n`)[1]?.split('\n## ')[0].trim();
const headings = ['Implementation Test Evidence', 'Findings Test Evidence', 'Validation Attempts'];

// Called only after the canonical producer has verified the concluded receipt
// and caught its deterministic semantic rejection. No caller-authored verdict.
export async function persistRunnerRejection({ receipt, context, taskText, blocker, diagnostic }) {
  if (!receipt?.owner || !receipt.receiptFile) fail('rejection lacks an owned receipt');
  const native = receipt.transport === 'native';
  const root = path.dirname(receipt.receiptFile);
  const files = native ? ['owner.json', `round-${receipt.attempt}.origin.json`, `round-${receipt.attempt}.agent.json`,
    `round-${receipt.attempt}.tool-result.json`, `round-${receipt.attempt}.verification.json`].map(name => path.join(root, name))
    : [receipt.eventsPath, receipt.receiptFile.replace(/\.receipt\.json$/u, '.started.json'),
      receipt.receiptFile.replace(/\.receipt\.json$/u, '.verification.json'), path.join(root, 'stnl-runner-broker/active.json'),
      path.join(root, 'stnl-runner-broker', `${String(receipt.sequence).padStart(3, '0')}.latest.json`),
      ...Object.values(context.identity).filter(value => value.sha256).map(value => value.path)];
  const evidence = await Promise.all([...new Set([...files, receipt.receiptFile, receipt.semanticResponseFile])]
    .map(async file => ({ path: file, sha256: hash((await readOwnedFile(file)).bytes) })));
  const origin = native ? await read(receipt.originFile) : null;
  const record = { format: 'stnl-runner-rejection-v1', owner: receipt.owner, transport: native ? 'native' : 'managed',
    receiptFile: receipt.receiptFile, semanticResponseFile: receipt.semanticResponseFile, diagnostic, blocker,
    round: native ? receipt.attempt : receipt.automaticCheckRound ? Number(receipt.automaticCheckRound[0]) : 1,
    consumedInvocations: native ? (origin.owner.recovery?.consumedInvocations ?? 0) + receipt.attempt - (origin.owner.recovery?.round ?? 1) + 1
      : receipt.attempt,
    evidence, privateChecks: Object.fromEntries(headings.map(heading => [heading, recoverySection(taskText, heading)])) };
  const file = `${receipt.receiptFile}.rejection.json`;
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
  try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || !(await readOwnedFile(file)).bytes.equals(bytes)) throw error; }
  return { path: file, sha256: hash(bytes) };
}

export async function readBoundRunnerRejection(reference, owner) {
  const bytes = (await readOwnedFile(reference.path)).bytes;
  if (hash(bytes) !== reference.sha256) fail('rejection proof changed');
  const proof = parseStrictJson(bytes.toString('utf8'));
  if (proof.format !== 'stnl-runner-rejection-v1' || proof.receiptFile + '.rejection.json' !== reference.path) fail('invalid rejection proof');
  assertExecutionAttempt({ activeAttempt: owner }, proof.owner);
  for (const entry of proof.evidence) if (hash((await readOwnedFile(entry.path)).bytes) !== entry.sha256) fail('rejected evidence changed');
  return proof;
}

export async function readRunnerRecovery(owner) {
  if (!owner.recovery) return null;
  const recovery = owner.recovery;
  if (Object.keys(recovery).sort().join(',') !== 'consumedInvocations,predecessor,rejection,round,supervisor'
    || recovery.predecessor.recovery || recovery.predecessor.operation !== owner.operation
    || recovery.predecessor.slice !== owner.slice || recovery.predecessor.deliveryId !== owner.deliveryId
    || recovery.predecessor.preparationRevision !== owner.preparationRevision
    || recovery.predecessor.normativeSha256 !== owner.normativeSha256
    || recovery.predecessor.operationAttemptId === owner.operationAttemptId) fail('successor identity differs');
  const bytes = (await readOwnedFile(recovery.rejection.path)).bytes;
  if (hash(bytes) !== recovery.rejection.sha256) fail('rejection proof changed');
  const proof = parseStrictJson(bytes.toString('utf8'));
  for (const entry of [...proof.evidence, ...(recovery.supervisor ? [recovery.supervisor] : [])]) {
    if (hash((await readOwnedFile(entry.path)).bytes) !== entry.sha256) fail('rejected evidence changed');
  }
  assertExecutionAttempt({ activeAttempt: recovery.predecessor }, proof.owner);
  if (proof.owner.operationAttemptId !== recovery.predecessor.operationAttemptId
    || recovery.round !== proof.round || recovery.consumedInvocations !== proof.consumedInvocations) fail('successor counters differ');
  return proof;
}

export async function verifyPublishedRunnerRejection({ current, state, recovery }) {
  const active = current.activation.activeAttempt;
  if (!active || active.recovery || recovery?.rejectedOperationAttemptId !== active.operationAttemptId
    || recovery.expectedActivationId !== current.activation.activationId) fail('rejected owner/activation differs or recovery already consumed');
  const blocker = state.activeDelegationBlockers?.[0];
  if (state.state !== 'RUNNER_RESULT_BLOCKED' || blocker?.kind !== 'malformed-output'
    || blocker.operation !== active.operation || blocker.slice !== active.slice || !blocker.recoveryProof) fail('published rejection proof required');
  if (!same(recovery.rejection, blocker.recoveryProof)) fail('requested rejection differs from published blocker');
  const bytes = (await readOwnedFile(recovery.rejection.path)).bytes;
  if (hash(bytes) !== recovery.rejection.sha256) fail('rejection proof changed');
  const proof = parseStrictJson(bytes.toString('utf8'));
  if (proof.format !== 'stnl-runner-rejection-v1' || proof.receiptFile + '.rejection.json' !== recovery.rejection.path) fail('invalid rejection proof');
  assertExecutionAttempt(current.activation, proof.owner);
  if (!Number.isSafeInteger(proof.consumedInvocations) || proof.consumedInvocations < 1 || proof.consumedInvocations >= 3
    || !Number.isSafeInteger(proof.round) || proof.round < 1 || proof.round > 3) fail('runner invocation budget exhausted');
  for (const entry of proof.evidence) if (hash((await readOwnedFile(entry.path)).bytes) !== entry.sha256) fail('rejected evidence changed');
  const text = (await readOwnedFile(path.join(state.workspace.executionRoot, 'tasks', `${active.slice}.md`))).bytes.toString('utf8');
  if (recoverySection(text, 'Delegation Blocker') !== `${proof.blocker}\n- Recovery proof: ${recovery.rejection.path} ${recovery.rejection.sha256}`
    || headings.some(heading => recoverySection(text, heading) !== proof.privateChecks[heading])) fail('published blocker/private checks differ');
  const receipt = await read(proof.receiptFile);
  let supervisor = null;
  if (proof.transport === 'native') {
    const root = path.dirname(proof.receiptFile);
    if (active.runner?.receiptFile !== path.join(root, 'owner.json')
      || (await fs.readdir(root)).filter(name => /^round-[1-3]\.origin\.json$/u.test(name)).length !== receipt.attempt) fail('native dispatch has later or uncertain work');
  } else if (proof.transport === 'managed') {
    const root = path.dirname(proof.receiptFile), directory = path.join(root, 'stnl-runner-broker');
    if (active.runner?.receiptFile !== path.join(directory, 'active.json')) fail('managed dispatch differs');
    const file = path.join(directory, `${String(receipt.sequence).padStart(3, '0')}.supervisor.json`);
    const bytes = (await readOwnedFile(file)).bytes, closed = parseStrictJson(bytes.toString('utf8'));
    if (!closed.closedAt || closed.pending !== false || closed.cancelledPending !== false || closed.errors?.length !== 0
      || closed.sequence !== receipt.sequence || closed.operation !== active.operation || closed.slice !== active.slice) fail('managed runner conclusion uncertain');
    const latest = await read(path.join(directory, `${String(receipt.sequence).padStart(3, '0')}.latest.json`));
    if (latest.receipt?.receiptFile !== proof.receiptFile) fail('managed runner has later work');
    supervisor = { path: file, sha256: hash(bytes) };
  } else fail('unknown rejection transport');
  return { predecessor: active, rejection: recovery.rejection, round: proof.round, consumedInvocations: proof.consumedInvocations, supervisor };
}
