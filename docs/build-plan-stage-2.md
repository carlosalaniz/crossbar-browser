# Build plan, stage 2

**Date:** 11 November 2026. **Executed by:** an agent working mostly alone, one PR per step, in the working mode in [START.md](../START.md) (CI passes, written self-review, merge; the owner reviews `auth/`, `browser/` and `proxy/` afterwards, and PR bodies flag security-core changes).

This stage does everything in [the automation-signal plan](automation-signal-plan.md) (PRs A–H there) plus five owner requests:

1. A better UI, designed for both phone and desktop.
2. Simpler accounts: a default `admin` / `admin` owner account on first start, no setup code from the logs, no open sign-up.
3. The dev stack reachable on the local network, with notification links that open on the owner's phone.
4. Approval notifications that are clearer and less frequent.
5. A take-control page that feels like using a browser window: phone first, good on desktop.

## Goal, and what overrides it

The product goal: the user can act through Crossbar without sites flagging it, and without being nagged. Every bot-detection trigger and every unnecessary notification is a bug.

These still override convenience, in every step: the network gate fails closed, taint, consequence approvals, the proxy's post-resolution IP checks, human-only routes, no agent-supplied page code, server-controlled notification text (AGENTS.md rule 12).

## How the agent works through this

- **Order** is the table below. Each step is one PR unless noted, merged before the next starts.
- **Every PR:** `npm run check` passes; new behaviour comes with tests; the PR body has a self-review section and lists security-core files touched.
- **Phone checks:** from step 2 on, every UI or notification change is also checked on the LAN stack from a phone-sized viewport (Playwright-free: the existing browser-driven UI flow test, run at 390×844 and 1280×800), and the PR body says so.
- **START.md:** the Status section is updated at the end of each working session.
- **Stop and ask the owner** (open an issue or leave a note in START.md, and continue with the next independent step) when:
  - a change loosens a security boundary beyond what an accepted ADR allows;
  - a measurement contradicts an assumption in this plan (for example the Xvfb window-visibility check);
  - a step needs a credential, an account, or a live third-party site.

## Steps

| # | Step | Source | Security core |
|---|---|---|---|
| 1 | Decisions and docs | Signal plan A, plus ADRs here | docs only |
| 2 | LAN dev stack and LAN notification links | Request 3 | no |
| 3 | Simple accounts | Request 2 | **auth/** |
| 4 | Diagnostic page | Signal plan B | no |
| 5 | Explicit markers (S01–S04) | Signal plan C | **browser/** |
| 6 | UI foundation: design system and responsive shell | Request 1 | no |
| 7 | Take-control window, with faithful human input | Request 5 + signal plan D | **browser/**, routes |
| 8 | Fewer, clearer approvals and notifications | Request 4 | server, routes |
| 9 | Agent input and budgets (S05–S09) | Signal plan E | **browser/** |
| 10 | Browser memory: lazy start, idle stop | Request 2 (RAM) | **browser/** |
| 11 | Site compatibility (S19–S22) | Signal plan F | **browser/**, server |
| 12 | Environment consistency (S14, S27, S31–S35) | Signal plan G | deploy, **browser/** |
| 13 | Boundary-caused triggers (S23–S30, S36), ADR first | Signal plan H | **browser/**, **proxy/** |

Steps 2 and 3 come early because every later UI and notification step is tested from the owner's phone.

---

### Step 1: decisions and docs

Everything in signal plan A (ADRs 0015 device identity, 0016 human input transport, 0017 concurrency; README and threat model for credential fields), plus:

- **ADR 0018, simple accounts.** Supersedes the setup-code part of ADR 0008. Crossbar runs behind the owner's own access control (Harbor or a reverse proxy). On first start the server creates the owner account `admin` with password `admin`. There is no public sign-up; the owner adds household members, each with their own isolated browser profiles. The default password must be changed before the app is exposed beyond a trusted network; the app warns until it is (step 3). Sign-in is username and password only, for people; agents use MCP tokens. Passkeys and TOTP are hidden in the UI for now (passkeys can't work over plain-HTTP LAN anyway). Their server code stays but is unreachable from the UI, so it can come back without a rewrite; with no second factor enrolled, approvals need no extra check (owner: "make it easy"). `reset-owner` stays as the recovery path, and resets to a password the operator types.
- **ADR 0019, approval notifications.** The rules in step 8: what notifies, what doesn't, merging, and why "Approve" never goes in the notification itself.

### Step 2: LAN dev stack and LAN notification links

Today the app listens on all interfaces, but `CROSSBAR_ORIGIN` defaults to `http://localhost:<port>`. The same origin is used for CSRF checks, passkey verification and notification links, so a phone on the LAN gets links to `localhost` and its requests fail the origin check.

- `dev:local` and `dev` detect the machine's LAN IPv4 address (first non-internal interface; `CROSSBAR_LAN_HOST` overrides) and set `CROSSBAR_ORIGIN=http://<lan-ip>:<port>`. They print both URLs and a QR code of the LAN URL in the terminal.
- `CROSSBAR_ORIGIN` accepts a comma-separated list. The first entry is the public origin used in links; CSRF accepts any listed origin. `http://localhost:<port>` is always added in dev.
- Notification links (`Click`, actions) use the public origin, i.e. the LAN address in dev.
- Session cookies stay non-`Secure` over plain HTTP in dev only; production behind HTTPS keeps `Secure`.
- The test site stays on the internal network or loopback; only the app port is on the LAN.
- **Tests:** CSRF accepts listed origins and refuses others; notification links use the first origin; the dev script's LAN detection is unit-tested with fake interfaces.

### Step 3: simple accounts

- `GET /api/setup`, `POST /api/setup` and the setup-code screen go away. On first start (no users in the database) the server creates `admin` / `admin` as owner and logs one line saying so.
- While the owner's password is still the default:
  - a banner on every screen: "You're using the default password. Change it before this is reachable outside your network", linking to the change-password form;
  - a warning line in the logs on every start;
  - `/api/me` reports `defaultPassword: true` so the UI and the stack smoke script can see it.
  Nothing is blocked: the owner asked for no friction on a trusted network.
- The default `admin` password is the only password allowed under 10 characters. Changing it, and every other password, keeps the 10-character minimum.
- The owner creates household members from Settings with the existing invite route (owner sets the username and password). No public sign-up route.
- Remove the passkey and TOTP screens and buttons from the web app; their routes stay in the route table with tests. The UI flow test covers password-only login and the password re-check before a loosening approval.
- Each user gets their own anonymous and personal profile directories, as today. Isolation tests: user B's tab can't see user A's cookies; B's token can't read A's tickets or activity.
- Login throttling per client address stays, and covers `admin` like any other account.
- Route auth table and its coverage test updated; the setup-code tests are replaced, not deleted silently.
- `scripts/stack-smoke.ts`, `scripts/testsite-smoke.ts` and `scripts/agent-smoke.ts` stop taking a setup code and log in as `admin` (or `CROSSBAR_USER` / `CROSSBAR_PASSWORD`). START.md, the README and the Harbor package's install notes say to change the default password first.

### Step 4: diagnostic page

Signal plan B, unchanged. Also measures, for step 10, the resident memory of one idle browser and of one browser with a heavy page open.

### Step 5: explicit markers (S01–S04)

Signal plan C, unchanged.

### Step 6: UI foundation

The web app is one 773-line `web/src/main.ts` with a small `h()` helper and one stylesheet. Keep it framework-free (no new runtime dependency to review), but restructure:

- **Modules:** `web/src/ui/` (components), `web/src/screens/` (one file per screen), `web/src/api.ts`, `web/src/router.ts`. Vitest covers logic per module.
- **Design tokens** in CSS custom properties: colour, spacing, type scale, radius; light and dark themes from `prefers-color-scheme`.
- **Layout:** below 720 px, a bottom tab bar (Requests, Sites, Activity, Settings) and full-width cards; at 720 px and above, a left sidebar and a two-column layout for lists with detail. Touch targets at least 44 px. Safe-area insets for phones with notches.
- **Requests screen first:** pending approvals and challenges at the top with their actions inline; everything else (sites, tokens, settings) is secondary.
- **Connect flow:** the `claude mcp add …` snippet with a copy button and the token shown once, as today, reorganised as steps.
- **Installable:** a web app manifest and icons, so the phone can add it to the home screen.
- **Tests:** the existing browser-driven UI flow at both viewport sizes; an accessibility check (labels, contrast tokens) in Vitest.

### Step 7: take-control window

Signal plan D (stable device through takeover, the human-only input stream, touch, the foreground lease) plus the page itself. The page should feel like holding the actual browser window.

**Phone:**
- The live view fills the screen. A thin top bar shows the real origin with a lock or warning, drawn by Crossbar outside the stream (unchanged rule), plus Back and Reload.
- Tap, drag, long-press and swipe go straight to the page as touch (mobile sites) or as pointer events (desktop sites). Pinch zooms and pans the *viewer* when the remote page is desktop-sized; it doesn't send pinch to the page unless the site is in mobile mode.
- **Typing:** when the remote page focuses a text field, the phone keyboard opens automatically (the server reports the remote focus; the page focuses a hidden input). What you type is forwarded as you type. The hidden input carries the right `autocomplete` hint (`current-password`, `one-time-code`, `username`) so the phone's password manager and SMS code autofill work.
- A bottom sheet with **Done** (hand back), **Not a wall, let the agent continue**, and the extra keys (Tab, Enter, Esc) for sites that need them.
- When a sign-in window opens, the view switches to it with a short "Now on accounts.example.com" banner, and switches back when it closes.
- Connection status and lag are visible; on disconnect, input stops and pressed buttons are released.

**Desktop:**
- The remote page is shown at its real size in a window frame, centred. Mouse and keyboard go to it directly while it has focus (click inside to focus, Esc twice or click outside to release).
- Same top bar and actions.

**Stream:** 15 fps JPEG screencast as today, with quality raised while idle and lowered while moving; measured round-trip latency shown in the status.

**Tests:** device snapshots stable across claim, popup and hand-back (diag page); traces of tap, drag, typing with composition, password-manager fill and disconnect; agent tokens refused on the input stream; the remote-focus-opens-keyboard path in the UI flow test.

### Step 8: fewer, clearer approvals and notifications

**First, measure.** Run `agent-smoke` and the test-site scenarios, and count tickets and notifications by kind and trigger. Commit the counts in the PR body; the changes below must reduce them without any consequence going through unasked.

**Fewer:**
- **Page-triggered writes don't notify.** Writes not started by an agent click (`trigger.kind === "page"`, usually analytics) are held quietly and denied at the timeout, as the gate does today, and appear in Activity. If a page-triggered write is blocking the agent's task, the agent's tool result says so and the request shows in Requests, still without a push.
- **Notify only when an agent is waiting** on the answer. A ticket the agent has abandoned or that expires doesn't produce a second push.
- **One notification per task.** The merge window becomes per token and task, not a fixed 30 s per user: further asks while one notification is unanswered update it (ntfy supports replacing a message by ID) instead of sending another.
- **"For this task" is the default grant** for reversible classes, preselected on the approval page; "Always on this site" is one tap further. Irreversible classes keep "once" only (unchanged rule).
- **Identical repeats** (same token, site, class, request shape) while a ticket is pending join the existing ticket.
- **Quiet challenges:** a challenge notifies once; reminders only if the agent is still waiting after 5 minutes.

**Clearer:**
- Titles follow one pattern: *who wants to do what, where*. "Claude wants to post a comment on reddit.com". Challenges: "Log in to bank.example to continue" / "Solve a check on site.example".
- The body states what happens after each choice, from server-controlled fields only: "Approve: this comment is posted once. Deny: Claude is told no."
- Actions on the notification: **Review** (opens the approval page) and **Deny** (inline, as today). **Approve stays in the app**: an approve link in the notification would let anyone who can read the ntfy topic approve, and ntfy.sh is a third party. The approval page opens with one large Approve button and the default scope selected, so it's still one tap after opening.
- Priority by kind: consequences and challenges high; everything else default.
- **Tests:** notification text built only from server fields; merging per task; no push for page-triggered writes; repeated identical asks join one ticket; counts before and after recorded.

### Step 9: agent input and budgets

Signal plan E, unchanged.

### Step 10: browser memory

Today a browser starts on first use for each user and profile and stays running. Two profiles per user, so each user can cost two Chromium processes.

- **Lazy start** (already the case) and **idle stop:** a profile's browser shuts down after 15 minutes with no agent work, no viewer and no open ticket; the next use relaunches it with the same persistent profile.
- A cap on concurrently running browsers (default 4); the least recently used idle one stops first; a request that can't get a browser returns a clear "busy, retry" result.
- Memory per browser recorded by the diag measurement in step 4; no memory-saving flags that change the fingerprint (for example a renderer-process limit) without measuring them on the diag page.
- **Tests:** idle stop and relaunch keep cookies; a stop never happens during takeover or with a held request.

### Steps 11–13

Signal plan F, G and H, unchanged. Step 13 starts with ADRs. WebSockets stay blocked (ADR 0020, owner's decision).

## Done for this stage

- All steps merged with `npm run check` green.
- The diag page shows no Crossbar marker (S01–S04), a stable device across takeover, and an honest llvmpipe renderer.
- The owner can, from a phone on the LAN: log in as `admin`, change the password, connect an agent, receive one clear notification, approve in one tap after opening, and take control of a login comfortably.
- Notification counts on the smoke runs are lower than the step 8 baseline, with every consequence still asked.
