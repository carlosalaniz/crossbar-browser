# AGENTS.md

The front door for everyone working on Crossbar, agents and people alike. `CONTRIBUTING.md` points here. If a rule here conflicts with your habits, the rule wins. If it conflicts with a settled decision in `docs/decisions/`, the decision wins. Propose a new ADR instead of working around one.

## What this is

**Crossbar:** your own browser, lent to your agents, with you in the loop for anything a person should decide.

- A self-hosted, headful Chromium that agents drive through **MCP**, reading and acting on websites **as you**: your accounts, at a human pace.
- Captchas and logins are handed to a person through a phone-first web app (live view and takeover). Crossbar never solves them itself.
- Anything with consequences (posting, paying, deleting, private messages) goes to a person for approval.
- It is designed to stay safe while a page the agent is reading tries to take the agent over (prompt injection).

The sources of truth are two design pages: the **Charter** (scope, deployment, modules, license) and the **Access Model** (security). They are being moved into `docs/` (`docs/threat-model.md` and `docs/decisions/`). Until then:
- Charter: https://claude.ai/artifact/WBcaHfYYPBjRNq2zX4qQfL
- Access Model: https://claude.ai/artifact/JrJrT21wE7F5TXJbHNEzq1

## Architecture in one screen

Three containers in one compose file, served on **one port**:

| Container | Networks | Holds |
|---|---|---|
| `app` | public (the one port) and internal | API, web app, MCP, login, users, tokens, keys, database (SQLite in v1), activity log, tickets. Reaches browsers **only** through the pool interface in `browser/` |
| `browser` | internal only | Headful Chromium and its profiles. No tokens, no keys, no database |
| `proxy` | internal and outside | DNS, IP rules, taint enforcement, request logging. The browser's only way out |

```
crossbar/
├─ shared/     # zod contract: every route, tool and setting, with .describe()
├─ server/     # API, MCP, users, tokens, tickets, notifications; capabilities.ts generates MCP and OpenAPI
├─ auth/       # SECURITY: sessions, passwords, passkeys, TOTP, setup code, route auth table
├─ browser/    # SECURITY: CDP controller, pool, profiles, tabs, refs, element checks, network gate, page scripts
├─ proxy/      # SECURITY: egress proxy: DNS, IP rules, taint enforcement, request logging
├─ detect/     # block signatures as data, with HTML/HAR fixtures → BlockState
├─ adapters/   # one folder per site (reddit/ first): read ops, domain group, consent, sensitive paths, item selectors
├─ web/        # phone-first web app: connect, sites, approvals, live view, takeover, activity
├─ deploy/     # compose.yaml (app, browser, proxy), Harbor manifest
└─ docs/
   ├─ threat-model.md
   └─ decisions/   # one ADR per settled decision
```

Each folder owns one job and talks to the others through a typed contract in `shared/`. Work inside one folder without loading the whole system into your head.

## Core concepts (short)

- **Tokens.**
  - **Read:** navigate, read, click, expand, search; tighten only.
  - **Act:** the super admin. It can call every setting. Tightening applies at once; loosening returns `pending_approval`.
  - **No token can approve its own request.**
  - Every token has an agent name, written on every audit row. A token unused for 90 days is revoked.
- **Human-only list.** These are never in `capabilities.ts`:
  - approving tickets and proposals
  - showing or regenerating tokens
  - unblocking LAN or sensitive categories
  - changing where notifications go
  - importing cookies or exporting the profile
  - resuming after panic
  - choosing which challenge resolvers are allowed
- **Site ladder, per registrable domain (PSL):** `blocked` → `read` (anonymous profile) → `read_as_you` (personal profile) → `act_as_you`. The most specific host rule wins.
- **Two profiles per user:** a persistent anonymous one (never signed in) and a personal one.
- **Network gate (authoritative for writes):**
  - CDP `Fetch` runs on every target, including iframes and workers.
  - Non-GET requests not on the site's read list are held.
  - On signed-in sites, any unknown non-GET request asks, so a miss fails closed.
- **Taint.** After a session reads while signed in:
  - a plain GET to a domain the session hasn't used opens in the anonymous profile;
  - a request carrying data there asks first.
- **Tickets.** A blocked page returns `{state: "blocked", reason, ticket}`. `wait_for_ticket` waits; tickets expire after 15 minutes.
- **Challenge resolvers (ADR 0001).**
  - `detect/` emits `BlockState`; the server owns the ticket lifecycle; a `ChallengeResolver` resolves it.
  - v1 has **one** resolver: human takeover.
  - A separate verifier decides success, never the resolver.
  - `kind: login` always goes to a person.
- **Page scripts (ADRs 0002–0004).** Configurable stages per site:
  - **Ad blocking:** request blocking in the gate plus cosmetic hiding in the page. On by default.
  - **Markdown extraction:** Defuddle with `useAsync: false`, live-element refs, and a separate pass that lists links.
  - **Scroll:** real wheel events, extracting and removing duplicates while scrolling, with `until: {items}|{end}|{tokens}` and caps the server enforces.

  In-page scripts run in a CDP **isolated world**. Agents may set script parameters but never supply script code.
- **Activity log.** Records the *shape* of the data each request carries (key names, types, lengths, entropy band, keyed hash), not the values. Append-only, kept 90 days.

## Never build

A pull request that adds any of these is closed and pointed at this section:

1. Solving captchas automatically, or calling solver services
2. Rotating proxies or residential proxy pools
3. Creating accounts, or running many accounts
4. Bulk crawling, or mass extraction on a schedule
5. Getting around paywalls or access you don't have
6. Agent tools for eval, raw CDP, or exporting cookies or storage
7. Agents typing into `type=password`, `autocomplete=cc-*` or `one-time-code` fields, or on sign-in providers such as `accounts.google.com`

Device emulation (viewport, DPR, touch, a consistent mobile UA) is allowed per site.

## Rules

1. **This file is the front door.** Read it, then the ADRs that touch your folder, before changing anything.
2. **Security rules are tests.** Every rule in the Access Model has a named test, for example:
   - a read token can't propose
   - `10.0.0.1` is refused *after* DNS resolution
   - an agent can't type into `type=password`
   - a tainted session can't send a query to a new domain
   - every route declares its login type

   A change that breaks one fails CI, whoever wrote it. New security behaviour comes with its test in the same PR.
3. **Settled decisions are ADRs** in `docs/decisions/NNNN-title.md`. Don't reopen one without new evidence; write a new ADR that supersedes it.
4. **No live websites in CI.** Tests use saved HTML/HAR fixtures and local test pages served by the dev stack. Refreshing fixtures from real sites is a separate, manual script.
5. **The security core needs owner review.** `auth/`, `browser/`, `proxy/`, and token and capability code are covered by CODEOWNERS.
6. **A person answers for every pull request.** Agents may write the code; a human opens the PR, signs the CLA and answers for it. Agent co-authorship goes in commit trailers. No bot opens PRs on its own.
7. **One command to start.**
   - `npm ci && npm run check` passes on a clean checkout.
   - `npm run dev` brings up the stack with a local test site, so nobody needs an account anywhere.
8. **Vulnerabilities go through private advisories** (`SECURITY.md`), never public issues.
9. **Contracts first.** Any new route, tool or setting is defined in `shared/` with zod and `.describe()`. `server/capabilities.ts` generates MCP and OpenAPI from it. No hand-written tool schemas.
10. **Nothing outside `browser/` calls CDP.** Everything else goes through the pool and controller interface.
11. **Deny by default.** One route table, and every route declares its login: a session for the web app, a token for `/mcp`, either for `/api`.
12. **Server-controlled text only** in notifications and approval facts. Page text and agent reasons are shown as quotes, marked unverified.

## How to add a site adapter

1. Create `adapters/<site>/` with a declarative site file:
   - domain group
   - read operations (for example GraphQL `operationName`s or non-GET endpoints that only read)
   - consent-banner dismissal ("reject all")
   - sensitive paths
   - block signatures
   - item selector and stable key (for scrolling)
   - preferred read host (for example `old.reddit.com`)
2. Add saved fixtures (HTML/HAR) and tests that run against them only.
3. No changes to `auth/`, `browser/` or `proxy/` should be needed. If they are, open an issue first.

New block signatures go in `detect/` the same way: data plus fixtures.

## Dev loop

```
npm ci
npm run check     # typecheck, lint, all tests (node --test for server; Vitest for web)
npm run spike     # step 1 matrix: what CDP Fetch catches, per request path
npm run dev       # docker compose stack + local test site
```

Stack: TypeScript on Node, zod contracts, `node --test` with a fake browser for `server/`, real Chromium against local pages for `browser/`, table tests for `proxy/`, Vitest for `web/`.

## License

AGPL-3.0 with a CLA (the human who opens the PR signs it). SPDX line at the top of each source file.
