import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

assert.equal((await fs.readFile("src/message.txt", "utf8")).trim(), "web source exists");
