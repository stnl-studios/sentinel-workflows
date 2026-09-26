import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertManagedAgreement,
  createManagedValidationContext,
  managedEnvironment,
  readManagedValidationContext,
} from '../skills/workflows/stnl-slice-quality-manager/runtime/managed-validation-context.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-managed-context-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runRoot = path.join(root, 'run-XYZ');
  const workspace = path.join(runRoot, 'case-c/workspace');
  const specPath = path.join(workspace, 'specs/case-c');
  const privateHome = path.join(root, 'run-XYZ-c-AbCd12');
  const skillRoot = path.join(privateHome, 'skills/stnl-slice-quality-manager');
  await fs.mkdir(specPath, { recursive: true });
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(specPath, 'feature_spec.md'), '# Fixture\n');
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '# Copied skill\n');
  const officialPreflight = {
    exitCode: 0, operation: 'VALIDATE_SLICE', slice: 'slice-01', inputSlice: '1', specPath,
    state: 'IMPLEMENTED_AWAITING_VALIDATION', authority: `sha256:${'a'.repeat(64)}`,
    legalOperations: [{ operation: 'VALIDATE_SLICE', slice: 'slice-01' }], mandatoryRecovery: null,
  };
  return { root, runRoot, workspace, specPath, privateHome, skillRoot, officialPreflight };
}

test('managed SPEC_PATH stays under the case workspace when private home has the run suffix', async (t) => {
  const f = await fixture(t);
  const context = await createManagedValidationContext({ workspace: f.workspace, officialPreflight: f.officialPreflight });
  const environment = managedEnvironment({ CODEX_HOME: f.privateHome, SKILL_ROOT: f.skillRoot }, context);
  const read = readManagedValidationContext(environment);
  assert.equal(read.specPath, f.specPath);
  assert.equal(read.workspace, f.workspace);
  assert.equal(read.operation, 'VALIDATE_SLICE');
  assert.equal(read.slice, 'slice-01');
  assert.equal(read.authority, f.officialPreflight.authority);
  assert.equal(read.specPath.startsWith(`${f.runRoot}${path.sep}`), true);
  assert.equal(read.specPath.includes('run-XYZ-c-AbCd12'), false);
  assert.equal(await fs.realpath(environment.SKILL_ROOT), f.skillRoot);
  assert.equal(assertManagedAgreement({ specPath: f.specPath, workspace: f.workspace, slice: '1', environment }).specPath, f.specPath);
});

test('managed identity disagreement blocks; missing context preserves manual path inputs', async (t) => {
  const f = await fixture(t);
  const context = await createManagedValidationContext({ workspace: f.workspace, officialPreflight: f.officialPreflight });
  const environment = managedEnvironment({}, context);
  const wrongPath = path.join(f.privateHome, 'case-c/workspace/specs/case-c');
  assert.throws(() => assertManagedAgreement({ specPath: wrongPath, environment }), /disagrees with managed context/u);
  assert.throws(() => assertManagedAgreement({ workspace: f.privateHome, environment }), /disagrees with managed context/u);
  assert.throws(() => assertManagedAgreement({ slice: '2', environment }), /disagrees with managed context/u);
  assert.throws(() => readManagedValidationContext({ ...environment, STNL_MANAGED_SPEC_PATH: wrongPath }), /disagree/u);
  assert.equal(readManagedValidationContext({}), null);
  assert.equal(assertManagedAgreement({ specPath: f.specPath, slice: '1', environment: {} }), null);
});

test('managed context refuses source, sibling case, and private-home SPEC paths', async (t) => {
  const f = await fixture(t);
  const sibling = path.join(f.runRoot, 'case-b/workspace/specs/case-b');
  await fs.mkdir(sibling, { recursive: true });
  const source = path.join(f.root, 'source/specs/source');
  await fs.mkdir(source, { recursive: true });
  const paths = [sibling, source, f.privateHome];
  for (const specPath of paths) {
    await assert.rejects(createManagedValidationContext({
      workspace: f.workspace, officialPreflight: { ...f.officialPreflight, specPath },
    }), /outside managed workspace/u);
  }
});
