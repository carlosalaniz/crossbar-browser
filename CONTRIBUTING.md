# Contributing

Read [AGENTS.md](AGENTS.md). It is the front door for people and agents alike, and its rules apply to you.

In short:

- A human opens every pull request, signs the CLA, and answers for the code. Agent co-authorship goes in commit trailers.
- `npm ci && npm run check` must pass.
- Security behaviour comes with its test in the same PR.
- No live websites in tests.
- Changes to `auth/`, `browser/`, `proxy/`, tokens or capabilities need owner review.
- Report vulnerabilities privately (see [SECURITY.md](SECURITY.md)), never in a public issue.

**CLA:** the agreement text is not written yet (ADR 0007). Until it is, outside contributions can't be merged.
