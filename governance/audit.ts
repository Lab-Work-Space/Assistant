import type { ErrorSink } from '../core/events.js';
import { redactText } from '../core/logger.js';
import type { AuditEntry } from '../db/repos/ledger.js';

export type { AuditEntry };
export type AuditFn = (entry: AuditEntry) => Promise<void>;

const TEXT_MAX = 200;
// Free text can carry a model-chosen string (an unknown tool name): mask key/token shapes before storing (P24).
const cap = (s: string | null | undefined) => (s == null ? s : redactText(s).slice(0, TEXT_MAX));

/**
 * Appends metadata-only audit rows (spec §10). Only the known columns are copied, so a message body
 * passed in an extra field is dropped, and free text is capped. A failing store is logged, never thrown.
 */
export function createAudit(repo: { append(e: AuditEntry): Promise<void> }, log?: ErrorSink): AuditFn {
  return async (e) => {
    try {
      await repo.append({
        actor: cap(e.actor)!,
        action: cap(e.action)!,
        taskId: e.taskId,
        provider: cap(e.provider),
        model: cap(e.model),
        tokensIn: e.tokensIn,
        tokensOut: e.tokensOut,
        costUsd: e.costUsd,
        tool: cap(e.tool),
        outcome: cap(e.outcome),
      });
    } catch (err) {
      log?.error({ err, action: e.action }, 'audit append failed');
    }
  };
}
