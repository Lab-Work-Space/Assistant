import { isBlockedAddress } from './address.js';
import { createCheckTarget } from './fetch.js';
import { createControlServer, createForwarder, createGuardProxy, inCidr } from './proxy.js';
import { systemResolver } from './system.js';

/**
 * Entry point of the guard-proxy container (docker/chrome/proxy.Dockerfile). It is the only container with a route out.
 *   PROXY_PORT (3128)   the proxy Chrome uses, on the internal network
 *   CONTROL_PORT (9223) session control, published on the host's 127.0.0.1 only
 *   CDP_PORT (9222)     TCP forwarder to Chrome's DevTools port (CDP_TARGET host:port), published on the host's 127.0.0.1 only
 *   ACCESS_TOKEN        per-boot secret (>= 32 chars) the control API and the DevTools forwarder require as a bearer token
 *   INTERNAL_CIDR       Chrome's network; control and CDP refuse callers from it, so a page cannot mint sessions or drive Chrome
 *   EXTRA_PORTS         comma list of extra allowed ports >= 1024 (80 and 443 are always allowed)
 */
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n > 0 ? n : d;
};
const env = process.env;
const internal = env.INTERNAL_CIDR;
if (!internal) {
  console.error('INTERNAL_CIDR is required');
  process.exit(1);
}
const extra = (env.EXTRA_PORTS ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 1024 && n <= 65535);
const [cdpHost, cdpPort] = (env.CDP_TARGET ?? 'chrome:9222').split(':');
const token = env.ACCESS_TOKEN ?? '';
if (token.length < 32) {
  console.error('ACCESS_TOKEN (at least 32 characters) is required');
  process.exit(1);
}
const allowed = (remote: string) => !inCidr(remote, internal);

const proxy = createGuardProxy({
  check: createCheckTarget(isBlockedAddress),
  resolver: systemResolver,
  extraPorts: () => extra,
  caps: { maxBytes: num(env.CAP_BYTES, 8 * 1024 * 1024), maxRequests: num(env.CAP_REQUESTS, 200) },
});
proxy.server.listen(num(env.PROXY_PORT, 3128), '0.0.0.0');
createControlServer(proxy, allowed, token).listen(num(env.CONTROL_PORT, 9223), '0.0.0.0');
createForwarder({ host: cdpHost!, port: Number(cdpPort) }, allowed, token).listen(num(env.CDP_PORT, 9222), '0.0.0.0');
console.log('guard proxy up');
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => process.exit(0));
