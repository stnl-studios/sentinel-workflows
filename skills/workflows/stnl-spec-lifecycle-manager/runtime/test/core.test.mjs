import assert from "node:assert/strict";
import test from "node:test";

import { filesystemComponentKey } from "../lib/core.mjs";

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
