# Registry reverse proxy for the prep container (Gate 1 self-code X3): GET/HEAD of package documents and tarballs only, upstream fixed. Holds no secret.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY docker/chrome/package.json /app/package.json
COPY dist/devjob/registryproxy.js dist/devjob/registryproxy-main.js /app/devjob/
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER 65534:65534
CMD ["node", "/app/devjob/registryproxy-main.js"]
