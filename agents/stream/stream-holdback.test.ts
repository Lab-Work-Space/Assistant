import { describe, expect, it } from 'vitest';
import { redactText } from '../../core/logger.js';
import { committable, ELLIPSIS, HOLDBACK, PREVIEW_MAX, safeLength } from './stream-holdback.js';

/** Gate 1 S1/S2: property tests over every core/logger.ts TEXT_PATTERNS class and every literal shape, split at every point. */

type Fix = { name: string; text: string; secret: string };
const hex = (n: number, seed = 'a1b2c3') => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const FIXTURES: Fix[] = [
  { name: 'pem', text: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nKgwggSkAgEAAoIBAQC7\n-----END PRIVATE KEY-----', secret: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' },
  { name: 'pem-oneline', text: '-----BEGIN RSA PRIVATE KEY-----ZZZsecretpemZZZ-----END RSA PRIVATE KEY-----', secret: 'ZZZsecretpemZZZ' },
  { name: 'ghp', text: `ghp_${hex(36, 'Qx9Zk')}`, secret: hex(36, 'Qx9Zk') },
  { name: 'ghs-stateless', text: 'ghs_12345_abcdefghij.klmnopqrst.uvwxyz0123', secret: 'abcdefghij.klmnopqrst' },
  { name: 'github_pat', text: `github_pat_${hex(30, 'Pt7Wm')}`, secret: hex(30, 'Pt7Wm') },
  { name: 'jwt', text: 'eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', secret: 'eyJzdWIiOiIxMjM0' },
  { name: 'aiza', text: `AIzaSy${hex(30, 'Vb3Nq')}`, secret: hex(30, 'Vb3Nq') },
  { name: 'aq', text: `AQ.${hex(40, 'Lm5Rt')}`, secret: hex(40, 'Lm5Rt') },
  { name: 'key=', text: 'https://api.example.test/v1?alt=json&key=Zq81Xw0Pl9Mn&x=1', secret: 'Zq81Xw0Pl9Mn' },
  { name: 'token= special', text: 'token=P@ss!w0rd#ZZ*(x)', secret: 'P@ss!w0rd#ZZ*(x)' },
  { name: 'access_token=', text: 'access_token=Ab12Cd34Ef56', secret: 'Ab12Cd34Ef56' },
  { name: 'netscape-cookie', text: '.example.test\tTRUE\t/\tFALSE\t1893456000\tsession\tCOOKIEVALUE99xyz', secret: 'COOKIEVALUE99xyz' },
  { name: 'cookie-header', text: 'Cookie: sid=SESSIONVALUE77; theme=dark', secret: 'SESSIONVALUE77' },
  { name: 'set-cookie-lower', text: 'set-cookie: auth=AUTHTOKEN88abc; Path=/', secret: 'AUTHTOKEN88abc' },
  { name: 'thought_signature', text: '"thought_signature": "Sig99ValueXyz123"', secret: 'Sig99ValueXyz123' },
  { name: 'webhook', text: 'https://discord.com/api/webhooks/123456789012345678/WhTokenAbc_def-GHI12345', secret: 'WhTokenAbc_def-GHI12345' },
  { name: 'bot', text: `Bot ${hex(30, 'Dt4Yu')}`, secret: hex(30, 'Dt4Yu') },
  { name: 'discord-token', text: `${hex(24, 'Mx7Ab')}.${hex(6, 'Ck2')}.${hex(30, 'Zr6Qe')}`, secret: hex(30, 'Zr6Qe') },
  { name: 'sk-ant', text: `sk-ant-api03-${hex(20, 'Rk8Fj')}`, secret: hex(20, 'Rk8Fj') },
  { name: 'atatt', text: `ATATT${hex(24, 'Jt3Kp')}`, secret: hex(24, 'Jt3Kp') },
  { name: 'basic', text: `Basic ${hex(24, 'Bs6Nh')}==`, secret: hex(24, 'Bs6Nh') },
  { name: 'apps-script', text: 'https://script.google.com/macros/s/AKfycbzDeployIdValue-9/exec', secret: 'AKfycbzDeployIdValue-9' },
  { name: 'clickup', text: 'pk_12345_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' },
  { name: 'postgres ascii', text: 'postgres://app:hunter2secret@db.host.test:5432/x', secret: 'hunter2secret' },
  { name: 'postgres special', text: 'postgresql://app:pa$$w0rd!x#(y)*@db.host.test/x', secret: 'pa$$w0rd!x#(y)*' },
  { name: 'postgres thai', text: 'postgres://app:รหัสลับสุดยอด9@db.host.test/x', secret: 'รหัสลับสุดยอด9' },
];

const PAD = 'The answer begins here with plenty of ordinary words so that the sensitive text starts well past sixty-four characters. ';
const CONTEXTS: { name: string; wrap: (t: string) => string }[] = [
  { name: 'ascii', wrap: (t) => `${PAD}Item: ${t} and more text follows after it.` },
  { name: 'thai', wrap: (t) => `${PAD}ผลลัพธ์คือค่านี้ ${t} จบข้อความภาษาไทยแล้วครับ` },
  { name: 'thai-glued', wrap: (t) => `${PAD}ค่าคือ${t}แล้วก็จบ ok` },
  { name: 'nbsp', wrap: (t) => `${PAD}Item: ${t} and more text.` },
  { name: 'ideographic-space', wrap: (t) => `${PAD}Item:　${t}　and more text.` },
  { name: 'fence', wrap: (t) => `${PAD}\n\`\`\`\n${t}\n\`\`\`\nDone.` },
  { name: 'md-link', wrap: (t) => `${PAD}[click here](${t}) and more text.` },
  { name: 'newline-start', wrap: (t) => `${PAD}\n${t}\nThe end of it.` },
];

const windows = (s: string, n = 4): string[] => {
  const k = Math.min(n, s.length);
  const out: string[] = [];
  for (let i = 0; i + k <= s.length; i++) out.push(s.slice(i, i + k));
  return out;
};

function* positions(full: string, from: number, to: number): Generator<number> {
  for (let i = 0; i <= full.length; i++) if ((i >= from - 2 && i <= to + 2) || i % 9 === 0) yield i;
}

describe('stream holdback: no edit reveals what the full-text redaction masks (S1)', () => {
  for (const holdback of [0, HOLDBACK]) {
    it(`TEXT_PATTERNS fixtures x contexts x every split (holdback ${holdback})`, () => {
      let covered = 0;
      let skipped = 0;
      for (const f of FIXTURES) {
        const ws = windows(f.secret);
        for (const c of CONTEXTS) {
          const full = c.wrap(f.text);
          const masked = redactText(full);
          if (masked.includes(f.secret)) {
            skipped++; // the pattern does not mask the fixture in this context (e.g. Thai glued before key=): nothing to protect
            continue;
          }
          covered++;
          const at = full.indexOf(f.text);
          for (const i of positions(full, at, at + f.text.length)) {
            const edit = committable(full.slice(0, i), [], holdback) + ELLIPSIS;
            for (const w of ws) expect(edit.includes(w), `${f.name}/${c.name} split ${i} shows "${w}"`).toBe(false);
          }
        }
      }
      expect(covered).toBeGreaterThan(FIXTURES.length * 5); // the property ran on most contexts
      expect(skipped).toBeLessThan(FIXTURES.length * 3);
    }, 120_000);
  }

  it('the property can fail: without rule (b) a postgres password with $ leaks (sanity of the harness)', () => {
    const full = `${PAD}postgres://app:pa$$w0rd!x#(y)*@db.host.test/x ok`;
    // a naive cut at the last class character (the spec's old rule b) would show "pa$$": prove the harness would see it
    const naive = full.slice(0, full.indexOf('$$') + 2);
    expect(redactText(naive).includes('pa$$')).toBe(true);
    expect(committable(full.slice(0, full.indexOf('$$') + 2), [], 0).includes('pa$$')).toBe(false);
  });

  it('literal secrets: short DB password, one with internal whitespace, a PEM line, a long key (rule f, suffix >= 1)', () => {
    const lits = ['Zx9Qk', 'ab cd!', '-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEF', 'k3y/Base64+Value=='];
    for (const holdback of [0, HOLDBACK]) {
      for (const lit of lits) {
        for (const c of CONTEXTS) {
          const full = c.wrap(`token ${lit} end`);
          const p = full.indexOf(lit);
          for (let i = 0; i <= full.length; i++) {
            const part = full.slice(0, i);
            const cut = safeLength(part, lits, holdback);
            // the cut never falls strictly inside an occurrence of a literal
            for (let q = full.indexOf(lit); q >= 0; q = full.indexOf(lit, q + 1)) expect(cut > q && cut < q + lit.length, `${lit}/${c.name} split ${i} cut ${cut}`).toBe(false);
            const edit = committable(part, lits, holdback) + ELLIPSIS;
            for (const w of windows(lit.replace(/[-\s!]/g, ''), 4)) if (lit.length > 5) expect(edit.includes(w), `${lit}/${c.name} split ${i} shows ${w}`).toBe(false);
            if (lit.length === 5) expect(edit.includes(lit.slice(0, 1) + lit.slice(1, 3)) && i <= p + 2, `${lit}/${c.name} ${i}`).toBe(false);
          }
        }
      }
    }
  });

  it('a 5 character literal never shows 2+ characters of itself before it is complete', () => {
    const lit = 'Zx9Qk';
    const full = `${PAD}the password is ${lit} thanks`;
    const p = full.indexOf(lit);
    for (let i = 0; i <= full.length; i++) {
      const edit = committable(full.slice(0, i), [lit], 0);
      if (i < p + lit.length) for (const pre of ['Zx', 'x9', '9Q', 'Qk']) expect(edit.includes(pre)).toBe(false);
    }
  });

  it('the rules are a fixpoint: re-applying them to the cut is a no-op, and no cut splits a surrogate pair', () => {
    const lits = ['Zx9Qk'];
    for (const c of CONTEXTS) {
      const full = c.wrap('ghp_' + hex(36, 'Qx9Zk') + ' 😀😀 key=Abc123 \tZx9');
      for (let i = 0; i <= full.length; i++) {
        for (const h of [0, HOLDBACK]) {
          const cut = safeLength(full.slice(0, i), lits, h);
          expect(safeLength(full.slice(0, cut), lits, 0)).toBe(cut);
          const code = full.charCodeAt(cut - 1);
          if (cut > 0) expect(code >= 0xd800 && code <= 0xdbff).toBe(false);
        }
      }
    }
  });

  it('a partial PEM header is held and an open PEM block is cut before its first dash', () => {
    const base = `${PAD}see below `;
    for (const tail of ['-----BEGIN RSA PRIV', '-----BEGIN PRIVATE KEY-----\nMIIE', '-----BEG', '-----BEGIN']) {
      const edit = committable(base + tail, [], 0);
      expect(edit.includes('-----')).toBe(false);
      expect(edit.includes('PRIV')).toBe(false);
    }
  });

  it('Cookie:/Set-Cookie:/Bot/Basic words at the end are held, case-insensitively', () => {
    for (const w of ['Cookie:', 'set-cookie: ', 'COOKIE:', 'Bot ', 'bot  ', 'Basic ', 'BASIC']) {
      const edit = committable(`${PAD}${w}`, [], 0);
      expect(edit.endsWith(PAD)).toBe(true);
    }
  });

  it('S2: a secret straddling char 1900 never shows, and the preview stays within PREVIEW_MAX', () => {
    const secret = `ghp_${hex(36, 'Qx9Zk')}`;
    const lead = 'w '.repeat(Math.floor((PREVIEW_MAX - 20) / 2));
    const full = `${lead}${secret} tail words here`;
    expect(lead.length).toBeLessThan(PREVIEW_MAX);
    expect(lead.length + secret.length).toBeGreaterThan(PREVIEW_MAX);
    for (let i = 0; i <= full.length; i += 1) {
      const out = committable(full.slice(0, i), [], 0);
      expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX);
      for (const w of windows(secret.slice(4), 4)) expect(out.includes(w)).toBe(false);
    }
    // a literal straddling the limit too
    const lit = 'LiteralSecretValue9';
    const full2 = `${lead}${lit} tail words here`;
    for (let i = 0; i <= full2.length; i += 1) {
      const out = committable(full2.slice(0, i), [lit], 0);
      expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX);
      for (const w of windows(lit, 4)) expect(out.includes(w)).toBe(false);
    }
  });

  it('the committed text is the redacted prefix (a complete secret is masked, not dropped)', () => {
    const out = committable(`${PAD}key=Abc123Def and more words follow here for sure, yes indeed.`, [], 0);
    expect(out).toContain('key=[REDACTED]');
    expect(out).not.toContain('Abc123Def');
  });

  it('keeps HOLDBACK characters back at the default', () => {
    const text = 'word '.repeat(100);
    expect(committable(text).length).toBeLessThanOrEqual(text.length - HOLDBACK);
  });
});
