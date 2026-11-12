# 0006: Device emulation

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision

- Desktop viewport by default.
- A complete, consistent mobile profile (viewport, DPR, touch, a matching mobile user agent) can be chosen per site.
- Device emulation may present a consistent, believable device fingerprint (viewport, user agent, client hints, platform, GPU, screen metrics) so the site renders its usable layout and its bot-detection checks see a normal browser. Emulation is an extension of the user's own device, not a tool for running many accounts or rotating identities.

## Consequences

- Takeover already switches to a mobile viewport; the same profile code serves both.
