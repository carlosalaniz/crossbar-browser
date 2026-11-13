# 0032: The desktop window is the default again; the phone gets a magnifier

- **Status:** Accepted (owner's decision, 13 Nov 2026)
- **Date:** 2026-11-13
- **Supersedes:** ADR 0028 (the narrow window is the default). Narrow stays as a per-site choice.

## Context

ADR 0028 made a 500 px window the default so pages would be readable on the owner's phone during takeover. Live in Gmail (12 Nov 2026) it broke the theme dialog: the dialog keeps its desktop width, so its Save button sat past the window's edge where nothing scrolls, and the agent switched the site to desktop to get on. Wide dialogs, tables and admin pages are common, and the agent works best on the layout the site was built for.

The problem ADR 0028 solved was the person's view, not the browser's. A magnifier on the phone fixes that view without the page knowing: the person sees part of the desktop page at a readable size, as Windows Magnifier shows part of the screen and follows the mouse and focus.

## Decision

- **Every site opens in the full desktop window by default.** Rules saved as `narrow` because of ADR 0028's default move to `desktop` once. `narrow` and `mobile` stay as choices per site.
- **On a phone, take control is a magnifier** over the desktop page:
  - it opens zoomed in (about 0.6 page px per screen px), on the first text field if the page has one, else the top middle;
  - one finger moves the magnified view and sends the page nothing;
  - two fingers moving together scroll the page (real wheel events where the fingers are); spreading or closing them zooms instead; which of the two is decided once per gesture;
  - a tap clicks; hold (450 ms), then drag, is a mouse drag in the page (sliders, puzzles, reordering);
  - when a field takes focus, the view goes to it and stays above the keyboard (as before);
  - "Zoom" switches between the whole page and the magnifier.
- **The stream sends frames up to 2048 px** (it was 1280), so the magnified view is sharp. Cost (estimated, not yet measured): a frame only when the screen changes; roughly 16-24 Mbps peak while the page moves, near nothing when still.
- A site set to the emulated phone (ADR 0006) still gets real touch events, unchanged.

## Consequences

- Sites see one ordinary desktop browser; the narrow-window click problems (controls past the window's edge) mostly go away.
- One finger no longer scrolls the page on a phone; two fingers do. The hint says so when take control opens.
- On a weak mobile connection, full-size frames may lag; a cap or a cropped stream can come later if measured.
