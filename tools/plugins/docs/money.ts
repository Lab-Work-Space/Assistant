import { z } from 'zod';

/**
 * RF18: every amount of a business document is computed here, in integer satang (1 baht = 100 satang), never in floating point.
 *
 * Input amounts are baht numbers with at most 2 decimals; they are converted to satang once, after validation. Rounding is fixed:
 * VAT 7 % of the net amount (subtotal - discount), withholding tax rate % of the same net amount, and a line total (quantity x unit price)
 * are each rounded HALF UP to the satang. The model never supplies a total: the schemas are strict, so a `total` key is a validation error.
 */

export const MAX_BAHT = 1_000_000_000;
/** One line (quantity x price) may not exceed this many satang (10 billion baht); with 200 lines every sum stays below 2^53. */
export const MAX_LINE_SATANG = 1_000_000_000_000;
export const MAX_LINES = 200;
export const VAT_PERCENT = 7;
export const WHT_RATES = [1, 2, 3, 5, 10, 15] as const;
export type WhtRate = (typeof WHT_RATES)[number];

export class MoneyError extends Error {}

/** A baht amount: finite, not -0, 0..MAX_BAHT, at most 2 decimals (so 1e-9, 0.001, 1e21, 1e308, NaN and Infinity are all refused). */
export const isBaht = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && !Object.is(n, -0) && n >= 0 && n <= MAX_BAHT && Number(n.toFixed(2)) === n;
/** A quantity: finite, > 0, at most 1,000,000, at most 2 decimals. */
export const isQty = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1_000_000 && Number(n.toFixed(2)) === n;

export const Baht = z.number().refine(isBaht, 'must be a number from 0 to 1,000,000,000 with at most 2 decimals');
export const Qty = z.number().refine(isQty, 'must be a number above 0 and up to 1,000,000 with at most 2 decimals');
export const WhtRateSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(10), z.literal(15)]).describe('Withholding tax percent: 1, 2, 3, 5, 10 or 15');

/** Baht (validated, at most 2 decimals) to integer satang. */
export const toSatang = (baht: number): number => Math.round(baht * 100);

/** a * b / d rounded half up, for non-negative integers, exact (BigInt). */
export function mulDivHalfUp(a: number, b: number, d: number): number {
  const r = (BigInt(a) * BigInt(b) + BigInt(d) / 2n) / BigInt(d);
  if (r > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError('an amount is too large');
  return Number(r);
}

export type Line = { description: string; qty: number; unit?: string | undefined; unitPrice: number };
export type PricedLine = Line & { totalSatang: number; unitPriceSatang: number };

export type Totals = {
  lines: PricedLine[];
  subtotal: number;
  discount: number;
  net: number;
  vat: number;
  wht: number;
  whtRate: WhtRate | null;
  /** net + VAT - withholding tax. */
  payable: number;
};

export function priceLines(lines: readonly Line[]): PricedLine[] {
  if (lines.length > MAX_LINES) throw new MoneyError(`at most ${MAX_LINES} lines`);
  return lines.map((l) => {
    if (!isQty(l.qty) || !isBaht(l.unitPrice)) throw new MoneyError('a line has an invalid quantity or price');
    const unitPriceSatang = toSatang(l.unitPrice);
    const totalSatang = mulDivHalfUp(Math.round(l.qty * 100), unitPriceSatang, 100);
    if (totalSatang > MAX_LINE_SATANG) throw new MoneyError('a line total is too large');
    return { ...l, unitPriceSatang, totalSatang };
  });
}

export function computeTotals(o: { lines: readonly Line[]; vat: boolean; discount?: number | undefined; whtRate?: WhtRate | undefined }): Totals {
  const lines = priceLines(o.lines);
  const subtotal = lines.reduce((s, l) => s + l.totalSatang, 0);
  if (o.discount !== undefined && !isBaht(o.discount)) throw new MoneyError('the discount is invalid');
  const discount = o.discount === undefined ? 0 : toSatang(o.discount);
  if (discount > subtotal) throw new MoneyError('the discount is larger than the subtotal');
  const net = subtotal - discount;
  const vat = o.vat ? mulDivHalfUp(net, VAT_PERCENT, 100) : 0;
  if (o.whtRate !== undefined && !(WHT_RATES as readonly number[]).includes(o.whtRate)) throw new MoneyError('the withholding tax rate is not allowed');
  const wht = o.whtRate === undefined ? 0 : mulDivHalfUp(net, o.whtRate, 100);
  return { lines, subtotal, discount, net, vat, wht, whtRate: o.whtRate ?? null, payable: net + vat - wht };
}

/** Withholding certificate: tax withheld on a payment (rate % of the amount paid, half up). */
export function whtOn(paidBaht: number, rate: WhtRate): { paid: number; wht: number } {
  if (!isBaht(paidBaht)) throw new MoneyError('the amount is invalid');
  if (!(WHT_RATES as readonly number[]).includes(rate)) throw new MoneyError('the withholding tax rate is not allowed');
  const paid = toSatang(paidBaht);
  return { paid, wht: mulDivHalfUp(paid, rate, 100) };
}

/** 123456 satang -> "1,234.56" (pure integer arithmetic). */
export function fmtSatang(satang: number): string {
  if (!Number.isSafeInteger(satang) || satang < 0) throw new MoneyError('cannot format that amount');
  const baht = Math.floor(satang / 100);
  const frac = String(satang % 100).padStart(2, '0');
  return `${String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
/** Plain decimal for CSV: 123456 -> "1234.56". */
export const plainSatang = (satang: number): string => `${Math.floor(satang / 100)}.${String(satang % 100).padStart(2, '0')}`;
