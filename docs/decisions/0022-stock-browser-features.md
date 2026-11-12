# 0022: Re-enable stock browser features the gate already sees

- **Status:** Proposed
- **Date:** 2026-11-12

## Context

Launch flags and managed policy turn off network prediction, prerender, hyperlink auditing pings and similar features (audit S29). Their absence changes traffic and timing compared with a stock Chrome.

## Proposal

For each feature, a real-browser test shows whether its requests pass through the network gate and the egress proxy:

| Feature | Re-enable if |
|---|---|
| Speculation rules / Prerender2 | prerendered targets are auto-attached and paused like any other target |
| Link prefetch | requests show in the gate as GETs from the page's target |
| Hyperlink auditing (`<a ping>`) | the ping POST is held like any other write (it is a POST) |
| Network prediction (DNS preconnect) | stays off: it resolves names outside the proxy |

Only features that pass are re-enabled; each keeps its test.
