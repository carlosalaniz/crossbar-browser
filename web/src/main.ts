// SPDX-License-Identifier: AGPL-3.0-only
// Crossbar web app: phone-first. Approvals, takeover, live view, connect, sites, activity, settings.
// Talks to /api only (Charter). Page text and agent reasons are shown as quotes, marked unverified.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { parseRoute, headline, SCOPE_LABEL, toPage, timeLeft, levelLabel, originOf, type Route, type TicketView } from "./logic.ts";

// ---------- tiny DOM helper ----------
type Child = Node | string | null | undefined | false | Child[];
function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  const add = (c: Child) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(typeof c === "string" ? document.createTextNode(c) : c);
  };
  children.forEach(add);
  return el;
}
const app = document.getElementById("app")!;
let cleanup: Array<() => void> = [];

// ---------- API ----------
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-crossbar": "1" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, json?.error ?? r.statusText);
  return json as T;
}

/** Run an action that may need a fresh second factor (approvals that loosen access). */
async function withFreshFactor<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.message !== "fresh_factor_required") throw e;
    await freshFactorDialog();
    return fn();
  }
}

function freshFactorDialog(): Promise<void> {
  return new Promise((resolve, reject) => {
    const code = h("input", { inputmode: "numeric", autocomplete: "one-time-code", placeholder: "6-digit code", class: "input" }) as HTMLInputElement;
    const err = h("p", { class: "error" });
    const close = () => dlg.remove();
    const dlg = h(
      "div",
      { class: "sheet-backdrop" },
      h(
        "div",
        { class: "sheet", role: "dialog", "aria-label": "Confirm it's you" },
        h("h2", {}, "Confirm it's you"),
        h("p", { class: "muted" }, "This loosens access, so it needs your passkey or authenticator code."),
        h("button", {
          class: "btn primary",
          onclick: async () => {
            try {
              const o = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("POST", "/api/me/reauth/passkey/options", {});
              const response = await startAuthentication({ optionsJSON: o.options });
              await api("POST", "/api/me/reauth/passkey/verify", { challengeId: o.challengeId, response });
              close();
              resolve();
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        }, "Use passkey"),
        h("div", { class: "row" }, code, h("button", {
          class: "btn",
          onclick: async () => {
            try {
              await api("POST", "/api/me/reauth", { totp: code.value });
              close();
              resolve();
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        }, "Confirm")),
        err,
        h("button", { class: "btn ghost", onclick: () => (close(), reject(new Error("Cancelled"))) }, "Cancel"),
      ),
    );
    document.body.append(dlg);
    code.focus();
  });
}

// ---------- shell ----------
interface Me {
  userId: string;
  username: string;
  isOwner: boolean;
  twoFactor: boolean;
  totp: boolean;
  passkeys: number;
  recoveryCodesLeft: number;
}
let me: Me | null = null;

function shell(title: string, ...content: Child[]): HTMLElement {
  return h(
    "div",
    { class: "shell" },
    h("header", { class: "top" }, h("a", { href: "#/", class: "brand", "aria-label": "Home" }, "Crossbar"), h("span", { class: "title" }, title), me ? h("a", { href: "#/settings", class: "me" }, me.username) : null),
    h("main", { class: "content" }, ...content),
    me
      ? h(
          "nav",
          { class: "tabs", "aria-label": "Sections" },
          h("a", { href: "#/" }, "Inbox"),
          h("a", { href: "#/live" }, "Live"),
          h("a", { href: "#/sites" }, "Sites"),
          h("a", { href: "#/connect" }, "Agents"),
          h("a", { href: "#/activity" }, "Activity"),
        )
      : null,
  );
}

function render(node: HTMLElement) {
  app.replaceChildren(node);
  for (const a of app.querySelectorAll("nav.tabs a")) a.classList.toggle("on", (a as HTMLAnchorElement).hash === (location.hash || "#/"));
}

function errorBox(e: unknown) {
  return h("p", { class: "error" }, (e as Error).message);
}

// ---------- screens ----------
async function setupScreen() {
  const s = await api<{ open: boolean; reset: boolean }>("GET", "/api/setup");
  if (!s.open) return void (location.hash = "#/login");
  const code = h("input", { class: "input", placeholder: "Setup code from the logs", autocomplete: "off" }) as HTMLInputElement;
  const user = h("input", { class: "input", placeholder: "Username", autocomplete: "username", value: s.reset ? "" : "" }) as HTMLInputElement;
  const pw = h("input", { class: "input", type: "password", placeholder: "Password (10+ characters)", autocomplete: "new-password" }) as HTMLInputElement;
  const err = h("p", { class: "error" });
  render(
    shell(
      s.reset ? "Reset owner" : "Set up",
      h("p", {}, s.reset ? "Enter the reset code printed by reset-owner and a new password." : "Welcome. Enter the setup code printed in the app's logs, then create your account."),
      code,
      s.reset ? null : user,
      pw,
      h("button", {
        class: "btn primary",
        onclick: async () => {
          try {
            await api("POST", "/api/setup", { code: code.value.trim(), username: s.reset ? "owner" : user.value, password: pw.value });
            location.hash = "#/";
            void boot();
          } catch (e) {
            err.textContent = (e as Error).message;
          }
        },
      }, s.reset ? "Reset" : "Create account"),
      err,
    ),
  );
}

async function loginScreen() {
  const user = h("input", { class: "input", placeholder: "Username", autocomplete: "username" }) as HTMLInputElement;
  const pw = h("input", { class: "input", type: "password", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
  const totp = h("input", { class: "input", inputmode: "numeric", placeholder: "Authenticator code", autocomplete: "one-time-code", hidden: true }) as HTMLInputElement;
  const rec = h("input", { class: "input", placeholder: "Or a recovery code", hidden: true }) as HTMLInputElement;
  const err = h("p", { class: "error" });
  const login = async () => {
    try {
      await api("POST", "/api/login", { username: user.value, password: pw.value, totp: totp.value || undefined, recoveryCode: rec.value || undefined });
      location.hash = "#/";
      void boot();
    } catch (e) {
      const m = (e as Error).message;
      if (m === "second_factor_required" || m === "passkey_required") {
        totp.hidden = m !== "second_factor_required";
        rec.hidden = false;
        err.textContent = m === "passkey_required" ? "Use your passkey, or a recovery code." : "Enter the code from your authenticator.";
        (m === "second_factor_required" ? totp : rec).focus();
      } else err.textContent = m;
    }
  };
  render(
    shell(
      "Log in",
      h("form", { onsubmit: (e: Event) => (e.preventDefault(), void login()) }, user, pw, totp, rec, h("button", { class: "btn primary", type: "submit" }, "Log in")),
      h("button", {
        class: "btn",
        onclick: async () => {
          try {
            const o = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("POST", "/api/passkey/login/options", {});
            const response = await startAuthentication({ optionsJSON: o.options });
            await api("POST", "/api/passkey/login/verify", { challengeId: o.challengeId, response });
            location.hash = "#/";
            void boot();
          } catch (e) {
            err.textContent = (e as Error).message;
          }
        },
      }, "Log in with a passkey"),
      err,
    ),
  );
  user.focus();
}

function ticketCard(t: TicketView) {
  const icon = t.kind === "challenge" ? "⚑" : t.kind === "proposal" ? "⇡" : "✋";
  return h("a", { href: `#/tickets/${t.id}`, class: `card ticket ${t.kind}` }, h("span", { class: "icon", "aria-hidden": "true" }, icon), h("div", {}, h("strong", {}, headline(t)), h("div", { class: "muted small" }, `${String(t.facts.domain ?? t.facts.pattern ?? "")} · ${timeLeft(t.expiresAt)}`)));
}

async function homeScreen() {
  const [tickets, notif] = await Promise.all([api<TicketView[]>("GET", "/api/tickets"), api<{ ntfyUrl: string | null; panic: unknown }>("GET", "/api/settings/notifications")]);
  render(
    shell(
      "Inbox",
      notif.panic
        ? h("div", { class: "banner danger" }, h("strong", {}, "Panic is on."), " Every token is suspended. ", h("button", { class: "btn small", onclick: async () => (await withFreshFactor(() => api("POST", "/api/resume")), void homeScreen()) }, "Resume"))
        : null,
      !notif.ntfyUrl ? h("div", { class: "banner" }, "Notifications are off. ", h("a", { href: "#/settings" }, "Set up ntfy"), " so you hear about approvals.") : null,
      tickets.length === 0 ? h("div", { class: "empty" }, h("p", {}, "Nothing needs you."), h("p", { class: "muted" }, "Approvals, logins and captchas show up here.")) : tickets.map(ticketCard),
      h("div", { class: "spacer" }),
      h("button", {
        class: "btn danger",
        onclick: async () => {
          if (!confirm("Panic: suspend every token, drop signed-in and act access, and close all sessions?")) return;
          await api("POST", "/api/panic");
          void homeScreen();
        },
      }, "Panic"),
    ),
  );
  const timer = setInterval(() => void api<TicketView[]>("GET", "/api/tickets").then((n) => {
    if (n.length !== tickets.length) {
      clearInterval(timer);
      void homeScreen();
    }
  }).catch(() => {}), 4000);
  cleanup.push(() => clearInterval(timer));
}

function factsTable(t: TicketView) {
  const f = t.facts as {
    method?: string;
    origin?: string;
    path?: string;
    operation?: string | null;
    actionClass?: string;
    tainted?: boolean;
    taintSource?: string | null;
    profile?: string;
    trigger?: { kind: "agent"; tool: string; ref: string; label: string } | { kind: "page" };
    fields?: Array<{ where: string; key: string; preview: string; length: number; typedByAgent: boolean; overlapsSignedInText: number; opaque?: boolean }>;
  };
  const agent = t.agent ?? "The agent";
  // Why this is here, in one sentence: did the agent just do something, or did the page send it by itself?
  const why =
    f.trigger?.kind === "agent"
      ? h("p", { class: "why" }, f.trigger.tool === "click" ? `Right after ${agent} clicked “${f.trigger.label}”.` : `Right after ${agent} typed “${f.trigger.label}” and pressed Enter.`)
      : f.trigger?.kind === "page"
        ? h("div", { class: "banner" }, h("strong", {}, "The page sent this by itself. "), `${agent} didn't click or type just before. Pages send analytics like this all the time; if you don't recognise it, deny.`)
        : null;
  const rows: Array<[string, Child]> = [];
  if (f.method) rows.push(["method", f.method]);
  if (f.origin) rows.push(["origin", f.origin]);
  if (f.path) rows.push(["path", f.path]);
  if (f.operation) rows.push(["operation", f.operation]);
  // The kind is a guess from the URL and body keys, so say so.
  if (f.actionClass) rows.push(["looks like", `${f.actionClass.replace(/_/g, " ")} (guessed from the address)`]);
  if (f.profile) rows.push(["profile", f.profile === "personal" ? "signed in as you" : "anonymous"]);
  const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} characters`);
  const typedFields = (f.fields ?? []).filter((x) => x.typedByAgent);
  return h(
    "div",
    {},
    why,
    h("dl", { class: "facts" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    f.tainted ? h("p", { class: "warn small" }, `This session read pages while signed in${f.taintSource ? ` (first: ${originOf(f.taintSource)})` : ""}.`) : null,
    f.fields?.length
      ? h(
          "div",
          { class: "fields" },
          h("h3", {}, "Data it would send"),
          f.fields.length && !typedFields.length ? h("p", { class: "small muted" }, `None of it is text ${agent} typed.`) : null,
          f.fields.map((x) =>
            x.opaque && x.overlapsSignedInText < 24
              ? h(
                  "details",
                  { class: "field" },
                  h("summary", { class: "small muted" }, `${x.where} · ${x.key}: ${kb(x.length)} of structured data, not readable text`),
                  h("code", {}, x.preview),
                )
              : h(
                  "div",
                  { class: `field${x.typedByAgent ? " typed" : ""}${x.overlapsSignedInText >= 24 ? " leak" : ""}` },
                  h("div", { class: "small muted" }, `${x.where} · ${x.key} · ${kb(x.length)}`, x.typedByAgent ? ` · typed by ${agent}` : "", x.overlapsSignedInText >= 24 ? ` · matches ${x.overlapsSignedInText} characters you read while signed in` : ""),
                  h("code", {}, x.preview),
                ),
          ),
        )
      : null,
  );
}

async function ticketScreen(id: string) {
  let t: TicketView;
  try {
    t = await api<TicketView>("GET", `/api/tickets/${id}`);
  } catch (e) {
    return render(shell("Request", errorBox(e), h("a", { href: "#/", class: "btn" }, "Back")));
  }
  const err = h("p", { class: "error" });
  const final = !["open", "claimed"].includes(t.state);
  const buttons: HTMLButtonElement[] = [];
  const act = (label: string, cls: string, fn: () => Promise<unknown>) => {
    const b = h("button", { class: `btn ${cls}`, disabled: true, onclick: async () => {
      try {
        await withFreshFactor(fn);
        void ticketScreen(id);
      } catch (e) {
        err.textContent = (e as Error).message;
      }
    } }, label) as HTMLButtonElement;
    buttons.push(b);
    return b;
  };
  const decision =
    final
      ? h("p", { class: "state" }, `This request is ${t.state}.`)
      : t.kind === "challenge"
        ? h(
            "div",
            { class: "btns" },
            h("a", { class: "btn primary", href: `#/takeover/${t.id}` }, "Take control"),
            act("Not a wall — let the agent continue", "", () => api("POST", `/api/tickets/${id}/not-a-wall`)),
            act("Deny", "danger", () => api("POST", `/api/tickets/${id}/deny`)),
          )
        : h(
            "div",
            { class: "btns" },
            t.scopes.map((s, i) => act(SCOPE_LABEL[s]?.(t) ?? s, i === 0 ? "primary" : "", () => api("POST", `/api/tickets/${id}/approve`, { scope: s === "apply" ? "once" : s }))),
            act("Deny", "danger", () => api("POST", `/api/tickets/${id}/deny`)),
          );
  const f = t.facts as { origin?: string; url?: string; from?: Record<string, unknown>; to?: Record<string, unknown>; kind?: string; evidence?: string[]; passwordFieldOrigins?: string[] };
  const foreignPw = t.kind === "challenge" ? (f.passwordFieldOrigins ?? []).filter((o) => o !== f.origin) : [];
  render(
    shell(
      t.kind === "challenge" ? "Needs you" : t.kind === "proposal" ? "Proposal" : "Approval",
      h("div", { class: "origin" }, h("span", { class: "dot", "aria-hidden": "true" }), originOf(f.origin ?? f.url ?? String(t.facts.pattern ?? ""))),
      h("h2", {}, headline(t)),
      h("p", { class: "muted small" }, final ? t.state : timeLeft(t.expiresAt)),
      t.hasScreenshot ? h("img", { class: "crop", src: `/api/tickets/${id}/screenshot`, alt: "What the page looked like when the request was held" }) : null,
      t.kind === "proposal"
        ? h("dl", { class: "facts" }, Object.keys(f.to ?? {}).filter((k) => k !== "pattern" && (f.to as Record<string, unknown>)[k] !== undefined).map((k) => [h("dt", {}, k), h("dd", {}, `${String(f.from?.[k] ?? "–")} → `, h("strong", {}, String((f.to as Record<string, unknown>)[k])))]))
        : t.kind === "challenge"
          ? h("div", {}, foreignPw.length ? h("p", { class: "banner danger" }, `The password field on this page belongs to ${foreignPw.join(", ")}, not ${f.origin}. Make sure that's who you mean to log in to.`) : null, h("p", {}, f.kind === "verification" ? "Your bank wants to confirm this payment. Do it on your phone; the agent is paused while you're in control." : f.kind === "login" ? "Log in on your phone. Your password manager can fill the field; the agent sees nothing while you're in control." : "Solve it on your phone. The agent is paused while you're in control."), h("details", {}, h("summary", { class: "small muted" }, "Evidence"), h("ul", { class: "small" }, (f.evidence ?? []).map((e) => h("li", {}, e)))))
          : factsTable(t),
      t.agentSays ? h("blockquote", { class: "claim" }, h("span", { class: "small muted" }, "Agent says (unverified): "), `“${t.agentSays.text}”`) : null,
      decision,
      err,
    ),
  );
  // Buttons are disabled for 1 s after they appear (no accidental taps).
  const timer = setTimeout(() => buttons.forEach((b) => (b.disabled = false)), 1000);
  cleanup.push(() => clearTimeout(timer));
}

/** Streams a tab's frames into an <img>; returns a stop function. */
function stream(tab: string, img: HTMLImageElement, onUrl: (u: string) => void, onMeta: (m: { w: number; h: number }) => void): () => void {
  const es = new EventSource(`/api/live/${encodeURIComponent(tab)}/stream`);
  es.onmessage = (e) => {
    const f = JSON.parse(e.data) as { f: string; w: number; h: number };
    img.src = `data:image/jpeg;base64,${f.f}`;
    onMeta(f);
  };
  es.addEventListener("url", (e) => onUrl(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

async function takeoverScreen(id: string) {
  const err = h("p", { class: "error" });
  let claim: TicketView & { tab: string; origin: string; takeoverTab?: string | null };
  try {
    claim = await api("POST", `/api/tickets/${id}/claim`);
  } catch (e) {
    return render(shell("Take control", errorBox(e), h("a", { class: "btn", href: `#/tickets/${id}` }, "Back")));
  }
  const img = h("img", { class: "screen", alt: "Live view of the page you're controlling" }) as HTMLImageElement;
  const bar = h("div", { class: "origin" }, h("span", { class: "dot" }), claim.origin);
  const warn = h("p", { class: "warn small", hidden: true });
  let css = { w: 390, h: 844 };
  const send = (ev: Record<string, unknown>) => api("POST", `/api/tickets/${id}/input`, ev).catch((e) => (err.textContent = (e as Error).message));
  img.addEventListener("click", async (e) => {
    const r = img.getBoundingClientRect();
    const p = toPage({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, { width: css.w, height: css.h });
    await send({ type: "mousePressed", x: p.x, y: p.y, button: "left" });
    await send({ type: "mouseReleased", x: p.x, y: p.y, button: "left" });
  });
  // A native text field, so your password manager can fill it; text is forwarded as keystrokes.
  const field = h("input", { class: "input", placeholder: "Type here, then Send", autocomplete: "current-password", autocapitalize: "off", autocorrect: "off", spellcheck: "false" }) as HTMLInputElement;
  const onUrl = (u: string) => {
    // The real origin is drawn outside the stream, so the page can't fake it.
    bar.lastChild!.textContent = originOf(u);
    const differs = originOf(u) !== claim.origin;
    warn.hidden = !differs;
    warn.textContent = differs ? `You're now on ${originOf(u)}, not ${claim.origin}. Check before typing a password.` : "";
  };
  let current = claim.tab;
  let stopStream = stream(current, img, onUrl, (m) => (css = { w: m.w, h: m.h }));
  const stop = () => stopStream();
  // A sign-in window the page opens becomes what you're driving; follow it, and come back when it closes.
  const follow = setInterval(async () => {
    const t = await api<TicketView & { takeoverTab: string | null }>("GET", `/api/tickets/${id}`).catch(() => null);
    if (t?.takeoverTab && t.takeoverTab !== current) {
      current = t.takeoverTab;
      stopStream();
      stopStream = stream(current, img, onUrl, (m) => (css = { w: m.w, h: m.h }));
    }
  }, 1000);
  cleanup.push(() => clearInterval(follow));
  cleanup.push(stop);
  render(
    shell(
      "Take control",
      bar,
      warn,
      h("div", { class: "screen-wrap" }, img),
      h("div", { class: "row" }, field, h("button", { class: "btn", onclick: async () => (await send({ type: "insertText", text: field.value }), (field.value = "")) }, "Send")),
      h(
        "div",
        { class: "row keys" },
        ...[["Enter", "Enter", "\r"], ["⌫", "Backspace", ""], ["Tab", "Tab", ""]].map(([label, key, text]) => h("button", { class: "btn small", onclick: async () => (await send({ type: "keyDown", key, code: key, text }), await send({ type: "keyUp", key, code: key })) }, label!)),
        h("button", { class: "btn small", onclick: () => send({ type: "mouseWheel", x: css.w / 2, y: css.h / 2, deltaY: -400 }) }, "↑"),
        h("button", { class: "btn small", onclick: () => send({ type: "mouseWheel", x: css.w / 2, y: css.h / 2, deltaY: 400 }) }, "↓"),
      ),
      h("button", {
        class: "btn ghost small",
        onclick: async () => {
          await api("POST", `/api/tickets/${id}/not-a-wall`).catch((e) => (err.textContent = (e as Error).message));
          location.hash = "#/";
        },
      }, "This isn't a captcha or login — let the agent continue"),
      h("button", {
        class: "btn primary",
        onclick: async () => {
          try {
            const r = await api<{ verified: boolean; still?: string }>("POST", `/api/tickets/${id}/done`);
            if (r.verified) location.hash = "#/";
            else {
              // The verifier reopened the ticket: offer to pick it up again.
              for (const c of cleanup) c();
              cleanup = [];
              err.replaceChildren(
                `It still looks like a ${r.still} page. `,
                h("button", { class: "btn small", onclick: () => void takeoverScreen(id) }, "Take control again"),
                " ",
                h("button", {
                  class: "btn small",
                  onclick: async () => {
                    await api("POST", `/api/tickets/${id}/not-a-wall`);
                    location.hash = "#/";
                  },
                }, "It's not a wall — continue"),
              );
            }
          } catch (e) {
            err.textContent = (e as Error).message;
          }
        },
      }, "I'm done"),
      err,
    ),
  );
}

async function liveScreen() {
  const tabs = await api<Array<{ tab: string; agent: string; profile: string; tainted: boolean; takeover: boolean }>>("GET", "/api/live");
  render(
    shell(
      "Live",
      tabs.length === 0 ? h("div", { class: "empty" }, h("p", {}, "No agent has a page open.")) : tabs.map((t) => h("a", { class: "card", href: `#/live/${t.tab}` }, h("strong", {}, t.agent), h("div", { class: "muted small" }, `${t.profile === "personal" ? "signed in as you" : "anonymous"}${t.tainted ? " · read while signed in" : ""}`))),
    ),
  );
}

function liveTabScreen(tab: string) {
  const img = h("img", { class: "screen", alt: "Live view" }) as HTMLImageElement;
  const bar = h("div", { class: "origin" }, h("span", { class: "dot" }), "…");
  cleanup.push(stream(tab, img, (u) => (bar.lastChild!.textContent = originOf(u)), () => {}));
  render(shell("Live", bar, h("div", { class: "screen-wrap" }, img), h("p", { class: "muted small" }, "View only. Take control from a ticket when the agent asks.")));
}

async function connectScreen() {
  const tokens = await api<Array<{ id: string; agentName: string; kind: string; createdAt: string; lastUsed: string | null; revokedAt: string | null; revokedReason: string | null }>>("GET", "/api/tokens");
  const name = h("input", { class: "input", placeholder: "Agent name, e.g. claude-desktop", maxlength: "64" }) as HTMLInputElement;
  const kindRead = h("input", { type: "radio", name: "kind", value: "read", checked: true }) as HTMLInputElement;
  const kindAct = h("input", { type: "radio", name: "kind", value: "act" }) as HTMLInputElement;
  const out = h("div", {});
  const err = h("p", { class: "error" });
  const copyBox = (label: string, text: string) => h("div", { class: "copy" }, h("div", { class: "small muted" }, label), h("pre", {}, text), h("button", { class: "btn small", onclick: () => navigator.clipboard.writeText(text) }, "Copy"));
  render(
    shell(
      "Connect an agent",
      h("p", {}, "Each agent gets its own token. Its name is written on every activity row."),
      name,
      h("fieldset", { class: "choice" }, h("legend", {}, "Access"), h("label", {}, kindRead, h("strong", {}, " Read"), h("span", { class: "muted small" }, " — open, read, click, search. Can only tighten settings.")), h("label", {}, kindAct, h("strong", {}, " Act"), h("span", { class: "muted small" }, " — also posts on sites you allow, and can propose setting changes for you to approve."))),
      h("button", {
        class: "btn primary",
        onclick: async () => {
          try {
            const r = await api<{ secret: string; mcpUrl: string; claudeCode: string; claudeDesktop: unknown }>("POST", "/api/tokens", { agentName: name.value.trim(), kind: kindAct.checked ? "act" : "read" });
            out.replaceChildren(
              h("div", { class: "banner" }, "This token is shown once. Copy it now."),
              copyBox("Claude Code", r.claudeCode),
              copyBox("Claude Desktop / other MCP clients (JSON)", JSON.stringify(r.claudeDesktop, null, 2)),
              copyBox("Token", r.secret),
            );
          } catch (e) {
            err.textContent = (e as Error).message;
          }
        },
      }, "Create token"),
      err,
      out,
      h("h3", {}, "Tokens"),
      tokens.map((t) =>
        h(
          "div",
          { class: "card row between" },
          h("div", {}, h("strong", {}, t.agentName), h("div", { class: "muted small" }, `${t.kind} · ${t.revokedAt ? `revoked (${t.revokedReason})` : t.lastUsed ? `last used ${new Date(t.lastUsed).toLocaleString()}` : "never used"}`)),
          t.revokedAt ? null : h("button", { class: "btn small danger", onclick: async () => (await api("DELETE", `/api/tokens/${t.id}`), void connectScreen()) }, "Revoke"),
        ),
      ),
    ),
  );
}

async function sitesScreen() {
  const sites = await api<Array<{ pattern: string; level: string; adblock: boolean; device: string; source: string }>>("GET", "/api/sites");
  const pattern = h("input", { class: "input", placeholder: "reddit.com or mail.example.com" }) as HTMLInputElement;
  const level = h("select", { class: "input" }, ["blocked", "read", "read_as_you", "act_as_you"].map((l) => h("option", { value: l }, levelLabel(l)))) as HTMLSelectElement;
  level.value = "read";
  const err = h("p", { class: "error" });
  const save = async (body: Record<string, unknown>) => {
    try {
      await withFreshFactor(() => api("PUT", "/api/sites", body));
      void sitesScreen();
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
  render(
    shell(
      "Sites",
      h("p", { class: "callout small" }, h("strong", {}, "Anything the agent reads while signed in, it can repeat elsewhere."), " Keep “Can read as you” to the few sites you need."),
      h("div", { class: "row" }, pattern, level, h("button", { class: "btn", onclick: () => save({ pattern: pattern.value, level: level.value }) }, "Set")),
      err,
      sites.length === 0 ? h("p", { class: "muted" }, "Every public site is “Can read” (anonymous) by default. Mail, banking, password managers, cloud consoles and your LAN are blocked.") : null,
      sites.map((s) => {
        const sel = h("select", { class: "input small", onchange: (e: Event) => save({ pattern: s.pattern, level: (e.target as HTMLSelectElement).value }) }, ["blocked", "read", "read_as_you", "act_as_you"].map((l) => h("option", { value: l, selected: l === s.level }, levelLabel(l))));
        return h(
          "div",
          { class: "card" },
          h("div", { class: "row between" }, h("strong", {}, s.pattern), sel),
          h(
            "div",
            { class: "row small" },
            h("label", {}, h("input", { type: "checkbox", checked: s.adblock, onchange: (e: Event) => save({ pattern: s.pattern, adblock: (e.target as HTMLInputElement).checked }) }), " Block ads"),
            h("label", {}, h("input", { type: "checkbox", checked: s.device === "mobile", onchange: (e: Event) => save({ pattern: s.pattern, device: (e.target as HTMLInputElement).checked ? "mobile" : "desktop" }) }), " Mobile layout"),
            h("span", { class: "muted" }, `from ${s.source}`),
          ),
        );
      }),
    ),
  );
}

async function activityScreen() {
  const rows = await api<Array<{ ts: string; agent: string; method: string; host: string; path: string; outcome: string; rule: string | null; tainted: boolean; flagged: boolean; shapes: Array<{ key: string; type: string; length: number; entropy: string }> }>>("GET", "/api/activity?limit=200");
  render(
    shell(
      "Activity",
      rows.length === 0 ? h("p", { class: "muted" }, "Nothing yet.") : null,
      rows.map((r) =>
        h(
          "div",
          { class: `card act ${r.flagged ? "flagged" : ""}` },
          h("div", { class: "row between small" }, h("span", {}, `${r.agent ?? "?"} · ${new Date(r.ts).toLocaleTimeString()}`), h("span", { class: `pill ${r.outcome}` }, r.outcome.replace("_", " "))),
          h("div", { class: "mono small" }, `${r.method} ${r.host}${r.path}`),
          r.shapes.length ? h("div", { class: "muted small" }, r.shapes.slice(0, 6).map((s) => `${s.key}:${s.type}(${s.length},${s.entropy})`).join("  ")) : null,
          r.rule ? h("div", { class: "muted small" }, `rule: ${r.rule}${r.tainted ? " · tainted" : ""}`) : null,
        ),
      ),
    ),
  );
}

async function settingsScreen() {
  me = await api<Me>("GET", "/api/me");
  const n = await api<{ ntfyUrl: string | null }>("GET", "/api/settings/notifications");
  const cats = await api<Array<{ id: string; label: string; help: string; enabled: boolean; examples: string[] }>>("GET", "/api/settings/categories");
  const ntfy = h("input", { class: "input", placeholder: "https://ntfy.sh/your-secret-topic", value: n.ntfyUrl ?? "" }) as HTMLInputElement;
  const msg = h("p", { class: "small" });
  const out = h("div", {});
  const err = h("p", { class: "error" });
  const showCodes = (codes: string[] | null) => codes && out.replaceChildren(h("div", { class: "banner" }, "Recovery codes. Each works once. Save them somewhere safe."), h("pre", {}, codes.join("\n")));
  const users = me.isOwner ? await api<Array<{ username: string; isOwner: number }>>("GET", "/api/users") : [];
  const newUser = h("input", { class: "input", placeholder: "Username" }) as HTMLInputElement;
  const newPw = h("input", { class: "input", type: "password", placeholder: "Temporary password", autocomplete: "new-password" }) as HTMLInputElement;
  render(
    shell(
      "Settings",
      h("h3", {}, "Notifications"),
      h("p", { class: "muted small" }, "Crossbar sends approvals to an ntfy topic. Install the ntfy app and subscribe to the same topic."),
      ntfy,
      h("div", { class: "row" }, h("button", { class: "btn", onclick: async () => {
        try {
          await withFreshFactor(() => api("PUT", "/api/settings/notifications", { ntfyUrl: ntfy.value.trim() || null }));
          msg.textContent = "Saved.";
        } catch (e) {
          err.textContent = (e as Error).message;
        }
      } }, "Save"), h("button", { class: "btn", onclick: async () => {
        const r = await api<{ sent: boolean }>("POST", "/api/settings/notifications/test");
        msg.textContent = r.sent ? "Test sent." : "Couldn't send. Check the URL.";
      } }, "Send test")),
      msg,
      h("h3", {}, "What agents may use"),
      h("p", { class: "muted small" }, "Sensitive kinds of sites are off for agents until you turn them on. With one on, its sites follow the normal rules: reading is anonymous, you do any login yourself through a ticket, and payments or deletions still ask every time."),
      h("div", { class: "cats" }, cats.map((cat) => h("label", { class: "card row between" },
        h("div", {}, h("strong", {}, cat.label), h("div", { class: "muted small" }, cat.help), h("div", { class: "muted small" }, `e.g. ${cat.examples.join(", ")}`)),
        h("input", { type: "checkbox", checked: cat.enabled, onchange: async (e: Event) => {
          const box = e.target as HTMLInputElement;
          try {
            await withFreshFactor(() => api("PUT", "/api/settings/categories", { category: cat.id, enabled: box.checked }));
          } catch (err) {
            box.checked = !box.checked;
            msg.textContent = (err as Error).message;
          }
        } }),
      ))),
      h("h3", {}, "Two-factor"),
      h("p", { class: "muted small" }, `${me.passkeys} passkey(s) · TOTP ${me.totp ? "on" : "off"} · ${me.recoveryCodesLeft} recovery codes left. With two-factor on, approvals that loosen access ask for a fresh check.`),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: async () => {
          try {
            const o = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("POST", "/api/me/passkey/options", {});
            const response = await startRegistration({ optionsJSON: o.options });
            const r = await withFreshFactor(() => api<{ recoveryCodes: string[] | null }>("POST", "/api/me/passkey/verify", { challengeId: o.challengeId, response }));
            showCodes(r.recoveryCodes);
            void boot(false);
          } catch (e) {
            err.textContent = (e as Error).message;
          }
        } }, "Add a passkey"),
        me.totp ? null : h("button", { class: "btn", onclick: async () => {
          const b = await api<{ secret: string; otpauth: string }>("POST", "/api/me/totp/begin", {});
          const code = h("input", { class: "input", inputmode: "numeric", placeholder: "Code from the app", autocomplete: "one-time-code" }) as HTMLInputElement;
          out.replaceChildren(
            h("p", {}, "Add this to your authenticator app: ", h("a", { href: b.otpauth }, "open in app"), " or enter the key:"),
            h("pre", {}, b.secret.replace(/(.{4})/g, "$1 ").trim()),
            code,
            h("button", { class: "btn primary", onclick: async () => {
              try {
                const r = await withFreshFactor(() => api<{ recoveryCodes: string[] }>("POST", "/api/me/totp/enable", { secret: b.secret, code: code.value }));
                showCodes(r.recoveryCodes);
              } catch (e) {
                err.textContent = (e as Error).message;
              }
            } }, "Turn on"),
          );
        } }, "Set up an authenticator app"),
      ),
      out,
      me.isOwner
        ? h("div", {}, h("h3", {}, "Household"), users.map((u) => h("div", { class: "small" }, `${u.username}${u.isOwner ? " (owner)" : ""}`)), h("div", { class: "row" }, newUser, newPw, h("button", { class: "btn", onclick: async () => {
            try {
              await api("POST", "/api/users", { username: newUser.value, password: newPw.value });
              void settingsScreen();
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          } }, "Invite")))
        : null,
      err,
      h("div", { class: "spacer" }),
      h("button", { class: "btn ghost", onclick: async () => (await api("POST", "/api/logout", {}), (me = null), (location.hash = "#/login")) }, "Log out"),
    ),
  );
}

// ---------- router ----------
async function route() {
  // Leaving a screen: stop its streams and timers.
  for (const c of cleanup) c();
  cleanup = [];
  const r: Route = parseRoute(location.hash);
  try {
    if (!me && r.name !== "setup" && r.name !== "login") {
      const s = await api<{ open: boolean }>("GET", "/api/setup");
      if (s.open && !(await tryMe())) return void (location.hash = "#/setup");
      if (!(await tryMe())) return void (location.hash = "#/login");
    }
    switch (r.name) {
      case "setup":
        return await setupScreen();
      case "login":
        return await loginScreen();
      case "home":
      case "tickets":
        return await homeScreen();
      case "ticket":
        return await ticketScreen(r.id);
      case "takeover":
        return await takeoverScreen(r.id);
      case "connect":
        return await connectScreen();
      case "sites":
        return await sitesScreen();
      case "live":
        return await liveScreen();
      case "liveTab":
        return liveTabScreen(r.tab);
      case "activity":
        return await activityScreen();
      case "settings":
        return await settingsScreen();
    }
  } catch (e) {
    // The session ended (logged out elsewhere, expired): back to login.
    if (e instanceof ApiError && e.status === 401 && e.message === "Log in to the web app.") {
      me = null;
      location.hash = "#/login";
      return;
    }
    render(shell("Error", errorBox(e)));
  }
}

async function tryMe(): Promise<boolean> {
  try {
    me = await api<Me>("GET", "/api/me");
    return true;
  } catch {
    me = null;
    return false;
  }
}

async function boot(navigate = true) {
  await tryMe();
  if (navigate) await route();
}

window.addEventListener("hashchange", () => void route());
void boot();
