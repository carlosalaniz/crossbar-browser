// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { credentialFieldReason, signInProviderReason, typeInto } from "../src/input-guard.ts";
import { setup, openPage, evaluate, skipReason, type Env } from "./harness.ts";

describe("credential field rules", () => {
  // All fields are now typable — credential restrictions have been removed.
  test("all field types are allowed", () => {
    assert.equal(credentialFieldReason({ localName: "input", attributes: { type: "password" } }), null);
    assert.equal(credentialFieldReason({ localName: "input", attributes: { autocomplete: "cc-number" } }), null);
    assert.equal(credentialFieldReason({ localName: "input", attributes: { autocomplete: "one-time-code" } }), null);
    assert.equal(credentialFieldReason({ localName: "input", attributes: { type: "text" } }), null);
  });

  test("sign-in providers are not restricted", () => {
    assert.equal(signInProviderReason("https://accounts.google.com/signin"), null);
    assert.equal(signInProviderReason("https://foo.login.microsoftonline.com/"), null);
    assert.equal(signInProviderReason("https://google.com/"), null);
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

  // Credential field restrictions have been removed — agents may type into any field.
  // The user controls access through sensitive categories.
  for (const id of ["pw", "cc", "otp", "ccname", "sneaky"]) {
    test(`an agent can type into #${id} (restrictions removed)`, async () => {
      await typeInto(env.browser.cdp, s, `#${id}`, "hunter2");
      assert.equal(await evaluate(env, s, `document.getElementById('${id}').value`), "hunter2");
    });
  }

  test("an agent can type on any page (sign-in provider restriction removed)", async () => {
    await typeInto(env.browser.cdp, s, "#notes", "x");
    assert.equal(await evaluate(env, s, `document.getElementById('notes').value`), "x");
  });
});
