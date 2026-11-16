import type { ActorRef } from '../../company/types.js';
import { neutralise } from '../../company/handles.js';
import type { ConfigStore } from '../../config/store.js';
import type { AppEvents, EventBus } from '../../core/events.js';
import { redactText } from '../../core/logger.js';
import type { HealRepo } from '../../db/repos/heal.js';
import type { Task, TaskOrigin, TaskRepo } from '../../db/repos/tasks.js';
import type { AuditFn } from '../../governance/audit.js';
import { sameActor, type HealCode, type HealPort } from '../../tools/types.js';
import { actorLabel } from '../scheduler/notices.js';
import { retryBlocked, type RetryCode } from './retry.js';

const HQ: ActorRef = { kind: 'head', dept: 'hq' };

/** Origins a person started. Same list as `isHumanOrigin` in scheduler.ts (a test binds the two); kept here so this module needs no scheduler import. */
const HUMAN_ORIGINS: readonly TaskOrigin[] = ['chat', 'slash', 'voice'];
export const isPersonOrigin = (o: TaskOrigin): boolean => HUMAN_ORIGINS.includes(o);

/** The block reasons a head or the healer may resolve (HL-C7); a NULL reason reads as `owner`. Everything else needs the owner. */
export const HEALABLE = ['owner', 'error', 'turns'] as const;

/**
 * HEAL-1 (brief 3.2 step 6): who decides about a blocked task, derived by code from rows only. Shared by the healer (whom to wake) and `resolve_blocked` (who may act).
 * - `parent`: the open parent task's owner (a head) decides, from the parent task. `runnable` is false while the parent waits for an approval (no run on it).
 * - `ceo`: the hq head decides, from a new decide task.
 * - `none`: the CEO would decide about its own task: nobody is woken and no call is accepted (the owner sees it in the daily summary).
 */
export type Decider =
  | { path: 'parent'; actor: ActorRef; runTask: Task; runnable: boolean }
  | { path: 'ceo'; actor: ActorRef; runTask: null; runnable: true }
  | { path: 'none' };

const OPEN_PARENT: readonly Task['status'][] = ['todo', 'doing', 'review'];

export async function deciderOf(t: Task, d: { tasks: Pick<TaskRepo, 'get'> }): Promise<Decider> {
  const parent = t.parentId ? await d.tasks.get(t.parentId) : null;
  if (parent && parent.owner.kind === 'head' && !sameActor(parent.owner, t.owner)) {
    if (OPEN_PARENT.includes(parent.status) && parent.threadId) return { path: 'parent', actor: parent.owner, runTask: parent, runnable: true };
    if (parent.status === 'awaiting_approval') return { path: 'parent', actor: parent.owner, runTask: parent, runnable: false };
  }
  if (sameActor(t.owner, HQ)) return { path: 'none' };
  return { path: 'ceo', actor: HQ, runTask: null, runnable: true };
}

/** The fixed refusal texts of `resolve_blocked` (brief §5, Gate 1 HL-C6..C9). None echoes model text. */
export const HEAL_REFUSALS: Record<HealCode, string> = {
  R_DISABLED: 'automatic healing is switched off',
  R_HALTED: 'the company is halted',
  R_NOT_HEAD: 'resolve_blocked is for department heads only',
  R_NOT_FOUND: 'no task has that id',
  R_NOT_BLOCKED: 'that task is not blocked any more',
  R_NOT_HEALABLE: 'that block needs the owner',
  R_NOT_DECIDER: 'you are not the one who decides about that task',
  R_NOT_HERE: 'resolve_blocked works only from the parent task or the decision task of that blocked task',
  R_PENDING: 'that task has a pending approval; wait for the decision',
  R_RETRY_CAP: 'that task was already retried the most times allowed; cancel it or leave it for the owner',
  R_TAINTED: 'a person asked for that task; it cannot be cancelled from a run that read outside text. Retry it or leave it for the owner',
  R_TREE_ENDED: 'its parent or root task has ended',
  R_TURNS: 'that task used all its turns; cancel it or ask the person',
  R_OPEN_CHILDREN: 'that task has open subtasks; it cannot be cancelled here',
  R_STALE: 'the task changed meanwhile; nothing was done',
  R_ERROR: 'the action could not be recorded; nothing was done',
};

const RETRY_CODES: Record<RetryCode, HealCode> = {
  E_NOT_FOUND: 'R_NOT_FOUND', E_HALTED: 'R_HALTED', E_NOT_BLOCKED: 'R_NOT_BLOCKED', E_TREE_ENDED: 'R_TREE_ENDED', E_TURNS: 'R_TURNS', E_STALE: 'R_STALE',
};

/** Longest instruction kept in the frame (HL-C14). */
export const INSTRUCTION_MAX = 1000;

const fold = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** `YYYY-MM-DD HH:mm` of `ms` on the wall clock of `tz`. */
export function stamp(ms: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * HL-C14: the block appended to the task description by a retry. The instruction is neutralised, then redacted (literal secrets and patterns), folded to one line and
 * cut. The frame names the decider and the time and nothing else.
 */
export function instructionFrame(actor: ActorRef, text: string, at: number, tz: string, secrets: readonly string[]): string {
  const line = fold(redactText(neutralise(text), secrets)).slice(0, INSTRUCTION_MAX);
  return `\n\n---\nInstruction from ${actorLabel(actor)} after the block (${stamp(at, tz)}): ${line}`;
}

export interface HealActionsDeps {
  tasks: Pick<TaskRepo, 'get' | 'update' | 'countOpenChildren'>;
  repo: Pick<HealRepo, 'claim' | 'resolveRetries' | 'wakeRunTasks'>;
  /** The swallowing audit (the other refusals); the rows the summary lists or caps count (retry, cancel, R_TAINTED) go through `repo.claim` instead (HL-C10, G2-04). */
  audit: AuditFn;
  cfg: Pick<ConfigStore, 'get'>;
  isHalted(): boolean;
  pendingApprovals(taskId: string): Promise<number>;
  bus: Pick<EventBus<AppEvents>, 'emit'>;
  /** Best effort: ends the web grants of a cancelled root. */
  revokeRoot?: (rootId: string, by: string) => Promise<unknown>;
  secrets?: readonly string[];
  now?: () => number;
  log?: { error(o: unknown, msg: string): void };
}

const actorKey = (a: ActorRef): string => (a.kind === 'head' ? `head:${a.dept}` : `persona:${a.personaId}`);

/** The HealPort behind `resolve_blocked` (brief 3.4 with Gate 1 HL-C6..C10). Refusals, first match wins: see the order in the code. */
export function createHealActions(d: HealActionsDeps): HealPort {
  const now = d.now ?? Date.now;
  const secrets = d.secrets ?? [];
  const row = (req: { actor: ActorRef; taskId: string; callerTaskId: string | null }, outcome: string) =>
    d.audit({ actor: actorKey(req.actor), action: 'task.heal.resolve', taskId: req.taskId, tool: req.callerTaskId, outcome });
  const claimRow = async (req: { actor: ActorRef; taskId: string; callerTaskId: string | null }, outcome: string): Promise<boolean> => {
    try {
      await d.repo.claim({ actor: actorKey(req.actor), action: 'task.heal.resolve', taskId: req.taskId, tool: req.callerTaskId, outcome });
      return true;
    } catch (err) {
      d.log?.error({ errName: err instanceof Error ? err.name : 'unknown' }, 'resolve_blocked claim failed');
      return false;
    }
  };
  return {
    async resolve(req) {
      const no = async (code: HealCode): Promise<{ ok: false; code: HealCode }> => {
        await row(req, `refused:${code}`);
        return { ok: false, code };
      };
      let enabled = false;
      try {
        enabled = d.cfg.get('heal.enabled') === true; // a read error counts as off (HL-C17)
      } catch {
        enabled = false;
      }
      if (!enabled) return no('R_DISABLED');
      if (d.isHalted()) return no('R_HALTED');
      if (req.actor.kind !== 'head') return no('R_NOT_HEAD');
      const t = await d.tasks.get(req.taskId);
      if (!t) return no('R_NOT_FOUND');
      if (t.status !== 'blocked') return no('R_NOT_BLOCKED');
      if (!(HEALABLE as readonly string[]).includes(t.blockedReason ?? 'owner')) return no('R_NOT_HEALABLE'); // HL-C7
      const dec = await deciderOf(t, d);
      if (dec.path === 'none' || !sameActor(dec.actor, req.actor)) return no('R_NOT_DECIDER');
      // rule 7: only from the parent task, or from a decide task named in this task's wake claims
      const here = req.callerTaskId !== null && (req.callerTaskId === t.parentId || (await d.repo.wakeRunTasks(t.id)).includes(req.callerTaskId));
      if (!here) return no('R_NOT_HERE');
      if ((await d.pendingApprovals(t.id)) > 0) return no('R_PENDING');

      if (req.action === 'retry') {
        if ((await d.repo.resolveRetries(t.id)) >= d.cfg.get('heal.maxWakesPerTask')) return no('R_RETRY_CAP'); // HL-C8
        // HL-C10: the row is the claim; it is written first, awaited, and counts toward the cap even if the move is refused. A failed write means no retry.
        try {
          await d.repo.claim({ actor: actorKey(req.actor), action: 'task.heal.resolve', taskId: t.id, tool: req.callerTaskId, outcome: 'retry' });
        } catch (err) {
          d.log?.error({ errName: err instanceof Error ? err.name : 'unknown' }, 'resolve_blocked claim failed');
          return { ok: false, code: 'R_ERROR' };
        }
        const frame = instructionFrame(req.actor, req.instruction ?? '', now(), d.cfg.get('schedule.timezone'), secrets);
        const r = await retryBlocked({ tasks: d.tasks, bus: d.bus, isHalted: d.isHalted, turnsCap: () => d.cfg.get('limits.turnsPerTask') }, t.id, { resetTurns: false, append: frame, taint: req.tainted });
        if (!r.ok) {
          const code = RETRY_CODES[r.code];
          await row(req, `refused:${code}`); // best effort; the claim row above stays
          return { ok: false, code };
        }
        return { ok: true, action: 'retry' };
      }

      // cancel
      if (req.tainted && isPersonOrigin(t.origin)) {
        // HL-C6 + G2-04: the row feeds the HL-C20 list, so it is a claim (awaited, throws); a failed write refuses with R_ERROR
        if (!(await claimRow(req, 'refused:R_TAINTED'))) return { ok: false, code: 'R_ERROR' };
        return { ok: false, code: 'R_TAINTED' };
      }
      if ((await d.tasks.countOpenChildren(t.id)) > 0) return no('R_OPEN_CHILDREN');
      // G2-04: claim-first, as for the retry row: the HL-C20 "cancelled" list cannot miss an irreversible cancel. A stale loss after it leaves a row that over-lists.
      if (!(await claimRow(req, 'cancel'))) return { ok: false, code: 'R_ERROR' };
      const moved = await d.tasks.update(t.id, { status: 'cancelled' }, 'blocked');
      if (!moved) return no('R_STALE');
      const summary = fold(redactText(neutralise(req.reason ?? ''), secrets)).slice(0, 300);
      await d.bus.emit('task.changed', { task: moved, from: 'blocked', to: 'cancelled', ...(summary ? { summary } : {}) });
      if (moved.id === moved.rootId && d.revokeRoot) await d.revokeRoot(moved.rootId, 'system:heal').catch((err: unknown) => d.log?.error({ errName: err instanceof Error ? err.name : 'unknown' }, 'resolve_blocked grant revoke failed'));
      return { ok: true, action: 'cancel' };
    },
  };
}
