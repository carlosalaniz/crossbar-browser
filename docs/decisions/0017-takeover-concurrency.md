# 0017: Concurrency during takeover

- **Status:** Accepted (owner's decision, 11 Nov 2026)
- **Date:** 2026-11-11

## Decision

- During takeover, the tab a person controls is leased to them. Agent calls aimed at that tab return busy; the session that hit the challenge, and work that depends on it, waits (`wait_for_ticket`).
- Unrelated agent work continues.
- Agent sessions in the same profile each get their own window, so the person's tab and an agent's tab are both in front of their own window. If a browser build hides covered windows, the fallback is: before acting, the agent's tab comes forward, except while a person holds a lease in that window, when the agent waits.
- The live view never brings a tab forward that someone else holds.
