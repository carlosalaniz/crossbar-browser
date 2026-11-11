# 0006: Device emulation

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision

- Desktop viewport by default.
- A complete, consistent mobile profile (viewport, DPR, touch, a matching mobile user agent) can be chosen per site.
- The fingerprint-spoofing line was removed from the Charter's "never" list in Charter version 6. Emulation exists so a site renders its usable layout, not to impersonate many devices; running many accounts or rotating identities stays on the "never" list.

## Consequences

- Takeover already switches to a mobile viewport; the same profile code serves both.
