// SPDX-License-Identifier: AGPL-3.0-only
// Entry point. `node server/src/main.ts` serves the app; `node server/src/main.ts reset-owner` resets the owner to the default password.
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
// CROSSBAR_ORIGIN may list several origins, comma-separated. The first is used in links and
// notifications (in dev, the LAN address so a phone can open them); the rest are also accepted.
const origins = (env.CROSSBAR_ORIGIN ?? `http://localhost:${port}`).split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
const appOrigin = origins[0]!;
const extraOrigins = origins.slice(1);
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0.0.0";

if (process.argv[2] === "reset-owner") {
  const db = openDb(join(dataDir, "crossbar.db"));
  const user = await new Auth(db, { appOrigin }).resetOwner();
  console.log(`The owner "${user}" now has the default password "admin", and two-factor and passkeys are removed. Log in at ${appOrigin} and change it.`);
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
      // Headful unless asked: headless announces itself to sites (audit S14).
      headless: env.CROSSBAR_HEADLESS === "1",
      hostResolverRules: env.CROSSBAR_HOST_RESOLVER_RULES,
      extraArgs: env.CROSSBAR_CHROME_ARGS ? env.CROSSBAR_CHROME_ARGS.split(" ") : [],
    });
// Extra sign-in providers (comma-separated hosts).
const signInProviders = (env.CROSSBAR_SIGNIN_PROVIDERS ?? "").split(/[\s,]+/).filter(Boolean);
// Browsers with no open tab stop after a while to save memory; profiles stay on disk (build plan step 10).
const idleMinutes = Number(env.CROSSBAR_BROWSER_IDLE_MINUTES ?? 10);
const pool = new LocalPool(launcher, { extraSignInProviders: signInProviders, idleStopMs: idleMinutes > 0 ? idleMinutes * 60_000 : undefined });
const services = buildServices({
  dataDir,
  pool,
  appOrigin,
  adblock: await loadAdblock(),
  signInProviders,
  pace: { minIntervalMs: env.CROSSBAR_PACE_MS ? Number(env.CROSSBAR_PACE_MS) : undefined, hourlyCap: env.CROSSBAR_HOURLY_CAP ? Number(env.CROSSBAR_HOURLY_CAP) : undefined },
});
const auth = new Auth(services.db, { appOrigin, secureCookies: appOrigin.startsWith("https://"), log: (m) => console.log(m) });
await auth.ensureDefaultOwner();
const webRoot = env.CROSSBAR_WEB ?? resolve(import.meta.dirname, "../../web/dist");
const app = createApp({ services, tokens: services.tokens, auth, version, appOrigin, extraOrigins, webRoot });
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
  console.log(`Crossbar ${version} on ${[appOrigin, ...extraOrigins].join(" and ")} (port ${port})`);
}
app.server.listen(port, host, ready);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    app.server.close();
    // Close browsers properly; if that hangs, exiting still kills them (launch.ts).
    await Promise.race([pool.close(), new Promise((r) => setTimeout(r, 5000))]);
    process.exit(0);
  });
}
