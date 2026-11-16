import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { localDay } from '../company/calendar.js';
import type { ActorRef } from '../company/types.js';
import type { ConfigStore } from '../config/store.js';
import type { AppEvents, EventBus } from '../core/events.js';
import type { Pool } from '../db/pool.js';
import type { BudgetDay } from '../db/repos/ledger.js';
import { PROVIDER_ID } from '../providers/claude-code-local/protocol.js';
import { cleanDept, cleanModel, cleanProvider, cleanTool, monthStart } from './spend/spend-shared.js';

type Cfg = Pick<ConfigStore, 'get'>;
export type UsageRow = BudgetDay;
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
/**
 * 'price' = refused without touching any row: unknown model price or an invalid estimate (Gate 1 D4).
 * 'local' = the day's claude-code-local call count is used up; 'local_task' = the root tree's local call cap (Gate 1 L8).
 * 'warroom' = the separate daily pool of bot-origin warroom runs (TW4): `warroom.dailyUsd` and `warroom.localCallsPerDay`.
 * 'dept' = the department's monthly budget (SPEND-1): `spend.deptMonthlyUsd` or an approved override, keyed by the local month.
 * 'project' (AUTO-1) = the tree belongs to an active project and its USD or local call cap is used up. It replaces `task` and `local_task` for that tree and is never lifted.
 */
export type ReserveScope = 'company' | 'dept' | 'bot' | 'task' | 'local' | 'local_task' | 'warroom' | 'warroom_bot' | 'project' | 'price';
export type ReserveResult = { ok: true; reservationId: string } | { ok: false; scope: ReserveScope };
export type ReserveRequest = {
  actor: ActorRef;
  taskId?: string;
  estUsd: number;
  model?: string;
  /** Provider id; `claude-code-local` is counted in calls instead of priced (spec §4.3). */
  provider?: string;
  /** The call's abort signal: a local reservation is bound to it so the provider's onAttempt hook can count retries. */
  signal?: AbortSignal;
  /** TW4: a bot-origin warroom run (routed talk, a meeting turn) also draws from the warroom pool, so it can never use up what human work needs. Set by the scheduler only. */
  pool?: 'warroom';
  /** SPEND-1: what the spend rollup records for this call. Never read by a limit decision (Gate 1 S10); anything outside the allowlists is booked as a fallback. */
  attribution?: { provider?: string; model?: string; tool?: string };
};

/** Subscription provider: cost 0 by definition, so it is metered by call count (Gate 1 L8). */
export const LOCAL_PROVIDER = PROVIDER_ID;

/**
 * Work-style §6 / Gate 1 WS1: the EXACT list of caps `limits.localUnlimited` lifts, and only for a call whose resolved provider is the
 * local one (decided per call from the provider, never from the actor, the mode or a label). Every other cap stays: concurrency, the
 * local timeout, depth, children, open tasks, the human rate limits, vision / voice / reminders / schedules / watches, forum posts,
 * `warroom.heldMax`, the meeting structure and every USD scope. Counters keep counting.
 *
 * R8 PROV-FALLBACK: there IS a local -> metered path now, but it is a requeue, never a switch inside a run. When the subscription quota hold is on
 * and `provider.fallback.enabled` is on, the work reruns from its start on the Claude API (`providers/route.ts`), where it is metered in USD and fully
 * capped. The lifts below never apply to a `claude` run: they are decided per call from the effective provider (loop, tool context, warroom guard), and
 * a test pins that every key here reads false for it. The run that was cut keeps its local-priced state; the rerun starts clean.
 */
export const LIFTED_CAPS = [
  'limits.turnsPerTask',
  'limits.localCallsPerDay',
  'limits.localCallsPerTask',
  'warroom.localCallsPerDay',
  'warroom.turnsPerThreadPerHour',
  'warroom.turnsPerHour',
  'warroom.rootTasksPerDay',
  'meetings.adHocPerDay',
] as const;
export type LiftedCap = (typeof LIFTED_CAPS)[number];

/** True when the cap `key` is skipped for a call that resolved to `providerId`. */
export function liftsCap(key: string, cfg: Pick<ConfigStore, 'get'>, providerId: string | undefined): boolean {
  return providerId === LOCAL_PROVIDER && (LIFTED_CAPS as readonly string[]).includes(key) && cfg.get('limits.localUnlimited') === true;
}

/** Whether the lift is on for this provider at all (use `liftsCap` at each check so the list stays exact). */
export const localLiftOn = (cfg: Pick<ConfigStore, 'get'>, providerId: string | undefined): boolean =>
  providerId === LOCAL_PROVIDER && cfg.get('limits.localUnlimited') === true;

/** Task caps are lifetime caps on the root tree, so task rows use one fixed day instead of resetting at UTC midnight. */
const TASK_DAY = '1970-01-01';
/**
 * OT-1 (OT-C13): the budget_days key of a task tree's spend, exported so the overtime USD slice reads exactly the row `reserve` writes
 * (one place to change if the tree counter ever moves). Read only: callers never lock these rows (lock order above).
 */
export const taskBudgetKey = (rootId: string): { day: string; scope: 'task'; scopeId: string } => ({ day: TASK_DAY, scope: 'task', scopeId: rootId });
const EPS = 1e-9;
/** Money is stored as numeric(12,6): estimates round UP (never under-reserve), actuals to the nearest micro-dollar. */
const ceilMicro = (x: number) => Math.ceil(Number((x * 1e6).toFixed(4))) / 1e6;
const roundMicro = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Every transaction here locks budget_days rows in this one global order (an ordered subsequence of it), so concurrent
 * reservations, retry counts and settles can never deadlock: company -> dept -> bot -> task -> local -> warroom -> warroom_bot.
 * The dept row is keyed by the first day of the local month (schedule.timezone); no other row of a transaction shares its scope.
 */
type KeyScope = 'company' | 'dept' | 'bot' | 'task' | 'local' | 'warroom' | 'warroom_bot';
interface Key { day: string; scope: KeyScope; scopeId: string }
/** `rollupDay` and the dept are fixed at reserve time: a settle after local midnight books to the keys the call was admitted under. */
interface Reservation { estUsd: number; keys: Key[]; rootId: string | null; actor: ActorRef; local: boolean; attempts: number; signal?: AbortSignal; dept: string; rollupDay: string; attribution: { provider: string; model: string; tool: string } }
type Row = { reserved_usd: number; spent_usd: number; calls: number };

export const actorKey = (a: ActorRef): string => (a.kind === 'head' ? `head:${a.dept}` : `persona:${a.personaId}`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily cost meter. reserve() locks the company, bot and (root) task rows in that fixed order inside one
 * transaction, so concurrent reservations serialise and can never overshoot a limit. Any error is thrown,
 * and the caller must then make no provider call (Gate 1 D23).
 *
 * claude-code-local (Gate 1 L8): no USD is reserved or checked. reserve() locks the root task row then the day's
 * `local` row, checks and increments their call counts (attempt 1); onLocalAttempt() counts each further attempt
 * (a retry) the same way before the provider spawns it. Any error throws, so the provider spawns nothing.
 */
export class Budget {
  private readonly open = new Map<string, Reservation>();
  private readonly announced = new Set<string>();
  private readonly bound = new WeakMap<AbortSignal, string>();

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Cfg,
    private readonly bus: EventBus<AppEvents>,
    private readonly now: () => Date = () => new Date(),
    private readonly opts: {
      taskCap?: (rootId: string, client: PoolClient) => Promise<number>;
      /** Per-root local call cap (approved caps raise it); default `limits.localCallsPerTask`. */
      localCap?: (rootId: string, client: PoolClient) => Promise<number>;
      /** SPEND-1: the department's effective monthly cap (USD, Infinity = none), read through the reserving transaction's client. Default: the config cap only. */
      deptCap?: (dept: string, month: string, client: PoolClient) => Promise<number>;
      /**
       * AUTO-1 (SA-1 3.4): the active project's caps for a root tree (null = not in a project), read through the reserving transaction's client. A project cap replaces the
       * tree's USD cap and local call cap, and is never lifted by `limits.localUnlimited`. A throw fails the reservation closed (AP-C10).
       */
      project?: (rootId: string, client: PoolClient) => Promise<{ maxUsd: number; maxCalls: number } | null>;
    } = {},
  ) {}

  /** Throws for a model without a price (D4). */
  costOf(model: string, u: Usage): number {
    const pricing = this.cfg.get('pricing');
    if (!Object.hasOwn(pricing, model)) throw new Error(`no price for model ${model}`);
    const p = pricing[model]!;
    return (
      (u.inputTokens * p.inPerMTok +
        u.outputTokens * p.outPerMTok +
        u.cacheReadTokens * (p.cacheReadPerMTok ?? p.inPerMTok) +
        u.cacheWriteTokens * p.inPerMTok * 1.25) /
      1e6
    );
  }

  async reserve(r: ReserveRequest): Promise<ReserveResult> {
    const local = r.provider === LOCAL_PROVIDER;
    if (!Number.isFinite(r.estUsd) || r.estUsd < 0) return { ok: false, scope: 'price' };
    // D4 for every metered provider; a local call costs 0 by definition and is counted instead.
    if (!local && r.model !== undefined && !Object.hasOwn(this.cfg.get('pricing'), r.model)) return { ok: false, scope: 'price' };
    const estUsd = local ? 0 : ceilMicro(r.estUsd);
    const at = this.now();
    const day = isoDay(at);
    const rollupDay = localDay(at.getTime(), this.cfg.get('schedule.timezone')).date;
    const month = monthStart(rollupDay);
    const client = await this.pool.connect();
    let dept = '_unattributed';
    let failed: ReserveScope | null = null;
    let alertCalls: number | null = null;
    let reservationId = '';
    try {
      await client.query('BEGIN');
      dept = await this.deptOf(client, r.actor);
      let rootId: string | null = null;
      if (r.taskId !== undefined) {
        const t = await client.query<{ root_id: string }>('SELECT root_id FROM tasks WHERE id = $1', [r.taskId]);
        if (!t.rows[0]) throw new Error(`task ${r.taskId} not found`);
        rootId = t.rows[0].root_id;
      }
      const taskKey: Key[] = rootId ? [taskBudgetKey(rootId)] : []; // OT-C13: the same helper the overtime USD slice reads, so the two can never drift
      const warKey: Key[] = r.pool === 'warroom' ? [{ day, scope: 'warroom', scopeId: '' }] : [];
      // A warroom USD run is held to the warroom pool and to its bot's own warroom share instead of the bot's ordinary daily budget, so a head's
      // bot-to-bot talk can never use up what its human work needs (TW4). Locks stay ordered: '' sorts before 'head:...'.
      // SPEND-1: a metered call also draws on its department's month (always, even with no cap, so month-to-date is right when one is set). A local call never touches it (L8).
      const deptKey: Key = { day: month, scope: 'dept', scopeId: dept };
      const keys: Key[] = local
        ? [...taskKey, { day, scope: 'local', scopeId: '' }, ...warKey]
        : r.pool === 'warroom'
          ? [{ day, scope: 'company', scopeId: '' }, deptKey, ...taskKey, ...warKey, { day, scope: 'warroom_bot', scopeId: actorKey(r.actor) }]
          : [{ day, scope: 'company', scopeId: '' }, deptKey, { day, scope: 'bot', scopeId: actorKey(r.actor) }, ...taskKey];
      const rows = await this.lockRows(client, keys);
      const proj = rootId && this.opts.project ? await this.opts.project(rootId, client) : null;
      if (local) {
        failed = await this.localRefusal(client, keys, rows, rootId, r.provider, proj);
      } else {
        const deptLimit = this.opts.deptCap ? await this.opts.deptCap(dept, month, client) : (this.cfg.get('spend.deptMonthlyUsd') as Record<string, number>)[dept] ?? Infinity;
        const limits = { company: this.cfg.get('budget.companyDailyUsd'), dept: deptLimit, bot: this.cfg.get('budget.botDailyUsd'), task: proj ? proj.maxUsd : rootId && this.opts.taskCap ? await this.opts.taskCap(rootId, client) : this.cfg.get('budget.taskUsd'), local: Infinity, warroom: this.cfg.get('warroom.dailyUsd'), warroom_bot: this.cfg.get('warroom.botDailyUsd') };
        for (let i = 0; i < keys.length && failed === null; i++)
          if (rows[i]!.spent_usd + rows[i]!.reserved_usd + estUsd > limits[keys[i]!.scope] + EPS) failed = keys[i]!.scope;
        if (failed === 'task' && proj) failed = 'project';
      }
      if (failed !== null) {
        await client.query('ROLLBACK');
      } else {
        for (const k of keys)
          await client.query(
            local
              ? 'UPDATE budget_days SET calls = calls + 1 WHERE day = $1 AND scope = $2 AND scope_id = $3'
              : 'UPDATE budget_days SET reserved_usd = reserved_usd + $4 WHERE day = $1 AND scope = $2 AND scope_id = $3',
            local ? [k.day, k.scope, k.scopeId] : [k.day, k.scope, k.scopeId, estUsd],
          );
        await client.query('COMMIT');
        if (local) {
          const wi = keys.findIndex((k) => k.scope === 'warroom');
          if (wi >= 0) alertCalls = rows[wi]!.calls + 1;
        }
        reservationId = randomUUID();
        const a = r.attribution;
        this.open.set(reservationId, {
          estUsd, keys, rootId, actor: r.actor, local, attempts: 0, ...(r.signal ? { signal: r.signal } : {}), dept, rollupDay,
          attribution: { provider: cleanProvider(a?.provider ?? r.provider), model: cleanModel(a?.model ?? r.model), tool: cleanTool(a?.tool) },
        });
        if (local && r.signal) this.bound.set(r.signal, reservationId);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (failed === null) {
      // WS5: alert only. Bot-triggered local calls are the warroom row's count (every bot-triggered run carries pool 'warroom').
      if (local && r.pool === 'warroom' && alertCalls !== null && alertCalls === this.cfg.get('limits.localBotCallsAlert')) await this.announce('local_bot_alert', day, r.actor);
      return { ok: true, reservationId };
    }
    if (failed === 'dept') {
      // SP-02: every dept refusal is reported (the one-pending index and the stop claim dedupe, not the in-process Set), so a later refusal re-arms the raise card.
      await this.bus.emit('governance.paused', { scope: 'dept', dept, day: month, estUsd });
    } else if (failed === 'company' || failed === 'bot' || failed === 'local' || failed === 'warroom' || failed === 'warroom_bot') await this.announce(failed, day, r.actor);
    return { ok: false, scope: failed };
  }

  /**
   * The claude-code-local provider's onAttempt hook (R-L5), awaited before each spawn. Attempt 1 was counted by
   * reserve(); every further attempt (a retry after a timeout) is counted here under the same row locks. It throws,
   * and the provider spawns nothing, when no open local reservation is bound to `signal`, when the day's local count
   * is used up, or on any error (fail closed, D23). A retry is counted on the root tree too but not refused by the
   * tree cap: it overshoots that cap by at most one per call, and the next reserve() asks for approval.
   */
  async onLocalAttempt(_attempt: number, signal: AbortSignal): Promise<void> {
    const id = this.bound.get(signal);
    const res = id === undefined ? undefined : this.open.get(id);
    if (!res?.local) throw new Error('local call refused: no counted reservation for this call');
    if (res.attempts === 0) {
      res.attempts = 1;
      return;
    }
    const localKey = res.keys.find((k) => k.scope === 'local')!;
    const client = await this.pool.connect();
    let refused = false;
    let warRefused = false;
    try {
      await client.query('BEGIN');
      const rows = await this.lockRows(client, res.keys);
      // WS1: a local call under `limits.localUnlimited` is counted but not refused by these two daily counts.
      const perDay = this.cfg.get('limits.localCallsPerDay');
      refused = !liftsCap('limits.localCallsPerDay', this.cfg, LOCAL_PROVIDER) && rows[res.keys.indexOf(localKey)]!.calls >= perDay;
      const warIdx = res.keys.findIndex((k) => k.scope === 'warroom');
      warRefused = !refused && warIdx >= 0 && !liftsCap('warroom.localCallsPerDay', this.cfg, LOCAL_PROVIDER) && rows[warIdx]!.calls >= this.cfg.get('warroom.localCallsPerDay');
      if (refused || warRefused) {
        await client.query('ROLLBACK');
      } else {
        for (const k of res.keys)
          await client.query('UPDATE budget_days SET calls = calls + 1 WHERE day = $1 AND scope = $2 AND scope_id = $3', [k.day, k.scope, k.scopeId]);
        await client.query('COMMIT');
        res.attempts++;
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (refused) {
      await this.announce('local', localKey.day, res.actor);
      throw new Error('local call refused: daily local call count used up');
    }
    if (warRefused) {
      await this.announce('warroom', localKey.day, res.actor);
      throw new Error('local call refused: warroom local call count used up');
    }
  }

  /** Moves the estimate out of reserved and the actual cost into spent on the original rows, and onto the root task. */
  async settle(reservationId: string, actualUsd: number): Promise<void> {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error('settle needs a finite non-negative amount');
    await this.close(reservationId, roundMicro(actualUsd));
  }

  /** Frees a reservation whose provider call never happened or failed without usage. */
  async release(reservationId: string): Promise<void> {
    await this.close(reservationId, 0);
  }

  async usage(day: string): Promise<UsageRow[]> {
    return (
      await this.pool.query<UsageRow>(
        `SELECT to_char(day,'YYYY-MM-DD') AS day, scope, scope_id AS "scopeId", reserved_usd AS "reservedUsd", spent_usd AS "spentUsd",
         calls FROM budget_days WHERE day = $1 AND scope <> 'dept' ORDER BY scope, scope_id`,
        [day],
      )
    ).rows;
  }

  /** Actual spend of a whole task tree (stored on the root task). */
  async treeSpend(rootId: string): Promise<number> {
    return (await this.pool.query<{ cost_usd: number }>('SELECT cost_usd FROM tasks WHERE id = $1', [rootId])).rows[0]?.cost_usd ?? 0;
  }

  /**
   * Boot only, single process: reservations live in memory, so after a restart any leftover reserved amounts are leaks.
   * Refuses (throws) if this process holds an open reservation, since zeroing would unlock the cost guard.
   */
  async clearStaleReservations(): Promise<void> {
    if (this.open.size > 0) throw new Error('clearStaleReservations refused: open reservations exist');
    await this.pool.query('UPDATE budget_days SET reserved_usd = 0 WHERE reserved_usd <> 0');
  }

  private async close(reservationId: string, actualUsd: number): Promise<void> {
    const res = this.open.get(reservationId);
    if (!res) throw new Error(`unknown reservation ${reservationId}`);
    this.open.delete(reservationId); // claimed: a concurrent second settle fails instead of double counting
    if (res.signal) this.bound.delete(res.signal);
    const client = await this.pool.connect().catch((err: unknown) => { this.open.set(reservationId, res); throw err; });
    try {
      await client.query('BEGIN');
      for (const k of res.keys)
        await client.query(
          'UPDATE budget_days SET reserved_usd = GREATEST(reserved_usd - $4, 0), spent_usd = spent_usd + $5 WHERE day = $1 AND scope = $2 AND scope_id = $3',
          [k.day, k.scope, k.scopeId, res.estUsd, actualUsd],
        );
      if (res.rootId && actualUsd > 0) await client.query('UPDATE tasks SET cost_usd = cost_usd + $2 WHERE id = $1', [res.rootId, actualUsd]);
      // SPEND-1: the rollup is the last statement, in the same transaction: a failure here fails the settle (fail closed, Gate 1 S11).
      if (actualUsd > 0 || res.local)
        await client.query(
          `INSERT INTO spend_days (day, dept_id, provider, model, tool, root_id, spent_usd, calls) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (day, dept_id, provider, model, tool, root_id)
           DO UPDATE SET spent_usd = spend_days.spent_usd + EXCLUDED.spent_usd, calls = spend_days.calls + EXCLUDED.calls`,
          [res.rollupDay, cleanDept(res.dept), res.attribution.provider, res.attribution.model, res.attribution.tool, res.rootId ?? '', actualUsd, res.local ? Math.max(res.attempts, 1) : 1],
        );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.open.set(reservationId, res);
      throw err;
    } finally {
      client.release();
    }
  }

  /** The department a call is booked to: a head's own, a persona's (looked up on the reserving client), else `_unattributed` (no dept cap). */
  private async deptOf(client: PoolClient, actor: ActorRef): Promise<string> {
    if (actor.kind === 'head') return cleanDept(actor.dept);
    const r = await client.query<{ dept_id: string }>('SELECT dept_id FROM personas WHERE id = $1', [actor.personaId]);
    return cleanDept(r.rows[0]?.dept_id);
  }

  /** Ensures each row exists, then locks them in the given order (always an ordered subsequence of the global order). */
  private async lockRows(client: PoolClient, keys: Key[]): Promise<Row[]> {
    for (const k of keys)
      await client.query('INSERT INTO budget_days (day, scope, scope_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [k.day, k.scope, k.scopeId]);
    const rows: Row[] = [];
    for (const k of keys)
      rows.push(
        (
          await client.query<Row>('SELECT reserved_usd, spent_usd, calls FROM budget_days WHERE day = $1 AND scope = $2 AND scope_id = $3 FOR UPDATE', [k.day, k.scope, k.scopeId])
        ).rows[0]!,
      );
    return rows;
  }

  /** The daily count is reported first: approving a bigger tree cap would not help while the day is used up. */
  private async localRefusal(client: PoolClient, keys: Key[], rows: Row[], rootId: string | null, provider?: string, proj: { maxUsd: number; maxCalls: number } | null = null): Promise<ReserveScope | null> {
    const at = (scope: KeyScope) => rows[keys.findIndex((k) => k.scope === scope)];
    // WS1: these three counts are skipped (not reset) for a local call while limits.localUnlimited is on; the counters still go up.
    const lifted = (key: string) => liftsCap(key, this.cfg, provider);
    if (!lifted('limits.localCallsPerDay') && at('local')!.calls >= this.cfg.get('limits.localCallsPerDay')) return 'local';
    const war = at('warroom');
    if (war && !lifted('warroom.localCallsPerDay') && war.calls >= this.cfg.get('warroom.localCallsPerDay')) return 'warroom';
    // AUTO-1 (AP-C6): a project tree is held to the project's call cap, checked before the lifted per-tree block, so it is never lifted and `local_task` never applies to it.
    if (rootId && proj) return at('task')!.calls >= proj.maxCalls ? 'project' : null;
    if (rootId && !lifted('limits.localCallsPerTask')) {
      const cap = this.opts.localCap ? await this.opts.localCap(rootId, client) : this.cfg.get('limits.localCallsPerTask');
      if (at('task')!.calls >= cap) return 'local_task';
    }
    return null;
  }

  private async announce(scope: 'company' | 'bot' | 'local' | 'warroom' | 'warroom_bot' | 'local_bot_alert', day: string, actor: ActorRef): Promise<void> {
    const perBot = scope === 'bot' || scope === 'warroom_bot';
    const key = `${day}|${scope}|${perBot ? actorKey(actor) : ''}`;
    if (this.announced.has(key)) return;
    this.announced.add(key);
    await this.bus.emit('governance.paused', perBot ? { scope, actor, day } : { scope, day });
  }
}
