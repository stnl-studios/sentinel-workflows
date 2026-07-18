import process from "node:process";

import { publishCandidate } from "../lib/publisher.mjs";

const [target, candidate, manifest] = process.argv.slice(2);

try {
  await publishCandidate("RESUME", target, candidate, {
    manifestPath: manifest,
    beforePublish: async () => {
      process.send?.({ state: "locked" });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("publisher child release timeout")), 20_000);
        process.once("message", (message) => {
          if (message?.state !== "release") {
            clearTimeout(timeout);
            reject(new Error("publisher child received an invalid release message"));
            return;
          }
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  });
  process.send?.({ state: "complete" });
} catch (error) {
  process.send?.({ state: "error", message: error.stack ?? error.message });
  process.exitCode = 1;
}

