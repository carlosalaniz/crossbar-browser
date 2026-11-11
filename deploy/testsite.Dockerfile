# SPDX-License-Identifier: AGPL-3.0-only
# Dev-only image for the local test site (`dev` compose profile). No runtime dependencies: Node runs
# the TypeScript sources directly. testsite.test forwards to browser/test/site.ts, which serves the
# browser/ test pages and the detect/ and adapters/ fixtures, so those are copied too.
ARG NODE_IMAGE=node:26-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /srv
COPY testsite/package.json testsite/scenarios.json ./testsite/
COPY testsite/src ./testsite/src
COPY browser/test/site.ts ./browser/test/site.ts
COPY browser/test/pages ./browser/test/pages
COPY detect/fixtures ./detect/fixtures
COPY adapters ./adapters
ENV TESTSITE_BIND=0.0.0.0 TESTSITE_PORT=8090
USER node
EXPOSE 8090
CMD ["node", "testsite/src/main.ts"]
