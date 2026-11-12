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
