// SPDX-License-Identifier: AGPL-3.0-only
// Ad blocking (ADR 0003): request blocking in the network gate, cosmetic filtering in the page.
// @ghostery/adblocker is MPL-2.0 and used unmodified.
import { FiltersEngine, Request } from "@ghostery/adblocker";
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

export class AdBlocker {
  readonly engine: FiltersEngine;
  constructor(engine: FiltersEngine) {
    this.engine = engine;
  }

  /** Parse filter lists (EasyList, EasyPrivacy, ...). Tests use small fixture lists. */
  static fromLists(lists: string[]): AdBlocker {
    return new AdBlocker(FiltersEngine.parse(lists.join("\n"), { enableCompression: false, loadCosmeticFilters: true, loadNetworkFilters: true }));
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
    const base = { url: pageUrl, hostname: u.hostname, domain: u.hostname, getInjectionRules: false, getExtendedRules: false };
    const site = this.engine.getCosmeticsFilters({ ...base, getBaseRules: true, getRulesFromDOM: false });
    const fromDom = this.engine.getCosmeticsFilters({ ...base, ...dom, getBaseRules: false, getRulesFromHostname: false, getRulesFromDOM: true });
    return [site.styles, fromDom.styles].filter(Boolean).join("\n");
  }
}
