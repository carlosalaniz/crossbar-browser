// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { credentialFieldReason, signInProviderReason, typeInto, TypingRefused } from "../src/input-guard.ts";
import { setup, openPage, evaluate, skipReason, type Env } from "./harness.ts";

describe("credential field rules", () => {
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ["input", { type: "password" }, true],
    ["input", { type: " PASSWORD " }, true],
    ["input", { autocomplete: "cc-number" }, true],
    ["input", { autocomplete: "billing cc-name" }, true],
    ["input", { autocomplete: "CC-CSC" }, true],
    ["input", { autocomplete: "one-time-code" }, true],
    ["input", { autocomplete: "current-password" }, true],
    ["input", { type: "text" }, false],
    ["input", { type: "email", autocomplete: "username" }, false],
    ["textarea", {}, false],
  ];
  for (const [localName, attributes, refused] of cases) {
    test(`${localName} ${JSON.stringify(attributes)} is ${refused ? "refused" : "allowed"}`, () => {
      assert.equal(credentialFieldReason({ localName, attributes }) !== null, refused);
    });
  }
  test("sign-in providers are refused, including subdomains", () => {
    assert.ok(signInProviderReason("https://accounts.google.com/signin"));
    assert.ok(signInProviderReason("https://foo.login.microsoftonline.com/"));
    assert.equal(signInProviderReason("https://google.com/"), null);
    assert.equal(signInProviderReason("https://notaccounts.google.com.evil.test/"), null);
  });
});

describe("typing in a real page", { skip: skipReason }, () => {
  let env: Env;
  let s: string;
  before(async () => {
    env = await setup();
    s = await openPage(env, env.site.url("a.test", "/password-form"));
    await env.browser.cdp.send("DOM.enable", undefined, s);
    // A page that flips a text field to a password field when it gets focus.
    await evaluate(env, s, `document.getElementById('sneaky').addEventListener('focus', e => e.target.type = 'password'); 1`);
  });
  after(() => env?.close());

  test("types into a plain text field", async () => {
    await typeInto(env.browser.cdp, s, "#name", "hello");
    assert.equal(await evaluate(env, s, `document.getElementById('name').value`), "hello");
  });

  for (const id of ["pw", "cc", "otp", "ccname", "sneaky"]) {
    test(`an agent can't type into #${id}`, async () => {
      await assert.rejects(typeInto(env.browser.cdp, s, `#${id}`, "hunter2"), TypingRefused);
      assert.equal(await evaluate(env, s, `document.getElementById('${id}').value`), "");
    });
  }

  test("an agent can't type on a sign-in provider", async () => {
    await assert.rejects(typeInto(env.browser.cdp, s, "#notes", "x", { providers: ["a.test"] }), /sign-in provider/);
  });
});
