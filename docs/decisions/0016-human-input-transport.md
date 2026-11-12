# 0016: Human input transport for takeover

- **Status:** Accepted
- **Date:** 2026-11-11

## Context

Takeover sends each tap as two awaited HTTP requests (press, release) and typing as one inserted string from a field in Crossbar's page (audit S15–S18). The site sees no movement, a press as long as an HTTP round trip, and no keystrokes.

## Decision

- Takeover input travels over one WebSocket per claimed ticket, session-authenticated, on the human-only route list. Agent tokens are refused.
- Messages are ordered batches with a sequence number; every batch names the tab it targets. Events: pointer down, move, up and cancel with `pointerType`; touch points; wheel with `deltaX` and `deltaY`; key down and up with modifiers; text and composition.
- On disconnect, tab change or ticket end, pressed buttons and touches are released and the queue is dropped; nothing is replayed into another tab.
- Typing is forwarded as it happens. Whole-string insertion stays for password-manager fills. Key data and text are never logged.
- The old `POST /api/tickets/:id/input` route stays for compatibility and uses the same validation.

## Consequences

- The server rate-limits input per connection.
- Diagnostics record event shapes and timing only, never values.
