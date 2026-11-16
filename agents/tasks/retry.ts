import type { AppEvents, EventBus } from '../../core/events.js';
import type { BlockReason, Task, TaskRepo, TaskStatus } from '../../db/repos/tasks.js';

/**
 * HEAL-1 (SA-1 C11, HL-C11, HL-C14): the one blocked -> todo move, shared by `/task retry` (a person), the healer (code) and `resolve_blocked` (a head).
 * It does NO audit: every caller writes its own row. It emits `task.changed` and `task.ready` only when the guarded UPDATE moved a row.
 */
export type RetryCode = 'E_NOT_FOUND' | 'E_HALTED' | 'E_NOT_BLOCKED' | 'E_TREE_ENDED' | 'E_TURNS' | 'E_STALE';
export type RetryResult = { ok: true; task: Task; reason: BlockReason } | { ok: false; code: RetryCode; reason?: BlockReason; status?: TaskStatus };
export interface RetryDeps {
  tasks: Pick<TaskRepo, 'get' | 'update'>;
  bus: Pick<EventBus<AppEvents>, 'emit'>;
  isHalted(): boolean;
  turnsCap(): number;
}

const ENDED: readonly TaskStatus[] = ['done', 'cancelled'];
/** HL-C14: the description stays within this many characters; the original part is trimmed from its END, so its first line always survives. */
export const DESCRIPTION_MAX = 6000;

/**
 * `append` (already framed, redacted and one line by the caller) is added to the description in the same guarded UPDATE. `taint` sets `tainted`
 * in that UPDATE (copied forward, never cleared). Refusal order: not found, halted, not blocked, tree ended, turns, stale.
 */
export async function retryBlocked(d: RetryDeps, taskId: string, o: { resetTurns: boolean; append?: string; taint?: boolean }): Promise<RetryResult> {
  const task = await d.tasks.get(taskId);
  if (!task) return { ok: false, code: 'E_NOT_FOUND' };
  const reason: BlockReason = task.blockedReason ?? 'owner'; // TA-C16: a NULL reason (a row from before the owner reason) reads as owner
  if (d.isHalted()) return { ok: false, code: 'E_HALTED', reason, status: task.status };
  if (task.status !== 'blocked') return { ok: false, code: 'E_NOT_BLOCKED', reason, status: task.status };
  const parent = task.parentId ? await d.tasks.get(task.parentId) : null;
  const root = task.rootId !== task.id ? await d.tasks.get(task.rootId) : null;
  if ((parent && ENDED.includes(parent.status)) || (root && ENDED.includes(root.status))) return { ok: false, code: 'E_TREE_ENDED', reason, status: task.status };
  const cap = d.turnsCap();
  if (reason === 'turns' && !o.resetTurns && task.turnsUsed >= cap) return { ok: false, code: 'E_TURNS', reason, status: task.status };
  const append = o.append ? o.append.slice(0, DESCRIPTION_MAX) : '';
  const moved = await d.tasks.update(
    task.id,
    {
      status: 'todo',
      ...(o.resetTurns ? { turnsUsed: 0 } : {}),
      ...(append ? { description: task.description.slice(0, DESCRIPTION_MAX - append.length) + append } : {}),
      ...(o.taint === true && !task.tainted ? { tainted: true } : {}),
    },
    'blocked',
  );
  if (!moved) return { ok: false, code: 'E_STALE', reason, status: task.status };
  await d.bus.emit('task.changed', { task: moved, from: 'blocked', to: 'todo' });
  await d.bus.emit('task.ready', { taskId: moved.id });
  return { ok: true, task: moved, reason };
}
