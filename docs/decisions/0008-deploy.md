# 0008: Deployment

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision

- A standalone app with its own login (setup code, password, optional passkey or TOTP, recovery codes, `reset-owner`).
- Three containers in one compose file, one public port:

  | Container | Networks | Holds |
  |---|---|---|
  | `app` | public and internal | API, web app, MCP, login, users, tokens, keys, SQLite, activity log, tickets |
  | `browser` | internal only | Headful Chromium and profiles. No tokens, keys or database |
  | `proxy` | internal and egress | DNS, IP rules, taint enforcement, request logging. The browser's only way out |

- The app reaches browsers only through the pool interface in `browser/`.
- Harbor installs it as a manifest app; Harbor provides domain, TLS and image pins, not login.
- A household of users from v1. OIDC after v1.

## Consequences

- The browser container has no route to the internet except the proxy; its network is `internal: true`.
- Scaling past one host happens behind the pool interface later.
