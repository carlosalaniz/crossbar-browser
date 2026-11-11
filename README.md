# Crossbar

**Your own browser, lent to your agents, with you in the loop for anything a person should decide.**

Crossbar is a self-hosted Chromium that AI agents drive through [MCP](https://modelcontextprotocol.io). Agents read and act on websites as you: your accounts, at a human pace.

- **Captchas and logins go to you.** Crossbar detects them and hands them to you through a phone-first web app with a live view and takeover. It never solves them itself.
- **Consequences ask first.** Posting, paying, deleting and private messages are held in the browser until you approve them on your phone. Approval is decided from the requests that actually leave the browser, not from button labels.
- **Built for prompt injection.** A page the agent reads can't promote the agent, can't approve anything, and can't make the browser send what it read while signed in to a new site without asking you.

> Status: early. Everything in v1 is implemented and tested against local pages, but it hasn't had real-world use yet. Read [docs/threat-model.md](docs/threat-model.md) before trusting it with your accounts.

## What it is not

Crossbar refuses to become a scraper. Pull requests that add any of these are closed:

- solving captchas automatically, or calling solver services;
- rotating or residential proxy pools;
- creating accounts, or running many accounts;
- bulk crawling, or mass extraction on a schedule;
- getting around paywalls or access you don't have;
- agent tools for eval, raw CDP, or exporting cookies;
- agents typing into password, one-time-code or card fields.

## How it works

Three containers, one public port:

| Container | Network | Holds |
|---|---|---|
| `app` | public + internal | Web app, MCP, API, login, tokens, keys, SQLite, activity log |
| `browser` | internal only | Headful Chromium (under Xvfb) and its profiles. No tokens or keys |
| `proxy` | internal + egress | The browser's only way out. Resolves DNS itself and refuses private ranges after resolution |

Every request from every tab, iframe and worker passes a **network gate** (CDP `Fetch` on every target). Reads pass. Writes are held for up to 20 s while your phone buzzes. WebSockets are blocked outright, since CDP can't see them (see [ADR 0010](docs/decisions/0010-websocket-block.md)).

Each site sits on a ladder: **blocked → can read (anonymous profile) → can read as you (your logins) → can act as you.** Mail, banking, password managers, cloud consoles and your LAN start blocked, and only you can unblock them.

## Quick start

### Docker (recommended)

```sh
git clone https://github.com/carlosalaniz/crossbar-browser && cd crossbar-browser
printf 'CROSSBAR_BROWSER_SECRET=%s\nCROSSBAR_ORIGIN=http://localhost:8080\n' "$(openssl rand -base64 36)" > deploy/.env
# Port 8080 taken? Add CROSSBAR_PORT=8081 and CROSSBAR_ORIGIN=http://localhost:8081 to deploy/.env.
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml logs app | grep "setup code"
```

Open http://localhost:8080, enter the setup code and create your account. Put it behind HTTPS (a reverse proxy, Tailscale, or Harbor) before using it from your phone, and set `CROSSBAR_ORIGIN` to that URL.

### Harbor

```sh
harbor sources add https://github.com/carlosalaniz/crossbar-browser
```

Read [harbor/README.md](harbor/README.md) first. Harbor can't yet give the browser the namespaces Chromium's sandbox needs, so the browser won't start there until you turn the **Chromium sandbox** setting off, knowingly, or Harbor gains that permission.

### Development

```sh
npm ci
npm run check      # typecheck, lint, all tests (installs a pinned Chrome for Testing on first run)
npm run dev        # docker compose stack + a local test site at http://testsite.test:8090
                   # (uses port 8080, or the next free one; it prints the URL)
npm run dev:local  # the same without Docker: proxy, test site and app in one process
```

## Connect an agent

In the web app, open **Agents**, name the agent, choose **Read** or **Act**, and copy the line it gives you:

```sh
claude mcp add --transport http crossbar https://crossbar.example.com/mcp --header "Authorization: Bearer cb_read_…"
```

Tools: `open`, `read` (markdown with clickable refs like `[e12]`), `click`, `type`, `scroll`, `back`, `wait_for_ticket`, `list_activity`, `list_flags`, `flag_domain`, `list_sites`, `set_site`, `list_grants`, `revoke_grant`, `panic`.

When a tool returns `pending_approval` or `blocked`, the agent calls `wait_for_ticket` while you decide on your phone. Notifications go through [ntfy](https://ntfy.sh); set your topic in **Settings**.

## Security

- The security model and its residual risks: [docs/threat-model.md](docs/threat-model.md).
- Settled decisions: [docs/decisions/](docs/decisions/).
- Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Contributing

Start at [AGENTS.md](AGENTS.md); it's the front door for people and agents alike.

## License

AGPL-3.0-only, with a CLA ([ADR 0007](docs/decisions/0007-license.md)). Page extraction adapts code from [MD-This-Page](https://github.com/Ademking/MD-This-Page) (MIT). Ad blocking uses [@ghostery/adblocker](https://github.com/ghostery/adblocker) (MPL-2.0).
