import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactText, sanitize } from './logger.js';

function capture(secrets: string[] = []) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const log = createLogger('info', { secrets, destination });
  return { log, out: () => lines.join('') };
}

const discordToken = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA.GabCdE.abcdefghijklmnopqrstuvwxyz0'; // 27+ chars last part
const webhook = 'https://discord.com/api/webhooks/1234567890123456/AbC-dEf_ghIJKlmn0123';

describe('logger redaction', () => {
  it('masks discord token pattern', () => {
    const { log, out } = capture();
    log.info(`login with ${discordToken}`);
    log.info({ detail: discordToken }, 'x');
    expect(out()).not.toContain(discordToken);
    expect(out()).toContain('[REDACTED]');
  });

  it('masks Bot <token> authorization strings', () => {
    expect(sanitize('Authorization: Bot abcdefghijklmnopqrstuvwxyz.123')).not.toContain('abcdefghij');
  });

  it('masks sk-ant- keys', () => {
    const { log, out } = capture();
    log.warn('key sk-ant-api03-AbCdEfGh1234567890_xyz leaked');
    expect(out()).not.toContain('sk-ant-api03');
    expect(out()).toContain('[REDACTED]');
  });

  it('masks webhook url and DATABASE_URL password', () => {
    const { log, out } = capture();
    log.info({ url: webhook, db: 'postgres://assistant:hunter2pass@postgres:5432/assistant' }, 'cfg');
    const o = out();
    expect(o).not.toContain('AbC-dEf_ghIJKlmn0123');
    expect(o).not.toContain('hunter2pass');
    expect(o).toContain('postgres://assistant:[REDACTED]@postgres');
  });

  it('masks key-named values of any type, nested', () => {
    const { log, out } = capture();
    log.info({ a: { b: [{ key: 987654321 }], token: { x: 1 }, apiKey: true, Password: 'pw', webhookUrl: 'u' } }, 'n');
    const o = out();
    expect(o).not.toContain('987654321');
    expect(o).not.toContain('"pw"');
    expect(JSON.parse(o).a.b[0].key).toBe('[REDACTED]');
    expect(JSON.parse(o).a.token).toBe('[REDACTED]');
    expect(JSON.parse(o).a.apiKey).toBe('[REDACTED]');
  });

  it('keeps non-secret counters such as maxTokens', () => {
    expect(sanitize({ maxTokens: 100 })).toEqual({ maxTokens: 100 });
  });

  it('masks nested key-named numeric secret', () => {
    expect(sanitize({ a: { b: { secret: 123456 } } })).toEqual({ a: { b: { secret: '[REDACTED]' } } });
  });

  it('masks registered literal secrets such as CONFIG_MASTER_KEY', () => {
    const k = Buffer.alloc(32, 9).toString('base64');
    const { log, out } = capture([k]);
    log.info(`master ${k}`);
    expect(out()).not.toContain(k);
  });

  it('masks secrets inside Error messages and stacks', () => {
    const { log, out } = capture();
    log.error({ err: new Error(`fail ${discordToken}`) }, 'oops');
    expect(out()).not.toContain(discordToken);
  });

  it('survives circular references', () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    expect(() => sanitize(a)).not.toThrow();
  });

  it('sanitize is idempotent', () => {
    const input = {
      s: `x ${discordToken} sk-ant-abcdefgh12345 ${webhook} postgres://u:pw@h/db Bot abcdefghijklmnopqrstuvwxyz`,
      password: 'p',
      n: { key: 5 },
    };
    const once = sanitize(input);
    expect(sanitize(once)).toEqual(once);
  });

  it('Date survives as ISO string', () => {
    const d = new Date('2026-10-31T10:00:00.000Z');
    expect(sanitize({ at: d })).toEqual({ at: '2026-10-31T10:00:00.000Z' });
  });

  it('Map and Set are serialised, with redaction applied inside', () => {
    const out = sanitize({
      m: new Map<string, unknown>([['a', 1], ['token', 'x'], ['u', discordToken]]),
      s: new Set(['p', discordToken]),
    }) as unknown as { m: Record<string, unknown>; s: unknown[] };
    expect(out.m).toEqual({ a: 1, token: '[REDACTED]', u: '[REDACTED]' });
    expect(out.s).toEqual(['p', '[REDACTED]']);
  });
});

describe('logger P10 generic secrets (gemini)', () => {
  const aiza = 'AIzaSyA-1234567890abcdefghijklmnopqrstu';
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabc/def+ghi=\n-----END PRIVATE KEY-----';
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXBhcnQtMTIz';
  const cookie = '.example.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabcDEF123456';

  it('masks AIza keys in text and nested objects', () => {
    const { log, out } = capture();
    log.info(`call failed for ${aiza}`);
    log.info({ a: { b: [`x ${aiza} y`] } }, 'nested');
    expect(out()).not.toContain(aiza);
    expect(out()).toContain('[REDACTED]');
  });

  it('masks AQ. Gemini keys; leaves ordinary dotted text alone', () => {
    const aq = 'AQ.Ab8RN6K-1234567890_abcdefghijklmnopqrstuvwxyz';
    const { log, out } = capture();
    log.info(`call failed for ${aq}`);
    log.info({ a: { b: [`x ${aq} y`] } }, 'nested');
    expect(out()).not.toContain(aq);
    expect(out()).not.toContain('Ab8RN6K');
    expect(out()).toContain('[REDACTED]');
    expect(sanitize(`k=${aq}.`)).not.toContain('Ab8RN6K');
    for (const ok of ['AQ.short', 'see AQ. then', 'FAQ.mdfile-is-here-and-long-enough-x']) expect(sanitize(ok)).toBe(ok);
  });

  it('masks PEM, AIza, key= query, JWT, cookie lines; sanitize is idempotent; delimiter variants', () => {
    const text = [pem, aiza, 'https://x.test/v1/models?alt=sse&key=abc123XYZ&b=1', jwt, cookie].join('\n');
    const once = sanitize(text);
    for (const leak of ['MIIEvQIBADAN', 'AIzaSyA', 'abc123XYZ', 'eyJzdWIi', 'abcDEF123456']) expect(once).not.toContain(leak);
    expect(sanitize(once)).toBe(once);
    for (const d of ['"', "'", '(', ')', ',', ';', '=', ':', ' ', '\n', '\t', '<', '>', '[', ']']) {
      const s = sanitize(`k${d}${aiza}${d}j${d}${jwt}${d}`);
      expect(s).not.toContain('AIzaSyA');
      expect(s).not.toContain('eyJzdWIi');
    }
    expect(sanitize('?key=abc123XYZ&b=1')).toContain('b=1');
  });

  it('masks values under privateKey, pem, cookie, jwt and signature keys', () => {
    const o = sanitize({ privateKey: 'p', pem: 'p', cookie: 'c', jwt: 'j', signature: 's', ok: 'fine' });
    expect(o).toEqual({ privateKey: '[REDACTED]', pem: '[REDACTED]', cookie: '[REDACTED]', jwt: '[REDACTED]', signature: '[REDACTED]', ok: 'fine' });
  });

  it('thoughtSignature never logged', () => {
    const { log, out } = capture();
    const sig = 'CiQBjz1rX-opaque-thought-signature-value';
    log.info({ part: { functionCall: { name: 'x' }, thoughtSignature: sig }, deep: [{ thought_signature: sig }] }, 'raw part');
    log.info(`wire {"thoughtSignature":"${sig}"}`);
    expect(out()).not.toContain(sig);
    expect(sanitize({ thoughtSignature: sig })).toEqual({ thoughtSignature: '[REDACTED]' });
  });
});

describe('logger P10 clickup', () => {
  it('logger › masks pk_ tokens', () => {
    const pk = 'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const { log, out } = capture();
    log.info(`ClickUp said no to ${pk}`);
    log.info({ a: [`x ${pk} y`] }, `nested ${pk}`);
    expect(out()).not.toContain(pk);
    expect(out()).toContain('[REDACTED]');
  });
});

describe('logger P10 jira', () => {
  it('logger › masks ATATT tokens', () => {
    const t = 'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEFGH=1A2B3C4D';
    const basic = `Basic ${Buffer.from(`bot@acme.test:${t}`).toString('base64')}`;
    const { log, out } = capture();
    log.info(`Jira said no to ${t}`);
    log.info({ a: [`x ${t} y`], note: `header was ${basic}` }, `nested ${t} and ${basic}`);
    log.info({ headers: { Authorization: basic } }, 'req');
    expect(out()).not.toContain(t);
    expect(out()).not.toContain('ATATT');
    expect(out()).not.toContain(basic.slice(6));
    expect(out()).toContain('[REDACTED]');
  });
});

describe('logger P10 github', () => {
  it('logger › masks ghs_/ghp_ tokens and PEM blocks', () => {
    const ghs = `ghs_${'Ab1'.repeat(13)}`;
    const ghp = `ghp_${'Xy9'.repeat(13)}`;
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7';
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\nabcd\n-----END PRIVATE KEY-----`;
    const rsa = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const cut = `-----BEGIN PRIVATE KEY-----\n${body}\nno end marker`;
    const { log, out } = capture();
    log.info(`a ${ghs} b ${ghp} c ${pem} d ${rsa}`);
    log.info({ n: [`x ${ghs}`], err: `bad pem ${cut}` }, `nested ${pem}`);
    log.info({ headers: { Authorization: `Bearer ${ghs}` } }, 'req');
    expect(out()).not.toContain(ghs);
    expect(out()).not.toContain(ghp);
    expect(out()).not.toContain(body);
    expect(out()).not.toContain('PRIVATE KEY');
    expect(out()).toContain('[REDACTED]');
  });

  it('logger › masks the stateless ghs_<appid>_<jwt> form and github_pat_, idempotently', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1Ng';
    const stateless = `ghs_123456_${jwt}`;
    const pat = `github_pat_${'A1b2C3d4E5'.repeat(4)}`;
    const { log, out } = capture();
    log.info(`t ${stateless} p ${pat}`);
    log.info({ a: [stateless] }, `again ${pat}`);
    for (const frag of [stateless, jwt, 'eyJpc3Mi', 'c2lnbmF0dXJl', pat, 'A1b2C3d4E5']) expect(out()).not.toContain(frag);
    const once = redactText(`${stateless} ${pat}`);
    expect(redactText(once)).toBe(once);
  });
});

describe('G2BL-06 discord token pattern is linear and unchanged on real tokens', () => {
  it('20 KB word runs are scanned in under 50 ms', () => {
    for (const run of ['a'.repeat(20_000), 'a-'.repeat(10_000), `${'x'.repeat(10_000)}.${'y'.repeat(10_000)}`]) {
      const t0 = performance.now();
      redactText(run);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
  it('masks the same text as before on the token fixtures', () => {
    const tok = `${'A'.repeat(24)}.${'b'.repeat(6)}.${'C'.repeat(27)}`;
    const cases: [string, string][] = [
      [tok, '[REDACTED]'],
      [`token ${tok} end`, 'token [REDACTED] end'],
      [`(${tok})`, '([REDACTED])'],
      [`x=${tok},y`, 'x=[REDACTED],y'],
      ['version 1.2.3 and a.b.c and short.tokens.here', 'version 1.2.3 and a.b.c and short.tokens.here'],
    ];
    for (const [input, out] of cases) expect(redactText(input)).toBe(out);
  });
});

describe('AI-APPROVE-1 (AA-C2): Bearer tokens are masked', () => {
  it('masks the value after Bearer, any case, idempotently, and leaves plain words alone', () => {
    const tok = 'abc123DEF456ghi789.jkl-mno_pqr~stu+vwx/yz==';
    expect(redactText(`Authorization: Bearer ${tok} end`)).toBe('Authorization: Bearer [REDACTED] end');
    expect(redactText(`bearer ${tok}`)).toBe('Bearer [REDACTED]');
    const once = redactText(`BEARER ${tok}`);
    expect(redactText(once)).toBe(once);
    expect(redactText('the bearer of this letter')).toBe('the bearer of this letter');
    expect(redactText('Bearer short')).toBe('Bearer short');
    // global backend rule 2: a backslash (or any other non-space) tail must not leak
    for (const tail of ['\\TAIL', ';TAIL', ')TAIL', '\\', '%5CTAIL']) expect(redactText(`Bearer abcdefghijklmnop${tail} end`), tail).toBe('Bearer [REDACTED] end');
    const t0 = performance.now();
    redactText(`Bearer ${'a'.repeat(20_000)}`);
    redactText('Bearer '.repeat(3000));
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
