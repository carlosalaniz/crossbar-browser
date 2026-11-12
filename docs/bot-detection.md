# How bot detection works, and where Crossbar shows up

Audience: the owner. This explains the mechanisms, so decisions about Crossbar's behaviour (and any ADR) rest on how detection really works. It is background, not a settled decision.

Items marked **(code)** were checked against this repo. Everything else is how fraud vendors (Akamai, F5/Shape, Kasada, DataDome, ThreatMetrix, BioCatch, and in-house bank systems) generally work. Vendors don't publish their rules, so details vary and change.

## 0. The model: a risk score, not a bot test

Banks rarely ask "is this a bot?". They compute a **risk score** per request or session from many weak signals, then pick an action: allow, step-up (OTP, security question), challenge, or block/lock the account.

Three layers run at once:

| Layer | Where it runs | What it sees |
|---|---|---|
| Edge / network | CDN or WAF in front of the bank | IP, TLS handshake, HTTP headers, request rate |
| Client-side sensor | JavaScript the bank serves to the page | Browser and device properties, input events, timing |
| Server-side account | The bank's own backend | Device history, login history, behaviour on this account |

Two things matter more than any single signal:

1. **Consistency.** Every property is cross-checked against the others. A Windows UA with Linux fonts, or a claimed GPU whose rendering output doesn't match it, scores worse than an honestly odd but self-consistent browser.
2. **Absence.** The sensor script *must* phone home. If its data never arrives, that is itself a strong signal. This is the most important point for Crossbar, because its own safety machinery can cause it (section A).

## A. Crossbar breaking the bank's sensors

### A1. The network gate holds sensor POSTs

How the vendor works: the sensor script collects data, then sends it with a POST to an endpoint on the bank's site or a vendor subdomain (Akamai `sensor_data`, ThreatMetrix profiling, BioCatch telemetry). The backend then expects that data with the login or transaction request. No data, or stale data, means a high score.

Crossbar side: **(code, AGENTS.md)** the gate holds non-GET requests not on the site's read list, and on signed-in sites any unknown non-GET asks. After 20 s the held request fails. The result is a session where the sensor ran but its data never reached the bank.

Fix direction: put each bank's telemetry endpoints in the adapter's read operations, with a test that fixtures the request.

### A2. Taint blocks third-party fraud domains

How the vendor works: fingerprint collectors often live on the vendor's own registrable domain (for example ThreatMetrix's `online-metrix.net`) so one vendor can correlate across many banks.

Crossbar side: after a signed-in read, a request carrying data to a domain the session hasn't used asks first. A fingerprint beacon is exactly that. It gets held or denied, which is the same failure as A1.

Fix direction: the bank's domain group includes its fraud vendors. This is the adapter's job, not a change to `browser/`.

### A3. Ad blocking removes fraud scripts

How the vendor works: fingerprinting and tracking scripts are what EasyPrivacy and similar lists target. Some bank-side fraud scripts are on those lists, because they use the same techniques. Anti-adblock or anti-bot scripts also plant "bait" elements (class names like `ad-banner`) and check whether they got hidden.

Crossbar side: ADR 0003 turns ad blocking on by default. Request blocking in the gate drops the script. Cosmetic hiding trips the bait check.

Fix direction: default off for banking sites. The ADR already allows it per site.

### A4. WebSockets are always refused

How the vendor works: some fraud SDKs, chat, and live-session tools open a WebSocket. A handshake that always fails is not something a normal browser does.

Crossbar side: **(code)** ADR 0010 blocks all handshakes with a declarative net request rule from an extension.

### A5. `data-cb-ref` attributes in the live DOM

How the vendor works: the page's JavaScript and the extension's isolated-world JavaScript are separate, but they share one DOM. A fraud script can run `document.querySelector('[data-cb-ref]')`, or observe attribute mutations with a `MutationObserver`. Bot frameworks leave known marks (Selenium's `$cdc_` variables, Puppeteer's injected attributes), and vendors keep lists of them.

Crossbar side: **(code, `browser/src/page-scripts/page.ts`)** `data-cb-ref` and `data-cb-clickable` are written onto the page's elements. This is the one marker unique to Crossbar, so it's the easiest to fingerprint after one Crossbar user is caught.

Fix direction: keep the ref map outside the DOM (a `WeakMap` in the isolated world, plus `DOM.resolveNode` or `backendNodeId` for the later action), or use attribute names that are randomised per session.

### A6. The Fetch round trip and delayed workers

How the vendor works: timing probes measure how long subresources take and whether workers start on schedule. Pausing every request through CDP adds a consistent per-request delay.

Crossbar side: **(code, `gate.ts`)** `Fetch.enable` on `*` plus `waitForDebuggerOnStart` for every target. This is also what makes the gate authoritative, so it can't be dropped. The signal is weak, and the cost is modest.

### A7. Service workers bypassed

How the vendor works: some banks register a service worker that handles device binding or token refresh. A service worker that never receives a fetch event is unusual.

Crossbar side: **(code, `gate.ts:161`)** `Network.setBypassServiceWorker` when the option is set.

## B. Browser and environment fingerprint

A fingerprint script reads dozens of properties, hashes them, and compares the hash with the bank's history for your account. A *new* hash isn't automatically bad (browsers update), but a hash that is implausible or inconsistent is.

### B1. WebGL and GPU

How it works: the script creates a canvas, reads `WEBGL_debug_renderer_info` for the vendor and renderer strings, then reads:
- the supported extension list
- parameter limits (max texture size, max vertex attributes)
- shader precision formats
- the actual pixels of a rendered scene, hashed

A GPU is a very specific combination of all of these. Software rendering (SwiftShader, llvmpipe) is recognisable, and common in VMs, containers and headless fleets.

Why changing the strings alone is weak: the strings are only one of several outputs. The extensions, limits and pixel hash all come from the real renderer. Vendors compare them with what the claimed GPU produces. A mismatch is a "tampering" signal, usually weighted worse than honest software rendering.

Crossbar side: Xvfb has no GPU, so headful Chromium renders in software. RAM isn't the issue; software rendering costs CPU. A GPU passed through (`/dev/dri`) fixes the signal at its source.

### B2. Linux in a container

How it works: `navigator.platform`, the UA, the installed fonts (measured by drawing text and reading its width), `AudioContext` behaviour, `enumerateDevices()`, the battery API, and sensors all describe the OS and hardware.

Crossbar side: a bare container has few fonts, no audio device, no media devices. Almost no bank customers use desktop Linux, and it won't match the device the bank has on file for you. Installing real fonts and a dummy audio device is straightforward.

### B3. Screen and window geometry

How it works: scripts compare `screen.width/height`, `screen.availWidth/availHeight`, `window.outerWidth/outerHeight` and `innerWidth/innerHeight`. On a real desktop the available height is smaller than the screen (taskbar), the outer window is bigger than the inner (title bar and borders), and `devicePixelRatio` fits the display. Headless defaults often break all of these (outer equals inner, no chrome).

Crossbar side: **(code, uncommitted diff)** `--window-size=1280,800` inside a 1280x1024 Xvfb screen, with device-metrics emulation cleared. That's more self-consistent than before, because the page's own measurements now come from one source.

### B4. Chromium or Chrome for Testing, not Google Chrome

How it works: Google Chrome ships proprietary codecs (H.264, AAC) and Widevine DRM. Scripts call `MediaSource.isTypeSupported`, `canPlayType`, and `requestMediaKeySystemAccess`. A browser claiming to be Chrome but failing those is Chromium.

Crossbar side: `--load-extension` works only in Chromium or Chrome for Testing, which is why ADR 0010 requires them. Switching to branded Chrome would need a different way to block WebSockets.

### B5. User-agent and client hints

How it works: modern Chrome sends `Sec-CH-UA`, `Sec-CH-UA-Platform`, `Sec-CH-UA-Mobile`, and (when asked) high-entropy hints like platform version and architecture, and exposes `navigator.userAgentData`. The UA string, the hints, the JS values and `navigator.platform` must all agree. A UA override through CDP without matching metadata wipes the hints entirely, which is a classic tell.

Crossbar side: **(code, `pool.ts`, uncommitted diff)** when the browser is headless, it replaces `HeadlessChrome` and sets matching metadata. Things to watch: the GREASE brand is hardcoded (real Chrome derives it from the version), and `platformVersion` and `architecture` are empty. Production runs headful, where none of this runs, so those are only a risk if `CROSSBAR_HEADLESS=1`.

### B6. Mobile emulation

How it works: a mobile profile claims touch support, a small screen, a mobile UA, and sensors (accelerometer, gyroscope, orientation events). Real phones also have specific GPUs, fonts, and screen densities.

Crossbar side: ADR 0006 allows a "complete, consistent" mobile profile, but CDP emulation changes only part of that picture. The GPU, fonts, and missing motion sensors still say desktop.

### B7. Disabled features

How it works: scripts probe APIs that exist in stock Chrome (`document.browsingTopics`, `speculationrules`, and so on). Missing ones narrow down the build.

Crossbar side: **(code, `DISABLED_FEATURES` in `launch.ts`)** many are turned off for the security model. This is a small signal on its own.

### B8. `navigator.webdriver` and automation flags

How it works: the spec says a browser under automation sets `navigator.webdriver = true`. Chrome sets it when launched with `--enable-automation` or in some headless modes. Scripts also look for `window.cdc_*`, `window.__playwright`, `window.callPhantom`, and similar.

Crossbar side: launching with `--remote-debugging-port` and no `--enable-automation` leaves it `false` in headful mode. Add a test that pins it.

### B9. Hooks into the Chrome DevTools Protocol itself

How it works: some detectors infer that a debugger is attached. `Runtime.enable` makes console arguments get serialised, which can be observed through side effects such as an object's `stack` getter being touched when it is logged. Playwright and Puppeteer enable `Runtime` by default; this is a well-known detection.

Crossbar side: ADR 0009 uses an in-house CDP client and creates an isolated world with `Page.createIsolatedWorld`, so Crossbar can avoid `Runtime.enable` on the main world. Worth a test: verify no `Runtime.enable` is sent for the page's main world.

## C. Network

### C1. IP reputation

How it works: the edge looks up the client IP in reputation databases. A **datacenter ASN** (AWS, Hetzner, DigitalOcean) gets a heavy penalty for consumer banks. Residential and mobile IPs are trusted. Banks also build their own history of which IPs your account has used.

Crossbar side: a home server is fine. A VPS isn't. (Residential proxy pools are on the Never list.)

### C2. Geography and locale consistency

How it works: IP geolocation is compared with `Intl.DateTimeFormat().resolvedOptions().timeZone`, `navigator.language(s)`, and the `Accept-Language` header. A UTC container in a "Chicago" IP is a mismatch.

Crossbar side: set the container's timezone and locale to match the exit.

### C3. TLS and HTTP fingerprints

How it works: the TLS ClientHello (cipher order, extensions, ALPN) is hashed as **JA3/JA4**, and HTTP/2 settings and header order are hashed as an Akamai-style fingerprint. Each browser family has a characteristic value. A Python `requests` client is recognised instantly.

Crossbar side: the browser's own stack makes the ClientHello, so its fingerprint is Chrome's. The **proxy** matters, though: an HTTP CONNECT proxy tunnels the browser's TLS untouched, which keeps it authentic. A proxy that terminates TLS and re-originates the connection would replace Chrome's fingerprint with the proxy's. The current proxy design (DNS, IP rules, then connect to the checked IP) should keep tunnelling; add a test pinning that.

### C4. No HTTP/3

How it works: Chrome upgrades to QUIC after seeing `Alt-Svc`. A Chrome that never does is slightly unusual. Weak signal.

Crossbar side: `--disable-quic` is a security requirement (UDP would skip the proxy).

### C5. WebRTC

How it works: WebRTC can reveal local and public IPs through ICE candidates, bypassing a proxy. Scripts use that to find the real IP.

Crossbar side: `disable_non_proxied_udp` removes it. A browser with WebRTC limited that way resembles a VPN user. Weak signal.

### C6. DNS

How it works: some vendors serve unique subdomains and see which resolver asks, comparing its location with the client IP.

Crossbar side: the proxy resolves DNS itself, so the resolver's location may differ from the exit. Low priority.

## D. Behaviour

Behavioural biometrics (BioCatch is the best known; Akamai and others have versions) model *how you use the page*. They collect events, build features, and compare them with your history and with human and bot populations.

### D1. Typing

What's collected: per-key `keydown`/`keyup` times, dwell (key held), flight (gap between keys), rhythm, error and backspace rate, paste events.

Crossbar side: **(code, `input-guard.ts:85`)** `Input.insertText` puts the text in without key events. No keydown, no timing. The field value changes with a single `input` event. This is among the clearest bot signals, because real people can't do that, apart from paste or autofill (which also have their own signatures).

### D2. Mouse and pointer

What's collected: movement paths (curvature, speed, acceleration, overshoot), the time hovering before a click, press duration, click position inside the element (humans don't hit exact centres), and whether the pointer moved before the click.

Crossbar side: **(code, `pool.ts`, click)** one `mouseMoved` to the target, then press and release back to back. There's no path, and a press of zero duration, at a deterministic point.

### D3. Focus

What's collected: how a field got focus (a click first, Tab, or script).

Crossbar side: `DOM.focus` focuses fields programmatically with no pointer event before it.

### D4. Scrolling

What's collected: wheel delta sizes, intervals, momentum and easing (trackpads send smooth decaying events), direction changes.

Crossbar side: ADR 0004 uses real wheel events but at a *steady* pace. Steady is itself the signal, because humans are irregular.

### D5. Navigation and session shape

What's collected: the page sequence, referrers, dwell time before first interaction, time of day, and how fast pages are read.

Crossbar side: an agent can open a deep URL directly with no referrer, act within milliseconds of load, and run at odd hours. Each is weak alone, but together they describe a script.

### D6. Visibility and focus state

What's collected: `document.hidden`, `visibilitychange`, window focus and blur events, and `requestAnimationFrame` timing (background tabs get throttled).

Crossbar side: acting in a tab that was never focused or visible is odd.

## E. Human takeover looks automated too

**(Design issue, not code.)** When you take over to log in, your input travels phone, then app, then browser host, then CDP `Input.dispatch*`. The bank sees: coordinates scaled from a phone screen, events batched by the stream, delay between press and release shaped by the network, and (if you tap) touch-like single-point input on a desktop browser. This is the moment banks score hardest, and the one where signals from section D matter most.

## F. Account-level

- **New device.** The first login from an unknown device ID or cookie set triggers step-up (OTP, email link). Wiping or rebuilding the personal profile triggers it again. Expect it and route it as a `verification` ticket (ADR 0011).
- **Concurrent sessions.** Being logged in on your phone from one IP and Crossbar from another can end a session or flag the account.
- **Schedules and volume.** An hourly balance check at fixed intervals looks like an aggregator. Some banks prohibit that in their terms. The Charter already forbids scheduled extraction.

## What this means

1. **The highest-value fixes are ones that stop Crossbar hurting itself** (A1-A5), plus real input (D1-D4). These don't depend on guessing a vendor's rules.
2. **Environment fixes (B, C) are cheapest when real, not faked.** A real GPU, real fonts, a real audio device, a home IP, and a matching timezone.
3. **A vendor compares everything.** Any property you set by hand must agree with every other property it relates to. A partial lie costs more than none.
4. **E and F can't be engineered away.** They are the bank doing its job. Plan for step-up checks.

## Boundary with the Charter

This document explains how banks detect automation. Whether and how far Crossbar should reduce detection is a policy decision for the Charter and an ADR, not for this page. Any such change should keep the six Never items (captcha solving, proxy pools, many accounts, bulk crawling, paywalls, eval/raw CDP/cookie export) intact: the line is one person's browser, not anything that scales.
