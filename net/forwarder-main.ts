import { createForwarder, inCidr } from './proxy.js';

/**
 * Entry point of the document renderer's forwarder container (docker/render/forwarder.Dockerfile, RF15). It runs NO proxy and mints no sessions: it only
 * forwards a TCP connection from the host (127.0.0.1, published by the compose file) to the renderer Chrome's DevTools port, and only after the first
 * request carried the per-boot bearer token. Callers from the renderer's own network are refused, so a document cannot drive the browser that renders it.
 *   FWD_PORT (9224)      port to listen on (published on the host's 127.0.0.1 only)
 *   FWD_TARGET           renderer host:port, for example 10.88.78.3:9222
 *   ACCESS_TOKEN         per-boot secret, at least 32 characters
 *   INTERNAL_CIDR        the renderer's network
 */
const env = process.env;
const internal = env.INTERNAL_CIDR;
const token = env.ACCESS_TOKEN ?? '';
const [host, port] = (env.FWD_TARGET ?? '').split(':');
const listen = Number(env.FWD_PORT ?? 9224);
if (!internal) {
  console.error('INTERNAL_CIDR is required');
  process.exit(1);
}
if (token.length < 32) {
  console.error('ACCESS_TOKEN (at least 32 characters) is required');
  process.exit(1);
}
if (!host || !Number.isInteger(Number(port)) || !Number.isInteger(listen)) {
  console.error('FWD_TARGET host:port is required');
  process.exit(1);
}
createForwarder({ host, port: Number(port) }, (remote) => !inCidr(remote, internal), token).listen(listen, '0.0.0.0');
console.log('renderer forwarder up');
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => process.exit(0));
