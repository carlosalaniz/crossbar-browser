# START.md: build kickoff

Read this, then `AGENTS.md`, at the start of a new build session. It records where the project stands and what to do first. Update the **Status** section at the end of each session.

## Status (11 Nov 2026, end of first build session)

- **Steps 0–6 are built.** Repo: https://github.com/carlosalaniz/crossbar-browser (public). One PR per step (#1 merged; #2–#5 stacked, merged as CI allows).
- **Working mode (owner's decision, 11 Nov 2026):** agents build autonomously in one PR per step. CI must pass and the agent posts a written self-review, then merges, security core included. The owner reviews `auth/`, `browser/` and `proxy/` after the fact; PR bodies flag security-core changes. Commits carry only the owner as author.
- `npm ci && npm run check` passes: typecheck, lint, SPDX, ~180 node tests (proxy, browser in a real Chrome for Testing, server with a fake browser and end to end, auth, detect, adapters, a UI flow driven in a browser), Vitest for `web/`, web build.
- `npm run dev` brings up app, browser (headful Chromium under Xvfb, sandboxed), proxy and a local test site at http://testsite.test:8090. `npm run dev:local` does the same without Docker.
- `node scripts/stack-smoke.ts <setup-code>` checks a running stack. `node scripts/agent-smoke.ts` lets a real model (OpenRouter key in `.env`, never committed) drive Crossbar over MCP: comment held → approved; private page asks; taint exit with 90 chars of overlap held → denied.
- Decisions added this session: ADR 0009 (in-house CDP client), ADR 0010 (WebSocket block via DNR, Chromium/CfT only). Both **Proposed** pending owner review.
- **Open:**
  - CODEOWNERS uses a placeholder team `@crossbarhq/owners`.
  - The CLA text isn't written.
  - The Harbor manifest is a draft (`deploy/harbor/crossbar.yaml`): Harbor's schema isn't in this repo.
  - Passkeys are tested only up to options/rejection (needs a virtual authenticator test).
  - The taint subresource gap (see the threat model).
  - The first commit on `main` carries a Claude co-author trailer; removing it needs a force-push the owner has to allow.
- **Next:**
  - proxy-side taint for subresources;
  - virtual-authenticator passkey test;
  - real Reddit fixtures via a manual refresh script;
  - accuracy and prompt-rate measurements against real sessions.
- Design sources:
  - Charter: https://claude.ai/artifact/WBcaHfYYPBjRNq2zX4qQfL (read with the Artifact tool, `action: read`)
  - Access Model: https://claude.ai/artifact/JrJrT21wE7F5TXJbHNEzq1

## Decisions settled on 11 Nov 2026 (become ADRs in step 0)

| ADR | Decision |
|---|---|
| 0001 challenge-resolver-seam | No auto-solving in v1. Human takeover is the only resolver, behind a `ChallengeResolver` interface. `detect/` emits `BlockState {kind: captcha\|login\|consent\|soft_block, vendor, origin, evidence}`. The server owns tickets (`open → claimed(resolverId) → resolved\|failed\|expired`). A verifier, not the resolver, decides success. `login` always goes to a person. Routing is a human-only setting. `ResolverSession` is narrow: stream, input, origin; no CDP, no cookies. Contract tests plus a `FakeResolver`. Agent state is `blocked` (renamed from `needs_human`). |
| 0002 extraction-pipeline | `defuddle` (MIT, v0.19.x) called directly with `useAsync: false`. Borrow from github.com/Ademking/MD-This-Page (MIT, credit it): the whole-page fallback when Defuddle extracts too little, `cloneVisible` (drops hidden text, which also strips hidden prompt injection), the wait for single-page apps to render, and the esbuild fix for astral-plane characters. Add: `data-cb-ref` tags on live elements that survive conversion, and a separate pass listing every visible anchor and button with ref, text, href and region. One extraction, two outputs (`content`, `content+links`). Runs in a CDP isolated world. |
| 0003 ad-blocking | On by default. `@ghostery/adblocker` (MPL-2.0) with EasyList and EasyPrivacy. Request blocking lives in the network gate; cosmetic filtering runs in the page. Can be turned off per site. Anti-adblock walls get a `detect/` signature. Blocked requests are logged as their own outcome. |
| 0004 scroll-and-extract | Real `mouseWheel` events through `Input.dispatchMouseEvent`, at a steady pace. Extract **during** scrolling and remove duplicates by stable key (adapter key, or a hash of href and text), because virtualized feeds drop items. `until: {items: n} \| {end: true} \| {tokens: n}`. Server caps: maxScrolls, maxSeconds, maxTokens; pacing applies. "Load more" buttons and pagination count as reading. The response says why it stopped (`target \| end \| no_growth \| cap`). The Reddit adapter prefers old.reddit.com pagination. |
| 0005 page-scripts | Ad blocking, extraction and scroll are configurable page scripts per site. In-page scripts run in an isolated world and ship with the app. Agents may set parameters, never code. |
| 0006 device-emulation | Desktop viewport by default. A complete, consistent mobile profile can be chosen per site. The fingerprint-spoofing line was removed from the Charter's "never" list (version 6). |
| 0007 license | AGPL-3.0 with a CLA. |
| 0008 deploy | Standalone app with its own login, three containers, one port. Harbor installs it as a manifest app. Household of users from v1. OIDC after v1. |

The Access Model's own five decisions (taint rule kept, token revoked after 90 days unused, Read preselected at setup, persistent anonymous profile, "Always" can be granted from the phone) go into `docs/threat-model.md`.

## Known doc gaps (fix while writing ADRs and the threat model)

1. `flag_domain` is in the Access Model but missing from the Charter's v1 tool list. Add it.
2. In v1, `list_flags` can only return flags from the gate's real-time checks and from `flag_domain`. The traffic graph and fan-in scoring come after v1.
3. The Access Model's debate table still says approvals sit behind "Harbor's login". The app has its own login now.
4. The accuracy and prompt-rate figures are estimates. Step 1 measures them.

## Build order

**Step 0: scaffold (short)**
- `git init`, `package.json` workspaces, TypeScript, lint, `npm run check`.
- Module folders, CODEOWNERS, SECURITY.md, CONTRIBUTING.md (pointing to AGENTS.md), LICENSE (AGPL-3.0), SPDX headers.
- ADRs 0001–0008, and `docs/threat-model.md` (from the Access Model).
- `deploy/compose.yaml` skeleton with app, browser and proxy, using internal and external networks.

**Step 1: `browser/` + `proxy/` spike (everything else depends on it).** Prove with tests against local pages in a real Chromium:
- CDP `Fetch` pauses redirect hops, `sendBeacon`, service-worker requests (or service workers are off), and requests from iframes running in their own process (auto-attach to every target).
- Non-GET requests are held, then released or failed; held requests time out after 20 s.
- The egress proxy resolves DNS itself, refuses 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fe80::/10, fc00::/7, IPv4-mapped, NAT64 and 6to4 after resolution, then connects to the IP it checked. QUIC is off; WebRTC can't use UDP outside the proxy.
- Typing into `type=password`, `cc-*` or `one-time-code` fields is refused by element type.
- Choose the CDP library here (puppeteer-core vs chrome-remote-interface vs playwright-core over CDP). The deciding factor is clean raw access to per-target `Fetch` and isolated worlds. Record the choice as an ADR.

**Step 2: page scripts.** Extraction with refs and the links pass, then scroll-and-extract, then ad blocking. Fixtures only. Add a local test page with infinite scroll and a virtualized list.

**Step 3: `shared/` contract, then `server/`.** Capabilities to MCP and OpenAPI; tokens; site ladder; proposals; tickets with the resolver interface and `FakeResolver`; taint; activity log.

**Step 4: `auth/`.** Setup code, password, passkey and TOTP, recovery codes, the route auth table and its coverage test, `reset-owner`.

**Step 5: `web/`.** Connect flow (`claude mcp add …` snippet), sites, approval page, live view at 15 fps, takeover, activity. ntfy notifications.

**Step 6: Reddit adapter, block signatures, Harbor manifest, `npm run dev` with a local test site.**

## First prompt for a new session

> Read START.md and AGENTS.md. Do step 0, then start step 1. Write ADRs from the decisions table. Stop after the step 1 spike and report what CDP `Fetch` did and didn't catch.
