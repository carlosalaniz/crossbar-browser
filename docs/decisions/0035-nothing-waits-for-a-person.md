# 0035: Nothing in the browser waits for a person who isn't there

- **Status:** Accepted (owner's decision, 13 Nov 2026)
- **Date:** 2026-11-13

## Context

In the container Chrome runs on a screen nobody watches. Live (13 Nov 2026), Ad-Shield on solsticeforum.com opened a confirm dialog when its blocked loader failed; the page's scripts stopped, every Crossbar call to the page hung, and the agent stopped. Other things wait the same way: Chrome's own sign-in box for HTTP authentication, file pickers, a crashed page, a dead Chrome, a page that freezes in a script.

## Decision

- **Dialogs** (`alert`, `confirm`, `prompt`, "leave this page?") are answered by Crossbar after about a second: OK to a plain message; Cancel to any question, so Crossbar never says yes for the agent; "leave" only when the agent itself asked to leave (open, back) in the last 20 s. The agent's next tool result says what the page showed (quoted as page text) and what Crossbar answered (`pageEvents`).
- **During takeover** dialogs aren't answered automatically: the take-control screen shows the page's text and OK/Cancel (and a field for a prompt), since Chrome draws dialogs outside the stream. When the takeover ends, an open dialog gets Cancel.
- **HTTP sign-in boxes** (401/407) are cancelled by the gate (`handleAuthRequests`); the agent is told.
- **File pickers** are intercepted, so Chrome's window never opens; the agent is told nothing was picked.
- **A crashed page** is reloaded once; the agent is told to read again.
- **A dead Chrome** is forgotten by the pool, and its tabs are closed, so the next tab launches a new browser. **A tab that goes away** (the page closed itself, a crash, Chrome exited) is dropped from the agent's session, so the next open starts a fresh one.
- **No Chrome command waits forever:** each times out after 60 s with "the page may be frozen".
- **Blocked requests can get a stand-in:** a filter with `redirect=` (uBO's `noopjs`, `1x1.gif`...) is answered by the gate with that harmless body (`Fetch.fulfillRequest`) instead of an error. Ad-Shield's domains get stand-ins, so the page believes its loader ran and doesn't break itself (ADR 0034's blanket block of them is replaced).

## Consequences

- An agent can't be stopped by a page asking a question; a question that matters (delete, pay) still never gets a yes without a person.
- Timing: Crossbar answers in 0.6-1.4 s, about as fast as a person reading a short message.
- A site that needs HTTP sign-in or a file upload can't be finished in Crossbar yet, by an agent or by a person in take control: both are cancelled there too. Uploads from the phone are a later step.
