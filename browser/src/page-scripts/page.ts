// SPDX-License-Identifier: AGPL-3.0-only
// In-page code. Bundled by esbuild and run in the "crossbar" isolated world (ADR 0005):
// it shares the DOM with the page but not its globals.
//
// Adapted from MD-This-Page (https://github.com/Ademking/MD-This-Page, MIT, (c) Adem Kouki):
// the visible-only clone, the wait for single-page apps, and the whole-page fallback (ADR 0002).
import { querySelectorAll as extQuerySelectorAll, type AST } from "@ghostery/adblocker-extended-selectors";
import * as DefuddleModule from "defuddle/full";

// defuddle/full is a UMD bundle; its default export lands at different depths under different bundlers.
type DefuddleCtor = new (doc: Document, opts?: Record<string, unknown>) => { parse(): { content?: string } };
const mod = DefuddleModule as unknown as { default?: unknown; createMarkdownContent?: (html: string, url: string) => string };
const inner = mod.default as { default?: unknown; createMarkdownContent?: (html: string, url: string) => string } | DefuddleCtor | undefined;
const Defuddle = ((inner as { default?: unknown })?.default ?? inner) as DefuddleCtor;
const createMarkdownContent = (mod.createMarkdownContent ?? (inner as { createMarkdownContent?: (h: string, u: string) => string }).createMarkdownContent)!;

export interface ExtractParams {
  includeLinks?: boolean;
  /**
   * auto (hybrid): the markdown, a heading map on top when the page has several sections, and the controls the
   * markdown left out, each with its name and state. content: the markdown only. outline: the heading map and
   * every control, no body text (for app pages: dashboards, settings, mail).
   */
  mode?: "auto" | "content" | "outline";
  /** Read only this element (a dialog, a panel), by ref; the whole page if absent. */
  within?: string;
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
  /** expanded, collapsed, checked, selected, disabled... */
  state?: string;
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
  /** Collect only inside this area (a ref, or "dialog"). */
  within?: string;
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
  /** Where to turn the wheel: the middle of the scrolling box (the window's middle for the page). */
  x: number;
  y: number;
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

/** querySelectorAll that also looks inside open shadow roots (web components: live, Chase's account tiles). */
function deepQueryAll(root: ParentNode, selector: string, limit = MAX_SCAN): Element[] {
  const out: Element[] = [...root.querySelectorAll(selector)];
  const hosts: ParentNode[] = [root];
  let seen = 0;
  while (hosts.length && seen < limit) {
    const r = hosts.shift()!;
    for (const el of r.querySelectorAll("*")) {
      if (++seen > limit) break;
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) {
        out.push(...sr.querySelectorAll(selector));
        hosts.push(sr);
      }
    }
  }
  return out;
}

/** Gives every visible interactive element a stable ref, inside open shadow roots too. Existing refs are kept. */
export function tagRefs(root: ParentNode = document): void {
  for (const el of deepQueryAll(root, INTERACTIVE)) {
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
  if (tag === "slot") {
    // What's rendered in a slot: the light-DOM nodes assigned to it, else its fallback content.
    const span = el.ownerDocument.createElement("span");
    const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
    for (const n of assigned.length ? assigned : [...el.childNodes]) {
      const c = cloneVisible(n);
      if (c) span.appendChild(c);
    }
    return span;
  }
  if (!isVisible(el) || adHidden.has(el)) return null;
  const copy = el.cloneNode(false) as Element;
  // The clone is detached, so marking it is invisible to the page.
  const ref = refOfEl.get(el);
  if (ref) copy.setAttribute(REF_ATTR, ref);
  if (tag === "input" || tag === "textarea" || tag === "select") return copy;
  // Open shadow roots: the shadow tree is what's rendered (light children show only through its slots).
  const sr = (el as HTMLElement).shadowRoot;
  for (const child of sr ? sr.childNodes : el.childNodes) {
    const c = cloneVisible(child);
    if (c) copy.appendChild(c);
  }
  // A block named only for assistive technology (aria-label, aria-labelledby, role=img): the name is what
  // tells it apart (live: Chase's account tiles showed balances with no card name). Write it in.
  if (!ref) {
    const label = blockLabel(el);
    if (label && !squash(copy.textContent).toLowerCase().includes(label.toLowerCase())) {
      const role = el.getAttribute("role");
      const named = el.ownerDocument.createElement(role === "img" ? "span" : "p");
      named.textContent = role === "img" ? `(image: ${label})` : `${label}:`;
      if (role !== "img") {
        const strong = el.ownerDocument.createElement("strong");
        strong.textContent = named.textContent;
        named.textContent = "";
        named.appendChild(strong);
      }
      copy.insertBefore(named, copy.firstChild);
    }
  }
  return copy;
}

/** The accessible name of a block that has no ref (a tile, a group, an image drawn with CSS), or "". */
function blockLabel(el: Element): string {
  const role = el.getAttribute("role") ?? "";
  if (/^(presentation|none)$/.test(role)) return "";
  let label = squash(el.getAttribute("aria-label"));
  const by = el.getAttribute("aria-labelledby");
  if (!label && by) {
    const root = el.getRootNode() as Document | ShadowRoot;
    label = squash(by.split(/\s+/).map((id) => root.getElementById?.(id)?.textContent ?? document.getElementById(id)?.textContent ?? "").join(" "));
  }
  if (label.length < 3) return "";
  // Only blocks and pictures: an inline icon's label inside a sentence would just repeat noise.
  if (role === "img") return label.slice(0, 160);
  const d = getComputedStyle(el).display;
  return /^(block|flex|grid|list-item|table|table-row|inline-block|inline-flex|inline-grid)$/.test(d) ? label.slice(0, 160) : "";
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
    const ref = refOfEl.get(el)!;
    const item: LinkItem = { ref, kind: kindOf(el), text: textOf(el) || nameOf(el), region: regionOf(el) };
    const st = /\(([^)]*)\)$/.exec(refNote(ref, "x"))?.[1];
    if (st) item.state = st;
    const href = (el as HTMLAnchorElement).href;
    if (href) item.href = href;
    out.push(item);
  }
  return out;
}

/**
 * What a bare ref needs to be usable: its name when it shows no text (an icon button, a chevron), and its
 * state (expanded, checked, selected). Live: Chase's "[e10]" was the Credit cards collapse toggle; the agent
 * clicked it five times not knowing.
 */
function refNote(ref: string, shownText: string): string {
  const live = elementByRef(ref);
  if (!live) return "";
  const name = shownText ? "" : nameOf(live).slice(0, 80);
  const states: string[] = [];
  const exp = live.getAttribute("aria-expanded");
  if (exp === "true") states.push("expanded");
  if (exp === "false") states.push("collapsed");
  const checked = live.getAttribute("aria-checked") ?? live.getAttribute("aria-pressed") ?? ((live as HTMLInputElement).type && /^(checkbox|radio)$/.test((live as HTMLInputElement).type) ? String((live as HTMLInputElement).checked) : null);
  if (checked === "true") states.push(live.getAttribute("aria-pressed") ? "pressed" : "checked");
  if (live.getAttribute("aria-selected") === "true") states.push("selected");
  if (live.getAttribute("aria-disabled") === "true" || (live as HTMLButtonElement).disabled) states.push("disabled");
  const st = states.length ? ` (${states.join(", ")})` : "";
  return name ? `: ${name.replace(/[⟦⟧\]]/g, "")}${st}` : st;
}

/** Marks refs in the clone with text that survives HTML→markdown, e.g. "Reply ⟦e12⟧". */
function inlineRefMarkers(root: Element): void {
  for (const el of root.querySelectorAll(`[${REF_ATTR}]`)) {
    const ref = el.getAttribute(REF_ATTR)!;
    const tag = el.tagName.toLowerCase();
    const marker = el.ownerDocument.createTextNode(` ⟦${ref}${refNote(ref, squash(el.textContent))}⟧`);
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
const fromMarkers = (s: string) => s.replace(/⟦(e\d+)([^⟧]*)⟧/g, "[$1$2]");
/**
 * Defuddle turns blocks whose class looks like a callout into "> [!-full-width] \-full-width" (live: Chase).
 * A callout type starting with "-" is a class name, not a callout: drop that line, keep the quote's text.
 */
const dropFakeCallouts = (s: string) => s.replace(/^> \[!-[^\]\n]*\][^\n]*\n?/gm, "");

/** What the converter returns when Turndown throws; it then embeds the raw HTML (live: Gmail, 13 Nov 2026). */
const CONVERSION_FAILED = /^Partial conversion completed with errors/;

/**
 * Markdown from a DOM node, never from an HTML string. Pages under Trusted Types (Gmail) refuse every
 * string-to-DOM parse, also in the isolated world, and refuse new policies, so Turndown parsing the
 * serialized HTML throws and the converter dumps raw HTML. Turndown takes a node directly; the converter
 * first strips <wbr> with String.replace, so the node answers that call with itself.
 */
function markdownOf(root: HTMLElement, url: string): string {
  for (const w of root.querySelectorAll("wbr")) w.remove();
  const node = root as HTMLElement & { replace?: () => HTMLElement };
  node.replace = () => root;
  try {
    // When Turndown throws, the converter's own error path calls .substring on its input, a node here, and
    // throws again (live: reading all of Gmail, 12 Nov 2026). Either way the text is still there.
    let md: string;
    try {
      md = createMarkdownContent(node as unknown as string, url);
    } catch {
      return plainText(root);
    }
    return CONVERSION_FAILED.test(md) ? plainText(root) : md;
  } finally {
    delete node.replace;
  }
}

const BLOCK = /^(address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tr|ul)$/i;
/** Last resort: the text, one block per line, refs kept. */
function plainText(root: Node): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out.push(n.textContent ?? "");
    else if (n.nodeType === Node.ELEMENT_NODE) {
      const block = BLOCK.test((n as Element).tagName);
      if (block) out.push("\n");
      for (const c of n.childNodes) walk(c);
      if (block) out.push("\n");
    }
  };
  walk(root);
  return out.join("").replace(/[ \t]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
}

export async function extract(p: ExtractParams = {}): Promise<ExtractResult> {
  if (document.readyState !== "complete") await new Promise((r) => addEventListener("load", r, { once: true }));
  await waitForQuiet(p.quietMs ?? 300, p.maxWaitMs ?? 3000);
  tagRefs();
  markExtendedAds();
  const scope = p.within ? areaOf(p.within) : document.body;
  if (!scope) throw new Error(p.within === "dialog" ? "No dialog is open." : `No element with ref ${p.within} on the page any more. Call find or read again.`);
  const visible = cloneVisible(scope) as HTMLElement | null;
  const doc = document.implementation.createHTMLDocument(document.title);
  if (visible) {
    inlineRefMarkers(visible);
    const body = doc.createElement("body");
    body.appendChild(doc.importNode(visible, true));
    doc.body.replaceWith(body);
  }
  const url = location.href;
  let content = "";
  let usedFallback = false;
  // A part of the page is converted as it is: the article extractor would look for an article inside it.
  if (!p.within) {
    try {
      // useAsync: false — never let extraction make network requests (ADR 0002).
      const r = new Defuddle(doc, { url, markdown: true, useAsync: false, removeHiddenElements: false }).parse();
      content = r.content ?? "";
    } catch {
      content = "";
    }
    if (CONVERSION_FAILED.test(content)) content = "";
  }
  if (p.within || words(content) < (p.minWords ?? 60)) {
    usedFallback = !p.within;
    content = markdownOf(doc.body, url);
  }
  content = dropFakeCallouts(fromMarkers(content)).trim();
  const mode = p.mode ?? "content";
  if (mode === "outline") content = [headingMap(scope), controlList(scope, new Set())].filter(Boolean).join("\n\n");
  else if (mode === "auto") {
    // The hybrid: what the markdown dropped (the article extractor keeps the main text, not an app's
    // controls) is listed after it with names and states, and long pages get a map of their sections.
    const shown = new Set([...content.matchAll(/\[(e\d+)[\]:( ]/g)].map((m) => m[1]!));
    const map = headingMap(scope);
    const rest = controlList(scope, shown);
    content = [map && map.split("\n").length > 4 ? map : "", content, rest].filter(Boolean).join("\n\n");
  }
  const out: ExtractResult = { url, title: document.title, content, wordCount: words(content), usedFallback };
  if (p.includeLinks) out.links = listLinks();
  return out;
}

/** The page's sections as an indented list: headings (inside open shadow roots too) and labelled dialogs. */
function headingMap(scope: Element): string {
  const lines: string[] = [];
  for (const h of deepQueryAll(scope, "h1, h2, h3, h4, h5, h6, [role=heading], dialog[aria-label], [role=dialog][aria-label]")) {
    if (lines.length >= 40) break;
    if (!isVisible(h)) continue;
    const isDialog = /dialog/i.test(h.tagName) || h.getAttribute("role") === "dialog";
    const level = isDialog ? 1 : Number(/h(\d)/i.exec(h.tagName)?.[1] ?? h.getAttribute("aria-level") ?? 2);
    const text = isDialog ? `Dialog: ${squash(h.getAttribute("aria-label"))}` : squash((h as HTMLElement).innerText ?? h.textContent).slice(0, 100);
    if (text) lines.push(`${"  ".repeat(Math.max(0, level - 1))}- ${text}`);
  }
  return lines.length ? `## Page outline\n${lines.join("\n")}` : "";
}

/** Visible controls with refs (except those already shown), one line each: ref, kind, name, state. */
function controlList(scope: Element, skip: Set<string>): string {
  const rows: Array<{ el: Element; ref: string; name: string; st?: string }> = [];
  for (const el of refElements()) {
    if (rows.length >= 80) break;
    const ref = refOfEl.get(el)!;
    if (skip.has(ref) || !composedContains(scope, el) || !isVisible(el)) continue;
    rows.push({ el, ref, name: (textOf(el) || nameOf(el)).slice(0, 100), st: /\(([^)]*)\)$/.exec(refNote(ref, "x"))?.[1] });
  }
  // The same name more than once ("Pay card" on every tile): say which tile or section each one is in.
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  const lines = rows.map((r) => {
    const where = (count.get(r.name) ?? 0) > 1 ? contextOf(r.el) : "";
    return `- [${r.ref}] ${kindOf(r.el)}${r.name ? ` "${r.name}"` : ""}${r.st ? ` (${r.st})` : ""}${where ? ` in "${where}"` : ""}`;
  });
  return lines.length ? `## Controls${skip.size ? " not shown above" : ""}\n${lines.join("\n")}` : "";
}

/** The nearest labelled block or section heading around an element (through shadow roots), for telling repeats apart. */
function contextOf(el: Element): string {
  for (let a = composedParent(el), i = 0; a && i < 40; a = composedParent(a), i++) {
    const label = blockLabel(a);
    if (label) return label;
    const h = a.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4");
    if (h) return squash(h.textContent).slice(0, 80);
  }
  return "";
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
  const area = p.within ? areaOf(p.within) : document;
  if (!area) throw new Error(p.within === "dialog" ? "No dialog is open." : `No element with ref ${p.within} on the page any more.`);
  // Inside a box (a picker, a dropdown), its options are the items.
  const sel = p.selector ?? (p.within ? "[role=option], [role=listitem], [role=row], [role=menuitem], [role=article], article, li" : "article, [role=article], li");
  const out: CollectedItem[] = [];
  for (const el of area.querySelectorAll(sel)) {
    if (!isVisible(el)) continue;
    // Skip containers whose items are themselves matched (nested lists).
    if (el.querySelector(sel)) continue;
    // Picture options (Gmail's themes) have no text, only a label.
    const text = (((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim() || nameOf(el)).slice(0, p.maxTextChars ?? 500);
    if (!text) continue;
    const a = el.querySelector("a[href]") as HTMLAnchorElement | null;
    const href = a?.href;
    const key = (p.keyAttr && el.getAttribute(p.keyAttr)) || hash(`${href ?? ""}|${text}`);
    out.push({ key, ref: refFor(el), text, ...(href ? { href } : {}) });
  }
  return out;
}

/**
 * The box that scrolls for an area: the element itself if it scrolls, else the scrolling box inside it with
 * the most to scroll (a dialog's list), else the nearest scrolling box around it.
 */
function scrollBoxOf(el: Element): Element | null {
  if (scrolls(el)) return el;
  let best: Element | null = null;
  let most = 0;
  let n = 0;
  for (const d of el.querySelectorAll("*")) {
    if (++n > MAX_SCAN) break;
    const extra = d.scrollHeight - d.clientHeight;
    if (extra > most && scrolls(d) && shown(d)) {
      best = d;
      most = extra;
    }
  }
  return best ?? scrollerOf(el);
}

export function scrollState(p: { within?: string } = {}): ScrollState {
  if (p.within) {
    const area = areaOf(p.within);
    if (!area) throw new Error(p.within === "dialog" ? "No dialog is open." : `No element with ref ${p.within} on the page any more.`);
    const box = scrollBoxOf(area);
    if (box) {
      const r = box.getBoundingClientRect();
      const top = Math.max(0, r.top);
      const bottom = Math.min(innerHeight, r.bottom);
      return { scrollY: box.scrollTop, viewportHeight: box.clientHeight, scrollHeight: box.scrollHeight, atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 2, x: (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2, y: (top + bottom) / 2 };
    }
  }
  const se = document.scrollingElement ?? document.documentElement;
  const scrollY = se.scrollTop;
  const viewportHeight = innerHeight;
  const scrollHeight = se.scrollHeight;
  return { scrollY, viewportHeight, scrollHeight, atEnd: scrollY + viewportHeight >= scrollHeight - 2, x: innerWidth / 2, y: innerHeight / 2 };
}

/** Cosmetic ad filtering: CSS from the adblock engine, injected as a style element. */
/**
 * Cosmetic filtering through a constructed stylesheet adopted by the document: no <style> node, no fixed
 * id, nothing a MutationObserver sees (audit S03). Hidden ads are still hidden, which a page can measure.
 */
let cosmeticSheet: CSSStyleSheet | null = null;
/** Extended hide rules (uBO :has-text() and friends) for this page; evaluated at each read. */
let extendedRules: AST[] = [];
/** Elements the extended rules hide: left out of what the agent reads. The live page isn't touched. */
let adHidden = new WeakSet<Element>();
function markExtendedAds(): void {
  adHidden = new WeakSet();
  for (const ast of extendedRules) {
    try {
      for (const el of extQuerySelectorAll(document.documentElement, ast)) adHidden.add(el);
    } catch {
      /* a rule this evaluator can't run */
    }
  }
}

export function applyCosmetics(p: { css: string; extended?: unknown[] }): number {
  extendedRules = (p.extended ?? []) as AST[];
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

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const clipsOverflow = (s: CSSStyleDeclaration) => /(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY);
const scrolls = (el: Element) => {
  const s = getComputedStyle(el);
  return (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1);
};

/**
 * The part of the viewport where the element can be seen: the window, cut down by every ancestor that clips
 * its overflow (a scrolling list inside a dialog). Gmail's theme picker: the option was inside the window but
 * below the list's fold, so a click there landed on the dialog (live, 13 Nov 2026).
 */
function clipOf(el: Element): Box {
  const box: Box = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  for (let a = composedParent(el), i = 0; a && a !== document.body && a !== document.documentElement && i < 100; a = composedParent(a), i++) {
    const s = getComputedStyle(a);
    if (s.position === "fixed") break;
    if (!clipsOverflow(s)) continue;
    const r = a.getBoundingClientRect();
    box.left = Math.max(box.left, r.left);
    box.top = Math.max(box.top, r.top);
    box.right = Math.min(box.right, r.right);
    box.bottom = Math.min(box.bottom, r.bottom);
  }
  return box;
}

/** The nearest ancestor that scrolls (where a wheel moves the element), or null for the page itself. */
function scrollerOf(el: Element): Element | null {
  for (let a = composedParent(el), i = 0; a && a !== document.body && a !== document.documentElement && i < 100; a = composedParent(a), i++) if (scrolls(a)) return a;
  return null;
}

/** Centre of an element, and whether the centre is where it can be seen (inside every clipping ancestor). */
function sightOf(el: Element): { x: number; y: number; w: number; h: number; inView: boolean; clip: Box } {
  const r = el.getBoundingClientRect();
  const clip = clipOf(el);
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const inView = r.width > 0 && r.height > 0 && x >= clip.left && x <= clip.right && y >= clip.top && y <= clip.bottom;
  return { x, y, w: r.width, h: r.height, inView, clip };
}

const COMMIT_WORDS =
  /\b(send|post|publish|submit|save|apply|confirm|delete|remove|trash|discard|archive|buy|pay|purchase|order|checkout|subscribe|unsubscribe|follow|unfollow|like|upvote|downvote|vote|reply|comment|share|invite|accept|decline|approve|reject|block|report|mark|move|label|star|transfer|book|reserve|sign|log ?out|upload|create|add|update|change|set|enable|disable|turn|install|connect|disconnect|done|ok|yes|continue|next|finish|join|leave|mute|pin|retry|undo)\b/i;
const OPEN_WORDS = /\b(settings|menu|more|options|see all|see more|show|view|open|expand|collapse|close|cancel|back|filter|sort|search|help|details|preview|previous|older|newer|page \d+)\b/i;

/**
 * What a click on this control is for (ADR 0030): "open" only shows something (a menu, a tab, a dialog, a
 * panel, another page by link); "act" may do something as the person (save, send, choose). Structure first
 * (a popup or disclosure button, a tab), then the words on it; anything unclear acts. A page can mislabel a
 * control, but what it gains is no more than ADR 0027 already lets its own scripts send.
 */
function intentOf(el: Element): "open" | "act" {
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  const type = ((el as HTMLButtonElement).type ?? "").toLowerCase();
  // Sends a form, or chooses something (an option, a box, a switch): acts.
  if ((tag === "button" && type === "submit" && el.closest("form")) || (tag === "input" && /^(submit|image)$/.test(type))) return "act";
  if (/^(option|radio|checkbox|switch|menuitemradio|menuitemcheckbox)$/.test(role) || (tag === "input" && /^(checkbox|radio)$/.test(type))) return "act";
  const popup = el.getAttribute("aria-haspopup");
  if ((popup && popup !== "false") || el.hasAttribute("aria-expanded") || role === "tab" || tag === "summary") return "open";
  const name = nameOf(el);
  if (COMMIT_WORDS.test(name)) return "act";
  if (OPEN_WORDS.test(name)) return "open";
  const href = tag === "a" ? (el.getAttribute("href") ?? "") : "";
  if (href && !/^(#|javascript:)/i.test(href.trim())) return "open";
  return "act";
}

/**
 * Where the element with this ref is, in viewport coordinates, and whether it can be seen there (not just in
 * the window: inside its scrolling list too). If not, `scroller` is the box a wheel should turn: its nearest
 * scrolling ancestor, or the page. It isn't scrolled unless `reveal` is set: the caller scrolls with real
 * wheel events first, like a person (audit S06), and only falls back to this.
 */
export function locateRef(p: { ref: string; reveal?: boolean }): {
  x: number;
  y: number;
  w: number;
  h: number;
  inView: boolean;
  vw: number;
  vh: number;
  tag: string;
  text: string;
  scroller: { x: number; y: number; w: number; h: number } | null;
  intent: "open" | "act";
} | null {
  const el = elementByRef(p.ref);
  if (!el || !isVisible(el)) return null;
  let at = sightOf(el);
  if (p.reveal && !at.inView) {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" as ScrollBehavior });
    at = sightOf(el);
  }
  let scroller: { x: number; y: number; w: number; h: number } | null = null;
  const sc = at.inView ? null : scrollerOf(el);
  if (sc) {
    const r = sc.getBoundingClientRect();
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - left;
    const h = Math.min(innerHeight, r.bottom) - top;
    if (w > 4 && h > 4) scroller = { x: left + w / 2, y: top + h / 2, w, h };
  }
  return { x: at.x, y: at.y, w: at.w, h: at.h, inView: at.inView, vw: innerWidth, vh: innerHeight, tag: el.tagName.toLowerCase(), text: textOf(el), scroller, intent: intentOf(el) };
}

export type ControlRole = "button" | "link" | "field" | "menuitem" | "option" | "tab" | "checkbox" | "other";
export type ControlState = "visible" | "offscreen" | "covered" | "hidden" | "disabled";
export interface ControlMatch {
  ref?: string;
  role: ControlRole;
  name: string;
  region: string;
  state: ControlState;
  coveredBy?: { ref: string; text: string };
  openWith?: { ref: string; name: string };
}

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * What a control is called, as assistive technology would say it: aria-label, aria-labelledby, its text, then
 * title, an image's alt, placeholder, value, an inner icon's label. Icon-only buttons (a gear with
 * aria-label="Settings") have a name even with no text (live: Gmail, 12 Nov 2026).
 */
export function nameOf(el: Element): string {
  const aria = squash(el.getAttribute("aria-label"));
  if (aria) return aria.slice(0, 200);
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = squash(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
    if (t) return t.slice(0, 200);
  }
  const own = squash((el as HTMLElement).innerText ?? el.textContent);
  if (own) return own.slice(0, 200);
  const other =
    squash(el.getAttribute("title")) ||
    squash(el.querySelector("img[alt]")?.getAttribute("alt")) ||
    squash((el as HTMLInputElement).placeholder) ||
    squash(el.tagName === "INPUT" && /^(button|submit|reset)$/.test((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : "") ||
    squash(el.querySelector("[aria-label]")?.getAttribute("aria-label")) ||
    squash(el.querySelector("svg title")?.textContent);
  return other.slice(0, 200);
}

function roleOf(el: Element): ControlRole {
  const r = el.getAttribute("role") ?? "";
  const t0 = el.tagName.toLowerCase();
  if (r === "button") return "button";
  if (r === "link") return "link";
  if (/^menuitem/.test(r)) return "menuitem";
  if (r === "option" || t0 === "option") return "option";
  if (r === "tab") return "tab";
  if (/^(checkbox|switch|radio)$/.test(r)) return "checkbox";
  if (/^(textbox|searchbox|combobox)$/.test(r)) return "field";
  const t = el.tagName.toLowerCase();
  if (t === "a" && el.hasAttribute("href")) return "link";
  if (t === "button" || t === "summary") return "button";
  if (t === "input") {
    const type = (el as HTMLInputElement).type;
    if (/^(button|submit|reset|image)$/.test(type)) return "button";
    if (/^(checkbox|radio)$/.test(type)) return "checkbox";
    return "field";
  }
  if (t === "textarea" || t === "select" || (el as HTMLElement).isContentEditable) return "field";
  return "other";
}

const CONTROLS = `${INTERACTIVE}, [role=menuitem], [role=tab], [role=option], summary, [contenteditable=""], [contenteditable=true]`;

function shown(el: Element): boolean {
  const v = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return v ? v.call(el, { checkOpacity: true, checkVisibilityCSS: true }) && isVisible(el) : isVisible(el);
}

/** For a hidden control: the visible control that reveals it (a closed menu's button, a <details> summary). */
function opener(el: Element): Element | null {
  const details = el.closest("details:not([open])");
  if (details) {
    const s = details.querySelector(":scope > summary");
    if (s && shown(s)) return s;
  }
  for (let a: Element | null = el, depth = 0; a && depth < 8; a = a.parentElement, depth++) {
    if (a.id) {
      const c = document.querySelector(`[aria-controls~="${CSS.escape(a.id)}"], [aria-owns~="${CSS.escape(a.id)}"]`);
      if (c && shown(c)) return c;
    }
    for (let s = a.previousElementSibling, n = 0; s && n < 3; s = s.previousElementSibling, n++) {
      const c = s.matches("[aria-haspopup], [aria-expanded=false]") ? s : s.querySelector("[aria-haspopup], [aria-expanded=false]");
      if (c && shown(c)) return c;
    }
  }
  return null;
}

function score(name: string, want: string): number {
  const n = name.toLowerCase();
  if (!n) return 0;
  if (n === want) return 4;
  if (n.startsWith(want)) return 3;
  if (new RegExp(`\\b${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(n)) return 2.5;
  if (n.includes(want)) return 2;
  const words = want.split(" ").filter(Boolean);
  return words.length > 1 && words.every((w) => n.includes(w)) ? 1 : 0;
}

/** The topmost open dialog (role=dialog, <dialog open>, aria-modal), for find and scroll "within: dialog". */
function openDialog(): Element | null {
  const all = [...document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")].filter((d) => shown(d));
  return all.at(-1) ?? null;
}

/** An area named by ref, or the word "dialog" for the open dialog. */
function areaOf(within: string): Element | null {
  return within === "dialog" ? openDialog() : elementByRef(within);
}

/** What a word of the query could be found in, cheaply (no layout): text content and the naming attributes. */
function haystack(el: Element): string {
  let s = (el.textContent ?? "") + " " + (el.getAttribute("aria-label") ?? "") + " " + (el.getAttribute("title") ?? "") + " " + ((el as HTMLInputElement).placeholder ?? "") + " " + ((el as HTMLInputElement).value ?? "");
  const img = el.querySelector("img[alt], [aria-label], svg title");
  if (img) s += " " + (img.getAttribute("alt") ?? img.getAttribute("aria-label") ?? img.textContent ?? "");
  const by = el.getAttribute("aria-labelledby");
  if (by) for (const id of by.split(/\s+/)) s += " " + (document.getElementById(id)?.textContent ?? "");
  return s.toLowerCase();
}

/**
 * Controls on the page whose name matches, best first: what they are, where, and whether a click can reach
 * them now (visible, offscreen, covered and by what, hidden and what opens them, disabled). Reads only; refs
 * live in the isolated world (S02). Page text in names is untrusted.
 */
/** Other names agents use for a kind of control (ARIA roles, HTML words), so a role filter never refuses. */
const ROLE_ALIASES: Record<string, ControlRole> = {
  textbox: "field",
  searchbox: "field",
  combobox: "field",
  input: "field",
  textarea: "field",
  select: "field",
  radio: "checkbox",
  switch: "checkbox",
  menuitemradio: "menuitem",
  menuitemcheckbox: "menuitem",
  listbox: "option",
};
function roleMatches(el: Element, role: ControlRole, wanted: string | undefined): boolean {
  const w = (wanted ?? "any").toLowerCase();
  if (w === "any" || w === role) return true;
  if ((el.getAttribute("role") ?? "").toLowerCase() === w) return true;
  return ROLE_ALIASES[w] === role;
}

export function findControls(p: { query?: string; role?: string; limit?: number; textFallback?: boolean; within?: string }): ControlMatch[] {
  tagRefs();
  const want = squash(p.query).toLowerCase();
  const area = p.within ? areaOf(p.within) : document;
  if (!area) throw new Error(p.within === "dialog" ? "No dialog is open." : `No element with ref ${p.within} on the page any more. Call find or read again.`);
  // No query: every control in the area, in page order (what's in this dialog?).
  const listing = !want;
  if (listing && !p.within) return [];
  const limit = Math.min(Math.max(p.limit ?? (listing ? 30 : 8), 1), 50);
  const words = want.split(" ").filter(Boolean);
  const scored: Array<{ el: Element; s: number; role: ControlRole; name: string; visible: boolean }> = [];
  const seen = new Set<Element>();
  let scanned = 0;
  for (const el of area.querySelectorAll(CONTROLS)) {
    if (++scanned > MAX_SCAN * 2) break;
    if (el.closest("[role=tooltip], [aria-hidden=true]")) continue;
    // Cheap test first: a control none of whose text or labels holds the words can't match. Naming every
    // control (innerText needs layout) made find take 14 s on Gmail (live, 13 Nov 2026).
    if (!listing && !words.every((w) => haystack(el).includes(w))) continue;
    const role = roleOf(el);
    if (!roleMatches(el, role, p.role)) continue;
    const name = nameOf(el);
    const s = listing ? (name ? 1 : 0) : score(name, want);
    if (!s) continue;
    // The innermost of nested matches (a link wrapping a button with the same name) is enough once.
    if ([...seen].some((x) => x.contains(el) && nameOf(x) === name)) continue;
    seen.add(el);
    scored.push({ el, s: s + 1, role, name, visible: shown(el) });
  }
  for (const el of refElements().filter((e) => clickables.has(e))) {
    if (seen.has(el) || (p.within && !(area as Element).contains(el))) continue;
    if (!listing && !words.every((w) => haystack(el).includes(w))) continue;
    const name = nameOf(el);
    const s = listing ? (name ? 1 : 0) : score(name, want);
    if (s && roleMatches(el, "other", p.role)) scored.push({ el, s: s + 0.5, role: "other", name, visible: shown(el) });
  }
  if (listing) {
    const visible = scored.filter((x) => x.visible).sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return visible.slice(0, limit).map((x) => matchOf(x)).map(({ rank: _rank, ...m }) => m);
  }
  // Last resort for clicking by text: the innermost visible element carrying the text.
  if (p.textFallback && !scored.some((x) => x.visible)) {
    let n = 0;
    for (const el of area.querySelectorAll(area === document ? "body *" : "*")) {
      if (++n > MAX_SCAN * 2) break;
      if (!(el instanceof HTMLElement) || !words.every((w) => (el.textContent ?? "").toLowerCase().includes(w))) continue;
      if (!shown(el) || el.closest("[role=tooltip], [aria-hidden=true]")) continue;
      const own = squash(el.innerText).toLowerCase();
      if (!own || own.length > want.length * 4 + 40) continue;
      if ([...el.children].some((c) => squash((c as HTMLElement).innerText).toLowerCase().includes(want))) continue;
      const s = score(own, want);
      if (s) scored.push({ el: refAncestor(el) ?? el, s, role: "other", name: squash(el.innerText).slice(0, 200), visible: true });
    }
  }
  return scored
    .map((x) => matchOf(x))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ rank: _rank, ...m }) => m);
}

/** One found control: what it is, where, and whether a click can reach it now. */
function matchOf(x: { el: Element; s: number; role: ControlRole; name: string; visible: boolean }): ControlMatch & { rank: number } {
  const disabled = (x.el as HTMLButtonElement).disabled === true || x.el.getAttribute("aria-disabled") === "true";
  const base = { role: x.role, name: x.name, region: regionOf(x.el) };
  if (!x.visible) {
    const o = opener(x.el);
    return { ...base, state: "hidden", ...(o ? { openWith: { ref: refFor(o), name: nameOf(o) } } : {}), rank: x.s - 3 };
  }
  const ref = refFor(x.el, !hasRef(x.el) && x.role === "other");
  if (disabled) return { ...base, ref, state: "disabled", rank: x.s - 4 };
  // Out of the window, or scrolled out of its own list (a dialog's grid): click scrolls to it.
  if (!sightOf(x.el).inView) return { ...base, ref, state: "offscreen", rank: x.s - 0.5 };
  const r = x.el.getBoundingClientRect();
  const c = checkPoint({ ref, x: r.left + r.width / 2, y: r.top + r.height / 2 });
  if (c.ok) return { ...base, ref, state: "visible", rank: x.s };
  if (!c.covering) return { ...base, ref, state: "offscreen", rank: x.s - 0.5 };
  return { ...base, ref, state: "covered", coveredBy: { ref: c.covering.ref, text: c.covering.text }, rank: x.s - 2 };
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
export function checkPoint(p: { ref: string; x: number; y: number }): { ok: true } | { ok: false; covering: { ref: string; tag: string; text: string } | null; clipped?: true; outside?: true } {
  const target = elementByRef(p.ref);
  // Past the window's edge (a dialog wider than a narrow window): nothing there to hit, but it's not gone.
  if (target && isVisible(target) && (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight)) return { ok: false, covering: null, outside: true };
  const hit = deepElementFromPoint(p.x, p.y);
  if (!target || !hit) return { ok: false, covering: null };
  if (composedContains(target, hit)) return { ok: true };
  // What's there is the element's own container: it's scrolled out of its list, not covered by anything.
  if (composedContains(hit, target)) return { ok: false, covering: null, clipped: true };
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

/** A visible link on this page to `href` that opens in this tab, given a ref; null if there is none. */
export function refForHref(p: { href: string }): string | null {
  // A target with a #fragment (a single-page app's route, Gmail's #settings/themes) needs a link to that
  // route: any link to the same page would do otherwise, and Gmail's Inbox link won (live, 13 Nov 2026).
  const keepHash = /#./.test(p.href);
  const norm = (h: string) => (keepHash ? h : h.replace(/#.*$/, "")).replace(/\/(?=#|$)/, "");
  const want = norm(p.href);
  for (const a of document.querySelectorAll("a[href]")) {
    const el = a as HTMLAnchorElement;
    if (norm(el.href) !== want) continue;
    if ((el.target && el.target !== "_self" && el.target !== "_top") || el.hasAttribute("download")) continue;
    if (!isVisible(el)) continue;
    return refFor(el);
  }
  return null;
}

/** The live element for a ref, returned as a handle (not by value) so typing can target it without a selector. */
export function elementForRef(p: { ref: string }): Element | null {
  return elementByRef(p.ref);
}

(globalThis as unknown as { __crossbar: unknown }).__crossbar = { extract, collectItems, scrollState, applyCosmetics, listLinks, locateRef, refAtPoint, checkPoint, domTokens, findControls, elementForRef, refForHref };
