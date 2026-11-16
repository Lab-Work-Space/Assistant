import { z } from 'zod';
import { ipcCall, type IpcRequest } from '../executor/ipc.js';
import type { PermPort } from './console.js';

/**
 * The main application's side of the executor IPC (Gate 1 S2, option A). It holds no token and no Discord write capability: it forwards a
 * proposal to the executor ("LW Admin") for validation against the executor's own live reads, and a confirmed card's id for application.
 * An executor that is not running makes every server operation fail closed with a plain message.
 */
const Answer = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();
const Applied = z.object({
  ok: z.literal(true),
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('refused'), why: z.string() }),
    z.object({ kind: z.literal('done'), ok: z.boolean(), lines: z.array(z.string()), applied: z.number(), total: z.number() }),
    z.object({ kind: z.literal('awaiting'), lines: z.array(z.string()) }),
  ]),
});
const Proposed = z.object({ ok: z.literal(true), payload: z.unknown(), snapshot: z.unknown(), items: z.array(z.object({ label: z.string(), old: z.string(), neu: z.string() }).passthrough()) });
const CodeRollbackAnswer = z.object({ ok: z.boolean(), lines: z.array(z.string()) });
const Read = z.object({ ok: z.literal(true), text: z.string() });
const Status = z.object({ ok: z.literal(true), ready: z.string().nullable(), userId: z.string().nullable() });

export interface ExecutorClientDeps {
  socketPath: string;
  /** C21 for the bots of THIS process, after each apply: returns the clients it turned off. */
  recheck?: () => Promise<{ dept: string; warnings: string[] }[]>;
  alert?: (dept: string, warnings: string[]) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
  call?: (path: string, req: IpcRequest, timeoutMs?: number) => Promise<unknown>;
}

const OFF = 'the executor (LW Admin) is not running or not reachable';

export class ExecutorClient {
  constructor(private readonly d: ExecutorClientDeps) {}

  private async call(req: IpcRequest, timeoutMs?: number): Promise<unknown> {
    return (this.d.call ?? ipcCall)(this.d.socketPath, req, timeoutMs);
  }

  /** null = ready; else why not. */
  async readiness(): Promise<string | null> {
    try {
      const s = Status.safeParse(await this.call({ op: 'status' }, 10_000));
      return s.success ? s.data.ready : 'the executor sent an unexpected answer';
    } catch {
      return OFF;
    }
  }

  async userId(): Promise<string | null> {
    try {
      const s = Status.safeParse(await this.call({ op: 'status' }, 10_000));
      return s.success ? s.data.userId : null;
    } catch {
      return null;
    }
  }

  /** S14: the executor's live view of default roles and the welcome channel. */
  async checkWelcome(roleIds: readonly string[], channelId: string | null): Promise<string | null> {
    try {
      const a = Answer.safeParse(await this.call({ op: 'check_welcome', roleIds: [...roleIds], channelId }));
      if (!a.success) return 'the executor sent an unexpected answer';
      return a.data.ok ? null : (a.data.error ?? 'refused');
    } catch {
      return OFF;
    }
  }

  /** T7-T10: the prospective tier settings against the executor's live view; null = fine. */
  async checkTiers(c: { managerId: string | null; moderatorId: string | null; modRoomId: string | null }): Promise<string | null> {
    try {
      const a = Answer.safeParse(await this.call({ op: 'check_tiers', ...c }));
      if (!a.success) return 'the executor sent an unexpected answer';
      return a.data.ok ? null : (a.data.error ?? 'refused');
    } catch {
      return OFF;
    }
  }

  /** `deploy_read` (Gate 1 V22): status and logs of assistant-owned apps. The executor judges the Bot Admin tier itself. The text is untrusted. */
  async deployRead(userId: string, read: { kind: 'status' | 'logs'; app?: string | undefined; lines?: number | undefined }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    try {
      const raw = await this.call({ op: 'deploy_read', userId, read: { kind: read.kind, ...(read.app ? { app: read.app } : {}), ...(read.lines ? { lines: read.lines } : {}) } }, 130_000);
      const r = Read.safeParse(raw);
      if (r.success) return { ok: true, text: r.data.text };
      const a = Answer.safeParse(raw);
      return { ok: false, error: a.success && a.data.error ? a.data.error : 'the executor could not read that' };
    } catch {
      return { ok: false, error: OFF };
    }
  }

  /** Manual rollback of the last code change (X18); the executor judges the Bot Admin tier itself. */
  async codeRollback(userId: string): Promise<{ ok: boolean; lines: string[] }> {
    try {
      const r = CodeRollbackAnswer.safeParse(await this.call({ op: 'code_rollback', userId }, 600_000));
      return r.success ? r.data : { ok: false, lines: ['the executor sent an unexpected answer'] };
    } catch {
      return { ok: false, lines: [OFF] };
    }
  }

  /** The families share one transport; `family` picks the executor's validation and the card kind. */
  port(family: 'perm' | 'server' | 'deploy' | 'code'): PermPort {
    return {
      readiness: () => this.readiness(),
      propose: async (ops, ctx) => {
        try {
          const raw = await this.call({ op: 'propose', family, ops: Array.isArray(ops) ? ops : [ops], userId: ctx?.userId ?? '', namedIds: [...(ctx?.namedIds ?? [])] });
          const p = Proposed.safeParse(raw);
          if (p.success) return { ok: true, payload: p.data.payload, snapshot: p.data.snapshot, items: p.data.items as never };
          const a = Answer.safeParse(raw);
          return { ok: false, error: a.success && a.data.error ? a.data.error : 'the executor refused the proposal' };
        } catch {
          return { ok: false, error: OFF };
        }
      },
      apply: async (_payload, _snapshot, who) => {
        let r: z.infer<typeof Applied>['result'];
        try {
          const a = Applied.safeParse(await this.call({ op: 'apply', cardId: who.cardId }, 150_000));
          if (!a.success) return { kind: 'unknown', why: 'unexpected answer' };
          r = a.data.result;
        } catch (e) {
          // G2SM-07: a timeout means the executor may have run the card; "not running" means it did not. The console reconciles with executed_at.
          return /in time/.test(e instanceof Error ? e.message : '') ? { kind: 'unknown', why: 'timeout' } : { kind: 'refused', why: OFF };
        }
        if (r.kind === 'refused' || r.kind === 'awaiting') return r;
        // C21 for the department bots of this process (the executor re-checked itself): an unsafe one is turned off and alerted.
        const lines = [...r.lines];
        try {
          for (const x of (await this.d.recheck?.()) ?? []) {
            lines.push(`Live re-check: the ${x.dept} bot was turned off (${x.warnings.join('; ').slice(0, 300)}).`);
            await this.d.alert?.(x.dept, x.warnings).catch((err: unknown) => this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'disabled alert failed'));
          }
        } catch (err) {
          this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'live re-check failed');
          lines.push('Live re-check could not be completed; run /healthz and check the bots.');
        }
        return { kind: 'done', ok: r.ok, applied: r.applied, total: r.total, lines };
      },
      read: async (kind, args) => {
        try {
          const raw = await this.call({ op: 'read', kind, ...(args?.roleId ? { roleId: args.roleId } : {}), ...(args?.joinedAfter ? { joinedAfter: args.joinedAfter } : {}) });
          const r = Read.safeParse(raw);
          if (r.success) return { ok: true, text: r.data.text };
          const a = Answer.safeParse(raw);
          return { ok: false, error: a.success && a.data.error ? a.data.error : 'the executor could not read that' };
        } catch {
          return { ok: false, error: OFF };
        }
      },
    };
  }
}
