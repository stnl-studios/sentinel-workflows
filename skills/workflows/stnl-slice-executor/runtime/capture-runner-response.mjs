#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

async function requireRegularFile(file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail(`${label} must be absolute`);
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be an existing regular file`);
  }
  return path.resolve(file);
}

async function requireAbsentOutput(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail("output file must be absolute");
  const resolved = path.resolve(file);
  if (await fs.lstat(resolved).catch(() => null) !== null) fail("output file already exists");
  const parent = path.dirname(resolved);
  const metadata = await fs.lstat(parent).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("output parent must be an existing non-symlink directory");
  }
  const canonicalParent = await fs.realpath(parent);
  if (canonicalParent !== parent) fail("output parent must be canonical");
  return resolved;
}

function parseStructuredOutput(text) {
  const messages = [];
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) fail("structured runner output is empty");
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail(`structured runner output line ${index + 1} is invalid JSON`);
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)
      || typeof event.type !== "string") {
      fail(`structured runner output line ${index + 1} is not a typed event`);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message"
      && typeof event.item.text === "string") {
      messages.push(event.item.text);
    }
  }
  const response = messages.at(-1);
  if (response === undefined) fail("structured runner output has no final agent message");
  let semantic;
  try {
    semantic = JSON.parse(response);
  } catch {
    fail("final runner message is not valid JSON");
  }
  if (semantic === null || typeof semantic !== "object" || Array.isArray(semantic)) {
    fail("final runner message must be one JSON object, not a JSON string or array");
  }
  return response;
}

export async function captureRunnerResponse({ structuredOutputFile, outputFile }) {
  const source = await requireRegularFile(structuredOutputFile, "structured output file");
  const destination = await requireAbsentOutput(outputFile);
  const response = parseStructuredOutput(await fs.readFile(source, "utf8"));
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, response, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { status: "PASS", outputFile: destination };
}

function parseArgs(argv) {
  if (argv.length !== 4) fail("usage: capture-runner-response.mjs --structured-output-file <absolute> --output <absolute>");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--structured-output-file", "--output"]).has(name)
      || value === undefined || value.startsWith("--") || Object.hasOwn(values, name)) {
      fail("invalid capture-runner-response arguments");
    }
    values[name] = value;
  }
  return {
    structuredOutputFile: values["--structured-output-file"],
    outputFile: values["--output"],
  };
}

export async function main(argv) {
  const result = await captureRunnerResponse(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
