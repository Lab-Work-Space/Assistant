import { z } from 'zod';
import { CLICKUP_ID } from '../../../services/ids.js';
import { toolError, type ToolPlugin, type ToolResult } from '../../types.js';
import type { ClickUpClient, TaskPatch } from './client.js';
import { workspaceWriteTools, type WorkspaceWriteDeps } from './workspace-write.js';

const NAME_MAX = 200;
const DESC_MAX = 4000;
const COMMENT_MAX = 2000;
const CHANGE_MAX = 120;

const taskId = z.string().regex(CLICKUP_ID, 'a ClickUp task id (lowercase letters and digits)').describe('ID of the task');
const person = z.string().min(1).max(100);
/** Quoted with JSON escaping, so a `"` or newline in model text cannot fake the card's structure. */
const q = (s: string) => JSON.stringify(s.length > CHANGE_MAX ? `${s.slice(0, CHANGE_MAX)}...` : s);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type UpdateInput = { task_id: string; name?: string; description?: string; due_date?: string; clear_due_date?: boolean; priority?: number; clear_priority?: boolean };
type AssignInput = { task_id: string; add?: string[]; remove?: string[] };

/** 'YYYY-MM-DD' (a real calendar day) -> UTC midnight in ms, else null. */
function dayMs(s: string): number | null {
  const m = DATE.exec(s);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  const d = new Date(ms);
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! ? ms : null;
}

/**
 * ClickUp write tools (Task 26, AC9). Approval is NOT decided here: every tool has a `kind`, so the registry applies
 * approvalFor (R3, P2) and these tools only describe the call through `summary` for the approval card. Writes use the same
 * list scope as reads: the client refuses a task outside CLICKUP_LIST_ID before any write request. Results are our own
 * fixed text (no vendor prose), so these tools do not taint the run.
 */
export function clickupWriteTools(cu: ClickUpClient, guarded: (f: () => Promise<string>) => Promise<ToolResult>, ws?: WorkspaceWriteDeps): ToolPlugin<any>[] {
  // CLICKUP-ALL-1: workspace mode has its own tools (precheck, pins, approval every time, no delete); list mode below is unchanged.
  if (cu.mode === 'workspace') return workspaceWriteTools(cu, guarded, ws ?? { cfg: { get: () => 0 as never }, clock: Date.now });
  const base = { requiresApproval: () => false } as const; // extra tool-specific asks: none; the central policy supplies approval
  return [
    {
      ...base, kind: 'write', name: 'clickup_create_task',
      description: 'Create a task in the configured ClickUp project (no other project is possible). Give a clear name and optionally a description.',
      inputSchema: z.object({ name: z.string().min(1).max(NAME_MAX).describe('Task name'), description: z.string().max(DESC_MAX).optional().describe('Task description') }),
      summary: (i: { name: string; description?: string }) => ({ target: cu.listId as string, change: `create task ${q(i.name)}${i.description ? ` with a ${i.description.length}-character description` : ''}` }),
      run: (i: { name: string; description?: string }) => guarded(async () => `Created task ${(await cu.createTask({ name: i.name, ...(i.description ? { description: i.description } : {}) })).id}.`),
    } satisfies ToolPlugin<any>,
    {
      ...base, kind: 'write', name: 'clickup_update_task',
      description: 'Change fields of one task: name, description, due date (YYYY-MM-DD), priority (1 urgent, 2 high, 3 normal, 4 low). Only give the fields to change; clear_due_date / clear_priority remove a value. Use clickup_update_status for the status and clickup_assign_task for people.',
      inputSchema: z.object({
        task_id: taskId, name: z.string().min(1).max(NAME_MAX).optional(), description: z.string().max(DESC_MAX).optional(),
        due_date: z.string().max(10).optional().describe('YYYY-MM-DD'), clear_due_date: z.boolean().optional(),
        priority: z.number().int().min(1).max(4).optional(), clear_priority: z.boolean().optional(),
      }).superRefine((i, ctx) => {
        // refused here, before any approval card exists (a call that could never run must not ask a person)
        if (i.due_date !== undefined && dayMs(i.due_date) === null) ctx.addIssue({ code: 'custom', path: ['due_date'], message: 'must be a real calendar day written YYYY-MM-DD' });
        if (i.due_date !== undefined && i.clear_due_date) ctx.addIssue({ code: 'custom', path: ['clear_due_date'], message: 'give due_date or clear_due_date, not both' });
        if (i.priority !== undefined && i.clear_priority) ctx.addIssue({ code: 'custom', path: ['clear_priority'], message: 'give priority or clear_priority, not both' });
        if (i.name === undefined && i.description === undefined && i.due_date === undefined && !i.clear_due_date && i.priority === undefined && !i.clear_priority) ctx.addIssue({ code: 'custom', message: 'nothing to change: give at least one field' });
      }),
      summary: (i: UpdateInput) => ({
        target: i.task_id,
        change: [i.name !== undefined && `name -> ${q(i.name)}`, i.description !== undefined && `description -> ${i.description.length} characters`, i.due_date !== undefined && `due date -> ${q(i.due_date)}`, i.clear_due_date && 'clear due date', i.priority !== undefined && `priority -> ${i.priority}`, i.clear_priority && 'clear priority'].filter(Boolean).join('; ') || 'no change',
      }),
      run: (i: UpdateInput) => {
        const p: TaskPatch = {};
        if (i.name !== undefined) p.name = i.name;
        if (i.description !== undefined) p.description = i.description;
        if (i.due_date !== undefined) p.dueDateMs = dayMs(i.due_date); // validated by the schema
        if (i.clear_due_date) p.dueDateMs = null;
        if (i.priority !== undefined) p.priority = i.priority;
        if (i.clear_priority) p.priority = null;
        return guarded(async () => (await cu.updateTask(i.task_id, p), `Updated task ${i.task_id}.`));
      },
    } satisfies ToolPlugin<any>,
    {
      ...base, kind: 'write', name: 'clickup_update_status',
      description: 'Set the status of one task, e.g. "complete" or "in progress". The status must be one the project has; otherwise the error lists the valid ones.',
      inputSchema: z.object({ task_id: taskId, status: z.string().min(1).max(100).describe('New status name') }),
      summary: (i: { task_id: string; status: string }) => ({ target: i.task_id, change: `status -> ${q(i.status)}` }),
      run: (i: { task_id: string; status: string }) => guarded(async () => `Task ${i.task_id} is now "${await cu.updateStatus(i.task_id, i.status)}".`),
    } satisfies ToolPlugin<any>,
    {
      ...base, kind: 'write', name: 'clickup_assign_task',
      description: 'Add and/or remove assignees of one task by the exact username or email of a project member. If unsure of the spelling, call clickup_list_members first.',
      inputSchema: z.object({ task_id: taskId, add: z.array(person).max(10).optional().describe('People to assign'), remove: z.array(person).max(10).optional().describe('People to unassign') })
        .refine((i) => (i.add?.length ?? 0) + (i.remove?.length ?? 0) > 0, { message: 'nothing to change: give add and/or remove' }),
      summary: (i: AssignInput) => ({ target: i.task_id, change: [i.add?.length && `add ${i.add.map(q).join(', ')}`, i.remove?.length && `remove ${i.remove.map(q).join(', ')}`].filter(Boolean).join('; ') || 'no change' }),
      run: (i: AssignInput) => guarded(async () => (await cu.assign(i.task_id, { add: i.add ?? [], remove: i.remove ?? [] }), `Updated assignees of task ${i.task_id}.`)),
    } satisfies ToolPlugin<any>,
    {
      ...base, kind: 'write', name: 'clickup_add_comment',
      description: 'Add a comment to one task.',
      inputSchema: z.object({ task_id: taskId, text: z.string().min(1).max(COMMENT_MAX).describe('Comment text') }),
      summary: (i: { task_id: string; text: string }) => ({ target: i.task_id, change: `comment ${q(i.text)}` }),
      run: (i: { task_id: string; text: string }) => guarded(async () => (await cu.addComment(i.task_id, i.text), `Commented on task ${i.task_id}.`)),
    } satisfies ToolPlugin<any>,
    {
      ...base, kind: 'destructive', name: 'clickup_delete_task',
      description: 'Permanently delete one task. It cannot be undone and always needs a person to approve; only call it when the user clearly asked to delete.',
      inputSchema: z.object({ task_id: taskId }),
      summary: (i: { task_id: string }) => ({ target: i.task_id, change: 'delete this task permanently' }),
      run: (i: { task_id: string }) => guarded(async () => (await cu.deleteTask(i.task_id), `Deleted task ${i.task_id}.`)),
    } satisfies ToolPlugin<any>,
  ];
}
