import { describe, expect, it } from 'vitest';
import { fakeResolver, fakeTransport } from '../../../tests/fakes/net.js';
import { SHEETS_URL_RE, SheetsError, appendRows, sheetsConfigured } from './sheets.js';
import { ECHO, SECRET, SHEETS, SHEETS_URL } from './receipt-fixture.js';

const net = (route: Parameters<typeof fakeTransport>[0][string], host = '142.250.4.100') => ({
  resolver: fakeResolver({ 'script.google.com': [host] }), transport: fakeTransport({ [SHEETS_URL]: route }), extraPorts: () => [] as number[],
});

describe('sheets', () => {
  it('URL must be https://script.google.com/macros/s/… from env only; secret goes in the POST body, never the URL', async () => {
    for (const bad of ['http://script.google.com/macros/s/abc/exec', 'https://script.google.com/macros/s/abc/exec?x=1', 'https://script.google.com/macros/s/abc/dev', 'https://evil.example/macros/s/abc/exec', 'https://script.google.com.evil.example/macros/s/abc/exec', 'https://script.google.com/macros/s/ab c/exec', 'https://user@script.google.com/macros/s/abc/exec']) {
      expect(SHEETS_URL_RE.test(bad), bad).toBe(false);
      expect(sheetsConfigured({ url: bad, secret: SECRET }), bad).toBe(false);
    }
    expect(sheetsConfigured(SHEETS)).toBe(true);
    expect(sheetsConfigured({ url: SHEETS_URL, secret: '' })).toBe(false);
    expect(sheetsConfigured(undefined)).toBe(false);
    const n = net({ status: 302, headers: { location: ECHO }, body: '' });
    await appendRows(n, SHEETS, [['2026-10-30', 'x', 1]]);
    const req = n.transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url.href).toBe(SHEETS_URL);
    expect(req.url.href).not.toContain(SECRET);
    expect(JSON.parse(req.body!.toString())).toEqual({ secret: SECRET, worksheet: 'Sheet1', rows: [['2026-10-30', 'x', 1]] });
    expect(JSON.stringify(req.headers)).not.toContain(SECRET);
  });

  it('a 302 to script.googleusercontent.com is accepted and not followed; any other redirect is an error', async () => {
    const ok = net({ status: 302, headers: { location: ECHO }, body: '' });
    await expect(appendRows(ok, SHEETS, [['a']])).resolves.toBeUndefined();
    expect(ok.transport.requests).toHaveLength(1); // the secret is never sent in a follow-up GET
    for (const loc of ['https://script.googleusercontent.com.evil.example/x', 'https://evil.example/x', 'http://script.googleusercontent.com/x', 'https://user@script.googleusercontent.com/x', '']) {
      const n = net({ status: 302, headers: loc ? { location: loc } : {}, body: '' });
      await expect(appendRows(n, SHEETS, [['a']]), loc).rejects.toBeInstanceOf(SheetsError);
      expect(n.transport.requests).toHaveLength(1);
    }
    await expect(appendRows(net({ status: 500, body: 'boom ' + SECRET }), SHEETS, [['a']])).rejects.toThrow(/^Google Sheets did not accept the row\.$/);
    await expect(appendRows(net({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"error":"unauthorized"}' }), SHEETS, [['a']])).rejects.toBeInstanceOf(SheetsError);
    await expect(appendRows(net({ status: 200, body: '<html>TypeError</html>' }), SHEETS, [['a']])).rejects.toBeInstanceOf(SheetsError);
    await expect(appendRows(net({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"url":"https://docs.google.com/x"}' }), SHEETS, [['a']])).resolves.toBeUndefined();
  });

  it('private/loopback URL refused by SSRF guard (fixed error, no request sent)', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254']) {
      const n = net({ status: 302, headers: { location: ECHO }, body: '' }, ip);
      const e = await appendRows(n, SHEETS, [['a']]).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SheetsError);
      expect((e as Error).message).not.toContain(SECRET);
      expect(n.transport.requests).toHaveLength(0);
    }
  });
});
