import { randomBytes } from 'node:crypto';
import { redactText } from '../../../core/logger.js';
import type { CompanyProfile } from '../../../company/profile.js';
import { field as csvField, guardCell } from '../ocr/csv.js';
import { fontCss } from './fonts.js';
import { isDraftKind, KIND_INFO, WATERMARK_TEXT, type DocKind } from './kinds.js';
import { computeTotals, fmtSatang, plainSatang, toSatang, whtOn, type Totals } from './money.js';
import type { DocData } from './schemas.js';

/**
 * RF17 / RF19: the code-owned HTML templates. Rules every template follows:
 * - the only dynamic text is passed through `esc` (& < > " ' escaped) and lands in a TEXT NODE; no data value is ever put into an attribute, a style,
 *   an href, a src or CSS, and the page has no <script>, <link>, <img> or <iframe> (the only url() is the embedded font data: URL);
 * - every string is masked with redactText BEFORE it gets here (`redactDeep`), because a PDF is binary and postFile sends it unmasked;
 * - money kinds (and the offer letter) carry the DRAFT watermark: a fixed element in the template, `position: fixed` so it prints on every page.
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);
/** Escaped text with line breaks kept (the <br> is the template's own). */
const ml = (s: string): string => esc(s).replace(/\r\n|\r|\n/g, '<br>');

/** RF17: masks secret and token patterns in every string of the data (deep). Numbers, booleans and keys are untouched. */
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactText(v) as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

/** RF19: the only reference a document carries; no legal series, no sequence. */
export const draftRef = (): string => `DRAFT-${randomBytes(4).toString('hex').toUpperCase()}`;

// ---- building blocks ----------------------------------------------------------------------------------------------------------------------

const row = (label: string, value: string | undefined): string => (value ? `<tr><th>${esc(label)}</th><td>${ml(value)}</td></tr>` : '');
const kv = (rows: string[]): string => `<table class="kv">${rows.join('')}</table>`;
const h = (s: string): string => `<h2>${esc(s)}</h2>`;
const ul = (a: readonly string[] | undefined): string => (a?.length ? `<ul>${a.map((x) => `<li>${ml(x)}</li>`).join('')}</ul>` : '');
const para = (s: string | undefined): string => (s ? `<p>${ml(s)}</p>` : '');
const sectionHtml = (s: { heading: string; body?: string | undefined; bullets?: string[] | undefined }, fig = ''): string => `<div class="sec"><h3>${esc(s.heading)}</h3>${para(s.body)}${ul(s.bullets)}${fig}</div>`;
/** P4: a diagram the code holds, as a `data:image/png` the page may load; the id is looked up, never echoed as markup. */
function figure(id: string | undefined, diagrams: ReadonlyMap<string, Buffer> | undefined, cls = 'fig'): string {
  if (!id) return '';
  const png = diagrams?.get(id);
  if (!png) throw new Error(`diagram ${id} is not available`);
  return `<img class="${cls}" alt="Diagram" src="data:image/png;base64,${png.toString('base64')}">`;
}
const table = (head: string[], rows: string[][], right: number[] = []): string =>
  `<table class="grid"><thead><tr>${head.map((x, i) => `<th${right.includes(i) ? ' class="r"' : ''}>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${right.includes(i) ? ' class="r"' : ''}>${ml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

type PartyIn = { name: string; address?: string | undefined; taxId?: string | undefined; phone?: string | undefined; email?: string | undefined };
const party = (label: string, p: PartyIn): string => `<div class="party"><h3>${esc(label)}</h3>${kv([row('Name / ชื่อ', p.name), row('Address / ที่อยู่', p.address), row('Tax ID / เลขประจำตัวผู้เสียภาษี', p.taxId), row('Phone / โทร', p.phone), row('Email', p.email)])}</div>`;

function totalsBlock(t: Totals): string {
  const r = (label: string, satang: number, strong = false): string => `<tr${strong ? ' class="strong"' : ''}><th>${esc(label)}</th><td class="r">${fmtSatang(satang)}</td></tr>`;
  return `<table class="totals">${r('Subtotal / รวมเป็นเงิน', t.subtotal)}${t.discount ? r('Discount / ส่วนลด', t.discount) : ''}${t.discount ? r('After discount / หลังหักส่วนลด', t.net) : ''}${t.vat ? r('VAT 7% / ภาษีมูลค่าเพิ่ม 7%', t.vat) : ''}${t.wht ? r(`Withholding tax ${t.whtRate}% / หัก ณ ที่จ่าย ${t.whtRate}%`, t.wht) : ''}${r('Total payable / ยอดสุทธิ (THB)', t.payable, true)}</table>`;
}

function linesTable(t: Totals): string {
  return table(
    ['#', 'Description / รายการ', 'Qty / จำนวน', 'Unit / หน่วย', 'Unit price / ราคาต่อหน่วย', 'Amount / จำนวนเงิน'],
    t.lines.map((l, i) => [String(i + 1), l.description, String(l.qty), l.unit ?? '', fmtSatang(l.unitPriceSatang), fmtSatang(l.totalSatang)]),
    [2, 4, 5],
  );
}

function letterhead(p: CompanyProfile | null): string {
  if (!p) return '';
  return `<div class="lh"><div class="lhn">${esc(p.name)}</div><div>${ml(p.address)}</div><div>${p.taxId ? esc(`Tax ID ${p.taxId}${p.branch ? ` · Branch ${p.branch}` : ''}`) : ''}${p.phone ? esc(` · ${p.phone}`) : ''}${p.email ? esc(` · ${p.email}`) : ''}</div></div>`;
}

// ---- the page --------------------------------------------------------------------------------------------------------------------------------

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const CSS = `
@page{size:A4;margin:18mm 16mm}
*{box-sizing:border-box}
body{font-family:'Sarabun',sans-serif;font-size:11pt;line-height:1.45;color:#111;margin:0}
h1{font-size:18pt;margin:0 0 4pt}h2{font-size:13pt;margin:14pt 0 4pt;border-bottom:1px solid #999}h3{font-size:11.5pt;margin:8pt 0 2pt}
p{margin:2pt 0 6pt}ul{margin:2pt 0 6pt 16pt;padding:0}
.sub{color:#555;font-size:9.5pt;margin-bottom:8pt}
.lh{border-bottom:2px solid #333;padding-bottom:6pt;margin-bottom:10pt;font-size:10pt}.lhn{font-size:14pt;font-weight:700}
table{border-collapse:collapse;width:100%}
table.kv th{width:34%;text-align:left;font-weight:700;vertical-align:top;padding:1pt 6pt 1pt 0}table.kv td{padding:1pt 0}
table.grid{margin:6pt 0}table.grid th,table.grid td{border:1px solid #888;padding:3pt 5pt;vertical-align:top}table.grid th{background:#eee;text-align:left}
.r{text-align:right}
table.totals{width:60%;margin:8pt 0 8pt auto}table.totals th{text-align:left;font-weight:400;padding:2pt 6pt}table.totals td{padding:2pt 6pt}table.totals tr.strong th,table.totals tr.strong td{font-weight:700;border-top:2px solid #333}
.cols{display:flex;gap:16pt}.cols>div{flex:1}
.sec{break-inside:avoid}
.fig{display:block;max-width:100%;max-height:150mm;margin:4pt 0}
.draftline{font-weight:700;color:#a00;margin-bottom:6pt}
.wm{position:fixed;top:42%;left:0;right:0;text-align:center;font-size:34pt;white-space:nowrap;font-weight:700;color:rgba(190,0,0,.16);transform:rotate(-28deg);z-index:9999;pointer-events:none}
.foot{margin-top:14pt;font-size:9pt;color:#555;border-top:1px solid #bbb;padding-top:4pt}
`;

function page(o: { ref: string; draft: boolean; title: string; body: string; generated: string }): string {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${esc(o.ref)}</title><style>${fontCss()}${CSS}</style></head><body>${
    o.draft ? `<div class="wm">${esc(WATERMARK_TEXT)}</div>` : ''
  }<h1>${esc(o.title)}</h1><div class="sub">${esc(o.ref)} · ${esc(o.generated)}</div>${o.draft ? `<div class="draftline">${esc(WATERMARK_TEXT)}</div>` : ''}${o.body}<div class="foot">${esc(o.ref)} · ${
    o.draft ? 'Draft prepared by software; not signed, not issued, not sent. / ฉบับร่างจัดทำโดยซอฟต์แวร์ ยังไม่ลงนาม ไม่ออกเอกสารจริง ไม่ได้ส่งออก' : 'Prepared by software.'
  }</div></body></html>`;
}

// ---- slide decks (P4) ---------------------------------------------------------------------------------------------------------------------

const DECK_CSS = `
@page{size:297mm 167mm;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Sarabun',sans-serif;color:#14213d}
.slide{width:297mm;height:167mm;padding:14mm 18mm 12mm;position:relative;overflow:hidden;break-after:page;page-break-after:always;background:#fff;border-top:6mm solid #1d4e89}
.slide:last-child{break-after:auto;page-break-after:auto}
.slide h1{font-size:34pt;margin:22mm 0 4mm;line-height:1.15}
.slide h2{font-size:24pt;margin:0 0 5mm;line-height:1.15;color:#1d4e89}
.slide .subtitle{font-size:16pt;color:#555}
.slide p{font-size:14pt;margin:0 0 4mm;line-height:1.4}
.slide ul{margin:0;padding-left:7mm;font-size:15pt;line-height:1.4}.slide li{margin-bottom:2mm}
.slide .cols{display:flex;gap:8mm;align-items:flex-start}.slide .cols>.txt{flex:1}.slide .cols>.pic{flex:1.3;text-align:center}
.slide .solo{text-align:center}.slide .solo img.dg{max-height:118mm}
.slide img.dg{max-width:100%;max-height:112mm}
.slide .pg{position:absolute;right:18mm;bottom:8mm;font-size:9pt;color:#777}
`;

/** RF23: a deck page carries only the PNGs the code holds (data: images) and fixed text; it never runs script. */
function deckPage(o: { ref: string; generated: string; title: string; subtitle?: string | undefined; sections: { heading: string; body?: string | undefined; bullets?: string[] | undefined; diagramId?: string | undefined }[]; diagrams: ReadonlyMap<string, Buffer> | undefined }): string {
  const total = o.sections.length + 1;
  const title = `<section class="slide"><h1>${esc(o.title)}</h1>${o.subtitle ? `<div class="subtitle">${ml(o.subtitle)}</div>` : ''}<p class="subtitle">${esc(o.generated)}</p><div class="pg">1 / ${total}</div></section>`;
  const slides = o.sections.map((s, i) => {
    const txt = `${para(s.body)}${ul(s.bullets)}`;
    const pic = figure(s.diagramId, o.diagrams, 'dg');
    return `<section class="slide"><h2>${esc(s.heading)}</h2>${pic && !txt ? `<div class="solo">${pic}</div>` : pic ? `<div class="cols"><div class="txt">${txt}</div><div class="pic">${pic}</div></div>` : txt}<div class="pg">${i + 2} / ${total}</div></section>`;
  });
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${esc(o.ref)}</title><style>${fontCss()}${DECK_CSS}</style></head><body>${title}${slides.join('')}</body></html>`;
}

// ---- per kind --------------------------------------------------------------------------------------------------------------------------------

export type Built = { html: string; csv: string | null; totals: Totals | null };

const INCOME_LABEL: Record<string, string> = {
  '40_1': '40(1) เงินเดือน ค่าจ้าง', '40_2': '40(2) ค่าธรรมเนียม ค่านายหน้า', '40_3': '40(3) ค่าแห่งลิขสิทธิ์', '40_4a': '40(4)(ก) ดอกเบี้ย', '40_4b': '40(4)(ข) เงินปันผล',
  '40_5': '40(5) ค่าเช่าทรัพย์สิน', '40_6': '40(6) วิชาชีพอิสระ', '40_7': '40(7) ค่ารับเหมา', '40_8': '40(8) เงินได้อื่น',
};

function csv(head: string[], rows: string[][]): string {
  return `﻿${[head, ...rows].map((r) => r.map((c) => csvField(guardCell(c))).join(',')).join('\r\n')}\r\n`;
}

function linesCsv(t: Totals, ref: string): string {
  const blank = ['', '', '', ''];
  return csv(['no', 'description', 'qty', 'unit', 'unit_price', 'line_total'], [
    ...t.lines.map((l, i) => [String(i + 1), l.description, String(l.qty), l.unit ?? '', plainSatang(l.unitPriceSatang), plainSatang(l.totalSatang)]),
    ['', 'Subtotal', ...blank.slice(0, 3), plainSatang(t.subtotal)],
    ...(t.discount ? [['', 'Discount', '', '', '', plainSatang(t.discount)]] : []),
    ...(t.vat ? [['', 'VAT 7%', '', '', '', plainSatang(t.vat)]] : []),
    ...(t.wht ? [['', `Withholding tax ${t.whtRate}%`, '', '', '', plainSatang(t.wht)]] : []),
    ['', 'Total payable', '', '', '', plainSatang(t.payable)],
    ['', `${WATERMARK_TEXT} ${ref}`, '', '', '', ''],
  ]);
}

export function buildDocument(kind: DocKind, raw: DocData[DocKind], o: { ref: string; generated: string; profile: CompanyProfile | null; diagrams?: ReadonlyMap<string, Buffer> }): Built {
  const data = redactDeep(raw) as DocData[DocKind];
  const profile = o.profile ? redactDeep(o.profile) : null;
  const info = KIND_INFO[kind];
  const draft = isDraftKind(kind);
  const wrap = (body: string, totals: Totals | null = null, csvText: string | null = null): Built => ({ html: page({ ref: o.ref, draft, title: info.title, body, generated: o.generated }), csv: csvText, totals });
  const lh = letterhead(profile);

  switch (kind) {
    case 'purchase_request': {
      const d = data as DocData['purchase_request'];
      const t = computeTotals({ lines: d.lines, vat: d.vat ?? false, discount: d.discount });
      return wrap(lh + kv([row('Requester / ผู้ขอซื้อ', d.requester), row('Department / แผนก', d.department), row('Needed by / ต้องการภายใน', d.neededBy), row('Reason / เหตุผล', d.reason)]) + h('Items / รายการ') + linesTable(t) + totalsBlock(t) + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : ''), t, linesCsv(t, o.ref));
    }
    case 'purchase_order': {
      const d = data as DocData['purchase_order'];
      const t = computeTotals({ lines: d.lines, vat: d.vat ?? false, discount: d.discount, whtRate: d.whtRate });
      return wrap(lh + party('Supplier / ผู้ขาย', d.supplier) + kv([row('Order date / วันที่สั่งซื้อ', d.orderDate), row('Delivery date / กำหนดส่ง', d.deliveryDate), row('Deliver to / สถานที่ส่ง', d.deliveryAddress), row('Payment terms / เงื่อนไขการชำระ', d.paymentTerms)]) + h('Items / รายการ') + linesTable(t) + totalsBlock(t) + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : ''), t, linesCsv(t, o.ref));
    }
    case 'quotation': {
      const d = data as DocData['quotation'];
      const t = computeTotals({ lines: d.lines, vat: d.vat ?? false, discount: d.discount });
      return wrap(lh + party('Customer / ลูกค้า', d.customer) + kv([row('Quote date / วันที่เสนอราคา', d.quoteDate), row('Valid until / ใช้ได้ถึง', d.validUntil), row('Payment terms / เงื่อนไขการชำระ', d.paymentTerms)]) + h('Items / รายการ') + linesTable(t) + totalsBlock(t) + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : ''), t, linesCsv(t, o.ref));
    }
    case 'invoice_receipt': {
      const d = data as DocData['invoice_receipt'];
      const t = computeTotals({ lines: d.lines, vat: d.vat ?? false, discount: d.discount, whtRate: d.whtRate });
      const mode = d.mode === 'invoice' ? 'Invoice (draft) / ใบแจ้งหนี้ (ร่าง)' : 'Receipt (draft) / ใบเสร็จรับเงิน (ร่าง)';
      return wrap(lh + kv([row('Type / ประเภท', mode)]) + party('Customer / ลูกค้า', d.customer) + kv([row('Issue date / วันที่', d.issueDate), row('Due date / ครบกำหนด', d.dueDate), row('Payment method / วิธีชำระ', d.paymentMethod)]) + h('Items / รายการ') + linesTable(t) + totalsBlock(t) + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : ''), t, linesCsv(t, o.ref));
    }
    case 'tax_invoice': {
      const d = data as DocData['tax_invoice'];
      const t = computeTotals({ lines: d.lines, vat: true, discount: d.discount });
      return wrap(lh + party('Customer / ผู้ซื้อ', d.customer) + kv([row('Issue date / วันที่', d.issueDate)]) + h('Items / รายการ') + linesTable(t) + totalsBlock(t) + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : ''), t, linesCsv(t, o.ref));
    }
    case 'withholding_tax_cert': {
      const d = data as DocData['withholding_tax_cert'];
      const w = whtOn(d.amountPaid, d.whtRate);
      return wrap(lh + party('Payer / ผู้มีหน้าที่หักภาษี ณ ที่จ่าย (the company above)', { name: profile?.name ?? '', ...(profile ? { address: profile.address, taxId: profile.taxId } : {}) })
        + party('Payee / ผู้ถูกหักภาษี ณ ที่จ่าย', d.payee)
        + kv([row('Payment date / วันที่จ่าย', d.paymentDate), row('Income type / ประเภทเงินได้', INCOME_LABEL[d.incomeType]), row('Withholding rate / อัตราภาษีที่หัก', `${d.whtRate}%`)])
        + `<table class="totals"><tr><th>Amount paid / จำนวนเงินที่จ่าย (THB)</th><td class="r">${fmtSatang(w.paid)}</td></tr><tr class="strong"><th>Tax withheld / ภาษีที่หักและนำส่ง (THB)</th><td class="r">${fmtSatang(w.wht)}</td></tr></table>`
        + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : ''));
    }
    case 'expense_report': {
      const d = data as DocData['expense_report'];
      const sats = d.expenses.map((e) => toSatang(e.amount));
      const total = sats.reduce((s, x) => s + x, 0);
      const rows = d.expenses.map((e, i) => [e.date, e.category, e.description, fmtSatang(sats[i]!)]);
      const body = lh + kv([row('Employee / พนักงาน', d.employee), row('Department / แผนก', d.department), row('Period / ช่วงเวลา', `${d.periodStart} – ${d.periodEnd}`), row('Purpose / วัตถุประสงค์', d.purpose)])
        + h('Expenses / รายการค่าใช้จ่าย') + table(['Date / วันที่', 'Category / หมวด', 'Description / รายละเอียด', 'Amount / จำนวนเงิน'], rows, [3])
        + `<table class="totals"><tr class="strong"><th>Total / รวม (THB)</th><td class="r">${fmtSatang(total)}</td></tr></table>` + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : '');
      const fake: Totals = { lines: [], subtotal: total, discount: 0, net: total, vat: 0, wht: 0, whtRate: null, payable: total };
      return wrap(body, fake, csv(['date', 'category', 'description', 'amount'], [...d.expenses.map((e, i) => [e.date, e.category, e.description, plainSatang(sats[i]!)]), ['', '', 'Total', plainSatang(total)], ['', '', `${WATERMARK_TEXT} ${o.ref}`, '']]));
    }
    case 'job_description': {
      const d = data as DocData['job_description'];
      return wrap(lh + kv([row('Job title / ตำแหน่ง', d.jobTitle), row('Department / แผนก', d.department), row('Reports to / รายงานต่อ', d.reportsTo), row('Location / สถานที่ทำงาน', d.location), row('Employment type / ประเภทการจ้าง', d.employmentType)])
        + h('Summary / สรุป') + para(d.summary) + h('Responsibilities / หน้าที่ความรับผิดชอบ') + ul(d.responsibilities) + h('Requirements / คุณสมบัติ') + ul(d.requirements) + (d.benefits?.length ? h('Benefits / สวัสดิการ') + ul(d.benefits) : ''));
    }
    case 'offer_letter': {
      const d = data as DocData['offer_letter'];
      return wrap(lh + kv([row('Candidate / ผู้สมัคร', d.candidate), row('Position / ตำแหน่ง', d.position), row('Department / แผนก', d.department), row('Reports to / รายงานต่อ', d.reportsTo), row('Start date / วันเริ่มงาน', d.startDate),
        row('Monthly salary / เงินเดือน (THB)', fmtSatang(toSatang(d.monthlySalary))), row('Probation / ทดลองงาน', d.probationDays === undefined ? undefined : `${d.probationDays} days`)])
        + (d.benefits?.length ? h('Benefits / สวัสดิการ') + ul(d.benefits) : '') + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : '')
        + '<p class="sub">This draft has no signature and is not an offer until reviewed and issued by an authorised person. / ฉบับร่างนี้ไม่มีลายมือชื่อ และยังไม่เป็นหนังสือเสนองานจนกว่าผู้มีอำนาจจะตรวจสอบและออกเอกสาร</p>');
    }
    case 'meeting_minutes': {
      const d = data as DocData['meeting_minutes'];
      return wrap(kv([row('Title / หัวข้อ', d.title), row('Date / วันที่', d.date), row('Location / สถานที่', d.location)]) + h('Attendees / ผู้เข้าร่วม') + ul(d.attendees) + h('Agenda / วาระ') + ul(d.agenda)
        + (d.discussion ? h('Discussion / การหารือ') + para(d.discussion) : '') + (d.decisions?.length ? h('Decisions / มติ') + ul(d.decisions) : '')
        + (d.actions?.length ? h('Action items / สิ่งที่ต้องทำ') + table(['Owner / ผู้รับผิดชอบ', 'Task / งาน', 'Due / กำหนด'], d.actions.map((a) => [a.owner, a.task, a.due ?? ''])) : ''));
    }
    case 'plan': {
      const d = data as DocData['plan'];
      return wrap(`<h2>${esc(d.title)}</h2>` + h('Objective / วัตถุประสงค์') + para(d.objective) + d.sections.map((x) => sectionHtml(x, figure(x.diagramId, o.diagrams))).join('')
        + (d.milestones?.length ? h('Milestones / เป้าหมายย่อย') + table(['Milestone', 'Date / วันที่', 'Owner / ผู้รับผิดชอบ'], d.milestones.map((m) => [m.name, m.date ?? '', m.owner ?? ''])) : ''));
    }
    case 'slides': {
      const d = data as DocData['slides'];
      return { html: deckPage({ ref: o.ref, generated: o.generated, title: d.title, subtitle: d.subtitle, sections: d.sections, diagrams: o.diagrams }), csv: null, totals: null };
    }
    case 'report': {
      const d = data as DocData['report'];
      return wrap(`<h2>${esc(d.title)}</h2>` + kv([row('Period / ช่วงเวลา', d.period)]) + h('Summary / สรุป') + para(d.summary) + d.sections.map((x) => sectionHtml(x)).join('') + (d.conclusions?.length ? h('Conclusions / ข้อสรุป') + ul(d.conclusions) : ''));
    }
    case 'spec':
    case 'technical_design': {
      const d = data as DocData['spec'];
      return wrap(`<h2>${esc(d.title)}</h2>` + kv([row('Version / เวอร์ชัน', d.version)]) + h('Overview / ภาพรวม') + para(d.overview) + h('Goals / เป้าหมาย') + ul(d.goals) + (d.nonGoals?.length ? h('Non-goals / สิ่งที่ไม่ทำ') + ul(d.nonGoals) : '')
        + d.sections.map((x) => sectionHtml(x)).join('') + (d.openQuestions?.length ? h('Open questions / คำถามที่ยังเปิดอยู่') + ul(d.openQuestions) : ''));
    }
    case 'proposal': {
      const d = data as DocData['proposal'];
      return wrap(`<h2>${esc(d.title)}</h2>` + (d.client ? party('Client / ลูกค้า', d.client) : '') + h('Summary / สรุป') + para(d.summary) + d.sections.map((x) => sectionHtml(x)).join('') + (d.nextSteps?.length ? h('Next steps / ขั้นตอนต่อไป') + ul(d.nextSteps) : ''));
    }
    case 'marketing_brief': {
      const d = data as DocData['marketing_brief'];
      return wrap(`<h2>${esc(d.campaign)}</h2>` + h('Objective / วัตถุประสงค์') + para(d.objective) + h('Audience / กลุ่มเป้าหมาย') + para(d.audience) + h('Key messages / ข้อความหลัก') + ul(d.keyMessages) + h('Channels / ช่องทาง') + ul(d.channels)
        + (d.timeline?.length ? h('Timeline / ไทม์ไลน์') + table(['Item', 'Date / วันที่'], d.timeline.map((x) => [x.label, x.date ?? ''])) : '') + (d.kpis?.length ? h('KPIs') + ul(d.kpis) : '') + (d.notes ? h('Notes / หมายเหตุ') + para(d.notes) : ''));
    }
  }
}
