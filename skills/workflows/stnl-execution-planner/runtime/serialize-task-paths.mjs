#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPreparationCandidate } from './prepare-plan-candidate.mjs';
import { pathToFileURL } from 'node:url';
import { resolveExecutionWorkspace, resolvePhysicalImplementationTarget, resolveSemanticPhysicalImplementationTarget } from './execution-state.mjs';
import { preparationPathClaims, preparationAreaClaims, parseVerificationRecipe, verificationReferences } from './execution-preparation.mjs';

function body(text, heading) {
  const match = new RegExp(`^## ${heading}\\n\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'mu').exec(text);
  if (!match) throw new Error(`missing ${heading}`); return match[1].trim();
}
function replaceBody(text, heading, value) {
  if (body(text, heading) === value) return text;
  return text.replace(new RegExp(`(^## ${heading}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'mu'),
    (_, prefix) => `${prefix}${value}\n\n`);
}
async function canonicalRecipe(specPath, artifact, carrier) {
  const recipe = parseVerificationRecipe(carrier);
  for (const ref of verificationReferences(recipe)) {
    const raw = ref.path;
    const target = raw.startsWith('.') ? await resolvePhysicalImplementationTarget(specPath, {artifact, field:'verification input', raw})
      : await resolveSemanticPhysicalImplementationTarget(specPath, {raw});
    ref.path = path.relative(path.dirname(artifact), target.physicalTarget).split(path.sep).join('/');
  }
  return recipe;
}
export async function serializeTaskPathClaims({ specPath, candidateExecutionRoot }) {
  await assertPreparationCandidate(candidateExecutionRoot, specPath);
  const workspace = await resolveExecutionWorkspace(specPath);
  const candidate = await fs.realpath(candidateExecutionRoot);
  if (candidate === workspace.executionRoot || candidate.startsWith(workspace.executionRoot + path.sep)) throw new Error('candidate-only serialization required');
  let serializedClaims = 0; const changedPaths = [], updates = [];
  for (const file of (await fs.readdir(path.join(candidate, 'plans'))).sort()) {
    const planPath = path.join(candidate, 'plans', file); const taskPath = path.join(candidate, 'tasks', file);
    let plan = await fs.readFile(planPath, 'utf8'); let task = await fs.readFile(taskPath, 'utf8');
    // Both carriers are independently parsed and resolved. Canonical path spelling
    // can converge; command/base/dependency differences must survive as rejection.
    const planRecipeBody = body(plan, 'Verification Recipe'), taskRecipeBody = body(task, 'Verification Recipe');
    const planRecipe = await canonicalRecipe(specPath, path.join(workspace.executionRoot,'plans',file), planRecipeBody);
    const taskRecipe = await canonicalRecipe(specPath, path.join(workspace.executionRoot,'tasks',file), taskRecipeBody);
    if (JSON.stringify(planRecipe) !== JSON.stringify(taskRecipe)) throw new Error(`${file} Verification Recipe differs between Plan and Task`);
    for (const carrier of ['Authorized Areas', 'Expected Files', 'Existing Inputs']) {
      const source = body(plan, carrier); const claims = preparationPathClaims(source, carrier);
      const canonical = [];
      const kinds = carrier === 'Authorized Areas' ? preparationAreaClaims(source) : null;
      for (const raw of claims) {
        const target = raw.startsWith('.') ? await resolvePhysicalImplementationTarget(specPath, { artifact: path.join(workspace.executionRoot, 'plans', file), field: carrier, raw })
          : await resolveSemanticPhysicalImplementationTarget(specPath, { raw });
        if (carrier === 'Existing Inputs') { const meta = await fs.lstat(target.physicalTarget); if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1) throw new Error('existing input must be regular'); }
        canonical.push(`- ${kinds ? kinds[canonical.length].kind + ': ' : ''}\`${path.relative(path.join(workspace.executionRoot, 'tasks'), target.physicalTarget).split(path.sep).join('/')}\``);
      }
      const value = canonical.join('\n') || '- none';
      plan = plan.replace(source, value); task = task.replace(body(task, carrier), value); serializedClaims += claims.length;
    }
    plan = replaceBody(plan, 'Verification Recipe', '- Recipe: ' + JSON.stringify(planRecipe));
    task = replaceBody(task, 'Verification Recipe', '- Recipe: ' + JSON.stringify(taskRecipe));
    updates.push([planPath,plan],[taskPath,task]);
  }
  for (const [target, text] of updates) {
    if (await fs.readFile(target, 'utf8') !== text) { await fs.writeFile(target, text); changedPaths.push(target); }
  }
  return { status: 'PASS', serializedClaims, changedPaths };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--spec-path' || args[2] !== '--candidate-execution-root') throw new Error('usage: serialize-task-paths.mjs --spec-path SPEC_PATH --candidate-execution-root ROOT');
  process.stdout.write(JSON.stringify(await serializeTaskPathClaims({ specPath: args[1], candidateExecutionRoot: args[3] })) + '\n');
}
