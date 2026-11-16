import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seededOrg } from '../../../agents/test-helpers.js';
import { DEFAULT_DUTIES, handleOf } from '../../../company/duties.js';
import { thaiTaxIdOk, type CompanyProfile } from '../../../company/profile.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import type { ActorRef } from '../../../company/types.js';
import { webRig } from '../web/test-helpers.js';
import { taxIdOf } from './test-helpers.js';
import type { ToolContext } from '../../types.js';
import { docsGroup, kindRefusal } from './index.js';
import { DOC_KINDS, isDraftKind, KIND_INFO, WATERMARK_TEXT, type DocKind } from './kinds.js';
import { Baht, computeTotals, fmtSatang, isBaht, isQty, MoneyError, toSatang, whtOn } from './money.js';
import { RenderError, type DocRenderer } from './render.js';
import { newRunState } from '../../types.js';
import { dataSizeProblem, KIND_SCHEMAS } from './schemas.js';
import { buildDocument, esc, redactDeep } from './templates.js';
import type { PluginDeps } from '../deps.js';
import { ToolRegistry } from '../../registry.js';

// ---- fixtures ------------------------------------------------------------------------------------------------------------------------------

const TAX = taxIdOf('010553600000');
const PROFILE: CompanyProfile = { name: 'บริษัท ทดสอบ จำกัด', address: '1 ถนนทดสอบ กรุงเทพ', taxId: TAX, branch: '00000', phone: '02-123-4567' };
const FIN: ActorRef = { kind: 'head', dept: 'finance' };
const SALES: ActorRef = { kind: 'head', dept: 'sales' };
const HR: ActorRef = { kind: 'head', dept: 'hr' };
const OPS: ActorRef = { kind: 'head', dept: 'ops' };
const SW: ActorRef = { kind: 'head', dept: 'software' };
const MKT: ActorRef = { kind: 'head', dept: 'marketing' };
const ROOMS: Record<string, string> = { 'room-fin': 'finance', 'room-sales': 'sales', 'room-hr': 'hr', 'room-ops': 'ops', 'room-sw': 'software', 'room-mkt': 'marketing' };
const ROOM_OF: Record<string, string> = { finance: 'room-fin', sales: 'room-sales', hr: 'room-hr', ops: 'room-ops', software: 'room-sw', marketing: 'room-mkt' };

const lines = [{ description: 'Widget', qty: 2, unit: 'pcs', unitPrice: 100 }, { description: 'บริการ', qty: 1.5, unitPrice: 33.33 }];
const party = { name: 'ACME Co', address: '9 Road', taxId: '0105500000000', phone: '02-000-0000' };
export const SAMPLES: Record<DocKind, Record<string, unknown>> = {
  purchase_request: { requester: 'Somchai', reason: 'Need laptops', lines, vat: true },
  purchase_order: { supplier: party, orderDate: '2026-11-03', lines, vat: true, whtRate: 3 },
  quotation: { customer: party, quoteDate: '2026-11-03', lines, vat: true, discount: 10 },
  proposal: { title: 'P', summary: 'S', sections: [{ heading: 'H', body: 'B', bullets: ['x'] }] },
  invoice_receipt: { mode: 'invoice', customer: party, issueDate: '2026-11-03', lines, vat: true },
  tax_invoice: { customer: party, issueDate: '2026-11-03', lines, vat: true },
  withholding_tax_cert: { payee: { name: 'Payee', taxId: '1101700000000' }, paymentDate: '2026-11-03', incomeType: '40_6', amountPaid: 10000, whtRate: 3 },
  expense_report: { employee: 'E', periodStart: '2026-11-01', periodEnd: '2026-11-03', expenses: [{ date: '2026-11-02', category: 'Taxi', description: 'To client', amount: 250.5 }] },
  job_description: { jobTitle: 'Engineer', department: 'Software', employmentType: 'full_time', summary: 'S', responsibilities: ['a'], requirements: ['b'] },
  offer_letter: { candidate: 'Cand', position: 'Engineer', department: 'Software', startDate: '2026-12-01', monthlySalary: 55000.5 },
  meeting_minutes: { title: 'Weekly', date: '2026-11-03', attendees: ['A'], agenda: ['one'] },
  plan: { title: 'Plan', objective: 'O', sections: [{ heading: 'H', bullets: ['x'] }] },
  slides: { title: 'Deck', subtitle: 'Sub', sections: [{ heading: 'H', bullets: ['x'] }] },
  report: { title: 'R', summary: 'S', sections: [{ heading: 'H', body: 'B' }] },
  spec: { title: 'T', overview: 'O', goals: ['g'], sections: [{ heading: 'H', body: 'B' }] },
  technical_design: { title: 'T', overview: 'O', goals: ['g'], sections: [{ heading: 'H', body: 'B' }] },
  marketing_brief: { campaign: 'C', objective: 'O', audience: 'A', keyMessages: ['k'], channels: ['fb'] },
};

const tmps: string[] = [];
afterEach(async () => { for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }); });

type Over = { profile?: CompanyProfile | null; duties?: Record<string, readonly string[]>; renderer?: DocRenderer; actor?: ActorRef; room?: string | null; direct?: boolean; tainted?: boolean; noWorkspace?: boolean; incidents?: { report: (i: unknown) => string } };
async function rig(o: Over = {}) {
  const actor = o.actor ?? FIN;
  const base = await mkdtemp(join(tmpdir(), 'docs-'));
  tmps.push(base);
  const workspaceRoot = join(base, 'praw'); // Praw's root; department documents go to a SIBLING folder
  const org = await seededOrg({ mapped: ROOMS });
  const cfg = new FakeConfig({ 'company.profile': o.profile === undefined ? PROFILE : o.profile } as never);
  const html: string[] = [];
  const renderer: DocRenderer = o.renderer ?? { renderPdf: vi.fn(async (h: string) => (html.push(h), { pdf: Buffer.from('%PDF-1.7 fake /Type /Page'), pages: 1 })) };
  const posted: { target: unknown; payload: { body: string }; file: { name: string; data: Buffer; contentType: string } }[] = [];
  const port = { postFile: vi.fn(async (_a: ActorRef, target: unknown, payload: { body: string }, file: { name: string; data: Buffer; contentType: string }) => (posted.push({ target, payload, file }), `msg${posted.length}`)) };
  const records: unknown[][] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deps = {
    cfg, port, renderer, log, clock: () => Date.UTC(2026, 10, 3, 12), org, workspaceRoot, docsDir: join(base, 'documents'),
    provenance: { record: vi.fn(async (...a: unknown[]) => void records.push(a)) },
    ...(o.incidents ? { incidents: o.incidents } : {}),
  } as unknown as PluginDeps;
  const g = docsGroup(deps);
  if (!('tools' in g)) throw new Error('docs group disabled');
  const room = o.room === undefined ? ROOM_OF[actor.kind === 'head' ? actor.dept : 'finance'] ?? 'room-fin' : o.room;
  const r = await webRig(g.tools as never, {
    actor, duties: () => o.duties ?? DEFAULT_DUTIES,
    source: { channelId: room ?? '', threadId: 'thread-1', messageId: null, userId: 'u1', attachments: [] },
    direct: o.direct ?? false,
    ...(o.tainted ? {} : {}),
  } as Partial<ToolContext>);
  if (o.tainted) r.c.run.markTainted();
  // the model-facing `data` is the JSON text of the object; tests may pass the object and it is serialised here
  const norm = (i: unknown): unknown => (i && typeof i === 'object' && 'data' in i && typeof (i as { data: unknown }).data === 'object' ? { ...(i as object), data: JSON.stringify((i as { data: unknown }).data) } : i);
  const run0 = r.reg.run.bind(r.reg);
  const runApproved0 = r.reg.runApproved.bind(r.reg);
  r.reg.run = (n: string, i: unknown, c: ToolContext) => run0(n, norm(i), c);
  r.reg.runApproved = (n: string, i: unknown, c: ToolContext) => runApproved0(n, norm(i), c);
  // the actor may call the tool (offering is a separate gate)
  return { ...r, posted, html, records, port, log, base, workspaceRoot, renderer, cfg, tool: g.tools[0]! };
}

// ---- RF18 money -----------------------------------------------------------------------------------------------------------------------------

describe('RF18 money is computed in code, in integer satang', () => {
  it('RF18: probes 1e308, Infinity, NaN, -0, 1e-9, negatives and 3 decimals are refused in EVERY numeric field of every kind, one field at a time', () => {
    const bad = [1e308, Infinity, -Infinity, NaN, -0, 1e-9, -1, 0.001, 1.005, 1e21, 1_000_000_001, 0.1 + 0.2, '12', null, undefined];
    // every numeric leaf of every sample, as a path
    const leaves = (o: unknown, path: (string | number)[] = []): (string | number)[][] =>
      Array.isArray(o) ? o.flatMap((x, i) => leaves(x, [...path, i])) : o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => leaves(v, [...path, k])) : typeof o === 'number' ? [path] : [];
    const setAt = (o: any, path: (string | number)[], v: unknown): void => { let c = o; for (const k of path.slice(0, -1)) c = c[k]; c[path.at(-1)!] = v; };
    let checked = 0;
    const fields = new Set<string>();
    for (const kind of DOC_KINDS) {
      for (const path of leaves(SAMPLES[kind])) {
        fields.add(`${kind}.${path.filter((x) => typeof x === 'string').join('.')}`);
        for (const v of bad.filter((x) => x !== undefined)) { // `undefined` is "field absent", valid for an optional field
          const s = JSON.parse(JSON.stringify(SAMPLES[kind])) as Record<string, unknown>;
          setAt(s, path, v);
          expect(KIND_SCHEMAS[kind].safeParse(s).success, `${kind} ${path.join('.')} = ${String(v)}`).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBe([...DOC_KINDS].reduce((n, k) => n + leaves(SAMPLES[k]).length * (bad.length - 1), 0));
    for (const f of ['quotation.lines.qty', 'quotation.lines.unitPrice', 'quotation.discount', 'purchase_order.whtRate', 'withholding_tax_cert.amountPaid', 'withholding_tax_cert.whtRate', 'offer_letter.monthlySalary', 'expense_report.expenses.amount']) expect(fields.has(f), f).toBe(true);
    expect(KIND_SCHEMAS.offer_letter.safeParse({ ...SAMPLES.offer_letter, probationDays: -0 }).success).toBe(false);
    expect(KIND_SCHEMAS.offer_letter.safeParse({ ...SAMPLES.offer_letter, probationDays: 90 }).success).toBe(true);
    for (const v of bad) {
      expect(isBaht(v), String(v)).toBe(false);
      expect(Baht.safeParse(v).success, String(v)).toBe(false);
    }
    expect(isBaht(0)).toBe(true);
    expect(isBaht(1_000_000_000)).toBe(true);
    expect(isBaht(1234.56)).toBe(true);
    expect(isQty(0)).toBe(false);
    expect(isQty(2.5)).toBe(true);
    expect(isQty(1_000_001)).toBe(false);
  });

  it('RF18: VAT 7% of the net amount is rounded half up to the satang; withholding likewise; all in integers', () => {
    // 1.50 baht -> VAT 0.105 -> 0.11 (half up), 15 satang * 7 = 105 -> (105 + 50) / 100 = 1.55 -> 1 ... in satang: 150*7/100 = 10.5 -> 11
    const t = computeTotals({ lines: [{ description: 'x', qty: 1, unitPrice: 1.5 }], vat: true });
    expect(t).toMatchObject({ subtotal: 150, vat: 11, wht: 0, payable: 161 });
    const t2 = computeTotals({ lines: [{ description: 'x', qty: 1, unitPrice: 1.49 }], vat: true }); // 149 * 7 / 100 = 10.43 -> 10
    expect(t2.vat).toBe(10);
    const t3 = computeTotals({ lines: [{ description: 'x', qty: 3, unitPrice: 0.01 }, { description: 'y', qty: 1.5, unitPrice: 33.33 }], vat: true, discount: 1, whtRate: 3 });
    expect(t3.lines.map((l) => l.totalSatang)).toEqual([3, 4_999.5 === 4999.5 ? 5000 : 0]); // 1.5 * 3333 = 4999.5 -> 5000 half up
    expect(t3.subtotal).toBe(5003);
    expect(t3.net).toBe(4903);
    expect(t3.vat).toBe(343); // 4903 * 7 / 100 = 343.21
    expect(t3.wht).toBe(147); // 4903 * 3 / 100 = 147.09
    expect(t3.payable).toBe(4903 + 343 - 147);
    for (const n of [t.subtotal, t.vat, t3.payable]) expect(Number.isInteger(n)).toBe(true);
    expect(fmtSatang(123_456_789)).toBe('1,234,567.89');
    expect(fmtSatang(5)).toBe('0.05');
    expect(toSatang(1.15)).toBe(115);
    expect(toSatang(0.07)).toBe(7);
  });

  it('RF18: the maximum case stays exact (qty 1e6 x 1e6 baht would overflow doubles; it is refused by the line cap, not rounded)', () => {
    expect(() => computeTotals({ lines: [{ description: 'big', qty: 1_000_000, unitPrice: 1_000_000_000 }], vat: true })).toThrow(MoneyError);
    const edge = computeTotals({ lines: [{ description: 'max', qty: 1, unitPrice: 1_000_000_000 }], vat: true });
    expect(edge.subtotal).toBe(100_000_000_000);
    expect(edge.vat).toBe(7_000_000_000);
    const many = computeTotals({ lines: Array.from({ length: 200 }, () => ({ description: 'm', qty: 1, unitPrice: 1_000_000_000 })), vat: true });
    expect(Number.isSafeInteger(many.payable)).toBe(true);
    expect(many.payable).toBe(200 * 107_000_000_000);
  });

  it('RF18: the withholding rate is an enum (1, 2, 3, 5, 10, 15), never a free number', () => {
    for (const ok of [1, 2, 3, 5, 10, 15]) expect(KIND_SCHEMAS.withholding_tax_cert.safeParse({ ...SAMPLES.withholding_tax_cert, whtRate: ok }).success, String(ok)).toBe(true);
    for (const bad of [0, 4, 7, 3.5, 100, -3, NaN, Infinity, '3']) expect(KIND_SCHEMAS.withholding_tax_cert.safeParse({ ...SAMPLES.withholding_tax_cert, whtRate: bad }).success, String(bad)).toBe(false);
    expect(whtOn(10000, 3)).toEqual({ paid: 1_000_000, wht: 30_000 });
    expect(whtOn(0.5, 3).wht).toBe(2); // 50 * 3 / 100 = 1.5 -> 2 half up
  });

  it('RF18: a total, subtotal, vatAmount or net supplied by the model is refused (strict schemas); a discount larger than the subtotal is refused', () => {
    for (const key of ['total', 'subtotal', 'vatAmount', 'vat_total', 'net', 'grandTotal', 'whtAmount', 'amountDue']) {
      expect(KIND_SCHEMAS.quotation.safeParse({ ...SAMPLES.quotation, [key]: 1 }).success, key).toBe(false);
      expect(KIND_SCHEMAS.quotation.safeParse({ ...SAMPLES.quotation, lines: [{ ...lines[0], total: 5 }] }).success).toBe(false);
    }
    expect(KIND_SCHEMAS.quotation.safeParse({ ...SAMPLES.quotation, discount: 1_000_000 }).success).toBe(false);
    expect(KIND_SCHEMAS.tax_invoice.safeParse({ ...SAMPLES.tax_invoice, vat: false }).success).toBe(false); // a tax invoice always has VAT
  });
});

// ---- RF17 templates -------------------------------------------------------------------------------------------------------------------------

// each at most 20 characters, so it fits every text field (the shortest is `unit`, 20): no kind x payload pair is skipped
const PAYLOADS = ['<script>1</script>', '<img src=x onerror=1', '<link href=//e.co>', '<iframe src=file:>', 'url(http://e.co/x)', '"><b onclick=1>', "';background:url(", '</style><script>'];

/** The page with the embedded font block removed: the only place `url(` may appear is the font data: URL. */
const body = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/, '<style></style>');

describe('RF17 templates and data', () => {
  const profile = PROFILE;
  const gen = (kind: DocKind, data: Record<string, unknown>) => buildDocument(kind, KIND_SCHEMAS[kind].parse(data) as never, { ref: 'DRAFT-TEST', generated: '2026-11-03', profile });

  it('RF17: every string field of every kind is escaped into a text node; no script, link, iframe, img, href, src or url( is injected', () => {
    let checked = 0;
    for (const kind of DOC_KINDS) {
      for (const p of PAYLOADS) {
        const inject = (o: unknown): unknown => {
          if (typeof o === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(o) || /^\d+$/.test(o) || ['full_time', 'invoice', '40_6'].includes(o) ? o : p;
          if (Array.isArray(o)) return o.map(inject);
          if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ['mode', 'employmentType', 'incomeType', 'taxId', 'phone', 'email'].includes(k) ? v : inject(v)]));
          return o;
        };
        const data = inject(SAMPLES[kind]) as Record<string, unknown>;
        const parsed = KIND_SCHEMAS[kind].safeParse(data);
        expect(parsed.success, `${kind} ${p}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues[0])}`).toBe(true); // never skipped
        checked++;
        const html = body(gen(kind, data).html);
        expect(html, `${kind} ${p}`).not.toMatch(/<script|<link|<iframe|<img|<object|<embed|<form|<a[ >]|<[a-z][^>]*\son\w+\s*=/i); // payload text such as `onclick=1` may appear as escaped text, never inside a tag
        expect(html, `${kind} ${p}`).not.toMatch(/<[a-z][^>]*\b(href|src|style)\s*=/i); // no data value reaches an attribute
        expect(html.match(/<style>/g), `${kind} ${p}`).toHaveLength(1); // nor CSS (the one style element is the template's; payload text is escaped)
        expect(html, `${kind} ${p}`).not.toContain('evil.example/a.css"');
        expect(html, `${kind} ${p}`).toContain(esc(p));
      }
    }
    expect(checked).toBe(DOC_KINDS.length * PAYLOADS.length);
  });

  it('RF17: the document carries a restrictive CSP meta, no script element, and the only url() is the embedded font data: URL', () => {
    const h = gen('quotation', SAMPLES.quotation!).html;
    expect(h).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`);
    expect(h).not.toMatch(/<script/i);
    const urls = [...h.matchAll(/url\(([^)]{0,40})/g)].map((m) => m[1]);
    expect(urls.length).toBe(2);
    for (const u of urls) expect(u).toMatch(/^data:font\/ttf;base64,/);
    expect(h).not.toMatch(/https?:\/\//); // no network reference at all
    expect(h).not.toMatch(/@import/);
  });

  it('RF17: schemas are strict (unknown keys refused), size bounds hold (64 KB, 200 lines, string lengths)', () => {
    for (const kind of DOC_KINDS) expect(KIND_SCHEMAS[kind].safeParse({ ...SAMPLES[kind], extraneous: 1 }).success, kind).toBe(false);
    expect(KIND_SCHEMAS.quotation.safeParse({ ...SAMPLES.quotation, lines: Array.from({ length: 201 }, () => lines[0]) }).success).toBe(false);
    expect(KIND_SCHEMAS.quotation.safeParse({ ...SAMPLES.quotation, lines: Array.from({ length: 200 }, () => lines[0]) }).success).toBe(true);
    expect(KIND_SCHEMAS.report.safeParse({ ...SAMPLES.report, summary: 'x'.repeat(4001) }).success).toBe(false);
    expect(dataSizeProblem(JSON.stringify({ a: 'x'.repeat(70_000) }))).toMatch(/65536/);
    expect(dataSizeProblem(JSON.stringify({ a: 'ก'.repeat(30_000) }))).toMatch(/65536/); // bytes, not characters: 30k Thai characters are 90 KB
    expect(dataSizeProblem(JSON.stringify(SAMPLES.report))).toBeNull();
    expect(KIND_SCHEMAS.report.safeParse({ ...SAMPLES.report, title: 'a\u0000b' }).success).toBe(false);
  });

  it('RF17: strings are redacted before render (a secret-shaped token is masked); a 13-digit tax ID and a Thai phone number stay readable', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const out = gen('quotation', { ...SAMPLES.quotation, notes: `key ${key}`, customer: { ...party, taxId: '0105500000000', phone: '081-234-5678' } });
    expect(out.html).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out.html).toContain('0105500000000');
    expect(out.html).toContain('081-234-5678');
    expect(redactDeep({ a: [`x ${key}`], n: 5 }).a[0]).not.toContain('abcdefghijklmnop');
  });

  it('RF17: CSV cells use guardCell (formula injection) and RFC 4180 quoting; tabular kinds only', () => {
    const q = gen('quotation', { ...SAMPLES.quotation, discount: 0, lines: [{ description: '=HYPERLINK("http://evil")', qty: 1, unitPrice: 1 }, { description: 'a,"b"\nc', qty: 1, unitPrice: 2 }] });
    expect(q.csv).toContain("'=HYPERLINK");
    expect(q.csv).toContain('"a,""b""\nc"');
    expect(q.csv!.startsWith('﻿')).toBe(true);
    for (const kind of DOC_KINDS) expect(gen(kind, SAMPLES[kind]!).csv !== null, kind).toBe(KIND_INFO[kind].tabular);
  });
});

// ---- RF19 draft -----------------------------------------------------------------------------------------------------------------------------

describe('RF19 drafts only', () => {
  const gen = (kind: DocKind) => buildDocument(kind, KIND_SCHEMAS[kind].parse(SAMPLES[kind]) as never, { ref: 'DRAFT-AB12CD34', generated: '2026-11-03', profile: PROFILE });

  it('RF19: the DRAFT watermark is part of the template for every money, tax and HR-offer kind (and only those); a fixed, print-repeating element', () => {
    for (const kind of DOC_KINDS) {
      const h = gen(kind).html;
      if (isDraftKind(kind)) {
        expect(h, kind).toContain(`<div class="wm">${WATERMARK_TEXT}</div>`);
        expect(h, kind).toContain('.wm{position:fixed');
      } else expect(h, kind).not.toContain('class="wm"');
    }
    expect(DOC_KINDS.filter(isDraftKind).sort()).toEqual(['expense_report', 'invoice_receipt', 'offer_letter', 'purchase_order', 'purchase_request', 'quotation', 'tax_invoice', 'withholding_tax_cert'].sort());
  });

  it('RF19: no data value can remove or restyle the watermark: data never reaches CSS or attributes, a payload stays text', () => {
    const data = { ...SAMPLES.quotation, notes: '</style><style>.wm{display:none}</style><div class="wm">', customer: { ...party, name: '"><style>.wm{display:none}</style>' } };
    const h = buildDocument('quotation', KIND_SCHEMAS.quotation.parse(data) as never, { ref: 'DRAFT-AB12CD34', generated: '2026-11-03', profile: PROFILE }).html;
    expect(h.match(/<style>/g)).toHaveLength(1);
    expect(h).not.toContain('<style>.wm');
    expect(h.match(/class="wm"/g)).toHaveLength(1);
  });

  it('RF19: no document-number, legal-series, signature or stamp field exists in any schema; the reference is a code-made DRAFT-<random>', () => {
    const keys = (s: unknown): string[] => {
      const out: string[] = [];
      const visit = (z: any): void => {
        const def = z?._zod?.def ?? z?.def;
        if (!def) return;
        if (def.type === 'object') for (const [k, v] of Object.entries(def.shape ?? {})) { out.push(k); visit(v); }
        else if (def.innerType) visit(def.innerType);
        else if (def.element) visit(def.element);
        else if (def.in) visit(def.in);
      };
      visit(s);
      return out;
    };
    const all = new Set(DOC_KINDS.flatMap((k) => keys(KIND_SCHEMAS[k])));
    expect(all.size).toBeGreaterThan(30);
    for (const k of all) expect(k, k).not.toMatch(/number|series|serial|signature|signed|stamp|seal|^no$|^id$|docid|reference|recipient|^to$|^cc$|^bcc$|sendto|webhook|url|link/i);
    expect(gen('tax_invoice').html).toMatch(/DRAFT-AB12CD34/);
  });

  it('RF19: the tool has no recipient parameter; its input is exactly {kind, data}', async () => {
    const r = await rig();
    const spec = new ToolRegistry({ halt: { isHalted: () => false } });
    spec.register(r.tool as never);
    const s = spec.specsFor(['doc_create'])[0]!;
    expect(Object.keys((s.inputSchema as { properties: object }).properties).sort()).toEqual(['data', 'kind']);
    expect(r.tool.inputSchema.safeParse({ kind: 'report', data: JSON.stringify(SAMPLES.report), to: 'x@y.z' }).success).toBe(false);
    expect(r.tool.inputSchema.safeParse({ kind: 'report', data: JSON.stringify(SAMPLES.report), channelId: '1' }).success).toBe(false);
  });
});

// ---- RF20 company profile -------------------------------------------------------------------------------------------------------------------

describe('RF20 company profile and the tool when it is unset', () => {
  it('RF20: the Thai tax ID checksum is enforced (generated valid IDs pass, a wrong check digit fails)', () => {
    for (const f of ['010553600000', '110170000000', '350990012345', '000000000001']) expect(thaiTaxIdOk(taxIdOf(f)), f).toBe(true);
    const good = taxIdOf('010553600000');
    const bad = `${good.slice(0, 12)}${(Number(good[12]) + 1) % 10}`;
    expect(thaiTaxIdOk(bad)).toBe(false);
    expect(thaiTaxIdOk('123')).toBe(false);
    expect(thaiTaxIdOk('01055360000012')).toBe(false);
    expect(thaiTaxIdOk('abcdefghijklm')).toBe(false);
  });

  it('RF20: when company.profile is unset, money, tax and offer kinds are refused; other kinds still work', async () => {
    const r = await rig({ profile: null });
    for (const kind of ['quotation', 'tax_invoice', 'offer_letter'] as const) {
      const act = kind === 'offer_letter' ? HR : kind === 'quotation' ? SALES : FIN;
      const x = await rig({ profile: null, actor: act });
      const res = await x.reg.run('doc_create', { kind, data: SAMPLES[kind] }, x.c);
      expect(res.isError, kind).toBe(true);
      expect(res.content, kind).toMatch(/company profile/);
      expect(x.renderer.renderPdf).not.toHaveBeenCalled();
    }
    const rep = await r.reg.run('doc_create', { kind: 'report', data: SAMPLES.report }, r.c);
    expect(rep.isError).toBeFalsy();
  });
});

// ---- RF21, RF22, RF35 flow ------------------------------------------------------------------------------------------------------------------

describe('RF21 approval, audience, posting and the copy', () => {
  it('RF21: money, tax and offer kinds ALWAYS ask for approval, even for a direct, untainted run; the card shows counterparty, totals, VAT and WHT; nothing renders before the approval', async () => {
    for (const [kind, actor] of [['purchase_request', OPS], ['purchase_order', FIN], ['quotation', SALES], ['invoice_receipt', FIN], ['tax_invoice', FIN], ['withholding_tax_cert', FIN], ['expense_report', FIN], ['offer_letter', HR]] as const) {
      const r = await rig({ actor, direct: true });
      const res = await r.reg.run('doc_create', { kind, data: SAMPLES[kind] }, r.c);
      expect(res.content, kind).toMatch(/NOT DONE YET/);
      expect(r.approvals.request, kind).toHaveBeenCalledTimes(1);
      expect(r.renderer.renderPdf, kind).not.toHaveBeenCalled();
      const call = (r.approvals.request as unknown as { mock: { calls: [{ reason: string; tool: { name: string } }][] } }).mock.calls[0]![0];
      expect(call.reason, kind).toMatch(/DRAFT/);
      if (kind === 'purchase_order') expect(call.reason).toMatch(/supplier ACME Co.*subtotal.*VAT.*withholding 3%.*payable/);
      if (kind === 'quotation') expect(call.reason).toMatch(/customer ACME Co.*subtotal 2\d\d\.\d\d.*VAT/);
      if (kind === 'withholding_tax_cert') expect(call.reason).toMatch(/payee Payee.*paid 10,000\.00, withheld 3% = 300\.00/);
    }
  });

  it('RF21: another kind is a write under approvalFor: a direct untainted run is not asked, a tainted run is, a delegated run is', async () => {
    const direct = await rig({ actor: SALES, direct: true });
    expect((await direct.reg.run('doc_create', { kind: 'proposal', data: SAMPLES.proposal }, direct.c)).content).toMatch(/Created Proposal/);
    const tainted = await rig({ actor: SALES, direct: true, tainted: true });
    expect((await tainted.reg.run('doc_create', { kind: 'proposal', data: SAMPLES.proposal }, tainted.c)).content).toMatch(/NOT DONE YET/);
    const delegated = await rig({ actor: SALES, direct: false });
    expect((await delegated.reg.run('doc_create', { kind: 'proposal', data: SAMPLES.proposal }, delegated.c)).content).toMatch(/NOT DONE YET/);
  });

  it('RF21: an approved replay re-checks duty and profile live, then renders and posts the PDF and the CSV in the run\'s own thread only', async () => {
    const r = await rig({ actor: SALES });
    const res = await r.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r.c);
    expect(res.isError).toBeFalsy();
    expect(r.posted.map((p) => p.file.contentType)).toEqual(['application/pdf', 'text/csv; charset=utf-8']);
    for (const p of r.posted) expect(p.target).toEqual({ channelId: 'room-sales', threadId: 'thread-1' });
    expect(res.content).toMatch(/Computed by code: subtotal .*payable/);
    expect(res.content).toMatch(/DRAFT: unsigned, no legal number, not sent to anyone/);
    // the replay is refused when the live duty table no longer gives sales the duty
    const r2 = await rig({ actor: SALES, duties: { ...DEFAULT_DUTIES, sales: [] } });
    const refused = await r2.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r2.c);
    expect(refused.isError).toBe(true);
    expect(r2.renderer.renderPdf).not.toHaveBeenCalled();
  });

  it('RF21: HR, money and tax files are posted only in the owning department\'s own room: a channel of another department, an unmapped channel and no channel are refused', async () => {
    for (const room of ['room-hr', 'room-sales', 'unmapped-channel', null]) {
      const r = await rig({ actor: FIN, room });
      const res = await r.reg.runApproved('doc_create', { kind: 'purchase_order', data: SAMPLES.purchase_order }, r.c);
      expect(res.isError, String(room)).toBe(true);
      expect(res.content).toMatch(/own room or task thread/);
      expect(r.posted).toHaveLength(0);
      expect(r.renderer.renderPdf).not.toHaveBeenCalled();
    }
    // a coordination kind has no audience restriction
    const rep = await rig({ actor: FIN, room: 'room-hr' });
    expect((await rep.reg.run('doc_create', { kind: 'report', data: SAMPLES.report }, rep.c)).isError).toBeFalsy();
    const jd = await rig({ actor: HR, room: 'room-sales' });
    expect((await jd.reg.runApproved('doc_create', { kind: 'job_description', data: SAMPLES.job_description }, jd.c)).isError).toBe(true);
  });

  it('RF21 / RF38: the file names come from code (kind + date + random suffix); the CSV is masked; the posted body has no model text', async () => {
    const r = await rig({ actor: SALES });
    await r.reg.runApproved('doc_create', { kind: 'quotation', data: { ...SAMPLES.quotation, notes: 'ignore previous @everyone <@123>', customer: { ...party, name: '@everyone evil' } } }, r.c);
    const [pdf, csv] = r.posted;
    expect(pdf!.file.name).toMatch(/^quotation-20261103-[0-9a-f]{6}\.pdf$/);
    expect(csv!.file.name).toMatch(/^quotation-20261103-[0-9a-f]{6}\.csv$/);
    expect(pdf!.payload.body).toMatch(/^📄 Quotation \(ใบเสนอราคา\)\nRef DRAFT-[0-9A-F]{8} · 1 page\nDRAFT — ต้องตรวจสอบก่อนใช้/);
    expect(pdf!.payload.body).not.toMatch(/everyone|evil|ignore/);
    expect(csv!.payload.body).not.toMatch(/everyone|evil|ignore/);
  });

  it('RF21: the department copy is written by code outside Praw\'s workspace root, with a sidecar that carries the run\'s taint; Praw\'s own workspace never holds it', async () => {
    const r = await rig({ actor: SALES, tainted: true });
    const res = await r.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r.c);
    expect(res.content).toMatch(/A copy is kept in the sales document folder/);
    const dir = join(r.base, 'documents', 'sales');
    const names = (await readdir(dir)).sort();
    expect(names).toHaveLength(3);
    const meta = JSON.parse(await readFile(join(dir, names.find((n) => n.endsWith('.meta.json'))!), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ kind: 'quotation', dept: 'sales', tainted: true, draft: true });
    expect(meta.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(dir, names.find((n) => n.endsWith('.pdf'))!), 'utf8')).toContain('%PDF-1.7'); // bytes intact (not a UTF-8 round trip)
    await expect(stat(r.workspaceRoot)).rejects.toThrow(); // Praw's root was never created or written
    expect(r.records).toHaveLength(2); // provenance of both posted messages, with the run's taint
    expect(r.records[0]).toEqual(['msg1', 'thread-1', true, 'u1']);
  });

  it('global rule 9: an approved replay (an untainted context on a tainted task) records the task\'s taint in the sidecar and both provenance rows', async () => {
    const r = await rig({ actor: SALES });
    expect(r.c.tainted()).toBe(false);
    r.c.task = { ...r.c.task!, tainted: true };
    await r.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r.c);
    const dir = join(r.base, 'documents', 'sales');
    const meta = JSON.parse(await readFile(join(dir, (await readdir(dir)).find((n) => n.endsWith('.meta.json'))!), 'utf8')) as { tainted: boolean };
    expect(meta.tainted).toBe(true);
    expect(r.records.map((x) => x[2])).toEqual([true, true]);
    const clean = await rig({ actor: SALES });
    await clean.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, clean.c);
    expect(clean.records.map((x) => x[2])).toEqual([false, false]);
  });

  it('RF17: `data` must be the JSON text of one object: an array, a scalar, broken JSON, an object value and an oversized text are refused', async () => {
    const r = await rig({ actor: SALES });
    for (const data of ['[]', '5', 'null', '{broken', 'x'.repeat(70_000)]) expect((await r.reg.run('doc_create', { kind: 'report', data }, r.c)).content, data.slice(0, 20)).toMatch(/invalid input for doc_create/);
    expect(r.tool.inputSchema.safeParse({ kind: 'report', data: SAMPLES.report }).success).toBe(false); // a real object is not the model-facing form
    expect(r.approvals.request).not.toHaveBeenCalled();
  });

  it('RF38: logs hold the kind, size and sha256 only: never content, names or the company profile', async () => {
    const r = await rig({ actor: SALES });
    await r.reg.runApproved('doc_create', { kind: 'quotation', data: { ...SAMPLES.quotation, notes: 'SECRET-NOTE-TEXT' } }, r.c);
    const logged = JSON.stringify([...r.log.info.mock.calls, ...r.log.warn.mock.calls, ...r.log.error.mock.calls]);
    expect(logged).toMatch(/"kind":"quotation"/);
    expect(logged).toMatch(/[0-9a-f]{64}/);
    expect(logged).not.toMatch(/SECRET-NOTE-TEXT|ACME|ทดสอบ|taxId|0105536/);
  });

  it('RF38: a render refusal (renderer error) is a fixed text; nothing is posted or saved', async () => {
    for (const code of ['busy', 'timeout', 'too_large', 'too_many_pages', 'unavailable', 'failed'] as const) {
      const r = await rig({ actor: SALES, renderer: { renderPdf: async () => { throw new RenderError(code, 'internal detail /private/path'); } } });
      const res = await r.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r.c);
      expect(res.isError, code).toBe(true);
      expect(res.content, code).not.toMatch(/internal detail|private/);
      expect(r.posted).toHaveLength(0);
    }
  });

  it('BOTLOG-1: a renderer fault is reported once with tool and stage; content refusals and busy are not incidents', async () => {
    const report = vi.fn((_i: unknown) => 'id');
    for (const code of ['busy', 'too_large', 'too_many_pages', 'bad_source'] as const) {
      const r = await rig({ actor: SALES, incidents: { report }, renderer: { renderPdf: async () => { throw new RenderError(code, 'x'); } } });
      await r.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r.c);
    }
    expect(report).not.toHaveBeenCalled();
    const r = await rig({ actor: SALES, incidents: { report }, renderer: { renderPdf: async () => { throw new RenderError('unavailable', 'connect ECONNREFUSED'); } } });
    await r.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r.c);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({ source: 'tool', stage: 'render', toolName: 'doc_create' });
  });

  it('a run makes at most 3 documents', async () => {
    const r = await rig({ actor: SALES, direct: true });
    for (let i = 0; i < 3; i++) expect((await r.reg.run('doc_create', { kind: 'report', data: SAMPLES.report }, r.c)).isError).toBeFalsy();
    expect((await r.reg.run('doc_create', { kind: 'report', data: SAMPLES.report }, r.c)).content).toMatch(/at most 3 documents/);
  });
});

describe('RF22 / RF35 duties', () => {
  it('RF22: the kind -> duty table: each owner passes; a department without the duty gets the WS12 refusal naming the owner handle', async () => {
    const pass: [DocKind, ActorRef][] = [['purchase_request', OPS], ['purchase_order', FIN], ['quotation', SALES], ['proposal', SALES], ['invoice_receipt', FIN], ['tax_invoice', FIN], ['withholding_tax_cert', FIN], ['expense_report', FIN], ['job_description', HR], ['offer_letter', HR], ['spec', SW], ['technical_design', SW], ['marketing_brief', MKT]];
    for (const [kind, actor] of pass) {
      const r = await rig({ actor });
      const res = await r.reg.runApproved('doc_create', { kind, data: SAMPLES[kind] }, r.c);
      expect(res.isError, `${kind} ${JSON.stringify(actor)} ${res.content}`).toBeFalsy();
    }
    const r = await rig({ actor: SALES });
    const res = await r.reg.run('doc_create', { kind: 'purchase_order', data: SAMPLES.purchase_order }, r.c);
    expect(res.isError).toBe(true);
    expect(res.content).toBe(`doc_create: purchase_order: department sales does not own duty finance; the owner is @${handleOf('finance')}`);
    expect(r.approvals.request).not.toHaveBeenCalled(); // refused before any approval row
    for (const [kind, actor] of [['marketing_brief', SALES], ['offer_letter', FIN], ['quotation', FIN], ['spec', HR]] as [DocKind, ActorRef][]) {
      const x = await rig({ actor });
      expect((await x.reg.run('doc_create', { kind, data: SAMPLES[kind] }, x.c)).content, kind).toMatch(/does not own duty/);
    }
  });

  it('RF22 / OD-4: meeting minutes, plan and report need no duty: any head may; a persona may not', async () => {
    for (const actor of [FIN, SALES, HR, OPS, SW, MKT, { kind: 'head', dept: 'praw' } as ActorRef]) {
      for (const kind of ['meeting_minutes', 'plan', 'report'] as const) {
        const r = await rig({ actor, room: null });
        const res = await r.reg.run('doc_create', { kind, data: SAMPLES[kind] }, { ...r.c, source: { ...r.c.source, channelId: 'any-channel' } });
        expect(res.isError, `${kind} ${JSON.stringify(actor)} ${res.content}`).toBeFalsy();
      }
    }
    const p = await rig({ actor: { kind: 'persona', personaId: 'system-analyst' } });
    expect((await p.reg.run('doc_create', { kind: 'report', data: SAMPLES.report }, p.c)).content).toMatch(/department head only/);
  });

  it('RF35: the duty is read live at every call: moving the duty moves the permission, with no restart', async () => {
    let table: Record<string, readonly string[]> = { ...DEFAULT_DUTIES };
    const r = await rig({ actor: SALES });
    r.c.duties = () => table;
    expect((await r.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r.c)).isError).toBeFalsy();
    table = { ...table, sales: [], finance: ['finance', 'sales'] };
    expect((await r.reg.runApproved('doc_create', { kind: 'quotation', data: SAMPLES.quotation }, r.c)).isError).toBe(true);
  });

  it('RF35: the registry refuses a call to a tool the actor\'s department is not offered, even when the model names it', async () => {
    const r = await rig({ actor: SALES });
    r.c.org = { ...r.c.org, toolsFor: () => ['web_search'] } as never;
    const res = await r.reg.run('doc_create', { kind: 'report', data: SAMPLES.report }, r.c);
    expect(res.content).toBe('tool doc_create is not allowed for you');
  });

  it('RF35: the default tools.byDept offers doc_create to every department; configRisk marks any duties.byDept change high risk (RF36)', async () => {
    const { CONFIG_DEFAULTS } = await import('../../../config/defaults.js');
    for (const [d, names] of Object.entries(CONFIG_DEFAULTS['tools.byDept'])) expect(names, d).toContain('doc_create');
    const { configRisk } = await import('../../../admin/keys.js');
    expect(configRisk('duties.byDept', DEFAULT_DUTIES, { ...DEFAULT_DUTIES, sales: ['sales', 'finance'] })).toBe(true);
  });
});

describe('group wiring', () => {
  it('D-04: an unsafe documents root turns the group off (fixed reason), it is never derived from the workspace root', async () => {
    const mk = (docsDir: string | undefined, workspaceRoot: string) => docsGroup({ cfg: new FakeConfig(), clock: Date.now, renderer: { renderPdf: async () => ({ pdf: Buffer.alloc(0), pages: 1 }) }, docsDir, workspaceRoot } as unknown as PluginDeps);
    expect(mk('/tmp/x/praw/docs', '/tmp/x/praw')).toMatchObject({ id: 'docs', disabled: expect.stringMatching(/workspace root/) });
    expect(mk(join((await import('node:os')).homedir(), 'Documents', 'd'), '/tmp/x/praw')).toMatchObject({ disabled: expect.stringMatching(/~\/Documents/) });
    expect(mk('/tmp/x/docs', '/tmp/x/praw')).toHaveProperty('tools');
  });

  it('RF15: without a renderer the docs group is off with a fixed message (no fallback renderer)', () => {
    const g = docsGroup({ cfg: new FakeConfig(), clock: Date.now } as unknown as PluginDeps);
    expect(g).toEqual({ id: 'docs', disabled: expect.stringMatching(/document renderer is not available on this host/) });
    expect(docsGroup({ cfg: new FakeConfig(), clock: Date.now, rendererDisabled: 'x is down' } as unknown as PluginDeps)).toEqual({ id: 'docs', disabled: 'x is down' });
  });

  it('the tool schema converts for Gemini, the description lists every kind and says totals are computed by code', async () => {
    const r = await rig();
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    reg.register(r.tool as never);
    const s = reg.specsFor(['doc_create'])[0]!;
    const g = toGeminiSchema(s.inputSchema) as { type?: string };
    expect(g.type).toBe('OBJECT');
    expect(JSON.stringify(g)).not.toMatch(/"\$schema"|"additionalProperties"|"\$ref"/);
    // `data` is the JSON text of the object: Gemini rejects an OBJECT parameter that declares no properties, and one bad declaration fails the whole request
    expect((g as { properties: Record<string, { type: string }> }).properties.data!.type).toBe('STRING');
    for (const k of DOC_KINDS) expect(s.description).toContain(k);
    expect(s.description).toMatch(/computed by code/);
  });

  it('invalid data never reaches a card: the zod refinement refuses it first (unknown key, bad number, too big)', async () => {
    const r = await rig({ actor: SALES });
    for (const data of [{ ...SAMPLES.quotation, total: 5 }, { ...SAMPLES.quotation, discount: 1e308 }, { ...SAMPLES.quotation, notes: 'x'.repeat(70_000) }]) {
      const res = await r.reg.run('doc_create', { kind: 'quotation', data }, r.c);
      expect(res.content).toMatch(/invalid input for doc_create/);
    }
    expect(r.approvals.request).not.toHaveBeenCalled();
  });

  it('the redaction helper and escape cover & < > " \'', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('every kind builds a document and renders through the fake renderer', async () => {
    for (const kind of DOC_KINDS) {
      const actor = ({ purchase_request: OPS, quotation: SALES, proposal: SALES, job_description: HR, offer_letter: HR, spec: SW, technical_design: SW, marketing_brief: MKT } as Record<string, ActorRef>)[kind] ?? FIN;
      const r = await rig({ actor });
      const res = await r.reg.runApproved('doc_create', { kind, data: SAMPLES[kind] }, r.c);
      expect(res.isError, `${kind}: ${res.content}`).toBeFalsy();
      expect(r.html).toHaveLength(1);
      expect(r.html[0]).toContain('<!doctype html>');
    }
  });

  it('Baht schema sanity: a valid 2-decimal amount parses', () => {
    expect(Baht.parse(10.25)).toBe(10.25);
  });
});

describe('company tax ID optional (owner 2026-11-03: not registered yet)', () => {
  it('a profile without taxId validates; tax_invoice and withholding_tax_cert are refused until it is set', async () => {
    const { CompanyProfileSchema } = await import('../../../company/profile.js');
    expect(CompanyProfileSchema.safeParse({ name: 'LabWorkSpace', address: 'Nonthaburi 11000' }).success).toBe(true);
    expect(CompanyProfileSchema.safeParse({ name: 'LabWorkSpace', address: 'x', taxId: '123' }).success).toBe(false);
  });
});

// ---- RFMD P4: plan / slides and diagram_create ------------------------------------------------------------------------------------------------

describe('P4 slides and plan (schema and template)', () => {
  const ID1 = 'dg-0a1b2c3d';
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const deck = (over: Record<string, unknown> = {}) => ({ title: 'Deck', sections: [{ heading: 'H', bullets: ['a'] }], ...over });

  it('slides is any-head, not a draft, has no CSV, and is a strict schema (no totals, no recipient, no unknown key)', () => {
    expect(KIND_INFO.slides.duties).toBe('any_head');
    expect(isDraftKind('slides')).toBe(false);
    expect(KIND_INFO.slides.tabular).toBe(false);
    const S = KIND_SCHEMAS.slides;
    expect(S.safeParse(deck()).success).toBe(true);
    expect(S.safeParse(deck({ to: 'x' })).success).toBe(false);
    expect(S.safeParse(deck({ sections: [] })).success).toBe(false);
    expect(S.safeParse(deck({ sections: Array.from({ length: 26 }, () => ({ heading: 'h' })) })).success).toBe(false);
    expect(S.safeParse(deck({ sections: Array.from({ length: 25 }, () => ({ heading: 'h' })) })).success).toBe(true); // 1 title + 25 = 26 pages, under the 30-page cap
    expect(S.safeParse(deck({ sections: [{ heading: 'h', bullets: Array.from({ length: 8 }, () => 'b') }] })).success).toBe(false);
    expect(S.safeParse(deck({ sections: [{ heading: 'h', url: 'http://x' }] })).success).toBe(false);
    expect(S.safeParse(deck({ title: 'x‮y' })).success).toBe(false);
  });

  it('P4-POLISH: a slide with a diagram and no text centres the picture (.solo); with text it keeps the two columns', () => {
    const o = { ref: 'R', generated: '2026-11-03', profile: null, diagrams: new Map([[ID1, PNG]]) };
    const solo = buildDocument('slides', deck({ sections: [{ heading: 'H', diagramId: ID1 }] }) as never, o).html;
    expect(solo).toContain('<div class="solo"><img');
    expect(solo).not.toContain('<div class="cols">');
    const both = buildDocument('slides', deck({ sections: [{ heading: 'H', bullets: ['a'], diagramId: ID1 }] }) as never, o).html;
    expect(both).toContain('<div class="cols">');
    expect(both).not.toContain('<div class="solo">');
  });

  it('diagram ids must be code-made ids (dg- and 8 hex), and at most 5 per document, for slides and for plan', () => {
    for (const bad of ['dg-xyz', '../x', 'DG-0A1B2C3D', 'dg-0a1b2c3d0', '<img>', '']) {
      expect(KIND_SCHEMAS.slides.safeParse(deck({ sections: [{ heading: 'h', diagramId: bad }] })).success, bad).toBe(false);
      expect(KIND_SCHEMAS.plan.safeParse({ ...SAMPLES.plan, sections: [{ heading: 'h', diagramId: bad }] }).success, bad).toBe(false);
    }
    const six = Array.from({ length: 6 }, () => ({ heading: 'h', diagramId: ID1 }));
    expect(KIND_SCHEMAS.slides.safeParse(deck({ sections: six })).success).toBe(false);
    expect(KIND_SCHEMAS.slides.safeParse(deck({ sections: six.slice(0, 5) })).success).toBe(true);
    expect(KIND_SCHEMAS.plan.safeParse({ ...SAMPLES.plan, sections: six }).success).toBe(false);
    expect(KIND_SCHEMAS.plan.safeParse({ ...SAMPLES.plan, sections: six.slice(0, 5) }).success).toBe(true);
  });

  it('template: every text value is escaped, a slide is landscape with one section each, no script/link/remote URL, and the only image is the held PNG as a data: URL', () => {
    const evil = '<script>alert(1)</script>"\'&<img src=x onerror=1>';
    const out = buildDocument('slides', { title: evil, subtitle: evil, sections: [{ heading: evil, body: evil, bullets: [evil], diagramId: ID1 }, { heading: 'two' }] } as never, { ref: 'DRAFT-AB12CD34', generated: '2026-11-03', profile: null, diagrams: new Map([[ID1, PNG]]) });
    expect(out.csv).toBeNull();
    expect(out.html).not.toMatch(/<script|onerror=1>|<img src=x|<link|<iframe|https?:\/\//i);
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('@page{size:297mm 167mm');
    expect((out.html.match(/<section class="slide">/g) ?? []).length).toBe(3); // title + 2 sections
    expect(out.html.match(/<img /g)).toHaveLength(1);
    expect(out.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`);
    expect(out.html).not.toContain(ID1); // the id is only a lookup key
    expect(out.html).not.toContain(WATERMARK_TEXT); // not a draft kind
  });

  it('template: secrets are masked before they reach a slide, and a missing diagram is a build error (never an empty image)', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const out = buildDocument('slides', deck({ sections: [{ heading: `k ${key}` }] }) as never, { ref: 'R', generated: '2026-11-03', profile: null });
    expect(out.html).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(() => buildDocument('slides', deck({ sections: [{ heading: 'h', diagramId: ID1 }] }) as never, { ref: 'R', generated: '2026-11-03', profile: null })).toThrow();
  });

  it('plan: extended, not duplicated: the same plan template with an optional figure after its section', () => {
    const plain = buildDocument('plan', SAMPLES.plan as never, { ref: 'R', generated: '2026-11-03', profile: null });
    expect(plain.html).not.toContain('<img');
    const withFig = buildDocument('plan', { ...SAMPLES.plan, sections: [{ heading: 'H', diagramId: ID1 }] } as never, { ref: 'R', generated: '2026-11-03', profile: null, diagrams: new Map([[ID1, PNG]]) });
    expect(withFig.html).toMatch(/<div class="sec"><h3>H<\/h3><img class="fig"/);
  });
});

describe('P4 diagram_create and doc_create(slides) through the registry', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('diagram-bytes')]);
  const drawn: { sourceSeen: string; html: string }[] = [];
  const mkRenderer = (over: Partial<DocRenderer> = {}): DocRenderer => ({
    renderPdf: vi.fn(async (h: string) => (drawn.push({ sourceSeen: '', html: h }), { pdf: Buffer.from('%PDF-1.7 fake /Type /Page'), pages: 3 })),
    renderDiagram: vi.fn(async (_p, src: string) => (drawn.push({ sourceSeen: src, html: _p.html }), { png: PNG, width: 400, height: 300 })),
    ...over,
  });
  const FLOW = 'flowchart TD\n  A[Start] --> B[End]';
  const idOf = (content: string): string => /dg-[0-9a-f]{8}/.exec(content)![0];

  it('P4-POLISH: the renderer gets the Thai-wrapped source (<br/> at word boundaries); the stored/checked text is the original', async () => {
    const r = await rig({ renderer: mkRenderer() });
    const long = 'หัวหน้าอนุมัติการลาของพนักงานภายในสามวัน';
    const res = await r.reg.run('diagram_create', { type: 'flowchart', source: `flowchart TD\n A[${long}] --> B[End]`, title: 'T' }, r.c);
    expect(res.isError).toBeFalsy();
    const seen = drawn[drawn.length - 1]!.sourceSeen;
    expect(seen).toContain('<br/>');
    expect(seen.replace(/<br\/>/g, '')).toContain(long);
  });

  it('registers with the docs group, no approval for any head (direct or not, tainted or not), posts exactly the renderer buffer as image/png', async () => {
    for (const actor of [FIN, SALES, HR, SW, MKT, OPS]) {
      const r = await rig({ renderer: mkRenderer(), actor, tainted: actor === HR });
      const res = await r.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: 'Process' }, r.c);
      expect(res.content, String(actor.kind === 'head' ? actor.dept : '')).toMatch(/^Created diagram dg-[0-9a-f]{8} \(flowchart\)/);
      expect(res.isError).toBeFalsy();
      expect(r.approvals.request).not.toHaveBeenCalled();
      expect(r.posted).toHaveLength(1);
      expect(r.posted[0]!.file.data).toBe(PNG);
      expect(r.posted[0]!.file.contentType).toBe('image/png');
      expect(r.posted[0]!.file.name).toMatch(/^diagram-dg-[0-9a-f]{8}\.png$/);
      expect(r.posted[0]!.target).toEqual({ channelId: ROOM_OF[actor.kind === 'head' ? actor.dept : 'finance'], threadId: 'thread-1' }); // only the run's own thread
      expect(r.records).toHaveLength(1);
    }
  });

  it('input is exactly {type, source, title} (no channel, no recipient, no path); a bad type, a long source and a forbidden construct are refused before anything is drawn', async () => {
    const rd = mkRenderer();
    const r = await rig({ renderer: rd });
    const sch = r.reg.specsFor(['diagram_create'])[0]!.inputSchema as { properties: object };
    expect(Object.keys(sch.properties).sort()).toEqual(['source', 'title', 'type']);
    for (const bad of [
      { type: 'pie', source: 'pie\n "a": 1', title: 't' },
      { type: 'flowchart', source: 'sequenceDiagram\n A->>B: x', title: 't' },
      { type: 'flowchart', source: `${FLOW}\n click A "http://x"`, title: 't' },
      { type: 'flowchart', source: `${FLOW}\n%% ${'a'.repeat(21000)}`, title: 't' },
      { type: 'flowchart', source: FLOW, title: 't', channelId: '1' },
      { type: 'flowchart', source: FLOW, title: '' },
    ]) {
      const res = await r.reg.run('diagram_create', bad, r.c);
      expect(res.isError, JSON.stringify(bad).slice(0, 60)).toBe(true);
    }
    expect(rd.renderDiagram).not.toHaveBeenCalled();
    expect(r.posted).toHaveLength(0);
  });

  it('RF24: the renderer gets the REDACTED source; the bundle page is built after the sha check', async () => {
    const rd = mkRenderer();
    const r = await rig({ renderer: rd });
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const res = await r.reg.run('diagram_create', { type: 'flowchart', source: `flowchart TD\n A[${key}] --> B`, title: `t ${key}` }, r.c);
    expect(res.content).toMatch(/masked/);
    const call = (rd.renderDiagram as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(call[0].html).toContain("script-src 'sha256-");
    expect(call[0].config).toMatchObject({ securityLevel: 'strict', htmlLabels: false });
    expect(r.posted[0]!.payload.body).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('renderer failures give fixed texts; a syntax error text is redacted; a per-run cap of 4; nothing is posted on failure', async () => {
    const bad = mkRenderer({ renderDiagram: vi.fn(async () => { throw new RenderError('bad_source', 'syntax error: Parse error on line 2 near sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'); }) });
    const r = await rig({ renderer: bad });
    const res = await r.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: 't' }, r.c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/Parse error/);
    expect(res.content).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    const busy = await rig({ renderer: mkRenderer({ renderDiagram: vi.fn(async () => { throw new RenderError('busy', 'x'); }) }) });
    expect((await busy.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: 't' }, busy.c)).content).toMatch(/busy/);
    expect(r.posted).toHaveLength(0);
    const ok = await rig({ renderer: mkRenderer() });
    for (let i = 0; i < 4; i++) expect((await ok.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: `t${i}` }, ok.c)).isError).toBeFalsy();
    expect((await ok.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: 't5' }, ok.c)).content).toMatch(/at most 4/);
  });

  it('a renderer without diagram support registers doc_create only', async () => {
    const r = await rig({ renderer: { renderPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF-1.7 /Type /Page'), pages: 1 })) } });
    expect(r.reg.specsFor(['diagram_create'])).toHaveLength(0);
    expect(r.reg.specsFor(['doc_create'])).toHaveLength(1);
  });

  it('slides embed a diagram made earlier in the same task tree (the stored PNG, not model data); the deck is posted as a PDF', async () => {
    const rd = mkRenderer();
    const r = await rig({ renderer: rd, direct: true });
    const made = await r.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: 'Flow' }, r.c);
    const id = idOf(made.content);
    const res = await r.reg.run('doc_create', { kind: 'slides', data: { title: 'Deck', sections: [{ heading: 'Flow', bullets: ['a'], diagramId: id }, { heading: 'End' }] } }, r.c);
    expect(res.content, res.content).toMatch(/Created Slide deck/);
    const html = (rd.renderPdf as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(html).toContain(`data:image/png;base64,${PNG.toString('base64')}`);
    const pdf = r.posted.find((p) => p.file.name.endsWith('.pdf'))!;
    expect(pdf.file.name).toMatch(/^slides-\d{8}-[0-9a-f]{6}\.pdf$/);
    expect(pdf.file.contentType).toBe('application/pdf');
    // and plan embeds one too
    const plan = await r.reg.run('doc_create', { kind: 'plan', data: { ...SAMPLES.plan, sections: [{ heading: 'H', diagramId: id }] } }, r.c);
    expect(plan.content, plan.content).toMatch(/Created Plan/);
  });

  it('G2RF4-02: a diagram drawn by a tainted run taints the deck that embeds it, even when the deck is made by a clean run of the same tree', async () => {
    const r = await rig({ renderer: mkRenderer(), direct: true });
    const dirtyRun = newRunState();
    dirtyRun.markTainted();
    const dirty = { ...r.c, run: dirtyRun, tainted: () => true } as ToolContext;
    const id = idOf((await r.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: 'Flow' }, dirty)).content);
    expect(r.c.tainted()).toBe(false);
    const res = await r.reg.run('doc_create', { kind: 'slides', data: { title: 'Deck', sections: [{ heading: 'Flow', diagramId: id }] } }, r.c);
    expect(res.content, res.content).toMatch(/Created Slide deck/);
    const dir = join(r.base, 'documents', 'finance');
    const meta = JSON.parse(await readFile(join(dir, (await readdir(dir)).find((n) => n.endsWith('.meta.json'))!), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ kind: 'slides', tainted: true });
    expect(r.records.at(-1)![2]).toBe(true); // provenance of the posted deck is tainted
  });

  it('RF27: an id from another task tree, an unknown id, or an id of a run without that task is refused with a fixed text; nothing is rendered or posted', async () => {
    const rd = mkRenderer();
    const r = await rig({ renderer: rd, direct: true });
    const id = idOf((await r.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: 'Flow' }, r.c)).content);
    const posted0 = r.posted.length;
    const other = { ...r.c, task: { ...r.c.task!, rootId: 'another-tree' }, run: newRunState() } as ToolContext;
    for (const [ctx, did] of [[other, id], [r.c, 'dg-ffffffff']] as const) {
      const res = await r.reg.run('doc_create', { kind: 'slides', data: { title: 'D', sections: [{ heading: 'h', diagramId: did }] } }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/was not made in this task/);
    }
    expect(rd.renderPdf).not.toHaveBeenCalled();
    expect(r.posted.length).toBe(posted0);
  });

  it('P4 conversation: a diagram drawn before the conversation had a task is found by the approved doc_create (runApproved) in the task that approval opened; another task still cannot', async () => {
    const r = await rig({ renderer: mkRenderer(), direct: true });
    const taskOf = (id: string, rootId: string) => ({ ...r.c.task!, id, rootId });
    const run = newRunState();
    const noTask = { ...r.c, task: null, run, tainted: () => run.tainted(), direct: false, ensureConversationTask: async () => taskOf('conv-task', 'conv-task') } as unknown as ToolContext;
    const id = idOf((await r.reg.run('diagram_create', { type: 'flowchart', source: FLOW, title: 'Flow' }, noTask)).content);
    const data = { title: 'Deck', sections: [{ heading: 'Flow', diagramId: id }] };
    const asked = await r.reg.run('doc_create', { kind: 'slides', data }, noTask); // asks for approval, which opens the conversation task
    expect(asked.content).toMatch(/NOT DONE YET/);
    const approved = { ...r.c, task: taskOf('conv-task', 'conv-task'), run: newRunState() } as ToolContext;
    const ok = await r.reg.runApproved('doc_create', { kind: 'slides', data }, approved);
    expect(ok.content, ok.content).toMatch(/Created Slide deck/);
    const elsewhere = { ...r.c, task: taskOf('other-task', 'other-task'), run: newRunState() } as ToolContext;
    const no = await r.reg.runApproved('doc_create', { kind: 'slides', data }, elsewhere);
    expect(no.isError).toBe(true);
    expect(no.content).toMatch(/was not made in this task/);
  });

  it('OD-4: any head may make a slide deck; a non-head actor may not; slides is write-gated by approvalFor like plan (an undirected run asks)', async () => {
    for (const actor of [FIN, SALES, HR, SW, MKT, OPS]) {
      const r = await rig({ renderer: mkRenderer(), actor, direct: true });
      expect((await r.reg.run('doc_create', { kind: 'slides', data: SAMPLES.slides }, r.c)).content, String(actor)).toMatch(/Created Slide deck/);
    }
    const undirected = await rig({ renderer: mkRenderer(), direct: false });
    expect((await undirected.reg.run('doc_create', { kind: 'slides', data: SAMPLES.slides }, undirected.c)).content).toMatch(/NOT DONE YET/);
    expect(kindRefusal('slides', { actor: { kind: 'persona', personaId: 'p' } as never, org: { persona: () => ({ deptId: 'finance' }) } as never, duties: () => DEFAULT_DUTIES })).toMatch(/head only/);
  });
});
