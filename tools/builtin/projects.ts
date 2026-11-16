import { z } from 'zod';
import { isConversationTask } from '../../agents/conversation.js';
import { actorKey } from '../../governance/budget.js';
import { ParentCancelledError } from '../../db/repos/tasks.js';
import { PROPOSE_TEXT, ProjectProposeInput, type ProjectService } from '../../governance/projects.js';
import { toolError, type ToolContext, type ToolPlugin, type ToolResult } from '../types.js';

/** AUTO-1: the project tools. Both names are in builtinNames, so no skill and no tools.byDept list can grant them. */
export const PROJECT_TOOL_NAMES = ['project_propose', 'project_task'] as const;

/** `project_task` input (SA-1 3.8). Strict. */
export const ProjectTaskInput = z.object({ projectId: z.number().int().min(1), title: z.string().trim().min(1).max(200), instruction: z.string().trim().min(1).max(4000) }).strict();
export type ProjectTaskInput = z.infer<typeof ProjectTaskInput>;

/** SA-1 5.3: fixed refusal texts; none echoes input or model text. */
export const PROJECT_TASK_TEXT = {
  halted: PROPOSE_TEXT.halted,
  off: 'Autopilot is switched off; project tasks cannot be opened.',
  not_head: 'Only a department head can open a project task.',
  not_chat: 'project_task is only for chat runs; inside a task use create_task.',
  not_admin: 'project_task can only be used when a Bot Admin asked in this chat.',
  tainted: 'project_task cannot be used after reading outside content; ask the person to send a new message.',
  no_project: 'There is no active project with that number.',
  root_ended: "That project's root task has ended.",
  children: 'this task already has the maximum number of child tasks',
  open: 'the company has too many open tasks; finish or close some first',
} as const;
type TaskCode = keyof typeof PROJECT_TASK_TEXT;

const runOf = (ctx: ToolContext) => ({ tainted: ctx.tainted(), task: ctx.task ? { tainted: ctx.task.tainted } : null });

/**
 * `project_propose` (SA-1 3.2): the CEO asks the Bot Admins to start a project with a deadline and a budget. No `kind` and `requiresApproval` false (the tool_request precedent):
 * its only effect is a row and a card in #setting; nothing starts until a live Bot Admin approves. The service refuses everyone but the CEO and checks halt and the switch itself.
 */
export function projectTools(svc: { projects: ProjectService }): ToolPlugin<never>[] {
  const propose: ToolPlugin<ProjectProposeInput> = {
    name: 'project_propose',
    description:
      'Ask the Bot Admins to start a PROJECT: a goal with a deadline (YYYY-MM-DD, up to one year ahead) and a budget (maxLocalCalls, maxUsd). ' +
      'It posts one card; nothing starts until a Bot Admin approves it. Once approved, the whole project tree runs on its own: no per-call approval cards, no questions to the owner. ' +
      'Optional adopt: ids (8 or more characters) of existing open root tasks to bring into the project. At most 3 open proposals. CEO only.',
    inputSchema: ProjectProposeInput,
    requiresApproval: () => false,
    async run(input, ctx): Promise<ToolResult> {
      const r = await svc.projects.propose(ctx.actor, runOf(ctx), input);
      return r.ok ? { content: r.text } : toolError(r.error);
    },
  };
  const task: ToolPlugin<ProjectTaskInput> = {
    name: 'project_task',
    description:
      'Open a task INSIDE an approved project, from a chat where a Bot Admin asked for work (give the project number, a short title and a self-contained instruction). ' +
      'It creates a task owned by you under the project, which runs as its own task and reports in its thread; do not do the work in the chat. ' +
      'Only in a chat started by a Bot Admin, and not after reading outside content.',
    inputSchema: ProjectTaskInput,
    requiresApproval: () => false,
    async run(input, ctx): Promise<ToolResult> {
      const no = async (code: TaskCode): Promise<ToolResult> => {
        try { await ctx.audit({ actor: actorKey(ctx.actor), action: 'project.task', tool: 'project_task', taskId: ctx.task?.id ?? null, outcome: `refused:${code}` }); } catch { /* the audit never changes the refusal */ }
        return toolError(PROJECT_TASK_TEXT[code]);
      };
      const gate = svc.projects.gateRefusal(); // 1 halted, 2 off
      if (gate) return no(gate);
      if (ctx.actor.kind !== 'head') return no('not_head'); // 3
      if (ctx.task && !isConversationTask(ctx.task)) return no('not_chat'); // 4
      if (ctx.personAdmin !== true) return no('not_admin'); // 5: the loop derives it from trigger.msg.isAdmin only
      if (ctx.tainted() || ctx.task?.tainted === true) return no('tainted'); // 6
      const project = await svc.projects.openProject(input.projectId); // 7
      if (!project) return no('no_project');
      const root = await ctx.tasks.get(project.rootTaskId);
      if (!root || root.status === 'done' || root.status === 'cancelled') return no('root_ended'); // 8
      if (!(await ctx.limits.checkChildren(root.id))) return no('children'); // 9
      if (!(await ctx.limits.checkOpenTasks())) return no('open');
      let made: Awaited<ReturnType<ToolContext['tasks']['create']>>;
      try {
        made = await ctx.tasks.create({
          title: input.title, description: `${input.instruction}\n\nOpened from a chat by a Bot Admin for project #${project.id}.`, deptId: ctx.actor.dept, owner: ctx.actor, requester: ctx.actor,
          origin: 'delegated', status: 'todo', parentId: root.id, tainted: false, ...(ctx.source.userId ? { sourceUserId: ctx.source.userId } : {}),
          // a department with no work channel (Praw) opens the new task's thread in the chat channel the Bot Admin wrote in (an id from code, never tool input); without it the scheduler could not open a thread at all
          ...(!ctx.org.dept(ctx.actor.dept)?.workChannelId && ctx.source.channelId ? { channelId: ctx.source.channelId } : {}),
        });
      } catch (err) {
        if (err instanceof ParentCancelledError) return no('root_ended');
        throw err;
      }
      await ctx.bus.emit('task.created', { task: made });
      await ctx.audit({ actor: actorKey(ctx.actor), action: 'project.task', tool: 'project_task', taskId: made.id, outcome: `ok p${project.id} ${made.id.slice(0, 8)}` });
      const off = ctx.offDay?.();
      const waits = off?.off ? `. It will start on the next workday (today is ${off.reason === 'holiday' ? 'a company holiday' : 'a weekly off day'}).` : '';
      return { content: `opened task ${made.id} in project #${project.id}; it runs as its own task now and reports in its thread. Tell the person it has started; do not do the work in this chat.${waits}` };
    },
  };
  return [propose, task] as unknown as ToolPlugin<never>[];
}
