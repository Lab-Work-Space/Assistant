import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { Calendar } from '../../company/calendar.js';
import { localDay } from '../../company/calendar.js';
import type { ConfigStore } from '../../config/store.js';
import type { AppEvents, EventBus } from '../../core/events.js';
import { IncidentError, type IncidentSink } from '../../core/incidents.js';
import type { ApproveError, OtRequest, OtRequestRepo, OtRevokeReason } from '../../db/repos/ot-requests.js';
import type { Task } from '../../db/repos/tasks.js';
import type { AuditFn } from '../audit.js';
import { maskReason } from '../approval/approvals.js';
import type { Halt } from '../halt.js';

/**
 * OT-1: overtime requests on off days. Code raises one request per task tree per day (from the scheduler's held-work notice; there is NO model
 * tool), a Bot Admin decides from a card in #setting, and an approved row is a grant for that one tree: each held start consumes one run.
 * The decision rests on the stored row (the custom id only points at it); scope comes from the stored root id. Nothing here widens a grant,
 * and every refusal or fault reads as "no overtime" (fail closed).
 */

/** What the scheduler holds for a tree right now, shown on the card (counts and department names only). */
export interface HeldSummary { tasks: number; depts: string[]; rollups: number; botTalk: number }

/** What the scheduler needs from overtime (it never sees the repository). */
export interface OtHook {
  /** Raises a request for the tree if the preconditions hold; true when a request is pending for it afterwards. `held` is read only if a card is made. */
  raise(root: Task, held: () => Promise<HeldSummary>): Promise<boolean>;
  /** Read only: a usable grant exists (every consume term). False on any fault. */
  usable(rootId: string): Promise<boolean>;
  /** One run of the grant, taken at the moment a held start begins. False when none is left (or any fault). */
  consume(rootId: string): Promise<boolean>;
}

type Cfg = Pick<ConfigStore, 'get'>;
type Log = { error(o: unknown, m?: string): void };
type Repo = Pick<OtRequestRepo, 'peek' | 'raise' | 'setCard' | 'endUnposted' | 'spentOf' | 'usable' | 'unexpired' | 'consume' | 'get' | 'approve' | 'deny' | 'claimDay' | 'unclaimDay' | 'revoke' | 'revokeAll' | 'closeMoot' | 'sweep'>;

export interface OtDeps {
  repo: Repo;
  cfg: Cfg;
  calendar: Calendar;
  halt: Pick<Halt, 'isHalted'>;
  bus: Pick<EventBus<AppEvents>, 'emit'>;
  clock: () => number;
  /** The #setting channel id: the only place a card is posted, and the only channel where "whole day" is accepted. */
  configChannelId: string;
  secrets: readonly string[];
  audit: AuditFn;
  log: Log;
  incidents?: IncidentSink;
  tasks: { get(id: string): Promise<Task | null> };
  /** Card builders (the Discord embed layer's `otRequestPayload` / `otGrantedPayload` / `otGrantedNote`; injected so governance never imports it). */
  render: {
    request(v: CardView, secrets: readonly string[]): OutboundPayload;
    granted(v: CardView, g: { by: string; until: Date; runsUsed: number; maxRuns: number; maxUsd: number }, secrets: readonly string[]): OutboundPayload;
  };
  ports: {
    /** Posts the request card (hq head, #setting); returns where it went. */
    postCard(payload: OutboundPayload): Promise<{ channelId: string; messageId: string }>;
    /** Re-renders a card in place (false when it is gone). */
    editCard(channelId: string, messageId: string, payload: OutboundPayload): Promise<boolean>;
    /** Ends a card in place: its buttons go, `note` is its text. */
    closeCard(channelId: string, messageId: string, note: string): Promise<void>;
    /** A plain chat line in the task tree's root thread (code-written text only). */
    threadLine(root: Task, text: string): Promise<void>;
  };
}

/** What the card shows (see discord/embeds/approval.ts OtCardView; structurally the same). */
export interface CardView {
  id: number; digest: string; rootId: string; rootTitle: string; threadId: string | null; requestedBy: string;
  held: HeldSummary; spentUsd: number; until: Date; maxRuns: number; maxUsd: number;
}

export type OtDecideError = ApproveError | 'halted_after_commit' | 'day_failed' | 'ended' | 'disabled';
export type OtDecided = { ok: true; row: OtRequest } | { ok: false; error: OtDecideError; row?: OtRequest; text?: string };
export type OpenDay = (date: string, userId: string) => Promise<{ ok: true } | { ok: false; error: string; already?: boolean }>;

const HUMAN_ORIGINS = ['chat', 'slash', 'voice'];
const SEEN_MAX = 1000;

const mention = (id: string | null | undefined) => (id && /^[0-9]{17,20}$/.test(id) ? `<@${id}>` : 'a Bot Admin');
/** A database fault reduced to a fixed text (OT-C15): the SQLSTATE code at most, never a title or thread content. */
const codeOf = (err: unknown): string => { const c = (err as { code?: unknown } | null)?.code; return typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c) ? c : 'error'; };

export class OtService implements OtHook {
  private readonly capAlerted = new Set<string>();
  private readonly exhausted = new Set<number>();

  constructor(private readonly d: OtDeps) {}

  private today(): string { return localDay(this.d.clock(), this.d.cfg.get('schedule.timezone')).date; }
  private enabled(): boolean { try { return this.d.cfg.get('ot.enabled') === true; } catch { return false; } }
  private incident(stage: string, err: unknown): void {
    try { this.d.incidents?.report({ source: 'overtime', stage, err }); } catch { /* reporting never throws */ }
  }
  private async safe(what: string, fn: () => Promise<unknown>): Promise<void> {
    try { await fn(); } catch (err) { this.d.log.error({ errName: err instanceof Error ? err.name : 'error', code: codeOf(err) }, `overtime: ${what} failed`); }
  }

  // ---- what the scheduler uses ----------------------------------------------------------------------------------------------------------

  usable(rootId: string): Promise<boolean> { return this.d.repo.usable(rootId, this.today()); }

  /** The end of the tree's grant of today (any grant not revoked or expired, whatever is left of its runs), or null. For create_task's reply. */
  async until(rootId: string): Promise<Date | null> { return (await this.d.repo.unexpired(rootId, this.today()))?.grantExpiresAt ?? null; }

  async consume(rootId: string): Promise<boolean> {
    const day = this.today();
    const r = await this.d.repo.consume(rootId, day);
    if (r.ok) {
      if (r.runsUsed >= r.maxRuns) await this.noteExhausted(r.id, `runs ${r.runsUsed}/${r.maxRuns}`);
      return true;
    }
    if (r.why === 'exhausted') {
      const g = await this.d.repo.unexpired(rootId, day).catch(() => null);
      if (g) await this.noteExhausted(g.id, 'runs or spend');
    }
    return false;
  }

  /** ot.exhausted, once per grant. */
  private async noteExhausted(id: number, what: string): Promise<void> {
    if (this.exhausted.has(id)) return;
    if (this.exhausted.size >= SEEN_MAX) this.exhausted.clear();
    this.exhausted.add(id);
    await this.safe('audit exhausted', () => this.d.audit({ actor: 'system', action: 'ot.exhausted', taskId: null, outcome: `grant #${id} ${what}` }));
  }

  async raise(root: Task, held: () => Promise<HeldSummary>): Promise<boolean> {
    try {
      return await this.raiseInner(root, held);
    } catch (err) {
      this.incident('raise', new IncidentError('ot_raise_failed', `an overtime request could not be raised (${codeOf(err)})`, 'Check the database; the off-day notice is still sent.'));
      return false;
    }
  }

  private async raiseInner(root: Task, held: () => Promise<HeldSummary>): Promise<boolean> {
    const { cfg, repo } = this.d;
    if (!this.enabled() || this.d.halt.isHalted() || !this.d.calendar.isOffDay(this.d.clock()).off) return false;
    if (!HUMAN_ORIGINS.includes(root.origin) || !root.threadId) return false;
    const person = root.requester.kind === 'human' ? root.requester.userId : root.sourceUserId;
    if (!person) return false;
    const tz = cfg.get('schedule.timezone');
    const peek = await repo.peek(root.id, this.today());
    // A pending row with no card is an orphan (the post worked but its id was never stored): it blocks a second card until midnight and cannot be decided, so it
    // is not a request a Bot Admin can see: no "request sent" line (OT-C11).
    if (peek.pending) return !peek.orphan;
    if (peek.usable || peek.denied || peek.today >= cfg.get('ot.requestsPerRootPerDay')) return false;
    const r = await repo.raise({ rootId: root.id, requestedBy: person, tz, perRoot: cfg.get('ot.requestsPerRootPerDay'), perDay: cfg.get('ot.requestsPerDay'), perPerson: cfg.get('ot.requestsPerPersonPerDay') });
    for (const c of r.expired) await this.safe('close stale card', () => this.d.ports.closeCard(c.channelId, c.messageId, 'This OT request expired: the day it was for has ended.'));
    if (!r.ok) {
      if (r.why === 'cap_day' || r.why === 'cap_person') this.capIncident(r.why);
      return r.why === 'pending';
    }
    const row = r.row;
    const hours = cfg.get('ot.hours');
    const view: CardView = {
      id: row.id, digest: row.digest, rootId: root.id, rootTitle: maskReason(root.title, this.d.secrets), threadId: root.threadId, requestedBy: person,
      held: await held().catch(() => ({ tasks: 0, depts: [], rollups: 0, botTalk: 0 })), spentUsd: await repo.spentOf(root.id).catch(() => 0),
      until: new Date(Math.min(this.d.clock() + hours * 3_600_000, row.expiresAt.getTime())), maxRuns: cfg.get('ot.maxRuns'), maxUsd: cfg.get('ot.maxUsd'),
    };
    let posted: { channelId: string; messageId: string };
    try {
      posted = await this.d.ports.postCard(this.d.render.request(view, this.d.secrets));
    } catch (err) {
      // OT-C11: the row is ended, never deleted: it still counts toward the caps, so a failing channel cannot be retried without bound
      await this.safe('end unposted request', () => repo.endUnposted(row.id));
      this.incident('card post', new IncidentError('ot_card_failed', `an overtime request card could not be posted (${codeOf(err)})`, 'Check the bot permissions in #setting.'));
      return false;
    }
    let stored = false;
    try { stored = await repo.setCard(row.id, posted.channelId, posted.messageId); } catch { stored = false; }
    if (!stored) {
      // The card exists but the row cannot point at it. The row stays PENDING with no card: it counts toward the caps and, through the one-pending index, blocks
      // a second card until the day ends (OT-C11); the handler refuses it (no stored card). The orphan card loses its buttons (this port never deletes messages).
      await this.safe('close orphan card', () => this.d.ports.closeCard(posted.channelId, posted.messageId, 'This OT request could not be recorded; it cannot be decided.'));
      this.incident('card store', new IncidentError('ot_card_unrecorded', 'an overtime request card was posted but its message id could not be stored', 'Check the database; that request cannot be decided and lapses at midnight, and no second card is made today.'));
      return false;
    }
    await this.safe('audit request', () => this.d.audit({ actor: 'system', action: 'ot.request', taskId: root.id, outcome: `request #${row.id} seq ${row.seq}` }));
    return true;
  }

  /** A daily cap was hit: one #bot-log incident per day and kind, no card. */
  private capIncident(why: 'cap_day' | 'cap_person'): void {
    const key = `${this.today()}:${why}`;
    if (this.capAlerted.has(key)) return;
    if (this.capAlerted.size >= SEEN_MAX) this.capAlerted.clear();
    this.capAlerted.add(key);
    this.incident('daily cap', new IncidentError('ot_cap', why === 'cap_day' ? 'the daily limit of overtime requests was reached; no more cards are made today' : 'one person reached the daily limit of overtime requests; no more cards are made for them today', 'Raise ot.requestsPerDay or ot.requestsPerPersonPerDay in the database if this is expected.'));
  }

  // ---- decisions (the buttons) ----------------------------------------------------------------------------------------------------------

  private async rootOf(row: OtRequest): Promise<Task | null> { return this.d.tasks.get(row.rootId).catch(() => null); }

  /** The card of a row, as it was posted (for the in-place edits). */
  private async view(row: OtRequest, root: Task | null, note: { until: Date; by: string }): Promise<CardView> {
    const cfg = this.d.cfg;
    return {
      id: row.id, digest: row.digest, rootId: row.rootId, rootTitle: maskReason(root?.title ?? row.rootId, this.d.secrets), threadId: root?.threadId ?? null,
      requestedBy: row.requestedBy, held: { tasks: 0, depts: [], rollups: 0, botTalk: 0 }, spentUsd: await this.d.repo.spentOf(row.rootId).catch(() => 0),
      until: note.until, maxRuns: row.maxRuns ?? cfg.get('ot.maxRuns'), maxUsd: row.maxUsd ?? cfg.get('ot.maxUsd'),
    };
  }

  /** Approve OT (action `approve`) or Deny. `c.channelId` / `c.messageId` are those of the clicked message (null when Discord gave none). */
  async decide(c: { id: number; digest: string; action: 'approve' | 'deny'; userId: string; channelId: string | null; messageId: string | null }): Promise<OtDecided> {
    const card = { digest: c.digest, messageId: c.messageId, channelId: c.channelId, userId: c.userId };
    if (c.action === 'deny') return this.deny(c.id, card);
    const { cfg, repo } = this.d;
    const r = await repo.approve({
      id: c.id, ...card, tz: cfg.get('schedule.timezone'), hours: cfg.get('ot.hours'), maxRuns: cfg.get('ot.maxRuns'), maxUsd: cfg.get('ot.maxUsd'),
      gates: { offDay: () => this.d.calendar.isOffDay(this.d.clock()).off, halted: () => this.d.halt.isHalted(), enabled: () => this.enabled() },
    });
    if (!r.ok) {
      await this.staleCard(r.error, c);
      return { ok: false, error: r.error };
    }
    const row = r.row;
    await this.closeRevoked(r.superseded, 'a newer approval replaced it', c.userId);
    // A halt that landed between the commit and here: the grant is revoked at once and nothing is released (OT-C16; the halt hooks also revoke every grant).
    if (this.d.halt.isHalted()) {
      await this.safe('revoke after halt', () => repo.revoke(row.id, 'system', 'halt'));
      await this.safe('audit approve', () => this.d.audit({ actor: `user:${c.userId}`, action: 'ot.approve', taskId: row.rootId, outcome: `ok #${row.id} halted_after_commit` }));
      await this.safe('close card', () => this.d.ports.closeCard(row.cardChannelId!, row.cardMessageId!, `OT request #${row.id} was approved but a halt landed, so it was revoked.`));
      return { ok: false, error: 'halted_after_commit', row };
    }
    await this.safe('audit approve', () => this.d.audit({ actor: `user:${c.userId}`, action: 'ot.approve', taskId: row.rootId, outcome: `ok #${row.id} runs ${row.maxRuns} usd ${row.maxUsd}` }));
    // rootId from the committed row, never from the custom id (OT-C16)
    await this.safe('emit approved', () => this.d.bus.emit('ot.approved', { rootId: row.rootId }));
    const root = await this.rootOf(row);
    await this.safe('edit card', async () => {
      const view = await this.view(row, root, { until: row.grantExpiresAt!, by: c.userId });
      await this.d.ports.editCard(row.cardChannelId!, row.cardMessageId!, this.d.render.granted(view, { by: c.userId, until: row.grantExpiresAt!, runsUsed: 0, maxRuns: row.maxRuns!, maxUsd: row.maxUsd! }, this.d.secrets));
    });
    if (root) await this.safe('thread line', () => this.d.ports.threadLine(root, `✅ อนุมัติ OT ถึง ${hhmm(row.grantExpiresAt!, cfgTz(this.d.cfg))}`));
    return { ok: true, row };
  }

  private async deny(id: number, card: { digest: string; messageId: string | null; channelId: string | null; userId: string }): Promise<OtDecided> {
    const r = await this.d.repo.deny({ id, ...card });
    if (!r.ok) {
      await this.staleCard(r.error, { id, ...card });
      return { ok: false, error: r.error };
    }
    const row = r.row;
    await this.safe('audit deny', () => this.d.audit({ actor: `user:${card.userId}`, action: 'ot.deny', taskId: row.rootId, outcome: `ok #${row.id}` }));
    await this.safe('close card', () => this.d.ports.closeCard(row.cardChannelId!, row.cardMessageId!, `OT request #${row.id} denied by ${mention(card.userId)}. The work starts on the next workday.`));
    const root = await this.rootOf(row);
    if (root) await this.safe('thread line', () => this.d.ports.threadLine(root, 'งานจะเริ่มวันทำงานถัดไป'));
    return { ok: true, row };
  }

  /** "Make today a workday": the claim (one conditional UPDATE, OT-C6), then `openDay(row.localDay)`; the row's own day, never "today". */
  async decideDay(c: { id: number; digest: string; userId: string; channelId: string | null; messageId: string | null }, openDay: OpenDay): Promise<OtDecided> {
    const card = { digest: c.digest, messageId: c.messageId, channelId: c.channelId, userId: c.userId };
    const r = await this.d.repo.claimDay({ id: c.id, ...card, tz: this.d.cfg.get('schedule.timezone'), configChannelId: this.d.configChannelId });
    if (!r.ok) {
      await this.staleCard(r.error, { id: c.id, ...card });
      return { ok: false, error: r.error };
    }
    const row = r.row;
    let opened: Awaited<ReturnType<OpenDay>>;
    try {
      opened = await openDay(row.localDay, c.userId);
    } catch {
      opened = { ok: false, error: 'The workday could not be saved.' };
    }
    if (!opened.ok && opened.already !== true) {
      await this.safe('give the claim back', () => this.d.repo.unclaimDay(row.id));
      return { ok: false, error: 'day_failed', text: opened.error };
    }
    await this.safe('audit workday', () => this.d.audit({ actor: `user:${c.userId}`, action: 'ot.workday', taskId: row.rootId, outcome: `ok #${row.id} day ${row.localDay}` }));
    await this.safe('close card', () => this.d.ports.closeCard(row.cardChannelId!, row.cardMessageId!, `OT request #${row.id}: ${mention(c.userId)} made today a workday for all work.`));
    return { ok: true, row };
  }

  /** Revoke OT: only on that grant's own card (its stored message), by a Bot Admin the guard already checked. */
  async revoke(c: { id: number; digest: string; userId: string; channelId: string | null; messageId: string | null }): Promise<OtDecided> {
    const row = await this.d.repo.get(c.id).catch(() => null);
    if (!row) return { ok: false, error: 'not_found' };
    if (!c.messageId || !c.channelId || !row.cardMessageId || row.digest !== c.digest || row.cardMessageId !== c.messageId || row.cardChannelId !== c.channelId) return { ok: false, error: 'wrong_card' };
    if (row.status !== 'approved') return { ok: false, error: 'not_pending' };
    const done = await this.d.repo.revoke(row.id, c.userId, 'admin');
    if (!done) return { ok: false, error: 'ended' };
    await this.safe('audit revoke', () => this.d.audit({ actor: `user:${c.userId}`, action: 'ot.revoke', taskId: row.rootId, outcome: `admin #${row.id}` }));
    await this.safe('close card', () => this.d.ports.closeCard(row.cardChannelId!, row.cardMessageId!, `OT revoked by ${mention(c.userId)}. A run already started finishes.`));
    return { ok: true, row: done };
  }

  /** An expired or moot click closes its card in place (the card is the clicked message, already matched to the stored one). */
  private async staleCard(error: ApproveError, c: { id: number; channelId: string | null; messageId: string | null }): Promise<void> {
    if ((error !== 'expired' && error !== 'moot') || !c.channelId || !c.messageId) return;
    const channelId = c.channelId;
    const messageId = c.messageId;
    await this.safe('close stale card', () => this.d.ports.closeCard(channelId, messageId, error === 'moot' ? `OT request #${c.id}: today is already a workday.` : `OT request #${c.id}: the day it was for has ended.`));
  }

  // ---- ends and revokes -----------------------------------------------------------------------------------------------------------------

  /** Today became a workday (OffDayWatch): every pending request is moot and its card is closed. */
  async closeMoot(): Promise<void> {
    const cards = await this.d.repo.closeMoot();
    for (const c of cards) await this.safe('close moot card', () => this.d.ports.closeCard(c.channelId, c.messageId, 'OT request: today is a workday now, so no overtime is needed.'));
    if (cards.length) await this.safe('audit moot', () => this.d.audit({ actor: 'system', action: 'ot.moot', taskId: null, outcome: `n=${cards.length}` }));
  }

  /** The timer sweep: pending requests past their expiry end, a grant on an ended tree is revoked `root_ended`; their cards are closed. */
  async sweep(): Promise<void> {
    const s = await this.d.repo.sweep();
    for (const c of s.expired) await this.safe('close expired card', () => this.d.ports.closeCard(c.channelId, c.messageId, 'OT request expired: the day it was for has ended.'));
    if (s.expired.length) await this.safe('audit expire', () => this.d.audit({ actor: 'system', action: 'ot.expire', taskId: null, outcome: `n=${s.expired.length}` }));
    for (const g of s.ended) {
      await this.safe('audit root ended', () => this.d.audit({ actor: 'system', action: 'ot.revoke', taskId: g.rootId, outcome: `root_ended #${g.id}` }));
      if (g.cardChannelId && g.cardMessageId) await this.revokedCard(g, 'the task tree ended');
    }
  }

  /** Every grant ends (halt, resume, the switch turned off). The repository throws on a fault (a halt revoke is then owed); the cards are closed best effort. */
  async revokeAll(reason: OtRevokeReason, by = 'system'): Promise<number> {
    const rows = await this.d.repo.revokeAll(reason, by);
    await this.closeRevoked(rows, reason === 'halt' ? 'the company was halted' : 'overtime was switched off', by);
    return rows.length;
  }

  /**
   * G2OT-01: audits and closes the cards of grants that were revoked outside the service (the repository's own halt revoke, the boot revoke, a supersede), so no
   * card keeps showing "approved" with a Revoke button. Best effort: never throws.
   */
  async closeRevoked(rows: readonly OtRequest[], why: string, by = 'system'): Promise<void> {
    for (const g of rows) {
      await this.safe('audit revoke', () => this.d.audit({ actor: by === 'system' ? 'system' : `user:${by}`, action: 'ot.revoke', taskId: g.rootId, outcome: `${g.revokeReason ?? 'revoked'} #${g.id}` }));
      if (g.cardChannelId && g.cardMessageId) await this.revokedCard(g, why);
    }
  }

  private async revokedCard(g: OtRequest, why: string): Promise<void> {
    const channelId = g.cardChannelId!;
    const messageId = g.cardMessageId!;
    await this.safe('close revoked card', () => this.d.ports.closeCard(channelId, messageId, `OT #${g.id} ended: ${why}. A run already started finishes (a halt aborts it).`));
  }
}

const cfgTz = (cfg: Cfg): string => cfg.get('schedule.timezone');
const hhmm = (d: Date, tz: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
