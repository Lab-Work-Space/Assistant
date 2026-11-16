# Model proxy (Gate 1 self-code X1): the only container that holds the dev-job key. Built after `npm run build`; copies only the compiled modules it needs.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY docker/chrome/package.json /app/package.json
COPY dist/devjob/modelproxy.js dist/devjob/modelproxy-main.js /app/devjob/
COPY dist/net/proxy.js /app/net/proxy.js
# G2C-01 style: no package manager in a runtime image (rule 21).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir /data && chown 65534:65534 /data
USER 65534:65534
CMD ["node", "/app/devjob/modelproxy-main.js"]
