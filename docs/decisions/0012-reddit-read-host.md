# 0012: Reddit read host per profile

- **Status:** Accepted
- **Date:** 2026-11-11
- **Amends:** [0004](0004-scroll-and-extract.md) ("The Reddit adapter prefers old.reddit.com pagination").

## Evidence (live, 11 Nov 2026)

- Logged out, `old.reddit.com` redirects to a login page (`/login/?reason=lor2`) in a normal, visible Chrome.
- `www.reddit.com` serves listings to a visible Chrome when logged out.
- Headless Chrome is blocked on both ("You've been blocked by network security").
- After repeated visits from one IP, Reddit shows "Prove your humanity" (a captcha) even to a visible Chrome.

## Decision

- Adapters declare `readHosts: { signedIn, anonymous }` instead of one preferred host.
- Reddit: anonymous reads use `www.reddit.com`; signed-in reads use `old.reddit.com`, which still paginates server-side.
- The rewrite only swaps between the site's own read hosts and its `www` and apex hosts.
- `detect/` treats "Prove your humanity" as a captcha and "blocked by network security" as a soft block. Both go to a person.
- `npm run dev:local` runs a visible Chrome by default, like production.

## Consequences

- Anonymous Reddit reads scroll the infinite `www` feed (scroll-and-extract, ADR 0004), not old Reddit's pagination.
- Repeated agent visits from one IP will meet captchas. That's by design: a person solves them, and the clearance stays in the persistent anonymous profile.
