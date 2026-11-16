import type { DutyId } from '../../../company/duties.js';

/**
 * RF22 / OD-4: the kind -> duty table is code-owned. `any_head` (coordination documents: meeting minutes, plans, slide decks, reports) may be made by any department
 * head; every other kind needs the department to hold one of the listed duties in the live `duties.byDept` table. The spec's owner column (for example
 * software, it and rnd for specs) is a default of that table, not a second source of truth: `spec` and `technical_design` accept engineering,
 * infrastructure or research, because DEFAULT_DUTIES gives `engineering` only to software.
 */
export const DOC_KINDS = [
  'purchase_request', 'purchase_order', 'quotation', 'proposal', 'invoice_receipt', 'tax_invoice', 'withholding_tax_cert', 'expense_report',
  'job_description', 'offer_letter', 'meeting_minutes', 'plan', 'slides', 'report', 'spec', 'technical_design', 'marketing_brief',
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export type KindInfo = {
  /** Duties of which the department must hold at least one, or any department head. */
  duties: readonly DutyId[] | 'any_head';
  /** Money or tax document: amounts computed in code, company.profile required, DRAFT watermark, always approval (RF18, RF19, RF21). */
  money: boolean;
  /** HR offer: DRAFT watermark and always approval, company.profile required (RF19, RF21). */
  offer: boolean;
  /** HR, money and tax files post only in the owning department's own room or task thread (RF21). */
  restrictedAudience: boolean;
  /** Rows to put in a CSV beside the PDF. */
  tabular: boolean;
  title: string;
};

const K = (duties: KindInfo['duties'], title: string, f: Partial<Omit<KindInfo, 'duties' | 'title'>> = {}): KindInfo => ({
  duties, title, money: false, offer: false, restrictedAudience: false, tabular: false, ...f,
});
const M = { money: true, restrictedAudience: true } as const;

export const KIND_INFO: Readonly<Record<DocKind, KindInfo>> = {
  purchase_request: K(['operations'], 'Purchase request (ใบขอซื้อ)', { ...M, tabular: true }),
  purchase_order: K(['finance'], 'Purchase order (ใบสั่งซื้อ)', { ...M, tabular: true }),
  quotation: K(['sales'], 'Quotation (ใบเสนอราคา)', { ...M, tabular: true }),
  proposal: K(['sales', 'strategy'], 'Proposal (ข้อเสนอ)'),
  invoice_receipt: K(['finance'], 'Invoice / receipt (ใบแจ้งหนี้ / ใบเสร็จรับเงิน)', { ...M, tabular: true }),
  tax_invoice: K(['finance'], 'Tax invoice (ใบกำกับภาษี)', { ...M, tabular: true }),
  withholding_tax_cert: K(['finance'], 'Withholding tax certificate (หนังสือรับรองการหักภาษี ณ ที่จ่าย, 50 ทวิ)', M),
  expense_report: K(['finance'], 'Expense report (รายงานค่าใช้จ่าย)', { ...M, tabular: true }),
  job_description: K(['people'], 'Job description (รายละเอียดตำแหน่งงาน)', { restrictedAudience: true }),
  offer_letter: K(['people'], 'Offer letter (หนังสือเสนองาน)', { offer: true, restrictedAudience: true }),
  meeting_minutes: K('any_head', 'Meeting minutes (รายงานการประชุม)'),
  plan: K('any_head', 'Plan (แผนงาน)'),
  slides: K('any_head', 'Slide deck (ชุดสไลด์)'),
  report: K('any_head', 'Report (รายงาน)'),
  spec: K(['engineering', 'infrastructure', 'research'], 'Specification (เอกสารข้อกำหนด)'),
  technical_design: K(['engineering', 'infrastructure', 'research'], 'Technical design (เอกสารออกแบบเชิงเทคนิค)'),
  marketing_brief: K(['marketing'], 'Marketing brief (บรีฟการตลาด)'),
};

export const isMoneyKind = (k: DocKind): boolean => KIND_INFO[k].money;
/** The DRAFT watermark and the always-ask approval apply to money, tax and HR-offer kinds. */
export const isDraftKind = (k: DocKind): boolean => KIND_INFO[k].money || KIND_INFO[k].offer;
/** The legal company details are printed, so company.profile must be set. */
export const needsProfile = isDraftKind;

/** The fixed watermark text of RF19 (part of the template; no data can reach it). */
export const WATERMARK_TEXT = 'DRAFT — ต้องตรวจสอบก่อนใช้';
