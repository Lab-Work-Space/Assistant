# R7 PLUGIN-FORGE base image (spec 7.2 BE1, PF-C23): the checked-in base every forged plugin image is committed on. Built by the owner with docker/forge/build.sh; the app never builds it.
# Same Node digest as the ws runner. Node only: npm, npx, corepack and yarn are removed. No VOLUME, no USER, no ENTRYPOINT: `docker commit --change` sets USER, WORKDIR, ENTRYPOINT and CMD (forge/builder.ts).
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
# G2-01: base ships zlib 1.3.2-r1 (CVE-2026-4738, Critical); fixed in 1.4-r0.
RUN apk upgrade --no-cache zlib
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /srv/plugin
