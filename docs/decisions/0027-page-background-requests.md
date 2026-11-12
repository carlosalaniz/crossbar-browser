# 0027: A page's own background requests pass

- **Status:** Accepted (owner's decision, 12 Nov 2026)
- **Date:** 2026-11-12
- **Amends:** the Access Model's "non-GET not on the read list is held" for requests no agent action caused.

## Context

Live on made-in-china.com, every page's own performance tracker, push check and probe request was held for 20 seconds and then dropped, and each left an approval card nobody could act on. A site whose own scripts always fail is a bot signal and can break the page, and a Requests list full of cards that don't matter teaches the person to approve without reading.

The owner's rule: anything that would happen in a browser with the person sitting in front of it is fine. People don't watch the network tab.

## Decision

- A non-GET request a page sends with no agent action on that tab in the last 3 seconds (`trigger: page`) passes, to its own site or any other, with rule `page_background`, for read and act tokens alike.
- It is still held, as before, if:
  - it carries text read while the session was signed in (24+ characters of overlap): the taint rule;
  - it carries text the agent typed (3+ characters), however long after the typing: a misled agent could type what it read into a field and leave the page to send it;
  - its class is irreversible or private (pay, delete, account security, OAuth, private message, sensitive path): no page does those without a click.
- Held page requests that run out of time are expired at once, so they leave Requests.
- Unchanged: everything an agent's click or Enter causes; site blocking, LAN and private addresses; WebSockets (ADR 0020); the egress proxy.
- Requests are classified by their path and GraphQL operation, never by their query (trackers carry the page's URL as a parameter), plus checkout/pay/billing hosts.

## Consequences

- A site's own scripts can send what they collected about the page to their servers or to third parties, as in any browser. Text the agent typed or read while signed in can't leave that way.
- Short or paraphrased leaks after taint still pass, as before (threat model, known gaps).
