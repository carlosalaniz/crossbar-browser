// SPDX-License-Identifier: AGPL-3.0-only
// Entry point. `node server/src/main.ts` serves the app; `node server/src/main.ts reset-owner` prints an owner reset code.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Auth } from "@crossbar/auth/auth";
import { LocalPool, localLauncher } from "@crossbar/browser/pool";
import { remoteLauncher } from "@crossbar/browser/remote";
import { AdBlocker } from "@crossbar/browser/adblock";
import { buildServices } from "./services.ts";
import { createApp } from "./http.ts";
import { openDb } from "./db.ts";

const env = process.env;
const dataDir = resolve(env.CROSSBAR_DATA ?? "./data");
const port = Number(env.CROSSBAR_PORT ?? 8080);
const appOrigin = (env.CROSSBAR_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, "");
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0.0.0";

if (process.argv[2] === "reset-owner") {
  const db = openDb(join(dataDir, "crossbar.db"));
  const code = new Auth(db, { appOrigin }).resetOwner();
  console.log(`Owner reset code: ${code}\nOpen ${appOrigin}, choose "Set up", and enter it to set a new owner password. Two-factor and passkeys for the owner are removed.`);
  process.exit(0);
}

async function loadAdblock(): Promise<AdBlocker | undefined> {
  if (env.CROSSBAR_ADBLOCK === "off") return undefined;
  const cache = join(dataDir, "adblock.bin");
  try {
    if (existsSync(cache) && Date.now() - (await import("node:fs")).statSync(cache).mtimeMs < 7 * 24 * 3600_000) return AdBlocker.deserialize(readFileSync(cache));
    const b = await AdBlocker.fromPrebuilt();
    writeFileSync(cache, b.serialize());
    return b;
  } catch (e) {
    console.warn(`Ad blocking lists unavailable (${(e as Error).message}); continuing without them.`);
    return existsSync(cache) ? AdBlocker.deserialize(readFileSync(cache)) : undefined;
  }
}

const launcher = env.CROSSBAR_BROWSER_URL
  ? remoteLauncher(env.CROSSBAR_BROWSER_URL, env.CROSSBAR_BROWSER_SECRET ?? "")
  : localLauncher({
      dataDir,
      proxyServer: env.CROSSBAR_PROXY,
      headless: env.CROSSBAR_HEADLESS !== "0",
      hostResolverRules: env.CROSSBAR_HOST_RESOLVER_RULES,
      extraArgs: env.CROSSBAR_CHROME_ARGS ? env.CROSSBAR_CHROME_ARGS.split(" ") : [],
    });
// Extra sign-in providers (comma-separated hosts): blocked for agents by default and typing refused there.
const signInProviders = (env.CROSSBAR_SIGNIN_PROVIDERS ?? "").split(/[\s,]+/).filter(Boolean);
const pool = new LocalPool(launcher, { extraSignInProviders: signInProviders });
const services = buildServices({
  dataDir,
  pool,
  appOrigin,
  adblock: await loadAdblock(),
  signInProviders,
  pace: { minIntervalMs: env.CROSSBAR_PACE_MS ? Number(env.CROSSBAR_PACE_MS) : undefined, hourlyCap: env.CROSSBAR_HOURLY_CAP ? Number(env.CROSSBAR_HOURLY_CAP) : undefined },
});
const auth = new Auth(services.db, { appOrigin, secureCookies: appOrigin.startsWith("https://"), log: (m) => console.log(m) });
auth.ensureSetupCode();
const webRoot = env.CROSSBAR_WEB ?? resolve(import.meta.dirname, "../../web/dist");
const app = createApp({ services, tokens: services.tokens, auth, version, appOrigin, webRoot });
setInterval(() => {
  services.tokens.sweep();
  services.activity.retention();
}, 6 * 3600_000).unref();
// "::" is dual stack, so http://localhost works whether it resolves to ::1 or 127.0.0.1.
// Hosts and containers without IPv6 fall back to IPv4.
const host = env.CROSSBAR_HOST ?? "::";
app.server.once("error", (e: NodeJS.ErrnoException) => {
  if (host === "::" && (e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL")) app.server.listen(port, "0.0.0.0", ready);
  else {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use. Set CROSSBAR_PORT to a free port.` : e.message);
    process.exit(1);
  }
});
function ready() {
  console.log(`Crossbar ${version} on ${appOrigin} (port ${port})`);
}
app.server.listen(port, host, ready);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.server.close();
    await pool.close();
    process.exit(0);
  });
}
