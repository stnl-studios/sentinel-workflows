#!/usr/bin/env node

import path from "node:path";

import { writeValidationCapabilitySource } from "./lib/validation-capability.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const capability = await writeValidationCapabilitySource(repositoryRoot);
process.stdout.write(`${capability.identity}\n`);
