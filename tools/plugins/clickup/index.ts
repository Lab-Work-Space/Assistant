import { z } from 'zod';
import { redactText } from '../../../core/logger.js';
import { HIDDEN } from '../../../discord/embeds/approval.js';
import { CLICKUP_ID } from '../../../services/ids.js';
import { toolError, type ToolContext, type ToolPlugin, type ToolResult } from '../../types.js';
import type { GroupFactory } from '../index.js';
import { clickupWriteTools } from './write.js';
import type { ClickUpClient } from './client.js';
import { ClickUpError, TASK_CAP, listPathText, type Analysis, type CuTask } from './client.js';

const LIST_MAX = 20;
const DESC_MAX = 4000;
const COMMENT_MAX = 500;

const taskId = z.string().regex(CLICKUP_ID, 'a ClickUp task id (lowercase letters and digits)').describe('ID of the task');
const project = z.string().max(100).optional().describe('Only the configured project (list) can be read: leave empty, give its name or id, or "all"');

const iso = (ms: unknown) => (Number.isFinite(Number(ms)) && ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'none');
const line = (t: CuTask) => `- ${t.name} (id: ${t.id}, status: ${t.status?.status ?? 'unknown'}${t.assignees?.length ? `, assignees: ${t.assignees.map((a) => a.username ?? '?').join(', ')}` : ''})`;

function analysisText(title: string, a: Analysis): string {
  const m = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  none';
  return [
    `Project: ${title}`, `Total: ${a.truncated ? `at least ${a.total} tasks (capped at ${TASK_CAP}; the numbers below cover only those)` : `${a.total} tasks`}, done ${a.done} (${a.donePct}%)`, `By status:\n${m(a.byStatus)}`, `By assignee:\n${m(a.byAssignee)}`,
    `Overdue: ${a.overdue}, due within 7 days: ${a.dueSoon}, unassigned: ${a.unassigned}`,
  ].join('\n');
}

/**
 * ClickUp read tools (Task 25; the write tools are in write.ts, Task 26). Scope (P9): the client only ever talks to the one configured list; a task of another
 * list or a `project` naming another list is refused. Bodies, names and comments are written by other people, so every
 * tool is untrusted output (the registry wraps the text and taints the run); tools return raw text.
 */
type Guarded = (f: () => Promise<string>) => Promise<ToolResult>;
const HIER_LINES = 150;
const SEARCH_LINES = 20;
const wsProject = z.string().max(100).optional().describe('REQUIRED: the list to read, by id or exact name (see clickup_list_projects)');
/** All-workspaces mode: an exact workspace name; control and invisible characters are refused (it is matched against vendor names, never shown as a pin). */
const workspaceName = z.string().max(100).refine((v) => ![...v].some((ch) => /\p{Cc}/u.test(ch)) && !new RegExp(HIDDEN.source, 'u').test(v), { message: 'text may not contain control or invisible characters' })
  .optional().describe('Exact workspace name (see clickup_list_projects); leave empty to use every workspace');

/** An empty workspace is not a dead end for an actor that may create: name the next step (fixed text, offered only when both create tools are). */
function emptyHint(ctx: ToolContext): string {
  const own = ctx.org.toolsFor(ctx.actor);
  return own.includes('clickup_create_space') && own.includes('clickup_create_list')
    ? ' Create one: clickup_create_space (it needs approval), then clickup_create_list with the new space id, then clickup_create_task with the new list id.' : '';
}

/** Workspace mode (CLICKUP-ALL-1): every list of the one workspace. Same output rules as list mode: untrusted, whitelist rendering, redacted. */
function workspaceReadTools(cu: ClickUpClient, guarded: Guarded): ToolPlugin<any>[] {
  const all = cu.teamScope === 'all';
  const base = { kind: 'read', untrustedOutput: true, untrustedSource: 'clickup', requiresApproval: () => false } as const;
  const tool = <I>(t: Omit<ToolPlugin<I>, 'kind' | 'untrustedOutput' | 'untrustedSource' | 'requiresApproval'>): ToolPlugin<I> => ({ ...base, ...t });
  const wsLine = (t: CuTask) => `- ${t.name} (id: ${t.id}, status: ${t.status?.status ?? 'unknown'}, list: ${t.list?.name ?? '?'}${t.assignees?.length ? `, assignees: ${t.assignees.map((a) => a.username ?? '?').join(', ')}` : ''})`;
  return [
    tool({
      name: 'clickup_list_projects',
      description: all
        ? 'Show every ClickUp workspace this token can see as Workspace / Space / Folder / List with each list id. Give workspace (exact name) to read one workspace in full. Call this first when asked which projects exist or to find a list id; never answer with task names.'
        : 'Show the ClickUp workspace as Space / Folder / List with each list id. Call this first when asked which projects exist or to find a list id; never answer with task names.',
      inputSchema: all ? z.object({ workspace: workspaceName }) : z.object({}),
      run: (i: { workspace?: string }, ctx: ToolContext) => guarded(async () => {
        const h = await cu.hierarchy(all && i.workspace ? { workspace: i.workspace } : undefined);
        if (!h.entries.length) return `${all ? 'No lists found.' : 'The workspace has no lists.'}${emptyHint(ctx)}`;
        const lines = h.entries.slice(0, HIER_LINES).map((e) => `- ${all && e.workspace !== undefined ? `${e.workspace} / ` : ''}${e.space} / ${e.folder ? `${e.folder} / ` : ''}${e.name} (id: ${e.id})`);
        const more = h.entries.length > HIER_LINES || h.truncated;
        return `${lines.join('\n')}${more ? `\n(truncated: showing ${lines.length} lists of the first ${Math.min(h.spaces, 20)} spaces; ask for a list by id or name${all ? '; name a workspace to see more' : ''})` : ''}`;
      }),
    }),
    tool({
      name: 'clickup_search_tasks',
      description: `Search tasks across the whole ClickUp workspace${all ? 's' : ''}, newest update first. Filters: query (text in the task name), ${all ? 'workspace (exact name), ' : ''}list_id, space_id, assignee (exact username or email), status, include_done, updated_within_days. Shows at most 20 tasks (name, id, status, list, assignees); use clickup_get_task_detail for one task.`,
      inputSchema: z.object({
        query: z.string().max(100).optional().describe('Text the task name contains'), list_id: z.string().regex(CLICKUP_ID).optional(), space_id: z.string().regex(CLICKUP_ID).optional(),
        ...(all ? { workspace: workspaceName } : {}),
        assignee: z.string().max(200).optional().describe('Exact username or email'), status: z.string().max(100).optional(), include_done: z.boolean().optional(),
        updated_within_days: z.number().int().min(1).max(365).optional(),
      }),
      run: (i: { query?: string; list_id?: string; space_id?: string; workspace?: string; assignee?: string; status?: string; include_done?: boolean; updated_within_days?: number }) => guarded(async () => {
        const r = await cu.searchTasks({
          ...(i.query ? { query: i.query } : {}), ...(i.list_id ? { listId: i.list_id } : {}), ...(i.space_id ? { spaceId: i.space_id } : {}), ...(all && i.workspace ? { workspace: i.workspace } : {}), ...(i.assignee ? { assignee: i.assignee } : {}),
          ...(i.status ? { status: i.status } : {}), ...(i.include_done ? { includeDone: true } : {}), ...(i.updated_within_days ? { updatedWithinDays: i.updated_within_days } : {}),
        });
        const note = !r.truncated ? '' : r.searched !== undefined ? ` (searched ${r.searched} workspaces, first page each; narrow with workspace, list, space, status or assignee)` : ' (the search stopped at 300 tasks; narrow it with a list, space, status or assignee)';
        if (!r.tasks.length) return `No tasks found${note}.`;
        return `${r.truncated ? 'at least ' : ''}${r.tasks.length} task(s)${r.tasks.length > SEARCH_LINES ? `, showing the first ${SEARCH_LINES}` : ''}${note}:\n${r.tasks.slice(0, SEARCH_LINES).map(wsLine).join('\n')}`;
      }),
    }),
    tool({
      name: 'clickup_list_open_tasks',
      description: 'List tasks of one ClickUp list (give project = list id or exact name). Default: unfinished tasks only; include_done=true adds finished ones; assignee filters by username or email.',
      inputSchema: z.object({ project: wsProject, assignee: z.string().max(200).optional().describe('Username or email of the assignee'), include_done: z.boolean().optional().describe('true = also finished tasks') }),
      run: (i: { project?: string; assignee?: string; include_done?: boolean }) => guarded(async () => {
        const r = await cu.listOpenTasks({ includeDone: i.include_done === true, listId: await cu.resolveList(i.project) });
        let tasks = r.tasks;
        const who = (i.assignee ?? '').trim().toLowerCase();
        if (who) tasks = tasks.filter((t) => (t.assignees ?? []).some((a) => { const n = (a.username ?? '').toLowerCase(); return n === who || (a.email ?? '').toLowerCase() === who || n.includes(who); }));
        const note = r.truncated ? ` (the list has more than ${TASK_CAP} tasks; only the first ${TASK_CAP} were read, so this list may be incomplete)` : '';
        if (!tasks.length) return `No ${i.include_done ? '' : 'open '}tasks${who ? ` for ${i.assignee}` : ''} in the list${note}.`;
        return `${r.truncated ? 'at least ' : ''}${tasks.length} task(s)${tasks.length > LIST_MAX ? `, showing the first ${LIST_MAX}` : ''}${note}:\n${tasks.slice(0, LIST_MAX).map(line).join('\n')}`;
      }),
    }),
    tool({
      name: 'clickup_get_task_detail',
      description: 'Full detail of one task of the workspace: list, description, assignees, due date, priority, status, the statuses its list allows, subtasks, url.',
      inputSchema: z.object({ task_id: taskId }),
      run: (i: { task_id: string }) => guarded(async () => {
        const { task: t, list } = await cu.describeTask(i.task_id);
        const desc = (t.description ?? '').trim();
        const subs = t.subtasks ?? [];
        return [
          `Name: ${t.name}`, `List: ${listPathText(list)} (id: ${list.id})`, `Status: ${t.status?.status ?? 'unknown'}`, `Statuses of this list: ${list.statuses.join(', ') || 'none'}`,
          `Assignees: ${(t.assignees ?? []).map((a) => a.username ?? '?').join(', ') || 'none'}`,
          `Due: ${iso(t.due_date)}`, `Priority: ${t.priority?.priority ?? 'none'}`, `Description: ${desc ? desc.slice(0, DESC_MAX) + (desc.length > DESC_MAX ? ' [truncated]' : '') : 'none'}`,
          `Url: ${CLICKUP_ID.test(t.id) ? `https://app.clickup.com/t/${t.id}` : ''}`, ...(subs.length ? [`Subtasks (${subs.length}): ${subs.slice(0, 10).map((s) => s.name).join(', ')}`] : []), // CM-C7 a: rebuilt from the task id; the vendor url can carry a team id
        ].join('\n');
      }),
    }),
    tool({
      name: 'clickup_list_comments',
      description: 'Comments of one task of the workspace (newest first, up to 20).',
      inputSchema: z.object({ task_id: taskId }),
      run: (i: { task_id: string }) => guarded(async () => {
        const cs = await cu.listComments(i.task_id);
        if (!cs.length) return 'No comments.';
        return cs.slice(0, LIST_MAX).map((c) => `- ${c.user?.username ?? '?'}: ${(c.comment_text ?? '').slice(0, COMMENT_MAX)}`).join('\n');
      }),
    }),
    tool({
      name: 'clickup_list_members',
      description: 'Members with explicit access to one ClickUp list (project = list id or exact name); use it to learn the exact username before filtering by assignee or assigning.',
      inputSchema: z.object({ project: wsProject }),
      run: (i: { project?: string }) => guarded(async () => {
        const ms = await cu.listMembers({ listId: await cu.resolveList(i.project) });
        return ms.length ? ms.map((m) => `- ${m.username ?? '?'}${m.email ? ` (${m.email})` : ''}`).join('\n') : 'No members with explicit access to this list.';
      }),
    }),
    tool({
      name: 'clickup_analyze_project',
      description: 'Overview numbers for one ClickUp list (project = list id or exact name): progress %, tasks per status, workload per person, overdue, due within 7 days, unassigned. Summarise the numbers in your own words and point out concerns.',
      inputSchema: z.object({ project: wsProject }),
      run: (i: { project?: string }) => guarded(async () => {
        const lid = await cu.resolveList(i.project);
        const a = await cu.analyze({ listId: lid });
        return a.total === 0 ? 'The list has no tasks to analyse.' : analysisText((await cu.hierarchy()).entries.find((e) => e.id === lid)?.name ?? 'list', a);
      }),
    }),
  ];
}

export const clickupGroup: GroupFactory = (deps) => {
  const cu = deps.clickup;
  if (!cu) return { id: 'clickup', disabled: 'CLICKUP_API_TOKEN / CLICKUP_LIST_ID (or CLICKUP_TEAM_ID = a workspace id or all) not set' };

  const guarded = async (f: () => Promise<string>): Promise<ToolResult> => {
    try {
      return { content: redactText(await f()) }; // defence in depth: a credential-shaped string in vendor data never reaches the model
    } catch (err) {
      return toolError(err instanceof ClickUpError ? err.message : 'ClickUp request failed'); // fixed text and status only
    }
  };
  const scoped = async (p: string | undefined): Promise<void> => {
    if (!(await cu.inScope(p))) throw new ClickUpError('ClickUp: that project is outside the configured list');
  };
  if (cu.mode === 'workspace') return { id: 'clickup', tools: [...workspaceReadTools(cu, guarded), ...clickupWriteTools(cu, guarded, { cfg: deps.cfg, clock: deps.clock, ...(deps.clickupUsage ? { usage: deps.clickupUsage } : {}), ...(deps.clickupSecrets ? { secrets: deps.clickupSecrets } : {}) })] };
  const base = { kind: 'read', untrustedOutput: true, untrustedSource: 'clickup', requiresApproval: () => false } as const;
  const tool = <I>(t: Omit<ToolPlugin<I>, 'kind' | 'untrustedOutput' | 'untrustedSource' | 'requiresApproval'>): ToolPlugin<I> => ({ ...base, ...t });

  const tools: ToolPlugin<any>[] = [
    tool({
      name: 'clickup_list_projects',
      description: 'Show the ClickUp project (list) this assistant is allowed to read. Call this first when asked which projects exist; never answer with task names.',
      inputSchema: z.object({}),
      run: () => guarded(async () => (await cu.listProjects()).map((p) => `- ${p.name} (id: ${p.id}${p.folder ? `, folder: ${p.folder}` : ''}${p.space ? `, space: ${p.space}` : ''})`).join('\n')),
    }),
    tool({
      name: 'clickup_list_open_tasks',
      description: 'List tasks of the configured ClickUp project. Default: unfinished tasks only; include_done=true adds finished ones; assignee filters by username or email.',
      inputSchema: z.object({ project, assignee: z.string().max(200).optional().describe('Username or email of the assignee'), include_done: z.boolean().optional().describe('true = also finished tasks') }),
      run: (i: { project?: string; assignee?: string; include_done?: boolean }) => guarded(async () => {
        await scoped(i.project);
        const r = await cu.listOpenTasks({ includeDone: i.include_done === true });
        let tasks = r.tasks;
        const who = (i.assignee ?? '').trim().toLowerCase();
        if (who) tasks = tasks.filter((t) => (t.assignees ?? []).some((a) => { const n = (a.username ?? '').toLowerCase(); return n === who || (a.email ?? '').toLowerCase() === who || n.includes(who); }));
        const note = r.truncated ? ` (the project has more than ${TASK_CAP} tasks; only the first ${TASK_CAP} were read, so this list may be incomplete)` : '';
        if (!tasks.length) return `No ${i.include_done ? '' : 'open '}tasks${who ? ` for ${i.assignee}` : ''} in the project${note}.`;
        return `${r.truncated ? 'at least ' : ''}${tasks.length} task(s)${tasks.length > LIST_MAX ? `, showing the first ${LIST_MAX}` : ''}${note}:\n${tasks.slice(0, LIST_MAX).map(line).join('\n')}`;
      }),
    }),
    tool({
      name: 'clickup_get_task_detail',
      description: 'Full detail of one task of the configured project: description, assignees, due date, priority, status, subtasks, url.',
      inputSchema: z.object({ task_id: taskId }),
      run: (i: { task_id: string }) => guarded(async () => {
        const t = await cu.getTask(i.task_id);
        const desc = (t.description ?? '').trim();
        const subs = t.subtasks ?? [];
        return [
          `Name: ${t.name}`, `Status: ${t.status?.status ?? 'unknown'}`, `Assignees: ${(t.assignees ?? []).map((a) => a.username ?? '?').join(', ') || 'none'}`,
          `Due: ${iso(t.due_date)}`, `Priority: ${t.priority?.priority ?? 'none'}`, `Description: ${desc ? desc.slice(0, DESC_MAX) + (desc.length > DESC_MAX ? ' [truncated]' : '') : 'none'}`,
          `Url: ${t.url ?? ''}`, ...(subs.length ? [`Subtasks (${subs.length}): ${subs.slice(0, 10).map((s) => s.name).join(', ')}`] : []),
        ].join('\n');
      }),
    }),
    tool({
      name: 'clickup_list_comments',
      description: 'Comments of one task of the configured project (newest first, up to 20).',
      inputSchema: z.object({ task_id: taskId }),
      run: (i: { task_id: string }) => guarded(async () => {
        const cs = await cu.listComments(i.task_id);
        if (!cs.length) return 'No comments.';
        return cs.slice(0, LIST_MAX).map((c) => `- ${c.user?.username ?? '?'}: ${(c.comment_text ?? '').slice(0, COMMENT_MAX)}`).join('\n');
      }),
    }),
    tool({
      name: 'clickup_list_members',
      description: 'Members with explicit access to the configured project; use it to learn the exact username before filtering by assignee.',
      inputSchema: z.object({ project }),
      run: (i: { project?: string }) => guarded(async () => {
        await scoped(i.project);
        const ms = await cu.listMembers();
        return ms.length ? ms.map((m) => `- ${m.username ?? '?'}${m.email ? ` (${m.email})` : ''}`).join('\n') : 'No members with explicit access to this project.';
      }),
    }),
    tool({
      name: 'clickup_analyze_project',
      description: 'Overview numbers for the configured project: progress %, tasks per status, workload per person, overdue, due within 7 days, unassigned. Summarise the numbers in your own words and point out concerns.',
      inputSchema: z.object({ project }),
      run: (i: { project?: string }) => guarded(async () => {
        await scoped(i.project);
        const a = await cu.analyze();
        return a.total === 0 ? 'The project has no tasks to analyse.' : analysisText((await cu.listProjects())[0]?.name ?? 'project', a);
      }),
    }),
  ];
  return { id: 'clickup', tools: [...tools, ...clickupWriteTools(cu, guarded)] };
};
