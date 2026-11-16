import type { ConfigStore } from '../../config/store.js';
import type { Approval } from '../../db/repos/ledger.js';
import type { Task, TaskRepo } from '../../db/repos/tasks.js';
import type { ToolKind } from '../../tools/policy-approval.js';
import { treeGrantEligible } from '../../tools/tree-grant-scope.js';
import type { TreeGrantOffer } from '../embeds/approval.js';

/**
 * TREEGRANT-1 (TG-C3, TG-C11): the offer a card carries. Null (no "Approve the whole task" button) unless the stored row passes the ONE pure predicate
 * (`treeGrantEligible`, the same one decideTaskGrant and decideBatch run), the feature is on, the company is not halted, the task tree is open and it has no
 * live grant yet. The numbers are the ones decideTaskGrant will snapshot (a conversation root gets the shorter expiry), so the card never promises more than the grant gives.
 */
export function makeTaskGrantOffer(d: {
  cfg: Pick<ConfigStore, 'get'>;
  halt: { isHalted(): boolean };
  tasks: Pick<TaskRepo, 'get'>;
  grants: { live(rootId: string): Promise<unknown> };
  kindOf(name: string): ToolKind | undefined;
  isConversation(root: Task): boolean;
}): (a: Approval) => Promise<TreeGrantOffer | null> {
  return async (a) => {
    if (d.halt.isHalted() || d.cfg.get('taskGrant.enabled') !== true) return null;
    if (!treeGrantEligible(a, (n) => d.kindOf(n))) return null;
    const t = a.taskId ? await d.tasks.get(a.taskId) : null;
    const root = t ? (t.rootId === t.id ? t : await d.tasks.get(t.rootId)) : null;
    if (!root || root.status === 'done' || root.status === 'cancelled' || (await d.grants.live(root.id))) return null;
    const hours = d.cfg.get('taskGrant.hours');
    const maxFetches = d.cfg.get('web.taskGrant.maxFetches');
    return {
      maxCalls: d.cfg.get('taskGrant.maxCalls'),
      hours: d.isConversation(root) ? Math.min(hours, d.cfg.get('taskGrant.conversationHours')) : hours,
      web: d.cfg.get('web.taskGrant.enabled') === true
        ? { hours: d.cfg.get('web.taskGrant.hours'), maxFetches, maxHosts: Math.min(d.cfg.get('web.taskGrant.maxHosts'), maxFetches), maxUrlChars: d.cfg.get('web.taskGrant.maxUrlChars') }
        : null,
    };
  };
}
