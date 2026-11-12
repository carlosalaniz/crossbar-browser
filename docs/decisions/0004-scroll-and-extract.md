# 0004: Scroll and extract

- **Status:** Accepted; Reddit's read host amended by [0012](0012-reddit-read-host.md)
- **Date:** 2026-11-11

## Decision

- Scroll with real `mouseWheel` events via `Input.dispatchMouseEvent`, at a steady pace.
- Extract **during** scrolling and remove duplicates by a stable key (the adapter's key, or a hash of href and text), because virtualized feeds drop items that scroll out of view.
- `until: { items: n } | { end: true } | { tokens: n }`.
- Server-enforced caps: `maxScrolls`, `maxSeconds`, `maxTokens`. Pacing applies.
- "Load more" buttons and pagination count as reading.
- The response says why it stopped: `target | end | no_growth | cap`.
- The Reddit adapter prefers old.reddit.com pagination over infinite scroll.

## Consequences

- Works on virtualized lists, which a single end-of-scroll extraction would miss.
- Caps keep this from becoming bulk extraction.
