# 0021: Permission prompts behave like a fresh browser

- **Status:** Proposed
- **Date:** 2026-11-12

## Context

Fresh profiles pre-deny notifications, location, camera and microphone (audit S28). A page querying permissions sees `denied` without ever having asked, which a fresh real browser never shows.

## Proposal

- Default content settings stay "ask" (Chrome's default); the seeded denies are removed for new profiles.
- A prompt that appears while an agent drives is dismissed by the gate (`Browser.setPermission` is not used to grant anything). Dismissing keeps the state at `prompt`, as when a person closes the bubble.
- During takeover the person sees a Crossbar card for the prompt and may allow it for that origin. Camera and microphone stay unavailable in the container regardless.

## Consequences

- Repeated dismissals put an origin under Chrome's embargo (its normal behaviour for people too).
