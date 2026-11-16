import { describe, expect, it } from 'vitest';
import { PRAW_DEFAULT_MODEL } from '../../../company/seed.js';
import { ECHO, SECRET, SHEETS, SHEETS_URL, receiptRig } from './receipt-fixture.js';
import { SENT_NOTE } from './sheets.js';

describe('AC11', () => {
  it('Thai receipt (fake Gemini) → table + CSV attachment; append awaits approval; after approval exactly one Sheets POST with the pinned row (secret in the POST body, never echoed)', async () => {
    // A delegated run: the Sheets write always asks (P2); the run is also tainted by the receipt read.
    const t = await receiptRig({ sheets: SHEETS, ctx: { direct: false, origin: 'delegated' } });
    const res = await t.reg.run('extract_receipt', {}, t.c);
    expect(res.isError).toBeFalsy();
    expect(t.provider.calls).toHaveLength(1);
    expect(t.provider.calls[0]!.model).toBe(PRAW_DEFAULT_MODEL);
    expect(t.provider.calls[0]!.messages[0]!.content[0]).toMatchObject({ type: 'media', mimeType: 'image/png' });
    expect(t.port.files).toHaveLength(1);
    const f = t.port.files[0]!;
    expect(f.target).toEqual({ channelId: '1569000000000000001' });
    expect(f.payload.body).toMatch(/\| ?Item ?\|/);
    expect(f.payload.body).toContain('ลาเต้เย็น');
    expect(f.payload.body).toContain('155.15');
    expect(f.file.name).toBe('receipt-2026-10-30.csv');
    expect(f.file.contentType).toBe('text/csv; charset=utf-8');
    const csv = f.file.data.toString('utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('บราวนี่');
    // the model passes the row on: awaiting approval, nothing sent
    const row = JSON.parse(/sheets_append_receipt with: (\{.*\})/.exec(res.content)![1]!) as Record<string, unknown>;
    expect(await t.reg.run('sheets_append_receipt', row, t.c)).toMatchObject({ content: expect.stringMatching(/^NOT DONE YET/) });
    expect(t.transport.requests.filter((r) => r.url.href === SHEETS_URL)).toHaveLength(0);
    const stored = (t.approvals.request.mock.calls as unknown as [{ tool: { name: string; input: unknown } }][])[0]![0].tool;
    expect(stored).toEqual({ name: 'sheets_append_receipt', input: row });
    // approve: the replay runs through the scheduler's real context (no attachments), with no second model call
    const done = await t.reg.runApproved(stored.name, stored.input, t.replayCtx());
    expect(done.content).toBe(SENT_NOTE);
    const posts = t.transport.requests.filter((r) => r.url.href === SHEETS_URL);
    expect(posts).toHaveLength(1);
    expect(t.transport.requests.some((r) => r.url.href === ECHO)).toBe(false);
    const sent = JSON.parse(posts[0]!.body!.toString()) as { secret: string; rows: unknown[][] };
    expect(sent.secret).toBe(SECRET);
    expect(sent.rows).toEqual([['2026-10-30', 'ร้านกาแฟดี (TAX ID 0105536012345)', 'THB', 145, 10.15, 155.15]]);
    expect(posts[0]!.url.href).not.toContain(SECRET);
    expect(t.provider.calls).toHaveLength(1);
    expect(JSON.stringify([res, done, f.payload, t.audits, t.logs])).not.toContain(SECRET);
  });
});
