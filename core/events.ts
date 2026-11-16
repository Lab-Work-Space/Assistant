import type { ActorRef } from '../company/types.js';
import type { Approval } from '../db/repos/ledger.js';
import type { Task, TaskStatus } from '../db/repos/tasks.js';

export type Handler<P> = (payload: P) => void | Promise<void>;

/** Placeholder payloads; each later task narrows its own event. */
export type AppEvents = {
  'message.received': unknown;
  /** A task made by create_task; it may already be awaiting_approval (run only tasks in todo). */
  'task.created': { task: Task };
  /** A status change made by update_task; `summary` is set when the owner reports (required for done). */
  'task.changed': {
    task: Task; from: TaskStatus; to: TaskStatus; summary?: string;
    /** TEAMTALK-1: update_task of a persona's own task: up to 3 ideas and 3 decisions for its room, and whether the run that wrote them had read outside text. */
    ideas?: string[]; decisions?: string[]; runTainted?: boolean;
    /** TASKADMIN-1: set only by Approvals.adminCancel: the ids cancelled in the same admin action (parent notice is skipped when the parent is among them), and the masked, capped admin reason (display only, TA-C12). */
    admin?: { cascadeIds: readonly string[]; reason?: string };
  };
  'task.ready': { taskId: string };
  'approval.requested': Approval;
  /** A budget refusal for the company or one bot; fired once per UTC day per scope. */
  /** SPEND-1: scope 'dept' is the department's monthly budget; `day` is then the local month's first day, and it fires on EVERY refusal (the raise card dedupes in the database). `estUsd` is the refused reservation. */
  'governance.paused': { scope: 'company' | 'dept' | 'bot' | 'local' | 'warroom' | 'warroom_bot' | 'local_bot_alert'; actor?: ActorRef; day: string; dept?: string; estUsd?: number };
  'config.changed': unknown;
  'halt.changed': { halted: boolean; by: string };
  /** OT-1: a Bot Admin approved overtime for one task tree (`rootId` comes from the committed row). The scheduler releases that tree's held work, each start consuming one run. */
  'ot.approved': { rootId: string };
};

export interface ErrorSink {
  error(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
}

export class EventBus<E extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof E, Set<Handler<never>>>();

  constructor(private readonly logger: ErrorSink = console) {}

  on<K extends keyof E>(k: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(k);
    if (!set) this.handlers.set(k, (set = new Set()));
    const h = fn as Handler<never>;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  /** Awaits every handler; a throwing/rejecting handler is logged and does not stop the others. */
  async emit<K extends keyof E>(k: K, p: E[K]): Promise<void> {
    const set = this.handlers.get(k);
    if (!set) return;
    await Promise.all(
      [...set].map(async (h) => {
        try {
          await (h as Handler<E[K]>)(p);
        } catch (err) {
          this.logger.error({ err, event: String(k) }, 'event handler failed');
        }
      }),
    );
  }
}
