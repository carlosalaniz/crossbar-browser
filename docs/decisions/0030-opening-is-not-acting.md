# 0030: A click that only opens something isn't acting as you

- **Status:** Accepted (owner's decision, 13 Nov 2026)
- **Date:** 2026-11-13
- **Amends:** ADR 0027 (a page's own background requests pass) and the 3-second trigger window it relies on.

## Context

Live on Gmail, an agent clicked the settings gear to open the menu. Gmail sends a sync POST every second or so, one landed within 3 seconds of the click, and Crossbar counted it as caused by the agent: the person was asked to approve "POST /mail/u/0/" for opening a menu. ADR 0027 already lets the same request through when no agent action is near; only the timing made it a question.

The owner's rule (12 Nov 2026): ask only for what acts as the person, like logging in and posting.

## Decision

- Each click has an intent, decided in the page before the click:
  - **open**: it only shows something. A button that opens a popup or a disclosure (`aria-haspopup`, `aria-expanded`), a tab, a `<summary>`, a link to a real address, or a control named for showing (Settings, Menu, More, Show, View, Close, Cancel, Back, Filter, Sort, Search…).
  - **act**: everything else, and always: a form's submit button, an option, checkbox, radio or switch (choosing changes something), and any control named for doing (Send, Post, Save, Apply, Delete, Buy, Pay, Confirm, Reply, Follow, Set, Done…). Unclear means act.
- What a page sends within 3 seconds of an **open** click is judged as ADR 0027 judges the page's own requests: it passes (rule `after_open_click`) unless it carries text read while signed in, carries text the agent typed, or is an always-ask class (pay, delete, credentials, OAuth, private message, sensitive path).
- Typing with Enter is always act. An **act** click keeps today's behaviour: its writes are held and a person is asked.

## Consequences

- A page can mislabel a control (call a button "Settings" or give it `aria-haspopup`). What it gains is no more than ADR 0027 already allows its own scripts without any click: the taint, typed-text and always-ask checks still apply, and those are what stop real harm.
- Choosing a picture theme in Gmail still asks (an option is a choice). Opening the picker doesn't.

## Also in this change (no policy change)

- `look` returns a screenshot of an element or the visible page. Seeing is reading: on a signed-in page it taints the session like `read`, and the text in that area goes into the read index. Text that exists only as pixels (a canvas, an image of text) isn't indexed, so a paraphrase of it could leave unnoticed; that's the same class of known gap as short or paraphrased leaks (threat model).
