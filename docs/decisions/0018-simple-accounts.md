# 0018: Simple accounts

- **Status:** Accepted (owner's decision, 11 Nov 2026)
- **Date:** 2026-11-11
- **Supersedes:** the setup-code and second-factor parts of ADR 0008.

## Context

Crossbar runs behind the owner's own access control (Harbor or a reverse proxy) and is tested from a phone on the LAN over plain HTTP. The setup code in the logs and the passkey/TOTP screens are friction the owner doesn't want; passkeys don't work without HTTPS anyway.

## Decision

- On first start, with no users, the server creates the owner account `admin` with password `admin` and logs that it did.
- No public sign-up. The owner adds household members with a username and password. Each user has their own isolated profiles.
- People sign in with username and password; agents use MCP tokens. Passkey and TOTP screens are removed from the web app; their server routes stay so they can return.
- While the owner's password is the default, every screen shows a banner to change it and every start logs a warning. Nothing is blocked.
- `admin` is the only password allowed under 10 characters.
- Approvals that loosen access re-check the password when no second factor is enrolled.

## Consequences

- Until the default password is changed, anyone who reaches the port is the owner. The install notes say to change it before exposing the app.
