# 0034: uBlock Origin's filter lists, in our own engine

- **Status:** Accepted (owner's decision, 13 Nov 2026)
- **Date:** 2026-11-13
- **Amends:** ADR 0003 (ad blocking: EasyList and EasyPrivacy).

## Context

Ads still polluted what agents read. The owner asked for uBlock Origin. Chromium removed Manifest V2 (the last switches went with Chrome 151, July 2026), so uBlock Origin itself can't run in Crossbar's Chrome for Testing 157; uBO Lite (MV3) could, but blocks outside the network gate (no `blocked_ad` rows, no per-site switch, no pause during takeover). Brave keeps MV2 for now, but changes the browser's fingerprint, and its MV2 support is a patch that can end.

Most of uBlock Origin's advantage is its lists and its extended rules (`:has-text()` and friends), and `@ghostery/adblocker` reads both.

## Decision

- The engine is built from uBlock Origin's default lists: uBlock filters, Privacy, Badware, Quick fixes, Unbreak, and the EasyList and EasyPrivacy copies uBO ships (`ublockorigin.github.io/uAssets`). The app fetches them, never the browser; rebuilt daily (cached in `adblock-ubo.bin`), falling back to the prebuilt EasyList engine if the lists can't be fetched.
- Extended rules are evaluated in Crossbar's isolated world at each read; matched elements are left out of what the agent reads. The live page isn't changed by them (plain CSS hide rules are still applied as before).
- Cosmetic rules are looked up by registrable domain: with the full hostname, rules for `amazon.com` never applied on `www.amazon.com` (found while measuring).
- Not yet: scriptlets (`+js(...)`), which must run in the page's own world. That needs its own decision and a check on the detection page.

## Consequences

- Sponsored results and site-specific ads that EasyList alone missed drop out of reads; network blocking catches more.
- Ad blocking stays in the gate: per-site switches, pausing during takeover (S22) and `blocked_ad` activity rows keep working, and it doesn't depend on any browser's extension policy.
- Building takes about a second (measured: 6.3 MB engine, 6 ms to load from cache).
