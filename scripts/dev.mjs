// SPDX-License-Identifier: AGPL-3.0-only
// npm run dev: builds and starts app, browser, proxy and a local test site with docker compose.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const envFile = resolve(import.meta.dirname, "..", "deploy", ".env");
if (!existsSync(envFile)) {
  writeFileSync(envFile, `CROSSBAR_BROWSER_SECRET=${randomBytes(32).toString("base64url")}\nCROSSBAR_ORIGIN=http://localhost:8080\n`, { mode: 0o600 });
  console.log("Wrote deploy/.env with a random browser secret.");
}
const args = ["compose", "--env-file", envFile, "-f", "deploy/compose.yaml", "-f", "deploy/compose.dev.yaml", ...(process.argv.slice(2).length ? process.argv.slice(2) : ["up", "--build"])];
console.log(`docker ${args.join(" ")}\nWhen it's up: open http://localhost:8080 and find the setup code with  docker compose -f deploy/compose.yaml logs app\nTest pages for agents: http://testsite.test:8090/pages/article (and /pages/infinite, /pages/login, ...)`);
const r = spawnSync("docker", args, { stdio: "inherit", cwd: resolve(import.meta.dirname, "..") });
process.exit(r.status ?? 1);
