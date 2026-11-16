import type { Task } from '../db/repos/tasks.js';
import { sameActor, type ToolOrigin } from './types.js';
import type { ActorRef } from '../company/types.js';

/** What started this run. `human_message` covers a human's message or interaction (slash); anything else is not a human speaking. */
export type DirectTrigger =
  | { kind: 'human_message'; userId: string; origin: ToolOrigin }
  | { kind: 'child_report' }
  | { kind: 'approved_result' }
  | { kind: 'owner_run' };

export type DirectInput = { origin: ToolOrigin; actor: ActorRef; task: Task | null; trigger: DirectTrigger };

/**
 * R3 / Gate 1 P2: true only while a human talks straight to praw. Computed from the task row and the trigger the
 * loop holds, never from tool input or model output. Voice, delegated, schedule, watch, reminder, poll and import
 * are never direct.
 */
export function isDirectHumanRun({ origin: given, actor, task, trigger }: DirectInput): boolean {
  const origin = task ? task.origin : given; // the task row is the only truth when there is one
  if (origin !== 'chat' && origin !== 'slash') return false;
  if (actor.kind !== 'head' || actor.dept !== 'praw') return false;
  if (trigger.kind !== 'human_message') return false;
  // The message itself must be typed/slash too: a voice transcript is never a direct trigger (P20).
  if (trigger.origin !== 'chat' && trigger.origin !== 'slash') return false;
  if (!task) return true;
  return sameActor(task.owner, actor) && task.depth === 0 && task.requester.kind === 'human' && task.requester.userId === trigger.userId;
}
