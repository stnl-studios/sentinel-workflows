import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { offlineProviderContext } from './offline-provider-context.mjs';

const PRIVATE_PARENT = path.join(os.homedir(), 'Library', 'Application Support');
const MAIN_AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const NODE_RUNTIME = path.dirname(process.execPath);
const OWNER = 'sentinel-codex-isolated-home-v1';

function tomlString(value) {
  return JSON.stringify(value);
}

export function isolatedEnvironment({ privateHome, shellHome, tmpdir, snapshot, workspace, candidates, offline = null }) {
  return {
    PATH: `${NODE_RUNTIME}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    CODEX_HOME: privateHome,
    HOME: shellHome,
    TMPDIR: tmpdir,
    STNL_CODEX_ADAPTER: path.join(snapshot, 'agents', 'codex', 'runtime'),
    STNL_RUNNER_ADAPTER: path.join(snapshot, 'agents', 'codex', 'runtime', 'validation-runner.mjs'),
    STNL_DISCOVERY_PATHS: JSON.stringify({ workspace, snapshot, candidates, tmpdir,
      skillsRoot: path.join(shellHome, '.agents', 'skills') }),
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    ...(offline === null ? {} : { STNL_OFFLINE_PROVIDER_CONTEXT: offline.file }),
  };
}

export function configText({ workspace }) {
  return `model_provider = "openai"
sandbox_mode = "danger-full-access"
approval_policy = "never"
web_search = "disabled"

[agents]
enabled = false

[features]
apps = false
plugins = false
remote_plugin = false
hooks = false
multi_agent = false
multi_agent_v2 = false
skill_search = false
browser_use = false
computer_use = false
in_app_browser = false
image_generation = false
code_mode = false

[projects.${tomlString(workspace)}]
trust_level = "trusted"
`;
}

async function copySkillBundle(snapshot, shellHome) {
  const source = path.join(snapshot, 'skills', 'workflows');
  const target = path.join(shellHome, '.agents', 'skills');
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('stnl-')) continue;
    await fs.cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      dereference: true,
      filter: (file) => !['.DS_Store', '__MACOSX'].includes(path.basename(file))
        && !path.basename(file).startsWith('._'),
    });
  }
  // This is the existing operational copy, discovered through Codex's native
  // HOME/.agents/skills root. Its authority remains the frozen snapshot.
  async function freeze(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await freeze(file);
      else await fs.chmod(file, (await fs.stat(file)).mode & 0o111 ? 0o555 : 0o444);
    }
    await fs.chmod(directory, 0o555);
  }
  await freeze(target);
  return target;
}

async function hashTree(root, { workflowBundle = false } = {}) {
  const hash = createHash('sha256').update('sentinel-skill-copy-v1\0');
  async function walk(directory, relative = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => !['.DS_Store', '__MACOSX'].includes(entry.name) && !entry.name.startsWith('._'))
      .filter((entry) => !workflowBundle || relative !== '' || (entry.isDirectory() && entry.name.startsWith('stnl-')))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      const full = path.join(directory, entry.name);
      const metadata = await fs.lstat(full);
      if (metadata.isSymbolicLink()) throw new Error('skill copy contains a symlink');
      if (metadata.isDirectory()) await walk(full, child);
      else if (metadata.isFile()) {
        const bytes = await fs.readFile(full);
        hash.update(child).update('\0').update(String(bytes.length)).update('\0').update(bytes);
      } else throw new Error('skill copy contains an unsupported entry');
    }
  }
  await walk(root);
  return `sha256:${hash.digest('hex')}`;
}

export async function prepareIsolatedHome({ runId, caseId, snapshot, workspace, candidates, tmpdir }, { authPath = MAIN_AUTH } = {}) {
  const offline = await offlineProviderContext(process.env, snapshot);
  if (offline && authPath !== path.join(offline.home, '.codex/auth.json')) throw new Error('offline bootstrap requires fictitious auth');
  if (!/^[a-z0-9][a-z0-9-]{7,}$/u.test(runId) || !/^[ABC]$/u.test(caseId)) {
    throw new Error('invalid isolated home identity');
  }
  for (const directory of [snapshot, workspace, candidates, tmpdir]) {
    if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) {
      throw new Error(`isolated home input is not a canonical directory: ${directory}`);
    }
  }
  const authMetadata = await fs.lstat(authPath);
  if (!authMetadata.isFile() || authMetadata.isSymbolicLink()) throw new Error('official ChatGPT cache is unavailable or unsafe');
  let privateHome;
  try {
    privateHome = await fs.mkdtemp(path.join(PRIVATE_PARENT, `sentinel-benchmark-${runId}-${caseId.toLowerCase()}-`));
  } catch (error) {
    // This fact is recorded only when creation itself failed, never after a partial setup.
    error.privateHomeNotCreated = true;
    throw error;
  }
  await fs.chmod(privateHome, 0o700);
  const shellHome = path.join(tmpdir, 'shell-home');
  const marker = { owner: OWNER, runId, caseId, nonce: randomUUID(), shellHome };
  await fs.writeFile(path.join(privateHome, '.sentinel-owned.json'), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await fs.mkdir(shellHome, { mode: 0o700 });
  await fs.copyFile(authPath, path.join(privateHome, 'auth.json'));
  await fs.chmod(path.join(privateHome, 'auth.json'), 0o600);
  const snapshotSkills = path.join(snapshot, 'skills', 'workflows');
  const snapshotSkillsSha256 = await hashTree(snapshotSkills, { workflowBundle: true });
  const skills = await copySkillBundle(snapshot, shellHome);
  if (await hashTree(skills) !== snapshotSkillsSha256) throw new Error('isolated skill copy does not match snapshot provenance');
  const config = configText({ privateHome, snapshot, workspace, candidates, tmpdir });
  await fs.writeFile(path.join(privateHome, 'config.toml'), config, { mode: 0o600 });
  const configSha256 = `sha256:${createHash('sha256').update(config).digest('hex')}`;
  return { privateHome, shellHome, snapshotSkillsSha256, skillsSha256: snapshotSkillsSha256, configSha256,
    env: isolatedEnvironment({ privateHome, shellHome, tmpdir, snapshot, workspace, candidates, offline }) };
}

export async function verifyIsolatedHome(home, { runCommand = spawnSync } = {}) {
  const config = await fs.readFile(path.join(home.privateHome, 'config.toml'));
  if (`sha256:${createHash('sha256').update(config).digest('hex')}` !== home.configSha256) {
    throw new Error('isolated Codex config changed');
  }
  const discovery = JSON.parse(home.env.STNL_DISCOVERY_PATHS);
  const offline = await offlineProviderContext(home.env, path.resolve(home.env.STNL_CODEX_ADAPTER, '../../..'));
  const environment = isolatedEnvironment({ privateHome: home.privateHome, shellHome: home.shellHome,
    tmpdir: home.env.TMPDIR, snapshot: path.resolve(home.env.STNL_CODEX_ADAPTER, '../../..'),
    workspace: discovery.workspace, candidates: discovery.candidates, offline });
  if (environment.STNL_DISCOVERY_PATHS !== home.env.STNL_DISCOVERY_PATHS) {
    throw new Error('isolated discovery paths changed');
  }
  if (await hashTree(path.join(environment.STNL_CODEX_ADAPTER, '../../../skills/workflows'), { workflowBundle: true })
      !== home.snapshotSkillsSha256
    || await hashTree(path.join(home.shellHome, '.agents', 'skills')) !== home.snapshotSkillsSha256) {
    throw new Error('isolated skills do not match snapshot provenance');
  }
  const executable = offline?.provider ?? 'codex';
  const login = runCommand(executable, ['login', 'status'], { env: environment, encoding: 'utf8', timeout: 30_000 });
  if (login.status !== 0 || `${login.stdout}${login.stderr}`.trim() !== 'Logged in using ChatGPT') {
    throw new Error('isolated Codex login is not ChatGPT');
  }
  const doctor = runCommand(executable, ['doctor', '--json'], { env: environment, encoding: 'utf8', timeout: 30_000 });
  if (doctor.status !== 0 || doctor.signal) {
    throw new Error(`isolated Codex doctor failed (exit: ${doctor.status ?? 'null'}, signal: ${doctor.signal ?? 'none'})`,
      { cause: doctor.error });
  }
  const report = JSON.parse(doctor.stdout);
  const auth = report.checks?.['auth.credentials']?.details;
  const provider = report.checks?.['config.load']?.details?.['model provider'];
  const sandbox = report.checks?.['sandbox.helpers']?.details;
  if (auth?.['stored auth mode'] !== 'chatgpt' || auth?.['stored API key'] !== 'false'
    || provider !== 'openai' || sandbox?.['filesystem sandbox'] !== 'unrestricted'
    || sandbox?.['network sandbox'] !== 'enabled' || sandbox?.['approval policy'] !== 'Never'
    || sandbox?.['denied-read rules'] !== '0' || sandbox?.['denied-read glob rules'] !== '0') {
    throw new Error('isolated Codex auth/provider/sandbox report does not match policy');
  }
  return { authMode: 'chatgpt', provider: 'openai', filesystemSandbox: 'unrestricted', sandboxMode: 'danger-full-access' };
}

async function assertOwnedHome(home, { runId, caseId }) {
  const canonical = await fs.realpath(home.privateHome);
  if (path.dirname(canonical) !== await fs.realpath(PRIVATE_PARENT)
    || !path.basename(canonical).startsWith(`sentinel-benchmark-${runId}-${caseId.toLowerCase()}-`)) {
    throw new Error('isolated home path is not owned');
  }
  const marker = JSON.parse(await fs.readFile(path.join(canonical, '.sentinel-owned.json'), 'utf8'));
  if (marker.owner !== OWNER || marker.runId !== runId || marker.caseId !== caseId
    || marker.shellHome !== home.shellHome || await fs.realpath(home.shellHome) !== home.shellHome) {
    throw new Error('isolated home marker does not match');
  }
  return canonical;
}

export async function suspendIsolatedHome(home, identity, { runCommand = spawnSync } = {}) {
  const canonical = await assertOwnedHome(home, identity);
  if (await hashTree(path.join(home.shellHome, '.agents', 'skills')) !== home.snapshotSkillsSha256) {
    throw new Error('isolated skills do not match snapshot provenance');
  }
  const auth = path.join(canonical, 'auth.json');
  const metadata = await fs.lstat(auth);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('isolated auth cache is unsafe');
  await fs.unlink(auth);
  const offline = await offlineProviderContext(home.env, path.resolve(home.env.STNL_CODEX_ADAPTER, '../../..'));
  const login = runCommand(offline?.provider ?? 'codex', ['login', 'status'], { env: home.env, encoding: 'utf8', timeout: 30_000 });
  if (login.status === 0 && `${login.stdout}${login.stderr}`.includes('Logged in using ChatGPT')) {
    throw new Error('suspended isolated home still has ChatGPT authentication');
  }
  return { privateHome: canonical, shellHome: home.shellHome,
    snapshotSkillsSha256: home.snapshotSkillsSha256 ?? home.skillsSha256,
    skillsSha256: home.snapshotSkillsSha256 ?? home.skillsSha256, configSha256: home.configSha256 };
}

export async function resumeIsolatedHome({ runId, caseId, snapshot, workspace, candidates, tmpdir, suspended }, { authPath: sourceAuth = MAIN_AUTH } = {}) {
  const offline = await offlineProviderContext(process.env, snapshot);
  if (offline && sourceAuth !== path.join(offline.home, '.codex/auth.json')) throw new Error('offline bootstrap requires fictitious auth');
  if (!suspended || typeof suspended.configSha256 !== 'string'
    || typeof (suspended.snapshotSkillsSha256 ?? suspended.skillsSha256) !== 'string') {
    throw new Error('suspended isolated home metadata is invalid');
  }
  const canonical = await assertOwnedHome(suspended, { runId, caseId });
  if (suspended.shellHome !== path.join(tmpdir, 'shell-home')) throw new Error('suspended shell home is invalid');
  const authPath = path.join(canonical, 'auth.json');
  if (await fs.lstat(authPath).catch(() => null)) throw new Error('suspended home still contains authentication');
  const expectedConfig = configText({ privateHome: canonical, snapshot, workspace, candidates, tmpdir });
  const expectedHash = `sha256:${createHash('sha256').update(expectedConfig).digest('hex')}`;
  if (suspended.configSha256 !== expectedHash
    || await fs.readFile(path.join(canonical, 'config.toml'), 'utf8') !== expectedConfig
    || await hashTree(path.join(snapshot, 'skills', 'workflows'), { workflowBundle: true })
      !== (suspended.snapshotSkillsSha256 ?? suspended.skillsSha256)
    || await hashTree(path.join(suspended.shellHome, '.agents', 'skills'))
      !== (suspended.snapshotSkillsSha256 ?? suspended.skillsSha256)) {
    throw new Error('suspended isolated home changed');
  }
  const metadata = await fs.lstat(sourceAuth);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('official ChatGPT cache is unavailable or unsafe');
  await fs.copyFile(sourceAuth, authPath);
  await fs.chmod(authPath, 0o600);
  return { ...suspended, snapshotSkillsSha256: suspended.snapshotSkillsSha256 ?? suspended.skillsSha256,
    skillsSha256: suspended.snapshotSkillsSha256 ?? suspended.skillsSha256, privateHome: canonical,
    env: isolatedEnvironment({ privateHome: canonical, shellHome: suspended.shellHome,
      tmpdir, snapshot, workspace, candidates, offline }) };
}

export async function removeIsolatedHome(home, identity) {
  const canonical = await assertOwnedHome(home, identity);
  async function makeDirectoriesRemovable(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeDirectoriesRemovable(path.join(directory, entry.name));
    }
    await fs.chmod(directory, 0o700);
  }
  await makeDirectoriesRemovable(canonical);
  await makeDirectoriesRemovable(home.shellHome);
  await fs.rm(home.shellHome, { recursive: true });
  await fs.rm(canonical, { recursive: true });
}
