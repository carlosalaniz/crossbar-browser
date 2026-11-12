// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers for the web app (tested with Vitest).

export type Route =
  | { name: "home" }
  | { name: "setup" }
  | { name: "login" }
  | { name: "tickets" }
  | { name: "ticket"; id: string }
  | { name: "takeover"; id: string }
  | { name: "connect" }
  | { name: "sites" }
  | { name: "live" }
  | { name: "liveTab"; tab: string }
  | { name: "activity" }
  | { name: "settings" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b] = parts;
  switch (a) {
    case undefined:
      return { name: "home" };
    case "setup":
      return { name: "setup" };
    case "login":
      return { name: "login" };
    case "tickets":
      return b ? { name: "ticket", id: b } : { name: "tickets" };
    case "takeover":
      return b ? { name: "takeover", id: b } : { name: "home" };
    case "connect":
      return { name: "connect" };
    case "sites":
      return { name: "sites" };
    case "live":
      return b ? { name: "liveTab", tab: b } : { name: "live" };
    case "activity":
      return { name: "activity" };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "home" };
  }
}

export interface TicketView {
  id: string;
  kind: "approval" | "proposal" | "challenge";
  state: string;
  agent: string | null;
  facts: Record<string, unknown>;
  agentSays: { text: string; verified: false } | null;
  createdAt: string;
  expiresAt: string;
  scopes: string[];
  offerAlways: boolean;
  hasScreenshot: boolean;
  takeover: boolean;
  takeoverTab?: string | null;
}

const VERB: Record<string, string> = {
  comment: "comment",
  vote: "vote",
  save: "save or follow",
  message: "send a private message",
  pay: "pay",
  delete: "delete something",
  credentials: "change account security",
  oauth: "authorize an app",
  sensitive_path: "open a private page",
  taint_exit: "send data to a new site",
  login_use: "use your login",
  write: "send data",
};

/** Headline built only from server-observed facts and the agent name the person chose. */
export function headline(t: TicketView): string {
  const agent = t.agent ?? "An agent";
  const f = t.facts;
  if (t.kind === "challenge") {
    const kind = String(f.kind);
    const d = String(f.domain ?? "a site");
    return kind === "login" ? `${agent} needs you to log in to ${d}` : kind === "verification" ? `${agent} needs you to confirm a payment with your bank on ${d}` : kind === "captcha" ? `${agent} hit a ${String(f.vendor)} check on ${d}` : `${d} is blocking ${agent}`;
  }
  if (t.kind === "proposal") return `${agent} asks to change ${String(f.pattern)}`;
  if ((f.trigger as { kind?: string } | undefined)?.kind === "page") return `A page on ${String(f.domain ?? "a site")} wants to send data by itself`;
  return `${agent} wants to ${VERB[String(f.actionClass)] ?? "send data"}`;
}

export const SCOPE_LABEL: Record<string, (t: TicketView) => string> = {
  task: () => "Allow for this task",
  once: () => "Allow once",
  always: (t) => `Always ${VERB[String(t.facts.actionClass)] ?? "allow"} on ${String(t.facts.domain)}`,
  apply: () => "Apply change",
};

/** Map a tap on the scaled live image to page coordinates. */
export function toPage(tap: { x: number; y: number }, shown: { width: number; height: number }, natural: { width: number; height: number }, deviceScale = 1): { x: number; y: number } {
  const sx = natural.width / shown.width;
  const sy = natural.height / shown.height;
  return { x: Math.round((tap.x * sx) / deviceScale), y: Math.round((tap.y * sy) / deviceScale) };
}

export function timeLeft(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return m > 0 ? `${m} min left` : `${s} s left`;
}

export function levelLabel(level: string): string {
  return ({ blocked: "Blocked", read: "Can read", read_as_you: "Can read as you", act_as_you: "Can act as you" } as Record<string, string>)[level] ?? level;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Takeover typing from a phone: the hidden field's old and new value as Backspaces plus inserted text.
 * Works for keyboards that compose whole words (Android), autocorrect, and password-manager fills.
 */
export function textEdit(before: string, after: string): { backspaces: number; insert: string } {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  return { backspaces: before.length - i, insert: after.slice(i) };
}

/** The size to draw the remote page at so it fits the view without distortion (never upscaled on desktop). */
export function fitSize(page: { w: number; h: number }, view: { w: number; h: number }, allowUpscale = false): { w: number; h: number; scale: number } {
  const scale = Math.min(view.w / page.w, view.h / page.h, allowUpscale ? Infinity : 1);
  return { w: Math.round(page.w * scale), h: Math.round(page.h * scale), scale };
}

/** A point on the drawn image (client coordinates) to the remote page's CSS pixels. */
export function clientToPage(p: { x: number; y: number }, drawn: { left: number; top: number; width: number; height: number }, page: { w: number; h: number }): { x: number; y: number } | null {
  const rx = (p.x - drawn.left) / drawn.width;
  const ry = (p.y - drawn.top) / drawn.height;
  if (rx < 0 || ry < 0 || rx > 1 || ry > 1) return null;
  return { x: Math.round(rx * page.w), y: Math.round(ry * page.h) };
}

export interface PageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The text field under a point on the page, if any (so a tap on it can open the phone keyboard at once). */
export function fieldAt<T extends PageBox>(fields: T[], p: { x: number; y: number }, slop = 6): T | null {
  return fields.find((f) => p.x >= f.x - slop && p.x <= f.x + f.w + slop && p.y >= f.y - slop && p.y <= f.y + f.h + slop) ?? null;
}

/**
 * Zoom and pan for the take-control view so `target` (page px) fills the width of the visible area and sits
 * in its upper part, above the keyboard. `fit` is image px per page px at zoom 1; `origin` is where the
 * unzoomed image's top-left sits in the view. Returns a transform: translate(x, y) scale(s), origin 0 0.
 */
export function zoomToBox(target: PageBox, view: { w: number; h: number }, fit: number, origin: { x: number; y: number }, maxZoom = 4): { s: number; x: number; y: number } {
  const byWidth = (view.w * 0.94) / Math.max(1, target.w * fit);
  const byHeight = (view.h * 0.8) / Math.max(1, target.h * fit);
  const s = Math.max(1, Math.min(maxZoom, byWidth, byHeight));
  const cx = (target.x + target.w / 2) * fit;
  const cy = (target.y + target.h / 2) * fit;
  return { s, x: view.w / 2 - origin.x - s * cx, y: view.h * 0.42 - origin.y - s * cy };
}

/** Key and code for a character a plain keyboard types, so typing reaches the page as key presses. */
export function keyFor(ch: string): { key: string; code: string; shift: boolean } | null {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, shift: false };
  if (ch === " ") return { key: " ", code: "Space", shift: false };
  const punct: Record<string, string> = { ".": "Period", ",": "Comma", "-": "Minus", "/": "Slash", ";": "Semicolon", "'": "Quote", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "`": "Backquote" };
  if (punct[ch]) return { key: ch, code: punct[ch]!, shift: false };
  const shifted: Record<string, string> = { "!": "Digit1", "@": "Digit2", "#": "Digit3", $: "Digit4", "%": "Digit5", "^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0", _: "Minus", "+": "Equal", ":": "Semicolon", '"': "Quote", "<": "Comma", ">": "Period", "?": "Slash", "{": "BracketLeft", "}": "BracketRight", "|": "Backslash", "~": "Backquote" };
  if (shifted[ch]) return { key: ch, code: shifted[ch]!, shift: true };
  return null;
}

/**
 * Phone view (take control): the page image is drawn as wide as the view; `z` (≥1) zooms further. The pan is
 * clamped so the page always covers the view sideways (no black bars) and, vertically, so you can't scroll past
 * its top or past its bottom edge reaching the top of what covers the view (buttons, keyboard): `visibleH`.
 */
export function clampPan(pan: { x: number; y: number }, z: number, img: { w: number; h: number }, view: { w: number; visibleH: number }): { x: number; y: number } {
  const w = img.w * z;
  const h = img.h * z;
  const x = Math.min(0, Math.max(view.w - w, pan.x));
  const y = h <= view.visibleH ? 0 : Math.min(0, Math.max(view.visibleH - h, pan.y));
  return { x, y };
}

/** Where to pan so a field (page px) sits at 40% of the visible part of the view, as a phone browser does. */
export function panToField(field: PageBox, base: number, z: number, view: { w: number; visibleH: number }): { x: number; y: number } {
  const cx = (field.x + field.w / 2) * base * z;
  const cy = (field.y + field.h / 2) * base * z;
  return { x: view.w / 2 - cx, y: view.visibleH * 0.4 - cy };
}

/** A one-finger drag on the phone view: pan the view first; what's left past its edge scrolls the page. */
export function dragPanThenScroll(pan: { x: number; y: number }, d: { x: number; y: number }, z: number, img: { w: number; h: number }, view: { w: number; visibleH: number }): { pan: { x: number; y: number }; scroll: { x: number; y: number } } {
  const next = clampPan({ x: pan.x + d.x, y: pan.y + d.y }, z, img, view);
  return { pan: next, scroll: { x: d.x - (next.x - pan.x), y: d.y - (next.y - pan.y) } };
}
