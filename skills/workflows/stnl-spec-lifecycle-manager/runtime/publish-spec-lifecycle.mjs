#!/usr/bin/env node

import process from "node:process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ValidationError } from "./lib/lifecycle.mjs";
import {
  MUTABLE_MODES,
  isFilesystemError,
  publishCandidate,
  readinessAttestationPath,
} from "./lib/publisher.mjs";

const USAGE =
  "usage: publish-spec-lifecycle.mjs [-h] [--manifest MANIFEST] " +
  "[--readiness-attestation auto|READINESS_ATTESTATION] " +
  "[--product-root ROOT --temporary-root ROOT --excluded-root ROOT] {CLOSE,INIT,RESUME} target [candidate]";

function argumentFailure(message) {
  process.stderr.write(`${USAGE}\npublish-spec-lifecycle.mjs: error: ${message}\n`);
  return 2;
}

function parseArguments(arguments_) {
  const positional = [];
  let manifestPath = null;
  let readinessAttestation = null;
  let optionsEnabled = true;
  const roots = new Map();
  const rootOptions = ["--product-root", "--temporary-root", "--excluded-root"];
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
      equalsOption === "--manifest" || equalsOption === "--readiness-attestation" ||
      rootOptions.includes(argument) || rootOptions.includes(equalsOption)
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
      if (rootOptions.includes(option)) {
        if (!value || roots.has(option)) return { error: `argument ${option}: requires one nonempty value, once` };
        roots.set(option, value);
      } else if (option === "--manifest") {
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
  const [mode,target,candidate=null]=positional;
  const expected=mode==='CLOSE'?2:3;
  if(positional.length!==expected)return {error:mode==='CLOSE'?'CLOSE requires target only; omit external candidate':'the following arguments are required: mode, target, candidate'};
  if (!MUTABLE_MODES.has(mode)) {
    return {
      error: `argument mode: invalid choice: '${mode}' (choose from 'CLOSE', 'INIT', 'RESUME')`,
    };
  }
  if (roots.size !== 0 && roots.size !== rootOptions.length)
    return { error: 'product-root, temporary-root and excluded-root must be supplied together' };
  const filesystemContext = roots.size === 0 ? null : {
    productRoot: roots.get('--product-root'), temporaryRoot: roots.get('--temporary-root'),
    excludedRoots: [roots.get('--excluded-root')],
  };
  return { mode, target, candidate, manifestPath, readinessAttestation, filesystemContext };
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
      filesystemContext: parsed.filesystemContext,
    });
    if(parsed.mode==='CLOSE')process.stdout.write(JSON.stringify(published)+'\n');
    else process.stdout.write(`PASS: ${parsed.mode} published validated candidate at ${published}\n`);
    if (parsed.mode === "RESUME" && parsed.readinessAttestation !== null) {
      process.stdout.write(
        `PASS: readiness attestation available at ${await readinessAttestationPath(published,{filesystemContext:parsed.filesystemContext})}\n`,
      );
    }
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
