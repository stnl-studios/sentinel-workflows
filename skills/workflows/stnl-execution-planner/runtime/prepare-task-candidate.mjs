#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveExecutionWorkspace, preflightExecutionOperation } from './execution-state.mjs';
import { allocatePreparationCandidate, withExecutionPublicationLock } from './execution-publication.mjs';

export async function preparePreparationCandidate({ specPath, operation, revisionMode = null }) {
  if (!['PLAN', 'REPLAN', 'REVIEW_PLAN'].includes(operation)) throw new Error('preparation operation required');
  if (revisionMode !== null && (operation !== 'REPLAN' || !['same-delivery-revision','pristine-replacement','append-only-extension'].includes(revisionMode))) throw new Error('explicit revision mode requires a supported REPLAN mode');
  const workspace = await resolveExecutionWorkspace(specPath);
  return withExecutionPublicationLock(workspace, async lease => {
    const preflight = await preflightExecutionOperation(specPath, operation);
    const candidateExecutionRoot = await allocatePreparationCandidate({ workspace, lease, captureParent: os.tmpdir(), metadata: { operation, specPath: await fs.realpath(specPath),
      expectedActivationId: preflight.activation?.activationId ?? null,
      preparationRevision: operation === 'REPLAN' ? (preflight.globalPlan?.revision ?? 0) + 1 : preflight.globalPlan?.revision ?? 1,
      revisionMode: operation === 'REPLAN' && preflight.tasks ? (revisionMode ?? ([...preflight.tasks.values()].every(task => task.pristine) ? 'pristine-replacement' : 'append-only-extension')) : null,
      reviewContinuity: operation==='REVIEW_PLAN' ? preflight.preparation?.normativeProjection.continuity ?? null : null,
      predecessorDeliveries: operation === 'PLAN' ? [] : (preflight.preparation?.deliveries ?? []).map(d => ({...d,revision:preflight.tasks.get(d.slice).revision})),
      historicalSlices: operation !== 'PLAN' && preflight.tasks && [...preflight.tasks.values()].some(task => !task.pristine) ? [...preflight.tasks.keys()] : [], deliveryIds: {} } });
    return { status: 'PASS', candidateExecutionRoot, expectedActivationId: preflight.activation?.activationId ?? null };
  });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (![4,6].includes(args.length) || (args.length===6 && args[4]!=='--revision-mode') || args[0] !== '--spec-path' || args[2] !== '--operation') throw new Error('usage: prepare-task-candidate.mjs --spec-path SPEC_PATH --operation PLAN|REPLAN|REVIEW_PLAN [--revision-mode same-delivery-revision|pristine-replacement|append-only-extension]');
  process.stdout.write(JSON.stringify(await preparePreparationCandidate({ specPath: args[1], operation: args[3], revisionMode: args[5] ?? null })) + '\n');
}
