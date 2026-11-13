// SPDX-License-Identifier: AGPL-3.0-only
// Ad blocking (ADR 0003): request blocking in the network gate, cosmetic filtering in the page.
// @ghostery/adblocker is MPL-2.0 and used unmodified.
import { FiltersEngine, Request } from "@ghostery/adblocker";
import { parse as parseDomain } from "tldts-experimental";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GateRequest } from "./gate.ts";
import { candidates, matchHeaders, parseHeaderRules, type HeaderRule } from "./adblock-headers.ts";

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

/** Marks a serialized blocker that carries header rules after the engine (older caches are the bare engine). */
const MAGIC = Buffer.from("CBADB1\n");

export class AdBlocker {
  readonly engine: FiltersEngine;
  /** uBO `header=` rules, which the engine drops (ADR 0036). */
  readonly headerRules: HeaderRule[];
  constructor(engine: FiltersEngine, headerRules: HeaderRule[] = []) {
    this.engine = engine;
    this.headerRules = headerRules;
  }

  /** Parse filter lists (EasyList, EasyPrivacy, ...). Tests use small fixture lists. */
  static fromLists(lists: string[]): AdBlocker {
    const text = lists.join("\n");
    return new AdBlocker(FiltersEngine.parse(text, { enableCompression: false, loadCosmeticFilters: true, loadNetworkFilters: true, loadExtendedSelectors: true }), parseHeaderRules(text));
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
    const text = [...lists, EXTRA_FILTERS].join("\n");
    return new AdBlocker(FiltersEngine.parse(text, { loadExtendedSelectors: true, loadCosmeticFilters: true, loadNetworkFilters: true, enableCompression: true }), parseHeaderRules(text));
  }

  /** Downloads the prebuilt EasyList + EasyPrivacy engine. Not used in CI (no live sites). */
  static async fromPrebuilt(): Promise<AdBlocker> {
    return new AdBlocker(await FiltersEngine.fromPrebuiltAdsAndTracking(fetch));
  }

  /** The engine, then the header rules' source lines. */
  serialize(): Uint8Array {
    const engine = this.engine.serialize();
    const rules = Buffer.from(this.headerRules.map((r) => r.source).join("\n"));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(engine.length);
    return Buffer.concat([MAGIC, len, engine, rules]);
  }
  static deserialize(buf: Uint8Array): AdBlocker {
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (!b.subarray(0, MAGIC.length).equals(MAGIC)) return new AdBlocker(FiltersEngine.deserialize(buf));
    const len = b.readUInt32BE(MAGIC.length);
    const start = MAGIC.length + 4;
    const engine = FiltersEngine.deserialize(new Uint8Array(b.subarray(start, start + len)));
    return new AdBlocker(engine, parseHeaderRules(b.subarray(start + len).toString("utf8")));
  }

  /** Whether the gate should block this request as an ad or tracker. Top-level documents are never blocked. */
  shouldBlock(r: GateRequest, sourceUrl: string): boolean {
    return this.check(r, sourceUrl).block;
  }

  /**
   * Block, and with what to answer: a rule with redirect= (uBO's noopjs, 1x1.gif...) gets a harmless stand-in
   * instead of an error, so a page that checks its script loaded doesn't break (live: Ad-Shield blanked
   * solsticeforum.com and opened a dialog when its loader failed).
   */
  check(r: GateRequest, sourceUrl: string): { block: boolean; respond?: { contentType: string; bodyBase64: string } } {
    if (r.resourceType === "Document" && r.targetType === "page") return { block: false };
    const type = r.resourceType === "Document" ? "sub_frame" : (TYPE_MAP[r.resourceType] ?? "other");
    const { match, redirect } = this.engine.match(Request.fromRawDetails({ url: r.url, sourceUrl, type: type as never }));
    if (!match) return { block: false };
    if (!redirect || r.resourceType === "Document") return { block: true };
    const comma = redirect.dataUrl.indexOf(",");
    const bodyBase64 = comma >= 0 ? redirect.dataUrl.slice(comma + 1) : "";
    // A stylesheet must be served as CSS, a script as JavaScript, or Chrome refuses the stand-in itself.
    const contentType = r.resourceType === "Stylesheet" ? "text/css" : r.resourceType === "Script" ? "application/javascript" : redirect.contentType.replace(/;base64$/, "");
    return { block: true, respond: { contentType, bodyBase64 } };
  }

  /**
   * Header rules that could block this request once its response arrives (empty: nothing to check). The
   * gate then pauses the response and calls blockedByHeaders.
   */
  responseRules(r: GateRequest, sourceUrl: string): HeaderRule[] {
    if (r.resourceType === "Document" && r.targetType === "page") return [];
    return candidates(this.headerRules, r, sourceUrl);
  }

  /** The rule a response's headers match, if any: the request is then blocked like any other ad. */
  blockedByHeaders(rules: HeaderRule[], headers: Array<{ name: string; value: string }>): HeaderRule | undefined {
    return matchHeaders(rules, headers);
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
