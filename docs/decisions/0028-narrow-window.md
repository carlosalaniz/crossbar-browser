# 0028: The narrow window is the default

- **Status:** Accepted (owner's decision, 12 Nov 2026)
- **Date:** 2026-11-12
- **Amends:** ADR 0006 (desktop viewport by default) and ADR 0015 (device per session).

## Context

Pages shown at desktop width are tiny on the owner's phone during takeover. An emulated phone (ADR 0006's mobile profile) is a weaker disguise on a Linux desktop browser: its GPU, fonts and hardware still say desktop, and touch is emulated (audit S12). A desktop browser in a narrow window is a real setup people have (split screens, docked windows), and responsive sites switch to their phone layout on their own.

Measured (Chromium 156 under Xvfb, 12 Nov 2026): Chrome won't make a window narrower than 500 px, even when asked for 300 or 390. A 500 px page matches `max-width: 600px`.

## Decision

- Each site has a device: **narrow** (default), **desktop** or **mobile**.
- **narrow:** the desktop browser as it is (user agent, client hints, pointer, GPU unchanged), in a window 500 px wide, as narrow as a person can drag it, and 1170 px tall, so the page is 500x1083: a 390x844 phone's shape (0.46). The container screen is 1920x1200 (16:10) so it fits.
- **desktop:** the window fills the screen.
- **mobile:** the emulated phone of ADR 0006, unchanged.
- The device is fixed per site for the whole session, takeover included (ADR 0015). Each tab has its own window (ADR 0017), so each is sized to its site.
- Site rules saved before this decision had `desktop` only because it was the default; they move to `narrow` once.

## Consequences

- Sites that pick their mobile version by user agent (`m.` domains) still serve desktop pages, in a narrow window.
- Sites with breakpoints below 500 px show a compact desktop layout.
- On a phone, takeover shows the page at about 0.8 scale instead of about 0.3.
