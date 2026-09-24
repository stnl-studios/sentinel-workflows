import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { composeRunnerRequest, readRunnerConfiguration } from '../agents/codex/runtime/validation-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('independent runner receives adapter-owned serializer and managed workspace context', async () => {
  const configuration = await readRunnerConfiguration(ROOT);
  const workspace = path.join(ROOT, 'benchmark-temp/run-example/case-a/workspace');
  const serializer = path.join(ROOT, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs');
  const specPath = path.join(workspace, 'specs/benchmark-case-a');
  const officialPreflight = { operation: 'EXECUTE_SLICE', slice: 'slice-01', specPath };
  const prompt = 'Exact main-context semantic payload.';
  const request = composeRunnerRequest({ configuration, officialPreflight, operation: 'EXECUTE_SLICE',
    slice: 'slice-01', workspace, serializer, prompt });
  assert.equal(configuration.model, 'gpt-5.6-luna');
  assert.equal(configuration.effort, 'medium');
  assert.ok(request.includes(`RUNNER_EVIDENCE_SERIALIZER=${serializer}\n\n`));
  assert.ok(request.includes(`MANAGED_WORKSPACE=${workspace}\n\n`));
  assert.ok(request.includes(`SPEC_PATH=${specPath}\n\n`));
  assert.ok(request.includes(`OFFICIAL_EXECUTION_PREFLIGHT=${JSON.stringify(officialPreflight)}`));
  assert.ok(request.endsWith(prompt));
  assert.throws(() => composeRunnerRequest({ configuration, officialPreflight, operation: 'EXECUTE_SLICE',
    slice: 'slice-01', workspace, serializer: 'relative/serializer.mjs', prompt }), /context path is invalid/u);
});
