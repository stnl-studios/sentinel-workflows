import { digest } from './core.mjs';
import { nextOperation } from './workflow.mjs';
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;
const string = x => typeof x === 'string' && x.length > 0;
const slice = a => a?.current?.output?.normalHandoff?.slice;
const operation = a => { try { return a && nextOperation(a); } catch { return 'BLOCKED'; } };
const official = a => a?.lifecycle?.exitCode === 0 && a?.current?.exitCode === 0;
const passedDelivery = (a, selectedSlice, deliveryId) => string(deliveryId) && a?.current?.output?.deliveries?.some(d => d.slice === selectedSlice && d.deliveryId === deliveryId && d.formalStatus === 'PASS' && string(d.deliveryId) && HASH.test(d.evidenceSha256 ?? '')) === true;

/** Pure read-only recovery admission, never a replay executor. Authority must be
 * fresh output of the official read-only runtime, not an agent's assertion.
 * providerTurn = {threadId, id, status}. Store authorityBefore with each intent.
 * Fingerprints bind observations; their difference alone proves no completion.
 * No effect receipt collector is implemented yet, therefore all pending effects
 * remain BLOCKED, even if a file or caller asserts authenticated:true. */
export function decideRecovery({ checkpoint, providerTurn, authority, workspaceFingerprint, identityMatches, now = Date.now() } = {}) {
  const blocked = reason => ({ outcome: 'BLOCKED', reason, nextStage: null, dispatchAllowed: false, replayAllowed: false });
  if (identityMatches !== true) return blocked('IDENTITY_MISMATCH');
  if (!checkpoint || !Number.isFinite(now) || !Number.isFinite(checkpoint.deadline) || !HASH.test(workspaceFingerprint ?? '')) return blocked('OBSERVATION_OR_DEADLINE_MISSING');
  if (checkpoint.campaignDeadline !== undefined && !Number.isFinite(checkpoint.campaignDeadline)) return blocked('CAMPAIGN_DEADLINE_INVALID');
  const deadline = Math.min(checkpoint.deadline, checkpoint.campaignDeadline ?? checkpoint.deadline);
  const expired = now >= deadline;
  if (checkpoint.pendingEffect) return blocked('PENDING_EFFECT_REQUIRES_INDEPENDENT_COLLECTOR');
  const pending = checkpoint.pending;
  const next = operation(authority);
  if (!pending) return { outcome: next && next !== 'BLOCKED' ? 'NO_PENDING' : 'BLOCKED', reason: 'NO_PENDING_DISPATCH_TO_SETTLE', nextStage: next && next !== 'BLOCKED' ? next : null, dispatchAllowed: false, replayAllowed: false, deadline, expired };
  if (!Number.isSafeInteger(pending.index) || pending.index < 1 || !string(pending.stage) || !string(pending.threadId) || !string(pending.turnId) || !HASH.test(pending.before ?? '')) return blocked('PENDING_IDENTITY_OR_BEFORE_MISSING');
  if (checkpoint.settledAttempts?.some(a => a.index === pending.index || (a.threadId === pending.threadId && a.turnId === pending.turnId))) return blocked('ATTEMPT_ALREADY_SETTLED');
  if (providerTurn?.threadId !== pending.threadId || providerTurn?.id !== pending.turnId) return blocked('PROVIDER_TURN_IDENTITY_MISMATCH');
  if (providerTurn.status === 'inProgress') return { outcome: 'OBSERVE', reason: 'EXACT_TURN_STILL_ACTIVE', nextStage: null, dispatchAllowed: false, replayAllowed: false, deadline, expired };
  if (providerTurn.status !== 'completed') return blocked('PROVIDER_TURN_NOT_COMPLETED');
  const before = pending.authorityBefore;
  if (!before || !string(before.specPath) || before.specPath !== authority?.specPath) return blocked('SPEC_AUTHORITY_BINDING_MISSING');
  if (!official(authority) || !next || next === 'BLOCKED') return blocked('OFFICIAL_AUTHORITY_NOT_ADMISSIBLE');
  const prior = operation(before), selectedSlice = slice(before), currentSlice = slice(authority);
  let advanced = false;
  switch (pending.stage) {
    case 'INIT': advanced = prior === 'INIT' && next === 'PLAN'; break;
    case 'READINESS': advanced = prior === 'READINESS' && next === 'PLAN'; break;
    case 'REVIEW_PLAN': advanced = prior === 'PLAN' && next === 'EXECUTE_SLICE' && string(currentSlice); break;
    case 'EXECUTE_SLICE':
    case 'APPLY_FINDINGS': advanced = prior === pending.stage && next === 'VALIDATE_SLICE' && string(selectedSlice) && selectedSlice === currentSlice; break;
    case 'VALIDATE_SLICE':
      if (prior !== 'VALIDATE_SLICE' || !string(selectedSlice)) break;
      if (next === 'APPLY_FINDINGS') advanced = selectedSlice === currentSlice;
      else if (next === 'EXECUTE_SLICE') advanced = string(currentSlice) && selectedSlice !== currentSlice && passedDelivery(authority, selectedSlice, before.current?.output?.normalHandoff?.deliveryId);
      else if (next === 'CLOSE') advanced = passedDelivery(authority, selectedSlice, before.current?.output?.normalHandoff?.deliveryId);
      break;
    case 'CLOSE':
      advanced = prior === 'CLOSE' && next === 'CLOSED' && operation(checkpoint.preCloseComplete) === 'CLOSE' && official(checkpoint.preCloseComplete) && digest(checkpoint.preCloseComplete) === digest(before);
      break;
    default: return blocked('STAGE_REQUIRES_ADDITIONAL_AUTHENTICATED_PROOF');
  }
  if (!advanced) return blocked('OFFICIAL_STAGE_ADVANCE_NOT_PROVEN');
  const proof = {
    schemaVersion: 1, purpose: 'settle-completed-attempt-without-replay',
    attempt: pending.index, stage: pending.stage, threadId: pending.threadId, turnId: pending.turnId,
    specPath: before.specPath, beforeFingerprint: pending.before, afterFingerprint: workspaceFingerprint,
    beforeAuthorityDigest: digest(before), authorityDigest: digest(authority), providerTurnDigest: digest(providerTurn),
    nextStage: next, deadline, observedAt: now, expired,
  };
  return { outcome: 'SETTLE', reason: 'EXACT_COMPLETED_TURN_AND_OFFICIAL_ADVANCE', nextStage: next, dispatchAllowed: false, replayAllowed: false, newStageRequiresAdmission: !expired && next !== 'CLOSED', deadline, expired, proof, proofDigest: digest(proof) };
}
