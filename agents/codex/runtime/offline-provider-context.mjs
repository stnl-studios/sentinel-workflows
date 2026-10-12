import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const OFFLINE_MARKER = 'sentinel-offline-provider-test-only-v1\n';
export const OFFLINE_AUTH = '{"offline_test_only":true}\n';
export const OFFLINE_PROVIDER = 'scripts/fixtures/offline-codex-provider.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// The pinned SDK is bundled into one ESM entrypoint with only Node imports.
// Its CLI package is identified as an input; the offline override never loads
// the native binary. No shared path is copied, chmodded or cleaned here.
export async function describeOfflineSdk(dependencyRoot, fixtureRoot) {
  if (typeof dependencyRoot !== 'string' || !path.isAbsolute(dependencyRoot)
    || await fs.realpath(dependencyRoot) !== dependencyRoot
    || !(await fs.lstat(dependencyRoot)).isDirectory()
    || typeof fixtureRoot !== 'string' || await fs.realpath(fixtureRoot) !== fixtureRoot) {
    throw new Error('offline shared SDK roots are not canonical');
  }
  const files = [];
  async function inspect(relative) {
    const file = path.join(dependencyRoot, relative);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) {
      throw new Error(`offline shared SDK input is not a physical file: ${relative}`);
    }
    const bytes = await fs.readFile(file);
    files.push({ path: relative, device: stat.dev, inode: stat.ino, bytes: bytes.length, sha256: digest(bytes) });
    return bytes;
  }
  const sdk = JSON.parse(await inspect('@openai/codex-sdk/package.json'));
  const cli = JSON.parse(await inspect('@openai/codex/package.json'));
  if (sdk.name !== '@openai/codex-sdk' || cli.name !== '@openai/codex'
    || sdk.version !== '0.160.0' || cli.version !== '0.160.0'
    || sdk.type !== 'module' || sdk.exports?.['.']?.import !== './dist/index.js'
    || sdk.dependencies?.['@openai/codex'] !== cli.version || cli.bin?.codex !== 'bin/codex.js') {
    throw new Error('offline shared SDK/CLI identity differs from the pinned adapter');
  }
  await inspect('@openai/codex-sdk/dist/index.js');
  await inspect('@openai/codex/bin/codex.js');
  return { mode: 'shared-readonly', fixtureRoot, dependencyRoot,
    package: sdk.name, sdkVersion: sdk.version, cliPackage: cli.name, cliVersion: cli.version,
    entrypoint: path.join(dependencyRoot, '@openai/codex-sdk/dist/index.js'), files };
}

export async function assertOfflineSdk(descriptor, fixtureRoot) {
  if (!descriptor || descriptor.fixtureRoot !== fixtureRoot || descriptor.mode !== 'shared-readonly') {
    throw new Error('offline shared SDK fixture binding is invalid');
  }
  const current = await describeOfflineSdk(descriptor.dependencyRoot, fixtureRoot);
  if (JSON.stringify(current) !== JSON.stringify(descriptor)) throw new Error('offline shared SDK integrity changed');
  return descriptor;
}

// This is a test seam, never an alternate production authentication route.
// Read only explicitly named files in the owned disposable checkout.
export async function offlineProviderContext(environment = process.env, snapshot = null) {
  const file = environment.STNL_OFFLINE_PROVIDER_CONTEXT;
  if (file === undefined) return null;
  const invalid = () => { throw new Error('invalid owned TEST-ONLY offline provider context'); };
  if (typeof file !== 'string' || !path.isAbsolute(file) || await fs.realpath(file) !== file) invalid();
  const metadata = await fs.lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) invalid();
  const context = JSON.parse(await fs.readFile(file, 'utf8'));
  const { root, home, providerSha256 } = context;
  const allocationParent=context.allocationParent ?? await fs.realpath('/tmp');
  if(typeof allocationParent!=='string' || !path.isAbsolute(allocationParent) || await fs.realpath(allocationParent)!==allocationParent) invalid();
  if (context.mode !== 'OFFLINE_TEST_ONLY' || typeof root !== 'string'
    || path.dirname(root) !== allocationParent
    || !path.basename(root).startsWith('stnl-offline-checkout-')
    || await fs.realpath(root) !== root || file !== path.join(root, '.offline-context.json')
    || home !== path.join(root, '.offline-home') || await fs.realpath(home) !== home
    || await fs.readFile(path.join(root, '.offline-owned'), 'utf8') !== OFFLINE_MARKER
    || !/^sha256:[a-f0-9]{64}$/u.test(providerSha256 ?? '')) invalid();
  if(context.allocationParent!==undefined) {
    const ownerFile=path.join(root,'.offline-fixture-owner.json');const ownerMeta=await fs.lstat(ownerFile);
    if(!ownerMeta.isFile()||ownerMeta.isSymbolicLink()||ownerMeta.nlink!==1) invalid();
    const owner=JSON.parse(await fs.readFile(ownerFile,'utf8'));
    if(owner.root!==root || owner.inode!==(await fs.lstat(root)).ino || !/^[a-f0-9-]{36}$/u.test(owner.id) || !Number.isSafeInteger(owner.pid)) invalid();
  }
  const auth = path.join(home, '.codex/auth.json');
  const authMetadata = await fs.lstat(auth);
  if (!authMetadata.isFile() || authMetadata.isSymbolicLink() || authMetadata.nlink !== 1
    || await fs.realpath(auth) !== auth || await fs.readFile(auth, 'utf8') !== OFFLINE_AUTH) invalid();
  // Child turns have their own HOME. Their frozen snapshot must still belong
  // to the disposable harness, and the provider bytes must match its manifest.
  if (snapshot !== null && (!snapshot.startsWith(`${root}/benchmark-temp/`)
    || await fs.realpath(snapshot) !== snapshot)) invalid();
  if (snapshot === null && environment.HOME !== home) invalid();
  const provider = path.join(snapshot ?? root, OFFLINE_PROVIDER);
  const providerMetadata = await fs.lstat(provider);
  if (!providerMetadata.isFile() || providerMetadata.isSymbolicLink() || providerMetadata.nlink !== 1
    || await fs.realpath(provider) !== provider
    || `sha256:${createHash('sha256').update(await fs.readFile(provider)).digest('hex')}` !== providerSha256) invalid();
  await assertOfflineSdk(context.sdk, root);
  if (snapshot !== null) {
    const snapshotMetadata = JSON.parse(await fs.readFile(path.join(path.dirname(snapshot), 'snapshot.json'), 'utf8'));
    if (snapshotMetadata.executionMode !== 'OFFLINE_TEST_ONLY'
      || JSON.stringify(snapshotMetadata.externalSdk) !== JSON.stringify(context.sdk)) invalid();
  }
  return { ...context, file, provider };
}
