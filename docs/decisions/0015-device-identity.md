# 0015: One device identity per session, honest software rendering

- **Status:** Accepted (owner's decision, 11 Nov 2026)
- **Date:** 2026-11-11
- **Amends:** ADR 0006 (its consequence "takeover already switches to a mobile viewport" is withdrawn).

## Context

The automation-signal audit (`docs/automation-signal-audit.md`, S12–S14, S31) found that takeover rewrites a desktop session into a claimed Pixel phone and back, and that headless mode reports guessed client-hint metadata. Sites see a device that changes in the middle of a login. Bot-detection triggers stop the user acting, so each one is a bug.

## Decision

- The site's device (desktop by default, or the per-site mobile profile) stays fixed for the whole session, including takeover and popups opened during it. The phone viewer scales and letterboxes the stream; it never changes the remote device.
- Device emulation stays a believable profile (ADR 0006), with one limit: the GPU is the real renderer. The browser renders through Mesa llvmpipe (ANGLE) and the renderer string is never overridden. User agent and client hints say Linux x86_64 to match; fonts are the Linux set.
- The mobile profile is kept and gets real touch input (`Input.dispatchTouchEvent`), applied to every child target.
- Headful is the default in every launcher; headless is for tests.

## Consequences

- A spoofed GPU string that WebGL output would contradict is never shipped.
- The takeover UI must work with a desktop-sized remote page on a phone (pinch and pan in the viewer).
