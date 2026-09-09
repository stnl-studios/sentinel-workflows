import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { parseStrictJson } from "./strict-json.mjs";

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export const DEFAULT_REFINEMENT_PATH = "docs/refinement";
export const MODEL_FILENAME = "refinement.json";
export const HTML_FILENAME = "index.html";
export const MAX_MODEL_BYTES = 3_000_000;

const SECRET_PATH_NAMES = new Set([
  ".env", ".npmrc", ".pypirc", "credentials", "credentials.json", "id_rsa", "id_ed25519",
  "cookies", "cookies.json", "secrets", "secrets.json",
]);
const REPOSITORY_METADATA_NAMES = new Set([".git", ".hg", ".svn", "cvs"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function isIgnoredMetadata(name) {
  return name === ".DS_Store" || name === "__MACOSX" || name === "Thumbs.db"
    || name.toLowerCase() === "desktop.ini" || name.startsWith("._");
}

export async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

export async function assertNoSymlinkComponents(filePath, label) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstatOrNull(current);
    if (metadata === null) break;
    if (metadata.isSymbolicLink()) {
      const allowedDarwinAlias = process.platform === "darwin" && ["/etc", "/tmp", "/var"].includes(current);
      if (!allowedDarwinAlias) throw new ValidationError(`${label} contains a symlink component: ${current}`);
    }
  }
}

export function isCanonicalPhysicalAlias(requested, physical) {
  if (requested === physical) return true;
  if (process.platform !== "darwin") return false;
  return ["/etc", "/tmp", "/var"].some((prefix) => (
    (requested === prefix || requested.startsWith(`${prefix}/`)) && physical === `/private${requested}`
  ));
}

export function filesystemKey(value) {
  return String(value).normalize("NFC").toLocaleLowerCase("en-US");
}

export function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("//")) {
    throw new ValidationError(`${label} must be a non-empty repository-relative POSIX path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || isIgnoredMetadata(segment))) {
    throw new ValidationError(`${label} contains a forbidden path segment`);
  }
  for (const segment of segments) {
    const lower = filesystemKey(segment);
    if (SECRET_PATH_NAMES.has(lower) || lower.startsWith(".env.") || lower.endsWith(".pem") || lower.endsWith(".key")) {
      throw new ValidationError(`${label} identifies a secret-bearing path`);
    }
    if (REPOSITORY_METADATA_NAMES.has(lower)) throw new ValidationError(`${label} identifies repository metadata`);
  }
  return segments.join("/");
}

export async function resolveProjectRoot(value) {
  const requested = path.resolve(String(value));
  await assertNoSymlinkComponents(requested, "PROJECT_ROOT");
  const metadata = await lstatOrNull(requested);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ValidationError(`PROJECT_ROOT must be an existing real directory: ${requested}`);
  }
  const physical = await fs.realpath(requested);
  if (!isCanonicalPhysicalAlias(requested, physical)) {
    throw new ValidationError(`PROJECT_ROOT must use its canonical physical path: ${requested}`);
  }
  return physical;
}

export async function resolveInsideProject(projectRoot, relativeValue, label) {
  const relative = normalizeRelativePath(relativeValue, label);
  const absolute = path.resolve(projectRoot, ...relative.split("/"));
  const boundary = path.relative(projectRoot, absolute);
  if (boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    throw new ValidationError(`${label} escapes PROJECT_ROOT`);
  }
  await assertNoSymlinkComponents(absolute, label);
  const metadata = await lstatOrNull(absolute);
  if (metadata !== null) {
    const physical = await fs.realpath(absolute);
    if (!isCanonicalPhysicalAlias(absolute, physical)) throw new ValidationError(`${label} is not a canonical physical path`);
  }
  return { relative, absolute, metadata };
}

export async function resolveRefinement(projectRootValue, refinementPathValue = DEFAULT_REFINEMENT_PATH) {
  const projectRoot = await resolveProjectRoot(projectRootValue);
  const refinementPath = normalizeRelativePath(refinementPathValue || DEFAULT_REFINEMENT_PATH, "REFINEMENT_PATH");
  const resolved = await resolveInsideProject(projectRoot, refinementPath, "REFINEMENT_PATH");
  return {
    projectRoot,
    refinementPath,
    refinementRoot: resolved.absolute,
    refinementMetadata: resolved.metadata,
    modelPath: path.join(resolved.absolute, MODEL_FILENAME),
    htmlPath: path.join(resolved.absolute, HTML_FILENAME),
  };
}

export async function requireSingleLinkRealFile(filePath, label, maximumBytes = MAX_MODEL_BYTES) {
  await assertNoSymlinkComponents(filePath, label);
  const metadata = await lstatOrNull(filePath);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new ValidationError(`${label} must be a single-link real file: ${filePath}`);
  }
  if (metadata.size > maximumBytes) throw new ValidationError(`${label} exceeds the ${maximumBytes} byte safety limit`);
  if (!isCanonicalPhysicalAlias(path.resolve(filePath), await fs.realpath(filePath))) {
    throw new ValidationError(`${label} contains a non-canonical physical component`);
  }
  return metadata;
}

export function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new ValidationError(`${label} must contain valid UTF-8`);
  }
}

export async function readStrictJsonFile(filePath, label = "refinement model") {
  await requireSingleLinkRealFile(filePath, label);
  const source = decodeUtf8(await fs.readFile(filePath), label);
  try {
    return {
      source,
      value: parseStrictJson(
        source,
        (key) => `${label} contains duplicate JSON key '${key}'`,
        (constant) => `${label} contains unsupported JSON constant '${constant}'`,
      ),
    };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`${label} is invalid JSON: ${error.message}`);
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formattedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
