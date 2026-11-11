// SPDX-License-Identifier: AGPL-3.0-only
// npm run dev: builds and starts app, browser, proxy and a local test site with docker compose.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { freePort } from "./free-port.mjs";

const envFile = resolve(import.meta.dirname, "..", "deploy", ".env");
if (!existsSync(envFile)) {
  writeFileSync(envFile, `CROSSBAR_BROWSER_SECRET=${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  console.log("Wrote deploy/.env with a random browser secret.");
}
// Pick a host port that's actually free (8080 is often taken), unless one was given.
const up = (process.argv[2] ?? "up") === "up";
if (up && !process.env.CROSSBAR_PORT) {
  const port = await freePort(8080);
  process.env.CROSSBAR_PORT = String(port);
  process.env.CROSSBAR_ORIGIN ??= `http://localhost:${port}`;
  if (port !== 8080) console.log(`Port 8080 is in use; using ${port}.`);
}
const args = ["compose", "--env-file", envFile, "-f", "deploy/compose.yaml", "-f", "deploy/compose.dev.yaml", ...(process.argv.slice(2).length ? process.argv.slice(2) : ["up", "--build"])];
console.log(`docker ${args.join(" ")}\nWhen it's up: open ${process.env.CROSSBAR_ORIGIN ?? "http://localhost:8080"} and find the setup code with  docker compose -f deploy/compose.yaml logs app\nTest pages for agents: http://testsite.test:8090/pages/article (and /pages/infinite, /pages/login, ...)`);
const r = spawnSync("docker", args, { stdio: "inherit", cwd: resolve(import.meta.dirname, "..") });
process.exit(r.status ?? 1);
