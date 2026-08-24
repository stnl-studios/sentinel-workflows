import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { unicodeCaseFold } from './unicode-casefold.mjs';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function fail(message, location = null) {
  throw new ValidationError(location === null ? message : `${location}: ${message}`);
}

export function expandUser(value) {
  const input = String(value);
  if (input === '~') return os.homedir();
  if (input.startsWith(`~${path.sep}`) || (path.sep === '\\' && input.startsWith('~/'))) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function requestedPartsContainTraversal(value) {
  const normalized = String(value).replaceAll('\\', '/');
  return normalized.split('/').includes('..');
}

export function filesystemComponentKey(component) {
  return unicodeCaseFold(component);
}

export function lstatOrNull(value, options = undefined) {
  try {
    return fs.lstatSync(value, options);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function lexists(value) {
  return lstatOrNull(value) !== null;
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function canonicalExistingComponent(parent, name, metadata) {
  const key = filesystemComponentKey(name);
  const matches = [];
  let entries;
  try {
    entries = fs.readdirSync(parent);
  } catch (error) {
    fail(`cannot canonicalize existing path component ${path.join(parent, name)}: ${error.message}`);
  }
  for (const entry of entries) {
    if (filesystemComponentKey(entry) !== key) continue;
    const entryPath = path.join(parent, entry);
    const entryMetadata = lstatOrNull(entryPath);
    if (entryMetadata === null || !sameIdentity(entryMetadata, metadata)) continue;
    if (entry === name) return name;
    matches.push(entry);
  }
  if (matches.length !== 1) {
    fail(`cannot uniquely canonicalize existing path component ${path.join(parent, name)}`);
  }
  return matches[0];
}

export function canonicalPathWithoutSymlinks(value, label) {
  const requested = expandUser(value);
  if (requestedPartsContainTraversal(requested)) fail(`${label} must not contain path traversal`);
  const absolute = path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(requested);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const remainder = absolute.slice(parsed.root.length);
  const parts = remainder.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const candidate = path.join(current, part);
    const metadata = lstatOrNull(candidate);
    if (metadata === null) return path.join(candidate, ...parts.slice(index + 1));
    if (metadata.isSymbolicLink()) {
      const trustedSystemAlias = current === parsed.root && process.platform !== 'win32' && metadata.uid === 0;
      if (!trustedSystemAlias) fail(`${label} must not contain symlink components: ${candidate}`);
      try {
        current = fs.realpathSync(candidate);
      } catch (error) {
        fail(`${label} contains an invalid system path alias: ${error.message}`);
      }
      continue;
    }
    current = path.join(current, canonicalExistingComponent(current, part, metadata));
  }
  return current;
}

export function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function isOsMetadata(value) {
  const parts = String(value).replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.some((part) => part === '.DS_Store' || part === '__MACOSX' || part.startsWith('._'));
}

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

export function decodeUtf8(buffer) {
  return fatalUtf8.decode(buffer);
}

export function readTextUtf8(file) {
  const metadata = lstatOrNull(file);
  if (metadata === null || !metadata.isFile()) fail('required file does not exist', file);
  return decodeUtf8(fs.readFileSync(file));
}

export function compareCodePoints(left, right) {
  const a = Array.from(String(left), (character) => character.codePointAt(0));
  const b = Array.from(String(right), (character) => character.codePointAt(0));
  const count = Math.min(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function sorted(values, key = (value) => value) {
  return [...values].sort((left, right) => compareCodePoints(key(left), key(right)));
}
