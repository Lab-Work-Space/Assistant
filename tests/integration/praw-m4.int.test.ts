import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { cmd, text as replyText } from '../../discord/commands/test-helpers.js';
import { handlePrawInteraction } from '../../discord/praw/index.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { FakeProvider, type ChatRequest } from '../../providers/index.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { ActorProvider, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, turn, type TestPort } from './helpers.js';

/** M4 acceptance (T34): /ocr, /receipt, the auto-OCR channel and the finance/software tool split, over fake Discord, CDN and Gemini. */
const PRAW_WORK = '1565999999999999001';
const FINANCE_WORK = '1565999999999999005';
const CDN = 'https://cdn.discordapp.com/attachments/111/222/receipt.png?ex=1&hm=2';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('\0\0\0\rIHDR\0\0\0\x10\0\0\0\x10\x08\x02\0\0\0', 'latin1')]);
const THAI_TEXT = 'ร้านกาแฟดี\nรวมทั้งสิ้น 155.15 บาท';
const RECEIPT = JSON.stringify({ merchant: 'ร้านกาแฟดี', date: '2026-10-30', currency: 'THB', items: [{ name: 'ลาเต้เย็น', qty: 1, unitPrice: 65, total: 65 }], subtotal: 145, tax: 10.15, total: 155.15 });
const ATT = { name: 'receipt.png', url: CDN, size: PNG.length };

let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); });
afterAll(async () => { await db.close(); });

async function prepare(): Promise<void> {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  await db.pool.query("UPDATE departments SET work_channel_id = $1 WHERE id = 'finance'", [FINANCE_WORK]);
}
const gemini = (...replies: string[]) => new FakeProvider(replies.map((t) => ({ text: t, usage: { inputTokens: 1300, outputTokens: 80 } })), 'gemini');
const net = () => ({ resolver: fakeResolver({ 'cdn.discordapp.com': ['162.159.130.233'] }), transport: fakeTransport({ [CDN]: { headers: { 'content-type': 'image/png' }, body: [PNG] } }) });
const toolNames = (r: ChatRequest) => r.tools.map((t) => t.name);
const body = (r: ChatRequest) => JSON.stringify(r.messages);
const slash = (name: 'ocr' | 'receipt', over: Parameters<typeof cmd>[2] = {}) => cmd(name, null, { channelId: PRAW_WORK, roles: [], userId: 'u1', attachments: { file: { ...ATT, contentType: 'image/png' } }, ...over });
const praw = (): ActorProvider => new ActorProvider({ 'heads/praw': [turn({ name: 'ocr_image', input: { attachmentIndex: 0 } }), turn(respond('chat', 'Transcribed: รวมทั้งสิ้น 155.15 บาท'))] });

describe('m4', () => {
  it('/ocr › file option runs ocr_image through ask() and the loop; Gemini reads the attachment bytes; the model never sees the url', async () => {
    await prepare();
    const g = gemini(THAI_TEXT);
    const provider = praw();
    const t = await boot(db.pool, { provider, extraProviders: [g], net: net() });
    app = t.app;
    const i = slash('ocr', { strings: { language: 'th' } });
    const r = await handlePrawInteraction(i, t.app.services.prawCommands);
    expect(r?.ephemeral).toBe(false);
    expect(replyText(i.edits[0]!)).toContain('155.15');
    const calls = provider.callsOf('heads/praw');
    expect(toolNames(calls[0]!)).toContain('ocr_image');
    expect(body(calls[1]!)).toContain('รวมทั้งสิ้น 155.15 บาท'); // the tool result reached the model (wrapped untrusted)
    expect(body(calls[0]!)).not.toContain('cdn.discordapp.com');
    expect(body(calls[0]!)).toContain('receipt.png'); // attachment metadata is listed for the model
    expect(g.calls).toHaveLength(1);
    expect(JSON.stringify(g.calls[0]!.messages)).toContain('"media"');
  });

  it('/receipt › returns table + CSV (AC11 read half): CSV file posted in the channel, table in the answer', async () => {
    await prepare();
    const g = gemini(RECEIPT);
    const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'extract_receipt', input: {} }), turn(respond('chat', 'Receipt read: total 155.15 THB'))] });
    const t = await boot(db.pool, { provider, extraProviders: [g], net: net() });
    app = t.app;
    const i = slash('receipt');
    await handlePrawInteraction(i, t.app.services.prawCommands);
    const files = (t.port as TestPort).files;
    expect(files).toHaveLength(1);
    expect(files[0]!.file.name).toBe('receipt-2026-10-30.csv');
    expect(files[0]!.file.data.toString('utf8')).toContain('ลาเต้เย็น');
    expect(JSON.stringify(files[0]!.payload)).toContain('| Item | Qty |');
    expect(replyText(i.edits[0]!)).toContain('155.15');
  });

  it('auto-ocr › image in the configured, praw-mapped channel triggers OCR; the same image elsewhere does not; and the cap/counter are shared', async () => {
    await prepare();
    const g = gemini(THAI_TEXT, THAI_TEXT);
    const provider = new ActorProvider({
      'heads/praw': [turn({ name: 'ocr_image', input: {} }), turn(respond('chat', 'auto text')), turn({ name: 'ocr_image', input: {} }), turn(respond('chat', 'second'))],
      'heads/software': [turn(respond('chat', 'software here'))],
    });
    const t = await boot(db.pool, { provider, extraProviders: [g], net: net() });
    app = t.app;
    await t.app.services.cfg.set('ocr.autoChannelId', PRAW_WORK, 'test');
    await t.app.services.cfg.set('limits.visionPerUserDay', 2, 'test');
    // elsewhere: no OCR (software channel, not praw-mapped, no mention of praw)
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('software')} look`, { mentionedHeads: ['software'], attachments: [ATT] }));
    await t.app.services.scheduler.idle();
    expect(provider.callsOf('heads/praw')).toHaveLength(0);
    expect(g.calls).toHaveLength(0);
    // in the auto channel: runs OCR (1 of 2)
    await t.app.services.scheduler.onMessage(humanMsg('', { channelId: PRAW_WORK, attachments: [ATT] }));
    await t.app.services.scheduler.idle();
    expect(g.calls).toHaveLength(1);
    expect((t.port as TestPort).posts.map((p) => JSON.stringify(p.payload)).join('')).toContain('auto text');
    // a chat request with an image (mention) shares the same daily cap (2 of 2)
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} read this`, { channelId: PRAW_WORK, mentionedHeads: ['praw'], attachments: [ATT] }));
    await t.app.services.scheduler.idle();
    expect(g.calls).toHaveLength(2);
    // over the cap: /ocr refused with no model call; the auto channel answers a notice and calls nothing
    const praw0 = provider.callsOf('heads/praw').length;
    const i = slash('ocr', { userId: '42' });
    const r = await handlePrawInteraction(i, t.app.services.prawCommands);
    expect(r?.ephemeral).toBe(true);
    await t.app.services.scheduler.onMessage(humanMsg('', { channelId: PRAW_WORK, attachments: [ATT] }));
    await t.app.services.scheduler.idle();
    expect(provider.callsOf('heads/praw')).toHaveLength(praw0);
    expect(g.calls).toHaveLength(2);
  });

  it('m4 › finance head may call extract_receipt, software may not', async () => {
    await prepare();
    const g = gemini(RECEIPT);
    const provider = new ActorProvider({
      'heads/finance': [turn({ name: 'extract_receipt', input: {} }), turn(respond('chat', 'finance read it'))],
      'heads/software': [turn({ name: 'extract_receipt', input: {} }, { name: 'ocr_image', input: {} }), turn(respond('chat', 'software tried'))],
    });
    const t = await boot(db.pool, { provider, extraProviders: [g], net: net() });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('finance')} receipt`, { channelId: FINANCE_WORK, mentionedHeads: ['finance'], attachments: [ATT] }));
    await t.app.services.scheduler.idle();
    const fin = provider.callsOf('heads/finance');
    expect(toolNames(fin[0]!)).toContain('extract_receipt');
    expect(toolNames(fin[0]!)).not.toContain('sheets_append_receipt'); // finance stays read-only
    expect(body(fin[1]!)).toContain('Receipt read');
    expect(g.calls).toHaveLength(1);
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('software')} receipt`, { mentionedHeads: ['software'], attachments: [ATT] }));
    await t.app.services.scheduler.idle();
    const sw = provider.callsOf('heads/software');
    expect(toolNames(sw[0]!)).not.toContain('extract_receipt');
    expect(toolNames(sw[0]!)).not.toContain('ocr_image');
    expect(body(sw[1]!)).toMatch(/not allowed|unknown tool|not available/i);
    expect(g.calls).toHaveLength(1); // software's attempts reached no model
  });
});
