# Crossbar threat model

This is the Access Model kept in the repo. The design page (https://claude.ai/artifact/JrJrT21wE7F5TXJbHNEzq1) was the source until this file landed; from here on, this file wins. Every rule below has, or will have, a named test (AGENTS.md rule 2). Rules with a test today are marked **[test: name]**.

## What we defend against

1. **Prompt injection from pages.** A page the agent reads tries to make the agent post, pay, delete, leak what it read while signed in, or loosen its own permissions.
2. **A compromised or careless agent** with a valid token.
3. **Pages attacking the host network** (LAN, Tailscale, cloud metadata, the home's public IP) through the browser.
4. **Rubber-stamping**: a tired person approving something bad because the prompt was misleading.

Not defended: a compromised host (profiles are encrypted at rest, which protects disks and backups, not a running box), and an agent repeating text through its own tools once it has read it.

## Six rules

1. **Two tokens. The act token is the super admin.** It can call every setting. Tightening applies at once. Loosening returns `pending_approval`. No token can approve its own request.
2. **One ladder per site.** `blocked` → `read` → `read_as_you` → `act_as_you`. Logging in through a ticket is the opt-in to `read_as_you`.
3. **Clicking is reading. Consequences ask.** The network gate decides from what actually leaves the browser, not from button labels. On signed-in sites any unknown non-GET request asks, so a miss fails closed.
4. **Some actions always ask, and some never happen.**
5. **A proxy fences the network.** DNS is resolved by the proxy, and private ranges are refused after resolution.
6. **A notification only points to the approval page.** Approving happens behind the app's own login. Deny can be inline.

## Site ladder

Matched on the registrable domain (Public Suffix List). Specific host rules override it; the most specific rule wins. Adapters group related domains (`reddit.com`, `redd.it`, `redditstatic.com`).

| Level | Profile | Meaning | Default for |
|---|---|---|---|
| `blocked` | none | The agent can't open it | LAN and private ranges (human-only to change); mail, banking, password managers, cloud consoles, Harbor, Crossbar's own UI |
| `read` | anonymous | Click, expand, paginate, search, dismiss consent ("reject all") | Every other public site |
| `read_as_you` | personal | Same, with your logins. Sensitive paths (`/message`, `/chat`, `/inbox`, `/settings`, billing) ask every time. Reading here taints the session | Reached by logging in through a ticket, or approving a proposal |
| `act_as_you` | personal | Post, vote, save, subscribe; asks unless granted. Irreversible actions always ask | Reached only by approval |

The settings page says: **"Anything the agent reads while signed in, it can repeat elsewhere."**

## Tokens

- **Read:** navigate, read, click, expand, search. Tighten only (block a site, revoke a grant, panic). Can't propose loosening. **[test planned: read token can't propose]**
- **Act:** everything Read can, plus acting on `act_as_you` sites, plus every setting. Loosening becomes a proposal ticket; the approval card shows a server-built diff and quotes the agent's reason as unverified.
- Every token has an agent name, written on every audit row. Setup preselects Read.
- A token unused for 90 days is revoked; a token in use never expires.
- Proposals: identical ones collapse; at most 3 open; a denied proposal can't be raised again for 24 h.
- **Panic** (UI or MCP, since it only tightens): suspends every token, drops all act and signed-in grants, closes sessions. Resuming is human-only.

### Human-only list (never in `capabilities.ts`)

Approving tickets and proposals; showing or regenerating tokens; unblocking LAN or sensitive categories; changing where notifications go; importing cookies or exporting the profile; resuming after panic; choosing which challenge resolvers are allowed (ADR 0001).

## What asks

| Class | Behaviour | Examples |
|---|---|---|
| Reading | Never asks | Click, expand, load more, paginate, GET search, scroll, consent "reject all", any public site in the anonymous profile |
| Consequential | Asks unless granted | Non-GET not on the site's read list; using your login on a `read` site; after taint, data to a domain the session hasn't used |
| Irreversible or private | Always asks | Pay/checkout, delete, change email or password, OAuth authorize, private messages, sensitive paths on signed-in sites |
| Not possible | Never | Typing into `type=password`, `autocomplete=cc-*`, `autocomplete=one-time-code` **[test: refuses typing into password, cc-*, one-time-code]**; eval, raw CDP, cookie or storage tools; downloads; `file:`, `chrome:`, `devtools:` URLs; typing on sign-in providers such as `accounts.google.com` **[test: refuses typing on sign-in providers]** |

## Approvals

1. **Notification**: agent, site and reason, from server-controlled fields only. Deny inline. Asks within 30 s merge.
2. **Link**: single use, bound to one ticket, valid 10 minutes, works only with a logged-in app session, never an agent token.
3. **Approval page**: only facts the browser observed (origin, method, path, GraphQL operation, form fields with agent-typed text highlighted, screenshot crop). Page labels and the agent's reason appear as quotes, marked unverified.
4. **Bound and rechecked**: an approval is tied to a hash of the request and the element's fingerprint; just before the click the browser checks what is under the click point.

| Button | Scope |
|---|---|
| Allow once | This exact request |
| For this task (default) | Token, site and action class. Ends at task end or 1 h idle; without a taskId, when the MCP session ends |
| Always | Site and action class. Never preselected. Lapses after 90 days unused. Offered after 3 "once" approvals for the same pair. Can be granted from the phone |
| Deny | Fails the request; the agent gets one sentence saying what happened |

If two-factor is on, approvals that loosen access ask for a fresh passkey or code. Buttons are disabled for 1 s after they appear.

While waiting, the gate holds the request for up to **20 s**, then fails it and opens a ticket. The agent retries with the approval id. **[test: held requests fail after the timeout; 20 s default]**

## Enforcement layers

| Layer | What it does |
|---|---|
| L1 Egress proxy | Chromium's only route out. Resolves DNS itself, checks every address, connects to the address it checked (defeats DNS rebinding). Refuses 0/8, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 192.0.0/24, 198.18/15, multicast, reserved, broadcast, ::, ::1, fe80::/10, fc00::/7, IPv4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96, 64:ff9b:1::/48), 6to4 (2002::/16), Teredo (2001::/32), ff00::/8, and the home's configured public IPs. QUIC off; WebRTC can't use UDP outside the proxy. **[test: proxy/test/ip.test.ts, proxy/test/proxy.test.ts]** |
| L2 Two profiles | Persistent anonymous profile (never signed in, keeps clearance cookies) and personal profile. The ladder picks one per tab. Third-party cookies blocked in both |
| L3 Tool layer | The token decides which tools exist. No eval, CDP or cookie tool. Credential fields refused by element type |
| L4 Element check before click | Element under the click point must match the ref and name, no overlay |
| L5 Network gate (authoritative) | CDP `Fetch` on every target (pages, iframes, workers). Non-GET not on the read list is held. Service workers off. WebSocket handshakes blocked by a DNR extension, since Fetch never sees them (ADR 0010); WebRTC denied UDP outside the proxy. Strictest of top-level site, frame site and destination. Every redirect hop rechecked. **[tests: browser/test/gate.test.ts]** |
| L6 Site adapters | Read operations, domain group, consent dismissal, block signatures, sensitive paths |

Accuracy and prompt-rate figures in the design review (for example "<2% of Reddit sessions with a false prompt") are **estimates, not measurements**. Step 1 measures what the gate catches; the rates come later with real adapters.

## Taint

After a session reads while signed in:

| New domain (not used by this session before the taint) | Result |
|---|---|
| Plain GET, no query string | Opens in the anonymous profile, no prompt |
| Query string, fragment data, or a long path segment (threshold tuned in step 1/3, e.g. >40 chars or matches read text) | Asks; the card shows each value and whether it overlaps text read while signed in |
| Form submit or any non-GET | Asks, with body fields |
| Domain used before the taint | Normal rules |

**[test planned: tainted session can't send a query to a new domain]**. Taint closes the browser as an exit; it can't stop an agent sending text through its own tools.

## Activity log

Records the **shape** of data, not values: per query/fragment/path segment/body field, the key name, value type, length, entropy band and a keyed hash. Who (agent, token, session, tab, profile, initiator), where (method, host, registrable domain, path, adapter operation, novelty), taint (source page, overlap), outcome (allowed, anonymous, asked→approved/denied, blocked, blocked_ad, with the deciding rule). Plain resource GETs are counted per domain per session. Append-only, 90 days. Flagged rows keep encrypted values for 30 days. The log is encrypted with the profiles.

Agents get `list_activity` (read-only, own rows, no values) and `flag_domain` (marks a domain hostile; only tightens, applies at once).

**v1 scope of `list_flags`:** it returns flags from the gate's real-time checks (read-text overlap, smuggling shape) and from `flag_domain` only. The traffic graph and fan-in scoring are **after v1**; the log collects what they need from v1 on.

## Captchas, logins and takeover

Per ADRs 0001 and 0011: `detect/` emits `BlockState` (`captcha`, `verification` for 3-D Secure and other step-up checks, `login`, `consent`, `soft_block`); `login` and `verification` always go to a person, and only a verified `login` changes the site ladder; the agent gets `{ state: "blocked", reason, ticket }`; tickets expire after 15 minutes. The only v1 resolver is human takeover. A verifier decides success; the person's "I'm done" triggers verification, and a failed check reopens the ticket. During takeover the agent is paused and sees nothing; the real origin is drawn outside the stream, with a warning when a password field is on a different origin from the ticket's. On hand-back the agent gets a fresh read, never a replay. Live view at 15 fps.

## Implementation notes (from building v1)

- **WebSockets** are invisible to CDP `Fetch` and `Network.setBlockedURLs`. A static `declarativeNetRequest` extension blocks every handshake (ADR 0010). Branded Google Chrome ignores `--load-extension`, so Crossbar runs Chromium or Chrome for Testing only.
- **DNS**: in the browser container, Chromium runs with `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE proxy`. It can't resolve any name except the proxy's, so there's no DNS channel around the proxy. DNS-over-HTTPS is off.
- **Background traffic**: Chromium's own phoning home is turned off with flags and managed policy (`deploy/browser/policies.json`). One request ignores every flag tried: Chrome's AI Mode eligibility check to `www.google.com`. It carries no page data, goes through the proxy, and is turned off by policy in the container. **[test: browser/test/proxy-chrome.test.ts]**
- **Sandbox**: Chromium's sandbox stays on. The browser container uses Docker's default seccomp profile plus `clone`, `unshare`, `setns` and `chroot` (`deploy/browser/seccomp.json`), with no capabilities and `no-new-privileges`.
- **Harbor installs** can't declare an internal network or a seccomp profile. The browser container firewalls itself to the proxy (`deploy/browser/egress-firewall.sh`, `net-admin` permission), then runs as a non-root user with no capabilities and `no-new-privs`. Chromium's sandbox can't start under Harbor's seccomp; the browser refuses to start until an operator turns the visible "Chromium sandbox" setting off. Crossbar never turns it off on its own.
- **Quiet refusals** (no ticket, no flag):
  - background writes from a tab whose page sits behind an open captcha or login ticket;
  - adapter-listed telemetry (Reddit's `pi.reddit.com`, `perfMetrics`, `/reports`).

  A captcha widget's own calls to its vendor (reCAPTCHA, hCaptcha, Turnstile, Arkose, DataDome) pass, except as an exit after a signed-in read. Asking about any of these trains people to rubber-stamp. **[test: live Reddit findings]**
- **Dev data** lives outside the repository (`~/.crossbar/dev`, mode 0700). `npm run lint` fails if a database, key, `.env` or profile is ever tracked.
- **Intranet names**: single-label hosts (`app`, `nas`), `.local`, `.lan`, `.internal`, `.home.arpa`, `localhost` and private IP literals are blocked on the ladder before the proxy sees them; the proxy refuses private addresses after DNS as the second layer.
- **Popups** opened by pages are closed: no tab owns them, so no policy fits. During takeover, a popup the person's tab opens (a "Sign in with…" window) joins the takeover with the same policy, and control returns to the tab when it closes. **[test: server/test/e2e.test.ts]**
- **Takeover reach**: a person driving a tab may use sites blocked for agents by default (sign-in providers are for humans only), but never LAN or private addresses, this app, or a site blocked on purpose.
- **Taint scope**: taint holds top navigations and every non-GET. Subresource GETs (images, scripts) to a new domain from a tainted session can't be held without breaking pages, so they're **refused** when a value overlaps signed-in text (24+ characters) or has a smuggling shape (a 48+ character high-entropy base64 or hex value, also inside a file name), and the domain is flagged. **[test: taint and subresources]** Short or paraphrased leaks in subresource URLs still get through; that's the residual.
- **Read-text overlap** is shown only for requests leaving for a domain the session hadn't used before the taint. Posting back to the same site isn't exfiltration, and showing overlap there would train people to ignore it.

## Settled decisions (11 Nov 2026)

1. **Taint rule kept**: allow until tainted; after that, new domains open anonymously or ask.
2. **Token expiry**: revoked after 90 days unused.
3. **Setup shows Read first**, Act beside it.
4. **Anonymous profile is persistent.**
5. **"Always" can be granted from the phone**, behind the app's own login (not Harbor's; see ADR 0008).

## Residual risk

- **Signed-in reads can leak** through the agent's own tools. Keep `read_as_you` narrow.
- **Writes that look like reads** (state-changing GETs, WebSocket protocols) on unknown sites. Mostly in the anonymous profile, where nothing is signed in.
- **Soft blocks** return 200 and look normal; the agent will sometimes report incomplete content as complete.
- **A compromised host** defeats at-rest encryption.
- **The log is sensitive**: encrypted, agents see only their own rows without values.
- **Rubber-stamping**: the defence is approval cards built from the browser's own facts.

## Corrections from the design pages

- The debate table said approvals sit behind "Harbor's login". The app has its own login (ADR 0008).
- The Charter's v1 tool list omitted `flag_domain`. It is a v1 tool.
- The blocked state is `blocked`, not `needs_human` (ADR 0001).
- "Your tap is the final say" on resolution is replaced by ADR 0001: the tap triggers the verifier, which decides.
