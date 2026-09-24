import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = path.resolve(RUNTIME_ROOT, '..');
const REPOSITORY_ROOT = path.resolve(BENCHMARK_ROOT, '../..');

export const LONG_MODEL_OPERATION_TIMEOUT_MS = 1_800_000;

export const SEMANTIC_RESPONSE_SCHEMA_PATH_BY_OPERATION = Object.freeze({
  EXECUTE_SLICE: path.join(
    REPOSITORY_ROOT, 'skills', 'workflows', 'stnl-slice-executor', 'runtime', 'runner-execute-response.schema.json',
  ),
  APPLY_FINDINGS: path.join(
    REPOSITORY_ROOT, 'skills', 'workflows', 'stnl-slice-executor', 'runtime', 'runner-apply-findings-response.schema.json',
  ),
  VALIDATE_SLICE: path.join(
    REPOSITORY_ROOT, 'skills', 'workflows', 'stnl-slice-executor', 'runtime', 'runner-validate-response.schema.json',
  ),
});

export function canonicalSliceInput(value) {
  const match = /^slice-([0-9]{2,})$/u.exec(String(value));
  if (match === null) {
    const error = new Error(`invalid canonical slice label: ${value}`);
    error.exitCode = 2;
    throw error;
  }
  return BigInt(match[1]).toString(10);
}
