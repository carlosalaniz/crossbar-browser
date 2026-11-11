# 0009: CDP client

- **Status:** Proposed (step 1 spike; needs owner review)
- **Date:** 2026-11-11

## Context

START.md listed three candidates: puppeteer-core, chrome-remote-interface, or playwright-core over CDP. The deciding factor was clean raw access to per-target `Fetch` and isolated worlds.

What the gate actually needs, as the spike built it (`browser/src/gate.ts`):

- one browser connection with **flat sessions**, one `sessionId` per target;
- browser-level and per-session `Target.setAutoAttach { waitForDebuggerOnStart: true, flatten: true }`, recursively;
- on every attach, in order: `Fetch.enable`, child auto-attach, then `Runtime.runIfWaitingForDebugger`, each with a deadline, and closing the target if `Fetch.enable` fails;
- `Page.createIsolatedWorld` + `Runtime.evaluate { contextId }`.

## Decision

Use a **small in-house CDP client** (`browser/src/cdp.ts`, about 100 lines) over Node's built-in `WebSocket`, typed against the `devtools-protocol` package. This is none of the three listed candidates.

- **puppeteer-core / playwright-core:** both own auto-attach and the `Fetch` domain for their own request interception and target tracking. The gate needs to own exactly those. Using them means either fighting their internals or bypassing them through raw sessions, which leaves us carrying a large dependency for its launcher. *Not measured in the spike; this is from how both libraries are built.*
- **chrome-remote-interface:** raw and would work. It adds a dependency with loose typings for what is a request/response map and an event emitter.
- **In-house:** everything the gate does is visible in two files, typed per command, and the security core has no CDP dependency beyond protocol type definitions.

## Consequences

- We maintain the client. Its surface is `send`, `on`, `close`.
- Protocol types come from `devtools-protocol`; bump it with the pinned browser.
- Revisit if we need features those libraries do well and we don't (for example, robust screencast handling for the 15 fps live view); a library can sit beside the gate for that without owning `Fetch`.
