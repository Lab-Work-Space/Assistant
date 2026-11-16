import { z } from 'zod';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import { DEPT_IDS, type DeptId } from '../../core/index.js';
import { DEFAULT_DUTIES, DUTY_IDS, dutyRefusal } from '../../company/duties.js';
import { ParentCancelledError } from '../../db/repos/tasks.js';
import { sameActor, toolError, type ToolContext, type ToolPlugin, type ToolResult } from '../types.js';

export const createTaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  assignee: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('head'), dept: z.enum(DEPT_IDS) }),
    z.object({ kind: z.literal('persona'), personaId: z.string().min(1).max(64) }),
  ]),
  /** Required, finite, non-negative (Gate 1 D1). Approval also triggers from actual tree spend (loop). */
  /** WS12: the duty this task belongs to, a value of the closed enum (company/duties.ts). The owner department must hold it; checked in code. */
  duty: z.enum(DUTY_IDS).optional(),
  /** TEAMTALK-1: what "done" means (shown on the handoff line and the card; display only) and the due date (display only, no reminder; the range is checked in code). */
  acceptance: z.string().trim().max(300).optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  estCostUsd: z.number({ error: 'estCostUsd is required and must be a number' }).min(0, 'estCostUsd must be >= 0').max(1_000_000, 'estCostUsd is too large'),
});
export type CreateTaskInput = z.infer<typeof createTaskInput>;
type Input = CreateTaskInput;

const DUE_REFUSAL = 'due must be a date from today to one year ahead';
const isoDay = (y: number, m: number, d: number): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** A real calendar date (2026-02-31 is not) within [today, today + 365 days]. Pure date arithmetic in UTC: both sides are plain calendar days. */
export function dueOk(due: string, today: string): boolean {
  const [y, m, d] = due.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  const t = new Date(`${today}T00:00:00Z`);
  const max = new Date(t.getTime() + 365 * 86_400_000);
  return due >= today && due <= isoDay(max.getUTCFullYear(), max.getUTCMonth() + 1, max.getUTCDate());
}

/**
 * Where the child task's card and thread open. A persona works only in its own direct room; a head delegating to another
 * department (Praw included) uses the bot-to-bot war room. Null: the assignee's department work channel.
 */
function homeChannel(a: Input['assignee'], dept: DeptId, ctx: ToolContext): string | null {
  if (a.kind === 'persona') return ctx.org.persona(a.personaId)?.directChannelId ?? null;
  return ctx.actor.kind === 'head' && ctx.actor.dept !== dept ? AI_WARROOM_CHANNEL_ID : null;
}

/** The assignee's department if the assignee exists, it and its department are enabled and online, else an error text. */
function assigneeDept(a: Input['assignee'], ctx: ToolContext): DeptId | string {
  let dept: DeptId;
  if (a.kind === 'persona') {
    const p = ctx.org.persona(a.personaId);
    if (!p) return `unknown persona ${a.personaId}`;
    if (!p.enabled) return `persona ${a.personaId} is disabled`;
    dept = p.deptId as DeptId;
  } else {
    if (!ctx.org.dept(a.dept)) return `unknown department ${a.dept}`;
    dept = a.dept;
  }
  const d = ctx.org.dept(dept);
  if (!d?.enabled) return `department ${dept} is disabled`;
  // R1: every task opens a thread in the department work channel (scheduler.ensureThread).
  if (a.kind === 'persona') {
    // Personas speak only in their own direct room: without one they cannot be given work.
    if (!ctx.org.persona(a.personaId)?.directChannelId) return `persona ${a.personaId} has no direct channel; assign the task to the head of ${dept}`;
  } else if (!d.workChannelId) return `${dept} has no work channel; a Bot Admin must run /channel map … work:true`;
  if (ctx.deptOnline && !ctx.deptOnline(dept)) return `department ${dept} is offline`;
  return dept;
}

/**
 * P16d: praw acts for a human, so the human must be able to see the target department's work channel in Discord
 * (real permissions via DiscordPort.canMemberView). Fails closed when the lookup fails.
 */
async function memberCannotView(dept: DeptId, ctx: ToolContext, allHeads = false): Promise<string | null> {
  if (!allHeads && (ctx.actor.kind !== 'head' || ctx.actor.dept !== 'praw')) return null;
  // RF9: for forward_to (every head) the person is the ROOT requester of the tree, found through rootId; a child task's requester is a bot.
  let userId = ctx.source.userId ?? (ctx.task?.requester.kind === 'human' ? ctx.task.requester.userId : null);
  if (allHeads && ctx.task) {
    const root = ctx.task.id === ctx.task.rootId ? ctx.task : await ctx.tasks.get(ctx.task.rootId).catch(() => null);
    if (root?.requester.kind === 'human') userId = root.requester.userId;
  }
  const channelId = ctx.org.dept(dept)?.workChannelId;
  if (!userId || !channelId) return null;
  const refusal = `the requesting member has no access to ${dept}'s channels, so praw cannot delegate there for them`;
  if (!ctx.canMemberView) return refusal; // no permission check wired: fail closed
  try {
    if (await ctx.canMemberView(userId, channelId)) return null;
  } catch {
    // fall through: refuse
  }
  return refusal;
}

/**
 * Delegates work. Owner = assignee, requester = the calling actor, parent = the current task (never from input,
 * Gate 1 D14). Guards: delegation rules, depth, children per task and open tasks (D2). An estimate above the
 * approval threshold creates the child as awaiting_approval with an approval request attached to the child.
 */
export const createTask: ToolPlugin<Input> = {
  name: 'create_task',
  description:
    'Create a task for a member of your department or for the head of another department. ' +
    'Give a short title, a self-contained description with the expected result, the assignee, your cost estimate in USD, and the duty the work belongs to (from the fixed duty list in your instructions). ' +
    'Also set acceptance (one line: how the assignee and you will know it is done) and due (YYYY-MM-DD) when you can; both are shown to the team.',
  inputSchema: createTaskInput,
  // The estimate gate is handled in run(): the approval belongs to the new child task, which must exist first.
  requiresApproval: () => false,
  run: (input, ctx) => delegate(input, ctx),
};

/** What forward_to adds on top of create_task (RF9-RF11); create_task passes nothing. */
export type DelegateExtra = {
  /** Non-mutating checks run once the parent is known (run cap, chain, per-root cap availability). */
  check?: (parent: ToolContext['task']) => Promise<string | null>;
  /** Takes the per-root slot (conditional UPDATE) right before the child is created; false = cap reached. */
  take?: (parent: ToolContext['task']) => Promise<boolean>;
  /** Code-made title / description / card mode for the child. */
  child?: { title: string; description: string; forwardCard: 'full' | 'link' };
  /** Apply the member-can-view check to every head, not only Praw. */
  viewCheckAllHeads?: boolean;
  /** Called once the child exists. */
  created?: () => void;
};

/** The one delegation path: create_task and forward_to both run it. */
export async function delegate(input: Input, ctx: ToolContext, extra: DelegateExtra = {}): Promise<ToolResult> {
  {
    if (ctx.task && !sameActor(ctx.task.owner, ctx.actor)) return toolError('you can only delegate from a task you own');
    const dept = assigneeDept(input.assignee, ctx);
    if (!(DEPT_IDS as readonly string[]).includes(dept)) return toolError(dept);
    if (!ctx.org.canDelegate(ctx.actor, input.assignee)) return toolError('you cannot delegate to that assignee');
    // T12: a real calendar date from today to one year ahead, in the schedule timezone; the fixed refusal echoes nothing the model wrote.
    if (input.due !== undefined && !dueOk(input.due, ctx.today?.() ?? new Date().toISOString().slice(0, 10))) return toolError(DUE_REFUSAL);
    // WS12: enum membership in code, before anything is created or counted. The refusal text is fixed (department id, duty id, owner handle) and echoes nothing the model wrote.
    if (input.duty) {
      const why = dutyRefusal(ctx.duties?.() ?? DEFAULT_DUTIES, dept as DeptId, input.duty);
      if (why) return toolError(why);
    }
    const denied = await memberCannotView(dept as DeptId, ctx, extra.viewCheckAllHeads);
    if (denied) return toolError(denied);
    // R2: a human's chat with praw has no task yet; the conversation task becomes the parent (created only now that the request is valid).
    let parent = ctx.task;
    if (!parent && ctx.ensureConversationTask) {
      try {
        parent = await ctx.ensureConversationTask();
      } catch (err) {
        return toolError(err instanceof Error ? err.message : 'the conversation could not be started');
      }
    }
    if (parent && !ctx.limits.checkDepth(parent.depth)) return toolError('delegation depth limit reached; do the work yourself or mark the task blocked');
    if (parent && !(await ctx.limits.checkChildren(parent.id))) return toolError('this task already has the maximum number of child tasks');
    if (!(await ctx.limits.checkOpenTasks())) return toolError('the company has too many open tasks; finish or close some first');

    if (extra.check) {
      const why = await extra.check(parent);
      if (why) return toolError(why);
    }
    // TW6: a root task born from bot talk (no parent: warroom talk, a meeting close) counts against the daily cap on bot-created root tasks.
    const releaseSlot = !parent && ctx.rootTaskGate ? await ctx.rootTaskGate.acquire() : undefined;
    if (!parent && ctx.rootTaskGate && !releaseSlot) return toolError('the daily limit on tasks started from bot-to-bot talk and meetings is reached; try again tomorrow');
    try {
      if (extra.take && !(await extra.take(parent))) return toolError('this task tree already forwarded the maximum number of times');
      const res = await createChild(input, ctx, parent, dept as DeptId, extra.child);
      if (!res.isError) extra.created?.();
      return res;
    } finally {
      releaseSlot?.();
    }
  }
}

async function createChild(input: Input, ctx: ToolContext, parent: ToolContext['task'], dept: DeptId, child?: DelegateExtra['child']): Promise<ToolResult> {
  {
    // AUTO-1 (SA-1 C16): inside an active project the estimate card is skipped; the project's USD cap governs. A port fault reads as "no project" (today's card).
    const inProject = parent && ctx.autopilot ? !!(await ctx.autopilot.projectOf(parent.id).catch(() => null)) : false;
    // AUTO-2 (SA-1 3.6, AC-C8/C12): in a company tree (or, with no parent, company scope on) the estimate card is skipped too; budgets and caps are unchanged. Any fault reads as "no skip".
    let inCompany = false;
    try { inCompany = parent ? (ctx.autopilot?.inCompany ? await ctx.autopilot.inCompany(parent.id).catch(() => false) : false) : ctx.autopilot?.companyOn?.() === true; } catch { inCompany = false; }
    const needsApproval = !inProject && !inCompany && ctx.approvals.needsApproval(input.estCostUsd);
    const channelId = homeChannel(input.assignee, dept as DeptId, ctx);
    let task: Awaited<ReturnType<ToolContext['tasks']['create']>>;
    try {
      task = await ctx.tasks.create({
        title: child?.title ?? input.title,
        description: child?.description ?? input.description,
        ...(child ? { forwardCard: child.forwardCard } : {}),
        deptId: dept as DeptId,
        owner: input.assignee,
        requester: ctx.actor,
        origin: 'delegated', // always: a delegated task never inherits a human origin (Gate 1 P1)
        parentId: parent?.id ?? null,
        status: needsApproval ? 'awaiting_approval' : 'todo',
        estCostUsd: input.estCostUsd,
        tainted: ctx.tainted(), // G2-04: the child starts as tainted as the run that delegated it
        ...(channelId ? { channelId } : {}),
        ...(input.acceptance ? { acceptance: input.acceptance } : {}),
        ...(input.due ? { dueOn: input.due } : {}),
      });
    } catch (err) {
      if (err instanceof ParentCancelledError) return toolError('the parent task was cancelled'); // TA-C8: an admin cancel landed while this call ran
      throw err;
    }
    if (needsApproval) {
      try {
        await ctx.approvals.request({ taskId: task.id, reason: `estimated cost ${input.estCostUsd.toFixed(2)} USD`, estCostUsd: input.estCostUsd, requestedBy: ctx.actor });
      } catch {
        // Never leave an awaiting child without an approval row: it would never expire and could be resumed unapproved.
        await ctx.tasks.update(task.id, { status: 'cancelled' }, 'awaiting_approval');
        return toolError('approval could not be requested; the task was cancelled');
      }
      task = (await ctx.tasks.get(task.id)) ?? task;
    }
    await ctx.bus.emit('task.created', { task });
    // Off day: the scheduler holds delegated work until the next workday; say so, so the reply to a human can too. Never the holiday name.
    const off = ctx.offDay?.();
    // OT-1: with approved overtime the work can start now, but only while the runs last, so the text says "can" (true after the runs run out too). Never the holiday name.
    const until = off?.off ? await ctx.otUntil?.().catch(() => null) ?? null : null;
    const waits = off?.off
      ? until !== null
        ? `. It can start now while approved overtime runs remain (until ${until}); otherwise it starts on the next workday (today is ${off.reason === 'holiday' ? 'a company holiday' : 'a weekly off day'}).`
        : `. It will start on the next workday (today is ${off.reason === 'holiday' ? 'a company holiday' : 'a weekly off day'}).`
      : '';
    return { content: `created task ${task.id} (${task.status}) owned by ${input.assignee.kind === 'head' ? `head of ${dept}` : input.assignee.personaId}${waits}` };
  }
}
