// TEST ONLY (npm run chrome:e2e). The real proxy modules, plus one extra "public" test range (10.89.78.0/24) so that a redirecting,
// hostile origin container can exist. Everything else (private ranges, loopback, metadata, ports, caps, auth) is the production code.
import dns from 'node:dns/promises';
import { isBlockedAddress } from '/app/net/address.js';
import { createCheckTarget } from '/app/net/fetch.js';
import { createControlServer, createForwarder, createGuardProxy, inCidr } from '/app/net/proxy.js';

const resolver = async (h) => (h === 'redir.test' ? ['10.89.78.10'] : (await dns.lookup(h, { all: true })).map((x) => x.address));
const proxy = createGuardProxy({ check: createCheckTarget((ip) => isBlockedAddress(ip) && !ip.startsWith('10.89.78.')), resolver, extraPorts: () => [] });
proxy.server.listen(3128, '0.0.0.0');
const token = process.env.ACCESS_TOKEN;
const allowed = (r) => !inCidr(r, '10.88.77.0/24');
createControlServer(proxy, allowed, token).listen(9223, '0.0.0.0');
createForwarder({ host: '10.88.77.3', port: 9222 }, allowed, token).listen(9222, '0.0.0.0');
