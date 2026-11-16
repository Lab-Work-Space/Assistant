import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config/schema.js';
import { PINNED_BINARIES } from '../voice/binaries.js';
import {
  HOST_RE, LIMITS, PROTOCOL_V, ProtocolError, decodeExitTrailer, encodeExitTrailer, isIpLiteral, parseHealth, parseTrackRequest, toWireExit,
  type WireExit,
} from './protocol.js';

const good = { v: 1, query: 'lofi beats', allowlist: ['www.youtube.com', 'youtu.be'], capSeconds: 600, capBytes: 1_000_000 };
const exit = (o: Partial<WireExit> = {}): WireExit => ({ code: 0, signal: null, reason: null, stderr: '', ...o });
const expect400 = (fn: () => unknown) => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(ProtocolError); expect((e as ProtocolError).status).toBe(400); return; }
  throw new Error('did not throw');
};
const b64u = (s: string) => Buffer.from(s).toString('base64url');

describe('constants', () => {
  it('carries the spec limits', () => {
    expect(PROTOCOL_V).toBe(1);
    expect(LIMITS).toEqual({
      trackBody: 8192, query: 300, allowlistMax: 20, capSecondsMax: 1200, capBytesMax: 52428800, trailerMax: 4096, reasonMax: 200, stderrMax: 300,
      decodeBodyMax: 4194304, maxHeaders: 20, headersTimeoutMs: 5000, connectTimeoutMs: 2000, decodeServerMs: 20000, decodeClientMs: 25000, tracks: 2, decodes: 2,
    });
  });
});

describe('HOST_RE parity with config/schema.ts', () => {
  it('HOST_RE equals the media.ytHostAllowlist regex in config/schema.ts', () => {
    const line = readFileSync(new URL('../config/schema.ts', import.meta.url), 'utf8').split('\n').find((l) => l.includes("'media.ytHostAllowlist'"));
    expect(line).toBeDefined();
    const m = /\.regex\(\/(.+?)\/, '/.exec(line as string);
    expect(m).not.toBeNull();
    expect(HOST_RE.source).toBe(new RegExp((m as RegExpExecArray)[1] as string).source);
  });

  it('accepts and refuses the same hosts as the schema (regex plus IP-literal refine)', () => {
    const table = ['example.com', 'www.youtube.com', 'a-b.example.org', '1.2.3.4', '0x7f.1', 'a.1', '127.1', '10.0.0.1', 'a.0x7f', 'foo.0X1F', 'localhost',
      'Example.com', '[::1]', 'exa mple.com', '-a.com', 'a-.com', '', 'a..com', '999.999.999.999', 'x.y.123'];
    const schemaHost = ConfigSchema['media.ytHostAllowlist'];
    for (const h of table) {
      const viaSchema = schemaHost.safeParse([h]).success;
      const viaProtocol = h.length >= 1 && h.length <= 253 && HOST_RE.test(h) && !isIpLiteral(h);
      expect(viaProtocol, `host ${JSON.stringify(h)}`).toBe(viaSchema);
    }
  });

  it('isIpLiteral flags dotted numerics and numeric or hex last labels', () => {
    for (const h of ['1.2.3.4', '127.1', '0x7f.1', 'a.1', 'a.0x7f', '[::1]', '::1']) expect(isIpLiteral(h), h).toBe(true);
    for (const h of ['example.com', 'a1.example.com', 'x.com1']) expect(isIpLiteral(h), h).toBe(false);
  });
});

describe('parseTrackRequest', () => {
  it('accepts a valid body', () => {
    expect(parseTrackRequest(good)).toEqual(good);
  });

  it('refuses unknown key, missing field, wrong types', () => {
    expect400(() => parseTrackRequest({ ...good, extra: 1 }));
    expect400(() => parseTrackRequest({ ...good, argv: ['--exec', 'x'] }));
    for (const k of Object.keys(good)) {
      const { [k]: _drop, ...rest } = good as Record<string, unknown>;
      expect400(() => parseTrackRequest(rest));
    }
    expect400(() => parseTrackRequest({ ...good, v: 2 }));
    expect400(() => parseTrackRequest({ ...good, query: 5 }));
    expect400(() => parseTrackRequest({ ...good, allowlist: 'youtu.be' }));
    expect400(() => parseTrackRequest({ ...good, allowlist: [5] }));
    for (const body of [null, undefined, 'x', 5, [], [good]]) expect400(() => parseTrackRequest(body));
  });

  it('bounds query to 1..300', () => {
    expect400(() => parseTrackRequest({ ...good, query: '' }));
    expect400(() => parseTrackRequest({ ...good, query: 'a'.repeat(301) }));
    expect(parseTrackRequest({ ...good, query: 'a'.repeat(300) }).query).toHaveLength(300);
    expect(parseTrackRequest({ ...good, query: 'a' }).query).toBe('a');
  });

  it('bounds allowlist to 1..20 valid non-IP hosts', () => {
    expect400(() => parseTrackRequest({ ...good, allowlist: [] }));
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);
    expect400(() => parseTrackRequest({ ...good, allowlist: hosts(21) }));
    expect(parseTrackRequest({ ...good, allowlist: hosts(20) }).allowlist).toHaveLength(20);
    expect400(() => parseTrackRequest({ ...good, allowlist: ['1.2.3.4'] }));
    expect400(() => parseTrackRequest({ ...good, allowlist: ['[::1]'] }));
    expect400(() => parseTrackRequest({ ...good, allowlist: ['0x7f.1'] }));
    expect400(() => parseTrackRequest({ ...good, allowlist: ['Example.com'] }));
    expect400(() => parseTrackRequest({ ...good, allowlist: [`${'a'.repeat(250)}.com`] }));
  });

  it('bounds capSeconds to int 1..1200 and capBytes to int 1..52428800', () => {
    for (const s of [0, 1201, 1.5, -1, Number.NaN, '5']) expect400(() => parseTrackRequest({ ...good, capSeconds: s }));
    for (const s of [1, 1200]) expect(parseTrackRequest({ ...good, capSeconds: s }).capSeconds).toBe(s);
    for (const b of [0, 52428801, 2.5, -1, Number.POSITIVE_INFINITY]) expect400(() => parseTrackRequest({ ...good, capBytes: b }));
    for (const b of [1, 52428800]) expect(parseTrackRequest({ ...good, capBytes: b }).capBytes).toBe(b);
  });
});

describe('toWireExit', () => {
  it('caps stderr at 300 with control chars stripped, and reason at 200', () => {
    const w = toWireExit({ code: 1, signal: null, reason: 'r'.repeat(500), stderr: `a\u0000b\u001b[31m${'x'.repeat(600)}\u007f\n` });
    expect(w.stderr).toHaveLength(300);
    expect(w.stderr).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(w.stderr.startsWith('ab[31m')).toBe(true);
    expect(w.reason).toHaveLength(200);
  });

  it('keeps code, signal and a null reason', () => {
    expect(toWireExit({ code: null, signal: 'SIGKILL', reason: null, stderr: '' })).toEqual({ code: null, signal: 'SIGKILL', reason: null, stderr: '' });
  });

  it('strips control chars from reason and signal too', () => {
    const w = toWireExit({ code: 0, signal: 'SIG\u0000X', reason: 'a\nb', stderr: '' });
    expect(w.reason).toBe('ab');
    expect(w.signal).toBe('SIGX');
  });
});

describe('trailer', () => {
  const t = { ytDlp: exit({ code: 1, stderr: 'boom' }), ffmpeg: exit({ code: null, signal: 'SIGKILL', reason: 'timeout' }) };

  it('round-trips', () => {
    expect(decodeExitTrailer(encodeExitTrailer(t))).toEqual(t);
  });

  it('decode returns null for undefined, a 4097-byte value, "!!!", non-JSON base64url, and wrong shapes', () => {
    expect(decodeExitTrailer(undefined)).toBeNull();
    expect(decodeExitTrailer('A'.repeat(4097))).toBeNull();
    expect(decodeExitTrailer('!!!')).toBeNull();
    expect(decodeExitTrailer('')).toBeNull();
    expect(decodeExitTrailer(b64u('not json'))).toBeNull();
    expect(decodeExitTrailer(b64u('[]'))).toBeNull();
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit() })))).toBeNull();
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit(), ffmpeg: { ...exit(), code: 'x' } })))).toBeNull();
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit(), ffmpeg: { code: 0, signal: null, reason: null } })))).toBeNull();
  });

  it('decode refuses an extra trailer key or an extra key inside an exit', () => {
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit(), ffmpeg: exit(), extra: 1 })))).toBeNull();
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: { ...exit(), x: 1 }, ffmpeg: exit() })))).toBeNull();
  });

  it('decode refuses over-long reason or stderr and non-integer or non-string fields', () => {
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit({ reason: 'r'.repeat(201) }), ffmpeg: exit() })))).toBeNull();
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit({ stderr: 's'.repeat(301) }), ffmpeg: exit() })))).toBeNull();
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit({ code: 1.5 }), ffmpeg: exit() })))).toBeNull();
    expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit({ signal: 9 as unknown as string }), ffmpeg: exit() })))).toBeNull();
  });

  it('decode refuses control chars in reason and strips them from stderr', () => {
    for (const r of ['a\nb', 'x\u001b[31m', 'a\u007f', 'a\u0000']) expect(decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit({ reason: r }), ffmpeg: exit() }))), JSON.stringify(r)).toBeNull();
    const d = decodeExitTrailer(b64u(JSON.stringify({ ytDlp: exit({ stderr: 'a\nb\u001b[31mc\u007f' }), ffmpeg: exit() })));
    expect(d?.ytDlp.stderr).toBe('ab[31mc');
  });

  it('decode refuses an unpadded-looking but non-canonical value (standard base64 chars)', () => {
    expect(decodeExitTrailer(`${encodeExitTrailer(t)}=`)).toBeNull();
    expect(decodeExitTrailer('a+b/')).toBeNull();
  });

  it('encode stays within 4 KiB by shrinking stderr and throws when it cannot', () => {
    const big = { ytDlp: exit({ stderr: 'x'.repeat(300), reason: 'r'.repeat(200) }), ffmpeg: exit({ stderr: 'y'.repeat(300), reason: 'r'.repeat(200) }) };
    expect(encodeExitTrailer(big).length).toBeLessThanOrEqual(LIMITS.trailerMax);
    const huge = { ytDlp: exit({ stderr: '"'.repeat(300), reason: '"'.repeat(200) }), ffmpeg: exit({ signal: 'S'.repeat(5000) }) };
    expect(() => encodeExitTrailer(huge)).toThrow();
  });
});

describe('parseHealth', () => {
  const ok = { v: 1, check: { ok: true }, versions: { ytDlp: '2026.10.26', ffmpeg: 'n9.0.2-39-g7adfbe40dc' }, busy: { tracks: 0, decodes: 1 } };

  it('accepts ok and not-ok checks and the pinned versions', () => {
    expect(parseHealth(ok)).toEqual(ok);
    const bad = { ...ok, check: { ok: false, missing: ['ffmpeg'], mismatched: [] } };
    expect(parseHealth(bad)).toEqual(bad);
    expect(parseHealth({ ...ok, versions: { ytDlp: PINNED_BINARIES.ytDlp.version, ffmpeg: PINNED_BINARIES.ffmpeg.version } })).not.toBeNull();
  });

  it('rejects v:2 and missing check', () => {
    expect(parseHealth({ ...ok, v: 2 })).toBeNull();
    const { check: _c, ...noCheck } = ok;
    expect(parseHealth(noCheck)).toBeNull();
  });

  it('rejects malformed check, versions and busy', () => {
    for (const body of [null, 5, 'x', [], {}]) expect(parseHealth(body)).toBeNull();
    expect(parseHealth({ ...ok, check: { ok: false, missing: 'x', mismatched: [] } })).toBeNull();
    expect(parseHealth({ ...ok, check: { ok: false, missing: [] } })).toBeNull();
    expect(parseHealth({ ...ok, check: { ok: false, missing: [5], mismatched: [] } })).toBeNull();
    expect(parseHealth({ ...ok, check: { ok: 'yes' } })).toBeNull();
    expect(parseHealth({ ...ok, versions: { ytDlp: '1.0' } })).toBeNull();
    expect(parseHealth({ ...ok, busy: { tracks: -1, decodes: 0 } })).toBeNull();
    expect(parseHealth({ ...ok, busy: { tracks: 1.5, decodes: 0 } })).toBeNull();
    expect(parseHealth({ ...ok, extra: 1 })).toBeNull();
  });

  it('enforces the S7 version regex and length (a sidecar cannot inject text through versions)', () => {
    for (const v of ['', 'a'.repeat(65), 'has space', 'new\nline', '<script>', 'a/b', '1.0;rm']) {
      expect(parseHealth({ ...ok, versions: { ytDlp: v, ffmpeg: '1' } }), JSON.stringify(v)).toBeNull();
      expect(parseHealth({ ...ok, versions: { ytDlp: '1', ffmpeg: v } }), JSON.stringify(v)).toBeNull();
    }
    expect(parseHealth({ ...ok, versions: { ytDlp: 'a'.repeat(64), ffmpeg: '1.2+b-c' } })).not.toBeNull();
  });

  it('restricts check names to yt-dlp and ffmpeg (no sidecar text reaches the disabled alert)', () => {
    for (const n of ['@everyone', 'a\nb', 'unknown', 'ffmpeg ', 'FFMPEG']) {
      expect(parseHealth({ ...ok, check: { ok: false, missing: [n], mismatched: [] } }), JSON.stringify(n)).toBeNull();
      expect(parseHealth({ ...ok, check: { ok: false, missing: [], mismatched: [n] } }), JSON.stringify(n)).toBeNull();
    }
    const both = { ...ok, check: { ok: false, missing: ['yt-dlp'], mismatched: ['ffmpeg'] } };
    expect(parseHealth(both)).toEqual(both);
  });

  it('bounds the check name lists', () => {
    expect(parseHealth({ ...ok, check: { ok: false, missing: Array(5).fill('ffmpeg'), mismatched: [] } })).toBeNull();
    expect(parseHealth({ ...ok, check: { ok: false, missing: ['ffmpeg', 'ffmpeg', 'ffmpeg'], mismatched: [] } })).toBeNull();
  });
});
