import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverCanonicalSkills,
  resolveCanonicalSkill,
} from "../../scripts/lib/skill-discovery.mjs";

export function discoverClaudeSkills(repositoryRoot) {
  return Object.freeze({
    consumer: "claude-code",
    sourceOfTruth: "skills",
    ...discoverCanonicalSkills(repositoryRoot),
  });
}

export function loadClaudeSkill(repositoryRoot, name) {
  return Object.freeze({
    consumer: "claude-code",
    sourceOfTruth: "skills",
    ...resolveCanonicalSkill(repositoryRoot, name),
  });
}

function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  process.stdout.write(`${JSON.stringify(discoverClaudeSkills(root))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
