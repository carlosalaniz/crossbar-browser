# 0013: A person can dismiss a challenge as a false alarm

- **Status:** Accepted
- **Date:** 2026-11-11
- **Amends:** [0001](0001-challenge-resolver-seam.md), where the verifier, not the resolver, decides success.

## Context

Live, old Reddit's submit form showed a reCAPTCHA *inside the form* (asked of newer accounts at submit time). `detect/` called the page a captcha wall. The verifier kept seeing the widget, so "I'm done" could never succeed, and the person was stuck in a loop with no way out.

## Decision

- A person (web session, never a token) can close a challenge ticket as a false alarm: `POST /api/tickets/:id/not-a-wall`. The ticket resolves with `{ verifiedBy: "person", falseAlarm: true }`, and any takeover ends.
- ADR 0001's rule still holds for resolvers: a resolver never decides its own success. The person isn't a resolver here: they are the authority the whole design defers to.
- The agent session remembers the dismissal (kind + origin + path), so the same page doesn't raise the same wall again in that session.
- It's logged, so false positives can be fed back into `detect/` signatures.
- Separately, `detect/` no longer treats a captcha widget inside a form that has other fields to fill as a wall. It gates sending that form, not reading the page. Login forms (a password field) and bare challenge pages still count.

## Consequences

- A tired person can wave a real wall through. That costs nothing: the agent just hits the wall again, because the dismissal is per page and only for that session.
