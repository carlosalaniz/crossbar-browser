// SPDX-License-Identifier: AGPL-3.0-only
// Ad blocking (ADR 0003): request blocking in the network gate, cosmetic filtering in the page.
// @ghostery/adblocker is MPL-2.0 and used unmodified.
import { FiltersEngine, Request } from "@ghostery/adblocker";
import { parse as parseDomain } from "tldts-experimental";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GateRequest } from "./gate.ts";

const TYPE_MAP: Record<string, string> = {
  Document: "main_frame",
  Stylesheet: "stylesheet",
  Image: "image",
  Media: "media",
  Font: "font",
  Script: "script",
  XHR: "xmlhttprequest",
  Fetch: "xmlhttprequest",
  Ping: "ping",
  WebSocket: "websocket",
  CSPViolationReport: "csp_report",
  Prefetch: "other",
  EventSource: "other",
  Manifest: "other",
  Other: "other",
};

/** The default lists of uBlock Origin (ADR 0034). Fetched by the app, never by the browser. */
export const UBO_LISTS = [
  "https://ublockorigin.github.io/uAssets/filters/filters.min.txt",
  "https://ublockorigin.github.io/uAssets/filters/privacy.min.txt",
  "https://ublockorigin.github.io/uAssets/filters/badware.min.txt",
  "https://ublockorigin.github.io/uAssets/filters/quick-fixes.min.txt",
  "https://ublockorigin.github.io/uAssets/filters/unbreak.min.txt",
  "https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt",
  "https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt",
];

/** Crossbar's own filters (ADR 0034), as data next to the code. */
export const EXTRA_FILTERS = readFileSync(fileURLToPath(new URL("./adblock-extra.txt", import.meta.url)), "utf8");

export class AdBlocker {
  readonly engine: FiltersEngine;
  constructor(engine: FiltersEngine) {
    this.engine = engine;
  }

  /** Parse filter lists (EasyList, EasyPrivacy, ...). Tests use small fixture lists. */
  static fromLists(lists: string[]): AdBlocker {
    return new AdBlocker(FiltersEngine.parse(lists.join("\n"), { enableCompression: false, loadCosmeticFilters: true, loadNetworkFilters: true, loadExtendedSelectors: true }));
  }

  /**
   * uBlock Origin's own lists and the third-party lists it ships with (EasyList, EasyPrivacy), with extended
   * selectors (:has-text() and friends) loaded. Not used in CI (no live sites).
   */
  static async fromUblockLists(fetchFn: typeof fetch = fetch): Promise<AdBlocker> {
    const lists = await Promise.all(
      UBO_LISTS.map(async (u) => {
        const r = await fetchFn(u);
        if (!r.ok) throw new Error(`${u}: ${r.status}`);
        return r.text();
      }),
    );
    // Crossbar's own rules last (adblock-extra.txt): what uBO's lists leave to per-site rules.
    return new AdBlocker(FiltersEngine.parse([...lists, EXTRA_FILTERS].join("\n"), { loadExtendedSelectors: true, loadCosmeticFilters: true, loadNetworkFilters: true, enableCompression: true }));
  }

  /** Downloads the prebuilt EasyList + EasyPrivacy engine. Not used in CI (no live sites). */
  static async fromPrebuilt(): Promise<AdBlocker> {
    return new AdBlocker(await FiltersEngine.fromPrebuiltAdsAndTracking(fetch));
  }

  serialize(): Uint8Array {
    return this.engine.serialize();
  }
  static deserialize(buf: Uint8Array): AdBlocker {
    return new AdBlocker(FiltersEngine.deserialize(buf));
  }

  /** Whether the gate should block this request as an ad or tracker. Top-level documents are never blocked. */
  shouldBlock(r: GateRequest, sourceUrl: string): boolean {
    if (r.resourceType === "Document" && r.targetType === "page") return false;
    const type = r.resourceType === "Document" ? "sub_frame" : (TYPE_MAP[r.resourceType] ?? "other");
    const { match } = this.engine.match(Request.fromRawDetails({ url: r.url, sourceUrl, type: type as never }));
    return match;
  }

  /** CSS that hides ad elements on this page. */
  /** Generic hide rules match on the page's class names, ids and hrefs, so pass them in (page script domTokens). */
  cosmeticCss(pageUrl: string, dom: { classes?: string[]; ids?: string[]; hrefs?: string[] } = {}): string {
    const u = new URL(pageUrl);
    // domain is the registrable domain: with the hostname here, "amazon.com##..." rules never matched www.amazon.com.
    const base = { url: pageUrl, hostname: u.hostname, domain: parseDomain(u.hostname).domain ?? u.hostname, getInjectionRules: false, getExtendedRules: false };
    const site = this.engine.getCosmeticsFilters({ ...base, getBaseRules: true, getRulesFromDOM: false });
    const fromDom = this.engine.getCosmeticsFilters({ ...base, ...dom, getBaseRules: false, getRulesFromHostname: false, getRulesFromDOM: true });
    return [site.styles, fromDom.styles].filter(Boolean).join("\n");
  }

  /**
   * Extended hide rules for this page (uBO's :has-text(), :upward()...): CSS can't express them, so the page
   * script evaluates them and leaves those elements out of what the agent reads. Rules that change styles or
   * attributes instead of hiding (a directive) are left out.
   */
  extendedSelectors(pageUrl: string, dom: { classes?: string[]; ids?: string[]; hrefs?: string[] } = {}): unknown[] {
    const u = new URL(pageUrl);
    const base = { url: pageUrl, hostname: u.hostname, domain: parseDomain(u.hostname).domain ?? u.hostname, getInjectionRules: false, getExtendedRules: true };
    const site = this.engine.getCosmeticsFilters({ ...base, getBaseRules: true, getRulesFromDOM: false });
    const fromDom = this.engine.getCosmeticsFilters({ ...base, ...dom, getBaseRules: false, getRulesFromHostname: false, getRulesFromDOM: true });
    // `attribute` is Ghostery's own hide marker, not a rule action; a `directive` (:style, :remove-attr...) is.
    return [...site.extended, ...fromDom.extended].filter((e) => !e.directive).map((e) => e.ast);
  }
}
