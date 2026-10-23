/**
 * Cross-platform launcher for server.js (works on Windows, macOS, and Linux).
 * Sets env vars before the process starts so Next.js sees them on import.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "dev";
const env = { ...process.env };

if (mode === "dev") {
  env.NEXT_IGNORE_INCORRECT_LOCKFILE = "1";
  if (!env.NODE_ENV) env.NODE_ENV = "development";
} else if (mode === "start") {
  env.NODE_ENV = "production";
}

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js");
const child = spawn(process.execPath, [serverPath], { stdio: "inherit", env });

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
