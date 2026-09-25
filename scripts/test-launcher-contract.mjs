import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderLauncher } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CANONICAL = path.join(ROOT, 'templates', 'prompts');
const CHECKER = path.join(ROOT, 'scripts', 'check-contracts.mjs');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-launchers-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const prompts = path.join(temporary, 'prompts');
  await fs.cp(CANONICAL, prompts, { recursive: true });
  return prompts;
}

function check(root) {
  return spawnSync(process.execPath, [CHECKER, 'launchers', '--root', root], { encoding: 'utf8' });
}

async function change(root, name, transform) {
  const file = path.join(root, name);
  await fs.writeFile(file, transform(await fs.readFile(file, 'utf8')));
}

test('every human launcher is a compact registered entry with matching platform pairs', async (t) => {
  const root = await fixture(t);
  assert.equal(check(root).status, 0, check(root).stderr);
  const files = (await fs.readdir(root)).filter((name) => name.endsWith('.md'));
  assert.equal(files.length, 19);
  for (const name of files) assert.ok((await fs.readFile(path.join(root, name), 'utf8')).split('\n').length <= 9, name);
});

for (const [label, name, transform] of [
  ['wrong skill', 'execution-plan.md', (text) => text.replace('stnl-execution-planner', 'stnl-plan-reviewer')],
  ['wrong operation', 'execution-plan.md', (text) => text.replace('OPERATION=PLAN', 'OPERATION=REPLAN')],
  ['missing slice', 'slice-execute-codex.md', (text) => text.replace('SLICE={{SLICE}}\n', '')],
  ['benchmark parameter', 'slice-execute-codex.md', (text) => text.replace('SLICE={{SLICE}}', 'SLICE={{SLICE}}\nBENCHMARK_SEQUENCE={{BENCHMARK_SEQUENCE}}')],
  ['helper procedure', 'execution-plan.md', (text) => text.replace('Contexto adicional (opcional):', 'node __SERIALIZER__\n\nContexto adicional (opcional):')],
  ['extra prose', 'spec-init.md', (text) => text.replace('Contexto adicional (opcional):', 'Execute o publisher.\n\nContexto adicional (opcional):')],
  ['unknown placeholder', 'execution-plan-review.md', (text) => text.replace('SPEC_PATH={{SPEC_PATH}}', 'SPEC_PATH={{UNKNOWN}}')],
  ['platform divergence', 'slice-validate-claude.md', (text) => text.replace('SLICE={{SLICE}}', 'SLICE=01')],
]) {
  test(`rejects ${label}`, async (t) => {
    const root = await fixture(t);
    await change(root, name, transform);
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONTRACT_ERROR\[L004_INPUTS\]|CONTRACT_ERROR\[L018_PLATFORM_EQUIVALENCE\]/u);
  });
}

test('rendered benchmark input is byte-identical to the versioned template substitution', async () => {
  const template = await fs.readFile(path.join(CANONICAL, 'slice-execute-codex.md'), 'utf8');
  const spec = '/workspace/specs/feature';
  const expected = `Use \`stnl-slice-executor\`.\nOPERATION=EXECUTE_SLICE\nSPEC_PATH=${spec}\nSLICE=2\n\nContexto adicional (opcional):\n`;
  assert.equal(renderLauncher(template, { SPEC_PATH: spec, SLICE: '2' }), expected);
  assert.throws(() => renderLauncher(template, { SPEC_PATH: spec }), /SLICE/);
  assert.throws(() => renderLauncher(template, { SPEC_PATH: spec, SLICE: '2\nOPERATION=OTHER' }), /malformed/);
  const literal = renderLauncher(template, { SPEC_PATH: '/tmp/$(echo harmless)', SLICE: '2' });
  assert.ok(literal.includes('/tmp/$(echo harmless)'));
});
