# 0005: Page scripts

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision

- Ad blocking (0003), extraction (0002) and scroll (0004) are **page scripts**, configurable per site.
- In-page scripts run in a CDP isolated world and ship with the app.
- Agents may set a script's **parameters**, never its **code**. There is no eval tool.

## Consequences

- The page's own JavaScript can't see or tamper with Crossbar's globals, and Crossbar doesn't trust page prototypes.
- Adding a page script is a code change reviewed like any other, not a runtime configuration.
