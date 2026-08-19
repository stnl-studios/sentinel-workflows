import fs from "node:fs";
import path from "node:path";

import {
  DOMAIN_SKILLS,
  WORKFLOW_SKILLS,
  canonicalSkillRelativePath,
  familyForSkill,
} from "./skill-registry.mjs";

function descriptor(repositoryRoot, name) {
  const relativePath = canonicalSkillRelativePath(name);
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`canonical skill is not discoverable: ${relativePath}`);
  }
  return Object.freeze({
    name,
    family: familyForSkill(name),
    relativePath,
    absolutePath,
  });
}

export function discoverCanonicalSkills(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  return Object.freeze({
    workflows: Object.freeze(WORKFLOW_SKILLS.map((name) => descriptor(root, name))),
    domains: Object.freeze(DOMAIN_SKILLS.map((name) => descriptor(root, name))),
  });
}

export function resolveCanonicalSkill(repositoryRoot, name) {
  const result = descriptor(path.resolve(repositoryRoot), name);
  return Object.freeze({
    ...result,
    content: fs.readFileSync(result.absolutePath, "utf8"),
  });
}
