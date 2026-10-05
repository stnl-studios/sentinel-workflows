import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const section = (text, name) => text.match(new RegExp(`(?:^|\\n)## ${name}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'u'))?.[1]?.trim();
export const findingsEvidenceFingerprint = text => hash(section(text, 'Findings Test Evidence'));
function fail(message) { throw Object.assign(new Error(message), { code: 'MANAGED_FINDINGS_BINDING_INVALID' }); }

// The active validation attempt owns the cycle. Finding origins can be older.
// Raw runner judgments remain untouched; only these observed type confusions
// have an unambiguous mechanical interpretation under a singleton active set.
export function bindManagedFindingsCycle({ context, binding, selected, sealed, receipt, response, candidateText, liveText, fingerprint, prior }) {
  const attempt = selected?.attempts.at(-1);
  const activeFindings = selected?.findings.filter(finding => finding.state === 'active').map(finding => finding.id).sort();
  if (context.operation !== 'APPLY_FINDINGS' || attempt?.status !== 'NEEDS_FIX'
    || !/^attempt-[0-9]{2,}$/.test(attempt.id) || !activeFindings?.length
    || binding.operation !== context.operation || binding.slice !== context.slice || binding.authority !== context.authority
    || sealed.operation !== context.operation || sealed.slice !== context.slice || sealed.sequence !== binding.sequence
    || sealed.workspace !== context.workspace || receipt.sequence !== binding.sequence || receipt.slice !== context.slice
    || receipt.authority !== context.authority || binding.sourceTaskSha256 !== hash(liveText)
    || !same(sealed.managedPayload?.activeFindings, activeFindings)) fail('managed findings cycle identity or active set disagrees');
  if (response.automaticCheckRound !== sealed.managedPayload?.automaticCheckRound) fail('managed findings round differs from sealed request');
  for (const name of ['Validation Attempts', 'Validation Findings']) {
    if (section(candidateText, name) !== section(liveText, name)) fail('managed findings candidate changed validation authority/history');
  }
  const round = Number(response.automaticCheckRound?.slice(0, 1));
  if (round > 1) {
    const priorBinding = prior?.findingsCycleBinding;
    if (prior?.state !== 'PRIVATE_TESTS_FAIL' || prior.operation !== context.operation
      || prior.slice !== context.slice || prior.sequence !== binding.sequence || prior.authority !== context.authority
      || priorBinding?.canonicalCycle !== attempt.id || !same(priorBinding.activeFindings, activeFindings)
      || Number(priorBinding.automaticCheckRound?.slice(0, 1)) + 1 !== round
      || priorBinding.findingsEvidenceSha256 !== findingsEvidenceFingerprint(candidateText)) {
      fail('managed findings prior private history or round ownership changed');
    }
  }
  const reportedCycle = response.findingsCycle;
  const normalized = reportedCycle !== attempt.id;
  const observedConfusion = activeFindings.length === 1
    && [`${context.slice}; ${activeFindings[0]} ativo`, activeFindings[0]].includes(reportedCycle);
  if (normalized && !observedConfusion) fail('managed findings cycle is not the current authorized attempt or an observed type confusion');
  return { operation: context.operation, slice: context.slice, sequence: binding.sequence, authority: context.authority, fingerprint,
    requestId: sealed.requestId, receiptFile: receipt.receiptFile, candidateTaskArtifact: binding.candidateTaskArtifact,
    sourceTaskSha256: binding.sourceTaskSha256, candidateInputSha256: hash(candidateText), activeFindings,
    canonicalCycle: attempt.id, reportedCycle, normalized, automaticCheckRound: response.automaticCheckRound,
    responseSha256: receipt.semanticResponseSha256, method: normalized ? 'observed-type-confusion' : 'canonical-match' };
}
