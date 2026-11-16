import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import type { Pool } from '../db/pool.js';
import type { ExecRepo } from '../db/repos/exec.js';
import type { AuditFn } from '../governance/audit.js';
import { welcomeRoleProblem, type ServerConsts } from '../discord/server/server-limits.js';
import type { ServerWorld, ServerWriter } from '../discord/server/server-world.js';

export interface WelcomeCfg {
  enabled: boolean;
  roleIds: string[];
  message: string;
  channelId: string | null;
  raidPerMinute: number;
}

const KEYS = ['welcome.enabled', 'welcome.roleIds', 'welcome.message', 'welcome.channelId', 'welcome.raidPerMinute'] as const;

/** Reads the welcome keys straight from the config table (the executor has no ConfigStore); an invalid stored value falls back to its default. */
export async function readWelcomeConfig(pool: Pool): Promise<WelcomeCfg> {
  const rows = await pool.query<{ key: string; value: unknown }>('SELECT key, value FROM config WHERE key = ANY($1::text[])', [[...KEYS]]);
  const raw = new Map(rows.rows.map((r) => [r.key, r.value]));
  const pick = <K extends (typeof KEYS)[number]>(k: K): ReturnType<(typeof ConfigSchema)[K]['parse']> => {
    const v = raw.has(k) ? ConfigSchema[k].safeParse(raw.get(k)) : null;
    return (v?.success ? v.data : CONFIG_DEFAULTS[k]) as never;
  };
  return { enabled: pick('welcome.enabled'), roleIds: pick('welcome.roleIds'), message: pick('welcome.message'), channelId: pick('welcome.channelId'), raidPerMinute: pick('welcome.raidPerMinute') };
}

export interface WelcomeDeps {
  exec: ExecRepo;
  world: ServerWorld;
  writer: Pick<ServerWriter, 'addRole'>;
  consts: () => ServerConsts;
  cfg: () => Promise<WelcomeCfg>;
  audit: AuditFn;
  now?: () => number;
  log: { error(o: unknown, m?: string): void };
}

export const PAUSE_KEY = 'welcome.paused';
const WINDOW_MS = 60_000;

/**
 * The automatic welcome (spec "Automatic flows", Gate 1 S11-S14), run by the executor on GuildMemberAdd. Order matters:
 * 1. every join counts for the raid window, bots included; above the limit both the default roles and the welcome post pause until a
 *    confirmed card resumes them (the flag is in the database, so a restart does not end it);
 * 2. a joining bot gets nothing; 3. a user id is welcomed once per 24 h; 4. each default role is re-checked against live data on every join
 *    (a role edited to carry power after config is NOT assigned: the flow pauses and alerts instead);
 * 5. the post itself is the main application's job: the executor only queues it (it has no Send Messages).
 */
export function createWelcome(d: WelcomeDeps) {
  const joins: number[] = [];
  const now = d.now ?? Date.now;
  const alert = (title: string, text: string) => d.exec.push('alert', { title, text }).catch((err: unknown) => d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'welcome alert failed'));
  const pause = async (reason: string, title: string, text: string) => {
    await d.exec.setState(PAUSE_KEY, { since: new Date(now()).toISOString(), reason });
    await alert(title, text);
  };
  return {
    async onJoin(m: { id: string; isBot: boolean }): Promise<void> {
      try {
        const t = now();
        joins.push(t);
        while (joins.length && joins[0]! < t - WINDOW_MS) joins.shift();
        if ((await d.exec.getState(PAUSE_KEY)) !== null) return;
        const cfg = await d.cfg();
        if (joins.length > cfg.raidPerMinute) {
          await d.audit({ actor: 'system:executor', action: 'welcome.raid', tool: 'welcome', outcome: `paused joins=${joins.length} limit=${cfg.raidPerMinute}` });
          await pause('raid', 'Welcome paused: join rate', `${joins.length} members joined within a minute (limit ${cfg.raidPerMinute}). Default roles and welcome posts are paused until a Bot Admin confirms \`welcome.resume\`.`);
          return;
        }
        if (m.isBot || !cfg.enabled) return;
        if (!(await d.exec.firstWelcome(m.id))) return;
        for (const roleId of cfg.roleIds) {
          const why = await welcomeRoleProblem(roleId, d.world, d.consts());
          if (why) {
            await d.audit({ actor: 'system:executor', action: 'welcome.role', tool: `${m.id}:${roleId}`, outcome: `refused ${why}`.slice(0, 190) });
            await pause('role', 'Welcome default role refused', `Default role ${roleId} can no longer be assigned: ${why}. Auto-roles and welcome posts are paused until a Bot Admin fixes the role and confirms \`welcome.resume\`.`);
            return;
          }
        }
        for (const roleId of cfg.roleIds) {
          try {
            await d.writer.addRole(m.id, roleId, 'Praw welcome: default role');
            await d.audit({ actor: 'system:executor', action: 'welcome.role', tool: `${m.id}:${roleId}`, outcome: 'ok' });
          } catch (e) {
            const code = (e as { code?: unknown }).code;
            await d.audit({ actor: 'system:executor', action: 'welcome.role', tool: `${m.id}:${roleId}`, outcome: `failed ${typeof code === 'number' ? `Discord error ${code}` : 'error'}` });
          }
        }
        await d.exec.push('welcome.post', { userId: m.id });
      } catch (err) {
        d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'welcome handler failed');
      }
    },
  };
}
