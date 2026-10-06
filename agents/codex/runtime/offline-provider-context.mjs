import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const OFFLINE_MARKER = 'sentinel-offline-provider-test-only-v1\n';
export const OFFLINE_AUTH = '{"offline_test_only":true}\n';
export const OFFLINE_PROVIDER = 'scripts/fixtures/offline-codex-provider.mjs';

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
  if (context.mode !== 'OFFLINE_TEST_ONLY' || typeof root !== 'string'
    || path.dirname(root) !== await fs.realpath('/tmp')
    || !path.basename(root).startsWith('stnl-offline-checkout-')
    || await fs.realpath(root) !== root || file !== path.join(root, '.offline-context.json')
    || home !== path.join(root, '.offline-home') || await fs.realpath(home) !== home
    || await fs.readFile(path.join(root, '.offline-owned'), 'utf8') !== OFFLINE_MARKER
    || !/^sha256:[a-f0-9]{64}$/u.test(providerSha256 ?? '')) invalid();
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
  return { ...context, file, provider };
}
