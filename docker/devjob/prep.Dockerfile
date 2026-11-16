# Prep container (Gate 1 self-code X3): unpacks the source bundle and runs `npm ci --ignore-scripts` from the lockfile through the registry proxy.
# No secrets, no model access. Its only network is devjob_prepnet, whose only peer is the registry proxy. npm exists HERE only.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
# G2SC-05: the npm bundled with the base image carries undici 6.28.0 (two HIGH advisories); a pinned patched npm replaces it. Re-scan with grype after every bump.
ARG NPM_VERSION=12.2.1
ARG UNDICI_VERSION=6.29.1
# npm 12.2.1 still bundles undici 6.29.0 (GHSA-xjj6, qrxm, 2m5v: HIGH); undici has no runtime dependencies, so the patched release replaces the bundled copy.
RUN npm install -g --ignore-scripts npm@${NPM_VERSION} \
 && cd /tmp && npm pack --silent undici@${UNDICI_VERSION} && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici && mkdir /usr/local/lib/node_modules/npm/node_modules/undici \
 && tar -xzf undici-${UNDICI_VERSION}.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/undici && rm -f undici-*.tgz && npm -v >/dev/null \
 && apk add --no-cache git \
 && mkdir -p /work /opt/devjob /home/agent && chown 65534:65534 /work /home/agent
COPY docker/devjob/prep.sh /opt/devjob/prep.sh
RUN chmod 0555 /opt/devjob/prep.sh
WORKDIR /work
USER 65534:65534
ENTRYPOINT ["/opt/devjob/prep.sh"]
