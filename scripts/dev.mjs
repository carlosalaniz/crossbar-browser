// SPDX-License-Identifier: AGPL-3.0-only
// npm run dev: builds and starts app, browser, proxy and the local test site with docker compose
// (`dev` profile). The proxy is built from the proxy-dev target with the dev-only test-site allowlist on.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { freePort } from "./free-port.mjs";
import { devOrigins } from "./lan.mjs";

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
  process.env.CROSSBAR_ORIGIN = devOrigins(port);
  if (port !== 8080) console.log(`Port 8080 is in use; using ${port}.`);
}
// The browser's time zone and language follow this machine's (audit S33).
process.env.CROSSBAR_TZ ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.CROSSBAR_LANG ??= Intl.DateTimeFormat().resolvedOptions().locale;
const args = ["compose", "--env-file", envFile, "-f", "deploy/compose.yaml", "--profile", "dev", ...(process.argv.slice(2).length ? process.argv.slice(2) : ["up", "--build"])];
process.env.CROSSBAR_ORIGIN ??= devOrigins(process.env.CROSSBAR_PORT ?? 8080);
console.log(`docker ${args.join(" ")}
When it's up: open ${process.env.CROSSBAR_ORIGIN.split(",").join(" or ")} (the first works from a phone on the same Wi-Fi)
Test site for agents: http://site-a.test:8090/ (every scenario), http://testsite.test:8090/pages/article (browser/ test pages)`);
const r = spawnSync("docker", args, {
  stdio: "inherit",
  cwd: resolve(import.meta.dirname, ".."),
  env: { ...process.env, CROSSBAR_DEV_TESTSITE: "1", CROSSBAR_PROXY_TARGET: "proxy-dev", CROSSBAR_PACE_MS: process.env.CROSSBAR_PACE_MS ?? "1000", CROSSBAR_SIGNIN_PROVIDERS: process.env.CROSSBAR_SIGNIN_PROVIDERS ?? "accounts.idp.test" },
});
process.exit(r.status ?? 1);
