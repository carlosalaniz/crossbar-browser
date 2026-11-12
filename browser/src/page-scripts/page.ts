// SPDX-License-Identifier: AGPL-3.0-only
// In-page code. Bundled by esbuild and run in the "crossbar" isolated world (ADR 0005):
// it shares the DOM with the page but not its globals.
//
// Adapted from MD-This-Page (https://github.com/Ademking/MD-This-Page, MIT, (c) Adem Kouki):
// the visible-only clone, the wait for single-page apps, and the whole-page fallback (ADR 0002).
import * as DefuddleModule from "defuddle/full";

// defuddle/full is a UMD bundle; its default export lands at different depths under different bundlers.
type DefuddleCtor = new (doc: Document, opts?: Record<string, unknown>) => { parse(): { content?: string } };
const mod = DefuddleModule as unknown as { default?: unknown; createMarkdownContent?: (html: string, url: string) => string };
const inner = mod.default as { default?: unknown; createMarkdownContent?: (html: string, url: string) => string } | DefuddleCtor | undefined;
const Defuddle = ((inner as { default?: unknown })?.default ?? inner) as DefuddleCtor;
const createMarkdownContent = (mod.createMarkdownContent ?? (inner as { createMarkdownContent?: (h: string, u: string) => string }).createMarkdownContent)!;

export interface ExtractParams {
  includeLinks?: boolean;
  /** Below this many words from Defuddle, fall back to converting the whole visible page. */
  minWords?: number;
  /** How long the DOM must be quiet before extracting (SPA render wait). */
  quietMs?: number;
  maxWaitMs?: number;
}

export interface LinkItem {
  ref: string;
  kind: "link" | "button" | "input" | "select" | "textarea" | "option" | "clickable";
  text: string;
  href?: string;
  region: string;
}

export interface ExtractResult {
  url: string;
  title: string;
  content: string;
  links?: LinkItem[];
  wordCount: number;
  usedFallback: boolean;
}

export interface CollectParams {
  selector?: string;
  /** Attribute that holds a stable key (adapter-provided), else hash(href + text). */
  keyAttr?: string;
  maxTextChars?: number;
}

export interface CollectedItem {
  key: string;
  ref: string;
  text: string;
  href?: string;
}

export interface ScrollState {
  scrollY: number;
  viewportHeight: number;
  scrollHeight: number;
  atEnd: boolean;
}

/**
 * Refs live here, in the isolated world, never on the page's elements: an attribute on the live DOM is
 * something the page can find or watch being added (docs/automation-signal-audit.md S02). The attribute
 * name below is only written onto the detached clone used for extraction.
 */
const REF_ATTR = "data-cb-ref";
const byRef = new Map<string, WeakRef<Element>>();
const refOfEl = new WeakMap<Element, string>();
const clickables = new WeakSet<Element>();
const INTERACTIVE =
  'a[href], button, input:not([type=hidden]), textarea, select, summary, label, [onclick], [tabindex]:not([tabindex="-1"]), ' +
  "[role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=radio], [role=checkbox], [role=switch], [role=treeitem]";
const MAX_SCAN = 6000;
const REGION_SELECTOR = "header, nav, main, aside, footer, form, dialog, [role=banner], [role=navigation], [role=main], [role=complementary], [role=contentinfo], [role=dialog]";

let refCounter = 0;

const hasRef = (el: Element) => refOfEl.has(el);
/** The element's ref, giving it one if it has none. `clickable`: seen as clickable by its cursor alone. */
function refFor(el: Element, clickable = false): string {
  let r = refOfEl.get(el);
  if (!r) {
    r = `e${++refCounter}`;
    refOfEl.set(el, r);
    byRef.set(r, new WeakRef(el));
  }
  if (clickable) clickables.add(el);
  return r;
}
/** The live element for a ref, or null if it's gone from the document. */
function elementByRef(ref: string): Element | null {
  const el = byRef.get(ref)?.deref();
  return el && el.isConnected ? el : null;
}
/** Nearest ancestor-or-self with a ref. */
function refAncestor(el: Element | null): Element | null {
  for (let n = el; n; n = n.parentElement) if (refOfEl.has(n)) return n;
  return null;
}
/** Every live element with a ref, in document order. */
function refElements(): Element[] {
  const out: Element[] = [];
  for (const [ref, w] of byRef) {
    const el = w.deref();
    if (el?.isConnected) out.push(el);
    else byRef.delete(ref);
  }
  return out.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return true;
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
  if (Number(s.opacity) === 0) return false;
  if (parseFloat(s.fontSize) === 0) return false;
  if (s.clipPath === "inset(50%)" || s.clip === "rect(0px, 0px, 0px, 0px)" || s.clip === "rect(1px, 1px, 1px, 1px)") return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0 && s.overflow !== "visible") return false;
  // Pushed far off-canvas to hide it from people but not from scrapers.
  if (r.right < -1000 || r.bottom < -1000 + -window.scrollY) return false;
  return true;
}

/** Gives every visible interactive element a stable ref. Existing refs are kept. */
export function tagRefs(root: ParentNode = document): void {
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    if (!hasRef(el) && isVisible(el)) refFor(el);
  }
  // What a person sees as clickable: the pointer cursor starts on this element (not inherited from a
  // clickable parent), it's a sensible size, and it isn't inside something that already has a ref.
  let scanned = 0;
  for (const el of (root as Document | Element).querySelectorAll("body *")) {
    if (++scanned > MAX_SCAN) break;
    if (hasRef(el) || !(el instanceof HTMLElement)) continue;
    if (getComputedStyle(el).cursor !== "pointer") continue;
    const parent = el.parentElement;
    if (parent && getComputedStyle(parent).cursor === "pointer") continue;
    if (refAncestor(el)) continue;
    const r = el.getBoundingClientRect();
    // Up to a full-width row (options and list items often are), but not a whole section of the page.
    if (r.width < 4 || r.height < 4 || r.width > innerWidth + 1 || r.height > Math.min(600, innerHeight * 0.75) || !isVisible(el)) continue;
    if (!(el.innerText ?? "").trim() && !el.getAttribute("aria-label") && !el.getAttribute("title") && !el.querySelector("img, svg")) continue;
    refFor(el, true);
  }
}

/** Deep clone that drops hidden subtrees, so hidden text (and hidden prompt injection) never reaches the agent. */
export function cloneVisible(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(false);
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return null;
  if (!isVisible(el)) return null;
  const copy = el.cloneNode(false) as Element;
  // The clone is detached, so marking it is invisible to the page.
  const ref = refOfEl.get(el);
  if (ref) copy.setAttribute(REF_ATTR, ref);
  if (tag === "input" || tag === "textarea" || tag === "select") return copy;
  for (const child of el.childNodes) {
    const c = cloneVisible(child);
    if (c) copy.appendChild(c);
  }
  // Open shadow roots: flatten their visible content in.
  if ((el as HTMLElement).shadowRoot) {
    for (const child of (el as HTMLElement).shadowRoot!.childNodes) {
      const c = cloneVisible(child);
      if (c) copy.appendChild(c);
    }
  }
  return copy;
}

function textOf(el: Element): string {
  const own = (el as HTMLElement).innerText ?? el.textContent ?? "";
  const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? (el as HTMLInputElement).placeholder ?? (el as HTMLInputElement).value ?? "";
  return (own.trim() || label.trim()).replace(/\s+/g, " ").slice(0, 200);
}

function kindOf(el: Element): LinkItem["kind"] {
  const t = el.tagName.toLowerCase();
  const role = el.getAttribute("role") ?? "";
  if (/^(option|radio|menuitemradio|menuitemcheckbox|checkbox|switch|treeitem)$/.test(role)) return "option";
  if (clickables.has(el) || (t !== "a" && t !== "button" && t !== "input" && t !== "select" && t !== "textarea" && !role && (el.hasAttribute("onclick") || el.hasAttribute("tabindex")))) return "clickable";
  if (t === "a" || el.getAttribute("role") === "link") return "link";
  if (t === "input") return (el as HTMLInputElement).type === "submit" || (el as HTMLInputElement).type === "button" ? "button" : "input";
  if (t === "select") return "select";
  if (t === "textarea") return "textarea";
  return "button";
}

function regionOf(el: Element): string {
  const r = el.closest(REGION_SELECTOR);
  if (!r) return "body";
  const role = r.getAttribute("role");
  return role ?? r.tagName.toLowerCase();
}

export function listLinks(): LinkItem[] {
  const out: LinkItem[] = [];
  for (const el of refElements()) {
    if (!isVisible(el)) continue;
    const item: LinkItem = { ref: refOfEl.get(el)!, kind: kindOf(el), text: textOf(el), region: regionOf(el) };
    const href = (el as HTMLAnchorElement).href;
    if (href) item.href = href;
    out.push(item);
  }
  return out;
}

/** Marks refs in the clone with text that survives HTML→markdown, e.g. "Reply ⟦e12⟧". */
function inlineRefMarkers(root: Element): void {
  for (const el of root.querySelectorAll(`[${REF_ATTR}]`)) {
    const ref = el.getAttribute(REF_ATTR)!;
    const tag = el.tagName.toLowerCase();
    const marker = el.ownerDocument.createTextNode(` ⟦${ref}⟧`);
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const label = el.ownerDocument.createElement("span");
      label.textContent = `[${kindOf(el)}: ${textOf(el) || (el as HTMLInputElement).name || ""}] ⟦${ref}⟧`;
      el.replaceWith(label);
    } else el.appendChild(marker);
  }
}

function waitForQuiet(quietMs: number, maxWaitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    let timer = setTimeout(done, quietMs);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, Date.now() - start > maxWaitMs ? 0 : quietMs);
    });
    obs.observe(document, { subtree: true, childList: true, characterData: true });
    const hard = setTimeout(done, maxWaitMs);
    function done() {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(hard);
      resolve();
    }
  });
}

const words = (s: string) => (s.match(/\S+/g) ?? []).length;
const fromMarkers = (s: string) => s.replace(/⟦(e\d+)⟧/g, "[$1]");

export async function extract(p: ExtractParams = {}): Promise<ExtractResult> {
  if (document.readyState !== "complete") await new Promise((r) => addEventListener("load", r, { once: true }));
  await waitForQuiet(p.quietMs ?? 300, p.maxWaitMs ?? 3000);
  tagRefs();
  const visible = cloneVisible(document.body) as HTMLElement | null;
  const doc = document.implementation.createHTMLDocument(document.title);
  if (visible) {
    inlineRefMarkers(visible);
    doc.body.replaceWith(doc.importNode(visible, true));
  }
  const url = location.href;
  let content = "";
  let usedFallback = false;
  try {
    // useAsync: false — never let extraction make network requests (ADR 0002).
    const r = new Defuddle(doc, { url, markdown: true, useAsync: false, removeHiddenElements: false }).parse();
    content = r.content ?? "";
  } catch {
    content = "";
  }
  if (words(content) < (p.minWords ?? 60)) {
    usedFallback = true;
    content = createMarkdownContent(doc.body.innerHTML, url);
  }
  content = fromMarkers(content).trim();
  const out: ExtractResult = { url, title: document.title, content, wordCount: words(content), usedFallback };
  if (p.includeLinks) out.links = listLinks();
  return out;
}

function hash(s: string): string {
  // FNV-1a, 32-bit: a stable key, not a security boundary.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Items currently in the DOM (virtualized lists drop the rest), keyed for de-duplication across scrolls. */
export function collectItems(p: CollectParams = {}): CollectedItem[] {
  tagRefs();
  const sel = p.selector ?? "article, [role=article], li";
  const out: CollectedItem[] = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!isVisible(el)) continue;
    // Skip containers whose items are themselves matched (nested lists).
    if (el.querySelector(sel)) continue;
    const text = (((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim()).slice(0, p.maxTextChars ?? 500);
    if (!text) continue;
    const a = el.querySelector("a[href]") as HTMLAnchorElement | null;
    const href = a?.href;
    const key = (p.keyAttr && el.getAttribute(p.keyAttr)) || hash(`${href ?? ""}|${text}`);
    out.push({ key, ref: refFor(el), text, ...(href ? { href } : {}) });
  }
  return out;
}

export function scrollState(): ScrollState {
  const se = document.scrollingElement ?? document.documentElement;
  const scrollY = se.scrollTop;
  const viewportHeight = innerHeight;
  const scrollHeight = se.scrollHeight;
  return { scrollY, viewportHeight, scrollHeight, atEnd: scrollY + viewportHeight >= scrollHeight - 2 };
}

/** Cosmetic ad filtering: CSS from the adblock engine, injected as a style element. */
/**
 * Cosmetic filtering through a constructed stylesheet adopted by the document: no <style> node, no fixed
 * id, nothing a MutationObserver sees (audit S03). Hidden ads are still hidden, which a page can measure.
 */
let cosmeticSheet: CSSStyleSheet | null = null;
export function applyCosmetics(p: { css: string }): number {
  cosmeticSheet ??= new CSSStyleSheet();
  cosmeticSheet.replaceSync(p.css);
  if (!document.adoptedStyleSheets.includes(cosmeticSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, cosmeticSheet];
  return p.css.length;
}

/** Class names, ids and link targets on the page, for generic cosmetic filters. */
export function domTokens(): { classes: string[]; ids: string[]; hrefs: string[] } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const hrefs = new Set<string>();
  for (const el of document.querySelectorAll("[class], [id], a[href]")) {
    for (const c of el.classList) classes.add(c);
    if (el.id) ids.add(el.id);
    const h = el.getAttribute("href");
    if (h) hrefs.add(h);
    if (classes.size + ids.size + hrefs.size > 20_000) break;
  }
  return { classes: [...classes], ids: [...ids], hrefs: [...hrefs] };
}

/**
 * Where the element with this ref is, in viewport coordinates. It isn't scrolled unless `reveal` is set:
 * the caller scrolls with real wheel events first, like a person (audit S06), and only falls back to this.
 */
export function locateRef(p: { ref: string; reveal?: boolean }): { x: number; y: number; w: number; h: number; inView: boolean; vw: number; vh: number; tag: string; text: string } | null {
  const el = elementByRef(p.ref);
  if (!el || !isVisible(el)) return null;
  let r = el.getBoundingClientRect();
  const inView = (rr: DOMRect) => rr.top >= 0 && rr.left >= 0 && rr.bottom <= innerHeight && rr.right <= innerWidth && rr.width > 0 && rr.height > 0;
  if (p.reveal && !inView(r)) {
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" as ScrollBehavior });
    r = el.getBoundingClientRect();
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, inView: inView(r), vw: innerWidth, vh: innerHeight, tag: el.tagName.toLowerCase(), text: textOf(el) };
}

/**
 * Fallback for clicking what a person sees: the visible element whose text matches, preferring an exact
 * match and the clickable thing around it. Gives it a ref so the normal click (and its checks) can follow.
 */
export function findByText(p: { text: string; nth?: number }): { ref: string; text: string } | null {
  tagRefs();
  const want = p.text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!want) return null;
  const exact: Element[] = [];
  const partial: Element[] = [];
  let scanned = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (++scanned > MAX_SCAN * 2) break;
    if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
    const own = (el.innerText ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!own || own.length > want.length * 4 + 40) continue;
    // Innermost element carrying the text: skip if a child carries it too.
    const childHas = [...el.children].some((c) => ((c as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().toLowerCase().includes(want));
    if (childHas) continue;
    if (own === want || el.getAttribute("aria-label")?.toLowerCase() === want) exact.push(el);
    else if (own.includes(want)) partial.push(el);
  }
  const pick = (exact.length ? exact : partial)[p.nth ?? 0];
  if (!pick) return null;
  const target = refAncestor(pick) ?? pick;
  const ref = hasRef(target) ? refOfEl.get(target)! : refFor(target, true);
  return { ref, text: textOf(target) };
}

/** Element under a point, for the check before click (Access Model L4). */
export function refAtPoint(p: { x: number; y: number }): string | null {
  const el = document.elementFromPoint(p.x, p.y);
  const r = refAncestor(el);
  return r ? refOfEl.get(r)! : null;
}

/** The element a click at this point would really hit, looking inside open shadow roots. */
function deepElementFromPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  for (let i = 0; i < 20 && el?.shadowRoot; i++) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** Parent in the composed tree: through slots and out of shadow roots to their host. */
function composedParent(n: Element): Element | null {
  if (n.assignedSlot) return n.assignedSlot;
  if (n.parentElement) return n.parentElement;
  const root = n.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function composedContains(outer: Element, inner: Element): boolean {
  for (let n: Element | null = inner, i = 0; n && i < 200; n = composedParent(n), i++) if (n === outer) return true;
  return false;
}

/**
 * The check before click (Access Model L4), as a person's click would land. OK when what's under the
 * point is the element or inside it (through shadow DOM and slots), its label, or a component that wraps it.
 * Otherwise it names what's on top and gives it a ref, so the agent can deal with it (close a banner).
 */
export function checkPoint(p: { ref: string; x: number; y: number }): { ok: true } | { ok: false; covering: { ref: string; tag: string; text: string } | null } {
  const target = elementByRef(p.ref);
  const hit = deepElementFromPoint(p.x, p.y);
  if (!target || !hit) return { ok: false, covering: null };
  if (composedContains(target, hit)) return { ok: true };
  // Clicking a label activates its control (custom radios and checkboxes draw the label on top).
  const label = hit.closest("label") as HTMLLabelElement | null;
  if (label && (label.control === target || composedContains(label, target))) return { ok: true };
  if ((target as HTMLInputElement).labels && [...((target as HTMLInputElement).labels ?? [])].some((l) => composedContains(l, hit))) return { ok: true };
  // A component that wraps the element at this spot (it draws the control in its shadow DOM).
  for (let n: Element | null = hit, i = 0; n && i < 200; n = composedParent(n), i++) {
    if (n.tagName.includes("-") && composedContains(n, target) && n.getBoundingClientRect().width < innerWidth * 0.9) return { ok: true };
  }
  // A real overlay: say what it is, with a ref.
  const cover = (hit.closest("button, a[href], [role=button], [role=dialog], dialog, [aria-modal]") ?? hit) as Element;
  if (!hasRef(cover)) {
    tagRefs();
    if (!hasRef(cover)) refFor(cover, true);
  }
  const tag = cover.tagName.toLowerCase() + (cover.id ? `#${cover.id}` : "") + (typeof (cover as HTMLElement).className === "string" && (cover as HTMLElement).className.trim() ? `.${(cover as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join(".")}` : "");
  return { ok: false, covering: { ref: refOfEl.get(cover)!, tag, text: textOf(cover).slice(0, 80) } };
}

/** The live element for a ref, returned as a handle (not by value) so typing can target it without a selector. */
export function elementForRef(p: { ref: string }): Element | null {
  return elementByRef(p.ref);
}

(globalThis as unknown as { __crossbar: unknown }).__crossbar = { extract, collectItems, scrollState, applyCosmetics, listLinks, locateRef, refAtPoint, checkPoint, domTokens, findByText, elementForRef };
