# 0020: WebSockets stay blocked

- **Status:** Accepted (owner's decision, 12 Nov 2026). Keeps ADR 0010 as it is; the scoped allowance first proposed here is rejected.
- **Date:** 2026-11-12

## Context

Every WebSocket handshake is blocked by a static extension rule (ADR 0010), because CDP `Fetch` never pauses WebSockets and the egress proxy can't tell `wss://` from HTTPS inside a `CONNECT` tunnel. The automation-signal audit (S24) asked whether that block costs too much in site compatibility or bot detection.

Which sites depend on sockets:

| Effect of the block | Examples |
|---|---|
| Core feature broken | Discord, Slack and WhatsApp Web (live messages), Figma, Notion, Miro, Linear (real-time editing), Coinbase, Binance, TradingView (live prices) |
| Live updates missing, page usable | GitHub (live PR and issue updates), Reddit (chat, live counts), support chat widgets (Intercom, Zendesk) |
| No dependency known | Mail sites, shopping, articles and forums |

An earlier draft said challenge and fraud SDKs need WebSockets. That wasn't verified: no major captcha or bot-detection script is known to depend on one.

## Options considered

1. **Scoped allowance:** sockets allowed to the site's own domain group, on sites at `read_as_you` or above, opted in per site, removed on taint. Rejected. Once a socket is open, nothing sent over it gets an approval card, a taint check or a content log. On sites whose writes travel over the socket (WhatsApp Web sends messages that way), an agent could send without asking. An agent misled by prompt injection could paste text it read while signed in into an allowed chat. Monitoring sent frames (CDP reports them after they're sent) gives detection and a kill switch, not prevention.
2. **Fake open, drop everything (a black hole).** Rejected.
   - Faking the server's answer for `wss://` needs intercepting TLS with a certificate the browser trusts. Replacing `WebSocket` in the page's own JavaScript is a detectable patch of the kind the audit removed (S02–S04).
   - It doesn't make sites work. Clients expect a greeting or heartbeat within seconds (Discord's gateway sends "hello" at once), so a silent socket times out and reconnects, or sits on "connecting".
   - It doesn't hide anything from the site. Bot detection is mostly server-side, and the server sees the same thing either way: the page loaded and its socket never connected. "Opens, then silence, then a reconnect loop" is rarer than "fails to connect", which corporate firewalls and privacy tools also produce.
3. **Keep the block.** Chosen.

## Decision

- WebSocket handshakes stay blocked for every site, page, frame and worker (ADR 0010, unchanged).
- No fake or black-holed sockets.
- Agents aren't offered for apps that need sockets for their core feature (chat apps, real-time editors, live trading). Those stay for a person.

## Consequences

- Reading and acting on mail, shopping, forums, GitHub and Reddit work; live updates on those pages need a reload.
- A failing socket is visible to page code. It's a weak signal: firewalls and privacy tools cause the same failure.
- To revisit: a site an owner needs whose ordinary reading or approved actions break without a socket, with a test showing which writes go over it. A new ADR, not an edit to this one.
