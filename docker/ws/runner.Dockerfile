# ws runner (SA-1 C3): one fresh container per ws_run command, started by workspaces/runner.ts with a fixed argv (no USER line: the uid comes from --user).
# /home/ws is the mount point of a tmpfs that inherits this mode (1777): the container's --user is the owner's uid, which has no entry here.
# npm exists here (npm ci / install / test / run); no git, no corepack, no yarn. ENTRYPOINT is empty: the command is given by the argv.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
# Same npm and undici patch as docker/devjob/prep.Dockerfile (G2SC-05): the bundled undici 6.29.0 has three HIGH advisories.
# G2-01: base ships zlib 1.3.2-r1 (CVE-2026-4738, Critical); fixed in 1.4-r0.
RUN apk upgrade --no-cache zlib
ARG NPM_VERSION=12.2.1
ARG UNDICI_VERSION=6.29.1
RUN npm install -g --ignore-scripts npm@${NPM_VERSION} \
 && cd /tmp && npm pack --silent undici@${UNDICI_VERSION} && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici && mkdir /usr/local/lib/node_modules/npm/node_modules/undici \
 && tar -xzf undici-${UNDICI_VERSION}.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/undici && rm -f undici-*.tgz && npm -v >/dev/null \
 && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /work /home/ws && chmod 1777 /home/ws
WORKDIR /work
ENTRYPOINT []
