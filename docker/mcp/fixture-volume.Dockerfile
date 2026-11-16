# R6 MCP-1 BE3 (MC-C2): the fixture image PLUS a VOLUME. Test-only negative case: mcp/docker.int.test.ts builds it locally to prove the admin refuses an image that declares a volume (E_IMAGE).
# Same local base and context as fixture.Dockerfile; nothing is pulled.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
COPY echo-server.mjs /srv/echo-server.mjs
VOLUME /data
ENTRYPOINT ["node", "/srv/echo-server.mjs"]
