# Test/build container (Gate 1 self-code X4, X5): NO network at all, no secrets. Runs the FIXED commands of test.sh on a tree whose dependencies were installed by prep.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
RUN apk add --no-cache git \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /work /opt/devjob /home/agent && chown 65534:65534 /work /home/agent
COPY docker/devjob/test.sh /opt/devjob/test.sh
RUN chmod 0555 /opt/devjob/test.sh
WORKDIR /work
USER 65534:65534
ENTRYPOINT ["/opt/devjob/test.sh"]
