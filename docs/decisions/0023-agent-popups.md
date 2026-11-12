# 0023: Popups an agent's click opens become tabs

- **Status:** Proposed
- **Date:** 2026-11-12

## Context

Pages an agent didn't create are closed at once (audit S30). "Sign in with…" and payment windows opened by an agent's click fail, and a site sees its popup vanish.

## Proposal

- A popup opened by a page within 2 seconds of an agent's click on that page is adopted as a tab of the same session, with the opener's policy, taint and profile, and its own window (ADR 0017).
- The agent sees it in the next tool result and can switch to it; it closes when the session ends.
- Popups with no recent agent click are still closed. Downloads and printing stay off.
