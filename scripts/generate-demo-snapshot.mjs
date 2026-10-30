import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "frontend/data/demo-result.json");
const response = JSON.parse(
  execFileSync(path.join(root, "engine/build/scryer-native"), {
    cwd: root,
    input: JSON.stringify({ schemaVersion: "1", operation: "demo" }),
    encoding: "utf8",
  }),
);

if (response.schemaVersion !== "1" || response.operation !== "demo" || !response.result) {
  throw new Error("Native engine did not return a versioned demo result");
}

const serialized = `${JSON.stringify(response, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== serialized) {
    throw new Error("Synthetic demo snapshot is stale; regenerate from the native engine");
  }
} else {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, serialized);
}
