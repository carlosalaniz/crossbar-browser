# 0007: License

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision

- AGPL-3.0 (`AGPL-3.0-only`), with a Contributor License Agreement.
- The human who opens a pull request signs the CLA and answers for the code. Agents can't sign; agent co-authorship goes in commit trailers.
- Every source file starts with `SPDX-License-Identifier: AGPL-3.0-only`. `npm run lint` checks it.

## Consequences

- Anyone running a modified Crossbar as a network service must publish their changes.
- The CLA keeps relicensing and commercial licensing possible for the owner.
- The CLA text still needs to be written, ideally with an IP lawyer; until then, no outside contributions are merged.
