import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PRIVATE_PARENT = path.join(os.homedir(), 'Library', 'Application Support');
const MAIN_AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const NODE_RUNTIME = path.dirname(process.execPath);
const OWNER = 'sentinel-codex-isolated-home-v1';

function tomlString(value) {
  return JSON.stringify(value);
}

function childEnvironment({ privateHome, shellHome, tmpdir, snapshot }) {
  return {
    PATH: `${NODE_RUNTIME}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    CODEX_HOME: privateHome,
    HOME: shellHome,
    TMPDIR: tmpdir,
    STNL_CODEX_ADAPTER: path.join(snapshot, 'agents', 'codex', 'runtime'),
    STNL_RUNNER_ADAPTER: path.join(snapshot, 'agents', 'codex', 'runtime', 'validation-runner.mjs'),
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
  };
}

function configText({ privateHome, snapshot, workspace, candidates, tmpdir }) {
  const nodeVersion = path.dirname(NODE_RUNTIME);
  return `model_provider = "openai"
default_permissions = "sentinel-case"
approval_policy = "never"
web_search = "disabled"

[features]
apps = false
plugins = false
remote_plugin = false
hooks = false
multi_agent = false
skill_search = false
browser_use = false
computer_use = false
in_app_browser = false
image_generation = false
code_mode = false

[permissions.sentinel-case]
extends = ":workspace"

[permissions.sentinel-case.filesystem]
":root" = "deny"
":minimal" = "read"
":slash_tmp" = "deny"
${tomlString(path.join(os.homedir(), '.codex'))} = "deny"
${tomlString(privateHome)} = "deny"
${tomlString(path.join(privateHome, 'skills'))} = "read"
${tomlString('/private/var/tmp')} = "deny"
${tomlString('/System/Library/OpenSSL')} = "read"
${tomlString(nodeVersion)} = "read"
${tomlString(snapshot)} = "read"
${tomlString(candidates)} = "write"
${tomlString(tmpdir)} = "write"

[permissions.sentinel-case.filesystem.":workspace_roots"]
"." = "write"

[projects.${tomlString(workspace)}]
trust_level = "trusted"
`;
}

async function copySkillBundle(snapshot, privateHome) {
  const source = path.join(snapshot, 'skills', 'workflows');
  const target = path.join(privateHome, 'skills');
  await fs.mkdir(target);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('stnl-')) continue;
    await fs.cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      dereference: true,
      filter: (file) => !['.DS_Store', '__MACOSX'].includes(path.basename(file))
        && !path.basename(file).startsWith('._'),
    });
  }
  return target;
}

async function hashTree(root) {
  const hash = createHash('sha256').update('sentinel-skill-copy-v1\0');
  async function walk(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
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

async function freezeSkills(root) {
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) await fs.chmod(full, (await fs.stat(full)).mode & 0o111 ? 0o555 : 0o444);
      else throw new Error('skill copy contains an unsafe entry');
    }
    await fs.chmod(directory, 0o555);
  }
  await walk(root);
}

export async function prepareIsolatedHome({ runId, caseId, snapshot, workspace, candidates, tmpdir }) {
  if (!/^[a-z0-9][a-z0-9-]{7,}$/u.test(runId) || !/^[ABC]$/u.test(caseId)) {
    throw new Error('invalid isolated home identity');
  }
  for (const directory of [snapshot, workspace, candidates, tmpdir]) {
    if (await fs.realpath(directory) !== directory || !(await fs.lstat(directory)).isDirectory()) {
      throw new Error(`isolated home input is not a canonical directory: ${directory}`);
    }
  }
  const authMetadata = await fs.lstat(MAIN_AUTH);
  if (!authMetadata.isFile() || authMetadata.isSymbolicLink()) throw new Error('official ChatGPT cache is unavailable or unsafe');
  const privateHome = await fs.mkdtemp(path.join(PRIVATE_PARENT, `sentinel-benchmark-${runId}-${caseId.toLowerCase()}-`));
  await fs.chmod(privateHome, 0o700);
  const marker = { owner: OWNER, runId, caseId, nonce: randomUUID() };
  await fs.writeFile(path.join(privateHome, '.sentinel-owned.json'), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  const shellHome = path.join(privateHome, 'shell-home');
  await fs.mkdir(shellHome, { mode: 0o700 });
  await fs.copyFile(MAIN_AUTH, path.join(privateHome, 'auth.json'));
  await fs.chmod(path.join(privateHome, 'auth.json'), 0o600);
  const skills = await copySkillBundle(snapshot, privateHome);
  const skillsSha256 = await hashTree(skills);
  await freezeSkills(skills);
  const config = configText({ privateHome, snapshot, workspace, candidates, tmpdir });
  await fs.writeFile(path.join(privateHome, 'config.toml'), config, { mode: 0o600 });
  const configSha256 = `sha256:${createHash('sha256').update(config).digest('hex')}`;
  return { privateHome, shellHome, skillsSha256, configSha256,
    env: childEnvironment({ privateHome, shellHome, tmpdir, snapshot }) };
}

export async function verifyIsolatedHome(home) {
  const config = await fs.readFile(path.join(home.privateHome, 'config.toml'));
  if (`sha256:${createHash('sha256').update(config).digest('hex')}` !== home.configSha256) {
    throw new Error('isolated Codex config changed');
  }
  if (await hashTree(path.join(home.privateHome, 'skills')) !== home.skillsSha256) {
    throw new Error('isolated skill bundle changed');
  }
  const environment = childEnvironment({ privateHome: home.privateHome, shellHome: home.shellHome, tmpdir: home.env.TMPDIR,
    snapshot: path.resolve(home.env.STNL_CODEX_ADAPTER, '../../..') });
  const login = spawnSync('codex', ['login', 'status'], { env: environment, encoding: 'utf8', timeout: 30_000 });
  if (login.status !== 0 || `${login.stdout}${login.stderr}`.trim() !== 'Logged in using ChatGPT') {
    throw new Error('isolated Codex login is not ChatGPT');
  }
  const doctor = spawnSync('codex', ['doctor', '--json'], { env: environment, encoding: 'utf8', timeout: 30_000 });
  const report = JSON.parse(doctor.stdout);
  const auth = report.checks?.['auth.credentials']?.details;
  const provider = report.checks?.['config.load']?.details?.['model provider'];
  const sandbox = report.checks?.['sandbox.helpers']?.details;
  if (auth?.['stored auth mode'] !== 'chatgpt' || auth?.['stored API key'] !== 'false'
    || provider !== 'openai' || sandbox?.['filesystem sandbox'] !== 'restricted') {
    throw new Error('isolated Codex auth/provider/sandbox report does not match policy');
  }
  return { authMode: 'chatgpt', provider: 'openai', filesystemSandbox: 'restricted' };
}

async function assertOwnedHome(home, { runId, caseId }) {
  const canonical = await fs.realpath(home.privateHome);
  if (path.dirname(canonical) !== await fs.realpath(PRIVATE_PARENT)
    || !path.basename(canonical).startsWith(`sentinel-benchmark-${runId}-${caseId.toLowerCase()}-`)) {
    throw new Error('isolated home path is not owned');
  }
  const marker = JSON.parse(await fs.readFile(path.join(canonical, '.sentinel-owned.json'), 'utf8'));
  if (marker.owner !== OWNER || marker.runId !== runId || marker.caseId !== caseId) {
    throw new Error('isolated home marker does not match');
  }
  return canonical;
}

export async function suspendIsolatedHome(home, identity) {
  const canonical = await assertOwnedHome(home, identity);
  const auth = path.join(canonical, 'auth.json');
  const metadata = await fs.lstat(auth);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('isolated auth cache is unsafe');
  await fs.unlink(auth);
  const login = spawnSync('codex', ['login', 'status'], { env: home.env, encoding: 'utf8', timeout: 30_000 });
  if (login.status === 0 && `${login.stdout}${login.stderr}`.includes('Logged in using ChatGPT')) {
    throw new Error('suspended isolated home still has ChatGPT authentication');
  }
  return { privateHome: canonical, shellHome: home.shellHome,
    skillsSha256: home.skillsSha256, configSha256: home.configSha256 };
}

export async function resumeIsolatedHome({ runId, caseId, snapshot, workspace, candidates, tmpdir, suspended }) {
  if (!suspended || typeof suspended.configSha256 !== 'string' || typeof suspended.skillsSha256 !== 'string') {
    throw new Error('suspended isolated home metadata is invalid');
  }
  const canonical = await assertOwnedHome(suspended, { runId, caseId });
  if (suspended.shellHome !== path.join(canonical, 'shell-home')) throw new Error('suspended shell home is invalid');
  const authPath = path.join(canonical, 'auth.json');
  if (await fs.lstat(authPath).catch(() => null)) throw new Error('suspended home still contains authentication');
  const expectedConfig = configText({ privateHome: canonical, snapshot, workspace, candidates, tmpdir });
  const expectedHash = `sha256:${createHash('sha256').update(expectedConfig).digest('hex')}`;
  if (suspended.configSha256 !== expectedHash
    || await fs.readFile(path.join(canonical, 'config.toml'), 'utf8') !== expectedConfig
    || await hashTree(path.join(canonical, 'skills')) !== suspended.skillsSha256) {
    throw new Error('suspended isolated home changed');
  }
  const metadata = await fs.lstat(MAIN_AUTH);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('official ChatGPT cache is unavailable or unsafe');
  await fs.copyFile(MAIN_AUTH, authPath);
  await fs.chmod(authPath, 0o600);
  return { ...suspended, privateHome: canonical,
    env: childEnvironment({ privateHome: canonical, shellHome: suspended.shellHome, tmpdir, snapshot }) };
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
  await fs.rm(canonical, { recursive: true });
}
