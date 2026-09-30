import fs from 'node:fs/promises';
import path from 'node:path';

import {
  CATEGORIES,
  canonicalPathWithoutSymlinks,
  canonicalizeInitFilePurposeHeader,
} from './lifecycle.mjs';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function requireRegularSingleLink(metadata, file) {
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error(`INIT candidate artifact must be a single-link regular file: ${file}`);
  }
}

async function candidateArtifacts(candidateRoot) {
  const feature = path.join(candidateRoot, 'feature_spec.md');
  const featureMetadata = await lstatOrNull(feature);
  requireRegularSingleLink(featureMetadata, feature);
  const files = [feature];

  const shared = path.join(candidateRoot, 'shared');
  const sharedMetadata = await lstatOrNull(shared);
  if (sharedMetadata !== null) {
    if (sharedMetadata.isSymbolicLink() || !sharedMetadata.isDirectory()) {
      throw new Error(`INIT candidate shared path must be a real directory: ${shared}`);
    }
    for (const category of CATEGORIES) {
      const file = path.join(shared, category.filename);
      const metadata = await lstatOrNull(file);
      if (metadata === null) continue;
      requireRegularSingleLink(metadata, file);
      files.push(file);
    }
  }
  return files;
}

function decodeUtf8(bytes, file) {
  try {
    return utf8.decode(bytes);
  } catch (error) {
    throw new Error(`INIT candidate artifact is not valid UTF-8: ${file} (${error.message})`);
  }
}

export async function prepareInitCandidate({ target, candidate }) {
  if (typeof target !== 'string' || target.length === 0) throw new Error('INIT target is required');
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error('INIT candidate is required');

  const targetPath = canonicalPathWithoutSymlinks(target, 'INIT target');
  if (await lstatOrNull(targetPath) !== null) throw new Error(`INIT destination must not exist: ${targetPath}`);

  const candidatePath = canonicalPathWithoutSymlinks(candidate, 'INIT candidate');
  const candidateMetadata = await lstatOrNull(candidatePath);
  if (candidateMetadata === null || candidateMetadata.isSymbolicLink() || !candidateMetadata.isDirectory()) {
    throw new Error(`INIT candidate must be a real directory: ${candidatePath}`);
  }
  if (inside(candidatePath, targetPath) || inside(targetPath, candidatePath)) {
    throw new Error('INIT candidate and destination must be disjoint');
  }

  const files = await candidateArtifacts(candidatePath);
  const staged = [];
  for (const file of files) {
    const canonicalFile = canonicalPathWithoutSymlinks(file, 'INIT candidate artifact');
    if (canonicalFile !== file) throw new Error(`INIT candidate artifact path is not canonical: ${file}`);
    const metadata = await fs.lstat(file);
    requireRegularSingleLink(metadata, file);
    const originalBytes = await fs.readFile(file);
    const originalText = decodeUtf8(originalBytes, file);
    const candidateText = canonicalizeInitFilePurposeHeader(originalText, file);
    if (candidateText !== originalText) {
      staged.push({ file, metadata, originalBytes, candidateBytes: Buffer.from(candidateText, 'utf8') });
    }
  }

  if (staged.length === 0) return { candidate: candidatePath, changedFiles: [] };

  const handles = [];
  try {
    for (const item of staged) {
      const handle = await fs.open(item.file, 'r+');
      handles.push({ ...item, handle });
      const openedMetadata = await handle.stat();
      const pathMetadata = await fs.lstat(item.file);
      if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.nlink !== 1
        || !sameIdentity(item.metadata, openedMetadata) || !sameIdentity(item.metadata, pathMetadata)) {
        throw new Error(`INIT candidate artifact changed identity before serialization: ${item.file}`);
      }
      const currentBytes = await handle.readFile();
      if (!currentBytes.equals(item.originalBytes)) {
        throw new Error(`INIT candidate artifact changed before serialization: ${item.file}`);
      }
    }

    for (const item of handles) {
      await item.handle.truncate(0);
      let offset = 0;
      while (offset < item.candidateBytes.length) {
        const result = await item.handle.write(
          item.candidateBytes,
          offset,
          item.candidateBytes.length - offset,
          offset,
        );
        if (result.bytesWritten <= 0) throw new Error(`could not serialize INIT candidate artifact: ${item.file}`);
        offset += result.bytesWritten;
      }
      await item.handle.truncate(item.candidateBytes.length);
      await item.handle.sync();
    }
  } finally {
    await Promise.all(handles.map(({ handle }) => handle.close().catch(() => {})));
  }

  return {
    candidate: candidatePath,
    changedFiles: staged.map(({ file }) => path.relative(candidatePath, file).split(path.sep).join('/')),
  };
}
