import { redactText } from '../core/logger.js';
import { IMAGE_ID } from '../workspaces/runner.js';
import type { McpClass } from '../db/repos/mcp.js';
import type { AdminCode } from './errors.js';
import { SLUG } from './names.js';
import { hasHidden } from './screen.js';
import { screenText } from '../knowledge/screen.js';

/** Spec 5.4: the fields of `/mcp add`, validated at the boundary (and again by the sandbox for the parts that reach the argv). */
export type Parsed<T, C extends AdminCode = AdminCode> = { ok: true; value: T } | { ok: false; code: C };
const ok = <T>(value: T): Parsed<T, never> => ({ ok: true, value });
const no = <C extends AdminCode>(code: C): Parsed<never, C> => ({ ok: false, code });

export const COMMAND_ITEM = /^[A-Za-z0-9._/:=@+,-]{1,200}$/;
export const ENV_KEY = /^[A-Z][A-Z0-9_]{0,31}$/;
export const ENV_VALUE = /^[A-Za-z0-9._:/@+=,-]{0,200}$/;
const ENV_DENY = /^(?:PATH|HOME|USER|SHELL|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY)$/;
const ENV_DENY_PREFIX = /^(?:LD_|DYLD_|DOCKER_)/;
const ENV_DENY_WORD = /TOKEN|SECRET|PASSW|API_KEY|PRIVATE|CREDENTIAL|AUTH/;
const REF = /^[A-Za-z0-9._/:@-]{1,200}$/;
const DEPT = /^[a-z_]{1,32}$/;

export const parseSlug = (s: string): Parsed<string> => (SLUG.test(s) ? ok(s) : no('E_SLUG'));
export const parseImage = (s: string): Parsed<string> => (IMAGE_ID.test(s) ? ok(s) : no('E_IMAGE'));
export const parseClass = (s: string | undefined): Parsed<McpClass> => (s === undefined ? ok('write') : s === 'read' || s === 'write' ? ok(s) : no('E_CLASS'));

export function parseCommand(s: string | undefined): Parsed<string[]> {
  if (s === undefined) return ok([]);
  if (s.length > 1000) return no('E_COMMAND');
  let v: unknown;
  try { v = JSON.parse(s); } catch { return no('E_COMMAND'); }
  if (!Array.isArray(v) || v.length > 16) return no('E_COMMAND');
  for (const x of v) if (typeof x !== 'string' || !COMMAND_ITEM.test(x)) return no('E_COMMAND');
  return ok(v as string[]);
}

/** `K=V;K=V`. The key rules and both deny lists apply to every pair; a duplicate key, an empty pair and a value the redactor would change are refused. */
export function parseEnv(s: string | undefined, secrets: readonly string[]): Parsed<Record<string, string>> {
  if (s === undefined || s === '') return ok({});
  const pairs = s.split(';');
  if (pairs.length > 16) return no('E_ENV');
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) return no('E_ENV');
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (!ENV_KEY.test(k) || ENV_DENY.test(k) || ENV_DENY_PREFIX.test(k) || ENV_DENY_WORD.test(k) || seen.has(k)) return no('E_ENV');
    if (!ENV_VALUE.test(v) || redactText(v, secrets) !== v) return no('E_ENV');
    seen.add(k);
    out[k] = v;
  }
  return ok(out);
}

export function parseDepartments(csv: string, exists: (id: string) => boolean): Parsed<string[]> {
  const ids = [...new Set(csv.split(',').map((x) => x.trim()))];
  if (ids.length < 1 || ids.length > 10) return no('E_DEPT');
  for (const d of ids) if (!DEPT.test(d) || !exists(d)) return no('E_DEPT');
  return ok(ids);
}

export function parseTitle(s: string): Parsed<string> {
  if (hasHidden(s)) return no('E_SCREEN');
  const r = screenText(s, { max: 80, multiline: false, pii: false });
  return r.ok ? ok(r.text) : no('E_SCREEN');
}

export const parseRef = (s: string | undefined): Parsed<string | null> => (s === undefined ? ok(null) : REF.test(s) ? ok(s) : no('E_FIELD'));

export function parseNumbers(o: { timeout?: number; daily?: number }): Parsed<{ timeoutMs: number; maxCallsPerDay: number }> {
  const t = o.timeout ?? 60;
  const d = o.daily ?? 100;
  if (!Number.isInteger(t) || t < 5 || t > 120 || !Number.isInteger(d) || d < 1 || d > 1000) return no('E_FIELD');
  return ok({ timeoutMs: t * 1000, maxCallsPerDay: d });
}
