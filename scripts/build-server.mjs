import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const result = spawnSync(process.execPath, [cli, "build", "--webpack", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CAKEBURN_SERVER: "1", NEXT_TELEMETRY_DISABLED: "1" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Next's standalone server needs both directories alongside server.js.
mkdirSync(new URL("../.next/standalone/.next/", import.meta.url), { recursive: true });
cpSync(new URL("../public/", import.meta.url), new URL("../.next/standalone/public/", import.meta.url), { recursive: true });
cpSync(new URL("../.next/static/", import.meta.url), new URL("../.next/standalone/.next/static/", import.meta.url), { recursive: true });
