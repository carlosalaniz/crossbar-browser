# 0033: After a signed-in read, the person's own sites keep their login

- **Status:** Accepted (owner's decision, 13 Nov 2026)
- **Date:** 2026-11-13
- **Amends:** the Access Model's taint rule (threat model, "Taint"; settled decision 1).

## Context

Live (12 Nov 2026): an agent read Chase while signed in, then opened made-in-china.com, a site the person had set to `read_as_you`. The taint rule opened it in the anonymous profile, which is never signed in, so every page redirected to a login; Crossbar raised four login tickets and handed the person the anonymous profile to log in to. Gmail went the same way. The owner: this breaks the purpose of Crossbar; strictness should be a choice.

The taint rule exists for prompt injection: a page the agent reads tells it to carry what it read somewhere. That travels through the agent's own requests (an address with data in it, a form, a message), not through which profile a data-free page opens in. Those stay checked.

## Decision

- **Default:** after a signed-in read, a top-level open of a site the person set to `read_as_you` or `act_as_you` uses their login, as long as the address carries no data (no query, fragment data or long path segment). If it does, a person approves first, as before; once approved, it opens signed in. From then on the session treats the site as one it has used.
- **Unchanged:** sites without the person's login open anonymously after taint; an address carrying data to a new site asks; non-GET requests, typed text, the subresource checks and the always-ask classes are as before.
- **Strict mode** (Settings, human only; turning it off needs a fresh check with 2FA): the old rule, every new site opens anonymously after taint.
- **No login on the anonymous profile.** A login wall in the anonymous profile on a site with the person's login is not a ticket: the agent is told why it opened anonymously and what the person can do.
- **Pages close sooner:** an agent session's pages (one window each, ADR 0017) close after 10 quiet minutes (was 60), or when the agent calls the new `finish` tool. `finish` closes pages only; what the session read keeps counting, so read → finish → send is still checked.

## Consequences

- A session can move between the person's own sites (bank, mail, suppliers) signed in, which is what Crossbar is for.
- A misled agent can now open a data-free page on another of the person's sites while signed in and read it there. Sending anything from it is still checked as before; a site that acts on a bare address visit (rare) would act signed in. Strict mode removes this.
- Once a site is "used" after taint, addresses carrying data to it no longer ask in that session. The person chose to give that site their login; it is not an attacker's collection point.
