import { ADMIN_TOOL_NAMES, MOD_TOOL_NAMES } from '../admin/names.js';
import type { CallDeps } from '../agents/call/call.js';
import type { Org } from '../company/org.js';
import type { ConfigStore } from '../config/store.js';
import { redactText } from '../core/logger.js';
import type { AiApproverRepo } from '../db/repos/ai-approver.js';
import type { Approval, PromptOverrideRepo } from '../db/repos/ledger.js';
import type { TaskRepo } from '../db/repos/tasks.js';
import { HIDDEN } from '../discord/embeds/approval.js';
import { isNonSensitiveTool } from '../discord/approval/approval-rooms.js';
import type { PromptDoc } from '../prompts/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { FallbackState } from '../providers/route.js';
import { DERIVED, classOf } from '../tools/manifest/catalog.js';
import type { ToolRegistry } from '../tools/registry.js';
import { grantUrlCheck } from '../tools/plugins/web/grant-url.js';
import { storedInputOk } from '../tools/tree-grant-scope.js';
import type { AuditFn } from './audit.js';
import type { Approvals } from './approval/approvals.js';
import { canonicalJson, inputDigest } from './canonical.js';
import { AI_JUDGE_SYSTEM, buildJudgeUser } from './ai-approver-prompt.js';
import { JUDGE_TIMEOUT_MS, JudgeCaller, JudgeError, type JudgeAnswer } from './judge-call.js';

export { JUDGE_TIMEOUT_MS };

/** The audit actor of the reviewer's own rows (the approve row and the decide line are written by Approvals.decideAi). */
export const AI_ACTOR = 'system:ai-approver';
export const JUDGE_CONCURRENCY = 2;
/** AA-C5: judge calls are bounded at this many times the daily approval cap. */
const REVIEW_CAP_FACTOR = 2;

/** AA-C1: frozen views of the manifest (R4: aiReview 'money_doc' / 'cost_or_lasting'; joining needs a manifest entry and the same diff in tools/manifest/privileged.json). `isNonSensitiveTool` and the admin/mod name lists are imported, never copied. The checks below read `classOf`, which fails closed. */
export const MONEY_DOC_TOOLS: readonly string[] = DERIVED.moneyDoc; // R4: a frozen view of the manifest (aiReview 'money_doc')
export const COST_OR_LASTING_TOOLS: readonly string[] = DERIVED.costOrLasting; // R4: a frozen view of the manifest (aiReview 'cost_or_lasting')
export const COST_OR_LASTING_PREFIX = 'schedule_'; // kept as a floor next to the declared class (V9 also forces every schedule_ manifest entry to cost_or_lasting)

export type AiCode =
  | 'hard_deny:unknown' | 'hard_deny:destructive' | 'hard_deny:sensitive' | 'hard_deny:money_doc' | 'hard_deny:input' | 'hard_deny:cost_or_lasting'
  | 'disabled' | 'url_heuristic' | 'query_heuristic' | 'masked_input' | 'input_cut' | 'cap_tree' | 'cap_day'
  | 'judge_timeout' | 'judge_error' | 'judge_bad_output' | 'judge_budget' | 'decide_error' | 'input_mismatch' | 'interrupted' | 'paused' | 'halted';

/** Fixed AI review texts (SA-1 section 3 plus Gate 1). `null`: no line on the card. */
export const AI_REVIEW_TEXT: Readonly<Record<AiCode, string | null>> = Object.freeze({
  'hard_deny:destructive': 'Not reviewed: destructive tool',
  'hard_deny:sensitive': 'Not reviewed: sensitive tool',
  'hard_deny:money_doc': 'Not reviewed: money, tax or offer document',
  'hard_deny:input': 'Not reviewed: money document, file overwrite or bad input',
  'hard_deny:cost_or_lasting': 'Not reviewed: cost or long-lived effect',
  'hard_deny:unknown': 'Not reviewed: unknown tool',
  url_heuristic: 'Escalated: url looks like it carries data',
  query_heuristic: 'Escalated: search query looks like it carries data',
  masked_input: 'Not reviewed: the call contains a secret',
  input_cut: 'Escalated: too long to review in full',
  cap_tree: 'Escalated: AI approval cap reached',
  cap_day: 'Escalated: AI approval cap reached',
  judge_timeout: 'Not reviewed: the AI review timed out',
  judge_error: 'Not reviewed: the AI review failed',
  judge_bad_output: 'Not reviewed: the AI review failed',
  judge_budget: 'Not reviewed: the AI review failed',
  decide_error: 'Not reviewed: the AI review failed',
  input_mismatch: 'Not reviewed: the AI review failed',
  interrupted: 'Not reviewed: the AI review was interrupted by a restart',
  paused: null,
  halted: null,
  disabled: null, // switched off after the start row was written (AA-C14); an outcome row keeps boot recovery from re-posting it
});

/** What the scheduler hook does with the answer: `approved` and `gone` post no card; `escalate` posts today's card (with `aiReview` as the card line when set). */
export type AiVerdict = { kind: 'approved' } | { kind: 'gone' } | { kind: 'escalate'; aiReview: string | null };

export interface AiApproverDeps {
  cfg: Pick<ConfigStore, 'get'> & Partial<Pick<ConfigStore, 'listenerHealthy'>>;
  repo: Pick<AiApproverRepo, 'claim' | 'countTree' | 'countDay' | 'reviewsDay' | 'pausedToday' | 'setAiReview' | 'interrupted'>;
  approvals: Pick<Approvals, 'decideAi'>;
  tasks: Pick<TaskRepo, 'get'>;
  /** The MAIN registry only (AA-C1): kinds are never read from the admin registry. */
  tools: Pick<ToolRegistry, 'describe'>;
  halt: { isHalted(): boolean };
  /** The swallowing audit helper (escalate rows only; every row that carries a cap or a recovery fact is a throwing claim). */
  audit: AuditFn;
  /** The shared literal secret list (it may grow after construction). */
  secrets: readonly string[];
  org: Org;
  prompts: Map<string, PromptDoc>;
  overrides: Pick<PromptOverrideRepo, 'getActive'>;
  providers: Pick<ProviderRegistry, 'resolve'> & Partial<Pick<ProviderRegistry, 'has' | 'get'>>;
  /** R8: the Claude API backup gate (JudgeCaller); absent = no backup. */
  fallback?: FallbackState;
  call: CallDeps;
  log: { warn(o: unknown, m?: string): void };
  timeoutMs?: number;
  concurrency?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

class Escalate extends Error {
  constructor(readonly code: AiCode, readonly judgeReason?: string) { super(code); }
}

/**
 * The AA-C1 hard-deny classes and the SA-1 heuristics as a pure function (AUTO-1, AA-C1: project autopilot imports this, never copies it).
 * `describe` is the registry's `describe`; `secrets` the shared literal list. Null: the call may go on.
 */
export function precheckCall(name: string, toolInput: unknown, describe: (name: string) => { kind?: string } | undefined, secrets: readonly string[] = []): AiCode | null {
  const info = name === '' ? undefined : describe(name);
  if (!info || info.kind === undefined) return 'hard_deny:unknown';
  if (info.kind === 'destructive') return 'hard_deny:destructive';
  if (!isNonSensitiveTool(name) || (ADMIN_TOOL_NAMES as readonly string[]).includes(name) || (MOD_TOOL_NAMES as readonly string[]).includes(name)) return 'hard_deny:sensitive';
  if (classOf(name).aiReview === 'money_doc') return 'hard_deny:money_doc';
  if (!storedInputOk(name, toolInput)) return 'hard_deny:input';
  if (classOf(name).aiReview === 'cost_or_lasting' || name.startsWith(COST_OR_LASTING_PREFIX)) return 'hard_deny:cost_or_lasting';
  const input = toolInput as Record<string, unknown>; // storedInputOk proved an object
  if (name === 'fetch_page' && !grantUrlCheck(String(input['url'])).ok) return 'url_heuristic';
  if (name === 'web_search') {
    const q = String(input['query']);
    if (q.length > 200 || /\S{20,}/.test(q) || (q.match(/[0-9]/g)?.length ?? 0) >= 10 || q.includes('@') || redactText(q, secrets) !== q || q.replace(HIDDEN, '') !== q) return 'query_heuristic';
  }
  return null;
}

export class AiApprover {
  private readonly caller: JudgeCaller;
  constructor(private readonly d: AiApproverDeps) { this.caller = new JudgeCaller(d, AI_JUDGE_SYSTEM, 'ai_review', d.concurrency ?? JUDGE_CONCURRENCY); }

  /** The AA-C1 hard-deny classes and the SA-1 heuristics, in code. Null: the call may go on to the caps and the judge. */
  precheck(a: Approval): AiCode | null {
    return precheckCall(a.toolName ?? '', a.toolInput, (n) => this.d.tools.describe(n), this.d.secrets);
  }

  /** `off`: no row, no line. `halted` / `paused`: a row and no line. A read error counts as off or paused (fail closed). */
  private async gate(tz: string, q?: Parameters<AiApproverRepo['pausedToday']>[1]): Promise<'off' | 'halted' | 'paused' | null> {
    let on = false;
    try { on = this.d.cfg.get('approval.ai.enabled') === true; } catch { on = false; }
    if (!on) return 'off';
    if (this.d.halt.isHalted()) return 'halted';
    try { return (await this.d.repo.pausedToday(tz, q)) ? 'paused' : null; } catch { return 'paused'; }
  }

  private tz(): string {
    try { return this.d.cfg.get('schedule.timezone'); } catch { return 'Asia/Bangkok'; }
  }

  /** Never throws. Every failure path escalates; no error path approves. */
  async review(a: Approval): Promise<AiVerdict> {
    try {
      return await this.reviewInner(a);
    } catch (err) {
      this.d.log.warn({ errName: errName(err) }, 'ai review failed');
      return this.escalate(a, 'judge_error').catch((): AiVerdict => ({ kind: 'escalate', aiReview: null }));
    }
  }

  private async reviewInner(a: Approval): Promise<AiVerdict> {
    const tz = this.tz();
    const g = await this.gate(tz);
    if (g === 'off') return { kind: 'escalate', aiReview: null };
    if (g) return this.escalate(a, g);
    try {
      const code = this.precheck(a);
      if (code) return this.escalate(a, code);
      const task = await this.d.tasks.get(a.taskId);
      if (!task) return this.escalate(a, 'judge_error');
      const maxTree = this.d.cfg.get('approval.ai.maxPerTree');
      const maxDay = this.d.cfg.get('approval.ai.maxPerDay');
      const [tree, day, reviews] = [await this.d.repo.countTree(task.rootId), await this.d.repo.countDay(tz), await this.d.repo.reviewsDay(tz)];
      if (tree >= maxTree) return this.escalate(a, 'cap_tree');
      if (day >= maxDay || reviews >= REVIEW_CAP_FACTOR * maxDay) return this.escalate(a, 'cap_day');
      const sha = a.inputSha256 ?? '';
      let digestOk = false;
      try { digestOk = inputDigest(canonicalJson(a.toolInput)) === sha && sha !== ''; } catch { digestOk = false; }
      if (!digestOk) return this.escalate(a, 'input_mismatch');
      const name = a.toolName!;
      const info = this.d.tools.describe(name)!;
      const built = buildJudgeUser({
        tool: name, kind: info.kind!, description: info.description, requestedBy: a.requestedBy, depth: task.depth, tainted: task.tainted,
        aiTree: tree, aiDay: day, reason: a.reason, title: task.title, toolInput: a.toolInput, secrets: this.d.secrets,
      });
      if (built.masked) return this.escalate(a, 'masked_input');
      if (built.inputCut) return this.escalate(a, 'input_cut');
      await this.d.repo.claim({ actor: AI_ACTOR, action: 'approval.ai.review', taskId: a.taskId, tool: name, outcome: `#${a.id} start` });
      const out = await this.judge(built.text);
      if (out.decision === 'escalate') return this.escalate(a, 'judge_error', out.reason, true);
      let res: Awaited<ReturnType<AiApproverDeps['approvals']['decideAi']>>;
      try {
        res = await this.d.approvals.decideAi(a.id, {
          sha, reason: out.reason, maxPerTree: maxTree, maxPerDay: maxDay, tz,
          stillOn: async (q) => (await this.gate(tz, q)) === null,
        });
      } catch (err) {
        this.d.log.warn({ errName: errName(err) }, 'ai decide failed');
        return this.escalate(a, 'decide_error');
      }
      if (res.ok) return { kind: 'approved' };
      switch (res.error) {
        case 'not_pending':
        case 'expired':
          return { kind: 'gone' };
        case 'halted': case 'cap_tree': case 'cap_day': case 'input_mismatch':
          return this.escalate(a, res.error);
        case 'not_enabled': {
          const again = await this.gate(tz);
          return this.escalate(a, again === 'off' ? 'disabled' : again ?? 'decide_error');
        }
        default:
          return this.escalate(a, 'decide_error');
      }
    } catch (err) {
      if (err instanceof Escalate) return this.escalate(a, err.code);
      this.d.log.warn({ errName: errName(err) }, 'ai review step failed');
      return this.escalate(a, 'judge_error');
    }
  }

  /** One judge call (JudgeCaller: slot wait and call share one 30 s race). Resolves to the parsed output, or throws Escalate with a code. */
  private async judge(user: string): Promise<JudgeAnswer> {
    try {
      return await this.caller.run(user);
    } catch (err) {
      if (err instanceof JudgeError) throw new Escalate(err.code);
      throw err;
    }
  }

  /**
   * The escalate path: a row (also for `disabled` after a `not_enabled` decide result; the switch-off before the start row returns early and writes none), then the card line (best effort), then the verdict.
   * `judge`: the row carries the sanitised judge reason instead of a code, and the card shows that reason.
   */
  private async escalate(a: Approval, code: AiCode, judgeReason?: string, judge = false): Promise<AiVerdict> {
    const text = judge && judgeReason ? judgeReason : AI_REVIEW_TEXT[code];
    const outcome = judge && judgeReason ? `#${a.id} judge ${judgeReason}` : `#${a.id} ${code}`;
    await this.d.audit({ actor: AI_ACTOR, action: 'approval.ai.escalate', taskId: a.taskId, tool: a.toolName ?? null, outcome });
    if (text) await this.d.repo.setAiReview(a.id, text).catch(() => undefined);
    return { kind: 'escalate', aiReview: text };
  }

  /** Boot recovery (AA-C16): the pending approvals whose review a restart cut short; each is escalated as `interrupted` and returned with its card line. Never judges again. */
  async recover(hours: number): Promise<Approval[]> {
    const rows = await this.d.repo.interrupted(hours);
    const out: Approval[] = [];
    for (const a of rows) {
      const v = await this.escalate(a, 'interrupted').catch(() => null);
      out.push(v && v.kind === 'escalate' && v.aiReview ? { ...a, aiReview: v.aiReview } : a);
    }
    return out;
  }
}
