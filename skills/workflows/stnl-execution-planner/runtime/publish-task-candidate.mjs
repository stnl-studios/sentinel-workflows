#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveExecutionWorkspace, preflightExecutionOperation, validateExecutionCandidate,
  readExecutionActivation, preparationAuthorityAt, computeRequirementsAuthority, prepareDeliveryRetention } from './execution-state.mjs';
import { publishExecutionUpdate } from './execution-publication.mjs';
import { captureApprovedPreparation, parseStrictJson, readPreparationArtifacts, sha256, validateApprovedPreparation, parsePreparationArtifact } from './execution-preparation.mjs';
import { preparePlanCandidate } from './prepare-plan-candidate.mjs';
import { serializePlanPathClaims } from './serialize-plan-paths.mjs';

function assertReviewedDivergences(before, after, label) {
  if (before === after) return;
  if (before === '- none' && after.startsWith('### ')) return;
  const records = text => text.split(/(?=^### )/mu).filter(record => record.trim()).map(record => record.trim());
  const previous = records(before), proposed = records(after);
  // Only disposition of an active blocking record belongs to the approved
  // mapped recovery. Identity, description and advisory/history bytes remain
  // protected. The state validator checks its exact committing owner/revision.
  const immutable = record => record.split('\n').filter(line => !/^- (?:State|Resolution|Superseded by):/u.test(line)).join('\n');
  for (const [index, record] of previous.entries()) {
    const next = proposed[index];
    const disposable = /^- Severity: blocking$/mu.test(record) && /^- State: active$/mu.test(record);
    if (!next || (disposable ? immutable(record) !== immutable(next) : record !== next)) throw new Error(`${label} rewrote historical evidence`);
  }
}
async function assertHistoricalPreparation(specPath, staged, operation) {
  const live = await preflightExecutionOperation(specPath, operation);
  if (!live.tasks || [...live.tasks.values()].every(task => task.pristine)) return;
  const original = await readPreparationArtifacts(live.workspace.executionRoot);
  const proposed = await readPreparationArtifacts(staged);
  const global = parsePreparationArtifact(proposed.get('plan.md'), 'plan.md');
  const same=global.fields['Revision mode']==='same-delivery-revision';
  if (operation === 'REPLAN' && (!['append-only-extension','same-delivery-revision'].includes(global.fields['Revision mode'])
    || Number(global.fields['Plan revision']) !== live.globalPlan.revision + 1)) throw new Error('historical REPLAN requires next append-only revision');
  const mapped = new Set((global.fields['Supersedes open slices'] ?? 'none').split(', ').map(mapping => mapping.split(' -> ')[0]));
  for (const [name, bytes] of original) {
    if (name === 'plan.md' || name === 'tasks.md') continue;
    const next = proposed.get(name);
    if (!next) throw new Error(`historical artifact was removed: ${name}`);
    const slice = path.basename(name, '.md');
    if (same && (operation==='REPLAN' || Number(parsePreparationArtifact(next,name).fields['Plan revision'])===live.globalPlan.revision)) {
      const old=parsePreparationArtifact(bytes,name);const revised=parsePreparationArtifact(next,name);
      if (old.fields['Delivery ID']!==revised.fields['Delivery ID']) throw new Error('same-delivery revision changes runtime identity');
      if (name.startsWith('tasks/')) for (const heading of ['Implementation Test Evidence','Findings Test Evidence','Validation Attempts','Validation Findings','Divergences','Delegation Blocker']) {
        if (old.sections[heading]!==revised.sections[heading]) throw new Error('revision rewrites operational history before retention');
      }
      continue;
    }
    if (operation === 'REVIEW_PLAN' && live.tasks.get(slice)?.pristine && live.tasks.get(slice)?.revision === live.globalPlan.revision) continue;
    if (name.startsWith('plans/') || operation === 'REPLAN') {
      if (bytes !== next) throw new Error(`historical artifact changed: ${name}`);
      continue;
    }
    const old = parsePreparationArtifact(bytes, name); const changed = parsePreparationArtifact(next, name);
    const historical = Number(old.fields['Plan revision']) < live.globalPlan.revision || !live.tasks.get(path.basename(name, '.md')).pristine;
    if (!historical) continue; // Independent reviewer may correct the new pristine draft.
    if (JSON.stringify(old.fields) !== JSON.stringify(changed.fields)) throw new Error(`historical task identity changed: ${name}`);
    for (const heading of Object.keys(old.sections)) {
      if (mapped.has(path.basename(name, '.md')) && ['Final Result', 'Divergences'].includes(heading)) {
        if (heading === 'Divergences') assertReviewedDivergences(old.sections[heading], changed.sections[heading], name + ':' + heading);
        continue; // The state validator checks the exact committed supersession and preserves prior PASS.
      }
      if (old.sections[heading] !== changed.sections[heading]) throw new Error(`historical task section changed: ${name}:${heading}`);
    }
  }
  const oldRows = original.get('tasks.md').split('\n').filter(line => /^\| \[[ x]\] /u.test(line));
  const newRows = proposed.get('tasks.md').split('\n').filter(line => /^\| \[[ x]\] /u.test(line));
  for (const [index, row] of oldRows.entries()) {
    const slice = /tasks\/(slice-[0-9]{2,})\.md/u.exec(row)?.[1];
    if (same) {
      const old=row.split('|');const next=newRows[index]?.split('|');
      if (!next || old.slice(2,6).join('|')!==next.slice(2,6).join('|')) throw new Error('same revision changes historical progress identity');
    } else if (operation === 'REPLAN' || !mapped.has(slice)) {
      if (row !== newRows[index]) throw new Error('historical progress row changed');
    } else {
      const old = row.split('|'); const next = newRows[index]?.split('|');
      if (!next || old.slice(2, 6).join('|') !== next.slice(2, 6).join('|') || next[1].trim() !== '[x]'
        || next[6].trim() !== 'SUPERSEDED' || next[7].trim() !== 'SUPERSEDED') throw new Error('historical row has unauthorized supersession');
    }
  }
}

export async function publishPreparationCandidate({ specPath, candidateExecutionRoot, reviewDecision = null, checkpoint = null }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const marker = parseStrictJson(await fs.readFile(`${candidateExecutionRoot}.owner.json`, 'utf8'));
  if (marker.specPath !== await fs.realpath(specPath) || marker.executionRoot !== workspace.executionRoot
    || !['PLAN', 'REPLAN', 'REVIEW_PLAN'].includes(marker.operation)) throw new Error('preparation marker differs');
  await preparePlanCandidate({ candidateExecutionRoot });
  await serializePlanPathClaims({ specPath, candidateExecutionRoot });
  const reviewed = marker.operation === 'REVIEW_PLAN';
  if (reviewed) {
    if (!reviewDecision) throw new Error('independent joint review decision required');
    await captureApprovedPreparation({ candidateExecutionRoot, reviewDecision });
  } else if (reviewDecision !== null) throw new Error('author cannot approve its own preparation');
  return publishExecutionUpdate({ workspace, candidateExecutionRoot, expectedTree: marker.source,
    expectedActivationId: marker.expectedActivationId, draft: !reviewed, checkpoint,
    prepareRetention: details => prepareDeliveryRetention({specPath,...details,revise:marker.operation === 'REPLAN'}),
    readActivated: () => readExecutionActivation(specPath, { requireCurrent: marker.operation !== "REPLAN" }),
    authorizeDiff: async staged => {
      await assertHistoricalPreparation(specPath, staged, marker.operation);
    },
    validateCandidate: async root => {
      // validateExecutionCandidate is isolated; live draft readback is handled by the core byte checks.
      if (root !== workspace.executionRoot) await validateExecutionCandidate(specPath, root);
      const authority = await preparationAuthorityAt(root);
      if (authority.requirementsAuthority !== `sha256:${await computeRequirementsAuthority(specPath)}`) throw new Error('requirements changed');
      if (reviewed) {
        const snapshot = parseStrictJson(await fs.readFile(path.join(root, 'approved-preparation.json'), 'utf8'));
        validateApprovedPreparation(snapshot);
        const final = await readPreparationArtifacts(root);
        if (snapshot.reviewedArtifacts.some(record => record.sha256 !== sha256(Buffer.from(final.get(record.path) ?? '')))) throw new Error('final content differs from joint review');
      }
      return authority;
    } });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (![4, 6].includes(args.length) || args[0] !== '--spec-path' || args[2] !== '--candidate-execution-root'
    || (args.length === 6 && args[4] !== '--review-decision-file')) throw new Error('usage: publish-task-candidate.mjs --spec-path SPEC_PATH --candidate-execution-root ROOT [--review-decision-file FILE]');
  const reviewDecision = args.length === 6 ? parseStrictJson(await fs.readFile(args[5], 'utf8')) : null;
  process.stdout.write(JSON.stringify(await publishPreparationCandidate({ specPath: args[1], candidateExecutionRoot: args[3], reviewDecision })) + '\n');
}
