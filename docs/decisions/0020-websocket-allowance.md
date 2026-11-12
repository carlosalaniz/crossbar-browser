# 0020: Scoped WebSocket allowance

- **Status:** Proposed. Needs the owner's decision (it loosens a security boundary).
- **Date:** 2026-11-12
- **Amends:** ADR 0010 (every WebSocket handshake is blocked).

## Context

Every WebSocket fails today (audit S24). Sites that use sockets for chat, live updates, or challenge and fraud SDKs either break or see a browser whose sockets always fail, which is itself a bot-detection trigger. The gate can't see WebSocket frames (CDP `Fetch` never pauses them), so an allowed socket is a data channel that approvals and taint can't inspect.

## Proposal

- A DNR dynamic allow rule per site, added only when the site is at `read_as_you` or above and the person turned on "Live connections" for it in Sites. Off by default.
- Allowed only to the top-level site's own domain group, never third parties.
- Removed for a session as soon as it's tainted to another domain.
- Each socket open is logged (host, time), never its frames.

## Consequences

- Data could leave over an allowed socket without an approval card. The scope (own domain, person opt-in, untainted) limits this to the site the person already lets the agent act on.
