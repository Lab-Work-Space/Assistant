# R6 MCP-1 BE3: the repo's own fixture MCP server (tests/fixtures/mcp/echo-server.mjs) as an image, for the Docker acceptance tests ONLY. It is built locally by
# mcp/docker.int.test.ts (docker build --pull=false) and referenced by image id; it is never pulled, pushed or installed as a real server. The base is the node:22-alpine
# image that the other local images already use; no package is installed. No VOLUME (MC-C2 refuses one), no USER line (the sandbox argv sets --user 65534:65534).
# Build:  docker build --pull=false -f docker/mcp/fixture.Dockerfile --iidfile /tmp/mcp-fixture.iid tests/fixtures/mcp
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
COPY echo-server.mjs /srv/echo-server.mjs
ENTRYPOINT ["node", "/srv/echo-server.mjs"]
