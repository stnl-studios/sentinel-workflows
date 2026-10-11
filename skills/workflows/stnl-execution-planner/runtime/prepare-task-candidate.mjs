#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveExecutionWorkspace, preflightExecutionOperation } from './execution-state.mjs';
import { captureExecutionTree, withExecutionPublicationLock } from './execution-publication.mjs';

export async function preparePreparationCandidate({ specPath, operation }) {
  if (!['PLAN', 'REPLAN', 'REVIEW_PLAN'].includes(operation)) throw new Error('preparation operation required');
  const workspace = await resolveExecutionWorkspace(specPath);
  return withExecutionPublicationLock(workspace, async () => {
    const preflight = await preflightExecutionOperation(specPath, operation);
    const source = await captureExecutionTree(workspace.executionRoot);
    const candidateExecutionRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-preparation-')));
    if (source) {
      await fs.cp(workspace.executionRoot, candidateExecutionRoot, { recursive: true });
      if (JSON.stringify((await captureExecutionTree(candidateExecutionRoot)).files) !== JSON.stringify(source.files)) throw new Error('source changed during copy');
    }
    // The owned marker lives outside the candidate execution tree. It is never authority by itself.
    await fs.writeFile(`${candidateExecutionRoot}.owner.json`, JSON.stringify({ operation, specPath: await fs.realpath(specPath),
      executionRoot: workspace.executionRoot, source, expectedActivationId: preflight.activation?.activationId ?? null,
      preparationRevision: operation === 'REPLAN' ? (preflight.globalPlan?.revision ?? 0) + 1 : preflight.globalPlan?.revision ?? 1,
      revisionMode: operation === 'REPLAN' && preflight.tasks ? ([...preflight.tasks.values()].every(task => task.pristine) ? 'pristine-replacement' : 'append-only-extension') : null,
      historicalSlices: operation !== 'PLAN' && preflight.tasks && [...preflight.tasks.values()].some(task => !task.pristine) ? [...preflight.tasks.keys()] : [], deliveryIds: {} }) + '\n', { flag: 'wx', mode: 0o600 });
    for (const name of ['activation.json', 'approved-preparation.json']) await fs.rm(path.join(candidateExecutionRoot, name), { force: true });
    return { status: 'PASS', candidateExecutionRoot, expectedActivationId: preflight.activation?.activationId ?? null };
  });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--spec-path' || args[2] !== '--operation') throw new Error('usage: prepare-task-candidate.mjs --spec-path SPEC_PATH --operation PLAN|REPLAN|REVIEW_PLAN');
  process.stdout.write(JSON.stringify(await preparePreparationCandidate({ specPath: args[1], operation: args[3] })) + '\n');
}
