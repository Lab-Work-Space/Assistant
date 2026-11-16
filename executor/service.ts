import { z } from 'zod';
import { canonical } from '../config/store.js';
import { redactText } from '../core/logger.js';
import type { AdminCard, AdminCardRepo } from '../db/repos/adminCards.js';
import type { ExecRepo } from '../db/repos/exec.js';
import type { AuditFn } from '../governance/audit.js';
import type { CardItem } from '../admin/card.js';
import { clean } from '../discord/perm/perm-limits.js';
import { PermProposal, type PermOp } from '../discord/perm/perm-ops.js';
import type { PermWriter } from '../discord/perm/perm-world.js';
import { PermService } from '../discord/perm/perm-service.js';
import { ADMIN_POWER_BITS } from '../discord/perm/perm-bits.js';
import { executeServerOps, serverTarget } from '../discord/server/server-apply.js';
import { checkServerOps, welcomeRoleProblem, type ServerConsts, type ResolvedServerOp } from '../discord/server/server-limits.js';
import { DESTRUCTIVE_KINDS, ServerOp, ServerProposal } from '../discord/server/server-ops.js';
import type { ServerWorld, ServerWriter } from '../discord/server/server-world.js';
import { isTier, opsTierProblem, tierOf, tierTag, type Tier, type TierRoles } from '../discord/tiers.js';
import type { SecondConfirm } from './confirm.js';
import { CODE_CONFIRM_TTL_MS, type CodeService } from './code-service.js';
import type { DeployService } from './deploy.js';
import type { RateGate } from './rate.js';
import type { TierConfig } from './tiers.js';

export type Family = 'perm' | 'server' | 'deploy' | 'code';

/** S21: the audit rows of a bulk delete name author ids (with counts) and the time range; the message ids follow (8 per row). Never content. */
function bulkAuditDetail(r: ResolvedServerOp): string[] {
  if (!r.bulk?.length) return [];
  const by = new Map<string, number>();
  for (const m of r.bulk) by.set(m.authorId, (by.get(m.authorId) ?? 0) + 1);
  const times = r.bulk.map((m) => m.at);
  const rows = [`range ${new Date(Math.min(...times)).toISOString()}..${new Date(Math.max(...times)).toISOString()}`];
  const authors = [...by].map(([id, n]) => `${id}x${n}`);
  for (let i = 0; i < authors.length; i += 4) rows.push(`authors ${authors.slice(i, i + 4).join(',')}`);
  return rows;
}
export type ProposeResult = { ok: true; payload: unknown; items: CardItem[]; snapshot: unknown } | { ok: false; error: string };
export type ApplyResult = { kind: 'refused'; why: string } | { kind: 'done'; ok: boolean; lines: string[]; applied: number; total: number } | { kind: 'awaiting'; lines: string[] };
/** Internal: every check passed and the card is in scope of the executor's own second confirmation (OD-G2-1); nothing has been done yet. */
type SecondNeeded = { kind: 'second'; card: AdminCard; by: string; tier: Tier; summary: string; family: 'deploy' | 'server' | 'code'; ttlMs?: number; bind?: { head: string; bundleSha256: string }; ownerOnly?: boolean };

export interface ExecutorServiceDeps {
  world: ServerWorld;
  permWriter: PermWriter;
  serverWriter: ServerWriter;
  cards: Pick<AdminCardRepo, 'claimForExecution'>;
  exec: ExecRepo;
  rate: RateGate;
  consts: () => ServerConsts;
  /** C21 on the executor itself: fresh boot check; warnings mean the executor was disabled. */
  recheck: () => Promise<string[]>;
  /** Non-null while the executor is switched off (unsafe permissions or a failed hierarchy check). */
  disabled: () => string[] | null;
  /** The default roles of the welcome flow (from config), for the S5 hierarchy check. */
  welcomeRoleIds: () => Promise<string[]>;
  /** T1/T7/T10: the tier roles and the mod room, read by the executor itself from the config table on EVERY check (no cache). */
  tiers: () => Promise<TierConfig>;
  audit: AuditFn;
  log: { error(o: unknown, m?: string): void };
  secrets?: readonly string[];
  now?: () => number;
  /** VPS deploy (Gate 1 V22): absent when no deploy key is configured; deploy cards are then refused. */
  deploy?: DeployService;
  /** Self-code (Gate 1 self-code): absent when the executor has no code root configured; code cards are then refused. */
  code?: CodeService;
  /** OD-5: the one user who confirms protected-path code changes. */
  ownerUserId?: string | null;
  /** OD-G2-1: LW Admin's own second confirmation for deploy ops and destructive server ops. Absent = those cards are refused (fail closed). */
  confirm?: Pick<SecondConfirm, 'request'>;
}

const NamedIds = z.array(z.string().regex(/^\d{17,20}$/)).max(200);
const StoredServer = z.object({ ops: z.array(z.unknown()).min(1).max(20), named: NamedIds }).strict();
const BOT_LOG_SUMMARY: ReadonlySet<string> = new Set(['member.kick', 'member.ban', 'member.timeout', 'msg.bulk', 'automod.create', 'automod.edit', 'automod.enable', 'automod.disable', 'automod.delete']);

const READ_MAX = 12_000;
const cap = (s: string): string => (s.length > READ_MAX ? `${s.slice(0, READ_MAX)} ...(truncated; ask for a narrower view)` : s);

/**
 * The executor's brain (Gate 1 S1, S2): validates proposals and applies CONFIRMED cards. Everything is re-checked here on the executor's own
 * live reads: a card row is data to be checked, never a validation result to be trusted. Runs inside the executor process only.
 */
export class ExecutorService {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly perm: PermService;
  /** T21: the tier of the card being applied; set only inside the serialized apply, so the perm service's rows carry it. */
  private auditTier: Tier | null = null;

  constructor(private readonly d: ExecutorServiceDeps) {
    this.perm = new PermService({
      world: d.world, writer: d.permWriter, consts: d.consts,
      readiness: { power: ADMIN_POWER_BITS, belowAllPrivileged: true },
      recheck: async () => {
        const w = await d.recheck();
        return w.length ? [{ dept: 'admin', warnings: w }] : [];
      },
      alert: async (_dept, warnings) => d.exec.push('alert', { title: 'LW Admin executor turned off', text: warnings.join('; ').slice(0, 800) }),
      audit: (e) => d.audit(this.auditTier ? { ...e, actor: `${e.actor}${tierTag(this.auditTier)}` } : e), log: d.log,
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Fresh on every call: null when the executor may run, else why it is off. */
  async readiness(): Promise<string | null> {
    const off = this.d.disabled();
    if (off) return `the executor is turned off: ${off.join('; ').slice(0, 300)}`;
    try {
      const base = await this.perm.readiness();
      if (base) return base;
      // S5: the executor's top role sits strictly above every welcome default role.
      const ids = await this.d.welcomeRoleIds();
      if (ids.length) {
        const [roles, me] = await Promise.all([this.d.world.roles(), this.d.world.me()]);
        if (!roles || !me) return 'the roles could not be read';
        for (const id of ids) {
          const r = roles.find((x) => x.id === id);
          if (r && r.position >= me.topPosition) return `welcome default role ${id} is not strictly below the executor's top role`;
        }
      }
      return null;
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'executor readiness check failed');
      return 'the readiness check could not be completed';
    }
  }

  unconfigured(): boolean {
    return this.perm.unconfigured();
  }

  async status(): Promise<{ ready: string | null }> {
    return { ready: await this.readiness() };
  }

  async propose(family: Family, raw: unknown, ctx: { userId: string; namedIds: readonly string[] }): Promise<ProposeResult> {
    const off = await this.readiness();
    if (off) return { ok: false, error: `server operations are off: ${off}` };
    // T1/T3: the proposer's tier from the LIVE member and the executor's own config, whatever the main application or the model says.
    const who = await this.authority(ctx.userId, false);
    if (!who.ok) return { ok: false, error: who.why };
    if (family === 'deploy') {
      if (who.tier !== 'bot_admin') return { ok: false, error: 'deploy operations are for Bot Admins only' };
      if (!this.d.deploy) return { ok: false, error: 'VPS deploy is off: no deploy key is configured for the executor' };
      const one = Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
      if (one === undefined) return { ok: false, error: 'a deploy card carries exactly one operation' };
      const r = await this.d.deploy.propose(one, ctx.userId);
      return r.ok ? { ok: true, payload: r.payload, items: r.items, snapshot: { ...r.snapshot, tier: who.tier } } : r;
    }
    if (family === 'code') {
      if (who.tier !== 'bot_admin') return { ok: false, error: 'code changes are for Bot Admins only' };
      if (!this.d.code) return { ok: false, error: 'code changes are off: the executor has no release directory configured' };
      const one = Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
      if (one === undefined) return { ok: false, error: 'a code card carries exactly one change' };
      const r = await this.d.code.propose(one, ctx.userId);
      return r.ok ? { ok: true, payload: r.payload, items: r.items, snapshot: { ...r.snapshot, tier: who.tier } } : r;
    }
    if (family === 'perm') {
      if (who.tier !== 'bot_admin') return { ok: false, error: 'permission operations are for Bot Admins only' };
      const why = this.tierRoleOpProblem(raw, who.cfg, who.roles);
      if (why) return { ok: false, error: why };
      const r = await this.perm.propose(raw);
      if (!r.ok) return r;
      const n = (r.payload as { ops: unknown[] }).ops.length;
      const limit = await this.d.rate.check(ctx.userId, n, 0, who.tier);
      return limit ? { ok: false, error: limit } : r;
    }
    const parsed = ServerProposal.safeParse({ ops: raw });
    // G2SM-02 (N2): code picks the messages of a bulk delete. A proposal that brings its own id list (the model or a caller) is refused.
    if (parsed.success && parsed.data.ops.some((o) => o.kind === 'msg.bulk' && o.ids !== undefined)) return { ok: false, error: 'a bulk delete names a count and an optional author; the messages are chosen by code, not supplied' };
    if (!parsed.success) return { ok: false, error: `invalid operations: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500)}` };
    const checked = await checkServerOps(parsed.data.ops, this.d.world, this.d.consts(), this.input(ctx.userId, ctx.namedIds, this.tiersIn(ctx.userId, who)));
    if (!checked.ok) return { ok: false, error: checked.error };
    const limit = await this.d.rate.check(ctx.userId, checked.resolved.length, checked.resolved.filter((r) => r.destructive).length, who.tier);
    if (limit) return { ok: false, error: limit };
    return {
      // T6: the tier in the snapshot is informational (display, audit, the T22 mismatch row); the executor never reads it as authority.
      ok: true, payload: { ops: checked.resolved.map((r) => r.op), named: checked.named }, snapshot: { snaps: checked.resolved.map((r) => r.snap), tier: who.tier },
      items: checked.resolved.map((r) => r.item),
    };
  }

  /** The roles a tier is computed from, in the executor's own view: the Bot Admin role from its env, the others from its config read. */
  private rolesOf(cfg: TierConfig): TierRoles {
    return { botAdminRoleId: this.d.consts().botAdminRoleId, managerId: cfg.managerId, moderatorId: cfg.moderatorId };
  }

  /**
   * T1: one member's tier from a fresh fetch and the executor's own config. Not found, a fetch error or a config read error is a refusal (fail
   * closed). A tier below Bot Admin also needs both tier roles to pass the T7 checks right now; if they do not, the alert goes to #bot-log.
   */
  private async authority(userId: string, alert: boolean): Promise<{ ok: true; tier: Tier; cfg: TierConfig; roles: TierRoles } | { ok: false; why: string; tier: Tier | null }> {
    let tier: Tier | null;
    let cfg: TierConfig;
    let roles: TierRoles;
    try {
      cfg = await this.d.tiers();
      const m = await this.d.world.member(userId);
      if (!m) return { ok: false, why: `member ${userId} could not be fetched (refused to be safe)`, tier: null };
      roles = this.rolesOf(cfg);
      tier = m.isBot ? null : tierOf(m.roleIds, roles);
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'tier check failed');
      return { ok: false, why: 'the tier of a member could not be determined (refused to be safe)', tier: null };
    }
    if (!tier) return { ok: false, why: `member ${userId} holds no Bot Admin, Manager or Moderator role now`, tier: null };
    if (tier !== 'bot_admin') {
      const bad = await this.tierRolesProblem(cfg).catch(() => 'the tier roles could not be checked (refused to be safe)');
      if (bad) {
        if (alert) await this.d.exec.push('alert', { title: 'Manager/Moderator cards are refused', text: bad.slice(0, 800) }).catch(() => undefined);
        return { ok: false, why: `the Manager and Moderator roles are not safe right now (${bad}); their cards are refused`, tier };
      }
    }
    return { ok: true, tier, cfg, roles };
  }

  /**
   * T7/T8: the tier roles against the S12 safe-role rules and each other, on fresh reads. Null = fine. A role that is not configured is skipped.
   * `welcomeRoleProblem` covers: exists, not managed, not @everyone, not Founder/Bot Admin/privileged, below the executor, not held by a bot, safe bits only.
   */
  private async tierRolesProblem(cfg: TierConfig): Promise<string | null> {
    const c = this.d.consts();
    if (cfg.managerId && cfg.managerId === cfg.moderatorId) return 'the Manager and Moderator roles are the same role';
    const welcome = await this.d.welcomeRoleIds();
    for (const [label, id] of [['Manager', cfg.managerId], ['Moderator', cfg.moderatorId]] as const) {
      if (!id) continue;
      if (id === c.botAdminRoleId || id === c.founderRoleId) return `the ${label} role is the Bot Admin or Founder role`;
      if (welcome.includes(id)) return `the ${label} role is also a welcome default role`;
      const why = await welcomeRoleProblem(id, this.d.world, c);
      if (why) return `${label} role: ${why}`;
    }
    return null;
  }

  /** The config-time check for `roles.*` (T7-T10): the same rules as at apply, plus the mod room must be a readable channel that is not a protected one. */
  async checkTierConfig(next: TierConfig): Promise<string | null> {
    const off = await this.readiness();
    if (off) return `server operations are off: ${off}`;
    try {
      const why = await this.tierRolesProblem(next);
      if (why) return why;
      if (next.modRoomId !== null) {
        const c = this.d.consts();
        if (c.deniedChannelIds.includes(next.modRoomId) || c.deniedCategoryIds.includes(next.modRoomId) || c.systemChannelIds.includes(next.modRoomId)) return 'the mod room is a protected or system channel';
        const ch = await this.d.world.channel(next.modRoomId);
        if (!ch) return 'the mod room could not be read (LW Admin needs View Channel there)';
        if (ch.isThread || ch.type === 4) return 'the mod room must be a text channel';
        if (ch.parentId && (c.deniedChannelIds.includes(ch.parentId) || c.deniedCategoryIds.includes(ch.parentId))) return 'the mod room is in a protected category';
      }
      return null;
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'tier config check failed');
      return 'the tier settings could not be checked (refused to be safe)';
    }
  }

  /** T9/T24: granting, removing or editing a tier role (or the Bot Admin role) is never a Praw operation; the owner assigns them in Discord. */
  private tierRoleOpProblem(ops: unknown, cfg: TierConfig, roles: TierRoles): string | null {
    const locked = new Set([cfg.managerId, cfg.moderatorId, roles.botAdminRoleId].filter((x): x is string => !!x));
    for (const o of Array.isArray(ops) ? ops : []) {
      const op = o as { kind?: unknown; role?: unknown } | null;
      if (op && typeof op === 'object' && typeof op.kind === 'string' && /^role\.(assign|remove|edit\.permissions)$/.test(op.kind) && typeof op.role === 'string' && locked.has(op.role)) {
        return 'the Bot Admin, Manager and Moderator roles cannot be granted, removed or edited through Praw; assign them in Discord';
      }
    }
    return null;
  }

  private tiersIn(userId: string, who: { tier: Tier; cfg: TierConfig; roles: TierRoles }) {
    return who.tier === 'bot_admin' ? undefined : { actorId: userId, tier: who.tier, roles: who.roles, modRoomId: who.cfg.modRoomId };
  }

  private input(userId: string, named: readonly string[], tiers?: ReturnType<ExecutorService['tiersIn']>) {
    return { proposer: { userId }, ...(tiers ? { tiers } : {}), named: new Set(named), now: this.d.now ?? Date.now, ...(this.d.secrets ? { secrets: this.d.secrets } : {}), welcomePaused: async () => (await this.d.exec.getState('welcome.paused')) !== null };
  }

  /** Applies one confirmed card by id. The claim is the single-use gate; every check below runs on live reads. */
  apply(cardId: string): Promise<ApplyResult> {
    return this.serial(async () => {
      const r = await this.doApply(cardId);
      return r.kind === 'second' ? this.askSecond(r) : r;
    });
  }

  /** OD-G2-1: the prompt goes out through LW Admin's own identity; the work waits for a click that only LW Admin's interaction stream can deliver. */
  private async askSecond(n: SecondNeeded): Promise<ApplyResult> {
    const why = async (w: string): Promise<ApplyResult> => {
      await this.d.audit({ actor: `user:${n.by} via ${n.card.via}${tierTag(n.tier)}`, action: 'admin.exec', tool: n.card.kind, outcome: `refused card:${n.card.id} ${w}` });
      return { kind: 'refused', why: w };
    };
    if (!this.d.confirm) return why('the second confirmation by LW Admin is not available, so this card cannot run');
    const r = await this.d.confirm.request({
      cardId: n.card.id, userId: n.by, channelId: n.card.channelId, summary: n.summary, family: n.family, ...(n.ttlMs ? { ttlMs: n.ttlMs } : {}),
      run: async () => {
        const out = await this.serial(() => this.doApply(n.card.id, n.card, n.bind));
        if (out.kind === 'refused') return { ok: false, refused: true, lines: [`Refused: ${out.why}`] };
        if (out.kind === 'done') return { ok: out.ok, lines: out.lines, applied: out.applied, total: out.total };
        return { ok: false, lines: ['Refused: the card asked for a second confirmation again'] };
      },
      recheck: async (userId) => {
        const who = await this.authority(userId, false);
        if (!who.ok) return who.why;
        // OD-5: the click of a protected-path code change counts only from the owner, judged again here.
        if (n.ownerOnly && (!this.d.ownerUserId || userId !== this.d.ownerUserId)) return 'only the owner can confirm a change to protected paths';
        return who.tier === n.tier ? null : `your role changed since the card (${n.tier} -> ${who.tier})`;
      },
    });
    if (!r.ok) return why(r.why);
    return { kind: 'awaiting', lines: [`A second confirmation was sent by LW Admin ${r.where === 'dm' ? 'to your DMs' : 'in this channel (your DMs are closed)'}. Click its button within ${r.ttlMinutes} minutes; nothing has been done yet.`] };
  }

  /** `again`: the card was claimed on the first pass; this is the pass after the second confirmation (all checks run again on live data). */
  private async doApply(cardId: string, again?: AdminCard, bind?: { head: string; bundleSha256: string }): Promise<ApplyResult | SecondNeeded> {
    const refuse = async (why: string, card?: { proposerId: string; kind: string; via: string; decidedBy: string | null }, tier?: Tier | null): Promise<ApplyResult> => {
      await this.d.audit({ actor: card ? `user:${card.decidedBy ?? card.proposerId} via ${card.via}${tier ? tierTag(tier) : ''}` : 'system:executor', action: 'admin.exec', tool: card?.kind ?? 'card', outcome: `refused card:${cardId} ${why}` });
      return { kind: 'refused', why };
    };
    const card = again ?? (await this.d.cards.claimForExecution(cardId));
    if (!card) return refuse('the card is not a confirmed, unused card of the permission, server or deploy family');
    const confirmed = again !== undefined;
    const off = await this.readiness();
    if (off) return refuse(`server operations are off: ${off}`, card);
    // T1: BEFORE any write, the proposer AND the decider are fetched live and their tiers come from the executor's own config. A card row is data to be checked;
    // the stored tier, the stored proposer and the click that confirmed it are not authority. No recorded decider = refused (no fallback to the proposer).
    if (!card.decidedBy) return refuse('the card has no recorded decider', card);
    const proposer = await this.authority(card.proposerId, true);
    if (!proposer.ok) return refuse(`proposer: ${proposer.why}`, card, proposer.tier);
    const decider = card.decidedBy === card.proposerId ? proposer : await this.authority(card.decidedBy, true);
    if (!decider.ok) return refuse(`decider: ${decider.why}`, card, decider.tier);
    const tier = proposer.tier;
    const by = card.decidedBy;
    // T4: a tier below Bot Admin confirms only its own card. T22: the tier now must be the tier the card was proposed under.
    if (tier !== 'bot_admin' && by !== card.proposerId) return refuse('only the proposer can confirm this card', card, tier);
    // G2T-02/03: the card's channel is tied to the tier. A tier card lives in the mod room the executor reads from config; a #setting card needs a Bot Admin proposer and decider.
    if (tier !== 'bot_admin' ? !proposer.cfg.modRoomId || card.channelId !== proposer.cfg.modRoomId : card.channelId === proposer.cfg.modRoomId || decider.tier !== 'bot_admin') {
      return refuse('the card\'s channel does not match the proposer\'s role (a Manager or Moderator card belongs to the mod room, a Bot Admin card to #setting)', card, tier);
    }
    const proposedAs = (card.snapshot as { tier?: unknown } | null)?.tier;
    if (isTier(proposedAs) && proposedAs !== tier) return refuse(`the proposer's role changed since the proposal (proposed as ${proposedAs}, now ${tier}); ask again`, card, tier);
    if (card.kind === 'deploy') {
      // Gate 1 V22: Bot Admin proposer AND decider (the channel rule above already pinned the card to #setting); the key and the VPS call live in DeployService.
      if (proposer.tier !== 'bot_admin' || decider.tier !== 'bot_admin') return refuse('deploy operations need a Bot Admin proposer and decider', card, tier);
      if (!this.d.deploy) return refuse('VPS deploy is off: no deploy key is configured for the executor', card, tier);
      if (!confirmed) {
        const c = await this.d.deploy.check(card);
        if (!c.ok) return refuse(c.why, card, tier);
        return { kind: 'second', card, by, tier, family: 'deploy', summary: c.summary };
      }
      const r = await this.d.deploy.apply(card, by);
      if (r.kind === 'refused') return refuse(r.why, card, tier);
      return r;
    }
    if (card.kind === 'code') {
      // Gate 1 self-code: Bot Admin proposer AND decider; OD-5 adds the owner-only rule for protected paths inside CodeService.check. The row is data.
      if (proposer.tier !== 'bot_admin' || decider.tier !== 'bot_admin') return refuse('code changes need a Bot Admin proposer and decider', card, tier);
      if (!this.d.code) return refuse('code changes are off: the executor has no release directory configured', card, tier);
      if (!confirmed) {
        const c = await this.d.code.check(card, by);
        if (!c.ok) return refuse(c.why, card, tier);
        return { kind: 'second', card, by, tier, family: 'code', summary: c.summary, ttlMs: CODE_CONFIRM_TTL_MS, bind: c.bind, ownerOnly: c.ownerOnly };
      }
      if (!bind) return refuse('the confirmation carried no binding', card, tier);
      const r = await this.d.code.apply(card, by, bind);
      if (r.kind === 'refused') return refuse(r.why, card, tier);
      return r;
    }
    if (card.kind === 'perm') {
      if (proposer.tier !== 'bot_admin' || decider.tier !== 'bot_admin') return refuse('permission operations need a Bot Admin proposer and decider', card, tier);
      const parsed = PermProposal.safeParse({ ops: (card.payload as { ops?: unknown } | null)?.ops });
      if (!parsed.success) return refuse('the stored operations are no longer valid', card, tier);
      const roleWhy = this.tierRoleOpProblem(parsed.data.ops, proposer.cfg, proposer.roles);
      if (roleWhy) return refuse(roleWhy, card, tier);
      const limit = await this.d.rate.check(by, parsed.data.ops.length, 0, tier);
      if (limit) return refuse(limit, card, tier);
      this.auditTier = tier;
      try {
        return (await this.perm.apply(card.payload, card.snapshot, { userId: by, cardId: card.id, via: card.via })) as ApplyResult;
      } finally {
        this.auditTier = null;
      }
    }
    const stored = StoredServer.safeParse(card.payload);
    if (!stored.success) return refuse('the stored operations are no longer valid', card, tier);
    const ops = ServerProposal.safeParse({ ops: stored.data.ops });
    if (!ops.success) return refuse('the stored operations are no longer valid', card, tier);
    // T2: every op against the one table, for the proposer and the decider alike.
    for (const t of [proposer.tier, decider.tier]) {
      const why = opsTierProblem(t, ops.data.ops);
      if (why) return refuse(why, card, tier);
    }
    // msg.bulk must carry its frozen id list; the executor never selects again (N2).
    if (ops.data.ops.some((o) => o.kind === 'msg.bulk' && !o.ids)) return refuse('a bulk delete without its stored message ids', card, tier);
    if (ops.data.ops.some((o) => o.kind === 'msg.bulk' && o.ids!.length > o.count)) return refuse('a bulk delete stores more message ids than its count', card, tier);
    const checked = await checkServerOps(ops.data.ops, this.d.world, this.d.consts(), this.input(card.proposerId, stored.data.named, this.tiersIn(card.proposerId, proposer)));
    if (!checked.ok) return refuse(checked.error, card, tier);
    const snaps = (card.snapshot as { snaps?: unknown[] } | null)?.snaps ?? [];
    const stale = checked.resolved.findIndex((r, i) => canonical(r.snap) !== canonical(snaps[i]));
    if (stale >= 0) return refuse(`the state of operation ${stale + 1} changed since the proposal; ask again`, card, tier);
    const limit = await this.d.rate.check(by, checked.resolved.length, checked.resolved.filter((r) => r.destructive).length, tier);
    if (limit) return refuse(limit, card, tier);
    if (!confirmed && checked.resolved.some((r) => r.destructive)) {
      const lines = checked.resolved.slice(0, 8).map((r) => `${r.destructive ? '[destructive] ' : ''}${r.item.label}: ${r.item.old} -> ${r.item.neu}`);
      return { kind: 'second', card, by, tier, family: 'server', summary: lines.join('\n').replace(/@/g, '@\u200b') };
    }
    return this.runServer(checked.resolved, by, card.id, card.via, tier);
  }

  private async runServer(resolved: ResolvedServerOp[], by: string, cardId: string, via: string, tier: Tier): Promise<ApplyResult> {
    const actor = `user:${by} via ${via}${tierTag(tier)}`;
    const c = this.d.consts();
    const world = this.d.world;
    const archiveId = (await world.channels())?.find((x) => x.type === 4 && x.name.trim() === c.archiveCategoryName)?.id ?? null;
    const report = await executeServerOps(
      resolved, this.d.serverWriter,
      {
        everyoneRoleId: world.guildId, archiveCategoryId: () => archiveId, botLogChannelId: c.botLogChannelId,
        archived: (id) => this.d.exec.recordArchive(id, by), resumeWelcome: async () => void (await this.d.exec.clearState('welcome.paused')),
        bulkIds: (r) => r.bulk?.map((m) => m.id) ?? [],
      },
      `Praw server management: ${by} card ${cardId.slice(0, 8)}`,
      async (r, outcome, o) => {
        await this.d.audit({ actor, action: `server.${r.op.kind}`, tool: serverTarget(r.op), outcome: `${outcome} card:${cardId} old=${r.op.kind === 'invite.create' || r.op.kind === 'invite.revoke' ? '-' : r.item.old} new=${r.op.kind === 'invite.create' ? '-' : r.item.neu}` });
        const detail = [...bulkAuditDetail(r), ...o.detail];
        for (const d of detail) await this.d.audit({ actor, action: `server.${r.op.kind}.detail`, tool: serverTarget(r.op), outcome: `detail card:${cardId} ${d}` });
        if (outcome === 'ok' && BOT_LOG_SUMMARY.has(r.op.kind)) {
          const target = 'member' in r.op ? `<@${r.op.member}>` : 'channel' in r.op ? `<#${r.op.channel}>` : serverTarget(r.op);
          await this.d.exec.push('summary', { text: `${r.op.kind} by <@${by}> (card #${cardId.slice(0, 8)}): ${target}` }).catch((err: unknown) => this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'summary outbox failed'));
        }
      },
    );
    // C21 for the executor itself: its own permissions again on fresh data; unsafe ones switch it off.
    const lines = [...report.lines];
    try {
      const warnings = await this.d.recheck();
      if (warnings.length) {
        lines.push(`Live re-check: the executor was turned off (${warnings.join('; ').slice(0, 300)}).`);
        await this.d.exec.push('alert', { title: 'LW Admin executor turned off', text: warnings.join('; ').slice(0, 800) });
      }
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'live re-check failed');
      lines.push('Live re-check could not be completed; check the executor.');
    }
    return { kind: 'done', ok: report.ok, applied: report.applied, total: report.total, lines };
  }

  /** The discovery reads (S9, S10). Names are user-written text: the caller wraps the result as untrusted. */
  async read(kind: 'roles' | 'channels' | 'members' | 'audit', args: { roleId?: string | undefined; joinedAfter?: string | undefined } = {}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const off = this.d.disabled();
    if (off) return { ok: false, error: 'the executor is turned off' };
    if (kind === 'roles' || kind === 'channels') return this.perm.read(kind);
    if (kind === 'members') {
      const list = await this.d.world.memberList(50);
      if (!list) return { ok: false, error: 'the members could not be read' };
      const since = args.joinedAfter ? Date.parse(args.joinedAfter) : null;
      const out = list.filter((m) => (!args.roleId || m.roleIds.includes(args.roleId)) && (since === null || (m.joinedAt ?? 0) >= since)).slice(0, 50)
        .map((m) => ({ id: m.id, mention: `<@${m.id}>`, name: clean(m.displayName), joined: m.joinedAt ? new Date(m.joinedAt).toISOString().slice(0, 10) : null, roles: m.roleIds }));
      return { ok: true, text: cap(JSON.stringify(out)) };
    }
    const log = await this.d.world.auditLog(50);
    if (!log) return { ok: false, error: 'the audit log could not be read' };
    const out = log.slice(0, 50).map((e) => ({ action: e.action, executor: e.executorId, target: e.targetId, at: new Date(e.at).toISOString(), reason: e.reason ? redactText(e.reason, this.d.secrets ?? []).slice(0, 120) : null }));
    return { ok: true, text: cap(JSON.stringify(out)) };
  }

  /** Manual rollback of the last code change (24 h): a Bot Admin, judged live. */
  async codeRollback(userId: string): Promise<{ ok: boolean; lines: string[] }> {
    if (!this.d.code) return { ok: false, lines: ['code changes are off'] };
    const who = await this.authority(userId, false);
    if (!who.ok) return { ok: false, lines: [who.why] };
    if (who.tier !== 'bot_admin') return { ok: false, lines: ['rollback is for Bot Admins only'] };
    return this.d.code.rollback(userId);
  }

  /** `deploy_read` (status, logs): Bot Admin only, judged on the live member; the output is untrusted text for the caller to wrap. */
  async deployRead(userId: string, raw: unknown): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    if (!this.d.deploy) return { ok: false, error: 'VPS deploy is off: no deploy key is configured for the executor' };
    const who = await this.authority(userId, false);
    if (!who.ok) return { ok: false, error: who.why };
    if (who.tier !== 'bot_admin') return { ok: false, error: 'deploy reads are for Bot Admins only' };
    return this.d.deploy.read(userId, raw);
  }

  /** `welcome` config check for the main application (S14): roles and channel against the executor's live view. */
  async checkWelcome(roleIds: readonly string[], channelId: string | null): Promise<string | null> {
    const off = await this.readiness();
    if (off) return `server operations are off: ${off}`;
    // T9: a tier role is never a welcome default role.
    const tiers = await this.d.tiers().catch(() => null);
    if (!tiers) return 'the tier roles could not be read (refused to be safe)';
    for (const id of roleIds) {
      if (id === tiers.managerId || id === tiers.moderatorId) return `default role ${id}: it is a Manager or Moderator tier role`;
      const why = await welcomeRoleProblem(id, this.d.world, this.d.consts());
      if (why) return `default role ${id}: ${why}`;
    }
    if (channelId !== null) {
      const c = this.d.consts();
      if (c.deniedChannelIds.includes(channelId) || c.deniedCategoryIds.includes(channelId) || c.systemChannelIds.includes(channelId)) return 'the welcome channel is a protected or system channel';
      const ch = await this.d.world.channel(channelId);
      if (!ch) return 'the welcome channel could not be read';
      if (ch.parentId && (c.deniedChannelIds.includes(ch.parentId) || c.deniedCategoryIds.includes(ch.parentId))) return 'the welcome channel is in a protected category';
    }
    return null;
  }

  /** The kinds that count as destructive (exported for the service tests and the rate display). */
  static readonly DESTRUCTIVE = DESTRUCTIVE_KINDS;
  static parseOps(raw: unknown): ServerOp[] | null {
    const r = z.array(ServerOp).safeParse(raw);
    return r.success ? r.data : null;
  }
}

export type { PermOp };
