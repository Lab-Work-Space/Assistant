# DevTools forwarder for the document renderer (Gate 1 RF15). Built by `npm run local:render` after `npm run build`; copies only two compiled modules
# (no proxy code path is started, no secrets, no node_modules). Base image pinned by digest (global rule 21), the same as the web Chrome's guard proxy.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY docker/chrome/package.json /app/package.json
COPY dist/net/proxy.js dist/net/forwarder-main.js /app/net/
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
CMD ["node", "/app/net/forwarder-main.js"]
