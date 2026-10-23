// Fixed benchmark observations. Never copied into, or imported from, candidate tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_CONTRACT = 'sentinel-todo-product-v2';
export const PRODUCT_CHECK_IDS = Object.freeze({
  A: Object.freeze(['list-storage', 'list-filters', 'list-empty', 'list-usage', 'add-complete', 'existing-errors']),
  B: Object.freeze(['list-storage', 'add-complete', 'existing-errors', 'priority-persist', 'priority-errors', 'priority-legacy', 'priority-literal', 'dependencies']),
  C: Object.freeze(['list-storage', 'add-complete', 'existing-errors', 'archive-list', 'archive-state', 'archive-errors', 'archive-usage', 'archive-compat', 'dependencies']),
});

export function productInstrumentIdentity(directory = fileURLToPath(new URL('.', import.meta.url))) {
  const digest = createHash('sha256').update('sentinel-product-instrument-v1\0');
  for (const name of ['product-acceptance.mjs', 'product-write-observer.cjs']) {
    const bytes = readFileSync(path.join(directory, name));
    digest.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return `sha256:${digest.digest('hex')}`;
}

export async function productCandidateIdentity(workspace) {
  if (!path.isAbsolute(workspace) || await fs.realpath(workspace) !== workspace
    || !(await fs.lstat(workspace)).isDirectory()) throw new Error('product identity requires a canonical workspace');
  const digest = createHash('sha256').update('sentinel-product-candidate-v1\0');
  async function visit(relative) {
    const file = path.join(workspace, relative);
    const metadata = await fs.lstat(file);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) throw new Error('product identity requires physical files');
    if (metadata.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) if (!(relative === '' && name === '.git')) await visit(path.join(relative, name));
    } else {
      const bytes = await fs.readFile(file);
      digest.update(relative.split(path.sep).join('/')).update('\0').update(String(metadata.mode & 0o777)).update('\0')
        .update(String(bytes.length)).update('\0').update(bytes);
    }
  }
  await visit('');
  return `sha256:${digest.digest('hex')}`;
}

// Current approval requires current instrument evidence. Historical diagnostic
// reports may remain readable without inventing a qualification they never had.
export function validateProductAcceptance(value, caseId, required = false, expectedInstrument = productInstrumentIdentity(), expectedProduct = null) {
  const fail = () => { throw new Error('result productAcceptance is invalid or unavailable'); };
  if (value === undefined || value === null) { if (required) fail(); return; }
  const keys = ['caseId', 'checks', 'commands', 'contract', 'diagnostic', 'errorCode', 'failedCheck', 'passed'];
  if (Object.hasOwn(value, 'instrumentSha256')) keys.push('instrumentSha256');
  if (Object.hasOwn(value, 'product')) keys.push('product');
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()
    || !(required ? value.contract === PRODUCT_CONTRACT : [PRODUCT_CONTRACT, 'sentinel-todo-product-v1'].includes(value.contract))
    || value.caseId !== caseId || !['A', 'B', 'C'].includes(caseId)
    || typeof value.passed !== 'boolean' || !Array.isArray(value.checks)
    || value.checks.some(check => typeof check !== 'string' || check.trim() === '')
    || new Set(value.checks).size !== value.checks.length || !Number.isSafeInteger(value.commands) || value.commands < 0
    || ['diagnostic', 'errorCode', 'failedCheck'].some(key => value[key] !== null && typeof value[key] !== 'string')
    || (value.passed ? value.failedCheck !== null || value.diagnostic !== null || value.errorCode !== null
      : value.failedCheck === null || value.diagnostic === null)
    || (value.instrumentSha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(value.instrumentSha256))
    || (value.product !== undefined && value.product !== null && (typeof value.product !== 'object' || Array.isArray(value.product)
      || Object.keys(value.product).sort().join() !== 'root,sha256' || typeof value.product.root !== 'string'
      || !path.isAbsolute(value.product.root) || path.resolve(value.product.root) !== value.product.root
      || !/^sha256:[0-9a-f]{64}$/u.test(value.product.sha256)))
    || (required && (!value.passed || !expectedProduct || !value.product
      || value.product.root !== expectedProduct.root || value.product.sha256 !== expectedProduct.sha256
      || value.commands === 0 || value.instrumentSha256 !== expectedInstrument
      || JSON.stringify([...value.checks].sort()) !== JSON.stringify([...PRODUCT_CHECK_IDS[caseId]].sort())))) fail();
}

export async function checkProductAcceptance(workspace, caseId) {
  if (!['A', 'B', 'C'].includes(caseId)) throw new Error('product acceptance supports only A/B/C');
  const evidence = { contract: PRODUCT_CONTRACT, instrumentSha256: productInstrumentIdentity(), product: null, caseId, passed: false, checks: [], commands: 0,
    failedCheck: null, diagnostic: null, errorCode: null };
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-product-')));
  let currentCheck = 'setup';
  let serial = 0;
  const withPriority = (todos) => todos.map((todo) => caseId === 'B'
    ? { ...todo, priority: todo.priority ?? 'medium' }
    : caseId === 'C' ? { ...todo, archived: todo.archived ?? false } : todo);
  const mixed = [
    { id: 7, title: 'último pendente', completed: false },
    { id: 2, title: 'feito', completed: true },
    { id: 5, title: 'outro pendente', completed: false },
  ];
  const sorted = [...mixed].sort((a, b) => a.id - b.id);
  const check = async (id, name, observation) => {
    currentCheck = name;
    await observation();
    evidence.checks.push(id);
  };
  const store = async (todos) => {
    const directory = path.join(scratch, String(++serial));
    await fs.mkdir(directory);
    const file = path.join(directory, 'todos.json');
    if (todos !== undefined) await fs.writeFile(file, `${JSON.stringify({ todos }, null, 2)}\n`);
    return file;
  };
  // Includes existence, bytes and stray temporary files, rather than parsed JSON alone.
  const snapshot = async (file) => Promise.all((await fs.readdir(path.dirname(file))).sort()
    .map(async (name) => [name, (await fs.readFile(path.join(path.dirname(file), name))).toString('base64')]));
  const invoke = (file, args, readOnly = false) => {
    evidence.commands += 1;
    const trace = path.join(scratch, `write-observer-${evidence.commands}.jsonl`);
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.NODE_OPTIONS;
    if (readOnly) Object.assign(environment, { STNL_PRODUCT_OBSERVER_ROOT: path.dirname(file), STNL_PRODUCT_OBSERVER_FILE: trace });
    const observer = fileURLToPath(new URL('./product-write-observer.cjs', import.meta.url));
    const result = spawnSync(process.execPath, [...(readOnly ? ['--require', observer] : []), path.join(workspace, 'src', 'cli.mjs'), '--store', file, ...args],
      { cwd: workspace, env: environment, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.signal, null, `CLI signal: ${result.signal}; stderr: ${result.stderr}`);
    if (readOnly) {
      const unavailable = detail => Object.assign(new Error(`storage observation unavailable: ${detail}`), { code: 'PRODUCT_OBSERVATION_UNPROVEN' });
      let records;
      try { records = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
      catch { throw unavailable('missing or malformed trace'); }
      if (records[0]?.type !== 'ready' || records[0]?.contract !== 'sentinel-product-write-observer-v1'
        || records[0]?.root !== path.dirname(file) || records.at(-1)?.type !== 'complete' || records.at(-1)?.overflow !== false
        || records.slice(1, -1).some(row => !['write-attempt', 'unobserved-capability'].includes(row.type))) {
        throw unavailable('incomplete coverage');
      }
      if (records.some(row => row.type === 'unobserved-capability')) throw unavailable(JSON.stringify(records));
      assert.ok(!records.some(row => row.type === 'write-attempt'), `read-only command attempted storage writes: ${JSON.stringify(records)}`);
    }
    return result;
  };
  const success = (result) => {
    assert.equal(result.status, 0, `CLI exit ${result.status}; stderr: ${result.stderr}`);
    assert.equal(result.stderr, '', 'successful CLI must not emit stderr');
    if (result.stdout === '') return [];
    assert.ok(result.stdout.endsWith('\n'), 'JSON lines must end with newline');
    return result.stdout.slice(0, -1).split('\n').map((line) => {
      const todo = JSON.parse(line);
      assert.ok(todo !== null && typeof todo === 'object' && !Array.isArray(todo), 'one Todo object per line');
      if (caseId === 'C') {
        assert.ok(todo.archived === undefined || typeof todo.archived === 'boolean', 'archived must be boolean when supplied');
        return { ...todo, archived: todo.archived ?? false };
      }
      return todo;
    });
  };
  const readOnlyList = async (file, args, expected) => {
    const before = await snapshot(file);
    assert.deepEqual(success(invoke(file, ['list', ...args], true)), withPriority(expected));
    assert.deepEqual(await snapshot(file), before, 'list must preserve storage bytes/existence');
  };
  const rejected = async (file, args, exit, stderr) => {
    const before = await snapshot(file);
    const result = invoke(file, args, true);
    assert.equal(result.status, exit, `CLI exit ${result.status}; stderr: ${result.stderr}`);
    assert.equal(result.stdout, '', 'rejected command must have empty stdout');
    assert.match(result.stderr, stderr);
    assert.deepEqual(await snapshot(file), before, 'rejected command must preserve storage');
  };
  const persisted = async (file) => JSON.parse(await fs.readFile(file, 'utf8')).todos;
  try {
    workspace = await fs.realpath(workspace);
    evidence.product = { root: workspace, sha256: await productCandidateIdentity(workspace) };
    await check('list-storage', 'list: JSON lines, ID order, legacy compatibility and read-only storage', async () => {
      await readOnlyList(await store(mixed), [], sorted);
      await readOnlyList(await store([]), [], []);
      await readOnlyList(await store(), [], []);
    });
    if (caseId === 'A') {
      await check('list-filters', 'list: completed/pending subsets and relative order', async () => {
        const file = await store(mixed);
        await readOnlyList(file, ['--completed'], sorted.filter((todo) => todo.completed));
        await readOnlyList(file, ['--pending'], sorted.filter((todo) => !todo.completed));
      });
      await check('list-empty', 'list: empty, missing and no-match filters succeed without writes', async () => {
        for (const todos of [[], undefined, [mixed[0]], [mixed[1]]]) {
          const file = await store(todos);
          for (const flag of ['--completed', '--pending']) {
            await readOnlyList(file, [flag], (todos ?? []).filter((todo) => todo.completed === (flag === '--completed')));
          }
        }
      });
      await check('list-usage', 'list: conflicting and unknown flags are usage errors without writes', async () => {
        for (const todos of [mixed, undefined]) {
          const file = await store(todos);
          for (const args of [['--completed', '--pending'], ['--pending', '--completed'],
            ['--unknown'], ['--completed', '--unknown'], ['unexpected']]) {
            await rejected(file, ['list', ...args], 2, /^usage:/u);
          }
        }
      });
    }
    await check('add-complete', 'add/complete: JSON output, IDs, titles, persistence and list order', async () => {
      const file = await store(mixed);
      const added = withPriority([{ id: 8, title: 'nova tarefa café', completed: false }])[0];
      assert.deepEqual(success(invoke(file, ['add', 'nova', 'tarefa', 'café'])), [added]);
      assert.deepEqual(withPriority(await persisted(file)), [...withPriority(sorted), added]);
      await readOnlyList(file, [], [...sorted, added]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const completed = success(invoke(file, ['complete', '8']));
        assert.equal(completed.length, 1);
        assert.deepEqual(caseId === 'B' ? completed.map(({ priority, ...todo }) => todo) : completed,
          caseId === 'C' ? withPriority([{ id: 8, title: 'nova tarefa café', completed: true }])
            : [{ id: 8, title: 'nova tarefa café', completed: true }]);
        if (caseId === 'B' && completed[0].priority !== undefined) assert.equal(completed[0].priority, 'medium');
        assert.deepEqual(withPriority(await persisted(file)), [...withPriority(sorted), { ...added, completed: true }]);
      }
      await readOnlyList(file, [], [...sorted, { ...added, completed: true }]);
      const missing = await store();
      const first = withPriority([{ id: 1, title: 'primeira', completed: false }]);
      assert.deepEqual(success(invoke(missing, ['add', 'primeira'])), first);
      assert.deepEqual(withPriority(await persisted(missing)), first);
    });
    await check('existing-errors', 'compatibility: usage/domain errors retain codes, stderr and storage', async () => {
      const file = await store(mixed);
      for (const args of [['add'], ['complete'], ['complete', '2', '5'], ['unknown']]) {
        await rejected(file, args, 2, /^usage:/u);
      }
      if (caseId === 'B') await rejected(file, ['list', '--unknown'], 2, /^usage:/u);
      for (const args of [['add', '   '], ['complete', '0'], ['complete', 'no-id'], ['complete', '999']]) {
        await rejected(file, args, 1, /^error:/u);
      }
      const invalid = await store([]);
      await fs.writeFile(invalid, 'invalid JSON\n');
      await rejected(invalid, ['list'], 1, /^error:/u);
    });
    if (caseId === 'C') {
      await check('archive-list', 'archive: active/archive lists, JSON lines, relative ID order and read-only legacy', async () => {
        const todos = [mixed[0], { ...mixed[1], archived: true }, { ...mixed[2], archived: false }];
        const file = await store(todos);
        await readOnlyList(file, [], [todos[2], todos[0]]);
        await readOnlyList(file, ['--archived'], [todos[1]]);
        for (const initial of [undefined, [], [todos[1]], [todos[0]]]) {
          const empty = await store(initial);
          const ordered = [...(initial ?? [])].sort((a, b) => a.id - b.id);
          await readOnlyList(empty, [], ordered.filter(todo => !todo.archived));
          await readOnlyList(empty, ['--archived'], ordered.filter(todo => todo.archived));
        }
      });
      await check('archive-state', 'archive/unarchive: persisted state, completed preservation and idempotent returns', async () => {
        const file = await store(mixed);
        const expected = withPriority(sorted);
        for (const id of ['7', '2']) {
          const item = expected.find(todo => todo.id === Number(id));
          for (const command of ['archive', 'archive', 'unarchive', 'unarchive']) {
            item.archived = command === 'archive';
            assert.deepEqual(success(invoke(file, [command, id])), [item]);
            assert.deepEqual(withPriority(await persisted(file)), expected, 'archive retains all todos and completed states');
            await readOnlyList(file, [], expected.filter(todo => !todo.archived));
            await readOnlyList(file, ['--archived'], expected.filter(todo => todo.archived));
          }
        }
      });
      await check('archive-errors', 'archive: missing/invalid IDs and complete archived are domain errors without partial writes', async () => {
        const file = await store([{ ...mixed[0], archived: true }, mixed[1]]);
        for (const command of ['archive', 'unarchive']) {
          for (const id of ['0', 'not-an-id', '999']) {
            await rejected(file, [command, id], 1, /^error:.+/u);
          }
          await rejected(await store(), [command, '1'], 1, /^error:.+/u);
        }
        await rejected(file, ['complete', '7'], 1, /^error:.+/u);
        assert.deepEqual(success(invoke(file, ['complete', '2'])), withPriority([{ ...mixed[1], completed: true }]));
        assert.deepEqual(withPriority(await persisted(file)), withPriority([{ ...mixed[1], completed: true }, { ...mixed[0], archived: true }]));
      });
      await check('archive-usage', 'archive: wrong arity and list flags are usage errors without writes', async () => {
        for (const todos of [mixed, undefined]) {
          const file = await store(todos);
          for (const command of ['archive', 'unarchive']) {
            for (const args of [[], ['2', '7']]) await rejected(file, [command, ...args], 2, /^usage:/u);
          }
          for (const args of [['--unknown'], ['--completed'], ['--pending'], ['--archived', '--archived'], ['--archived', 'extra']]) {
            await rejected(file, ['list', ...args], 2, /^usage:/u);
          }
        }
      });
      await check('archive-compat', 'archive: add is active and complete preserves archive state', async () => {
        const file = await store([{ ...mixed[0], archived: true }]);
        const added = { id: 8, title: 'literal --archived', completed: false, archived: false };
        assert.deepEqual(success(invoke(file, ['add', 'literal', '--archived'])), [added]);
        await readOnlyList(file, [], [added]);
        assert.deepEqual(success(invoke(file, ['complete', '8'])), [{ ...added, completed: true }]);
        assert.deepEqual(withPriority(await persisted(file)), [{ ...mixed[0], archived: true }, { ...added, completed: true }]);
      });
    }
    if (caseId === 'B') {
      await check('priority-persist', 'priority: default and low/medium/high persist and remain observable', async () => {
        const file = await store([]);
        const expected = [];
        for (const priority of [undefined, 'low', 'medium', 'high']) {
          const title = `tarefa ${priority ?? 'default'}`;
          const todo = { id: expected.length + 1, title, completed: false, priority: priority ?? 'medium' };
          assert.deepEqual(success(invoke(file, ['add', ...(priority ? ['--priority', priority] : []), title])), [todo]);
          expected.push(todo);
          assert.deepEqual(await persisted(file), expected, 'new priority must be persisted, including default');
          await readOnlyList(file, [], expected);
        }
      });
      await check('priority-errors', 'priority: invalid value is domain error; missing value/title is usage error', async () => {
        for (const todos of [mixed, undefined]) {
          const file = await store(todos);
          await rejected(file, ['add', '--priority', 'urgent', 'tarefa'], 1, /^error:.*urgent/isu);
          for (const args of [['add', '--priority'], ['add', '--priority', 'high']]) {
            await rejected(file, args, 2, /^usage:/u);
          }
        }
      });
      await check('priority-legacy', 'priority: legacy reads do not rewrite; complete preserves old and explicit priority', async () => {
        const todos = [mixed[0], { ...mixed[1], priority: 'high' }, { ...mixed[2], priority: 'low' }];
        const expected = [...todos].sort((a, b) => a.id - b.id);
        const file = await store(todos);
        await readOnlyList(file, [], expected);
        for (const id of ['7', '2', '5']) {
          const todo = expected.find((item) => item.id === Number(id));
          todo.completed = true;
          const output = success(invoke(file, ['complete', id]));
          assert.equal(output.length, 1);
          assert.deepEqual(output.map(({ priority, ...item }) => item), [{ id: todo.id, title: todo.title, completed: true }]);
          if (output[0].priority !== undefined) assert.equal(output[0].priority, todo.priority ?? 'medium');
          const saved = await persisted(file);
          assert.deepEqual(withPriority(saved), withPriority(expected));
          for (const explicit of expected.filter((item) => item.priority)) {
            assert.equal(saved.find((item) => item.id === explicit.id).priority, explicit.priority);
          }
          await readOnlyList(file, [], expected);
        }
      });
      await check('priority-literal', 'priority: existing title arguments stay literal after first title token', async () => {
        const file = await store([]);
        const todo = { id: 1, title: 'literal --priority high', completed: false, priority: 'medium' };
        assert.deepEqual(success(invoke(file, ['add', 'literal', '--priority', 'high'])), [todo]);
        assert.deepEqual(await persisted(file), [todo]);
      });
    }
    if (caseId === 'B' || caseId === 'C') {
      await check('dependencies', 'dependencies: no declared external dependencies', async () => {
        const pkg = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          assert.equal(Object.keys(pkg[field] ?? {}).length, 0, `${field} must remain empty`);
        }
      });
    }
    if (evidence.product.sha256 !== await productCandidateIdentity(workspace)) {
      throw Object.assign(new Error('candidate changed during product verification'), { code: 'PRODUCT_STATE_DRIFT' });
    }
    evidence.passed = true;
  } catch (error) {
    evidence.failedCheck = currentCheck;
    evidence.diagnostic = String(error.message).slice(0, 8192);
    evidence.errorCode = typeof error.code === 'string' ? error.code : null;
  } finally {
    if (evidence.instrumentSha256 !== productInstrumentIdentity()) {
      evidence.passed = false; evidence.failedCheck = 'instrument integrity';
      evidence.diagnostic = 'product oracle/observer changed during verification'; evidence.errorCode = 'INSTRUMENT_DRIFT';
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return evidence;
}
