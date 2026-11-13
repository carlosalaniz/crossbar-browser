// SPDX-License-Identifier: AGPL-3.0-only
// Site adapters: declarative site files. No changes to auth/, browser/ or proxy/ needed to add one.
import { google } from "../google/site.ts";
import { reddit } from "../reddit/site.ts";

export interface SiteAdapter {
  id: string;
  /** Domain group: registrable domains that belong together. */
  domains: string[];
  /** Non-GET requests that only read (GraphQL operationNames or endpoint patterns). */
  readOperations?: { graphql?: string[]; endpoints?: Array<{ method: string; path: RegExp }> };
  /** Consent banner: selector for "reject all". */
  consent?: { rejectSelector: string };
  /** Telemetry endpoints (host + path): refused quietly, never a ticket. */
  telemetry?: RegExp[];
  /** Telemetry recognised by its body on paths that also carry real actions (host + path, and body). */
  telemetryBodies?: Array<{ path: RegExp; body: RegExp }>;
  /** Paths that always ask on signed-in sessions. */
  sensitivePaths?: RegExp[];
  /** Items for scroll-and-extract. */
  items?: { selector: string; keyAttr?: string };
  /**
   * Hosts the adapter prefers for reading, per profile (ADR 0012). Reddit: old.reddit.com paginates
   * server-side but walls logged-out visitors, so it's only for the signed-in profile.
   */
  readHosts?: { signedIn?: string; anonymous?: string };
}

export const ADAPTERS: SiteAdapter[] = [reddit, google];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function adapterFor(url: string): SiteAdapter | undefined {
  const host = hostOf(url);
  return ADAPTERS.find((a) => a.domains.some((d) => host === d || host.endsWith(`.${d}`)));
}

/** True if both registrable domains are in one adapter's domain group (or are the same domain). */
export function sameDomainGroup(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return ADAPTERS.some((x) => x.domains.includes(a) && x.domains.includes(b));
}

/** True if this request goes to one of the adapter's telemetry endpoints. */
export function isTelemetry(url: string, body?: string): boolean {
  let hp = "";
  try {
    const u = new URL(url);
    hp = `${u.hostname}${u.pathname}`;
  } catch {
    return false;
  }
  const a = adapterFor(url);
  if (a?.telemetry?.some((re) => re.test(hp))) return true;
  return !!body && !!a?.telemetryBodies?.some((t) => t.path.test(hp) && t.body.test(body.slice(0, 200)));
}

/** True if this non-GET request is on the adapter's read list. */
export function matchReadOperation(url: string, method: string, graphqlOperation: string | null): boolean {
  const a = adapterFor(url);
  if (!a?.readOperations) return false;
  if (graphqlOperation && a.readOperations.graphql?.includes(graphqlOperation)) return true;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return !!a.readOperations.endpoints?.some((e) => e.method === method && e.path.test(path));
}
