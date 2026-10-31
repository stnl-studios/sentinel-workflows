// Read-only compatibility gate over `codex app-server generate-json-schema`.
// A schema PASS proves shape, not server behavior or model execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function checkAppServerSchema(directory) {
  const files = [];
  async function read(name) {
    const bytes = await fs.readFile(path.join(directory, name));
    files.push({ path: name, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    return JSON.parse(bytes);
  }
  function expect(condition, message) {
    if (!condition) throw new Error(`APP_SERVER_SCHEMA_INCOMPATIBLE: ${message}`);
  }
  function properties(schema, names, label) {
    for (const name of names) expect(schema?.properties?.[name], `${label}.${name}`);
  }
  const requests = await read('ClientRequest.json');
  const methods = new Set(requests.oneOf.flatMap(value => value.properties?.method?.enum ?? []));
  for (const method of ['initialize', 'skills/extraRoots/set', 'skills/list', 'thread/start',
    'turn/start', 'thread/read', 'thread/turns/list', 'thread/items/list', 'experimentalFeature/list']) {
    expect(methods.has(method), `missing stable method ${method}`);
  }
  const roots = await read('v2/SkillsExtraRootsSetParams.json');
  expect(roots.required?.includes('extraRoots') && roots.properties?.extraRoots?.type === 'array', 'extraRoots');
  properties(await read('v2/SkillsListParams.json'), ['cwds', 'forceReload'], 'skills/list');
  const listing = await read('v2/SkillsListResponse.json');
  properties(listing.definitions?.SkillMetadata, ['name', 'path', 'enabled'], 'SkillMetadata');
  properties(listing.definitions?.SkillsListEntry, ['cwd', 'errors', 'skills'], 'SkillsListEntry');
  const history = await read('v2/ThreadReadResponse.json');
  properties(history.definitions?.Thread, ['id', 'parentThreadId', 'forkedFromId', 'cliVersion', 'cwd', 'agentRole', 'model', 'reasoningEffort', 'historyMode'], 'Thread');
  expect(history.definitions?.ThreadHistoryMode?.enum?.includes('paginated'), 'paginated history metadata');
  properties(history.definitions?.Turn, ['id', 'status', 'error', 'items', 'itemsView'], 'Turn');
  const variants = history.definitions?.ThreadItem?.oneOf;
  const variant = name => variants?.find(value => value.properties?.type?.enum?.includes(name));
  properties(variant('subAgentActivity'), ['agentThreadId', 'agentPath', 'kind', 'model', 'reasoningEffort'], 'subAgentActivity');
  properties(variant('agentMessage'), ['id', 'text', 'phase'], 'agentMessage');
  properties(variant('commandExecution'), ['command', 'cwd', 'status', 'exitCode', 'aggregatedOutput'], 'commandExecution');
  expect(history.definitions?.SubAgentActivityKind?.enum?.includes('started'), 'started activity kind');
  expect(history.definitions?.SubAgentActivityKind?.enum?.includes('completed'), 'completed activity kind');
  properties(await read('v2/ExperimentalFeatureListParams.json'), ['threadId','cursor','limit'], 'experimentalFeature/list');
  const featureResponse=await read('v2/ExperimentalFeatureListResponse.json');
  properties(featureResponse,['data','nextCursor'],'experimentalFeature/list response');
  properties(featureResponse.definitions?.ExperimentalFeature,['name','enabled'],'agent feature metadata');
  properties(await read('v2/ThreadItemsListParams.json'), ['threadId', 'turnId', 'cursor', 'sortDirection'], 'thread/items/list');
  properties(await read('v2/ThreadTurnsListParams.json'), ['threadId', 'itemsView', 'cursor'], 'thread/turns/list');
  for (const kind of ['Items', 'Turns']) {
    const response = await read(`v2/Thread${kind}ListResponse.json`);
    properties(response, ['data', 'nextCursor'], `Thread${kind}ListResponse`);
    if (kind === 'Items') {
      expect(response.properties.data.items?.$ref === '#/definitions/ThreadItemEntry', 'items data uses ThreadItemEntry');
      const entry = response.definitions?.ThreadItemEntry;
      properties(entry, ['turnId', 'item'], 'ThreadItemEntry');
      expect(entry.required?.includes('turnId') && entry.required?.includes('item')
        && entry.properties.turnId.type === 'string' && entry.properties.item.$ref === '#/definitions/ThreadItem',
      'scoped item envelope');
    }
  }
  const start = await read('v2/ThreadStartParams.json');
  properties(start, ['config', 'cwd', 'approvalPolicy', 'sandbox'], 'thread/start');
  const policies = start.definitions?.AskForApproval?.oneOf?.find(value => value.type === 'string')?.enum;
  expect(JSON.stringify(policies?.slice().sort()) === JSON.stringify(['never', 'on-request', 'untrusted']),
    'approval policy enums differ from the pinned adapter');
  expect(JSON.stringify(start.definitions?.SandboxMode?.enum?.slice().sort())
    === JSON.stringify(['danger-full-access', 'read-only', 'workspace-write']), 'sandbox policy enums differ');
  const turn = await read('v2/TurnStartParams.json');
  properties(turn, ['input', 'threadId', 'effort'], 'turn/start');
  const skill = turn.definitions?.UserInput?.oneOf?.find(value => value.properties?.type?.enum?.includes('skill'));
  properties(skill, ['name', 'path'], 'skill input');
  properties(await read('v1/InitializeResponse.json'), ['userAgent'], 'initialize response');
  return { status: 'PASS_SCHEMA_ONLY', publicTag: 'rust-v0.163.0', files };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/check-app-server-schema.mjs EXPORTED_SCHEMA_DIRECTORY');
    process.stdout.write(`${JSON.stringify(await checkAppServerSchema(process.argv[2]), null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
