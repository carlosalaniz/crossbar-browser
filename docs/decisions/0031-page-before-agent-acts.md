# 0031: Until the agent acts on a page, everything the page sends is its own

- **Status:** Accepted (owner's decision, 13 Nov 2026)
- **Date:** 2026-11-13
- **Amends:** ADR 0027 (a page's own background requests pass) and ADR 0030 (opening is not acting).

## Context

One live Gmail run ("change my background") held 20 requests; one of them was the agent acting as the person (choosing a theme).

- 13 were Gmail's own error reports (`POST /mail/u/0/jserror`). They carried 78-91 characters of text the agent had read in Gmail, so the taint check held them, although they were going back to google.com, where the text came from. Gmail retried each one when its hold ran out.
- 6 were `POST taskassist-pa.clients6.google.com/v2/taskassist:compose`, sent by Gmail on every load with no agent action: a 139-byte body of nulls and two numbers. The path contains "compose", so it was classed as a private message, which always asks.

The owner's rule: if the agent clicked something, look at what follows; otherwise what the page sends is fine, even a "send", because it would happen with the person just sitting there.

A send can leave long after its click (Gmail's Undo Send waits 5-30 seconds, retry queues longer), so "clicked something" has to mean *since the page loaded*, not within the 3-second trigger window.

## Decision

- **Before the agent acts on a page** (no act click, no typing since the document loaded), the page's own requests pass, including the always-ask classes (pay, delete, credentials, OAuth, message, sensitive path), with rule `page_before_agent_acted`.
- **After the agent acts on the page**, the page's own requests pass as in ADR 0027, except the always-ask classes, which ask. A new document in the tab clears the mark. Open clicks (ADR 0030) don't set it.
- **Within 3 seconds of a click** nothing changes: an act click's writes are held; after an open click, the always-ask classes still ask.
- **Text read while signed in** only counts when the request leaves the site it was read on: the page's registrable domain and its adapter's domain group (Google: google.com, gstatic.com, googleusercontent.com, ggpht.com). Sending it back to that site leaks nothing.
- **Unchanged:** text the agent typed (3+ characters) is held wherever and whenever the page sends it; the taint rules for navigations and subresources; site blocking, LAN and private addresses; WebSockets (ADR 0020); the egress proxy.

## Consequences

- A page can do anything by itself before the agent touches it, as it would with the person watching: the agent caused none of it.
- A single-page app keeps its document, so once the agent acts in Gmail, the always-ask classes keep asking until Gmail reloads. Gmail's taskassist call after an agent click is still held (no notification; it expires).
- Opening a crafted address isn't counted as acting: a site that sends a message merely because an address was visited would pass. The typed-text and taint checks still apply to what it carries.
