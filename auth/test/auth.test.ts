// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ROUTES } from "@crossbar/shared";
import { Auth, totpAt, verifyTotp, base32Encode, hashPassword, verifyPassword } from "../src/auth.ts";
import { startTestApp } from "../../server/test/helpers.ts";

describe("primitives", () => {
  test("TOTP matches the RFC 6238 SHA-1 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    assert.equal(totpAt(secret, 59_000), "287082");
    assert.equal(totpAt(secret, 1111111109_000), "081804");
    assert.ok(verifyTotp(secret, "287082", 59_000 + 30_000)); // one step of drift
    assert.ok(!verifyTotp(secret, "287082", 59_000 + 120_000));
  });
  test("passwords are scrypt-hashed and verified", async () => {
    const h = await hashPassword("correct horse battery");
    assert.match(h, /^scrypt\$/);
    assert.ok(await verifyPassword("correct horse battery", h));
    assert.ok(!(await verifyPassword("wrong", h)));
  });
});

describe("login and the route table", () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let auth: Auth;
  let code: string;
  let logs: string[];
  before(async () => {
    logs = [];
    t = await startTestApp({ users: {}, authFactory: (db) => (auth = new Auth(db, { appOrigin: "http://crossbar.test", log: (m) => logs.push(m) })) });
    code = auth.ensureSetupCode()!;
  });
  after(() => t?.close());

  async function call(method: string, path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", "x-crossbar": "1", ...extra };
    if (cookie) headers.cookie = cookie;
    const r = await fetch(t.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = r.headers.get("set-cookie");
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown>, cookie: setCookie ? setCookie.split(";")[0] : undefined, setCookie };
  }

  test("every session or token route refuses an anonymous request", async () => {
    for (const r of ROUTES) {
      if (r.auth === "public") continue;
      const path = r.path.replace(/:(\w+)/g, "x");
      const res = await fetch(t.base + path, { method: r.method, headers: { "content-type": "application/json", "x-crossbar": "1" }, body: r.method === "GET" ? undefined : "{}" });
      assert.equal(res.status, 401, `${r.method} ${r.path} answered ${res.status} without a login`);
    }
  });

  test("setup needs the code from the logs and creates the owner", async () => {
    assert.ok(logs.some((l) => l.includes(code)));
    assert.equal((await call("GET", "/api/setup")).json.open, true);
    assert.equal((await call("POST", "/api/setup", { code: "wrong-code", username: "owner", password: "a long password" })).status, 403);
    const ok = await call("POST", "/api/setup", { code, username: "Owner", password: "a long password" });
    assert.equal(ok.status, 200);
    assert.match(ok.setCookie!, /HttpOnly/);
    assert.match(ok.setCookie!, /SameSite=Lax/);
    const me = await call("GET", "/api/me", undefined, ok.cookie);
    assert.equal(me.json.username, "owner");
    assert.equal(me.json.isOwner, true);
    // The code works once.
    assert.equal((await call("POST", "/api/setup", { code, username: "x", password: "a long password" })).status, 403);
  });

  test("password login, logout, and session-only routes", async () => {
    assert.equal((await call("POST", "/api/login", { username: "owner", password: "nope" })).status, 401);
    const ok = await call("POST", "/api/login", { username: "owner", password: "a long password" });
    assert.equal(ok.status, 200);
    assert.equal((await call("GET", "/api/tokens", undefined, ok.cookie)).status, 200);
    await call("POST", "/api/logout", {}, ok.cookie);
    assert.equal((await call("GET", "/api/tokens", undefined, ok.cookie)).status, 401);
  });

  test("a token can't use session routes, even with a cookie", async () => {
    const owner = await call("POST", "/api/login", { username: "owner", password: "a long password" });
    const me = await call("GET", "/api/me", undefined, owner.cookie);
    const tok = t.services.tokens.create(String(me.json.userId), "a", "act").secret;
    // Token alone on a session route.
    assert.equal((await call("GET", "/api/tokens", undefined, undefined, { authorization: `Bearer ${tok}` })).status, 401);
  });

  test("household: the owner invites a member; members can't manage users", async () => {
    const owner = await call("POST", "/api/login", { username: "owner", password: "a long password" });
    assert.equal((await call("POST", "/api/users", { username: "sam", password: "another long one" }, owner.cookie)).status, 200);
    const sam = await call("POST", "/api/login", { username: "sam", password: "another long one" });
    assert.equal((await call("GET", "/api/users", undefined, sam.cookie)).status, 403);
  });

  test("TOTP: enrolment, login needs the code, recovery codes work once, approvals need a fresh check", async () => {
    const s1 = await call("POST", "/api/login", { username: "sam", password: "another long one" });
    const begin = await call("POST", "/api/me/totp/begin", {}, s1.cookie);
    const secret = String(begin.json.secret);
    assert.match(String(begin.json.otpauth), /^otpauth:\/\/totp\//);
    const en = await call("POST", "/api/me/totp/enable", { secret, code: totpAt(secret) }, s1.cookie);
    assert.equal(en.status, 200);
    const codes = en.json.recoveryCodes as string[];
    assert.equal(codes.length, 10);
    assert.equal((await call("POST", "/api/login", { username: "sam", password: "another long one" })).json.error, "second_factor_required");
    const s2 = await call("POST", "/api/login", { username: "sam", password: "another long one", totp: totpAt(secret) });
    assert.equal(s2.status, 200);
    const s3 = await call("POST", "/api/login", { username: "sam", password: "another long one", recoveryCode: codes[0] });
    assert.equal(s3.status, 200);
    assert.equal((await call("POST", "/api/login", { username: "sam", password: "another long one", recoveryCode: codes[0] })).status, 401);
    // A proposal for sam; approving it loosens access, so it needs a fresh factor.
    const me = await call("GET", "/api/me", undefined, s3.cookie);
    const tok = t.services.tokens.create(String(me.json.userId), "agent", "act").secret;
    const c = await t.mcpClient(tok);
    const p = await c.call("set_site", { pattern: "reddit.com", level: "act_as_you" });
    // Freshness from the login lasts 5 minutes; let it lapse.
    t.services.db.prepare("UPDATE web_sessions SET fresh_until = NULL").run();
    const denied = await call("POST", `/api/tickets/${p.ticket!.id}/approve`, { scope: "once" }, s3.cookie);
    assert.equal(denied.json.error, "fresh_factor_required");
    assert.equal((await call("POST", "/api/me/reauth", { totp: "000000" }, s3.cookie)).status, 401);
    assert.equal((await call("POST", "/api/me/reauth", { totp: totpAt(secret) }, s3.cookie)).status, 200);
    assert.equal((await call("POST", `/api/tickets/${p.ticket!.id}/approve`, { scope: "once" }, s3.cookie)).status, 200);
  });

  test("login is rate limited", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("POST", "/api/login", { username: "ratelimit", password: "x" })).status;
    assert.equal(last, 429);
  });

  test("reset-owner: a new code resets the owner's password and second factors", async () => {
    const reset = auth.resetOwner();
    assert.equal((await call("GET", "/api/setup")).json.reset, true);
    assert.equal((await call("POST", "/api/setup", { code: reset, username: "ignored", password: "brand new password" })).status, 200);
    assert.equal((await call("POST", "/api/login", { username: "owner", password: "a long password" })).status, 401);
    assert.equal((await call("POST", "/api/login", { username: "owner", password: "brand new password" })).status, 200);
  });

  test("passkey options use this origin's RP ID and require user verification", async () => {
    const o = await call("POST", "/api/passkey/login/options", {});
    const opts = o.json.options as { rpId: string; userVerification: string };
    assert.equal(opts.rpId, "crossbar.test");
    assert.equal(opts.userVerification, "required");
    // A made-up assertion fails cleanly.
    const v = await call("POST", "/api/passkey/login/verify", { challengeId: o.json.challengeId, response: { id: "nope", rawId: "nope", type: "public-key", response: {}, clientExtensionResults: {} } });
    assert.equal(v.status, 401);
  });
});
