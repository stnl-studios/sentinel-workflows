import fs from 'node:fs';
import path from 'node:path';
import { AppServer } from './app-server.mjs';
import { confined, digest, treeHashes } from './core.mjs';
import { inspectAuthority } from './workflow.mjs';
import { decideRecovery } from './recovery.mjs';

// Same semantic inputs as the campaign. No import of its orchestration module.
export function recoveryFingerprint(workspace, authority) {
  const l = authority.lifecycle?.output, c = authority.current?.output;
  const semantics = { lifecycle: l?.lifecycle_status ?? null, execution: l?.execution_state ?? null, lifecycleExit: authority.lifecycle?.exitCode ?? null, currentExit: authority.current?.exitCode ?? null, state: c?.state ?? null, handoff: c?.normalHandoff ?? null };
  return digest({ semantics, src: treeHashes(confined(workspace, 'src')), package: fs.readFileSync(confined(workspace, 'package.json'), 'utf8') });
}
const blocked = reason => ({ outcome: 'BLOCKED', reason, nextStage: null, dispatchAllowed: false, replayAllowed: false });
/** Read-only inspection of an existing dispatch. Never start/resume a thread or
 * submit a turn; never write receipts/checkpoints or clear a pending marker.
 * Removing the deadline from the read-only inspection copy does NOT modify or
 * extend the saved execution deadline used by decideRecovery. */
export async function inspectCaseRecovery({ manifest, checkpoint, identityMatches = true, serverFactory = options => new AppServer(options), inspect = inspectAuthority, fingerprint = recoveryFingerprint } = {}) {
  const report = { schemaVersion: 1, kind: 'read-only-recovery-inspection', observedAt: new Date().toISOString(), providerTurn: null, authority: null, workspaceFingerprint: null, decision: null, cleanup: 'not-started' };
  if (identityMatches !== true) { report.decision = blocked('IDENTITY_MISMATCH'); return report; }
  if (!manifest?.workspace || !manifest?.profile || !checkpoint) { report.decision = blocked('MANIFEST_OR_CHECKPOINT_MISSING'); return report; }
  if (checkpoint.pendingEffect) { report.decision = blocked('PENDING_EFFECT_REQUIRES_INDEPENDENT_COLLECTOR'); return report; }
  const pending = checkpoint.pending;
  if (pending && (!pending.threadId || !pending.turnId)) { report.decision = blocked('PENDING_TURN_IDENTITY_MISSING'); return report; }
  let server;
  try {
    if (pending) {
      server = serverFactory({ cli: manifest.profile.cli, cwd: manifest.workspace, home: manifest.codexHome, tmpDir: manifest.tmpDir, onEvent: () => {} });
      await server.start();
      const response = await server.readThread(pending.threadId);
      if (response?.thread?.id !== pending.threadId) throw Error('PROVIDER_THREAD_IDENTITY_MISMATCH');
      const matches = response.thread.turns?.filter(t => t.id === pending.turnId) ?? [];
      if (matches.length !== 1) throw Error(matches.length ? 'PROVIDER_TURN_IDENTITY_DUPLICATED' : 'PROVIDER_TURN_NOT_FOUND');
      // Retain identities and status only, never messages/reasoning/auth payloads.
      report.providerTurn = { threadId: response.thread.id, id: matches[0].id, status: matches[0].status };
    }
    const readManifest = { ...manifest }; delete readManifest.deadline;
    report.authority = await inspect(readManifest);
    report.workspaceFingerprint = await fingerprint(manifest.workspace, report.authority);
    report.decision = decideRecovery({ checkpoint, providerTurn: report.providerTurn, authority: report.authority, workspaceFingerprint: report.workspaceFingerprint, identityMatches, now: Date.now() });
  } catch (error) {
    report.decision = blocked('RECOVERY_INSPECTION_FAILED');
    // Error messages are operational exceptions, not provider response bodies.
    report.error = String(error.message);
  } finally {
    if (server) {
      try { await server.stop(); report.cleanup = 'stop-completed-not-independently-verified'; }
      catch { report.cleanup = 'transport-stop-unconfirmed'; report.decision = blocked('RECOVERY_TRANSPORT_CLEANUP_UNCONFIRMED'); }
    }
  }
  return report;
}
