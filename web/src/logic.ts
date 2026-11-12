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
