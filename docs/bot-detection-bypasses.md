# How automation addresses each bot-detection signal

Research companion to [the original detection inventory](bot-detection.md). This is a new background document, not an ADR, implementation plan, or claim that Crossbar already implements these techniques. The original document is unchanged.

**Research date: 12 November 2026.** Public browser documentation, automation-project documentation, and vendor research were retrieved for this review. “Current” means the mechanisms documented by those sources at review time, not a verified success rate against a particular bank. No protected website was tested, no bank account was accessed, and no bypass benchmark was performed.

## How to read this

- **Documented mechanism:** an upstream browser or automation project exposes the capability. This does not establish that a vendor cannot detect it.
- **Engineering inference:** the approach follows from how the signal works, but the cited source does not demonstrate a successful production bypass.
- **No general bypass:** browser-side changes cannot reliably remove the relevant server-side decision.
- **Bypass versus repair:** letting a real sensor run, keeping a profile, or using the actual device often removes a self-inflicted anomaly. That is different from forging telemetry, impersonating another device, or defeating authentication.

Each A–D item maps one-to-one to the original inventory. E is split into its four takeover input types; F into its three account-level signals. References identify evidence for capabilities, not endorsements of advertising claims.

**Crossbar boundary:** the [project's exclusions](../README.md:13), [device-emulation decision](decisions/0006-device-emulation.md:6), [human challenge resolver](decisions/0001-challenge-resolver-seam.md:10), and [human-only step-up verification](decisions/0011-verification-challenge.md:13) still apply. Describing an external technique does not authorize adding it. In particular, automated CAPTCHA solving, rotating/residential proxy pools, many-account operation, bulk crawling, paywall circumvention, and agent access to raw browser execution or cookie export remain outside scope.

## 0. Bypassing a signal is not bypassing a risk score

**What automation does:** combines several layers: a full browser to execute challenges and sensors; a coherent device environment; persistent session state; a suitable network path; and less mechanical input. Anti-detect projects additionally patch browser properties or browser internals. Cloudflare documents separate heuristic, machine-learning, and JavaScript detection engines, illustrating why removing one indicator is insufficient. [S1] [S2] [S3]

**Limit:** a detector's public test page is not the bank's account-risk model. Passing it says nothing conclusive about account history, fraud rules, transaction checks, or a different browser release. A sensor that runs successfully can still report automation.

**Crossbar relevance:** prefer fewer artificial inconsistencies, but keep the security gate and human approvals. A challenge is an expected outcome, not proof that every browser property needs spoofing.

## A. Crossbar interfering with site sensors

### A1. The network gate holds sensor submissions

- **Mechanism used:** ordinary full-browser automation lets the site's own JavaScript collect and submit its own telemetry. Network-routing APIs can continue approved traffic rather than aborting it. This avoids the “missing sensor” anomaly without having to reproduce a proprietary sensor format. **Documented routing capability; engineering inference about the risk reduction.** [S4]
- **What this does not bypass:** receipt is not acceptance. The server can reject stale, malformed, inconsistent, or low-confidence telemetry. Merely returning a successful response locally does not create server-side evidence. Forging vendor telemetry is a different, vendor-specific technique, not demonstrated by these sources.
- **Crossbar:** any compatibility repair must be narrowly reviewed and tested. Calling a submission “telemetry” does not prove it is read-only or safe: its payload can carry page or account data. Never broadly exempt sensor-looking requests from write approval or taint enforcement.

### A2. Taint blocks third-party fraud domains

- **Mechanism used:** full browsers ordinarily fetch and send data to the collector origins actually configured by the site. Automation with request controls can permit those known origins and preserve their normal cookies and request context. **Documented networking capability; engineering inference for fraud collectors.** [S4]
- **What this does not bypass:** a domain allowlist cannot establish what data a collector may safely receive. Vendor domains may serve multiple customers or unrelated endpoints; redirects and domain changes also matter. A collector's participation does not mean the session is scored as human.
- **Crossbar:** external automation often lacks Crossbar's taint model. A domain-group change is therefore a security decision, not a free stealth improvement. Keep payload-bearing cross-domain requests subject to the existing policy; no automatic trust of arbitrary vendor hosts.

### A3. Ad blocking removes fraud scripts or hides bait elements

- **Mechanism used:** use a clean browser context without content-blocking extensions or custom request-abort rules, or disable the relevant blocking for the affected site. Its sensor and bait elements then behave as the site expects. **Documented browser/network control; inference about a particular site's bait.** [S4] [S5]
- **What this does not bypass:** turning blocking off removes an interference signal; it does not neutralize the sensor. A site may still identify automation from everything the now-working sensor collects. Cosmetic modifications and network blocking are separate and must both be considered.
- **Crossbar:** the [ad-blocking decision](decisions/0003-ad-blocking.md:6) permits per-site disabling. Changing a default or adapter requires a separate reviewed change; this document does not make one.

### A4. WebSockets are refused

- **Mechanism used:** ordinary browsers and automation frameworks support real WebSocket connections. Running without a blanket WebSocket blocker lets a legitimate SDK complete its connection and exchange messages. **Documented capability; inference that this removes a particular SDK failure.** [S4]
- **What this does not bypass:** a blocked connection is not universally proof of automation; corporate networks and privacy tools also interfere. Conversely, an open connection can carry sensitive data and writes that ordinary HTTP request interception does not control.
- **Crossbar:** its [WebSocket-block design](decisions/0010-websocket-block.md:6) exists precisely because the authoritative gate does not cover those handshakes. Do not disable that protection for appearance's sake. Scoped support needs its own security design and tests.

### A5. Automation markers in the live DOM

- **Mechanism used:** keep element references in automation-side state or private isolated-world JavaScript state instead of adding recognizable attributes to page elements. Frameworks also patch or remove recognizable globals. **Documented isolated-world separation and stealth patching; external reference storage is an engineering design inference.** [S6] [S7]
- **What this does not bypass:** isolated worlds separate JavaScript environments, **not the DOM**. Attribute additions, removals, and style changes remain observable by the page. Randomizing an attribute name only removes a fixed-name signature; the mutation pattern remains. Rebrowser's broad claim about avoiding mutation observers must not be read as hiding shared-DOM mutations. [S8]
- **Crossbar:** the original inventory identifies its [element-reference attributes](bot-detection.md:56). Avoiding unnecessary DOM writes is conceptually stronger than renaming them, but no ref implementation changes are made here.

### A6. Request-interception round trips and paused workers

- **Mechanism used:** automation that needs no request gate often avoids global interception. When interception is necessary, local handlers make decisions quickly and avoid long waits or external round trips. Browser-protocol interception and routing make this possible. **Documented mechanism; inference about reducing timing artifacts.** [S4] [S9]
- **What this does not bypass:** ordinary latency, CPU contention, extensions, and debugging also change timings. No public source here establishes a reliable vendor threshold or a guaranteed fingerprint for a small added delay. Fast interception is not invisible interception.
- **Crossbar:** it cannot take the common shortcut of dropping interception: coverage of every relevant target is a security invariant. Only bounded, measured optimizations that preserve fail-closed behavior are compatible.

### A7. Service workers bypassed

- **Mechanism used:** leave native service-worker behavior enabled and retain the associated profile storage. The browser protocol exposes an explicit switch for bypassing service workers, so automation need not enable it. Playwright also documents the interaction between service workers and network interception. **Documented capability.** [S4] [S9]
- **What this does not bypass:** registration and fetch handling are different. Bypassing service-worker handling does not necessarily make registration fail; it changes which requests it controls. Whether a site uses workers for device binding is site-specific, not established for all banks.
- **Crossbar:** the [original inventory already says this signal is absent](bot-detection.md:70). There is nothing to bypass if workers run normally. Preserving interception of worker-originated writes remains mandatory.

### A8. Third-party cookies blocked

- **Mechanism used:** use persistent browser storage and, where browser policy permits, allow the third-party cookies the site needs. Modern services can instead use partitioned cookies, which preserve state separately for each top-level site. **Documented persistent-storage and partitioning capabilities.** [S5] [S10]
- **What this does not bypass:** automation cannot make a partitioned cookie become a universal cross-site identifier. The service must support the relevant storage model. Privacy restrictions are common in genuine browsers; missing third-party cookies alone do not establish a bot or guarantee a new device identifier.
- **Crossbar:** persistence of permitted first-party state is useful independently of changing cookie policy. Relaxing privacy policy is not implied by this research, and broad cookie access is not a substitute for the taint gate.

## B. Browser and environment fingerprint

### B1. WebGL and GPU

- **Mechanism used:** run on actual GPU-backed hardware, or use an environment whose reported renderer agrees with its real graphics outputs. Anti-detect browsers also document engine-level control of graphics parameters; older stealth plugins patch exposed vendor/renderer properties. **Documented spoofing capabilities; real-hardware consistency is an engineering inference.** [S2] [S7]
- **What this does not bypass:** changing a renderer string does not change extension support, limits, shader precision, canvas pixels, or other rendering APIs. Engine-level patches can cover more surfaces, but public claims are not evidence that all cross-checks agree. Software rendering also occurs legitimately.
- **Crossbar:** actual GPU support avoids some fabrication, but availability depends on host and container platform. A virtual display is not itself proof that Chromium has no GPU; verify the selected renderer on the deployed machine. Do not claim a hardware fingerprint based on a string override alone.

### B2. Linux/container environment

- **Mechanism used:** execute automation on the intended OS with real fonts, a desktop environment, and ordinary device services; alternatively use coherent browser-engine fingerprint profiles. Camoufox documents controls covering navigator properties, fonts, and other surfaces. **Documented patch capabilities; the real-environment approach is an engineering inference.** [S2]
- **What this does not bypass:** adding fonts or a dummy audio service does not turn Linux into Windows or recreate the account owner's device. Fonts, audio rendering, device permissions, CPU characteristics, and graphics can still disagree. A fingerprinting library's published source illustrates the variety of inputs, not a bank's exact rules. [S11]
- **Crossbar:** an honest, stable Linux identity may be preferable to a partial imitation. The original inventory's claims about how rare Linux is among a bank's customers are not a measured statistic in this review.

### B3. Screen and window geometry

- **Mechanism used:** run a real browser window in a desktop session, or coordinate viewport, screen dimensions, pixel density, touch mode, and window sizing through supported emulation. **Documented emulation capability.** [S3] [S9] [S12]
- **What this does not bypass:** setting the viewport alone does not necessarily set outer-window dimensions, display work area, browser chrome, or every frame's environment. Kiosk/fullscreen and unusual desktops are genuine exceptions; equality between two dimensions is not conclusive. Modern headless Chrome shares the headful implementation, so old headless geometry tests require retesting. [S3]
- **Crossbar:** measure actual values in the pinned deployment rather than infer them solely from launch arguments. Prefer consistency over forcing a fashionable screen size.

### B4. Chromium / Chrome for Testing versus branded Chrome

- **Mechanism used:** automation frameworks can run installed branded browser channels when native codecs or product behavior matter. Some stealth plugins instead emulate selected codec-support answers. **Documented browser-channel support and patching.** [S7] [S13]
- **What this does not bypass:** a positive capability answer is not successful media decoding or DRM playback. Chromium and Chrome for Testing are not interchangeable labels for every media capability; packaging, platform, licenses, and browser release matter. Widevine failure alone is not a universal build classifier.
- **Crossbar:** the extension-loading restriction is real: Chrome's announcement removed the command-line extension-loading path from branded builds starting with version 137, while preserving it in Chromium and Chrome for Testing. The [existing browser-pinning design](decisions/0010-websocket-block.md:14) must not be discarded merely to change product branding. [S14]

### B5. User-agent and client hints

- **Mechanism used:** preserve the browser's native identity, or coordinate the user-agent string, platform, language, and structured client-hint metadata using supported browser controls. Broader anti-detect implementations try to keep the JavaScript-visible properties consistent as well. **Documented capabilities.** [S2] [S9] [S15]
- **What this does not bypass:** changing the text does not change rendering, OS internals, or network behavior. High-entropy hints are negotiated, have origin/delegation rules, and are not expected on every request. GREASE brands are intentionally variable; absence or a particular brand order is not a universal detector.
- **Crossbar:** native desktop values avoid many manual guesses. Mobile/headless overrides need release-specific consistency checks across headers, scripts, frames, and workers; a matching pair of strings is insufficient.

### B6. Mobile emulation

- **Mechanism used:** device presets coordinate viewport, scale, user agent, and touch behavior; real-device automation operates Chrome on an actual Android device. Playwright documents both device emulation and experimental Android support. **Documented capabilities.** [S12] [S16]
- **What this does not bypass:** desktop emulation is not a physical phone. It does not automatically supply the phone's GPU, fonts, motion sensors, OS behavior, or input history. An Android emulator also has its own hardware differences; real-device automation can still be detected behaviorally.
- **Crossbar:** touch emulation is not touch input. A mobile claim accompanied only by desktop mouse actions is incomplete, although real phones can have external input devices. Use the [complete-profile requirement](decisions/0006-device-emulation.md:6) as a constraint, not evidence that the current profile is complete.

### B7. Disabled browser features

- **Mechanism used:** ordinary automation can run a standard supported browser without unnecessary disabling flags. Anti-detect software may patch API exposure, but that only changes the surfaces it actually implements. **Documented browser-channel support; inference about minimizing unusual configuration.** [S13]
- **What this does not bypass:** API availability changes with browser release, origin trials, permissions, context security, enterprise policy, and deprecation. A missing API is not automatically an automation flag, and the APIs named in the original inventory should not be assumed to remain present forever.
- **Crossbar:** keep features disabled where the security model requires it. Pretending an API exists without implementing its behavior can add inconsistencies. Do not trade a security boundary for an unmeasured fingerprint improvement.

### B8. Automation flag and framework globals

- **Mechanism used:** stealth patches alter the exposed automation indicator and known framework properties; other tools avoid WebDriver and control a browser directly over CDP. Nodriver documents that architectural approach. **Documented techniques, not proof of invisibility.** [S7] [S17] [S18]
- **What this does not bypass:** CDP is still automation, and a page can inspect other properties and behavior. Getter replacement can itself leave differences in descriptors, prototypes, or frames. MDN documents that the debugging-port value matters: port zero can enable the indicator in Chrome. [S17]
- **Crossbar:** do not generalize “CDP leaves the flag false” to every launch mode. Test the exact pinned headful and headless configurations. Chrome also restricts remote debugging of its default profile; a separate dedicated profile is the documented automation path, not unrestricted attachment to the user's regular browser. [S19]

### B9. CDP side effects and main-world hooks

- **Mechanism used:** patched frameworks reduce automatic runtime-domain subscriptions and use alternate execution-context discovery; isolated worlds avoid many page-installed JavaScript hooks. OS-level visual automation can avoid browser-protocol execution entirely. **Documented capabilities.** [S6] [S8] [S20]
- **Important update:** the classic console-error stack-getter probe in the original inventory is historical, not a reliable current universal test. Castle reports that V8 changes from May 2025 stopped inspector previews from invoking user-defined error getters, breaking that specific technique. This does **not** prove all CDP side channels are gone, and older/pinned builds can differ. [S21]
- **What this does not bypass:** isolated worlds do not hide DOM mutations, network actions, or input behavior. Briefly enabling and disabling a runtime subscription still has a timing window. OS-level input avoids one instrumentation family but adds coordinate, accessibility, and synchronization limitations.
- **Crossbar:** keeping browser evaluation out of the main world reduces exposure to page hooks and aligns with the [CDP-client design](decisions/0009-cdp-client.md:10). The original inventory's claims about current code paths are inherited observations, not a fresh code audit in this document.

## C. Network

### C1. IP reputation

- **Mechanism used:** run the owner's browser on their normal connection. External scraping systems also advertise residential/mobile proxy services or pools; that changes the apparent egress address, not the browser's identity or the account's history. **Engineering inference for reputation; proxy configuration itself is documented.** [S1] [S4]
- **What this does not bypass:** “residential” is not a guarantee of trust, and “datacenter” is not a guaranteed rejection. Shared NAT, VPNs, previously abused addresses, account history, and request patterns all affect decisions. Changing addresses repeatedly can itself be anomalous.
- **Crossbar:** the owner's stable connection is compatible with the model. Residential/rotating proxy pools are not. Do not mistake a commercial proxy provider's marketing for independently measured bank acceptance.

### C2. Geography and locale consistency

- **Mechanism used:** configure timezone, locale, language headers, and any explicitly permitted location data coherently. Browser automation exposes timezone and locale emulation separately from the machine running the script. **Documented capability.** [S9] [S12]
- **What this does not bypass:** it does not move the egress IP or alter account travel history. Geography and language need not match exactly for a real person: travelers, multilingual users, and VPN users are ordinary. Overly exact fabricated alignment is not inherently more human.
- **Crossbar:** reflecting the owner's actual settings avoids arbitrary container defaults. Do not auto-spoof geolocation or add broad permissions simply to satisfy an assumed rule.

### C3. TLS and HTTP fingerprints

- **Mechanism used:** full-browser automation uses the browser's real network stack. Non-browser clients such as curl_cffi document impersonation of browser TLS and HTTP/2 fingerprints. A non-terminating tunnel preserves the browser's handshake; TLS interception replaces it with the intermediary's. **Documented impersonation capability; tunneling behavior is a protocol-level inference.** [S22] [S23]
- **What this does not bypass:** matching a TLS fingerprint does not execute JavaScript, create genuine sensor state, or reproduce account history. JA4 is not simply the same extension-order hash as JA3: it normalizes aspects of the handshake, including extension sorting. HTTP/2 settings and HTTP/3 behavior are additional surfaces. [S23]
- **Crossbar:** browser-originated HTTPS through its checked tunnel is the relevant design. Replacing browser requests with an impersonating HTTP client would not preserve its interaction or security semantics. A familiar fingerprint can still be associated with unwanted traffic.

### C4. No HTTP/3

- **Mechanism used:** normal browsers negotiate HTTP/3 when it is offered and the network permits it. Some impersonating HTTP libraries now document HTTP/3 support as well. **Documented capability.** [S22]
- **What this does not bypass:** many genuine networks block UDP, and traditional proxy paths may leave a browser on HTTP/2 or HTTP/1.1. Lack of HTTP/3 is therefore not a decisive bot test. Enabling a protocol does not solve reputation or client-side scoring.
- **Crossbar:** do not enable direct QUIC to improve appearance: the original inventory explains that it would bypass the required proxy path. Any future UDP-capable transport needs equivalent DNS, IP, taint, and logging enforcement, not just a browser flag.

### C5. WebRTC

- **Mechanism used:** automation can retain native WebRTC on the owner's actual network, restrict candidate exposure, or use a browser engine that patches reported WebRTC addresses. Camoufox documents protocol-level address spoofing. **Documented patch capability, not a verified leak-proof configuration.** [S2] [S24]
- **What this does not bypass:** ICE behavior, API support, and other traffic can still disagree with a claimed address. Modern privacy protections, including host-candidate obfuscation, mean WebRTC does not universally disclose a user's raw private IP. Restricted candidates are not uniquely an automation signal.
- **Crossbar:** preserving the no-unchecked-UDP boundary matters more than restoring every candidate type. An address returned to a script is not proof that all underlying traffic obeys the egress policy.

### C6. DNS resolver location

- **Mechanism used:** resolve names through the intended proxy/egress path instead of letting part of the browser resolve locally. Chromium documents proxy-side hostname resolution for SOCKS and warns that other browser components can still issue DNS lookups. **Documented behavior; location consistency is an inference.** [S25]
- **What this does not bypass:** resolver geography is not a reliable physical-location measurement. Public recursive resolvers, anycast, caching, and enterprise DNS introduce ordinary differences. Moving resolution does not guarantee that a vendor considers the path normal.
- **Crossbar:** keep authoritative resolution and post-resolution IP checks in the proxy. Do not create a browser-side resolver exception or trust a hostname without checking the actual destination address.

## D. Behavior

### D1. Typing

- **Mechanism used:** send character-by-character keyboard input instead of replacing the whole value, optionally with delays; OS automation can also produce normal keyboard interactions. Playwright explicitly documents sequential typing and keyboard events. **Documented capability.** [S20] [S26]
- **What this does not bypass:** a fixed delay is another pattern. Even randomized timing does not reproduce the account owner's learned rhythm, error behavior, or keyboard layout. Trusted browser-generated events are not proof of a human; script-dispatched events and browser input are different categories. [S27]
- **Correction to the original framing:** whole-string insertion is not inherently impossible for a person. The browser protocol specifically describes text insertion for IME/emoji input; paste, dictation, autofill, and accessibility workflows also vary. Missing key events are contextual evidence, not certainty. [S9]
- **Crossbar:** do not manufacture passwords, OTPs, or approval actions. Better input fidelity cannot change who is allowed to enter sensitive data.

### D2. Mouse and pointer

- **Mechanism used:** cursor generators produce curved paths, distance-dependent speed, noncentral hit points, overshoot, and delays. Ghost Cursor documents Bézier paths and Fitts's-law-based point generation; OS automation supports movement and easing. **Documented capabilities.** [S20] [S28]
- **What this does not bypass:** a library's recognizable path family may become a new fingerprint. Smooth curves, random jitter, or a decorative cursor do not establish user identity. Movement must also agree with mouse, touchpad, pen, or touch modality and with focus and timing.
- **Crossbar:** a “more human” click must remain inside the verified target and preserve element revalidation and approval facts. Random hit points cannot justify clicking a neighboring destructive control.

### D3. Focus

- **Mechanism used:** focus through a preceding pointer action or normal Tab navigation, rather than isolated programmatic focus. Frameworks and OS automation support those input sequences. **Documented capability.** [S20] [S26]
- **What this does not bypass:** programmatic focus is itself normal on many sites and with assistive technology. MDN notes that focus events generated through a programmatic focus operation may be trusted; a detector cannot equate “trusted focus” with a physical user. [S27]
- **Crossbar:** preserve coherent focus/input ordering where possible, but never treat that ordering as authorization to type into a restricted field. An extra click can have consequences and still needs the existing checks.

### D4. Scrolling

- **Mechanism used:** generate a series of wheel/touch gestures with varied intervals, distances, and acceleration rather than identical periodic jumps. Browser protocols expose scroll-gesture and wheel input; desktop automation exposes native scroll actions. **Documented primitives; the humanization strategy is an engineering inference.** [S9] [S20]
- **What this does not bypass:** arbitrary variation is not a measured human distribution. Mouse wheels, trackpads, keyboards, touchscreens, and accessibility tools differ substantially; one delta size is not universally “human.” Scrolling without plausible reading or pointer context can still look scripted.
- **Crossbar:** keep the server's item, token, and duration caps and the [scroll/extract design](decisions/0004-scroll-and-extract.md). Cosmetic irregularity must not become unbounded extraction or bypass duplicate handling.

### D5. Navigation and session shape

- **Mechanism used:** stateful automation follows actual site links and waits for relevant page readiness instead of issuing a rapid sequence of unrelated deep links. Some systems add task-dependent pauses or use visual, OS-level interaction. **Documented interaction primitives; risk reduction is an engineering inference.** [S20] [S26]
- **What this does not bypass:** random sleeps do not reproduce intent, a personal reading pattern, or a normal account history. Deep links and unusual hours also occur legitimately. A forged referrer is not equivalent to taking the site's navigation path. Behavioral vendors describe profiling whole sessions rather than one delay. [S29]
- **Crossbar:** enforce a human-scale workload rather than simulate a browsing history. Avoid unnecessary requests; do not generate cover traffic, scheduled extraction, or fake account activity.

### D6. Visibility and focus state

- **Mechanism used:** activate the target tab in a real browser window before interacting, and keep its actual visibility/focus behavior coherent. The browser protocol exposes tab activation; desktop automation operates the foreground application. **Documented capability.** [S9] [S20]
- **What this does not bypass:** patching one visibility getter does not reproduce animation scheduling, focus events, or all background throttling. Visibility and window focus are distinct: an unfocused window may still be visible. MDN documents these distinctions and background scheduling effects. [S30]
- **Crossbar:** a live stream is not itself evidence that the tab is foregrounded. Verify actual browser state, and do not change scheduling or visibility APIs just to contradict that state.

## E. Human takeover transported through automation

Human takeover is not an automatic anti-detection bypass: a real person can still arrive through an unusual input transport. The following address transport fidelity, not impersonating the account owner.

### E1. Taps

- **Mechanism used:** remote-control or automation transports preserve a coherent pointer/touch sequence, coordinates, and event ordering. Desktop control can use OS input; browser control can dispatch touch events when the environment actually represents touch. **Documented primitives; improved remote fidelity is an engineering inference.** [S9] [S20]
- **Limit:** a phone controlling a desktop browser does not magically turn that desktop into a phone. Network latency changes observed timing, and replaying a plausible gesture does not establish physical presence at the host.
- **Crossbar:** preserve honest input modality and bounded ordering; do not add fake movement merely to assert human presence. The person's action still passes through the same consequence and credential rules.

### E2. Typing and whole-string Send

- **Mechanism used:** remote tools can forward actual key/composition activity rather than collecting an entire field and inserting it later. Where text comes from a password manager or IME, insertion may be the honest representation. **Documented keyboard/text primitives; the transport redesign is an engineering inference.** [S9] [S26]
- **Limit:** a phone's native text field may not expose physical keystroke timing, and reconstructing it afterward invents evidence. Replacing a user's real autofill with fake per-character timing does not prove a more legitimate session.
- **Crossbar:** credential entry remains human-only. Any fidelity improvement must avoid logging secret values or per-key secret-bearing telemetry and must not give the agent access to it.

### E3. Enter, Backspace, and Tab buttons

- **Mechanism used:** send the browser's normal key-down/key-up sequence with correct key, modifiers, ordering, and focus. Browser and OS automation both support discrete keys. **Documented capability.** [S9] [S20] [S26]
- **Limit:** a valid key sequence does not authenticate a human; the same sequence is available to scripts. Transport retries can also duplicate an action unless the application handles them correctly.
- **Crossbar:** preserve what the person actually requested, without secretly adding submits or extra keys. Input correctness and approval authority are separate.

### E4. Arrow-button scrolling

- **Mechanism used:** forward actual scroll gestures where available, or honestly retain discrete button-driven scrolling as an accessibility/remote-control mode. Browser input APIs provide wheel and gesture primitives. **Documented primitives; transport choice is an engineering inference.** [S9]
- **Limit:** turning one button press into invented trackpad momentum does not recover the person's real gesture. Regular button increments can be legitimate, just as Page Down and accessibility tools are legitimate.
- **Crossbar:** improve usability without claiming that a person necessarily produces local-mouse-like behavior. A legitimate remote session can still require bank step-up verification.

## F. Account-level signals

### F1. New device

- **Mechanism used:** keep a dedicated persistent browser profile, its cookies, and local device state between authorized sessions. Complete required enrollment or step-up through the account owner's normal flow. Persistent-context APIs explicitly support retaining this state. **Documented capability; no general authentication bypass.** [S5]
- **What this does not bypass:** storage persistence does not clone hardware-bound keys, repair revoked sessions, or eliminate a server's right to challenge. Browser updates and risk events can trigger verification even with an unchanged profile. Copying cookies is not equivalent to establishing a trusted device.
- **Crossbar:** retain the owner's personal profile rather than rebuilding it, and route step-up to the person under the [verification decision](decisions/0011-verification-challenge.md:13). No agent cookie export, device-identity rotation, or MFA evasion follows from this research.

### F2. Concurrent sessions

- **Mechanism used:** serialize an automation task, reuse its intended session, and avoid unnecessary logins from different environments. This reduces self-created session churn. **Engineering inference, not a documented universal vendor bypass.** Persistent browser contexts provide the storage primitive, not control over the bank's session policy. [S5]
- **What this does not bypass:** the server can detect multiple tokens, device IDs, IPs, and overlapping activity. Matching IP addresses does not merge two sessions, and some services revoke an older session on a new login by design.
- **Crossbar:** coordinate the owner's use rather than imitate or suppress another device. If the site disallows concurrent sessions, accept that constraint; no browser patch can require the server to permit them.

### F3. Schedules and volume

- **Mechanism used:** legitimate clients stay within documented quotas, cache permitted results, back off on throttling, and prefer an approved API where available. Scraping systems also distribute traffic across identities or addresses, but that is outside Crossbar's scope. **Documented rate-limiting behavior; workload advice is an engineering inference.** [S31]
- **What this does not bypass:** jittering an hourly schedule does not change total volume, account-level aggregation, or the service's terms. A rate limiter can key on more than IP. There is no general browser-side way to override the server's limits.
- **Crossbar:** the existing prohibition on scheduled/bulk extraction still applies. Stop or ask the person when blocked; do not multiply accounts or egress addresses to continue.

## What the evidence actually supports

1. **Repairing interference is often more defensible than spoofing.** A1–A4 and A7 concern whether the site's intended mechanisms run. Their safe repair remains constrained by approval, taint, and egress rules.
2. **Native consistency beats isolated property patches.** Actual browser/network behavior and persistent authorized state address several signals at once. They do not make automation indistinguishable from a person.
3. **Protocol stealth and input fidelity solve different problems.** Removing framework markers does not create human behavior; realistic pointer motion does not fix missing telemetry or account history.
4. **Some original claims need qualification.** The classic B9 error-getter probe broke in newer V8; headless and headful Chrome now share an implementation; whole-string input can be legitimate; GPU, media, and visibility characteristics are platform/version-dependent.
5. **Authentication is not a fingerprint nuisance.** No mechanism here reliably bypasses a bank's account-risk decisions, MFA, or payment verification. Selenium's own guidance discourages automating 2FA and discusses test-environment arrangements, not defeating production authentication. [S32]

## Sources and evidence limits

All sources below were retrieved during this review. Browser/project documentation establishes supported mechanisms; project claims of being “undetectable” are **not** independently validated results. Mutable documentation and default branches can change; reproduce any future experiment with recorded browser/library versions and local fixtures. Crossbar behavior is taken from the original inventory and the linked ADRs, not independently re-audited here.

Search was attempted through public search pages and followed by direct retrieval of upstream documentation and project sources. The DataDome CDP article returned an access-denied response and is **not** used as retrieved evidence. The later Castle analysis was accessible and supplies the specific historical correction.

| Ref | Retrieved source | What it supports |
|---|---|---|
| S1 | [Cloudflare: bot scores and detection engines](https://developers.cloudflare.com/bots/concepts/bot-score/) | Layered scoring; heuristics, machine learning, and client-side detection. Not a disclosure of bank-specific weights. |
| S2 | [Camoufox documentation](https://camoufox.com/) | Project-documented engine-level fingerprint controls and consistency goals. Marketing claims are not bypass measurements. |
| S3 | [Chrome: unified Headless mode](https://developer.chrome.com/docs/automation-and-testing/headless) | Shared headful/headless implementation; distinction from the old headless shell. |
| S4 | [Playwright: network](https://playwright.dev/docs/network) | Routing, interception, proxies, WebSockets, and service-worker interactions. |
| S5 | [Playwright: browser type and persistent contexts](https://playwright.dev/docs/api/class-browsertype) | Dedicated persistent profiles, stored session data, and default-profile cautions. |
| S6 | [Chrome: content scripts and isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) | Separate JavaScript environments with access to a shared DOM. |
| S7 | [Puppeteer Extra stealth project documentation](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) | Examples of browser-property, codec, and framework-artifact patches; not current universal effectiveness. |
| S8 | [Rebrowser patches documentation](https://github.com/rebrowser/rebrowser-patches) | Runtime-subscription changes and alternate context-discovery approaches. Shared-DOM visibility still applies. |
| S9 | [Chrome DevTools Protocol: browser protocol definitions](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json) | Input, gestures, interception, isolated worlds, service-worker bypass, tab activation, identity and locale emulation primitives. |
| S10 | [MDN: partitioned cookies / CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies) | Per-top-level-site cookie state; not unrestricted cross-site recognition. |
| S11 | [FingerprintJS source and documentation](https://github.com/fingerprintjs/fingerprintjs) | Public example of collecting multiple browser fingerprint components. Not a proxy for a particular bank's detector. |
| S12 | [Playwright: emulation](https://playwright.dev/docs/emulation) | Device presets, viewport, touch mode, locale, timezone, and permission controls. |
| S13 | [Playwright: browsers](https://playwright.dev/docs/browsers) | Branded channels, browser packaging, and media-codec differences. |
| S14 | [Chrome team: extension-loading change announcement](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY) | Version-137 branded-build restriction and Chromium/Chrome for Testing exception. |
| S15 | [Chrome: User-Agent Client Hints](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints) | Structured hints, negotiation, secure contexts, GREASE, and origin scope. |
| S16 | [Playwright: Android](https://playwright.dev/docs/api/class-android) | Experimental real-device and emulator automation with stated limitations. |
| S17 | [MDN: browser automation indicator](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver) | Documented Chrome launch conditions for exposing the indicator, including debugging port zero. |
| S18 | [Nodriver project documentation](https://github.com/ultrafunkamsterdam/nodriver) | Direct-CDP automation without Selenium/WebDriver. Stealth claims are project claims. |
| S19 | [Chrome: remote-debugging security changes](https://developer.chrome.com/blog/remote-debugging-port) | Default-profile restrictions from Chrome 136 and dedicated-directory guidance. |
| S20 | [PyAutoGUI documentation](https://pyautogui.readthedocs.io/en/latest/) | OS-level desktop pointer, keyboard, timing, and scrolling primitives, with platform limitations. |
| S21 | [Castle: why the classic CDP detection signal stopped working](https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/) | August 2025 analysis of May 2025 V8 error-preview getter guards; a correction to one probe, not all CDP detection. |
| S22 | [curl_cffi project documentation](https://github.com/lexiforest/curl_cffi) | Browser-like TLS/HTTP fingerprints and documented HTTP/3 support; does not establish full browser equivalence. |
| S23 | [Cloudflare: JA3/JA4 fingerprints](https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/) | TLS fingerprinting and JA4 normalization, including sorting ClientHello extensions. |
| S24 | [MDN: WebRTC ICE candidate events](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/icecandidate_event) | Candidate gathering and exchange mechanics, not guaranteed IP disclosure. |
| S25 | [Chromium: SOCKS proxy and DNS behavior](https://www.chromium.org/developers/design-documents/network-stack/socks-proxy/) | Proxy-side resolution and warnings about other DNS/network paths. Not a guarantee about Crossbar's separate HTTP proxy. |
| S26 | [Playwright: input actions](https://playwright.dev/docs/input) | Sequential keyboard entry, delays, pointer actions, keys, and focus behavior. |
| S27 | [MDN: trusted events](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted) | Browser-generated versus script-dispatched events; programmatic focus can generate trusted events. |
| S28 | [Ghost Cursor project documentation](https://github.com/Xetera/ghost-cursor) | Bézier paths, distance/target-size modeling, overshoot, randomized hit points, and delays. No bank-specific efficacy proof. |
| S29 | [BioCatch: behavioral biometrics](https://www.biocatch.com/behavioral-biometrics) | Vendor-described session-wide interaction collection and historical behavioral analysis; exact rules are undisclosed. |
| S30 | [MDN: Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) | Visibility versus focus and background animation/timer throttling. |
| S31 | [Cloudflare: rate-limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) | Server-side thresholds, counting characteristics, and mitigation behavior. |
| S32 | [Selenium: two-factor authentication guidance](https://www.selenium.dev/documentation/test_practices/discouraged/two_factor_authentication/) | Discourages automating 2FA; test-environment alternatives are not production bypasses. |
