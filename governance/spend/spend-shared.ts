/**
 * SPEND-1 pure helpers shared by the meter (budget.ts) and the spend module (spend.ts): the one money maximum, the rollup allowlists
 * (Gate 1 S10, SP-06) and the local-month arithmetic. No imports from either, so there is no cycle.
 */
export { SPEND_MAX_USD } from '../../config/schema.js';

const DEPT = /^[a-z_]{1,32}$/;
const TOOL = /^[a-z0-9_]{1,40}$/;
const PROVIDER = /^[a-z0-9._:-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const MODEL = /^[\x21-\x7e]{1,128}$/;

/** A department id that fits the column, else `_unattributed` (which has no department cap). */
export const cleanDept = (d: string | undefined | null): string => (typeof d === 'string' && DEPT.test(d) ? d : '_unattributed');
export const cleanTool = (t: string | undefined | null): string => (typeof t === 'string' && TOOL.test(t) ? t : t === undefined || t === null ? 'llm' : 'other');
export const cleanProvider = (p: string | undefined | null): string => (typeof p === 'string' && PROVIDER.test(p) ? p : 'unknown');
export const cleanModel = (m: string | undefined | null): string => (typeof m === 'string' && MODEL.test(m) ? m : '');

/** `2026-11-17` -> `2026-11-01`: the key of a department month. */
export const monthStart = (localDate: string): string => `${localDate.slice(0, 7)}-01`;
