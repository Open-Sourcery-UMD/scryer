import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = path.resolve(frontend, "../client");
const destination = path.join(frontend, "public/headless");

execFileSync("npm", ["run", "build:browser"], { cwd: client, stdio: "inherit" });
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(path.join(client, "build/import"), path.join(destination, "import"), { recursive: true });
await cp(path.join(client, "build/vendor"), path.join(destination, "vendor"), { recursive: true });
