import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { OutboundPayload } from '../agents/loop/payload.js';
import type { ActorRef } from '../company/types.js';
import type { ConfigStore } from '../config/store.js';
import type { ToolRequestRepo, ToolRequestRow } from '../db/repos/grow.js';
import { escapeCardText } from '../discord/embeds/approval.js';
import { planBotTools, isError, MCP_GRANT_TEXT, type PlanDeps } from '../discord/commands/plans.js';
import type { AuditFn } from '../governance/audit.js';
import { screenText } from '../knowledge/screen.js';
import { SAFE_TOOL_NAME, skillToolAllowed, type GrantEnv } from '../tools/skill-grant.js';

/** `tool_request {tool, reason}` (SA-1 3.3). No kind, no approval: its only effect is a row and a Bot Admin card. */
export const ToolRequestInput = z.object({ tool: z.string().regex(/^[a-z0-9_]{1,64}$/), reason: z.string().trim().min(1).max(300) }).strict();
export type ToolRequestInput = z.infer<typeof ToolRequestInput>;

export type RequestCode = 'not_head' | 'halted' | 'tainted' | 'unknown_tool' | 'already_allowed' | 'not_grantable' | 'mcp' | 'screen' | 'open_cap' | 'pending_exists' | 'recently_rejected';
/** Fixed texts; nothing echoes input or model text. */
export const REQUEST_TEXT: Record<RequestCode, string> = {
  not_head: 'Only a department head can request a tool.',
  halted: 'The company is halted; try again after /resume.',
  tainted: 'Refused: this run read outside content.',
  unknown_tool: 'There is no tool with that name.',
  already_allowed: 'Your department already has that tool.',
  not_grantable: 'That tool cannot be requested: it is a core, sensitive or admin tool.',
  mcp: MCP_GRANT_TEXT,
  screen: 'The reason was refused (a secret-like value or control characters).',
  open_cap: 'Your department already has 3 open tool requests.',
  pending_exists: 'That tool already has an open request for your department.',
  recently_rejected: 'A Bot Admin rejected that request in the last 7 days; it cannot be asked again yet.',
};
export type Requested = { ok: true; id: number | null; text: string } | { ok: false; code: RequestCode; error: string };

export type DecideCode = 'wrong_card' | 'not_pending' | 'expired' | 'halted' | 'changed' | 'void' | 'exception';
export const DECIDE_TEXT: Record<DecideCode, string> = {
  wrong_card: 'That button does not belong to this card.',
  not_pending: 'Already decided.',
  expired: 'This request has expired.',
  halted: 'The company is halted; approve after /resume.',
  changed: 'The department tools changed meanwhile; press Approve again.',
  void: 'That tool can no longer be granted; the request was closed.',
  exception: 'That could not be done now; nothing was changed.',
};
export const GRANTED_UNSETTLED_TEXT = 'The tool was granted, but the request record could not be updated; it will settle at the next restart.';
export type DecideInput = { token: string; action: 'approve' | 'reject'; userId: string; channelId: string | null; messageId: string | null };
export type Decided = { ok: true; row: ToolRequestRow; result: 'approved' | 'rejected' | 'already' } | { ok: false; code: DecideCode; text: string };

export interface ToolRequestDeps {
  repo: Pick<ToolRequestRepo, 'create' | 'byToken' | 'byId' | 'setCard' | 'reject' | 'claim' | 'settle' | 'revert' | 'expire' | 'applying' | 'listPending'>;
  cfg: Pick<ConfigStore, 'get' | 'setIf'>;
  org: PlanDeps['org'] & { toolsFor(a: ActorRef): string[] };
  /** The registry view: names, kinds and the core builtins (rule G reads it on every call). */
  grant: GrantEnv;
  /** Registered non-builtin tool names (what `planBotTools` accepts). */
  plugins: () => string[];
  halted: () => boolean;
  audit: AuditFn;
  secrets: readonly string[];
  configChannelId: string;
  /** Posts the card as hq in #setting and returns the message id. */
  postCard: (p: OutboundPayload) => Promise<string>;
  closeCard: (channelId: string, messageId: string, note: string) => Promise<void>;
  /** `Scheduler.notifyHead`: code text only, clean provenance. */
  notifyHead: (dept: string, text: string) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
  /**
   * AUTO-1 (SA-1 3.8, Gate 1 AP-C7, C10): the project grant port. This module still never imports the approver: the port is injected and decides by database rows only.
   * Called only when the run has a task its caller owns, after every refusal above (including `tainted`). `not_project` goes on to today's card flow.
   */
  projectGrant?: (r: { dept: string; taskId: string; tool: string }) => Promise<{ kind: 'granted'; projectId: number } | { kind: 'granted_tree'; rootId: string } | { kind: 'refused'; text: string } | { kind: 'not_project' }>;
  newToken?: () => string;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

/**
 * GROW-1 tool_request (SA-1 3.3, Gate 1 GW-C16..C23). A head asks for an EXISTING tool for its own department; a live Bot Admin approves on a card in #setting.
 * This module never imports the AI approver or the skill judge: a tool grant is never AI-approved. The only config write is `tools.byDept` for the one department,
 * through `setIf` (compare-and-swap on the whole map).
 */
export class ToolRequestService {
  constructor(private readonly d: ToolRequestDeps) {}

  private async rec(actor: string, action: string, tool: string, outcome: string): Promise<void> {
    await this.d.audit({ actor, action, tool, outcome });
  }

  private async refuse(who: string, code: RequestCode): Promise<Requested> {
    await this.rec(who, 'tool.request', 'tool_request', `refused:${code}`);
    return { ok: false, code, error: REQUEST_TEXT[code] };
  }

  private listed(dept: string, tool: string): boolean {
    const all = this.d.cfg.get('tools.byDept');
    return (Object.hasOwn(all, dept) ? all[dept]! : []).includes(tool);
  }

  async request(actor: ActorRef, run: { tainted: boolean; task: { id: string; tainted: boolean } | null; ownsTask?: boolean }, input: ToolRequestInput): Promise<Requested> {
    const who = actor.kind === 'head' ? `head:${actor.dept}` : `persona:${actor.personaId}`.slice(0, 80);
    if (actor.kind !== 'head' || actor.dept === 'praw') return this.refuse(who, 'not_head'); // Praw's "*" reaches this tool; personas never
    const dept: string = actor.dept;
    if (this.d.halted()) return this.refuse(who, 'halted'); // the registry refuses on halt only on the approved path (C13)
    if (run.tainted || run.task?.tainted) return this.refuse(who, 'tainted');
    const tool = input.tool;
    if (tool.startsWith('mcp_')) return this.refuse(who, 'mcp'); // R6 (spec 5.8, MC-C14): external tools are granted only with /mcp depts
    if (!this.d.grant.registered().includes(tool)) return this.refuse(who, 'unknown_tool');
    if (this.d.org.toolsFor(actor).includes(tool) || this.listed(dept, tool)) return this.refuse(who, 'already_allowed');
    if (!skillToolAllowed(tool, this.d.grant)) return this.refuse(who, 'not_grantable'); // rule G (C7: a kindless plugin tool refuses too)
    const screened = screenText(input.reason.replace(/\s+/g, ' ').trim(), { max: 300, secrets: this.d.secrets, multiline: false });
    if (!screened.ok) return this.refuse(who, 'screen');
    // AUTO-1 (AP-C7): a task of the caller's own, in an active project: a project-scoped grant, no card. A port fault or a name-level hard-deny tool falls through to the card.
    if (this.d.projectGrant && run.task && run.ownsTask === true) {
      let g: Awaited<ReturnType<NonNullable<ToolRequestDeps['projectGrant']>>> = { kind: 'not_project' };
      try {
        g = await this.d.projectGrant({ dept, taskId: run.task.id, tool });
      } catch (err) {
        this.d.log.error({ errName: errName(err) }, 'project tool grant failed');
      }
      if (g.kind === 'refused') return { ok: false, code: 'not_grantable', error: g.text };
      if (g.kind === 'granted') {
        await this.rec(who, 'tool.request', 'tool_request', `project p${g.projectId} ${tool}`);
        return { ok: true, id: null, text: `Granted for project #${g.projectId} only: ${dept} may use ${tool} in this project's tasks from its next run there. No card was sent.` };
      }
      if (g.kind === 'granted_tree') {
        await this.rec(who, 'tool.request', 'tool_request', `tree ${g.rootId.slice(0, 8)} ${tool}`);
        return { ok: true, id: null, text: `Granted for this task tree only: ${dept} may use ${tool} in this tree's tasks from its next run there. No card was sent.` };
      }
    }
    const made = await this.d.repo.create(dept, tool, screened.text, run.task?.id ?? null, (this.d.newToken ?? (() => randomBytes(16).toString('hex')))());
    if (!made.ok) return this.refuse(who, made.code);
    await this.rec(who, 'tool.request', 'tool_request', `#${made.id} ${tool}`);
    let cardOk = true;
    try {
      const kind = this.d.grant.kindOf(tool) ?? 'unknown';
      const messageId = await this.d.postCard({
        type: 'approval', origin: 'governance', title: 'Tool request', toolRequestId: made.token,
        body: `${dept} head asks for the existing tool ${tool} (kind ${kind}) for the whole department. Approve adds it to tools.byDept for ${dept} only. Expires <t:${Math.floor(made.expiresAt.getTime() / 1000)}:R>.`,
        fields: [{ name: 'Reason (written by the bot)', value: escapeCardText(screened.text, 300, this.d.secrets) }],
      });
      await this.d.repo.setCard(made.id, this.d.configChannelId, messageId);
    } catch (err) {
      cardOk = false; // the row stays pending without a card: listed in /tool requests, expires in 7 days
      this.d.log.error({ errName: errName(err) }, 'tool request card post failed');
    }
    return { ok: true, id: made.id, text: `Tool request #${made.id} for ${tool} was sent to the Bot Admins. NOTHING has changed yet; you will be told in this room. Do not say you have the tool.${cardOk ? '' : ' The card could not be posted; a Bot Admin can see it in /tool requests.'}` };
  }

  // ---- the button ----

  async decide(c: DecideInput): Promise<Decided> {
    const no = (code: DecideCode): Decided => ({ ok: false, code, text: DECIDE_TEXT[code] });
    try {
      if (!/^[0-9a-f]{32}$/.test(c.token)) return no('wrong_card');
      const row = await this.d.repo.byToken(c.token);
      // GW-C19: the stored card is the only card this token may be decided from.
      if (!row || row.messageId === null || row.channelId === null || row.channelId !== c.channelId || row.messageId !== c.messageId || c.channelId !== this.d.configChannelId) return no('wrong_card');
      if (row.status !== 'pending') return no('not_pending');
      if (!row.live) return no('expired');
      const by = `user:${c.userId}`;
      if (c.action === 'reject') {
        const done = await this.d.repo.reject(c.token, c.userId);
        if (!done) return no('not_pending');
        await this.rec(by, 'tool.request.decide', 'tool_request', `#${done.id} rejected`);
        await this.after(done, `Rejected by <@${c.userId}>. Nothing changed.`, `Tool request #${done.id} (${done.tool}): rejected by a Bot Admin. Nothing changed.`);
        return { ok: true, row: done, result: 'rejected' };
      }
      if (this.d.halted()) return no('halted'); // the row stays pending
      const claimed = await this.d.repo.claim(c.token, c.userId);
      if (!claimed) return no('not_pending');
      return await this.apply(claimed, c.userId);
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'tool request decide failed');
      return no('exception');
    }
  }

  /** The claimed row (status approved, outcome applying). Any failure before the write puts it back to pending; a crash is reconciled at boot (GW-C20). */
  private async apply(row: ToolRequestRow, userId: string): Promise<Decided> {
    const by = `user:${userId}`;
    const void_ = async (why: string): Promise<Decided> => {
      await this.d.repo.settle(row.id, why, 'void');
      await this.rec(by, 'tool.request.decide', 'tool_request', `#${row.id} void ${why}`);
      await this.after(row, 'Closed: that tool cannot be granted.', `Tool request #${row.id} (${row.tool}): closed; that tool cannot be granted.`);
      return { ok: false, code: 'void', text: DECIDE_TEXT.void };
    };
    const revert = async (code: DecideCode): Promise<Decided> => {
      await this.d.repo.revert(row.id);
      return { ok: false, code, text: DECIDE_TEXT[code] };
    };
    let written = false; // G2-GW-01: once setIf succeeded the tool is granted; never revert the row after that
    try {
      // rule G again, on the live registry
      if (!this.d.grant.registered().includes(row.tool) || !skillToolAllowed(row.tool, this.d.grant)) return await void_('not_grantable');
      const approvedNote = `Approved by <@${userId}>: ${row.deptId} head may use ${row.tool}.`;
      const approvedHead = `Tool request #${row.id} (${row.tool}): approved by a Bot Admin. You can use it from your next run.`;
      if (this.listed(row.deptId, row.tool)) {
        await this.d.repo.settle(row.id, 'already');
        await this.rec(by, 'tool.request.decide', 'tool_request', `#${row.id} already`);
        await this.after(row, approvedNote, approvedHead);
        return { ok: true, row, result: 'already' };
      }
      const plan = planBotTools(row.deptId, 'add', row.tool, { org: this.d.org, cfg: this.d.cfg, tools: { plugins: this.d.plugins } });
      if (isError(plan)) return await void_('plan');
      const w = await this.d.cfg.setIf(plan.writes, by); // CAS on the whole tools.byDept map; only this department's list differs
      if (!w.ok) return w.reason === 'changed' ? await revert('changed') : await void_('plan');
      written = true;
      await this.rec(by, 'bot.tools.add', row.tool, `ok tool_request:${row.id}`); // only after setIf succeeded
      await this.d.repo.settle(row.id, 'ok');
      await this.after(row, approvedNote, approvedHead);
      return { ok: true, row, result: 'approved' };
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'tool request apply failed');
      if (written) return { ok: false, code: 'exception', text: GRANTED_UNSETTLED_TEXT }; // the row stays `applying`; boot recovery settles it from tools.byDept
      await this.d.repo.revert(row.id).catch(() => undefined);
      return { ok: false, code: 'exception', text: DECIDE_TEXT.exception };
    }
  }

  /** Closes the card and tells the head in its room. Each step is independent and never throws. */
  private async after(row: Pick<ToolRequestRow, 'channelId' | 'messageId' | 'deptId' | 'tool'>, cardNote: string, headText: string): Promise<void> {
    if (row.channelId && row.messageId) await this.d.closeCard(row.channelId, row.messageId, cardNote).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'tool request card close failed'));
    if (SAFE_TOOL_NAME.test(row.tool)) await this.d.notifyHead(row.deptId, headText).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'tool request head notice failed'));
  }

  // ---- expiry and boot ----

  /** Every 60 s and once at boot: expire, close the card, tell the head. Never throws. */
  async sweep(): Promise<number> {
    try {
      const rows = await this.d.repo.expire();
      for (const r of rows) {
        await this.rec('system:tool-request', 'tool.request.expire', 'tool_request', `#${r.id}`);
        await this.after(r, 'Expired after 7 days without a decision.', `Tool request #${r.id} (${r.tool}): expired after 7 days without a decision.`);
      }
      return rows.length;
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'tool request sweep failed');
      return 0;
    }
  }

  /**
   * GW-C20 (boot): a claim whose process died between the claim and `setIf` (or before the final write). The tool is in `tools.byDept[dept]` -> settled `ok`;
   * otherwise back to pending while unexpired, else void. Never throws.
   */
  async recover(): Promise<void> {
    try {
      for (const r of await this.d.repo.applying()) {
        if (this.listed(r.deptId, r.tool)) {
          await this.d.repo.settle(r.id, 'ok');
          await this.rec(`user:${r.decidedBy ?? 'unknown'}`.slice(0, 60), 'bot.tools.add', r.tool, `ok tool_request:${r.id} recovered`);
          await this.after(r, `Approved by <@${r.decidedBy ?? 'a Bot Admin'}>: ${r.deptId} head may use ${r.tool}.`, `Tool request #${r.id} (${r.tool}): approved by a Bot Admin. You can use it from your next run.`);
        } else if (r.live) {
          await this.d.repo.revert(r.id);
        } else {
          await this.d.repo.settle(r.id, 'recovered', 'void');
          await this.after(r, 'Closed: the request expired before it could be applied.', `Tool request #${r.id} (${r.tool}): closed; that tool cannot be granted.`);
        }
      }
    } catch (err) {
      this.d.log.error({ errName: errName(err) }, 'tool request recovery failed');
    }
  }

  listPending(limit = 25): Promise<ToolRequestRow[]> {
    return this.d.repo.listPending(limit);
  }
}
