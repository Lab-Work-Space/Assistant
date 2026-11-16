import type { Receipt } from './receipt.js';

/**
 * Spreadsheet formula starters (OWASP CSV injection): `= + - @`, their full-width forms, the same after leading white space
 * (including the ideographic space), and a leading tab, CR or LF. Applied to string cells only.
 */
const FORMULA_START = /^[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/;

/** P19: a string cell that could run as a formula is stored as text with a leading `'` (CSV and Sheets). Numbers are not strings and stay as they are. */
export const guardCell = (s: string): string => (FORMULA_START.test(s) ? `'${s}` : s);

/** RFC 4180: a field holding a comma, quote, CR or LF is quoted and its quotes are doubled. */
export const field = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const num = (n: number | undefined): string => (n === undefined ? '' : String(n));

/** UTF-8 BOM (so Excel reads Thai), header, one row per line item, then Subtotal, Tax and Total rows; CRLF line ends. */
export function toCsv(r: Receipt): string {
  const head = ['date', 'merchant', 'currency', 'item', 'qty', 'unit_price', 'line_total'];
  const row = (item: string, qty: string, unit: string, total: string) => [guardCell(r.date), guardCell(r.merchant), guardCell(r.currency), guardCell(item), qty, unit, total];
  const rows = [
    head,
    ...r.items.map((i) => row(i.name, num(i.qty), num(i.unitPrice), num(i.total))),
    ...(r.subtotal !== undefined ? [row('Subtotal', '', '', num(r.subtotal))] : []),
    ...(r.tax !== undefined ? [row('Tax', '', '', num(r.tax))] : []),
    row('Total', '', '', num(r.total)),
  ];
  return `﻿${rows.map((cells) => cells.map(field).join(',')).join('\r\n')}\r\n`;
}

/** The one Sheets row for a receipt: date, merchant, currency, subtotal, tax, total (empty when absent). */
export const sheetRow = (r: Pick<Receipt, 'date' | 'merchant' | 'currency' | 'subtotal' | 'tax' | 'total'>): (string | number)[] => [guardCell(r.date), guardCell(r.merchant), guardCell(r.currency), r.subtotal ?? '', r.tax ?? '', r.total];
