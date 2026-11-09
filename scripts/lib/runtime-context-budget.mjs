import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Deliberate baseline changes require explicit review of this pin and snapshot.
// Never regenerate the snapshot from the current runtime or fall back to Git.
export const BASELINE_SNAPSHOT_SHA256 = "8981eb746cb1bfd65d25a04a6c7a29471c07402f65c9a83be5b2cb0c100a37a8";

export function metrics(buffers) {
  return {
    words: buffers.reduce((total, buffer) => total + buffer.toString("utf8").trim().split(/\s+/u).filter(Boolean).length, 0),
    bytes: buffers.reduce((total, buffer) => total + buffer.byteLength, 0),
  };
}

export function fileMetadata(buffer) {
  return {
    ...metrics([buffer]),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    git_blob_sha1: createHash("sha1").update(`blob ${buffer.byteLength}\0`).update(buffer).digest("hex"),
  };
}

export function validateBaseline(manifest, snapshot) {
  assert.equal(createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), BASELINE_SNAPSHOT_SHA256,
    "baseline snapshot integrity mismatch: review an explicit baseline migration; no fallback is allowed");
  assert.equal(snapshot.schema_version, 1);
  assert.equal(manifest.baseline_revision, snapshot.origin.revision, "baseline revision changed");
  assert.deepEqual(Object.keys(manifest.modes).sort(), Object.keys(snapshot.modes).sort());
  const requiredFiles = [...new Set(Object.values(snapshot.modes).flatMap(mode => mode.baseline.files))].sort();
  assert.deepEqual(Object.keys(snapshot.files).sort(), requiredFiles, "baseline file inventory mismatch");
  for (const [mode, fixed] of Object.entries(snapshot.modes)) {
    const contract = manifest.modes[mode];
    assert.deepEqual(contract.baseline, fixed.baseline, `${mode}: baseline changed`);
    for (const unit of ["words", "bytes"]) {
      const sum = fixed.baseline.files.reduce((total, path) => total + snapshot.files[path][unit], 0);
      assert.equal(sum, contract.baseline[unit], `${mode}: baseline ${unit} sum mismatch`);
      assert(Number.isSafeInteger(contract.ceilings[unit]) && contract.ceilings[unit] >= 0,
        `${mode}: invalid ${unit} ceiling`);
      assert(contract.ceilings[unit] <= fixed.maximum_ceilings[unit], `${mode}: raised ${unit} ceiling`);
    }
    assert(Number.isFinite(contract.required_reduction_percent) &&
      contract.required_reduction_percent >= fixed.minimum_reduction_percent &&
      contract.required_reduction_percent <= 100, `${mode}: weakened or invalid reduction`);
  }
}

export function validateCurrent(mode, contract, current) {
  for (const unit of ["words", "bytes"]) {
    assert(current[unit] <= contract.ceilings[unit], `${mode}: ${unit} ceiling exceeded`);
    assert(contract.ceilings[unit] <= contract.baseline[unit], `${mode}: raised ${unit} ceiling`);
    const reduction = (100 * (contract.baseline[unit] - current[unit])) / contract.baseline[unit];
    assert(reduction >= contract.required_reduction_percent,
      `${mode} ${unit}: ${reduction}% < ${contract.required_reduction_percent}%`);
  }
}
