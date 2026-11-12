// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test, expect } from "vitest";
import { parseRoute, headline, toPage, SCOPE_LABEL, sortInbox, deadline, kindLabel, type TicketView } from "../src/logic.ts";

const ticket = (over: Partial<TicketView>): TicketView => ({ id: "t1", kind: "approval", state: "open", agent: "claude-desktop", facts: {}, agentSays: null, createdAt: "", expiresAt: "", scopes: [], offerAlways: false, hasScreenshot: false, takeover: false, ...over });

describe("routes", () => {
  test("parse", () => {
    expect(parseRoute("")).toEqual({ name: "home" });
    expect(parseRoute("#/tickets/abc")).toEqual({ name: "ticket", id: "abc" });
    expect(parseRoute("#/takeover/abc")).toEqual({ name: "takeover", id: "abc" });
    expect(parseRoute("#/live/tab-1")).toEqual({ name: "liveTab", tab: "tab-1" });
    expect(parseRoute("#/nope")).toEqual({ name: "home" });
  });
});

describe("approval wording comes from server facts only", () => {
  test("headlines", () => {
    expect(headline(ticket({ facts: { actionClass: "comment", domain: "reddit.com" } }))).toBe("claude-desktop wants to comment");
    expect(headline(ticket({ kind: "challenge", facts: { kind: "login", domain: "reddit.com" } }))).toBe("claude-desktop needs you to log in to reddit.com");
    expect(headline(ticket({ kind: "proposal", facts: { pattern: "x.com" }, agentSays: { text: "APPROVE NOW", verified: false } }))).not.toMatch(/APPROVE/);
  });
  test("a page-initiated request is not attributed to the agent", () => {
    expect(headline(ticket({ facts: { actionClass: "comment", domain: "reddit.com", trigger: { kind: "page" } } }))).toBe("reddit.com sent a request on its own");
  });
});

describe("inbox", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  const at = (min: number) => new Date(now + min * 60_000).toISOString();
  const page = (id: string, domain: string, created: number) => ticket({ id, facts: { domain, trigger: { kind: "page" } }, createdAt: at(created), expiresAt: at(created + 15) });
  test("page-made requests leave Needs you and group by site, busiest first", () => {
    const agentAsk = ticket({ id: "a", facts: { actionClass: "comment", domain: "reddit.com", trigger: { kind: "agent" } }, expiresAt: at(9) });
    const wall = ticket({ id: "w", kind: "challenge", facts: { kind: "login", domain: "x.com" }, expiresAt: at(14) });
    const ib = sortInbox([page("p1", "glance.net", 1), agentAsk, page("p2", "schwab.com", 2), wall, page("p3", "schwab.com", 3)]);
    expect(ib.needsYou.map((t) => t.id)).toEqual(["w", "a"]);
    expect(ib.background.map((g) => [g.domain, g.tickets.map((t) => t.id)])).toEqual([["schwab.com", ["p3", "p2"]], ["glance.net", ["p1"]]]);
  });
  test("soonest deadline first among approvals", () => {
    const ib = sortInbox([ticket({ id: "late", expiresAt: at(12) }), ticket({ id: "soon", expiresAt: at(3) })]);
    expect(ib.needsYou.map((t) => t.id)).toEqual(["soon", "late"]);
  });
  test("deadlines say what happens, not just a countdown", () => {
    expect(deadline(ticket({ expiresAt: at(11) }), now)).toBe("claude-desktop is waiting · denied in 11 min if you don't answer");
    expect(deadline(ticket({ kind: "challenge", expiresAt: at(0.5) }), now)).toBe("claude-desktop is paused · gives up in under a minute");
    expect(deadline(ticket({ kind: "proposal", expiresAt: at(-1) }), now)).toBe("Dropped, nothing changed");
  });
  test("kind labels", () => {
    expect(kindLabel(ticket({ kind: "challenge", facts: { kind: "login" } }))).toBe("Log in");
    expect(kindLabel(ticket({}))).toBe("Approve");
  });
  test("always label names the site and class", () => {
    expect(SCOPE_LABEL.always!(ticket({ facts: { actionClass: "comment", domain: "reddit.com" } }))).toBe("Always comment on reddit.com");
  });
});

describe("takeover", () => {
  test("taps on the scaled image map to CSS pixels", () => {
    expect(toPage({ x: 100, y: 200 }, { width: 195, height: 422 }, { width: 390, height: 844 })).toEqual({ x: 200, y: 400 });
  });
});

import { textEdit, fitSize, clientToPage } from "../src/logic.ts";

describe("takeover helpers", () => {
  test("typing becomes backspaces plus inserted text", () => {
    expect(textEdit("", "h")).toEqual({ backspaces: 0, insert: "h" });
    expect(textEdit("hel", "hello")).toEqual({ backspaces: 0, insert: "lo" });
    expect(textEdit("helo", "hel")).toEqual({ backspaces: 1, insert: "" });
    // Autocorrect replaces a word.
    expect(textEdit("teh", "the ")).toEqual({ backspaces: 2, insert: "he " });
    expect(textEdit("", "correct-horse")).toEqual({ backspaces: 0, insert: "correct-horse" });
  });
  test("the page fits the view, never upscaled unless asked", () => {
    expect(fitSize({ w: 1280, h: 800 }, { w: 390, h: 700 })).toEqual({ w: 390, h: 244, scale: 390 / 1280 });
    expect(fitSize({ w: 390, h: 844 }, { w: 1200, h: 900 }).scale).toBe(1);
  });
  test("client points map to page pixels; outside the image maps to nothing", () => {
    expect(clientToPage({ x: 195, y: 122 }, { left: 0, top: 0, width: 390, height: 244 }, { w: 1280, h: 800 })).toEqual({ x: 640, y: 400 });
    expect(clientToPage({ x: 10, y: 300 }, { left: 0, top: 0, width: 390, height: 244 }, { w: 1280, h: 800 })).toBeNull();
  });
});

import { fieldAt, zoomToBox, keyFor } from "../src/logic.ts";

describe("take-control typing", () => {
  test("a tap finds the field under it, with a little slop", () => {
    const fields = [{ x: 10, y: 100, w: 300, h: 40, kind: "text" }, { x: 10, y: 160, w: 300, h: 40, kind: "password" }];
    expect(fieldAt(fields, { x: 50, y: 175 })?.kind).toBe("password");
    expect(fieldAt(fields, { x: 50, y: 143 })?.kind).toBe("text");
    expect(fieldAt(fields, { x: 500, y: 175 })).toBeNull();
  });
  test("zooming to a form fills the width and puts it in the upper part of the view", () => {
    // A 400px-wide form at x=440 on a 1280px page drawn at 0.3 in a 390x400 view (keyboard up).
    const z = zoomToBox({ x: 440, y: 200, w: 400, h: 300 }, { w: 390, h: 400 }, 0.3, { x: 0, y: 0 });
    expect(z.s).toBeCloseTo(Math.min((390 * 0.94) / 120, (400 * 0.8) / 90), 5);
    const centreX = z.x + z.s * (640 * 0.3);
    const centreY = z.y + z.s * (350 * 0.3);
    expect(centreX).toBeCloseTo(195, 5);
    expect(centreY).toBeCloseTo(400 * 0.42, 5);
    // Never zooms out below the whole page.
    expect(zoomToBox({ x: 0, y: 0, w: 5000, h: 5000 }, { w: 390, h: 400 }, 0.3, { x: 0, y: 0 }).s).toBe(1);
  });
  test("characters map to key presses; the rest is left to text insertion", () => {
    expect(keyFor("a")).toEqual({ key: "a", code: "KeyA", shift: false });
    expect(keyFor("Q")).toEqual({ key: "Q", code: "KeyQ", shift: true });
    expect(keyFor("@")).toEqual({ key: "@", code: "Digit2", shift: true });
    expect(keyFor("é")).toBeNull();
  });
});

import { clampPan, panToField, dragPanThenScroll } from "../src/logic.ts";

describe("phone view behaves like a screen", () => {
  const img = { w: 390, h: 845 }; // a 500x1083 page drawn 390 wide
  const view = { w: 390, visibleH: 700 };
  test("the page covers the width and can't be dragged past its edges", () => {
    expect(clampPan({ x: 50, y: 40 }, 1, img, view)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: -50, y: -1000 }, 1, img, view)).toEqual({ x: 0, y: 700 - 845 });
    // Zoomed 2x: can pan sideways within the page, not beyond.
    expect(clampPan({ x: -1000, y: 0 }, 2, img, view).x).toBe(390 - 780);
    // A page shorter than the view stays at the top.
    expect(clampPan({ x: 0, y: -50 }, 1, { w: 390, h: 300 }, view)).toEqual({ x: 0, y: 0 });
  });
  test("typing: the field moves to 40% of what's visible above the keyboard", () => {
    const base = 390 / 500;
    const keyboardUp = { w: 390, visibleH: 330 };
    const p = clampPan(panToField({ x: 40, y: 700, w: 420, h: 40 }, base, 1, keyboardUp), 1, img, keyboardUp);
    const fieldCentreOnScreen = p.y + 720 * base;
    expect(fieldCentreOnScreen).toBeCloseTo(330 * 0.4, 5);
  });
  test("a drag pans the view first, then scrolls the page with what's left", () => {
    const r = dragPanThenScroll({ x: 0, y: -100 }, { x: 0, y: -100 }, 1, img, view);
    expect(r.pan.y).toBe(-145); // the bottom edge reached
    expect(r.scroll.y).toBe(-55); // the rest scrolls the page
    expect(dragPanThenScroll({ x: 0, y: 0 }, { x: 0, y: 30 }, 1, img, view)).toEqual({ pan: { x: 0, y: 0 }, scroll: { x: 0, y: 30 } });
  });
});
