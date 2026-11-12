# 0010: WebSocket block and the pinned browser

- **Status:** Proposed (step 1 spike; needs owner review)
- **Date:** 2026-11-11

## Context

The Access Model (L5) says WebSocket and WebRTC are denied unless an adapter allows them. The step 1 spike measured that **CDP `Fetch` never pauses WebSocket handshakes** from pages, cross-site iframes or workers, and that **`Network.setBlockedURLs` doesn't block them either** (it blocks ordinary HTTP with the same patterns). The proxy can't tell `wss://` from `https://` inside a `CONNECT` tunnel.

A Manifest V3 extension with one static `declarativeNetRequest` rule (`resourceTypes: ["websocket"]`, action `block`) blocked handshakes from pages, cross-site iframes and dedicated workers in Chrome for Testing 157 (`browser/test/gate.test.ts`).

Branded Google Chrome (137 and later) ignores `--load-extension`; Chromium and Chrome for Testing honour it.

## Decision

- Ship `browser/extensions/ws-block/`: a static DNR rule, no background script, no messaging, no host access beyond what DNR needs.
- The launcher loads it with `--load-extension` and `--disable-extensions-except`.
- The browser runs **Chrome for Testing or Chromium**, never branded Chrome. Development and CI pin Chrome for Testing (`scripts/ensure-browser.mjs`, installed into `.cache/browsers` by `npm test`); the browser container will ship Chromium or the same pinned build.
- The WebSocket tests fail, rather than skip, when the browser can't load extensions.
- Adapters that need WebSockets later get an allow rule through DNR dynamic rules, scoped to their domain group. That design is deferred. (ADR 0020 later decided against any allowance: sockets stay blocked.)

## Consequences

- A small extension is part of the security core and needs the same owner review as `browser/`.
- WebSocket traffic is blocked outright, not held for approval; the gate can't show it on an approval card.
- WebRTC is not covered by this; it relies on `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, which the spike did **not** verify against a live UDP listener.
