// External consumers of current public product facts. No product mutation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = message => { throw Object.assign(new Error(message), { code: 'NATIVE_EVIDENCE_UNPROVEN' }); };
const equal = isDeepStrictEqual;

export function validateNativeLedger(ledger, state, runId, { settled = false } = {}) {
  if (ledger?.version !== 1 || !Number.isSafeInteger(ledger.total) || ledger.total < 0
    || !Number.isSafeInteger(ledger.limit) || ledger.limit < 1 || ledger.total > ledger.limit
    || !Array.isArray(ledger.turns) || !Array.isArray(ledger.reservations)
    || new Set(ledger.turns.map(turn => turn.number)).size !== ledger.turns.length
    || new Set(ledger.reservations.map(item => item.id)).size !== ledger.reservations.length
    || ledger.turns.some(turn => !Number.isSafeInteger(turn.number) || turn.number < 1
      || !['main', 'runner'].includes(turn.role)
      || !['completed', 'failed', 'dispatched', 'uncertain', 'not_dispatched'].includes(turn.state))
    || ledger.total !== ledger.turns.filter(turn => turn.state !== 'not_dispatched').length
    || settled && (ledger.reservations.length !== 0 || ledger.turns.some(turn => !['completed', 'not_dispatched'].includes(turn.state)))) fail('native ledger is absent, inconsistent or unsettled');
  const counted = ledger.turns.filter(turn => turn.caseId === state.caseId && turn.state !== 'not_dispatched');
  if (counted.some(turn => turn.runId !== runId)
    || counted.filter(turn => turn.role === 'main').length !== state.mainTurns
    || counted.filter(turn => turn.role === 'runner').length !== state.runnerTurns) fail('native case counters differ from admitted turns');
  return ledger;
}

export function contextPolicy(configuration) {
  const policy = configuration.contextPolicy ?? { regime: 'fresh', authorContinuityOperations: [] };
  if (!['fresh', 'author-continuity'].includes(policy.regime)
    || !Array.isArray(policy.authorContinuityOperations)
    || new Set(policy.authorContinuityOperations).size !== policy.authorContinuityOperations.length
    || policy.authorContinuityOperations.some(operation => !['SPEC_RESUME', 'SPEC_PROMOTE', 'PLAN', 'REPLAN', 'EXECUTE_SLICE', 'APPLY_FINDINGS', 'SPEC_CLOSE'].includes(operation))
    || (policy.regime === 'fresh' && policy.authorContinuityOperations.length !== 0)
    || (policy.regime === 'author-continuity' && policy.authorContinuityOperations.length === 0)) fail('context regime/author segment must be explicit');
  return structuredClone(policy);
}

export async function preparationHandoff(product, specPath, commandResults) {
  const candidates = commandResults.filter(item => item?.status === 'AWAITING_REVIEW'
    && item.publication === 'not-started' && typeof item.candidateExecutionRoot === 'string');
  if (candidates.length !== 1) fail('PLAN has no single official AWAITING_REVIEW return');
  const request = candidates[0];
  const owned = await product.assertPreparationCandidate(request.candidateExecutionRoot, specPath);
  if (owned.root !== request.candidateExecutionRoot) fail('PLAN root differs from its public ownership proof');
  return structuredClone(request);
}

export function assertNativeCaptures(image, captures, { restoreCaptureSources } = {}) {
  // image must come from the product's public, fully validating capture reader.
  if (!image?.files || !image.inspection || captures.length === 0) fail('native captures or verified official image absent');
  const activation = JSON.parse(Buffer.from(image.activationBytes));
  const operationAttemptId = activation.lastAttempt?.operationAttemptId;
  if (!operationAttemptId) fail('current invocation publication is absent');
  const official = [];
  for (const [name, bytes] of image.files) if (name.startsWith('evidence/') && name.endsWith('.json')) {
    const bundle = JSON.parse(Buffer.from(bytes));
    const objects = new Map(bundle.objects?.map(object => [object.id, Buffer.from(object.bytesBase64, 'base64')]) ?? []);
    const records = [...(bundle.implementation ?? []), bundle.validation,
      ...(bundle.findingsChecks ?? []), ...(bundle.support ?? [])].filter(Boolean);
    const current = records.filter(record => record.origin?.operationAttemptId === operationAttemptId);
    const allowed = new Set(current);
    for (const record of current) if (record.origin?.operation === 'VALIDATE_SLICE') {
      if (typeof restoreCaptureSources !== 'function') fail('public product source verifier absent');
      const source = restoreCaptureSources('current-validation', record, objects);
      const origin = JSON.parse(Buffer.from(source.origin)), binding = origin.admission?.binding?.normalization;
      if (!binding) continue;
      if (binding.operation !== 'VALIDATE_SLICE' || binding.status !== 'settled' || binding.used !== 1
        || binding.round !== 1 || binding.consumedInvocations !== 1
        || binding.sourceOperationAttemptId === operationAttemptId) fail('formal normalization is not one bounded predecessor');
      const predecessors = records.filter(item => item.kind === 'rejection'
        && item.origin?.operation === 'VALIDATE_SLICE'
        && item.origin.operationAttemptId === binding.sourceOperationAttemptId);
      if (predecessors.length !== 1) fail('authenticated formal predecessor absent/ambiguous');
      allowed.add(predecessors[0]);
    }
    for (const record of allowed) {
      if (record.sources?.transport !== 'native') continue;
      const object = objects.get(record.sources.concludedToolResult);
      if (!object) fail('current operation has no retained concluded tool result');
      const value = JSON.parse(object);
      if (value?.agentId && value.status === 'completed' && typeof value.finalResponse === 'string') official.push({ value, record });
    }
  }
  if (new Set(captures.map(item => item.binding.agentPath)).size !== captures.length
    || official.length !== captures.length) fail('native capture count/identity differs from retained invocation lineage');
  for (const capture of captures) {
    if (official.filter(({ value }) => value.agentId === capture.binding.agentPath
      && value.finalResponse === capture.toolResult.finalResponse).length !== 1) fail('official retained capture differs from the public child');
  }
  return { matched: captures.length, responseHashes: captures.map(item => item.finalResponseSha256),
    rejectedResponses: official.filter(item => item.record.kind === 'rejection').map(item => ({
      operationAttemptId: item.record.origin.operationAttemptId,
      finalResponseSha256: sha(Buffer.from(item.value.finalResponse, 'utf8')) })) };
}

export async function retainBeforeClose({ product, specPath, workspace, artifacts }) {
  const image = await product.captureCurrentExecution(specPath);
  if (image.inspection.state !== 'COMPLETE' || !image.activationBytes) fail('CLOSE requires current integral COMPLETE');
  const disposition = await product.deriveCloseExecutionDisposition(specPath);
  if (disposition.kind !== 'discard-current-complete' || disposition.activationId !== image.inspection.activationId
    || disposition.requirementsAuthority !== image.requirementsAuthority) fail('CLOSE disposition differs from current image');
  const source = { inspection: image.inspection, context: image.context, requirementsAuthority: image.requirementsAuthority,
    activationBase64: Buffer.from(image.activationBytes).toString('base64'),
    files: [...image.files].map(([name, bytes]) => ({ name, bytesBase64: Buffer.from(bytes).toString('base64'), sha256: sha(Buffer.from(bytes)) })),
    manifests: [...image.observedByDelivery].map(([deliveryId, observed]) => ({ deliveryId, manifest: observed.manifest })) };
  return { format: 'sentinel-native-terminal-v1', specPath, workspace, disposition, artifacts, source,
    sourceSha256: sha(Buffer.from(JSON.stringify(source))) };
}

export async function assertRetainedProducts(pre) {
  for (const { manifest } of pre.source.manifests) for (const entry of manifest.entries) {
    const file = path.resolve(pre.workspace, entry.path);
    if (!file.startsWith(pre.workspace + path.sep) || path.relative(pre.workspace, file).split(path.sep).includes('..')) fail('retained product path escapes workspace');
    const metadata = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (entry.kind === 'absent') { if (metadata !== null) fail('absent product changed across CLOSE'); continue; }
    if (!metadata || metadata.isSymbolicLink() || await fs.realpath(file) !== file) fail('retained product identity changed');
    if (entry.kind === 'file') {
      if (!metadata.isFile() || sha(await fs.readFile(file)) !== entry.sha256 || (metadata.mode & 0o777) !== entry.mode) fail('retained product bytes/mode changed');
    } else if (entry.kind === 'directory') {
      const names = (await fs.readdir(file)).filter(name => name !== '.DS_Store' && name !== '__MACOSX' && !name.startsWith('._')).sort();
      if (!metadata.isDirectory() || !equal(names, [...entry.children].sort())) fail('retained product directory changed');
    } else fail('unknown retained product kind');
  }
}

export async function finishCloseEvidence({ product, pre, commandResults }) {
  if (sha(Buffer.from(JSON.stringify(pre.source))) !== pre.sourceSha256) fail('retained source was changed');
  const matches = commandResults.filter(item => item?.target === pre.specPath && item.publication === 'confirmed');
  if (matches.length !== 1) fail('CLOSE official publication result absent/ambiguous');
  const receipt = matches[0];
  if (receipt.cleanup !== 'complete' || !/^[a-f0-9]{32}$/u.test(receipt.transactionId ?? '')
    || receipt.requirementsAuthority !== pre.disposition.requirementsAuthority
    || !equal(receipt.sourceExecutionDisposition, pre.disposition)) fail('CLOSE publication/cleanup/source binding incomplete');
  const document = product.validateWorkspace(pre.specPath), after = await product.inspectExecutionState(pre.specPath);
  if (!document.closed || document.status !== 'closed' || after.state !== 'SPEC_CLOSED'
    || await fs.lstat(path.join(pre.specPath, 'execution')).catch(() => null) !== null) fail('closed readback differs');
  const ascii = JSON.stringify(product.workspaceSnapshot(pre.specPath)).replace(/[\u0080-\uffff]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (sha(Buffer.from(ascii)) !== receipt.closedSnapshotSha256) fail('CLOSE returned digest differs from public document snapshot');
  await assertRetainedProducts(pre);
  return { ...pre, receipt, closedSnapshotSha256: receipt.closedSnapshotSha256, state: 'SPEC_CLOSED' };
}

// Consume the retained public image with the product's existing validators.
// A self-declared COMPLETE summary or a hash over arbitrary JSON is no proof.
export async function validateRetainedSource({ product, evidence, specPath, workspace }) {
  if (await fs.realpath(workspace) !== workspace || evidence.workspace !== workspace
    || evidence.specPath !== specPath || evidence.disposition?.kind !== 'discard-current-complete') fail('terminal source/workspace binding absent');
  const { context } = await product.resolveCurrentExecutionContext(specPath);
  if (context.productRoot !== workspace || !equal(evidence.source.context, context)) fail('retained execution context differs');
  const files = new Map(evidence.source.files.map(file => {
    const bytes = Buffer.from(file.bytesBase64, 'base64');
    if (sha(bytes) !== file.sha256) fail('retained artifact bytes differ');
    return [file.name, bytes];
  }));
  if (files.size !== evidence.source.files.length) fail('duplicate retained artifact');
  const { activation, continuity } = product.validateCurrentImage({
    activationBytes: Buffer.from(evidence.source.activationBase64, 'base64'), files });
  if (activation.activeAttempt !== null || activation.activationId !== evidence.disposition.activationId
    || activation.requirementsAuthority !== evidence.disposition.requirementsAuthority
    || activation.requirementsAuthority !== evidence.source.requirementsAuthority
    || sha(Buffer.from(JSON.stringify(activation.artifacts))) !== evidence.disposition.artifactManifestSha256) fail('retained activation/disposition differs');
  const snapshotBytes = files.get('approved-preparation.json');
  const {retainedEvidence,fresh} = await product.completedEvidenceContext({context,snapshotBytes,continuity,files});
  const converted = activation.preparationRevision > 1;
  const prepared = product.validateCurrentPreparation({context,requirementsAuthority:activation.requirementsAuthority,
    snapshotBytes,artifacts:new Map([...files].filter(([name])=>name.endsWith('.md'))),
    profile:continuity.completed.length?'completed-current':converted?'converted-current':'initial',retainedEvidence});
  const snapshot=prepared.snapshot, global=snapshot.normativeProjection.global, verified=[];
  const members=[...continuity.deliveries,...continuity.completed];
  for(const current of [...continuity.completed,...continuity.deliveries]) {
    const completed=continuity.completed.includes(current);
    const carrier=prepared.currentArtifacts.deliveries.find(item=>item.deliveryId===current.deliveryId);
    const delivery=[...snapshot.normativeProjection.deliveries,...snapshot.normativeProjection.completed]
      .find(item=>item.deliveryId===current.deliveryId);
    const bundleBytes=files.get(current.evidence?.path);
    if(!delivery||!bundleBytes||!completed&&!carrier) fail('retained delivery/evidence absent');
    const bundle=JSON.parse(bundleBytes), record=bundle.validation;
    if(!record||record.origin.deliveryId!==current.deliveryId||record.origin.slice!==current.slice)
      fail('retained validation identity differs');
    const cap=product.restoreCaptureSources('current-validation',record,
      new Map(bundle.objects.map(object=>[object.id,Buffer.from(object.bytesBase64,'base64')])));
    const request=JSON.parse(Buffer.from(cap.validationRequest));
    const post=['stnl-current-validation-request-v3','stnl-current-validation-request-v4'].includes(request.format);
    const retained=completed||continuity.completed.length>0&&!fresh.has(current.deliveryId);
    const authority={preparationRevision:record.origin.preparationRevision,localRevision:record.origin.localRevision,
      normativeSha256:record.origin.normativeSha256,delivery:record.contract.delivery,context:record.contract.context};
    const observed=await product.observeCurrentDeliveryWork({context,delivery,
      sections:carrier?.sections??{'Expected Files':'- none'},current,bundle,initial:!post});
    const lastAttempt=activation.lastAttempt?.deliveryId===current.deliveryId?activation.lastAttempt:null;
    const currentAuthority={preparationRevision:snapshot.preparationRevision,localRevision:current.localRevision,
      normativeSha256:converted?current.authoritySha256:snapshot.normativeSha256,delivery,
      context:{requirementsAuthority:snapshot.requirementsAuthority,objective:global.objective,strategy:global.strategy,risks:global.risks}};
    const facts=post?await product.inspectPostConversionEvidence({context,snapshotBytes,current,bundleBytes,
      observedWork:observed.manifest,lastAttempt,admissionRef:lastAttempt?.operationRef??null,
      preparationProfile:continuity.completed.length?'completed-current':'converted-current',retainedEvidence,
      retainedRead:retained?{authority:request.authority,snapshotDigest:request.base.approvedSnapshotSha256}:null})
      :product.inspectCurrentEvidence({context,authority:retained?authority:currentAuthority,bundleBytes,counters:current.counters,
        baseline:current.baseline,observedWork:observed.manifest,currentAuthoritySha256:current.authoritySha256});
    // The public historical verifier proves the old capture, not its current
    // ownership. Bind every historical selector to that verified admission's
    // literal identities before comparing the current normative contract.
    if(retained) {
      const origin=JSON.parse(Buffer.from(cap.origin)), bindings=new Map([[record.origin.slice,record.origin.deliveryId]]);
      for(const item of origin.otherDeliveryWork??[]) {
        if(!members.some(member=>member.deliveryId===item.deliveryId&&member.slice===item.slice)
          || bindings.has(item.slice)&&bindings.get(item.slice)!==item.deliveryId) fail('historical delivery binding differs');
        bindings.set(item.slice,item.deliveryId);
      }
      const expected={requirementsAuthority:snapshot.requirementsAuthority,objective:global.objective,
        strategy:global.strategy,risks:global.risks};
      const canonical=(leaf,historical)=>({...leaf,obligations:leaf.obligations.map(obligation=>{
        const owner=obligation.fullOwner.startsWith('delivery:')?obligation.fullOwner.slice(9)
          :historical?bindings.get(obligation.fullOwner):members.find(member=>member.slice===obligation.fullOwner)?.deliveryId;
        if(!owner||!members.some(member=>member.deliveryId===owner)) fail('unproven retained obligation owner');
        return {...obligation,fullOwner:owner};
      })});
      if(!equal(authority.context,expected)||!equal(canonical(authority.delivery,true),canonical(delivery,false))
        || record.origin.localRevision!==current.localRevision) fail('retained current contract/ownership differs');
      const decision=snapshot.deliveries.find(item=>item.deliveryId===current.deliveryId)?.review.evidenceDecisions
        .find(item=>item.deliveryId===current.deliveryId)
        ??snapshot.globalReview.evidenceDecisions.find(item=>item.deliveryId===current.deliveryId);
      if(decision?.disposition==='revalidate') fail('retained proof still requires reviewed revalidation');
    }
    if(carrier) product.validateCurrentEvidenceCarriers({facts,sections:carrier.sections,
      continuity:post?{...carrier.continuity,evidence:current.evidence.path}:carrier.continuity,
      index:carrier.index,slice:current.slice,priorDeliveries:verified});
    if(facts.formalStatus!=='PASS'||facts.persistedValidation!=='current'||facts.observedValidation!=='current'
      || !facts.observationMatches||facts.rejection||facts.requiresFormalRevalidation
      || facts.auxiliaryStatus==='BLOCKED'||facts.openFindings.some(item=>item.severity==='blocking')
      || facts.openDivergences?.some(item=>item.severity==='blocking')) fail('retained local formal proof incomplete');
    verified.push({slice:current.slice,deliveryId:current.deliveryId,facts,manifest:observed.manifest,
      observed,observationInput:{context,delivery,sections:carrier?.sections??{'Expected Files':'- none'},current,bundle,initial:!post}});
  }
  const outputs=members.map(member=>verified.find(item=>item.deliveryId===member.deliveryId));
  const target = product.currentTerminalProjection(snapshot);
  const terminal = outputs.find(item => equal(item.facts.latest?.record, item.facts.bundle.validation)
    && equal(item.facts.bundle.validation?.contract.terminal, target)
    && target.deliveries.find(leaf => leaf.deliveryId === item.deliveryId)?.obligations
      .some(obligation => obligation.contribution === 'complete' && obligation.fullOwner === item.deliveryId));
  if (!terminal || !activation.lastAttempt || activation.lastAttempt.operation !== 'VALIDATE_SLICE'
    || activation.previousActivationId === null || activation.lastAttempt.terminalActivationId !== activation.activationId
    || activation.lastAttempt.deliveryId !== terminal.deliveryId || activation.lastAttempt.slice !== terminal.slice
    || activation.lastAttempt.outcome !== 'recorded'
    || activation.lastAttempt.operationAttemptId !== terminal.facts.bundle.validation.origin.operationAttemptId) fail('integral terminal judgment absent/stale');
  const cap = product.restoreCaptureSources('current-validation', terminal.facts.bundle.validation,
    new Map(terminal.facts.bundle.objects.map(object => [object.id, Buffer.from(object.bytesBase64, 'base64')])));
  const origin = JSON.parse(Buffer.from(cap.origin)), others = outputs.filter(item => item !== terminal);
  if (!Array.isArray(origin.otherDeliveryWork) || origin.otherDeliveryWork.length !== others.length
    || new Set(origin.otherDeliveryWork.map(item => item.deliveryId)).size !== others.length
    || others.some(item => !origin.otherDeliveryWork.some(other => other.deliveryId === item.deliveryId
      && other.slice === item.slice && equal(other.manifest, item.manifest)))) fail('integral other-delivery basis differs');
  const manifests = outputs.map(item => ({ deliveryId: item.deliveryId, manifest: item.manifest }));
  if (!equal(manifests, evidence.source.manifests)) fail('retained manifests differ from public observation');
  for(const item of outputs) {
    const after=await product.observeCurrentDeliveryWork(item.observationInput);
    if(!equal(after.manifest,item.observed.manifest)||!equal(after.identities,item.observed.identities)
      ||!equal(after.rootIdentity,item.observed.rootIdentity)) fail('product changed during retained evidence inspection');
  }
  return files;
}

export async function validateTerminalEvidence({ product, evidence, specPath, workspace }) {
  if (evidence?.format !== 'sentinel-native-terminal-v1' || evidence.state !== 'SPEC_CLOSED'
    || evidence.specPath !== specPath || evidence.source?.inspection?.state !== 'COMPLETE') fail('terminal proof absent/foreign');
  await validateRetainedSource({ product, evidence, specPath, workspace });
  await finishCloseEvidence({ product, pre: evidence, commandResults: [evidence.receipt] });
  return evidence;
}
