import { createHash } from 'node:crypto';
const CASES = ['rename', 'query', 'import'];
export const REQUIRED_CHECKS = ['local-tests', 'interruption-recovery', 'no-progress', 'authority-byte-binding', 'profile-observation'];
const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
export const qualificationDigest = hash;
const HARNESS_HASHES=['engine','fixture','scenarioOracle','contextPolicy','adapterProtocol'];
function validHarness(h){return h&&HARNESS_HASHES.every(k=>HASH.test(h[k]??''))&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(h.cliVersion??'');}
export function harnessBinds(h,i){return Boolean(h&&i&&['engine','fixture','cliVersion','scenarioOracle'].every(k=>typeof i[k]==='string'&&i[k].length>0&&h[k]===i[k])&&['contextPolicy','adapterProtocol'].every(k=>typeof i[k]==='string'&&i[k].length>0&&h[k]===qualificationDigest(i[k])));}
export const REQUIRED_TARGET_CAPABILITIES=['initialize','model/list','thread/start','thread/read','thread/resume','turn/start','turn/interrupt'];
const ROLES=['coordinator','plan_approver','plan_review','execute_check','formal_validate'];
function modelRolesValid(roles){
 if(!Array.isArray(roles)||!roles.length||new Set(roles.map(r=>r?.role)).size!==roles.length)return false;
 const qualified=roles.some(r=>r?.caseId!==undefined||r?.logicalRole!==undefined);
 if(roles.some(r=>!r||!/^[a-z][a-z0-9_]*$/.test(r.role??'')||typeof r.model!=='string'||!r.model.trim()||typeof r.effort!=='string'||!r.effort.trim()))return false;
 if(!qualified)return ROLES.every(required=>roles.some(r=>r.role===required));
 if(roles.some(r=>!CASES.includes(r.caseId)||!/^[a-z][a-z0-9_]*$/.test(r.logicalRole??'')||r.role!==r.caseId+'__'+r.logicalRole))return false;
 return [...new Set(roles.map(r=>r.caseId))].every(caseId=>ROLES.every(required=>roles.some(r=>r.caseId===caseId&&r.logicalRole===required)));
}

export const campaignConcurrency=identity=>identity?.concurrency??1; // Old evidence has no parallel claim.
function validIdentity(identity) {
  return identity && [1,2,3].includes(campaignConcurrency(identity)) && ['engine', 'fixture', 'source', 'profile'].every(k => typeof identity[k] === 'string' && HASH.test(identity[k])) && typeof identity.cliVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(identity.cliVersion) && /^[a-f0-9]{40}$/.test(identity.sentinelRevision ?? '');
}
function validProof(proof) {
  return proof && typeof proof.ref === 'string' && proof.ref.length > 0 && !proof.ref.startsWith('/') && !proof.ref.includes('\\') && !proof.ref.split('/').some(p => p === '.' || p === '..' || p === '') && !/[\x00-\x1f]/.test(proof.ref) && HASH.test(proof.sha256 ?? '');
}
/** Structural binding only: neither a PASS boolean nor a hash authenticates execution. */
export function checkBindingReasons(check, harnessIdentity) {
 const reasons=[],id=check?.id??'unknown';
 if(!validHarness(harnessIdentity)||!validHarness(check?.harnessIdentity)||canonical(check.harnessIdentity)!==canonical(harnessIdentity))reasons.push('CHECK_HARNESS_BINDING:'+id);
 if(!Array.isArray(check?.dependencies)||!check.dependencies.length)reasons.push('CHECK_DEPENDENCIES_REQUIRED:'+id);
 const seen=new Set();
 for(const dependency of Array.isArray(check?.dependencies)?check.dependencies:[]){
  if(!validProof(dependency)||Object.keys(dependency).some(k=>!['ref','sha256'].includes(k)))reasons.push('CHECK_DEPENDENCY_INVALID:'+id);
  if(dependency?.ref===check?.proof?.ref)reasons.push('CHECK_DEPENDENCY_SELF_REFERENCE:'+id);
  if(seen.has(dependency?.ref))reasons.push('CHECK_DEPENDENCY_DUPLICATE:'+id);
  seen.add(dependency?.ref);
 }
 return reasons;
}
/** Pure qualification decision. Proof hashes are supplied observations, not file I/O
 * verification or cryptographic authentication. The collector must read/hash files.
 * campaigns contains selected immutable diagnostic campaign snapshots, whose rows
 * include harnessValid, closed, oracle, and proof {ref, sha256}. */
export function buildQualification({ identity, harnessIdentity, campaigns = [], checks = [] } = {}) {
  const reasons = [];
  if (!validIdentity(identity)) reasons.push('IDENTITY_INVALID');
  if (!validHarness(harnessIdentity)||!harnessBinds(harnessIdentity,identity)) reasons.push('HARNESS_IDENTITY_INVALID');
  if (!Array.isArray(campaigns) || !campaigns.length) reasons.push('DIAGNOSTIC_CAMPAIGNS_REQUIRED');
  if (!Array.isArray(checks)) reasons.push('CHECKS_INVALID');
  const rows = [], proofRefs = new Map(), campaignIds = new Set();
  const inspectProof = (proof, label) => {
    if (!validProof(proof)) { reasons.push(`PROOF_INVALID:${label}`); return; }
    const normalized = proof.sha256.replace(/^sha256:/, '');
    if (proofRefs.has(proof.ref) && proofRefs.get(proof.ref) !== normalized) reasons.push(`PROOF_HASH_CONFLICT:${proof.ref}`);
    proofRefs.set(proof.ref, normalized);
  };
  for (const c of Array.isArray(campaigns) ? campaigns : []) {
    if (!c || typeof c.id !== 'string' || !c.id || campaignIds.has(c.id)) { reasons.push('CAMPAIGN_ID_INVALID_OR_DUPLICATE'); continue; }
    campaignIds.add(c.id);
    if (c.mode !== 'diagnostic') reasons.push(`DIAGNOSTIC_ONLY:${c.id}`);
    if (canonical(c.identity) !== canonical(identity)) reasons.push(`CAMPAIGN_IDENTITY_MISMATCH:${c.id}`);
    if (c.scope !== 'live') reasons.push(`LIVE_CAMPAIGN_REQUIRED:${c.id}`);
    inspectProof(c.proof, c.id);
    if (!Array.isArray(c.results)) { reasons.push(`RESULTS_REQUIRED:${c.id}`); continue; }
    const cells = new Set();
    if(!Array.isArray(c.plannedCells)||!c.plannedCells.length)reasons.push(`DECLARED_CELLS_REQUIRED:${c.id}`);
    const declared=(Array.isArray(c.plannedCells)?c.plannedCells:[]).map(x=>`${x?.caseId}/${x?.repetition}`);
    if(new Set(declared).size!==declared.length)reasons.push(`DECLARED_CELLS_DUPLICATED:${c.id}`);
    for (const r of c.results) {
      const cell = `${r?.caseId}/${r?.repetition}`;
      if (!r || !CASES.includes(r.caseId) || !Number.isSafeInteger(r.repetition) || r.repetition < 1 || cells.has(cell)) { reasons.push(`RESULT_ID_INVALID_OR_DUPLICATE:${c.id}/${cell}`); continue; }
      cells.add(cell);
      if (r.measurement !== 'diagnostic' || r.harnessValid !== true) reasons.push(`INVALID_DIAGNOSTIC_MEASUREMENT:${c.id}/${cell}`);
      if (!['PASS', 'FAIL', 'BLOCKED', 'TIMEOUT', 'INTERRUPTED'].includes(r.status)) reasons.push(`TERMINAL_OUTCOME_REQUIRED:${c.id}/${cell}`);
      inspectProof(r.proof, `${c.id}/${cell}`);
      rows.push({ ...r, campaignId: c.id });
    }
    if(canonical([...cells].sort())!==canonical(declared.sort()))reasons.push(`DECLARED_RESULTS_INCOMPLETE:${c.id}`);
  }
  for (const id of CASES) {
    const selected = rows.filter(r => r.caseId === id);
    if (new Set(selected.map(r => r.repetition)).size < 2) reasons.push(`TWO_REPETITIONS_REQUIRED:${id}`);
    if (!selected.some(r => r.status === 'PASS' && r.closed === true && r.oracle === 'PASS' && r.harnessValid === true)) reasons.push(`CLOSE_ORACLE_PATH_REQUIRED:${id}`);
    const uniqueEvidence = new Set(selected.map(r => r.proof?.ref));
    if (uniqueEvidence.size !== selected.length) reasons.push(`REUSED_RESULT_EVIDENCE:${id}`);
  }
  const ids = new Set();
  for (const c of Array.isArray(checks) ? checks : []) {
    if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id)) { reasons.push('CHECK_ID_INVALID_OR_DUPLICATE'); continue; }
    ids.add(c.id);
    if (c.pass !== true) reasons.push(`CHECK_NOT_PASS:${c.id}`);
    if (!['simulated', 'local', 'live'].includes(c.scope)) reasons.push(`CHECK_SCOPE_REQUIRED:${c.id}`);
    if (['profile-observation', 'authority-byte-binding'].includes(c.id) && c.scope !== 'live') reasons.push(`LIVE_CHECK_REQUIRED:${c.id}`);
    inspectProof(c.proof, `check/${c.id}`);
    reasons.push(...checkBindingReasons(c,harnessIdentity));
    for(const dependency of Array.isArray(c.dependencies)?c.dependencies:[])inspectProof(dependency,`check/${c.id}/dependency`);
  }
  for (const id of REQUIRED_CHECKS) if (!ids.has(id)) reasons.push(`CHECK_REQUIRED:${id}`);
  const body = { schemaVersion: 2, purpose: 'future-official-admission-only', identity: identity ?? null, referenceIdentity:identity??null,harnessIdentity:harnessIdentity??null, campaigns, checks, status: reasons.length ? 'BLOCKED' : 'QUALIFIED', reasons: [...new Set(reasons)], limitations: ['Supplied proof hashes require external file verification; this pure decision performs no I/O.', 'Diagnostics retain their original classification; no retroactive promotion.', 'Qualification proves selected scope, not arbitrary exactly-once effects or statistical ranking.'] };
  const result = clone(body); result.proofDigest = hash(result); return result;
}

/** Pure target admission. A supplied proof is a claim with bindings, NOT verified file content. */
export function admitOfficial({ qualification, identity, harnessIdentity, targetProof } = {}) {
 const reasons=[];
 if(!qualification||qualification.schemaVersion!==2||qualification.purpose!=='future-official-admission-only')return{allowed:false,reasons:['QUALIFICATION_REQUIRED']};
 const {proofDigest,...body}=qualification;
 if(!HASH.test(proofDigest??'')||hash(body)!==proofDigest)reasons.push('QUALIFICATION_INTEGRITY_MISMATCH');
 const rebuilt=buildQualification({identity:qualification.identity,harnessIdentity:qualification.harnessIdentity,campaigns:qualification.campaigns,checks:qualification.checks});
 if(rebuilt.status!=='QUALIFIED'||qualification.status!=='QUALIFIED')reasons.push('QUALIFICATION_NOT_READY',...rebuilt.reasons);
 if(!validIdentity(identity))reasons.push('IDENTITY_INVALID');
 if(campaignConcurrency(identity)!==campaignConcurrency(qualification.identity))reasons.push('CONCURRENCY_REQUALIFICATION_REQUIRED');
 const sameTarget=canonical(qualification.identity)===canonical(identity);
 const targetHarness=harnessIdentity??(sameTarget?qualification.harnessIdentity:null);
 if(!validHarness(targetHarness)||!harnessBinds(targetHarness,identity))reasons.push('TARGET_HARNESS_IDENTITY_INVALID');
 if(canonical(targetHarness)!==canonical(qualification.harnessIdentity))reasons.push('HARNESS_REQUALIFICATION_REQUIRED');
 if(identity?.cliVersion!==qualification.identity?.cliVersion)reasons.push('CLI_TRANSPORT_REQUALIFICATION_REQUIRED');
 if(!sameTarget||targetProof){
  if(!targetProof||targetProof.schemaVersion!==1)reasons.push('TARGET_PROOF_REQUIRED');
  else{
   if(!validIdentity(identity)||!validHarness(targetHarness)||targetProof.targetIdentityDigest!==hash(identity)||targetProof.harnessIdentityDigest!==hash(targetHarness))reasons.push('TARGET_PROOF_BINDING_MISMATCH');
   const checks=targetProof.checks??{},refs=new Map();
   for(const name of ['gitSnapshot','profile','modelSupport','securityContext','protocolCompatibility']){const check=checks[name];if(!check||!validProof(check.proof)){reasons.push(`TARGET_PROOF_INVALID:${name}`);continue}const normalized=check.proof.sha256.replace(/^sha256:/,'');if(refs.has(check.proof.ref))reasons.push(`TARGET_PROOF_REF_REUSED:${check.proof.ref}`);refs.set(check.proof.ref,normalized);}
   const git=checks.gitSnapshot;if(git?.status!=='VERIFIED'||git.revision!==identity?.sentinelRevision||git.treeDigest!==identity?.source||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(git.gitTree??''))reasons.push('TARGET_GIT_SNAPSHOT_UNPROVEN');
   if(checks.profile?.status!=='VERIFIED'||checks.profile.profileDigest!==identity?.profile)reasons.push('TARGET_PROFILE_UNPROVEN');
   const models=checks.modelSupport,roles=models?.roles;
   if(models?.status!=='SUPPORTED'||models.profileDigest!==identity?.profile||!modelRolesValid(roles))reasons.push('TARGET_MODELS_UNPROVEN');
   const security=checks.securityContext;if(security?.status!=='MATCH'||security.contextPolicyDigest!==targetHarness?.contextPolicy||security.profileDigest!==identity?.profile)reasons.push('TARGET_SECURITY_UNPROVEN');
   const protocol=checks.protocolCompatibility;
   if(protocol?.status!=='SUPPORTED'||protocol.adapterProtocolDigest!==targetHarness?.adapterProtocol||protocol.cliVersion!==identity?.cliVersion||protocol.sourceDigest!==identity?.source||!HASH.test(protocol.sentinelRuntimeContractDigest??'')||!Array.isArray(protocol.requiredCapabilities)||REQUIRED_TARGET_CAPABILITIES.some(x=>!protocol.requiredCapabilities.includes(x)))reasons.push('TARGET_PROTOCOL_UNPROVEN');
  }
 }
 return{allowed:reasons.length===0,reasons:[...new Set(reasons)],referenceQualificationDigest:qualification.proofDigest,referenceIdentity:clone(qualification.identity??null),targetIdentity:identity?clone(identity):null,harnessIdentity:targetHarness?clone(targetHarness):null,targetProofDigest:targetProof?hash(targetProof):null,targetOutcomeRequired:false,evidenceVerification:'supplied-bindings-only; external collector must read and verify proof files',classificationPolicy:'Admitted target task failures/timeouts remain official observations when harness-valid. Invalid configuration/protocol remains recorded diagnostic; never omit rejected attempts.'};
}
