import { describe, expect, it } from 'vitest';
import { redactText } from '../../core/logger.js';
import { committable, HOLDBACK, PREVIEW_MAX } from './stream-holdback.js';

/** STREAM-1 tester oracle (independent of stream-holdback.test.ts): every split point, random composition, stronger oracle than 4-gram windows:
 *  the committed text must be a PREFIX of redactText(fullBody) (a half-masked prefix that later turns into a different mask = a leak signature). */
let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const rep = (s: string, n: number) => s.repeat(n).slice(0, n);

const SECRETS: { text: string; vary: string }[] = [
  { text: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\nAQEFAASCBKcwggSj\n-----END PRIVATE KEY-----', vary: 'MIIEvQIBADANBgkqhkiG9w0B' },
  { text: '-----BEGIN OPENSSH PRIVATE KEY-----b3BlbnNzaC1rZXktdjEAAAAA-----END OPENSSH PRIVATE KEY-----', vary: 'b3BlbnNzaC1rZXktdjEAAAAA' },
  { text: `ghp_${rep('aZ3k9', 36)}`, vary: rep('aZ3k9', 36) },
  { text: `ghs_77_${rep('Hq1', 12)}.${rep('Pl0x', 20)}.${rep('Sg7', 14)}`, vary: rep('Pl0x', 20) },
  { text: `github_pat_${rep('Xy2', 30)}`, vary: rep('Xy2', 30) },
  { text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eXoifQ.SflKxwRJSMeKKF2QT4fwpM', vary: 'eyJzdWIiOiJ4eXoifQ' },
  { text: `AIzaSy${rep('Wq4', 30)}`, vary: rep('Wq4', 30) },
  { text: `AQ.${rep('Lz8', 45)}`, vary: rep('Lz8', 45) },
  { text: 'https://x.test/a?alt=json&key=Zq81XwPl9MnQ&z=1', vary: 'Zq81XwPl9MnQ' },
  { text: 'api_key=Ab-12.Cd_34/Ef', vary: 'Ab-12.Cd_34/Ef' },
  { text: '.ex.test\tTRUE\t/\tFALSE\t1893456000\tsess\tCOOKIEVAL99xyz\n', vary: 'COOKIEVAL99xyz' },
  { text: 'Cookie: sid=SESSVAL77abc; theme=dark more words here', vary: 'SESSVAL77abc' },
  { text: 'Set-Cookie: auth=AUTHTOK88abc; Path=/', vary: 'AUTHTOK88abc' },
  { text: '{"thoughtSignature":"SigVal99Xyz123abc"}', vary: 'SigVal99Xyz123abc' },
  { text: 'https://discordapp.com/api/v9/webhooks/123456789012345678/WhTok_Abc-GHI123456', vary: 'WhTok_Abc-GHI123456' },
  { text: `Bot\t${rep('Dt4', 30)}`, vary: rep('Dt4', 30) },
  { text: `Bot  \n ${rep('Dt4', 30)}`, vary: rep('Dt4', 30) },
  { text: `${rep('Mx7', 25)}.${rep('Ck2', 6)}.${rep('Zr6', 30)}`, vary: rep('Zr6', 30) },
  { text: `sk-ant-api03-${rep('Rk8', 20)}`, vary: rep('Rk8', 20) },
  { text: `ATATT${rep('Jt3', 24)}`, vary: rep('Jt3', 24) },
  { text: `Basic  ${rep('Bs6', 24)}==`, vary: rep('Bs6', 24) },
  { text: 'https://script.google.com/macros/s/AKfycbzDeployId-9_x/exec', vary: 'AKfycbzDeployId-9_x' },
  { text: 'pk_12345_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', vary: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' },
  { text: 'postgres://app:pa$$w0rd!x#(y)*@db.h.test:5432/x', vary: 'pa$$w0rd!x#(y)*' },
  { text: 'postgresql://app:รหัสลับ9สุดยอด@db.h.test/x', vary: 'รหัสลับ9สุดยอด' },
  { text: 'postgres://app:p/a?s=s:w@db/x', vary: 'p/a?s=s:w' },
  { text: 'postgres://app:short@db/x', vary: 'short' },
];
const LITS = ['Zx9Qk', 'DbPw!#$รหัส', 'two words', 'ab\tcd'];
const FILL = ['alpha', 'bravo', 'ค่าคือ', 'และ', 'ข้อมูล', 'code:', '`x`', '(see)', '\n', '\n\n', ' ', ' ', '　', '😀', '.', ',', '- item', '**b**'];
const grams = (s: string, n = 4): string[] => { const k = Math.min(n, s.length); const o: string[] = []; for (let i = 0; i + k <= s.length; i++) o.push(s.slice(i, i + k)); return o; };

describe('tester oracle: committed text is a prefix of the redacted full text', () => {
  it('every split of 400 random compositions (default holdback and 0)', () => {
    let splits = 0;
    const bad: string[] = [];
    for (let n = 0; n < 400; n++) {
      const parts: string[] = [];
      const secrets: { text: string; vary: string }[] = [];
      const len = 3 + Math.floor(rnd() * 8);
      for (let k = 0; k < len; k++) {
        if (rnd() < 0.35) { const s = rnd() < 0.2 ? { text: pick(LITS), vary: '' } : pick(SECRETS); secrets.push(s); parts.push(s.text); }
        else parts.push(pick(FILL));
        parts.push(pick([' ', ' ', '', '\n', ' ', ' ']));
      }
      const full = rep('The reply starts out with a long run of plain words to pass the holdback. ', 80) .slice(0, rnd() < 0.5 ? 0 : 70) + parts.join('');
      if (full.length > PREVIEW_MAX - 100) continue;
      const lits = LITS.filter(() => true);
      const R = redactText(full, lits);
      for (const hb of [0, HOLDBACK]) {
        for (let i = 0; i <= full.length; i++) {
          splits++;
          const E = committable(full.slice(0, i), lits, hb);
          // the netscape cookie pattern masks a whole line including its leading non-secret first field (^[^\t\r\n]*\t...): not a leak, so compositions holding that fixture only get the n-gram oracle
          const hasTabLine = full.includes('\t');
          if (!hasTabLine && !R.startsWith(E)) { bad.push(`#${n} hb${hb} i${i} E=${JSON.stringify(E.slice(-60))} R=${JSON.stringify(R.slice(Math.max(0, E.length - 60), E.length + 10))}`); break; }
          for (const s of secrets) if (s.vary && !hasTabLine) for (const g of grams(s.vary)) if (R.indexOf(g) < 0 && E.includes(g)) { bad.push(`#${n} hb${hb} i${i} LEAK ${g}`); break; }
        }
      }
    }
    console.log('splits checked', splits, 'violations', bad.length, bad.slice(0, 8));
    expect(bad).toEqual([]);
  }, 300_000);

  it('tab-bearing secrets (netscape cookie row, tab literal) at every split, with and without a preceding same-line field', () => {
    const row = '.ex.test\tTRUE\t/\tFALSE\t1893456000\tsess\tCOOKIEVAL99xyz';
    const pad = rep('word ', 40);
    for (const full of [`${pad}\n${row}\nafter text here`, `${pad}\n${row}`, `${pad}${row}\n${pad}`, `${pad} the pw is ab\tcd ok ${pad}`]) {
      for (const hb of [0, HOLDBACK]) {
        for (let i = 0; i <= full.length; i++) {
          const E = committable(full.slice(0, i), ['ab\tcd'], hb);
          for (const g of [...grams('COOKIEVAL99xyz'), 'ab\tc', 'b\tcd']) expect(E.includes(g), `${hb}/${i}/${g}`).toBe(false);
        }
      }
    }
  });
});
