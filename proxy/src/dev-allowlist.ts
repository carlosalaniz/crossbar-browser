// SPDX-License-Identifier: AGPL-3.0-only
// DEV ONLY. Lets the browser reach the local test site, which lives on a private address the proxy
// would otherwise refuse (Access Model L1). Read only when CROSSBAR_DEV_TESTSITE=1, and never in a
// production build.
//
// The allowlisted names are *pinned*: they are never looked up in DNS. Each one resolves to the
// test site's own address (the `target`, by default the compose service `testsite`) and nothing else.
// So an allowlisted name can't be pointed at the LAN, IP literals are never covered, and the LAN-block
// targets (10.0.0.1, 169.254.169.254, ::1, 100.64/10, loopback.test, ...) are still refused.
import net from "node:net";
import { existsSync } from "node:fs";

/** Baked into the production proxy image by deploy/Dockerfile; removed only in the proxy-dev target. */
export const PRODUCTION_MARKER = new URL("../PRODUCTION_BUILD", import.meta.url);

/** Exactly the test site's hostnames. No wildcards: `loopback.test` must stay refused. */
export const DEV_TESTSITE_HOSTS: readonly string[] = Object.freeze([
  "site-a.test",
  "site-b.test",
  "site-c.test",
  "exfil.test",
  "tracker.test",
  "accounts.idp.test",
  "captcha.test",
  "testsite.test",
]);

export interface DevAllowlist {
  hosts: ReadonlySet<string>;
  /** Hostname or IP of the test site. Its addresses are the only ones the allowlisted names may reach. */
  target: string;
  /** Extra port the allowlisted names may use (the test site's port when it isn't 80). */
  port?: number;
}

/**
 * A production build: the image carries proxy/PRODUCTION_BUILD (a file, so no environment variable can
 * unset it), or NODE_ENV=production, or CROSSBAR_BUILD=production.
 */
export function isProductionBuild(env: NodeJS.ProcessEnv, marker: URL | string = PRODUCTION_MARKER): boolean {
  return existsSync(marker) || env.NODE_ENV === "production" || env.CROSSBAR_BUILD === "production";
}

/**
 * Returns the allowlist when CROSSBAR_DEV_TESTSITE=1, null otherwise.
 * Throws (so the proxy refuses to start) if the flag is set in a production build.
 */
export function devAllowlistFromEnv(env: NodeJS.ProcessEnv, marker: URL | string = PRODUCTION_MARKER): DevAllowlist | null {
  if (env.CROSSBAR_DEV_TESTSITE === undefined || env.CROSSBAR_DEV_TESTSITE === "" || env.CROSSBAR_DEV_TESTSITE === "0") return null;
  if (env.CROSSBAR_DEV_TESTSITE !== "1") throw new Error(`CROSSBAR_DEV_TESTSITE must be 1 or unset, got "${env.CROSSBAR_DEV_TESTSITE}"`);
  if (isProductionBuild(env, marker)) throw new Error("CROSSBAR_DEV_TESTSITE=1 is not allowed in a production build; refusing to start");
  const port = env.CROSSBAR_DEV_TESTSITE_PORT ? Number(env.CROSSBAR_DEV_TESTSITE_PORT) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error("CROSSBAR_DEV_TESTSITE_PORT must be a port number");
  return { hosts: new Set(DEV_TESTSITE_HOSTS), target: env.CROSSBAR_DEV_TESTSITE_TARGET || "testsite", port };
}

export function devAllowlistWarning(a: DevAllowlist): string {
  const bar = "!".repeat(78);
  return [
    bar,
    "!! CROSSBAR_DEV_TESTSITE=1: DEV-ONLY ALLOWLIST IS ON",
    `!! ${a.hosts.size} test-site hostnames are pinned to ${a.target}${a.port ? `:${a.port}` : ""} and bypass the private-range check.`,
    "!! Never run this in production. Every other address is still checked.",
    bar,
  ].join("\n");
}

/** Lower-cased, trailing dot removed. IP literals are never on the list. */
export function allowlisted(a: DevAllowlist | null | undefined, host: string): boolean {
  if (!a) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  return !net.isIP(h) && a.hosts.has(h);
}
