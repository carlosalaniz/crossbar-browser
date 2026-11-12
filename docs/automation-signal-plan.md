# Plan: reducing bot-detection triggers

**Date:** 11 November 2026. **Source:** [the automation-signal audit](automation-signal-audit.md) (findings S01–S36), checked against `main` at edab54c.

## Goal

Every bot-detection trigger is a bug that stops the user acting on their own accounts. Remove as many as possible, ideally all. Where a security boundary causes a trigger, don't accept it as permanent and don't delete the boundary: propose a scoped, enforced alternative through an ADR.

What this plan cannot promise: an undetectable browser. Server-side account risk (new device, IP reputation, step-up policy) is outside a browser patch. Each PR measures the trigger it targets before and after, on the local diagnostic page, so "fixed" means measured.

Security invariants that every PR must keep (the existing suites run in every PR): the network gate fails closed, taint, consequence approvals, the egress proxy's post-resolution IP checks, human-only routes, no agent-supplied page code.

## Decisions taken (owner, 11 Nov 2026)

| # | Question | Decision | Consequence |
|---|---|---|---|
| D1 | Agent typing into password, card and one-time-code fields | Allowed, as the code already does ([input-guard.ts](../browser/src/input-guard.ts)) | README "never" list and threat-model L3 change to match. Typing into those fields is gated by the sensitive-category permission (ADR 0014) |
| D2 | Device fingerprint | Believable profile (ADR 0006 stands); GPU is an **honest software renderer**, Mesa llvmpipe, never a spoofed GPU string | User agent and client hints report Linux x86_64 to match; fonts stay the Linux set |
| D3 | Mobile site profile | Kept, with real touch input | Touch events, mobile emulation on every child target, and the device never changes during takeover |
| D4 | Concurrency during takeover | Unrelated agent work continues; the session that hit the challenge, and work that depends on it, waits | The takeover tab is leased to the person; agent calls on it return busy |
| D5 | Two agent sessions in one profile | The acting session's tab comes forward first | Conflicts with D4 inside one profile; resolved in PR D by one window per session, if the Xvfb check passes |

Corrections to the audit:
- Its date reads 12 Nov 2026; the snapshot is 11 Nov.
- S01 suggests `--remote-debugging-pipe` as an option. Chromium also marks the browser automated for the pipe flag (to be confirmed in PR C), so the plan uses an explicit nonzero loopback port.
- S12/S13/S31 recommend "honest native identity" over a believable profile; D2 overrides that, within the limits above.
- S24–S30 were listed as retained. Under this goal each gets a proposed path (PR H) instead of being closed as "keep".

## Order and dependencies

```
A (decisions) ─┬─> C (markers) ──> E (agent input)
B (diag page) ─┼─> D (takeover) 
               ├─> F (site compatibility)
               ├─> G (environment)
               └─> H (boundaries, ADR-first)
```

B lands before any behaviour change, so each later PR compares against a recorded baseline. C and D are the priority: they remove the direct markers and the takeover failures.

---

## PR A: decisions and docs (no code)

- **ADR 0015, device identity:** the site's device (desktop or mobile) stays fixed for the whole session, including takeover; the phone viewer scales and letterboxes. Software rendering through Mesa llvmpipe; the renderer string is never overridden. Amends ADR 0006 (its "takeover switches to mobile" consequence is withdrawn).
- **ADR 0016, human input transport:** a human-only, session-authenticated WebSocket per ticket; ordered, sequence-numbered batches; every batch names its tab; disconnect or tab change releases pressed buttons and drops the queue; never on an agent token.
- **ADR 0017, concurrency:** D4 and D5; foreground lease semantics; one window per agent session (conditional on PR B's measurement).
- README and [threat-model.md](threat-model.md) L3: credential-field typing per D1.
- [bot-detection.md](bot-detection.md): link this plan.

## PR B: local diagnostic page

A new test-site host, `diag.test`, served by the dev stack only. It records into a JSON snapshot:

- automation flags (`navigator.webdriver`), user agent, client hints (low and high entropy), platform;
- screen, available screen, inner and outer window, device pixel ratio;
- timezone, `Intl` locale, `navigator.languages`, the `Accept-Language` header it received;
- WebGL and WebGL2 renderer and vendor (unmasked), extensions and limits; canvas and audio availability; fonts from a fixed probe list;
- a MutationObserver log of every DOM change not made by the page's own script;
- main-world hooks on `document.title`, `querySelector*`, `getComputedStyle`, recording calls it didn't make;
- a pointer, touch, wheel, keyboard and composition trace (type, `isTrusted`, coordinates, timing; synthetic text only);
- visibility and focus changes;
- permission states; WebSocket, worker and service-worker outcomes; ping and prefetch requests seen.

A test helper reads the snapshot. Baseline snapshots from `main` are committed for: headful container, `dev:local`, and direct server start. Also measured here, ahead of PR D: whether two overlapping windows under Xvfb both report `visible`.

## PR C: explicit markers (S01–S04) — security core

| Finding | Change | Test |
|---|---|---|
| S01 automation flag from `--remote-debugging-port=0` ([launch.ts](../browser/src/launch.ts)) | Pick a free loopback port, pass it explicitly, retry on bind failure; keep the relay's authentication | Diag page shows `webdriver === false` in headful mode; launch, relay, auto-attach and gate tests unchanged |
| S02 `data-cb-ref` and `data-cb-clickable` on live elements ([page.ts](../browser/src/page-scripts/page.ts)) | Refs live in an isolated-world `Map<number, WeakRef<Element>>`; typing, clicking and overlay checks resolve elements by object handle (`Runtime.callFunctionOn`), not attribute selectors ([pool.ts](../browser/src/pool.ts) `type`); detached elements rejected via `isConnected` | Mutation log shows no writes after read, collect, find-by-text or a refused click; [page-scripts.test.ts](../browser/test/page-scripts.test.ts) asserts the attributes are absent; stale-ref tests pass |
| S03 fixed-ID cosmetic `<style>` | Inject cosmetics with `CSS.createStyleSheet` + `CSS.setStyleSheetText` (inspector origin); fallback: no ID, document what remains | No named node in the mutation log; `document.styleSheets` contents recorded; bait fixture shows hiding still works |
| S04 main-world `document.title` and frame facts ([pool.ts](../browser/src/pool.ts) `nav`, `facts`) | `createIsolatedWorld` takes a frame id and per-frame session, including out-of-process iframes; context recreated on navigation, never falls back to the main world | Main-world hooks record zero calls; a protocol spy fails the suite if any production `Runtime.evaluate` lacks `contextId` |

## PR D: faithful takeover (S10, S12, S13, S15–S18)

- **S13:** remove `emulate("mobile")` from `takeoverTab`, the popup handler and `endTakeover` ([agent.ts](../server/src/agent.ts)). Popups inherit the site's device. The viewer letterboxes using the stream's metadata.
- **S12:** in mobile mode, apply the full emulation (user agent, client hints, metrics, touch) to every child target in the gate's auto-attach, including workers; input arrives as `Input.dispatchTouchEvent`. Desktop GPU and fonts stay Linux, consistent with D2.
- **S17:** replace `TakeoverInput` in [shared](../shared/src/index.ts) with the ADR 0016 schema: pointer down, move, up and cancel with `pointerType`; touch points; wheel `deltaX` and `deltaY`; keys with modifiers; composition start, update and end; per-event relative timestamps; rate cap.
- **S15:** forward pointer events from the viewer image, including movement while pressed, preserving down/up timing.
- **S16:** capture typing through a hidden input with `beforeinput` and composition events, forwarded as key or composition events. The "Send" field stays for password-manager fills (whole-string insertion is how those behave anyway). No key data or text in logs.
- **S18:** forward native wheel and touch scroll gestures; the arrow buttons stay as an accessible fallback.
- **S10:** a foreground lease in the pool. Takeover holds it; agent calls on that tab return busy; the screencast never calls `bringToFront` on a tab leased to someone else. Same-profile agent sessions get their own window (ADR 0017); if the Xvfb check failed, they act in the background with honest reporting until revisited.

Tests: device snapshots identical before claim, after popup adoption, after failed verification and after hand-back; event traces under added latency, disconnect and popup switch show no stuck buttons and no replay into a new tab; agent tokens refused on the input route.

## PR E: agent input and budgets (S05–S09)

- **S05:** pointer moves from its last position to the target along a short path, presses, holds for a bounded time, releases. `checkPoint` re-runs immediately before the press; the hit point stays inside the verified element.
- **S06:** scroll the target into view only if it isn't already hittable, using wheel events; recompute geometry afterwards.
- **S07:** focus by clicking when possible; characters that a keyboard can produce go as key events; others go as insertion. Target rechecked after focus. Typing into credential fields allowed per D1 when the category is on.
- **S08:** scroll step and position derived from viewport and device; progress waits on readiness (item growth or a short network idle), not a fixed sleep; mobile mode uses touch scroll. Every server cap stays.
- **S09:** `Pacer.reserve()` replaces the separate check and record ([pace.ts](../server/src/pace.ts)); applies to every navigation-producing action (open, click that navigates, back, scroll pagination). "Follow link" clicks the ref instead of opening the URL, so the referrer is real. No forged referrers or history.

## PR F: site compatibility (S19–S22)

- **S19/S20:** challenge and sensor endpoints get narrow, typed read allowances per vendor in `detect/` (and per site in adapters), each with a fixture showing the neighbouring write is refused. While a challenge ticket is open, those allowances still apply so the challenge script can finish.
- **S21:** service and shared workers are owned by origin and profile and get the strictest policy of the tabs they serve; unowned writes stay fail-closed.
- **S22:** per-site person setting "no ad blocking" (already allowed by ADR 0003), plus an automatic exemption for vendor challenge and fraud scripts listed in `detect/`, covering both request and cosmetic blocking.

## PR G: environment consistency (S14, S27, S31–S35)

- **S14:** headful is the default everywhere, including [server/main.ts](../server/src/main.ts); headless remains for tests only. Remove the hard-coded client-hint metadata; derive versions from `Browser.getVersion`.
- **S31 (D2):** install Mesa in the browser image and start Chromium with ANGLE on llvmpipe; verify WebGL is present (not absent, which is worse) and the renderer string is llvmpipe. Add common desktop font families (e.g. DejaVu, Noto Color Emoji) where missing.
- **S32:** Xvfb screen and window size consistent (e.g. 1920×1080 screen, maximized window); a minimal window manager if needed so outer/inner window values look normal.
- **S33:** owner-set timezone and language in settings, applied as `TZ`, `LANG` and `--lang` on the browser container (native, reaches workers), plus the matching `Accept-Language`.
- **S34:** pin the Chromium package version in the Dockerfile; deterministic Chrome for Testing directory choice; regenerate the Harbor Dockerfile through its generator.
- **S27:** stop swallowing failed cookie-control calls; check that partitioned (CHIPS) cookies work, since sites expect them.
- **S35:** profile volumes survive upgrade; check that no production path launches with a temporary profile.

## PR H: boundary-caused triggers (S23–S30, S36), ADR first

Each item gets an ADR proposing the scoped alternative; code follows only after owner review.

| Finding | Current trigger | Proposed path |
|---|---|---|
| S23 interception latency | Every request pauses in the gate | Profile and speed up the allow path; keep full coverage |
| S24 all WebSockets fail | Sites using sockets (chat, live updates, some challenge SDKs) break | DNR dynamic allow rules for the top-level site's own domain group on sites at `read_as_you` or above, untainted sessions only; socket opens logged. A real security trade-off (the gate can't see socket payloads): owner decides |
| S25 no HTTP/3 | Weak signal | Keep; revisit only if a site measurably flags it |
| S26 WebRTC UDP blocked | Missing ICE candidates | Keep; if a site needs WebRTC, TURN over TCP through the proxy |
| S28 permissions pre-denied | `denied` with no prompt is unusual for a fresh profile | Default to "ask"; prompts are dismissed automatically (state stays `prompt`); a person can grant per origin |
| S29 pings, prediction, prerender off | Missing ping and prefetch traffic | Re-enable each feature whose requests the gate and proxy already see (tested per feature); keep anything that bypasses them |
| S30 agent popups closed | OAuth and "Sign in with…" flows break for agents | Popups opened by a gesture in an owned tab become owned tabs under the same gate and taint; downloads and printing stay off |
| S36 egress differs from the owner's | Data-centre IP and resolver | Document: deploy at home (Harbor) so egress is the owner's own connection |
| S11 extraction workload | Possible main-thread stalls | Profile on large fixtures; cut repeated layout reads |

## Done

Each PR is done when its diagnostic-page trigger is gone (or measured and documented if it can't be removed), the before/after snapshots are committed, and every existing security suite passes.
