# Agent container (Gate 1 self-code X4, X6): the pinned `claude` CLI, git and a shell. NO npm, npx or corepack in the final image (rule 21).
# Its only network is devjob_agentnet, whose only peer is the model proxy; it gets a per-job credential, never the key.
ARG CLI_VERSION=2.1.314
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS cli
ARG CLI_VERSION
# The package ships a native binary per platform as an optional dependency; install scripts stay off and the musl binary is copied out.
RUN npm install -g --ignore-scripts @anthropic-ai/claude-code@${CLI_VERSION} \
 && B=$(find /usr/local/lib/node_modules -path '*linux-*musl*' -type f -name claude | head -1) && test -n "$B" && mkdir /out && cp "$B" /out/claude

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
RUN apk add --no-cache git bash \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /work /opt/devjob /home/agent && chown 65534:65534 /work /home/agent
COPY --from=cli /out/claude /usr/local/bin/claude
RUN chmod 0555 /usr/local/bin/claude
COPY docker/devjob/agent.sh docker/devjob/export.sh /opt/devjob/
RUN chmod 0555 /opt/devjob/agent.sh /opt/devjob/export.sh
WORKDIR /work
USER 65534:65534
ENTRYPOINT []
CMD ["/opt/devjob/agent.sh"]
