import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_ROOT = path.resolve(RUNTIME_ROOT, '..');
export const FIXTURES = path.join(SKILL_ROOT, 'examples', 'validator-fixtures');

export function temporary(t, prefix = 'stnl lifecycle node ') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

export function copyFixture(root, fixture, name = fixture) {
  const destination = path.join(root, name);
  fs.cpSync(path.join(FIXTURES, fixture), destination, { recursive: true, dereference: false, preserveTimestamps: true });
  return destination;
}

export function replace(file, before, after) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(before)) throw new Error(`fixture text not found: ${before}`);
  fs.writeFileSync(file, text.replace(before, after), 'utf8');
}

export function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const relative = path.relative(root, entry).split(path.sep).join('/');
      const metadata = fs.lstatSync(entry);
      if (metadata.isSymbolicLink()) entries.push([relative, 'symlink', fs.readlinkSync(entry)]);
      else if (metadata.isDirectory()) { entries.push([relative, 'directory', '']); visit(entry); }
      else entries.push([relative, 'file', fs.readFileSync(entry).toString('base64')]);
    }
  }
  visit(root);
  return entries;
}
