import { z } from 'zod';
import type { OutboundPayload } from '../agents/loop/payload.js';
import { localDay } from '../company/calendar.js';
import type { ActorRef } from '../company/types.js';
import type { ConfigStore } from '../config/store.js';
import type { AppEvents, EventBus } from '../core/events.js';
import type { AdoptCode, Project, ProjectRepo, ProjectRow } from '../db/repos/projects.js';
import type { Task, TaskRepo } from '../db/repos/tasks.js';
import { escapeCardText } from '../discord/embeds/approval.js';
import { screenText } from '../knowledge/screen.js';
import { dueOk } from '../tools/builtin/createTask.js';

/**
 * AUTO-1 BE2 (SA-1 3.2, 3.5, 3.6, 5.3; Gate 1 AP-C9, AP-C11..C14): the project service. The one Bot Admin confirmation (the card and its buttons), the budget notice, the
 * lifecycle commands, the root-end sync and the deadline notice. The audit rows are written by ProjectRepo in its own transactions; nothing is audited twice here.
 * Nothing here logs model text: only `errName`. Card text built from model text goes through `escapeCardText` with the literal secrets.
 */

export const PROJECT_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `project_propose` input (SA-1 3.2). Strict: an unknown key is refused by the registry before the tool runs. */
export const ProjectProposeInput = z.object({
  title: z.string().trim().min(1).max(100),
  goal: z.string().trim().min(1).max(1000),
  deadline: z.string().regex(PROJECT_DATE),
  budget: z.object({ maxLocalCalls: z.number().int().min(1).max(100_000), maxUsd: z.number().min(0).max(1000) }).strict(),
  adopt: z.array(z.string().regex(/^[0-9a-f-]{8,36}$/)).max(20).optional(),
  /** R7 PLUGIN-FORGE: link an open, untainted tool idea; the project then builds it as a plugin (a Bot Admin still approves the project, the build and the install). */
  toolIdea: z.number().int().min(1).max(1_000_000_000).optional(),
}).strict();
export type ProjectProposeInput = z.infer<typeof ProjectProposeInput>;

/** The text the Bot Admin consents to, VERBATIM from SA-1 3.2 (a test binds it). */
export const AUTOPILOT_CARD_TEXT =
  'If you approve, inside this project only: calls that need approval run without a card, except destructive, sensitive, admin, deploy, config, money/tax/offer document, cost or long-lived, and unknown tools (these still ask a Bot Admin); calls that look like they carry data out are refused; tool requests from heads are granted to this project only; bots decide instead of asking you; spend stops at the budget and you get one notice.';

export type ProposeCode = 'not_ceo' | 'halted' | 'off' | 'invalid' | 'screen' | 'deadline' | 'open_cap' | 'duplicate' | 'forge_off' | 'idea_invalid' | 'idea_busy' | 'forge_cap' | 'exception';
export const PROPOSE_TEXT: Record<ProposeCode, string> = {
  not_ceo: 'Only the CEO can propose a project.',
  halted: 'The company is halted; try again after /resume.',
  off: 'Autopilot is switched off; projects cannot be proposed.',
  invalid: 'The project fields are out of range (title 1-100, goal 1-1000, usd 0-1000, calls 1-100000, adopt up to 20 ids of 8 to 36 hex characters).',
  screen: 'The title or goal was refused (a secret-like value or control characters).',
  deadline: 'deadline must be a date from today to one year ahead',
  open_cap: 'There are already 3 project proposals waiting for a decision.',
  duplicate: 'A project with that title is already waiting for a decision.',
  forge_off: 'The plugin forge is switched off.',
  idea_invalid: 'That tool idea is not open or was filed by a run that read outside content.',
  idea_busy: 'That tool idea already has a forge.',
  forge_cap: 'There are already 3 forges in progress.',
  exception: 'That could not be done now; nothing was changed.',
};
export type Proposed = { ok: true; id: number; text: string; cardOk: boolean } | { ok: false; code: ProposeCode; error: string };

export type DecideCode = 'wrong_card' | 'not_pending' | 'expired' | 'halted' | 'off' | 'not_found' | 'not_active' | 'not_exhausted' | 'raise_max' | 'unchanged_paused' | 'unchanged_running' | 'exception';
export const DECIDE_TEXT: Record<DecideCode, string> = {
  wrong_card: 'That button does not belong to this card.',
  not_pending: 'Already decided.',
  expired: 'This proposal has expired.',
  halted: 'The company is halted; try again after /resume.',
  off: 'Autopilot is switched off.',
  not_found: 'No project with that number.',
  not_active: 'That project is not active.',
  not_exhausted: "That project's budget is not used up.",
  raise_max: 'This project cannot be raised further.',
  unchanged_paused: 'That project is already paused.',
  unchanged_running: 'That project is not paused.',
  exception: 'That could not be done now; nothing was changed.',
};
export type CardDecided =
  | { ok: true; result: 'approved'; project: Project; root: Task; adopted: number; skipped: string[] }
  | { ok: true; result: 'rejected'; project: Project }
  | { ok: false; code: DecideCode; text: string };
export type BudgetDecided = { ok: true; result: 'raised' | 'closed'; project: Project; unblocked: number } | { ok: false; code: DecideCode; text: string };
export type Cmd = { ok: true; text: string } | { ok: false; code: DecideCode; text: string };

export interface ProjectServiceDeps {
  repo: Pick<ProjectRepo, 'create' | 'setCard' | 'setBudgetCard' | 'reject' | 'expire' | 'decide' | 'getByToken' | 'getByBudgetToken' | 'getRow' | 'byRoot' | 'list' | 'raise' | 'setPaused' | 'close' | 'rootEnded' | 'exhaust' | 'deadlineOwed' | 'claimDeadlineNotice' | 'extend' | 'projectOf'>;
  cfg: Pick<ConfigStore, 'get'>;
  tasks: Pick<TaskRepo, 'get' | 'update'>;
  bus: Pick<EventBus<AppEvents>, 'emit'>;
  halted: () => boolean;
  secrets: readonly string[];
  configChannelId: string;
  /** Posts the card as hq in #setting and returns the message id (throws when it cannot). */
  postCard: (p: OutboundPayload) => Promise<string>;
  closeCard: (channelId: string, messageId: string, note: string) => Promise<void>;
  /** `Scheduler.notifyHead`: code text only. */
  notifyHead: (dept: string, text: string) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
  now?: () => number;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');
const id8 = (id: string): string => id.slice(0, 8);
const fold = (s: string): string => s.replace(/\s+/g, ' ').trim();
const usd = (n: unknown): string => Number(n).toFixed(2);
const SETTLED = ['done', 'cancelled'];
const BAD_ADOPT = /^[0-9a-f-]{8,36}$/;

/** `/project start` input as the command passes it (the raw adopt string is split here). */
export type StartInput = { userId: string; title: string; goal: string; deadline: string; usd: number; calls: number; adopt?: string | null; /** R7: a tool idea number (`/project start idea:`). */ idea?: number | null };

export class ProjectService {
  constructor(private readonly d: ProjectServiceDeps) {}

  private nowMs(): number {
    return (this.d.now ?? Date.now)();
  }

  private on(): boolean {
    try { return this.d.cfg.get('autopilot.enabled') === true; } catch { return false; }
  }

  /** R7: `forge.enabled`, read live; only exactly `true` is on, a read error is off. */
  private forgeOn(): boolean {
    try { return this.d.cfg.get('forge.enabled') === true; } catch { return false; }
  }

  private halted(): boolean {
    try { return this.d.halted(); } catch { return true; }
  }

  private today(): string {
    return localDay(this.nowMs(), this.d.cfg.get('schedule.timezone')).date;
  }

  /** `project_task` (SA-1 3.8): why no project tool may run now. Halt first, then the switch (a read error is off). */
  gateRefusal(): 'halted' | 'off' | null {
    if (this.halted()) return 'halted';
    return this.on() ? null : 'off';
  }

  /** `project_task` (SA-1 3.8 step 7): the project by number, only while it is active, unpaused, not exhausted and in time; its root task id comes from the row. Null on any doubt. */
  async openProject(projectId: number): Promise<{ id: number; rootTaskId: string } | null> {
    try {
      const row = await this.d.repo.getRow(projectId);
      if (!row || row.status !== 'active' || !row.rootTaskId) return null;
      const p = await this.d.repo.projectOf(row.rootTaskId);
      return p && p.id === projectId ? { id: p.id, rootTaskId: row.rootTaskId } : null;
    } catch {
      return null;
    }
  }

  // ---- propose ---------------------------------------------------------------------------------------------------------------------------------------------------

  /** `project_propose` (CEO only). Refusal order: not_ceo, halted, off, screen, deadline, then the caps under the repo's lock. */
  async propose(actor: ActorRef, run: { tainted: boolean; task: { tainted: boolean } | null }, input: unknown): Promise<Proposed> {
    if (actor.kind !== 'head' || actor.dept !== 'hq') return { ok: false, code: 'not_ceo', error: PROPOSE_TEXT.not_ceo };
    return this.submit('head:hq', run.tainted || run.task?.tainted === true, input);
  }

  /** `/project start` (a Bot Admin in #setting): the same rules, proposer `user:<id>`, never tainted. */
  async start(a: StartInput): Promise<Proposed> {
    const entries = a.adopt ? a.adopt.slice(0, 800).split(/[\s,]+/).filter((s) => s !== '').map((s) => s.toLowerCase()) : [];
    if ((a.adopt ?? '').length > 800 || entries.length > 20 || entries.some((e) => !BAD_ADOPT.test(e))) return { ok: false, code: 'invalid', error: PROPOSE_TEXT.invalid };
    return this.submit(`user:${a.userId}`, false, { title: a.title, goal: a.goal, deadline: a.deadline, budget: { maxLocalCalls: a.calls, maxUsd: a.usd }, ...(entries.length ? { adopt: entries } : {}), ...(a.idea !== undefined && a.idea !== null ? { toolIdea: a.idea } : {}) });
  }

  private async submit(proposer: string, tainted: boolean, raw: unknown): Promise<Proposed> {
    const no = (code: ProposeCode): Proposed => ({ ok: false, code, error: PROPOSE_TEXT[code] });
    try {
      if (this.halted()) return no('halted');
      if (!this.on()) return no('off');
      const parsed = ProjectProposeInput.safeParse(raw);
      if (!parsed.success) return no('invalid');
      const v = parsed.data;
      const title = screenText(fold(v.title), { max: 100, secrets: this.d.secrets, multiline: false });
      const goal = screenText(fold(v.goal), { max: 1000, secrets: this.d.secrets, multiline: false });
      if (!title.ok || !goal.ok) return no('screen');
      if (!dueOk(v.deadline, this.today())) return no('deadline');
      if (v.toolIdea !== undefined && !this.forgeOn()) return no('forge_off');
      const made = await this.d.repo.create({
        title: title.text, goal: goal.text, deadline: v.deadline, maxLocalCalls: v.budget.maxLocalCalls, maxUsd: v.budget.maxUsd, proposer, tainted, ...(v.adopt ? { adopt: v.adopt } : {}), ...(v.toolIdea !== undefined ? { ideaId: v.toolIdea } : {}),
      });
      if (!made.ok) return no(made.code);
      const p = made.project;
      let cardOk = true;
      try {
        const messageId = await this.d.postCard(await this.proposalCard(p, made.adopt, made.forge));
        await this.d.repo.setCard(p.id, this.d.configChannelId, messageId);
      } catch (err) {
        cardOk = false; // the row stays proposed without a card: listed in /project list, expires in 7 days
        this.d.log.error({ errName: errName(err) }, 'project card post failed');
      }
      const text = `Project proposal #${p.id} was sent to the Bot Admins. Nothing starts until it is approved. Adopt: ${made.adopt.ids.length} listed, ${made.adopt.skipped.length} not eligible.${cardOk ? '' : ' The card could not be posted; a Bot Admin can see it in /project list.'}`;
      return { ok: true, id: p.id, text, cardOk };
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'project propose failed');
      return no('exception');
    }
  }

  private esc(s: string, max: number): string {
    return escapeCardText(s, max, this.d.secrets);
  }

  /** The card (SA-1 3.2): model text only escaped, the autopilot consent text fixed and whole. */
  private async proposalCard(p: Project, adopt: { ids: string[]; skipped: { id8: string; code: AdoptCode }[] }, forge?: { ideaId: number; ideaName: string; deptId: string }): Promise<OutboundPayload> {
    const who = p.proposer === 'head:hq' ? 'the CEO' : `<@${p.proposer.slice('user:'.length).replace(/[^0-9]/g, '')}>`;
    const lines = [
      `**${this.esc(p.title, 100)}**`,
      `Deadline: ${p.deadline}`,
      `Budget: ${p.maxLocalCalls} local model calls, ${usd(p.maxUsd)} USD, ${p.maxApprovals} auto approvals`,
      `Proposed by: ${who}`,
    ];
    if (forge) lines.push(`Forge: builds tool idea #${Math.trunc(forge.ideaId)} ${this.esc(forge.ideaName, 40)} (${this.esc(forge.deptId, 32)}) as a plugin.`);
    if (p.tainted) lines.push('The proposing run read outside content.');
    if (adopt.ids.length || adopt.skipped.length) {
      lines.push('', 'Adopt (open tasks that would join this project):');
      for (const id of adopt.ids) {
        const t = await this.d.tasks.get(id).catch(() => null);
        lines.push(`- ${id8(id)} ${this.esc(t?.title ?? '', 60)}`);
      }
      for (const s of adopt.skipped) lines.push(`- ${id8(s.id8)} not adopted: ${s.code}`);
    }
    lines.push('', AUTOPILOT_CARD_TEXT, `Expires <t:${Math.floor(p.expiresAt.getTime() / 1000)}:R>.`);
    const g = this.esc(p.goal, 1000);
    const chunks: string[] = [];
    for (let i = 0; i < g.length; i += 1000) chunks.push(g.slice(i, i + 1000));
    return {
      type: 'approval', origin: 'governance', title: 'Project proposal', projectCardId: p.token, body: lines.join('\n').slice(0, 4000),
      fields: chunks.map((c, i) => ({ name: i === 0 ? `Goal (written by ${p.proposer === 'head:hq' ? 'the CEO' : 'a Bot Admin'})` : 'Goal (continued)', value: c })),
    };
  }

  // ---- the proposal card buttons ---------------------------------------------------------------------------------------------------------------------------------

  /** `projcard:<token>:approve|reject` (route() has checked #setting and the live Bot Admin role; this checks the stored card, the status and the expiry). */
  async decideCard(c: { token: string; action: 'approve' | 'reject'; userId: string; channelId: string | null; messageId: string | null }): Promise<CardDecided> {
    const no = (code: DecideCode): CardDecided => ({ ok: false, code, text: DECIDE_TEXT[code] });
    try {
      if (!/^[0-9a-f]{32}$/.test(c.token)) return no('wrong_card');
      const p = await this.d.repo.getByToken(c.token);
      if (!p || p.messageId === null || p.channelId === null || p.channelId !== c.channelId || p.messageId !== c.messageId || c.channelId !== this.d.configChannelId) return no('wrong_card');
      if (p.status !== 'proposed') return no('not_pending');
      if (p.expiresAt.getTime() <= this.nowMs() && (await this.expireCard(p))) return no('expired');
      if (c.action === 'reject') {
        const r = await this.d.repo.reject(p.id, c.userId);
        if (!r) return no('not_pending');
        await this.closeNote(p.channelId, p.messageId, `Rejected by <@${c.userId}>. Nothing started.`);
        if (r.proposer === 'head:hq') await this.d.notifyHead('hq', `Project proposal #${r.id} was rejected. Do not start it.`).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'project reject notice failed'));
        return { ok: true, result: 'rejected', project: r };
      }
      const r = await this.d.repo.decide({ token: c.token, by: c.userId });
      if (!r.ok) {
        if (r.code === 'expired') {
          await this.expireCard(p);
          return no('expired');
        }
        return no(r.code);
      }
      // After COMMIT: the CEO's owner run starts from this event, once.
      await this.d.bus.emit('task.created', { task: r.root });
      const skipped = r.skipped.map((s) => `${id8(s.id)} ${s.code}`);
      await this.closeNote(p.channelId, p.messageId, `Approved by <@${c.userId}>. Root task ${id8(r.root.id)}. Adopted ${r.adopted.length}, skipped ${skipped.length ? skipped.join(', ') : 'none'}.`);
      return { ok: true, result: 'approved', project: r.project, root: r.root, adopted: r.adopted.length, skipped };
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'project decide failed');
      return no('exception');
    }
  }

  /** The proposal ran out: cancelled by the system and its card closed. False when the database says it is not expired (or already decided). */
  private async expireCard(p: Project): Promise<boolean> {
    const e = await this.d.repo.expire(p.id);
    if (!e) return false;
    if (p.channelId && p.messageId) await this.closeNote(p.channelId, p.messageId, 'Expired after 7 days without a decision.');
    return true;
  }

  /** Every minute: expire the proposals that ran out (and close their cards), then post each owed deadline notice. Never throws. */
  async tick(): Promise<void> {
    try {
      for (const r of await this.d.repo.list(25)) if (r.status === 'proposed' && r.expiresAt.getTime() <= this.nowMs()) await this.expireCard(r).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'project expiry failed'));
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'project expiry sweep failed');
    }
    await this.deadlineNotices();
  }

  /** AP-C9: one notice per project that passed its deadline, claim first (a CAS on deadline_noticed_at). Never throws. */
  async deadlineNotices(): Promise<number> {
    let n = 0;
    try {
      if (this.halted() || !this.on()) return 0;
      for (const o of await this.d.repo.deadlineOwed(10)) {
        const p = await this.d.repo.claimDeadlineNotice(o.id);
        if (!p) continue;
        n++;
        try {
          await this.d.postCard({
            type: 'alert', origin: 'governance', title: 'Project deadline passed',
            body: `Project #${p.id} ${this.esc(p.title, 60)} passed its deadline (${p.deadline}). Autopilot is off for it: its tasks run under the normal rules and ask for approval again. Use /project extend id:${p.id} to give it more time, or /project close id:${p.id} to end it.`,
          });
        } catch (err) {
          this.d.log.error({ errName: errName(err) }, 'project deadline notice failed');
        }
      }
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'project deadline sweep failed');
    }
    return n;
  }

  // ---- budget notice ---------------------------------------------------------------------------------------------------------------------------------------------

  /** SA-1 3.5: the one notice. `exhaust` is a claim-first CAS; only the caller that got the row posts the card. Never throws. */
  async exhausted(projectId: number): Promise<boolean> {
    try {
      const p = await this.d.repo.exhaust(projectId);
      if (!p || !p.budgetToken) return false;
      try {
        const row = await this.d.repo.getRow(projectId);
        const calls = row?.calls ?? 0;
        const spent = row?.usd ?? 0;
        const messageId = await this.d.postCard({
          type: 'approval', origin: 'governance', title: 'Project budget used up', projectBudgetId: p.budgetToken,
          body: `Project #${p.id} ${this.esc(p.title, 60)} used its budget: ${Math.trunc(Number(calls))}/${p.maxLocalCalls} local calls, ${usd(spent)}/${usd(p.maxUsd)} USD, ${p.approvalsUsed}/${p.maxApprovals} auto approvals. Autopilot is stopped for this project; tasks that hit the budget are blocked. Raise adds ${p.baseLocalCalls} calls, ${usd(p.baseUsd)} USD, ${p.baseApprovals} approvals.`,
        });
        await this.d.repo.setBudgetCard(p.id, this.d.configChannelId, messageId);
      } catch (err) {
        this.d.log.error({ errName: errName(err) }, 'project budget card post failed'); // the fallback is /project raise
      }
      return true;
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'project exhaust failed');
      return false;
    }
  }

  /** The loop's `autopilot.budgetHit` (SA-1 3.4): block the task for the budget, then send the one notice. Throws only on the block; the loop catches. */
  async budgetHit(task: Task): Promise<void> {
    const cur = await this.d.tasks.get(task.id);
    if (cur && !SETTLED.includes(cur.status)) {
      const from = cur.status;
      const updated = await this.d.tasks.update(cur.id, { status: 'blocked', blockedReason: 'budget' }, from);
      if (updated) await this.d.bus.emit('task.changed', { task: updated, from, to: 'blocked' });
    }
    const p = await this.d.repo.byRoot(task.rootId);
    if (p) await this.exhausted(p.id);
  }

  // ---- the budget card buttons -----------------------------------------------------------------------------------------------------------------------------------

  /** `projbud:<token>:raise|close`. The stored budget card is the only card this token may be decided from. */
  async decideBudget(c: { token: string; action: 'raise' | 'close'; userId: string; channelId: string | null; messageId: string | null }): Promise<BudgetDecided> {
    const no = (code: DecideCode): BudgetDecided => ({ ok: false, code, text: DECIDE_TEXT[code] });
    try {
      if (!/^[0-9a-f]{32}$/.test(c.token)) return no('wrong_card');
      const p = await this.d.repo.getByBudgetToken(c.token);
      if (!p || p.budgetMessageId === null || p.budgetChannelId === null || p.budgetChannelId !== c.channelId || p.budgetMessageId !== c.messageId || c.channelId !== this.d.configChannelId) return no('wrong_card');
      if (c.action === 'raise') {
        const r = await this.raiseRow(p.id, c.userId, c.token);
        return r.ok ? { ok: true, result: 'raised', project: r.project, unblocked: r.unblocked } : no(r.code);
      }
      if (this.halted()) return no('halted');
      const r = await this.closeRow(p.id, c.userId);
      return r.ok ? { ok: true, result: 'closed', project: r.project, unblocked: 0 } : no(r.code);
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'project budget decide failed');
      return no('exception');
    }
  }

  private async raiseRow(id: number, by: string, token?: string): Promise<{ ok: true; project: Project; unblocked: number } | { ok: false; code: DecideCode }> {
    const r = await this.d.repo.raise({ id, by, ...(token ? { token } : {}) });
    if (!r.ok) return { ok: false, code: r.code };
    for (const t of r.unblocked) {
      await this.d.bus.emit('task.changed', { task: t, from: 'blocked', to: 'todo' });
      await this.d.bus.emit('task.ready', { taskId: t.id });
    }
    await this.closeBudgetCard(r.project, `Raised by <@${by}>. Autopilot continues; ${r.unblocked.length} blocked task${r.unblocked.length === 1 ? '' : 's'} restarted.`);
    return { ok: true, project: r.project, unblocked: r.unblocked.length };
  }

  private async closeRow(id: number, by: string): Promise<{ ok: true; project: Project; rootDone: boolean } | { ok: false; code: DecideCode }> {
    const r = await this.d.repo.close({ id, by });
    if (!r.ok) return { ok: false, code: r.code };
    if (r.rootClosed) await this.d.bus.emit('task.changed', { task: r.rootClosed.task, from: r.rootClosed.from, to: 'done' });
    await this.closeBudgetCard(r.project, `Closed by <@${by}>.`);
    return { ok: true, project: r.project, rootDone: r.rootClosed !== null };
  }

  private async closeBudgetCard(p: Project, note: string): Promise<void> {
    if (p.budgetChannelId && p.budgetMessageId) await this.closeNote(p.budgetChannelId, p.budgetMessageId, note);
  }

  private async closeNote(channelId: string, messageId: string, note: string): Promise<void> {
    await this.d.closeCard(channelId, messageId, note).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'project card close failed'));
  }

  // ---- /project list | pause | resume | close | raise | extend ---------------------------------------------------------------------------------------------------------

  list(limit = 25): Promise<ProjectRow[]> {
    return this.d.repo.list(limit);
  }

  private async cmd(fn: () => Promise<Cmd>): Promise<Cmd> {
    try {
      return await fn();
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'project command failed');
      return { ok: false, code: 'exception', text: DECIDE_TEXT.exception };
    }
  }

  pause(id: number, by: string, paused = true): Promise<Cmd> {
    return this.cmd(async () => {
      const r = await this.d.repo.setPaused({ id, paused, by });
      if (r.ok) return { ok: true, text: `Project #${id} ${paused ? 'paused' : 'resumed'}.` };
      const code: DecideCode = r.code === 'unchanged' ? (paused ? 'unchanged_paused' : 'unchanged_running') : r.code;
      return { ok: false, code, text: DECIDE_TEXT[code] };
    });
  }

  resume(id: number, by: string): Promise<Cmd> {
    return this.pause(id, by, false);
  }

  close(id: number, by: string): Promise<Cmd> {
    return this.cmd(async () => {
      const r = await this.closeRow(id, by);
      return r.ok ? { ok: true, text: `Project #${id} closed.${r.rootDone ? ' Its root task was marked done.' : ''}` } : { ok: false, code: r.code, text: DECIDE_TEXT[r.code] };
    });
  }

  raise(id: number, by: string): Promise<Cmd> {
    return this.cmd(async () => {
      const r = await this.raiseRow(id, by);
      if (!r.ok) return { ok: false, code: r.code, text: DECIDE_TEXT[r.code] };
      return { ok: true, text: `Project #${id} raised: ${r.project.maxLocalCalls} calls, ${usd(r.project.maxUsd)} USD, ${r.project.maxApprovals} approvals in total. ${r.unblocked} blocked task${r.unblocked === 1 ? '' : 's'} restarted.` };
    });
  }

  extend(id: number, deadline: string, by: string): Promise<Cmd> {
    return this.cmd(async () => {
      if (this.halted()) return { ok: false, code: 'halted', text: DECIDE_TEXT.halted };
      if (!PROJECT_DATE.test(deadline) || !dueOk(deadline, this.today())) return { ok: false, code: 'exception', text: PROPOSE_TEXT.deadline };
      const r = await this.d.repo.extend({ id, deadline, by });
      if (r.ok) return { ok: true, text: `Project #${id} deadline is now ${r.project.deadline}.` };
      if (r.code === 'bad_date') return { ok: false, code: 'exception', text: PROPOSE_TEXT.deadline };
      return { ok: false, code: r.code, text: DECIDE_TEXT[r.code] };
    });
  }

  // ---- root-end sync ---------------------------------------------------------------------------------------------------------------------------------------------

  /** SA-1 3.6: a root task that ends (done or cancelled) ends its project. `track` is `Scheduler.track` so idle() waits for it. Returns the unsubscribe. */
  attach(bus: Pick<EventBus<AppEvents>, 'on'>, track: (what: string, fn: () => Promise<void>) => Promise<void>): () => void {
    return bus.on('task.changed', (e) => {
      if ((e.to !== 'done' && e.to !== 'cancelled') || e.task.parentId !== null) return;
      void track('project end', async () => {
        try {
          await this.d.repo.rootEnded(e.task.id, e.to as 'done' | 'cancelled');
        } catch (err) {
          this.d.log.error({ errName: errName(err) }, 'project end sync failed');
        }
      });
    });
  }
}
