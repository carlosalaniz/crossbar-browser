# 0002: Extraction pipeline

- **Status:** Accepted
- **Date:** 2026-11-11

## Context

Agents read pages as markdown and act on elements by ref. Extraction has to be good on article pages, degrade gracefully elsewhere, and not carry hidden text that a page uses for prompt injection.

## Decision

- Use `defuddle` (MIT, v0.19.x) directly, with `useAsync: false`.
- Borrow from [MD-This-Page](https://github.com/Ademking/MD-This-Page) (MIT; credit it in the source and NOTICE):
  - whole-page fallback when Defuddle extracts too little;
  - `cloneVisible`, which drops hidden text (and with it, hidden prompt injection);
  - waiting for single-page apps to render;
  - the esbuild fix for astral-plane characters.
- Add `data-cb-ref` tags on live elements so refs survive conversion to markdown.
- Add a separate pass that lists every visible anchor and button with ref, text, href and page region.
- One extraction, two outputs: `content` and `content+links`.
- The script runs in a CDP **isolated world** (see 0005).

## Consequences

- Refs point at live elements, so a click resolves to the element the agent saw, and the element check before click (Access Model L4) has something to compare.
- Hidden-text stripping is a mitigation, not a guarantee: visible injected text still reaches the agent.
