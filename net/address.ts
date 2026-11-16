import { isIP } from 'node:net';

/**
 * Gate 1 P4 address policy. An address is allowed only when it is a well-formed public unicast IP. Ranges are compared
 * numerically (BigInt), so textual tricks cannot slip through; anything that does not parse is blocked (fail closed).
 */

type Range = { base: bigint; bits: number; width: 32 | 128 };

function v4ToBig(ip: string): bigint | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0n;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s) || Number(s) > 255) return null;
    n = (n << 8n) | BigInt(Number(s));
  }
  return n;
}

function v6ToBig(ip: string): bigint | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) return null; // scoped (link-local) addresses are never public
  // an embedded dotted v4 tail (::ffff:1.2.3.4) becomes two hextets
  const dot = s.lastIndexOf('.');
  if (dot >= 0) {
    const colon = s.lastIndexOf(':');
    const v4 = v4ToBig(s.slice(colon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, colon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  let n = 0n;
  for (const h of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    n = (n << 16n) | BigInt(parseInt(h, 16));
  }
  return n;
}

const r4 = (cidr: string): Range => {
  const [a, b] = cidr.split('/');
  return { base: v4ToBig(a!)!, bits: Number(b), width: 32 };
};
const r6 = (cidr: string): Range => {
  const [a, b] = cidr.split('/');
  return { base: v6ToBig(a!)!, bits: Number(b), width: 128 };
};

// IANA IPv4 special-purpose registry entries that are not globally reachable, plus multicast and reserved.
const V4_BLOCKED = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
].map(r4);

// Only global unicast (2000::/3) can be public; inside it, the special-purpose and v4-embedding prefixes are refused too.
// Everything outside 2000::/3 (::, ::1, ::/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, fc00::/7, fe80::/10, fec0::/10,
// ff00::/8, ...) is blocked by the first rule; ::ffff:0:0/96 is decided on the embedded v4 before that.
const V6_GLOBAL = r6('2000::/3');
const V6_BLOCKED = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20', '5f00::/16'].map(r6);
const V4_MAPPED = r6('::ffff:0:0/96');

const inRange = (n: bigint, r: Range): boolean => n >> BigInt(r.width - r.bits) === r.base >> BigInt(r.width - r.bits);

/** True for any address that is not a public unicast IP, and for anything that is not an IP at all. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const fam = isIP(bare);
  if (fam === 4) {
    const n = v4ToBig(bare);
    return n === null || V4_BLOCKED.some((r) => inRange(n, r));
  }
  if (fam === 6) {
    const n = v6ToBig(bare);
    if (n === null) return true;
    if (inRange(n, V4_MAPPED)) {
      const v4 = n & 0xffffffffn;
      return V4_BLOCKED.some((r) => inRange(v4, r));
    }
    return !inRange(n, V6_GLOBAL) || V6_BLOCKED.some((r) => inRange(n, r));
  }
  return true;
}

/** `[::1]` -> `::1`; other hostnames unchanged. */
export const bareHost = (hostname: string): string =>
  hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
