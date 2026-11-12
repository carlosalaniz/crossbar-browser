# 0017: Concurrency during takeover

- **Status:** Accepted (owner's decision, 11 Nov 2026)
- **Date:** 2026-11-11

## Decision

- During takeover, the tab a person controls is leased to them. Agent calls aimed at that tab return busy; the session that hit the challenge, and work that depends on it, waits (`wait_for_ticket`).
- Unrelated agent work continues.
- Every tab Crossbar opens gets its own window, so the person's tab and each agent's tab are each in front of their own window.
- Measured under Xvfb (Chromium 156, 12 Nov 2026): a window covered by another reports `visibilityState: "hidden"` and stops animation frames; side by side, both stay visible; with `--disable-backgrounding-occluded-windows`, a covered window stays visible. Crossbar launches with that flag. The "bring the tab forward" fallback isn't needed.
- The live view never brings a tab forward that someone else holds.
