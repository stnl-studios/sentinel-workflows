import path from 'node:path';

import { ValidationError, validateWorkspace } from './lifecycle.mjs';
import { workspaceAuthoritySnapshotSha256 } from './readiness.mjs';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FINDING_ID = /^F-[0-9]{3,}$/u;
const ACTIONS = new Set(['REFINE_FROM_EVIDENCE', 'DECISION_REQUIRED']);

function reject(message) { throw new ValidationError(message); }
function exactKeys(value, names, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())) {
    reject(`${label} has missing or unknown fields`);
  }
}

export function readinessSnapshot(source) {
  const workspace = validateWorkspace(source);
  if (workspace.closed) reject('READINESS requires an active SPEC');
  return {
    workspacePath: workspace.root,
    snapshotSha256: `sha256:${workspaceAuthoritySnapshotSha256(workspace)}`,
    status: workspace.status,
  };
}

export function validateReadinessResult(source, value, { scope = 'GLOBAL' } = {}) {
  const snapshot = readinessSnapshot(source);
  exactKeys(value, ['version', 'mode', 'scope', 'verdict', 'workspacePath', 'snapshotSha256', 'findings'], 'READINESS result');
  if (value.version !== 1 || value.mode !== 'READINESS' || value.scope !== scope
    || !new Set(['GLOBAL', 'LOCAL']).has(value.scope)
    || !new Set(['READY', 'FINDINGS', 'LOCAL_CLEAR']).has(value.verdict)
    || typeof value.workspacePath !== 'string' || !path.isAbsolute(value.workspacePath)
    || value.workspacePath !== snapshot.workspacePath || !DIGEST.test(value.snapshotSha256)
    || value.snapshotSha256 !== snapshot.snapshotSha256 || !Array.isArray(value.findings)) {
    reject('READINESS result identity, scope, verdict, or snapshot is invalid');
  }
  if (value.verdict === 'READY' && value.findings.length !== 0) reject('READY result cannot contain findings');
  if (value.verdict === 'LOCAL_CLEAR' && value.findings.length !== 0) reject('LOCAL_CLEAR result cannot contain findings');
  if (value.verdict === 'FINDINGS' && value.findings.length === 0) reject('FINDINGS result requires findings');
  if (value.scope === 'LOCAL' ? value.verdict === 'READY' : value.verdict === 'LOCAL_CLEAR') {
    reject('READINESS scope and verdict are incompatible');
  }
  const ids = new Set();
  for (const finding of value.findings) {
    exactKeys(finding, ['id', 'path', 'evidence', 'action', 'question'], 'READINESS finding');
    if (typeof finding.id !== 'string' || !FINDING_ID.test(finding.id) || ids.has(finding.id)
      || typeof finding.path !== 'string' || finding.path.trim() === ''
      || path.isAbsolute(finding.path) || finding.path.includes('\\')
      || path.posix.normalize(finding.path) !== finding.path || finding.path.startsWith('../')
      || typeof finding.evidence !== 'string' || finding.evidence.trim() === ''
      || !ACTIONS.has(finding.action)
      || (finding.action === 'DECISION_REQUIRED' && (typeof finding.question !== 'string' || finding.question.trim() === ''))
      || (finding.action === 'REFINE_FROM_EVIDENCE' && finding.question !== null)) {
      reject('READINESS finding is malformed');
    }
    ids.add(finding.id);
  }
  return { ...value, status: snapshot.status };
}
