import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverCanonicalSkills,
  resolveCanonicalSkill,
} from "../../scripts/lib/skill-discovery.mjs";

export function discoverCodexSkills(repositoryRoot) {
  return Object.freeze({
    consumer: "codex",
    sourceOfTruth: "skills",
    ...discoverCanonicalSkills(repositoryRoot),
  });
}

export function loadCodexSkill(repositoryRoot, name) {
  return Object.freeze({
    consumer: "codex",
    sourceOfTruth: "skills",
    ...resolveCanonicalSkill(repositoryRoot, name),
  });
}

function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  process.stdout.write(`${JSON.stringify(discoverCodexSkills(root))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
