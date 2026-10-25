// Pure semantic contract shared by canonical producers and rejection readback.
function fail(message) { throw new Error(message); }

// One correction belongs to the frozen formal target, not to a child/owner.
// Initialization continuation and independent replacement spend the same slot.
export function formalRecoveryBudget(producerTurns, inherited = null) {
  if(![1,2].includes(producerTurns) || inherited && (inherited.operation!=='VALIDATE_SLICE'
    ||inherited.status!=='settled'||inherited.round!==1||inherited.consumedInvocations!==1||producerTurns!==1))
    throw Object.assign(new Error('formal corrective credit is exhausted or its lineage is invalid'),{code:'FORMAL_RECOVERY_NOT_ELIGIBLE'});
  const consumedInvocations=(inherited?.consumedInvocations??0)+producerTurns;
  return {consumedInvocations,resumable:consumedInvocations<2};
}

export class RunnerVerdictEvidenceError extends Error {
  constructor(operation, status, failedCommands, message = null) {
    super(message ?? `${operation} ${status} contradicts ${failedCommands.length} marked verification command(s) with non-zero exit`);
    this.name = "RunnerVerdictEvidenceError";
    this.code = "RUNNER_VERDICT_EVIDENCE_CONFLICT";
    this.operation = operation;
    this.status = status;
    this.failedCommands = failedCommands;
  }
}

export class RunnerSemanticResultError extends Error {
  constructor(operation, cause) {
    super(`${operation} captured semantic result is invalid: ${cause.message}`, { cause });
    this.name = "RunnerSemanticResultError";
    this.code = "RUNNER_SEMANTIC_RESULT_INVALID";
  }
}

export function parseCapturedResult(operation, parse, response) {
  try { return parse(response, operation); }
  catch (error) { throw new RunnerSemanticResultError(operation, error); }
}


export function recoverableRunnerResultDiagnostic(error) {
  if (!(error instanceof RunnerVerdictEvidenceError || error instanceof RunnerSemanticResultError)) return null;
  const failed = error instanceof RunnerVerdictEvidenceError
    ? `; failed verification commands: ${JSON.stringify(error.failedCommands)}` : "";
  return `${error.code}: ${error.message}${failed}`;
}

export function assertRunnerVerdictConsistency(operation, status, commands) {
  const success = operation === "VALIDATE_SLICE" ? status === "PASS" : status === "TESTS_PASS";
  if (!success) return;
  const failed = commands.filter(({ exit }) => exit !== 0);
  if (failed.length !== 0) throw new RunnerVerdictEvidenceError(operation, status, failed);
}


export function serializeCommand(command, label) {
  if (typeof command !== "string" || command.length === 0) fail(`${label} must be a non-empty command`);
  return /[`\r\n]/u.test(command) ? `json:${JSON.stringify(command)}` : `\`${command}\``;
}


const MACHINE_EXECUTION_FIELDS = Object.freeze({
  EXECUTE_SLICE: Object.freeze([
    ["status", "Status"],
    ["automaticCheckRound", "Automatic check round"],
    ["head", "HEAD"],
    ["discoverySources", "Discovery sources"],
    ["discoveryActions", "Discovery actions"],
    ["verificationTypesConsidered", "Verification types considered"],
    ["nonApplicabilityRationale", "Non-applicability rationale"],
    ["noVerificationCommandConfirmation", "No verification-command confirmation"],
    ["commands", "Commands"],
    ["resultOfEachCommandAndExitCode", "Result of each command and exit code"],
    ["selectedChecks", "Selected checks"],
    ["selectionRationale", "Selection rationale"],
    ["coverage", "Coverage"],
    ["failures", "Failures"],
    ["priorRoundFailure", "Prior-round failure"],
    ["correctionApplied", "Correction applied"],
    ["inSliceRationale", "In-slice rationale"],
    ["evidenceOrFailureSummary", "Evidence or failure summary"],
    ["affectedFilesOrBehaviors", "Affected files or behaviors"],
    ["blockers", "Blockers"],
    ["unexpectedWorkspaceEffects", "Unexpected workspace effects"],
    ["persistenceSummary", "Persistence summary"],
  ]),
  APPLY_FINDINGS: Object.freeze([
    ["status", "Status"],
    ["automaticCheckRound", "Automatic check round"],
    ["head", "HEAD"],
    ["discoverySources", "Discovery sources"],
    ["discoveryActions", "Discovery actions"],
    ["verificationTypesConsidered", "Verification types considered"],
    ["nonApplicabilityRationale", "Non-applicability rationale"],
    ["noVerificationCommandConfirmation", "No verification-command confirmation"],
    ["commands", "Commands"],
    ["resultOfEachCommandAndExitCode", "Result of each command and exit code"],
    ["selectedChecks", "Selected checks"],
    ["selectionRationale", "Selection rationale"],
    ["coverage", "Coverage"],
    ["findingsVerified", "Findings verified"],
    ["correctionsCovered", "Corrections covered"],
    ["regressionsSelected", "Regressions selected"],
    ["unsupportedActiveFindings", "Unsupported active findings"],
    ["failures", "Failures"],
    ["evidenceOrFailureSummary", "Evidence or failure summary"],
    ["affectedFilesOrBehaviors", "Affected files or behaviors"],
    ["blockers", "Blockers"],
    ["unexpectedWorkspaceEffects", "Unexpected workspace effects"],
    ["persistenceSummary", "Persistence summary"],
  ]),
});

export function validateScalarField(name, value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\n") || value.includes("\r") || value.includes("`")) {
    fail(`${name} must be a complete single-line scalar without backticks`);
  }
  return value;
}

const EXPLANATORY_EXECUTION_FIELDS = new Set([
  "Discovery sources", "Discovery actions", "Verification types considered", "Non-applicability rationale",
  "No verification-command confirmation", "Result of each command and exit code", "Selected checks",
  "Selection rationale", "Coverage", "Failures", "Prior-round failure", "Correction applied",
  "In-slice rationale", "Evidence", "Evidence or failure summary", "Affected files or behaviors", "Blockers",
  "Unexpected workspace effects", "Persistence summary", "Regressions selected", "Corrections covered", "Fileless reason",
]);

const EXPLANATORY_VALIDATION_FIELDS = new Set([
  "evidence", "blockers", "unexpectedWorkspaceEffects", "persistenceSummary",
]);

export function serializeMarkdownScalar(name, value, explanatory = false) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty scalar`);
  if (!explanatory) return validateScalarField(name, value);
  return /[`\r\n]/u.test(value) || value.startsWith("json:") ? `json:${JSON.stringify(value)}` : value;
}

export function decodeMarkdownScalar(name, value, explanatory = false) {
  if (!explanatory) return validateScalarField(name, value);
  if (!value.startsWith("json:")) {
    serializeMarkdownScalar(name, value, true);
    return value;
  }
  const encoded = value.slice("json:".length);
  let decoded;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    fail(`${name} must use a canonical json-quoted scalar`);
  }
  if (typeof decoded !== "string" || decoded.length === 0
    || serializeMarkdownScalar(name, decoded, true) !== value) {
    fail(`${name} must use a canonical json-quoted scalar`);
  }
  return decoded;
}

export function canonicalSemanticValidationScalar(name, value) {
  if (EXPLANATORY_VALIDATION_FIELDS.has(name)) {
    serializeMarkdownScalar(name, value, true);
    return value;
  }
  return validateScalarField(name, value);
}


export function parseSemanticExecutionPayload(text, operation) {
  const fields = MACHINE_EXECUTION_FIELDS[operation];
  if (fields === undefined) fail(`unsupported semantic execution operation: ${operation}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail("semantic execution payload must be one canonical JSON object");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail("semantic execution payload must be one canonical JSON object");
  }
  if (!["TESTS_PASS", "TESTS_FAIL", "TESTS_NOT_APPLICABLE", "BLOCKED"].includes(payload.status)) {
    fail("semantic execution payload Status is invalid");
  }
  if (!["1/3", "2/3", "3/3"].includes(payload.automaticCheckRound)) {
    fail("semantic execution payload Automatic check round is invalid");
  }
  const allowed = new Set([...fields.map(([key]) => key), "filelessReason",
    ...(operation === 'EXECUTE_SLICE' ? ['testCoverageOmissions'] : [])]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) fail(`unknown semantic execution payload field: ${key}`);
  }
  for (const [key] of fields) {
    if (!Object.hasOwn(payload, key)) fail(`missing semantic execution payload field: ${key}`);
    if (key === "commands") continue;
    serializeMarkdownScalar(key, payload[key], EXPLANATORY_EXECUTION_FIELDS.has(MACHINE_EXECUTION_FIELDS[operation].find(([candidate]) => candidate === key)?.[1]));
  }
  if (!Array.isArray(payload.commands)) fail("semantic execution payload commands must be an array");
  for (const [index, command] of payload.commands.entries()) {
    if (command === null || typeof command !== "object" || Array.isArray(command)
      || JSON.stringify(Object.keys(command).sort()) !== JSON.stringify(["command", "exit"])) {
      fail(`semantic execution payload command ${index + 1} must contain only command and exit`);
    }
    serializeCommand(command.command, `semantic execution payload command ${index + 1}`);
    if (!Number.isSafeInteger(command.exit)) fail(`semantic execution payload command ${index + 1} exit must be an integer`);
  }
  if (payload.commands.length === 0 && !new Set(["BLOCKED", "TESTS_NOT_APPLICABLE"]).has(payload.status)) {
    fail("non-blocked semantic execution payload requires executed commands");
  }
  if (operation === "EXECUTE_SLICE" && payload.automaticCheckRound !== "1/3") {
    for (const key of ["priorRoundFailure", "correctionApplied", "inSliceRationale"]) {
      if (/^(?:none|pending|n\/a)$/iu.test(payload[key])) {
        fail(`${key} is required for automatic check rounds after 1/3`);
      }
    }
  }
  if (Object.hasOwn(payload, "filelessReason")) serializeMarkdownScalar("filelessReason", payload.filelessReason, true);
  if (Object.hasOwn(payload, 'testCoverageOmissions')) {
    if (payload.status !== 'BLOCKED' || payload.commands.length === 0 || payload.commands.some(item => item.exit !== 0)
      || !Array.isArray(payload.testCoverageOmissions) || payload.testCoverageOmissions.length === 0)
      fail('testCoverageOmissions requires BLOCKED with completed zero-exit checks');
    const seen = new Set();
    for (const item of payload.testCoverageOmissions) {
      if (!item || Array.isArray(item) || typeof item !== 'object'
        || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['evidence','expectedCorrection','obligationId','testPath','testedFileSha256']))
        fail('testCoverageOmissions must identify obligation, observed test and correction');
      if (!/^obligation-[0-9]{2,}$/u.test(item.obligationId ?? '')
        || typeof item.testPath !== 'string' || !item.testPath || item.testPath.startsWith('/')
        || /[\\\r\n\0]/u.test(item.testPath) || item.testPath.split('/').some(part => !part || part === '.' || part === '..')
        || !/^sha256:[a-f0-9]{64}$/u.test(item.testedFileSha256 ?? '')) fail('testCoverageOmissions reference is invalid');
      for (const key of ['evidence','expectedCorrection']) {
        serializeMarkdownScalar(key, item[key], true);
        if (/^(?:none|pending|n\/a|not_available)$/iu.test(item[key].trim())) fail('testCoverageOmissions requires concrete evidence and correction');
      }
      const key = `${item.obligationId}:${item.testPath}`;
      if (seen.has(key)) fail('duplicate testCoverageOmissions reference');
      seen.add(key);
    }
  }
  return payload;
}

const VALIDATION_SEMANTIC_KEYS = Object.freeze([
  "status", "head", "commands", "evidence", "findingReferences", "findingDispositions",
  "blockers", "unexpectedWorkspaceEffects", "persistenceSummary",
]);

export function parseSemanticValidationPayload(text) {
  if (typeof text !== "string" || text.length === 0) fail("semantic validation response must be a non-empty JSON object");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail("semantic validation response must be a single raw JSON object");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail("semantic validation response must be a single raw JSON object");
  }
  const keys = Object.keys(payload);
  if (JSON.stringify(keys) !== JSON.stringify(VALIDATION_SEMANTIC_KEYS)) {
    const unknown = keys.find((key) => !VALIDATION_SEMANTIC_KEYS.includes(key));
    if (unknown !== undefined) fail(`unknown semantic validation payload field: ${unknown}`);
    fail("semantic validation payload keys are missing or not in canonical order");
  }
  if (!["PASS", "NEEDS_FIX", "BLOCKED"].includes(payload.status)) {
    fail("semantic validation payload status is invalid");
  }
  for (const key of VALIDATION_SEMANTIC_KEYS) {
    if (key === "commands") continue;
    payload[key] = canonicalSemanticValidationScalar(key, payload[key]);
  }
  if (!Array.isArray(payload.commands) || payload.commands.length === 0) {
    fail("semantic validation payload commands must be a non-empty array");
  }
  for (const [index, command] of payload.commands.entries()) {
    if (command === null || typeof command !== "object" || Array.isArray(command)
      || JSON.stringify(Object.keys(command).sort()) !== JSON.stringify(["command", "exit"])) {
      fail(`semantic validation payload command ${index + 1} must contain only command and exit`);
    }
    serializeCommand(command.command, `semantic validation payload command ${index + 1}`);
    if (!Number.isSafeInteger(command.exit)) fail(`semantic validation payload command ${index + 1} exit must be an integer`);
  }
  return payload;
}


export function assertExecutionResultScope(operation, payload, targetCount) {
  const reason = payload.filelessReason ?? null;
  const mismatch = targetCount === 0 && (reason === null || reason.trim() === "")
    ? "fileless semantic execution response must include Fileless reason"
    : targetCount !== 0 && reason !== null
      ? "file-backed semantic execution response cannot include Fileless reason" : null;
  if (mismatch !== null) throw new RunnerSemanticResultError(operation,
    Object.assign(new Error(mismatch), { code: "RUNNER_EXECUTION_SCOPE_INVALID" }));
}

// No caller Error or diagnostic participates in this decision. The caller must
// first verify the receipt/origin; historical readers verify the bound files.
// Re-evaluation only reads captured evidence: it never executes a check again.
export function deriveCanonicalRunnerRejection({ receipt, response }) {
  const operation = receipt.operation;
  if (!["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"].includes(operation)) fail("invalid captured runner operation");
  let payload;
  try {
    payload = parseCapturedResult(operation, operation === "VALIDATE_SLICE" ? parseSemanticValidationPayload
      : parseSemanticExecutionPayload, response);
  } catch (error) {
    if (!(error instanceof RunnerSemanticResultError)) throw error;
    if (receipt.status !== "RUNNER_RESULT_BLOCKED") return error;
    // Reconstruct the capture diagnostic from final bytes, preserving the
    // canonical capture diagnostic without trusting captureFailure.
    let raw;
    try { raw = JSON.parse(response); }
    catch { return new RunnerSemanticResultError(operation, new Error("final runner message is not valid JSON")); }
    const message = raw === null || typeof raw !== "object" || Array.isArray(raw)
      ? "final runner message must be one JSON object, not a JSON string or array"
      : operation === "VALIDATE_SLICE" ? `runner response schema is invalid: ${error.cause.message}`
        : typeof raw.status !== "string" ? "captured semantic runner response has no status" : null;
    if (message === null) fail("diagnostic receipt does not match a canonical capture rejection");
    return new RunnerSemanticResultError(operation, new Error(message));
  }
  // A diagnostic receipt cannot establish a verdict conflict or scope mismatch
  // for an otherwise valid response: it has no accepted observation of them.
  if (receipt.status === "RUNNER_RESULT_BLOCKED") return null;
  if (!receipt.verification || !Array.isArray(receipt.verification.checks)) fail("captured runner verification is missing");
  const commands = receipt.verification.checks.map(({ command, exit }) => {
    if (typeof command !== "string" || !Number.isSafeInteger(exit)) fail("captured runner command is invalid");
    return { command, exit };
  });
  if (receipt.transport === "native") {
    if (JSON.stringify(payload.commands) !== JSON.stringify(commands)) fail("native response commands differ from reviewed recipe observation");
    if (operation !== "VALIDATE_SLICE" && payload.automaticCheckRound !== `${receipt.attempt}/3`) fail("native semantic round differs from reserved invocation");
  }
  try {
    assertRunnerVerdictConsistency(operation, payload.status, commands);
    if (operation !== "VALIDATE_SLICE") {
      if (!Array.isArray(receipt.testedState?.entries)) fail("captured Tested state is missing");
      assertExecutionResultScope(operation, payload, receipt.testedState.entries.length);
    }
  } catch (error) {
    if (recoverableRunnerResultDiagnostic(error) !== null) return error;
    throw error;
  }
  return null;
}

export const executionFields = operation => MACHINE_EXECUTION_FIELDS[operation].map(entry => [...entry]);
export const isExplanatoryExecutionField = name => EXPLANATORY_EXECUTION_FIELDS.has(name);
