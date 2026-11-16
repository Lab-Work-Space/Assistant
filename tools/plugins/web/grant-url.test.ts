import { describe, expect, it } from 'vitest';
import { grantUrlCheck } from './grant-url.js';

const ok = (u: string) => grantUrlCheck(u);
const rule = (u: string) => { const r = grantUrlCheck(u); return r.ok ? 'ok' : r.rule; };

describe('grantUrlCheck (WEBGRANT-1 D9, W-C5, W-C6)', () => {
  it('passes a plain article url and returns the parsed host and character count', () => {
    expect(ok('https://Docs.Example.com/guide/intro?lang=en')).toEqual({ ok: true, host: 'docs.example.com', chars: '/guide/intro'.length + '?lang=en'.length });
  });
  it('E1: https only', () => {
    expect(rule('http://example.com/a')).toBe('E1');
    expect(rule('ftp://example.com/a')).toBe('E1');
    expect(rule('not a url')).toBe('E1');
  });
  it('E2: no userinfo', () => {
    expect(rule('https://user:pw@example.com/a')).toBe('E2');
    expect(rule('https://user@example.com/a')).toBe('E2');
  });
  it('E3: no explicit port', () => {
    expect(rule('https://example.com:8443/a')).toBe('E3');
    expect(rule('https://example.com:443/a')).toBe('ok'); // the default port is dropped by the parser
  });
  it('E4: a plain DNS name only', () => {
    expect(rule('https://127.0.0.1/a')).toBe('E4');
    expect(rule('https://[::1]/a')).toBe('E4');
    expect(rule('https://2130706433/a')).toBe('E4'); // parsed to 127.0.0.1
    expect(rule('https://localhost/a')).toBe('E4');
    expect(rule('https://example.com./a')).toBe('E4');
  });
  it('E5: host shape (a long data subdomain, too many labels, digit-heavy label)', () => {
    expect(rule('https://averyveryverylonglabelwithwords.example.com/a')).toBe('E5');
    expect(rule('https://a.b.c.d.e.example.com/a')).toBe('E5');
    expect(rule('https://h1234.example.com/a')).toBe('E5');
    expect(rule(`https://${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}.com/a`)).toBe('E5');
  });
  it('E6: size limits, no hash, few escapes', () => {
    expect(rule(`https://example.com/${'a'.repeat(10)}/${'b/'.repeat(8)}`)).toBe('E6'); // more than 8 segments
    expect(rule('https://example.com/a?a=1&b=2&c=3&d=4&e=5')).toBe('E6');
    expect(rule('https://example.com/a#frag')).toBe('E6');
    expect(rule('https://example.com/a#')).toBe('E6');
    expect(rule('https://example.com/%41%42%43%44%45%46%47')).toBe('E6');
    expect(rule(`https://example.com/${'ab-'.repeat(60)}`)).toBe('E6'); // path over 160 / raw over 256
  });
  it('E6: raw length boundary (256 passes, 257 fails) and a short raw whose parsed form grows', () => {
    const l = (n: number) => 'x'.repeat(n);
    const path = `${('/' + l(19)).repeat(7)}/${l(9)}`; // 150 chars, 8 segments
    const url = (k: number) => `https://example.com${path}?a=${l(20)}&b=${l(20)}&c=${l(20)}&d=${l(k)}`;
    expect(url(15).length).toBe(256);
    expect(grantUrlCheck(url(15)).ok).toBe(true);
    expect(url(16).length).toBe(257);
    expect(rule(url(16))).toBe('E6');
    // short raw, but each Thai character is three escapes in the parsed href
    expect(rule(`https://example.com/${'ก'.repeat(5)}`)).toBe('E6');
  });
  it('E7: token shapes (UUID path, 10-digit id, base64-ish token, long hex)', () => {
    expect(rule('https://example.com/u/550e8400-e29b-41d4-a716-446655440000')).toBe('E7'); // 12 hex digits? the last group is 12 hex
    expect(rule('https://example.com/user/1234567890')).toBe('E7');
    expect(rule('https://example.com/p/QWxhZGRpbjpvcGVuIHNlc2FtZQQQ')).toBe('E7');
    expect(rule('https://example.com/p/deadbeefcafebabe01')).toBe('E7');
    expect(rule('https://example.com/a?token=abcdefghijklmnopqrstuvwxyz')).toBe('E7');
    expect(rule('https://example.com/a?abcdefghijklmnopqrstuvwxyz=1')).toBe('E7');
  });
  it('E8: a credential-shaped url (redactText changes it)', () => {
    expect(rule('https://example.com/a?key=sk-ant-api03-abcdefghijklmnopqrstuvwx')).not.toBe('ok');
    expect(rule('https://example.com/ghp_abcdefghijklmnopqrstuvwxyz0123456789')).not.toBe('ok');
  });
  it('E9: invisible characters, and the second call on the same url gives the same answer (W-C5: no lastIndex carry-over)', () => {
    const u = 'https://example.com/a​b';
    expect(rule(u)).toBe('E9');
    expect(rule(u)).toBe('E9');
    expect(rule(u)).toBe('E9');
    expect(rule('https://example.com/a\u{E0041}b')).toBe('E9');
  });
  it('E9: two consecutive calls with different urls both detect the hidden character (the hit of the first must not hide the earlier hit of the second)', () => {
    expect(rule('https://example.com/aaaaaaaaaa\u200b')).toBe('E9'); // hit late in the text: a stateful /g regex would keep lastIndex past the second hit
    expect(rule('https://ex\u00adample.com/')).toBe('E9'); // the parser drops it from the host, so only the raw text still shows it
    expect(rule('https://ex\u00adample.com/')).toBe('E9');
  });
  it('W-C6 fixtures: backslash path, Thai path, IDN host, dot-dot segment, uppercase host', () => {
    expect(rule('https://example.com\\a\\b')).toBe('ok'); // parsed as /a/b
    expect(ok('https://example.com\\a\\b')).toMatchObject({ host: 'example.com', chars: 4 });
    expect(rule('https://example.com/ไทย')).toBe('E6'); // 6 escapes... 6 bytes x3 = 18 > 6
    const idn = ok('https://bücher.example.com/a');
    expect(idn).toMatchObject({ ok: true, host: 'xn--bcher-kva.example.com' });
    expect(ok('https://example.com/a/%2e%2e/b')).toMatchObject({ ok: true, chars: 2 }); // collapsed by the parser to /b
    expect(ok('https://EXAMPLE.COM/A')).toMatchObject({ ok: true, host: 'example.com' });
  });
  it('W-C6 (Gate 2): length is checked on the raw text AND the parsed href', () => {
    // two Thai letters (6 escapes, the E6 maximum) grow the href by 16 characters
    const host = 'abcdefghijklmnopqrstuvw.abcdefghijklmnopqrstuvw.example.com';
    const path = `/\u0E01/${Array.from({ length: 6 }, () => 'alpha-beta-gamma').join('/')}`;
    const pad = (n: number) => `?q=\u0E02&w=${'word-'.repeat(20).slice(0, n)}`;
    const raw = (n: number) => `https://${host}${path}${pad(n)}`;
    const n = 256 - raw(0).length; // raw exactly 256
    expect(raw(n).length).toBe(256);
    expect(new URL(raw(n)).href.length).toBeGreaterThan(256);
    expect(rule(raw(n))).toBe('E6'); // raw passes the 256 cap, the parsed href does not
    const short = raw(n - 20);
    expect(new URL(short).href.length).toBeLessThanOrEqual(256);
    expect(rule(short)).toBe('ok');
  });
  it('splits words on separators, so plain words pass', () => {
    expect(rule('https://en.wikipedia.org/wiki/Alan_Turing')).toBe('ok');
    expect(rule('https://example.com/blog/2026-11-08-release-notes')).toBe('ok');
  });

  it('DEFECT-1: a UUID in a path segment or a query value is E7, even when its dash groups are short and letter-heavy', () => {
    expect(rule('https://b.test/doc/3f2b8c1e-9d4a-4e7b-8a61-0c5d2e9f7a13/')).toBe('E7');
    expect(rule('https://b.test/doc?id=3f2b8c1e-9d4a-4e7b-8a61-0c5d2e9f7a13')).toBe('E7');
    expect(rule('https://b.test/doc/3F2B8C1E-9D4A-4E7B-8A61-0C5D2E9F7A13')).toBe('E7');
    expect(rule('https://b.test/doc/3f2b8c1e_9d4a_4e7b_8a61_0c5d2e9f7a13')).toBe('E7'); // other separators: stripped hex run
    expect(rule('https://b.test/doc/abcd-ef01-2345-6789-abcd')).toBe('E7'); // 20 hex characters across groups, has digits
  });
  it('DEFECT-1: ordinary dashed and dated urls still pass', () => {
    expect(rule('https://b.test/blog/2024/11/my-post-title')).toBe('ok');
    expect(rule('https://b.test/blog/2026-11-08-release-notes')).toBe('ok');
    expect(rule('https://b.test/docs/getting-started-with-the-api?lang=en&page=2')).toBe('ok');
    expect(rule('https://b.test/a/dead-beef-face')).toBe('ok'); // 12 hex characters, under the 16 bound
  });
});
