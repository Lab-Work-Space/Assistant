import { z } from 'zod';
import type { ConfigStore } from '../../../config/store.js';
import { localDay } from '../../../company/calendar.js';
import { sanitize } from '../../../core/logger.js';
import type { Approval } from '../../../db/repos/ledger.js';
import { cardShowsWhole, HIDDEN } from '../../../discord/embeds/approval.js';
import { CLICKUP_ID } from '../../../services/ids.js';
import type { ToolContext, ToolPlugin, ToolResult } from '../../types.js';
import { actorKey } from '../../../governance/budget.js';
import { ClickUpError, E, hasHiddenCtrl, listPathText, parentPathText, taskLabelText, workspaceLabelText, workspaceNameKey, type ClickUpClient, type CuListInfo, type CuParentInfo, type CuTask, type HierGuard, type TaskPatch, type WriteGuard } from './client.js';

/** CLICKUP-ALL-1 workspace write tools (spec 3.5, Gate 1 C1, C2, C4, C5, C9, C10). List mode keeps write.ts untouched. */
export const RUN_CAP = 5;
/**
 * AUTO-1 (AP-C1): the ClickUp workspace write tools whose OWN approval reason project autopilot may waive. A frozen list in code; `clickup_add_comment` is deliberately left out
 * (a comment is free text that can carry data out), and `clickup_delete_task` is a different plugin and destructive. A test binds this list to the tools this file builds.
 */
export const CLICKUP_WORKSPACE_WRITE_NAMES: readonly string[] = Object.freeze(['clickup_create_task', 'clickup_update_task', 'clickup_update_status', 'clickup_assign_task', 'clickup_create_space', 'clickup_create_folder', 'clickup_create_list']);
const NAME_MAX = 110; // C2: shown whole on the card
const BODY_MAX = 1500;

export const WE = {
  RUN_CAP: 'ClickUp: at most 5 write requests per run',
  DAY_CAP: 'ClickUp: the daily write limit is reached; nothing was done',
  COUNTER: 'ClickUp: the daily write counter is unavailable; nothing was done',
  TOO_LONG: 'ClickUp: this change is too long or too complex to show whole on an approval card; shorten the text',
  REDACTED: 'ClickUp: that text contains something that looks like a credential or secret; remove it and try again',
  BAD_CHARS: 'text may not contain control or invisible characters (new lines and tabs are fine)',
  // CLICKUP-HIER-1
  BAD_NAME: 'ClickUp: a name is 1-100 characters on one line, without / \\ [ ] or invisible characters',
  SPACE_RUN_CAP: 'ClickUp: at most 2 new spaces per run',
} as const;
/** CH-C6: space cards one run may file (OQ-2). */
export const SPACE_RUN_CAP = 2;

const CONTROL = /[\p{Cc}]/u;
const clean = (s: string): boolean => ![...s].some((ch) => ch !== '\n' && ch !== '\t' && CONTROL.test(ch)) && !new RegExp(HIDDEN.source, 'u').test(s);
const text = (max: number, min = 0) => z.string().min(min).max(max).refine(clean, { message: WE.BAD_CHARS });

/**
 * CLICKUP-HIER-1 `hierName` (CH-C9): validation only, the input is never rewritten (the card digest covers it). 1-100 units; no control or invisible character (so no ZWJ or VS16 emoji,
 * Thai letters and marks pass); no new line or tab; no leading or trailing space and no run of two; none of `/ \\ [ ]` (they spoof the path separator and the hash on the card); a usable name key.
 */
export const hierNameOk = (s: string): boolean =>
  s.length >= 1 && s.length <= 100 && clean(s) && !/[\n\t]/.test(s) && !hasHiddenCtrl(s) && s === s.trim() && !/\s{2,}/.test(s) && !/[/\\[\]]/.test(s) && workspaceNameKey(s) !== '?';
const hierName = z.string().refine(hierNameOk, { message: WE.BAD_NAME });

const taskId = z.string().regex(CLICKUP_ID, 'a ClickUp task id (lowercase letters and digits)').describe('ID of the task');
const listId = z.string().regex(CLICKUP_ID, 'a ClickUp list id (see clickup_list_projects)');
const person = z.string().min(1).max(100).refine(clean, { message: WE.BAD_CHARS });
const PIN = 'set by the system, leave empty';
const basePins = {
  in_list_id: z.string().regex(CLICKUP_ID).optional().describe(PIN),
  list_path: z.string().max(300).optional().describe(PIN),
  in_task: z.string().max(110).optional().describe(PIN),
};
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 'YYYY-MM-DD' (a real calendar day) -> UTC midnight in ms, else null. */
function dayMs(s: string): number | null {
  const m = DATE.exec(s);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  const d = new Date(ms);
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! ? ms : null;
}
const q = (s: string) => JSON.stringify(s.length > 120 ? `${s.slice(0, 120)}...` : s);

/** CLICKUP-HIER-1 pins: the parent ids, the parent path and the workspace label (all set by the system). */
type HierPins = { in_space_id?: string; in_folder_id?: string; parent_path?: string; in_workspace?: string };
type HierInput = HierPins & { name: string; description?: string; space_id?: string; folder_id?: string; workspace?: string };
type Pins = { in_list_id?: string; list_path?: string; in_task?: string; in_workspace?: string };
type CreateInput = Pins & { list_id: string; name: string; description?: string };
type UpdateInput = Pins & { task_id: string; name?: string; description?: string; due_date?: string; clear_due_date?: boolean; priority?: number; clear_priority?: boolean };
type StatusInput = Pins & { task_id: string; status: string };
type AssignInput = Pins & { task_id: string; add?: string[]; remove?: string[] };
type CommentInput = Pins & { task_id: string; text: string };

export type WorkspaceWriteDeps = {
  cfg: Pick<ConfigStore, 'get'>;
  clock: () => number;
  /** The daily counter. Absent or throwing = fail closed (E_COUNTER). */
  usage?: { take(day: string, cap: number): Promise<boolean> };
  /** Literal secrets the card masks (app.ts secretsOf): a text the card would show masked is refused (C5). */
  secrets?: readonly string[];
};

const REASON = 'ClickUp workspace write: every change needs approval';

/** The central approvalFor text is cut at this many characters (tools/policy-approval.ts REASON_MAX; a test keeps the two equal). */
export const POLICY_REASON_MAX = 500;
/** The longest target text a card reason can carry: `Workspace <label> · <path> (list <id>) task "<label>" (<id>)`, every part at its cap. */
export const WORST_TARGET_LEN = 'Workspace '.length + 40 + ' · '.length + 110 + ' (list '.length + 32 + ') task '.length + JSON.stringify('x'.repeat(110)).length + ' ('.length + 32 + ')'.length;
/**
 * The reason of the synthetic card: the real worst case (CM-C6), the central approvalFor text at its REASON_MAX, all characters escaping. The target alone is
 * about 360 characters, so the change text always fills the rest: the length is the policy maximum.
 */
export const SYNTHETIC_REASON_LEN = Math.min(POLICY_REASON_MAX, 'tool clickup_update_status on '.length + WORST_TARGET_LEN + ': '.length + 10_000);

/**
 * A card as it will be posted, with WORST-CASE ids and reason (C1b). The reason on the real card is either ours (REASON) or, for a tainted or non-direct run,
 * the central approvalFor text: up to REASON_MAX (500) characters made of the workspace, the path, the task label and model text, which escaping can double.
 * So the check uses a reason of that length that all escapes, and 64-character ids that all escape: a call that passes here fits whichever reason the registry ends up using.
 */
function syntheticCard(toolName: string, input: unknown): Approval {
  return {
    id: 999_999_999_999, taskId: '['.repeat(64), reason: '['.repeat(SYNTHETIC_REASON_LEN), estCostUsd: 0, requestedBy: '['.repeat(64), status: 'pending', decidedBy: null,
    createdAt: new Date(0), decidedAt: null, toolName, toolInput: input, inputSha256: 'a'.repeat(64), kind: 'tool',
  };
}

export function workspaceWriteTools(cu: ClickUpClient, guarded: (f: () => Promise<string>) => Promise<ToolResult>, d: WorkspaceWriteDeps): ToolPlugin<any>[] {
  const secrets = d.secrets ?? [];
  const all = cu.teamScope === 'all';
  // the workspace pin exists ONLY in all-workspaces mode, so the numeric-mode schemas are unchanged
  const pins = { ...basePins, ...(all ? { in_workspace: z.string().max(60).optional().describe(PIN) } : {}) };
  const filed = new WeakMap<object, number>(); // approvals this run filed (request path only: onApprovalTask never runs on a replay)
  const runKey = (ctx: ToolContext): object => (ctx.run as object | undefined) ?? ctx;

  /** C9: the day in the company timezone; taken right before the write request; a database error fails closed; no give-back. */
  const take = async (): Promise<void> => {
    let ok = false;
    try {
      if (!d.usage) throw new Error('no counter');
      ok = await d.usage.take(localDay(d.clock(), d.cfg.get('schedule.timezone')).date, d.cfg.get('clickup.writesPerDay'));
    } catch {
      throw new ClickUpError(WE.COUNTER);
    }
    if (!ok) throw new ClickUpError(WE.DAY_CAP);
  };
  const guardFor = (i: Pins): WriteGuard => ({
    listId: i.in_list_id ?? '',
    ...(i.in_workspace !== undefined ? { workspace: i.in_workspace } : {}),
    beforeWrite: take,
  });

  type Pre = { refuse: string } | { summary: { target: string; change: string }; pin: Pins } | null;
  /** Shared precheck (run and runApproved): run cap, redaction, scope, status, pin comparison, whole-card check. */
  const precheck = (toolName: string, kind: 'create' | 'task', change: (i: never) => string) => async (i: CreateInput & UpdateInput, ctx: ToolContext): Promise<Pre> => {
    if ((filed.get(runKey(ctx)) ?? 0) >= RUN_CAP) return { refuse: WE.RUN_CAP };
    if (JSON.stringify(sanitize(i, secrets)) !== JSON.stringify(i)) return { refuse: WE.REDACTED }; // C5: the card would show other text than the write sends
    let list: CuListInfo;
    let task: CuTask | undefined;
    try {
      if (kind === 'create') list = await cu.listInScope(i.list_id);
      else ({ task, list } = await cu.describeTask(i.task_id));
    } catch (e) {
      return { refuse: e instanceof ClickUpError ? e.message : 'ClickUp request failed' };
    }
    if (all && list.teamCollides) return { refuse: E.NAME_COLLISION }; // CM-C1: no card, nothing taken
    if (toolName === 'clickup_update_status') {
      const want = (i as unknown as StatusInput).status.trim().toLowerCase();
      if (!list.statuses.some((s) => s.toLowerCase() === want)) return { refuse: E.STATUS }; // C4: fixed text, no vendor status name, no card
    }
    const path = listPathText(list);
    const label = task ? taskLabelText(task.name) : undefined;
    const ws = all && list.teamId !== undefined ? workspaceLabelText(list.teamId, list.teamName ?? '?') : undefined;
    if (all && ws === undefined) return { refuse: E.MOVED };
    // C2/C10: a pin that differs from what is true now (task moved, list renamed, forged pin, workspace renamed) is "moved"
    if ((i.in_list_id !== undefined && i.in_list_id !== list.id) || (i.list_path !== undefined && i.list_path !== path) || (i.in_task !== undefined && i.in_task !== label) || (ws !== undefined && i.in_workspace !== undefined && i.in_workspace !== ws)) return { refuse: E.MOVED };
    const pin: Pins = { in_list_id: list.id, list_path: path, ...(label !== undefined ? { in_task: label } : {}), ...(ws !== undefined ? { in_workspace: ws } : {}) };
    if (!cardShowsWhole(syntheticCard(toolName, { ...i, ...pin }), secrets)) return { refuse: WE.TOO_LONG }; // C1b
    return { summary: { target: `${ws !== undefined ? `Workspace ${ws} · ` : ''}${path} (list ${list.id})${label !== undefined ? ` task ${JSON.stringify(label)} (${i.task_id})` : ''}`, change: change(i as never) }, pin };
  };


  // ---- CLICKUP-HIER-1: create space / folder / list (Gate 1 CH-C1..CH-C9). They spread `base`: approval is unconditional, direct chat included (CH-C8). ----
  const spaceCards = new WeakMap<object, number>(); // CH-C6: space cards filed this run (onApprovalTask only: refused calls and replays never count)
  const hierPins = {
    in_space_id: z.string().regex(CLICKUP_ID).optional().describe(PIN),
    in_folder_id: z.string().regex(CLICKUP_ID).optional().describe(PIN),
    parent_path: z.string().max(80).optional().describe(PIN),
  };
  const wsPin = { in_workspace: z.string().max(60).optional().describe(PIN) };
  const hierGuard = (i: HierInput): HierGuard => ({
    parentId: i.in_folder_id ?? i.in_space_id ?? '', parentPath: i.parent_path ?? '', workspace: i.in_workspace ?? '', beforeWrite: take, // CH-C1: an absent pin is empty, and empty is E_MOVED in the client
  });
  const hierChange = (thing: 'space' | 'folder' | 'list', i: HierInput): string => `create ${thing} ${q(i.name)}${i.description ? ` with a ${i.description.length}-character description` : ''}`;
  /** Precheck of the three create tools, shared by the request path and the replay path; a refusal files no card. */
  const hierPre = (toolName: string, thing: 'space' | 'folder' | 'list') => async (i: HierInput, ctx: ToolContext): Promise<Pre> => {
    if ((filed.get(runKey(ctx)) ?? 0) >= RUN_CAP) return { refuse: WE.RUN_CAP };
    if (thing === 'space' && (spaceCards.get(runKey(ctx)) ?? 0) >= SPACE_RUN_CAP) return { refuse: WE.SPACE_RUN_CAP };
    if (JSON.stringify(sanitize(i, secrets)) !== JSON.stringify(i)) return { refuse: WE.REDACTED }; // C5
    let pin: HierPins;
    let target: string;
    try {
      if (thing === 'space') {
        const t = await cu.describeTeam(i.workspace);
        if (all && t.teamCollides) return { refuse: E.NAME_COLLISION };
        const ws = workspaceLabelText(t.teamId, t.teamName);
        if (i.in_workspace !== undefined && i.in_workspace !== ws) return { refuse: E.MOVED };
        await cu.ensureNew('space', { kind: 'team', id: t.teamId }, i.name);
        pin = { in_workspace: ws };
        target = all ? `Workspace ${ws} · new space` : 'This workspace · new space';
      } else {
        const kind: 'space' | 'folder' = thing === 'list' && i.folder_id !== undefined ? 'folder' : 'space';
        const p: CuParentInfo = await cu.describeParent(kind, (kind === 'folder' ? i.folder_id : i.space_id) as string);
        if (all && p.teamCollides) return { refuse: E.NAME_COLLISION };
        const path = parentPathText(p);
        const ws = all && p.teamId !== undefined ? workspaceLabelText(p.teamId, p.teamName ?? '?') : undefined;
        if (all && ws === undefined) return { refuse: E.MOVED };
        const own = kind === 'folder' ? i.in_folder_id : i.in_space_id; // the pin of this parent kind
        const other = kind === 'folder' ? i.in_space_id : i.in_folder_id; // a pin of the other kind is forged
        if (other !== undefined || (own !== undefined && own !== p.id) || (i.parent_path !== undefined && i.parent_path !== path) || (ws !== undefined && i.in_workspace !== undefined && i.in_workspace !== ws)) return { refuse: E.MOVED };
        await cu.ensureNew(thing, { kind, id: p.id }, i.name);
        pin = { ...(kind === 'folder' ? { in_folder_id: p.id } : { in_space_id: p.id }), parent_path: path, ...(ws !== undefined ? { in_workspace: ws } : {}) };
        target = `${ws !== undefined ? `Workspace ${ws} · ` : ''}${path} (${kind} ${p.id})`;
      }
    } catch (e) {
      return { refuse: e instanceof ClickUpError ? e.message : 'ClickUp request failed' };
    }
    if (!cardShowsWhole(syntheticCard(toolName, { ...i, ...pin }), secrets)) return { refuse: WE.TOO_LONG }; // C1b
    return { summary: { target, change: hierChange(thing, i) }, pin: pin as Pins };
  };
  const audited = async (ctx: ToolContext, outcome: 'space' | 'folder' | 'list'): Promise<void> => {
    try { await ctx.audit({ actor: actorKey(ctx.actor), action: 'clickup.hierarchy.created', tool: 'clickup_create_' + outcome, taskId: ctx.task?.id ?? null, outcome }); } catch { /* the audit never fails a create that happened */ }
  };

  const base = { kind: 'write', requiresApproval: () => ({ reason: REASON }), onApprovalTask: (_i: unknown, ctx: ToolContext) => void filed.set(runKey(ctx), (filed.get(runKey(ctx)) ?? 0) + 1) } as const;

  return [
    {
      ...base, name: 'clickup_create_task',
      description: 'Create a task in one ClickUp list of the workspace (give the list id from clickup_list_projects). Give a clear name and optionally a description. Every write needs approval.',
      inputSchema: z.object({ list_id: listId.describe('ID of the list to create the task in'), name: text(NAME_MAX, 1).describe('Task name'), description: text(BODY_MAX).optional().describe('Task description'), ...pins }),
      summary: (i: CreateInput) => ({ target: i.list_id, change: `create task ${q(i.name)}${i.description ? ` with a ${i.description.length}-character description` : ''}` }),
      precheck: precheck('clickup_create_task', 'create', ((i: CreateInput) => `create task ${q(i.name)}${i.description ? ` with a ${i.description.length}-character description` : ''}`) as never),
      run: (i: CreateInput, _ctx: ToolContext) => guarded(async () => `Created task ${(await cu.createTask({ name: i.name, ...(i.description ? { description: i.description } : {}), listId: i.list_id }, guardFor(i))).id}.`),
    } satisfies ToolPlugin<any>,
    {
      ...base, name: 'clickup_update_task',
      description: 'Change fields of one task: name, description, due date (YYYY-MM-DD), priority (1 urgent, 2 high, 3 normal, 4 low). Only give the fields to change; clear_due_date / clear_priority remove a value. Use clickup_update_status for the status and clickup_assign_task for people. Every write needs approval.',
      inputSchema: z.object({
        task_id: taskId, name: text(NAME_MAX, 1).optional(), description: text(BODY_MAX).optional(),
        due_date: z.string().max(10).optional().describe('YYYY-MM-DD'), clear_due_date: z.boolean().optional(),
        priority: z.number().int().min(1).max(4).optional(), clear_priority: z.boolean().optional(), ...pins,
      }).superRefine((i, ctx) => {
        if (i.due_date !== undefined && dayMs(i.due_date) === null) ctx.addIssue({ code: 'custom', path: ['due_date'], message: 'must be a real calendar day written YYYY-MM-DD' });
        if (i.due_date !== undefined && i.clear_due_date) ctx.addIssue({ code: 'custom', path: ['clear_due_date'], message: 'give due_date or clear_due_date, not both' });
        if (i.priority !== undefined && i.clear_priority) ctx.addIssue({ code: 'custom', path: ['clear_priority'], message: 'give priority or clear_priority, not both' });
        if (i.name === undefined && i.description === undefined && i.due_date === undefined && !i.clear_due_date && i.priority === undefined && !i.clear_priority) ctx.addIssue({ code: 'custom', message: 'nothing to change: give at least one field' });
      }),
      summary: (i: UpdateInput) => ({ target: i.task_id, change: updateChange(i) }),
      precheck: precheck('clickup_update_task', 'task', updateChange as never),
      run: (i: UpdateInput) => {
        const p: TaskPatch = {};
        if (i.name !== undefined) p.name = i.name;
        if (i.description !== undefined) p.description = i.description;
        if (i.due_date !== undefined) p.dueDateMs = dayMs(i.due_date);
        if (i.clear_due_date) p.dueDateMs = null;
        if (i.priority !== undefined) p.priority = i.priority;
        if (i.clear_priority) p.priority = null;
        return guarded(async () => (await cu.updateTask(i.task_id, p, guardFor(i)), `Updated task ${i.task_id}.`));
      },
    } satisfies ToolPlugin<any>,
    {
      ...base, name: 'clickup_update_status',
      description: 'Set the status of one task, e.g. "complete" or "in progress". The status must be one the task\'s list has (clickup_get_task_detail shows them). Every write needs approval.',
      inputSchema: z.object({ task_id: taskId, status: text(100, 1).describe('New status name'), ...pins }),
      summary: (i: StatusInput) => ({ target: i.task_id, change: `status -> ${q(i.status)}` }),
      precheck: precheck('clickup_update_status', 'task', ((i: StatusInput) => `status -> ${q(i.status)}`) as never),
      run: (i: StatusInput) => guarded(async () => (await cu.updateStatus(i.task_id, i.status, guardFor(i)), `Updated the status of task ${i.task_id}.`)), // C4: no vendor status text in the result
    } satisfies ToolPlugin<any>,
    {
      ...base, name: 'clickup_assign_task',
      description: 'Add and/or remove assignees of one task by the exact username or email of a member of the task\'s list. If unsure of the spelling, call clickup_list_members first. Every write needs approval.',
      inputSchema: z.object({ task_id: taskId, add: z.array(person).max(10).optional().describe('People to assign'), remove: z.array(person).max(10).optional().describe('People to unassign'), ...pins })
        .refine((i) => (i.add?.length ?? 0) + (i.remove?.length ?? 0) > 0, { message: 'nothing to change: give add and/or remove' }),
      summary: (i: AssignInput) => ({ target: i.task_id, change: assignChange(i) }),
      precheck: precheck('clickup_assign_task', 'task', assignChange as never),
      run: (i: AssignInput) => guarded(async () => (await cu.assign(i.task_id, { add: i.add ?? [], remove: i.remove ?? [] }, guardFor(i)), `Updated assignees of task ${i.task_id}.`)),
    } satisfies ToolPlugin<any>,
    {
      ...base, name: 'clickup_add_comment',
      description: 'Add a comment to one task (at most 1500 characters). Every write needs approval.',
      inputSchema: z.object({ task_id: taskId, text: text(BODY_MAX, 1).describe('Comment text'), ...pins }),
      summary: (i: CommentInput) => ({ target: i.task_id, change: `comment ${q(i.text)}` }),
      precheck: precheck('clickup_add_comment', 'task', ((i: CommentInput) => `comment ${q(i.text)}`) as never),
      run: (i: CommentInput) => guarded(async () => (await cu.addComment(i.task_id, i.text, guardFor(i)), `Commented on task ${i.task_id}.`)),
    } satisfies ToolPlugin<any>,
    {
      ...base, name: 'clickup_create_space',
      description: 'Create a new space (a top-level project area) in a ClickUp workspace. Give a clear name; in all-workspaces mode name the workspace exactly. A new space is visible to every member of that workspace and cannot be made private by the bots. Every create needs approval.',
      inputSchema: z.object({ name: hierName.describe('Space name'), ...(all ? { workspace: z.string().min(1).max(100).refine(clean, { message: WE.BAD_CHARS }).describe('Exact workspace name (see clickup_list_projects)') } : {}), ...wsPin }).strict(),
      onApprovalTask: (_i: unknown, ctx: ToolContext) => { base.onApprovalTask(_i, ctx); spaceCards.set(runKey(ctx), (spaceCards.get(runKey(ctx)) ?? 0) + 1); },
      summary: (i: HierInput) => ({ target: all ? (i.workspace ?? '') : 'this workspace', change: hierChange('space', i) }),
      precheck: hierPre('clickup_create_space', 'space'),
      run: (i: HierInput, ctx: ToolContext) => guarded(async () => {
        const made = await cu.createSpace({ name: i.name, ...(i.workspace !== undefined ? { workspace: i.workspace } : {}) }, hierGuard(i));
        await audited(ctx, 'space');
        return `Created space ${made.id}.`;
      }),
    } satisfies ToolPlugin<any>,
    {
      ...base, name: 'clickup_create_folder',
      description: 'Create a folder in one ClickUp space (give the space id from clickup_list_projects or from clickup_create_space). Every create needs approval.',
      inputSchema: z.object({ space_id: z.string().regex(CLICKUP_ID, 'a ClickUp space id (lowercase letters and digits)'), name: hierName.describe('Folder name'), ...hierPins, ...(all ? wsPin : {}) }).strict(),
      summary: (i: HierInput) => ({ target: i.space_id ?? '', change: hierChange('folder', i) }),
      precheck: hierPre('clickup_create_folder', 'folder'),
      run: (i: HierInput, ctx: ToolContext) => guarded(async () => {
        const made = await cu.createFolder({ spaceId: i.space_id as string, name: i.name }, hierGuard(i));
        await audited(ctx, 'folder');
        return `Created folder ${made.id} in space ${made.spaceId}.`;
      }),
    } satisfies ToolPlugin<any>,
    {
      ...base, name: 'clickup_create_list',
      description: 'Create a list in a ClickUp space or in a folder (give exactly one of space_id or folder_id), with an optional plain-text description. Then use the new list id with clickup_create_task. Every create needs approval.',
      inputSchema: z.object({
        space_id: z.string().regex(CLICKUP_ID).optional().describe('ID of the space (a list without a folder)'), folder_id: z.string().regex(CLICKUP_ID).optional().describe('ID of the folder'),
        name: hierName.describe('List name'), description: text(BODY_MAX).optional().describe('List description (plain text)'), ...hierPins, ...(all ? wsPin : {}),
      }).strict().refine((i) => (i.space_id === undefined) !== (i.folder_id === undefined), { message: 'give exactly one of space_id or folder_id' }),
      summary: (i: HierInput) => ({ target: i.folder_id ?? i.space_id ?? '', change: hierChange('list', i) }),
      precheck: hierPre('clickup_create_list', 'list'),
      run: (i: HierInput, ctx: ToolContext) => guarded(async () => {
        const made = await cu.createList({ parent: i.folder_id !== undefined ? { kind: 'folder', id: i.folder_id } : { kind: 'space', id: i.space_id as string }, name: i.name, ...(i.description ? { content: i.description } : {}) }, hierGuard(i));
        await audited(ctx, 'list');
        return `Created list ${made.id}; use list_id ${made.id} with clickup_create_task.`;
      }),
    } satisfies ToolPlugin<any>,
  ];
}

function updateChange(i: UpdateInput): string {
  return [i.name !== undefined && `name -> ${q(i.name)}`, i.description !== undefined && `description -> ${i.description.length} characters`, i.due_date !== undefined && `due date -> ${q(i.due_date)}`, i.clear_due_date && 'clear due date', i.priority !== undefined && `priority -> ${i.priority}`, i.clear_priority && 'clear priority'].filter(Boolean).join('; ') || 'no change';
}
function assignChange(i: AssignInput): string {
  return [i.add?.length && `add ${i.add.map(q).join(', ')}`, i.remove?.length && `remove ${i.remove.map(q).join(', ')}`].filter(Boolean).join('; ') || 'no change';
}
