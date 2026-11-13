# 0029: How a person reaches Crossbar, and signs in each time

- **Status:** Accepted (owner's decision, 12 Nov 2026); not built yet; the screens come from the design artifact first
- **Date:** 2026-11-12

## Context

Agents mostly work in the background. The person is reached when something needs them, usually far from the computer. The Inbox and Live are the screens that matter; they are opened cold, from a notification or from the agent's app, often in a small webview.

## Decision

- **Ways in:** a notification (ntfy now) or an intent into an app opens a deep link: `#/tickets/<id>`, `#/` (Inbox) or `#/live/<tab>`. Each screen must make sense opened on its own and ends with a clear "done, you can close this".
- **A plain webview or browser asks the person to authenticate every time it opens.** Password now; biometrics (a passkey on the device: Face ID, fingerprint) later. The screen keeps a slot for it.
- **A native app or other wrapper** holds its own credential (a device token issued by Crossbar to that device, revocable in Settings) and opens already signed in.
- **The agent never carries the person's credential** and never approves its own request (AGENTS.md: no token can approve its own request).

## Consequences

- Passkeys need a secure context (HTTPS); on plain-HTTP LAN the webview falls back to the password.
- A device-token kind is new: issued from Settings, bound to one device, human-only (like showing tokens), listed and revocable. It needs its own ADR before it is built.
- Session lifetime for webviews becomes per-open; the web app's normal session stays as it is.
