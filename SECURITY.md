# Security policy

Crossbar holds people's logins and drives their browser. Treat every bug in `auth/`, `browser/`, `proxy/`, tokens, capabilities, the network gate or the taint rule as a potential vulnerability.

## Reporting

Use **GitHub private vulnerability reporting** on this repository (Security → Report a vulnerability). Do not open a public issue, discussion or pull request for a vulnerability.

Include what you did, what you expected, what happened, and the version or commit. A proof of concept against a local test page is ideal; please don't test against other people's accounts or real sites you don't own.

## Scope

In scope: escaping the network gate, reaching private ranges through the proxy, typing into credential fields, approving one's own request, a read token loosening anything, leaking data from a tainted session through the browser, bypassing route authentication, reading another household member's data.

Out of scope: an agent repeating text through its own tools after it read it (documented residual risk in `docs/threat-model.md`), and attacks that require an already-compromised host.
