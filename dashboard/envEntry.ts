import { redactText } from '../core/logger.js';
import type { AuditFn } from '../governance/audit.js';
import { ENV_KEY_NAMES, EnvWriter, isEnvKey, keyGroup, type EnvGroup, type EnvPaths, type Reason } from './envfile.js';

/** What the route sees. No value ever comes back through it (E16). */
export interface EnvEntry {
  /** Presence only; null when the env file fails its safety checks. */
  status(): Promise<{ key: string; group: EnvGroup; set: boolean }[] | null>;
  set(userId: string, key: string, value: string): Promise<EnvOutcome>;
  clear(userId: string, key: string): Promise<EnvOutcome>;
}
export type EnvOutcome = { ok: true } | { ok: false; reason: 'rate' | 'refused' };

export interface EnvEntryOptions {
  paths: EnvPaths;
  audit: AuditFn;
  /** E18: key name and admin only; posted to #bot-log. A failure never fails the write. */
  notify(text: string): Promise<void>;
  log: { error(o: unknown, m?: string): void };
  now?: () => number;
  /** Test seam for the writer (e.g. one that throws an error carrying the value). */
  writer?: Pick<EnvWriter, 'status' | 'set' | 'clear'>;
}

export const PER_ADMIN_HOUR = 10;
export const SERVER_HOUR = 30;
const HOUR = 3_600_000;

/** E15, E18: rate limit, audit and notice around the writer. */
export function createEnvEntry(o: EnvEntryOptions): EnvEntry {
  const writer = o.writer ?? new EnvWriter(o.paths, o.now);
  const now = o.now ?? Date.now;
  const perAdmin = new Map<string, number[]>();
  let all: number[] = [];

  /** Counts every attempt (successes and failures) before the value is looked at. */
  const allow = (userId: string): boolean => {
    const t = now();
    all = all.filter((x) => t - x < HOUR);
    const mine = (perAdmin.get(userId) ?? []).filter((x) => t - x < HOUR);
    if (mine.length >= PER_ADMIN_HOUR || all.length >= SERVER_HOUR) { perAdmin.set(userId, mine); return false; }
    mine.push(t); all.push(t); perAdmin.set(userId, mine);
    return true;
  };

  const run = async (action: 'env.set' | 'env.clear', userId: string, key: string, value: string | null): Promise<EnvOutcome> => {
    const actor = `user:${userId} via dashboard`;
    // The submitted key name is user typed and could be a pasted secret: only an allowlisted name is ever audited.
    const known = isEnvKey(key);
    const refuse = async (code: 'rate' | Reason): Promise<EnvOutcome> => {
      await o.audit({ actor, action, ...(known ? { tool: key } : {}), outcome: `refused:${code}` });
      return { ok: false, reason: code === 'rate' ? 'rate' : 'refused' };
    };
    if (!allow(userId)) return refuse('rate');
    if (!known) return refuse('key');
    let r: Awaited<ReturnType<EnvWriter['set']>>;
    try {
      r = value === null ? await writer.clear(key) : await writer.set(key, value);
    } catch (err) {
      // E17: nothing that can carry the value is logged; the name only, masked anyway.
      o.log.error({ err: redactText(err instanceof Error ? err.name : 'error', value ? [value] : []) }, 'env write failed');
      return refuse('io');
    }
    value = null; // best effort: drop our copy
    if (!r.ok) return refuse(r.reason);
    await o.audit({ actor, action, tool: key, outcome: 'ok' });
    await o.notify(`env key ${key} was ${action === 'env.set' ? 'changed' : 'cleared'} by <@${userId}>; restart required`).catch(() => o.log.error({ key }, 'env notice failed'));
    return { ok: true };
  };

  return {
    async status() {
      const s = await writer.status();
      return s ? ENV_KEY_NAMES.map((key) => ({ key, group: keyGroup(key)!, set: s[key] === true })) : null;
    },
    set: (u, k, v) => run('env.set', u, k, v),
    clear: (u, k) => run('env.clear', u, k, null),
  };
}
