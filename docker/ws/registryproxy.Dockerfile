# Registry reverse proxy for the ws runner (SA-1 C2): GET/HEAD of package documents and tarballs only, upstream fixed. Holds no secret.
# Build context is the repo root after `npm run build` (docker/ws/build.sh does both).
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
# G2-01: base ships zlib 1.3.2-r1 (CVE-2026-4738, Critical); fixed in 1.4-r0.
RUN apk upgrade --no-cache zlib
WORKDIR /app
COPY docker/chrome/package.json /app/package.json
COPY dist/devjob/registryproxy.js /app/devjob/registryproxy.js
COPY dist/workspaces/registryproxy-main.js /app/workspaces/registryproxy-main.js
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER 65534:65534
CMD ["node", "/app/workspaces/registryproxy-main.js"]
