# 0036: uBO's header rules in the gate; takeover keeps ad blocking

- **Status:** Accepted (owner's decision, 13 Nov 2026: "just kill ads and make it good")
- **Date:** 2026-11-13
- **Amends:** ADR 0034 (uBlock Origin's lists), audit S22 (ad blocking during takeover).

## Context

On solsticeforum.com the owner still saw ads that Brave hid. Compared on the same page:

- **Network blocking matched Brave's** for the ad stack (`config.htplayground.com`, EasyPrivacy) and Google's ad scripts.
- **Ad-Shield got through.** Its loader's address changes on every load: one visit used `stg.html-load.com/loader.min.js` (blocked by a uBO rule for this site), the owner's visit used `stg.content-loader.com/script/www.solsticeforum.com.js`, which nothing blocked, and dozens of `*.stg.content-loader.com/session/...` requests then brought the ads in. uBO catches that loader with `/…\/script\/….js$/$script,3p,header=x-length`: only the `X-Length` response header its server sends identifies it. `@ghostery/adblocker` drops `header=` rules (9 in uBO's lists today).
- **Takeover turned ad blocking off entirely** (S22), so a person taking control of any page saw every ad.

## Decision

- **Header rules run in the gate.** Crossbar parses uBO's `header=` rules itself (`browser/src/adblock-headers.ts`): address (regex or `||host^` pattern), type, party (`1p`, `3p`, `strict1p`, `strict3p`), `domain=`/`from=`, `to=`, and the header (present, literal, or `/regex/i`). A rule with any option it can't apply exactly is skipped, never guessed. An allowed request that a rule could match is continued with `interceptResponse`; when its response arrives the gate checks the headers and fails it as `blocked_ad`, or lets it through. Only those requests pause twice.
- **The rules travel with the engine cache** (`adblock-ubo2-*.bin`: the engine, then the rules' lines). An older cache loads as the bare engine.
- **Takeover keeps ad blocking**, except for sign-in (`login`) and payment-verification tickets, where a bank's fraud scripts must load (the reason for S22). Pages a person opens while in control get the cosmetic hiding an agent's pages get.

## Consequences

- Ad-Shield's per-site loader is blocked before it runs, as with uBO; the rest of uBO's anti-adblock defence (scriptlets) is still missing, so other Ad-Shield variants may still show ads or a wall.
- A captcha or consent takeover runs with ad blocking: a challenge that needs a blocked script fails, and the person can turn ad blocking off for that site. Challenge vendors' own scripts aren't on the ad lists.
- Response checks add one protocol round trip to the few requests that match a header rule's address.
