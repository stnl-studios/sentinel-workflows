import * as fs from "node:fs/promises";
import path from "node:path";

import { inspectExecutionState } from "../execution-state.mjs";
import { validateWorkspace } from "./lifecycle/lifecycle.mjs";
import {
  ValidationError,
  canonicalJson,
  isIgnoredMetadata,
  lstatOrNull,
  resolveInsideProject,
  sanitizeDiagnostic,
  sha256,
} from "./core.mjs";

const MAX_AUTHORITY_FILES = 5_000;
const MAX_AUTHORITY_BYTES = 50_000_000;

function lifecycleHandoff(candidate) {
  const lines = [
    "Use `stnl-spec-lifecycle-manager`.",
    "MODE=INIT",
    `SPEC_PATH=${candidate.spec_path}`,
    "REQUIREMENTS_SOURCE:",
    candidate.requirements_source,
  ];
  if (candidate.additional_context !== undefined) {
    lines.push("ADDITIONAL_CONTEXT:", candidate.additional_context);
  }
  return lines.join("\n");
}

export function projectExecutionDependency(executionState) {
  if (executionState === "COMPLETE") {
    return {
      verdict: "UNKNOWN",
      detail: "Execution is mechanically COMPLETE, but only a current stnl-execution-closer EXECUTION_APPROVED verdict can satisfy dependencies.",
    };
  }
  return {
    verdict: "UNSATISFIED",
    detail: `Current canonical execution state is ${executionState}; the dependency is not satisfied.`,
  };
}

async function projectCandidate(candidate, projectRoot) {
  const resolved = await resolveInsideProject(projectRoot, candidate.spec_path, `${candidate.id}.spec_path`);
  if (resolved.metadata === null) {
    return {
      candidate_id: candidate.id,
      materialization: "not_materialized",
      documentary_status: null,
      execution_state: null,
      dependency_verdict: "UNSATISFIED",
      detail: "No canonical SPEC workspace exists at the suggested path.",
      lifecycle_handoff: lifecycleHandoff(candidate),
    };
  }
  if (resolved.metadata.isSymbolicLink() || !resolved.metadata.isDirectory()) {
    return {
      candidate_id: candidate.id,
      materialization: "invalid",
      documentary_status: null,
      execution_state: null,
      dependency_verdict: "UNKNOWN",
      detail: "The suggested SPEC path exists but is not a real directory.",
      lifecycle_handoff: null,
    };
  }
  let lifecycle;
  try {
    lifecycle = validateWorkspace(resolved.absolute);
  } catch (error) {
    return {
      candidate_id: candidate.id,
      materialization: "invalid",
      documentary_status: null,
      execution_state: null,
      dependency_verdict: "UNKNOWN",
      detail: `The existing path is not a valid canonical SPEC workspace: ${sanitizeDiagnostic(error.message, projectRoot)}`,
      lifecycle_handoff: null,
    };
  }
  try {
    const execution = await inspectExecutionState(resolved.absolute);
    const dependency = projectExecutionDependency(execution.state);
    return {
      candidate_id: candidate.id,
      materialization: "materialized",
      documentary_status: lifecycle.status,
      execution_state: execution.state,
      dependency_verdict: dependency.verdict,
      detail: dependency.detail,
      lifecycle_handoff: null,
    };
  } catch (error) {
    return {
      candidate_id: candidate.id,
      materialization: "materialized",
      documentary_status: lifecycle.status,
      execution_state: "INVALID",
      dependency_verdict: "UNKNOWN",
      detail: `Canonical execution projection is unavailable: ${sanitizeDiagnostic(error.message, projectRoot)}`,
      lifecycle_handoff: null,
    };
  }
}

export async function projectRoadmap(model, projectRoot) {
  const candidates = new Map();
  for (const candidate of model.candidates) {
    candidates.set(candidate.id, await projectCandidate(candidate, projectRoot));
  }
  const dependencyEdges = [];
  for (const candidate of model.candidates) {
    for (const prerequisite of candidate.depends_on) {
      const prerequisiteProjection = candidates.get(prerequisite);
      dependencyEdges.push({
        candidate_id: candidate.id,
        prerequisite_id: prerequisite,
        verdict: prerequisiteProjection.dependency_verdict,
        detail: prerequisiteProjection.detail,
      });
    }
  }
  const coverageById = new Map(model.coverage.map((item) => [item.id, item]));
  const blockingByCandidate = new Map(model.candidates.map((item) => [item.id, []]));
  for (const gap of model.gaps.filter((item) => item.state === "open" && item.severity === "BLOCKING")) {
    const affected = new Set(gap.candidate_ids);
    for (const coverageId of gap.coverage_ids) {
      for (const candidateId of coverageById.get(coverageId)?.candidate_ids ?? []) affected.add(candidateId);
    }
    for (const candidateId of affected) blockingByCandidate.get(candidateId)?.push(gap.id);
  }
  return {
    candidates,
    dependencyEdges,
    blockingByCandidate,
  };
}

async function snapshotEntry(filePath, relative, state) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null) {
    state.entries.push([relative, "ABSENT"]);
    return;
  }
  if (metadata.isSymbolicLink()) throw new ValidationError(`authority snapshot contains a symlink: ${relative}`);
  if (metadata.isFile()) {
    if (metadata.nlink !== 1) throw new ValidationError(`authority snapshot contains a hard-linked file: ${relative}`);
    state.files += 1;
    state.bytes += metadata.size;
    if (state.files > MAX_AUTHORITY_FILES || state.bytes > MAX_AUTHORITY_BYTES) {
      throw new ValidationError("authority snapshot exceeds its bounded file or byte limit");
    }
    state.entries.push([relative, `sha256:${sha256(await fs.readFile(filePath))}`]);
    return;
  }
  if (!metadata.isDirectory()) throw new ValidationError(`authority snapshot contains a special entry: ${relative}`);
  state.entries.push([relative, "DIRECTORY"]);
  const entries = (await fs.readdir(filePath, { withFileTypes: true }))
    .filter((entry) => !isIgnoredMetadata(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) await snapshotEntry(path.join(filePath, entry.name), `${relative}/${entry.name}`, state);
}

export async function snapshotAuthorityInputs(model, projectRoot) {
  const state = { files: 0, bytes: 0, entries: [] };
  for (const source of model.sources.filter((item) => item.path !== undefined)) {
    const resolved = await resolveInsideProject(projectRoot, source.path, `${source.id}.path`);
    await snapshotEntry(resolved.absolute, `source:${source.id}:${source.path}`, state);
  }
  for (const candidate of model.candidates) {
    const resolved = await resolveInsideProject(projectRoot, candidate.spec_path, `${candidate.id}.spec_path`);
    if (resolved.metadata === null) {
      state.entries.push([`candidate:${candidate.id}:${candidate.spec_path}`, "ABSENT"]);
      continue;
    }
    if (!resolved.metadata.isDirectory()) {
      await snapshotEntry(resolved.absolute, `candidate:${candidate.id}:${candidate.spec_path}`, state);
      continue;
    }
    for (const relative of ["feature_spec.md", "shared", "execution"]) {
      await snapshotEntry(
        path.join(resolved.absolute, relative),
        `candidate:${candidate.id}:${candidate.spec_path}/${relative}`,
        state,
      );
    }
  }
  state.entries.sort((left, right) => left[0].localeCompare(right[0], "en"));
  return sha256(canonicalJson(state.entries));
}
