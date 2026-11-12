# Crossbar automation signals: current code and required changes

**Static audit date: 12 November 2026. Source snapshot: commit 0666218.** This document audits the current implementation, rather than repeating general vendor techniques from [the detection overview](bot-detection.md) or [the bypass research](bot-detection-bypasses.md).

**Scope:** browser launch and profiles; page scripts and input; request gating; server navigation, pacing and takeover; the web takeover interface; adapters; egress proxy; Docker and Harbor browser deployment. It lists 36 source-backed findings or conditional risks found across those surfaces. “All” here means the findings in this reviewed source snapshot, not a claim that every possible browser fingerprint has been enumerated.

**Evidence limitation:** code inspection confirms configuration and execution paths, not their exact output on every Chromium/platform combination. A Node/browser probe was blocked by the command-execution policy; no browser probe, vendor test, live bank access, or runtime test suite was run for this audit. All acceptance checks below are **proposed**, not passing test results.

## The answer in brief

Crossbar currently exposes recognizable page mutations, automation-oriented launch configuration, deterministic input, incomplete device emulation, and policy-induced networking differences. Human takeover retains several of these and adds a mid-session mobile-identity change and a lossy remote-input transport.

The highest-value changes are:

1. Stop writing Crossbar-specific element references and a fixed-name cosmetic style into the live page.
2. Fix the zero-valued remote-debugging launch configuration; **headful alone does not settle the automation-indicator question**.
3. Move remaining main-world inspection into isolated worlds.
4. Keep one coherent device identity across agent use and human takeover; do not turn a desktop browser into a claimed phone just because its viewer is a phone.
5. Preserve actual human input during takeover, including ordering, modality, composition, and gestures.
6. Review site compatibility under the existing security boundaries, especially missing sensors, background workers, and ad-blocking interference.

These changes can remove particular artifacts. They cannot certify a browser as human-driven, and must not weaken approval, taint, credential, or egress requirements.

## Classification and decision rules

- **Direct:** the code creates an observable marker or event sequence. This does not mean every vendor detects it.
- **Conditional:** the code creates the condition, but observable output depends on mode, platform, site behavior, or deployment.
- **Weak/inferred:** a plausible statistical or compatibility difference, not an established production detector.
- **P0:** first implementation candidates: direct identifiers, cross-world inspection, identity discontinuities, or broken human input.
- **P1:** compatibility and behavior work after correctness and security design.
- **P2:** deployment-specific measurements and low-confidence differences.

Priorities concern this audit, **not vulnerability severity**. “Remove” means remove the named artifact, not defeat a site's overall risk model.

Some observable behavior is an intentional safety trade-off. The [threat model](threat-model.md:80), [isolated-world requirement](decisions/0005-page-scripts.md:6), [device requirement](decisions/0006-device-emulation.md:6), [WebSocket design](decisions/0010-websocket-block.md:6), and [human-only verification](decisions/0011-verification-challenge.md:13) constrain the changes. Anything that supersedes a settled decision needs an ADR and owner review. New routes/settings/input contracts belong in [the shared contracts](../shared/src/index.ts).

## I. Explicit browser and page artifacts

### S01. Zero-valued debugging port can expose the automation indicator

- **Evidence / scope:** [the launcher](../browser/src/launch.ts:163) always selects a zero-valued remote-debugging port. This applies to both headful and headless launches. [MDN's launch-condition documentation](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver) explicitly includes that port value for Chrome. **Conditional output; confirmed configuration. P0.**
- **Observable:** the standard automation indicator can be true even when Crossbar did not request the separate automation flag. The original inventory's implication that headful remote debugging necessarily leaves it false is unsafe for this launcher.
- **Required change:** choose a supported private debugging transport/configuration that does not trigger this condition, then test the pinned browser. A nonzero loopback port is an option to investigate; a pipe needs client/host transport changes. Preserve authenticated relay isolation and avoid port races or public debugging exposure. Do not merely replace a JavaScript getter and call the problem solved.
- **Acceptance:** a local page records the indicator and identity in each supported headful/headless launch mode; lifecycle, relay authentication, target auto-attach, and fail-closed gate tests still pass. Record actual output rather than infer it from the absence of one flag.

### S02. Stable Crossbar attributes on live elements

- **Evidence / scope:** [reference definitions and tagging](../browser/src/page-scripts/page.ts:63), [item collection](../browser/src/page-scripts/page.ts:255), [text-based lookup](../browser/src/page-scripts/page.ts:324), and [overlay reporting](../browser/src/page-scripts/page.ts:387) write recognizable attributes onto the live DOM. **Direct, whenever these paths run. P0.**
- **Observable:** page scripts can find the attributes or observe their addition, including sequential reference values across many interactive elements. The isolated world does not conceal shared-DOM mutations. The [existing reference test](../browser/test/page-scripts.test.ts:44) actually requires a live attribute today.
- **Required change:** move reference identity into private isolated-world maps and browser-side node handles. Update every consumer, including [typing's attribute selector](../browser/src/pool.ts:366), link extraction, collection, text fallback, overlay checks, and stale-reference handling. Random attribute names only obscure a fixed signature; they do not eliminate mutations.
- **Acceptance:** a local mutation observer sees no reference-tagging writes after reads, collection, lookup, or refused clicks; references still survive valid repeat reads and reject detached/replaced targets. Hidden-content filtering and point checks remain intact.

### S03. Fixed cosmetic-style identifier

- **Evidence / scope:** [cosmetic application](../browser/src/page-scripts/page.ts:283) inserts a style with a fixed Crossbar identifier and sets its text. [After-load processing](../server/src/agent.ts:576) calls this when applicable CSS exists. **Direct, conditional on cosmetics being applied. P0.**
- **Observable:** a named style element, its stylesheet rules, DOM insertion timing, and changed computed styles. This is a separate identifier from element references.
- **Required change:** remove the product-specific live-node identifier and investigate a browser-managed stylesheet mechanism if cosmetic filtering remains required. Verify which stylesheet surfaces remain observable. Per-site disabling can remove cosmetic interference but changes privacy behavior and still needs authorization.
- **Acceptance:** no fixed product marker is added; local bait and stylesheet-inspection fixtures characterize the remaining footprint. Hiding ads is still observable even if the named DOM node disappears: do not promise invisible cosmetic filtering.

### S04. Main-world title, text, and challenge inspection

- **Evidence / scope:** [navigation summaries](../browser/src/pool.ts:303) and [page/frame facts](../browser/src/pool.ts:379) evaluate page expressions without an explicit isolated context. [Page-script calls](../browser/src/page-scripts/index.ts:48) already use an isolated context. **Direct inspection path; detectability depends on page hooks. P0.**
- **Observable:** a page can instrument methods/getters in its own world and inspect unexpected access or call stacks. This is not the historical console-error serialization probe.
- **Required change:** run all shipped DOM inspection in an isolated world for the specific frame/session, including out-of-process frames. Extend the current main-frame-only [world helper](../browser/src/isolated-world.ts:8), and handle navigation/context invalidation without falling back to the main world.
- **Acceptance:** fixture-installed main-world hooks are not invoked by navigation summaries or facts collection; password/OTP/captcha detection still covers reachable frames. Add a protocol-spy assertion that production DOM evaluation always identifies its intended context.

## II. Agent interaction and execution patterns

### S05. Teleporting, exact-center clicks with no deliberate press duration

- **Evidence / scope:** [agent clicking](../browser/src/pool.ts:341) waits 50 ms for a check, then sends one move followed immediately by press/release. [Target location](../browser/src/page-scripts/page.ts:311) selects the bounding-box center. **Direct, agent clicks. P1.**
- **Observable:** deterministic hit points, no approach path or hover, and press duration dominated by protocol/host latency rather than a deliberate gesture. It is not literally guaranteed to be zero.
- **Required change:** separate verified-target selection from input transport. For actual human control, forward actual movement and button phases. Agent input can be less degenerate and device-consistent, but generated curves or random delays remain automation, not proof of a person. Revalidate the exact final point immediately before activation.
- **Acceptance:** local event recording verifies ordering, chosen target, overlay refusal, and bounded timings. Changes must not randomize into neighboring controls or weaken the existing composed-tree hit test.

### S06. Instant scroll-to-center before clicking

- **Evidence / scope:** [target location](../browser/src/page-scripts/page.ts:312) always asks the page to scroll the target into the center instantly before obtaining coordinates. **Direct behavior; not uniquely robotic. P1.**
- **Observable:** scroll position changes without preceding wheel/touch input, followed by a center hit. Page code commonly scrolls programmatically too, so the isolated event is weak; its repeated combination with S05 is more distinctive.
- **Required change:** avoid unnecessary repositioning when the target is already interactable. If movement is needed, use an explicit, bounded reveal action appropriate to the actual device; for takeover, preserve the person's scroll. Recompute geometry after any reveal instead of relying on an old point.
- **Acceptance:** clicking an already-visible control does not recenter the page; offscreen, sticky-header, overlay, nested-scroll, and dynamic-layout fixtures still land only on the intended target.

### S07. Agent typing inserts an entire string after programmatic focus

- **Evidence / scope:** [the typing implementation](../browser/src/input-guard.ts:44) focuses a node then inserts the full text. [Submission](../browser/src/pool.ts:366) adds an immediate Enter key pair when requested. **Direct, agent typing. P1.**
- **Observable:** no ordinary character-by-character key rhythm and no preceding pointer/Tab focus sequence. Whole-string insertion is also legitimate for IME, paste, dictation, autofill, and accessibility; it is evidence in context, not proof of automation.
- **Required change:** distinguish keyboard, composition, paste/autofill, and bulk insertion semantics instead of treating every text action identically. Use appropriate browser input primitives, preserve focus ownership, and recheck the target after focus. Synthetic per-key timing does not establish the owner's biometric rhythm.
- **Acceptance:** local event traces and value assertions cover ordinary text, Unicode, composition, submission, focus swaps, and restricted-field policy. Resolve the credential-policy discrepancy noted below before extending this path.

### S08. Fixed wheel increments at a fixed viewport point

- **Evidence / scope:** [the scrolling loop](../browser/src/page-scripts/scroll.ts:47) emits vertical deltas of 80% of viewport height at its center, then sleeps a fixed pace. [The agent](../server/src/agent.ts:797) supplies 600 ms; the utility default is 500 ms with a 150 ms floor. **Direct, agent scrolling. P1.**
- **Observable:** repeated deltas, unchanged pointer coordinates, no horizontal component, and a regular lower-bound cadence plus extraction/transport time. Actual intervals are not exactly the configured sleep.
- **Required change:** preserve real gestures during takeover; for agent scrolling, define a device-appropriate, bounded interaction model rather than identical jumps. Loading/readiness should drive progress, not invented “human randomness.” Retain deduplication and every server cap.
- **Acceptance:** local wheel/touch traces match the selected input mode; slow feeds, virtualized lists, no-growth behavior, and item/token/time limits still work. No unlimited background scrolling.

### S09. Mechanical navigation and incomplete pacing coverage

- **Evidence / scope:** [navigation](../browser/src/pool.ts:309) directly opens URLs without supplying a browsing referrer. [The pacer](../server/src/pace.ts:9) defaults to 3 seconds and 120 opens/hour, with a 1-second floor. [Only the open path](../server/src/agent.ts:673) invokes it; [click/type/scroll/back](../server/src/agent.ts:764) do not. [Settle polling](../server/src/agent.ts:728) uses fixed waits. **Direct control flow; behavioral significance inferred. P1.**
- **Observable:** deep-link arrivals, short or regular action spacing, potentially rapid click-driven pagination, and no guarantee of human reading time. Referrer-free links and short dwell also occur legitimately.
- **Required change:** use real link navigation when that is the requested task, never forge cover history. Enforce workload budgets across navigation-producing actions, and use bounded readiness checks. Make pacing reservation atomic if parallel sessions can race; the current check/record pair is separate.
- **Acceptance:** local tests cover parallel opens, click pagination, back navigation, retries, hourly limits, and readiness. Do not add scheduled extraction, fake activity, or arbitrary “reading” traffic to look human.

### S10. Foreground state is not coordinated across agent tabs and viewers

- **Evidence / scope:** [screencast start](../browser/src/pool.ts:512) brings a tab forward. Agent click/type paths do not. [The pool](../browser/src/pool.ts:586) shares one browser per user/profile across sessions. **Conditional, especially multiple tabs/viewers. P1.**
- **Observable:** actions in a background document, or visibility/focus changes when another tab is viewed. Opening live view can itself change the browser state being measured. There is no explicit per-user foreground lease in these paths.
- **Required change:** define an exclusive foreground/input ownership model for human takeover and any foreground-dependent operations; coordinate live viewers without repeatedly stealing focus. Decide explicitly whether agent work may occur in background tabs and keep its reported state honest.
- **Acceptance:** a two-session local test records visibility, focus, and input delivery; starting a viewer cannot redirect another person's active input. Taking over must pause competing agent control, not just one method call.

### S11. Extraction and screencasting add workload correlated with actions

- **Evidence / scope:** [reference scanning](../browser/src/page-scripts/page.ts:90), [visible cloning and parsing](../browser/src/page-scripts/page.ts:215), [collection](../browser/src/page-scripts/page.ts:255), and [screen streaming](../browser/src/pool.ts:512) perform repeated work. **Weak/inferred, workload-dependent. P2.**
- **Observable:** possible main-thread stalls, layout work, or frame-rate changes correlated with reads/scrolls and live viewing. This audit did not measure long tasks or establish that a vendor uses them to identify Crossbar.
- **Required change:** profile local large-page fixtures, reduce repeated style/layout reads, avoid redundant extraction, and bound capture cost. Keep invisible-text filtering and synchronous/no-network extraction semantics. Reducing workload is a correctness/performance improvement, not an invisibility guarantee.
- **Acceptance:** record local long-task and frame-time distributions with extraction/viewing on and off, under representative CPU contention. Separate generic load effects from direct identifiers S02–S03.

## III. Device identity and human-takeover fidelity

### S12. Mobile identity is only partially emulated

- **Evidence / scope:** [mobile constants](../browser/src/pool.ts:139) select a 390×844 viewport at scale 3; [mobile emulation](../browser/src/pool.ts:460) claims a Pixel 8/Android 14 identity and five touch points. No corresponding touch-event path appears in [takeover input](../browser/src/pool.ts:540). **Conditional, mobile mode. P0.**
- **Observable:** a claimed mobile environment can retain desktop graphics/fonts/CPU behavior and mouse-driven input. The dimensions are a layout choice, not proof of actual Pixel hardware. Emulation is configured for this tab session, with no explicit propagation of its full identity to every new worker/frame in the gate.
- **Required change:** prefer the honest native desktop identity unless a coherent mobile environment is actually supported. If mobile remains, inventory and test every exposed surface and child-target behavior; use real mobile hardware for requirements desktop emulation cannot satisfy.
- **Acceptance:** compare headers, client hints, script properties, viewport/screen, graphics, frames, workers, and input modality. Do not treat two matching identity strings as a complete profile.

### S13. Taking control changes device identity mid-session

- **Evidence / scope:** [takeover setup](../server/src/agent.ts:201) forces mobile emulation on the tab and its adopted popups, even if the site was desktop. [Hand-back](../server/src/agent.ts:230) restores the configured site device. **Direct transition; actual resulting surface values are browser-dependent. P0.**
- **Observable:** a session can begin as desktop, resize/change identity when a person claims a challenge, then revert. Existing page scripts, subsequent requests, and popup state may see different parts of that transition.
- **Required change:** decouple the phone viewer's size from the remote browser's identity. Retain the site's chosen device throughout the session and scale/pan the viewer. A genuine device change should be explicit and, where necessary, start a fresh coherent navigation rather than silently mutate an existing authentication flow.
- **Acceptance:** device/header/property snapshots are stable across claim, popup adoption, failed verification, successful hand-back, and repeated takeover. Phone usability is tested without rewriting the browser's identity.

### S14. Headless identity suppression uses hardcoded metadata

- **Evidence / scope:** [headless desktop emulation](../browser/src/pool.ts:482) replaces the headless user-agent token and supplies fixed GREASE-brand, platform-version, and architecture guesses. [The container host](../browser/src/host.ts:24) defaults headful, but [direct server startup](../server/src/main.ts:40) defaults its local launcher to headless unless disabled; [the local dev wrapper](../scripts/dev-local.ts:60) explicitly disables it. **Conditional, headless/local startup. P1.**
- **Observable:** suppressed headless text can coexist with native automation indicators, incompatible architecture/platform details, or unusual hint metadata. The local entry point and container do not have identical defaults.
- **Required change:** make execution mode explicit and consistent. Prefer native identity for the actual supported environment instead of guessed OS values. If an override is necessary, derive and validate supported structured metadata, including full-version information and target propagation.
- **Acceptance:** exercise direct startup, dev wrapper, and container modes separately. Check Intel/ARM cases where supported and verify fallback version handling. Headful is not itself a complete fix for S01.

### S15. Human taps become two mouse requests, without pointer travel

- **Evidence / scope:** [the takeover image click handler](../web/src/main.ts:404) runs after a viewer click, then sends a mouse press and release as separately awaited HTTP requests. [Server forwarding](../server/src/http.ts:302) and [browser input](../browser/src/pool.ts:540) preserve that reduced representation. **Direct, human takeover. P0.**
- **Observable:** no original movement path or physical down/up timing; observed press duration includes an HTTP response cycle and server/protocol work. Coordinates reflect viewer scaling, not a native local cursor trajectory.
- **Required change:** capture actual pointer phases and movement, with a bounded ordered transport and explicit target-tab binding. Preserve duration and modality where available. Cancel safely on disconnect/navigation; do not replay a consequential press against a newly selected popup.
- **Acceptance:** local traces under latency, packet delay, popup changes, and disconnects preserve ordering without stuck buttons or duplicate clicks. A remote human gesture is still not proof that no automation is present.

### S16. Human typing is collected elsewhere and inserted as one string

- **Evidence / scope:** [the native takeover field and Send button](../web/src/main.ts:415) collect text in the Crossbar app; [browser forwarding](../browser/src/pool.ts:542) inserts it into the remote page as one text operation. **Direct, human takeover. P0.**
- **Observable:** the destination never sees the person's original field focus, composition, corrections, or typing rhythm. Password-manager insertion can legitimately be whole-string input, so the issue is lossy transport, not an inherently nonhuman event.
- **Required change:** offer a true keyboard/composition-forwarding mode where supported, while retaining honest insertion for autofill/IME workflows. Never reconstruct fictitious key timings from a completed string. Keep secret-bearing text and raw per-key data out of logs and agent responses.
- **Acceptance:** test Unicode, IME, password-manager fill, selection, replacement, deletion, errors and reconnects without secret logging. Keep person-only credential/step-up ownership as required by policy.

### S17. Takeover contract cannot express full pointer/keyboard gestures

- **Evidence / scope:** [the shared input schema](../shared/src/index.ts:215) and [browser event interface](../browser/src/pool.ts:54) omit touch contacts, composition phases, modifiers, horizontal wheel data, event sequencing, and source timing. [The key buttons](../web/src/main.ts:449) send a narrow Enter/Backspace/Tab pair. **Direct capability limitation; resulting signals depend on the task. P1.**
- **Observable:** a purported mobile session never receives native touch sequences from this API; key/modifier and gesture behavior can be incomplete. A successful single key pair is not a full keyboard transport.
- **Required change:** define a bounded, session-only human-input contract first, then implement validation, ordering, target binding, composition, touch/pen support where genuine, and disconnect cancellation. Never give these human-only routes to agent tokens.
- **Acceptance:** contract and authorization tests reject malformed/reordered events and agent callers; local pages receive the supported modalities correctly. Secret values are excluded from diagnostic recordings.

### S18. Takeover scrolling is fixed-size button input

- **Evidence / scope:** [takeover arrow buttons](../web/src/main.ts:450) emit ±400-pixel vertical wheel events at the page center; [browser forwarding](../browser/src/pool.ts:551) sets horizontal delta to zero. **Direct, human takeover. P1.**
- **Observable:** repeated fixed steps without the user's actual touchpad/touch movement. This can also represent a legitimate remote-control/accessibility interface and is not conclusive bot evidence.
- **Required change:** forward genuine viewer gestures when available, including direction and appropriate scrolling container, and keep button scrolling as an explicit accessible fallback. Do not translate a single button into invented trackpad biometrics.
- **Acceptance:** local nested-scroll and mobile/desktop fixtures preserve gesture direction, zoom/scale coordinates, and bounded event rates; button use remains predictable and accessible.

## IV. Sensor and networking differences

### S19. Unknown sensor submissions are held or denied

- **Evidence / scope:** [the current request policy](../server/src/agent.ts:333) allows known reads and selected challenge endpoints, denies other writes for read tokens, and otherwise holds/grants them. [The adapter registry](../adapters/src/index.ts:28) contains only Reddit, not bank-specific sensor adapters. [Held requests](../browser/src/gate.ts:193) fail on timeout after the [20-second default](../browser/src/gate.ts:71). **Conditional, sites needing unrecognized non-GET sensors. P1.**
- **Observable:** the site receives no sensor submission, receives it late, or sees it fail in page code. The nearby comment about banking adapters is not evidence that such adapters are registered.
- **Required change:** investigate each affected site's legitimate traffic using authorized fixtures; add only narrowly reviewed, typed compatibility rules consistent with the Access Model. Telemetry can contain sensitive data or side effects: never bypass policy merely because an endpoint looks analytical.
- **Acceptance:** fixture tests demonstrate both permitted read behavior and refusal of writes/exfiltration on similar endpoints. Do not allow an entire GraphQL or vendor API as a shortcut.

### S20. Opening a challenge ticket changes background-request behavior

- **Evidence / scope:** [challenge creation](../server/src/agent.ts:548) marks a tab blocked; [the request policy](../server/src/agent.ts:339) denies remaining non-GET requests behind that ticket. Selected read/challenge calls are evaluated first. [Human takeover](../server/src/agent.ts:294) takes a different branch. **Direct policy transition, conditional on page traffic. P1.**
- **Observable:** background traffic that worked previously can stop after detection and resume differently when a person takes over. Request failure may itself frustrate a challenge SDK or token refresh.
- **Required change:** preserve the quiet, fail-closed behavior for consequential/unclassified writes. If a specific challenge needs additional read-only traffic, design an explicit bounded compatibility path rather than unblocking the whole page.
- **Acceptance:** local challenge fixtures can progress using only permitted traffic, while background writes remain denied and no approval spam is introduced. Test tainted and cross-domain cases separately.

### S21. Workers without an owning tab lose non-GET behavior

- **Evidence / scope:** [browser-level routing](../browser/src/pool.ts:192) permits only GET/HEAD when a request has no owning tab policy. [Gate ownership](../browser/src/gate.ts:125) follows attachment parents; browser-level service/shared workers may have no owning page. **Conditional, worker ownership/lifecycle. P1.**
- **Observable:** a service/shared-worker refresh or telemetry submission can fail even when equivalent page traffic is allowed. Workers being enabled is not the same as their requests receiving a useful tab policy.
- **Required change:** design explicit origin/profile/session ownership and policy lifetime for workers that need supported non-GET reads. Shared workers may serve multiple tabs with different taint state: do not arbitrarily borrow the most permissive policy.
- **Acceptance:** real-browser local tests cover worker-originated requests, passthrough fetches, multiple clients, closed tabs, taint changes, and restart. Unowned writes stay fail-closed until ownership is established.

### S22. Ad blocking still runs during human takeover

- **Evidence / scope:** [site defaults](../server/src/sites.ts:153) keep blocking enabled even for an enabled banking category; [request filtering](../server/src/agent.ts:291) precedes the human-takeover branch. [Filter loading](../server/src/main.ts:26) uses ads-and-tracking lists when available. **Conditional, list matches and site configuration. P1.**
- **Observable:** missing fraud/analytics scripts and resources, plus cosmetic bait effects from S03. Claiming a ticket does not make this a clean unfiltered browser. Conversely, list download failure can make installations differ.
- **Required change:** use an explicit person-controlled per-site compatibility setting, already allowed by the [ad-blocking ADR](decisions/0003-ad-blocking.md:6), where justified. Coordinate request and cosmetic behavior. Fixing a sensor's delivery does not authorize sending otherwise forbidden data.
- **Acceptance:** local blocked-script and bait fixtures exercise agent and takeover modes with filtering on/off; approval/taint refusals remain independent of content blocking.

### S23. Every request and new target passes through a protocol pause

- **Evidence / scope:** [auto-attach](../browser/src/gate.ts:105) pauses new targets; [target initialization](../browser/src/gate.ts:136) enables interception for all request URLs before resuming. [Allowed requests](../browser/src/gate.ts:193) still make a protocol round trip. **Confirmed machinery; timing detectability weak/inferred. P2.**
- **Observable:** possible startup delay for workers/frames and per-request latency. CPU/network load can produce similar effects; no vendor threshold was measured here.
- **Required change:** profile and optimize the allow path, policy work, and transport while preserving target coverage, deadlines, and fail-closed handling. Removing interception or letting a target run before the gate is ready would violate the architecture.
- **Acceptance:** local latency baselines include many resources and worker starts, while the gate matrix proves no write escapes during attach, redirects, crashes, or timeouts. Improvement is measured, not presumed stealth.

### S24. All WebSocket handshakes fail

- **Evidence / scope:** [the extension rule](../browser/extensions/ws-block/rules.json:1) blocks WebSocket resource types; [the launcher](../browser/src/launch.ts:175) loads it by default. [The manifest](../browser/extensions/ws-block/manifest.json:1) has no page content script or web-accessible resources declared. **Direct connection behavior, not a universal automation proof. P1 / architecture change.**
- **Observable:** a site can attempt a socket and observe failure. The extension's display name is not automatically readable by arbitrary website JavaScript.
- **Required change:** retain the block unless a reviewed protocol-aware, scoped allowance can enforce the required security semantics. The [existing ADR](decisions/0010-websocket-block.md:14) defers adapter-specific support. Opening every socket is not a safe fix.
- **Acceptance:** local page/iframe/worker sockets remain denied unless explicitly supported; allowed protocols cannot evade taint, consequences, private-IP checks, or logging.

### S25. HTTP/3 is disabled

- **Evidence / scope:** [security launch arguments](../browser/src/launch.ts:108) disable QUIC, reinforced by [managed browser policy](../deploy/browser/policies.json:22). **Direct configuration; server-visible protocol choice conditional. P2 / retain boundary.**
- **Observable:** HTTP/2 or HTTP/1.1 instead of HTTP/3 where a site offers it. Many human browsers behind proxies/firewalls behave the same way, so this is weak evidence.
- **Required change:** none merely for human appearance. Removing the difference would require a proxy transport that can enforce equivalent controls on UDP/QUIC, not just deleting a flag.
- **Acceptance:** if such architecture is proposed, a local UDP listener proves no direct egress, with DNS/IP/taint/authorization coverage at least equivalent to today's path. Until then, keep QUIC off.

### S26. WebRTC cannot use non-proxied UDP

- **Evidence / scope:** [launch restrictions](../browser/src/launch.ts:110), [managed policy](../deploy/browser/policies.json:23), and the [Harbor firewall](../deploy/browser/egress-firewall.sh:18) restrict network paths. **Conditional candidate/API behavior; intentional restriction. P2.**
- **Observable:** reduced ICE candidates or failing peer connections compared with an unrestricted desktop. Similar behavior occurs with VPNs, enterprise policy, and privacy settings; raw local-IP disclosure is not universal in modern browsers.
- **Required change:** preserve unchecked-UDP prevention. Only support real-time networking through an explicitly reviewed checked path if the product requires it. Patching returned address strings does not make underlying traffic safe or authentic.
- **Acceptance:** local ICE/STUN/UDP fixtures verify actual packets, not just a policy string. Tests must cover both IPv4 and IPv6 and fail closed on unsupported paths.

### S27. Third-party cookies are restricted in both profiles

- **Evidence / scope:** [seed preferences](../browser/src/pool.ts:114), [runtime cookie controls](../browser/src/pool.ts:172), and [managed policy](../deploy/browser/policies.json:19) impose restrictions. Runtime control failures are swallowed, and existing preference files are not reseeded. **Confirmed attempted configuration; effective result platform/profile-dependent. P2.**
- **Observable:** third-party collectors/embeds may have less persistent cross-site state. This is common privacy behavior, not unique to bots, and does not necessarily destroy first-party device recognition.
- **Required change:** keep permitted first-party storage stable and test the service's partitioned-cookie support. Broadly enabling third-party tracking conflicts with the documented profile policy and needs an explicit decision, not a hidden stealth toggle.
- **Acceptance:** local first-/third-party and partitioned-cookie fixtures verify both profiles, upgrades, existing preferences, and managed-policy application. Never treat an ignored control call as proven enforcement.

### S28. Fresh profiles default-deny notification, location, camera and microphone permissions

- **Evidence / scope:** [initial preference seeding](../browser/src/pool.ts:123) sets these content settings to denied, provided no preferences file exists yet. **Conditional on effective preferences and requested APIs. P2.**
- **Observable:** permission queries or attempts can see a denied state without the usual first-use prompt; associated device enumeration may be restricted. Genuine users also deny these permissions, and this is not proof of automation.
- **Required change:** do not grant invasive permissions to look normal. If a legitimate supported task needs one, design a person-controlled, origin-scoped permission flow and preserve explicit denial elsewhere. Use native permission reporting instead of faking a prompt state.
- **Acceptance:** local secure-context pages check actual permission results, prompts, denial persistence, and unauthorized-agent refusal without accessing real microphones, cameras, or location.

### S29. Pings, prediction, prerender and other stock behaviors are disabled

- **Evidence / scope:** [disabled features](../browser/src/launch.ts:67), [security arguments](../browser/src/launch.ts:108), and [managed policy](../deploy/browser/policies.json:1) suppress several behaviors, including hyperlink pings, prediction and prerender. **Conditional; individual API effects are version-dependent. P2.**
- **Observable:** missing ping requests, different speculative-fetch/navigation timing, or differences in available features. Not every listed flag maps to a webpage-readable API; Chrome's own background services are generally not a direct signal to an unrelated site.
- **Required change:** classify each suppression by security purpose and actual measurable site effect. Retain those preventing unreviewed network paths. Change a compatibility-only restriction only with evidence and tests; do not indiscriminately enable background traffic or mock every missing API.
- **Acceptance:** local ping/prerender/prediction fixtures record traffic and policy decisions. Test the browser version's actual behavior rather than assuming a flag still has its historical effect.

### S30. Popups, downloads, printing and browser integration are restricted

- **Evidence / scope:** [unowned pages](../browser/src/pool.ts:176) are closed unless adopted during takeover; [tab initialization](../browser/src/pool.ts:245) denies downloads. [Managed policy](../deploy/browser/policies.json:15) disables password/autofill services, downloads, printing, sync and sign-in. **Conditional, feature-specific. P2.**
- **Observable:** popup closure and failed workflows, lack of ordinary autofill behavior, or attempted downloads not completing. Internal policy names and sync state are not automatically enumerable by a website; some restrictions may have no reliable remote probe.
- **Required change:** retain product safety restrictions. If a human workflow needs a supported popup, adopt it with explicit ownership and preserved device/input state; do not permit arbitrary unowned windows. Supporting a prohibited feature is a product/security change, not a cosmetic fix.
- **Acceptance:** local opener/popup and harmless download fixtures distinguish permitted takeover windows from agent-created unowned pages. No fixture writes sensitive files or exposes the host/profile.

## V. Deployment and account-context differences

### S31. Container graphics, fonts, audio and devices differ from the owner's machine

- **Evidence / scope:** [the browser image](../deploy/Dockerfile:53) runs Linux Chromium under a virtual display and installs Liberation plus Noto font families. [Compose](../deploy/compose.yaml:31) declares no GPU passthrough or audio/media device integration. **Conditional environment mismatch; actual renderer/devices unmeasured. P2.**
- **Observable:** software rendering, container-specific graphics outputs, Linux fonts/audio characteristics, or missing media capabilities may differ from the device previously used for the account. The image is **not font-empty**. Xvfb alone does **not** prove software rendering.
- **Required change:** measure the deployed renderer and available devices first. Where useful and safe, support actual host graphics/display services and required font packages without opening broad host access. Prefer honest stable platform identity to fabricated GPU strings. A matching user-agent string cannot turn Linux into the owner's other OS.
- **Acceptance:** local environment snapshots record renderer, graphics limits, fonts, audio/media availability and permissions. Any device mapping is minimal, documented, and owner-reviewed; software rendering remains an acceptable supported mode, not concealed as different hardware.

### S32. Uniform virtual-screen and window geometry

- **Evidence / scope:** [launch sizing](../browser/src/launch.ts:170) selects a 1280×800 window; [Docker](../deploy/Dockerfile:70) and [the Harbor entrypoint](../deploy/browser/egress-firewall.sh:46) select a 1280×1024 virtual display. No window manager is explicitly started by those commands. **Conditional actual measurements; common deployment signature rather than unique proof. P2.**
- **Observable:** many deployments may share screen/work-area/window values; virtual display and mobile overrides can produce unusual combinations. Native browser chrome and platform behavior determine actual inner/outer values, so do not infer exact dimensions from arguments alone.
- **Required change:** configure a real, coherent display/window environment appropriate to the supported use, or keep honest defaults. Expose approved display configuration only where needed; do not rotate dimensions per request.
- **Acceptance:** local snapshots cover screen, work area, inner/outer window, pixel ratio, screenshots and coordinate mapping in all supported modes. Repeated takeover does not alter device identity (S13).

### S33. Browser timezone and locale are not explicitly tied to the owner

- **Evidence / scope:** [browser image environment](../deploy/Dockerfile:65), [Compose browser environment](../deploy/compose.yaml:37), and [Harbor environment](../harbor/compose.yaml:18) do not set browser timezone/locale. The [emulation implementation](../browser/src/pool.ts:460) does not apply those settings either. **Conditional on image/operator defaults. P1.**
- **Observable:** timezone, language headers, and script language may differ from the user's normal device or egress region. UTC and multilingual users are genuine; this is a consistency issue, not a requirement that every property equal IP geolocation.
- **Required change:** provide explicit owner-selected timezone/language configuration and apply it coherently before navigation, including relevant child targets. Persist it with the device configuration. Do not silently infer or spoof sensitive location permissions.
- **Acceptance:** local pages verify time formatting, daylight-saving behavior, language headers and worker/frame values across restart and takeover. Record effective values, not assumed base-image defaults.

### S34. Browser build and capability differences vary by deployment

- **Evidence / scope:** [development installation](../scripts/ensure-browser.mjs:8) pins Chrome for Testing; [container installation](../deploy/Dockerfile:55) installs distribution Chromium without an exact package version. [Browser discovery](../browser/src/launch.ts:35) selects the first matching cached directory, not necessarily the intended pin. **Conditional build/capability drift. P1.**
- **Observable:** version, codec/DRM support, hint behavior, graphics and policy enforcement can differ between dev and production or rebuilds. Chromium does not universally lack every codec, and a DRM failure does not uniquely identify automation.
- **Required change:** explicitly track supported browser products/builds and capabilities; select the intended cached executable deterministically. Use a tested update policy for security fixes, not a permanently frozen old build. Branded Chrome substitution requires preserving extension-based WebSocket enforcement.
- **Acceptance:** deployment diagnostics record exact product/build and supported capabilities; local launch/interception/extension tests run for each supported build. Update generated [Harbor browser build instructions](../harbor/build/browser.Dockerfile) through their generator, not by hand.

### S35. Separate browser profiles are a new device/account context

- **Evidence / scope:** [local profile paths](../browser/src/pool.ts:106), [container profile paths](../browser/src/host.ts:44), [the profile volume](../deploy/compose.yaml:35), and [site-based profile selection](../server/src/agent.ts:655) create persistent but separate anonymous/personal contexts. Login [claims the personal profile](../server/src/http.ts:290). **Direct account-context separation; resulting risk score conditional. P1.**
- **Observable:** the first Crossbar login can look like a new device even if the owner already uses that account elsewhere. Moving from anonymous to personal changes cookies/storage; taint can intentionally send a new-domain navigation back to anonymous. Persistence already prevents unconditional profile loss on every run.
- **Required change:** retain profile volumes and identity settings across upgrades/restarts, avoid accidental temporary profiles in production, and support ordinary human enrollment/step-up. Coordinate concurrent account use rather than rotate identities or copy another browser's cookies.
- **Acceptance:** local cookie/device-state fixtures survive restart and authorized takeover; anonymous stays separate and taint behavior stays intact. Real MFA or server single-session policy is respected, not bypassed.

### S36. Egress, DNS and plain-HTTP behavior can differ from a local browser

- **Evidence / scope:** [the proxy](../proxy/src/proxy.ts:33) resolves names and opens sockets from its own environment; [plain HTTP forwarding](../proxy/src/proxy.ts:90) uses Node's HTTP client; [HTTPS tunneling](../proxy/src/proxy.ts:130) pipes bytes without terminating browser TLS. [Port/address policy](../proxy/src/proxy.ts:56) deliberately refuses unsupported destinations. **Conditional, network/deployment-specific. P2.**
- **Observable:** the proxy's public IP/ASN, resolver path, TCP behavior and sometimes plain-HTTP formatting differ from the owner's usual environment. Refused alternate-port/private-target probes may fail. **HTTPS TLS is still the browser's**, not a Node-generated handshake, and the denial header is not an identifying header added to allowed origin requests.
- **Required change:** use the owner's stable authorized deployment/connection where appropriate, preserve checked resolution and tunneling, and measure actual plain-HTTP differences before changing them. Fixing wire formatting would need a safe forwarding design, not blind header spoofing. Do not add proxy pools, direct DNS/UDP paths, or private-range exceptions for appearance.
- **Acceptance:** local origin tests compare raw HTTP behavior and tunneled TLS; controlled resolver/address fixtures prove post-resolution refusal and checked-IP dialing still hold. IP reputation and a server's account-location policy remain outside a browser patch's control.

## Suspected signals that this audit does not establish

| Claim | Current evidence / conclusion |
|---|---|
| Service workers are switched off | [Bypass is optional](../browser/src/gate.ts:161); [normal browser construction](../browser/src/pool.ts:158) does not enable it. Worker request-policy failures (S21) are a separate issue. |
| Crossbar exposes its extraction global directly to the page | [The bundle](../browser/src/page-scripts/page.ts:413) installs its global in the [isolated context](../browser/src/page-scripts/index.ts:40). [A local test](../browser/test/page-scripts.test.ts:53) asserts main-world absence; this audit did not run that test. Shared-DOM markers remain S02–S03. |
| The isolated world's product name is directly readable by ordinary page JavaScript | [The name](../browser/src/isolated-world.ts:6) is a debugging-context label. No ordinary page enumeration mechanism was established here. Do not confuse debugger access with webpage access. |
| Runtime event subscription necessarily exposes the classic error-getter probe | No runtime-domain-enable call was found in browser production source. The [research companion](bot-detection-bypasses.md) also documents why the specific classic probe broke in newer V8. Neither fact proves that every debugger side channel is absent. |
| The extraction markers appended to converted text are all live DOM mutations | [Text markers](../browser/src/page-scripts/page.ts:179) are appended to the [detached visible clone](../browser/src/page-scripts/page.ts:215). Those edits are not live-page markers. Reference attributes and cosmetic style insertion are. |
| Production is always headless | [The browser host](../browser/src/host.ts:24) and [container image](../deploy/Dockerfile:65) default headful. Direct local server startup differs (S14). |
| Profiles are cleared on every request | [Production/local launchers](../browser/src/pool.ts:106) use persistent directories. [Temporary-directory deletion](../browser/src/launch.ts:161) applies when the low-level launcher was not given a profile directory. |
| All telemetry metadata in adapters is currently enforced | [Telemetry metadata/helpers](../adapters/src/index.ts:13) remain, but no call to that helper was found in server production source in this snapshot. Follow [the actual policy](../server/src/agent.ts:333), not stale comments or test names. Unknown submissions still face S19/S20. |
| Banks receive Crossbar's app authentication header | [The web app's header](../web/src/main.ts:38) is for requests to Crossbar's own API. No source path here adds it to allowed third-party website traffic. |
| No GPU/audio/fonts is proven by the Dockerfile | Fonts are explicitly installed; renderer and actual devices require measurement. Missing explicit host integration supports a conditional environment finding, not a universal output claim (S31). |

### Source/policy discrepancy to resolve separately

The current [typing implementation](../browser/src/input-guard.ts:2) explicitly says credential-field restrictions were removed; [its tests](../browser/test/input-guard.test.ts:40) expect agent entry into password/card/OTP fields. This conflicts with the [README exclusion](../README.md:23) and [threat-model tool-layer rule](threat-model.md:86). This audit reports the current code, does not resolve that policy conflict, and does not treat those protections as currently proven. Any input-fidelity work needs an explicit policy decision and matching security tests; it must not silently broaden credential access.

## Mapping back to the original detection list

| Original item | Current audit coverage |
|---|---|
| A1 sensor submissions | S19, S20 |
| A2 third-party collectors / taint | S19, S20, S35; taint remains intentional |
| A3 ad blocking | S03, S22 |
| A4 WebSockets | S24 |
| A5 live references | S02 |
| A6 interception timing | S23 |
| A7 service workers | S21 and the nonfinding above: bypass is not enabled |
| A8 third-party cookies | S27 |
| B1 graphics | S31 |
| B2 container environment | S28, S31 |
| B3 geometry | S32 |
| B4 browser product/media | S34 |
| B5 identity and hints | S14, S34 |
| B6 mobile | S12, S13, S17 |
| B7 disabled features | S28–S30 |
| B8 automation flags | S01 |
| B9 protocol/main-world inspection | S04; runtime-subscription nonfinding above |
| C1 reputation | S36; depends on deployment, not inevitably a VPS |
| C2 locale/location | S33, S36 |
| C3 TLS/HTTP | S36; HTTPS tunneling preserves browser TLS |
| C4 HTTP/3 | S25 |
| C5 WebRTC | S26 |
| C6 DNS | S36 |
| D1 typing | S07 |
| D2 pointer | S05, S06 |
| D3 focus | S07, S10 |
| D4 scroll | S08 |
| D5 navigation/session shape | S09, S35 |
| D6 visibility | S10 |
| E taps | S15, S17 |
| E typing | S16, S17 |
| E special keys | S17 |
| E scroll | S18 |
| F new device | S13, S35 |
| F concurrent sessions | S09, S10, S35 |
| F schedule/volume | S09; no scheduler was established in the reviewed paths |

Additional details beyond that list include the fixed cosmetic marker, instant target recentering, forced takeover identity transitions, incomplete input contract, unowned-worker policy, permission defaults, build selection drift, and extraction workload.

## What would actually make takeover human-driven?

There is no webpage property Crossbar can truthfully toggle to prove “a human is driving.” The website sees browser/network behavior and whatever authentication or attestation it supports. A browser-generated trusted event can still be generated through automation. Removing markers does not turn agent actions into human actions.

A defensible target is **a real person controlling the same coherent browser through a faithful, private transport**:

1. Keep the selected device identity stable; make the viewer responsive instead of rewriting the remote device.
2. Establish exclusive human input ownership; pause competing agent work and handle popup transitions explicitly.
3. Forward the person's actual supported pointer/key/composition/gesture events in order, with cancellation and no fabricated biometrics.
4. Keep browser state, origin display, account enrollment and verification honest. Do not spoof a successful security check or grant the agent the person's credentials.
5. Preserve the request gate and proxy independently of input transport. A possible OS-level remote-desktop transport would not remove browser/network policy differences and would require a new narrowly scoped human-only interface.
6. Where a service offers an approved API, delegated-access flow, or explicit automation arrangement, prefer that over pretending automation is a local human session. Local test exemptions do not authorize production access.

## Suggested implementation order

| Stage | Work | Required proof before merging |
|---|---|---|
| 1: Remove explicit artifacts | S01–S04 | Pinned-browser launch matrix; zero live reference markers; no production main-world DOM evaluation; extraction and click safety preserved. |
| 2: Make takeover faithful | S12–S18, S10 | Stable device across claim/hand-back; human-only contract; actual input ordering; no stale-tab replay or secret logging. |
| 3: Fix task input and budgets | S05–S09 | Device-consistent events, valid final click point, bounded progress, atomic workload limits and unchanged consequence approvals. |
| 4: Repair supported site compatibility | S19–S22 | Saved local fixtures proving narrow supported reads and refusal of adjacent writes/exfiltration; no generic telemetry exemptions. |
| 5: Measure deployment differences | S11, S23, S27–S36 | Effective environment report, supported-build matrix, persistence checks, local timing/network evidence. Retain intentional restrictions absent a reviewed replacement. |
| Separate architecture decisions | S24–S26 and any prohibited-feature support | ADR plus equivalent or stronger enforcement; never disable a boundary just to improve a detection score. |

### Local-only evidence to collect

Add a diagnostic page to the local test stack, not a third-party fingerprint service in CI. Record nonsecret effective environment values, app-created live DOM mutations, sanitized input-event shapes/timing, visibility/focus, resource outcomes, and worker behavior. Include before/after snapshots of takeover, navigation, popup adoption, and restart.

Use isolated test profiles and synthetic text. Never capture real passwords, OTPs, payment data, account cookies, secret-bearing key events, or real signed-in page content. Run the existing security suites alongside new behavior tests; a friendlier fingerprint with a broken gate is a regression, not success.

**Done means:** the named artifact is absent or its remaining trade-off is measured and documented, legitimate human control is more faithful, and Crossbar's security invariants still hold. It does not mean “undetectable.”
