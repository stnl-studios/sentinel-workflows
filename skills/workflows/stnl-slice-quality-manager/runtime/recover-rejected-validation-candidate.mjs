#!/usr/bin/env node

import fs from "node:fs/promises";
import { readOperationOwner, assertOwnedOperationalCandidate } from "./execution-publication.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ExecutionContractError, inspectExecutionState, preflightExecutionOperation,
  validateExecutionCandidate, resolveExecutionWorkspace, readExecutionActivation } from "./execution-state.mjs";
import { prepareValidationCopy } from "./prepare-validation-copy.mjs";
import { publishValidationCandidate } from "./publish-validation-candidate.mjs";
import { persistMalformedRunnerResultInCandidate, recoverableRunnerResultDiagnostic,
  RunnerVerdictEvidenceError, resolveCapturedRunnerCommands } from "./serialize-runner-evidence.mjs";
import { assertManagedAgreement, assertManagedRunnerReceipt } from "./managed-slice-context.mjs";

function fail(message) { throw new Error(`validation rejection recovery blocked: ${message}`); }

export async function recoverRejectedValidationCandidate({ specPath, slice, workspace,
  rejectedCandidateRoot, candidateParent, semanticResponseFile, receiptFile }) {
  const managed = assertManagedAgreement({ specPath, workspace, slice });
  const owner = managed?.owner ?? await readOperationOwner(specPath);
  const number = BigInt(String(slice).replace(/^slice-/u, ""));
  if (number < 1n) fail("slice must be positive");
  const canonicalSlice = `slice-${number.toString(10).padStart(2, "0")}`;
  const preflight = await preflightExecutionOperation(specPath, "VALIDATE_SLICE", number.toString(10), { owner });
  await assertOwnedOperationalCandidate({ candidateExecutionRoot: rejectedCandidateRoot, slice: canonicalSlice,
    resolveWorkspace: resolveExecutionWorkspace, readActivated: readExecutionActivation });
  const expectedId = `attempt-${String(preflight.tasks.get(canonicalSlice)?.attempts.length + 1).padStart(2, "0")}`;
  if (expectedId.includes("NaN")) fail("official preflight did not resolve the selected task");
  let rejection;
  try { await validateExecutionCandidate(specPath, rejectedCandidateRoot); }
  catch (error) { rejection = error; }
  if (!(rejection instanceof ExecutionContractError)
    || rejection.contractViolation?.code !== "PASS_COMMAND_EXIT_NONZERO"
    || rejection.contractViolation.record !== expectedId) {
    fail("strict candidate rejection is not the selected recoverable PASS command conflict");
  }
  const response = JSON.parse(await fs.readFile(semanticResponseFile, "utf8"));
  if (response?.status !== "PASS") fail("captured response is not PASS");
  if (!await assertManagedRunnerReceipt({ receiptFile, semanticResponseFile, workspace, slice: canonicalSlice, operation: 'VALIDATE_SLICE' })) {
    fail('rejected validation recovery requires the matching managed invocation and observed reviewed recipe');
  }
  const commands = await resolveCapturedRunnerCommands({ receiptFile, semanticResponseFile,
    operation: "VALIDATE_SLICE" });
  const failed = commands.filter(({ exit }) => exit !== 0);
  if (failed.length === 0) fail("bound recipe observations do not confirm the rejected command conflict");
  const rejectedTask = path.join(rejectedCandidateRoot, "tasks", `${canonicalSlice}.md`);
  const before = await fs.readFile(rejectedTask);
  const copy = await prepareValidationCopy({ specPath, slice: canonicalSlice, candidateParent, owner });
  const candidateTask = path.join(copy.candidateExecutionRoot, "tasks", `${canonicalSlice}.md`);
  const producerError = new RunnerVerdictEvidenceError("VALIDATE_SLICE", "PASS", failed, rejection.message);
  const diagnostic = recoverableRunnerResultDiagnostic(producerError);
  const recovery = await persistMalformedRunnerResultInCandidate({ taskArtifact: candidateTask,
    operation: "VALIDATE_SLICE", receiptFile, semanticResponseFile, diagnostic, error: producerError, workspace });
  const candidate = await validateExecutionCandidate(specPath, copy.candidateExecutionRoot);
  if (candidate.state !== "RUNNER_RESULT_BLOCKED") fail("recovery candidate did not produce the canonical blocker");
  const published = await publishValidationCandidate({ specPath, slice: canonicalSlice,
    candidateExecutionRoot: copy.candidateExecutionRoot, owner, terminal: false });
  const readback = await inspectExecutionState(specPath);
  if (readback.state !== "RUNNER_RESULT_BLOCKED"
    || readback.mandatoryRecovery?.operation !== "VALIDATE_SLICE"
    || readback.mandatoryRecovery?.slice !== canonicalSlice) fail("published recovery readback disagrees");
  if (!(await fs.readFile(rejectedTask)).equals(before)) fail("rejected candidate changed during recovery");
  return { status: "RUNNER_RESULT_BLOCKED", rejection: rejection.contractViolation,
    rejectedCandidateRoot, recoveryCandidateRoot: copy.candidateExecutionRoot,
    publishedState: published.state, mandatoryRecovery: readback.mandatoryRecovery,
    diagnostic: recovery.diagnostic };
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  try {
    const names = ["--spec-path", "--slice", "--workspace", "--rejected-candidate",
      "--candidate-parent", "--semantic-response-file", "--receipt-file"];
    const args = process.argv.slice(2);
    if (args.length !== names.length * 2 || names.some((name, index) => args[index * 2] !== name)) {
      fail(`usage: ${names.map((name) => `${name} VALUE`).join(" ")}`);
    }
    const result = await recoverRejectedValidationCandidate({ specPath: args[1], slice: args[3],
      workspace: args[5], rejectedCandidateRoot: args[7], candidateParent: args[9],
      semanticResponseFile: args[11], receiptFile: args[13] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
