import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalPathWithoutSymlinks, filesystemComponentKey } from "../lib/core.mjs";

test("filesystem component keys use NFC plus full Unicode case folding", () => {
  const equivalentGroups = [
    ["Straße", "STRASSE", "strasse"],
    ["ΟΣ", "οσ", "ος"],
    ["ﬃ", "FFI", "ffi"],
    ["É", "E\u0301", "é"],
    ["Ꭰ", "ꭰ"],
    ["ՄՆ", "մն"],
  ];
  for (const group of equivalentGroups) {
    const expected = filesystemComponentKey(group[0]);
    for (const value of group.slice(1)) {
      assert.equal(filesystemComponentKey(value), expected, `${value} did not fold with ${group[0]}`);
    }
  }
});

test("full folding expands compatibility and combining forms deterministically", () => {
  assert.equal(filesystemComponentKey("ẞ"), "ss");
  assert.equal(filesystemComponentKey("ŉ"), "ʼn");
  assert.equal(filesystemComponentKey("ΐ"), "ι\u0308\u0301");
  assert.equal(filesystemComponentKey("և"), "եւ");
  assert.equal(filesystemComponentKey("Ɤ"), "Ɤ");
});

test("canonical path check uses native realpath when an ancestor cannot be listed", { concurrency: false }, () => {
  const original = fs.readdirSync;
  const target = fs.realpathSync.native(os.tmpdir());
  const parent = path.parse(target).root;
  fs.readdirSync = (directory, ...options) => {
    if (directory === parent) {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    }
    return original(directory, ...options);
  };
  try {
    assert.equal(canonicalPathWithoutSymlinks(target, "test"), fs.realpathSync.native(target));
    const [first, ...rest] = target.slice(parent.length).split(path.sep);
    const wrongCase = path.join(parent, first.toUpperCase(), ...rest);
    if (wrongCase !== target && fs.existsSync(wrongCase)) {
      assert.throws(() => canonicalPathWithoutSymlinks(wrongCase, "test"));
    }
  } finally {
    fs.readdirSync = original;
  }
});
