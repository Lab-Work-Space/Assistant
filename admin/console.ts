import { z } from 'zod';
import { canonical, type ConfigWrite } from '../config/store.js';
import { ConfigSchema, type ConfigKey } from '../config/schema.js';
import type { AdminCard, AdminCardRepo, AdminCardKind } from '../db/repos/adminCards.js';
import { ADMIN_FORBIDDEN_CMD_KEYS, CONFIG_CHANNEL_ID, ephemeral, configReply, type CommandDeps, type Reply } from '../discord/commands/types.js';
import { isError, type Item } from '../discord/commands/plans.js';
import type { DiscordPort } from '../discord/port.js';
import type { AuditFn } from '../governance/audit.js';
import { redactText } from '../core/logger.js';
import { renderCard, type CardItem, type Rendered } from './card.js';
import { ADMIN_CONFIG_KEYS, configRisk, isAdminConfigKey } from './keys.js';
import { AdminOp, planOp, type OpDeps } from './ops.js';
import type { ProposalRepo } from '../db/repos/knowledge.js';
import type { KnowledgeService } from '../knowledge/service.js';
import { skillCardItems } from '../skills/card.js';
import { renderBlock } from '../skills/render.js';
import { refusalText } from '../skills/validate.js';
import { SkillRefused, type SkillService } from '../skills/service.js';
import { cardKindMinTier, opsTierProblem, tierOf, tierTag, type Tier, type TierRoles } from '../discord/tiers.js';

/** Who proposed: the Bot Admin whose own message started the run (set by code from the message author, never from tool input). */
export interface Proposer {
  userId: string;
  /** The run read untrusted content (history from others, tool output): the card says so. */
  tainted: boolean;
  /** Which front end the proposal came through; names the actor in the audit (`user:<id> via <via>`). Default 'praw' (the model path). */
  via?: Via;
  /** Gate 1 S18: user ids the confirming admin named in the triggering message (`<@id>`, `<@!id>` or the raw id), parsed by code. Ban and kick need them; the panel passes the typed id. */
  namedIds?: readonly string[];
  /** Delegated tiers: the tier of the run's author as the router computed it from the message's member roles (code, never tool input). Absent = Bot Admin in #setting. A usability gate; the executor re-derives it (T1, T3). */
  tier?: Tier;
  /** The channel the run lives in (code). A tier proposal is accepted only in the configured mod room. */
  channelId?: string;
}

/** Gate 1 S37d/S46: the panel and the dashboard use this very console; there is no second write path. */
export type Via = 'praw' | 'panel' | 'dashboard';
export type Proposed = { ok: true; text: string; cardId?: string; items?: CardItem[] } | { ok: false; error: string };

/** The permission operations behind `perm_propose`; implemented in discord/perm/perm-service.ts (Part B). */
export interface PermPort {
  /** Fresh check: null when permission ops may run, else why they are off (shown to the model and in the boot alert). */
  readiness(): Promise<string | null>;
  propose(ops: unknown, ctx?: { userId: string; namedIds: readonly string[] }): Promise<{ ok: true; payload: unknown; items: CardItem[]; snapshot: unknown } | { ok: false; error: string }>;
  /** `refused`: a limit or the stale check stopped the whole card before anything ran. `done`: ops ran, stopping at the first failure. */
  apply(payload: unknown, snapshot: unknown, who: { userId: string; cardId: string; via?: 'praw' | 'panel' | 'dashboard' }): Promise<{ kind: 'refused'; why: string } | { kind: 'unknown'; why: string } | { kind: 'awaiting'; lines: string[] } | { kind: 'done'; ok: boolean; lines: string[]; applied: number; total: number }>;
  /** `discord_read` (S9, S10). */
  read(kind: 'roles' | 'channels' | 'members' | 'audit', args?: { roleId?: string | undefined; joinedAfter?: string | undefined }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

export interface ConsoleDeps {
  guildId: string;
  adminRoleId: string;
  cards: AdminCardRepo;
  cfg: { get: CommandDeps['cfg']['get']; setIf(w: ConfigWrite[], by: string): Promise<{ ok: true } | { ok: false; key: ConfigKey; reason: 'changed' | 'invalid' }> };
  cmd: CommandDeps;
  port: Pick<DiscordPort, 'post' | 'closeCard' | 'listGuildChannels'>;
  audit: AuditFn;
  log: { error(o: unknown, m?: string): void };
  secrets?: readonly string[];
  /** The hq application's user id (a card's message must have been posted by it). */
  hqUserId: () => string | undefined;
  /** G2-04: records the taint of the card message so later admin runs do not read hq's own cards as untrusted. */
  provenance?: { record(messageId: string, channelId: string, tainted: boolean, userId: string | null): Promise<void> };
  perms?: PermPort;
  /** Phase 2 server-management ops (channels, members, moderation, AutoMod, server settings, events): the executor's `server` family. */
  server?: PermPort;
  /** VPS deploy (Gate 1 V22): the executor's `deploy` family. Bot Admin cards in #setting only. */
  deploy?: PermPort;
  /** Self-code (Gate 1 self-code): the executor's `code` family. Bot Admin cards in #setting only; the proposer of the card is the one who will confirm it (OD-5). */
  code?: PermPort;
  /** Gate 1 S14: the live welcome check (executor for roles, Praw's own client for the send right). */
  welcome?: { check(roleIds: readonly string[], channelId: string | null): Promise<string | null> };
  /** T7-T10: the prospective `roles.*` values judged on the executor's live view; null = fine. Without it, `roles.*` cannot be changed. */
  tiers?: { check(next: { managerId: string | null; moderatorId: string | null; modRoomId: string | null }): Promise<string | null> };
  /** Self-knowledge: proposals wait in `proposals`; a Bot Admin turns one into a dashboard card (mintKnowledgeCard) and `knowledge.apply` runs it. */
  knowledge?: Pick<KnowledgeService, 'apply' | 'cardItems'>;
  proposals?: Pick<ProposalRepo, 'get' | 'attachCard' | 'releaseCard'>;
  /** SKILLS-1: review, bind and apply of a head's skill proposal (`mintSkillCard`, `applySkill`). Absent: skill cards are refused. */
  skills?: Pick<SkillService, 'review' | 'bindCard' | 'applyProposal' | 'releaseCard'>;
  /** Called after a card was applied (also a refused or failed one): the settings panel refreshes its live values (S37e). Never throws into the apply. */
  afterApply?: () => void;
}

export interface Click {
  cardId: string;
  action: 'confirm' | 'cancel';
  guildId: string | null;
  channelId: string | null;
  userId: string;
  memberRoleIds: readonly string[];
  messageId: string | null;
  messageAuthorId: string | null;
}

const ConfigChange = z.object({ key: z.string().min(1).max(64), value: z.unknown() }).strict();
export const ConfigProposal = z.object({ changes: z.array(ConfigChange).min(1).max(20), note: z.string().max(300).optional() }).strict();

type Applied = { outcome: string; title: string; lines: string[]; note: string };
/** T21: the audit actor carries the tier as evaluated by code at that step, as an anchored suffix (ids and enums only, never user text). */
/** The untagged form (`user:<id> via <via>`) stays what `config.updated_by` and the plan functions record. */
const byOf = (userId: string, via: Via = 'praw') => `user:${userId} via ${via}`;
const actorOf = (userId: string, via: Via = 'praw', tier: Tier = 'bot_admin') => `user:${userId} via ${via}${tierTag(tier)}`;
/** T20: a user's proposals into the mod room per 10 minutes. */
const MOD_PROPOSALS_PER_10M = 10;
const shortId = (id: string) => id.slice(0, 8);
const TTL_TEXT = '15 minutes';

const REFUSALS: Record<string, string> = {
  not_found: 'That card no longer exists.',
  not_pending: 'This card was already used.',
  expired: 'This card expired. Ask Praw to propose it again.',
  not_proposer: 'Only the admin whose request produced this card can use it.',
  wrong_channel: 'Use this card in the channel where it was posted.',
  wrong_message: 'This button does not belong to that card.',
  superseded: 'A newer proposal replaced this card.',
};

/**
 * The admin console (spec A/B; Gate 1 C4-C8, C21). `propose*` validate and store a card (one row, the validated ops) and post it as hq;
 * `click` is the only way a stored card turns into a change: the proposer presses Confirm, one conditional UPDATE consumes the card, and
 * the code applies the STORED ops under one process-wide lock after re-validating them against live state. The model is not involved
 * after the proposal.
 */
export class AdminConsole {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: ConsoleDeps) {
    for (const k of ADMIN_FORBIDDEN_CMD_KEYS) if (k in d.cmd) throw new Error('AdminConsole: cmd must not carry a human-only command group'); // G2-RL-09, G2-MCP-04
  }

  /** Serializes applies across admins (C7). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // ---- reads ----

  /** `config_get`: the allowed keys only (C13). Values and defaults as JSON; never env, provider keys or prompt overrides. */
  readConfig(keys: readonly ConfigKey[]): { key: string; value: unknown }[] {
    return keys.map((key) => ({ key, value: this.d.cmd.cfg.get(key) }));
  }

  /** `discord_read` (C10): the permission service reads the guild; without one the tool says so. */
  async readGuild(kind: 'roles' | 'channels' | 'members' | 'audit', args?: { roleId?: string | undefined; joinedAfter?: string | undefined }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    return this.d.perms ? this.d.perms.read(kind, args) : { ok: false, error: 'reading the guild is not available in this process' };
  }

  // ---- proposals ----

  /** G2A-08: a refused proposal is the signal of probing under injection; it is audited like every other outcome. */
  private async refused(p: Proposer, kind: string, r: Promise<Proposed>) {
    const out = await r;
    if (!out.ok) await this.d.audit({ actor: actorOf(p.userId, p.via, p.tier), action: 'admin.propose', tool: kind, outcome: `refused: ${out.error.replace(/\s+/g, ' ').slice(0, 120)}` });
    return out;
  }

  proposeConfig(p: Proposer, raw: unknown) {
    return this.refused(p, 'config', this.doProposeConfig(p, raw));
  }

  proposeOp(p: Proposer, raw: unknown, note?: string) {
    return this.refused(p, 'admin_op', this.doProposeOp(p, raw, note));
  }

  proposePerm(p: Proposer, raw: unknown, note?: string) {
    return this.refused(p, 'perm', this.doProposeExec(p, 'perm', raw, note));
  }

  /** Phase 2: channels, members, moderation, AutoMod, server settings and events. The same card path as every other family. */
  proposeServer(p: Proposer, raw: unknown, note?: string) {
    return this.refused(p, 'server', this.doProposeExec(p, 'server', raw, note));
  }

  /** VPS deploy: add, redeploy, remove, preview, publish_static. One operation per card; Bot Admin only (V22). */
  proposeDeploy(p: Proposer, raw: unknown, note?: string) {
    return this.refused(p, 'deploy', this.doProposeExec(p, 'deploy', [raw], note));
  }

  /** A finished dev job as a confirmation card. Called by the dev-job service, never by a model: `p.userId` is the user who will confirm (OD-5). */
  proposeCode(p: Proposer, raw: unknown, note?: string) {
    return this.refused(p, 'code', this.doProposeExec(p, 'code', [raw], note));
  }

  /** T3/T10: only a Bot Admin run (in #setting) proposes config, admin ops or permissions; a tier run is refused here whatever tool it reached. */
  private bypass(p: Proposer, what: string): Proposed | null {
    return p.tier && p.tier !== 'bot_admin' ? { ok: false, error: `${what} is for Bot Admins in #⚙️-setting; nothing was proposed` } : null;
  }

  /** T7-T10: a change to `roles.*` is judged by the executor on its live view, with the other tier keys as they would then be. */
  private async tierKeysProblem(changes: readonly { key: string; value: unknown }[]): Promise<string | null> {
    if (!changes.some((c) => c.key.startsWith('roles.'))) return null;
    if (!this.d.tiers) return 'the tier settings need the executor (LW Admin), which is not configured in this process';
    const pick = (k: 'roles.managerId' | 'roles.moderatorId' | 'roles.modRoomId'): string | null => {
      const c = changes.find((x) => x.key === k);
      return (c ? c.value : this.d.cmd.cfg.get(k)) as string | null;
    };
    return this.d.tiers.check({ managerId: pick('roles.managerId'), moderatorId: pick('roles.moderatorId'), modRoomId: pick('roles.modRoomId') });
  }

  private async doProposeConfig(p: Proposer, raw: unknown): Promise<Proposed> {
    const t = this.bypass(p, 'Config');
    if (t) return t;
    const parsed = ConfigProposal.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid proposal: ${z.prettifyError(parsed.error).slice(0, 400)}` };
    const { changes, note } = parsed.data;
    const seen = new Set<string>();
    const items: CardItem[] = [];
    const payload: { key: ConfigKey; value: unknown }[] = [];
    const old: Record<string, unknown> = {};
    for (const c of changes) {
      if (!isAdminConfigKey(c.key)) {
        const hint = c.key === 'halted' ? 'use /halt and /resume' : 'it is not a key the console may set directly; some keys go through admin_op_propose';
        return { ok: false, error: `config key "${c.key.slice(0, 64)}" is not allowed here (${hint}). Allowed: ${ADMIN_CONFIG_KEYS.join(', ')}` };
      }
      if (seen.has(c.key)) return { ok: false, error: `config key ${c.key} appears twice` };
      seen.add(c.key);
      const r = ConfigSchema[c.key].safeParse(c.value);
      if (!r.success) return { ok: false, error: `invalid value for ${c.key}: ${z.prettifyError(r.error).slice(0, 400)}` };
      const cur = this.d.cmd.cfg.get(c.key);
      old[c.key] = cur;
      payload.push({ key: c.key, value: r.data });
      items.push({ label: c.key, old: show(cur), neu: show(r.data), risk: configRisk(c.key, cur, r.data) });
    }
    const tierWhy = await this.tierKeysProblem(payload);
    if (tierWhy) return { ok: false, error: tierWhy };
    return this.post(p, 'config', { changes: payload }, { old }, items, note);
  }

  private async doProposeOp(p: Proposer, raw: unknown, note?: string): Promise<Proposed> {
    const t = this.bypass(p, 'This admin operation');
    if (t) return t;
    const parsed = AdminOp.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid op: ${z.prettifyError(parsed.error).slice(0, 400)}` };
    const plan = await planOp(parsed.data, await this.opDeps(p.userId, p.via));
    if (isError(plan)) return { ok: false, error: plan.error };
    const items: CardItem[] = plan.items.map((i: Item) => ({ ...i, risk: plan.risk }));
    return this.post(p, 'admin_op', { op: parsed.data }, { before: plan.before, items: plan.items }, items, note);
  }

  private async doProposeExec(p: Proposer, kind: 'perm' | 'server' | 'deploy' | 'code', raw: unknown, note?: string): Promise<Proposed> {
    const port = kind === 'perm' ? this.d.perms : kind === 'deploy' ? this.d.deploy : kind === 'code' ? this.d.code : this.d.server;
    const noun = kind === 'perm' ? 'permission' : kind === 'deploy' ? 'deploy' : kind === 'code' ? 'code' : 'server';
    if (kind === 'perm' || kind === 'deploy' || kind === 'code') {
      const t = this.bypass(p, kind === 'perm' ? 'Permission changes' : kind === 'code' ? 'Code changes' : 'Deploying');
      if (t) return t;
    }
    if (p.tier && p.tier !== 'bot_admin') {
      // The mod room front end: only in the configured room, and only a bounded number of cards per user (T20).
      const room = this.modRoom();
      if (!room || p.channelId !== room) return { ok: false, error: 'tier proposals are accepted only in the mod room' };
      if ((await this.d.cards.countRecent(p.userId, room, 10)) >= MOD_PROPOSALS_PER_10M) return { ok: false, error: `at most ${MOD_PROPOSALS_PER_10M} proposals per 10 minutes in the mod room` };
    }
    if (!port) return { ok: false, error: `${noun} operations are off: the executor (LW Admin) is not configured in this process (EXECUTOR_SOCKET)` };
    const off = await port.readiness();
    if (off) return { ok: false, error: `${noun} operations are off: ${off}` };
    const r = await port.propose(raw, { userId: p.userId, namedIds: p.namedIds ?? [] });
    if (!r.ok) return { ok: false, error: r.error };
    return this.post(p, kind, r.payload, r.snapshot, r.items.map((i) => (kind === 'perm' || kind === 'deploy' || kind === 'code' ? { ...i, risk: true } : i)), note);
  }

  private modRoom(): string | null {
    return this.d.cmd.cfg.get('roles.modRoomId');
  }

  private tierRoles(): TierRoles {
    return { botAdminRoleId: this.d.adminRoleId, managerId: this.d.cmd.cfg.get('roles.managerId'), moderatorId: this.d.cmd.cfg.get('roles.moderatorId') };
  }

  private async opDeps(by: string, via: Via = 'praw'): Promise<OpDeps> {
    return { cmd: this.d.cmd, by: byOf(by, via), channels: async () => this.d.port.listGuildChannels(), ...(this.d.welcome ? { welcome: this.d.welcome } : {}) };
  }

  /** Renders (validating the size), stores the card (older pending cards of this admin are superseded), posts it as hq. */
  private async post(p: Proposer, kind: AdminCardKind, payload: unknown, snapshot: unknown, items: CardItem[], note?: string): Promise<Proposed> {
    const title = kind === 'config' ? 'Config change' : kind === 'perm' ? 'Discord permission change' : kind === 'server' ? 'Server change' : kind === 'deploy' ? 'VPS deploy' : kind === 'code' ? 'Code change' : 'Admin change';
    const probe = renderCard({ id: '0'.repeat(32), proposerId: p.userId, title, items, tainted: p.tainted, note }, this.d.secrets);
    if ('error' in probe) return { ok: false, error: probe.error };
    const dash = p.via === 'dashboard';
    // T5: a tier run's card is created for the mod room and never for #setting; a Bot Admin run's card never for the mod room.
    const tiered = !!p.tier && p.tier !== 'bot_admin';
    const channelId = tiered ? this.modRoom() : CONFIG_CHANNEL_ID;
    if (!channelId || (tiered && kind !== 'server')) return { ok: false, error: 'the mod room is not configured' };
    // The dashboard shows the diff later from the stored row, so the code-rendered items ride in the snapshot (apply reads only its own keys).
    const stored = dash ? { ...(snapshot as object), display: items } : snapshot;
    const { card, superseded } = await this.d.cards.create({ proposerId: p.userId, kind, payload, snapshot: stored, tainted: p.tainted, channelId, ...(dash ? { origin: 'dashboard' as const } : {}), via: p.via ?? 'praw' });
    for (const s of superseded) {
      await this.releaseFor(s); // its proposal can get a fresh card
      await this.close(s, 'Superseded by a newer proposal.', 'superseded');
    }
    const rendered: Rendered = renderCard({ id: card.id, proposerId: p.userId, title, items, tainted: p.tainted, note }, this.d.secrets);
    if ('error' in rendered) {
      await this.d.cards.abandon(card.id).catch(() => undefined);
      return { ok: false, error: rendered.error };
    }
    if (dash) {
      // S46: the card lives in the table only; the dashboard shows the same code-rendered diff and its own Apply button.
      await this.d.audit({ actor: actorOf(p.userId, p.via), action: 'admin.propose', tool: kind, outcome: `card:${card.id}` });
      return { ok: true, text: `Card #${shortId(card.id)} is waiting for Apply (valid ${TTL_TEXT}).`, cardId: card.id, items };
    }
    try {
      const messageId = await this.d.port.post({ kind: 'head', dept: 'hq' }, { channelId }, rendered.payload);
      await this.d.cards.setMessage(card.id, messageId);
      // G2SK-01: a card that shows stored skill text (a skill_rollback's restored version, any skill op, any plain-text item) is never recorded as the admin's
      // console output: adminHistory ignores taint, so a recorded card would feed possibly head-written text back to the admin run as clean history.
      const opName = kind === 'admin_op' ? (payload as { op?: { op?: unknown } } | null)?.op?.op : undefined;
      const carriesSkillText = (typeof opName === 'string' && opName.startsWith('skill_')) || items.some((i) => i.plain !== undefined);
      if (!carriesSkillText) await this.d.provenance?.record(messageId, channelId, p.tainted, p.userId).catch(() => undefined);
    } catch (err) {
      this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'admin card post failed');
      await this.d.cards.abandon(card.id).catch(() => undefined);
      return { ok: false, error: 'the confirmation card could not be posted; nothing was proposed' };
    }
    await this.d.audit({ actor: actorOf(p.userId, p.via, p.tier), action: 'admin.propose', tool: kind, outcome: `card:${card.id}` });
    return { ok: true, cardId: card.id, items, text: `A confirmation card (#${shortId(card.id)}) was posted in the channel. NOTHING has changed yet: ${tiered ? 'the person who asked' : 'a Bot Admin'} must press Confirm within ${TTL_TEXT}. Tell the admin what you proposed; do not say it is done.` };
  }

  // ---- the click ----

  /** Gate 1 C5 in order; every refusal is ephemeral and audited. Delegated tiers: T4 (proposer-only in the mod room, tier from THIS click's roles), T5 (the card's own channel). */
  async click(c: Click): Promise<Reply> {
    // The tier of THIS click payload (never a cache or the roles at proposal time); informational for the audit, authority for the checks below.
    const clickTier = tierOf(c.memberRoleIds, this.tierRoles());
    const refuse = async (why: string, text: string): Promise<Reply> => {
      await this.d.audit({ actor: clickTier ? actorOf(c.userId, 'praw', clickTier) : `user:${c.userId} via praw`, action: 'admin.click', tool: c.action, outcome: `refused:${why} card:${c.cardId}${clickTier ? '' : ' (no tier role)'}` });
      return ephemeral(text);
    };
    if (c.guildId !== this.d.guildId) return refuse('guild', 'Not available here.');
    const stored = await this.d.cards.get(c.cardId);
    if (!stored) return refuse('not_found', REFUSALS.not_found!);
    // T5: a card is used only in the channel stored on it.
    if (c.channelId !== stored.channelId) return refuse('channel', stored.channelId === CONFIG_CHANNEL_ID ? 'Use this in #⚙️-setting.' : REFUSALS.wrong_channel!);
    let anyProposer = false;
    if (stored.channelId === CONFIG_CHANNEL_ID) {
      if (!this.d.adminRoleId || !c.memberRoleIds.includes(this.d.adminRoleId)) return refuse('role', 'Only Bot Admins can do this.');
    } else {
      // The mod room: server-family cards only, in the room that is configured now, by the proposer; a Bot Admin may cancel.
      const room = this.modRoom();
      if (!room || stored.channelId !== room || stored.kind !== 'server') return refuse('channel', 'This card does not belong to an active mod room.');
      if (!clickTier) return refuse('role', 'You no longer hold a Moderator, Manager or Bot Admin role.');
      if (c.action === 'confirm') {
        if (c.userId !== stored.proposerId) return refuse('not_proposer', REFUSALS.not_proposer!);
        const ops = (stored.payload as { ops?: unknown } | null)?.ops;
        const why = Array.isArray(ops) ? opsTierProblem(clickTier, ops as { kind: string }[]) : 'the card has no operations';
        if (why || cardKindMinTier(stored.kind) === 'bot_admin') return refuse('role', `Your role no longer allows this card: ${why ?? 'not a server card'}`);
      } else if (c.userId !== stored.proposerId) {
        if (clickTier !== 'bot_admin') return refuse('not_proposer', REFUSALS.not_proposer!);
        anyProposer = true;
      }
    }
    const hq = this.d.hqUserId();
    if (!hq || c.messageAuthorId !== hq) return refuse('author', 'This button does not belong to a card.');
    const got = await this.d.cards.consume(c.cardId, c.action === 'confirm' ? 'confirmed' : 'cancelled', c.userId, c.messageId, { channelId: stored.channelId, anyProposer });
    if (!got.ok) {
      if (got.reason === 'expired') await this.sweep();
      return refuse(got.reason, REFUSALS[got.reason] ?? 'This card cannot be used.');
    }
    const card = got.card;
    const tier: Tier = clickTier ?? 'bot_admin'; // always set here: the mod-room path needs a tier and the #setting path the Bot Admin role (checked above)
    if (c.action === 'cancel') {
      await this.releaseFor(card); // SK2: a cancelled skill card frees its proposal
      await this.d.audit({ actor: actorOf(c.userId, 'praw', tier), action: 'admin.card', tool: card.kind, outcome: `cancelled card:${card.id}` });
      await this.close(card, `Cancelled by <@${c.userId}>. Nothing changed.`);
      return ephemeral('Cancelled. Nothing changed.');
    }
    const result = await this.serial(() => this.apply(card, c.userId, card.via, tier)); // the real proposing front end (panel, dashboard or praw), stored on the card
    this.after();
    await this.d.cards.setOutcome(card.id, result.outcome);
    await this.close(card, result.note);
    return configReply(result.title, result.lines.join('\n') || result.note, { ephemeral: true });
  }

  /** Runs the stored ops of a consumed card. Any stale or refused check refuses the whole card (C7). */
  private async apply(card: AdminCard, userId: string, via: Via, tier: Tier = 'bot_admin'): Promise<Applied> {
    const actor = actorOf(userId, via, tier);
    const refuseCard = async (why: string): Promise<Applied> => {
      await this.d.audit({ actor, action: 'admin.card', tool: card.kind, outcome: `refused card:${card.id} ${why}` });
      return { outcome: `refused:${why}`.slice(0, 200), title: 'Refused', lines: [`Nothing was changed: ${why}`], note: `Confirmed by <@${userId}> but refused: ${why}. Nothing changed.` };
    };
    try {
      if (card.kind === 'config') return await this.applyConfig(card, userId, via, refuseCard);
      if (card.kind === 'admin_op') return await this.applyOp(card, userId, via, refuseCard);
      if (card.kind === 'knowledge') return await this.applyKnowledge(card, userId, via, refuseCard, tier);
      if (card.kind === 'skill') return await this.applySkill(card, userId, via, refuseCard, tier);
      // SK2: no fall-through: only the executor families reach the executor ports; any other kind is refused.
      if (card.kind === 'perm' || card.kind === 'server' || card.kind === 'deploy' || card.kind === 'code') return await this.applyExec(card, userId, via, refuseCard, tier);
      return await refuseCard('unknown card kind');
    } catch (err) {
      this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error'), card: card.id }, 'admin apply failed');
      await this.releaseFor(card).catch(() => undefined);
      await this.d.audit({ actor, action: 'admin.card', tool: card.kind, outcome: `failed card:${card.id}` });
      return { outcome: 'failed', title: 'Failed', lines: ['The change failed; it may be partly applied. Check the logs.'], note: `Confirmed by <@${userId}> but the apply failed. Check the logs.` };
    }
  }

  private async applyConfig(card: AdminCard, userId: string, via: Via, refuseCard: (w: string) => Promise<Applied>) {
    const stored = card.payload as { changes: { key: string; value: unknown }[] };
    const old = (card.snapshot as { old: Record<string, unknown> }).old;
    const writes: ConfigWrite[] = [];
    for (const c of stored.changes) {
      if (!isAdminConfigKey(c.key)) return refuseCard(`${c.key} is no longer an allowed key`);
      if (!ConfigSchema[c.key].safeParse(c.value).success) return refuseCard(`the value for ${c.key} is no longer valid`);
      writes.push({ key: c.key, value: c.value, expect: old[c.key] });
    }
    const tierWhy = await this.tierKeysProblem(stored.changes);
    if (tierWhy) return refuseCard(tierWhy);
    const r = await this.d.cfg.setIf(writes, byOf(userId, via));
    if (!r.ok) return refuseCard(r.reason === 'changed' ? `${r.key} changed since the proposal; ask again` : `the value for ${r.key} is not valid`);
    for (const w of writes) {
      await this.d.audit({ actor: actorOf(userId, via), action: 'config.set', tool: w.key, outcome: `ok card:${card.id} old=${show(w.expect)} new=${show(w.value)}` });
    }
    return this.applyDone(`${writes.length} setting${writes.length === 1 ? '' : 's'} changed`, writes.map((w) => `${w.key}: ${show(w.expect)} → ${show(w.value)}`), userId);
  }

  /** Knowledge cards are Bot Admin only and live on the dashboard: a click from anywhere else, or a tier run, never gets here. */
  private async applyKnowledge(card: AdminCard, userId: string, via: Via, refuseCard: (w: string) => Promise<Applied>, tier: Tier) {
    // Every exit that does not reach the service frees the proposal again: the card is spent, the proposal must not stay bound to it.
    const refuse = async (why: string) => {
      await this.d.proposals?.releaseCard(card.id);
      return refuseCard(why);
    };
    if (!this.d.knowledge) return refuse('knowledge changes are not available in this process');
    if (card.origin !== 'dashboard' || via !== 'dashboard' || tier !== 'bot_admin' || card.proposerId !== userId) return refuse('a knowledge card is applied by its own Bot Admin on the dashboard');
    const proposalId = Number((card.payload as { proposalId?: unknown } | null)?.proposalId);
    if (!Number.isInteger(proposalId)) return refuse('the card has no proposal');
    const r = await this.d.knowledge.apply(card.id, proposalId, userId);
    if (!r.ok) return refuseCard(r.why); // the service already marked the proposal stale or released it
    return this.applyDone('Knowledge changed', r.lines, userId);
  }

  /** One place that frees whatever proposal a card was bound to, for every way a card can end (SK2). */
  private async releaseFor(card: Pick<AdminCard, 'id' | 'kind'>): Promise<void> {
    if (card.kind === 'knowledge') await this.d.proposals?.releaseCard(card.id);
    if (card.kind === 'skill') await this.d.skills?.releaseCard(card.id);
  }

  /**
   * SK2/SK6: a skill card is applied only by its own Bot Admin, from the Discord card in #⚙️-setting (never the dashboard, never the mod room). The service
   * re-checks everything under lock and closes or reopens the proposal; every refusal here also releases it, so a stuck `card` row cannot block the skill.
   */
  private async applySkill(card: AdminCard, userId: string, via: Via, refuseCard: (w: string) => Promise<Applied>, tier: Tier) {
    const refuse = async (why: string) => {
      await this.releaseFor(card);
      return refuseCard(why);
    };
    if (!this.d.skills) return refuse('skills are not available in this process');
    if (card.origin !== 'discord' || card.channelId !== CONFIG_CHANNEL_ID || tier !== 'bot_admin' || via === 'dashboard' || card.proposerId !== userId) return refuse('a skill card is applied by its own Bot Admin on its card in #⚙️-setting');
    const proposalId = Number((card.payload as { proposalId?: unknown } | null)?.proposalId);
    const sha = (card.snapshot as { bodySha256?: unknown } | null)?.bodySha256;
    if (!Number.isInteger(proposalId) || typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return refuse('the card has no proposal');
    const r = await this.d.skills.applyProposal(card.id, proposalId, userId, sha);
    if (!r.ok) return refuse(r.why);
    return this.applyDone('Skill applied', r.lines, userId);
  }

  /**
   * SKILLS-1: a Bot Admin turns a waiting head proposal into the admin's OWN single-use card in #⚙️-setting (`/skill review`). The stored text is re-screened and
   * re-linted first; the card shows the proposed text in full or the mint is refused and the proposal stays open (SK7). The card message is NOT recorded in the
   * provenance table (SK3): head-written text must never re-enter the admin console history as the admin's clean output.
   */
  async mintSkillCard(userId: string, proposalId: number): Promise<{ ok: true; cardId: string; text: string } | { ok: false; error: string }> {
    const skills = this.d.skills;
    if (!skills) return { ok: false, error: 'skills are not available in this process' };
    const actor = actorOf(userId, 'panel');
    const rev = await skills.review(proposalId);
    if (!rev.ok) {
      await this.d.audit({ actor, action: 'skill.review', tool: `proposal:${proposalId}`, outcome: `refused:${rev.code}` });
      return { ok: false, error: refusalText(rev) };
    }
    const p = rev.proposal;
    const items = skillCardItems({
      kind: p.kind, skillId: p.skillId, version: rev.body.version, bytes: rev.bytes, dept: p.deptId, proposer: p.proposer,
      target: p.targetKind && p.targetId ? `${p.targetKind}:${p.targetId}` : '', attachments: rev.attachments, budget: rev.budget, reason: p.payload.reason, ...(p.aiReview ? { aiReview: p.aiReview } : {}), block: rev.block,
      ...(p.kind === 'edit' && rev.current ? { prevBlock: renderBlock({ id: p.skillId, version: rev.body.version, title: rev.current.title, instructions: rev.current.instructions, templates: rev.current.templates }) } : {}),
    });
    const title = 'Skill proposal';
    const probe = renderCard({ id: '0'.repeat(32), proposerId: userId, title, items, tainted: false }, this.d.secrets);
    if ('error' in probe) {
      await this.d.audit({ actor, action: 'skill.review', tool: `proposal:${p.id}`, outcome: 'refused:too_long' });
      return { ok: false, error: `${refusalText({ code: 'too_long' })} It does not fit on one card in full, so it cannot be confirmed; reject it with /skill reject ${p.id}. [too_long]` };
    }
    const { card, superseded } = await this.d.cards.create({ proposerId: userId, kind: 'skill', payload: { proposalId: p.id }, snapshot: { proposalId: p.id, baseVersion: p.baseVersion, bodySha256: rev.sha256, display: items }, tainted: false, channelId: CONFIG_CHANNEL_ID, origin: 'discord', via: 'panel' });
    for (const s of superseded) {
      await this.releaseFor(s);
      await this.close(s, 'Superseded by a newer proposal.', 'superseded');
    }
    if (!(await skills.bindCard(p.id, card.id, userId))) {
      await this.d.cards.abandon(card.id).catch(() => undefined);
      return { ok: false, error: 'That proposal is not waiting for a card any more.' };
    }
    const rendered = renderCard({ id: card.id, proposerId: userId, title, items, tainted: false }, this.d.secrets);
    if ('error' in rendered) {
      await this.d.cards.abandon(card.id).catch(() => undefined);
      await skills.releaseCard(card.id);
      return { ok: false, error: rendered.error };
    }
    try {
      const messageId = await this.d.port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, rendered.payload);
      await this.d.cards.setMessage(card.id, messageId); // no provenance record on purpose (SK3)
    } catch (err) {
      this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'skill card post failed');
      await this.d.cards.abandon(card.id).catch(() => undefined);
      await skills.releaseCard(card.id);
      return { ok: false, error: 'the confirmation card could not be posted; nothing was proposed' };
    }
    await this.d.audit({ actor, action: 'skill.review', tool: `proposal:${p.id}`, outcome: `card:${card.id}` });
    return { ok: true, cardId: card.id, text: `Card #${shortId(card.id)} for proposal #${p.id} was posted here. Nothing has changed: press Confirm within ${TTL_TEXT} after reading the full text.` };
  }

  private async applyOp(card: AdminCard, userId: string, via: Via, refuseCard: (w: string) => Promise<Applied>) {
    const op = AdminOp.safeParse((card.payload as { op: unknown }).op);
    if (!op.success) return refuseCard('the stored operation is no longer valid');
    // A fresh plan against live state: the same checks as at propose, so a newly denied channel or a changed list refuses here.
    const plan = await planOp(op.data, await this.opDeps(userId, via));
    if (isError(plan)) return refuseCard(plan.error);
    const snap = card.snapshot as { before: unknown; items?: unknown };
    if (canonical(plan.before) !== canonical(snap.before) || canonical(plan.items) !== canonical(snap.items)) return refuseCard('the setting or the target changed since the proposal; ask again');
    if (plan.writes.length) {
      const r = await this.d.cfg.setIf(plan.writes, byOf(userId, via));
      if (!r.ok) return refuseCard(r.reason === 'changed' ? `${r.key} changed since the proposal; ask again` : `the value for ${r.key} is not valid`);
    }
    try {
      await plan.run?.();
    } catch (e) {
      // SK9: a skill write that lost its compare-and-swap (or failed a re-check) wrote nothing: the card is refused with a fixed code, never with text.
      if (e instanceof SkillRefused) return refuseCard(`the skill change was refused (${e.code}); ask again`);
      throw e;
    }
    await this.d.audit({ actor: actorOf(userId, via), action: `admin.${op.data.op}`, tool: plan.audit.tool, ...(plan.audit.provider ? { provider: plan.audit.provider } : {}), ...(plan.audit.model ? { model: plan.audit.model } : {}), outcome: `ok card:${card.id} ${plan.items.map((i) => `old=${i.old} new=${i.neu}`).join('; ')}` });
    return this.applyDone('Change applied', plan.items.map((i) => `${i.label}: ${i.old} → ${i.neu}`), userId);
  }

  /** perm and server cards: the executor claims the confirmed row by id and re-runs every hard limit itself (S1, S2). */
  private async applyExec(card: AdminCard, userId: string, via: Via, refuseCard: (w: string) => Promise<Applied>, tier: Tier = 'bot_admin') {
    const port = card.kind === 'server' ? this.d.server : card.kind === 'deploy' ? this.d.deploy : card.kind === 'code' ? this.d.code : this.d.perms;
    if (!port) return refuseCard('these operations are not available');
    const r = await port.apply(card.payload, card.snapshot, { userId, cardId: card.id, via });
    if (r.kind === 'refused') return refuseCard(r.why);
    if (r.kind === 'awaiting') {
      // OD-G2-1: the executor asked the confirming admin a second time through LW Admin's own identity; only that click can apply the card.
      await this.d.audit({ actor: actorOf(userId, via, tier), action: 'admin.card', tool: card.kind, outcome: `awaiting_second card:${card.id}` });
      return { outcome: 'awaiting second confirmation', title: 'Second confirmation needed', lines: r.lines, note: `Confirmed by <@${userId}>: waiting for the second confirmation from LW Admin. Nothing has been done yet.` };
    }
    if (r.kind === 'unknown') {
      // G2SM-07: the call to the executor timed out. The executor's claim (executed_at) tells whether it ever started this card.
      const claimed = (await this.d.cards.get(card.id))?.executedAt ?? null;
      if (!claimed) return refuseCard('the executor did not take the card; nothing was changed');
      const why = `result unknown: the executor took card #${shortId(card.id)} but did not answer in time. Check #🧾-bot-log and the audit log before proposing it again`;
      await this.d.audit({ actor: actorOf(userId, via, tier), action: 'admin.card', tool: card.kind, outcome: `unknown card:${card.id}` });
      return { outcome: 'unknown', title: 'Result unknown', lines: [why], note: `Confirmed by <@${userId}> but the result is unknown. Check #🧾-bot-log and the audit log for card #${shortId(card.id)}.` };
    }
    const outcome = r.ok ? 'applied' : `failed:${r.applied}/${r.total}`;
    const noun = card.kind === 'server' ? 'server change' : card.kind === 'deploy' ? 'deploy request' : card.kind === 'code' ? 'code change' : 'permission change';
    await this.d.audit({ actor: actorOf(userId, via, tier), action: 'admin.card', tool: card.kind, outcome: `${outcome} card:${card.id}` });
    return {
      outcome, title: r.ok ? (card.kind === 'server' ? 'Server changed' : card.kind === 'deploy' ? 'Deploy queued' : card.kind === 'code' ? 'Code change applied' : 'Permissions changed') : card.kind === 'deploy' ? 'Deploy not queued' : card.kind === 'code' ? 'Code change not applied' : 'Stopped at the first failure', lines: r.lines,
      note: r.ok ? `Confirmed by <@${userId}>: ${r.applied} ${noun}${r.applied === 1 ? '' : 's'} applied.` : `Confirmed by <@${userId}>: ${r.applied} of ${r.total} applied, then stopped.`,
    };
  }

  private applyDone(title: string, lines: string[], userId: string): Applied {
    return { outcome: 'applied', title, lines, note: `Confirmed by <@${userId}>: applied.` };
  }

  private after(): void {
    try { this.d.afterApply?.(); } catch (err) { this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'after-apply hook failed'); }
  }

  /**
   * Gate 1 S46: the dashboard's Apply. The caller (the dashboard) has already re-checked the Bot Admin role live (S47). The card is consumed by the
   * same single-use UPDATE (origin dashboard, the session user's own, newest, unexpired) and the STORED ops run through the same `apply`:
   * same validation, compare-and-swap, hard limits and audit. Actor: `user:<id> via dashboard`.
   */
  async applyFromDashboard(cardId: string, userId: string): Promise<{ ok: true; title: string; lines: string[]; outcome: string } | { ok: false; why: string }> {
    if (!/^[0-9a-f]{32}$/.test(cardId)) return { ok: false, why: 'That card does not exist.' };
    const got = await this.d.cards.consumeDashboard(cardId, userId);
    if (!got.ok) {
      await this.d.audit({ actor: actorOf(userId, 'dashboard'), action: 'admin.apply', tool: 'dashboard', outcome: `refused:${got.reason} card:${cardId}` });
      return { ok: false, why: got.reason === 'wrong_message' ? 'That card was created in Discord; confirm it there.' : (REFUSALS[got.reason] ?? 'This card cannot be used.') };
    }
    const result = await this.serial(() => this.apply(got.card, userId, 'dashboard'));
    await this.d.cards.setOutcome(got.card.id, result.outcome);
    this.after();
    return { ok: true, title: result.title, lines: result.lines, outcome: result.outcome };
  }

  /**
   * Self-knowledge: the Bot Admin on the dashboard turns a waiting proposal into the admin's OWN single-use dashboard card (proposer-bound).
   * A tainted proposal needs the explicit review step first (K3). The proposal and card are bound both ways; apply re-checks everything.
   */
  async mintKnowledgeCard(userId: string, proposalId: number): Promise<{ ok: true; cardId: string } | { ok: false; error: string }> {
    const { knowledge, proposals } = this.d;
    if (!knowledge || !proposals) return { ok: false, error: 'knowledge changes are not available in this process' };
    const p = await proposals.get(proposalId);
    if (!p || p.status !== 'open') return { ok: false, error: 'That proposal is not waiting for a card.' };
    if (p.tainted && (p.reviewedBy !== userId || !p.reviewedAt)) return { ok: false, error: 'This proposal has tainted sources. Read them and press "I have read the sources" first.' };
    const items = await knowledge.cardItems(p);
    const { card, superseded } = await this.d.cards.create({ proposerId: userId, kind: 'knowledge', payload: { proposalId: p.id }, snapshot: { proposalId: p.id, display: items }, tainted: p.tainted, channelId: CONFIG_CHANNEL_ID, origin: 'dashboard', via: 'dashboard' });
    for (const s of superseded) {
      await this.releaseFor(s);
      await this.close(s, 'Superseded by a newer proposal.', 'superseded');
    }
    if (!(await proposals.attachCard(p.id, card.id))) {
      await this.d.cards.abandon(card.id).catch(() => undefined);
      return { ok: false, error: 'That proposal was taken by another card.' };
    }
    await this.d.audit({ actor: actorOf(userId, 'dashboard'), action: 'admin.propose', tool: 'knowledge', outcome: `card:${card.id} proposal:${p.id}` });
    return { ok: true, cardId: card.id };
  }

  /** The dashboard's Cancel for the session user's own pending dashboard card. */
  async cancelFromDashboard(cardId: string, userId: string): Promise<boolean> {
    if (!/^[0-9a-f]{32}$/.test(cardId)) return false;
    const ok = await this.d.cards.cancelDashboard(cardId, userId);
    if (ok) await this.d.proposals?.releaseCard(cardId);
    if (ok) await this.d.skills?.releaseCard(cardId).catch(() => undefined);
    if (ok) await this.d.audit({ actor: actorOf(userId, 'dashboard'), action: 'admin.card', tool: 'dashboard', outcome: `cancelled card:${cardId}` });
    return ok;
  }

  /** Removes the card's buttons and states how it ended; a missing message is not an error. */
  private async close(card: AdminCard, note: string, audit?: string): Promise<void> {
    if (audit) await this.d.audit({ actor: 'system:praw-admin', action: 'admin.card', tool: card.kind, outcome: `${audit} card:${card.id}` });
    if (!card.messageId) return;
    await this.d.port.closeCard(card.channelId, card.messageId, note).catch((err: unknown) => this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'closing an admin card failed'));
  }

  /** Marks overdue cards expired (audited) and closes their buttons. Also run on boot, so nothing pending outlives its time (C6). */
  async sweep(): Promise<number> {
    const expired = await this.d.cards.expireOverdue();
    for (const c of expired) {
      await this.releaseFor(c); // the proposal can get a fresh card
      await this.close(c, `Expired after ${TTL_TEXT}. Nothing changed.`, 'expired');
    }
    return expired.length;
  }
}

const show = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined'));
