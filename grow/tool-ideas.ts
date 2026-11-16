import { z } from 'zod';
import type { ActorRef } from '../company/types.js';
import type { ToolIdeaRepo, ToolIdeaRow } from '../db/repos/grow.js';
import type { AuditFn } from '../governance/audit.js';
import { screenText } from '../knowledge/screen.js';

/** `tool_idea {name, problem, example}` (SA-1 3.4). No kind, no approval: the only effect is a ticket row and a bot-log line. */
export const ToolIdeaInput = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  problem: z.string().trim().min(10).max(500),
  example: z.string().trim().min(1).max(500),
}).strict();
export type ToolIdeaInput = z.infer<typeof ToolIdeaInput>;

export type IdeaCode = 'not_head' | 'halted' | 'screen' | 'open_cap' | 'duplicate';
/** Fixed texts; nothing echoes input or model text. */
export const IDEA_TEXT: Record<IdeaCode, string> = {
  not_head: 'Only a department head can file a tool idea.',
  halted: 'The company is halted; try again after /resume.',
  screen: 'The idea was refused (a secret-like value or control characters).',
  open_cap: 'Your department already has 5 open tool ideas.',
  duplicate: 'Your department already has an open idea with that name.',
};
export type Idea = { ok: true; id: number; text: string } | { ok: false; code: IdeaCode; error: string };

export interface ToolIdeaDeps {
  repo: Pick<ToolIdeaRepo, 'create' | 'listOpen' | 'close'>;
  halted: () => boolean;
  audit: AuditFn;
  secrets: readonly string[];
  /** One line to #bot-log (governance alert). A failure never undoes the ticket. */
  notify: (title: string, text: string) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

/**
 * GROW-1 tool_idea (Gate 1 GW-C24). A ticket for a tool that does not exist yet. Allowed from a tainted run: the taint is stored and `/tool ideas` marks the row
 * UNVERIFIED. Nothing in GROW-1 reads these rows except /tool; any future consumer treats them as untrusted data and needs its own gate.
 */
export class ToolIdeaService {
  constructor(private readonly d: ToolIdeaDeps) {}

  private async refuse(who: string, code: IdeaCode): Promise<Idea> {
    await this.d.audit({ actor: who, action: 'tool.idea', tool: 'tool_idea', outcome: `refused:${code}` });
    return { ok: false, code, error: IDEA_TEXT[code] };
  }

  async idea(actor: ActorRef, run: { tainted: boolean; task: { id: string; tainted: boolean } | null }, input: ToolIdeaInput): Promise<Idea> {
    const who = actor.kind === 'head' ? `head:${actor.dept}` : `persona:${actor.personaId}`.slice(0, 80);
    if (actor.kind !== 'head' || actor.dept === 'praw') return this.refuse(who, 'not_head');
    const dept: string = actor.dept;
    if (this.d.halted()) return this.refuse(who, 'halted');
    // a secret refuses; PII is masked. The masked text must still fit the column checks (a mask can shorten it).
    const name = screenText(input.name, { max: 40, secrets: this.d.secrets, pii: false, multiline: false });
    const problem = screenText(input.problem, { max: 500, secrets: this.d.secrets, multiline: true });
    const example = screenText(input.example, { max: 500, secrets: this.d.secrets, multiline: true });
    if (!name.ok || !problem.ok || !example.ok || problem.text.length < 10) return this.refuse(who, 'screen');
    const made = await this.d.repo.create({ dept, name: name.text, problem: problem.text, example: example.text, tainted: run.tainted || run.task?.tainted === true, taskId: run.task?.id ?? null });
    if (!made.ok) return this.refuse(who, made.code);
    await this.d.audit({ actor: who, action: 'tool.idea', tool: 'tool_idea', outcome: `#${made.id}` });
    await this.d.notify('Tool idea', `Tool idea #${made.id} from ${dept} head: ${name.text}`).catch((err: unknown) => this.d.log.error({ errName: errName(err) }, 'tool idea notice failed'));
    return { ok: true, id: made.id, text: `Tool idea #${made.id} (${name.text}) was filed as a ticket. Nothing is built now.` };
  }

  list(limit = 25): Promise<ToolIdeaRow[]> {
    return this.d.repo.listOpen(limit);
  }

  /** `/tool idea_close`: the reason is screened (secret refuses) and capped at 200; null when absent. */
  async close(id: number, userId: string, reason: string | null): Promise<{ ok: true } | { ok: false; text: string }> {
    let clean: string | null = null;
    if (reason !== null && reason.trim() !== '') {
      const s = screenText(reason.replace(/\s+/g, ' '), { max: 200, secrets: this.d.secrets, multiline: false });
      if (!s.ok) return { ok: false, text: 'The reason was refused (a secret-like value, control characters or over 200 characters).' };
      clean = s.text;
    }
    if (!(await this.d.repo.close(id, userId, clean))) return { ok: false, text: 'That idea is not open.' };
    await this.d.audit({ actor: `user:${userId}`, action: 'tool.idea.close', tool: 'tool_idea', outcome: `#${id}` });
    return { ok: true };
  }
}
