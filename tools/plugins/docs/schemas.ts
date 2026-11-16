import { z } from 'zod';
import { isCalendarDate } from '../../../config/schema.js';
import { DECK_DIAGRAMS, DIAGRAM_ID } from './diagram.js';
import { type DocKind } from './kinds.js';
import { Baht, computeTotals, MAX_LINES, MoneyError, Qty, WhtRateSchema } from './money.js';

/**
 * RF17 / RF18 / RF19: the per-kind input of `doc_create`. Every schema is strict (an unknown key, such as a `total`, `subtotal` or `documentNumber`, is
 * refused), strings are length-bounded plain text without control characters, numbers are validated by money.ts, and there is no document-number,
 * legal-series, signature or stamp field anywhere. Nothing here transforms the input (the registry stores the validated value and parses it again at an approved replay).
 */

export const DATA_MAX_BYTES = 64 * 1024;
export const LIST_MAX = 50;

const NO_CONTROL = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/; // tab, LF and CR are allowed (multi-line text)
// G2-RFMD-P3 D-01: bidi embedding/override/isolate controls would let the PDF show text in a different order than the approval card (which strips them).
// Zero-width space (U+200B) stays allowed: Thai text uses it for word breaks.
const NO_BIDI = /^[^‪-‮⁦-⁩]*$/;
const text = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL, 'no control characters').regex(NO_BIDI, 'no bidirectional control characters');
const longText = text(4000);
const line = text(300);
const list = (item: z.ZodType<string> = line, max = LIST_MAX) => z.array(item).min(1).max(max);
const date = z.string().refine(isCalendarDate, 'must be a date written YYYY-MM-DD');

const Party = z.strictObject({
  name: text(200),
  address: text(400).optional(),
  /** A counterparty tax ID is data from the request; digits only. The Thai checksum is not required (foreign parties). */
  taxId: z.string().regex(/^\d{10,13}$/, 'digits only, 10 to 13').optional(),
  phone: z.string().regex(/^[0-9+\-() ]{3,30}$/, 'digits, + - ( ) and spaces only').optional(),
  email: z.string().max(100).regex(/^[^\s@<>"']+@[^\s@<>"']+$/, 'not an email address').optional(),
});
export type Party = z.infer<typeof Party>;

const Item = z.strictObject({
  description: text(300),
  qty: Qty,
  unit: text(20).optional(),
  unitPrice: Baht,
});

const items = z.array(Item).min(1).max(MAX_LINES);

/** The common money part: lines, VAT switch, discount (an explicit field), notes. The arithmetic is checked here too, so a bad total never reaches a card. */
const withTotals = <T extends z.ZodType<{ lines: z.infer<typeof Item>[]; vat?: boolean; discount?: number; whtRate?: 1 | 2 | 3 | 5 | 10 | 15 }>>(s: T): T =>
  s.superRefine((v, ctx) => {
    const x = v as { lines: z.infer<typeof Item>[]; vat?: boolean; discount?: number; whtRate?: 1 | 2 | 3 | 5 | 10 | 15 };
    try {
      computeTotals({ lines: x.lines, vat: x.vat ?? false, discount: x.discount, whtRate: x.whtRate });
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof MoneyError ? e.message : 'invalid amounts' });
    }
  }) as unknown as T;

const section = z.strictObject({ heading: text(120), body: longText.optional(), bullets: z.array(line).max(LIST_MAX).optional() });

const purchase_request = withTotals(z.strictObject({
  requester: text(120), department: text(80).optional(), neededBy: date.optional(), reason: longText,
  lines: items, vat: z.boolean().optional(), discount: Baht.optional(), notes: longText.optional(),
}));
const purchase_order = withTotals(z.strictObject({
  supplier: Party, orderDate: date, deliveryDate: date.optional(), deliveryAddress: text(400).optional(), paymentTerms: text(200).optional(),
  lines: items, vat: z.boolean().optional(), discount: Baht.optional(), whtRate: WhtRateSchema.optional(), notes: longText.optional(),
}));
const quotation = withTotals(z.strictObject({
  customer: Party, quoteDate: date, validUntil: date.optional(), paymentTerms: text(200).optional(),
  lines: items, vat: z.boolean().optional(), discount: Baht.optional(), notes: longText.optional(),
}));
const proposal = z.strictObject({
  title: text(200), client: Party.optional(), summary: longText, sections: z.array(section).min(1).max(LIST_MAX), nextSteps: z.array(line).max(LIST_MAX).optional(),
});
const invoice_receipt = withTotals(z.strictObject({
  mode: z.enum(['invoice', 'receipt']), customer: Party, issueDate: date, dueDate: date.optional(), paymentMethod: text(100).optional(),
  lines: items, vat: z.boolean().optional(), discount: Baht.optional(), whtRate: WhtRateSchema.optional(), notes: longText.optional(),
}));
const tax_invoice = withTotals(z.strictObject({
  customer: Party, issueDate: date, lines: items, vat: z.literal(true).describe('A tax invoice always carries VAT 7%: must be true'), discount: Baht.optional(), notes: longText.optional(),
}));
export const INCOME_TYPES = ['40_1', '40_2', '40_3', '40_4a', '40_4b', '40_5', '40_6', '40_7', '40_8'] as const;
const withholding_tax_cert = z.strictObject({
  payee: Party.extend({ taxId: z.string().regex(/^\d{13}$/, 'the payee tax ID is 13 digits') }),
  paymentDate: date, incomeType: z.enum(INCOME_TYPES).describe('Section of the Revenue Code: 40_1 salary ... 40_8 other'),
  amountPaid: Baht, whtRate: WhtRateSchema, notes: longText.optional(),
});
const expense_report = z.strictObject({
  employee: text(120), department: text(80).optional(), periodStart: date, periodEnd: date, purpose: longText.optional(),
  expenses: z.array(z.strictObject({ date, category: text(60), description: text(300), amount: Baht })).min(1).max(MAX_LINES), notes: longText.optional(),
}).superRefine((v, ctx) => {
  if (v.periodEnd < v.periodStart) ctx.addIssue({ code: 'custom', message: 'periodEnd is before periodStart' });
  const sum = v.expenses.reduce((s, e) => s + Math.round(e.amount * 100), 0);
  if (!Number.isSafeInteger(sum)) ctx.addIssue({ code: 'custom', message: 'the total is too large' });
});
const job_description = z.strictObject({
  jobTitle: text(120), department: text(80), reportsTo: text(120).optional(), location: text(120).optional(),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']), summary: longText,
  responsibilities: list(), requirements: list(), benefits: z.array(line).max(LIST_MAX).optional(),
});
const offer_letter = z.strictObject({
  candidate: text(120), position: text(120), department: text(80), reportsTo: text(120).optional(), startDate: date,
  monthlySalary: Baht, probationDays: z.number().int().min(0).max(365).refine((n) => !Object.is(n, -0), 'must not be -0').optional(), benefits: z.array(line).max(LIST_MAX).optional(), notes: longText.optional(),
});
const meeting_minutes = z.strictObject({
  title: text(200), date, location: text(120).optional(), attendees: list(text(120)), agenda: list(),
  discussion: longText.optional(), decisions: z.array(line).max(LIST_MAX).optional(),
  actions: z.array(z.strictObject({ owner: text(120), task: line, due: date.optional() })).max(LIST_MAX).optional(),
});
/** RFMD P4 / RF27: a diagram id is made by code (`dg-` and 8 hex digits) and resolves only inside the task tree that made it (the tool checks that). */
const diagramId = z.string().regex(DIAGRAM_ID, 'a diagram id looks like dg-0a1b2c3d (the id diagram_create returned)');
const diagramRefs = (sections: { diagramId?: string | undefined }[], ctx: z.RefinementCtx): void => {
  const n = sections.filter((x) => x.diagramId).length;
  if (n > DECK_DIAGRAMS) ctx.addIssue({ code: 'custom', path: ['sections'], message: `at most ${DECK_DIAGRAMS} diagrams per document` });
};
const planSection = section.extend({ diagramId: diagramId.optional() });
const plan = z.strictObject({
  title: text(200), objective: longText, sections: z.array(planSection).min(1).max(LIST_MAX),
  milestones: z.array(z.strictObject({ name: line, date: date.optional(), owner: text(120).optional() })).max(LIST_MAX).optional(),
}).superRefine((v, ctx) => diagramRefs(v.sections, ctx));
/** One slide per section after the title slide: at most 25 sections keeps the deck under the 30-page cap. Text is bounded so a slide does not overflow. */
export const DECK_SECTIONS_MAX = 25;
const slides = z.strictObject({
  title: text(200), subtitle: text(200).optional(),
  sections: z.array(z.strictObject({ heading: text(120), body: text(500).optional(), bullets: z.array(text(160)).min(1).max(7).optional(), diagramId: diagramId.optional() })).min(1).max(DECK_SECTIONS_MAX),
}).superRefine((v, ctx) => diagramRefs(v.sections, ctx));
const report = z.strictObject({
  title: text(200), period: text(80).optional(), summary: longText, sections: z.array(section).min(1).max(LIST_MAX), conclusions: z.array(line).max(LIST_MAX).optional(),
});
const spec = z.strictObject({
  title: text(200), version: text(30).optional(), overview: longText, goals: list(), nonGoals: z.array(line).max(LIST_MAX).optional(),
  sections: z.array(section).min(1).max(LIST_MAX), openQuestions: z.array(line).max(LIST_MAX).optional(),
});
const marketing_brief = z.strictObject({
  campaign: text(200), objective: longText, audience: longText, keyMessages: list(), channels: list(text(80)),
  timeline: z.array(z.strictObject({ label: line, date: date.optional() })).max(LIST_MAX).optional(), kpis: z.array(line).max(LIST_MAX).optional(), notes: longText.optional(),
});

export const KIND_SCHEMAS = {
  purchase_request, purchase_order, quotation, proposal, invoice_receipt, tax_invoice, withholding_tax_cert, expense_report,
  job_description, offer_letter, meeting_minutes, plan, slides, report, spec, technical_design: spec, marketing_brief,
} as const satisfies Record<DocKind, z.ZodType>;

export type DocData = {
  [K in DocKind]: z.infer<(typeof KIND_SCHEMAS)[K]>;
};

/**
 * RF17: `data` travels as the JSON TEXT of the object (a model-facing object parameter with no declared properties is rejected by Gemini, and one bad
 * declaration fails the whole request). The text is at most 64 KB (bytes) before it is parsed; it must parse to a plain object.
 */
export function dataSizeProblem(data: unknown): string | null {
  if (typeof data !== 'string') return 'data must be the JSON text of an object';
  return Buffer.byteLength(data, 'utf8') > DATA_MAX_BYTES ? `data is at most ${DATA_MAX_BYTES} bytes` : null;
}

/** Parses the `data` text to a plain object (not an array or a scalar); null when it is not valid JSON of that shape. */
export function parseDataText(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A one-line guide per kind for the tool description (code-built, never from config or the model). */
export const KIND_FIELD_HINTS: Readonly<Record<DocKind, string>> = {
  purchase_request: '{requester, department?, neededBy?, reason, lines:[{description, qty, unit?, unitPrice}], vat?, discount?, notes?}',
  purchase_order: '{supplier:{name, address?, taxId?, phone?, email?}, orderDate, deliveryDate?, deliveryAddress?, paymentTerms?, lines, vat?, discount?, whtRate?, notes?}',
  quotation: '{customer:{name,...}, quoteDate, validUntil?, paymentTerms?, lines, vat?, discount?, notes?}',
  proposal: '{title, client?, summary, sections:[{heading, body?, bullets?}], nextSteps?}',
  invoice_receipt: '{mode:"invoice"|"receipt", customer:{name,...}, issueDate, dueDate?, paymentMethod?, lines, vat?, discount?, whtRate?, notes?}',
  tax_invoice: '{customer:{name,...}, issueDate, lines, vat:true, discount?, notes?}',
  withholding_tax_cert: '{payee:{name, taxId(13 digits), address?}, paymentDate, incomeType:"40_1".."40_8", amountPaid, whtRate:1|2|3|5|10|15, notes?}',
  expense_report: '{employee, department?, periodStart, periodEnd, purpose?, expenses:[{date, category, description, amount}], notes?}',
  job_description: '{jobTitle, department, reportsTo?, location?, employmentType:"full_time"|"part_time"|"contract"|"intern", summary, responsibilities[], requirements[], benefits?}',
  offer_letter: '{candidate, position, department, reportsTo?, startDate, monthlySalary, probationDays?, benefits?, notes?}',
  meeting_minutes: '{title, date, location?, attendees[], agenda[], discussion?, decisions?, actions?:[{owner, task, due?}]}',
  plan: '{title, objective, sections:[{heading, body?, bullets?, diagramId?}], milestones?:[{name, date?, owner?}]}  (diagramId: an id from diagram_create in this task)',
  slides: '{title, subtitle?, sections:[{heading, body?(500), bullets?(1-7 x 160), diagramId?}] (1-25; one slide each after the title slide)}  (landscape PDF; diagramId: an id from diagram_create in this task, at most 5)',
  report: '{title, period?, summary, sections:[{heading, body?, bullets?}], conclusions?}',
  spec: '{title, version?, overview, goals[], nonGoals?, sections:[{heading, body?, bullets?}], openQuestions?}',
  technical_design: 'same fields as spec',
  marketing_brief: '{campaign, objective, audience, keyMessages[], channels[], timeline?:[{label, date?}], kpis?, notes?}',
};
