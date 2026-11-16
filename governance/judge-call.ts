import { callProvider, type CallDeps } from '../agents/call/call.js';
import { resolveActor } from '../agents/context.js';
import type { Org } from '../company/org.js';
import type { ActorRef } from '../company/types.js';
import type { ConfigStore } from '../config/store.js';
import type { PromptOverrideRepo } from '../db/repos/ledger.js';
import type { PromptDoc } from '../prompts/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { reportFallback } from '../providers/fallback-gate.js';
import { fallbackRequest, resolveEffective, type Effective, type FallbackState } from '../providers/route.js';
import { JudgeOut, sanitizeReason } from './ai-approver-prompt.js';

const HQ: ActorRef = { kind: 'head', dept: 'hq' };
export const JUDGE_TIMEOUT_MS = 30_000;
const JUDGE_MAX_TOKENS = 200;

export type JudgeCode = 'judge_timeout' | 'judge_error' | 'judge_bad_output' | 'judge_budget';
/** A judge call that did not produce a usable answer; carries a fixed code only (never model text or a zod error). */
export class JudgeError extends Error {
  constructor(readonly code: JudgeCode) { super(code); this.name = 'JudgeError'; }
}
export type JudgeAnswer = { decision: 'approve' | 'escalate'; reason: string };

export interface JudgeCallerDeps {
  cfg: Pick<ConfigStore, 'get'>;
  /** The shared literal secret list (it may grow after construction). */
  secrets: readonly string[];
  org: Org;
  prompts: Map<string, PromptDoc>;
  overrides: Pick<PromptOverrideRepo, 'getActive'>;
  providers: Pick<ProviderRegistry, 'resolve'> & Partial<Pick<ProviderRegistry, 'has' | 'get'>>;
  /** R8 PROV-FALLBACK: the Claude API backup gate. `ai_review` may use the backup during the hold; `skill_review` fails fast. Absent: no backup, and a plain hold changes nothing. */
  fallback?: FallbackState;
  call: CallDeps;
  timeoutMs?: number;
}

class Slots {
  private free: number;
  private readonly waiters: (() => void)[] = [];
  constructor(n: number) { this.free = n; }
  acquire(): Promise<() => void> {
    const give = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const next = this.waiters.shift();
        if (next) next(); else this.free++;
      };
    };
    if (this.free > 0) { this.free--; return Promise.resolve(give()); }
    return new Promise((resolve) => this.waiters.push(() => resolve(give())));
  }
}

/**
 * One bounded judge call, shared by the AI approver and the skill judge (SA-1 3.2): actor HQ, tools [], maxTokens 200, a fixed system text,
 * a slot pool of its own, one 30 s race over slot wait plus call, JudgeOut plus sanitizeReason. Never logs text or zod errors.
 */
export class JudgeCaller {
  private readonly slots: Slots;
  constructor(private readonly d: JudgeCallerDeps, private readonly system: string, private readonly tool: 'ai_review' | 'skill_review', concurrency: number) {
    this.slots = new Slots(concurrency);
  }

  /** Resolves to the parsed output or throws JudgeError. */
  async run(user: string): Promise<JudgeAnswer> {
    const ms = this.d.timeoutMs ?? JUDGE_TIMEOUT_MS;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => { timedOut = true; r('timeout'); }, ms); timer.unref?.(); });
    const work = (async () => {
      const release = await this.slots.acquire();
      try {
        if (timedOut) return null; // waited for a slot past the deadline: the call is never made
        return await this.call(user);
      } finally {
        release();
      }
    })();
    work.catch(() => undefined); // a late result, or a late throw, is ignored
    try {
      const r = await Promise.race([work, timeout]);
      if (r === 'timeout' || r === null) throw new JudgeError('judge_timeout');
      return r;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async call(user: string): Promise<JudgeAnswer> {
    let provider: Effective;
    let deptId: string;
    try {
      const profile = await resolveActor(HQ, this.d.org, this.d.prompts, this.d.overrides);
      if (typeof profile === 'string') throw new JudgeError('judge_error');
      deptId = profile.deptId;
      // R8: the one route function. Only `ai_review` may use the backup; a held route (including the hold with no backup) fails fast before any reservation or spawn.
      provider = resolveEffective(this.d.providers, profile, HQ, this.d.cfg, this.d.fallback, { allowFallback: this.tool === 'ai_review' });
    } catch (err) {
      if (err instanceof JudgeError) throw err;
      throw new JudgeError('judge_error');
    }
    if (provider.route === 'held') throw new JudgeError('judge_error');
    const onApi = provider.route === 'fallback';
    let out: Awaited<ReturnType<typeof callProvider>>;
    try {
      const base = { model: provider.model, system: this.system, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: user }] }], tools: [], maxTokens: JUDGE_MAX_TOKENS };
      out = await callProvider(onApi ? fallbackRequest(base) : base, provider.provider, HQ, null, this.d.call, undefined, undefined, this.tool);
    } catch {
      throw new JudgeError('judge_error');
    }
    if (onApi) reportFallback(this.d.fallback, { actor: HQ, deptId }, out); // PV-C09
    if (out.kind === 'refused') throw new JudgeError('judge_budget');
    if (out.kind !== 'done') throw new JudgeError('judge_error');
    if (out.failed !== undefined || out.aborted || out.reason === 'refusal' || out.reason === 'max_tokens') throw new JudgeError('judge_error');
    let parsed: JudgeAnswer;
    try {
      const p = JudgeOut.safeParse(JSON.parse(out.text.trim()));
      if (!p.success) throw new Error('bad');
      parsed = p.data;
    } catch {
      // never log the text, the zod error or the key names (zod 4 echoes unknown keys)
      throw new JudgeError('judge_bad_output');
    }
    const reason = sanitizeReason(parsed.reason, this.d.secrets);
    if (reason === null) throw new JudgeError('judge_bad_output');
    return { decision: parsed.decision, reason };
  }
}
