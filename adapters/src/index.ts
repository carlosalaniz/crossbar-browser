// SPDX-License-Identifier: AGPL-3.0-only
// Site adapters: declarative site files. No changes to auth/, browser/ or proxy/ needed to add one.
import { reddit } from "../reddit/site.ts";

export interface SiteAdapter {
  id: string;
  /** Domain group: registrable domains that belong together. */
  domains: string[];
  /** Non-GET requests that only read (GraphQL operationNames or endpoint patterns). */
  readOperations?: { graphql?: string[]; endpoints?: Array<{ method: string; path: RegExp }> };
  /** Consent banner: selector for "reject all". */
  consent?: { rejectSelector: string };
  /** Paths that always ask on signed-in sessions. */
  sensitivePaths?: RegExp[];
  /** Items for scroll-and-extract. */
  items?: { selector: string; keyAttr?: string };
  /** Host the adapter prefers for reading (e.g. old.reddit.com). */
  preferredReadHost?: string;
}

export const ADAPTERS: SiteAdapter[] = [reddit];

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
