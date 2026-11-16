import { z } from 'zod';
import { actorKey } from '../governance/budget.js';
import type { ToolSpec } from '../providers/types.js';
import { wrapUntrusted } from '../prompts/assemble.js';
import { approvalFor, type ToolKind } from './policy-approval.js';
import { extractUrls } from './urls.js';
import { flattenTopLevelUnion } from './schema.js';
import { treeGrantCovers, treeGrantRunOk } from './tree-grant-scope.js';
import type { TaskGrantMiss } from '../db/repos/task-grants.js';
import type { Task } from '../db/repos/tasks.js';
import type { IncidentSink } from '../core/incidents.js';
import { AUTOPILOT_OWN_WAIVE, AUTOPILOT_REFUSAL, AUTOPILOT_REFUSAL_COMPANY } from './autopilot.js';
import { sameActor, toolError, type AutopilotDecision, type ToolContext, type ToolPlugin, type ToolResult } from './types.js';

type AnyTool = ToolPlugin<never>;

/** F1: what the model reads when a call needs approval. Fixed text; only the card number and a channel mention (both from code) vary. */
export const awaitingText = (card: number | null, where: string | null): string =>
  `NOT DONE YET: waiting for approval of ${card === null ? 'the approval card' : `card #${card}`} in ${where ?? 'the approvals channel'}. Tell the user it is waiting for approval; do not say it is done.`;
/** F1: the footer line the loop adds to a posted answer after any awaiting_approval result. Fixed template (tool name and card from code). */
export const awaitingFooter = (p: { tool: string; card: number | null }): string =>
  `⏳ รออนุมัติ: ${p.tool.replace(/[^\w-]/g, '').slice(0, 64)}${p.card === null ? '' : ` (การ์ด #${p.card})`}`;
const ISSUES_MAX = 500;
/** R17: the urls these tools return are ones the run may fetch later without approval. */
const URL_SOURCES = new Set(['web_search', 'fetch_page']);

/**
 * Every tool call goes through here: actor allowlist (Gate 1 D16) -> zod validation -> precheck -> requiresApproval -> run,
 * and each call is audited with its outcome. Tool failures become error results the model can read.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  /** `halt` is required: runApproved must never run an approved call while halted (D9). */
  constructor(private readonly opts: {
    halt: { isHalted(): boolean };
    /** BOTLOG-1: a tool that throws is reported to #bot-log. */ incidents?: IncidentSink;
    /** TREEGRANT-1 (TG-C6, second line): only the main registry sets this. Without it a task grant port in the context is dropped, so the admin registry can never consume one. */
    treeGrants?: boolean;
    /** AUTO-1 (AP-C3): only the main registry sets this. Without it an autopilot port in the context is dropped, so the admin registry can never decide a call. */
    autopilot?: boolean;
    /** R6 MCP-1 (spec 5.8, MC-C14): the live external (MCP) tools; only the main registry sets this. Consulted only for `mcp_` names; the admin registry never resolves one. */
    external?: { get(name: string): { readonly name: string } | undefined; names(): readonly string[] };
  }) {}

  register<I>(t: ToolPlugin<I>): void {
    if (t.name.startsWith('mcp_')) throw new Error('tool names starting with mcp_ are reserved for external tools'); // MC-C10: no static tool can shadow an external name
    if (this.tools.has(t.name)) throw new Error(`tool ${t.name} already registered`);
    this.tools.set(t.name, t as unknown as AnyTool);
  }

  /** Names of every registered tool. Static: never lists an external (MCP) name, so no grant list built from it can widen (MC-C1). */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** The live external tool names (the host's view). Never feeds a grant. A fault reads as none. */
  externalNames(): string[] {
    try {
      return [...(this.opts.external?.names() ?? [])];
    } catch {
      return [];
    }
  }

  /** R6 (spec 5.8): `mcp_` names resolve through `external` (main registry only), every other name through the static map. A fault or a mismatched name is "unknown". */
  private lookup(name: string): AnyTool | undefined {
    if (!name.startsWith('mcp_')) return this.tools.get(name);
    try {
      const t = this.opts.external?.get(name);
      return t && t.name === name ? (t as unknown as AnyTool) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The declared kind of a registered tool (undefined: unknown tool or a tool without a kind). Read by the skill grant rule (SK8). */
  kindOf(name: string): ToolKind | undefined {
    return this.lookup(name)?.kind;
  }

  /** AI-APPROVE-1: the declared kind and description of a registered tool (read by the judge input builder). Undefined: unknown tool. */
  describe(name: string): { kind: ToolKind | undefined; description: string } | undefined {
    const t = this.lookup(name);
    return t ? { kind: t.kind, description: t.description } : undefined;
  }

  /** HEAL-1 (HL-C15): whether `name` is a registered tool. The failed-tool footer only ever names registered tools. */
  has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  /** HEAL-1 (HL-C15): whether the tool's output is untrusted text (the footer then shows a fixed reason instead of the error text). */
  untrustedOf(name: string): boolean {
    return this.lookup(name)?.untrustedOutput === true;
  }

  /** Specs for the registered tools among `names` (the actor's prompt-meta allowlist). */
  specsFor(names: string[]): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const n of new Set(names)) {
      const t = this.lookup(n);
      if (!t) continue;
      const { $schema: _drop, ...inputSchema } = z.toJSONSchema(t.inputSchema, { io: 'input' }) as Record<string, unknown>;
      out.push({ name: t.name, description: t.description, inputSchema: flattenTopLevelUnion(inputSchema) });
    }
    return out;
  }

  /** The model asked for `name`: allowlist -> zod -> requiresApproval (stores the validated call) -> run. */
  async run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    return this.exec(name, input, ctx, false);
  }

  /**
   * Runs a call an admin approved (R4, claimed by the scheduler). Everything except the approval question is re-checked
   * against current state: the actor's allowlist, zod, and the tool's own refusals. Nothing runs while halted (D9).
   */
  async runApproved(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    return this.exec(name, input, ctx, true);
  }

  private async exec(name: string, input: unknown, ctx: ToolContext, approved: boolean): Promise<ToolResult> {
    // W-C2 (WEBGRANT-1): an approved replay never spends a web grant, whatever the context carries. Structural: the port is removed here.
    if (approved && ctx.webGrants) {
      const { webGrants: _stripped, ...rest } = ctx;
      ctx = rest;
    }
    // TG-C6 (S1): the same for the task-tree grant, and it is also dropped unless this registry was built for it (the admin registry never was).
    if ((approved || this.opts.treeGrants !== true) && ctx.treeGrants) {
      const { treeGrants: _stripped, ...rest } = ctx;
      ctx = rest;
    }
    // AP-C3: the same for the project autopilot port: never on the approved path, never in a registry built without it.
    if ((approved || this.opts.autopilot !== true) && ctx.autopilot) {
      const { autopilot: _stripped, ...rest } = ctx;
      ctx = rest;
    }
    const audit = (outcome: string) =>
      ctx.audit({ actor: actorKey(ctx.actor), action: 'tool', tool: name, taskId: ctx.task?.id ?? null, outcome });
    if (approved && this.opts.halt.isHalted()) {
      await audit('halted');
      return { ...toolError('the company is halted; the approved call was not run'), notRun: 'halted' };
    }
    const tool = this.lookup(name);
    if (!tool) {
      await audit('unknown_tool');
      return toolError(`unknown tool ${name}`);
    }
    if (!ctx.org.toolsFor(ctx.actor).includes(name)) {
      await audit('denied');
      return toolError(`tool ${name} is not allowed for you`);
    }
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      await audit('invalid_input');
      return toolError(`invalid input for ${name}: ${z.prettifyError(parsed.error).slice(0, ISSUES_MAX)}`);
    }
    let value = parsed.data as never;
    let pre: Awaited<ReturnType<NonNullable<AnyTool['precheck']>>> = null;
    if (tool.precheck) {
      try {
        pre = await tool.precheck(value, ctx);
      } catch {
        pre = { refuse: `${name}: the target could not be checked, nothing was done` };
      }
      if (pre && 'refuse' in pre) {
        await audit('refused');
        return toolError(pre.refuse);
      }
      if (pre && pre.pin) {
        // P3: what the call will act on (read now) becomes part of the stored, digested input; it must still be a valid input
        const merged = tool.inputSchema.safeParse({ ...(value as object), ...(pre.pin as object) });
        if (!merged.success) {
          await audit('refused');
          return toolError(`${name}: the target could not be checked, nothing was done`);
        }
        value = merged.data as never;
      }
    }
    try {
      // P2: a tool with a kind is gated centrally; its own requiresApproval can add approval, never remove it.
      const sum = (pre && 'summary' in pre ? pre.summary : undefined) ?? (tool.summary as ((i: unknown) => { target: string; change: string }) | undefined)?.(value) ?? { target: 'call', change: JSON.stringify(value).slice(0, 300) };
      const central = tool.kind ? approvalFor(tool.kind, ctx, { ...sum, tool: name }) : false;
      // TG-C2: the tool's own answer is computed on its own (never on the approved path, which must not ask again). Only a strict `false` can be waived below.
      let own: ReturnType<AnyTool['requiresApproval']> | undefined;
      let ownThrew = false; // G2-02: a throwing requiresApproval is never decided by autopilot
      if (!approved) {
        try {
          own = tool.requiresApproval(value, ctx);
        } catch (err) {
          if (!central) throw err; // nothing waives anything here: today's fault path
          ownThrew = true;
          own = true; // a throw under a central approval is truthy (a card), never covered
        }
      }
      let approval: ReturnType<AnyTool['requiresApproval']> = approved ? false : central || own!;
      let graceNote = '';
      // TREEGRANT-1 (TG-C5): a covered call of the task owner may run on the live task-tree grant. Every miss falls through to the card below.
      if (approval && !approved && central && own === false && ctx.treeGrants && ctx.task && sameActor(ctx.task.owner, ctx.actor) && treeGrantCovers(name, tool.kind, own)) {
        if (!(await treeGrantRunOk(name, value, ctx))) {
          graceNote = ` (task grant not applied: ${'not_covered' satisfies TaskGrantMiss})`;
        } else {
          let r: Awaited<ReturnType<NonNullable<ToolContext['treeGrants']>['consume']>>;
          try {
            r = await ctx.treeGrants.consume({ rootId: ctx.task.rootId, tool: name, tainted: ctx.tainted() || ctx.task.tainted === true });
          } catch {
            r = { ok: false, why: 'error' }; // the port never throws; a fake that does still only gives a card
          }
          await ctx.audit({ actor: actorKey(ctx.actor), action: 'task_grant.use', tool: name, taskId: ctx.task.id, outcome: r.ok ? `ok #${r.grantId} ${r.used}/${r.max}` : r.why });
          if (r.ok) {
            if (this.opts.halt.isHalted()) {
              await audit('halted'); // a halt that landed after the consume: nothing runs (a plain error, not the approved-replay `notRun`)
              return toolError('the company is halted; the call was not run');
            }
            approval = false;
          } else {
            graceNote = ` (task grant not applied: ${r.why})`;
          }
        }
      }
      // AUTO-2: a chat run with no task gets the conversation task the card path would open (same memoised promise), so company autopilot decides here.
      // AUTO-1: inside an active project tree or a company tree the owner's call is decided here: refused (data-like), run (auto-approved, claimed in a tx), or today's card. Never on the approved path.
      // AP-C1: a tool's OWN approval reason (anything but a strict `false`) is waived only for a name on the frozen AUTOPILOT_OWN_WAIVE list; AP-C2: the run-time predicates of the tree grant still apply.
      const waivable = own === false || (!ownThrew && AUTOPILOT_OWN_WAIVE.includes(name));
      let apTask: Task | null = ctx.task ?? null;
      let companyOn = false;
      if (approval && !approved && !apTask && waivable) { try { companyOn = ctx.autopilot?.companyOn?.() === true; } catch { companyOn = false; } } // AC-C8: a read fault is project rules (the card path)
      if (companyOn && ctx.ensureConversationTask) {
        try { apTask = (await ctx.ensureConversationTask()) ?? null; } catch { apTask = null; } // the card path below meets the same failure (today's behaviour)
        if (apTask && ctx.run.tainted() && !apTask.tainted) { await ctx.tasks.update(apTask.id, { tainted: true }); apTask = { ...apTask, tainted: true }; }
      }
      const apCtx: ToolContext = apTask && apTask !== ctx.task ? { ...ctx, task: apTask } : ctx;
      let runCtx: ToolContext = ctx;
      if (approval && !approved && ctx.autopilot && apTask && sameActor(apTask.owner, ctx.actor) && waivable && (await treeGrantRunOk(name, value, apCtx))) {
        let d: AutopilotDecision;
        try { d = await ctx.autopilot.decide({ taskId: apTask.id, tool: name, input: value }); } catch { d = { kind: 'card' }; }
        if (d.kind === 'refuse') { await audit(`autopilot_refused:${d.code}`); return toolError((d.company === true ? AUTOPILOT_REFUSAL_COMPANY : AUTOPILOT_REFUSAL)[d.code]); }
        if (d.kind === 'run') {
          if (this.opts.halt.isHalted()) { await audit('halted'); return toolError('the company is halted; the call was not run'); }
          try { tool.onApprovalTask?.(value as never, apCtx, { id: apTask.id, rootId: apTask.rootId }); } catch { /* a hook never blocks */ }
          approval = false;
          runCtx = apCtx; // same task context an approved replay would get
        }
      }
      if (approval) {
        // I1: an actor running in someone else's task thread must not file an approval that later replays as the owner.
        if (ctx.task && !sameActor(ctx.task.owner, ctx.actor)) {
          await audit('approval_not_owner');
          return toolError(`${name} needs approval and can only be requested by the task owner`);
        }
        // Mention chat has no task yet: the conversation task (R2) is created now so the approval has somewhere to wait.
        const task = ctx.task ?? (await ctx.ensureConversationTask?.()) ?? null;
        if (!task) {
          await audit('approval_needs_task');
          return toolError(`${name} needs approval and can only run inside a task`);
        }
        // G2-02: a task opened just now (or any task) must carry this run's taint BEFORE the card exists, so the AI approver's judge input is right.
        if (ctx.run.tainted() && !task.tainted) await ctx.tasks.update(task.id, { tainted: true });
        const base = approval === true ? { reason: `tool ${name}` } : approval;
        const req = graceNote ? { ...base, reason: `${base.reason}${graceNote}` } : base;
        // The validated value is stored and shown to the approver; the model's wording never reaches the card.
        const card = await ctx.approvals.request({ kind: 'tool', tool: { name, input: value }, taskId: task.id, reason: req.reason, estCostUsd: 0, requestedBy: ctx.actor });
        await ctx.audit({ actor: actorKey(ctx.actor), action: 'tool', tool: name, taskId: task.id, outcome: 'awaiting_approval' });
        try { tool.onApprovalTask?.(value as never, ctx, { id: task.id, rootId: task.rootId }); } catch { /* a hook never blocks the card */ }
        // F1 / LF8: fixed code-written text; the tool name and card number come from code, the channel is a code-chosen id.
        const cardId = Number.isSafeInteger(card?.id) ? (card.id as number) : null;
        ctx.run.pending.push({ tool: name, card: cardId });
        let where: string | null = null;
        try {
          const ch = card && ctx.approvalChannel ? await ctx.approvalChannel(card) : null;
          where = ch && /^\d{1,25}$/.test(ch) ? `<#${ch}>` : null;
        } catch {
          where = null;
        }
        return { content: awaitingText(cardId, where) };
      }
      const raw = await tool.run(value, runCtx);
      let res = raw;
      if (tool.untrustedOutput) {
        const was = ctx.run.tainted();
        ctx.run.markTainted();
        // G2-04: the task keeps the taint, so a later run on it (resume, roll-up) starts tainted
        if (!was && runCtx.task && !runCtx.task.tainted) await ctx.tasks.update(runCtx.task.id, { tainted: true });
        // The registry owns the wrapper (PF11); tools return raw text. The urls are read from the raw text, not from tool input (R17).
        if (URL_SOURCES.has(name) && !raw.isError) for (const u of extractUrls(raw.content)) ctx.run.knownUrls.add(u);
        res = { ...raw, content: wrapUntrusted({ author: name, authorKind: 'model', source: tool.untrustedSource ?? 'tool_output', content: raw.content }) };
      }
      await audit(res.isError ? 'tool_error' : 'ok');
      return res;
    } catch (err) {
      await audit('error');
      // A throw (not a refusal or a validation error, which return results above) is a system fault.
      this.opts.incidents?.report({ source: 'tool', stage: 'run', toolName: name, err, actor: ctx.actor, ...(ctx.task ? { taskId: ctx.task.id, taskTitle: ctx.task.title } : {}) });
      return toolError(`tool ${name} failed`);
    }
  }
}
