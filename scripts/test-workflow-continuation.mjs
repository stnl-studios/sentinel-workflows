import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFile(path.join(root, rel), 'utf8');
const consumers = ['stnl-execution-planner', 'stnl-plan-reviewer', 'stnl-slice-executor', 'stnl-slice-quality-manager'];

test('installed workflow consumers carry the same bounded coordination contract', async () => {
  let expected;
  for (const name of consumers) {
    const prefix = `skills/workflows/${name}`;
    const skill = await read(`${prefix}/SKILL.md`);
    assert.match(skill, /references\/workflow-continuation\.md/u);
    const reference = await read(`${prefix}/references/workflow-continuation.md`);
    const body = reference.slice(reference.indexOf('# Approved workflow continuation'));
    expected ??= body;
    assert.equal(body, expected, `${name} must not invent different continuation authority`);
    assert.match(body, /authorizes execution/u);
    assert.match(body, /request limited to planning, review, validation or one slice remains limited/u);
    assert.match(body, /Stop before CLOSE/u);
    assert.match(body, /material requirement\/strategy change/u);
    assert.match(body, /automatic REPLAN, RECONCILE/u);
    assert.match(body, /resume that handle/u);
    assert.match(body, /BLOCKED is not permission to loop/u);
    assert.match(body, /reserve-dispatch --terminal/u);
    assert.match(body, /A separate validation slice is optional/u);
    assert.match(body, /missing manual QA/u);
    assert.match(body, /Do not rerun a recipe merely to recover/u);
    assert.match(body, /Unknown historical approval, consumption or evidence stays unknown/u);
  }
});

test('planning and independent review require compact decomposition and terminal proof', async () => {
  const planner = await read('skills/workflows/stnl-execution-planner/SKILL.md');
  const reviewer = await read('skills/workflows/stnl-plan-reviewer/SKILL.md');
  assert.match(planner, /smallest serial decomposition/u);
  assert.match(planner, /Record the target, observable whole-delivery criteria, executable proof/u);
  assert.match(reviewer, /Reject unnecessary fragmentation/u);
  assert.match(reviewer, /Do not approve a plan that leaves the path from local PASS to integral judgment unspecified/u);
  assert.doesNotMatch(planner, /do not start or delegate that next operation from PLAN/u);
});

test('public instructions distinguish continuation from lifecycle RESUME and CLOSE', async () => {
  const readme = await read('README.md');
  assert.doesNotMatch(readme, /não executa operações futuras automaticamente|A geração não é automática/u);
  assert.match(readme, /pausa antes do CLOSE/u);
  assert.match(readme, /pedido de etapa isolada continua isolado/u);
  const lifecycle = await read('skills/workflows/stnl-spec-lifecycle-manager/SKILL.md');
  assert.match(lifecycle, /“continue” does not itself authorize CLOSE/u);
  assert.match(lifecycle, /it is not MODE=RESUME/u);
  const prompt = await read('docs/workflow-continue-example.md');
  assert.match(prompt, /handle existente/u);
  assert.match(prompt, /Pare antes do CLOSE/u);
});
