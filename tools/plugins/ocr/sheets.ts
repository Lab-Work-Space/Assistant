import { z } from 'zod';
import { safeFetch, SafeFetchError, type Resolver, type Transport } from '../../../net/guard.js';
import { toolError, type ToolPlugin } from '../../types.js';
import { sheetRow } from './csv.js';

/** P4: the only Apps Script web-app shape accepted, from env only (never from a model, message or file). */
export const SHEETS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
export type SheetsConfig = { url: string; secret: string };
export type SheetsDeps = { resolver: Resolver; transport: Transport; extraPorts?: () => number[] };

const WORKSHEET = 'Sheet1';
const TIMEOUT_MS = 30_000;
const RESPONSE_MAX = 64 * 1024;
const OUTPUT_HOST = 'script.googleusercontent.com';

/** Fixed text only: nothing from the response, the url or the secret is ever quoted. */
export class SheetsError extends Error {
  override readonly name = 'SheetsError';
}

export const sheetsConfigured = (c: SheetsConfig | undefined): c is SheetsConfig => !!c && c.secret !== '' && SHEETS_URL_RE.test(c.url);

/** Step 0 (Google docs, "Content service > Redirects"): output of a web app is redirected to a one-time script.googleusercontent.com URL after doPost has run. */
function isOutputRedirect(location: string | undefined): boolean {
  if (!location) return false;
  try {
    const u = new URL(location);
    return u.protocol === 'https:' && u.hostname === OUTPUT_HOST && !u.username && !u.password && u.port === '';
  } catch {
    return false;
  }
}

/**
 * Appends rows through the Apps Script web app (old bot contract: POST JSON {secret, worksheet, rows}). The secret is in the body only.
 * safeFetch does not follow a POST redirect, and nothing follows it here: a 302 to script.googleusercontent.com means doPost ran, and
 * a follow-up GET would carry no benefit (the one-time URL holds only the reply). Any other non-2xx is an error. Because the reply is
 * not read, an application-level rejection by the script (for example a wrong secret) cannot be seen on that path.
 */
export async function appendRows(d: SheetsDeps, c: SheetsConfig, rows: (string | number)[][]): Promise<void> {
  const fail = () => new SheetsError('Google Sheets did not accept the row.');
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(c.url, {
      resolver: d.resolver, transport: d.transport, ...(d.extraPorts ? { extraPorts: d.extraPorts() } : {}), method: 'POST', maxRedirects: 0,
      timeoutMs: TIMEOUT_MS, maxBytes: RESPONSE_MAX, headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ secret: c.secret, worksheet: WORKSHEET, rows }),
    });
  } catch (err) {
    throw new SheetsError(err instanceof SafeFetchError && err.code === 'blocked' ? 'Google Sheets was not contacted (the address was refused).' : 'Google Sheets could not be reached.');
  }
  if (res.status === 302 && isOutputRedirect(res.headers.location)) return;
  if (res.status < 200 || res.status > 299) throw fail();
  try {
    const data: unknown = JSON.parse(res.body.toString('utf8'));
    if (typeof data !== 'object' || data === null || 'error' in data) throw fail();
  } catch {
    throw fail();
  }
}

const num = z.number().finite();
const Row = z.strictObject({
  date: z.string().max(40), merchant: z.string().max(200), currency: z.string().max(10),
  subtotal: num.optional(), tax: num.optional(), total: num,
});
type RowInput = z.infer<typeof Row>;
export const SENT_NOTE = 'Sent to Google Sheets (the web app accepted the request; a rejection by the script is not visible here).';

/**
 * `sheets_append_receipt` (Task 33): appends ONE row to the configured sheet. Kind write, so the central policy (P2) asks approval
 * for a delegated, voice, scheduled or tainted run (a run that just read a receipt is tainted). The approval card and the stored
 * call hold the whole row (the merchant is shown to the approver; P19 only forbids logging and auditing receipt contents), so a
 * replay needs no attachment and no model call. String cells are formula-guarded before sending.
 */
export function sheetsAppendTool(d: SheetsDeps, c: SheetsConfig): ToolPlugin<RowInput> {
  return {
    name: 'sheets_append_receipt',
    description: 'Append one receipt row (date, merchant, currency, subtotal, tax, total) to the configured Google Sheet. Use the values extract_receipt returned. Needs approval unless a person asks directly and nothing untrusted was read.',
    kind: 'write',
    inputSchema: Row,
    summary: (i) => ({ target: 'Google Sheets', change: `append row: ${i.date} | ${i.merchant} | ${i.currency} | subtotal ${i.subtotal ?? '-'} | tax ${i.tax ?? '-'} | total ${i.total}` }),
    requiresApproval: () => false, // the central write policy decides
    async run(input) {
      try {
        await appendRows(d, c, [sheetRow(input)]);
        return { content: SENT_NOTE };
      } catch (err) {
        return toolError(err instanceof SheetsError ? err.message : 'Google Sheets export failed.');
      }
    },
  };
}
