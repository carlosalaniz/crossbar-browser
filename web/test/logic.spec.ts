// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test, expect } from "vitest";
import { parseRoute, headline, toPage, timeLeft, SCOPE_LABEL, type TicketView } from "../src/logic.ts";

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
    expect(headline(ticket({ facts: { actionClass: "comment", domain: "reddit.com", trigger: { kind: "page" } } }))).toBe("A page on reddit.com wants to send data by itself");
  });
  test("always label names the site and class", () => {
    expect(SCOPE_LABEL.always!(ticket({ facts: { actionClass: "comment", domain: "reddit.com" } }))).toBe("Always comment on reddit.com");
  });
});

describe("takeover", () => {
  test("taps on the scaled image map to CSS pixels", () => {
    expect(toPage({ x: 100, y: 200 }, { width: 195, height: 422 }, { width: 390, height: 844 })).toEqual({ x: 200, y: 400 });
  });
  test("time left", () => {
    expect(timeLeft(new Date(Date.now() + 125_000).toISOString())).toBe("2 min left");
    expect(timeLeft(new Date(Date.now() - 1).toISOString())).toBe("expired");
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
