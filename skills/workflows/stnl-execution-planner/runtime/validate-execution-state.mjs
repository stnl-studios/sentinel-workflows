#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveNormalHandoff,
  ExecutionContractError,
  inspectExecutionState,
  preflightExecutionOperation,
  repairExecutionContract,
  validateExecutionCandidate,
} from "./execution-state.mjs";

export async function main(arguments_) {
  const candidateMode = arguments_.length === 3 && arguments_[1] === "--candidate";
  const handoffMode = arguments_.length === 3 && arguments_[1] === "--handoff-after";
  const repairMode = arguments_.length === 2 && arguments_[1] === "--repair-known-contract";
  const reserved = new Set(["--candidate", "--handoff-after", "--repair-known-contract"]);
  if (arguments_.length < 1 || arguments_.length > 3
    || (reserved.has(arguments_[1]) && !candidateMode && !handoffMode && !repairMode)) {
    process.stderr.write("usage: validate-execution-state.mjs SPEC_PATH [OPERATION [SLICE] | --candidate CANDIDATE_EXECUTION_ROOT | --handoff-after COMPLETED_OPERATION | --repair-known-contract]\n");
    return 2;
  }
  try {
    if (arguments_.length === 1) {
      const result = await inspectExecutionState(arguments_[0]);
      process.stdout.write(`PASS: execution state=${result.state} authority=sha256:${result.currentFingerprint}\n`);
      return 0;
    }
    if (candidateMode) {
      const result = await validateExecutionCandidate(arguments_[0], arguments_[2]);
      process.stdout.write(`PASS: execution candidate state=${result.state} authority=sha256:${result.currentFingerprint}\n`);
      return 0;
    }
    if (handoffMode) {
      const result = await inspectExecutionState(arguments_[0]);
      process.stdout.write(`${JSON.stringify({
        state: result.state,
        normal_handoff: deriveNormalHandoff(result, arguments_[2]),
        legal_operations: result.legalOperations,
        mandatory_recovery: result.mandatoryRecovery,
        required_recovery_handoff: result.requiredRecoveryHandoff,
        recovery_targets: result.recoveryTargets,
        accepted_gates: result.acceptedGates,
      })}\n`);
      return 0;
    }
    if (repairMode) {
      const result = await repairExecutionContract(arguments_[0]);
      process.stdout.write(`PASS: contract repair status=${result.status} repairs=${result.repairs.length} state=${result.state}\n`);
      return 0;
    }
    const result = await preflightExecutionOperation(arguments_[0], arguments_[1], arguments_[2] ?? null);
    process.stdout.write(`PASS: ${result.operation} preflight state=${result.state}${result.slice === null ? "" : ` slice=${result.slice}`} authority=sha256:${result.currentFingerprint}\n`);
    if (result.mandatoryRecovery !== null) {
      process.stdout.write(`MANDATORY_RECOVERY: ${JSON.stringify(result.mandatoryRecovery)}\n`);
    }
    if (result.acceptedGates?.length) process.stdout.write(`ACCEPTED_GATES: ${JSON.stringify(result.acceptedGates)}\n`);
    if (result.revalidation?.length) process.stdout.write(`REVALIDATION_REQUIRED: ${JSON.stringify(result.revalidation)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ExecutionContractError) {
      if (error.contractViolation !== null) {
        process.stderr.write(`BLOCKED: contract_violation=${JSON.stringify(error.contractViolation)}\n`);
        if (error.contractViolation.repairability === "mechanical") {
          process.stderr.write("RECOVERY: rerun with --repair-known-contract, then repeat the original read-only preflight\n");
        }
      }
      else if (error.findings.length !== 0) for (const finding of error.findings) process.stderr.write(`BLOCKED: ${finding}\n`);
      else process.stderr.write(`BLOCKED: ${error.message}\n`);
      if (error.recoveryTargets.length !== 0) {
        process.stderr.write(`RECOVERY_TARGETS: ${JSON.stringify(error.recoveryTargets)}\n`);
      }
      return 1;
    }
    throw error;
  }
}

// macOS temporary paths may be presented through the /var -> /private/var alias,
// so lexical absolute-path equality is not a reliable entrypoint check.
const executed = process.argv[1] !== undefined
  && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
