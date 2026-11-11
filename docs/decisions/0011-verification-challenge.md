# 0011: A `verification` challenge kind (3-D Secure and other step-up checks)

- **Status:** Accepted
- **Date:** 2026-11-11
- **Amends:** [0001](0001-challenge-resolver-seam.md), which lists `BlockState.kind` as `captcha | login | consent | soft_block`.

## Context

After a person approves a payment (an always-ask action), the card issuer may demand 3-D Secure: a bank's own page, usually in a cross-origin iframe, asking for a code, an app approval or a password. The test site's Stripe scenarios showed there was no kind for it:
- `captcha` would be wrong: it isn't a bot check.
- `login` would be worse: a verified login raises the site to "can read as you" (ADR 0001, the opt-in to signed-in reading). Finishing a bank check must never loosen access to the shop.

## Decision

- Add `kind: "verification"` to `BlockState`: a step-up check by a third party (3-D Secure, a bank or card issuer's challenge).
- Like `login`, it **always goes to a person** (no non-human resolver may take it).
- Unlike `login`, resolving it **never changes the site ladder**.
- Takeover uses the tab where it appeared (same profile); there's no switch to the personal profile.
- The verifier passes when the challenge frames are gone.
- `detect/` recognises it by the frame shapes 3-D Secure uses (`three-ds`, `3d_secure`, `3ds2`, issuer ACS pages), so it doesn't depend on one payment provider's exact URLs.
- Priority: `captcha` > `verification` > `login` > `soft_block` > `consent`.

## Consequences

- The test site's 3DS scenario expects `blocked:verification` instead of the `blocked:captcha` stand-in.
- Agents see `{ state: "blocked", reason: "…confirm the payment with the bank…" }` and wait, as for any other ticket.
