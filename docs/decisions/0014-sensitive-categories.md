# 0014: Sensitive categories are account permissions

- **Status:** Accepted (owner's decision, 11 Nov 2026)
- **Date:** 2026-11-11
- **Amends:** the Access Model's site ladder ("Blocked by default: mail, banking, password managers, cloud consoles"). Unblocking stays on the human-only list.

## Context

Live, an agent opened `schwab.com`: brokerages weren't on the hand-kept default-blocked list. The owner's rule: everything should be possible with enough permission. Banking (and the other sensitive kinds of site) should be one explicit permission on the Crossbar account, not a per-site exception.

## Decision

- Sensitive sites are grouped into **categories**: banking and money (banks, brokerages, payment apps, crypto), email, password managers, cloud consoles, account and sign-in pages, government and taxes.
- Each category is a **permission on the Crossbar account**, off by default. Only a person turns it on or off, in Settings (`PUT /api/settings/categories`; with 2FA on, turning one on needs a fresh check). No tool can.
- **Off:** the category's sites are blocked for agents, and the agent is told which category it is, that only the person can turn it on, and not to ask for passwords or codes.
- **On:** its sites follow the normal ladder. Reading is anonymous; a login goes to the person through a ticket (raising the site to "can read as you"); payments, deletions and credential changes still ask every time; agents still never type passwords, one-time codes or card numbers.
- A person's own rule for a host or domain wins over the category (allow one bank with banking off, or block one bank with banking on).
- LAN and private addresses are not a category: they stay blocked, and a person changes them per host.
- The host lists are hand-maintained in `server/src/sites.ts` and will miss sites. They move to data with the rules engine (START.md, Later).

## Consequences

- One switch instead of a growing list of exceptions, and an agent that explains the situation instead of improvising (an agent offered to type the user's Schwab password).
- A site missing from a category list behaves like any public site: readable anonymously, everything with consequences asks.
