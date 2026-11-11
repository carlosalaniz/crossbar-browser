// SPDX-License-Identifier: AGPL-3.0-only
// Accounts: login (+ captcha, + TOTP), registration, login wall, wrong-origin login, sign-in provider, OAuth consent.
import { formCaptchaOk, runGate, widgetFor, type App, type Router } from "../app.ts";
import { hostUrl, redirect, send, type Ctx } from "../context.ts";
import { esc, page } from "../html.ts";
import { verifyTotp } from "../accounts.ts";

export function requireLogin(ctx: Ctx): boolean {
  if (ctx.session.user) return true;
  redirect(ctx, `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
  return false;
}

function safeNext(n: string | null | undefined): string {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/account";
}

function loginForm(ctx: Ctx, app: App, opts: { error?: string; widget?: string; action?: string; next: string; host: string }): string {
  return page("Sign in", `
${opts.error ? `<p class="warn" role="alert">${esc(opts.error)}</p>` : ""}
<form method="POST" action="${esc(opts.action ?? "/login")}" data-captcha>
<input type="hidden" name="next" value="${esc(opts.next)}">
<label>Username <input name="username" autocomplete="username" required></label>
<label>Password <input type="password" name="password" autocomplete="current-password" required></label>
${opts.widget ?? ""}
<button>Sign in</button></form>
<p class="note">Fixtures: alice / correct-horse-battery-staple, or bob (TOTP). <a href="/register">Register</a>. Add <code>?mode=always</code> to require a captcha.</p>`, { host: opts.host });
}

export function registerAccounts(r: Router): void {
  r.add("site-a.test", "GET", "/login", (ctx, app) => {
    const g = runGate(ctx, app);
    if (g.handled) return;
    send(ctx, 200, loginForm(ctx, app, { next: safeNext(ctx.url.searchParams.get("next")), widget: g.widget ? widgetFor(ctx, app, g.widget) : "", host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/login", async (ctx, app) => {
    const next = safeNext(ctx.body.next);
    if (!(await formCaptchaOk(ctx, app, "/login"))) return send(ctx, 403, loginForm(ctx, app, { error: "Captcha missing or invalid.", next, host: ctx.host, widget: "" }));
    const acct = app.accounts.check(ctx.body.username ?? "", ctx.body.password ?? "");
    if (!acct) return send(ctx, 401, loginForm(ctx, app, { error: "Wrong username or password.", next, host: ctx.host }));
    if (acct.totp) {
      ctx.session.pendingTotp = acct.username;
      return redirect(ctx, `/login/totp?next=${encodeURIComponent(next)}`, 303);
    }
    ctx.session.user = acct.username;
    redirect(ctx, next, 303);
  });
  r.add("site-a.test", "GET", "/login/totp", (ctx) => {
    if (!ctx.session.pendingTotp) return redirect(ctx, "/login");
    send(ctx, 200, page("Two-step verification", `
<form method="POST" action="/login/totp"><input type="hidden" name="next" value="${esc(safeNext(ctx.url.searchParams.get("next")))}">
<label>6-digit code <input name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label>
<button>Verify</button></form><p class="note">Fixture secret for bob: JBSWY3DPEHPK3PXP</p>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/login/totp", (ctx, app) => {
    const user = ctx.session.pendingTotp;
    const acct = user ? app.accounts.get(user) : undefined;
    if (!acct?.totp) return redirect(ctx, "/login", 303);
    if (!verifyTotp(acct.totp, ctx.body.code ?? "", app.now())) return send(ctx, 401, page("Two-step verification", `<p class="warn">Wrong code.</p><p><a href="/login/totp">Try again</a></p>`, { host: ctx.host }));
    delete ctx.session.pendingTotp;
    ctx.session.user = acct.username;
    redirect(ctx, safeNext(ctx.body.next), 303);
  });
  r.add("site-a.test", "POST", "/logout", (ctx) => {
    delete ctx.session.user;
    redirect(ctx, "/", 303);
  });
  r.add("site-a.test", "GET", "/account", (ctx, app) => {
    if (!requireLogin(ctx)) return;
    const a = app.accounts.get(ctx.session.user!);
    send(ctx, 200, page("Your account", `<p>Signed in as <strong>${esc(a?.displayName ?? ctx.session.user)}</strong> (${esc(a?.email ?? "")}).</p>
<ul><li><a href="/inbox">Inbox</a></li><li><a href="/settings">Settings</a></li><li><a href="/billing">Billing</a></li><li><a href="/account/delete">Delete account</a></li></ul>
<form method="POST" action="/logout"><button>Sign out</button></form>`, { host: ctx.host }));
  });

  // Registration: email, password, confirm, captcha (always), terms.
  r.add("site-a.test", "GET", "/register", (ctx, app) => {
    const cfg = app.gateConfig(ctx.url.searchParams);
    app.sessions.get(ctx.session.id)!.pendingCaptcha.set("/register", cfg.provider);
    send(ctx, 200, page("Create an account", `
<form method="POST" action="/register" data-captcha>
<label>Username <input name="username" autocomplete="username" required></label>
<label>Email <input type="email" name="email" autocomplete="email" required></label>
<label>Password <input type="password" name="password" autocomplete="new-password" required></label>
<label>Confirm password <input type="password" name="confirm" autocomplete="new-password" required></label>
${widgetFor(ctx, app, cfg.provider)}
<label><input type="checkbox" name="terms" value="1" required> I agree to the fixture terms</label>
<button>Create account</button></form>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/register", async (ctx, app) => {
    const b = ctx.body;
    const err = !(await formCaptchaOk(ctx, app, "/register"))
      ? "Captcha missing or invalid."
      : !b.username || !b.email || !b.password
        ? "All fields are required."
        : b.password !== b.confirm
          ? "Passwords don't match."
          : b.terms !== "1"
            ? "Accept the terms."
            : !app.accounts.register({ username: b.username, email: b.email, password: b.password, displayName: b.username })
              ? "That username is taken."
              : null;
    if (err) return send(ctx, 400, page("Create an account", `<p class="warn">${esc(err)}</p><p><a href="/register">Back</a></p>`, { host: ctx.host }));
    ctx.session.user = b.username;
    redirect(ctx, "/account", 303);
  });

  // Login wall: content that redirects to login when signed out.
  r.add("site-a.test", "GET", "/members/article", (ctx) => {
    if (!requireLogin(ctx)) return;
    send(ctx, 200, page("Members-only article", `<article><h1>For members</h1>${"<p>Signed-in fixture content.</p>".repeat(5)}</article>`, { host: ctx.host }));
  });

  // Wrong-origin login: the ticket is for site-a.test, but the password field lives on site-b.test.
  r.add("site-a.test", "GET", "/accounts/wrong-origin", (ctx) => {
    send(ctx, 200, page("Sign in to continue", `<p>To read this page, sign in below.</p>
<iframe src="${esc(hostUrl(ctx, "site-b.test", "/embedded-login?for=site-a.test"))}" title="Sign in" width="420" height="260" style="border:1px solid #ccc"></iframe>
<p class="note">The frame is site-b.test. A takeover for a site-a.test login ticket must warn that the password field is on a different origin.</p>`, { host: ctx.host }));
  });
  r.add("site-a.test", "GET", "/accounts/wrong-origin-redirect", (ctx) => redirect(ctx, hostUrl(ctx, "site-b.test", "/embedded-login?for=site-a.test&top=1")));
  r.add("site-b.test", "GET", "/embedded-login", (ctx) => {
    send(ctx, 200, page("Sign in (site-b.test)", `<form method="POST" action="/embedded-login">
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button>Sign in</button></form>`, { host: ctx.host }));
  });
  r.add("site-b.test", "POST", "/embedded-login", (ctx) => send(ctx, 200, page("site-b.test", "<p>Credentials received by site-b.test (fixture; not the site you meant to sign in to).</p>", { host: ctx.host })));

  // Sign-in provider: humans only.
  r.add("accounts.idp.test", "GET", "/signin", (ctx) => {
    const cont = ctx.url.searchParams.get("continue") ?? "";
    send(ctx, 200, page("Sign in with IdP", `<form method="POST" action="/signin"><input type="hidden" name="continue" value="${esc(cont)}">
<label>Email <input type="email" name="email" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button>Next</button></form><p class="note">A sign-in provider. Crossbar refuses agent typing anywhere on this host.</p>`, { host: ctx.host }));
  });
  r.add("accounts.idp.test", "POST", "/signin", (ctx) => {
    ctx.session.user = ctx.body.email || "idp-user";
    const cont = ctx.body.continue;
    redirect(ctx, cont && cont.startsWith("/") && !cont.startsWith("//") ? cont : "/", 303);
  });

  // OAuth consent: always asks.
  r.add("site-a.test", "GET", "/connect/idp", (ctx) => {
    const q = new URLSearchParams({ client_id: "site-a", redirect_uri: hostUrl(ctx, "site-a.test", "/oauth/callback"), scope: "profile email contacts.read", state: "fixture-state", response_type: "code" });
    redirect(ctx, hostUrl(ctx, "accounts.idp.test", `/oauth/authorize?${q}`));
  });
  r.add("site-a.test", "GET", "/connect/site-b", (ctx) => {
    const q = new URLSearchParams({ client_id: "site-a", redirect_uri: hostUrl(ctx, "site-a.test", "/oauth/callback"), scope: "profile email repo.write", state: "fixture-state", response_type: "code" });
    redirect(ctx, hostUrl(ctx, "site-b.test", `/oauth/authorize?${q}`));
  });
  // The same consent page on two providers: accounts.idp.test (a sign-in provider; agents are refused
  // there) and site-b.test (an ordinary site acting as an OAuth provider; the fixture user is already
  // signed in, so an agent reaches the Allow/Deny decision).
  for (const provider of ["accounts.idp.test", "site-b.test"] as const) {
    r.add(provider, "GET", "/oauth/authorize", (ctx) => {
      const q = ctx.url.searchParams;
      if (provider === "site-b.test") ctx.session.user ??= "alice@site-b.test";
      if (!ctx.session.user) return redirect(ctx, `/signin?continue=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
      const hidden = ["client_id", "redirect_uri", "scope", "state"].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? "")}">`).join("");
      send(ctx, 200, page("Authorize site-a", `<p><strong>${esc(q.get("client_id"))}</strong> wants to access your account (${esc(ctx.session.user)}):</p>
  <ul>${(q.get("scope") ?? "").split(" ").map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
  <form method="POST" action="/oauth/authorize">${hidden}<button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form>`, { host: ctx.host }));
    });
    r.add(provider, "POST", "/oauth/authorize", (ctx) => {
      const b = ctx.body;
      let target: URL;
      try {
        target = new URL(b.redirect_uri ?? "");
      } catch {
        return send(ctx, 400, "bad redirect_uri");
      }
      if (b.decision === "allow") target.searchParams.set("code", "fixture-code");
      else target.searchParams.set("error", "access_denied");
      target.searchParams.set("state", b.state ?? "");
      redirect(ctx, target.toString(), 303);
    });
  }
  r.add("site-a.test", "GET", "/oauth/callback", (ctx) => {
    const q = ctx.url.searchParams;
    send(ctx, 200, page("Connected", q.get("code") ? `<p>IdP connected (code ${esc(q.get("code"))}).</p>` : `<p>Not connected: ${esc(q.get("error"))}.</p>`, { host: ctx.host }));
  });
}
