import * as fs from "node:fs/promises";

import {
  ValidationError,
  canonicalJson,
  requireSingleLinkRealFile,
  resolveInsideProject,
  sha256,
} from "./core.mjs";

const MAX_AUTHORITY_FILES = 500;
const MAX_AUTHORITY_BYTES = 25_000_000;

function authorityPaths(model) {
  const paths = new Map();
  for (const source of model.sources.filter((item) => item.path !== undefined)) {
    paths.set(source.path, `source:${source.id}`);
  }
  for (const evidence of model.evidence.filter((item) => item.kind === "REPOSITORY_OBSERVATION")) {
    if (!paths.has(evidence.path)) paths.set(evidence.path, `evidence:${evidence.id}`);
  }
  for (const file of model.exploration.files_read) {
    if (!paths.has(file)) paths.set(file, "exploration");
  }
  return [...paths.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
}

export async function snapshotAuthorityInputs(model, projectRoot) {
  const entries = [];
  let bytes = 0;
  const paths = authorityPaths(model);
  if (paths.length > MAX_AUTHORITY_FILES) throw new ValidationError("authority snapshot exceeds its bounded file limit");
  for (const [relative, role] of paths) {
    const resolved = await resolveInsideProject(projectRoot, relative, `${role} authority path`);
    const metadata = await requireSingleLinkRealFile(resolved.absolute, `${role} authority`, 5_000_000);
    bytes += metadata.size;
    if (bytes > MAX_AUTHORITY_BYTES) throw new ValidationError("authority snapshot exceeds its bounded byte limit");
    entries.push([relative, `sha256:${sha256(await fs.readFile(resolved.absolute))}`]);
  }
  return sha256(canonicalJson(entries));
}
