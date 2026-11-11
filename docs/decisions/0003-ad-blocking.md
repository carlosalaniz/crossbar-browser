# 0003: Ad blocking

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision

- On by default.
- `@ghostery/adblocker` (MPL-2.0) with EasyList and EasyPrivacy.
- **Request blocking** lives in the network gate (`browser/`), so it covers every target the gate covers. **Cosmetic filtering** runs in the page, in the isolated world.
- Can be turned off per site.
- Anti-adblock walls get a `detect/` signature like any other block.
- Blocked requests are logged with their own outcome (`blocked_ad`), separate from security denials.

## Consequences

- Fewer requests, less tracking, shorter extractions.
- MPL-2.0 is file-level copyleft and compatible with AGPL-3.0 distribution; keep the library unmodified or publish changes to its files.
