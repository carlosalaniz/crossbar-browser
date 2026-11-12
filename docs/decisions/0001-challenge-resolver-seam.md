# 0001: Challenge resolver seam

- **Status:** Accepted; amended by [0011](0011-verification-challenge.md) (adds `kind: "verification"`) and [0013](0013-person-overrides-verifier.md) (a person can dismiss a false alarm)
- **Date:** 2026-11-11

## Context

Captchas, logins, consent walls and soft blocks stop agents. We want a clean place where the handling of a blocked page lives, so the lifecycle is testable and the human path is not tangled into the browser code.

## Decision

- `detect/` turns a page into `BlockState { kind: "captcha" | "login" | "consent" | "soft_block", vendor, origin, evidence }`. It has no side effects.
- The server owns the ticket lifecycle: `open → claimed(resolverId) → resolved | failed | expired`. Tickets expire after 15 minutes.
- A `ChallengeResolver` claims and works a ticket. **v1 ships exactly one resolver: human takeover.**
- A separate **verifier** decides whether the block is gone (signature gone, clearance or session cookie set, expected content visible). The resolver never marks its own work as successful. A person tapping "I'm done" triggers verification; if the check fails the ticket reopens.
- `kind: "login"` always goes to a person, whatever resolvers are configured.
- `ResolverSession` is narrow: the screen stream, input events, and the ticket's origin. It has no CDP access and no cookies.
- The agent sees `{ state: "blocked", reason, ticket }` (renamed from `needs_human`) and can call `wait_for_ticket`.
- Contract tests run against a `FakeResolver`.

## Consequences

- Adding a resolver later means implementing an interface and passing the contract tests, not touching the browser or the ticket store.
- The seam supports both human and automated resolvers; each resolver declares its capabilities and the server routes tickets accordingly.
