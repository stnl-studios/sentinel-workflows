#!/usr/bin/env node

import process from "node:process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ValidationError } from "./lib/lifecycle.mjs";
import { MUTABLE_MODES, isFilesystemError, publishCandidate } from "./lib/publisher.mjs";

const USAGE =
  "usage: publish-spec-lifecycle.mjs [-h] [--manifest MANIFEST] " +
  "[--readiness-attestation READINESS_ATTESTATION] {CLOSE,INIT,RESUME} target candidate";

function argumentFailure(message) {
  process.stderr.write(`${USAGE}\npublish-spec-lifecycle.mjs: error: ${message}\n`);
  return 2;
}

function parseArguments(arguments_) {
  const positional = [];
  let manifestPath = null;
  let readinessAttestation = null;
  let optionsEnabled = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (optionsEnabled && argument === "--") {
      optionsEnabled = false;
      continue;
    }
    if (optionsEnabled && (argument === "-h" || argument === "--help")) {
      return { help: true };
    }
    const equalsOption = optionsEnabled && argument.startsWith("--") && argument.includes("=")
      ? argument.split("=", 1)[0]
      : null;
    if (optionsEnabled && (
      argument === "--manifest" || argument === "--readiness-attestation" ||
      equalsOption === "--manifest" || equalsOption === "--readiness-attestation"
    )) {
      const option = equalsOption ?? argument;
      const inlineValue = equalsOption === null ? null : argument.slice(argument.indexOf("=") + 1);
      let value = inlineValue;
      if (inlineValue === null) {
        if (index + 1 >= arguments_.length || arguments_[index + 1].startsWith("-")) {
          return { error: `argument ${option}: expected one argument` };
        }
        value = arguments_[index + 1];
        index += 1;
      }
      if (option === "--manifest") {
        manifestPath = value;
      } else {
        readinessAttestation = value;
      }
      continue;
    }
    if (optionsEnabled && argument.startsWith("-")) {
      return { error: `unrecognized arguments: ${argument}` };
    }
    positional.push(argument);
  }
  if (positional.length < 3) {
    const missing = ["mode", "target", "candidate"].slice(positional.length).join(", ");
    return { error: `the following arguments are required: ${missing}` };
  }
  if (positional.length > 3) {
    return { error: `unrecognized arguments: ${positional.slice(3).join(" ")}` };
  }
  const [mode, target, candidate] = positional;
  if (!MUTABLE_MODES.has(mode)) {
    return {
      error: `argument mode: invalid choice: '${mode}' (choose from 'CLOSE', 'INIT', 'RESUME')`,
    };
  }
  return { mode, target, candidate, manifestPath, readinessAttestation };
}

export async function main(arguments_ = process.argv.slice(2)) {
  const parsed = parseArguments(arguments_);
  if (parsed.help) {
    process.stdout.write(
      `${USAGE}\n\nValidate, durably publish, and recover mutable SPEC lifecycle candidates.\n`,
    );
    return 0;
  }
  if (parsed.error) return argumentFailure(parsed.error);
  try {
    const published = await publishCandidate(parsed.mode, parsed.target, parsed.candidate, {
      manifestPath: parsed.manifestPath,
      readinessAttestation: parsed.readinessAttestation,
    });
    process.stdout.write(`PASS: ${parsed.mode} published validated candidate at ${published}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ValidationError || isFilesystemError(error)) {
      process.stderr.write(`FAIL: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  process.exitCode = await main();
}
