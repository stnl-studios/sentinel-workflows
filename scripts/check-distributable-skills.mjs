#!/usr/bin/env node

import { basename, resolve } from "node:path";
import {
  checkDistributableSkill,
  LIFECYCLE_DISTRIBUTION_POLICY,
} from "./lib/check-distributable-skill.mjs";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  process.stderr.write("usage: node scripts/check-distributable-skills.mjs <skill-root> [...]\n");
  process.exitCode = 2;
} else {
  let failed = false;
  for (const value of roots) {
    const root = resolve(value);
    const policy =
      basename(root) === "stnl-spec-lifecycle-manager" ? LIFECYCLE_DISTRIBUTION_POLICY : {};
    const findings = await checkDistributableSkill(root, policy);
    if (findings.length === 0) {
      process.stdout.write(`PASS: distributable skill is self-contained: ${root}\n`);
    } else {
      failed = true;
      for (const finding of findings) {
        process.stderr.write(`SELF_CONTAINMENT_ERROR: ${root}: ${finding}\n`);
      }
    }
  }
  if (failed) {
    process.exitCode = 1;
  }
}
