import { ScriptedBudget } from '../../../agents/loop/loop-fixture.js';
import { createMeteredModel } from '../../../agents/call/metered.js';
import { auditSpy, newBus } from '../../../agents/test-helpers.js';
import { Budget } from '../../../governance/budget.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry } from '../../../providers/index.js';
import { FakeDiscordPort } from '../../../tests/fakes/discordPort.js';
import { fakeResolver, fakeTransport, type FakeRoute } from '../../../tests/fakes/net.js';
import type { ToolSource } from '../../types.js';
import { webRig } from '../web/test-helpers.js';
import { approvedToolContext } from '../../../agents/loop/loop.js';
import { extractReceiptTool, type ReceiptDeps } from './receipt.js';
import { sheetsAppendTool, type SheetsConfig } from './sheets.js';

export const PRAW = { kind: 'head' as const, dept: 'praw' as const };
export const CDN = 'https://cdn.discordapp.com/attachments/111/222/receipt.png?ex=1&hm=2';
export const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbxTEST_id-1/exec';
export const SECRET = 'sheets-secret-ZZtop-0042';
export const ECHO = 'https://script.googleusercontent.com/macros/echo?user_content_key=abc';
export const TAX_ID = '0105536012345';
export const CARD = '4111111111111111';
/** PNG magic plus an IHDR header; the bytes go to the fake model as-is. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('\0\0\0\rIHDR\0\0\0\x10\0\0\0\x10\x08\x02\0\0\0', 'latin1')]);

export const THAI_RECEIPT = {
  merchant: `ร้านกาแฟดี (TAX ID ${TAX_ID})`, date: '2026-10-30', currency: 'THB',
  items: [{ name: `ลาเต้เย็น, แก้วใหญ่ card ${CARD}`, qty: 1, unitPrice: 65, total: 65 }, { name: 'บราวนี่', qty: 2, unitPrice: 40, total: 80 }],
  subtotal: 145, tax: 10.15, total: 155.15, confidence: 0.93,
};
export const THAI_JSON = JSON.stringify(THAI_RECEIPT);

export const src = (attachments: ToolSource['attachments'] = [{ url: CDN, name: 'receipt.png', size: PNG.length }]): ToolSource =>
  ({ channelId: '1569000000000000001', threadId: null, messageId: '1570000000000000001', userId: 'u1', attachments });

export type RigOpts = { vision?: ReceiptDeps['vision']; halt?: ReceiptDeps['halt']; replies?: string[]; sheets?: SheetsConfig | undefined; sheetsRoute?: FakeRoute; hosts?: Record<string, string[]>; ctx?: Record<string, unknown> };

/** A receipt tool wired to a fake Gemini, fake CDN + Apps Script transport and a fake Discord port. */
export async function receiptRig(o: RigOpts = {}) {
  const cfg = new FakeConfig();
  const provider = new FakeProvider((o.replies ?? [THAI_JSON]).map((text) => ({ text, usage: { inputTokens: 1300, outputTokens: 80 } })), 'gemini');
  const providers = new ProviderRegistry();
  providers.register(provider);
  const spy = auditSpy();
  const budget = new ScriptedBudget(new Budget(null as never, cfg, newBus()));
  const metered = createMeteredModel({ providers, cfg, budget, audit: spy.audit, halt: { isHalted: () => false, track: () => () => undefined } });
  const transport = fakeTransport({
    [CDN]: { headers: { 'content-type': 'image/png' }, body: [PNG] },
    [SHEETS_URL]: o.sheetsRoute ?? { status: 302, headers: { location: ECHO }, body: '' },
  });
  const resolver = fakeResolver({ 'cdn.discordapp.com': ['162.159.130.233'], 'script.google.com': ['142.250.4.100'], ...o.hosts });
  const port = new FakeDiscordPort();
  const logs: unknown[] = [];
  const net = { metered, resolver, transport, extraPorts: () => [] as number[], ...(o.vision ? { vision: o.vision } : {}), ...(o.halt ? { halt: o.halt } : {}) };
  const tool = extractReceiptTool({ ...net, port, sheetsTool: !!o.sheets });
  const append = o.sheets ? sheetsAppendTool(net, o.sheets) : undefined;
  const r = await webRig([tool, ...(append ? [append] : [])], { actor: PRAW, direct: true, origin: 'chat', source: src(), ...o.ctx });
  /** The context the scheduler gives an approved call (R4): real approvedToolContext, so no attachments, never direct. */
  const replayCtx = () => approvedToolContext(PRAW, r.c.task!, { org: r.c.org, tasks: r.c.tasks, approvals: r.c.approvals, limits: r.c.limits, notes: r.c.notes, bus: r.c.bus, audit: r.c.audit } as never);
  return { ...r, tool, append, provider, transport, port, audits: spy.entries, logs, budget, replayCtx };
}
export const SHEETS: SheetsConfig = { url: SHEETS_URL, secret: SECRET };
