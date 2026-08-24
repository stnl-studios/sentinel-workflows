import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const FIXTURES = path.join(HERE, "fixtures");

export async function temporary(t, prefix = "stnl-roadmap-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t?.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

export async function representativeRaw() {
  return JSON.parse(await fs.readFile(path.join(FIXTURES, "representative-roadmap.json"), "utf8"));
}

export async function project(t) {
  const root = await temporary(t, "stnl-roadmap-project-");
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs/checkout-stories.md"), "# Checkout stories\n\nUS-001 US-002 US-003 US-004\n", "utf8");
  return root;
}

export async function candidateFile(t, value) {
  const root = await temporary(t, "stnl-roadmap-candidate-");
  const file = path.join(root, "candidate.json");
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

export function clone(value) {
  return structuredClone(value);
}
