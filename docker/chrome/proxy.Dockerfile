# Guard proxy for the Chrome container (Gate 1 Part C, C24). Built by `npm run local:chrome` after `npm run build`; copies only the
# compiled net/ modules (no secrets, no node_modules: the proxy has no dependencies). Base image pinned by digest (global rule 21).
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY docker/chrome/package.json /app/package.json
COPY dist/net/address.js dist/net/fetch.js dist/net/proxy.js dist/net/proxy-main.js dist/net/system.js /app/net/
# G2C-01: the proxy never runs a package manager; its bundled npm/corepack/yarn only carry advisories (rule 21).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
CMD ["node", "/app/net/proxy-main.js"]
